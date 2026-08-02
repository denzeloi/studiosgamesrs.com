#!/usr/bin/env node
'use strict';

/**
 * Static checks for the cs2-nexus cloud-init package (plugins + MatchZy configs).
 *
 * Run this after editing anything under cs2-server/cfg/MatchZy/, install-plugins.sh
 * or the NexusBridge plugin, to confirm the provisioner will still ship every file.
 *
 * CRLF matters here: shell scripts and CS2 .cfg files are consumed literally on the
 * Linux VM, so a stray \r breaks bash and turns cvar values into "2\r". C# sources
 * are compiled by dotnet and tolerate CRLF.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const repoRoot = path.join(__dirname, '..');
const pack = require(path.join(repoRoot, 'functions', 'cs2-nexus', 'lib', 'cloud-init-pack.js'));

const REQUIRED_FILES = [
  '/root/install-plugins.sh',
  '/root/fix-metamod-on-server.sh',
  '/usr/local/bin/cs2-ensure-metamod.sh',
  '/root/NexusBridgePlugin.cs',
  '/root/NexusBridge.csproj',
  '/root/matchzy-cfg/config.cfg',
  '/root/matchzy-cfg/warmup.cfg',
  '/root/matchzy-cfg/knife.cfg',
  '/root/matchzy-cfg/live.cfg',
];

// Vultr/cloud-init reject oversized user-data; stay well under the 64 KB ceiling.
const MAX_YAML_BYTES = 60 * 1024;

// CRLF is only tolerated in files compiled by dotnet on the VM.
const CRLF_ALLOWED = /\.(cs|csproj)$/;

let failed = 0;

function fail(msg) {
  console.error('FAIL', msg);
  failed += 1;
}

function ok(msg) {
  console.log('OK  ', msg);
}

/**
 * Los archivos que van comprimidos se descomprimen aquí igual que hará
 * cloud-init en la máquina: lo que se revisa tiene que ser lo que acaba en
 * disco, no el bulto que viaja.
 */
function decodeWriteFile(encoding, body) {
  const raw = body.replace(/^ {6}/gm, '');
  if (!encoding) return raw;
  return zlib.gunzipSync(Buffer.from(raw.replace(/\s+/g, ''), 'base64')).toString('utf8');
}

function parseWriteFiles(yaml) {
  const entries = [];
  const re = /^ {2}- path: (.+)\n {4}permissions: '[^']*'\n(?: {4}encoding: (\S+)\n)? {4}content: \|\n([\s\S]*?)(?=^ {2}- path: |^runcmd:)/gm;
  let m;
  while ((m = re.exec(yaml)) !== null) {
    entries.push({
      path: m[1],
      encoding: m[2] || null,
      body: m[2] ? decodeWriteFile(m[2], m[3]) : m[3],
    });
  }
  return entries;
}

function checkMode(label) {
  console.log('\n--- ' + label + ' ---');

  const yaml = pack.loadCloudInitYaml();
  const entries = parseWriteFiles(yaml);
  const paths = entries.map((e) => e.path);

  REQUIRED_FILES.forEach((p) => {
    if (paths.includes(p)) return;
    fail(label + ': missing ' + p + ' in cloud-init write_files');
  });
  if (!failed) ok(label + ': all ' + REQUIRED_FILES.length + ' required files embedded (' + paths.length + ' total)');

  entries.forEach((e) => {
    if (CRLF_ALLOWED.test(e.path)) return;
    if (e.body.includes('\r')) {
      fail(label + ': ' + e.path + ' contains CR — convert it to LF endings');
    }
  });

  if (!yaml.startsWith('#cloud-config\n')) {
    fail(label + ': YAML must start with the #cloud-config header');
  }
  if (!/^runcmd:$/m.test(yaml)) {
    fail(label + ': YAML has no runcmd section');
  }

  // The hook is useless unless the unit calls it, so assert both halves exist.
  const bootScript = entries.find((e) => /\/root\/(install-cs2|configure-cs2)\.sh$/.test(e.path));
  if (!bootScript) {
    fail(label + ': no boot script (install-cs2.sh / configure-cs2.sh) in the package');
  } else if (!bootScript.body.includes('ExecStartPre=-/usr/local/bin/cs2-ensure-metamod.sh')) {
    fail(label + ': cs2-server.service is missing the cs2-ensure-metamod.sh ExecStartPre hook');
  } else {
    ok(label + ': cs2-server.service runs the metamod hook before start');
  }

  // El plugin viaja comprimido para no reventar el techo del user-data. Si la
  // compresión se rompe la máquina arranca igual y compila basura, así que aquí
  // se descomprime y se compara con el original antes de dejar salir el deploy.
  const plugin = entries.find((e) => e.path === '/root/NexusBridgePlugin.cs');
  if (plugin) {
    const source = pack.readRepoFile('cs2-server/plugins/NexusBridge/NexusBridgePlugin.cs');
    if (!plugin.encoding) {
      fail(label + ': NexusBridgePlugin.cs viaja sin comprimir y no cabe en el user-data');
    } else if (plugin.body !== source) {
      fail(label + ': NexusBridgePlugin.cs no se recupera igual al descomprimirlo');
    } else {
      ok(label + ': el plugin se descomprime idéntico al original');
    }
  }

  const bytes = Buffer.byteLength(yaml, 'utf8');
  if (bytes > MAX_YAML_BYTES) {
    fail(label + ': user-data is ' + bytes + ' bytes, over the ' + MAX_YAML_BYTES + ' limit');
  } else {
    ok(label + ': user-data ' + bytes + ' bytes (limit ' + MAX_YAML_BYTES + ')');
  }
}

/**
 * Cada máquina con su token de Steam. Las dos con el mismo y Valve echa a una,
 * justo a mitad de la partida que ya estaba en marcha.
 */
function checkGsltPerSlot() {
  console.log('\n--- token de Steam por ranura ---');

  const saved1 = process.env.GSLT_SERVER_1;
  const saved2 = process.env.GSLT_SERVER_2;
  process.env.GSLT_SERVER_1 = 'TOKEN-RANURA-UNO';
  process.env.GSLT_SERVER_2 = 'TOKEN-RANURA-DOS';

  const restore = function () {
    if (saved1 === undefined) delete process.env.GSLT_SERVER_1;
    else process.env.GSLT_SERVER_1 = saved1;
    if (saved2 === undefined) delete process.env.GSLT_SERVER_2;
    else process.env.GSLT_SERVER_2 = saved2;
  };

  try {
    if (pack.gsltForSlot(0) !== 'TOKEN-RANURA-UNO') fail('la primera ranura no usa GSLT_SERVER_1');
    else ok('la primera ranura usa su token');

    if (pack.gsltForSlot(1) !== 'TOKEN-RANURA-DOS') fail('la segunda ranura no usa GSLT_SERVER_2');
    else ok('la segunda ranura usa el suyo');

    const first = pack.loadCloudInitYaml({ gsltSlot: 0 });
    const second = pack.loadCloudInitYaml({ gsltSlot: 1 });
    if (!first.includes('TOKEN-RANURA-UNO') || first.includes('TOKEN-RANURA-DOS')) {
      fail('el arranque de la primera máquina no lleva su token');
    } else if (!second.includes('TOKEN-RANURA-DOS') || second.includes('TOKEN-RANURA-UNO')) {
      fail('el arranque de la segunda máquina lleva el token de la primera');
    } else {
      ok('las dos máquinas arrancan con tokens distintos');
    }

    // Sin segundo token se sigue levantando, con el de siempre y avisando.
    delete process.env.GSLT_SERVER_2;
    if (pack.gsltForSlot(1) !== 'TOKEN-RANURA-UNO') {
      fail('sin GSLT_SERVER_2 la segunda ranura debería caer a la primera');
    } else {
      ok('sin segundo token se cae al primero en vez de arrancar sin ninguno');
    }
  } finally {
    restore();
  }
}

/**
 * The check that was missing, and the reason the game chat kept the plugin's name for
 * weeks: everything above passes on a laptop because the repo root is one folder up. A
 * deploy only uploads functions/cs2-nexus, so unless these files are copied inside it,
 * the provisioner ships nothing and says nothing.
 */
function checkAssetsTravelWithTheDeploy() {
  console.log('\n--- los archivos del servidor viajan con la funcion ---');

  pack.REPO_ASSETS.forEach(function (relPath) {
    const bundled = path.join(pack.BUNDLED_ASSETS_DIR, relPath);
    if (!fs.existsSync(bundled)) {
      fail(relPath + ' no esta en server-assets/ — corre: node scripts/sync-cs2-server-assets.js');
      return;
    }
    const source = fs.readFileSync(path.join(repoRoot, relPath), 'utf8').replace(/\r\n/g, '\n');
    const copy = fs.readFileSync(bundled, 'utf8').replace(/\r\n/g, '\n');
    if (source !== copy) {
      fail(relPath + ' difiere de su copia en server-assets/ — corre: node scripts/sync-cs2-server-assets.js');
    } else {
      ok(relPath + ' viaja con el deploy');
    }
  });

  // Con solo la copia interna el paquete tiene que salir completo: eso es exactamente lo
  // que ve Cloud Functions, sin la raiz del repositorio al alcance.
  const bundledOnly = pack.readRepoFile('cs2-server/cfg/MatchZy/config.cfg');
  if (!bundledOnly || !/Studiosgamesrs/.test(bundledOnly)) {
    fail('readRepoFile no encuentra el config de MatchZy dentro del codebase');
  } else {
    ok('readRepoFile lee el config de MatchZy desde dentro del codebase');
  }
}

/**
 * Whoever handles Metamod also handled the configs, and both branches could skip them
 * without failing. The copy has to happen on its own, before the service starts.
 */
function checkSnapshotWritesMatchZyConfig() {
  console.log('\n--- el arranque desde snapshot deja los cfg de MatchZy ---');

  const src = fs.readFileSync(
    path.join(repoRoot, 'functions', 'cs2-nexus', 'cloud-init-snapshot.sh'), 'utf8'
  );
  const copyAt = src.indexOf('cp -a /root/matchzy-cfg/.');
  const restartAt = src.indexOf('systemctl restart cs2-server');

  if (copyAt === -1) {
    fail('cloud-init-snapshot.sh no copia /root/matchzy-cfg por su cuenta');
  } else if (restartAt === -1 || copyAt > restartAt) {
    fail('los cfg se copian despues de arrancar CS2, asi que el plugin ya leyo los viejos');
  } else {
    ok('los cfg se copian antes de arrancar CS2');
  }
}

const savedSnapshot = process.env.VULTR_SNAPSHOT_ID;

delete process.env.VULTR_SNAPSHOT_ID;
checkMode('full install');
checkGsltPerSlot();

process.env.VULTR_SNAPSHOT_ID = savedSnapshot || 'verify-placeholder';
checkMode('snapshot boot');
checkAssetsTravelWithTheDeploy();
checkSnapshotWritesMatchZyConfig();

if (savedSnapshot === undefined) delete process.env.VULTR_SNAPSHOT_ID;
else process.env.VULTR_SNAPSHOT_ID = savedSnapshot;

if (failed) {
  console.error('\n[verify-cs2-cloudinit]', failed, 'check(s) failed');
  process.exit(1);
}

console.log('\n[verify-cs2-cloudinit] All checks passed.');
