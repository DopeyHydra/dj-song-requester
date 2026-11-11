'use strict';
/* Admin-Panel */

const $ = (id) => document.getElementById(id);
const state = { tab: 'open', items: [], settings: null, started: false };

// ---------- Login ----------
const LOGIN_ERRORS = {
  forbidden: 'Dein Konto hat keine Berechtigung für das Admin-Panel.',
  state: 'Die Anmeldung ist abgelaufen oder wurde in einem anderen Browser gestartet. Bitte erneut versuchen.',
  token: 'Die Antwort des Anmeldedienstes war ungültig. Details stehen im Server-Log.',
  provider: 'Die Anmeldung wurde abgebrochen oder vom Anmeldedienst abgelehnt.',
  oidc_unavailable: 'Der Anmeldedienst ist gerade nicht erreichbar.',
};

async function init() {
  // Fehler aus dem SSO-Rücksprung anzeigen und aus der Adresszeile entfernen
  const params = new URLSearchParams(location.search);
  const error = params.get('error');
  if (error) history.replaceState(null, '', location.pathname);

  try {
    const me = await api('/api/admin/me');
    state.me = me;
    showPanel();
  } catch {
    await showLogin();
    if (error) $('loginError').textContent = LOGIN_ERRORS[error] || 'Anmeldung fehlgeschlagen.';
  }
}

async function showLogin() {
  $('panel').classList.add('hidden');
  $('loginView').classList.remove('hidden');
  let cfg = { password: true, oidc: false };
  try { cfg = await api('/api/admin/auth-config'); } catch { /* Standard verwenden */ }
  $('oidcBtn').textContent = cfg.oidcLabel || 'Mit SSO anmelden';
  $('oidcBtn').classList.toggle('hidden', !cfg.oidc);
  $('loginForm').classList.toggle('hidden', !cfg.password);
  $('loginDivider').classList.toggle('hidden', !(cfg.oidc && cfg.password));
  if (cfg.password && !cfg.oidc) $('username').focus();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: { username: $('username').value, password: $('password').value } });
    $('password').value = '';
    state.me = await api('/api/admin/me');
    showPanel();
  } catch (err) {
    $('loginError').textContent = err.message;
  }
});

$('btnLogout').addEventListener('click', async () => {
  const r = await api('/api/admin/logout', { method: 'POST', body: {} }).catch(() => null);
  // Bei SSO auch beim Identity Provider abmelden
  if (r && r.redirect) location.href = r.redirect;
  else location.reload();
});

async function showPanel() {
  $('loginView').classList.add('hidden');
  $('panel').classList.remove('hidden');
  $('whoami').textContent = state.me ? state.me.username : '';
  $('pwSection').classList.toggle('hidden', !(state.me && state.me.canChangePassword));
  await Promise.all([loadSettings(), loadList()]);
  if (!state.started) {
    state.started = true;
    liveUpdates(loadList, loadSettings);
  }
}

// Bei abgelaufener Session zurück zum Login
async function adminApi(path, options) {
  try {
    return await api(path, options);
  } catch (e) {
    if (e.status === 401) { location.reload(); }
    throw e;
  }
}

// ---------- Einstellungen ----------
async function loadSettings() {
  state.settings = await adminApi('/api/admin/settings');
  const s = state.settings;
  $('eventName').textContent = s.eventName;
  document.title = `Admin · ${s.eventName}`;
  $('requestsOpen').checked = s.requestsOpen;
  $('requestsOpenLabel').textContent = s.requestsOpen ? 'Wünsche offen' : 'Wünsche geschlossen';
  if (!s.spotifyConfigured && !s.demoMode) toast('Spotify ist nicht konfiguriert – Gäste können nicht suchen.', 'error');
}

$('requestsOpen').addEventListener('change', async (e) => {
  try {
    await adminApi('/api/admin/settings', { method: 'PUT', body: { requestsOpen: e.target.checked } });
    await loadSettings();
  } catch (err) { toast(err.message, 'error'); }
});

$('btnSettings').addEventListener('click', () => {
  $('setEventName').value = state.settings.eventName;
  $('setPublicUrl').value = state.settings.publicUrlOverride;
  $('dlgSettings').showModal();
});

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await adminApi('/api/admin/settings', {
      method: 'PUT', body: { eventName: $('setEventName').value, publicUrl: $('setPublicUrl').value },
    });
    await loadSettings();
    toast('Gespeichert.', 'success');
    $('dlgSettings').close();
  } catch (err) { toast(err.message, 'error'); }
});

$('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if ($('pwNew').value !== $('pwNew2').value) return toast('Die neuen Passwörter stimmen nicht überein.', 'error');
  try {
    await adminApi('/api/admin/password', {
      method: 'POST', body: { currentPassword: $('pwCurrent').value, newPassword: $('pwNew').value },
    });
    alert('Passwort geändert. Bitte neu anmelden.');
    location.reload();
  } catch (err) { if (err.status !== 401) toast(err.message, 'error'); }
});

async function reset(scope, question) {
  if (!confirm(question)) return;
  try {
    await adminApi('/api/admin/reset', { method: 'POST', body: { scope } });
    toast('Erledigt.', 'success');
    loadList();
  } catch (err) { toast(err.message, 'error'); }
}
$('resetPlayed').addEventListener('click', () => reset('played', 'Alle gespielten Songs aus der Liste löschen?'));
$('resetAll').addEventListener('click', () => reset('all', 'Wirklich ALLE Wünsche und Likes löschen? Das kann nicht rückgängig gemacht werden.'));

// ---------- QR-Code ----------
function updateQrLinks() {
  const size = $('qrSize').value;
  const bust = Date.now();
  $('qrImg').src = `/api/admin/qr?format=png&size=512&t=${bust}`;
  $('qrPng').href = `/api/admin/qr?format=png&size=${size}&download=1`;
  $('qrSvg').href = '/api/admin/qr?format=svg&download=1';
}
$('btnQr').addEventListener('click', async () => {
  await loadSettings();
  $('qrUrl').textContent = state.settings.publicUrl;
  updateQrLinks();
  $('dlgQr').showModal();
});
$('qrSize').addEventListener('change', updateQrLinks);

document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

// ---------- Liste ----------
async function loadList() {
  try {
    const data = await adminApi('/api/admin/requests');
    state.items = data.items;
    $('stOpen').textContent = data.stats.open;
    $('stPlayed').textContent = data.stats.played;
    $('stTotal').textContent = data.stats.total;
    $('stVotes').textContent = data.stats.votes;
    renderList();
  } catch { /* wird beim nächsten Update erneut versucht */ }
}

function timeAgo(sqlDate) {
  if (!sqlDate) return '';
  const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
  const min = Math.round((Date.now() - d) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
}

function renderList() {
  const open = state.items.filter((s) => !s.played);
  const played = state.items.filter((s) => s.played)
    .sort((a, b) => String(b.playedAt).localeCompare(String(a.playedAt)));
  $('cOpen').textContent = `(${open.length})`;
  $('cPlayed').textContent = `(${played.length})`;
  const items = state.tab === 'open' ? open : state.tab === 'played' ? played : state.items;

  if (!items.length) {
    $('list').replaceChildren(el('div', { class: 'empty' }, state.tab === 'open' ? 'Keine offenen Wünsche.' : 'Nichts hier.'));
    return;
  }
  $('list').replaceChildren(...items.map((s, i) => el('div', { class: `song admin-song ${s.played ? 'played' : ''}` },
    el('button', {
      class: `check ${s.played ? 'on' : ''}`, type: 'button',
      title: s.played ? 'Als nicht gespielt markieren' : 'Als gespielt abhaken',
      'aria-label': s.played ? 'Als nicht gespielt markieren' : 'Als gespielt abhaken',
      onclick: () => setPlayed(s, !s.played),
    }, svgIcon(ICONS.check)),
    state.tab !== 'played' && !s.played ? el('div', { class: 'rank hide-sm' }, String(i + 1)) : null,
    cover(s.imageUrl),
    el('div', { class: 'meta' },
      el('div', { class: 'title' }, s.title, s.explicit ? el('span', { class: 'tag' }, 'E') : null),
      el('div', { class: 'artist' }, [s.artists, fmtDuration(s.durationMs)].filter(Boolean).join(' · ')),
      el('div', { class: 'time' }, s.played ? `Gespielt ${timeAgo(s.playedAt)}` : `Gewünscht ${timeAgo(s.requestedAt)}`)),
    el('div', { class: `pop ${s.votes >= 3 ? 'hot' : ''}`, title: `${s.requestCount} Wünsche, ${s.likeCount} Likes` },
      el('div', { class: 'n' }, String(s.votes)),
      el('div', { class: 'd' }, `${s.requestCount}× gewünscht · ${s.likeCount} ♥`)),
    el('div', { class: 'actions' },
      s.spotifyUrl ? el('a', { class: 'icon-btn hide-sm', href: s.spotifyUrl, target: '_blank', rel: 'noopener', title: 'In Spotify öffnen', 'aria-label': 'In Spotify öffnen' }, svgIcon(ICONS.external)) : null,
      el('button', { class: 'icon-btn', type: 'button', title: 'Löschen', 'aria-label': 'Löschen', onclick: () => removeSong(s) }, svgIcon(ICONS.trash))),
  )));
}

async function setPlayed(s, played) {
  s.played = played;
  s.playedAt = played ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;
  renderList();
  try {
    await adminApi(`/api/admin/requests/${s.id}/played`, { method: 'POST', body: { played } });
  } catch (err) { toast(err.message, 'error'); }
  loadList();
}

async function removeSong(s) {
  if (!confirm(`„${s.title}“ aus der Liste löschen?`)) return;
  try {
    await adminApi(`/api/admin/requests/${s.id}`, { method: 'DELETE', body: {} });
    loadList();
  } catch (err) { toast(err.message, 'error'); }
}

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  state.tab = b.dataset.tab;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  renderList();
}));

init();
