# CS2 Nexus — Architecture

Phase 1 connects on-demand Hetzner CS2 servers to the Studiosgamesrs Nexus web platform.

## Components

### Frontend (repo root)

Static site on **Firebase Hosting** (`studiosgamesrs.web.app`).

| Module | Files | Purpose |
|--------|-------|---------|
| Tournament API client | `tournament-system.js`, `cs2-bridge-config.js` | Calls Cloud Functions (`mode: firebase-functions`) |
| Tournament admin UI | `tournament-details.html/js` | Provision, launch, shutdown, live scoreboard |
| Commander Panel | `commander-panel.html/js` | Alternate tournament controls |
| Competition Hub | `competition-hub.html/js` | Create tournaments, team registration |
| Site routing | `site-config.js` | Firebase vs cPanel domain for Steam auth |
| Firebase init | `sg-firebase-init.js` | Shared client config (all pages should use this) |

**Clean URLs:** `firebase.json` rewrites map `/login`, `/dashboard`, etc. to root `*.html` files. Do not create or commit duplicate `login/`, `dashboard/` folders — run `npm run hosting:clean` to remove legacy copies.

### Backend (`functions/cs2-nexus/`)

Firebase Cloud Functions codebase **`cs2-nexus`** (separate from the default `functions/` codebase).

| Export | Op / route | Purpose |
|--------|------------|---------|
| `cs2NexusApi` | `?op=provision\|launch\|shutdown\|check\|resume` | Tournament server lifecycle |
| `cs2MatchWebhook` | POST | NexusBridge plugin events → RTDB |

Libraries in `functions/cs2-nexus/lib/`: Hetzner API, RCON, bracket builder, RTDB helpers, net probe.

Boot scripts (bundled with the deploy package):

- `cloud-init-snapshot.sh` — fast boot from golden image
- `cloud-init.sh` — full install fallback
- `install-plugins.sh` — Metamod, Fake RCON, CounterStrikeSharp, MatchZy, NexusBridge

Environment: `functions/.env` (never commit — see `functions/.env.example`). Firebase CLI loads it on deploy.

### CS2 servers (Hetzner)

Created on demand from snapshot **`HETZNER_SNAPSHOT_ID`**.

Plugin source (read at provision time): `cs2-server/plugins/NexusBridge/`.

### Firebase RTDB paths

| Path | Writer | Purpose |
|------|--------|---------|
| `tournaments/{id}` | UI, Functions | Metadata, bracket, server IP, status |
| `tournaments/{id}/registeredTeams/` | Team captains | Registration |
| `partida_en_vivo/{matchId}` | Webhook | Live scores, kills, MVPs |
| `gameServers/{hetznerId}` | Functions | Server status, IP, provision mode |

### Hybrid: Steam authentication

- **Firebase Hosting** serves the app (`studiosgamesrs.web.app`).
- **cPanel** (`studiosgamesrs.com`) runs `steam_login.php` for Steam OpenID.
- `site-config.js` redirects auth flows to the main domain when needed.

Do not treat cPanel as the primary deploy target for CS2 tournament pages.

## Deploy flow (canonical)

```bash
cd repo
npm run deploy:all
```

Never deploy functions alone after frontend changes — use `npm run deploy:hosting` or `npm run deploy:all`.

## Snapshot flow

See [SNAPSHOT.md](./SNAPSHOT.md) and [MANUAL-SNAPSHOT.md](./MANUAL-SNAPSHOT.md).

## Related docs

- [DEPLOYMENT.md](./DEPLOYMENT.md) — Operations checklist
- [DEPLOY_FUNCTIONS.md](./DEPLOY_FUNCTIONS.md) — IAM troubleshooting (if needed)
