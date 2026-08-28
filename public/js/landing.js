const modal = document.getElementById('auth-modal');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');

function openModal(tab = 'login') {
  modal.classList.remove('hidden');
  switchTab(tab);
}

function closeModal() {
  modal.classList.add('hidden');
  document.getElementById('login-error').classList.add('hidden');
  document.getElementById('register-error').classList.add('hidden');
}

function switchTab(tab) {
  document.querySelectorAll('.modal-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  loginForm.classList.toggle('hidden', tab !== 'login');
  registerForm.classList.toggle('hidden', tab !== 'register');
}

document.querySelectorAll('.modal-tab').forEach((t) => {
  t.addEventListener('click', () => switchTab(t.dataset.tab));
});

document.getElementById('modal-close').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

document.getElementById('btn-login').addEventListener('click', () => openModal('login'));
document.getElementById('btn-register').addEventListener('click', () => openModal('register'));
document.getElementById('hero-start').addEventListener('click', () => openModal('register'));
document.getElementById('cta-start').addEventListener('click', () => openModal('register'));
document.querySelectorAll('.pricing-cta').forEach((b) => b.addEventListener('click', () => openModal('register')));

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');

  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('login-user').value.trim(),
        password: document.getElementById('login-pass').value,
      }),
    });
    setToken(data.token);
    window.location.href = '/dashboard';
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('register-error');
  errEl.classList.add('hidden');

  try {
    const data = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: document.getElementById('reg-user').value.trim(),
        email: document.getElementById('reg-email').value.trim(),
        password: document.getElementById('reg-pass').value,
      }),
    });
    setToken(data.token);
    window.location.href = '/dashboard';
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
});

async function loadPublicStats() {
  try {
    const stats = await api('/api/stats');
    const el = document.getElementById('hero-bots');
    if (el) el.textContent = stats.online || 0;
  } catch { /* ignore */ }
}

if (getToken()) {
  api('/api/auth/me').then(() => {
    window.location.href = '/dashboard';
  }).catch(() => setToken(null));
}

loadPublicStats();
