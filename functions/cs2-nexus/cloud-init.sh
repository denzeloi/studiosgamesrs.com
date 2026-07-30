#!/bin/bash
# CS2 Nexus — full golden image install (CS2 + tournament plugins)
set -euo pipefail

LOG="/var/log/cs2-nexus-install.log"
exec > >(tee -a "$LOG") 2>&1
echo "=== CS2 Nexus install started $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# Cloud images may force a root password change on first SSH, which blocks key-based checks.
chage -d "$(date +%Y-%m-%d)" root 2>/dev/null || true
chage -M 99999 -E -1 root 2>/dev/null || true

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y lib32gcc-s1 curl wget tar unzip sudo

CS2_USER="cs2"
CS2_HOME="/home/${CS2_USER}"
CS2_ROOT="${CS2_HOME}/cs2-server"
CS2_DIR="${CS2_ROOT}/game/csgo"
CS2_BIN="${CS2_ROOT}/game/bin/linuxsteamrt64/cs2"
CS2_SH="${CS2_ROOT}/game/cs2.sh"

useradd -m -s /bin/bash "$CS2_USER" 2>/dev/null || true

mkdir -p "${CS2_HOME}/steamcmd"
cd "${CS2_HOME}/steamcmd"
curl -sqL "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz" | tar zxvf -
chown -R "${CS2_USER}:${CS2_USER}" "${CS2_HOME}"

echo "[install] Downloading CS2 dedicated server (may take 30–45 min)..."
runuser -u "${CS2_USER}" -- bash -c "
  ${CS2_HOME}/steamcmd/steamcmd.sh +force_install_dir ${CS2_ROOT} +login anonymous +app_update 730 validate +quit
"

STEAMCLIENT32="${CS2_HOME}/steamcmd/linux32/steamclient.so"
STEAMCLIENT64="${CS2_HOME}/steamcmd/linux64/steamclient.so"
if [ ! -f "$STEAMCLIENT64" ]; then
  runuser -u "${CS2_USER}" -- "${CS2_HOME}/steamcmd/steamcmd.sh" \
    +@sSteamCmdForcePlatformType linux +login anonymous +quit || true
fi
if [ ! -f "$STEAMCLIENT64" ] && [ -f "$STEAMCLIENT32" ]; then
  mkdir -p "${CS2_HOME}/steamcmd/linux64"
  cp -a "$STEAMCLIENT32" "$STEAMCLIENT64"
fi
if [ -f "$STEAMCLIENT64" ]; then
  mkdir -p "${CS2_ROOT}/linux64" "${CS2_ROOT}/linuxsteamrt64"
  mkdir -p "${CS2_HOME}/.steam/sdk64" "${CS2_HOME}/.steam/sdk32"
  cp -a "$STEAMCLIENT64" "${CS2_HOME}/.steam/sdk64/steamclient.so"
  ln -sf "$STEAMCLIENT64" "${CS2_ROOT}/linux64/steamclient.so"
  ln -sf "$STEAMCLIENT64" "${CS2_ROOT}/linuxsteamrt64/steamclient.so"
  [ -f "$STEAMCLIENT32" ] && cp -a "$STEAMCLIENT32" "${CS2_HOME}/.steam/sdk32/steamclient.so"
  chown -R "${CS2_USER}:${CS2_USER}" "${CS2_HOME}/.steam"
  echo "[install] steamclient.so installed for cs2 user"
fi

CS2_SH="${CS2_ROOT}/game/cs2.sh"
CSGO_BIN="${CS2_DIR}/bin/linuxsteamrt64"
BIN_DIR="${CS2_ROOT}/game/bin/linuxsteamrt64"
mkdir -p "$CSGO_BIN"
if [ -d "$BIN_DIR" ]; then
  for lib in "$BIN_DIR"/libv8*.so; do
    [ -f "$lib" ] || continue
    ln -sf "$lib" "${CSGO_BIN}/$(basename "$lib")"
  done
  for lib in libclient.so libhost.so libmatchmaking.so libserver.so; do
    [ -f "${CSGO_BIN}/${lib}" ] && [ ! -e "${BIN_DIR}/${lib}" ] && ln -sf "../../csgo/bin/linuxsteamrt64/${lib}" "${BIN_DIR}/${lib}" || true
  done
  echo "[install] libv8 + game lib symlinks created"
fi

if [ ! -x "$CS2_SH" ] && [ ! -x "$CS2_BIN" ]; then
  echo "[install] FATAL: cs2.sh / cs2 binary missing under ${CS2_ROOT}/game"
  exit 1
fi

# Plugins on disk before first CS2 start (non-fatal). Fake RCON required for CS2.
if bash /root/install-plugins.sh "$CS2_DIR" "$CS2_USER" "__RCON_PASSWORD__"; then  echo "[install] Plugins installed on disk"
else
  echo "[install] WARN: Plugin install failed — continuing with base CS2"
fi
chown -R "${CS2_USER}:${CS2_USER}" "${CS2_ROOT}"

mkdir -p "$CS2_DIR/cfg" /etc/cs2-nexus

# Allow CS2 game traffic (UDP + TCP) and SSH before enabling host firewall.
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 27015/udp >/dev/null 2>&1 || true
  ufw allow 27015/tcp >/dev/null 2>&1 || true
  ufw allow 27020/udp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
  echo "[install] ufw enabled (27015 udp/tcp open)"
fi

open_cs2_ports() {
  iptables -C INPUT -p udp --dport 27015 -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport 27015 -j ACCEPT
  iptables -C INPUT -p tcp --dport 27015 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 27015 -j ACCEPT
  iptables -C INPUT -p udp --dport 27020 -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport 27020 -j ACCEPT
}
open_cs2_ports

cat > /usr/local/bin/open-cs2-ports.sh << 'FWEOF'
#!/bin/bash
set -euo pipefail
if command -v ufw >/dev/null 2>&1; then
  ufw allow 27015/udp >/dev/null 2>&1 || true
  ufw allow 27015/tcp >/dev/null 2>&1 || true
  ufw allow 27020/udp >/dev/null 2>&1 || true
fi
iptables -C INPUT -p udp --dport 27015 -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport 27015 -j ACCEPT
iptables -C INPUT -p tcp --dport 27015 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 27015 -j ACCEPT
iptables -C INPUT -p udp --dport 27020 -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport 27020 -j ACCEPT
FWEOF
chmod +x /usr/local/bin/open-cs2-ports.sh

cat > /etc/systemd/system/cs2-firewall.service << 'FWSVC'
[Unit]
Description=Open CS2 UDP/TCP ports for player connections
Before=cs2-server.service
After=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/open-cs2-ports.sh

[Install]
WantedBy=multi-user.target
FWSVC

systemctl daemon-reload
systemctl enable cs2-firewall.service 2>/dev/null || true
systemctl start cs2-firewall.service 2>/dev/null || true

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
mp_maxrounds 24
tv_enable 1
tv_delay 105
log on
sv_hibernate_when_empty 0
CFGEOF

cat > /etc/cs2-nexus/bridge.env << ENVEOF
WEBHOOK_SECRET=__WEBHOOK_SECRET__
BRIDGE_WEBHOOK_URL=__BRIDGE_WEBHOOK_URL__
RCON_PASSWORD=__RCON_PASSWORD__
ENVEOF

# rcon_password on command line AND in server.cfg (+exec server.cfg loads cfg/server.cfg)
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
Environment=LD_LIBRARY_PATH=${CS2_ROOT}/game/bin/linuxsteamrt64:${CS2_DIR}/bin/linuxsteamrt64
ExecStart=${CS2_SH} -dedicated -usercon -fakercon +ip 0.0.0.0 -port 27015 +sv_setsteamaccount __GSLT_TOKEN__ +map de_mirage +exec server.cfg +tv_port 27020
Restart=on-failure
RestartSec=15

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable cs2-server
systemctl start cs2-server
echo "[install] CS2 server started $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Verify Fake RCON locally (external checks from dev machines often fail due to VPN/firewall).
mkdir -p /var/lib/cs2-nexus
RCON_PASS="__RCON_PASSWORD__"
apt-get install -y mcrcon >/dev/null 2>&1 || true
for i in $(seq 1 120); do
  if timeout 3 bash -c "echo > /dev/tcp/127.0.0.1/27015" 2>/dev/null; then
    if command -v mcrcon >/dev/null 2>&1 && mcrcon -H 127.0.0.1 -P 27015 -p "$RCON_PASS" status 2>/dev/null | grep -qiE 'hostname|players'; then
      date -u +%Y-%m-%dT%H:%M:%SZ > /var/lib/cs2-nexus/rcon-ready
      echo "[install] Local RCON verified (attempt $i)"
      break
    fi
    if [ "$i" -eq 120 ]; then
      echo "[install] WARN: Port 27015 open but local RCON auth failed after 120 attempts"
    fi
  fi
  sleep 15
done

echo "[install] Finished $(date -u +%Y-%m-%dT%H:%M:%SZ)"
