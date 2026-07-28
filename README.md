# Studiosgamesrs — CS2 Nexus (Phase 1)

Firebase-hosted tournament platform with on-demand **Hetzner CS2** servers, live scoreboard via **NexusBridge**, and integration with the existing Nexus site.

**Production:** [studiosgamesrs.web.app](https://studiosgamesrs.web.app)

## Repository layout

| Path | Purpose |
|------|---------|
| `*.html`, `*.js`, `*.css` (root) | Firebase Hosting — source of truth for pages |
| `functions/` | Default Cloud Functions (site economy, Steam, etc.) |
| `functions/cs2-nexus/` | CS2 tournament API (`provision`, `launch`, `shutdown`, webhook) |
| `cs2-server/` | Server cfg + NexusBridge plugin (injected into VMs at provision) |
| `scripts/` | Hosting build, deploy verification, secret scan |
| `docs/` | Architecture, deployment, snapshot guides |

## Quick start (developers)

```bash
# 1. Secrets (never commit)
cp functions/.env.example functions/.env
# Fill HETZNER_API_TOKEN, RCON_PASSWORD, GSLT_SERVER_*, HETZNER_SNAPSHOT_ID

# 2. Deploy everything
npm run deploy:all
```

## Deploy commands

| Command | When to use |
|---------|-------------|
| `npm run deploy:all` | Full release (functions + hosting + verify) |
| `npm run deploy:hosting` | UI / static assets only |
| `npm run deploy:functions` | CS2 backend only |
| `npm run hosting:clean` | Remove legacy route dirs if they reappear locally |

Hosting uses **`firebase.json` rewrites** (`/login` → `login.html`) — no duplicate `login/` or `dashboard/` folders.

## CS2 tournament flow

1. Commander creates a tournament in **Competition Hub** or **Commander Panel**
2. Open **Tournament Details** → **Provision Server** (Hetzner VM from snapshot, ~5–8 min)
3. Teams register; admin **Launch Match** when ready
4. Players connect: `connect <IP>:27015` in CS2 console
5. **Shutdown Server** when done (stops Hetzner billing)

## Secrets policy

These files must stay **local only** (see `.gitignore`):

- `functions/.env` — Hetzner, RCON, GSLT, webhook
- `serviceAccountKey.json` — PHP Steam login on cPanel
- `steam_login.php`, `steam-config.php` — production PHP (cPanel)

Firebase `apiKey` in client JS is public by design. Real credentials belong in `.env` or server-side only.

## Documentation

Start at [docs/README.md](./docs/README.md):

- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — system design
- [DEPLOYMENT.md](./docs/DEPLOYMENT.md) — ops checklist
- [SNAPSHOT.md](./docs/SNAPSHOT.md) — golden Hetzner image

## Branch note

Deploy CS2 hosting from **`dev`** (or merge `dev` → `main`). Deploying hosting from `main` without CS2 files will overwrite tournament pages on Firebase.
