# CS2 Nexus — Architecture

Phase 1 connects on-demand **Vultr Miami** CS2 servers to the Studiosgamesrs Nexus web platform.

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

Libraries in `functions/cs2-nexus/lib/`: Vultr provider (default), Hetzner (legacy), RCON, MatchZy match JSON, bracket builder, RTDB helpers, net probe.

Boot scripts (bundled with the deploy package):

- `cloud-init-snapshot.sh` — fast boot from golden image
- `cloud-init.sh` — full install fallback
- `install-plugins.sh` — Metamod, Fake RCON, CounterStrikeSharp, MatchZy, NexusBridge
- `cs2-server/cfg/MatchZy/` — tournament warmup/knife/live configs

Match launch uses MatchZy `matchzy_loadmatch_url` (teams + Steam IDs) when available; otherwise pug `css_match`.

Environment: `functions/.env` (never commit — see `functions/.env.example`). Default provider is **Vultr Miami** (`CS2_CLOUD_PROVIDER=vultr`).

### CS2 servers (Vultr)

Created on demand in **Miami (`mia`)** from snapshot **`VULTR_SNAPSHOT_ID`** when set, otherwise full Ubuntu install.

Plugin source (read at provision time): `cs2-server/plugins/NexusBridge/`.

### Firebase RTDB paths

| Path | Writer | Purpose |
|------|--------|---------|
| `tournaments/{id}` | UI, Functions | Metadata, bracket, server IP, status |
| `tournaments/{id}/registeredTeams/` | Team captains | Registration |
| `tournaments/{id}/scheduleConfig` | War Room | Smart schedule parameters (start, match length, gaps, seeding) |
| `tournaments/{id}/prizes` | War Room | Live prize pool: tokens, cash, per-place split, MVP |
| `tournaments/{id}/prizePayouts/{place}` | War Room | Recorded deliveries (who got paid, when, by whom) |
| `tournaments/{id}/podium` | War Room, auto | 1st / 2nd / 3rd (3rd is suggested from semifinal losers) |
| `tournaments/{id}/teamStates/{teamId}` | War Room | Team paused / active, with reason |
| `tournaments/{id}/commanderNote` | War Room | Public announcement shown to every spectator |
| `partida_en_vivo/{matchId}` | Webhook | Live scores, kills, MVPs |
| `gameServers/{cloudServerId}` | Functions | Server status, IP, provision mode, provider |
| `tournamentPresence/{id}/{uid}` | Any viewer | Spectator presence (`onDisconnect` cleanup, 90 s TTL) |
| `security/sentinels/{uid}` | Commander | Sentinel roster (limited watchdog permission) |
| `security/sentinelConfig` | Commander | Default sentinel on duty |
| `security/sentinelReports/{id}` | Sentinels | Cheat reports; Commander resolves them |

### Commander War Room (Control Universal del Torneo)

`commander-panel.html` tab `warroom`, driven by `commander-warroom.js` + `commander-warroom.css`.

Single place to run a tournament live: full game-server telemetry (IP, boot pipeline,
RCON/UDP flags, live score, kills), team roster with pause / remove / transfer,
smart single-elimination seeding with a visual schedule, prize pool published in
real time, sentinel management and spectator list.

The bracket it writes is **the same shape** as `functions/cs2-nexus/lib/bracket.js`,
so `cs2MatchWebhook` keeps advancing winners on `match_end` without changes. The
panel adds seeding by team strength, per-round scheduling, byes, and manual closing
for when the game server never reports a `match_end`.

**Two roles reach this tab:**

- **Commander** (`rango` = `commander` / `divisional_commander` / `boss_of_the_state`) — full control.
- **Sentinel** — any user listed in `security/sentinels/{uid}` with `active: true`.
  Sees only this tab, read-only, and can file cheat reports. Everything gated by
  `data-cwr-role="commander"` in the markup plus RTDB rules.

### Hybrid: Steam authentication

- **Firebase Hosting** serves the app (`studiosgamesrs.web.app`).
- **cPanel** (`studiosgamesrs.com`) runs `steam_login.php` for Steam OpenID.
- `site-config.js` redirects auth flows to the main domain when needed.

Do not treat cPanel as the primary deploy target for CS2 tournament pages.

## Deploy flow (canonical)

```bash
cd repo
cp functions/.env functions/cs2-nexus/.env
npm run deploy:all
```

Never deploy functions alone after frontend changes — use `npm run deploy:hosting` or `npm run deploy:all`.

## Snapshot flow

See [SNAPSHOT.md](./SNAPSHOT.md) and [MANUAL-SNAPSHOT.md](./MANUAL-SNAPSHOT.md).

## Related docs

- [DEPLOYMENT.md](./DEPLOYMENT.md) — Operations checklist
- [DEPLOY_FUNCTIONS.md](./DEPLOY_FUNCTIONS.md) — IAM troubleshooting (if needed)
- [LOCATION.md](./LOCATION.md) — Miami vs legacy Hetzner
