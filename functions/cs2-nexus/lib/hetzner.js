'use strict';

const axios = require('axios');
const cloudInit = require('./cloud-init-pack');

const HETZNER_API = 'https://api.hetzner.cloud/v1';
const ALLOWED_LOCATIONS = new Set(['ash', 'hil', 'fsn1', 'nbg1', 'hel1', 'sin']);

function envValue(name, fallback) {
  return cloudInit.envValue(name, fallback);
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

function resolveLocation(requested) {
  const loc = String(requested || envValue('HETZNER_LOCATION', 'ash')).toLowerCase();
  if (ALLOWED_LOCATIONS.has(loc)) return loc;
  return envValue('HETZNER_LOCATION', 'ash');
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

async function createServer({ name, labels = {}, location, gsltSlot, tournamentId, matchId } = {}) {
  const client = getClient();
  const snapshot = usesSnapshot();
  const loc = resolveLocation(location);
  try {
    const { data } = await client.post('/servers', {
      name: sanitizeServerName(name || `cs2-nexus-${Date.now()}`),
      server_type: envValue('HETZNER_SERVER_TYPE', 'cpx31'),
      location: loc,
      image: getProvisionImage(),
      labels: sanitizeLabels(labels),
      user_data: cloudInit.loadCloudInitYaml({
        gsltSlot: gsltSlot,
        tournamentId: tournamentId,
        matchId: matchId,
      }),
      start_after_create: true,
    });
    return {
      ...data.server,
      provisionMode: snapshot ? 'snapshot' : 'full',
      provider: 'hetzner',
      region: loc,
    };
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
  resolveLocation,
  ALLOWED_LOCATIONS,
};
