'use strict';

const fs = require('fs');
const path = require('path');

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

function loadCloudInitScript(mode) {
  const file = mode === 'snapshot' ? 'cloud-init-snapshot.sh' : 'cloud-init.sh';
  const scriptPath = path.join(__dirname, '..', file);
  let script = fs.readFileSync(scriptPath, 'utf8');
  const rcon = envValue('RCON_PASSWORD', 'changeme');
  const gslt = envValue('GSLT_SERVER_1');
  const secret = envValue('WEBHOOK_SECRET');
  const webhookUrl = envValue('CS2_WEBHOOK_URL');
  script = script
    .replace(/__RCON_PASSWORD__/g, rcon)
    .replace(/__GSLT_TOKEN__/g, gslt)
    .replace(/__WEBHOOK_SECRET__/g, secret)
    .replace(/__BRIDGE_WEBHOOK_URL__/g, webhookUrl);
  return script;
}

function indentCloudInit(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map((l) => `${pad}${l}`).join('\n');
}

function readRepoFile(relPath) {
  const p = path.join(__dirname, '..', '..', '..', relPath);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function loadMatchZyCfgFiles(files) {
  const names = ['config.cfg', 'warmup.cfg', 'knife.cfg', 'live.cfg'];
  names.forEach(function (name) {
    const content = readRepoFile('cs2-server/cfg/MatchZy/' + name);
    if (content) {
      files.push({ path: '/root/matchzy-cfg/' + name, content: content });
    }
  });
}

function loadCloudInitYaml() {
  const useMode = usesSnapshot() ? 'snapshot' : 'full';
  const script = loadCloudInitScript(useMode);
  const runPath = useMode === 'snapshot' ? '/root/configure-cs2.sh' : '/root/install-cs2.sh';
  const files = [{ path: runPath, content: script }];

  files.push({
    path: '/root/install-plugins.sh',
    content: fs.readFileSync(path.join(__dirname, '..', 'install-plugins.sh'), 'utf8'),
  });
  const nexusCs = readRepoFile('cs2-server/plugins/NexusBridge/NexusBridgePlugin.cs');
  const nexusProj = readRepoFile('cs2-server/plugins/NexusBridge/NexusBridge.csproj');
  if (nexusCs) files.push({ path: '/root/NexusBridgePlugin.cs', content: nexusCs });
  if (nexusProj) files.push({ path: '/root/NexusBridge.csproj', content: nexusProj });
  loadMatchZyCfgFiles(files);

  if (useMode === 'snapshot') {
    files.push({
      path: '/root/install-cs2-full.sh',
      content: loadCloudInitScript('full'),
    });
  }

  let yaml = '#cloud-config\nwrite_files:\n';
  files.forEach((f) => {
    yaml += `  - path: ${f.path}\n    permissions: '0755'\n    content: |\n${indentCloudInit(f.content, 6)}\n`;
  });
  yaml += `runcmd:\n  - [ bash, ${runPath} ]\n`;
  return yaml;
}

module.exports = {
  envValue,
  usesSnapshot,
  loadCloudInitYaml,
  loadCloudInitScript,
  readRepoFile,
};
