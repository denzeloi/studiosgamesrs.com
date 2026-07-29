# Manual snapshot recovery (Vultr)

Use this when automated snapshot tooling is unavailable or RCON checks from your PC fail.

## Is VPN the problem?

| What | VPN impact |
|------|------------|
| **Vultr CS2 install** (Steam, plugins) | **No** — runs on Vultr, not your PC |
| **Firebase / tournament website** | Sometimes — try without VPN if pages fail |
| **Playing CS2 / connecting to server** | Sometimes — use server public IP, not LAN IP |

---

## Manual fix on the golden server

After a full-install provision, the server stays running until you shut it down.

### 1. Open Vultr console

1. [Vultr Customer Portal](https://my.vultr.com/) → **Products → Cloud Compute**
2. Open the golden build server
3. Use **View Console** (browser) or SSH as root: `ssh root@<server-ip>`

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

If local test fails → reinstall plugins and restart:

```bash
bash /root/install-plugins.sh \
  /home/cs2/cs2-server/game/csgo cs2 'YOUR_RCON_PASSWORD'
systemctl restart cs2-server
sleep 30
mcrcon -H 127.0.0.1 -P 27015 -p 'YOUR_RCON_PASSWORD' status
```

### 5. Create Vultr snapshot

1. Power off the instance in Vultr portal
2. **Products → Snapshots → Add Snapshot**
3. Copy snapshot ID to `VULTR_SNAPSHOT_ID` in `repo/functions/.env`
4. Sync and deploy:

```bash
cp functions/.env functions/cs2-nexus/.env
cd repo && npm run deploy:functions
```

---

## Provision without snapshot (slow but works)

Leave `VULTR_SNAPSHOT_ID` unset in `repo/functions/.env`, sync to `functions/cs2-nexus/.env`, deploy functions, then **Provision** from the tournament page. First boot takes ~30–45 min (full Steam install).

## Legacy: Hetzner

If still on Hetzner (`CS2_CLOUD_PROVIDER=hetzner`), use `HETZNER_SNAPSHOT_ID` and the [Hetzner Cloud Console](https://console.hetzner.cloud/) instead of the steps above.
