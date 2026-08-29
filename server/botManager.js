const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const fileManager = require('./files');

const activeProcesses = new Map();
const botLogs = new Map();
const MAX_LOGS = 500;

function addLog(botId, level, message) {
  if (!botLogs.has(botId)) botLogs.set(botId, []);
  const logs = botLogs.get(botId);
  logs.push({ time: new Date().toISOString(), level, message: String(message).trim() });
  if (logs.length > MAX_LOGS) logs.shift();
}

function getLogs(botId) {
  return botLogs.get(botId) || [];
}

function clearLogs(botId) {
  botLogs.set(botId, []);
}

function isValidToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.trim().split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0) && token.length >= 50;
}

function buildEnv(bot) {
  const env = { ...process.env, ...bot.env };
  env.DISCORD_TOKEN = bot.token;
  env.BOT_TOKEN = bot.token;
  env.TOKEN = bot.token;
  env.NODE_ENV = 'production';
  return env;
}

function getRuntimeCommand(bot) {
  const ws = storage.getWorkspacePath(bot.id);
  const startFile = bot.startFile || 'index.js';
  const startPath = path.join(ws, startFile);

  if (!fs.existsSync(startPath)) {
    throw new Error(`Fichier de démarrage introuvable: ${startFile}`);
  }

  if (bot.runtime === 'python') {
    return { cmd: process.platform === 'win32' ? 'python' : 'python3', args: [startFile], cwd: ws };
  }

  return { cmd: 'node', args: [startFile], cwd: ws };
}

async function installDependencies(bot) {
  const ws = storage.getWorkspacePath(bot.id);
  const pkgPath = path.join(ws, 'package.json');

  if (bot.runtime === 'python') {
    const reqPath = path.join(ws, 'requirements.txt');
    if (fs.existsSync(reqPath)) {
      addLog(bot.id, 'info', 'Installation des dépendances Python...');
      try {
        execSync(`${process.platform === 'win32' ? 'pip' : 'pip3'} install -r requirements.txt`, {
          cwd: ws, stdio: 'pipe', timeout: 120000,
        });
        addLog(bot.id, 'success', 'Dépendances Python installées');
      } catch (err) {
        addLog(bot.id, 'warn', 'pip install échoué — lance manuellement si besoin');
      }
    }
    return;
  }

  if (fs.existsSync(pkgPath) && !fs.existsSync(path.join(ws, 'node_modules'))) {
    addLog(bot.id, 'info', 'Installation npm install...');
    try {
      execSync('npm install --production', { cwd: ws, stdio: 'pipe', timeout: 120000 });
      addLog(bot.id, 'success', 'Dépendances npm installées');
    } catch (err) {
      addLog(bot.id, 'warn', `npm install: ${err.message.slice(0, 120)}`);
    }
  }
}

async function startBot(bot) {
  const mode = bot.hostMode || 'cloud';

  if (mode !== 'local') {
    if (!bot.cloudApiKey && !process.env.PULSE_CLOUD_KEY && !process.env.E2B_API_KEY) {
      return { ok: false, message: 'Clé API cloud requise — VPS → Machine Virtuelle → Sauvegarder clé' };
    }
    return require('./cloudvm').startCloudBot(bot);
  }

  if (activeProcesses.has(bot.id)) {
    return { ok: true, message: 'Déjà en ligne' };
  }

  if (!isValidToken(bot.token)) {
    return { ok: false, message: 'Token Discord invalide — configure-le dans Paramètres' };
  }

  addLog(bot.id, 'info', `Démarrage: ${bot.runtime || 'nodejs'} ${bot.startFile || 'index.js'}`);
  storage.updateBot(bot.id, { status: 'starting', error: null });

  try {
    await installDependencies(bot);
    const { cmd, args, cwd } = getRuntimeCommand(bot);
    const env = buildEnv(bot);

    const proc = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    proc.stdout.on('data', (data) => {
      data.toString().split('\n').filter(Boolean).forEach((line) => addLog(bot.id, 'info', line));
    });

    proc.stderr.on('data', (data) => {
      data.toString().split('\n').filter(Boolean).forEach((line) => addLog(bot.id, 'error', line));
    });

    proc.on('close', (code) => {
      activeProcesses.delete(bot.id);
      if (code === 0) {
        addLog(bot.id, 'info', 'Processus arrêté proprement');
        storage.updateBot(bot.id, { status: 'offline', pid: null });
      } else {
        addLog(bot.id, 'error', `Processus crashé (code ${code})`);
        storage.updateBot(bot.id, { status: 'error', error: `Exit code ${code}`, pid: null });
      }
    });

    proc.on('error', (err) => {
      addLog(bot.id, 'error', err.message);
      activeProcesses.delete(bot.id);
      storage.updateBot(bot.id, { status: 'error', error: err.message, pid: null });
    });

    activeProcesses.set(bot.id, proc);
    storage.updateBot(bot.id, {
      status: 'online',
      pid: proc.pid,
      lastOnline: new Date().toISOString(),
      error: null,
    });
    addLog(bot.id, 'success', `Processus local lancé (PID ${proc.pid}) — ⚠️ tourne sur TON PC`);

    return { ok: true, message: 'Bot démarré' };
  } catch (err) {
    addLog(bot.id, 'error', err.message);
    storage.updateBot(bot.id, { status: 'error', error: err.message });
    return { ok: false, message: err.message };
  }
}

async function stopBot(id) {
  const bot = storage.getBot(id);
  const cloudvm = require('./cloudvm');

  if (cloudvm.isCloudBotRunning(id) || (bot?.hostMode || 'cloud') !== 'local') {
    await cloudvm.stopCloudBot(id);
  }

  const proc = activeProcesses.get(id);
  if (!proc) {
    storage.updateBot(id, { status: 'offline', pid: null, error: null });
    return { ok: true, message: 'Bot déjà arrêté' };
  }

  addLog(id, 'info', 'Arrêt du bot...');
  const pid = proc.pid;

  await new Promise((resolve) => {
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      proc.removeAllListeners();
      activeProcesses.delete(id);
      storage.updateBot(id, { status: 'offline', pid: null, error: null });
      addLog(id, 'info', 'Bot arrêté');
      resolve();
    };

    proc.once('close', cleanup);

    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', timeout: 10000 });
      } catch { /* déjà mort */ }
      setTimeout(cleanup, 800);
    } else {
      proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          if (activeProcesses.has(id)) proc.kill('SIGKILL');
        } catch { /* ignore */ }
        setTimeout(cleanup, 300);
      }, 2000);
    }
  });

  return { ok: true, message: 'Bot arrêté' };
}

async function restartBot(id) {
  await stopBot(id);
  await new Promise((r) => setTimeout(r, 1500));
  const bot = storage.getBot(id);
  if (!bot) return { ok: false, message: 'Bot introuvable' };
  return startBot(bot);
}

function killOrphanLocalBots() {
  for (const id of [...activeProcesses.keys()]) {
    stopBot(id).catch(() => {});
  }
  if (process.platform !== 'win32') return;
  try {
    const out = execSync(
      'wmic process where "CommandLine like \'%index.js%\' and Name=\'node.exe\'" get ProcessId /format:value',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] },
    );
    for (const m of out.matchAll(/ProcessId=(\d+)/g)) {
      const pid = m[1];
      if (pid !== String(process.pid)) {
        try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

async function restoreAllBots() {
  for (const bot of storage.loadBots()) {
    if (bot.autoStart !== false && bot.token && (bot.hostMode || 'cloud') === 'cloud') {
      await startBot(bot).catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function getLiveStats() {
  const cloudvm = require('./cloudvm');
  const bots = storage.loadBots();
  const cloudOnline = bots.filter((b) => cloudvm.isCloudBotRunning(b.id)).length;
  const localOnline = activeProcesses.size;
  return {
    total: bots.length,
    online: localOnline + cloudOnline,
    offline: bots.length - localOnline - cloudOnline,
  };
}

function sanitizeBot(bot, opts = {}) {
  const cloudvm = require('./cloudvm');
  const isCloudOnline = cloudvm.isCloudBotRunning(bot.id);
  const isLocalOnline = activeProcesses.has(bot.id);
  const isOnline = isLocalOnline || isCloudOnline;
  const hostMode = bot.hostMode || 'cloud';

  const base = {
    id: bot.id,
    name: bot.name,
    status: isOnline ? 'online' : bot.status || 'offline',
    runtime: bot.runtime || 'nodejs',
    startFile: bot.startFile || 'index.js',
    env: bot.env || {},
    hostMode,
    hostLabel: isCloudOnline || hostMode === 'cloud' ? 'VPS Cloud' : 'Local (ton PC)',
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    lastOnline: bot.lastOnline || null,
    error: bot.error || null,
    pid: isLocalOnline ? activeProcesses.get(bot.id)?.pid : null,
    hasToken: Boolean(bot.token),
    autoStart: Boolean(bot.autoStart),
  };

  if (!opts.lite) {
    base.workspaceSize = fileManager.getWorkspaceSize(bot.id);
    base.fileCount = fileManager.listAllFiles(bot.id).length;
  }

  return base;
}

function getBotStatus(id) {
  const proc = activeProcesses.get(id);
  if (!proc) return null;
  return { pid: proc.pid, running: !proc.killed };
}

module.exports = {
  startBot,
  stopBot,
  restartBot,
  restoreAllBots,
  getLiveStats,
  sanitizeBot,
  getLogs,
  clearLogs,
  getBotStatus,
  isValidToken,
  addLog,
  killOrphanLocalBots,
  activeProcesses,
};
