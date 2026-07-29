# Deploy CS2 Cloud Functions

All CS2 functions are deployed to Firebase (us-central1).

## Deployed functions

| Function | URL / type |
|----------|------------|
| `cs2ProvisionServer` | Callable |
| `cs2LaunchMatch` | Callable |
| `cs2ShutdownServer` | Callable |
| `cs2BuildBracket` | Callable |
| `cs2ListServers` | Callable |
| `cs2MatchWebhook` | https://us-central1-studiosgamesrs.cloudfunctions.net/cs2MatchWebhook |

## Important: do NOT run `firebase deploy --only functions` alone

The repo only contains CS2 functions. A full functions deploy would try to delete the client's existing Nexus functions (`steamLoginResolve`, `useTokenForAction`, etc.).

Always deploy the CS2 codebase explicitly:

```bash
cd repo
firebase deploy --only functions:cs2-nexus
```

Or deploy specific CS2 functions plus hosting:

```bash
firebase deploy --only functions:cs2-nexus,hosting
```

## Hosting: permanent fix for recurring 404s

Clean URLs like `/login` used to depend on `firebase.json` **rewrites**, which sometimes failed to apply on the live CDN (while `login.html` still worked). That caused daily 404s on `/login`, `/dashboard`, etc.

**Fix:** `scripts/build-hosting-routes.js` (runs automatically before every hosting deploy) creates real directories:

- `login/index.html` → served at `/login`
- `dashboard/index.html` → served at `/dashboard`
- …and so on for every main page

These work as **plain static files** — no rewrite config required.

### Always deploy hosting this way

```bash
cd repo
npm run deploy:hosting
```

Or functions + hosting together:

```bash
npm run deploy:all
```

**After any `firebase deploy --only functions:cs2-nexus`**, run `npm run deploy:hosting` before sharing the site URL.

If `/login` 404s again, run `npm run deploy:hosting` — it rebuilds route folders and verifies live URLs.
## Environment variables

Loaded from `repo/functions/cs2-nexus/.env` on deploy (Vultr token, GSLT, RCON password, webhook secret). Keep in sync with `repo/functions/.env`.

## CS2 server webhook

Configure CS2 plugin / MatchZy to POST to:
`https://us-central1-studiosgamesrs.cloudfunctions.net/cs2MatchWebhook`

Header: `X-Webhook-Secret: <WEBHOOK_SECRET from .env>`
