'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const HETZNER_API = 'https://api.hetzner.cloud/v1';

function envValue(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback || '';
  return String(raw).trim().replace(/\r$/, '');
}

function getToken() {
  return envValue('HETZNER_API_TOKEN');
}

function sanitizeLabelValue(value) {
  var s = String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  s = s.replace(/^[^a-z0-9]+/, '');
  if (!s) s = 'unknown';
  return s.slice(0, 63);
}

function sanitizeLabels(labels) {
  var out = { project: 'cs2-nexus' };
  Object.keys(labels || {}).forEach(function (key) {
    out[sanitizeLabelValue(key)] = sanitizeLabelValue(labels[key]);
  });
  return out;
}

function sanitizeServerName(name) {
  var s = String(name || 'cs2-nexus')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  if (!s) s = 'cs2-nexus';
  return s.slice(0, 63);
}

function getClient() {
  const token = getToken();
  if (!token) throw new Error('HETZNER_API_TOKEN not configured');
  return axios.create({
    baseURL: HETZNER_API,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 60000,
  });
}

function formatHetznerError(err) {
  if (err.response && err.response.data && err.response.data.error) {
    var e = err.response.data.error;
    return e.message || e.code || JSON.stringify(e);
  }
  return err.message || 'Hetzner API request failed';
}

function usesSnapshot() {
  return !!envValue('HETZNER_SNAPSHOT_ID');
}

function getProvisionImage() {
  if (usesSnapshot()) return envValue('HETZNER_SNAPSHOT_ID');
  return envValue('HETZNER_IMAGE', 'ubuntu-24.04');
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

function loadCloudInit() {
  const mode = usesSnapshot() ? 'snapshot' : 'full';
  const script = loadCloudInitScript(mode);
  const runPath = mode === 'snapshot' ? '/root/configure-cs2.sh' : '/root/install-cs2.sh';
  const files = [{ path: runPath, content: script }];

  files.push({
    path: '/root/install-plugins.sh',
    content: fs.readFileSync(path.join(__dirname, '..', 'install-plugins.sh'), 'utf8'),
  });
  const nexusCs = readRepoFile('cs2-server/plugins/NexusBridge/NexusBridgePlugin.cs');
  const nexusProj = readRepoFile('cs2-server/plugins/NexusBridge/NexusBridge.csproj');
  if (nexusCs) files.push({ path: '/root/NexusBridgePlugin.cs', content: nexusCs });
  if (nexusProj) files.push({ path: '/root/NexusBridge.csproj', content: nexusProj });

  if (mode === 'snapshot') {
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

async function createServer({ name, labels = {} }) {
  const client = getClient();
  const snapshot = usesSnapshot();
  try {
    const { data } = await client.post('/servers', {
      name: sanitizeServerName(name || `cs2-nexus-${Date.now()}`),
      server_type: envValue('HETZNER_SERVER_TYPE', 'cpx31'),
      location: envValue('HETZNER_LOCATION', 'ash'),
      image: getProvisionImage(),
      labels: sanitizeLabels(labels),
      user_data: loadCloudInit(),
      start_after_create: true,
    });
    return { ...data.server, provisionMode: snapshot ? 'snapshot' : 'full' };
  } catch (err) {
    throw new Error(formatHetznerError(err));
  }
}

async function getServer(serverId) {
  const { data } = await getClient().get(`/servers/${serverId}`);
  return data.server;
}

async function deleteServer(serverId) {
  try {
    await getClient().delete(`/servers/${serverId}`);
  } catch (err) {
    throw new Error(formatHetznerError(err));
  }
}

async function waitForServerIp(serverId, maxAttempts = 40, intervalMs = 5000) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const server = await getServer(serverId);
    const ip = server.public_net?.ipv4?.ip;
    if (ip && server.status === 'running') return { server, ip };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Server ${serverId} not ready`);
}

async function listProjectServers() {
  const { data } = await getClient().get('/servers', {
    params: { label_selector: 'project=cs2-nexus' },
  });
  return data.servers || [];
}

async function listSnapshots() {
  const { data } = await getClient().get('/images', {
    params: { type: 'snapshot', sort: 'created:desc' },
  });
  return (data.images || []).filter(function (img) {
    return img.labels && img.labels.project === 'cs2-nexus';
  });
}

module.exports = {
  createServer,
  getServer,
  deleteServer,
  waitForServerIp,
  listProjectServers,
  listSnapshots,
  sanitizeServerName,
  sanitizeLabels,
  usesSnapshot,
  getProvisionImage,
};
