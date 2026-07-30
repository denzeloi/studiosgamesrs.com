#!/usr/bin/env node
'use strict';

/**
 * Blocks deploy if tracked or staged files contain obvious secrets.
 * Run before firebase deploy (see package.json).
 *
 * Untracked files are checked too, unless .gitignore excludes them. An
 * untracked-but-not-ignored file holding credentials is one `git add .` away
 * from a public commit, so it fails the scan and must be gitignored instead.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.firebase',
  'vendor',
]);

const SKIP_FILES = new Set([
  'scripts/verify-no-secrets.js',
  'functions/.env.example',
  'functions/cs2-nexus/.env.example',
]);

const PATTERNS = [
  { name: 'Hetzner API token', re: /HETZNER_API_TOKEN\s*=\s*[A-Za-z0-9]{20,}/ },
  { name: 'Vultr API token', re: /VULTR_API_TOKEN\s*=\s*[A-Za-z0-9]{20,}/ },
  { name: 'RCON password assignment', re: /RCON_PASSWORD\s*=\s*(?!changeme|YOUR_|__)[^\s#]{8,}/ },
  { name: 'GSLT token assignment', re: /GSLT_SERVER_\d+\s*=\s*[A-F0-9]{20,}/i },
  { name: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'Service account JSON key', re: /"private_key"\s*:\s*"-----BEGIN/ },
  { name: 'Hardcoded Steam API key', re: /STEAM_API_KEY'\s*,\s*'[A-Fa-f0-9]{32}'/ },
  { name: 'Inline SMTP password', re: /->Password\s*=\s*['"][^'"]{6,}['"]/ },
];

function listRepoFiles(dir, out) {
  if (!fs.existsSync(dir)) return;
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) return;
      listRepoFiles(full, out);
      return;
    }
    out.push(path.relative(root, full).split(path.sep).join('/'));
  });
}

function gitTracked(rel) {
  try {
    execSync('git ls-files --error-unmatch ' + JSON.stringify(rel), {
      cwd: root,
      stdio: 'pipe',
    });
    return true;
  } catch (_) {
    return false;
  }
}

function gitIgnored(rel) {
  try {
    execSync('git check-ignore -q ' + JSON.stringify(rel), {
      cwd: root,
      stdio: 'pipe',
    });
    return true;
  } catch (_) {
    return false;
  }
}

const files = [];
listRepoFiles(root, files);

let failed = 0;

files.forEach(function (rel) {
  if (SKIP_FILES.has(rel)) return;
  if (rel.endsWith('.glb') || rel.endsWith('.png') || rel.endsWith('.jpg')) return;

  const tracked = gitTracked(rel);
  if (!tracked && gitIgnored(rel)) return;

  const content = fs.readFileSync(path.join(root, rel), 'utf8');
  PATTERNS.forEach(function (pattern) {
    if (!pattern.re.test(content)) return;
    if (tracked) {
      console.error('FAIL secret scan:', rel, '—', pattern.name);
    } else {
      console.error(
        'FAIL secret scan:', rel, '—', pattern.name,
        '(untracked and not ignored: add it to .gitignore)'
      );
    }
    failed += 1;
  });
});

if (failed) {
  console.error('[verify-no-secrets]', failed, 'issue(s). Remove secrets before commit/deploy.');
  process.exit(1);
}

console.log('[verify-no-secrets] No obvious secrets in tracked files.');
