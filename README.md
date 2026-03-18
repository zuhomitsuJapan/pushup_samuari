# PushUp Live Pro – Android Edition

Erweiterte Web-App für gemeinsames Push-Up-Tracking mit:

- Live Sync ohne Reload via Socket.IO
- Push Notifications im Browser via Web Push
- Streak-System (aktuelle und beste Serie)
- mobile UI im Fitness-App Stil
- privates Leaderboard pro Team
- Login mit Benutzername/Passwort
- optionaler Login mit Google
- Excel-Export `.xlsx`
- SQLite lokal, PostgreSQL online

Diese Version wurde für euch vereinfacht:
- Apple Login wurde komplett entfernt
- Fokus auf Android + Web
- weniger Setup, weniger Fehlerquellen

## Start lokal

```bash
npm install
npm start
```

Danach im Browser öffnen:

```text
http://localhost:3000
```

## Render / Railway

Diese Version ist deploy-fähig. Für einen vollständigen Deploy solltest du folgende Variablen setzen:

### Pflicht

- `SESSION_SECRET`

### Für Push Notifications

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (z. B. `mailto:deine-mail@example.com`)

VAPID Keys erzeugen, z. B. mit Node:

```bash
node -e "const webpush=require('web-push'); console.log(webpush.generateVAPIDKeys())"
```

### Für Google Login

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL`

Beispiel Callback:

```text
https://deine-app.onrender.com/auth/google/callback
```

## Wichtige Hinweise

- Google Login erscheint nur, wenn die entsprechenden Umgebungsvariablen gesetzt sind.
- Push Notifications funktionieren erst nach VAPID-Konfiguration und Browser-Erlaubnis.
- Das private Leaderboard ist standardmäßig auf `private` gesetzt und nur für Team-Mitglieder sichtbar.
- Für zwei Personen auf Android reicht in der Praxis meist Benutzername/Passwort plus gemeinsamer Team-Code.
