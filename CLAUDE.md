# CLAUDE.md

Project guidance for Claude Code when working in this repository.

## Project overview

FX Ladder — a synthetic FX trading demo built as a frontend showcase (real-time WebSocket
feed, order lifecycle, GraphQL warm plane) with a deliberately minimal backend. See:

- [FX_LADDER_BUSINESS_SPEC.md](FX_LADDER_BUSINESS_SPEC.md) / `_EN.md` — product spec (FR/NFR/AC IDs)
- [FX_BACKEND_ARCHITECTURE.md](FX_BACKEND_ARCHITECTURE.md) — backend architecture, ADRs
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — versioned release ladder + execution backlog (§7)
- [FX_GLOSSARY.md](FX_GLOSSARY.md) / `_EN.md` — domain glossary

## Git conventions

- **Do not add `Co-Authored-By: Claude` or any other AI-attribution trailer to commit
  messages.** Commits should look and read as authored solely by the repository owner.
- Do not mention Claude, Anthropic, or AI assistance in commit messages, PR descriptions,
  or code comments.
- Conventional commits (`feat:`, `fix:`, `perf:`, `test:`, `docs:`) — see
  `IMPLEMENTATION_PLAN.md` §2.2.
- Trunk-based development, short-lived branches, `main` always green — see
  `IMPLEMENTATION_PLAN.md` §2.2.

## Execution conventions

Before implementing anything from `IMPLEMENTATION_PLAN.md`, read §2.4 ("Execution
conventions") — it pins the stack, the invariants enforced by `pnpm verify`, and the
"done when" discipline that every task in §7 follows.
