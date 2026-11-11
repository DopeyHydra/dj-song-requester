'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'dj-song-requester.db'));

const { slugify, slugError } = require('./slug');

const SONGS_TABLE_SQL = (name) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    spotify_id    TEXT NOT NULL,
    title         TEXT NOT NULL,
    artists       TEXT NOT NULL,
    album         TEXT,
    image_url     TEXT,
    spotify_url   TEXT,
    duration_ms   INTEGER,
    explicit      INTEGER NOT NULL DEFAULT 0,
    requested_at  TEXT NOT NULL DEFAULT (datetime('now')),
    played        INTEGER NOT NULL DEFAULT 0,
    played_at     TEXT,
    UNIQUE (event_id, spotify_id)
  );`;

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    slug           TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    requests_open  INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  ${SONGS_TABLE_SQL('songs')}

  -- Jede/r Gast zählt pro Song genau einmal: entweder als Wunsch oder als Like.
  CREATE TABLE IF NOT EXISTS votes (
    song_id     INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
    visitor_id  TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('request', 'like')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (song_id, visitor_id)
  );
  CREATE INDEX IF NOT EXISTS idx_votes_visitor ON votes(visitor_id);

  CREATE TABLE IF NOT EXISTS admins (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
`);

// ---- Migrationen für bestehende Datenbanken ----
function addColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('admins', 'kind', "TEXT NOT NULL DEFAULT 'local'"); // 'local' | 'oidc'
addColumn('admins', 'display_name', 'TEXT');
addColumn('sessions', 'id_token', 'TEXT');

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---- Mehrere Events ----------------------------------------------------------
function createDefaultEvent() {
  const name = getSetting('eventName') || process.env.EVENT_NAME || 'DJ Song Requester';
  let slug = (process.env.DEFAULT_EVENT_SLUG || '').trim().toLowerCase() || slugify(name);
  if (slugError(slug)) slug = 'event';
  const open = getSetting('requestsOpen') === '0' ? 0 : 1;
  const id = Number(db.prepare('INSERT INTO events (slug, name, requests_open) VALUES (?, ?, ?)')
    .run(slug, name, open).lastInsertRowid);
  // Als Startseite setzen, damit bisherige QR-Codes (auf "/") weiter funktionieren
  setSetting('startEventId', id);
  db.prepare(`DELETE FROM settings WHERE key IN ('eventName', 'requestsOpen')`).run();
  return { id, slug };
}

// Alte Datenbank (eine einzige Wunschliste) → Songs in ein erstes Event übernehmen
const songCols = db.prepare('PRAGMA table_info(songs)').all().map((c) => c.name);
if (!songCols.includes('event_id')) {
  db.exec('PRAGMA foreign_keys = OFF'); // sonst würde DROP TABLE die Votes per CASCADE löschen
  try {
    transaction(() => {
      const ev = createDefaultEvent();
      db.exec(SONGS_TABLE_SQL('songs_new'));
      db.prepare(
        `INSERT INTO songs_new (id, event_id, spotify_id, title, artists, album, image_url, spotify_url,
                                duration_ms, explicit, requested_at, played, played_at)
         SELECT id, ?, spotify_id, title, artists, album, image_url, spotify_url,
                duration_ms, explicit, requested_at, played, played_at FROM songs`
      ).run(ev.id);
      db.exec('DROP TABLE songs; ALTER TABLE songs_new RENAME TO songs;');
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`Fremdschlüssel verletzt: ${JSON.stringify(broken.slice(0, 3))}`);
      console.log(`[db] Bestehende Wunschliste wurde ins Event "/${ev.slug}" übernommen.`);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  setSetting('eventsInitialized', '1');
}

// Neue Installation → ein erstes Event anlegen (nur einmal, damit gelöschte Events nicht wiederkommen)
if (getSetting('eventsInitialized') !== '1') {
  if (db.prepare('SELECT COUNT(*) AS c FROM events').get().c === 0) {
    const ev = createDefaultEvent();
    console.log(`[db] Erstes Event angelegt: "/${ev.slug}".`);
  }
  setSetting('eventsInitialized', '1');
}

db.exec('CREATE INDEX IF NOT EXISTS idx_songs_event ON songs(event_id)');

module.exports = { db, getSetting, setSetting, transaction, DATA_DIR };
