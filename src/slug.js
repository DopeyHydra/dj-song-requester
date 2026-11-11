'use strict';
// Unterlinks für Events, z. B. /hochzeit-mueller

// Pfade, die die App selbst benutzt, dürfen keine Event-Unterlinks sein.
const RESERVED = new Set(['admin', 'api', 'healthz', 'static', 'assets', 'public', 'favicon', 'robots', 'login', 'logout']);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
}

/** Gibt eine Fehlermeldung zurück oder null, wenn der Unterlink gültig ist. */
function slugError(slug) {
  if (!slug) return 'Der Unterlink darf nicht leer sein.';
  if (!SLUG_RE.test(slug)) {
    return 'Der Unterlink darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten (max. 50 Zeichen, nicht mit - beginnen/enden).';
  }
  if (RESERVED.has(slug)) return `„${slug}“ ist reserviert. Bitte einen anderen Unterlink wählen.`;
  return null;
}

module.exports = { slugify, slugError, SLUG_RE, RESERVED };
