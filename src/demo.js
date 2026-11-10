'use strict';
// Beispielsongs für DEMO_MODE (ohne Spotify-Zugangsdaten zum Ausprobieren).
const SONGS = [
  ['Mr. Brightside', 'The Killers', 'Hot Fuss'],
  ['Dancing Queen', 'ABBA', 'Arrival'],
  ['Blinding Lights', 'The Weeknd', 'After Hours'],
  ['Atemlos durch die Nacht', 'Helene Fischer', 'Farbenspiel'],
  ['Levels', 'Avicii', 'Levels'],
  ['Uptown Funk', 'Mark Ronson, Bruno Mars', 'Uptown Special'],
  ['September', 'Earth, Wind & Fire', 'The Best of Earth, Wind & Fire'],
  ['Don\'t Stop Me Now', 'Queen', 'Jazz'],
  ['Wonderwall', 'Oasis', '(What\'s the Story) Morning Glory?'],
  ['Titanium', 'David Guetta, Sia', 'Nothing but the Beat'],
  ['Mambo No. 5', 'Lou Bega', 'A Little Bit of Mambo'],
  ['Sweet Caroline', 'Neil Diamond', 'Brother Love\'s Travelling Salvation Show'],
  ['Levitating', 'Dua Lipa', 'Future Nostalgia'],
  ['99 Luftballons', 'Nena', 'Nena'],
  ['I Gotta Feeling', 'Black Eyed Peas', 'The E.N.D.'],
].map(([title, artists, album], i) => ({
  spotifyId: `demo${String(i).padStart(8, '0')}`,
  title, artists, album,
  imageUrl: null,
  spotifyUrl: null,
  durationMs: 180000 + i * 7000,
  explicit: false,
}));

function search(q) {
  const t = q.toLowerCase();
  return SONGS.filter((s) => `${s.title} ${s.artists} ${s.album}`.toLowerCase().includes(t)).slice(0, 10);
}
const get = (id) => SONGS.find((s) => s.spotifyId === id) || null;

module.exports = { search, get };
