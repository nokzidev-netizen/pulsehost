const ACCESS_TOKEN_KEY = 'pulsehost_access_token';

let accessPromise = null;
let pendingResolve = null;
let submitting = false;

function storageGet(key) {
  try {
    const v = localStorage.getItem(key);
    if (v) return v;
  } catch { /* ignore */ }
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, val) {
  let ok = false;
  try {
    localStorage.setItem(key, val);
    ok = true;
  } catch { /* ignore */ }
  try {
    sessionStorage.setItem(key, val);
    ok = true;
  } catch { /* ignore */ }
  if (!ok) throw new Error('Stockage navigateur bloqué — désactive le mode strict / cookies');
}

function storageClear(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
  try { sessionStorage.removeItem(key); } catch { /* ignore */ }
}

function getAccessToken() {
  return storageGet(ACCESS_TOKEN_KEY);
}

function setAccessToken(token) {
  if (token) storageSet(ACCESS_TOKEN_KEY, token);
  else storageClear(ACCESS_TOKEN_KEY);
}

function setHint(msg) {
  const hint = document.getElementById('access-gate-hint');
  if (hint) hint.textContent = msg;
}

function hideAccessGate() {
  document.getElementById('access-gate')?.classList.add('hidden');
  document.body.classList.remove('access-locked');
}

function showAccessGateOverlay() {
  const overlay = document.getElementById('access-gate');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  document.body.classList.add('access-locked');
  document.getElementById('access-code-input')?.focus();
  setHint('Entre le code puis clique Entrer');
}

async function fetchAccessStatus() {
  const res = await fetch('/api/access/status', {
    headers: { 'X-Access-Token': getAccessToken() || '' },
  });
  return res.json();
}

async function isAccessGranted() {
  try {
    const data = await fetchAccessStatus();
    return !data.required || data.granted;
  } catch {
    return false;
  }
}

function completeAccessFlow() {
  hideAccessGate();
  setHint('Accès autorisé ✓');
  window.dispatchEvent(new Event('pulsehost-access-granted'));
  if (pendingResolve) {
    const done = pendingResolve;
    pendingResolve = null;
    done(true);
  }
}

async function submitAccessCode(e) {
  if (e) e.preventDefault();
  if (submitting) return;
  submitting = true;

  const input = document.getElementById('access-code-input');
  const err = document.getElementById('access-gate-error');
  const btn = document.getElementById('access-gate-submit');
  const code = (input?.value || '').trim();

  if (!code) {
    if (err) {
      err.textContent = 'Entre un code';
      err.style.display = 'block';
    }
    submitting = false;
    return;
  }

  if (err) err.style.display = 'none';
  setHint('Vérification en cours...');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Vérification...';
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (typeof getClientId === 'function') headers['X-Client-Id'] = getClientId();

    const res = await fetch('/api/access/verify', {
      method: 'POST',
      headers,
      body: JSON.stringify({ code }),
    });

    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }

    if (!res.ok) {
      throw new Error(data.error || `Erreur ${res.status}`);
    }

    if (!data.token) {
      throw new Error('Réponse serveur invalide');
    }

    setAccessToken(data.token);

    if (await isAccessGranted()) {
      completeAccessFlow();
      return;
    }

    throw new Error('Code OK mais session refusée — réessaie');
  } catch (ex) {
    setHint('Entre le code puis clique Entrer');
    if (err) {
      err.textContent = ex.message || 'Erreur de connexion';
      err.style.display = 'block';
    }
  } finally {
    submitting = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Entrer';
    }
  }
}

function bindAccessForm() {
  const form = document.getElementById('access-gate-form');
  const btn = document.getElementById('access-gate-submit');
  if (!form || form.dataset.bound === '1') return;
  form.dataset.bound = '1';
  form.addEventListener('submit', submitAccessCode);
  btn?.addEventListener('click', (e) => {
    e.preventDefault();
    submitAccessCode(e);
  });
}

async function runAccessCheck() {
  bindAccessForm();

  if (await isAccessGranted()) {
    hideAccessGate();
    return true;
  }

  showAccessGateOverlay();

  if (await isAccessGranted()) {
    hideAccessGate();
    return true;
  }

  await new Promise((resolve) => {
    pendingResolve = resolve;
  });

  return true;
}

function ensureSiteAccess() {
  if (!accessPromise) {
    accessPromise = runAccessCheck().catch((err) => {
      accessPromise = null;
      showAccessGateOverlay();
      bindAccessForm();
      setHint(err.message || 'Erreur — réessaie');
      throw err;
    });
  }
  return accessPromise;
}

function lockSiteAccess() {
  accessPromise = null;
  pendingResolve = null;
  storageClear(ACCESS_TOKEN_KEY);
  showAccessGateOverlay();
  bindAccessForm();
  accessPromise = runAccessCheck();
  return accessPromise;
}

window.ensureSiteAccess = ensureSiteAccess;
window.lockSiteAccess = lockSiteAccess;
window.submitAccessCode = submitAccessCode;

bindAccessForm();
ensureSiteAccess();
