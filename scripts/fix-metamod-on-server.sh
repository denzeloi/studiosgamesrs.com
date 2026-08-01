#!/bin/bash
# Force Metamod to load on CS2.
# Proof of failure in journal:
#   Loaded .../game/bin/linuxsteamrt64/libserver.so   ← vanilla (plugins dead)
# Success looks like:
#   Loaded .../addons/metamod/bin/linuxsteamrt64/libserver.so
#
# Run as root: bash /root/fix-metamod-on-server.sh
set -euo pipefail

CS2_USER="${CS2_USER:-cs2}"
CS2_HOME="/home/${CS2_USER}"
CS2_ROOT="${CS2_HOME}/cs2-server"
CS2_DIR="${CS2_ROOT}/game/csgo"
CS2_SH="${CS2_ROOT}/game/cs2.sh"
GAME_BIN="${CS2_ROOT}/game/bin/linuxsteamrt64"
CSGO_BIN="${CS2_DIR}/bin/linuxsteamrt64"
GAMEINFO="${CS2_DIR}/gameinfo.gi"
MM_BIN="${CS2_DIR}/addons/metamod/bin/linuxsteamrt64"
SVC="/etc/systemd/system/cs2-server.service"
METAMOD_URL="${METAMOD_URL:-https://mms.alliedmods.net/mmsdrop/2.0/mmsource-2.0.0-git1410-linux.tar.gz}"

echo "=== CS2 Metamod FORCE fix $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

TMP="/tmp/metamod-fix-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

echo "[fix] Downloading Metamod..."
wget -qO "$TMP/metamod.tar.gz" "$METAMOD_URL"
tar -xzf "$TMP/metamod.tar.gz" -C "$CS2_DIR"

if [ -f "$MM_BIN/libserver.so.disabled" ] && [ ! -f "$MM_BIN/libserver.so" ]; then
  mv "$MM_BIN/libserver.so.disabled" "$MM_BIN/libserver.so"
fi
if [ ! -f "$MM_BIN/libserver.so" ]; then
  echo "FATAL: Metamod stub missing at $MM_BIN/libserver.so"
  ls -la "$MM_BIN" || true
  exit 1
fi
echo "[fix] Stub OK: $MM_BIN/libserver.so"

# Patch gameinfo — metamod as FIRST line inside SearchPaths { }
cp -a "$GAMEINFO" "${GAMEINFO}.bak.$(date +%s)"
sed -i '/addons\/metamod/d' "$GAMEINFO"
# Insert after the first "{" that follows SearchPaths
awk '
  BEGIN { done=0 }
  {
    print
    if (!done && prev ~ /SearchPaths/ && $0 ~ /^[[:space:]]*\{/) {
      print "\t\t\tGame\tcsgo/addons/metamod"
      done=1
    }
    prev=$0
  }
' "$GAMEINFO" > "$GAMEINFO.new" && mv "$GAMEINFO.new" "$GAMEINFO"
chown "$CS2_USER:$CS2_USER" "$GAMEINFO"
echo "[fix] gameinfo SearchPaths:"
awk '/SearchPaths/,/}/ { print NR": "$0; if (/}/ && n++) exit }' "$GAMEINFO" | head -15

# Keep a real vanilla libserver for Metamod stub to chain-load
mkdir -p "$CSGO_BIN"
if [ -f "${GAME_BIN}/libserver.so" ] && [ ! -L "${GAME_BIN}/libserver.so" ]; then
  [ -f "${GAME_BIN}/libserver.so.vanilla" ] || cp -a "${GAME_BIN}/libserver.so" "${GAME_BIN}/libserver.so.vanilla"
  [ -f "${CSGO_BIN}/libserver.so" ] || cp -a "${GAME_BIN}/libserver.so" "${CSGO_BIN}/libserver.so"
  echo "[fix] Preserved vanilla libserver.so"
elif [ -f "${GAME_BIN}/libserver.so.vanilla" ]; then
  [ -f "${CSGO_BIN}/libserver.so" ] || cp -a "${GAME_BIN}/libserver.so.vanilla" "${CSGO_BIN}/libserver.so"
fi

# FORCE stub into the path CS2 always loads
rm -f "${GAME_BIN}/libserver.so"
ln -sfn "../../../csgo/addons/metamod/bin/linuxsteamrt64/libserver.so" "${GAME_BIN}/libserver.so"
echo "[fix] Forced stub symlink:"
ls -la "${GAME_BIN}/libserver.so"

ENSURE=/usr/local/bin/cs2-ensure-metamod.sh
cat > "$ENSURE" << 'ENSURE'
#!/bin/bash
GAME_BIN=/home/cs2/cs2-server/game/bin/linuxsteamrt64
CSGO_BIN=/home/cs2/cs2-server/game/csgo/bin/linuxsteamrt64
MM_STUB=/home/cs2/cs2-server/game/csgo/addons/metamod/bin/linuxsteamrt64/libserver.so
GAMEINFO=/home/cs2/cs2-server/game/csgo/gameinfo.gi
[ -f "$MM_STUB" ] || exit 0
if [ -f "$GAMEINFO" ] && ! grep -q 'addons/metamod' "$GAMEINFO"; then
  sed -i '/addons\/metamod/d' "$GAMEINFO" 2>/dev/null || true
  awk 'BEGIN{d=0}{print; if(!d && p~/SearchPaths/ && $0~/^[[:space:]]*\{/){print "\t\t\tGame\tcsgo/addons/metamod"; d=1} p=$0}' \
    "$GAMEINFO" > "${GAMEINFO}.new" 2>/dev/null && mv "${GAMEINFO}.new" "$GAMEINFO" || true
fi
if [ -f "${GAME_BIN}/libserver.so" ] && [ ! -L "${GAME_BIN}/libserver.so" ]; then
  mkdir -p "$CSGO_BIN"
  [ -f "${CSGO_BIN}/libserver.so" ] || cp -a "${GAME_BIN}/libserver.so" "${CSGO_BIN}/libserver.so" 2>/dev/null || true
  [ -f "${GAME_BIN}/libserver.so.vanilla" ] || cp -a "${GAME_BIN}/libserver.so" "${GAME_BIN}/libserver.so.vanilla" 2>/dev/null || true
fi
ln -sfn "../../../csgo/addons/metamod/bin/linuxsteamrt64/libserver.so" "${GAME_BIN}/libserver.so" 2>/dev/null || true
exit 0
ENSURE
chmod 755 "$ENSURE"
sed -i 's/\r$//' "$ENSURE"
/bin/bash "$ENSURE" || true
echo "[fix] ensure script installed at $ENSURE"

# Patch existing systemd unit in place (preserve GSLT / ExecStart args)
LD_PATH="${GAME_BIN}:${CSGO_BIN}"
if [ ! -f "$SVC" ]; then
  echo "FATAL: $SVC missing"
  exit 1
fi
# Remove old LD_LIBRARY / ExecStartPre lines then add correct ones
sed -i '/^Environment=LD_LIBRARY_PATH=/d' "$SVC"
sed -i '/^ExecStartPre=/d' "$SVC"
if grep -q '^Environment=DOTNET' "$SVC"; then
  sed -i "/^Environment=DOTNET/a Environment=LD_LIBRARY_PATH=${LD_PATH}" "$SVC"
else
  sed -i "/^\[Service\]/a Environment=LD_LIBRARY_PATH=${LD_PATH}" "$SVC"
fi
# "+" = run ExecStartPre as root (User=cs2 cannot read /root/)
sed -i '/^ExecStart=/i ExecStartPre=+/usr/local/bin/cs2-ensure-metamod.sh' "$SVC"

if [ -d /root/matchzy-cfg ]; then
  mkdir -p "${CS2_DIR}/cfg/MatchZy"
  cp -a /root/matchzy-cfg/. "${CS2_DIR}/cfg/MatchZy/"
fi

# Studiosgamesrs team logo (top-of-screen score bar + scoreboard, via mp_teamlogo_1/2).
# This is the path snapshot boots actually take (see cloud-init-snapshot.sh), so the
# fetch lives here too, not only in install-plugins.sh's install_team_logos. Pulled from
# a hosted mirror rather than embedded in cloud-init: the SVG+PNG are too big for the
# 60KB user-data cap that scripts/verify-cs2-cloudinit.js enforces. This only reaches
# the server's own disk (CS2 dropped sv_downloadurl, so there is no FastDL to re-serve
# it to clients) — see the LOGO_BASE_URL comment in lib/rcon.js for what that does and
# does not cover.
LOGO_BASE="${NEXUS_LOGO_BASE_URL:-https://studiosgamesrs.web.app/cs2-fastdl}"
SVG_DST="${CS2_DIR}/materials/panorama/images/tournaments/teams"
PNG_DST="${CS2_DIR}/resource/flash/econ/tournaments/teams"
mkdir -p "$SVG_DST" "$PNG_DST"
if wget -qO "$SVG_DST/sgrs.svg" "$LOGO_BASE/materials/panorama/images/tournaments/teams/sgrs.svg" \
    && wget -qO "$SVG_DST/sgrs.png" "$LOGO_BASE/materials/panorama/images/tournaments/teams/sgrs.png" \
    && wget -qO "$PNG_DST/sgrs.png" "$LOGO_BASE/resource/flash/econ/tournaments/teams/sgrs.png"; then
  echo "[fix] Studiosgamesrs team logo downloaded from $LOGO_BASE"
else
  echo "[fix] WARN: could not fetch the team logo from $LOGO_BASE — mp_teamlogo will precache nothing"
fi

chown -R "$CS2_USER:$CS2_USER" "$CS2_ROOT"
systemctl daemon-reload
if ! systemctl restart cs2-server; then
  echo "[fix] WARN: restart failed — check: systemctl status cs2-server"
  echo "[fix] If ExecStartPre failed, run: sed -i '/^ExecStartPre=/d' $SVC && systemctl daemon-reload && systemctl restart cs2-server"
  journalctl -u cs2-server -n 30 --no-pager || true
  exit 1
fi
echo "[fix] Waiting 90s..."
sleep 90

echo "=== DIAGNOSTIC (must show addons/metamod in Loaded path) ==="
ls -la "${GAME_BIN}/libserver.so"
journalctl -u cs2-server -b --no-pager | grep -i 'Loaded.*libserver' | tail -8
journalctl -u cs2-server -b --no-pager | grep -iE '\[META\]|CounterStrikeSharp|FATAL ERROR' | tail -20 || true

RCON_PASS="${RCON_PASSWORD:-}"
[ -z "$RCON_PASS" ] && [ -f "${GAME_BIN}/rcon.txt" ] && RCON_PASS=$(tr -d '\r\n' < "${GAME_BIN}/rcon.txt")
if command -v mcrcon >/dev/null 2>&1 && [ -n "$RCON_PASS" ]; then
  echo "--- meta version ---"
  mcrcon -H 127.0.0.1 -P 27015 -p "$RCON_PASS" "meta version" || true
  echo "--- css_plugins list ---"
  mcrcon -H 127.0.0.1 -P 27015 -p "$RCON_PASS" "css_plugins list" || true
fi
echo "=== Done ==="
