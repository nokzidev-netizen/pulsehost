const fs = require('fs');
const path = require('path');
const storage = require('./storage');

const ALLOWED_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.json', '.py',
  '.env', '.txt', '.md', '.yaml', '.yml', '.toml',
]);

function safePath(base, relative) {
  const resolved = path.resolve(base, relative);
  if (!resolved.startsWith(path.resolve(base))) {
    throw new Error('Chemin interdit');
  }
  return resolved;
}

function listFiles(botId, subPath = '') {
  const base = storage.getWorkspacePath(botId);
  if (!fs.existsSync(base)) return [];

  const dir = safePath(base, subPath || '.');
  if (!fs.statSync(dir).isDirectory()) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
    .map((e) => {
      const rel = subPath ? `${subPath}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      const stat = fs.statSync(full);
      return {
        name: e.name,
        path: rel.replace(/\\/g, '/'),
        type: e.isDirectory() ? 'folder' : 'file',
        size: e.isFile() ? stat.size : null,
        modified: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

function listAllFiles(botId, subPath = '', acc = []) {
  const items = listFiles(botId, subPath);
  for (const item of items) {
    if (item.type === 'file') acc.push(item.path);
    else listAllFiles(botId, item.path, acc);
  }
  return acc;
}

function detectStartFiles(botId) {
  const all = listAllFiles(botId);
  const candidates = [];
  const priority = [
    'index.js', 'main.js', 'bot.js', 'app.js', 'start.js', 'index.mjs',
    'main.py', 'bot.py', 'index.py', 'app.py', 'start.py',
  ];

  for (const p of priority) {
    if (all.includes(p)) candidates.push(p);
  }
  for (const f of all) {
    if (!candidates.includes(f) && (f.endsWith('.js') || f.endsWith('.mjs') || f.endsWith('.cjs') || f.endsWith('.py'))) {
      candidates.push(f);
    }
  }
  return candidates;
}

function readFile(botId, filePath) {
  const base = storage.getWorkspacePath(botId);
  const full = safePath(base, filePath);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw new Error('Fichier introuvable');
  }
  return fs.readFileSync(full, 'utf8');
}

function writeFile(botId, filePath, content) {
  const base = storage.getWorkspacePath(botId);
  const ext = path.extname(filePath).toLowerCase();
  if (ext && !ALLOWED_EXT.has(ext)) {
    throw new Error('Extension non autorisée');
  }
  const full = safePath(base, filePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

function deleteFile(botId, filePath) {
  const base = storage.getWorkspacePath(botId);
  const full = safePath(base, filePath);
  if (!fs.existsSync(full)) throw new Error('Fichier introuvable');
  fs.rmSync(full, { recursive: true, force: true });
}

function getWorkspaceSize(botId) {
  const base = storage.getWorkspacePath(botId);
  if (!fs.existsSync(base)) return 0;

  function walk(dir) {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += walk(full);
      else total += fs.statSync(full).size;
    }
    return total;
  }
  return walk(base);
}

function createDefaultProject(botId) {
  const ws = storage.createWorkspace(botId);
  const indexPath = path.join(ws, 'index.js');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, DEFAULT_BOT_TEMPLATE, 'utf8');
  }
  const pkgPath = path.join(ws, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: 'discord-bot',
      version: '1.0.0',
      main: 'index.js',
      dependencies: { 'discord.js': '^14.16.3' },
    }, null, 2), 'utf8');
  }
}

const DEFAULT_BOT_TEMPLATE = `const { Client, GatewayIntentBits, ActivityType } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(\`[OK] Connecté: \${client.user.tag}\`);
  client.user.setActivity('PulseHost', { type: ActivityType.Watching });
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.content.startsWith('!')) return;
  const cmd = msg.content.slice(1).split(' ')[0].toLowerCase();

  if (cmd === 'ping') {
    await msg.reply(\`🏓 Pong! \${client.ws.ping}ms\`);
  } else if (cmd === 'help') {
    await msg.reply('Commandes: \`!ping\`, \`!help\`, \`!status\`');
  } else if (cmd === 'status') {
    await msg.reply('✅ Bot en ligne sur PulseHost');
  }
});

const token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || process.env.TOKEN;
if (!token) {
  console.error('[ERREUR] Token manquant — configure-le dans Paramètres');
  process.exit(1);
}

client.login(token);
`;

module.exports = {
  listFiles,
  listAllFiles,
  detectStartFiles,
  readFile,
  writeFile,
  deleteFile,
  getWorkspaceSize,
  createDefaultProject,
  safePath,
  DEFAULT_BOT_TEMPLATE,
};
