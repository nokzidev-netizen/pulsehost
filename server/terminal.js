const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const storage = require('./storage');
const { isCommandAllowed } = require('./vm');

const sessions = new Map();

function validateAccess(projectId, clientId) {
  const bot = storage.getBot(projectId);
  return bot && bot.clientId === clientId;
}

function setupTerminal(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/api/vm/ws') {
      socket.destroy();
      return;
    }

    const projectId = url.searchParams.get('project');
    const clientId = url.searchParams.get('client');

    if (!projectId || !clientId || !validateAccess(projectId, clientId)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.projectId = projectId;
      startShell(ws, projectId);
    });
  });

  return wss;
}

function startShell(ws, projectId) {
  const workspace = storage.getWorkspacePath(projectId);
  const isWin = process.platform === 'win32';
  const shell = isWin ? 'powershell.exe' : 'bash';
  const shellArgs = isWin ? ['-NoLogo', '-NoExit'] : [];

  let proc;
  try {
    proc = spawn(shell, shellArgs, {
      cwd: workspace,
      env: { ...process.env, PULSEHOME: workspace, TERM: 'xterm-256color' },
      windowsHide: true,
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: 'err', data: err.message }));
    ws.close();
    return;
  }

  sessions.set(ws, proc);

  ws.send(JSON.stringify({
    type: 'info',
    data: `PulseVM connectée — ${workspace}\r\nTape tes commandes (npm install, node index.js, dir, ls...)\r\n\r\n`,
  }));

  proc.stdout.on('data', (d) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'out', data: d.toString() }));
  });

  proc.stderr.on('data', (d) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'err', data: d.toString() }));
  });

  proc.on('close', () => {
    sessions.delete(ws);
    if (ws.readyState === 1) ws.close();
  });

  ws.on('message', (raw) => {
    let cmd;
    try {
      const msg = JSON.parse(raw.toString());
      cmd = msg.data || msg.command || raw.toString();
    } catch {
      cmd = raw.toString();
    }

    if (!isCommandAllowed(cmd.split('\n')[0])) {
      ws.send(JSON.stringify({ type: 'err', data: 'Commande bloquée.\r\n' }));
      return;
    }

    proc.stdin.write(cmd.endsWith('\n') ? cmd : cmd + '\n');
  });

  ws.on('close', () => {
    const p = sessions.get(ws);
    if (p) { p.kill(); sessions.delete(ws); }
  });
}

module.exports = { setupTerminal };
