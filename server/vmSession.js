const crypto = require('crypto');
const storage = require('./storage');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function normalizeCode(code) {
  return (code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function generateCode() {
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  }
  return code;
}

function canAccess(bot, clientId) {
  if (!bot || !clientId) return false;
  if (bot.clientId === clientId) return true;
  return (bot.vmSessionMembers || []).includes(clientId);
}

function isOwner(bot, clientId) {
  return Boolean(bot && bot.clientId === clientId);
}

function createSession(botId, clientId) {
  const bot = storage.getBot(botId);
  if (!isOwner(bot, clientId)) throw new Error('Seul le créateur peut créer une session');

  let code = bot.vmSessionCode;
  const members = new Set(bot.vmSessionMembers || [bot.clientId]);
  members.add(clientId);

  if (!code) {
    do {
      code = generateCode();
    } while (storage.getBotBySessionCode(code));
  }

  storage.updateBot(botId, {
    vmSessionCode: code,
    vmSessionMembers: [...members],
  });

  return getSessionInfo(botId);
}

function joinSession(code, clientId) {
  const normalized = normalizeCode(code);
  if (normalized.length < 4) throw new Error('Code session invalide');

  const bot = storage.getBotBySessionCode(normalized);
  if (!bot) throw new Error('Code session introuvable');

  const members = new Set(bot.vmSessionMembers || [bot.clientId]);
  members.add(clientId);
  storage.updateBot(bot.id, { vmSessionMembers: [...members] });

  return {
    projectId: bot.id,
    name: bot.name,
    session: getSessionInfo(bot.id),
  };
}

function getSessionInfo(botId) {
  const bot = storage.getBot(botId);
  if (!bot) return null;

  return {
    code: bot.vmSessionCode || null,
    members: (bot.vmSessionMembers || []).length,
    lastSync: bot.vmLastSync || null,
    isOwner: false,
  };
}

module.exports = {
  canAccess,
  isOwner,
  createSession,
  joinSession,
  getSessionInfo,
  normalizeCode,
};
