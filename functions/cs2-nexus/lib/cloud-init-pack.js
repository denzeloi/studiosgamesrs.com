'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function envValue(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback || '';
  return String(raw).trim().replace(/\r$/, '');
}

function usesSnapshot() {
  const provider = envValue('CS2_CLOUD_PROVIDER', 'vultr').toLowerCase();
  if (provider === 'hetzner') {
    return !!envValue('HETZNER_SNAPSHOT_ID');
  }
  return !!envValue('VULTR_SNAPSHOT_ID');
}

/**
 * Token de Steam de la máquina que se está levantando.
 *
 * En modo dos servidores hay un token por ranura. Arrancar las dos con el mismo
 * hace que Steam invalide la sesión de la primera: la partida que ya estaba en
 * marcha se queda sin conexión con Valve a mitad de torneo. Si la segunda ranura
 * no tiene token propio se cae a la primera, que es lo que había siempre, pero
 * queda anotado en el log.
 */
function gsltForSlot(slot) {
  const wanted = Number(slot) === 1 ? 'GSLT_SERVER_2' : 'GSLT_SERVER_1';
  const token = envValue(wanted);
  if (token) return token;
  if (wanted === 'GSLT_SERVER_2') {
    console.warn('[cloud-init] GSLT_SERVER_2 sin configurar: la segunda máquina '
      + 'arranca con el token de la primera y Steam puede desconectar a una de las dos.');
  }
  return envValue('GSLT_SERVER_1');
}

/**
 * Los identificadores viajan a un archivo de entorno que se lee con `source`,
 * así que un salto de línea o una comilla convertirían el resto del archivo en
 * otra cosa. Son claves de Firebase (letras, dígitos, guiones), y lo que no lo
 * sea no vale la pena arriesgarlo.
 */
function safeEnvId(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]/g, '');
}

function loadCloudInitScript(mode, opts) {
  const file = mode === 'snapshot' ? 'cloud-init-snapshot.sh' : 'cloud-init.sh';
  const scriptPath = path.join(__dirname, '..', file);
  let script = fs.readFileSync(scriptPath, 'utf8');
  const rcon = envValue('RCON_PASSWORD', 'changeme');
  const gslt = gsltForSlot(opts && opts.gsltSlot);
  const secret = envValue('WEBHOOK_SECRET');
  const webhookUrl = envValue('CS2_WEBHOOK_URL');
  // El puente descartaba todo evento hasta que el lanzamiento le mandaba el
  // contexto por RCON. Grabarlo al arrancar la máquina es lo que permite que la
  // sala vea a quien entra a calentar antes de que la partida exista.
  const tournamentId = safeEnvId(opts && opts.tournamentId);
  const matchId = safeEnvId(opts && opts.matchId);
  script = script
    .replace(/__RCON_PASSWORD__/g, rcon)
    .replace(/__GSLT_TOKEN__/g, gslt)
    .replace(/__WEBHOOK_SECRET__/g, secret)
    .replace(/__BRIDGE_WEBHOOK_URL__/g, webhookUrl)
    .replace(/__NEXUS_TOURNAMENT_ID__/g, tournamentId)
    .replace(/__NEXUS_MATCH_ID__/g, matchId);
  return script;
}

function indentCloudInit(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map((l) => `${pad}${l}`).join('\n');
}

/**
 * El user-data de Vultr tiene un techo de 64 KB y la máquina no arranca si se
 * pasa. El grueso del paquete es el código fuente del plugin, que en la máquina
 * no lo lee nadie: se compila. Comprimirlo lo baja a un cuarto y devuelve el
 * presupuesto de arranque a los scripts, que sí hay que poder leer en la
 * consola de Vultr cuando algo falla.
 *
 * 'gzip+base64' lo descomprime cloud-init él solo al escribir el archivo; la
 * imagen es Ubuntu 24.04 y lo soporta desde hace más de diez años.
 */
const GZIP_ENCODING = 'gzip+base64';
const GZIP_WRAP_COLUMNS = 120;

function gzipForCloudInit(content) {
  const packed = zlib.gzipSync(Buffer.from(content, 'utf8'), { level: 9 }).toString('base64');
  const lines = [];
  for (let i = 0; i < packed.length; i += GZIP_WRAP_COLUMNS) {
    lines.push(packed.slice(i, i + GZIP_WRAP_COLUMNS));
  }
  return lines.join('\n');
}

/**
 * Files that live outside functions/cs2-nexus but have to travel with it.
 *
 * A deploy only uploads the codebase folder named in firebase.json, so reading the repo
 * root worked on a laptop and returned nothing in production: the MatchZy configs and the
 * Metamod scripts were quietly missing from every provisioned machine, which is why the
 * game chat kept the plugin's own name. server-assets/ is a committed copy inside the
 * codebase, kept in step by scripts/sync-cs2-server-assets.js.
 */
const BUNDLED_ASSETS_DIR = path.join(__dirname, '..', 'server-assets');

function readRepoFile(relPath) {
  const candidates = [
    path.join(BUNDLED_ASSETS_DIR, relPath),
    path.join(__dirname, '..', '..', '..', relPath),
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    if (fs.existsSync(candidates[i])) return fs.readFileSync(candidates[i], 'utf8');
  }
  return null;
}

const MATCHZY_CFG_NAMES = ['config.cfg', 'warmup.cfg', 'knife.cfg', 'live.cfg'];

// Everything readRepoFile has to find. scripts/sync-cs2-server-assets.js mirrors this
// list into server-assets/ and verify-cs2-cloudinit.js refuses a deploy if a copy drifts.
const REPO_ASSETS = [
  'scripts/fix-metamod-on-server.sh',
  'scripts/cs2-ensure-metamod.sh',
  'cs2-server/plugins/NexusBridge/NexusBridgePlugin.cs',
  'cs2-server/plugins/NexusBridge/NexusBridge.csproj',
].concat(MATCHZY_CFG_NAMES.map(function (name) {
  return 'cs2-server/cfg/MatchZy/' + name;
}));

function loadMatchZyCfgFiles(files) {
  MATCHZY_CFG_NAMES.forEach(function (name) {
    const content = readRepoFile('cs2-server/cfg/MatchZy/' + name);
    if (content) {
      files.push({ path: '/root/matchzy-cfg/' + name, content: content });
    }
  });
}

function loadCloudInitYaml(opts) {
  const useMode = usesSnapshot() ? 'snapshot' : 'full';
  const script = loadCloudInitScript(useMode, opts);
  const runPath = useMode === 'snapshot' ? '/root/configure-cs2.sh' : '/root/install-cs2.sh';
  const files = [{ path: runPath, content: script }];

  files.push({
    path: '/root/install-plugins.sh',
    content: fs.readFileSync(path.join(__dirname, '..', 'install-plugins.sh'), 'utf8'),
  });
  const fixMetamod = readRepoFile('scripts/fix-metamod-on-server.sh');
  if (fixMetamod) {
    files.push({ path: '/root/fix-metamod-on-server.sh', content: fixMetamod });
  }
  const ensureMetamod = readRepoFile('scripts/cs2-ensure-metamod.sh');
  if (ensureMetamod) {
    files.push({ path: '/usr/local/bin/cs2-ensure-metamod.sh', content: ensureMetamod });
  }
  const nexusCs = readRepoFile('cs2-server/plugins/NexusBridge/NexusBridgePlugin.cs');
  const nexusProj = readRepoFile('cs2-server/plugins/NexusBridge/NexusBridge.csproj');
  if (nexusCs) files.push({ path: '/root/NexusBridgePlugin.cs', content: nexusCs, gzip: true });
  if (nexusProj) files.push({ path: '/root/NexusBridge.csproj', content: nexusProj });
  loadMatchZyCfgFiles(files);

  if (useMode === 'snapshot') {
    files.push({
      path: '/root/install-cs2-full.sh',
      content: loadCloudInitScript('full', opts),
    });
  }

  let yaml = '#cloud-config\nwrite_files:\n';
  files.forEach((f) => {
    const body = f.gzip ? gzipForCloudInit(f.content) : f.content;
    const encoding = f.gzip ? `    encoding: ${GZIP_ENCODING}\n` : '';
    yaml += `  - path: ${f.path}\n    permissions: '0755'\n${encoding}    content: |\n${indentCloudInit(body, 6)}\n`;
  });
  yaml += `runcmd:\n  - [ bash, ${runPath} ]\n`;
  return yaml;
}

module.exports = {
  envValue,
  gsltForSlot,
  usesSnapshot,
  loadCloudInitYaml,
  loadCloudInitScript,
  readRepoFile,
  BUNDLED_ASSETS_DIR,
  MATCHZY_CFG_NAMES,
  REPO_ASSETS,
};
