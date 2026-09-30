# ParentsDay

**ParentsDay** ist ein Portal, mit dem Lehrkräfte die Termine für den Elternsprechtag mit den Eltern abstimmen.

* Lehrkräfte legen den Elternsprechtag, ihre Klassen und die Lernenden an. Daraus erzeugen sie Elternbriefe mit Code und QR-Code.
* Eltern melden sich mit Vorname, Nachname und Code ihres Kindes an und markieren alle Zeiten, zu denen sie Zeit haben.
* Die Lehrkraft lädt die Rückmeldungen hoch und plant die Gespräche per Drag & Drop. Zum Schluss druckt sie die Terminbestätigungen samt Übersicht.

Die Seite ist **rein statisch**. Einen eigenen Server oder eine Datenbank braucht sie nicht. Alle Daten bleiben im Browser der Lehrkraft bzw. der Eltern und in den Dateien, die sie selbst herunterladen. Einzige, freiwillige Ergänzung ist ein kleiner Dienst bei Cloudflare: Über den [digitalen Briefkasten](#digitaler-briefkasten-optional) gehen die Rückmeldungen der Eltern verschlüsselt an die Lehrkraft, und die [Cloud-Sicherung](#cloud-sicherung) bewahrt den Stand der Lehrkraft mit ihrem Passwort verschlüsselt auf.

## Ablauf

1. **Registrieren** (Zugang für Lehrkräfte): Sie geben Vorname, Nachname, Geburtsdatum und E-Mail-Adresse ein, mit [Cloud-Sicherung](#cloud-sicherung) auch ein Passwort. Danach laden Sie ein PDF mit dem Registrierungscode herunter.
2. **Anmelden**: Sie laden das Registrierungs-PDF hoch oder geben Ihre Daten und den Registrierungscode ein. Mit Cloud-Sicherung geben Sie an einem neuen Gerät danach Ihr Passwort ein, und Ihr aktueller Stand ist da.
3. **Elternsprechtag erstellen**: Sie wählen die Tage im Kalender aus und legen je Tag Anfangs- und Endzeit fest. Außerdem geben Sie die Adresse der Schule und die Länge eines Terminslots an.
4. **Klassen anlegen**: Sie wählen Jahrgangsstufe (1–13) und Buchstaben (a–h) und tragen die Lernenden in die Tabelle ein. Ein Klick auf **„Alle Lernenden erfolgreich eingetragen“** erzeugt die Codes. Mit **„Elternschreiben für diese Klasse erstellen“** entsteht ein PDF mit einer Seite pro Kind.
5. **Eltern**: Sie scannen den QR-Code im Brief, melden sich an, markieren ihre freien Slots grün und klicken auf **„Absenden“**. Das Rückmelde-PDF wird heruntergeladen. Danach schicken sie es per Knopf „E-Mail an die Lehrkraft schreiben“ an die Lehrkraft, auf dem Smartphone auch per „PDF teilen“. Ohne QR-Code geht die Anmeldung zusätzlich mit dem Termin-Schlüssel aus dem Brief. Mit [digitalem Briefkasten](#digitaler-briefkasten-optional) ist nach „Absenden“ nichts weiter zu tun.
6. **Rückmeldungen hochladen**: Die Lehrkraft lädt alle PDFs gesammelt hoch. Die Klasse wird am Code erkannt, und die Spalte „Verfügbarkeit der Eltern“ füllt sich. Mit digitalem Briefkasten kommen die Rückmeldungen automatisch an; Hochladen bleibt als Notlösung möglich.
7. **Gespräche terminieren**: Sie ziehen die Namen in die Tagesansicht. Die Blöcke sind je nach Verfügbarkeit der Eltern blau, orange oder rot. Mit **„Termine festlegen, speichern und drucken“** entsteht ein PDF: eine Terminbestätigung pro Kind und als letzte Seite eine Übersicht.
8. **Zwischenstand**: Jederzeit können Sie über „Zwischenstand speichern“ die Datei `Zwischenspeicher vom TT.MM.JJJJ um hh꞉mm für ParentsDay.json` herunterladen. Sie enthält auch Eingaben zum Elternsprechtag, die Sie noch nicht gespeichert haben. Nach dem Anmelden laden Sie sie über „Zwischenstand laden“ wieder hoch. Auf einem neuen Gerät zeigt ParentsDay dafür nach der Anmeldung einen eigenen Knopf. Mit Cloud-Sicherung brauchen Sie die Datei für den Gerätewechsel nicht; sie bleibt eine zusätzliche Sicherung zum Aufbewahren.

## Digitaler Briefkasten (optional)

Viele Eltern tun sich schwer damit, das Rückmelde-PDF selbst per E-Mail zu verschicken. Mit dem digitalen Briefkasten klicken sie nur auf **„Absenden“**: Ihr Browser verschlüsselt die Rückmeldung Ende-zu-Ende (lesen kann sie nur die Lehrkraft) und legt sie in einem kleinen Dienst bei Cloudflare ab (Worker + D1-Datenbank, `worker/briefkasten.js`). Die Seite der Lehrkraft holt die Rückmeldungen automatisch ab und füllt die Tabelle.

* Der kostenlose Tarif von Cloudflare reicht aus. Ist der Briefkasten nicht erreichbar, schicken die Eltern ihre Rückmeldung wie bisher als PDF bzw. E-Mail-Text (Notlösung).
* Eingeschaltet wird er mit der Adresse des Workers in `js/config.js` (`MAILBOX_URL`) und bei `connect-src` in `index.html`. Im Repository ist `https://parentsday-briefkasten.feindt.workers.dev` eingetragen. Ist `MAILBOX_URL` leer, bleibt alles wie vor dem Briefkasten (dann auch ohne Cloud-Sicherung).
* Unter „Weitere Einstellungen“ sehen Lehrkräfte den Zustand ihres Briefkastens, prüfen die Verbindung und leeren ihn nach dem Elternsprechtag.
* Der Schlüssel zum Briefkasten liegt im Browser der Lehrkraft, in ihrem Zwischenstand und – verschlüsselt – in ihrer Cloud-Sicherung. **Ohne Cloud-Sicherung speichern Sie deshalb nach den ersten Elternbriefen einen Zwischenstand** – nur damit lassen sich die Rückmeldungen auch auf einem anderen Gerät oder nach dem Löschen der Browserdaten lesen.

Die Einrichtung Schritt für Schritt, Kosten und Grenzen, Datenschutz und das Aufräumen beschreibt [`docs/BRIEFKASTEN.md`](docs/BRIEFKASTEN.md).

## Cloud-Sicherung

Mit dem Briefkasten-Dienst gibt es auch die **Cloud-Sicherung**: Der komplette Stand der Lehrkraft wird nach jeder Änderung automatisch gesichert, auch Eingaben zum Elternsprechtag, die noch nicht gespeichert sind. An einem anderen Gerät meldet sie sich an, gibt ihr Passwort ein und hat ihren aktuellen Stand – ohne Zwischenspeicher-Datei.

* Verschlüsselt wird schon im Browser mit einem Schlüssel aus dem Passwort der Lehrkraft (PBKDF2, HKDF und AES-256-GCM). Auch die Adresse der Sicherung beim Dienst wird aus dem Passwort berechnet; gespeichert wird sie dort nur als Hashwert zusammen mit einer Kennung der Lehrkraft. Adresse und Versionsnummer sind mit verschlüsselt, ein älterer Stand lässt sich deshalb nicht als neuer unterschieben. Das Passwort verlässt den Browser nie. Ohne es lässt sich die Sicherung über den Dienst weder finden noch lesen, überschreiben oder löschen – auch nicht von ParentsDay.
* Das Passwort legen Lehrkräfte bei der Registrierung fest. Wer schon registriert ist, wird beim Anmelden gefragt („Später“ ist möglich). „Passwort auf diesem Gerät merken“ gilt je Gerät: bei der Registrierung und beim Einrichten voreingestellt, beim Öffnen an einem weiteren Gerät nicht (außer das Gerät war schon verbunden).
* Haben zwei Geräte unabhängig voneinander geändert, fragt ParentsDay, welcher Stand gelten soll; den Stand des Geräts kann man dabei vorher als Zwischenstand speichern. Ohne Verbindung wird das Hochladen nachgeholt. Die Kopfzeile zeigt den Zustand.
* Beim Abmelden können Lehrkräfte „Meine Daten von diesem Gerät entfernen“ wählen. „Alle Daten in diesem Browser löschen“ lädt vorher offene Änderungen hoch und entfernt nur die Daten in diesem Browser; die Cloud-Sicherung bleibt erhalten. Ist der Stand des Geräts nicht vollständig gesichert, warnt der Dialog. Ein Gerät, das nach einem nicht mehr gültigen Passwort fragt, lässt sich mit „Nicht mehr verwenden“ von der Sicherung lösen.
* Passwort ändern und die Sicherung löschen geht unter „Weitere Einstellungen“, beides nur mit dem Passwort. Beim Ändern zieht der Stand in eine neue Sicherung um; die alte wird gelöscht oder bekommt den Hinweis „umgezogen“, und die anderen Geräte fragen einmal nach dem neuen Passwort. „Passwort vergessen?“ legt an einem Gerät, das noch verbunden ist, einfach ein neues Passwort fest; an einem anderen Gerät richtet es eine neue Sicherung ein, die mit dem Stand dieses Geräts beginnt (Geräte mit der alten verbindet man dort mit „Mit neuem Passwort verbinden“).
* Gegen das Ausprobieren von Passwörtern zählt der Dienst Versuche, eine Sicherung zu öffnen oder anzulegen, je Lehrkraft (höchstens 10 je Stunde und Anschluss, 30 am Tag) und begrenzt neue Sicherungen je Anschluss (20 bzw. 5 Millionen Zeichen am Tag). Geräte, die schon verbunden sind, gleichen ohne Zählung weiter ab. Wer Namen und Geburtsdatum einer Lehrkraft kennt, kann ihre Versuche eines Tages aufbrauchen und so das Öffnen auf neuen Geräten bis zum nächsten Tag sperren – lesen oder ändern kann er nichts. Sicherungen, die nach dem Einrichten nie genutzt wurden, werden nach 30 Tagen gelöscht, alle anderen nach 400 Tagen ohne Nutzung. Schutz, Grenzen und Restrisiken im Einzelnen: [`docs/BRIEFKASTEN.md`](docs/BRIEFKASTEN.md#cloud-sicherung-der-lehrkräfte).
* Bestehende Briefkästen brauchen dafür die neue Fassung von `worker/briefkasten.js` (`/v1/health` meldet `"sync":3`) – siehe [Worker aktualisieren](docs/BRIEFKASTEN.md#worker-aktualisieren). Empfohlen ist außerdem das Secret `IP_HASH_KEY`: Dann lassen sich die gespeicherten Hashwerte der IP-Adressen auch mit Zugriff auf die Datenbank keiner Adresse zuordnen.

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
* [`docs/BRIEFKASTEN.md`](docs/BRIEFKASTEN.md): digitalen Briefkasten und Cloud-Sicherung bei Cloudflare einrichten, aktualisieren und betreiben

## Lizenzen

* jsPDF (MIT): `vendor/LICENSE-jsPDF.txt`
* QR Code Generator von Kazuhiko Arase (MIT): `vendor/LICENSE-qrcode-generator.txt`
* Liberation Sans (SIL Open Font License 1.1): `fonts/LICENSE-LiberationSans.txt`
