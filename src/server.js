'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const QRCode = require('qrcode');

const { db, getSetting, setSetting, transaction } = require('./db');
const auth = require('./auth');
const spotify = require('./spotify');
const demo = require('./demo');

const PORT = Number(process.env.PORT || 3000);
const DEMO_MODE = /^(1|true|yes)$/i.test(process.env.DEMO_MODE || '');
const REQUEST_LIMIT = Number(process.env.REQUEST_LIMIT_PER_GUEST || 5); // neue Wünsche pro Gast ...
const REQUEST_WINDOW_MIN = Number(process.env.REQUEST_LIMIT_WINDOW_MINUTES || 15); // ... pro Zeitfenster
const VISITOR_COOKIE = 'djsr_vid';

auth.ensureInitialAdmin();
if (!spotify.isConfigured() && !DEMO_MODE) {
  console.warn('[spotify] SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET fehlen – die Songsuche ist deaktiviert.');
}
if (getSetting('eventName') === null) setSetting('eventName', process.env.EVENT_NAME || 'DJ Song Requester');
if (getSetting('requestsOpen') === null) setSetting('requestsOpen', '1');

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
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
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
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...[].concat(prev), parts.join('; ')]);
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

// ---- Live-Updates (Server-Sent Events) ---------------------------------------
const sseClients = new Set();
function broadcast(type = 'changed') {
  for (const res of sseClients) res.write(`event: ${type}\ndata: {}\n\n`);
}
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  sseClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

// ---- Hilfsfunktionen ---------------------------------------------------------
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
  GROUP BY s.id
  ORDER BY s.played ASC, votes DESC, s.requested_at ASC`;

function listSongs(visitorId) {
  return db.prepare(songListSql).all({ vid: visitorId || '' }).map((r) => ({
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

function publicConfig() {
  return {
    eventName: getSetting('eventName'),
    requestsOpen: getSetting('requestsOpen') === '1',
    searchAvailable: spotify.isConfigured() || DEMO_MODE,
    demoMode: DEMO_MODE && !spotify.isConfigured(),
  };
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- Öffentliche API (Gäste) -------------------------------------------------
app.get('/api/config', (req, res) => res.json(publicConfig()));

app.get('/api/search', searchLimiter, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ items: [] });
  let items;
  if (spotify.isConfigured()) items = await spotify.searchTracks(q);
  else if (DEMO_MODE) items = demo.search(q);
  else return res.status(503).json({ error: 'Die Songsuche ist nicht konfiguriert.' });

  // Status bereits gewünschter Songs mitliefern
  const known = new Map(listSongs(req.visitorId).map((s) => [s.spotifyId, s]));
  res.json({
    items: items.map((t) => {
      const s = known.get(t.spotifyId);
      return { ...t, existing: s ? { id: s.id, played: s.played, votes: s.votes, mine: s.mine } : null };
    }),
  });
}));

app.get('/api/requests', (req, res) => {
  res.json({ items: listSongs(req.visitorId).map(publicSong) });
});

app.post('/api/requests', writeLimiter, asyncRoute(async (req, res) => {
  if (getSetting('requestsOpen') !== '1') {
    return res.status(403).json({ error: 'Song-Wünsche sind gerade geschlossen.' });
  }
  const spotifyId = String((req.body && req.body.spotifyId) || '');
  if (!/^[A-Za-z0-9]{10,40}$/.test(spotifyId)) return res.status(400).json({ error: 'Ungültige Song-ID.' });

  let song = db.prepare('SELECT id, played FROM songs WHERE spotify_id = ?').get(spotifyId);

  if (!song) {
    // Limit für neue Wünsche pro Gast
    const recent = db.prepare(
      `SELECT COUNT(*) AS c FROM votes WHERE visitor_id = ? AND kind = 'request'
       AND created_at >= datetime('now', ?)`
    ).get(req.visitorId, `-${REQUEST_WINDOW_MIN} minutes`).c;
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
        `INSERT INTO songs (spotify_id, title, artists, album, image_url, spotify_url, duration_ms, explicit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(spotify_id) DO NOTHING`
      ).run(track.spotifyId, track.title, track.artists, track.album, track.imageUrl, track.spotifyUrl,
        track.durationMs ?? null, track.explicit ? 1 : 0);
      const s = db.prepare('SELECT id, played FROM songs WHERE spotify_id = ?').get(spotifyId);
      db.prepare(
        `INSERT INTO votes (song_id, visitor_id, kind) VALUES (?, ?, 'request') ON CONFLICT DO NOTHING`
      ).run(s.id, req.visitorId);
      return s;
    });
    broadcast();
    return res.status(201).json({ ok: true, id: song.id, status: 'created' });
  }

  if (song.played) return res.status(409).json({ error: 'Dieser Song wurde bereits gespielt.', id: song.id });

  const r = db.prepare(
    `INSERT INTO votes (song_id, visitor_id, kind) VALUES (?, ?, 'request') ON CONFLICT DO NOTHING`
  ).run(song.id, req.visitorId);
  if (r.changes) broadcast();
  res.json({ ok: true, id: song.id, status: r.changes ? 'voted' : 'already' });
}));

app.post('/api/requests/:id/like', writeLimiter, (req, res) => {
  const id = Number(req.params.id);
  const song = db.prepare('SELECT id, played FROM songs WHERE id = ?').get(id);
  if (!song) return res.status(404).json({ error: 'Song nicht gefunden.' });
  if (song.played) return res.status(409).json({ error: 'Dieser Song wurde bereits gespielt.' });
  const r = db.prepare(
    `INSERT INTO votes (song_id, visitor_id, kind) VALUES (?, ?, 'like') ON CONFLICT DO NOTHING`
  ).run(id, req.visitorId);
  if (r.changes) broadcast();
  res.json({ ok: true });
});

app.delete('/api/requests/:id/like', writeLimiter, (req, res) => {
  const r = db.prepare(`DELETE FROM votes WHERE song_id = ? AND visitor_id = ? AND kind = 'like'`)
    .run(Number(req.params.id), req.visitorId);
  if (r.changes) broadcast();
  res.json({ ok: true });
});

// ---- Admin-API ---------------------------------------------------------------
function requireAdmin(req, res, next) {
  const admin = auth.getSessionAdmin(req.cookies[auth.SESSION_COOKIE]);
  if (!admin) return res.status(401).json({ error: 'Nicht angemeldet.' });
  req.admin = admin;
  next();
}

app.post('/api/admin/login', (req, res) => {
  const wait = auth.loginBlocked(req.ip);
  if (wait) return res.status(429).json({ error: `Zu viele Fehlversuche. Bitte ${wait} s warten.` });
  const { username, password } = req.body || {};
  const adminId = auth.checkLogin(username, password);
  if (!adminId) {
    auth.registerFailure(req.ip);
    return res.status(401).json({ error: 'Benutzername oder Passwort falsch.' });
  }
  auth.registerSuccess(req.ip);
  const token = auth.createSession(adminId);
  const parts = [`${auth.SESSION_COOKIE}=${token}`, 'Path=/api/admin', 'HttpOnly', 'SameSite=Strict',
    `Max-Age=${auth.SESSION_TTL_MS / 1000}`];
  if (cookieSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  auth.destroySession(req.cookies[auth.SESSION_COOKIE]);
  res.append('Set-Cookie', `${auth.SESSION_COOKIE}=; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ username: req.admin.username }));

app.post('/api/admin/password', requireAdmin, (req, res) => {
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

app.get('/api/admin/requests', requireAdmin, (req, res) => {
  const items = listSongs('');
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

app.post('/api/admin/requests/:id/played', requireAdmin, (req, res) => {
  const played = Boolean(req.body && req.body.played);
  const r = db.prepare(
    `UPDATE songs SET played = ?, played_at = CASE WHEN ? THEN datetime('now') ELSE NULL END WHERE id = ?`
  ).run(played ? 1 : 0, played ? 1 : 0, Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: 'Song nicht gefunden.' });
  broadcast();
  res.json({ ok: true });
});

app.delete('/api/admin/requests/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM songs WHERE id = ?').run(Number(req.params.id));
  broadcast();
  res.json({ ok: true });
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const scope = req.body && req.body.scope;
  if (scope === 'played') db.prepare('DELETE FROM songs WHERE played = 1').run();
  else if (scope === 'all') db.prepare('DELETE FROM songs').run();
  else return res.status(400).json({ error: 'Unbekannter Bereich.' });
  broadcast();
  res.json({ ok: true });
});

function resolvePublicUrl(req) {
  const fromSetting = getSetting('publicUrl');
  if (fromSetting) return fromSetting;
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '') + '/';
  return `${req.protocol}://${req.get('host')}/`;
}

app.get('/api/admin/settings', requireAdmin, (req, res) => {
  res.json({
    eventName: getSetting('eventName'),
    requestsOpen: getSetting('requestsOpen') === '1',
    publicUrl: resolvePublicUrl(req),
    publicUrlOverride: getSetting('publicUrl') || '',
    spotifyConfigured: spotify.isConfigured(),
    demoMode: DEMO_MODE,
  });
});

app.put('/api/admin/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  if (typeof b.eventName === 'string') {
    const name = b.eventName.trim().slice(0, 80);
    if (name) setSetting('eventName', name);
  }
  if (typeof b.requestsOpen === 'boolean') setSetting('requestsOpen', b.requestsOpen ? '1' : '0');
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
  broadcast('config');
  res.json({ ok: true });
});

app.get('/api/admin/qr', requireAdmin, asyncRoute(async (req, res) => {
  const url = resolvePublicUrl(req);
  const format = req.query.format === 'svg' ? 'svg' : 'png';
  const size = Math.min(Math.max(Number(req.query.size) || 1024, 128), 4096);
  const opts = { errorCorrectionLevel: 'H', margin: 2, width: size, color: { dark: '#000000', light: '#ffffff' } };
  const download = req.query.download === '1';
  const filename = `dj-song-requester-qr.${format}`;
  if (download) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  if (format === 'svg') {
    res.type('image/svg+xml').send(await QRCode.toString(url, { ...opts, type: 'svg' }));
  } else {
    res.type('image/png').send(await QRCode.toBuffer(url, opts));
  }
}));

// ---- Statische Dateien -------------------------------------------------------
const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub, { extensions: ['html'], maxAge: '1h' }));
app.get('/admin', (req, res) => res.sendFile(path.join(pub, 'admin', 'index.html')));
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Nicht gefunden.' }));

app.use((err, req, res, _next) => {
  console.error('[error]', err.message);
  res.status(502).json({ error: 'Da ist etwas schiefgelaufen. Bitte gleich nochmal versuchen.' });
});

const server = app.listen(PORT, () => {
  console.log(`DJ Song Requester läuft auf Port ${PORT}`);
  if (DEMO_MODE && !spotify.isConfigured()) console.log('[demo] Demo-Modus aktiv – Suche liefert Beispielsongs.');
});

function shutdown() {
  for (const r of sseClients) r.end();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
