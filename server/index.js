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
const { extractZipToWorkspace } = require('./zipExtract');
const vm = require('./vm');
const cloudvm = require('./cloudvm');
const { setupTerminal } = require('./terminal');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const MAX_BOTS = 5;
const MAX_UPLOAD = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD },
  fileFilter: (_req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const ok = name.endsWith('.zip') || /\.(js|mjs|cjs|py|json|txt|env|yaml|yml|toml|md)$/.test(name);
    if (ok) cb(null, true);
    else cb(new Error('Type de fichier non autorisé'));
  },
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

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

function ownsBot(bot, clientId) {
  return bot && bot.clientId === clientId;
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
app.get('/api/projects', clientMiddleware, (req, res) => {
  const bots = storage.getBotsByClient(req.clientId).map((b) => botManager.sanitizeBot(b, { lite: true }));
  res.json(bots);
});

app.post('/api/projects', clientMiddleware, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nom du projet requis' });

  const existing = storage.getBotsByClient(req.clientId);
  if (existing.length >= MAX_BOTS) {
    return res.status(429).json({ error: `Limite: ${MAX_BOTS} projets max` });
  }

  const id = uuidv4();
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  storage.addBot(bot);
  storage.createWorkspace(id);
  res.status(201).json(botManager.sanitizeBot(bot));
});

app.get('/api/projects/:id/status', clientMiddleware, (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  const isOnline = botManager.activeProcesses.has(bot.id);
  res.json({
    id: bot.id,
    status: isOnline ? 'online' : bot.status || 'offline',
    error: bot.error || null,
    pid: isOnline ? botManager.activeProcesses.get(bot.id)?.pid : null,
    live: botManager.getBotStatus(bot.id),
  });
});

app.get('/api/projects/:id', clientMiddleware, (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  res.json({
    ...botManager.sanitizeBot(bot),
    live: botManager.getBotStatus(bot.id),
    startFiles: fileManager.detectStartFiles(bot.id),
  });
});

app.put('/api/projects/:id/settings', clientMiddleware, (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

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
  if (req.body.cloudApiKey !== undefined) {
    patch.cloudApiKey = req.body.cloudApiKey.trim();
  }

  const updated = storage.updateBot(bot.id, patch);
  res.json(botManager.sanitizeBot(updated));
});

app.post('/api/projects/:id/start', clientMiddleware, async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  const result = await botManager.startBot(storage.getBot(bot.id));
  if (!result.ok) return res.status(400).json({ error: result.message });
  res.json(botManager.sanitizeBot(storage.getBot(bot.id)));
});

app.post('/api/projects/:id/stop', clientMiddleware, async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  await botManager.stopBot(bot.id);
  res.json(botManager.sanitizeBot(storage.getBot(bot.id)));
});

app.post('/api/projects/:id/restart', clientMiddleware, async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  const result = await botManager.restartBot(bot.id);
  if (!result.ok) return res.status(400).json({ error: result.message });
  res.json(botManager.sanitizeBot(storage.getBot(bot.id)));
});

app.delete('/api/projects/:id', clientMiddleware, async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  await botManager.stopBot(bot.id);
  storage.deleteBot(bot.id);
  storage.deleteWorkspace(bot.id);
  res.json({ ok: true });
});

app.get('/api/projects/:id/logs', clientMiddleware, (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  const logs = botManager.getLogs(bot.id);
  const since = req.query.since;
  if (since) {
    const filtered = logs.filter((l) => l.time > since);
    return res.json({ logs: filtered, total: logs.length });
  }
  res.json({ logs, total: logs.length });
});

app.delete('/api/projects/:id/logs', clientMiddleware, (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });
  botManager.clearLogs(bot.id);
  res.json({ ok: true });
});

// ─── Files ───
app.get('/api/projects/:id/files', clientMiddleware, (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  const dir = req.query.dir || '';
  res.json({
    files: fileManager.listFiles(bot.id, dir),
    startFiles: fileManager.detectStartFiles(bot.id),
  });
});

app.get('/api/projects/:id/files/content', clientMiddleware, (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  try {
    const content = fileManager.readFile(bot.id, req.query.path);
    res.json({ path: req.query.path, content });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/projects/:id/files/content', clientMiddleware, (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Chemin requis' });

  try {
    fileManager.writeFile(bot.id, filePath, content ?? '');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/projects/:id/files', clientMiddleware, (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  try {
    fileManager.deleteFile(bot.id, req.query.path);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/projects/:id/upload', clientMiddleware, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload échoué' });
    }
    handleUpload(req, res);
  });
});

function handleUpload(req, res) {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });

  const ws = storage.getWorkspacePath(bot.id);
  const originalName = path.basename(req.file.originalname);
  const isZip = originalName.toLowerCase().endsWith('.zip');

  try {
    let uploadMessage;

    if (isZip) {
      const result = extractZipToWorkspace(req.file.buffer, ws);
      uploadMessage = result.message;
      botManager.addLog(bot.id, 'success', `ZIP extrait: ${originalName} — ${result.message}`);
    } else {
      const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
      fs.writeFileSync(path.join(ws, safeName), req.file.buffer);
      uploadMessage = `Fichier uploadé: ${safeName}`;
      botManager.addLog(bot.id, 'info', uploadMessage);
    }

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
  } catch (err) {
    res.status(400).json({ error: err.message || 'Extraction ZIP échouée' });
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
      credits: '100$ de crédits offerts',
      signupUrl: 'https://e2b.dev/dashboard?tab=keys',
    },
  });
});

app.get('/api/projects/:id/vm', clientMiddleware, (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });
  res.json({
    ...vm.getVmStats(bot.id),
    cloud: cloudvm.getCloudStatus(bot.id),
    terminalEnabled: !process.env.VERCEL,
    hasCloudKey: cloudvm.hasApiKey(bot),
  });
});

app.post('/api/projects/:id/vm/exec', clientMiddleware, async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  const { command } = req.body;
  if (!command?.trim()) return res.status(400).json({ error: 'Commande vide' });

  const env = bot.token ? { DISCORD_TOKEN: bot.token, BOT_TOKEN: bot.token } : {};
  const result = await vm.execCommand(bot.id, command.trim(), env);
  res.json(result);
});

app.post('/api/projects/:id/vm/cloud/start', clientMiddleware, async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  try {
    const cloud = await cloudvm.createSandbox(bot.id);
    res.json(cloud);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/projects/:id/vm/cloud/stop', clientMiddleware, async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  await cloudvm.killSandbox(bot.id);
  res.json({ ok: true });
});

app.post('/api/projects/:id/vm/cloud/exec', clientMiddleware, async (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  try {
    const result = await cloudvm.execInSandbox(bot.id, req.body.command);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/projects/:id/vm/cloud-key', clientMiddleware, (req, res) => {
  const bot = storage.getBot(req.params.id);
  if (!ownsBot(bot, req.clientId)) return res.status(404).json({ error: 'Projet introuvable' });

  const { cloudApiKey } = req.body;
  if (!cloudApiKey?.trim()) return res.status(400).json({ error: 'Clé API requise' });

  storage.updateBot(bot.id, { cloudApiKey: cloudApiKey.trim() });
  res.json({ ok: true, hasCloudKey: true });
});

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
    startKeepAlive();
    await botManager.restoreAllBots();
  });
}
