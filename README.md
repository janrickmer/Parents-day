# ParentsDay

**ParentsDay** ist ein Portal, mit dem Lehrkräfte die Termine für den Elternsprechtag mit den Eltern abstimmen.

* Lehrkräfte legen den Elternsprechtag, ihre Klassen und die Lernenden an. Daraus erzeugen sie Elternbriefe mit Code und QR-Code.
* Eltern melden sich mit Vorname, Nachname und Code ihres Kindes an und markieren alle Zeiten, zu denen sie Zeit haben.
* Die Lehrkraft lädt die Rückmeldungen hoch und plant die Gespräche per Drag & Drop. Zum Schluss druckt sie die Terminbestätigungen samt Übersicht.

Die Seite ist **rein statisch**. Es gibt keinen Server und keine Datenbank. Alle Daten bleiben im Browser der Lehrkraft bzw. der Eltern und in den Dateien, die sie selbst herunterladen.

## Ablauf

1. **Registrieren** (Zugang für Lehrkräfte): Sie geben Vorname, Nachname, Geburtsdatum und E-Mail-Adresse ein. Danach laden Sie ein PDF mit dem Registrierungscode herunter.
2. **Anmelden**: Sie laden das Registrierungs-PDF hoch oder geben Ihre Daten und den Registrierungscode ein.
3. **Elternsprechtag erstellen**: Sie wählen die Tage im Kalender aus und legen je Tag Anfangs- und Endzeit fest. Außerdem geben Sie die Adresse der Schule und die Länge eines Terminslots an.
4. **Klassen anlegen**: Sie wählen Jahrgangsstufe (1–13) und Buchstaben (a–h) und tragen die Lernenden in die Tabelle ein. Ein Klick auf **„Alle Lernenden erfolgreich eingetragen“** erzeugt die Codes. Mit **„Elternschreiben für diese Klasse erstellen“** entsteht ein PDF mit einer Seite pro Kind.
5. **Eltern**: Sie scannen den QR-Code im Brief, melden sich an, markieren ihre freien Slots grün und klicken auf **„Absenden“**. Das Rückmelde-PDF wird heruntergeladen. Danach schicken sie es per Knopf „E-Mail an die Lehrkraft schreiben“ an die Lehrkraft, auf dem Smartphone auch per „PDF teilen“. Ohne QR-Code geht die Anmeldung zusätzlich mit dem Termin-Schlüssel aus dem Brief.
6. **Rückmeldungen hochladen**: Die Lehrkraft lädt alle PDFs gesammelt hoch. Die Klasse wird am Code erkannt, und die Spalte „Verfügbarkeit der Eltern“ füllt sich.
7. **Gespräche terminieren**: Sie ziehen die Namen in die Tagesansicht. Die Blöcke sind je nach Verfügbarkeit der Eltern blau, orange oder rot. Mit **„Termine festlegen, speichern und drucken“** entsteht ein PDF: eine Terminbestätigung pro Kind und als letzte Seite eine Übersicht.
8. **Zwischenstand**: Jederzeit können Sie über „Zwischenstand speichern“ die Datei `Zwischenspeicher vom TT.MM.JJJJ um hh꞉mm für ParentsDay.json` herunterladen. Sie enthält auch Eingaben zum Elternsprechtag, die Sie noch nicht gespeichert haben. Nach dem Anmelden laden Sie sie über „Zwischenstand laden“ wieder hoch. Auf einem neuen Gerät zeigt ParentsDay dafür nach der Anmeldung einen eigenen Knopf.

## Codes

| Code | Aufbau | Beispiel (Anna Meier, 15.03.1990) |
|---|---|---|
| Registrierungscode | Anfangsbuchstaben Vor- und Nachname + (Anzahl Buchstaben des Vornamens × TTMMJJJJ) | `AM60127960` |
| Lehrkräftecode | Anfangsbuchstabe Vorname + (TTMMJJJJ × 1104) + Anfangsbuchstabe Nachname | `A16595316960M` |
| Schülercode | Jahrgangsstufe + Klassenbuchstabe + Lehrkräftecode + Zahlencode Vorname + Zahlencode Nachname (A=1 … Z=26) | Anna Beck, 5a: `5aA16595316960M11414125311` |

Umlaute werden für den Zahlencode umgeschrieben (ä→ae, ö→oe, ü→ue, ß→ss). Akzente werden entfernt, alle anderen Zeichen ignoriert.

Der **Termin-Schlüssel** im Elternbrief passt nur zu den Codes dieses Briefs, also zu Lehrkraft und Klasse. Tippfehler im Lehrkräftecode fallen so schon bei der Anmeldung auf. Anfangsbuchstaben wie „Ł“ dürfen die Eltern als „L“ abtippen.

## Veröffentlichen

Die Seite braucht nur einen Webspace, der Dateien ausliefert. Einen Build-Schritt gibt es nicht.

**GitHub Pages:**
1. Unter *Settings → Pages* bei *Source* „Deploy from a branch“, den Branch `main` und den Ordner `/ (root)` wählen.
2. Als *Custom domain* `parentsday.janrickmer.de` eintragen (steht auch in der Datei `CNAME`). Beim DNS-Anbieter zeigt der `CNAME`-Eintrag `parentsday` auf `janrickmer.github.io`.
3. Sobald GitHub das Zertifikat ausgestellt hat, unter *Settings → Pages* „Enforce HTTPS“ aktivieren.

**Anderer Webspace:** Alle Dateien (ohne `node_modules/` und `tests/`) in das Webverzeichnis der Subdomain kopieren. Stellen Sie `404.html` als Fehlerseite ein, z. B. mit `ErrorDocument 404 /404.html`. Dann führen abgetippte Adressen ohne „#“ (z. B. `/eltern`) zur richtigen Seite. GitHub Pages macht das automatisch.

`index.html` enthält eine strenge Content-Security-Policy. Fremde Skripte, Inline-Skripte und Inline-Stile blockiert der Browser.

Die Adresse, die in Elternbriefe und QR-Codes gedruckt wird, steht in `js/config.js` (`PUBLIC_URL`).

## Entwicklung

```bash
npm install          # nur für die Browser-Tests (Playwright)
npm start            # http://localhost:8080
npm test             # Unit-Tests der Kernlogik
npm run test:e2e     # Browser-Tests (Chromium)
```

Bei jedem Push laufen beide Testarten automatisch auf GitHub, zu sehen im Reiter *Actions* (`.github/workflows/tests.yml`).

Weitere Unterlagen:

* [`docs/ARCHITEKTUR.md`](docs/ARCHITEKTUR.md): Aufbau, Datenmodell und Datenfluss
* [`docs/ANFORDERUNGEN.md`](docs/ANFORDERUNGEN.md): ursprüngliche Anforderungen und getroffene Entscheidungen

## Lizenzen

* jsPDF (MIT): `vendor/LICENSE-jsPDF.txt`
* QR Code Generator von Kazuhiko Arase (MIT): `vendor/LICENSE-qrcode-generator.txt`
* Liberation Sans (SIL Open Font License 1.1): `fonts/LICENSE-LiberationSans.txt`
