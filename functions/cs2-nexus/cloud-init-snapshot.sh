#!/bin/bash
# CS2 Nexus — fast boot from Hetzner snapshot (CS2 already installed on disk)
set -euo pipefail

LOG="/var/log/cs2-nexus-install.log"
exec >> "$LOG" 2>&1
echo "=== CS2 snapshot boot $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

CS2_USER="cs2"
CS2_HOME="/home/${CS2_USER}"
CS2_ROOT="${CS2_HOME}/cs2-server"
CS2_DIR="${CS2_ROOT}/game/csgo"
CS2_BIN="${CS2_ROOT}/game/bin/linuxsteamrt64/cs2"
CS2_SH="${CS2_ROOT}/game/cs2.sh"
RCON_PASS="__RCON_PASSWORD__"

if [ ! -x "$CS2_BIN" ] && [ ! -x "$CS2_SH" ]; then
  echo "[snapshot] CS2 binary missing — running full install fallback"
  if [ -x /root/install-cs2-full.sh ]; then
    bash /root/install-cs2-full.sh
  else
    echo "[snapshot] FATAL: install-cs2-full.sh missing"
    exit 1
  fi
fi

# Ensure Fake RCON is configured (full reinstall only if Metamod missing).
if [ -x /root/install-plugins.sh ]; then
  if [ ! -f "$CS2_DIR/addons/metamod.vdf" ]; then
    echo "[snapshot] Metamod missing — installing plugins"
    bash /root/install-plugins.sh "$CS2_DIR" "$CS2_USER" "$RCON_PASS" || true
  fi
fi

mkdir -p "$CS2_DIR/cfg" /etc/cs2-nexus /var/lib/cs2-nexus

# Allow CS2 game traffic (UDP + TCP) and SSH before enabling host firewall.
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 27015/udp >/dev/null 2>&1 || true
  ufw allow 27015/tcp >/dev/null 2>&1 || true
  ufw allow 27020/udp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
  echo "[snapshot] ufw enabled (27015 udp/tcp open)"
fi

cat > "$CS2_DIR/cfg/server.cfg" << 'CFGEOF'
hostname "Studiosgamesrs | Nexus Tournament"
sv_password ""
rcon_password "__RCON_PASSWORD__"
sv_setsteamaccount "__GSLT_TOKEN__"
sv_lan 0
game_type 0
game_mode 1
mp_autoteambalance 0
mp_limitteams 0
log on
CFGEOF

cat > /etc/cs2-nexus/bridge.env << ENVEOF
WEBHOOK_SECRET=__WEBHOOK_SECRET__
BRIDGE_WEBHOOK_URL=__BRIDGE_WEBHOOK_URL__
RCON_PASSWORD=__RCON_PASSWORD__
ENVEOF

RCON_TXT="${CS2_ROOT}/game/bin/linuxsteamrt64/rcon.txt"
mkdir -p "$(dirname "$RCON_TXT")"
printf '%s\n' "$RCON_PASS" > "$RCON_TXT"
chown "$CS2_USER:$CS2_USER" "$RCON_TXT"
chmod 600 "$RCON_TXT"

STEAM32="${CS2_HOME}/steamcmd/linux32/steamclient.so"
STEAM64="${CS2_HOME}/steamcmd/linux64/steamclient.so"
if [ ! -f "$STEAM64" ]; then
  runuser -u "$CS2_USER" -- "${CS2_HOME}/steamcmd/steamcmd.sh" \
    +@sSteamCmdForcePlatformType linux +login anonymous +quit || true
fi
if [ ! -f "$STEAM64" ] && [ -f "$STEAM32" ]; then
  mkdir -p "${CS2_HOME}/steamcmd/linux64"
  cp -a "$STEAM32" "$STEAM64"
fi
if [ -f "$STEAM64" ]; then
  mkdir -p "${CS2_HOME}/.steam/sdk64" "${CS2_HOME}/.steam/sdk32"
  cp -a "$STEAM64" "${CS2_HOME}/.steam/sdk64/steamclient.so"
  ln -sfn "$STEAM64" "${CS2_ROOT}/linux64/steamclient.so" 2>/dev/null || mkdir -p "${CS2_ROOT}/linux64" && ln -sfn "$STEAM64" "${CS2_ROOT}/linux64/steamclient.so"
  [ -f "$STEAM32" ] && cp -a "$STEAM32" "${CS2_HOME}/.steam/sdk32/steamclient.so"
  chown -R "$CS2_USER:$CS2_USER" "${CS2_HOME}/.steam"
fi
CSGO_BIN="${CS2_DIR}/bin/linuxsteamrt64"
BIN_DIR="${CS2_ROOT}/game/bin/linuxsteamrt64"
mkdir -p "$CSGO_BIN"
for lib in "$BIN_DIR"/libv8*.so; do
  [ -f "$lib" ] || continue
  ln -sfn "$lib" "${CSGO_BIN}/$(basename "$lib")"
done
for lib in libclient.so libhost.so libmatchmaking.so libserver.so; do
  [ -f "${CSGO_BIN}/${lib}" ] && [ ! -e "${BIN_DIR}/${lib}" ] && ln -sf "../../csgo/bin/linuxsteamrt64/${lib}" "${BIN_DIR}/${lib}" || true
done

cat > /etc/systemd/system/cs2-server.service << SVCEOF
[Unit]
Description=Counter-Strike 2 Dedicated Server
After=network.target

[Service]
Type=simple
User=${CS2_USER}
WorkingDirectory=${CS2_ROOT}/game
EnvironmentFile=/etc/cs2-nexus/bridge.env
Environment=DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=true
ExecStart=${CS2_SH} -dedicated -usercon -fakercon +ip 0.0.0.0 -port 27015 +map de_mirage +exec server.cfg +tv_port 27020
Restart=on-failure
RestartSec=15

[Install]
WantedBy=multi-user.target
SVCEOF

cat > /root/wait-rcon-ready.sh << 'WREOF'
#!/bin/bash
set -uo pipefail
RCON_PASS="__RCON_PASSWORD__"
MARKER="/var/lib/cs2-nexus/rcon-ready"
apt-get install -y mcrcon >/dev/null 2>&1 || true
for i in $(seq 1 90); do
  if timeout 3 bash -c "echo > /dev/tcp/127.0.0.1/27015" 2>/dev/null; then
    if command -v mcrcon >/dev/null 2>&1 && \
       mcrcon -H 127.0.0.1 -P 27015 -p "$RCON_PASS" status 2>/dev/null | grep -qiE 'hostname|players'; then
      date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"
      echo "[snapshot] Local RCON ready (attempt $i)"
      exit 0
    fi
  fi
  sleep 10
done
echo "[snapshot] WARN: Local RCON not verified after 90 attempts"
exit 0
WREOF
chmod +x /root/wait-rcon-ready.sh

cat > /etc/systemd/system/cs2-rcon-ready.service << 'RCEOF'
[Unit]
Description=Verify CS2 Fake RCON is accepting connections
After=cs2-server.service
Wants=cs2-server.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/root/wait-rcon-ready.sh

[Install]
WantedBy=multi-user.target
RCEOF

chown -R "$CS2_USER:$CS2_USER" "$CS2_ROOT" 2>/dev/null || true

systemctl daemon-reload
systemctl enable cs2-server cs2-rcon-ready 2>/dev/null || true
systemctl restart cs2-server
systemctl start cs2-rcon-ready || true

echo "[snapshot] CS2 started from snapshot $(date -u +%Y-%m-%dT%H:%M:%SZ)"
