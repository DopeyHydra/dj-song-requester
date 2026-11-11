'use strict';
/* Gemeinsame Helfer für Gäste- und Admin-Seite */

// DOM-Builder: setzt Text immer über textContent (kein HTML-Injection-Risiko)
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function svgIcon(paths, extra) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', (extra && extra.fill) || 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of [].concat(paths)) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
const ICONS = {
  heart: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z',
  check: 'M20 6 9 17l-5-5',
  plus: ['M12 5v14', 'M5 12h14'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  external: ['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
};

function cover(url) {
  return url
    ? el('img', { class: 'cover', src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
    : el('div', { class: 'cover ph', 'aria-hidden': 'true' }, '♪');
}

async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
  if (opts.body !== undefined && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch { /* leer */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Fehler ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, type) {
  const t = document.getElementById('toast');
  // Ein offener Dialog liegt in der obersten Ebene – Meldung dort anzeigen, sonst wäre sie verdeckt
  const host = document.querySelector('dialog[open]') || document.body;
  if (t.parentNode !== host) host.append(t);
  t.textContent = msg;
  t.className = `toast show ${type || ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
}

// Live-Updates per Server-Sent Events, mit Polling als Rückfallebene.
// Rückgabe: { connect(url) } – zum Wechseln des Streams (z. B. anderes Event).
function liveUpdates({ url, onChange, onConfig, onDeleted }) {
  let debounce, es = null;
  const trigger = () => { clearTimeout(debounce); debounce = setTimeout(onChange, 150); };
  const parse = (e) => { try { return JSON.parse(e.data || '{}'); } catch { return {}; } };

  function connect(nextUrl) {
    if (es) { es.close(); es = null; }
    if (!nextUrl) return;
    try {
      es = new EventSource(nextUrl);
      es.addEventListener('changed', trigger);
      es.addEventListener('config', (e) => { onConfig && onConfig(parse(e)); trigger(); });
      es.addEventListener('deleted', () => { onDeleted && onDeleted(); });
    } catch { /* Polling reicht als Rückfallebene */ }
  }

  connect(url);
  setInterval(onChange, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onChange(); });
  return { connect };
}

function fmtDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
