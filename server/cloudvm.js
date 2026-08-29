const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const fileManager = require('./files');

/** @type {Map<string, { sandbox: object, streamUrl: string|null, cloudBotRunning: boolean, logOffset: number, logPollTimer: NodeJS.Timeout|null }>} */
const activeSandboxes = new Map();
/** @type {Map<string, NodeJS.Timeout>} */
const syncTimers = new Map();
/** @type {Map<string, NodeJS.Timeout>} */
const extendTimers = new Map();

const MAX_FILE_SIZE = 5_000_000;
const MAX_FILES = 100;
const VM_REMOTE_ROOT = '/home/user';

function getApiKey(bot) {
  return bot?.cloudApiKey || process.env.PULSE_CLOUD_KEY || process.env.E2B_API_KEY || null;
}

function hasApiKey(bot) {
  return Boolean(getApiKey(bot));
}

async function syncPushToSandbox(botId, sandbox) {
  const ws = storage.getWorkspacePath(botId);
  const files = fileManager.listAllFiles(botId);
  let pushed = 0;

  for (const rel of files.slice(0, MAX_FILES)) {
    const full = path.join(ws, rel);
    try {
      if (!fs.statSync(full).isFile()) continue;
      const size = fs.statSync(full).size;
      if (size > MAX_FILE_SIZE) continue;
      const remote = `${VM_REMOTE_ROOT}/${rel.replace(/\\/g, '/')}`;
      await sandbox.files.write(remote, fs.readFileSync(full));
      pushed += 1;
    } catch { /* skip */ }
  }

  return pushed;
}

async function syncPullFromSandbox(botId) {
  const entry = activeSandboxes.get(botId);
  if (!entry) throw new Error('Machine virtuelle non démarrée');

  const { sandbox } = entry;
  const result = await sandbox.commands.run(
    `find ${VM_REMOTE_ROOT} -type f \\( -path "*/node_modules/*" -o -path "*/.cache/*" -o -path "*/.local/share/*" \\) -prune -o -type f -print 2>/dev/null | head -${MAX_FILES}`,
  );

  const paths = (result.stdout || '')
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${VM_REMOTE_ROOT}/`));

  const ws = storage.getWorkspacePath(botId);
  let saved = 0;

  for (const absPath of paths) {
    const rel = absPath.slice(VM_REMOTE_ROOT.length + 1);
    if (!rel || rel.includes('..')) continue;

    try {
      const data = await sandbox.files.read(absPath);
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length > MAX_FILE_SIZE) continue;

      const dest = path.join(ws, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      saved += 1;
    } catch { /* skip */ }
  }

  storage.updateBot(botId, { vmLastSync: new Date().toISOString() });
  return { saved, syncedAt: new Date().toISOString() };
}

function clearTimers(botId) {
  if (syncTimers.has(botId)) {
    clearInterval(syncTimers.get(botId));
    syncTimers.delete(botId);
  }
  if (extendTimers.has(botId)) {
    clearInterval(extendTimers.get(botId));
    extendTimers.delete(botId);
  }
}

function startBackgroundTasks(botId, sandbox) {
  clearTimers(botId);

  syncTimers.set(
    botId,
    setInterval(async () => {
      try {
        if (activeSandboxes.has(botId)) await syncPullFromSandbox(botId);
      } catch { /* ignore */ }
    }, 5 * 60 * 1000),
  );

  extendTimers.set(
    botId,
    setInterval(async () => {
      try {
        if (activeSandboxes.has(botId) && typeof sandbox.setTimeout === 'function') {
          await sandbox.setTimeout(3600000);
        }
      } catch { /* ignore */ }
    }, 45 * 60 * 1000),
  );
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function ensureSandbox(botId, { withDesktop = false } = {}) {
  const existing = activeSandboxes.get(botId);
  if (existing) return existing;

  const bot = storage.getBot(botId);
  const apiKey = getApiKey(bot);
  if (!apiKey) {
    throw new Error('Ajoute ta clé API cloud dans VPS → Machine Virtuelle');
  }

  let Sandbox;
  try {
    ({ Sandbox } = require('@e2b/desktop'));
  } catch {
    throw new Error('Module cloud indisponible');
  }

  const desktop = await Sandbox.create({ apiKey, timeoutMs: 3600000 });
  let streamUrl = null;

  if (withDesktop) {
    await desktop.stream.start({ requireAuth: true });
    const authKey = await desktop.stream.getAuthKey();
    streamUrl = desktop.stream.getUrl({ authKey });
    if (!streamUrl.includes('autoconnect')) {
      streamUrl += (streamUrl.includes('?') ? '&' : '?') + 'autoconnect=true&resize=scale&quality=6';
    }
  }

  await syncPushToSandbox(botId, desktop);

  const entry = {
    sandbox: desktop,
    streamUrl,
    cloudBotRunning: false,
    logOffset: 0,
    logPollTimer: null,
  };
  activeSandboxes.set(botId, entry);
  startBackgroundTasks(botId, desktop);
  storage.updateBot(botId, {
    cloudVmId: desktop.sandboxId,
    cloudVmStatus: 'running',
    vmLastSync: new Date().toISOString(),
  });

  return entry;
}

function cloudLog(botId, level, message) {
  require('./botManager').addLog(botId, level, message);
}

function stopLogPolling(entry) {
  if (entry?.logPollTimer) {
    clearInterval(entry.logPollTimer);
    entry.logPollTimer = null;
  }
}

async function pullCloudBotLogs(botId) {
  const entry = activeSandboxes.get(botId);
  if (!entry?.cloudBotRunning) return;

  try {
    const raw = await entry.sandbox.files.read(`${VM_REMOTE_ROOT}/pulsehost.log`);
    const text = (Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || ''));
    const lines = text.split('\n');
    const newLines = lines.slice(entry.logOffset).filter(Boolean);
    entry.logOffset = lines.length;

    for (const line of newLines) {
      const level = /error|❌|crash|fail/i.test(line) ? 'error' : 'info';
      cloudLog(botId, level, line);
    }
  } catch { /* log pas encore créé */ }
}

function startLogPolling(botId) {
  const entry = activeSandboxes.get(botId);
  if (!entry) return;
  stopLogPolling(entry);
  entry.logPollTimer = setInterval(() => {
    pullCloudBotLogs(botId).catch(() => {});
  }, 3000);
}

function isCloudBotRunning(botId) {
  return Boolean(activeSandboxes.get(botId)?.cloudBotRunning);
}

async function startCloudBot(bot) {
  const botManager = require('./botManager');
  if (!botManager.isValidToken(bot.token)) {
    return { ok: false, message: 'Token Discord invalide — configure-le dans Paramètres' };
  }
  if (!hasApiKey(bot)) {
    return { ok: false, message: 'Clé API cloud requise — onglet VPS → Machine Virtuelle' };
  }

  if (isCloudBotRunning(bot.id)) {
    return { ok: true, message: 'Bot déjà en ligne sur VPS cloud' };
  }

  cloudLog(bot.id, 'info', 'Démarrage sur VPS cloud...');
  storage.updateBot(bot.id, { status: 'starting', error: null, hostMode: 'cloud' });

  try {
    const entry = await ensureSandbox(bot.id, { withDesktop: false });
    await syncPushToSandbox(bot.id, entry.sandbox);

    const startFile = bot.startFile || 'index.js';
    const runner = bot.runtime === 'python' ? 'python3' : 'node';
    const envLines = [
      `DISCORD_TOKEN=${bot.token}`,
      `BOT_TOKEN=${bot.token}`,
      `TOKEN=${bot.token}`,
      'NODE_ENV=production',
      ...Object.entries(bot.env || {}).map(([k, v]) => `${k}=${v}`),
    ].join('\n');

    await entry.sandbox.files.write(`${VM_REMOTE_ROOT}/.pulsehost.env`, envLines);

    await entry.sandbox.commands.run(
      `cd ${VM_REMOTE_ROOT} && npm install --production 2>/dev/null || true`,
      { timeoutMs: 180000 },
    );

    await entry.sandbox.commands.run(
      `cd ${VM_REMOTE_ROOT} && pkill -f ${shellQuote(startFile)} 2>/dev/null || true`,
    );

    await entry.sandbox.commands.run(
      `cd ${VM_REMOTE_ROOT} && set -a && . ./.pulsehost.env && set +a && nohup ${runner} ${shellQuote(startFile)} >> pulsehost.log 2>&1 & echo $! > pulsehost.pid && sleep 1 && cat pulsehost.pid`,
      { timeoutMs: 30000 },
    );

    entry.cloudBotRunning = true;
    entry.logOffset = 0;
    startLogPolling(bot.id);

    storage.updateBot(bot.id, {
      status: 'online',
      hostMode: 'cloud',
      lastOnline: new Date().toISOString(),
      error: null,
      pid: null,
    });

    cloudLog(bot.id, 'success', 'Bot démarré sur VPS cloud (plus sur ton PC)');
    await pullCloudBotLogs(bot.id);

    return { ok: true, message: 'Bot démarré sur VPS cloud' };
  } catch (err) {
    cloudLog(bot.id, 'error', err.message);
    storage.updateBot(bot.id, { status: 'error', error: err.message });
    return { ok: false, message: err.message };
  }
}

async function stopCloudBot(botId) {
  const entry = activeSandboxes.get(botId);
  if (!entry?.cloudBotRunning) {
    storage.updateBot(botId, { status: 'offline', pid: null, error: null });
    return { ok: true, message: 'Bot déjà arrêté' };
  }

  cloudLog(botId, 'info', 'Arrêt du bot sur VPS cloud...');

  try {
    const startFile = storage.getBot(botId)?.startFile || 'index.js';
    await entry.sandbox.commands.run(
      `cd ${VM_REMOTE_ROOT} && (kill $(cat pulsehost.pid 2>/dev/null) 2>/dev/null; pkill -f ${shellQuote(startFile)} 2>/dev/null; true)`,
    );
    await pullCloudBotLogs(botId);
  } catch { /* ignore */ }

  entry.cloudBotRunning = false;
  stopLogPolling(entry);
  storage.updateBot(botId, { status: 'offline', pid: null, error: null });
  cloudLog(botId, 'info', 'Bot VPS cloud arrêté');

  return { ok: true, message: 'Bot arrêté' };
}

async function createSandbox(botId) {
  let entry = activeSandboxes.get(botId);

  if (!entry) {
    entry = await ensureSandbox(botId, { withDesktop: true });
  } else if (!entry.streamUrl) {
    await entry.sandbox.stream.start({ requireAuth: true });
    const authKey = await entry.sandbox.stream.getAuthKey();
    let streamUrl = entry.sandbox.stream.getUrl({ authKey });
    if (!streamUrl.includes('autoconnect')) {
      streamUrl += (streamUrl.includes('?') ? '&' : '?') + 'autoconnect=true&resize=scale&quality=6';
    }
    entry.streamUrl = streamUrl;
  }

  return {
    id: entry.sandbox.sandboxId,
    status: 'running',
    type: 'PulseCloud Desktop',
    hostname: `vm-${botId.slice(0, 8)}.pulsecloud`,
    os: 'Ubuntu 22.04 + XFCE',
    ram: '512 Mo',
    cpu: '2 vCPU',
    streamUrl: entry.streamUrl,
    message: entry.streamUrl ? 'Bureau virtuel démarré' : 'VM active',
  };
}

async function execInSandbox(botId, command) {
  const entry = activeSandboxes.get(botId);
  if (!entry) throw new Error('Machine virtuelle non démarrée');

  const result = await entry.sandbox.commands.run(command);
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.exitCode ?? 0,
  };
}

async function killSandbox(botId) {
  const entry = activeSandboxes.get(botId);
  if (entry) {
    if (entry.cloudBotRunning) {
      await stopCloudBot(botId);
    }
    try {
      await syncPullFromSandbox(botId);
    } catch { /* ignore */ }

    clearTimers(botId);
    stopLogPolling(entry);
    try { await entry.sandbox.stream.stop(); } catch { /* ignore */ }
    await entry.sandbox.kill();
    activeSandboxes.delete(botId);
  } else {
    clearTimers(botId);
  }

  storage.updateBot(botId, { cloudVmId: null, cloudVmStatus: 'offline' });
}

function getCloudStatus(botId) {
  const bot = storage.getBot(botId);
  const entry = activeSandboxes.get(botId);
  return {
    active: Boolean(entry),
    id: entry?.sandbox?.sandboxId || bot?.cloudVmId || null,
    hasKey: hasApiKey(bot),
    hostname: entry ? `vm-${botId.slice(0, 8)}.pulsecloud` : null,
    streamUrl: entry?.streamUrl || null,
    lastSync: bot?.vmLastSync || null,
    botRunning: isCloudBotRunning(botId),
  };
}

module.exports = {
  createSandbox,
  execInSandbox,
  killSandbox,
  getCloudStatus,
  hasApiKey,
  getApiKey,
  syncPullFromSandbox,
  syncPushToSandbox,
  startCloudBot,
  stopCloudBot,
  isCloudBotRunning,
  pullCloudBotLogs,
  ensureSandbox,
};
