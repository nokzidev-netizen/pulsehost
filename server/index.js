const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const storage = require('./storage');
const botManager = require('./botManager');
const fileManager = require('./files');
const { extractArchiveToWorkspace } = require('./archiveExtract');
const { applySecurityHeaders, rateLimit, blockScanners } = require('./security');
const vm = require('./vm');
const cloudvm = require('./cloudvm');
const vmSession = require('./vmSession');
const { setupTerminal } = require('./terminal');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const MAX_UPLOAD = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const ok = name.endsWith('.zip') || name.endsWith('.rar')
      || /\.(js|mjs|cjs|ts|py|json|txt|env|yaml|yml|toml|md|html|css|sh|bat|ps1)$/i.test(name);
    if (ok) cb(null, true);
    else cb(new Error('Type de fichier non autorisé'));
  },
});

app.use(applySecurityHeaders);
app.use(blockScanners);
app.use(rateLimit({ max: 200 }));
app.use(cors({ origin: false }));
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(async (req, res, next) => {
  try {
    await storage.hydrate();
    next();
  } catch (err) {
    next(err);
  }
});
app.use((req, res, next) => {
  const match = req.path.match(/^\/api\/projects\/([^/]+)/);
  const cloudKey = req.headers['x-cloud-key']?.trim();
  if (match && cloudKey) {
    cloudvm.setRequestCloudKey(match[1], cloudKey);
    res.on('finish', () => cloudvm.clearRequestCloudKey(match[1]));
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), {
  dotfiles: 'deny',
  index: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

function getClientId(req) {
  return req.headers['x-client-id'] || req.query.clientId || null;
}

function clientMiddleware(req, res, next) {
  const clientId = getClientId(req);
  if (!clientId || clientId.length < 8) {
    return res.status(400).json({ error: 'Client ID manquant' });
  }
  req.clientId = clientId;
  next();
}

function protectedRoute(...handlers) {
  return [clientMiddleware, ...handlers];
}

function ownsBot(bot, clientId) {
  return bot && bot.clientId === clientId;
}

function canAccessBot(bot, clientId) {
  return vmSession.canAccess(bot, clientId);
}

// ─── Public ───
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime(), timestamp: Date.now() });
});

app.get('/api/stats', (_req, res) => {
  const stats = botManager.getLiveStats();
  res.json({ ...stats, uptime: Math.floor(process.uptime()) });
});

// ─── Projects ───
app.get('/api/projects', ...protectedRoute((req, res) => {
  const bots = storage.getBotsAccessibleByClient(req.clientId).map((b) => ({
    ...botManager.sanitizeBot(b, { lite: true }),
    isShared: b.clientId !== req.clientId,
    sessionCode: b.vmSessionCode || null,
  }));
  res.json(bots);
}));

app.post('/api/projects', ...protectedRoute((req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Nom du projet requis' });

    const id = uuidv4();
    storage.createWorkspace(id);
    fileManager.createDefaultProject(id);

    const bot = {
      id,
      clientId: req.clientId,
      name: name.trim().slice(0, 48),
      token: '',
      startFile: 'index.js',
      runtime: 'nodejs',
      env: {},
      status: 'offline',
      autoStart: false,
      hostMode: 'cloud',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    storage.addBot(bot);
    res.status(201).json(botManager.sanitizeBot(bot));
  } catch (err) {
    res.status(500).json({ error: err.message || 'Impossible de créer le projet' });
  }
}));

app.get('/api/projects/:id/status', ...protectedRoute((req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  const isOnline = botManager.activeProcesses.has(bot.id);
  res.json({
    id: bot.id,
    status: isOnline ? 'online' : bot.status || 'offline',
    error: bot.error || null,
    pid: isOnline ? botManager.activeProcesses.get(bot.id)?.pid : null,
    live: botManager.getBotStatus(bot.id),
  });
}));

app.get('/api/projects/:id', ...protectedRoute((req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  res.json({
    ...botManager.sanitizeBot(bot),
    live: botManager.getBotStatus(bot.id),
    startFiles: fileManager.detectStartFiles(bot.id),
    isShared: bot.clientId !== req.clientId,
    session: vmSession.getSessionInfo(bot.id),
  });
}));

app.put('/api/projects/:id/settings', ...protectedRoute((req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  const { name, token, startFile, runtime, env, autoStart } = req.body;
  const patch = {};

  if (name?.trim()) patch.name = name.trim().slice(0, 48);
  if (token !== undefined) {
    if (token && !botManager.isValidToken(token)) {
      return res.status(400).json({ error: 'Format de token Discord invalide' });
    }
    patch.token = token.trim();
  }
  if (startFile) {
    const ws = storage.getWorkspacePath(bot.id);
    const fp = path.join(ws, startFile);
    if (!fs.existsSync(fp)) {
      return res.status(400).json({ error: `Fichier introuvable: ${startFile}` });
    }
    patch.startFile = startFile;
  }
  if (runtime && ['nodejs', 'python'].includes(runtime)) patch.runtime = runtime;
  if (env && typeof env === 'object') patch.env = env;
  if (autoStart !== undefined) patch.autoStart = Boolean(autoStart);
  if (req.body.hostMode && ['local', 'cloud'].includes(req.body.hostMode)) {
    patch.hostMode = req.body.hostMode;
  }
  if (req.body.cloudApiKey !== undefined) {
    if (!vmSession.isOwner(bot, req.clientId)) {
      return res.status(403).json({ error: 'Seul le créateur peut modifier la clé API cloud' });
    }
    patch.cloudApiKey = req.body.cloudApiKey.trim();
  }

  const updated = storage.updateBot(bot.id, patch);
  res.json(botManager.sanitizeBot(updated));
}));

app.post('/api/projects/:id/start', ...protectedRoute(async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  const result = await botManager.startBot(storage.getBot(bot.id));
  if (!result.ok) return res.status(400).json({ error: result.message });
  res.json(botManager.sanitizeBot(storage.getBot(bot.id)));
}));

app.post('/api/projects/:id/stop', ...protectedRoute(async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  await botManager.stopBot(bot.id);
  res.json(botManager.sanitizeBot(storage.getBot(bot.id)));
}));

app.post('/api/projects/:id/restart', ...protectedRoute(async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  const result = await botManager.restartBot(bot.id);
  if (!result.ok) return res.status(400).json({ error: result.message });
  res.json(botManager.sanitizeBot(storage.getBot(bot.id)));
}));

app.delete('/api/projects/:id', ...protectedRoute(async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  await botManager.stopBot(bot.id);
  storage.deleteBot(bot.id);
  storage.deleteWorkspace(bot.id);
  res.json({ ok: true });
}));

app.get('/api/projects/:id/logs', ...protectedRoute(async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  if (cloudvm.isCloudBotRunning(bot.id)) {
    try { await cloudvm.pullCloudBotLogs(bot.id); } catch { /* ignore */ }
  }

  const logs = botManager.getLogs(bot.id);
  const since = req.query.since;
  if (since) {
    const filtered = logs.filter((l) => l.time > since);
    return res.json({ logs: filtered, total: logs.length });
  }
  res.json({ logs, total: logs.length });
}));

app.delete('/api/projects/:id/logs', ...protectedRoute((req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });
  botManager.clearLogs(bot.id);
  res.json({ ok: true });
}));

// ─── Files ───
app.get('/api/projects/:id/files', ...protectedRoute((req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  const dir = req.query.dir || '';
  res.json({
    files: fileManager.listFiles(bot.id, dir),
    startFiles: fileManager.detectStartFiles(bot.id),
  });
}));

app.get('/api/projects/:id/files/content', ...protectedRoute((req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  try {
    const content = fileManager.readFile(bot.id, req.query.path);
    res.json({ path: req.query.path, content });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.put('/api/projects/:id/files/content', ...protectedRoute((req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Chemin requis' });

  try {
    fileManager.writeFile(bot.id, filePath, content ?? '');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.delete('/api/projects/:id/files', ...protectedRoute((req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  try {
    fileManager.deleteFile(bot.id, req.query.path);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post('/api/projects/:id/upload', ...protectedRoute((req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload échoué' });
    }
    handleUpload(req, res);
  });
}));

function handleUpload(req, res) {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  const ws = storage.getWorkspacePath(bot.id);
  const originalName = path.basename(req.file.originalname);
  const lower = originalName.toLowerCase();
  const isArchive = lower.endsWith('.zip') || lower.endsWith('.rar');

  const finish = (uploadMessage) => {
    const startFiles = fileManager.detectStartFiles(bot.id);
    const currentBot = storage.getBot(bot.id);
    const currentStartPath = path.join(ws, currentBot.startFile || '');
    const startExists = fs.existsSync(currentStartPath);

    if (startFiles.length) {
      const newStart = startExists && startFiles.includes(currentBot.startFile)
        ? currentBot.startFile
        : startFiles[0];
      storage.updateBot(bot.id, { startFile: newStart });
      if (newStart !== currentBot.startFile) {
        botManager.addLog(bot.id, 'info', `Fichier de démarrage: ${newStart}`);
      }
    }

    res.json({
      ok: true,
      message: uploadMessage,
      files: fileManager.listFiles(bot.id),
      startFiles: fileManager.detectStartFiles(bot.id),
      startFile: storage.getBot(bot.id).startFile,
    });
  };

  if (isArchive) {
    extractArchiveToWorkspace(req.file.buffer, originalName, ws)
      .then((result) => {
        botManager.addLog(bot.id, 'success', `${lower.endsWith('.rar') ? 'RAR' : 'ZIP'} extrait: ${originalName} — ${result.message}`);
        finish(result.message);
      })
      .catch((err) => {
        res.status(400).json({ error: err.message || 'Extraction échouée' });
      });
    return;
  }

  try {
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    fs.writeFileSync(path.join(ws, safeName), req.file.buffer);
    const uploadMessage = `Fichier uploadé: ${safeName}`;
    botManager.addLog(bot.id, 'info', uploadMessage);
    finish(uploadMessage);
  } catch (err) {
    res.status(400).json({ error: err.message || 'Upload échoué' });
  }
}

// ─── VPS / PulseVM ───
app.get('/api/vm/info', (_req, res) => {
  res.json({
    modes: [
      { id: 'console', name: 'VPS Console', desc: 'Terminal intégré — gratuit, instantané', icon: '💻' },
      { id: 'cloud', name: 'Machine Virtuelle', desc: 'Vraie VM Linux cloud isolée — gratuit avec clé API', icon: '🖥' },
    ],
    keyHelp: {
      free: true,
      noCreditCard: true,
      credits: 'Crédits cloud offerts',
    },
  });
});

app.get('/api/projects/:id/vm', ...protectedRoute((req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });
  res.json({
    ...vm.getVmStats(bot.id),
    cloud: cloudvm.getCloudStatus(bot.id),
    terminalEnabled: !process.env.VERCEL,
    hasCloudKey: cloudvm.hasApiKey(bot, req),
    session: {
      ...vmSession.getSessionInfo(bot.id),
      isOwner: vmSession.isOwner(bot, req.clientId),
    },
  });
}));

app.post('/api/vm/session/join', ...protectedRoute((req, res) => {
  try {
    const { code } = req.body || {};
    const joined = vmSession.joinSession(code, req.clientId);
    res.json(joined);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post('/api/projects/:id/vm/session/create', ...protectedRoute((req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!vmSession.isOwner(bot, req.clientId)) {
    return res.status(403).json({ error: 'Seul le créateur peut créer une session' });
  }

  try {
    const session = vmSession.createSession(bot.id, req.clientId);
    res.json({ ok: true, session });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post('/api/projects/:id/vm/cloud/sync', ...protectedRoute(async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  try {
    const result = await cloudvm.syncPullFromSandbox(bot.id);
    res.json({ ok: true, ...result, message: `${result.saved} fichier(s) sauvegardés` });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post('/api/projects/:id/vm/exec', ...protectedRoute(async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  const { command } = req.body;
  if (!command?.trim()) return res.status(400).json({ error: 'Commande vide' });

  const env = bot.token ? { DISCORD_TOKEN: bot.token, BOT_TOKEN: bot.token } : {};
  const result = await vm.execCommand(bot.id, command.trim(), env);
  res.json(result);
}));

app.post('/api/projects/:id/vm/cloud/start', ...protectedRoute(async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  try {
    const cloud = await cloudvm.createSandbox(bot.id);
    res.json(cloud);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post('/api/projects/:id/vm/cloud/stop', ...protectedRoute(async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  await cloudvm.killSandbox(bot.id);
  res.json({ ok: true });
}));

app.post('/api/projects/:id/vm/cloud/exec', ...protectedRoute(async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!canAccessBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  try {
    const result = await cloudvm.execInSandbox(bot.id, req.body.command);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.put('/api/projects/:id/vm/cloud-key', ...protectedRoute(saveCloudKeyHandler));
app.post('/api/projects/:id/vm/cloud-key', ...protectedRoute(saveCloudKeyHandler));

function saveCloudKeyHandler(req, res) {
  try {
    const bot = storage.getBot(req.params.id);
    if (!bot) {
      return res.status(404).json({
        error: 'Projet introuvable — recrée ton projet puis réessaie',
      });
    }
    if (!canAccessBot(bot, req.clientId)) {
      return res.status(404).json({ error: 'Projet introuvable' });
    }
    if (!vmSession.isOwner(bot, req.clientId)) {
      return res.status(403).json({ error: 'Seul le créateur peut modifier la clé API cloud' });
    }

    const { cloudApiKey } = req.body || {};
    if (!cloudApiKey?.trim()) return res.status(400).json({ error: 'Clé API requise' });

    storage.updateBot(bot.id, { cloudApiKey: cloudApiKey.trim() });
    res.json({ ok: true, hasCloudKey: true });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Impossible de sauvegarder la clé' });
  }
}

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Route introuvable' });
  const page = (req.path === '/panel' || req.path.startsWith('/panel/') || req.path === '/dashboard')
    ? 'panel.html' : 'index.html';
  res.sendFile(path.join(__dirname, '..', 'public', page));
});

function startKeepAlive() {
  if (PUBLIC_URL.includes('localhost') || process.env.VERCEL) return;
  setInterval(() => {
    http.get(`${PUBLIC_URL}/api/health`, () => {}).on('error', () => {});
  }, 4 * 60 * 1000);
}

module.exports = app;

if (!process.env.VERCEL) {
  const server = http.createServer(app);
  setupTerminal(server);

  server.listen(PORT, async () => {
    console.log(`PulseHost → ${PUBLIC_URL}`);
    console.log(`PulseVM terminal → ws://localhost:${PORT}/api/vm/ws`);
    botManager.killOrphanLocalBots();
    startKeepAlive();
    await botManager.restoreAllBots();
  });
}
