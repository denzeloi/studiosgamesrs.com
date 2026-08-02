#!/bin/bash
# CS2 Nexus — fast boot from golden cloud snapshot (CS2 already installed on disk)
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

# Ensure Metamod hook + tournament configs (always refresh gameinfo/LD_LIBRARY_PATH).
if [ -x /root/fix-metamod-on-server.sh ]; then
  bash /root/fix-metamod-on-server.sh || true
elif [ ! -f "$CS2_DIR/addons/metamod.vdf" ] && [ -x /root/install-plugins.sh ]; then
  echo "[snapshot] Metamod missing — installing plugins"
  bash /root/install-plugins.sh "$CS2_DIR" "$CS2_USER" "$RCON_PASS" || true
elif [ -x /root/install-plugins.sh ]; then
  echo "[snapshot] Refreshing plugins + MatchZy configs"
  bash /root/install-plugins.sh "$CS2_DIR" "$CS2_USER" "$RCON_PASS" || true
fi

# The branch above decides who copies the tournament configs, and each branch had its own
# way of not doing it: fix-metamod skips them when /root/matchzy-cfg is absent and it also
# exits early on any failure. A snapshot ships MatchZy's stock config, so a miss here is
# invisible — the server just keeps calling itself MatchZy in chat. Copy them here too,
# unconditionally and before the service starts.
if [ -d /root/matchzy-cfg ]; then
  mkdir -p "$CS2_DIR/cfg/MatchZy"
  cp -a /root/matchzy-cfg/. "$CS2_DIR/cfg/MatchZy/"
  chown -R "$CS2_USER:$CS2_USER" "$CS2_DIR/cfg/MatchZy" 2>/dev/null || true
  echo "[snapshot] MatchZy tournament configs in place: $(grep -c . "$CS2_DIR/cfg/MatchZy/config.cfg" 2>/dev/null || echo 0) lines"
else
  echo "[snapshot] WARN: /root/matchzy-cfg missing — MatchZy keeps its stock config"
fi

# El puente es lo que le cuenta al sitio quién entra, quién mata y cómo acaba
# la partida: sin él la máquina funciona, MatchZy funciona, y la web no se
# entera de nada. La rama de arriba suele tomar el camino de fix-metamod, que
# nunca ejecuta install-plugins.sh, así que este bloque es el único que instala
# el puente en un arranque desde imagen. Va antes de cs2-server.service para que
# CS2 lo cargue en el primer arranque.
#
# Antes esto pedía que la imagen ya trajera dotnet y, si no lo traía, se saltaba
# el bloque entero sin decir nada; el fallo se atribuía al DLL de la imagen, que
# tampoco existía. Ahora se instala lo que falte, el build deja registro y al
# final se comprueba que el archivo esté de verdad donde CS2 lo busca.
NEXUS_DEST="${CS2_DIR}/addons/counterstrikesharp/plugins/NexusBridge"
if [ -f /root/NexusBridgePlugin.cs ]; then
  if ! command -v dotnet >/dev/null 2>&1; then
    echo "[snapshot] dotnet missing — installing SDK to build NexusBridge"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq || true
    apt-get install -y -qq dotnet-sdk-8.0 >/dev/null 2>&1 || true
  fi
fi

if [ -f /root/NexusBridgePlugin.cs ] && command -v dotnet >/dev/null 2>&1; then
  echo "[snapshot] Building NexusBridge from cloud-init source"
  NEXUS_SRC="/root/nexus-bridge-build"
  NEXUS_OUT="/tmp/nexus-out"
  NEXUS_LOG="/var/log/cs2-nexus-bridge-build.log"
  mkdir -p "$NEXUS_SRC"
  cp /root/NexusBridgePlugin.cs "$NEXUS_SRC/"
  if [ -f /root/NexusBridge.csproj ]; then
    cp /root/NexusBridge.csproj "$NEXUS_SRC/"
  fi
  if (cd "$NEXUS_SRC" && dotnet build -c Release -o "$NEXUS_OUT" > "$NEXUS_LOG" 2>&1); then
    mkdir -p "$NEXUS_DEST"
    cp "$NEXUS_OUT/NexusBridge.dll" "$NEXUS_DEST/"
    chown -R "${CS2_USER}:${CS2_USER}" "$NEXUS_DEST" 2>/dev/null || true
    echo "[snapshot] NexusBridge built ($(date -u +%H:%M:%SZ))"
  else
    echo "[snapshot] WARN: NexusBridge build failed — see $NEXUS_LOG"
    tail -n 25 "$NEXUS_LOG" 2>/dev/null || true
  fi
elif [ -f /root/NexusBridgePlugin.cs ]; then
  echo "[snapshot] WARN: no dotnet available — NexusBridge cannot be built"
fi

if [ -f "${NEXUS_DEST}/NexusBridge.dll" ]; then
  echo "[snapshot] NexusBridge.dll in place ($(stat -c %s "${NEXUS_DEST}/NexusBridge.dll" 2>/dev/null || echo '?') bytes)"
else
  echo "[snapshot] ERROR: NexusBridge.dll missing — the site will not see this server"
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

# CS2 clients use UDP 27015 — ensure iptables allows it even if ufw state is stale.
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
NEXUS_TOURNAMENT_ID=__NEXUS_TOURNAMENT_ID__
NEXUS_MATCH_ID=__NEXUS_MATCH_ID__
ENVEOF

RCON_TXT="${CS2_ROOT}/game/bin/linuxsteamrt64/rcon.txt"
mkdir -p "$(dirname "$RCON_TXT")"
printf '%s\n' "$RCON_PASS" > "$RCON_TXT"
chown "$CS2_USER:$CS2_USER" "$RCON_TXT"
chmod 600 "$RCON_TXT"

STEAM32="${CS2_HOME}/steamcmd/linux32/steamclient.so"
STEAM64="${CS2_HOME}/steamcmd/linux64/steamclient.so"
BIN_DIR="${CS2_ROOT}/game/bin/linuxsteamrt64"
if [ ! -f "$STEAM64" ]; then
  runuser -u "$CS2_USER" -- "${CS2_HOME}/steamcmd/steamcmd.sh" \
    +@sSteamCmdForcePlatformType linux +login anonymous +quit || true
fi
if [ ! -f "$STEAM64" ] && [ -f "$STEAM32" ]; then
  mkdir -p "${CS2_HOME}/steamcmd/linux64"
  cp -a "$STEAM32" "$STEAM64"
fi
if [ -f "$STEAM64" ]; then
  mkdir -p "${CS2_ROOT}/linux64" "${CS2_ROOT}/linuxsteamrt64" "${BIN_DIR}"
  mkdir -p "${CS2_HOME}/.steam/sdk64" "${CS2_HOME}/.steam/sdk32"
  cp -a "$STEAM64" "${CS2_HOME}/.steam/sdk64/steamclient.so"
  ln -sfn "$STEAM64" "${CS2_ROOT}/linux64/steamclient.so"
  ln -sfn "$STEAM64" "${CS2_ROOT}/linuxsteamrt64/steamclient.so"
  ln -sfn "$STEAM64" "${BIN_DIR}/steamclient.so"
  [ -f "$STEAM32" ] && cp -a "$STEAM32" "${CS2_HOME}/.steam/sdk32/steamclient.so"
  chown -R "$CS2_USER:$CS2_USER" "${CS2_HOME}/.steam"
  echo "[snapshot] steamclient.so linked for linuxsteamrt64"
fi
CSGO_BIN="${CS2_DIR}/bin/linuxsteamrt64"
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
Environment=LD_LIBRARY_PATH=${CS2_ROOT}/game/bin/linuxsteamrt64:${CS2_DIR}/bin/linuxsteamrt64
ExecStartPre=-/usr/local/bin/cs2-ensure-metamod.sh
ExecStart=${CS2_SH} -dedicated -usercon -fakercon +ip 0.0.0.0 -port 27015 +sv_setsteamaccount __GSLT_TOKEN__ +map de_mirage +exec server.cfg +tv_port 27020
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
