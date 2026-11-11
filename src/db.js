'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'dj-song-requester.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS songs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    spotify_id    TEXT NOT NULL UNIQUE,
    title         TEXT NOT NULL,
    artists       TEXT NOT NULL,
    album         TEXT,
    image_url     TEXT,
    spotify_url   TEXT,
    duration_ms   INTEGER,
    explicit      INTEGER NOT NULL DEFAULT 0,
    requested_at  TEXT NOT NULL DEFAULT (datetime('now')),
    played        INTEGER NOT NULL DEFAULT 0,
    played_at     TEXT
  );

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

module.exports = { db, getSetting, setSetting, transaction, DATA_DIR };
