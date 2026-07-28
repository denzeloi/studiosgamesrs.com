# CS2 Nexus — Deployment Guide

Production stack for Phase 1 tournament servers.

## Architecture (current)

See [ARCHITECTURE.md](./ARCHITECTURE.md) for full detail. Summary:

- **Frontend:** Firebase Hosting → `https://studiosgamesrs.web.app`
- **Backend:** Cloud Functions `cs2-nexus` (us-central1)
- **Database:** Firebase Realtime Database
- **Game servers:** Hetzner Cloud (on-demand from snapshot)
- **Steam login:** cPanel PHP on `studiosgamesrs.com` (hybrid)

The `bridge/` folder is for **local development only**. Production uses Cloud Functions (`repo/cs2-bridge-config.js` → `mode: 'firebase-functions'`).

---

## Prerequisites

1. Firebase project `studiosgamesrs` with Hosting + Functions + RTDB
2. `repo/functions/.env` — copy from `functions/.env.example` and fill secrets
3. Hetzner API token + billing enabled
4. Golden snapshot ID in `HETZNER_SNAPSHOT_ID` (see [SNAPSHOT.md](./SNAPSHOT.md))
5. Node.js 20+, Firebase CLI (`firebase login`)

---

## Deploy (canonical)

From **`repo/`**:

```bash
npm run deploy:all
```

This runs:

1. `build-hosting-routes.js` — verifies root `*.html` sources exist
2. `firebase deploy --only functions:cs2-nexus,hosting`
3. `hosting:verify` — HEAD checks on live URLs

### Deploy hosting only (UI changes)

```bash
npm run deploy:hosting
```

### Deploy functions only (backend changes)

```bash
npm run deploy:functions
```

**Important:** After UI changes, always run `deploy:hosting` or `deploy`. Deploying functions alone can leave the website on a broken partial release (404 on tournament pages).

---

## Firebase rules

```bash
cd repo
firebase deploy --only database
```

---

## Golden snapshot (one-time)

```bash
npm run snapshot:create
# When build completes (or to resume):
npm run snapshot:watch [SERVER_ID]
```

Updates `HETZNER_SNAPSHOT_ID` in `.env` and deploys via `npm run deploy`.

---

## cPanel (`studiosgamesrs.com`)

cPanel hosts the **legacy main site** and **Steam PHP auth**. It is **not** the primary deploy target for CS2 tournament UI.

Optional partial sync of CS2-touched files:

```bash
CPANEL_PASS='***' ./scripts/upload-cpanel.sh
```

Tournament pages must be served from **Firebase Hosting** for Cloud Functions integration.

---

## End-to-end test

1. Log in as Commander on `studiosgamesrs.web.app`
2. Competition Hub → Create Tournament
3. Register 2+ teams (or `npm run tournament:seed-teams -- <ID> <team1> <team2>`)
4. Tournament Details → **Provision Server** → wait for IP (~1–3 min)
5. **Launch Match** → connect `connect IP:27015`
6. Verify live data in tournament page / `partida_en_vivo/`
7. **Shutdown Server** when done (stops Hetzner billing)

---

## Operations scripts

| Command | Purpose |
|---------|---------|
| `npm run server:fix-libraries` | SSH repair: libv8, steamclient, cs2.sh (on server as root) |
| `npm run tournament:seed-teams` | Register teams + build bracket via Firebase CLI |
| `npm run hosting:verify` | Check live URLs without deploying |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| 404 on `studiosgamesrs.web.app` | Run `npm run deploy:hosting` — partial deploy |
| Provision timeout (504) | Normal; keep page open, wait for IP |
| CS2 SEGV on server | Run `server:fix-libraries` on Hetzner VM |
| RCON from cloud fails | Use local mcrcon on server; boot grace allows launch |
| `studiosgamesrs.com` shows old UI | Expected — use `.web.app` for CS2 features |

---

## Security checklist

- [ ] Never commit `repo/functions/.env` or `bridge/serviceAccount.json`
- [ ] Rotate credentials shared during development
- [ ] Firebase rules: clients read-only on live paths
- [ ] Commander rank required for provision/launch/shutdown

---

## Monthly cost (estimate)

- Hetzner CPX31 on-demand: ~$0.08/hr while server is running
- Firebase: usually within free tier for Phase 1
- No 24/7 bridge VPS required (Cloud Functions)
