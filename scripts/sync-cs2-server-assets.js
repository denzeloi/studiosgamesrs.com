#!/usr/bin/env node
'use strict';

/**
 * Copies the CS2 server assets that live outside functions/cs2-nexus into
 * functions/cs2-nexus/server-assets/, so they actually reach production.
 *
 * A Firebase deploy only uploads the folder declared as the codebase source. Reading
 * ../../cs2-server from the provisioner worked on a laptop and returned nothing once
 * deployed, so provisioned machines were missing the MatchZy configs and the Metamod
 * scripts without a single error anywhere. The copies are committed on purpose: a deploy
 * should never depend on this script having been run first.
 *
 * Line endings are forced to LF. These files are read literally by bash and by the CS2
 * console on a Linux box, where a stray CR turns a value into "2\r".
 *
 *   node scripts/sync-cs2-server-assets.js          copy and report
 *   node scripts/sync-cs2-server-assets.js --check   fail if a copy is out of date
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const pack = require(path.join(repoRoot, 'functions', 'cs2-nexus', 'lib', 'cloud-init-pack.js'));

const checkOnly = process.argv.includes('--check');
const KEEP_CRLF = /\.(cs|csproj)$/;

let changed = 0;
let stale = 0;
let missing = 0;

function normalize(buffer, relPath) {
  if (KEEP_CRLF.test(relPath)) return buffer;
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

pack.REPO_ASSETS.forEach(function (relPath) {
  const src = path.join(repoRoot, relPath);
  const dst = path.join(pack.BUNDLED_ASSETS_DIR, relPath);

  if (!fs.existsSync(src)) {
    console.error('FALTA  ' + relPath + ' no existe en el repositorio');
    missing += 1;
    return;
  }

  const wanted = normalize(fs.readFileSync(src), relPath);
  const current = fs.existsSync(dst) ? fs.readFileSync(dst) : null;

  if (current && current.equals(wanted)) {
    console.log('IGUAL  ' + relPath);
    return;
  }

  if (checkOnly) {
    console.error('VIEJO  ' + relPath + ' — corre: node scripts/sync-cs2-server-assets.js');
    stale += 1;
    return;
  }

  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, wanted);
  console.log('COPIA  ' + relPath);
  changed += 1;
});

if (missing || stale) {
  console.error('\n[sync-cs2-server-assets] ' + (missing + stale) + ' problema(s)');
  process.exit(1);
}

console.log('\n[sync-cs2-server-assets] ' + (checkOnly
  ? 'todas las copias están al día.'
  : changed + ' archivo(s) actualizado(s).'));
