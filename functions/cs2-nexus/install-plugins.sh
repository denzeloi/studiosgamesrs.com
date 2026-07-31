#!/bin/bash
# Install Metamod, Fake RCON, CounterStrikeSharp, MatchZy, and NexusBridge.
# CS2 native RCON is broken — Fake RCON (Metamod) restores standard TCP RCON on port 27015.
set -uo pipefail

CS2_DIR="${1:-/home/cs2/cs2-server/game/csgo}"
CS2_USER="${2:-cs2}"
RCON_PASS="${3:-}"
CS2_ROOT="$(dirname "$(dirname "$CS2_DIR")")"
LOG="/var/log/cs2-nexus-plugins.log"
exec > >(tee -a "$LOG") 2>&1
echo "=== CS2 plugin install started $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

apt-get install -y libicu-dev unzip wget tar dotnet-sdk-8.0 >/dev/null

TMP="/tmp/cs2-plugins-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

patch_gameinfo_metamod() {
  local gi="$1"
  if [ ! -f "$gi" ]; then
    echo "[plugins] WARN: missing $gi"
    return 1
  fi
  sed -i '/addons\/metamod/d' "$gi"
  if grep -q 'SearchPaths' "$gi"; then
    awk '
      /SearchPaths/ { in_sp = 1 }
      in_sp && /^[[:space:]]*\{/ && !done {
        print
        print "\t\t\tGame\tcsgo/addons/metamod"
        done = 1
        next
      }
      { print }
    ' "$gi" > "$gi.tmp" && mv "$gi.tmp" "$gi"
    echo "[plugins] Patched $gi — metamod first in SearchPaths"
    return 0
  fi
  echo "[plugins] WARN: SearchPaths not found in $gi"
  return 1
}

install_matchzy_configs() {
  local dst="$CS2_DIR/cfg/MatchZy"
  mkdir -p "$dst"
  if [ -d /root/matchzy-cfg ]; then
    cp -a /root/matchzy-cfg/. "$dst/"
    echo "[plugins] MatchZy configs copied from /root/matchzy-cfg"
    return 0
  fi
  # Fallback only, for a VM booted without /root/matchzy-cfg. Must stay in step with
  # cs2-server/cfg/MatchZy/config.cfg; verify-cs2-matchzy.js compares the two.
  cat > "$dst/config.cfg" << 'MZCFG'
// MatchZy - Studiosgamesrs Nexus tournament defaults
matchzy_knife_enabled_default 0
matchzy_minimum_ready_required 2
matchzy_stop_command_available 1
matchzy_whitelist_enabled_default 0
matchzy_kick_when_no_match_loaded 0
matchzy_chat_prefix [{Gold}Studiosgamesrs{Default}]
matchzy_admin_chat_prefix [{Red}Centinela{Default}]
matchzy_show_credits_on_match_start 0
matchzy_hostname_format "Studiosgamesrs | {TEAM1} vs {TEAM2}"
matchzy_match_start_message "{Gold}Studiosgamesrs{Default} - partida oficial en marcha. Mucha suerte."
matchzy_demo_path Studiosgamesrs/
matchzy_demo_name_format "{TIME}_{MATCH_ID}_{MAP}_{TEAM1}_vs_{TEAM2}"
matchzy_use_pause_command_for_tactical_pause false
MZCFG
  cat > "$dst/warmup.cfg" << 'MZWU'
mp_freezetime 5
mp_warmuptime 300
mp_warmup_pausetimer 1
mp_maxrounds 24
mp_overtime_enable 1
mp_autokick 0
mp_autoteambalance 0
mp_limitteams 0
MZWU
  cat > "$dst/knife.cfg" << 'MZKN'
mp_freezetime 0
mp_warmuptime 0
mp_roundtime 1.92
mp_roundtime_defuse 1.92
MZKN
  cat > "$dst/live.cfg" << 'MZLV'
mp_freezetime 15
mp_warmuptime 0
mp_maxrounds 24
mp_overtime_enable 1
mp_halftime 1
mp_match_can_clinch 1
MZLV
  echo "[plugins] MatchZy configs written (embedded defaults)"
}

METAMOD_URL="${METAMOD_URL:-https://mms.alliedmods.net/mmsdrop/2.0/mmsource-2.0.0-git1410-linux.tar.gz}"
CSS_URL="${CSS_URL:-https://github.com/roflmuffin/CounterStrikeSharp/releases/download/v1.0.371/counterstrikesharp-with-runtime-linux-1.0.371.zip}"
MATCHZY_URL="${MATCHZY_URL:-https://github.com/shobhit-pathak/MatchZy/releases/download/0.8.15/MatchZy-0.8.15-with-cssharp-linux.zip}"
FAKERCON_URL="${FAKERCON_URL:-https://github.com/Salvatore-Als/cs2-fake-rcon/releases/latest/download/linux.tar.gz}"

echo "[plugins] Installing Metamod..."
wget -qO "$TMP/metamod.tar.gz" "$METAMOD_URL"
tar -xzf "$TMP/metamod.tar.gz" -C "$CS2_DIR"
patch_gameinfo_metamod "$CS2_DIR/gameinfo.gi"

echo "[plugins] Installing Fake RCON (CS2 native RCON is non-functional)..."
wget -qO "$TMP/fakercon.tar.gz" "$FAKERCON_URL"
tar -xzf "$TMP/fakercon.tar.gz" -C "$CS2_DIR"
if [ -n "$RCON_PASS" ]; then
  RCON_TXT="${CS2_ROOT}/game/bin/linuxsteamrt64/rcon.txt"
  mkdir -p "$(dirname "$RCON_TXT")"
  printf '%s\n' "$RCON_PASS" > "$RCON_TXT"
  chown "$CS2_USER:$CS2_USER" "$RCON_TXT"
  chmod 600 "$RCON_TXT"
  for FAKE_CFG in \
    "$CS2_DIR/addons/configs/fake_rcon/config.ini" \
    "$CS2_DIR/addons/config/fake_rcon/config.ini" \
    "$(find "$CS2_DIR/addons" -path '*/fake_rcon/config.ini' 2>/dev/null | head -1)"; do
    if [ -n "$FAKE_CFG" ] && [ -f "$FAKE_CFG" ]; then
      sed -i "s/^rcon_password.*/rcon_password = ${RCON_PASS}/" "$FAKE_CFG" 2>/dev/null || true
      echo "[plugins] Fake RCON config.ini updated: $FAKE_CFG"
    fi
  done
  echo "[plugins] Fake RCON password configured (rcon.txt + config.ini)"
fi

echo "[plugins] Installing CounterStrikeSharp..."
wget -qO "$TMP/css.zip" "$CSS_URL"
# Remove stale CSS binaries from golden snapshots (Oct 2025 builds break on CS2 1.41.7+).
rm -rf "$CS2_DIR/addons/counterstrikesharp"
unzip -qo "$TMP/css.zip" -d "$CS2_DIR"

CSS_SO="$CS2_DIR/addons/counterstrikesharp/bin/linuxsteamrt64/counterstrikesharp.so"
if [ -f "$CSS_SO" ]; then
  # CS2 1.41.7.x on Linux requires GNU_STACK cleared on counterstrikesharp.so (CSS #1365).
  if ! command -v execstack >/dev/null 2>&1; then
    wget -qO "$TMP/execstack.deb" \
      "https://snapshot.debian.org/archive/debian/20250721T022532Z/pool/main/p/prelink/execstack_0.0.20131005-1%2Bb10_amd64.deb"
    mkdir -p "$TMP/execstack-extract"
    dpkg-deb -x "$TMP/execstack.deb" "$TMP/execstack-extract"
    install -m 0755 "$TMP/execstack-extract/usr/bin/execstack" /usr/local/bin/execstack
  fi
  execstack -c "$CSS_SO" && echo "[plugins] execstack -c applied to counterstrikesharp.so"
fi

echo "[plugins] Installing MatchZy..."
wget -qO "$TMP/matchzy.zip" "$MATCHZY_URL"
mkdir -p "$TMP/matchzy"
unzip -qo "$TMP/matchzy.zip" -d "$TMP/matchzy"
# MatchZy zip bundles an old CounterStrikeSharp — copy only the plugin folder.
MATCHZY_PLUGIN_SRC="$TMP/matchzy/addons/counterstrikesharp/plugins/MatchZy"
if [ -d "$MATCHZY_PLUGIN_SRC" ]; then
  mkdir -p "$CS2_DIR/addons/counterstrikesharp/plugins/MatchZy"
  cp -a "$MATCHZY_PLUGIN_SRC/." "$CS2_DIR/addons/counterstrikesharp/plugins/MatchZy/"
  echo "[plugins] MatchZy plugin deployed (CSS binaries left untouched)"
else
  echo "[plugins] WARN: MatchZy plugin folder not found in archive"
fi

echo "[plugins] Building NexusBridge..."
NEXUS_SRC="/root/nexus-bridge-build"
mkdir -p "$NEXUS_SRC"
if [ -f /root/NexusBridgePlugin.cs ]; then
  cp /root/NexusBridgePlugin.cs "$NEXUS_SRC/"
fi
if [ -f /root/NexusBridge.csproj ]; then
  cp /root/NexusBridge.csproj "$NEXUS_SRC/"
else
  cat > "$NEXUS_SRC/NexusBridge.csproj" << 'EOF'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <AssemblyName>NexusBridge</AssemblyName>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="CounterStrikeSharp.API" Version="1.0.371" />
  </ItemGroup>
</Project>
EOF
  cp /root/NexusBridgePlugin.cs "$NEXUS_SRC/NexusBridgePlugin.cs" 2>/dev/null || true
fi

if [ -f "$NEXUS_SRC/NexusBridgePlugin.cs" ]; then
  cd "$NEXUS_SRC"
  dotnet build -c Release -o "$TMP/nexus-out" >/dev/null
  mkdir -p "$CS2_DIR/addons/counterstrikesharp/plugins/NexusBridge"
  cp "$TMP/nexus-out/NexusBridge.dll" "$CS2_DIR/addons/counterstrikesharp/plugins/NexusBridge/"
  echo "[plugins] NexusBridge deployed"
else
  echo "[plugins] WARN: NexusBridgePlugin.cs not found — skipping NexusBridge build"
fi

echo "[plugins] Installing MatchZy tournament configs..."
install_matchzy_configs

chown -R "$CS2_USER:$CS2_USER" "/home/$CS2_USER/cs2-server"
echo "=== CS2 plugin install finished $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
exit 0
