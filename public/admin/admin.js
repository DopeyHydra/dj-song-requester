'use strict';
/* Admin-Panel */

const $ = (id) => document.getElementById(id);
const state = {
  me: null, settings: null, events: [], currentId: null,
  tab: 'open', items: [], live: null,
};
const STORAGE_KEY = 'djsr.admin.event';
const current = () => state.events.find((e) => e.id === state.currentId) || null;
const evApi = (suffix = '') => `/api/admin/events/${state.currentId}${suffix}`;

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
  if (error) {
    params.delete('error');
    history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : ''));
  }
  try {
    state.me = await api('/api/admin/me');
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
  await loadSettings();
  if (!state.settings.spotifyConfigured && !state.settings.demoMode) {
    toast('Spotify ist nicht konfiguriert – Gäste können nicht suchen.', 'error');
  }
  if (!state.live) {
    state.live = liveUpdates({ url: null, onChange: refresh, onConfig: loadEvents, onDeleted: loadEvents });
  }
  await loadEvents({ initial: true });
}

// Bei abgelaufener Session zurück zum Login
async function adminApi(path, options) {
  try {
    return await api(path, options);
  } catch (e) {
    if (e.status === 401) location.reload();
    throw e;
  }
}

async function refresh() {
  await loadList();
}

// ---------- Einstellungen ----------
async function loadSettings() {
  state.settings = await adminApi('/api/admin/settings');
  const shortBase = state.settings.publicUrl.replace(/^https?:\/\//, '');
  document.querySelectorAll('[data-base]').forEach((n) => { n.textContent = shortBase; n.title = state.settings.publicUrl; });
}

$('btnSettings').addEventListener('click', () => {
  $('setPublicUrl').value = state.settings.publicUrlOverride;
  $('dlgSettings').showModal();
});

$('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await adminApi('/api/admin/settings', { method: 'PUT', body: { publicUrl: $('setPublicUrl').value } });
    await loadSettings();
    await loadEvents();
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

// ---------- Events ----------
function storedEventSlug() {
  const fromUrl = new URLSearchParams(location.search).get('event');
  if (fromUrl) return fromUrl;
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

async function loadEvents({ initial = false } = {}) {
  const data = await adminApi('/api/admin/events');
  state.events = data.items;

  const has = state.events.length > 0;
  $('noEvents').classList.toggle('hidden', has);
  $('eventContent').classList.toggle('hidden', !has);
  if (!has) {
    state.currentId = null;
    state.live.connect(null);
    $('eventName').textContent = 'DJ Song Requester';
    document.title = 'Admin · DJ Song Requester';
    renderEventList();
    return;
  }

  // Aktuelles Event bestimmen: bisherige Auswahl → gespeicherte → Startseite → neuestes
  let id = state.currentId && state.events.some((e) => e.id === state.currentId) ? state.currentId : null;
  if (!id && initial) {
    const slug = storedEventSlug();
    const match = state.events.find((e) => e.slug === slug);
    if (match) id = match.id;
  }
  if (!id) id = (state.events.find((e) => e.isStart) || state.events[0]).id;

  renderEventSelect();
  renderEventList();
  if (id !== state.currentId) selectEvent(id);
  else renderHeader();
}

function renderEventSelect() {
  $('eventSelect').replaceChildren(...state.events.map((e) =>
    el('option', { value: String(e.id), selected: e.id === state.currentId }, `${e.name}  (/${e.slug})`)));
}

function renderHeader() {
  const ev = current();
  if (!ev) return;
  $('eventSelect').value = String(ev.id);
  $('eventName').textContent = ev.name;
  document.title = `Admin · ${ev.name}`;
  $('requestsOpen').checked = ev.requestsOpen;
  $('requestsOpenLabel').textContent = ev.requestsOpen ? 'Wünsche offen' : 'Wünsche geschlossen';
  $('guestLink').href = `/${ev.slug}`;
  $('eventLink').replaceChildren(el('a', { href: ev.url, target: '_blank', rel: 'noopener' }, ev.url));
}

function selectEvent(id) {
  state.currentId = id;
  const ev = current();
  try { localStorage.setItem(STORAGE_KEY, ev.slug); } catch { /* egal */ }
  history.replaceState(null, '', `${location.pathname}?event=${encodeURIComponent(ev.slug)}`);
  state.items = [];
  $('list').replaceChildren(el('div', { class: 'empty' }, 'Lade …'));
  renderHeader();
  state.live.connect(evApi('/stream'));
  loadList();
}

$('eventSelect').addEventListener('change', (e) => selectEvent(Number(e.target.value)));

$('requestsOpen').addEventListener('change', async (e) => {
  try {
    await adminApi(evApi(), { method: 'PUT', body: { requestsOpen: e.target.checked } });
    await loadEvents();
  } catch (err) { toast(err.message, 'error'); }
});

// Unterlink aus dem Namen vorschlagen (gleiche Regeln wie auf dem Server)
function slugify(text) {
  return String(text || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 50).replace(/-+$/g, '');
}

// --- Dialog: alle Events ---
let slugTouched = false;
function openEventsDialog() {
  $('newEventForm').reset();
  slugTouched = false;
  renderEventList();
  $('dlgEvents').showModal();
  $('newName').focus();
}
$('btnEvents').addEventListener('click', openEventsDialog);
$('btnFirstEvent').addEventListener('click', openEventsDialog);

$('newName').addEventListener('input', () => { if (!slugTouched) $('newSlug').value = slugify($('newName').value); });
$('newSlug').addEventListener('input', () => {
  slugTouched = $('newSlug').value !== '';
  $('newSlug').value = $('newSlug').value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
});

$('newEventForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await adminApi('/api/admin/events', {
      method: 'POST', body: { name: $('newName').value, slug: $('newSlug').value },
    });
    if ($('newStart').checked) {
      await adminApi('/api/admin/settings', { method: 'PUT', body: { startEventId: r.event.id } });
    }
    toast(`Event „${r.event.name}“ angelegt.`, 'success');
    $('newEventForm').reset();
    slugTouched = false;
    await loadEvents();
    selectEvent(r.event.id);
    renderEventList();
  } catch (err) { toast(err.message, 'error'); }
});

function renderEventList() {
  const box = $('eventList');
  if (!state.events.length) {
    box.replaceChildren(el('p', { class: 'hint' }, 'Noch keine Events.'));
    return;
  }
  box.replaceChildren(...state.events.map((ev) => el('div', { class: 'event-row' },
    el('div', { class: 'meta' },
      el('div', { class: 'title' }, ev.name,
        ev.isStart ? el('span', { class: 'pill' }, 'Startseite') : null,
        !ev.requestsOpen ? el('span', { class: 'pill closed' }, 'geschlossen') : null),
      el('div', { class: 'event-link' }, `/${ev.slug} · ${ev.songs} Songs, ${ev.open} offen`)),
    el('div', { class: 'actions' },
      el('button', {
        class: 'btn small', type: 'button', disabled: ev.id === state.currentId,
        onclick: () => { selectEvent(ev.id); renderEventList(); $('dlgEvents').close(); },
      }, ev.id === state.currentId ? 'Ausgewählt' : 'Öffnen'),
      el('button', {
        class: 'icon-btn', type: 'button', title: 'Event löschen', 'aria-label': `Event ${ev.name} löschen`,
        onclick: () => deleteEvent(ev),
      }, svgIcon(ICONS.trash))),
  )));
}

async function deleteEvent(ev) {
  const songs = ev.songs ? ` und ${ev.songs} Song${ev.songs === 1 ? '' : 's'}` : '';
  if (!confirm(`Event „${ev.name}“ (/${ev.slug})${songs} endgültig löschen?\n\nDer Unterlink und QR-Code funktionieren danach nicht mehr.`)) return false;
  try {
    await adminApi(`/api/admin/events/${ev.id}`, { method: 'DELETE', body: {} });
    toast(`Event „${ev.name}“ gelöscht.`, 'success');
    if (ev.id === state.currentId) state.currentId = null;
    await loadEvents();
    return true;
  } catch (err) { toast(err.message, 'error'); return false; }
}

// --- Dialog: aktuelles Event bearbeiten ---
$('btnEditEvent').addEventListener('click', () => {
  const ev = current();
  if (!ev) return;
  $('editName').value = ev.name;
  $('editSlug').value = ev.slug;
  $('editStart').checked = ev.isStart;
  $('dlgEditEvent').showModal();
});
$('editSlug').addEventListener('input', () => {
  $('editSlug').value = $('editSlug').value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
});

$('editEventForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ev = current();
  const newSlug = $('editSlug').value.trim();
  if (newSlug !== ev.slug && !confirm(`Unterlink von /${ev.slug} auf /${newSlug} ändern?\n\nBereits gedruckte QR-Codes funktionieren dann nicht mehr.`)) return;
  try {
    await adminApi(evApi(), { method: 'PUT', body: { name: $('editName').value, slug: newSlug } });
    const wantStart = $('editStart').checked;
    if (wantStart !== ev.isStart) {
      await adminApi('/api/admin/settings', { method: 'PUT', body: { startEventId: wantStart ? ev.id : null } });
    }
    await loadEvents();
    selectEvent(ev.id); // aktualisiert Adresszeile und gespeicherten Unterlink
    toast('Gespeichert.', 'success');
    $('dlgEditEvent').close();
  } catch (err) { toast(err.message, 'error'); }
});

async function reset(scope, question) {
  if (!confirm(question)) return;
  try {
    await adminApi(evApi('/reset'), { method: 'POST', body: { scope } });
    toast('Erledigt.', 'success');
    loadList();
    loadEvents();
  } catch (err) { toast(err.message, 'error'); }
}
$('resetPlayed').addEventListener('click', () => reset('played', 'Alle gespielten Songs dieses Events löschen?'));
$('resetAll').addEventListener('click', () => reset('all', 'Wirklich ALLE Wünsche und Likes dieses Events löschen? Das kann nicht rückgängig gemacht werden.'));
$('deleteEvent').addEventListener('click', async () => {
  const ev = current();
  if (ev && await deleteEvent(ev)) $('dlgEditEvent').close();
});

// ---------- QR-Code ----------
function updateQrLinks() {
  const size = $('qrSize').value;
  $('qrImg').src = `${evApi('/qr')}?format=png&size=512&t=${Date.now()}`;
  $('qrPng').href = `${evApi('/qr')}?format=png&size=${size}&download=1`;
  $('qrSvg').href = `${evApi('/qr')}?format=svg&download=1`;
}
$('btnQr').addEventListener('click', async () => {
  await loadEvents();
  $('qrUrl').textContent = current().url;
  updateQrLinks();
  $('dlgQr').showModal();
});
$('qrSize').addEventListener('change', updateQrLinks);

document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

// ---------- Wunschliste ----------
async function loadList() {
  if (!state.currentId) return;
  const id = state.currentId;
  try {
    const data = await adminApi(evApi('/requests'));
    if (id !== state.currentId) return; // inzwischen anderes Event gewählt
    state.items = data.items;
    $('stOpen').textContent = data.stats.open;
    $('stPlayed').textContent = data.stats.played;
    $('stTotal').textContent = data.stats.total;
    $('stVotes').textContent = data.stats.votes;
    renderList();
  } catch (e) {
    if (e.status === 404) loadEvents(); // Event wurde woanders gelöscht
  }
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
