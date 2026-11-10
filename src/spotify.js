'use strict';

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const MARKET = process.env.SPOTIFY_MARKET || 'DE';

let token = null;
let tokenExpires = 0;

function isConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

async function getToken() {
  if (token && Date.now() < tokenExpires - 60_000) return token;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Spotify-Token fehlgeschlagen (${res.status})`);
  const data = await res.json();
  token = data.access_token;
  tokenExpires = Date.now() + data.expires_in * 1000;
  return token;
}

function mapTrack(t) {
  const images = (t.album && t.album.images) || [];
  // Kleinstes Bild >= 64px bevorzugen
  const img = [...images].sort((a, b) => a.width - b.width).find((i) => i.width >= 64) || images[0];
  return {
    spotifyId: t.id,
    title: t.name,
    artists: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album ? t.album.name : null,
    imageUrl: img ? img.url : null,
    spotifyUrl: t.external_urls ? t.external_urls.spotify : null,
    durationMs: t.duration_ms,
    explicit: Boolean(t.explicit),
  };
}

const cache = new Map(); // query -> { at, items }

async function searchTracks(query) {
  const key = query.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.items;

  const url = new URL('https://api.spotify.com/v1/search');
  url.searchParams.set('q', query);
  url.searchParams.set('type', 'track');
  url.searchParams.set('limit', '10');
  url.searchParams.set('market', MARKET);

  const doFetch = async () =>
    fetch(url, { headers: { Authorization: `Bearer ${await getToken()}` } });

  let res = await doFetch();
  if (res.status === 401) { token = null; res = await doFetch(); }
  if (!res.ok) throw new Error(`Spotify-Suche fehlgeschlagen (${res.status})`);

  const data = await res.json();
  const items = ((data.tracks && data.tracks.items) || []).filter(Boolean).map(mapTrack);
  cache.set(key, { at: Date.now(), items });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return items;
}

async function getTrack(id) {
  const url = `https://api.spotify.com/v1/tracks/${encodeURIComponent(id)}?market=${MARKET}`;
  let res = await fetch(url, { headers: { Authorization: `Bearer ${await getToken()}` } });
  if (res.status === 401) {
    token = null;
    res = await fetch(url, { headers: { Authorization: `Bearer ${await getToken()}` } });
  }
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`Spotify-Track fehlgeschlagen (${res.status})`);
  return mapTrack(await res.json());
}

module.exports = { isConfigured, searchTracks, getTrack };
