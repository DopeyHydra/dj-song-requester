'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');

const { db, getSetting, setSetting, transaction } = require('./db');
const auth = require('./auth');
const spotify = require('./spotify');
const demo = require('./demo');
const oidc = require('./oidc');
const { slugify, slugError, SLUG_RE } = require('./slug');

const PORT = Number(process.env.PORT || 3000);
const DEMO_MODE = /^(1|true|yes)$/i.test(process.env.DEMO_MODE || '');
const REQUEST_LIMIT = Number(process.env.REQUEST_LIMIT_PER_GUEST || 5); // neue Wünsche pro Gast ...
const REQUEST_WINDOW_MIN = Number(process.env.REQUEST_LIMIT_WINDOW_MINUTES || 15); // ... pro Zeitfenster
const VISITOR_COOKIE = 'djsr_vid';

oidc.checkConfig();
const PASSWORD_LOGIN_WANTED = !/^(0|false|no)$/i.test(process.env.PASSWORD_LOGIN || 'true');
if (!PASSWORD_LOGIN_WANTED && !oidc.enabled) {
  console.error('[auth] PASSWORD_LOGIN=false geht nur zusammen mit OIDC (OIDC_ISSUER/OIDC_CLIENT_ID).');
  process.exit(1);
}
const PASSWORD_LOGIN = PASSWORD_LOGIN_WANTED && auth.ensureInitialAdmin({ oidcEnabled: oidc.enabled });
if (!PASSWORD_LOGIN) console.log('[auth] Passwort-Login ist deaktiviert.');
if (!spotify.isConfigured() && !DEMO_MODE) {
  console.warn('[spotify] SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET fehlen – die Songsuche ist deaktiviert.');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '10kb' }));

// ---- Sicherheits-Header ------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https://i.scdn.co https://*.scdn.co https://*.spotifycdn.com; " +
      "style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// ---- Cookies -----------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignorieren */ }
    }
  });
  return out;
}
function cookieSecure(req) {
  const v = (process.env.COOKIE_SECURE || 'auto').toLowerCase();
  return v === 'auto' ? req.secure : v === 'true';
}
function setCookie(req, res, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (cookieSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

app.use((req, res, next) => {
  req.cookies = parseCookies(req);
  let vid = req.cookies[VISITOR_COOKIE];
  if (!vid || !/^[A-Za-z0-9_-]{20,64}$/.test(vid)) {
    vid = crypto.randomBytes(18).toString('base64url');
    setCookie(req, res, VISITOR_COOKIE, vid, 60 * 60 * 24 * 365);
  }
  req.visitorId = vid;
  next();
});

// Schreibende Requests nur mit JSON (schützt zusammen mit SameSite gegen CSRF)
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'Content-Type muss application/json sein.' });
  }
  next();
});

// ---- Einfaches Rate-Limit -----------------------------------------------------
function rateLimit({ windowMs, max, key }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let e = hits.get(k);
    if (!e || e.reset < now) { e = { count: 0, reset: now + windowMs }; hits.set(k, e); }
    if (++e.count > max) return res.status(429).json({ error: 'Zu viele Anfragen – bitte kurz warten.' });
    next();
  };
}
const searchLimiter = rateLimit({ windowMs: 60_000, max: 40, key: (r) => r.ip });
const writeLimiter = rateLimit({ windowMs: 60_000, max: 60, key: (r) => r.ip });

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- Live-Updates (Server-Sent Events), getrennt pro Event --------------------
const sseClients = new Map(); // eventId -> Set<res>
function broadcast(eventId, type = 'changed', data = {}) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients.get(eventId) || []) res.write(msg);
}
function openStream(req, res, eventId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  if (!sseClients.has(eventId)) sseClients.set(eventId, new Set());
  const set = sseClients.get(eventId);
  set.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    set.delete(res);
    if (!set.size) sseClients.delete(eventId);
  });
}

// ---- Events ------------------------------------------------------------------
const eventCols = 'id, slug, name, requests_open AS requestsOpen, created_at AS createdAt';
const mapEvent = (e) => (e ? { ...e, requestsOpen: Boolean(e.requestsOpen) } : null);
const getEventBySlug = (slug) => mapEvent(db.prepare(`SELECT ${eventCols} FROM events WHERE slug = ?`).get(slug));
const getEventById = (id) => mapEvent(db.prepare(`SELECT ${eventCols} FROM events WHERE id = ?`).get(Number(id)));

function startEventId() {
  const id = Number(getSetting('startEventId'));
  return id && getEventById(id) ? id : null;
}

// ---- Songs -------------------------------------------------------------------
const songListSql = `
  SELECT s.id, s.spotify_id AS spotifyId, s.title, s.artists, s.album, s.image_url AS imageUrl,
         s.spotify_url AS spotifyUrl, s.duration_ms AS durationMs, s.explicit, s.played,
         s.requested_at AS requestedAt, s.played_at AS playedAt,
         COUNT(v.visitor_id) AS votes,
         SUM(v.kind = 'request') AS requestCount,
         SUM(v.kind = 'like') AS likeCount,
         MAX(v.visitor_id = :vid) AS mine,
         MAX(v.visitor_id = :vid AND v.kind = 'like') AS likedByMe,
         MAX(v.visitor_id = :vid AND v.kind = 'request') AS requestedByMe
  FROM songs s LEFT JOIN votes v ON v.song_id = s.id
  WHERE s.event_id = :eid
  GROUP BY s.id
  ORDER BY s.played ASC, votes DESC, s.requested_at ASC`;

function listSongs(eventId, visitorId) {
  return db.prepare(songListSql).all({ eid: eventId, vid: visitorId || '' }).map((r) => ({
    ...r,
    explicit: Boolean(r.explicit),
    played: Boolean(r.played),
    requestCount: r.requestCount || 0,
    likeCount: r.likeCount || 0,
    mine: Boolean(r.mine),
    likedByMe: Boolean(r.likedByMe),
    requestedByMe: Boolean(r.requestedByMe),
  }));
}

function publicSong(s) {
  // Gäste sehen keine internen Details wie Wunsch-/Like-Aufteilung
  const { requestCount, likeCount, ...rest } = s;
  return rest;
}

// ---- Öffentliche API (Gäste), pro Event unter /api/e/:slug -------------------
const guest = express.Router({ mergeParams: true });

guest.use((req, res, next) => {
  const ev = SLUG_RE.test(req.params.slug) ? getEventBySlug(req.params.slug) : null;
  if (!ev) return res.status(404).json({ error: 'Dieses Event gibt es nicht (mehr).', code: 'event_not_found' });
  req.event = ev;
  next();
});

guest.get('/', (req, res) => {
  res.json({
    slug: req.event.slug,
    eventName: req.event.name,
    requestsOpen: req.event.requestsOpen,
    searchAvailable: spotify.isConfigured() || DEMO_MODE,
    demoMode: DEMO_MODE && !spotify.isConfigured(),
  });
});

guest.get('/stream', (req, res) => openStream(req, res, req.event.id));

guest.get('/search', searchLimiter, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ items: [] });
  let items;
  if (spotify.isConfigured()) items = await spotify.searchTracks(q);
  else if (DEMO_MODE) items = demo.search(q);
  else return res.status(503).json({ error: 'Die Songsuche ist nicht konfiguriert.' });

  // Status bereits gewünschter Songs dieses Events mitliefern
  const known = new Map(listSongs(req.event.id, req.visitorId).map((s) => [s.spotifyId, s]));
  res.json({
    items: items.map((t) => {
      const s = known.get(t.spotifyId);
      return { ...t, existing: s ? { id: s.id, played: s.played, votes: s.votes, mine: s.mine } : null };
    }),
  });
}));

guest.get('/requests', (req, res) => {
  res.json({ items: listSongs(req.event.id, req.visitorId).map(publicSong) });
});

guest.post('/requests', writeLimiter, asyncRoute(async (req, res) => {
  const ev = req.event;
  if (!ev.requestsOpen) return res.status(403).json({ error: 'Song-Wünsche sind gerade geschlossen.' });
  const spotifyId = String((req.body && req.body.spotifyId) || '');
  if (!/^[A-Za-z0-9]{10,40}$/.test(spotifyId)) return res.status(400).json({ error: 'Ungültige Song-ID.' });

  const findSong = () => db.prepare('SELECT id, played FROM songs WHERE event_id = ? AND spotify_id = ?').get(ev.id, spotifyId);
  let song = findSong();

  if (!song) {
    // Limit für neue Wünsche pro Gast und Event
    const recent = db.prepare(
      `SELECT COUNT(*) AS c FROM votes v JOIN songs s ON s.id = v.song_id
       WHERE s.event_id = ? AND v.visitor_id = ? AND v.kind = 'request' AND v.created_at >= datetime('now', ?)`
    ).get(ev.id, req.visitorId, `-${REQUEST_WINDOW_MIN} minutes`).c;
    if (recent >= REQUEST_LIMIT) {
      return res.status(429).json({
        error: `Du hast schon ${REQUEST_LIMIT} Songs in ${REQUEST_WINDOW_MIN} Minuten gewünscht – gib den anderen auch eine Chance 😉`,
      });
    }
    // Songdaten serverseitig von Spotify holen (nicht vom Client übernehmen)
    const track = spotify.isConfigured() ? await spotify.getTrack(spotifyId) : DEMO_MODE ? demo.get(spotifyId) : null;
    if (!track) return res.status(404).json({ error: 'Song nicht gefunden.' });

    song = transaction(() => {
      db.prepare(
        `INSERT INTO songs (event_id, spotify_id, title, artists, album, image_url, spotify_url, duration_ms, explicit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id, spotify_id) DO NOTHING`
      ).run(ev.id, track.spotifyId, track.title, track.artists, track.album, track.imageUrl, track.spotifyUrl,
        track.durationMs ?? null, track.explicit ? 1 : 0);
      const s = findSong();
      db.prepare(`INSERT INTO votes (song_id, visitor_id, kind) VALUES (?, ?, 'request') ON CONFLICT DO NOTHING`)
        .run(s.id, req.visitorId);
      return s;
    });
    broadcast(ev.id);
    return res.status(201).json({ ok: true, id: song.id, status: 'created' });
  }

  if (song.played) return res.status(409).json({ error: 'Dieser Song wurde bereits gespielt.', id: song.id });

  const r = db.prepare(`INSERT INTO votes (song_id, visitor_id, kind) VALUES (?, ?, 'request') ON CONFLICT DO NOTHING`)
    .run(song.id, req.visitorId);
  if (r.changes) broadcast(ev.id);
  res.json({ ok: true, id: song.id, status: r.changes ? 'voted' : 'already' });
}));

guest.post('/requests/:id/like', writeLimiter, (req, res) => {
  const song = db.prepare('SELECT id, played FROM songs WHERE id = ? AND event_id = ?').get(Number(req.params.id), req.event.id);
  if (!song) return res.status(404).json({ error: 'Song nicht gefunden.' });
  if (song.played) return res.status(409).json({ error: 'Dieser Song wurde bereits gespielt.' });
  const r = db.prepare(`INSERT INTO votes (song_id, visitor_id, kind) VALUES (?, ?, 'like') ON CONFLICT DO NOTHING`)
    .run(song.id, req.visitorId);
  if (r.changes) broadcast(req.event.id);
  res.json({ ok: true });
});

guest.delete('/requests/:id/like', writeLimiter, (req, res) => {
  const r = db.prepare(
    `DELETE FROM votes WHERE song_id = (SELECT id FROM songs WHERE id = ? AND event_id = ?) AND visitor_id = ? AND kind = 'like'`
  ).run(Number(req.params.id), req.event.id, req.visitorId);
  if (r.changes) broadcast(req.event.id);
  res.json({ ok: true });
});

app.use('/api/e/:slug', guest);

// ---- Admin: Anmeldung --------------------------------------------------------
function requireAdmin(req, res, next) {
  const admin = auth.getSessionAdmin(req.cookies[auth.SESSION_COOKIE]);
  if (!admin) return res.status(401).json({ error: 'Nicht angemeldet.' });
  req.admin = admin;
  next();
}

function setSessionCookie(req, res, token) {
  const parts = [`${auth.SESSION_COOKIE}=${token}`, 'Path=/api/admin', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${auth.SESSION_TTL_MS / 1000}`];
  if (cookieSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

const requestOrigin = (req) => `${req.protocol}://${req.get('host')}`;

// Welche Anmeldearten die Login-Seite anzeigen soll
app.get('/api/admin/auth-config', (req, res) => {
  res.json({ password: PASSWORD_LOGIN, oidc: oidc.enabled, oidcLabel: oidc.BUTTON_LABEL });
});

app.post('/api/admin/login', (req, res) => {
  if (!PASSWORD_LOGIN) return res.status(403).json({ error: 'Passwort-Login ist deaktiviert.' });
  const wait = auth.loginBlocked(req.ip);
  if (wait) return res.status(429).json({ error: `Zu viele Fehlversuche. Bitte ${wait} s warten.` });
  const { username, password } = req.body || {};
  const adminId = auth.checkLogin(username, password);
  if (!adminId) {
    auth.registerFailure(req.ip);
    return res.status(401).json({ error: 'Benutzername oder Passwort falsch.' });
  }
  auth.registerSuccess(req.ip);
  setSessionCookie(req, res, auth.createSession(adminId));
  res.json({ ok: true });
});

// ---- OIDC (z. B. Keycloak) ----
const OIDC_FLOW_COOKIE = 'djsr_oidc';
const oidcRedirectUri = (req) => oidc.REDIRECT_URI || `${requestOrigin(req)}/api/admin/oidc/callback`;

app.get('/api/admin/oidc/login', asyncRoute(async (req, res) => {
  if (!oidc.enabled) return res.status(404).json({ error: 'OIDC ist nicht konfiguriert.' });
  try {
    const { url, browserKey } = await oidc.buildLoginUrl(oidcRedirectUri(req));
    const parts = [`${OIDC_FLOW_COOKIE}=${browserKey}`, 'Path=/api/admin/oidc', 'HttpOnly', 'SameSite=Lax', 'Max-Age=600'];
    if (cookieSecure(req)) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
    res.redirect(302, url);
  } catch (err) {
    console.error('[oidc]', err.message);
    res.redirect(302, '/admin/?error=oidc_unavailable');
  }
}));

app.get('/api/admin/oidc/callback', asyncRoute(async (req, res) => {
  if (!oidc.enabled) return res.status(404).json({ error: 'OIDC ist nicht konfiguriert.' });
  res.append('Set-Cookie', `${OIDC_FLOW_COOKIE}=; Path=/api/admin/oidc; HttpOnly; SameSite=Lax; Max-Age=0`);
  try {
    const user = await oidc.handleCallback(req.query, req.cookies[OIDC_FLOW_COOKIE]);
    const adminId = auth.upsertOidcAdmin(user.sub, user.displayName);
    setSessionCookie(req, res, auth.createSession(adminId, user.idToken));
    console.log(`[oidc] Anmeldung: ${user.displayName}`);
    res.redirect(302, '/admin/');
  } catch (err) {
    console.warn('[oidc] Anmeldung abgelehnt:', err.message);
    const code = err instanceof oidc.OidcError ? err.code : 'oidc_unavailable';
    res.redirect(302, `/admin/?error=${encodeURIComponent(code)}`);
  }
}));

app.post('/api/admin/logout', asyncRoute(async (req, res) => {
  const session = auth.destroySession(req.cookies[auth.SESSION_COOKIE]);
  res.append('Set-Cookie', `${auth.SESSION_COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0`);
  let redirect = null;
  if (session && session.kind === 'oidc' && oidc.enabled) {
    redirect = await oidc.buildLogoutUrl(session.idToken, `${requestOrigin(req)}/admin/`);
  }
  res.json({ ok: true, redirect });
}));

app.get('/api/admin/me', requireAdmin, (req, res) => res.json({
  username: req.admin.displayName,
  kind: req.admin.kind,
  canChangePassword: req.admin.kind === 'local' && PASSWORD_LOGIN,
}));

app.post('/api/admin/password', requireAdmin, (req, res) => {
  if (req.admin.kind !== 'local' || !PASSWORD_LOGIN) {
    return res.status(400).json({ error: 'Das Passwort wird bei SSO-Anmeldung im Identity Provider verwaltet.' });
  }
  const { currentPassword, newPassword } = req.body || {};
  if (!auth.checkLogin(req.admin.username, currentPassword)) {
    return res.status(400).json({ error: 'Aktuelles Passwort ist falsch.' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'Das neue Passwort muss mindestens 8 Zeichen haben.' });
  }
  auth.upsertAdmin(req.admin.username, newPassword); // invalidiert alle Sessions
  res.json({ ok: true });
});

// ---- Admin: Einstellungen & Events -------------------------------------------
function publicBaseUrl(req) {
  const base = getSetting('publicUrl') || process.env.PUBLIC_URL || `${requestOrigin(req)}/`;
  return base.replace(/\/*$/, '/');
}
const eventUrl = (req, ev) => new URL(ev.slug, publicBaseUrl(req)).toString();

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({
    publicUrl: publicBaseUrl(req),
    publicUrlOverride: getSetting('publicUrl') || '',
    startEventId: startEventId(),
    spotifyConfigured: spotify.isConfigured(),
    demoMode: DEMO_MODE,
  });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (typeof b.publicUrl === 'string') {
    const u = b.publicUrl.trim();
    if (!u) db.prepare(`DELETE FROM settings WHERE key = 'publicUrl'`).run();
    else {
      try {
        const parsed = new URL(u);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error();
        setSetting('publicUrl', parsed.toString());
      } catch {
        return res.status(400).json({ error: 'Ungültige URL (muss mit http:// oder https:// beginnen).' });
      }
    }
  }
  if (b.startEventId !== undefined) {
    if (b.startEventId === null) db.prepare(`DELETE FROM settings WHERE key = 'startEventId'`).run();
    else if (getEventById(b.startEventId)) setSetting('startEventId', Number(b.startEventId));
    else return res.status(400).json({ error: 'Event nicht gefunden.' });
  }
  res.json({ ok: true });
});

app.get('/api/admin/events', requireAdmin, (req, res) => {
  const start = startEventId();
  const rows = db.prepare(
    `SELECT e.id, e.slug, e.name, e.requests_open AS requestsOpen, e.created_at AS createdAt,
            COUNT(s.id) AS songs, COALESCE(SUM(s.played = 0), 0) AS open
     FROM events e LEFT JOIN songs s ON s.event_id = e.id
     GROUP BY e.id ORDER BY e.created_at DESC, e.id DESC`
  ).all();
  res.json({
    items: rows.map((e) => ({ ...e, requestsOpen: Boolean(e.requestsOpen), isStart: e.id === start, url: eventUrl(req, e) })),
  });
});

function validateEventInput(b, currentId = null) {
  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : undefined;
  if (name !== undefined && !name) return { error: 'Bitte einen Namen eingeben.' };
  let slug;
  if (typeof b.slug === 'string') {
    slug = b.slug.trim().toLowerCase();
    const err = slugError(slug);
    if (err) return { error: err };
    const taken = db.prepare('SELECT id FROM events WHERE slug = ?').get(slug);
    if (taken && taken.id !== currentId) return { error: `Der Unterlink „/${slug}“ ist schon vergeben.` };
  }
  return { name, slug };
}

app.post('/api/admin/events', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (typeof b.slug !== 'string' || !b.slug.trim()) b.slug = slugify(b.name);
  const v = validateEventInput(b);
  if (v.error) return res.status(400).json({ error: v.error });
  if (!v.name) return res.status(400).json({ error: 'Bitte einen Namen eingeben.' });
  const id = Number(db.prepare('INSERT INTO events (slug, name) VALUES (?, ?)').run(v.slug, v.name).lastInsertRowid);
  if (!startEventId() && b.makeStart !== false && db.prepare('SELECT COUNT(*) AS c FROM events').get().c === 1) {
    setSetting('startEventId', id); // erstes Event automatisch als Startseite
  }
  res.status(201).json({ ok: true, event: getEventById(id) });
});

// Lädt das Event aus :eventId – erst nach requireAdmin, damit Unangemeldete nichts erfahren
function loadEvent(req, res, next) {
  const ev = getEventById(req.params.eventId);
  if (!ev) return res.status(404).json({ error: 'Event nicht gefunden.' });
  req.event = ev;
  next();
}

app.put('/api/admin/events/:eventId', requireAdmin, loadEvent, (req, res) => {
  const b = req.body || {};
  const v = validateEventInput(b, req.event.id);
  if (v.error) return res.status(400).json({ error: v.error });
  if (v.name !== undefined) db.prepare('UPDATE events SET name = ? WHERE id = ?').run(v.name, req.event.id);
  if (v.slug !== undefined) db.prepare('UPDATE events SET slug = ? WHERE id = ?').run(v.slug, req.event.id);
  if (typeof b.requestsOpen === 'boolean') {
    db.prepare('UPDATE events SET requests_open = ? WHERE id = ?').run(b.requestsOpen ? 1 : 0, req.event.id);
  }
  // Gäste laden neu; bei geändertem Unterlink leitet die Gästeseite um
  const updated = getEventById(req.event.id);
  broadcast(req.event.id, 'config', { slug: updated.slug });
  res.json({ ok: true, event: updated });
});

app.delete('/api/admin/events/:eventId', requireAdmin, loadEvent, (req, res) => {
  db.prepare('DELETE FROM events WHERE id = ?').run(req.event.id); // Songs + Votes per CASCADE
  if (Number(getSetting('startEventId')) === req.event.id) {
    db.prepare(`DELETE FROM settings WHERE key = 'startEventId'`).run();
  }
  broadcast(req.event.id, 'deleted');
  res.json({ ok: true });
});

app.get('/api/admin/events/:eventId/stream', requireAdmin, loadEvent, (req, res) => openStream(req, res, req.event.id));

app.get('/api/admin/events/:eventId/requests', requireAdmin, loadEvent, (req, res) => {
  const items = listSongs(req.event.id, '');
  res.json({
    items,
    stats: {
      total: items.length,
      open: items.filter((s) => !s.played).length,
      played: items.filter((s) => s.played).length,
      votes: items.reduce((a, s) => a + s.votes, 0),
    },
  });
});

app.post('/api/admin/events/:eventId/reset', requireAdmin, loadEvent, (req, res) => {
  const scope = req.body && req.body.scope;
  if (scope === 'played') db.prepare('DELETE FROM songs WHERE event_id = ? AND played = 1').run(req.event.id);
  else if (scope === 'all') db.prepare('DELETE FROM songs WHERE event_id = ?').run(req.event.id);
  else return res.status(400).json({ error: 'Unbekannter Bereich.' });
  broadcast(req.event.id);
  res.json({ ok: true });
});

app.get('/api/admin/events/:eventId/qr', requireAdmin, loadEvent, asyncRoute(async (req, res) => {
  const url = eventUrl(req, req.event);
  const format = req.query.format === 'svg' ? 'svg' : 'png';
  const size = Math.min(Math.max(Number(req.query.size) || 1024, 128), 4096);
  const opts = { errorCorrectionLevel: 'H', margin: 2, width: size, color: { dark: '#000000', light: '#ffffff' } };
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="qr-${req.event.slug}.${format}"`);
  }
  res.setHeader('Cache-Control', 'no-store');
  if (format === 'svg') res.type('image/svg+xml').send(await QRCode.toString(url, { ...opts, type: 'svg' }));
  else res.type('image/png').send(await QRCode.toBuffer(url, opts));
}));

// Song-Aktionen (Song-IDs sind global eindeutig)
app.post('/api/admin/requests/:id/played', requireAdmin, (req, res) => {
  const song = db.prepare('SELECT id, event_id AS eventId FROM songs WHERE id = ?').get(Number(req.params.id));
  if (!song) return res.status(404).json({ error: 'Song nicht gefunden.' });
  const played = Boolean(req.body && req.body.played);
  db.prepare(`UPDATE songs SET played = ?, played_at = CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE id = ?`)
    .run(played ? 1 : 0, played ? 1 : 0, song.id);
  broadcast(song.eventId);
  res.json({ ok: true });
});

app.delete('/api/admin/requests/:id', requireAdmin, (req, res) => {
  const song = db.prepare('SELECT id, event_id AS eventId FROM songs WHERE id = ?').get(Number(req.params.id));
  if (song) {
    db.prepare('DELETE FROM songs WHERE id = ?').run(song.id);
    broadcast(song.eventId);
  }
  res.json({ ok: true });
});

// ---- Seiten ------------------------------------------------------------------
const pub = path.join(__dirname, '..', 'public');
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));

app.get(['/admin', '/admin/'], (req, res) => res.sendFile(path.join(pub, 'admin', 'index.html')));
// maxAge 0 + ETag: Browser fragen jedes Mal kurz nach (304), bekommen nach Updates aber sofort die neuen Dateien
app.use(express.static(pub, { index: false, maxAge: 0 }));

// Startseite: zum Startseiten-Event weiterleiten, sonst Hinweis anzeigen
app.get('/', (req, res) => {
  const id = startEventId();
  const ev = id && getEventById(id);
  if (ev) return res.redirect(302, `/${ev.slug}`);
  res.sendFile(path.join(pub, 'landing.html'));
});

// Gästeseite pro Event: /<unterlink>
app.get('/:slug', (req, res, next) => {
  const slug = req.params.slug;
  if (!SLUG_RE.test(slug)) {
    // Großschreibung oder Schrägstrich am Ende tolerieren
    const norm = slug.toLowerCase();
    if (SLUG_RE.test(norm) && getEventBySlug(norm)) return res.redirect(301, `/${norm}`);
    return next();
  }
  if (!getEventBySlug(slug)) return next();
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(pub, 'event.html'));
});

app.use((req, res) => res.status(404).sendFile(path.join(pub, 'landing.html')));

app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  res.status(502).json({ error: 'Da ist etwas schiefgelaufen. Bitte gleich nochmal versuchen.' });
});

const server = app.listen(PORT, () => {
  const events = db.prepare('SELECT slug FROM events ORDER BY id').all().map((e) => `/${e.slug}`);
  console.log(`DJ Song Requester läuft auf Port ${PORT} – Events: ${events.join(', ') || '(keine)'}`);
  if (DEMO_MODE && !spotify.isConfigured()) console.log('[demo] Demo-Modus aktiv – Suche liefert Beispielsongs.');
});

function shutdown() {
  for (const set of sseClients.values()) for (const r of set) r.end();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
