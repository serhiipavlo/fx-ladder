# Deploy — FX Ladder

Two independent tracks from one tag (architecture §9): the feed-server image
goes to ghcr → Azure Container Apps; the static web build goes to Azure Static
Web Apps. Release = annotated tag `vX.Y.Z` (plan §2.2).

## One-time provisioning (repo owner, Azure CLI)

```bash
az group create --name fx-ladder --location westeurope

az containerapp env create --name fx-env --resource-group fx-ladder --location westeurope

# First revision from the public image built by the release workflow.
az containerapp create \
  --name fx-feed-server \
  --resource-group fx-ladder \
  --environment fx-env \
  --image ghcr.io/serhiipavlo/fx-ladder/feed-server:latest \
  --target-port 8080 \
  --ingress external \
  --min-replicas 1 --max-replicas 1 \
  --revisions-mode multiple \
  --env-vars FX_ALLOWED_ORIGINS=<swa-url>,http://localhost:5173

az staticwebapp create --name fx-ladder-web --resource-group fx-ladder --location westeurope
```

Also set a **spending alert** on the subscription (v0.0.1 scope):
Cost Management → Budgets → monthly budget with an email alert.

## GitHub configuration

| Kind | Name | Value |
|---|---|---|
| secret | `AZURE_CREDENTIALS` | output of `az ad sp create-for-rbac --role contributor --scopes /subscriptions/<sub>/resourceGroups/fx-ladder --sdk-auth` |
| secret | `AZURE_SWA_TOKEN` | `az staticwebapp secrets list --name fx-ladder-web --query properties.apiKey -o tsv` |
| variable | `AZURE_RESOURCE_GROUP` | `fx-ladder` |
| variable | `AZURE_CONTAINERAPP` | `fx-feed-server` |
| variable | `FEED_PUBLIC_URL` | `https://<containerapp-fqdn>` |
| variable | `WEB_PUBLIC_URL` | `https://<swa-hostname>` |

Deploy jobs in `release.yml` are skipped while these variables are unset, so CI
stays green before Azure exists. After the SWA hostname is known, add it to the
container's `FX_ALLOWED_ORIGINS` — it is both the CORS allowlist for fetch
paths and the Origin allowlist for the WS upgrade (architecture §7.1, §9.2).

## Release

```bash
git tag -a v0.0.1 -m "v0.0.1 — walking skeleton"
git push origin v0.0.1
```

The `release` workflow builds and pushes
`ghcr.io/serhiipavlo/fx-ladder/feed-server:{vX.Y.Z,latest}` (linux/amd64),
updates the Container App, builds web with `VITE_FEED_URL` and uploads it to
SWA, then runs the smoke check against the public URLs. A red smoke marks the
release failed.

Manual smoke, any time:

```bash
node scripts/smoke.mjs https://<containerapp-fqdn> https://<swa-hostname>
```

## Rollback

Container Apps keeps revisions; every image is version-tagged in ghcr.

```bash
# list revisions, newest first
az containerapp revision list --name fx-feed-server --resource-group fx-ladder -o table

# activate the previous revision and route all traffic to it
az containerapp revision activate --revision <previous-revision-name> --resource-group fx-ladder
az containerapp ingress traffic set --name fx-feed-server --resource-group fx-ladder \
  --revision-weight <previous-revision-name>=100
```

Web rolls back by re-running `deploy-web` from the previous tag (or
`pnpm --filter @fx/web build` from the tag locally and SWA CLI upload).

**Rollback drill (T-0.0.7): pending.** To be executed once against live Azure:
roll back to the previous revision, verify it serves traffic (smoke), record
the elapsed time here.
