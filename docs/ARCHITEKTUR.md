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

* **Termin-Schlüssel:** Im Elternbrief steht Version 2. In ihre Prüfsumme gehen Lehrkräftecode und Klasse ein, der Schlüssel passt also nur zu Codes dieses Briefs. Ein Tippfehler im Lehrkräftecode des Kindes oder der Schlüssel aus dem Brief eines Geschwisterkindes wird deshalb schon bei der Anmeldung gemeldet. Die Länge bleibt gleich. Ältere Schlüssel (Version 1) werden weiter gelesen.
* **Anfangsbuchstaben:** Lehrkräftecodes werden tolerant verglichen (`teacherCodesMatch()` in `codes.js`): „L“ für „Ł“ oder „l“ für „I“, wie aus dem Brief abgetippt, gelten als gleich. Das gilt bei der Anmeldung der Eltern und beim Einlesen der Rückmeldungen.
* **Elternseite:** Jeder Tab hat seinen eigenen Stand (sessionStorage). Der zuletzt gespeicherte Stand steht zusätzlich im localStorage, damit ein neuer Tab damit beginnt. Öffnen Eltern die QR-Codes zweier Geschwister in zwei Tabs, vermischen sich Auswahl, Rückmeldung und E-Mail-Adresse deshalb nicht.
* **Link-Daten** (`?e=`) gelten nur mit denselben Grenzen wie auf der Lehrkraft-Seite (1–8 Tage, Terminlänge in 5-Minuten-Schritten). Eine E-Mail-Adresse aus dem Link wird nur übernommen, wenn sie gültig ist. Im mailto-Link wird der Empfänger kodiert.

## Verzeichnisse

| Pfad | Inhalt |
|---|---|
| `index.html` | Einstieg, bindet `css/base.css`, alle `css/views/*.css` und `js/app.js` ein |
| `js/app.js` | Hash-Router, Seitenrahmen (Kopf-/Fußzeile), Zwischenspeicher-Knöpfe, Abmelden |
| `js/config.js` | `PUBLIC_URL` (https://parentsday.janrickmer.de), `APP_NAME`, `DATA_VERSION`, gemeinsame Grenzen (Tage, Terminlänge, Adresse, Dateigrößen) |
| `js/core/codes.js` | Registrierungs-, Lehrkräfte-, Schülercode, Zahlencode, Eltern-Login-Prüfung |
| `js/core/time.js` | Datum/Uhrzeit, Slots, Zeitspannen, Terminfarbe (`availabilityStatus`) |
| `js/core/storage.js` | Datenmodell + localStorage (Lehrkraft-Zustand, Sitzung, Eltern-Zustand) |
| `js/core/transport.js` | Elternbrief-Link, Termin-Schlüssel, Rückmelde-Payload, PDF-Datenblock |
| `js/core/pdf.js` | jsPDF laden, Schrift einbetten, Kopfzeile, Absatz, gelber Kasten, Tabelle, QR, Daten ein-/auslesen, speichern, drucken |
| `js/core/ui.js` | `h()`, `mount()`, `toast()`, `modal()`, `confirmDialog()`, `fileDropZone()`, `field()`, `alertBox()` … |
| `js/core/backup.js` | Zwischenspeicher-Datei schreiben/lesen (prüft Größe, Inhalt und ob die Datei zur angemeldeten Lehrkraft gehört) |
| `js/core/responses.js` | Rückmelde-PDFs lesen und in den Zustand übernehmen |
| `js/components/` | wiederverwendbare Bausteine (`calendar-picker.js`, `response-import.js`, `backup-actions.js` für „Zwischenstand speichern/laden“) |
| `404.html` | GitHub Pages liefert sie für unbekannte Pfade (z. B. `/eltern`) und leitet auf die Hash-Adresse (`/#/eltern`) weiter |
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
* Kann der Browser nicht speichern (Speicher voll oder gesperrt), wirft `updateState()` bzw. `saveTeacherState()` einen Fehler mit der Meldung `STORAGE_FULL`. Die Anzeige „Automatisch gespeichert“ wird dann nicht aktualisiert. Aufrufer zeigen die Meldung an und dürfen keinen Erfolg melden.
* Ungespeicherte Eingaben auf „Elternsprechtag erstellen“ bzw. „Weitere Einstellungen“ liegen als Entwurf im sessionStorage (`storeEventDraft()`). Solange es sie gibt, zeigt die Kopfzeile „noch nicht gespeichert“ (`setDraftPending()`).

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
  }] }]
}
```

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

## Gestaltungsregeln

* Nur Bausteine aus `css/base.css` verwenden (`.card`, `.btn .btn-primary|secondary|ghost|danger|success`, `.btn-large|small`, `.field`, `.form-grid`, `.table-wrap > .table`, `.tiles > .tile`, `.badge-*`, `.alert-*`, `.dropzone`, `.page-header`, `.stack`, `.cluster`, `.code`, `.legend`).
* Farben nur über CSS-Variablen (`--c-available` grün, `--c-appt-ok` blau, `--c-appt-partial` orange, `--c-appt-unavailable` rot …).
* Seitenspezifisches CSS nur in der eigenen Datei `css/views/<view>.css`, Klassen mit eigenem Präfix (z. B. `.sched-…`).
* Wichtige Bedienelemente bekommen `data-testid`-Attribute (siehe unten), damit Browser-Tests stabil bleiben.
* `index.html` setzt eine strenge Content-Security-Policy (`script-src 'self'; style-src 'self'`, keine Inline-Stile). Stile im Code deshalb nur als Objekt an `h()` übergeben (`style: { display: 'none' }`), nie als Text.
* Dialoge (`modal()`) halten den Tastaturfokus fest. Solange ein Dialog offen ist, ist `#app` `inert`. Toasts lassen sich mit × schließen. Steht eine Meldung schon auf der Seite, zeigt ParentsDay dazu keinen Toast mehr.
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
| Eltern | `parent-firstname`, `parent-lastname`, `parent-code`, `parent-key` (nur im Formular, wenn der Schlüssel gebraucht wird), `parent-login`, `parent-other-key`, `parent-switch`, `slot-<datum>-<HH:MM>` (Button mit `aria-pressed`), `parent-submit`, `parent-download`, `parent-mailto`, `parent-share`, `parent-teacher-email` |
