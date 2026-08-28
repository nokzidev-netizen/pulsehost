const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const storage = require('./storage');

const sessions = new Map();
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function register(username, password, email) {
  const users = storage.loadUsers();

  if (!username || username.length < 3) {
    return { ok: false, error: 'Pseudo minimum 3 caractères' };
  }
  if (!password || password.length < 6) {
    return { ok: false, error: 'Mot de passe minimum 6 caractères' };
  }
  if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    return { ok: false, error: 'Ce pseudo est déjà pris' };
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: uuidv4(),
    username: username.trim(),
    email: (email || '').trim(),
    salt,
    passwordHash: hashPassword(password, salt),
    plan: 'free',
    createdAt: new Date().toISOString(),
  };

  storage.addUser(user);
  const token = createSession(user.id);
  return { ok: true, token, user: sanitizeUser(user) };
}

function login(username, password) {
  const users = storage.loadUsers();
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());

  if (!user) return { ok: false, error: 'Identifiants incorrects' };

  const hash = hashPassword(password, user.salt);
  if (hash !== user.passwordHash) {
    return { ok: false, error: 'Identifiants incorrects' };
  }

  const token = createSession(user.id);
  return { ok: true, token, user: sanitizeUser(user) };
}

function createSession(userId) {
  const token = uuidv4();
  sessions.set(token, { userId, createdAt: Date.now() });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function getUserFromToken(token) {
  const session = getSession(token);
  if (!session) return null;
  return storage.getUser(session.userId);
}

function logout(token) {
  sessions.delete(token);
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    plan: user.plan,
    createdAt: user.createdAt,
  };
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const user = getUserFromToken(token);

  if (!user) {
    return res.status(401).json({ error: 'Connecte-toi pour continuer' });
  }

  req.user = user;
  req.token = token;
  next();
}

module.exports = {
  register,
  login,
  logout,
  getUserFromToken,
  sanitizeUser,
  authMiddleware,
};
