#!/bin/bash
# Run on the CS2 VM as root (Vultr web console or SSH).
# Fixes "Cert request failed 5005 / not logged into Steam" so clients can connect.
set -euo pipefail

CS2_USER="${CS2_USER:-cs2}"
CS2_HOME="/home/${CS2_USER}"
CS2_ROOT="${CS2_HOME}/cs2-server"
CS2_DIR="${CS2_ROOT}/game/csgo"
BIN_DIR="${CS2_ROOT}/game/bin/linuxsteamrt64"
STEAM64="${CS2_HOME}/steamcmd/linux64/steamclient.so"
STEAM32="${CS2_HOME}/steamcmd/linux32/steamclient.so"
CFG="${CS2_DIR}/cfg/server.cfg"

GSLT="${1:-}"
if [ -z "$GSLT" ]; then
  echo "Usage: $0 YOUR_GSLT_TOKEN"
  echo "Get token: https://steamcommunity.com/dev/managegameservers (App ID 730)"
  if [ -f "$CFG" ]; then
    echo "Current sv_setsteamaccount:"
    grep setsteamaccount "$CFG" || true
  fi
  exit 1
fi

echo "[fix-steam] Ensuring steamcmd steamclient libraries..."
if [ ! -f "$STEAM64" ]; then
  runuser -u "$CS2_USER" -- "${CS2_HOME}/steamcmd/steamcmd.sh" \
    +@sSteamCmdForcePlatformType linux +login anonymous +quit || true
fi
if [ ! -f "$STEAM64" ] && [ -f "$STEAM32" ]; then
  mkdir -p "${CS2_HOME}/steamcmd/linux64"
  cp -a "$STEAM32" "$STEAM64"
fi
if [ ! -f "$STEAM64" ]; then
  echo "[fix-steam] FATAL: $STEAM64 missing"
  exit 1
fi

echo "[fix-steam] Linking steamclient.so for CS2 binary..."
mkdir -p "${CS2_ROOT}/linux64" "${CS2_ROOT}/linuxsteamrt64" "$BIN_DIR"
mkdir -p "${CS2_HOME}/.steam/sdk64" "${CS2_HOME}/.steam/sdk32"
cp -a "$STEAM64" "${CS2_HOME}/.steam/sdk64/steamclient.so"
ln -sfn "$STEAM64" "${CS2_ROOT}/linux64/steamclient.so"
ln -sfn "$STEAM64" "${CS2_ROOT}/linuxsteamrt64/steamclient.so"
ln -sfn "$STEAM64" "${BIN_DIR}/steamclient.so"
[ -f "$STEAM32" ] && cp -a "$STEAM32" "${CS2_HOME}/.steam/sdk32/steamclient.so"
chown -R "${CS2_USER}:${CS2_USER}" "${CS2_HOME}/.steam"

echo "[fix-steam] Writing GSLT to server.cfg..."
mkdir -p "$(dirname "$CFG")"
if [ ! -f "$CFG" ]; then
  cat > "$CFG" << EOF
hostname "Studiosgamesrs | Nexus Tournament"
sv_password ""
rcon_password "changeme"
sv_setsteamaccount "$GSLT"
sv_lan 0
EOF
else
  if grep -q setsteamaccount "$CFG"; then
    sed -i "s|^sv_setsteamaccount.*|sv_setsteamaccount \"$GSLT\"|" "$CFG"
  else
    echo "sv_setsteamaccount \"$GSLT\"" >> "$CFG"
  fi
fi
chown "$CS2_USER:$CS2_USER" "$CFG"

echo "[fix-steam] Patching systemd unit with +sv_setsteamaccount..."
UNIT=/etc/systemd/system/cs2-server.service
if [ -f "$UNIT" ] && ! grep -q '+sv_setsteamaccount' "$UNIT"; then
  sed -i "s|-port 27015 |-port 27015 +sv_setsteamaccount ${GSLT} |" "$UNIT"
  systemctl daemon-reload
fi

echo "[fix-steam] Restarting cs2-server..."
systemctl restart cs2-server
sleep 15

echo "[fix-steam] Recent Steam log lines:"
journalctl -u cs2-server -n 25 --no-pager | grep -iE 'steam|cert|logged' || journalctl -u cs2-server -n 10 --no-pager

echo "[fix-steam] Done. Wait 1–2 min, then client: connect $(curl -4 -s ifconfig.me):27015"
