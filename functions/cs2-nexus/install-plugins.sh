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

METAMOD_URL="${METAMOD_URL:-https://mms.alliedmods.net/mmsdrop/2.0/mmsource-2.0.0-git1398-linux.tar.gz}"
CSS_URL="${CSS_URL:-https://github.com/roflmuffin/CounterStrikeSharp/releases/download/v1.0.371/counterstrikesharp-with-runtime-linux-1.0.371.zip}"
MATCHZY_URL="${MATCHZY_URL:-https://github.com/shobhit-pathak/MatchZy/releases/download/0.8.15/MatchZy-0.8.15-with-cssharp-linux.zip}"
FAKERCON_URL="${FAKERCON_URL:-https://github.com/Salvatore-Als/cs2-fake-rcon/releases/latest/download/linux.tar.gz}"

echo "[plugins] Installing Metamod..."
wget -qO "$TMP/metamod.tar.gz" "$METAMOD_URL"
tar -xzf "$TMP/metamod.tar.gz" -C "$CS2_DIR"

GAMEINFO="$CS2_DIR/gameinfo.gi"
if [ -f "$GAMEINFO" ] && ! grep -q 'addons/metamod' "$GAMEINFO"; then
  sed -i '/^[[:space:]]*Game[[:space:]]*csgo$/a\                        Game    csgo/addons/metamod' "$GAMEINFO"
  echo "[plugins] Patched gameinfo.gi for Metamod"
fi

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
unzip -qo "$TMP/css.zip" -d "$CS2_DIR"

echo "[plugins] Installing MatchZy..."
wget -qO "$TMP/matchzy.zip" "$MATCHZY_URL"
mkdir -p "$TMP/matchzy"
unzip -qo "$TMP/matchzy.zip" -d "$TMP/matchzy"
if [ -d "$TMP/matchzy/addons" ]; then
  cp -a "$TMP/matchzy/addons/." "$CS2_DIR/addons/"
else
  mkdir -p "$CS2_DIR/addons/counterstrikesharp/plugins"
  cp -a "$TMP/matchzy/"* "$CS2_DIR/addons/counterstrikesharp/plugins/" 2>/dev/null || true
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

chown -R "$CS2_USER:$CS2_USER" "/home/$CS2_USER/cs2-server"
echo "=== CS2 plugin install finished $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
exit 0
