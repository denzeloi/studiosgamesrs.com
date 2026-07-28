# Manual snapshot recovery (when automated build fails)

## Is VPN the problem?

| What | VPN impact |
|------|------------|
| **Hetzner CS2 install** (Steam, plugins) | **No** — runs on Hetzner, not your PC |
| **Firebase / tournament website** | Sometimes — try without VPN if pages fail |
| **Snapshot script RCON check** (`create-cs2-snapshot.js`) | **Sometimes** — script runs on **your PC** and connects to port 27015. Some VPNs break RCON auth even when the port looks open |
| **Playing CS2 / connecting to server** | Sometimes — use server public IP, not LAN IP |

If the log shows `Port 27015 open` for many minutes but RCON never succeeds, the server may be fine and **your VPN may block RCON from your machine**. Test from the server itself (steps below).

---

## Manual fix on the golden server

The failed build leaves the server running for debugging (see log: `Server left running for debugging: <id>`).

### 1. Open Hetzner console

1. [Hetzner Cloud Console](https://console.hetzner.cloud/) → your project → **Servers**
2. Open the golden build server (`cs2-nexus-golden-build`)
3. Use **Console** (browser SSH) or SSH as root: `ssh root@<server-ip>`

### 2. Check install logs

```bash
tail -80 /var/log/cs2-nexus-install.log
tail -80 /var/log/cs2-nexus-plugins.log
journalctl -u cs2-server -n 80 --no-pager
```

### 3. Verify Metamod + Fake RCON

```bash
ls -la /home/cs2/cs2-server/game/csgo/addons/
cat /home/cs2/cs2-server/game/bin/linuxsteamrt64/rcon.txt
grep -i metamod /home/cs2/cs2-server/game/csgo/gameinfo.gi
systemctl status cs2-server
```

Fake RCON password file must contain **only** the password (one line), matching `RCON_PASSWORD` in `repo/functions/.env`.

### 4. Test RCON **on the server** (not from your PC)

```bash
apt-get update && apt-get install -y mcrcon
mcrcon -H 127.0.0.1 -P 27015 -p 'YOUR_RCON_PASSWORD' status
```

If this works locally but fails from your PC → **turn off VPN** and retry from your machine.

If local test fails → reinstall plugins and restart:

```bash
bash /root/install-plugins.sh \
  /home/cs2/cs2-server/game/csgo cs2 'YOUR_RCON_PASSWORD'
systemctl restart cs2-server
sleep 30
mcrcon -H 127.0.0.1 -P 27015 -p 'YOUR_RCON_PASSWORD' status
```

### 5. Create snapshot (VPN off recommended)

From your PC, in the repo root:

```bash
# Turn VPN off first
node scripts/create-cs2-snapshot.js --server-id <SERVER_ID>
cd repo && firebase deploy --only functions:cs2-nexus
```

Replace `<SERVER_ID>` with the ID from `snapshot-build.log` (e.g. `155593326`).

---

## Provision without snapshot (slow but works)

Remove or comment out `HETZNER_SNAPSHOT_ID` in `repo/functions/.env`, deploy functions, then **Provision** from the tournament page. First boot takes ~30–45 min (full Steam install).
