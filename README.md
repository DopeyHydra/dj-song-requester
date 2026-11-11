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

## Installation auf einem Server

Der Quellcode wird auf dem Server nicht gebraucht. Das fertige Image liegt auf Docker Hub als [`dopeyhydra/dj_song_requester`](https://hub.docker.com/r/dopeyhydra/dj_song_requester). Es läuft auf x86/amd64, also nicht auf ARM-Geräten wie dem Raspberry Pi.

**1. Ordner anlegen und die beiden Dateien herunterladen**
```bash
mkdir -p ~/dj-song-requester && cd ~/dj-song-requester
curl -fsSLO https://raw.githubusercontent.com/DopeyHydra/dj-song-requester/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/DopeyHydra/dj-song-requester/main/.env.example -o .env
```

**2. `.env` anpassen**
```bash
openssl rand -base64 12   # erzeugt ein sicheres Passwort
nano .env
```
- `ADMIN_PASSWORD` setzen (mindestens 8 Zeichen).
- `PUBLIC_URL` auf die Adresse setzen, unter der Gäste die Seite erreichen, z. B. `https://songs.example.com` oder `http://<server-ip>:3000`. Daraus wird der QR-Code erzeugt.
- Für die Songsuche `SPOTIFY_CLIENT_ID` und `SPOTIFY_CLIENT_SECRET` eintragen (siehe unten). Ohne Spotify zum Ausprobieren: `DEMO_MODE=true`.

**3. Starten**
```bash
docker compose pull
docker compose up -d
docker compose logs
```
In den Logs sollten `Admin "admin" angelegt` und `DJ Song Requester läuft auf Port 3000` stehen.

**4. Loslegen**
Das Admin-Panel unter `http://<server>:3000/admin` öffnen. Dort unter **QR-Code** den Code herunterladen und ausdrucken.

Nach dem ersten Start steht der Admin-Zugang verschlüsselt in der Datenbank. `ADMIN_PASSWORD` kann dann aus der `.env` gelöscht werden.

### Spotify-Zugangsdaten

1. Auf <https://developer.spotify.com/dashboard> eine App anlegen („Create app“).
2. Als Redirect-URI `http://127.0.0.1/callback` eintragen. Sie wird nicht benutzt, ist aber Pflicht.
3. Bei der API „Web API“ anhaken.
4. **Client ID** und **Client Secret** in die `.env` kopieren und `DEMO_MODE=false` setzen.
5. Mit `docker compose up -d` neu starten.

> Spotify verlangt für Apps im Development Mode ein Premium-Konto beim App-Besitzer. Die Songsuche nutzt nur den Client-Credentials-Flow, Gäste brauchen also kein Spotify-Konto.

## Update

```bash
docker compose pull
docker compose up -d
```
Wünsche, Likes und der Admin-Zugang bleiben dabei im Volume erhalten.

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

## Entwicklung

Aus dem Quellcode bauen und starten. `docker-compose.build.yml` ergänzt dafür nur `build: .`:
```bash
git clone https://github.com/DopeyHydra/dj-song-requester.git
cd dj-song-requester
cp .env.example .env      # ADMIN_PASSWORD setzen, ggf. DEMO_MODE=true
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

Ein neues Image auf Docker Hub veröffentlichen:
```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml build
docker compose push
```

Ohne Docker: `npm install`, dann `ADMIN_PASSWORD=… DEMO_MODE=true npm start`. Dafür ist Node.js 22.13 oder neuer nötig.
