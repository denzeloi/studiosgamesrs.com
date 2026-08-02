'use strict';

const https = require('https');
const axios = require('axios');
const cloudInit = require('./cloud-init-pack');

const VULTR_API = 'https://api.vultr.com/v2';

// Cloud Functions often egress via IPv6; Vultr API keys with IP allowlists
// typically whitelist IPv4 only — prefer IPv4 for api.vultr.com calls.
const vultrHttpsAgent = new https.Agent({ family: 4, keepAlive: true });

function envValue(name, fallback) {
  return cloudInit.envValue(name, fallback);
}

function getToken() {
  return envValue('VULTR_API_TOKEN');
}

function getClient() {
  const token = getToken();
  if (!token) throw new Error('VULTR_API_TOKEN not configured');
  return axios.create({
    baseURL: VULTR_API,
    httpsAgent: vultrHttpsAgent,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    timeout: 60000,
  });
}

function formatVultrError(err) {
  if (err.response && err.response.data) {
    const d = err.response.data;
    const msg = d.error ? String(d.error) : JSON.stringify(d);
    if (/unauthorized ip address/i.test(msg)) {
      return msg + '. Fix in Vultr: Account → API → Access Control → Allow All IPv4 (Firebase Cloud Functions use dynamic Google Cloud IPs).';
    }
    return msg;
  }
  return err.message || 'Vultr API request failed';
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

function usesSnapshot() {
  return !!envValue('VULTR_SNAPSHOT_ID');
}

function getOsOrSnapshot() {
  if (usesSnapshot()) {
    return { snapshot_id: envValue('VULTR_SNAPSHOT_ID') };
  }
  // Ubuntu 24.04 x64 — confirm with GET /os if this ID changes
  return { os_id: Number(envValue('VULTR_OS_ID', '2284')) };
}

async function createServer({ name, labels = {}, location, gsltSlot, tournamentId, matchId }) {
  const client = getClient();
  const region = location || envValue('VULTR_LOCATION', 'mia');
  const planId = envValue('VULTR_PLAN', 'vc2-4c-8gb');
  const label = sanitizeServerName(name || 'cs2-nexus-' + Date.now());
  // Cada ranura arranca con su propio token de Steam: con el mismo, la segunda
  // máquina echa a la primera de la red de Valve.
  const userData = Buffer.from(
    cloudInit.loadCloudInitYaml({
      gsltSlot: gsltSlot,
      tournamentId: tournamentId,
      matchId: matchId,
    }), 'utf8'
  ).toString('base64');
  const body = Object.assign(
    {
      region: region,
      plan: planId,
      label: label,
      hostname: label,
      user_data: userData,
      backups: 'disabled',
      enable_ipv6: false,
      tags: ['cs2-nexus', labels.tournamentId || 'tournament'].filter(Boolean),
    },
    getOsOrSnapshot()
  );

  try {
    const { data } = await client.post('/instances', body);
    const inst = data.instance || data;
    return {
      id: String(inst.id),
      name: inst.label || label,
      public_net: { ipv4: { ip: inst.main_ip || null } },
      status: inst.status || 'pending',
      provisionMode: usesSnapshot() ? 'snapshot' : 'full',
      provider: 'vultr',
      region: region,
    };
  } catch (err) {
    throw new Error(formatVultrError(err));
  }
}

async function getServer(serverId) {
  const { data } = await getClient().get('/instances/' + serverId);
  const inst = data.instance || data;
  return {
    id: String(inst.id),
    name: inst.label,
    public_net: { ipv4: { ip: inst.main_ip || null } },
    status: inst.status === 'active' ? 'running' : inst.status,
    provider: 'vultr',
  };
}

async function deleteServer(serverId) {
  try {
    await getClient().delete('/instances/' + serverId);
  } catch (err) {
    throw new Error(formatVultrError(err));
  }
}

async function waitForServerIp(serverId, maxAttempts = 40, intervalMs = 5000) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const server = await getServer(serverId);
    const ip = server.public_net && server.public_net.ipv4 && server.public_net.ipv4.ip;
    if (ip && ip !== '0.0.0.0' && server.status === 'running') {
      return { server, ip };
    }
    await new Promise(function (r) { setTimeout(r, intervalMs); });
  }
  throw new Error('Vultr server ' + serverId + ' not ready');
}

async function listProjectServers() {
  const { data } = await getClient().get('/instances', { params: { tag: 'cs2-nexus' } });
  return (data.instances || []).map(function (inst) {
    return {
      id: String(inst.id),
      name: inst.label,
      public_net: { ipv4: { ip: inst.main_ip } },
      status: inst.status,
      // La fecha viene del proveedor porque una máquina huérfana, por
      // definición, no tiene registro nuestro del que sacar la edad.
      createdAt: inst.date_created || null,
      provider: 'vultr',
    };
  });
}

module.exports = {
  createServer,
  getServer,
  deleteServer,
  waitForServerIp,
  listProjectServers,
  sanitizeServerName,
  usesSnapshot,
};
