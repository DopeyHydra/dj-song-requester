'use strict';
/* Gästeseite */

const $ = (id) => document.getElementById(id);
const state = {
  slug: decodeURIComponent(location.pathname.split('/')[1] || '').toLowerCase(),
  tab: 'open', items: [], config: null, busy: new Set(), gone: false,
};
const base = () => `/api/e/${encodeURIComponent(state.slug)}`;

// Event wurde gelöscht oder existiert nicht
function showGone() {
  if (state.gone) return;
  state.gone = true;
  document.querySelectorAll('[data-live]').forEach((n) => n.classList.add('hidden'));
  $('goneNotice').classList.remove('hidden');
  $('eventName').textContent = 'Event beendet';
  document.title = 'DJ Song Requester';
}

// Admin hat den Unterlink geändert → Adresse anpassen, ohne neu zu laden
function onConfigPush(data) {
  if (data && data.slug && data.slug !== state.slug) {
    state.slug = data.slug;
    history.replaceState(null, '', `/${data.slug}`);
    live.connect(`${base()}/stream`);
  }
  loadConfig();
}

async function loadConfig() {
  if (state.gone) return;
  try {
    state.config = await api(base());
    $('eventName').textContent = state.config.eventName;
    document.title = `${state.config.eventName} · Song-Wünsche`;
    $('closedNotice').classList.toggle('hidden', state.config.requestsOpen);
    $('demoNotice').classList.toggle('hidden', !state.config.demoMode);
    $('searchSection').classList.toggle('hidden', !state.config.requestsOpen || !state.config.searchAvailable);
  } catch (e) {
    if (e.status === 404) showGone();
  }
}

async function loadList() {
  if (state.gone) return;
  try {
    const data = await api(`${base()}/requests`);
    state.items = data.items;
    renderList();
  } catch (e) {
    if (e.status === 404) return showGone();
    if (!state.items.length) $('list').replaceChildren(el('div', { class: 'empty' }, 'Liste konnte nicht geladen werden.'));
  }
}

function likeButton(s) {
  const heart = svgIcon(ICONS.heart, { fill: s.mine ? 'currentColor' : 'none' });
  if (s.played) {
    return el('span', { class: 'like static', title: `${s.votes} Stimmen` }, heart, String(s.votes));
  }
  if (s.requestedByMe) {
    return el('span', { class: 'like on static', title: 'Von dir gewünscht' }, heart, String(s.votes));
  }
  return el('button', {
    class: `like ${s.likedByMe ? 'on' : ''}`,
    type: 'button',
    'aria-pressed': s.likedByMe ? 'true' : 'false',
    'aria-label': s.likedByMe ? 'Like entfernen' : 'Liken',
    disabled: state.busy.has(s.id),
    onclick: () => toggleLike(s),
  }, heart, String(s.votes));
}

function renderList() {
  const open = state.items.filter((s) => !s.played);
  const played = state.items.filter((s) => s.played)
    .sort((a, b) => String(b.playedAt).localeCompare(String(a.playedAt)));
  $('countOpen').textContent = open.length ? `(${open.length})` : '';
  $('countPlayed').textContent = played.length ? `(${played.length})` : '';

  const items = state.tab === 'open' ? open : played;
  if (!items.length) {
    $('list').replaceChildren(el('div', { class: 'empty' },
      state.tab === 'open' ? 'Noch keine Wünsche – such oben nach deinem Lieblingssong!' : 'Noch nichts gespielt.'));
    return;
  }
  $('list').replaceChildren(...items.map((s, i) => el('div', { class: `song ${s.played ? 'played' : ''}` },
    state.tab === 'open' ? el('div', { class: 'rank' }, String(i + 1)) : null,
    cover(s.imageUrl),
    el('div', { class: 'meta' },
      el('div', { class: 'title' }, s.title, s.explicit ? el('span', { class: 'tag' }, 'E') : null),
      el('div', { class: 'artist' }, s.artists)),
    el('div', { class: 'actions' },
      s.played ? el('span', { class: 'badge' }, svgIcon(ICONS.check), 'Gespielt') : null,
      likeButton(s)),
  )));
}

async function toggleLike(s) {
  state.busy.add(s.id);
  // Optimistisches Update
  const wasLiked = s.likedByMe;
  s.likedByMe = !wasLiked; s.mine = !wasLiked; s.votes += wasLiked ? -1 : 1;
  renderList();
  try {
    await api(`${base()}/requests/${s.id}/like`, { method: wasLiked ? 'DELETE' : 'POST', body: {} });
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.busy.delete(s.id);
    loadList();
  }
}

// ---------- Suche ----------
let searchTimer, searchSeq = 0;
const q = $('q');

q.addEventListener('input', () => {
  $('clear').classList.toggle('hidden', !q.value);
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 300);
});
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(); q.blur(); }
  if (e.key === 'Escape') clearSearch();
});
$('clear').addEventListener('click', () => { clearSearch(); q.focus(); });

function clearSearch() {
  q.value = '';
  $('clear').classList.add('hidden');
  $('results').classList.add('hidden');
  $('results').replaceChildren();
}

async function runSearch() {
  const term = q.value.trim();
  const box = $('results');
  if (term.length < 2) { box.classList.add('hidden'); return; }
  const seq = ++searchSeq;
  box.classList.remove('hidden');
  box.replaceChildren(el('div', { class: 'empty' }, 'Suche …'));
  try {
    const data = await api(`${base()}/search?q=${encodeURIComponent(term)}`);
    if (seq !== searchSeq) return;
    renderResults(data.items);
  } catch (e) {
    if (seq !== searchSeq) return;
    box.replaceChildren(el('div', { class: 'empty' }, e.message));
  }
}

function resultAction(t) {
  const ex = t.existing;
  if (ex && ex.played) return el('span', { class: 'badge' }, svgIcon(ICONS.check), 'Schon gespielt');
  if (ex && ex.mine) return el('span', { class: 'badge mine' }, svgIcon(ICONS.check), 'Dabei');
  return el('button', {
    class: 'btn primary small', type: 'button',
    onclick: (ev) => requestSong(t, ev.currentTarget),
  }, ex ? svgIcon(ICONS.heart) : svgIcon(ICONS.plus), ex ? `+1 (${ex.votes})` : 'Wünschen');
}

function renderResults(items) {
  const box = $('results');
  if (!items.length) { box.replaceChildren(el('div', { class: 'empty' }, 'Nichts gefunden.')); return; }
  box.replaceChildren(...items.map((t) => el('div', { class: 'song' },
    cover(t.imageUrl),
    el('div', { class: 'meta' },
      el('div', { class: 'title' }, t.title, t.explicit ? el('span', { class: 'tag' }, 'E') : null),
      el('div', { class: 'artist' }, [t.artists, fmtDuration(t.durationMs)].filter(Boolean).join(' · '))),
    el('div', { class: 'actions' }, resultAction(t)),
  )));
}

async function requestSong(t, btn) {
  btn.disabled = true;
  try {
    const r = await api(`${base()}/requests`, { method: 'POST', body: { spotifyId: t.spotifyId } });
    toast(r.status === 'created' ? `„${t.title}“ ist auf der Wunschliste! 🎶`
      : r.status === 'voted' ? `Deine Stimme für „${t.title}“ zählt! ♥` : 'Den hast du schon gewünscht.', 'success');
    clearSearch();
    state.tab = 'open';
    setTabs();
    await loadList();
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false;
  }
}

// ---------- Tabs ----------
function setTabs() {
  document.querySelectorAll('.tab').forEach((b) => {
    const active = b.dataset.tab === state.tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
}
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
  state.tab = b.dataset.tab; setTabs(); renderList();
}));

// ---------- Start ----------
loadConfig();
loadList();
const live = liveUpdates({ url: `${base()}/stream`, onChange: loadList, onConfig: onConfigPush, onDeleted: showGone });
