'use strict';
/*
 * OpenID Connect (Authorization Code Flow + PKCE) für das Admin-Panel.
 * Getestet mit Keycloak, funktioniert mit jedem standardkonformen Anbieter.
 *
 * Das ID-Token wird direkt vom Token-Endpunkt über eine TLS-Verbindung des Servers
 * abgeholt. Laut OIDC Core 3.1.3.7 genügt hier die TLS-Server-Validierung anstelle
 * einer Signaturprüfung; iss, aud, azp, exp und nonce werden trotzdem geprüft.
 */
const crypto = require('node:crypto');

const ISSUER = (process.env.OIDC_ISSUER || '').replace(/\/+$/, '');
const CLIENT_ID = process.env.OIDC_CLIENT_ID || '';
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || '';
const SCOPES = process.env.OIDC_SCOPES || 'openid profile email';
const REDIRECT_URI = process.env.OIDC_REDIRECT_URI || '';
const ROLES_CLAIM = process.env.OIDC_ROLES_CLAIM || 'realm_access.roles';
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const ALLOWED_ROLES = list(process.env.OIDC_ALLOWED_ROLES);
const ALLOWED_USERS = list(process.env.OIDC_ALLOWED_USERS).map((s) => s.toLowerCase());
const ALLOW_ALL = /^(1|true|yes)$/i.test(process.env.OIDC_ALLOW_ALL_USERS || '');
const BUTTON_LABEL = process.env.OIDC_BUTTON_LABEL || 'Mit SSO anmelden';
const SKEW_SEC = 120;

const enabled = Boolean(ISSUER && CLIENT_ID);

function checkConfig() {
  if (!enabled) return;
  if (!ALLOWED_ROLES.length && !ALLOWED_USERS.length && !ALLOW_ALL) {
    console.error('[oidc] OIDC ist aktiv, aber weder OIDC_ALLOWED_ROLES noch OIDC_ALLOWED_USERS gesetzt.');
    console.error('[oidc] Ohne Einschränkung dürfte jeder Benutzer des Realms ins Admin-Panel.');
    console.error('[oidc] Bitte eine Rolle/Benutzer festlegen oder bewusst OIDC_ALLOW_ALL_USERS=true setzen.');
    process.exit(1);
  }
  console.log(`[oidc] Aktiv – Issuer ${ISSUER}, Client "${CLIENT_ID}".`);
}

// ---- Discovery ---------------------------------------------------------------
let discovery = null;
let discoveryAt = 0;
async function getDiscovery() {
  if (discovery && Date.now() - discoveryAt < 60 * 60_000) return discovery;
  const res = await fetch(`${ISSUER}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC-Discovery fehlgeschlagen (${res.status})`);
  const d = await res.json();
  if (String(d.issuer).replace(/\/+$/, '') !== ISSUER) {
    throw new Error(`Issuer stimmt nicht überein: erwartet ${ISSUER}, erhalten ${d.issuer}`);
  }
  discovery = d;
  discoveryAt = Date.now();
  return d;
}

// ---- Flow-State (kurzlebig, im Speicher) -------------------------------------
const pending = new Map(); // state -> { verifier, nonce, redirectUri, browserKey, expires }
const b64url = (buf) => buf.toString('base64url');
const sha256b64url = (s) => b64url(crypto.createHash('sha256').update(s).digest());

function cleanup() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
}

async function buildLoginUrl(redirectUri) {
  cleanup();
  if (pending.size > 1000) throw new Error('Zu viele offene Anmeldungen.');
  const d = await getDiscovery();
  const state = b64url(crypto.randomBytes(24));
  const nonce = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const browserKey = b64url(crypto.randomBytes(24)); // bindet den Flow an diesen Browser (Cookie)
  pending.set(state, { verifier, nonce, redirectUri, browserKey, expires: Date.now() + 10 * 60_000 });

  const url = new URL(d.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', sha256b64url(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), browserKey };
}

function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

class OidcError extends Error {
  constructor(code, detail) { super(detail || code); this.code = code; }
}

async function handleCallback(query, browserKey) {
  if (query.error) throw new OidcError('provider', `${query.error}: ${query.error_description || ''}`);
  const flow = pending.get(String(query.state || ''));
  pending.delete(String(query.state || ''));
  if (!flow || flow.expires < Date.now()) throw new OidcError('state', 'Unbekannter oder abgelaufener state.');
  if (!browserKey || !crypto.timingSafeEqual(
    crypto.createHash('sha256').update(browserKey).digest(),
    crypto.createHash('sha256').update(flow.browserKey).digest())) {
    throw new OidcError('state', 'Anmeldung wurde in einem anderen Browser gestartet.');
  }
  if (!query.code) throw new OidcError('provider', 'Kein Code erhalten.');

  const d = await getDiscovery();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(query.code),
    redirect_uri: flow.redirectUri,
    code_verifier: flow.verifier,
  });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (CLIENT_SECRET) {
    const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+');
    headers.Authorization = 'Basic ' + Buffer.from(`${enc(CLIENT_ID)}:${enc(CLIENT_SECRET)}`).toString('base64');
  } else {
    body.set('client_id', CLIENT_ID);
  }
  const res = await fetch(d.token_endpoint, { method: 'POST', headers, body });
  const tokens = await res.json().catch(() => ({}));
  if (!res.ok || !tokens.id_token) {
    throw new OidcError('token', `Token-Abruf fehlgeschlagen (${res.status}) ${tokens.error || ''} ${tokens.error_description || ''}`);
  }

  // ---- ID-Token prüfen ----
  const claims = decodeJwt(tokens.id_token);
  if (!claims) throw new OidcError('token', 'ID-Token nicht lesbar.');
  const now = Math.floor(Date.now() / 1000);
  const aud = [].concat(claims.aud || []);
  if (String(claims.iss).replace(/\/+$/, '') !== ISSUER) throw new OidcError('token', 'Falscher Issuer im ID-Token.');
  if (!aud.includes(CLIENT_ID)) throw new OidcError('token', 'ID-Token ist nicht für diesen Client.');
  if (aud.length > 1 && claims.azp !== CLIENT_ID) throw new OidcError('token', 'Ungültiger azp im ID-Token.');
  if (!claims.exp || claims.exp + SKEW_SEC < now) throw new OidcError('token', 'ID-Token abgelaufen.');
  if (claims.nonce !== flow.nonce) throw new OidcError('token', 'Nonce stimmt nicht.');
  if (!claims.sub) throw new OidcError('token', 'ID-Token ohne sub.');

  // ---- Berechtigung prüfen ----
  // Rollen stehen bei Keycloak standardmäßig nur im Access-Token, daher beide Tokens durchsuchen.
  const accessClaims = decodeJwt(tokens.access_token) || {};
  const roles = new Set([
    ...[].concat(getPath(claims, ROLES_CLAIM) || []),
    ...[].concat(getPath(accessClaims, ROLES_CLAIM) || []),
  ].map(String));
  const names = [claims.preferred_username, claims.email].filter(Boolean).map((s) => String(s).toLowerCase());

  const allowed = ALLOW_ALL
    || ALLOWED_ROLES.some((r) => roles.has(r))
    || names.some((n) => ALLOWED_USERS.includes(n));
  if (!allowed) {
    throw new OidcError('forbidden', `Benutzer "${claims.preferred_username || claims.sub}" hat keine Admin-Berechtigung.`);
  }

  return {
    sub: String(claims.sub),
    displayName: String(claims.preferred_username || claims.name || claims.email || claims.sub),
    idToken: tokens.id_token,
  };
}

async function buildLogoutUrl(idToken, postLogoutRedirectUri) {
  try {
    const d = await getDiscovery();
    if (!d.end_session_endpoint) return null;
    const url = new URL(d.end_session_endpoint);
    url.searchParams.set('client_id', CLIENT_ID);
    if (idToken) url.searchParams.set('id_token_hint', idToken);
    url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
    return url.toString();
  } catch {
    return null;
  }
}

module.exports = {
  enabled, BUTTON_LABEL, REDIRECT_URI, checkConfig,
  buildLoginUrl, handleCallback, buildLogoutUrl, OidcError,
};
