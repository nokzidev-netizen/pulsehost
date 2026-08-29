const fs = require('fs');
const path = require('path');
const { encrypt, decrypt } = require('./crypto');

const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'pulsehost')
  : path.join(__dirname, '..', 'data');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');
const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
const BLOB_PATH = 'pulsehost/bots.json';

const SECURE_FIELDS = ['token', 'cloudApiKey'];

let memBots = null;
let hydrated = false;
let hydratePromise = null;

function sealBot(bot) {
  if (!bot) return bot;
  const sealed = { ...bot };
  for (const field of SECURE_FIELDS) {
    if (sealed[field]) sealed[field] = encrypt(sealed[field]);
  }
  return sealed;
}

function unsealBot(bot) {
  if (!bot) return bot;
  const open = { ...bot };
  for (const field of SECURE_FIELDS) {
    if (open[field]) open[field] = decrypt(open[field]);
  }
  return open;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(WORKSPACES_DIR)) fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
}

function readJson(file, fallback) {
  ensureDataDir();
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

async function loadFromBlob() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const { head } = require('@vercel/blob');
    const meta = await head(BLOB_PATH);
    if (!meta?.url) return null;
    const res = await fetch(meta.url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function saveToBlob(data) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    const { put } = require('@vercel/blob');
    await put(BLOB_PATH, JSON.stringify(data), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  } catch { /* ignore */ }
}

async function hydrate() {
  if (hydrated) return;
  if (hydratePromise) return hydratePromise;

  hydratePromise = (async () => {
    const local = readJson(BOTS_FILE, []);
    if (local.length > 0) {
      memBots = local;
      hydrated = true;
      return;
    }

    const blobData = await loadFromBlob();
    if (Array.isArray(blobData) && blobData.length > 0) {
      memBots = blobData;
      writeJson(BOTS_FILE, memBots);
      hydrated = true;
      return;
    }

    memBots = [];
    hydrated = true;
  })();

  return hydratePromise;
}

function persistBots(sealedBots) {
  memBots = sealedBots;
  writeJson(BOTS_FILE, sealedBots);
  saveToBlob(sealedBots).catch(() => {});
}

function loadBots() {
  if (memBots === null) {
    memBots = readJson(BOTS_FILE, []);
  }
  return memBots.map(unsealBot);
}

function saveBots(bots) {
  persistBots(bots.map(sealBot));
}

function getBot(id) {
  return loadBots().find((b) => b.id === id) || null;
}

function getBotsByClient(clientId) {
  return loadBots().filter((b) => b.clientId === clientId);
}

function getBotsAccessibleByClient(clientId) {
  return loadBots().filter(
    (b) => b.clientId === clientId || (b.vmSessionMembers || []).includes(clientId),
  );
}

function getBotBySessionCode(code) {
  return loadBots().find((b) => b.vmSessionCode === code) || null;
}

function addBot(bot) {
  const bots = loadBots();
  bots.push(bot);
  saveBots(bots);
  return bot;
}

function updateBot(id, patch) {
  const bots = loadBots();
  const idx = bots.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  bots[idx] = { ...bots[idx], ...patch, updatedAt: new Date().toISOString() };
  saveBots(bots);
  return bots[idx];
}

function deleteBot(id) {
  saveBots(loadBots().filter((b) => b.id !== id));
}

function getWorkspacePath(botId) {
  return path.join(WORKSPACES_DIR, botId);
}

function createWorkspace(botId) {
  const ws = getWorkspacePath(botId);
  if (!fs.existsSync(ws)) fs.mkdirSync(ws, { recursive: true });
  return ws;
}

function deleteWorkspace(botId) {
  const ws = getWorkspacePath(botId);
  if (fs.existsSync(ws)) fs.rmSync(ws, { recursive: true, force: true });
}

async function hydrateMiddleware(req, res, next) {
  try {
    await hydrate();
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  hydrate,
  hydrateMiddleware,
  loadBots,
  getBot,
  getBotsByClient,
  getBotsAccessibleByClient,
  getBotBySessionCode,
  addBot,
  updateBot,
  deleteBot,
  getWorkspacePath,
  createWorkspace,
  deleteWorkspace,
  WORKSPACES_DIR,
};
