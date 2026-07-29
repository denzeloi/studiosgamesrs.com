# Server location (Florida / US Southeast)

**Default:** **Vultr Miami (`mia`)** — best latency for Florida players.

## Provider comparison

| Provider | Florida / SE option | Notes |
|----------|---------------------|--------|
| **Vultr** (default) | **`mia` (Miami)** | Best match for Florida. Also `atl` (Atlanta). |
| **Hetzner** (legacy) | None | US only: `ash` (Ashburn, VA), `hil` (Hillsboro, OR). Ashburn is closest Hetzner gets to FL (~15–40 ms to Miami typical). |
| DigitalOcean | NYC / TOR | No Miami; NYC is second-best US East. |
| Linode / Akamai | Atlanta | Good SE option, not FL itself. |
| AWS | `us-east-1` (N. Virginia) | Similar to Ashburn; no Miami region for EC2 classic. |

## Default configuration (Vultr Miami)

In `repo/functions/.env` (never commit):

```bash
CS2_CLOUD_PROVIDER=vultr
VULTR_API_TOKEN=your_vultr_api_key
VULTR_LOCATION=mia
VULTR_PLAN=vc2-4c-8gb
# Optional after you build a golden snapshot on Vultr:
# VULTR_SNAPSHOT_ID=...

# Keep GSLT / RCON / webhook as before
GSLT_SERVER_1=...
RCON_PASSWORD=...
WEBHOOK_SECRET=...
```

Then sync and deploy:

```bash
cd repo
cp functions/.env functions/cs2-nexus/.env
npm run deploy:functions
```

First Vultr boots use **full install** (~35–50 min) until you create a Vultr snapshot. With a snapshot, each new Provision still requires **Vultr disk restore (~20–45 min)** plus **CS2 configure (~5–10 min)** — see [SNAPSHOT.md](./SNAPSHOT.md).

## Legacy: stay on Hetzner

Only if you explicitly need Hetzner Ashburn:

```bash
CS2_CLOUD_PROVIDER=hetzner
HETZNER_API_TOKEN=...
HETZNER_LOCATION=ash
HETZNER_SNAPSHOT_ID=...
```

Do **not** use `hil` for Florida players (worse latency).

## Vultr API key — IP access control

Firebase Cloud Functions call Vultr from **dynamic Google Cloud IPs** (often IPv6). If the API key has IP restrictions, provision fails with:

`Unauthorized IP address: …`

**Fix (client / Vultr account owner):**

1. [Vultr Customer Portal](https://my.vultr.com/) → **Account** → **API**
2. Open **Access Control** for the API key in use
3. Set **Allow All IPv4** (required for serverless automation)
4. If errors still mention an IPv6 address, also enable **Allow All IPv6**
5. Save → retry **Provision Server** in Tournament Details

Do **not** try to whitelist individual Firebase IPs — they change. Use a dedicated API key for CS2 Nexus with allow-all-IPv4, keep the token secret in `.env` only.

1. Create Vultr API key (Account → API)
2. Set env vars above in both `functions/.env` and `functions/cs2-nexus/.env`, then deploy functions
3. Provision a test tournament → wait for IP → fix Steam/GSLT if needed → Launch Match
4. Build a Vultr snapshot once CS2 + plugins are golden (see [SNAPSHOT.md](./SNAPSHOT.md))
5. Shut down leftover Hetzner test VMs to stop billing
