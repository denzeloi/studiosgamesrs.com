#!/usr/bin/env node
'use strict';

/**
 * Checks the in-game team-logo pipeline end to end, statically.
 *
 * CS2 shows mp_teamlogo_1/mp_teamlogo_2 in the top-of-screen score bar (SVG or PNG)
 * and the scoreboard/player panel (SVG only) — confirmed against a live 1.41.7.x server
 * (mp_teamlogo_1/2 accepted "sgrs" and read it back).
 *
 * IMPORTANT: CS2 removed sv_downloadurl (FastDL). "find download" on a live server
 * returns nothing. So this pipeline only gets the file onto the SERVER's own disk —
 * that makes the logo visible to the server operator and to anyone who drops the same
 * 3 files under their own CS2 install, but NOT automatically to every joining player.
 * That needs a Steam Workshop addon mounted via the MultiAddonManager Metamod plugin,
 * which needs a Workshop item published from an actual Steam account — a deliberate,
 * documented follow-up, not something any of these scripts attempt.
 *
 * What this DOES verify: the server-side file, the mp_teamlogo_1/mp_teamlogo_2 cvars,
 * and the two boot scripts that fetch the file all agree on the same short name, and
 * that nothing here quietly reintroduces the nonexistent sv_downloadurl.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

let failed = 0;
function fail(msg) { console.error('FAIL', msg); failed += 1; }
function ok(msg) { console.log('OK  ', msg); }

const LOGO_NAME = 'sgrs';
const SVG_REL = `materials/panorama/images/tournaments/teams/${LOGO_NAME}.svg`;
const PANORAMA_PNG_REL = `materials/panorama/images/tournaments/teams/${LOGO_NAME}.png`;
const LEGACY_PNG_REL = `resource/flash/econ/tournaments/teams/${LOGO_NAME}.png`;

console.log('\n--- file name convention ---');
if (LOGO_NAME.length > 5) {
  fail(`logo file name "${LOGO_NAME}" is longer than 5 chars — older CS2/Source clients truncate mp_teamlogo names`);
} else {
  ok(`logo file name "${LOGO_NAME}" is short enough (${LOGO_NAME.length} chars)`);
}

console.log('\n--- assets exist and look like real files ---');

function readBin(rel) {
  const p = path.join(repoRoot, 'cs2-fastdl', rel);
  if (!fs.existsSync(p)) {
    fail(`missing cs2-fastdl/${rel}`);
    return null;
  }
  return fs.readFileSync(p);
}

const svgBuf = readBin(SVG_REL);
if (svgBuf) {
  const text = svgBuf.toString('utf8');
  if (!/<svg[\s>]/.test(text)) {
    fail(`${SVG_REL} does not look like an SVG document`);
  } else if (!/<image[\s>]/.test(text)) {
    fail(`${SVG_REL} has no <image> element — Panorama needs actual pixels, not just markup`);
  } else {
    ok(`${SVG_REL} is a valid SVG wrapping an embedded image (${svgBuf.length} bytes)`);
  }
}

function checkPng(rel, buf, maxBytes) {
  if (!buf) return;
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) {
    fail(`${rel} does not start with the PNG signature`);
  } else if (buf.length > maxBytes) {
    fail(`${rel} is ${buf.length} bytes, over the ${maxBytes}-byte sanity ceiling for a scoreboard badge`);
  } else {
    ok(`${rel} is a valid PNG (${buf.length} bytes)`);
  }
}

checkPng(PANORAMA_PNG_REL, readBin(PANORAMA_PNG_REL), 200 * 1024);
checkPng(LEGACY_PNG_REL, readBin(LEGACY_PNG_REL), 50 * 1024);

console.log('\n--- server-tree copy matches the FastDL copy (no drift) ---');

[SVG_REL, PANORAMA_PNG_REL, LEGACY_PNG_REL].forEach((rel) => {
  const fastdl = path.join(repoRoot, 'cs2-fastdl', rel);
  const serverTree = path.join(repoRoot, 'cs2-server', rel);
  if (!fs.existsSync(fastdl) || !fs.existsSync(serverTree)) return; // already reported above
  const a = fs.readFileSync(fastdl);
  const b = fs.readFileSync(serverTree);
  if (!a.equals(b)) {
    fail(`cs2-server/${rel} does not match cs2-fastdl/${rel} byte for byte`);
  } else {
    ok(`cs2-server/${rel} matches the FastDL copy`);
  }
});

console.log('\n--- Firebase Hosting actually serves cs2-fastdl/ ---');

const firebaseJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'firebase.json'), 'utf8'));
const ignoreList = (firebaseJson.hosting && firebaseJson.hosting.ignore) || [];
const blocksFastdl = ignoreList.some((pattern) => {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$');
  return re.test('cs2-fastdl/materials/panorama/images/tournaments/teams/sgrs.svg');
});
if (blocksFastdl) {
  fail('firebase.json hosting.ignore matches cs2-fastdl/** — the logo would never deploy');
} else {
  ok('firebase.json hosting.ignore does not exclude cs2-fastdl/');
}
if (firebaseJson.hosting && firebaseJson.hosting.public !== '.') {
  fail(`firebase.json hosting.public is "${firebaseJson.hosting.public}", not "." — cs2-fastdl/ may not be inside the hosting root`);
} else {
  ok('firebase.json hosting.public is "." — cs2-fastdl/ is inside the hosting root');
}

console.log('\n--- rcon.js pushes cvars that match the hosted files ---');

const rcon = require(path.join(repoRoot, 'functions', 'cs2-nexus', 'lib', 'rcon.js'));
const rules = rcon.SERVER_RULES_CVARS || [];
const joinedRules = rules.join('\n');

if (!new RegExp('mp_teamlogo_1 ' + LOGO_NAME + '\\b').test(joinedRules)) {
  fail(`SERVER_RULES_CVARS does not push mp_teamlogo_1 ${LOGO_NAME}`);
} else {
  ok(`SERVER_RULES_CVARS pushes mp_teamlogo_1 ${LOGO_NAME}`);
}
if (!new RegExp('mp_teamlogo_2 ' + LOGO_NAME + '\\b').test(joinedRules)) {
  fail(`SERVER_RULES_CVARS does not push mp_teamlogo_2 ${LOGO_NAME}`);
} else {
  ok(`SERVER_RULES_CVARS pushes mp_teamlogo_2 ${LOGO_NAME}`);
}
if (joinedRules.includes('sv_downloadurl')) {
  fail('SERVER_RULES_CVARS still pushes sv_downloadurl — that cvar does not exist in CS2 (confirmed live: "Unknown command")');
} else {
  ok('SERVER_RULES_CVARS does not push the nonexistent sv_downloadurl cvar');
}

const probeNames = (rcon.BRANDING_PROBES || []).map((p) => p.cvar);
['mp_teamlogo_1', 'mp_teamlogo_2'].forEach((cvar) => {
  if (!probeNames.includes(cvar)) {
    fail(`BRANDING_PROBES has no readback probe for ${cvar}`);
  } else {
    ok(`BRANDING_PROBES can read ${cvar} back from a live server`);
  }
});

console.log('\n--- boot scripts fetch the exact same files RCON expects ---');

function checkBootScript(relPath, label) {
  const p = path.join(repoRoot, relPath);
  if (!fs.existsSync(p)) {
    fail(`${label}: ${relPath} not found`);
    return;
  }
  const src = fs.readFileSync(p, 'utf8');
  [SVG_REL, PANORAMA_PNG_REL, LEGACY_PNG_REL].forEach((rel) => {
    if (!src.includes(rel)) {
      fail(`${label}: does not fetch ${rel}`);
    }
  });
  if (!/NEXUS_LOGO_BASE_URL/.test(src)) {
    fail(`${label}: does not honor NEXUS_LOGO_BASE_URL for overriding the FastDL host`);
  }
  if (failed === 0) ok(`${label}: fetches all three logo files with the override honored`);
}

checkBootScript('functions/cs2-nexus/install-plugins.sh', 'install-plugins.sh (fresh install)');
checkBootScript('scripts/fix-metamod-on-server.sh', 'fix-metamod-on-server.sh (snapshot boot)');

console.log('\n--- baked-in server.cfg (both boot modes) sets the same cvars ---');

['functions/cs2-nexus/cloud-init.sh', 'functions/cs2-nexus/cloud-init-snapshot.sh'].forEach((rel) => {
  const p = path.join(repoRoot, rel);
  if (!fs.existsSync(p)) {
    fail(`${rel} not found`);
    return;
  }
  const src = fs.readFileSync(p, 'utf8');
  const block = src.match(/cat > "\$CS2_DIR\/cfg\/server\.cfg" << 'CFGEOF'\n([\s\S]*?)\nCFGEOF/);
  if (!block) {
    fail(`${rel}: could not find the server.cfg heredoc`);
    return;
  }
  const body = block[1];
  if (!/^mp_teamlogo_1 sgrs$/m.test(body) || !/^mp_teamlogo_2 sgrs$/m.test(body)) {
    fail(`${rel}: server.cfg heredoc is missing mp_teamlogo_1/mp_teamlogo_2`);
  } else if (body.includes('sv_downloadurl')) {
    fail(`${rel}: server.cfg heredoc still sets sv_downloadurl, a cvar CS2 does not have`);
  } else {
    ok(`${rel}: server.cfg bakes in mp_teamlogo_1/2`);
  }
});

console.log('\n--- MultiAddonManager is wired for when a Workshop ID exists ---');

function checkMultiAddon(relPath, label) {
  const p = path.join(repoRoot, relPath);
  if (!fs.existsSync(p)) {
    fail(`${label}: ${relPath} not found`);
    return;
  }
  const src = fs.readFileSync(p, 'utf8');
  if (!/MultiAddonManager/.test(src)) {
    fail(`${label}: does not install the MultiAddonManager plugin`);
  } else if (!/mm_extra_addons/.test(src)) {
    fail(`${label}: does not write mm_extra_addons into multiaddonmanager.cfg`);
  } else if (!/NEXUS_LOGO_WORKSHOP_ID/.test(src)) {
    fail(`${label}: does not read NEXUS_LOGO_WORKSHOP_ID for the addon ID`);
  } else if (!/mm_cache_clients_with_addons 1/.test(src)) {
    fail(`${label}: does not cache clients that already have the addon — every rejoin would re-show the download prompt`);
  } else {
    ok(`${label}: installs MultiAddonManager and wires mm_extra_addons to NEXUS_LOGO_WORKSHOP_ID`);
  }
}

checkMultiAddon('functions/cs2-nexus/install-plugins.sh', 'install-plugins.sh (fresh install)');
checkMultiAddon('scripts/fix-metamod-on-server.sh', 'fix-metamod-on-server.sh (snapshot boot)');

// Empty by default (no Workshop item published yet) must never crash rcon.js and must
// never push an empty mm_extra_addons that clobbers a value set some other way.
delete require.cache[path.join(repoRoot, 'functions', 'cs2-nexus', 'lib', 'rcon.js')];
const rconNoId = require(path.join(repoRoot, 'functions', 'cs2-nexus', 'lib', 'rcon.js'));
if (rconNoId.SERVER_RULES_CVARS.some((c) => c.includes('mm_extra_addons'))) {
  fail('rcon.js pushes mm_extra_addons even with CS2_LOGO_WORKSHOP_ID unset');
} else {
  ok('rcon.js pushes no mm_extra_addons while CS2_LOGO_WORKSHOP_ID is unset (safe no-op)');
}

if (failed) {
  console.error('\n[verify-cs2-logo]', failed, 'check(s) failed');
  process.exit(1);
}

console.log('\n[verify-cs2-logo] All checks passed.');
