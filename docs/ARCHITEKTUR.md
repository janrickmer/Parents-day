# ParentsDay – Architektur

ParentsDay ist eine **statische Web-App**: `index.html` + ES-Module + CSS, **ohne Build-Schritt und ohne Server**.
Sie läuft auf jedem Webspace bzw. auf GitHub Pages. Zum lokalen Testen: `npm start` (http://localhost:8080).

Der Name wird immer **ParentsDay** geschrieben (großes „D“). Alle Texte sind Deutsch in der **Sie-Form**.

## Datenfluss ohne Server

```
Lehrkraft (Browser, localStorage)
  │  Elternbrief-PDF: gelber Kasten (Vorname, Nachname, Code) + QR-Code/Link mit Termindaten
  │                   + kurzer „Termin-Schlüssel“ zum Abtippen
  ▼
Eltern (Browser)  →  markieren freie Slots  →  „Absenden“
  │  Rückmelde-PDF (Daten in PDF-Metadaten) wird heruntergeladen
  │  + Fertig-Seite mit Knopf „E-Mail an die Lehrkraft schreiben“ (mailto:, Text enthält Block PARENTSDAY[…]),
  │    auf Smartphones zusätzlich „PDF teilen …“ (Web Share API, z. B. direkt in die Mail-App)
  ▼
Lehrkraft lädt die PDFs gesammelt hoch (oder fügt E-Mail-Text ein) → Spalte „Verfügbarkeit“ füllt sich
```

## Verzeichnisse

| Pfad | Inhalt |
|---|---|
| `index.html` | Einstieg, bindet `css/base.css`, alle `css/views/*.css` und `js/app.js` ein |
| `js/app.js` | Hash-Router, Seitenrahmen (Kopf-/Fußzeile), Zwischenspeicher-Knöpfe, Abmelden |
| `js/config.js` | `PUBLIC_URL` (https://parents-day.janrickmer.de), `APP_NAME`, `DATA_VERSION` |
| `js/core/codes.js` | Registrierungs-, Lehrkräfte-, Schülercode, Zahlencode, Eltern-Login-Prüfung |
| `js/core/time.js` | Datum/Uhrzeit, Slots, Zeitspannen, Terminfarbe (`availabilityStatus`) |
| `js/core/storage.js` | Datenmodell + localStorage (Lehrkraft-Zustand, Sitzung, Eltern-Zustand) |
| `js/core/transport.js` | Elternbrief-Link, Termin-Schlüssel, Rückmelde-Payload, PDF-Datenblock |
| `js/core/pdf.js` | jsPDF laden, Schrift einbetten, Kopfzeile, Absatz, gelber Kasten, Tabelle, QR, Daten ein-/auslesen, speichern, drucken |
| `js/core/ui.js` | `h()`, `mount()`, `toast()`, `modal()`, `confirmDialog()`, `fileDropZone()`, `field()`, `alertBox()` … |
| `js/core/backup.js` | Zwischenspeicher-Datei schreiben/lesen |
| `js/core/responses.js` | Rückmelde-PDFs lesen und in den Zustand übernehmen |
| `js/components/` | wiederverwendbare Bausteine (`calendar-picker.js`, `response-import.js`) |
| `js/views/` | eine Datei pro Seite (siehe Routen) |
| `js/pdf/` | eine Datei pro PDF-Art |
| `css/base.css` | Farben (CSS-Variablen), Buttons, Formulare, Tabellen, Kacheln, Badges, Hinweise, Dialoge |
| `css/views/*.css` | seitenspezifisches CSS, immer mit Präfix-Klasse der Seite |
| `vendor/` | jsPDF 4.2.1 (UMD), qrcode-generator 2.0.4 (ESM) – lokal, kein CDN |
| `fonts/` | Liberation Sans (SIL OFL 1.1) für PDFs |
| `tests/unit/` | `node --test` für Kernlogik (`npm test`) |
| `tests/e2e/` | Browser-Tests mit Playwright/Chromium (`npm run test:e2e`), Hilfen in `helpers.mjs` |

## Routen und Views

Jede View ist ein ES-Modul: `export default async function render(ctx)`, optional mit Rückgabe einer Aufräumfunktion.

`ctx = { root, params, query, state, navigate(path, {replace}), rerender(), setTitle(title) }`

* `root` – das `<main>`-Element, in das die View rendert (`mount(root, …)`)
* `state` – bei Lehrkraft-Routen der aktuelle TeacherState (Kopie aus localStorage), sonst `null`
* Änderungen immer über `updateState(s => { … })` aus `core/storage.js` speichern (speichert sofort in localStorage, aktualisiert die „Automatisch gespeichert“-Anzeige). Danach bei Bedarf neu zeichnen oder `ctx.rerender()` aufrufen.

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
| `#/eltern/fertig` | `parent.js` | `step: 'done'` |

Lehrkraft-Routen ohne Anmeldung leiten automatisch auf `#/lehrkraft/anmelden` um.

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
  }] }]
}
```

Der Zwischenspeicher (`Zwischenspeicher vom TT.MM.JJJJ um hh꞉mm für ParentsDay.json`) ist genau dieser Zustand als JSON.

## Eingebettete Daten

| Art | `type` | Felder |
|---|---|---|
| Registrierungs-PDF | `teacher-registration` | `app:'ParentsDay', v:1, firstName, lastName, birthDate, email, registrationCode, teacherCode, createdAt` |
| Rückmelde-PDF / E-Mail-Block | `parent-response` | siehe `buildResponsePayload()` in `transport.js` |
| Elternbriefe-PDF | `parent-letters` | `app, v:1, classId, count, createdAt` (nur zur Erkennung bei versehentlichem Hochladen) |
| Termin-PDF | `appointments` | `app, v:1, classId, count, createdAt` (nur zur Erkennung bei versehentlichem Hochladen) |

PDF-Daten stehen im Metadatenfeld „Betreff“ als `PARENTSDAY1.<base64url-JSON>` (`embedPayload()` / `extractPayloadFromFile()` in `core/pdf.js`).

## Gestaltungsregeln

* Nur Bausteine aus `css/base.css` verwenden (`.card`, `.btn .btn-primary|secondary|ghost|danger|success`, `.btn-large|small`, `.field`, `.form-grid`, `.table-wrap > .table`, `.tiles > .tile`, `.badge-*`, `.alert-*`, `.dropzone`, `.page-header`, `.stack`, `.cluster`, `.code`, `.legend`).
* Farben nur über CSS-Variablen (`--c-available` grün, `--c-appt-ok` blau, `--c-appt-partial` orange, `--c-appt-unavailable` rot …).
* Seitenspezifisches CSS nur in der eigenen Datei `css/views/<view>.css`, Klassen mit eigenem Präfix (z. B. `.sched-…`).
* Wichtige Bedienelemente bekommen `data-testid`-Attribute (siehe unten), damit Browser-Tests stabil bleiben.
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
| Rückmeldungen | `response-upload` (Dropzone), `response-paste`, `response-report` |
| Terminieren | `schedule-student-<studentId>` (Chip), `schedule-day-<datum>` (Tagesspalte), `appointment-<studentId>` (Block mit `data-status="ok|partial|unavailable|unknown"`), `appointment-duration-<studentId>`, `schedule-finalize` |
| Eltern | `parent-firstname`, `parent-lastname`, `parent-code`, `parent-key`, `parent-login`, `slot-<datum>-<HH:MM>` (Button mit `aria-pressed`), `parent-submit`, `parent-download`, `parent-mailto`, `parent-share`, `parent-teacher-email` |
