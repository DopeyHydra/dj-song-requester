'use strict';
// Nutzung: node src/cli.js reset-password <benutzername> <neues-passwort>
const auth = require('./auth');

const [cmd, username, password] = process.argv.slice(2);

if (cmd === 'reset-password') {
  if (!username || !password || password.length < 8) {
    console.error('Nutzung: node src/cli.js reset-password <benutzername> <neues-passwort (min. 8 Zeichen)>');
    process.exit(1);
  }
  auth.upsertAdmin(username, password);
  console.log(`Passwort für "${username}" gesetzt (bestehende Logins wurden abgemeldet).`);
} else {
  console.log('Befehle:\n  reset-password <benutzername> <neues-passwort>');
}
