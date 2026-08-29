const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const fileManager = require('./files');

const activeSandboxes = new Map();

function getApiKey(bot) {
  return bot?.cloudApiKey || process.env.PULSE_CLOUD_KEY || process.env.E2B_API_KEY || null;
}

function hasApiKey(bot) {
  return Boolean(getApiKey(bot));
}

async function createSandbox(botId) {
  const bot = storage.getBot(botId);
  const apiKey = getApiKey(bot);
  if (!apiKey) {
    throw new Error('Ajoute ta clé API cloud gratuite dans l\'onglet Machine Virtuelle');
  }

  let Sandbox;
  try {
    ({ Sandbox } = require('@e2b/code-interpreter'));
  } catch {
    throw new Error('Module cloud indisponible — réessaie plus tard');
  }

  const ws = storage.getWorkspacePath(botId);
  const sandbox = await Sandbox.create({ apiKey, timeoutMs: 3600000 });

  const files = fileManager.listAllFiles(botId);
  for (const rel of files.slice(0, 50)) {
    const full = path.join(ws, rel);
    try {
      if (fs.statSync(full).isFile() && fs.statSync(full).size < 500000) {
        await sandbox.files.write('/home/user/' + rel.replace(/\\/g, '/'), fs.readFileSync(full));
      }
    } catch { /* skip */ }
  }

  activeSandboxes.set(botId, sandbox);
  storage.updateBot(botId, { cloudVmId: sandbox.sandboxId, cloudVmStatus: 'running' });

  return {
    id: sandbox.sandboxId,
    status: 'running',
    type: 'PulseCloud',
    hostname: `vm-${botId.slice(0, 8)}.pulsecloud`,
    os: 'Linux Ubuntu',
    ram: '512 Mo',
    cpu: '2 vCPU',
    message: 'Machine virtuelle cloud démarrée',
  };
}

async function execInSandbox(botId, command) {
  const sandbox = activeSandboxes.get(botId);
  if (!sandbox) throw new Error('Machine virtuelle non démarrée — clique sur Démarrer');

  const result = await sandbox.commands.run(command);
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.exitCode ?? 0,
  };
}

async function killSandbox(botId) {
  const sandbox = activeSandboxes.get(botId);
  if (sandbox) {
    await sandbox.kill();
    activeSandboxes.delete(botId);
  }
  storage.updateBot(botId, { cloudVmId: null, cloudVmStatus: 'offline' });
}

function getCloudStatus(botId) {
  const bot = storage.getBot(botId);
  const sandbox = activeSandboxes.get(botId);
  return {
    active: Boolean(sandbox),
    id: sandbox?.sandboxId || bot?.cloudVmId || null,
    hasKey: hasApiKey(bot),
    hostname: sandbox ? `vm-${botId.slice(0, 8)}.pulsecloud` : null,
  };
}

module.exports = { createSandbox, execInSandbox, killSandbox, getCloudStatus, hasApiKey, getApiKey };
