let vmSocket = null;
let vmData = null;
let vmMode = 'console';
let useHttpFallback = false;
let cloudVmActive = false;

function initVm() {
  document.querySelectorAll('.vm-mode').forEach((btn) => {
    btn.addEventListener('click', () => switchVmMode(btn.dataset.mode));
  });

  document.getElementById('btn-term-connect')?.addEventListener('click', connectConsoleTerminal);
  document.getElementById('btn-term-clear')?.addEventListener('click', () => clearTerm('vm-terminal'));
  document.getElementById('term-form')?.addEventListener('submit', (e) => submitCommand(e, 'console'));

  document.getElementById('btn-save-cloud-key')?.addEventListener('click', saveCloudKey);
  document.getElementById('btn-cloud-start')?.addEventListener('click', startCloudVm);
  document.getElementById('btn-cloud-stop')?.addEventListener('click', stopCloudVm);
  document.getElementById('btn-cloud-term-clear')?.addEventListener('click', () => clearTerm('cloud-terminal'));
  document.getElementById('cloud-term-form')?.addEventListener('submit', (e) => submitCommand(e, 'cloud'));

  document.querySelectorAll('.cmd-btn').forEach((btn) => {
    btn.addEventListener('click', () => runCommand(btn.dataset.cmd, 'console'));
  });
}

function switchVmMode(mode) {
  vmMode = mode;
  document.querySelectorAll('.vm-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  document.querySelectorAll('.vm-mode-panel').forEach((p) => p.classList.remove('active'));
  document.getElementById(`vm-panel-${mode}`)?.classList.add('active');

  if (mode === 'cloud') renderCloudPanel();
}

async function loadVmTab() {
  if (!activeProject) return;
  try {
    vmData = await api(`/api/projects/${activeProject.id}/vm`);
    renderConsoleStats(vmData);
    renderCloudPanel();

    if (!vmData.terminalEnabled) {
      document.getElementById('vm-vercel-warn')?.classList.remove('hidden');
      useHttpFallback = true;
    } else {
      document.getElementById('vm-vercel-warn')?.classList.add('hidden');
      useHttpFallback = false;
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderConsoleStats(data) {
  document.getElementById('vm-hostname').textContent = data.hostname || 'PulseConsole';
  document.getElementById('vm-os').textContent = data.os || '—';
  document.getElementById('vm-cpu').textContent = `${data.cores || 1} cores`;
  document.getElementById('vm-ram').textContent = formatBytes(data.ramUsed || 0);
  document.getElementById('vm-disk').textContent = `${formatBytes(data.diskUsed)} / ${formatBytes(data.diskLimit)}`;
  document.getElementById('vm-files-count').textContent = data.files ?? '—';
  const bar = document.getElementById('vm-disk-bar');
  if (bar) bar.style.width = `${Math.min(data.diskPercent || 0, 100)}%`;
}

function renderCloudPanel() {
  const cloud = vmData?.cloud || {};
  cloudVmActive = cloud.active;

  const dot = document.getElementById('cloud-dot');
  const statusText = document.getElementById('cloud-status-text');
  const startBtn = document.getElementById('btn-cloud-start');
  const stopBtn = document.getElementById('btn-cloud-stop');
  const termInput = document.getElementById('cloud-term-input');
  const termStatus = document.getElementById('cloud-term-status');

  if (cloud.active) {
    dot?.classList.add('running');
    statusText.textContent = 'En ligne';
    document.getElementById('cloud-hostname').textContent = cloud.hostname || 'PulseCloud VM';
    startBtn?.classList.add('hidden');
    stopBtn?.classList.remove('hidden');
    termInput.disabled = false;
    termStatus.textContent = 'Connecté';
    termStatus.className = 'term-status online';
  } else {
    dot?.classList.remove('running');
    statusText.textContent = vmData?.hasCloudKey ? 'Prête — clique Démarrer' : 'Ajoute ta clé API';
    startBtn?.classList.remove('hidden');
    stopBtn?.classList.add('hidden');
    termInput.disabled = true;
    termStatus.textContent = 'En attente';
    termStatus.className = 'term-status';
  }

  const keyInput = document.getElementById('cloud-api-key');
  if (keyInput && vmData?.hasCloudKey) {
    keyInput.placeholder = '•••••••••••• (clé sauvegardée)';
  }
}

async function saveCloudKey() {
  if (!activeProject) return;
  const key = document.getElementById('cloud-api-key').value.trim();
  if (!key) return showToast('Colle ta clé API', 'error');

  try {
    await api(`/api/projects/${activeProject.id}/vm/cloud-key`, {
      method: 'PUT',
      body: JSON.stringify({ cloudApiKey: key }),
    });
    showToast('Clé API sauvegardée');
    document.getElementById('cloud-api-key').value = '';
    vmData.hasCloudKey = true;
    renderCloudPanel();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function connectConsoleTerminal() {
  if (!activeProject) return;

  if (useHttpFallback) {
    document.getElementById('term-input').disabled = false;
    document.getElementById('term-status').textContent = 'Mode HTTP';
    appendTerm('vm-terminal', 'Terminal prêt — tape une commande.\r\n', 'info');
    return;
  }

  if (vmSocket?.readyState === WebSocket.OPEN) return;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/api/vm/ws?project=${activeProject.id}&client=${getClientId()}`;

  vmSocket = new WebSocket(url);
  document.getElementById('term-status').textContent = 'Connexion...';

  vmSocket.onopen = () => {
    document.getElementById('term-status').textContent = 'Connecté';
    document.getElementById('term-status').className = 'term-status online';
    document.getElementById('term-input').disabled = false;
  };

  vmSocket.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      appendTerm('vm-terminal', msg.data, msg.type === 'err' ? 'error' : msg.type === 'info' ? 'info' : 'out');
    } catch {
      appendTerm('vm-terminal', e.data, 'out');
    }
  };

  vmSocket.onclose = () => {
    document.getElementById('term-status').textContent = 'Déconnecté';
    document.getElementById('term-status').className = 'term-status';
    document.getElementById('term-input').disabled = true;
    vmSocket = null;
  };

  vmSocket.onerror = () => {
    useHttpFallback = true;
    document.getElementById('term-input').disabled = false;
    document.getElementById('term-status').textContent = 'Mode HTTP';
    appendTerm('vm-terminal', 'Terminal HTTP activé.\r\n', 'info');
  };
}

function appendTerm(termId, text, type = 'out') {
  const term = document.getElementById(termId);
  if (term.querySelector('.muted')) term.innerHTML = '';

  const span = document.createElement('span');
  span.className = `term-line ${type}`;
  span.textContent = text;
  term.appendChild(span);

  while (term.childNodes.length > 500) term.removeChild(term.firstChild);
  term.scrollTop = term.scrollHeight;
}

function clearTerm(termId) {
  document.getElementById(termId).innerHTML = '<div class="term-line muted">Terminal effacé</div>';
}

async function submitCommand(e, mode) {
  e.preventDefault();
  const inputId = mode === 'cloud' ? 'cloud-term-input' : 'term-input';
  const termId = mode === 'cloud' ? 'cloud-terminal' : 'vm-terminal';
  const input = document.getElementById(inputId);
  const cmd = input.value.trim();
  if (!cmd || !activeProject) return;

  appendTerm(termId, `$ ${cmd}\r\n`, 'info');
  input.value = '';
  await runCommand(cmd, mode);
}

async function runCommand(cmd, mode) {
  if (!activeProject) return;

  if (mode === 'console' && vmSocket?.readyState === WebSocket.OPEN) {
    vmSocket.send(JSON.stringify({ data: cmd + '\n' }));
    return;
  }

  const endpoint = mode === 'cloud'
    ? `/api/projects/${activeProject.id}/vm/cloud/exec`
    : `/api/projects/${activeProject.id}/vm/exec`;

  const termId = mode === 'cloud' ? 'cloud-terminal' : 'vm-terminal';

  try {
    const result = await api(endpoint, {
      method: 'POST',
      body: JSON.stringify({ command: cmd }),
    });
    if (result.stdout) appendTerm(termId, result.stdout, 'out');
    if (result.stderr) appendTerm(termId, result.stderr, 'error');
    if (!result.stdout && !result.stderr) appendTerm(termId, `[exit ${result.code}]\r\n`, 'muted');
  } catch (err) {
    appendTerm(termId, err.message + '\r\n', 'error');
  }
}

async function startCloudVm() {
  if (!activeProject) return;
  if (!vmData?.hasCloudKey) return showToast('Sauvegarde ta clé API d\'abord', 'error');

  try {
    const r = await api(`/api/projects/${activeProject.id}/vm/cloud/start`, { method: 'POST' });
    showToast(r.message || 'VM démarrée');
    appendTerm('cloud-terminal', `[PulseCloud] VM démarrée — ${r.hostname}\r\n`, 'success');
    appendTerm('cloud-terminal', 'Tes fichiers ont été synchronisés. Lance: cd /home/user && node index.js\r\n', 'info');
    await loadVmTab();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function stopCloudVm() {
  if (!activeProject) return;
  try {
    await api(`/api/projects/${activeProject.id}/vm/cloud/stop`, { method: 'POST' });
    showToast('VM arrêtée');
    clearTerm('cloud-terminal');
    await loadVmTab();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function disconnectVm() {
  if (vmSocket) { vmSocket.close(); vmSocket = null; }
}

document.addEventListener('DOMContentLoaded', initVm);
