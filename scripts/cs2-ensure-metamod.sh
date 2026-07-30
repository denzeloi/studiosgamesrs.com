#!/bin/bash
# Runs before cs2-server start — keeps Metamod stub symlink + gameinfo patch.
# Must always exit 0 so a hook failure never stops CS2 from starting.
GAME_BIN=/home/cs2/cs2-server/game/bin/linuxsteamrt64
CSGO_BIN=/home/cs2/cs2-server/game/csgo/bin/linuxsteamrt64
MM_STUB=/home/cs2/cs2-server/game/csgo/addons/metamod/bin/linuxsteamrt64/libserver.so
GAMEINFO=/home/cs2/cs2-server/game/csgo/gameinfo.gi

if [ ! -f "$MM_STUB" ]; then
  exit 0
fi

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
