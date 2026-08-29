const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const fileManager = require('./files');

const activeSandboxes = new Map();

async function isAvailable() {
  return Boolean(process.env.E2B_API_KEY);
}

async function createSandbox(botId) {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) throw new Error('E2B_API_KEY non configurée sur le serveur');

  let Sandbox;
  try {
    ({ Sandbox } = require('@e2b/code-interpreter'));
  } catch {
    throw new Error('Package E2B non installé — lance npm install @e2b/code-interpreter');
  }

  const ws = storage.getWorkspacePath(botId);
  const sandbox = await Sandbox.create({ apiKey, timeoutMs: 3600000 });

  const files = fileManager.listAllFiles(botId);
  for (const rel of files.slice(0, 50)) {
    const full = path.join(ws, rel);
    if (fs.statSync(full).isFile() && fs.statSync(full).size < 500000) {
      const content = fs.readFileSync(full);
      await sandbox.files.write('/home/user/' + rel.replace(/\\/g, '/'), content);
    }
  }

  activeSandboxes.set(botId, sandbox);
  return {
    id: sandbox.sandboxId,
    status: 'running',
    type: 'E2B Cloud VM',
    hostname: sandbox.sandboxId,
    message: 'MicroVM cloud démarrée (gratuit E2B — $100 crédits)',
  };
}

async function execInSandbox(botId, command) {
  const sandbox = activeSandboxes.get(botId);
  if (!sandbox) throw new Error('Cloud VM non démarrée');

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
}

function getCloudStatus(botId) {
  const sandbox = activeSandboxes.get(botId);
  if (!sandbox) return { active: false, available: Boolean(process.env.E2B_API_KEY) };
  return { active: true, id: sandbox.sandboxId, available: true };
}

module.exports = { isAvailable, createSandbox, execInSandbox, killSandbox, getCloudStatus };
