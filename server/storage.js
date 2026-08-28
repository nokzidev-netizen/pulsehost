const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'pulsehost')
  : path.join(__dirname, '..', 'data');
const BOTS_FILE = path.join(DATA_DIR, 'bots.json');
const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(WORKSPACES_DIR)) fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
}

function readJson(file, fallback) {
  ensureDataDir();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, JSON.stringify(fallback, null, 2), 'utf8');
    return fallback;
  }
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

function loadBots() {
  return readJson(BOTS_FILE, []);
}

function saveBots(bots) {
  writeJson(BOTS_FILE, bots);
}

function getBot(id) {
  return loadBots().find((b) => b.id === id) || null;
}

function getBotsByClient(clientId) {
  return loadBots().filter((b) => b.clientId === clientId);
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

module.exports = {
  loadBots,
  getBot,
  getBotsByClient,
  addBot,
  updateBot,
  deleteBot,
  getWorkspacePath,
  createWorkspace,
  deleteWorkspace,
  WORKSPACES_DIR,
};
