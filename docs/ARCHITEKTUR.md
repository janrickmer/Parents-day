# ParentsDay – Architektur

ParentsDay ist eine **statische Web-App**: `index.html` + ES-Module + CSS, **ohne Build-Schritt und ohne eigenen Server**.
Sie läuft auf jedem Webspace bzw. auf GitHub Pages. Zum lokalen Testen: `npm start` (http://localhost:8080).
Optional kommt der **digitale Briefkasten** dazu: ein kleiner Cloudflare Worker, über den die Rückmeldungen der Eltern Ende-zu-Ende-verschlüsselt zur Lehrkraft gelangen (siehe unten und [`BRIEFKASTEN.md`](BRIEFKASTEN.md)). Ohne ihn (`MAILBOX_URL = ''` in `js/config.js`, so im Repository) verhält sich ParentsDay genau wie vorher.

Der Name wird immer **ParentsDay** geschrieben (großes „D“). Alle Texte sind Deutsch in der **Sie-Form**.

## Datenfluss

```
Lehrkraft (Browser, localStorage)
  │  Elternbrief-PDF: gelber Kasten (Vorname, Nachname, Code) + QR-Code/Link mit Termindaten
  │                   (+ Briefkasten-ID und öffentlicher Schlüssel, wenn der Briefkasten eingerichtet ist)
  │                   + kurzer „Termin-Schlüssel“ zum Abtippen
  ▼
Eltern (Browser)  →  markieren freie Slots  →  „Absenden“
  │
  ├─ mit digitalem Briefkasten: Rückmeldung im Browser verschlüsseln → POST an den Worker (Cloudflare, D1)
  │      → Lehrkraft-Seite holt sie beim Öffnen der Klassenübersicht/Klasse automatisch ab und entschlüsselt sie
  │
  └─ Notlösung (kein Briefkasten eingerichtet, Elternbrief ohne Briefkasten oder Briefkasten nicht erreichbar):
     Rückmelde-PDF (Daten in PDF-Metadaten) wird heruntergeladen
     + Fertig-Seite mit Knopf „E-Mail an die Lehrkraft schreiben“ (mailto:, Text enthält Block PARENTSDAY[…]),
       auf Smartphones zusätzlich „PDF teilen …“ (Web Share API, z. B. direkt in die Mail-App)
     → Lehrkraft lädt die PDFs gesammelt hoch (oder fügt E-Mail-Text ein)
  ▼
Spalte „Verfügbarkeit der Eltern“ füllt sich (beide Wege über applyResponses() in core/responses.js)
```

* **Termin-Schlüssel:** Im Elternbrief steht Version 2. In ihre Prüfsumme gehen Lehrkräftecode und Klasse ein, der Schlüssel passt also nur zu Codes dieses Briefs. Ein Tippfehler im Lehrkräftecode des Kindes oder der Schlüssel aus dem Brief eines Geschwisterkindes wird deshalb schon bei der Anmeldung gemeldet. Die Länge bleibt gleich. Ältere Schlüssel (Version 1) werden weiter gelesen.
* **Anfangsbuchstaben:** Lehrkräftecodes werden tolerant verglichen (`teacherCodesMatch()` in `codes.js`): „L“ für „Ł“ oder „l“ für „I“, wie aus dem Brief abgetippt, gelten als gleich. Das gilt bei der Anmeldung der Eltern und beim Einlesen der Rückmeldungen.
* **Elternseite:** Jeder Tab hat seinen eigenen Stand (sessionStorage). Der zuletzt gespeicherte Stand steht zusätzlich im localStorage, damit ein neuer Tab damit beginnt. Öffnen Eltern die QR-Codes zweier Geschwister in zwei Tabs, vermischen sich Auswahl, Rückmeldung und E-Mail-Adresse deshalb nicht. Nach dem Absenden stehen dort `sentVia` (`'mailbox'` oder `'email'`) und beim Briefkasten `sentAt` (Annahme durch den Dienst) – siehe Kommentar zu ParentState in `core/storage.js`.
* **Link-Daten** (`?e=`) gelten nur mit denselben Grenzen wie auf der Lehrkraft-Seite (1–8 Tage, Terminlänge in 5-Minuten-Schritten). Eine E-Mail-Adresse aus dem Link wird nur übernommen, wenn sie gültig ist. Im mailto-Link wird der Empfänger kodiert.

## Digitaler Briefkasten

| Teil | Aufgabe |
|---|---|
| `worker/briefkasten.js` | Cloudflare Worker + D1-Datenbank (Bindung `DB`). Nimmt verschlüsselte Rückmeldungen an, gibt sie nur mit dem Geheimnis der Lehrkraft heraus bzw. löscht sie (`DELETE …?before=<ms>`: nur bis zur zuletzt abgeholten), hält Verzeichniseinträge für den Termin-Schlüssel (`GET` ohne Eintrag: `200 { found: false }`, kein 404). Schnittstelle im Kopfkommentar. **200 Tage:** Ältere Rückmeldungen und Verzeichniseinträge gibt er nicht mehr heraus; ein täglicher Cron-Trigger (`scheduled()`, `[triggers]` in `worker/wrangler.toml`) löscht sie mit einem Tag Vorlauf, zusätzlich bei etwa 2 % der Einwürfe. Ein Verzeichniseintrag gehört dem Briefkasten, der ihn angelegt hat (sonst 409), bis er 200 Tage nicht erneuert wurde. Einrichtung: [`BRIEFKASTEN.md`](BRIEFKASTEN.md), per Kommandozeile mit `worker/wrangler.toml`. |
| `js/core/mailbox.js` | Browser-Seite: `mailboxEnabled()`, Schlüssel erzeugen (`createTeacherMailbox()`), verschlüsseln (ECDH P-256 → HKDF → AES-GCM), `sendToMailbox()`, `fetchFromMailbox()` (liefert auch `newest`, den Eingang der neuesten Nachricht), `clearMailbox(mb, { upTo })`, `checkMailboxService()`, Verzeichnis (`publishDirectoryEntry()`, `lookupDirectoryEntry()`). Fehler als `MailboxError` mit deutscher Meldung (`status`, `offline`). |
| `js/core/teacher-mailbox.js` | Lehrkraft-Sicht auf den gespeicherten Zustand: `hasTeacherMailbox()`, `ensureTeacherMailbox()` (beim ersten Erstellen von Elternbriefen), `publishClassDirectory()`, `fetchMailboxResponses()` (holt ab und übernimmt wie beim Hochladen – aber nichts, wenn inzwischen eine andere Lehrkraft angemeldet ist oder der Briefkasten gewechselt hat), `clearTeacherMailbox({ upTo })`. |

Ablauf:

1. **Anlegen:** Beim ersten „Elternschreiben für diese Klasse erstellen“ entsteht im Browser der Lehrkraft ein Briefkasten (`state.mailbox`): Geheimnis, daraus die Briefkasten-ID, und ein Schlüsselpaar. Nach außen geht dabei nichts. Der Link im QR-Code enthält zusätzlich `b` (Briefkasten-ID) und `p` (öffentlicher Schlüssel) – nie Geheimnis oder privaten Schlüssel.
2. **Termin-Schlüssel-Weg:** Für jede Klasse legt die Lehrkraft einen Verzeichniseintrag ab (Inhalt wie der Link-Parameter `e=`). ID und AES-Schlüssel ergeben sich aus Lehrkräftecode, Klasse und Termin-Schlüssel. Eltern ohne QR-Code finden darüber Lehrkraft, Schule und Briefkasten.
3. **Absenden:** Der Browser der Eltern verschlüsselt die Rückmeldung (`buildResponsePayload()`) mit einem Einmal-Schlüssel für den öffentlichen Schlüssel der Lehrkraft und wirft sie ein. Klappt das nicht, bleibt der Weg per PDF/E-Mail.
4. **Abholen:** `components/response-import.js` ruft beim Einbinden (Klassenübersicht, Klasse) höchstens alle 30 s je Tab ab, außerdem per Knopf „Neue Rückmeldungen abrufen“. Neuere Rückmeldungen ersetzen ältere. `state.mailbox.lastFetchedAt` hält den letzten erfolgreichen Abruf fest.
5. **Einstellungen** (`teacher-event.js`, Karte „Digitaler Briefkasten“): Zustand (aktiv seit, zuletzt abgerufen), „Verbindung prüfen“ (`checkMailboxService()`), „Briefkasten leeren“ (holt vorher neue Rückmeldungen ab, dann `clearTeacherMailbox({ upTo: newest })` – Rückmeldungen, die währenddessen eingehen, bleiben liegen; passen Rückmeldungen zu keinem Kind in ParentsDay, fragt ein zweiter Dialog nach, weil sie danach nirgends mehr stünden). „Alle Daten in diesem Browser löschen“ holt vorher ab (neue Rückmeldungen stehen in keinem früher gespeicherten Zwischenstand – dann fragt ein zweiter Dialog mit Knopf „Zwischenstand jetzt speichern“ nach) und leert den Briefkasten. Scheitert Abruf oder Leeren, werden die Daten im Browser trotzdem gelöscht; der Briefkasten bleibt dann unverändert.
6. **Zwischenstand laden** (`components/backup-actions.js`): Enthält die Datei keinen Briefkasten (z. B. von vor dem ersten Elternbrief), bleibt der Briefkasten des Browsers erhalten – sonst wären Geheimnis und privater Schlüssel verloren. Enthält sie einen anderen, gilt der aus der Datei; der Dialog warnt vorher und bietet „Aktuellen Stand speichern“ an.
7. **Texte:** Startseite, Anmeldung/Registrierung (samt Registrierungs-PDF), Datenschutz-Hinweise und die Seiten der Lehrkraft beschreiben den Briefkasten nur, wenn `mailboxEnabled()` gilt; ohne ihn bleibt es bei „ParentsDay hat keinen Server“.

Voraussetzungen im Code: `MAILBOX_URL` in `js/config.js` und dieselbe Adresse bei `connect-src` der Content-Security-Policy in `index.html` (prüft `tests/unit/config.test.mjs`). Der Worker erlaubt Anfragen aus dem Browser nur von den Adressen in `ALLOWED_ORIGINS` (Standard: `https://parentsday.janrickmer.de`).

Tests: `tests/e2e/mailbox-server.mjs` startet den echten Worker lokal (D1-Nachbildung mit `node:sqlite`); `startServer({ mailboxUrl })` aus `tests/e2e/helpers.mjs` liefert die Seite so aus, als wäre `MAILBOX_URL` gesetzt. Unit-Tests: `tests/unit/mailbox.test.mjs` (auch 200-Tage-Regel, Cron, `?before`); Browser-Tests: `tests/e2e/*mailbox*.test.mjs`, darunter `full-flow-mailbox.test.mjs` (Gesamtablauf von der Registrierung über Briefkasten und Notlösung bis zum Zwischenstand auf einem neuen Gerät) und `mailbox-robustness.test.mjs` (Zwischenstand laden, Leeren während eines Einwurfs, Lehrkraft-Wechsel während eines Abrufs, Doppelklick auf Dialoge).

## Verzeichnisse

| Pfad | Inhalt |
|---|---|
| `index.html` | Einstieg, bindet `css/base.css`, alle `css/views/*.css` und `js/app.js` ein |
| `js/app.js` | Hash-Router, Seitenrahmen (Kopf-/Fußzeile), Zwischenspeicher-Knöpfe, Abmelden |
| `js/config.js` | `PUBLIC_URL` (https://parentsday.janrickmer.de), `MAILBOX_URL` (digitaler Briefkasten, leer = aus), `APP_NAME`, `DATA_VERSION`, gemeinsame Grenzen (Tage, Terminlänge, Adresse, Dateigrößen) |
| `js/core/codes.js` | Registrierungs-, Lehrkräfte-, Schülercode, Zahlencode, Eltern-Login-Prüfung |
| `js/core/time.js` | Datum/Uhrzeit, Slots, Zeitspannen, Terminfarbe (`availabilityStatus`) |
| `js/core/storage.js` | Datenmodell + localStorage (Lehrkraft-Zustand, Sitzung, Eltern-Zustand) |
| `js/core/transport.js` | Elternbrief-Link, Termin-Schlüssel, Rückmelde-Payload, PDF-Datenblock |
| `js/core/pdf.js` | jsPDF laden, Schrift einbetten, Kopfzeile, Absatz, gelber Kasten, Tabelle, QR, Daten ein-/auslesen, speichern, drucken |
| `js/core/ui.js` | `h()`, `mount()`, `toast()`, `modal()`, `confirmDialog()`, `fileDropZone()`, `field()`, `alertBox()` … |
| `js/core/backup.js` | Zwischenspeicher-Datei schreiben/lesen (prüft Größe, Inhalt und ob die Datei zur angemeldeten Lehrkraft gehört) |
| `js/core/responses.js` | Rückmelde-PDFs lesen und in den Zustand übernehmen |
| `js/core/mailbox.js` | digitaler Briefkasten: Verschlüsselung und Verbindung zum Worker |
| `js/core/teacher-mailbox.js` | digitaler Briefkasten der angemeldeten Lehrkraft: anlegen, Verzeichnis, abrufen, leeren |
| `worker/` | Briefkasten-Dienst für Cloudflare (`briefkasten.js`, `wrangler.toml`) – gehört nicht zur Web-App, sondern wird bei Cloudflare eingerichtet |
| `js/components/` | wiederverwendbare Bausteine (`calendar-picker.js`, `response-import.js`, `backup-actions.js` für „Zwischenstand speichern/laden“) |
| `404.html` | GitHub Pages liefert sie für unbekannte Pfade (z. B. `/eltern`) und leitet auf die Hash-Adresse (`/#/eltern`) weiter |
| `js/views/` | eine Datei pro Seite (siehe Routen) |
| `js/pdf/` | eine Datei pro PDF-Art |
| `css/base.css` | Farben (CSS-Variablen), Buttons, Formulare, Tabellen, Kacheln, Badges, Hinweise, Dialoge |
| `css/views/*.css` | seitenspezifisches CSS, immer mit Präfix-Klasse der Seite |
| `vendor/` | jsPDF 4.2.1 (UMD), qrcode-generator 2.0.4 (ESM) – lokal, kein CDN |
| `fonts/` | Liberation Sans (SIL OFL 1.1) für PDFs |
| `tests/unit/` | `node --test` für Kernlogik (`npm test`) |
| `tests/e2e/` | Browser-Tests mit Playwright/Chromium (`npm run test:e2e`), Hilfen in `helpers.mjs`, lokaler Briefkasten in `mailbox-server.mjs` |
| `docs/` | `ARCHITEKTUR.md`, `ANFORDERUNGEN.md`, `BRIEFKASTEN.md` (Einrichtung des Briefkastens für Betreiber) |

## Routen und Views

Jede View ist ein ES-Modul: `export default async function render(ctx)`, optional mit Rückgabe einer Aufräumfunktion.

`ctx = { root, params, query, state, navigate(path, {replace}), rerender(), setTitle(title) }`

* `root` – das `<main>`-Element, in das die View rendert (`mount(root, …)`)
* `state` – bei Lehrkraft-Routen der aktuelle TeacherState (Kopie aus localStorage), sonst `null`
* Änderungen immer über `updateState(s => { … })` aus `core/storage.js` speichern (speichert sofort in localStorage, aktualisiert die „Automatisch gespeichert“-Anzeige). Danach bei Bedarf neu zeichnen oder `ctx.rerender()` aufrufen.
* Kann der Browser nicht speichern (Speicher voll oder gesperrt), wirft `updateState()` bzw. `saveTeacherState()` einen Fehler mit der Meldung `STORAGE_FULL`. Die Anzeige „Automatisch gespeichert“ wird dann nicht aktualisiert. Aufrufer zeigen die Meldung an und dürfen keinen Erfolg melden.
* Ungespeicherte Eingaben auf „Elternsprechtag erstellen“ bzw. „Weitere Einstellungen“ liegen als Entwurf im localStorage (`storeEventDraft()`) und sind auch nach dem Schließen des Browsers bzw. beim nächsten Einloggen wieder da. Solange es sie gibt, zeigt die Kopfzeile „noch nicht gespeichert“ (`setDraftPending()`).

| Hash-Route | View | params |
|---|---|---|
| `#/` | `start.js` | – |
| `#/datenschutz` | `privacy.js` | – |
| `#/lehrkraft` | `teacher-auth.js` | `mode: 'choose'` |
| `#/lehrkraft/registrieren` | `teacher-auth.js` | `mode: 'register'` |
| `#/lehrkraft/anmelden` | `teacher-auth.js` | `mode: 'login'` |
| `#/lehrkraft/elternsprechtag` | `teacher-event.js` | `mode: 'create'` (Anmeldung nötig) |
| `#/lehrkraft/einstellungen` | `teacher-event.js` | `mode: 'settings'` („Weitere Einstellungen“) |
| `#/lehrkraft/klassen` | `teacher-classes.js` | – |
| `#/lehrkraft/klasse/5a` | `teacher-class.js` | `classId: '5a'` |
| `#/lehrkraft/klasse/5a/terminieren` | `teacher-schedule.js` | `classId: '5a'` |
| `#/eltern` (optional `?e=<Daten>`) | `parent.js` | `step: 'login'` |
| `#/eltern/zeiten` | `parent.js` | `step: 'times'` |
| `#/eltern/fertig` | `parent.js` | `step: 'done'` – zwei Varianten nach `sentVia` im Elternzustand: `'mailbox'` „Vielen Dank! … angekommen“ (nichts mehr zu tun, Beleg als PDF), `'email'` „Fast geschafft“ (PDF heruntergeladen, E-Mail an die Lehrkraft) |

Lehrkraft-Routen ohne Anmeldung leiten automatisch auf `#/lehrkraft/anmelden` um. Nach der Anmeldung geht es auf der zuvor aufgerufenen Seite weiter (`setReturnTo()`/`takeReturnTo()` in `storage.js`).
Groß-/Kleinschreibung und ein Schrägstrich am Ende spielen keine Rolle (`#/lehrkraft/klasse/5A/`). Unbekannte Adressen zeigen „Seite nicht gefunden“ statt still auf die Startseite umzuleiten.
Nach jedem Seitenwechsel liegt der Fokus auf der Überschrift `h1`, und eine `aria-live`-Region sagt den Seitentitel an. Das gilt nicht, wenn die Seite den Fokus selbst setzt.
Kann eine Seite nicht geladen werden, etwa bei fehlender Internetverbindung, erscheint eine deutsche Meldung mit dem Knopf „Seite neu laden“.

## Datenmodell (TeacherState)

Siehe Kommentar in `js/core/storage.js`. Kurzfassung:

```js
{
  app: 'ParentsDay', type: 'teacher-state', version: 1, savedAt,
  teacher: { firstName, lastName, birthDate: 'JJJJ-MM-TT', email, registrationCode, teacherCode },
  event: null | { schoolAddress, slotMinutes, days: [{ date, start: 'HH:MM', end: 'HH:MM' }] },
  classes: [{ id: '5a', grade: 5, letter: 'a', codesGenerated, students: [{
    id, lastName, firstName, code,
    response: null | { submittedAt, availability: { 'JJJJ-MM-TT': [['HH:MM','HH:MM'], …] } },
    appointment: null | { date, start: 'HH:MM', duration }
  }] }],
  mailbox: null | { v: 1, id, secret, publicKey, privateKey: JWK, createdAt, lastFetchedAt? }  // digitaler Briefkasten
}
```

`mailbox` enthält das Geheimnis und den privaten Schlüssel des Briefkastens. Sie stehen nur im localStorage und im Zwischenspeicher, nie im Link oder QR-Code. Ungültige Angaben verwirft `normalizeTeacherState()`.

Der Zwischenspeicher (`Zwischenspeicher vom TT.MM.JJJJ um hh꞉mm für ParentsDay.json`) ist dieser Zustand als JSON. Gibt es ungespeicherte Eingaben zum Elternsprechtag, enthält er sie zusätzlich im Feld `eventDraft: { days, address, slot, email }`. Beim Laden werden sie wiederhergestellt.
Beim Laden prüft `readBackupFile()` Größe (höchstens 10 MB) und Inhalt und vergleicht Lehrkräftecode, Namen und Geburtsdatum mit der angemeldeten Lehrkraft. `normalizeTeacherState()` verwirft ungültige Einträge: Tage ohne gültiges Datum, Terminlängen außerhalb von 5–120 Minuten, kaputte Verfügbarkeiten, Klassen außerhalb von 1–13/a–h und doppelte IDs.
Nach dem Laden geht es mit Elternsprechtag bei den Klassen weiter, sonst beim Erstellen des Elternsprechtags.

## Eingebettete Daten

| Art | `type` | Felder |
|---|---|---|
| Registrierungs-PDF | `teacher-registration` | `app:'ParentsDay', v:1, firstName, lastName, birthDate, email, registrationCode, teacherCode, createdAt` |
| Rückmelde-PDF / E-Mail-Block | `parent-response` | siehe `buildResponsePayload()` in `transport.js` |
| Elternbriefe-PDF | `parent-letters` | `app, v:1, classId, count, createdAt` (nur zur Erkennung bei versehentlichem Hochladen) |
| Termin-PDF | `appointments` | `app, v:1, classId, count, createdAt` (nur zur Erkennung bei versehentlichem Hochladen) |

PDF-Daten stehen im Metadatenfeld „Betreff“ als `PARENTSDAY1.<base64url-JSON>` (`embedPayload()` / `extractPayloadFromFile()` in `core/pdf.js`).

Der Elternbrief-Link (`?e=<base64url-JSON>`, `compactEvent()` in `core/transport.js`) enthält `v` (Version), `n` (Lehrkraft), `m` (E-Mail), `t` (Lehrkräftecode), `a` (Adresse), `s` (Terminlänge), `d` (Tage), `k` (Klasse) und mit Briefkasten zusätzlich `b` (Briefkasten-ID) und `p` (öffentlicher Schlüssel). Dieselbe Rückmeldung (`parent-response`) geht mit Briefkasten verschlüsselt an den Worker (`{ v:1, epk, iv, ct }`).

## Gestaltungsregeln

* Nur Bausteine aus `css/base.css` verwenden (`.card`, `.btn .btn-primary|secondary|ghost|danger|success`, `.btn-large|small`, `.field`, `.form-grid`, `.table-wrap > .table`, `.tiles > .tile`, `.badge-*`, `.alert-*`, `.dropzone`, `.page-header`, `.stack`, `.cluster`, `.code`, `.legend`).
* Farben nur über CSS-Variablen (`--c-available` grün, `--c-appt-ok` blau, `--c-appt-partial` orange, `--c-appt-unavailable` rot …).
* Seitenspezifisches CSS nur in der eigenen Datei `css/views/<view>.css`, Klassen mit eigenem Präfix (z. B. `.sched-…`).
* Wichtige Bedienelemente bekommen `data-testid`-Attribute (siehe unten), damit Browser-Tests stabil bleiben.
* `index.html` setzt eine strenge Content-Security-Policy (`script-src 'self'; style-src 'self'`, keine Inline-Stile). Stile im Code deshalb nur als Objekt an `h()` übergeben (`style: { display: 'none' }`), nie als Text. Verbindungen erlaubt `connect-src` nur zur eigenen Seite und – falls eingerichtet – zum digitalen Briefkasten.
* Alles zum digitalen Briefkasten erscheint nur, wenn `mailboxEnabled()` gilt. Bei leerem `MAILBOX_URL` sehen Seiten und Texte genau so aus wie ohne Briefkasten.
* Dialoge (`modal()`) halten den Tastaturfokus fest. Solange ein Dialog offen ist, ist `#app` `inert`. Der zweite Klick eines Doppelklicks (`event.detail > 1`) schließt einen Dialog nicht und löst keinen seiner Knöpfe aus. Toasts lassen sich mit × schließen. Steht eine Meldung schon auf der Seite, zeigt ParentsDay dazu keinen Toast mehr.
* Begriffe: „Elternbrief“ (nur der vorgegebene Knopf heißt „Elternschreiben für diese Klasse erstellen“), „Terminlänge“, „Zeitslot“. Meldungen immer in der Sie-Form („Bitte geben Sie … ein.“).
* Mobilgeräte: Elternseiten zuerst für Smartphones gestalten, Lehrkräfte-Seiten müssen auf Tablets bedienbar sein (Drag & Drop mit Pointer-Events, nicht mit HTML5-Drag-and-Drop).

## Verbindliche `data-testid`-Werte

| Bereich | testids |
|---|---|
| Start | `start-teacher`, `start-parent` |
| Registrierung | `auth-choose-register`, `auth-choose-login`, `reg-firstname`, `reg-lastname`, `reg-birthdate`, `reg-email`, `reg-submit`, `reg-download`, `reg-continue`, `reg-registration-code`, `reg-teacher-code` |
| Anmeldung | `login-upload` (Dropzone), `login-firstname`, `login-lastname`, `login-birthdate`, `login-code`, `login-submit` |
| Elternsprechtag | `event-calendar` (Tage als Buttons mit `data-date="JJJJ-MM-TT"`), `event-calendar-next`, `event-calendar-prev`, `event-day-start-<datum>`, `event-day-end-<datum>`, `event-address`, `event-slot`, `event-email`, `event-submit` |
| Klassen | `class-grade`, `class-letter`, `class-create`, `class-tile-<id>` |
| Klasse | `student-row` (tr), darin `student-lastname`, `student-firstname`, `student-code`, `student-availability`; `add-student`, `primary-action`, `schedule-link`, `delete-class` |
| Kopfzeile/Allgemein | `save-indicator`, `backup-upload` (Dropzone im Dialog „Zwischenstand laden“), `empty-device-load`, `route-announcer`, `notfound-classes` |
| Rückmeldungen | `response-upload` (Dropzone), `response-paste`, `response-report` |
| Terminieren | `schedule-student-<studentId>` (Chip), `schedule-day-<datum>` (Tagesspalte), `appointment-<studentId>` (Block mit `data-status="ok|partial|unavailable|unknown"`), `appointment-duration-<studentId>`, `schedule-finalize` |
| Eltern | `parent-firstname`, `parent-lastname`, `parent-code`, `parent-key` (nur im Formular, wenn der Schlüssel gebraucht wird), `parent-login`, `parent-other-key`, `parent-continue` („Weiter“ zu den Zeiten, wenn schon angemeldet), `parent-switch`, `slot-<datum>-<HH:MM>` (Button mit `aria-pressed`), `parent-submit`, `parent-download`, `parent-mailto`, `parent-share`, `parent-teacher-email` |
| Briefkasten bei den Rückmeldungen | `mailbox-section`, `mailbox-fetch` („Neue Rückmeldungen abrufen“), `mailbox-last`, `mailbox-note`, `mailbox-retry`, `mailbox-setup-hint`; nach dem Erstellen der Elternbriefe `letters-mailbox-note`, `letters-directory-note` |
| Eltern mit Briefkasten | `parent-sent-ok` (Fertig-Seite „angekommen“), `parent-retry` („Erneut versuchen“), `parent-fallback` („Stattdessen per E-Mail senden“), `parent-logout` |
| Briefkasten in „Weitere Einstellungen“ | `mailbox-card`, darin `mailbox-pending` (noch nicht eingerichtet), `mailbox-since`, `mailbox-fetched`, `mailbox-check`, `mailbox-clear`, `mailbox-status`; `mailbox-unmatched` (Rückfrage vor dem Leeren); `delete-all-mailbox-note` (Hinweis im Dialog „Alle Daten … löschen“), `delete-all-new-responses` (Rückfrage bei neuen Rückmeldungen) |
| Datenschutz/Start | `privacy-mailbox` (Abschnitt „Digitaler Briefkasten“, nur mit Briefkasten), `start-privacy` (Datenschutz-Zeile der Startseite) |
