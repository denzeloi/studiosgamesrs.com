# CS2 Vultr Snapshot (fast provisioning)

Provisioning from a **golden snapshot** skips re-downloading CS2 via SteamCMD on every new server. Plugins and game files are already on disk.

## Important: two phases (total time)

Vultr snapshot provision is **not** 5–8 minutes end-to-end. That figure was only the **cloud-init / CS2 restart** step *after* the disk exists.

| Phase | What happens | Typical time |
|-------|----------------|--------------|
| **1. Vultr snapshot restore** | Vultr copies your ~160 GB golden disk onto the **new** VM (orange banner in portal) | **~20–45 min** (Vultr says up to 60 min) |
| **2. Boot + configure** | VM starts, `cloud-init-snapshot.sh` applies GSLT/RCON/MatchZy, restarts CS2 | **~5–10 min** |
| **3. RCON ready** | CS2 listens on 27015 | **~2–5 min** |

**Realistic total:** often **~30–50 minutes** per new Provision (similar to a full install, but more reliable — no Steam download).

The snapshot still helps because:
- No dependency on SteamCMD download speed
- Plugins and CS2 version are pre-baked
- Consistent golden config every time

## Why restore takes so long every Provision

Each **Provision Server** creates a **brand-new Vultr VM**. Vultr must **copy the entire snapshot** to that VM’s disk every time. This is not reusing one running server — it is a full disk clone per tournament server.

You see this in the portal as: *“A snapshot is currently being restored…”*

## One-time: create the snapshot on Vultr

### Manual (recommended for Vultr)

1. Provision a test tournament server **without** `VULTR_SNAPSHOT_ID` set (full install, ~30–45 min)
2. SSH or use Vultr web console → verify CS2 + RCON + plugins work
3. Power off the instance in [Vultr Customer Portal](https://my.vultr.com/)
4. **Products → Snapshots → Add Snapshot** from that instance
5. Copy the snapshot ID into `repo/functions/.env`:

   ```bash
   VULTR_SNAPSHOT_ID=your_snapshot_uuid
   ```

6. Sync and deploy:

   ```bash
   cp functions/.env functions/cs2-nexus/.env
   npm run deploy:functions
   ```

Or run: `./scripts/create-vultr-snapshot.sh <instance-id>`

See [MANUAL-SNAPSHOT.md](./MANUAL-SNAPSHOT.md) for step-by-step console instructions.

## Deploy after snapshot is created

```bash
cd repo
cp functions/.env functions/cs2-nexus/.env
firebase deploy --only functions:cs2-nexus
```

## How it works

| Mode | Vultr image | Boot script | Typical ready time |
|------|-------------|-------------|-------------------|
| **Snapshot** (`VULTR_SNAPSHOT_ID` set) | New VM from snapshot (disk restore + configure) | `cloud-init-snapshot.sh` | **~30–50 min total** |
| **Full** (no snapshot) | Ubuntu 24.04 (`VULTR_OS_ID`) | `cloud-init.sh` — full SteamCMD install | **~35–50 min** |

## Updating the snapshot

When CS2 has a major update, rebuild from a fresh golden VM and update `VULTR_SNAPSHOT_ID`, then redeploy functions.

Old snapshots can be deleted in the Vultr portal to save storage costs (~$0.05/GB/month).

## Legacy: Hetzner snapshots

If `CS2_CLOUD_PROVIDER=hetzner`, use `HETZNER_SNAPSHOT_ID` instead. Hetzner snapshot IDs do **not** work on Vultr — build a separate Vultr golden image.
