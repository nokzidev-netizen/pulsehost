const ACCESS_TOKEN_KEY = 'pulsehost_access_token';

function getAccessToken() {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

function setAccessToken(token) {
  if (token) localStorage.setItem(ACCESS_TOKEN_KEY, token);
  else localStorage.removeItem(ACCESS_TOKEN_KEY);
}

function showAccessGate() {
  return new Promise((resolve) => {
    const overlay = document.getElementById('access-gate');
    if (!overlay) {
      resolve(true);
      return;
    }

    overlay.classList.remove('hidden');
    document.body.classList.add('access-locked');

    const form = document.getElementById('access-gate-form');
    const input = document.getElementById('access-code-input');
    const err = document.getElementById('access-gate-error');
    const btn = document.getElementById('access-gate-submit');

    const onSubmit = async (e) => {
      e.preventDefault();
      err?.classList.add('hidden');
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
          body: JSON.stringify({ code: input?.value || '' }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Code incorrect');

        setAccessToken(data.token);
        hideAccessGate();
        resolve(true);
      } catch (ex) {
        if (err) {
          err.textContent = ex.message;
          err.classList.remove('hidden');
        }
        resolve(false);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Entrer';
        }
      }
    };

    if (form) form.onsubmit = onSubmit;
    input?.focus();
  });
}

function hideAccessGate() {
  document.getElementById('access-gate')?.classList.add('hidden');
  document.body.classList.remove('access-locked');
}

async function ensureSiteAccess() {
  try {
    const res = await fetch('/api/access/status', {
      headers: { 'X-Access-Token': getAccessToken() || '' },
    });
    const data = await res.json();
    if (!data.required || data.granted) {
      hideAccessGate();
      return true;
    }
  } catch {
    /* afficher le gate */
  }

  setAccessToken(null);

  let ok = false;
  while (!ok) {
    ok = await showAccessGate();
    if (!ok) await new Promise((r) => setTimeout(r, 300));
  }

  return true;
}

function lockSiteAccess() {
  setAccessToken(null);
  return ensureSiteAccess();
}

window.ensureSiteAccess = ensureSiteAccess;
window.lockSiteAccess = lockSiteAccess;
window.hideAccessGate = hideAccessGate;

document.addEventListener('DOMContentLoaded', () => {
  ensureSiteAccess().catch(() => showAccessGate());
});
