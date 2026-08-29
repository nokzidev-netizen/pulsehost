const os = require('os');
const { spawn } = require('child_process');
const storage = require('./storage');
const fileManager = require('./files');

const DISK_LIMIT = 512 * 1024 * 1024; // 512 Mo
const BLOCKED = [/format\s/i, /rm\s+-rf\s+\//i, /del\s+\/f\s+\/s/i, /shutdown/i, /mkfs/i];

function getVmStats(botId) {
  const mem = process.memoryUsage();
  const diskUsed = fileManager.getWorkspaceSize(botId);
  const ws = storage.getWorkspacePath(botId);

  return {
    id: botId,
    type: 'PulseVM',
    status: 'running',
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    cpu: os.cpus()[0]?.model?.slice(0, 40) || 'CPU',
    cores: os.cpus().length,
    ramUsed: mem.heapUsed,
    ramTotal: Math.min(mem.heapTotal * 4, 512 * 1024 * 1024),
    diskUsed,
    diskLimit: DISK_LIMIT,
    diskPercent: Math.round((diskUsed / DISK_LIMIT) * 100),
    files: fileManager.listAllFiles(botId).length,
    cwd: ws,
    hostname: `pulsevm-${botId.slice(0, 8)}`,
    region: process.env.VERCEL ? 'vercel-edge' : 'pulsehost-local',
    websocket: !process.env.VERCEL,
  };
}

function isCommandAllowed(command) {
  const cmd = command.trim();
  if (!cmd) return false;
  for (const pattern of BLOCKED) {
    if (pattern.test(cmd)) return false;
  }
  return true;
}

function execCommand(botId, command, extraEnv = {}) {
  if (!isCommandAllowed(command)) {
    return Promise.resolve({ stdout: '', stderr: 'Commande bloquée pour sécurité.\n', code: 1 });
  }

  const ws = storage.getWorkspacePath(botId);
  const isWin = process.platform === 'win32';
  const shell = isWin ? 'cmd.exe' : '/bin/sh';
  const args = isWin ? ['/c', command] : ['-c', command];

  return new Promise((resolve) => {
    const proc = spawn(shell, args, {
      cwd: ws,
      env: { ...process.env, ...extraEnv, PULSEHOME: ws },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      stderr += '\n[Timeout 60s]\n';
      resolve({ stdout, stderr, code: 124 });
    }, 60000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: err.message + '\n', code: 1 });
    });
  });
}

module.exports = { getVmStats, execCommand, isCommandAllowed, DISK_LIMIT };
