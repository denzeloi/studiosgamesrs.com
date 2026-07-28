# CS2 Hetzner Snapshot (fast provisioning)

Provisioning from a **golden snapshot** skips the 30–45 minute SteamCMD download. New tournament servers boot in about **5–8 minutes**.

## Why snapshot builds waited 65 min and failed

CS2 **native RCON does not work** with standard RCON clients (Valve bug). Port 27015 opens but auth always fails.

**Fix:** Install [Fake RCON](https://github.com/Salvatore-Als/cs2-fake-rcon) Metamod plugin + `-fakercon` launch flag + `game/bin/linuxsteamrt64/rcon.txt` password file. This is automated in `install-plugins.sh`.

## One-time: create the snapshot

From the repo root:

```bash
node scripts/create-cs2-snapshot.js --provision
```

This will:

1. Create a temporary Hetzner server (`cs2-nexus-golden-build`)
2. Install CS2 via SteamCMD (~30–45 min)
3. Install **Metamod, CounterStrikeSharp, MatchZy, and NexusBridge** automatically
4. Wait until RCON responds
5. Power off the server and create a Hetzner **snapshot**
6. Write `HETZNER_SNAPSHOT_ID=<id>` into `repo/functions/.env`
7. Delete the temporary build server

### Snapshot from an existing server

If you already have a VM with CS2 fully installed:

```bash
node scripts/create-cs2-snapshot.js --server-id 123456789
```

**Do not use `--server-id` unless CS2 + RCON are already working.** The script now verifies RCON before snapshotting. Use `--force` only for emergencies (creates an incomplete snapshot).

### List snapshots

```bash
node scripts/create-cs2-snapshot.js --list
```

## Deploy after snapshot is created

```bash
cd repo
firebase deploy --only functions:cs2-nexus
```

Firebase loads `HETZNER_SNAPSHOT_ID` from `repo/functions/.env` on deploy.

## How it works

| Mode | Hetzner image | Boot script | Typical ready time |
|------|---------------|-------------|-------------------|
| **Snapshot** (`HETZNER_SNAPSHOT_ID` set) | Your snapshot | `cloud-init-snapshot.sh` — config + restart only | ~5–8 min |
| **Full** (no snapshot) | `ubuntu-24.04` | `cloud-init.sh` — full SteamCMD install | ~15–45 min |

## Updating the snapshot

When CS2 has a major update, rebuild:

```bash
node scripts/create-cs2-snapshot.js --provision
firebase deploy --only functions:cs2-nexus
```

Old snapshots can be deleted in the Hetzner Cloud Console to save storage costs.
