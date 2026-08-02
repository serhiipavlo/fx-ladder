# Deploy — FX Ladder (Render)

Two independent tracks from one tag (architecture §9, ADR-11 revised): the
feed-server image goes to ghcr and is deployed to a **Render Web Service**
(prebuilt image, deploy hook pinning the exact tag); the web build goes to a
**Render Static Site** (Render builds it from the repo). Both on the free
tier — cold starts are accepted deliberately, the page carries a wake button.

## One-time provisioning (repo owner)

Both services are declared in [`render.yaml`](render.yaml) — a Render
Blueprint: infra-as-code that the free tier actually supports (the Terraform
provider cannot create free-plan web services). After instantiation, service
settings sync from that file on commits to master; change env vars there,
not in the dashboard (a sync overwrites dashboard edits of managed settings).

1. **Make the image pullable.** The image-backed service needs an existing
   image: push the first tag (or one manual `docker push`), then make the
   ghcr package public (GitHub → Packages → `feed-server` → settings →
   visibility) — or keep it private and add a registry credential in Render
   (PAT with `read:packages`), referenced from `image.creds` in `render.yaml`.

2. **Instantiate the Blueprint.** Dashboard → New → Blueprint → connect this
   repo → apply. Render creates `fx-ladder-feed` (web service, free,
   Frankfurt) and `fx-ladder-web` (static site) exactly as declared.

3. **Check the hostnames.** The env literals in `render.yaml` assume
   `fx-ladder-feed.onrender.com` / `fx-ladder-web.onrender.com`. If Render
   suffixed a name at first sync, correct both literals in `render.yaml` and
   commit — the next sync applies the fix.

4. Copy both **deploy hook URLs** (each service → Settings → Deploy Hook).

## GitHub configuration

| Kind | Name | Value |
|---|---|---|
| secret | `RENDER_SERVER_DEPLOY_HOOK` | deploy hook URL of `fx-ladder-feed` |
| secret | `RENDER_WEB_DEPLOY_HOOK` | deploy hook URL of `fx-ladder-web` |
| variable | `FEED_PUBLIC_URL` | `https://fx-ladder-feed.onrender.com` |
| variable | `WEB_PUBLIC_URL` | `https://fx-ladder-web.onrender.com` |

`FEED_PUBLIC_URL` is also the gate: deploy and smoke jobs in `release.yml`
skip while it is unset, so CI stays green before Render exists. The
allowlist that feeds both halves of the same defence — CORS on the fetch
paths and the Origin allowlist on the WS upgrade (architecture §7.1, §9.2) —
lives in `render.yaml` as `FX_ALLOWED_ORIGINS`.

## Release

```bash
git tag -a v0.0.1 -m "v0.0.1 — walking skeleton"
git push origin v0.0.1
```

The `release` workflow builds and pushes
`ghcr.io/serhiipavlo/fx-ladder/feed-server:{vX.Y.Z,latest}` (linux/amd64),
triggers the server deploy hook with `imgURL=<exact version tag>`, then the
static-site hook, then runs the smoke check with retries against the public
URLs. A red smoke marks the release failed.

Manual smoke, any time:

```bash
node scripts/smoke.mjs https://fx-ladder-feed.onrender.com https://fx-ladder-web.onrender.com
```

## Free-tier behaviour (accepted deliberately)

- The instance **spins down after 15 min without inbound traffic**; the next
  request wakes it in up to ~1 min. The page shows an honest state and a
  "Wake the server" button instead of pretending the link is broken.
- Our heartbeat is outbound-only, so an idle viewer does not keep the
  instance awake indefinitely; the reconnect story (v0.1.0+) covers the cut,
  and v0.2.0's session ceiling makes bounded sessions policy anyway.
- **750 instance-hours/month** (spin-down conserves them) and a bounded
  egress allotment (~100 GB/month). At v0.2.0's 50k updates/s the stream
  costs ~6 MB/s ≈ 21 GB/h — full-rate streaming budget is roughly five hours
  a month. Demos run minutes at full rate; the public idle link stays at a
  low rate. No payment method attached ⇒ overrun halts the service, it never
  bills.

## Rollback

Every image is version-tagged in ghcr; Render redeploys whatever tag the
hook pins.

```bash
# roll the server back to the previous version
curl -fsS "$RENDER_SERVER_DEPLOY_HOOK&imgURL=ghcr.io/serhiipavlo/fx-ladder/feed-server:<previous-tag>"
```

Dashboard alternative for both services: Deploys → pick the previous deploy →
Rollback (static-site deploys are kept and roll back instantly).

**Rollback drill (T-0.0.7): pending.** To be executed once against live
Render: roll the server back one tag, verify with the smoke script, record
the elapsed time here.
