'use strict';
const crypto = require('node:crypto');
const { db } = require('./db');

const SESSION_COOKIE = 'djsr_admin';
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 Stunden

// ---- Passwort-Hashing (scrypt, gesalzen) -------------------------------------
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [algo, N, r, p, saltB64, hashB64] = stored.split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Dummy-Hash, damit unbekannte Benutzernamen gleich lange brauchen wie falsche Passwörter.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

// ---- Admin-Benutzer ----------------------------------------------------------
function upsertAdmin(username, password) {
  const hash = hashPassword(password);
  db.prepare(
    'INSERT INTO admins (username, password_hash) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash'
  ).run(username, hash);
  const admin = db.prepare('SELECT id FROM admins WHERE username = ?').get(username);
  // Bestehende Sessions dieses Admins ungültig machen.
  db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(admin.id);
}

function ensureInitialAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c;
  if (count > 0) return;
  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 8) {
    console.error(
      '[auth] Kein Admin vorhanden. Bitte ADMIN_PASSWORD (min. 8 Zeichen) in der .env setzen und neu starten.'
    );
    process.exit(1);
  }
  upsertAdmin(username, password);
  console.log(`[auth] Admin "${username}" angelegt (Passwort als scrypt-Hash gespeichert).`);
  console.log('[auth] Tipp: ADMIN_PASSWORD kann jetzt aus der .env entfernt werden.');
}

function checkLogin(username, password) {
  const admin = db.prepare('SELECT id, password_hash FROM admins WHERE username = ?').get(String(username || ''));
  const ok = verifyPassword(String(password || ''), admin ? admin.password_hash : DUMMY_HASH);
  return ok && admin ? admin.id : null;
}

// ---- Sessions ----------------------------------------------------------------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(adminId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token), adminId, Date.now() + SESSION_TTL_MS
  );
  return token;
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function getSessionAdmin(token) {
  if (!token) return null;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return db.prepare(
    `SELECT a.id, a.username FROM sessions s JOIN admins a ON a.id = s.admin_id
     WHERE s.token_hash = ? AND s.expires_at >= ?`
  ).get(sha256(token), Date.now()) || null;
}

// ---- Login-Bremse (pro IP) ---------------------------------------------------
const attempts = new Map(); // ip -> { count, until }
function loginBlocked(ip) {
  const a = attempts.get(ip);
  return a && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 1000) : 0;
}
function registerFailure(ip) {
  const a = attempts.get(ip) || { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= 5) a.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (a.count - 5));
  attempts.set(ip, a);
}
function registerSuccess(ip) {
  attempts.delete(ip);
}

module.exports = {
  SESSION_COOKIE, SESSION_TTL_MS,
  hashPassword, verifyPassword, upsertAdmin, ensureInitialAdmin, checkLogin,
  createSession, destroySession, getSessionAdmin,
  loginBlocked, registerFailure, registerSuccess,
};
