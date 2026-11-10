# DJ Song Requester

Gäste scannen einen QR-Code, suchen Songs aus dem Spotify-Katalog und wünschen sie sich. Sie sehen die Wunschliste, können Songs liken und erkennen, was schon gespielt wurde. Der DJ sieht im Admin-Panel alle Wünsche, sortiert nach Beliebtheit, und hakt gespielte Songs ab.

## Funktionen

**Gästeseite** (`/`)
- Spotify-Songsuche (Cover, Interpret, Länge, Explicit-Hinweis)
- Song wünschen. Ist er schon auf der Liste, zählt der Wunsch als +1.
- Wunschliste nach Beliebtheit sortiert, Songs mit ♥ liken (und wieder entliken)
- Tab „Gespielt“; gespielte Songs lassen sich nicht erneut wünschen
- Live-Updates ohne Neuladen
- Jede Person zählt pro Song nur einmal (Wunsch oder Like). Die Zuordnung läuft über ein anonymes Cookie, ohne Login.
- Begrenzung: 5 neue Wünsche pro Person in 15 Minuten (einstellbar)

**Admin-Panel** (`/admin`)
- Login mit Benutzername und Passwort. Das Passwort wird als gesalzener **scrypt-Hash** gespeichert, die Session-Tokens nur gehasht. Nach 5 Fehlversuchen wird der Login gebremst.
- Beliebtheits-Counter pro Song, aufgeteilt in „x× gewünscht · y ♥“
- Songs als gespielt abhaken (und den Haken wieder entfernen), Songs löschen, direkt in Spotify öffnen
- Wünsche öffnen oder schließen
- **QR-Code** als Vorschau und als Download (PNG bis 4096 px oder SVG)
- Einstellungen: Event-Name, öffentliche URL, Passwort ändern, Liste leeren

## Schnellstart

1. **Spotify-App anlegen** unter <https://developer.spotify.com/dashboard>: „Create app“, eine beliebige Redirect-URI (z. B. `http://127.0.0.1/callback`), API „Web API“ auswählen. Danach **Client ID** und **Client Secret** kopieren.
   > Spotify verlangt für Apps im Development Mode inzwischen ein Premium-Konto beim App-Besitzer. Die Songsuche nutzt nur den Client-Credentials-Flow. Gäste brauchen kein Spotify-Konto.

2. **Konfiguration anlegen:**
   ```bash
   cp .env.example .env
   ```
   In `.env` mindestens `ADMIN_PASSWORD`, `SPOTIFY_CLIENT_ID` und `SPOTIFY_CLIENT_SECRET` setzen.
   Zum Ausprobieren ohne Spotify: `DEMO_MODE=true`.

3. **Starten:**
   ```bash
   docker compose up -d --build
   ```

4. Das Admin-Panel unter `http://<server>:3000/admin` öffnen. Dort unter **QR-Code** den Code herunterladen und ausdrucken.

Nach dem ersten Start steht der Admin-Zugang verschlüsselt in der Datenbank. `ADMIN_PASSWORD` kann dann aus der `.env` gelöscht werden.

## Hosting hinter einem Reverse Proxy (empfohlen: HTTPS)

Beispiel für **Caddy**:
```
songs.example.com {
    reverse_proxy localhost:3000
}
```
Beispiel für **nginx**:
```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;            # für Live-Updates (Server-Sent Events)
}
```
Danach `PUBLIC_URL=https://songs.example.com` in der `.env` setzen (oder im Admin-Panel unter „Einstellungen“), damit der QR-Code auf die richtige Adresse zeigt.

Läuft der Proxy auf einem anderen Host oder in einem öffentlichen Netz, muss `TRUST_PROXY` angepasst werden. Der Standard vertraut nur lokalen und privaten Netzen.

## Passwort vergessen?

```bash
docker compose exec app node src/cli.js reset-password admin MeinNeuesPasswort
```

## Konfiguration (`.env`)

| Variable | Standard | Beschreibung |
|---|---|---|
| `ADMIN_USERNAME` | `admin` | Admin-Benutzer (nur beim ersten Start) |
| `ADMIN_PASSWORD` | – | Admin-Passwort, min. 8 Zeichen (nur beim ersten Start) |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | – | Spotify-App-Zugangsdaten |
| `SPOTIFY_MARKET` | `DE` | Ländermarkt für die Suche |
| `DEMO_MODE` | `false` | Beispielsongs statt Spotify |
| `EVENT_NAME` | `DJ Song Requester` | Startwert, später im Panel änderbar |
| `HOST_PORT` | `3000` | Port auf dem Host |
| `PUBLIC_URL` | automatisch | Ziel-URL des QR-Codes |
| `REQUEST_LIMIT_PER_GUEST` | `5` | Neue Wünsche pro Person … |
| `REQUEST_LIMIT_WINDOW_MINUTES` | `15` | … innerhalb dieser Minuten |
| `COOKIE_SECURE` | `auto` | `auto` / `true` / `false` |
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Express-Einstellung „trust proxy“ |

## Daten & Backup

Alle Daten liegen in einer SQLite-Datei im Docker-Volume `dj-song-requester-data` (`/data/dj-song-requester.db`).
```bash
docker compose cp app:/data/dj-song-requester.db ./backup.db
```

## Technik

Node.js 24 (Express, eingebautes `node:sqlite`, `qrcode`), Frontend ohne Framework, ein einziger Container. Für Live-Updates nutzt die App Server-Sent Events und fragt als Rückfallebene alle 20 s per Polling ab.

Lokal ohne Docker: `npm install`, dann `ADMIN_PASSWORD=… DEMO_MODE=true npm start`.
