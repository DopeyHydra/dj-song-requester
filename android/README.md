# DJ Song Requester – Android-App

Die App öffnet das Admin-Panel deines DJ Song Requester-Servers auf Handy oder Tablet (Android 8 oder neuer, Hoch- und Querformat).

- Beim ersten Start gibst du die **Server-Adresse** ein, z. B. `songs.example.com` oder `192.168.1.10:3000`. Die App prüft, ob dort ein DJ Song Requester läuft, und merkt sich die Adresse.
- Danach meldest du dich an wie im Browser, mit Benutzername und Passwort oder per Keycloak/SSO. Die Anmeldung bleibt gespeichert, bis die Session abläuft (12 Stunden).
- Im Menü oben rechts gibt es **Neu laden**, **Gästeseite öffnen** und **Server wechseln**. Server wechseln meldet dich auch ab.
- QR-Codes landen beim Herunterladen im **Download-Ordner**.
- Links zur Gästeseite oder zu Spotify öffnen sich im normalen Browser bzw. in der Spotify-App.

## Installieren

1. Die Datei `DJSongRequester.apk` aufs Gerät kopieren, z. B. per USB, Cloud oder Mail.
2. Antippen und installieren. Beim ersten Mal fragt Android, ob Apps aus dieser Quelle installiert werden dürfen. Das einmal erlauben.

Mit USB-Debugging am PC geht es auch direkt:
```bash
adb install -r DJSongRequester.apk
```

## Selbst bauen

Ein Android SDK ist nicht nötig, gebaut wird in Docker:
```bash
cd android
./build-apk.sh        # unter Windows in Git Bash
```
Das Ergebnis liegt in `android/DJSongRequester.apk`.

> **Signatur-Schlüssel sichern!** Beim ersten Build werden `release.jks` und `keystore.properties` erzeugt. Sie liegen bewusst nicht im Git-Repo. Bewahre beide Dateien gut auf, z. B. im Passwort-Manager. Ohne sie kann eine neue App-Version nicht als Update installiert werden, sondern nur nach Deinstallation der alten.

Für eine neue Version in `app/build.gradle.kts` den `versionCode` um 1 erhöhen und `versionName` anpassen, dann neu bauen.

Alternativ lässt sich der Ordner `android/` in Android Studio öffnen.
