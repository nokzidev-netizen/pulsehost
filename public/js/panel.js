let projects = [];
let activeProject = null;
let activeTab = 'overview';
let currentFilePath = '';
let currentDir = '';
let editorDirty = false;

let pollTimer = null;
let isPolling = false;
let isFetching = false;
let lastLogTime = null;
let lastLogCount = 0;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function init() {
  bindEvents();
  const clientEl = $('#client-id-display');
  if (clientEl) clientEl.textContent = getClientId().slice(0, 8) + '...';

  syncProjectsToServer()
    .then(() => loadProjects(false))
    .then(() => startSmartPolling())
    .catch(() => {
      loadProjects(false);
      startSmartPolling();
    });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPolling();
    else startSmartPolling();
  });
}

async function syncProjectsToServer() {
  const cached = loadCachedProjects();
  if (!cached.length) return;
  await api('/api/projects/sync', {
    method: 'POST',
    body: JSON.stringify({ projects: cached }),
  });
}

function bindEvents() {
  $('#btn-new-project').addEventListener('click', openNewModal);
  $('#empty-new-project')?.addEventListener('click', openNewModal);
  $('#modal-close').addEventListener('click', closeNewModal);
  $('#new-project-modal').addEventListener('click', (e) => { if (e.target.id === 'new-project-modal') closeNewModal(); });
  $('#new-project-form').addEventListener('submit', createProject);

  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#btn-start').addEventListener('click', () => projectAction('start'));
  $('#btn-stop').addEventListener('click', () => projectAction('stop'));
  $('#btn-restart').addEventListener('click', () => projectAction('restart'));
  $('#btn-delete').addEventListener('click', deleteProject);

  $('#settings-form').addEventListener('submit', saveSettings);
  $('#btn-add-env').addEventListener('click', () => addEnvRow('', ''));
  $('#toggle-token').addEventListener('click', () => {
    const i = $('#set-token');
    i.type = i.type === 'password' ? 'text' : 'password';
  });

  $('#upload-zone').addEventListener('click', (e) => {
    if (e.target.closest('input')) return;
    $('#file-input').click();
  });
  $('#file-input').addEventListener('change', (e) => {
    if (e.target.files?.length) uploadFiles(e.target.files);
  });
  setupFileDrop();

  $('#btn-save-file').addEventListener('click', saveCurrentFile);
  $('#btn-delete-file')?.addEventListener('click', deleteCurrentFile);
  $('#file-editor').addEventListener('input', () => { editorDirty = true; });
  $('#files-up').addEventListener('click', () => {
    if (!currentDir) return;
    currentDir = currentDir.split('/').slice(0, -1).join('/');
    loadFiles();
  });

  $('#btn-clear-logs').addEventListener('click', clearLogs);
  $('#btn-refresh-logs').addEventListener('click', () => loadLogs(true));
  $('#btn-join-session')?.addEventListener('click', joinSession);
  $('#session-join-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinSession();
  });
}

async function joinSession() {
  const input = $('#session-join-input');
  const code = input?.value.trim();
  if (!code) return showToast('Entre un code session', 'error');

  try {
    const r = await api('/api/vm/session/join', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    showToast(`Session rejointe — ${r.name}`);
    if (input) input.value = '';
    await loadProjects(true);
    selectProject(r.projectId);
    switchTab('vps');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function setupFileDrop() {
  const zone = $('#upload-zone');
  const tab = $('#tab-files');
  if (!zone) return;

  let dragDepth = 0;

  const prevent = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  for (const evt of ['dragenter', 'dragover', 'dragleave', 'drop']) {
    zone.addEventListener(evt, prevent);
    tab?.addEventListener(evt, prevent);
  }

  zone.addEventListener('dragenter', () => {
    dragDepth += 1;
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) zone.classList.remove('dragover');
  });

  zone.addEventListener('drop', (e) => {
    dragDepth = 0;
    zone.classList.remove('dragover');
    const files = e.dataTransfer?.files;
    if (!files?.length) return showToast('Aucun fichier détecté', 'error');
    uploadFiles(files);
  });

  tab?.addEventListener('drop', (e) => {
    const files = e.dataTransfer?.files;
    if (!files?.length) return;
    uploadFiles(files);
  });
}

// ─── Polling optimisé ───
function startSmartPolling() {
  stopPolling();
  if (document.hidden) return;

  pollTimer = setInterval(async () => {
    if (isPolling || !activeProject) return;
    isPolling = true;

    try {
      if (activeTab === 'console') {
        await loadLogs(false);
      } else if (activeProject.status === 'online' || activeProject.status === 'starting') {
        await refreshStatus();
      }
    } finally {
      isPolling = false;
    }
  }, 8000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function openNewModal() {
  $('#new-project-modal').classList.remove('hidden');
  $('#new-project-name').focus();
}

function closeNewModal() {
  $('#new-project-modal').classList.add('hidden');
  $('#new-project-error').classList.add('hidden');
  $('#new-project-name').value = '';
}

async function loadProjects(autoSelect = true) {
  if (isFetching) return;
  isFetching = true;
  try {
    projects = await api('/api/projects');
    if (projects.length === 0) {
      const cached = loadCachedProjects();
      if (cached.length) projects = cached;
    } else {
      cacheProjects(projects);
    }
    renderProjectList();

    if (projects.length === 0) {
      activeProject = null;
      showEmpty();
    } else if (autoSelect) {
      const target = activeProject?.id && projects.find((p) => p.id === activeProject.id)
        ? activeProject.id : projects[0].id;
      await selectProject(target, false);
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    isFetching = false;
  }
}

function renderProjectList() {
  const list = $('#project-list');
  if (projects.length === 0) {
    list.innerHTML = '<div class="no-projects">Aucun projet</div>';
    return;
  }

  const currentId = activeProject?.id;
  list.innerHTML = projects.map((p) => `
    <button class="project-item ${currentId === p.id ? 'active' : ''}" data-id="${p.id}">
      <span class="project-dot ${p.status}"></span>
      <span class="project-item-name">${escapeHtml(p.name)}${p.isShared ? ' <span class="shared-tag">session</span>' : ''}</span>
    </button>
  `).join('');

  list.querySelectorAll('.project-item').forEach((el) => {
    el.addEventListener('click', () => selectProject(el.dataset.id));
  });
}

function showEmpty() {
  stopPolling();
  $('#empty-panel').classList.remove('hidden');
  $('#workspace').classList.add('hidden');
}

function showWorkspace() {
  $('#empty-panel').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  updateWorkspaceActions();
  startSmartPolling();
}

function updateWorkspaceActions() {
  const isShared = activeProject?.isShared;
  $('#btn-delete')?.classList.toggle('hidden', Boolean(isShared));
}

async function selectProject(id, fullLoad = true) {
  if (activeProject?.id === id && !fullLoad) return;

  disconnectVm?.();

  activeProject = projects.find((p) => p.id === id);
  if (!activeProject) return;

  showWorkspace();
  renderProjectList();
  lastLogTime = null;
  lastLogCount = 0;

  try {
    if (fullLoad) {
      const detail = await api(`/api/projects/${id}`);
      activeProject = { ...activeProject, ...detail };
      updateWorkspaceActions();
      populateSettings();
    }
    updateHeader();
    updateOverview();
    loadTabContent(activeTab);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function refreshStatus() {
  if (!activeProject || isFetching) return;

  const data = await api(`/api/projects/${activeProject.id}/status`);
  if (activeProject.status === data.status && activeProject.error === data.error) return;

  activeProject.status = data.status;
  activeProject.error = data.error;
  activeProject.pid = data.pid;

  const idx = projects.findIndex((p) => p.id === activeProject.id);
  if (idx >= 0) projects[idx].status = data.status;

  updateHeader();
  updateProjectDot(activeProject.id, data.status);
}

function updateProjectDot(id, status) {
  const dot = document.querySelector(`.project-item[data-id="${id}"] .project-dot`);
  if (dot) dot.className = `project-dot ${status}`;
}

function updateHeader() {
  if (!activeProject) return;
  $('#project-name').textContent = activeProject.name;
  const badge = $('#project-status');
  badge.textContent = statusLabel(activeProject.status);
  badge.className = `status-badge ${activeProject.status}`;
}

function statusLabel(s) {
  return { online: 'En ligne', offline: 'Hors ligne', error: 'Erreur', starting: 'Démarrage...' }[s] || s;
}

function updateOverview() {
  if (!activeProject) return;
  $('#m-runtime').textContent = activeProject.runtime === 'python' ? 'Python' : 'Node.js';
  $('#m-start').textContent = activeProject.startFile || '—';
  $('#m-files').textContent = activeProject.fileCount ?? '—';
  $('#m-host').textContent = activeProject.hostLabel || (activeProject.hostMode === 'local' ? 'Local (ton PC)' : 'VPS Cloud');
  $('#m-size').textContent = activeProject.workspaceSize != null ? formatBytes(activeProject.workspaceSize) : '—';
}

function switchTab(name) {
  activeTab = name;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-content').forEach((c) => c.classList.toggle('active', c.id === `tab-${name}`));
  loadTabContent(name);
  startSmartPolling();
}

function loadTabContent(name) {
  if (!activeProject) return;
  if (name === 'console') loadLogs(true);
  else if (name === 'files') loadFiles();
  else if (name === 'settings') populateSettings();
  else if (name === 'overview') refreshOverviewStats();
  else if (name === 'vps') loadVmTab();
}

async function refreshOverviewStats() {
  if (!activeProject) return;
  try {
    const detail = await api(`/api/projects/${activeProject.id}`);
    activeProject.fileCount = detail.fileCount;
    activeProject.workspaceSize = detail.workspaceSize;
    activeProject.hostMode = detail.hostMode;
    activeProject.hostLabel = detail.hostLabel;
    updateOverview();
  } catch { /* ignore */ }
}

async function createProject(e) {
  e.preventDefault();
  const errEl = $('#new-project-error');
  errEl.classList.add('hidden');

  try {
    const bot = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: $('#new-project-name').value.trim() }),
    });
    closeNewModal();
    projects.push(bot);
    cacheProjects(projects);
    renderProjectList();
    await selectProject(bot.id);
    showToast('Projet créé');
    switchTab('files');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

async function projectAction(action) {
  if (!activeProject) return;

  const btn = $(`#btn-${action}`);
  if (btn) btn.disabled = true;

  try {
    const result = await api(`/api/projects/${activeProject.id}/${action}`, { method: 'POST' });
    Object.assign(activeProject, result);
    updateHeader();
    renderProjectList();
    if (action === 'stop') {
      await refreshStatus();
    } else if (action !== 'stop') {
      loadLogs(true);
    }
    showToast(action === 'start' ? 'Bot démarré' : action === 'stop' ? 'Bot arrêté' : 'Bot redémarré');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteProject() {
  if (!activeProject) return;
  if (!confirm(`Supprimer "${activeProject.name}" et tous ses fichiers ?`)) return;

  try {
    await api(`/api/projects/${activeProject.id}`, { method: 'DELETE' });
    const deletedId = activeProject.id;
    activeProject = null;
    projects = projects.filter((p) => p.id !== deletedId);
    renderProjectList();
    showToast('Projet supprimé');
    if (projects.length === 0) showEmpty();
    else await selectProject(projects[0].id);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Settings ───
function populateSettings() {
  if (!activeProject) return;
  $('#set-name').value = activeProject.name || '';
  $('#set-runtime').value = activeProject.runtime || 'nodejs';
  $('#set-hostmode').value = activeProject.hostMode || 'cloud';
  $('#set-autostart').checked = activeProject.autoStart || false;

  const startSelect = $('#set-startfile');
  const files = activeProject.startFiles || [activeProject.startFile || 'index.js'];
  startSelect.innerHTML = files.map((f) =>
    `<option value="${escapeHtml(f)}" ${f === activeProject.startFile ? 'selected' : ''}>${escapeHtml(f)}</option>`
  ).join('');

  $('#set-token').value = '';
  $('#set-token').placeholder = activeProject.hasToken ? '•••••••••••• (laisser vide pour garder)' : 'Token Discord';

  const envEditor = $('#env-editor');
  envEditor.innerHTML = '';
  const env = activeProject.env || {};
  const keys = Object.keys(env);
  if (keys.length === 0) addEnvRow('', '');
  else keys.forEach((k) => addEnvRow(k, env[k]));
}

function addEnvRow(key = '', val = '') {
  const row = document.createElement('div');
  row.className = 'env-row';
  row.innerHTML = `
    <input type="text" class="env-key" placeholder="CLÉ" value="${escapeHtml(key)}" />
    <input type="text" class="env-val" placeholder="valeur" value="${escapeHtml(val)}" />
    <button type="button" class="env-remove">×</button>`;
  row.querySelector('.env-remove').addEventListener('click', () => row.remove());
  $('#env-editor').appendChild(row);
}

async function saveSettings(e) {
  e.preventDefault();
  const okEl = $('#settings-success');
  const errEl = $('#settings-error');
  okEl.classList.add('hidden');
  errEl.classList.add('hidden');

  const env = {};
  $$('.env-row').forEach((row) => {
    const k = row.querySelector('.env-key').value.trim();
    const v = row.querySelector('.env-val').value;
    if (k) env[k] = v;
  });

  const body = {
    name: $('#set-name').value.trim(),
    runtime: $('#set-runtime').value,
    startFile: $('#set-startfile').value,
    env,
    autoStart: $('#set-autostart').checked,
    hostMode: $('#set-hostmode').value,
  };

  const token = $('#set-token').value.trim();
  if (token) body.token = token;

  try {
    const updated = await api(`/api/projects/${activeProject.id}/settings`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    Object.assign(activeProject, updated);
    okEl.classList.remove('hidden');
    showToast('Paramètres sauvegardés');
    updateHeader();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

// ─── Files ───
async function loadFiles() {
  if (!activeProject) return;
  try {
    const data = await api(`/api/projects/${activeProject.id}/files?dir=${encodeURIComponent(currentDir)}`);
    $('#files-path').textContent = '/' + (currentDir || '');
    renderFileList(data.files);

    if (data.startFiles?.length) {
      activeProject.startFiles = data.startFiles;
      const startSelect = $('#set-startfile');
      if (startSelect) {
        const current = activeProject.startFile;
        startSelect.innerHTML = data.startFiles.map((f) =>
          `<option value="${escapeHtml(f)}" ${f === current ? 'selected' : ''}>${escapeHtml(f)}</option>`
        ).join('');
      }
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderFileList(files) {
  const list = $('#file-list');
  if (!files.length) {
    list.innerHTML = '<div class="file-empty">Dossier vide — upload tes fichiers</div>';
    return;
  }

  list.innerHTML = files.map((f) => `
    <div class="file-item ${f.type}" data-path="${escapeHtml(f.path)}" data-type="${f.type}">
      <span class="file-icon">${f.type === 'folder' ? '📁' : '📄'}</span>
      <span class="file-name">${escapeHtml(f.name)}</span>
      ${f.size != null ? `<span class="file-size">${formatBytes(f.size)}</span>` : ''}
    </div>
  `).join('');

  list.querySelectorAll('.file-item').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.dataset.type === 'folder') {
        currentDir = el.dataset.path;
        loadFiles();
      } else {
        openFile(el.dataset.path);
      }
    });
  });
}

async function openFile(filePath) {
  if (editorDirty && !confirm('Modifications non sauvegardées. Continuer ?')) return;

  try {
    const data = await api(`/api/projects/${activeProject.id}/files/content?path=${encodeURIComponent(filePath)}`);
    currentFilePath = filePath;
    $('#editor-filename').textContent = filePath;
    $('#file-editor').value = data.content;
    $('#btn-save-file').classList.remove('hidden');
    $('#btn-delete-file')?.classList.remove('hidden');
    editorDirty = false;
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function saveCurrentFile() {
  if (!currentFilePath) return;
  try {
    await api(`/api/projects/${activeProject.id}/files/content`, {
      method: 'PUT',
      body: JSON.stringify({ path: currentFilePath, content: $('#file-editor').value }),
    });
    editorDirty = false;
    showToast('Fichier sauvegardé');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteCurrentFile() {
  if (!currentFilePath || !activeProject) return;
  if (!confirm(`Supprimer "${currentFilePath}" ?`)) return;

  try {
    await api(`/api/projects/${activeProject.id}/files?path=${encodeURIComponent(currentFilePath)}`, {
      method: 'DELETE',
    });
    currentFilePath = '';
    editorDirty = false;
    $('#editor-filename').textContent = 'Sélectionne un fichier';
    $('#file-editor').value = '';
    $('#btn-save-file').classList.add('hidden');
    $('#btn-delete-file')?.classList.add('hidden');
    showToast('Fichier supprimé');
    loadFiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function uploadFiles(fileList) {
  if (!activeProject) return showToast('Sélectionne un projet d\'abord', 'error');
  if (!fileList?.length) return showToast('Aucun fichier', 'error');

  const zone = $('#upload-zone');
  const inner = zone?.querySelector('.upload-zone-inner');
  zone?.classList.add('uploading');
  if (inner) inner.innerHTML = '<span>Upload en cours...</span>';

  try {
    for (const file of fileList) {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const result = await api(`/api/projects/${activeProject.id}/upload`, { method: 'POST', body: fd });
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.zip') || lower.endsWith('.rar')) {
        showToast(result.message || 'Archive extraite', 'success');
        if (result.startFile) activeProject.startFile = result.startFile;
      } else {
        showToast(`${file.name} uploadé`);
      }
    }
    if (activeTab === 'files') loadFiles();
    if (activeTab === 'overview') refreshOverviewStats();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    zone?.classList.remove('uploading');
    if (inner) {
      inner.innerHTML = '<span>📁 Glisse tes fichiers ici</span><span class="upload-hint">ou clique pour parcourir · ZIP & RAR supportés</span>';
    }
    const input = $('#file-input');
    if (input) input.value = '';
  }
}

// ─── Console (incremental) ───
function appendLogLines(lines) {
  const output = $('#console-output');
  if (output.querySelector('.log-line.muted')) output.innerHTML = '';

  const frag = document.createDocumentFragment();
  for (const l of lines) {
    const div = document.createElement('div');
    div.className = `log-line ${l.level}`;
    div.innerHTML = `<span class="log-time">${formatTime(l.time)}</span>${escapeHtml(l.message)}`;
    frag.appendChild(div);
  }
  output.appendChild(frag);

  while (output.childNodes.length > 300) {
    output.removeChild(output.firstChild);
  }
  output.scrollTop = output.scrollHeight;
}

async function loadLogs(full = false) {
  if (!activeProject) return;

  const url = full || !lastLogTime
    ? `/api/projects/${activeProject.id}/logs`
    : `/api/projects/${activeProject.id}/logs?since=${encodeURIComponent(lastLogTime)}`;

  try {
    const data = await api(url);
    const logs = data.logs || data;

    if (!logs.length && full) {
      $('#console-output').innerHTML = '<div class="log-line muted">Aucun log — démarre ton bot pour voir la sortie</div>';
      lastLogTime = null;
      lastLogCount = 0;
      return;
    }

    if (full) {
      $('#console-output').innerHTML = '';
      lastLogTime = null;
    }

    if (logs.length) {
      appendLogLines(logs);
      lastLogTime = logs[logs.length - 1].time;
      lastLogCount = data.total ?? logs.length;
    }
  } catch { /* ignore */ }
}

async function clearLogs() {
  if (!activeProject) return;
  await api(`/api/projects/${activeProject.id}/logs`, { method: 'DELETE' });
  lastLogTime = null;
  lastLogCount = 0;
  $('#console-output').innerHTML = '<div class="log-line muted">Logs effacés</div>';
}

init();
