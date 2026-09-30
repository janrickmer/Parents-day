# Digitaler Briefkasten – Einrichtung und Betrieb

Diese Anleitung richtet sich an die Person, die ParentsDay an der Schule betreut. Programmierkenntnisse brauchen Sie nicht. Planen Sie für die Einrichtung etwa 30 Minuten ein.

Der digitale Briefkasten ist **freiwillig**. Solange er nicht eingerichtet ist, funktioniert ParentsDay wie bisher: Die Eltern schicken ihre Rückmeldung als PDF-Datei bzw. E-Mail-Text an die Lehrkraft.

## Inhalt

1. [Was ist der digitale Briefkasten?](#was-ist-der-digitale-briefkasten)
2. [Kosten und Grenzen](#kosten-und-grenzen)
3. [Einrichtung im Cloudflare-Dashboard](#einrichtung-im-cloudflare-dashboard)
4. [Alternative: Einrichtung per Kommandozeile](#alternative-einrichtung-per-kommandozeile)
5. [Datenschutz](#datenschutz)
6. [Was passiert bei einem Ausfall?](#was-passiert-bei-einem-ausfall)
7. [Aufräumen nach dem Elternsprechtag](#aufräumen-nach-dem-elternsprechtag)
8. [Häufige Probleme](#häufige-probleme)

## Was ist der digitale Briefkasten?

Ohne Briefkasten laden die Eltern nach „Absenden“ eine PDF-Datei herunter und schicken sie per E-Mail an die Lehrkraft. Die Lehrkraft lädt die Dateien dann in ParentsDay hoch. Für viele Eltern ist das zu kompliziert.

Mit Briefkasten klicken die Eltern nur noch auf **„Absenden“**. Ihr Browser verschlüsselt die Rückmeldung und legt sie im Briefkasten ab. Öffnet die Lehrkraft in ParentsDay die Klassenübersicht oder eine Klasse, holt die Seite neue Rückmeldungen automatisch ab und trägt die Zeiten in die Tabelle ein. Zusätzlich gibt es den Knopf „Neue Rückmeldungen abrufen“.

```
Eltern (Browser)                  Briefkasten bei Cloudflare               Lehrkraft (Browser)
„Absenden“                        (Worker + Datenbank D1)
  │ verschlüsselt mit dem         speichert nur unlesbare Daten            holt ab, entschlüsselt
  │ öffentlichen Schlüssel  ───►  ───────────────────────────────────►    mit ihrem privaten Schlüssel
  │ der Lehrkraft (QR-Code)                                                und füllt die Tabelle
  │
  └─ Notlösung, wenn der Briefkasten nicht erreichbar ist: PDF-Datei bzw. E-Mail-Text wie bisher
```

Der Briefkasten besteht aus zwei Teilen, die Sie bei Cloudflare anlegen:

* einem **Worker**, also einem kleinen Programm (die Datei `worker/briefkasten.js` in diesem Projekt), und
* einer **D1-Datenbank**, in der die verschlüsselten Rückmeldungen bis zur Abholung liegen.

So funktioniert die Verschlüsselung:

* Erstellt eine Lehrkraft zum ersten Mal Elternbriefe, erzeugt ParentsDay in ihrem Browser einen eigenen Briefkasten mit einem Schlüsselpaar. Der **öffentliche** Schlüssel steht im QR-Code der Elternbriefe. Der **private** Schlüssel bleibt im Browser der Lehrkraft und in ihrer Zwischenspeicher-Datei.
* Nur mit dem privaten Schlüssel lassen sich die Rückmeldungen lesen. Cloudflare und Sie als Betreiber können das nicht.
* Die Lehrkraft sollte deshalb nach dem Erstellen der Elternbriefe einen Zwischenstand speichern. Ohne Schlüssel sind die Rückmeldungen im Briefkasten nicht lesbar.

**Der bisherige Weg bleibt als Notlösung erhalten.** Ist der Briefkasten nicht erreichbar, bietet die Elternseite wie bisher das Rückmelde-PDF und den Knopf „E-Mail an die Lehrkraft schreiben“ an. Lehrkräfte können PDFs und E-Mail-Texte weiterhin hochladen bzw. einfügen.

## Kosten und Grenzen

Der Briefkasten kommt mit den **kostenlosen Tarifen** von Cloudflare aus. Zahlungsdaten brauchen Sie dafür nicht.

| Dienst | Kostenlose Grenze (Stand: September 2026) |
|---|---|
| Workers Free | 100.000 Anfragen pro Tag, 10 ms Rechenzeit (CPU) je Anfrage |
| D1 Free | 5 Millionen gelesene Zeilen pro Tag, 100.000 geschriebene Zeilen pro Tag, 5 GB Speicher insgesamt (höchstens 500 MB je Datenbank) |

Quellen: [Workers – Limits](https://developers.cloudflare.com/workers/platform/limits), [D1 – Pricing](https://developers.cloudflare.com/d1/platform/pricing/) und [D1 – Limits](https://developers.cloudflare.com/d1/platform/limits/)

**Was passiert, wenn eine Grenze überschritten wird?** Es entstehen keine Kosten. Cloudflare lehnt weitere Anfragen ab, bis die Grenzen um Mitternacht UTC zurückgesetzt werden (in Deutschland um 1 Uhr, im Sommer um 2 Uhr). Für die Datenbank gilt das seit dem 1. September 2026: Abfragen im kostenlosen Tarif schlagen dann fehl. ParentsDay meldet in dieser Zeit, dass der digitale Briefkasten nicht erreichbar ist bzw. einen Fehler gemeldet hat, und die Eltern nutzen die Notlösung per E-Mail.

**Reicht das für unsere Schule?** Sehr wahrscheinlich ja, mit viel Abstand. Eine grobe Rechnung:

* Eine Rückmeldung braucht etwa 2 Anfragen (eine Vorabfrage des Browsers und den eigentlichen Einwurf).
* Jeder Abruf der Lehrkraft braucht ebenfalls etwa 2 Anfragen. Abgerufen wird beim Öffnen der Klassenübersicht oder einer Klasse (höchstens alle 30 Sekunden) und per Knopf.
* Eine Schule mit 60 Lehrkräften und je 30 Kindern bekommt 1.800 Rückmeldungen – verteilt über mehrere Tage oder Wochen. Das sind wenige tausend Anfragen pro Tag.
* Die Verschlüsselung erledigen die Browser. Der Worker braucht je Anfrage nur sehr wenig Rechenzeit.

Der Briefkasten setzt außerdem eigene Grenzen:

* höchstens 16 KB je Rückmeldung (eine normale Rückmeldung ist viel kleiner),
* höchstens 3.000 Rückmeldungen je Lehrkraft,
* höchstens 30 Rückmeldungen je IP-Adresse und Minute, damit niemand den Briefkasten mit Massen-Einwürfen füllt (einstellbar, siehe Schritt 6),
* Rückmeldungen und Einträge für den Termin-Schlüssel werden nach spätestens 200 Tagen gelöscht (täglicher Cron-Trigger, Schritt 5).

## Einrichtung im Cloudflare-Dashboard

> **Hinweis:** Cloudflare überarbeitet sein Dashboard regelmäßig. Menüpunkte und Knöpfe können anders heißen oder an anderer Stelle stehen als hier beschrieben (Stand: September 2026). Suchen Sie dann nach einem ähnlichen Namen. Das Dashboard ist auf Englisch; die englischen Bezeichnungen stehen hier in Anführungszeichen.

### Schritt 1: Kostenloses Konto anlegen

1. Öffnen Sie <https://dash.cloudflare.com/sign-up>.
2. Geben Sie eine E-Mail-Adresse und ein Passwort ein. Nehmen Sie am besten eine dienstliche Adresse der Schule, auf die auch eine Vertretung zugreifen kann.
3. Bestätigen Sie die E-Mail-Adresse über den Link, den Cloudflare Ihnen schickt.
4. Empfehlung: Schalten Sie in Ihrem Profil die Zwei-Faktor-Anmeldung ein („Two-Factor Authentication“).

Eine eigene Domain oder Webseite bei Cloudflare brauchen Sie nicht.

### Schritt 2: Datenbank anlegen

1. Wählen Sie im linken Menü „Storage & Databases“ und dann „D1 SQL Database“.
2. Klicken Sie auf „Create Database“ (bzw. „Create“).
3. Name: **`parentsday`**
4. Wenn Cloudflare einen Rechtsraum anbietet („Jurisdiction“), wählen Sie **„EU“**. Dann liegen die Daten nur in der Europäischen Union. Diese Einstellung geht nur beim Anlegen und lässt sich später nicht ändern. Gibt es nur eine Standort-Auswahl („Location“), wählen Sie „Western Europe“.
5. Klicken Sie auf „Create“.

Tabellen müssen Sie nicht anlegen. Das erledigt der Briefkasten bei der ersten Anfrage selbst.

### Schritt 3: Worker anlegen

1. Wählen Sie im linken Menü „Workers & Pages“ (ggf. unter „Compute“).
2. Klicken Sie auf „Create“ (bzw. „Create application“) und wählen Sie „Worker“ bzw. „Start with Hello World!“.
3. Name: **`parentsday-briefkasten`**. Aus dem Namen ergibt sich die Adresse, z. B. `https://parentsday-briefkasten.ihr-kontoname.workers.dev`.
4. Klicken Sie auf „Deploy“. Cloudflare legt zunächst ein Beispielprogramm an.
5. Klicken Sie auf „Edit code“. Löschen Sie den gesamten Text im Editor.
6. Öffnen Sie die Datei `worker/briefkasten.js` aus diesem Projekt (auf GitHub: Datei öffnen und über den Knopf „Copy raw file“ kopieren). Fügen Sie den **gesamten** Inhalt in den Editor ein.
7. Klicken Sie auf „Deploy“.

### Schritt 4: Datenbank mit dem Worker verbinden

1. Öffnen Sie den Worker `parentsday-briefkasten` und dort „Settings“ → „Bindings“ (bei manchen Konten ist „Bindings“ ein eigener Reiter).
2. Klicken Sie auf „Add binding“ (bzw. „Add“) und wählen Sie „D1 database“.
3. Variablenname („Variable name“): **`DB`** – genau so, in Großbuchstaben.
4. Datenbank: **`parentsday`**
5. Speichern Sie mit „Add binding“ bzw. „Deploy“.

Fehlt diese Verbindung, antwortet der Briefkasten mit `{"error":"no-database"}`.

### Schritt 5: Tägliches Aufräumen einschalten

Rückmeldungen und Einträge für den Termin-Schlüssel dürfen höchstens 200 Tage gespeichert bleiben – das sagen die Datenschutz-Hinweise von ParentsDay den Eltern zu. Gelöscht werden sie von einem **Cron-Trigger**, den Cloudflare einmal am Tag startet:

1. Worker `parentsday-briefkasten` öffnen → „Settings“ → „Trigger Events“ (bei manchen Konten „Triggers“).
2. „Add“ → „Cron Triggers“ wählen.
3. Zeitplan: einmal täglich, z. B. als Ausdruck („Cron expression“) **`17 3 * * *`** (jeden Tag um 3:17 Uhr UTC).
4. Mit „Add“ bzw. „Deploy“ speichern.

Der Cron-Trigger kostet nichts extra. Ohne ihn gibt der Briefkasten ältere Rückmeldungen zwar nicht mehr heraus, sie blieben aber in der Datenbank liegen (siehe [Aufräumen](#aufräumen-nach-dem-elternsprechtag)).

### Schritt 6 (optional): Erlaubte Web-Adressen

Der Briefkasten nimmt Anfragen aus dem Browser nur von bestimmten Web-Adressen an. Voreingestellt ist `https://parentsday.janrickmer.de`. Läuft ParentsDay bei Ihnen unter einer anderen Adresse, stellen Sie sie so ein:

1. Worker öffnen → „Settings“ → „Variables and Secrets“ → „Add“.
2. Typ: „Text“. Name: **`ALLOWED_ORIGINS`**
3. Wert: die Adresse Ihrer ParentsDay-Seite, z. B. `https://parentsday.meine-schule.de` – ohne Schrägstrich am Ende. Mehrere Adressen trennen Sie mit Kommas. Zum Ausprobieren auf dem eigenen Rechner (`npm start`) ergänzen Sie `http://localhost:8080`.
4. Mit „Deploy“ speichern.

Ebenso können Sie **`POSTS_PER_MINUTE`** setzen: So viele Rückmeldungen nimmt der Briefkasten je IP-Adresse und Minute an (Standard: 30).

### Schritt 7: Testen

1. Öffnen Sie im Browser die Adresse Ihres Workers mit `/v1/health` am Ende, z. B.
   `https://parentsday-briefkasten.ihr-kontoname.workers.dev/v1/health`
   Dort muss stehen: `{"ok":true,"service":"ParentsDay-Briefkasten","version":1}`
2. Prüfen Sie die Datenbank mit dieser Adresse (32-mal der Buchstabe A):
   `https://parentsday-briefkasten.ihr-kontoname.workers.dev/v1/directory/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
   * `{"found":false}` – richtig so: Die Datenbank ist verbunden. (Ältere Fassungen des Briefkastens antworten hier `{"error":"not-found"}` – auch das ist in Ordnung.)
   * `{"error":"no-database"}` – die Verbindung aus Schritt 4 fehlt.
   * `{"error":"server-error"}` – die Datenbank meldet einen Fehler. Prüfen Sie Schritt 2 und 4.

Eine neue `workers.dev`-Adresse ist manchmal erst nach einigen Minuten erreichbar.

### Schritt 8: Adresse in ParentsDay eintragen

Geben Sie die Adresse des Workers an die Person, die die ParentsDay-Dateien pflegt, oder ändern Sie selbst zwei Dateien:

1. **`js/config.js`**: Adresse bei `MAILBOX_URL` eintragen – ohne `/v1` und ohne Schrägstrich am Ende:
   ```js
   export const MAILBOX_URL = 'https://parentsday-briefkasten.ihr-kontoname.workers.dev';
   ```
2. **`index.html`**: In der Zeile mit `Content-Security-Policy` dieselbe Adresse bei `connect-src` ergänzen. Aus `connect-src 'self'` wird:
   ```
   connect-src 'self' https://parentsday-briefkasten.ihr-kontoname.workers.dev
   ```
   Ohne diesen Eintrag blockiert der Browser die Verbindung, und ParentsDay meldet „Der digitale Briefkasten ist gerade nicht erreichbar“. Wer die Tests des Projekts laufen lässt: `npm test` prüft, dass beide Einträge zusammenpassen.
3. Veröffentlichen Sie die geänderten Dateien wie gewohnt (bei GitHub Pages: auf den Branch `main` hochladen).

**Kontrolle:** Melden Sie sich als Lehrkraft an und öffnen Sie „Weitere Einstellungen“. Dort steht jetzt die Karte „Digitaler Briefkasten“. Nach dem Erstellen von Elternbriefen können Sie dort auf „Verbindung prüfen“ klicken. Die Datenschutz-Hinweise von ParentsDay enthalten jetzt automatisch einen Abschnitt zum Briefkasten.

**Wichtig:** Nur Elternbriefe, die **nach** dieser Umstellung erstellt werden, enthalten den Briefkasten im QR-Code. Eltern mit älteren Briefen schicken ihre Rückmeldung weiter per E-Mail. Lehrkräfte können die Elternbriefe einfach neu erstellen.

## Alternative: Einrichtung per Kommandozeile

Wer mit der Kommandozeile vertraut ist, kann Datenbank und Worker auch mit Wrangler anlegen, dem Werkzeug von Cloudflare. Sie brauchen dafür eine aktuelle Node.js-Version. Die Einstellungen stehen schon in `worker/wrangler.toml`.

```bash
cd worker
npx wrangler login                                      # öffnet den Browser zur Anmeldung bei Cloudflare
npx wrangler d1 create parentsday --jurisdiction eu     # Datenbank anlegen (Daten nur in der EU)
```

Wrangler zeigt danach die ID der neuen Datenbank (`database_id`) an. Tragen Sie sie in `worker/wrangler.toml` statt `HIER-DIE-DATENBANK-ID-EINTRAGEN` ein. Passen Sie dort bei Bedarf auch `ALLOWED_ORIGINS` an (siehe Schritt 6). Der tägliche Cron-Trigger zum Aufräumen (Schritt 5) steht dort schon und wird mit veröffentlicht. Dann veröffentlichen:

```bash
npx wrangler deploy
```

Wrangler gibt die Adresse des Workers aus (`https://parentsday-briefkasten.….workers.dev`). Weiter geht es mit [Schritt 7](#schritt-7-testen) und [Schritt 8](#schritt-8-adresse-in-parentsday-eintragen).

Ändert sich `worker/briefkasten.js` später, veröffentlichen Sie die neue Fassung erneut mit `npx wrangler deploy`. Im Dashboard fügen Sie den neuen Code wie in Schritt 3 ein.

## Datenschutz

Bitte klären Sie den Einsatz vorher mit der bzw. dem Datenschutzbeauftragten Ihrer Schule. Cloudflare verarbeitet Daten im Auftrag (Auftragsverarbeitung) und stellt dafür eine Vereinbarung bereit.

**Was ist verschlüsselt?**

* Rückmeldungen werden im Browser der Eltern **Ende-zu-Ende** verschlüsselt (ECDH P-256 und AES-GCM mit 256 Bit). Name und Code des Kindes und die Zeiten sind nur für die Lehrkraft lesbar.
* Der private Schlüssel verlässt den Browser der Lehrkraft nur in ihrer Zwischenspeicher-Datei. Weder Cloudflare noch Sie als Betreiber haben ihn.
* Lesen oder leeren kann einen Briefkasten nur, wer das Geheimnis der Lehrkraft kennt. Es liegt ebenfalls nur in ihrem Browser und im Zwischenspeicher.

**Was speichert der Briefkasten?**

* Tabelle `messages`: je Rückmeldung eine zufällige Kennung, die Kennung des Briefkastens (sie verrät nicht, zu welcher Lehrkraft er gehört), den Eingangszeitpunkt und den verschlüsselten Inhalt.
* Tabelle `directory`: Einträge für Eltern ohne QR-Code. Sie melden sich mit dem Termin-Schlüssel aus dem Elternbrief an und finden über diesen Eintrag den Briefkasten. Ein Eintrag enthält die Angaben aus dem Elternbrief: Name und E-Mail-Adresse der Lehrkraft, Adresse der Schule, Klasse, Tage, Uhrzeiten und den öffentlichen Schlüssel. Er ist verschlüsselt; der Schlüssel ergibt sich aus Lehrkräftecode, Klasse und Termin-Schlüssel des Elternbriefs. Namen von Kindern oder Eltern enthält er nicht. Ein Eintrag gehört dem Briefkasten, der ihn angelegt hat; wird er 200 Tage lang nicht erneuert, wird er gelöscht.
* IP-Adressen legt der Briefkasten **nicht** in der Datenbank ab.

**Was sieht Cloudflare?**

* Wie bei jeder Verbindung im Internet: die IP-Adressen von Eltern und Lehrkräften, den Zeitpunkt, die aufgerufene Adresse (mit der Kennung des Briefkastens), die Größe der verschlüsselten Daten und technische Angaben des Browsers.
* Um Massen-Einwürfe zu bremsen, merkt sich der Worker die IP-Adressen der letzten Einwürfe vorübergehend im Arbeitsspeicher, nicht in der Datenbank.
* Den Inhalt der Rückmeldungen kann Cloudflare nicht lesen.
* Cloudflare bietet für Worker Protokolle an („Observability“ bzw. „Workers Logs“). Sind sie eingeschaltet, speichert Cloudflare Angaben zu jeder Anfrage für einige Tage. Der Briefkasten braucht diese Protokolle nicht. Prüfen Sie in den Einstellungen des Workers, ob sie eingeschaltet sind, und schalten Sie sie bei Bedarf aus.

## Was passiert bei einem Ausfall?

Ist der Briefkasten nicht erreichbar – wegen einer Störung, weil die kostenlose Grenze erreicht ist oder weil die Adresse falsch eingetragen ist –, geht nichts verloren:

* **Eltern** sehen nach „Absenden“ eine verständliche Meldung. Sie können es erneut versuchen oder die Rückmeldung stattdessen per E-Mail schicken – als Rückmelde-PDF bzw. E-Mail-Text wie bisher.
* **Lehrkräfte** sehen im Abschnitt „Digitaler Briefkasten“ (Klassenübersicht bzw. Klasse) einen Hinweis, dass das Abrufen gerade nicht möglich ist. Rückmeldungen, die schon im Briefkasten liegen, bleiben dort und werden beim nächsten erfolgreichen Abruf übernommen. PDFs und E-Mail-Texte laden bzw. fügen sie wie bisher ein.
* Unter „Weitere Einstellungen“ → „Digitaler Briefkasten“ prüft der Knopf **„Verbindung prüfen“**, ob der Briefkasten erreichbar ist.

Soll der Briefkasten dauerhaft abgeschaltet werden, setzen Sie in `js/config.js` wieder `MAILBOX_URL = ''`. ParentsDay arbeitet dann wie vor der Einrichtung.

**Schlüssel verloren?** Löscht eine Lehrkraft ihre Browserdaten ohne gespeicherten Zwischenstand, kann niemand mehr die Rückmeldungen in ihrem Briefkasten lesen – auch Sie als Betreiber nicht. Die Eltern müssen ihre Rückmeldung dann erneut schicken. Erinnern Sie die Lehrkräfte deshalb daran, nach dem Erstellen der Elternbriefe einen Zwischenstand zu speichern. (Lädt eine Lehrkraft einen älteren Zwischenstand, der noch keinen Briefkasten enthält, behält ParentsDay den Briefkasten des Browsers. Enthält er einen anderen, warnt ParentsDay vor dem Laden.)

## Aufräumen nach dem Elternsprechtag

**Lehrkräfte** leeren ihren Briefkasten nach dem Elternsprechtag selbst: „Weitere Einstellungen“ → „Digitaler Briefkasten“ → **„Briefkasten leeren“**. Das löscht die Kopien auf dem Server; die übernommenen Zeiten bleiben in ParentsDay. Neue Rückmeldungen, die noch nicht abgeholt wurden, übernimmt ParentsDay vorher. Passt eine Rückmeldung zu keinem Kind (z. B. weil die Klasse in diesem Browser fehlt), fragt ParentsDay vor dem Löschen nach. Auch „Alle Daten in diesem Browser löschen“ leert den Briefkasten; sind dabei neue Rückmeldungen eingegangen, bietet ParentsDay vorher an, einen Zwischenstand zu speichern.

„Briefkasten leeren“ löscht nur die Rückmeldungen, die ParentsDay gerade abgeholt hat. Kommt währenddessen noch eine an, bleibt sie im Briefkasten und wird beim nächsten Abruf übernommen.

**Automatisch:** Der Cron-Trigger aus [Schritt 5](#schritt-5-tägliches-aufräumen-einschalten) löscht jeden Tag Rückmeldungen und Einträge für den Termin-Schlüssel, bevor sie 200 Tage alt sind. Rückmeldungen, die älter als 200 Tage sind, gibt der Briefkasten auch ohne Cron-Trigger nicht mehr heraus. Prüfen können Sie das Aufräumen im Dashboard unter „Settings“ → „Trigger Events“ bzw. in den Protokollen des Workers („Aufgeräumt: … Rückmeldungen, … Verzeichniseinträge“).

**Ohne Cron-Trigger** räumt der Briefkasten nur nebenbei auf (etwa bei jeder 50. neuen Rückmeldung). Kommen keine mehr an, bleiben alte Daten liegen. Richten Sie dann den Cron-Trigger ein oder räumen Sie **einmal im Monat** selbst auf:

1. Im Dashboard die Datenbank `parentsday` öffnen (Storage & Databases → D1 SQL Database) und den Reiter „Console“ wählen.
2. Diese Befehle eingeben und ausführen – sie löschen alles, was älter als 170 Tage ist. Bei monatlichem Aufräumen bleibt so nichts länger als 200 Tage gespeichert:
   ```sql
   DELETE FROM messages WHERE created_at < (CAST(strftime('%s', 'now') AS INTEGER) - 170 * 86400) * 1000;
   DELETE FROM directory WHERE updated_at < (CAST(strftime('%s', 'now') AS INTEGER) - 170 * 86400) * 1000;
   ```
   Eltern mit einem so alten Elternbrief finden den Briefkasten danach nicht mehr und nutzen den Weg per E-Mail.

**Briefkasten ganz abschalten:** Löschen Sie im Dashboard den Worker und die Datenbank. Setzen Sie in `js/config.js` wieder `MAILBOX_URL = ''` und entfernen Sie die Adresse aus `connect-src` in `index.html`.

## Häufige Probleme

| Beobachtung | Ursache und Lösung |
|---|---|
| „Verbindung prüfen“ meldet „nicht erreichbar“, aber `/v1/health` zeigt `{"ok":true,…}` | Die Adresse der ParentsDay-Seite fehlt in `ALLOWED_ORIGINS` (Schritt 6), oder die Worker-Adresse fehlt bei `connect-src` in `index.html` (Schritt 8). In den Entwicklerwerkzeugen des Browsers (Taste F12, Reiter „Konsole“) steht dann ein Hinweis auf „CORS“ bzw. „Content Security Policy“. |
| `/v1/health` lädt nicht | Adresse falsch abgetippt, Worker nicht veröffentlicht („Deploy“) oder die `workers.dev`-Adresse ist noch nicht freigeschaltet. Einige Minuten warten und erneut versuchen. |
| `{"error":"no-database"}` | Die Bindung `DB` fehlt oder ist anders geschrieben (Schritt 4). |
| „Verbindung prüfen“ meldet „Verbindung in Ordnung“, beim Abrufen der Rückmeldungen erscheint aber „hat einen Fehler gemeldet“ | „Verbindung prüfen“ fragt nur `/v1/health` ab, die Datenbank prüft es nicht. Prüfen Sie die Datenbank wie in [Schritt 7](#schritt-7-testen), Punkt 2. Meist fehlt die Bindung `DB`, oder die kostenlose Tagesgrenze der Datenbank ist erreicht. |
| In „Weitere Einstellungen“ fehlt die Karte „Digitaler Briefkasten“ | `MAILBOX_URL` in `js/config.js` ist leer, oder der Browser zeigt noch die alte Fassung. Seite neu laden (Strg + F5). |
| Eltern-Rückmeldungen kommen nicht im Briefkasten an | Die Elternbriefe wurden vor der Einrichtung erstellt und enthalten noch keinen Briefkasten. Elternbriefe neu erstellen. |
| Nach Mitternacht funktioniert wieder alles | Die kostenlose Tagesgrenze war erreicht (siehe [Kosten und Grenzen](#kosten-und-grenzen)). |

Für Entwickler: `tests/e2e/mailbox-server.mjs` startet den Briefkasten lokal (mit einer Nachbildung der D1-Datenbank auf Basis von `node:sqlite`). `npm test` und `npm run test:e2e` prüfen ihn zusammen mit der Web-App.
