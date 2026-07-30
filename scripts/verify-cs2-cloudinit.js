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

const path = require('path');
const pack = require(path.join(__dirname, '..', 'functions', 'cs2-nexus', 'lib', 'cloud-init-pack.js'));

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

function parseWriteFiles(yaml) {
  const entries = [];
  const re = /^ {2}- path: (.+)\n {4}permissions: '[^']*'\n {4}content: \|\n([\s\S]*?)(?=^ {2}- path: |^runcmd:)/gm;
  let m;
  while ((m = re.exec(yaml)) !== null) {
    entries.push({ path: m[1], body: m[2] });
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

  const bytes = Buffer.byteLength(yaml, 'utf8');
  if (bytes > MAX_YAML_BYTES) {
    fail(label + ': user-data is ' + bytes + ' bytes, over the ' + MAX_YAML_BYTES + ' limit');
  } else {
    ok(label + ': user-data ' + bytes + ' bytes (limit ' + MAX_YAML_BYTES + ')');
  }
}

const savedSnapshot = process.env.VULTR_SNAPSHOT_ID;

delete process.env.VULTR_SNAPSHOT_ID;
checkMode('full install');

process.env.VULTR_SNAPSHOT_ID = savedSnapshot || 'verify-placeholder';
checkMode('snapshot boot');

if (savedSnapshot === undefined) delete process.env.VULTR_SNAPSHOT_ID;
else process.env.VULTR_SNAPSHOT_ID = savedSnapshot;

if (failed) {
  console.error('\n[verify-cs2-cloudinit]', failed, 'check(s) failed');
  process.exit(1);
}

console.log('\n[verify-cs2-cloudinit] All checks passed.');
