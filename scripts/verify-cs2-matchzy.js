#!/usr/bin/env node
'use strict';

/**
 * Checks the MatchZy configuration before deploy.
 *
 * Two failure modes this catches, both of which bit us in production:
 *
 *  1. A convar that does not exist. CS2 does not reject the file, it just logs
 *     "Unknown command" for that line and keeps the default, so a setting looks
 *     applied while it never was. The known-good list below is the full set of
 *     convars shipped with MatchZy 0.8.15, the version install-plugins.sh pins.
 *
 *  2. The repo config and the fallback embedded in install-plugins.sh drifting
 *     apart, so a server gets different rules depending on how it booted.
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const cfgDir = path.join(repoRoot, 'cs2-server', 'cfg', 'MatchZy');
const repoCfgPath = path.join(cfgDir, 'config.cfg');
const installPath = path.join(repoRoot, 'functions', 'cs2-nexus', 'install-plugins.sh');

let failed = 0;

function fail(msg) {
  console.error('FAIL', msg);
  failed += 1;
}

function ok(msg) {
  console.log('OK  ', msg);
}

// Verbatim from cfg/MatchZy/config.cfg at tag 0.8.15.
const KNOWN_CONVARS = new Set([
  'matchzy_whitelist_enabled_default',
  'matchzy_knife_enabled_default',
  'matchzy_minimum_ready_required',
  'matchzy_demo_recording_enabled',
  'matchzy_demo_path',
  'matchzy_demo_name_format',
  'matchzy_stop_command_available',
  'matchzy_stop_command_no_damage',
  'matchzy_use_pause_command_for_tactical_pause',
  'matchzy_enable_tech_pause',
  'matchzy_tech_pause_flag',
  'matchzy_tech_pause_duration',
  'matchzy_max_tech_pauses_allowed',
  'matchzy_pause_after_restore',
  'matchzy_chat_prefix',
  'matchzy_admin_chat_prefix',
  'matchzy_chat_messages_timer_delay',
  'matchzy_playout_enabled_default',
  'matchzy_kick_when_no_match_loaded',
  'matchzy_reset_cvars_on_series_end',
  'matchzy_demo_upload_url',
  'matchzy_autostart_mode',
  'matchzy_save_nades_as_global_enabled',
  'matchzy_allow_force_ready',
  'matchzy_max_saved_last_grenades',
  'matchzy_smoke_color_enabled',
  'matchzy_everyone_is_admin',
  'matchzy_show_credits_on_match_start',
  'matchzy_hostname_format',
  'matchzy_enable_damage_report',
  'matchzy_match_start_message',
]);

// Settings that must read the same whichever config the server ends up with.
const MUST_MATCH = [
  'matchzy_knife_enabled_default',
  'matchzy_chat_prefix',
  'matchzy_show_credits_on_match_start',
  'matchzy_hostname_format',
  'matchzy_demo_path',
];

function parseConvars(text) {
  const out = {};
  text.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*(matchzy_[a-z_]+)\s+(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
}

console.log('\n--- convars exist in MatchZy 0.8.15 ---');

const repoCfg = fs.readFileSync(repoCfgPath, 'utf8');
const repoVars = parseConvars(repoCfg);

const installSrc = fs.readFileSync(installPath, 'utf8');
const heredoc = installSrc.match(/<< 'MZCFG'\n([\s\S]*?)\nMZCFG/);
if (!heredoc) {
  fail('Could not find the embedded MZCFG config block in install-plugins.sh');
}
const fallbackVars = heredoc ? parseConvars(heredoc[1]) : {};

[
  ['cs2-server config.cfg', repoVars],
  ['install-plugins.sh fallback', fallbackVars],
].forEach(([label, vars]) => {
  const unknown = Object.keys(vars).filter((k) => !KNOWN_CONVARS.has(k));
  if (unknown.length) {
    fail(`${label} sets convars that do not exist in 0.8.15 (CS2 will ignore them): ${unknown.join(', ')}`);
  } else {
    ok(`${label}: all ${Object.keys(vars).length} convars are real`);
  }
});

console.log('\n--- the two configs agree ---');

MUST_MATCH.forEach((key) => {
  const a = repoVars[key];
  const b = fallbackVars[key];
  if (a === undefined || b === undefined) {
    fail(`${key} is missing from ${a === undefined ? 'config.cfg' : 'the install-plugins.sh fallback'}`);
  } else if (a !== b) {
    fail(`${key} differs: config.cfg has "${a}", the fallback has "${b}"`);
  } else {
    ok(`${key} matches in both copies`);
  }
});

console.log('\n--- the RCON push agrees with the config ---');

// A running server gets these over RCON at launch, since a cfg change alone would only
// reach the next VM. If the two drift, a live server silently behaves differently.
const rconSrc = fs.readFileSync(path.join(repoRoot, 'functions', 'cs2-nexus', 'lib', 'rcon.js'), 'utf8');
const rulesBlock = rconSrc.match(/const SERVER_RULES_CVARS = \[([\s\S]*?)\];/);
if (!rulesBlock) {
  fail('Could not find SERVER_RULES_CVARS in rcon.js');
} else {
  const pushedLines = (rulesBlock[1].match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1));
  const pushed = parseConvars(pushedLines.join('\n'));
  const unknownPushed = Object.keys(pushed).filter((k) => !KNOWN_CONVARS.has(k));
  if (unknownPushed.length) {
    fail(`rcon.js pushes convars that do not exist in 0.8.15: ${unknownPushed.join(', ')}`);
  } else {
    ok(`rcon.js pushes ${Object.keys(pushed).length} real convars at launch`);
  }

  ['matchzy_knife_enabled_default', 'matchzy_chat_prefix', 'matchzy_show_credits_on_match_start'].forEach((key) => {
    const fromCfg = (repoVars[key] || '').replace(/^"|"$/g, '');
    const fromRcon = (pushed[key] || '').replace(/^"|"$/g, '');
    if (!fromRcon) {
      fail(`${key} is not pushed over RCON, so a running server keeps the old value`);
    } else if (fromCfg !== fromRcon) {
      fail(`${key} differs: config.cfg has "${fromCfg}", rcon.js pushes "${fromRcon}"`);
    } else {
      ok(`${key} is identical in the config and the RCON push`);
    }
  });
}

console.log('\n--- comment syntax ---');

fs.readdirSync(cfgDir)
  .filter((f) => f.endsWith('.cfg'))
  .forEach((file) => {
    const lines = fs.readFileSync(path.join(cfgDir, file), 'utf8').split(/\r?\n/);
    const hashLines = [];
    lines.forEach((line, i) => {
      if (/^\s*#/.test(line)) hashLines.push(i + 1);
    });
    if (hashLines.length) {
      // Source engine configs only understand "//"; a "#" line is run as a command.
      fail(`${file} uses "#" comments on line(s) ${hashLines.join(', ')} — use "//"`);
    } else {
      ok(`${file} uses // comments`);
    }
  });

console.log('\n--- encoding ---');

fs.readdirSync(cfgDir)
  .filter((f) => f.endsWith('.cfg'))
  .forEach((file) => {
    const raw = fs.readFileSync(path.join(cfgDir, file));
    const nonAscii = [];
    for (let i = 0; i < raw.length; i += 1) {
      if (raw[i] > 127) nonAscii.push(i);
    }
    if (nonAscii.length) {
      // These files are read by the game server and some values are printed in chat,
      // where a non-ASCII byte shows up as mojibake.
      fail(`${file} has ${nonAscii.length} non-ASCII byte(s), first at offset ${nonAscii[0]}`);
    } else {
      ok(`${file} is pure ASCII`);
    }
  });

console.log('\n--- branding ---');

if (/MatchZy/.test(repoVars.matchzy_chat_prefix || '')) {
  fail('The chat prefix still says MatchZy');
} else if (!/Studiosgamesrs/.test(repoVars.matchzy_chat_prefix || '')) {
  fail('The chat prefix does not carry the Studiosgamesrs brand');
} else {
  ok(`chat prefix is branded: ${repoVars.matchzy_chat_prefix}`);
}

if (repoVars.matchzy_show_credits_on_match_start !== '0') {
  fail('matchzy_show_credits_on_match_start must be 0, or the plugin credits print on match start');
} else {
  ok('the plugin credits message is off');
}

// Documented requirement: the last colour token has to be {Default}, otherwise the
// whole message inherits the prefix colour. Trailing brackets are fine.
const colourTokens = (repoVars.matchzy_chat_prefix || '').match(/\{[A-Za-z]+\}/g) || [];
if (colourTokens[colourTokens.length - 1] !== '{Default}') {
  fail('The chat prefix must close with {Default} or every message takes its colour');
} else {
  ok('the chat prefix closes its colour with {Default}');
}

console.log('\n--- sides are decided on the website ---');

const matchzy = require(path.join(repoRoot, 'functions', 'cs2-nexus', 'lib', 'matchzy.js'));
const mzSrc = fs.readFileSync(path.join(repoRoot, 'functions', 'cs2-nexus', 'lib', 'matchzy.js'), 'utf8');

if (/map_sides:\s*\['knife'\]/.test(mzSrc)) {
  fail('map_sides is hardcoded to knife — any player on the winning team could pick the side');
} else {
  ok('map_sides is not hardcoded to a knife round');
}

const sideCases = [
  ['team1_ct', 'team1_ct'],
  ['team1_t', 'team1_t'],
  ['team2_ct', 'team1_t'],
  ['team2_t', 'team1_ct'],
  ['knife', 'knife'],
  ['random', 'random'],
  ['', 'random'],
  [undefined, 'random'],
  ['garbage', 'random'],
  ['TEAM1_T', 'team1_t'],
];

sideCases.forEach(([input, expected]) => {
  const got = matchzy.normalizeSide(input);
  if (got !== expected) {
    fail(`normalizeSide(${JSON.stringify(input)}) returned "${got}", expected "${expected}"`);
  } else {
    ok(`normalizeSide(${JSON.stringify(input)}) -> ${got}`);
  }
});

if (matchzy.DEFAULT_SIDE !== 'random') {
  fail(`The default side should be a fair draw, got "${matchzy.DEFAULT_SIDE}"`);
} else {
  ok('the default is a fair draw');
}

console.log('\n--- the draw is fair and never leaves it to the game ---');

// resolveSide must always hand MatchZy a concrete value; 'random' reaching the config
// would be an invalid map_sides entry.
['team1_ct', 'team1_t', 'knife', 'random', '', 'garbage'].forEach((input) => {
  const got = matchzy.resolveSide(input);
  if (got === 'random') {
    fail(`resolveSide(${JSON.stringify(input)}) left the draw unresolved`);
  } else if (!['team1_ct', 'team1_t', 'knife'].includes(got)) {
    fail(`resolveSide(${JSON.stringify(input)}) returned "${got}", which MatchZy does not accept`);
  } else {
    ok(`resolveSide(${JSON.stringify(input)}) -> ${got}`);
  }
});

// Both outcomes must be reachable, and the coin has to be even. A draw that always
// favoured the same slot would be worse than no draw at all, because it looks fair.
if (matchzy.resolveSide('random', () => 0.1) !== 'team1_ct') {
  fail('A low roll should put team1 on CT');
} else if (matchzy.resolveSide('random', () => 0.9) !== 'team1_t') {
  fail('A high roll should put team1 on T');
} else {
  ok('both sides are reachable from the draw');
}

let ct = 0;
const DRAWS = 20000;
for (let i = 0; i < DRAWS; i += 1) {
  if (matchzy.resolveSide('random') === 'team1_ct') ct += 1;
}
const share = ct / DRAWS;
if (share < 0.47 || share > 0.53) {
  fail(`The draw is biased: team1 got CT ${(share * 100).toFixed(1)}% of ${DRAWS} draws`);
} else {
  ok(`the draw is even (team1 on CT ${(share * 100).toFixed(1)}% of ${DRAWS} draws)`);
}

// A fixed request must never be quietly turned into a draw.
if (matchzy.resolveSide('team1_ct', () => 0.9) !== 'team1_ct') {
  fail('An explicit side was overridden by the draw');
} else {
  ok('an explicit choice is never re-drawn');
}

console.log('\n--- a roster that cannot be locked blocks the launch ---');

const indexSrc = fs.readFileSync(path.join(repoRoot, 'functions', 'cs2-nexus', 'index.js'), 'utf8');

if (!/rostersLocked/.test(mzSrc)) {
  fail('buildMatchConfig does not report whether the rosters can be locked');
} else {
  ok('buildMatchConfig reports whether the rosters can be locked');
}

if (!/!matchBuild\.rostersLocked && allowUnlockedRosters !== true/.test(indexSrc)) {
  fail('launchMatchCore does not refuse a roster it cannot lock');
} else {
  ok('launchMatchCore refuses a roster it cannot lock');
}

if (!/reason: 'rosters_unlocked'/.test(indexSrc)) {
  fail('The refusal carries no machine-readable reason for the panel');
} else {
  ok('the refusal is reported with a reason the panel can act on');
}

const warroomSrc = fs.readFileSync(path.join(repoRoot, 'commander-warroom.js'), 'utf8');
if (!/details\.reason === 'rosters_unlocked'/.test(warroomSrc)) {
  fail('The War Room does not handle the unlocked-roster refusal');
} else {
  ok('the War Room names who is missing Steam and lets the Commander decide');
}

if (failed) {
  console.error('\n[verify-cs2-matchzy]', failed, 'check(s) failed');
  process.exit(1);
}

console.log('\n[verify-cs2-matchzy] All checks passed.');
