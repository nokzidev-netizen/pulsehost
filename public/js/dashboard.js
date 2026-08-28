let currentUser = null;
let allBots = [];
let selectedBotId = null;
let logsInterval = null;

const PLAN_LIMITS = { free: 3, standard: 5, pro: 10 };

const views = {
  overview: { title: "Vue d'ensemble", sub: 'Bienvenue sur ton panel PulseHost' },
  deploy: { title: 'Déployer', sub: 'Ajoute un nouveau bot Discord' },
  bots: { title: 'Mes bots', sub: 'Gère tous tes bots hébergés' },
  console: { title: 'Console', sub: 'Logs et monitoring en temps réel' },
};

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById(`view-${name}`)?.classList.add('active');

  const info = views[name] || views.overview;
  document.getElementById('page-title').textContent = info.title;
  document.getElementById('page-sub').textContent = info.sub;

  document.querySelectorAll('.sidebar-link').forEach((l) => {
    l.classList.toggle('active', l.dataset.view === name);
  });

  if (logsInterval) { clearInterval(logsInterval); logsInterval = null; }
  if (name === 'console' && selectedBotId) startLogsPolling();
}

document.querySelectorAll('.sidebar-link').forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    showView(link.dataset.view);
  });
});

async function init() {
  if (!getToken()) {
    window.location.href = '/';
    return;
  }

  try {
    const { user } = await api('/api/auth/me');
    currentUser = user;
    document.getElementById('user-name').textContent = user.username;
    document.getElementById('user-avatar').textContent = user.username[0].toUpperCase();
    document.getElementById('user-plan').textContent = user.plan || 'free';
    document.getElementById('stat-limit').textContent = PLAN_LIMITS[user.plan] || 3;
  } catch {
    window.location.href = '/';
    return;
  }

  await refreshAll();
  setInterval(refreshStats, 15000);
}

async function refreshStats() {
  try {
    const stats = await api('/api/stats');
    document.getElementById('stat-uptime').textContent = formatUptime(stats.uptime);
    document.getElementById('server-status').className = 'status-pill online';
    document.getElementById('server-status').innerHTML = '<span class="status-dot"></span> Serveur en ligne';
  } catch {
    document.getElementById('server-status').className = 'status-pill offline';
    document.getElementById('server-status').innerHTML = '<span class="status-dot"></span> Serveur hors ligne';
  }
}

async function refreshAll() {
  await refreshStats();
  await loadBots();
}

async function loadBots() {
  try {
    allBots = await api('/api/bots');
    renderOverview();
    renderBotsList();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function statusLabel(s) {
  return { online: 'En ligne', offline: 'Hors ligne', error: 'Erreur', starting: 'Démarrage...' }[s] || s;
}

function renderOverview() {
  const online = allBots.filter((b) => b.status === 'online').length;
  document.getElementById('stat-my-bots').textContent = allBots.length;
  document.getElementById('stat-my-online').textContent = online;

  const recent = document.getElementById('recent-bots');
  if (allBots.length === 0) {
    recent.innerHTML = '<div class="empty-mini">Aucun bot déployé — va dans Déployer pour commencer</div>';
    return;
  }

  recent.innerHTML = allBots.slice(0, 5).map((bot) => `
    <div class="recent-item" data-id="${bot.id}">
      <div class="recent-avatar">${bot.avatar ? `<img src="${bot.avatar}" alt="">` : '🤖'}</div>
      <div class="recent-name">${escapeHtml(bot.name)}</div>
      <span class="bot-row-status ${bot.status}">${statusLabel(bot.status)}</span>
    </div>
  `).join('');

  recent.querySelectorAll('.recent-item').forEach((el) => {
    el.addEventListener('click', () => openConsole(el.dataset.id));
  });
}

function renderBotsList() {
  const container = document.getElementById('bots-container');

  if (allBots.length === 0) {
    container.innerHTML = `
      <div class="panel" style="text-align:center;padding:3rem;">
        <div style="font-size:2.5rem;margin-bottom:0.5rem;">🤖</div>
        <p style="color:var(--text2);margin-bottom:1rem;">Aucun bot déployé pour l'instant</p>
        <button class="btn btn-primary" id="empty-deploy">Déployer mon premier bot</button>
      </div>`;
    document.getElementById('empty-deploy')?.addEventListener('click', () => showView('deploy'));
    return;
  }

  container.innerHTML = allBots.map((bot) => `
    <div class="bot-row">
      <div class="bot-row-avatar">${bot.avatar ? `<img src="${bot.avatar}" alt="">` : '🤖'}</div>
      <div class="bot-row-info">
        <div class="bot-row-name">${escapeHtml(bot.name)}</div>
        <div class="bot-row-meta">${bot.username || bot.tokenPreview || '—'} · ${formatDate(bot.createdAt)}</div>
        ${bot.error ? `<div style="color:var(--red);font-size:0.8rem;margin-top:0.2rem;">${escapeHtml(bot.error)}</div>` : ''}
      </div>
      <span class="bot-row-status ${bot.status}">${statusLabel(bot.status)}</span>
      <div class="bot-row-actions">
        ${bot.status === 'online'
          ? `<button class="btn btn-ghost btn-sm stop-btn" data-id="${bot.id}">Stop</button>
             <button class="btn btn-ghost btn-sm restart-btn" data-id="${bot.id}">Restart</button>`
          : `<button class="btn btn-primary btn-sm start-btn" data-id="${bot.id}">Start</button>`
        }
        <button class="btn btn-ghost btn-sm console-btn" data-id="${bot.id}">Console</button>
        <button class="btn btn-ghost btn-sm delete-btn" data-id="${bot.id}">🗑</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.start-btn').forEach((b) => b.addEventListener('click', () => botAction(b.dataset.id, 'start')));
  container.querySelectorAll('.stop-btn').forEach((b) => b.addEventListener('click', () => botAction(b.dataset.id, 'stop')));
  container.querySelectorAll('.restart-btn').forEach((b) => b.addEventListener('click', () => botAction(b.dataset.id, 'restart')));
  container.querySelectorAll('.delete-btn').forEach((b) => b.addEventListener('click', () => {
    if (confirm('Supprimer ce bot définitivement ?')) botAction(b.dataset.id, 'delete');
  }));
  container.querySelectorAll('.console-btn').forEach((b) => b.addEventListener('click', () => openConsole(b.dataset.id)));
}

async function botAction(id, action) {
  try {
    if (action === 'delete') {
      await api(`/api/bots/${id}`, { method: 'DELETE' });
      showToast('Bot supprimé');
      if (selectedBotId === id) { selectedBotId = null; showView('bots'); }
    } else {
      await api(`/api/bots/${id}/${action}`, { method: 'POST' });
      showToast(`Bot ${action === 'start' ? 'démarré' : action === 'stop' ? 'arrêté' : 'redémarré'}`);
    }
    await loadBots();
    if (selectedBotId === id && action !== 'delete') await openConsole(id);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function openConsole(id) {
  selectedBotId = id;
  showView('console');

  const bot = allBots.find((b) => b.id === id);
  if (!bot) return;

  document.getElementById('console-bot-info').innerHTML = `
    <div class="bot-detail-avatar">${bot.avatar ? `<img src="${bot.avatar}" alt="">` : '🤖'}</div>
    <div>
      <div style="font-weight:700;font-size:1.1rem;">${escapeHtml(bot.name)}</div>
      <div style="color:var(--text3);font-size:0.85rem;font-family:var(--mono);">${bot.username || '—'}</div>
      <span class="bot-row-status ${bot.status}" style="margin-top:0.3rem;display:inline-block;">${statusLabel(bot.status)}</span>
    </div>`;

  document.getElementById('console-actions').innerHTML = `
    ${bot.status === 'online'
      ? `<button class="btn btn-ghost btn-sm" id="c-stop">Stop</button>
         <button class="btn btn-ghost btn-sm" id="c-restart">Restart</button>`
      : `<button class="btn btn-primary btn-sm" id="c-start">Start</button>`
    }
    <button class="btn btn-ghost btn-sm" id="c-delete" style="color:var(--red);">Supprimer</button>`;

  document.getElementById('c-start')?.addEventListener('click', () => botAction(id, 'start'));
  document.getElementById('c-stop')?.addEventListener('click', () => botAction(id, 'stop'));
  document.getElementById('c-restart')?.addEventListener('click', () => botAction(id, 'restart'));
  document.getElementById('c-delete')?.addEventListener('click', () => {
    if (confirm('Supprimer ce bot ?')) botAction(id, 'delete');
  });

  try {
    const detail = await api(`/api/bots/${id}`);
    const live = detail.live;
    document.getElementById('console-metrics').innerHTML = live ? `
      <div class="metric"><div class="metric-label">Latence</div><div class="metric-value">${live.ping}ms</div></div>
      <div class="metric"><div class="metric-label">Uptime</div><div class="metric-value">${live.uptime}</div></div>
      <div class="metric"><div class="metric-label">Serveurs</div><div class="metric-value">${live.guilds}</div></div>
      <div class="metric"><div class="metric-label">Statut</div><div class="metric-value" style="color:var(--green);">OK</div></div>
    ` : '<div class="empty-mini">Bot hors ligne</div>';
  } catch { /* ignore */ }

  await loadLogs(id);
  startLogsPolling();
}

async function loadLogs(id) {
  try {
    const logs = await api(`/api/bots/${id}/logs`);
    const output = document.getElementById('console-output');

    if (logs.length === 0) {
      output.innerHTML = '<div class="console-line muted">Aucun log pour l\'instant...</div>';
      return;
    }

    output.innerHTML = logs.map((l) =>
      `<div class="console-line ${l.level}"><span class="console-time">${formatTime(l.time)}</span>${escapeHtml(l.message)}</div>`
    ).join('');
    output.scrollTop = output.scrollHeight;
  } catch { /* ignore */ }
}

function startLogsPolling() {
  if (logsInterval) clearInterval(logsInterval);
  logsInterval = setInterval(() => {
    if (selectedBotId) loadLogs(selectedBotId);
  }, 3000);
}

// Deploy form
document.getElementById('deploy-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('deploy-btn');
  const errEl = document.getElementById('deploy-error');
  const okEl = document.getElementById('deploy-success');
  errEl.classList.add('hidden');
  okEl.classList.add('hidden');

  btn.disabled = true;
  btn.textContent = 'Déploiement en cours...';

  try {
    const bot = await api('/api/bots', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('bot-name').value.trim(),
        token: document.getElementById('bot-token').value.trim(),
      }),
    });

    okEl.textContent = `✓ ${bot.name} est en ligne !`;
    okEl.classList.remove('hidden');
    showToast(`${bot.name} déployé avec succès !`);

    document.getElementById('bot-name').value = '';
    document.getElementById('bot-token').value = '';

    await loadBots();
    setTimeout(() => openConsole(bot.id), 500);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🚀 Déployer maintenant';
  }
});

document.getElementById('toggle-token').addEventListener('click', () => {
  const input = document.getElementById('bot-token');
  input.type = input.type === 'password' ? 'text' : 'password';
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  setToken(null);
  window.location.href = '/';
});

document.getElementById('refresh-bots').addEventListener('click', () => { loadBots(); showToast('Actualisé'); });
document.getElementById('refresh-logs').addEventListener('click', () => selectedBotId && loadLogs(selectedBotId));
document.getElementById('goto-bots').addEventListener('click', () => showView('bots'));
document.getElementById('quick-deploy').addEventListener('click', () => showView('deploy'));
document.getElementById('back-to-bots').addEventListener('click', () => { selectedBotId = null; showView('bots'); });

init();
