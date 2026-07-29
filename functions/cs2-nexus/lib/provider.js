'use strict';

/**
 * Cloud provider facade — Vultr Miami (default) or Hetzner (legacy).
 * Set CS2_CLOUD_PROVIDER=hetzner to use Hetzner Ashburn instead.
 */

const hetzner = require('./hetzner');
const vultr = require('./vultr');
const cloudInit = require('./cloud-init-pack');

function activeProviderName() {
  const raw = cloudInit.envValue('CS2_CLOUD_PROVIDER', 'vultr').toLowerCase();
  if (raw === 'hetzner') return 'hetzner';
  return 'vultr';
}

function getDriver(name) {
  return (name || activeProviderName()) === 'vultr' ? vultr : hetzner;
}

function sanitizeServerName(name) {
  return vultr.sanitizeServerName(name);
}

function assertConfigured() {
  const name = activeProviderName();
  if (name === 'vultr') {
    if (!cloudInit.envValue('VULTR_API_TOKEN')) {
      throw new Error('VULTR_API_TOKEN not configured in functions/.env');
    }
    return;
  }
  if (!cloudInit.envValue('HETZNER_API_TOKEN')) {
    throw new Error('HETZNER_API_TOKEN not configured in functions/.env');
  }
}

function usesSnapshot() {
  return getDriver().usesSnapshot();
}

async function createServer(opts) {
  const provider = activeProviderName();
  const driver = getDriver(provider);
  const server = await driver.createServer(opts || {});
  return Object.assign({}, server, { provider: provider });
}

async function getServer(serverId, providerHint) {
  return getDriver(providerHint || activeProviderName()).getServer(serverId);
}

async function deleteServer(serverId, providerHint) {
  return getDriver(providerHint || activeProviderName()).deleteServer(serverId);
}

async function waitForServerIp(serverId, providerHint) {
  return getDriver(providerHint || activeProviderName()).waitForServerIp(serverId);
}

async function listProjectServers() {
  const provider = activeProviderName();
  try {
    return await getDriver(provider).listProjectServers();
  } catch (err) {
    return [];
  }
}

module.exports = {
  activeProviderName,
  assertConfigured,
  createServer,
  getServer,
  deleteServer,
  waitForServerIp,
  listProjectServers,
  sanitizeServerName,
  usesSnapshot,
  hetzner,
  vultr,
};
