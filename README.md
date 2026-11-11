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
- Optional **Single Sign-On per OpenID Connect**, z. B. mit Keycloak. Freigabe über eine Rolle oder einzelne Benutzer, Abmeldung auch beim Identity Provider ([Anleitung](#anmeldung-mit-keycloak-oidc)).
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

## Anmeldung mit Keycloak (OIDC)

Statt mit Benutzername und Passwort kannst du dich am Admin-Panel über Keycloak anmelden. Andere OIDC-Anbieter (Authentik, Authelia, Zitadel, Entra ID …) funktionieren genauso. Nur die Menüs heißen dort anders.

In den Beispielen unten gilt:
- `https://songs.example.com` ist die Adresse des DJ Song Requesters.
- `https://auth.example.com` ist dein Keycloak, `meinrealm` dein Realm.

### 1. Client in Keycloak anlegen

Keycloak-Admin-Konsole → deinen Realm auswählen → **Clients** → **Create client**

| Schritt | Feld | Wert |
|---|---|---|
| General settings | Client type | `OpenID Connect` |
| | Client ID | `dj-song-requester` |
| Capability config | Client authentication | **On** |
| | Authorization | Off |
| | Authentication flow | nur **Standard flow** anhaken (Direct access grants, Implicit flow usw. aus) |
| Login settings | Root URL | `https://songs.example.com` |
| | Valid redirect URIs | `https://songs.example.com/api/admin/oidc/callback` |
| | Valid post logout redirect URIs | `https://songs.example.com/admin/*` |
| | Web origins | leer lassen |

Danach **Save**.

- Im Tab **Credentials** das **Client secret** kopieren.
- Optional, aber empfohlen: im Tab **Advanced** unter „Advanced settings“ die Option **Proof Key for Code Exchange Code Challenge Method** auf `S256` stellen. Die App nutzt PKCE ohnehin.

> Rufst du das Admin-Panel auch über eine andere Adresse auf (z. B. `http://192.168.1.10:3000`), trag diese zusätzlich bei den Redirect-URIs ein. Die Callback-URL ergibt sich immer aus der Adresse, über die du das Panel öffnest.

### 2. Rolle anlegen und zuweisen

1. **Realm roles** → **Create role** → Role name: `dj-admin` → Save.
2. **Users** → deinen Benutzer öffnen → Tab **Role mapping** → **Assign role**.
3. Oben links den Filter auf **Filter by realm roles** stellen, `dj-admin` anhaken → **Assign**.

Mehrere DJs: Leg eine Gruppe an (z. B. „DJs“), gib der Gruppe unter *Role mapping* die Rolle `dj-admin` und füge die Benutzer zur Gruppe hinzu.

Lieber eine **Client-Rolle**? Leg die Rolle unter *Clients → dj-song-requester → Roles* an und setze in der `.env` `OIDC_ROLES_CLAIM=resource_access.dj-song-requester.roles`.

### 3. `.env` ergänzen

```env
OIDC_ISSUER=https://auth.example.com/realms/meinrealm
OIDC_CLIENT_ID=dj-song-requester
OIDC_CLIENT_SECRET=<Client secret aus dem Tab Credentials>
OIDC_ALLOWED_ROLES=dj-admin
OIDC_BUTTON_LABEL=Mit Keycloak anmelden
```

Dann neu starten mit `docker compose up -d`. Auf der Login-Seite erscheint jetzt der Button „Mit Keycloak anmelden“.

- **Den Issuer findest du so:** Öffne `<OIDC_ISSUER>/.well-known/openid-configuration` im Browser. Wenn JSON kommt, stimmt die Adresse. Bei sehr alten Keycloak-Versionen (vor 17) steht noch `/auth` im Pfad: `https://auth.example.com/auth/realms/meinrealm`.
- **Der Container muss Keycloak unter genau dieser Adresse erreichen.** Laufen beide auf demselben Server, darf die Domain also nicht nur von außen auflösbar sein. Testen kannst du das mit `docker compose exec app node -e "fetch(process.env.OIDC_ISSUER+'/.well-known/openid-configuration').then(r=>console.log(r.status))"`. Das sollte `200` ausgeben.
- **Nur noch SSO:** Wenn der Keycloak-Login funktioniert, kannst du den Passwort-Login mit `PASSWORD_LOGIN=false` abschalten. `ADMIN_PASSWORD` wird dann nicht mehr gebraucht.
- **Statt einer Rolle** kannst du auch einzelne Benutzer freigeben: `OIDC_ALLOWED_USERS=anna,ben@example.com`. Verglichen werden Benutzername und E-Mail.
- **Ohne jede Einschränkung** (jeder Benutzer des Realms darf rein) startet die App nur, wenn du das ausdrücklich mit `OIDC_ALLOW_ALL_USERS=true` erlaubst.

### Fehlersuche

Die genaue Ursache steht immer im Log (`docker compose logs app`).

| Meldung im Panel | Ursache |
|---|---|
| „Dein Konto hat keine Berechtigung …“ | Dem Benutzer fehlt die Rolle aus `OIDC_ALLOWED_ROLES`, oder `OIDC_ROLES_CLAIM` zeigt auf die falsche Stelle (Realm- vs. Client-Rolle). Neu anmelden, nachdem die Rolle zugewiesen wurde. |
| „Der Anmeldedienst ist gerade nicht erreichbar.“ | Der Container erreicht `OIDC_ISSUER` nicht, oder die Adresse ist falsch (siehe Test oben). |
| Keycloak zeigt „Invalid parameter: redirect_uri“ | Die Callback-URL fehlt unter *Valid redirect URIs*. Hinter einem Reverse Proxy muss außerdem `X-Forwarded-Proto` gesetzt sein, sonst entsteht `http://` statt `https://`. Notfalls `OIDC_REDIRECT_URI` fest setzen. |
| „Die Antwort des Anmeldedienstes war ungültig.“ | Meist ein falsches `OIDC_CLIENT_SECRET` oder ein Issuer mit abweichender Schreibweise. |
| Nach dem Abmelden bleibt Keycloak auf einer Fehlerseite | `https://songs.example.com/admin/*` fehlt unter *Valid post logout redirect URIs*. |

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
| `OIDC_ISSUER` | – | Realm-URL des Identity Providers. Schaltet OIDC ein. |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | – | Client-Zugangsdaten. Ohne Secret wird ein Public Client mit PKCE angenommen. |
| `OIDC_ALLOWED_ROLES` | – | Rollen mit Zugriff (Komma-getrennt) |
| `OIDC_ALLOWED_USERS` | – | Benutzernamen/E-Mails mit Zugriff (Komma-getrennt) |
| `OIDC_ALLOW_ALL_USERS` | `false` | Jeder Benutzer des Realms darf ins Panel |
| `OIDC_ROLES_CLAIM` | `realm_access.roles` | Pfad der Rollen im Token |
| `OIDC_SCOPES` | `openid profile email` | Angeforderte Scopes |
| `OIDC_BUTTON_LABEL` | `Mit SSO anmelden` | Beschriftung des Login-Buttons |
| `OIDC_REDIRECT_URI` | automatisch | Feste Callback-URL |
| `PASSWORD_LOGIN` | `true` | `false` = nur OIDC-Login |

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
docker push dopeyhydra/dj_song_requester:latest
```

Ohne Docker: `npm install`, dann `ADMIN_PASSWORD=… DEMO_MODE=true npm start`. Dafür ist Node.js 22.13 oder neuer nötig.
