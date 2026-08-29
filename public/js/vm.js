let vmSocket = null;
let vmData = null;
let useHttpFallback = false;

function initVm() {
  document.getElementById('btn-term-connect')?.addEventListener('click', connectTerminal);
  document.getElementById('btn-term-clear')?.addEventListener('click', clearTerminal);
  document.getElementById('term-form')?.addEventListener('submit', submitCommand);
  document.getElementById('btn-cloud-start')?.addEventListener('click', startCloudVm);
  document.getElementById('btn-cloud-stop')?.addEventListener('click', stopCloudVm);

  document.querySelectorAll('.cmd-btn').forEach((btn) => {
    btn.addEventListener('click', () => runCommand(btn.dataset.cmd));
  });
}

async function loadVmTab() {
  if (!activeProject) return;

  try {
    vmData = await api(`/api/projects/${activeProject.id}/vm`);
    renderVmStats(vmData);

    if (!vmData.terminalEnabled) {
      document.getElementById('vm-vercel-warn')?.classList.remove('hidden');
      useHttpFallback = true;
    } else {
      document.getElementById('vm-vercel-warn')?.classList.add('hidden');
      useHttpFallback = false;
    }

    renderCloudStatus(vmData.cloud);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderVmStats(data) {
  document.getElementById('vm-hostname').textContent = data.hostname || 'PulseVM';
  document.getElementById('vm-os').textContent = data.os || '—';
  document.getElementById('vm-cpu').textContent = `${data.cores || 1} cores`;
  document.getElementById('vm-ram').textContent = formatBytes(data.ramUsed || 0);
  document.getElementById('vm-disk').textContent = `${formatBytes(data.diskUsed)} / ${formatBytes(data.diskLimit)}`;
  document.getElementById('vm-files-count').textContent = data.files ?? '—';

  const bar = document.getElementById('vm-disk-bar');
  if (bar) bar.style.width = `${Math.min(data.diskPercent || 0, 100)}%`;
}

function renderCloudStatus(cloud) {
  const el = document.getElementById('cloud-status');
  const startBtn = document.getElementById('btn-cloud-start');
  const stopBtn = document.getElementById('btn-cloud-stop');

  if (!cloud?.available) {
    el.textContent = 'Ajoute E2B_API_KEY sur le serveur (gratuit sur e2b.dev)';
    el.className = 'cloud-status offline';
    startBtn.disabled = true;
    return;
  }

  if (cloud.active) {
    el.textContent = `Cloud VM active — ${cloud.id?.slice(0, 12)}...`;
    el.className = 'cloud-status online';
    startBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
  } else {
    el.textContent = 'Prête — $100 crédits gratuits E2B';
    el.className = 'cloud-status ready';
    startBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    startBtn.disabled = false;
  }
}

function connectTerminal() {
  if (!activeProject) return;

  if (useHttpFallback) {
    document.getElementById('term-input').disabled = false;
    document.getElementById('term-status').textContent = 'Mode HTTP';
    appendTerm('Mode commande (Vercel) — tape une commande ci-dessous.\r\n', 'info');
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
      appendTerm(msg.data, msg.type === 'err' ? 'error' : msg.type === 'info' ? 'info' : 'out');
    } catch {
      appendTerm(e.data, 'out');
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
    appendTerm('WebSocket indisponible — mode commande HTTP activé.\r\n', 'info');
  };
}

function appendTerm(text, type = 'out') {
  const term = document.getElementById('vm-terminal');
  if (term.querySelector('.muted')) term.innerHTML = '';

  const span = document.createElement('span');
  span.className = `term-line ${type}`;
  span.textContent = text;
  term.appendChild(span);

  while (term.childNodes.length > 500) term.removeChild(term.firstChild);
  term.scrollTop = term.scrollHeight;
}

function clearTerminal() {
  document.getElementById('vm-terminal').innerHTML = '<div class="term-line muted">Terminal effacé</div>';
}

async function submitCommand(e) {
  e.preventDefault();
  const input = document.getElementById('term-input');
  const cmd = input.value.trim();
  if (!cmd || !activeProject) return;

  appendTerm(`$ ${cmd}\r\n`, 'info');
  input.value = '';
  await runCommand(cmd);
}

async function runCommand(cmd) {
  if (!activeProject) return;

  if (vmSocket?.readyState === WebSocket.OPEN) {
    vmSocket.send(JSON.stringify({ data: cmd + '\n' }));
    return;
  }

  try {
    const result = await api(`/api/projects/${activeProject.id}/vm/exec`, {
      method: 'POST',
      body: JSON.stringify({ command: cmd }),
    });
    if (result.stdout) appendTerm(result.stdout, 'out');
    if (result.stderr) appendTerm(result.stderr, 'error');
    if (!result.stdout && !result.stderr) appendTerm(`[exit ${result.code}]\r\n`, 'muted');
  } catch (err) {
    appendTerm(err.message + '\r\n', 'error');
  }
}

async function startCloudVm() {
  if (!activeProject) return;
  try {
    const r = await api(`/api/projects/${activeProject.id}/vm/cloud/start`, { method: 'POST' });
    showToast(r.message || 'Cloud VM démarrée');
    loadVmTab();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function stopCloudVm() {
  if (!activeProject) return;
  try {
    await api(`/api/projects/${activeProject.id}/vm/cloud/stop`, { method: 'POST' });
    showToast('Cloud VM arrêtée');
    loadVmTab();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function disconnectVm() {
  if (vmSocket) { vmSocket.close(); vmSocket = null; }
}

document.addEventListener('DOMContentLoaded', initVm);
