# Digitaler Briefkasten und Cloud-Sicherung – Einrichtung und Betrieb

Diese Anleitung richtet sich an die Person, die ParentsDay an der Schule betreut. Programmierkenntnisse brauchen Sie nicht. Planen Sie für die Einrichtung etwa 30 Minuten ein.

Der digitale Briefkasten ist **freiwillig**. Solange er nicht eingerichtet ist, funktioniert ParentsDay wie bisher: Die Eltern schicken ihre Rückmeldung als PDF-Datei bzw. E-Mail-Text an die Lehrkraft.

Derselbe Dienst bewahrt auch die **Cloud-Sicherung** der Lehrkräfte auf: ihren kompletten Stand, mit ihrem Passwort verschlüsselt. Damit ist er auf jedem Gerät da, an dem sie sich anmelden (siehe [Cloud-Sicherung der Lehrkräfte](#cloud-sicherung-der-lehrkräfte)). Ohne Dienst gibt es keine Cloud-Sicherung; Lehrkräfte nehmen ihren Stand dann wie bisher per Zwischenstand-Datei mit.

**Sie betreiben den Briefkasten schon?** Für die Cloud-Sicherung brauchen Sie die neue Fassung des Workers. Wie Sie sie einspielen, steht unter [Worker aktualisieren](#worker-aktualisieren).

## Inhalt

1. [Was ist der digitale Briefkasten?](#was-ist-der-digitale-briefkasten)
2. [Cloud-Sicherung der Lehrkräfte](#cloud-sicherung-der-lehrkräfte)
3. [Kosten und Grenzen](#kosten-und-grenzen)
4. [Einrichtung im Cloudflare-Dashboard](#einrichtung-im-cloudflare-dashboard)
5. [Worker aktualisieren](#worker-aktualisieren)
6. [Alternative: Einrichtung per Kommandozeile](#alternative-einrichtung-per-kommandozeile)
7. [Datenschutz](#datenschutz)
8. [Was passiert bei einem Ausfall?](#was-passiert-bei-einem-ausfall)
9. [Aufräumen nach dem Elternsprechtag](#aufräumen-nach-dem-elternsprechtag)
10. [Häufige Probleme](#häufige-probleme)

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
* einer **D1-Datenbank**, in der die verschlüsselten Rückmeldungen bis zur Abholung liegen – und die verschlüsselten Cloud-Sicherungen der Lehrkräfte.

So funktioniert die Verschlüsselung:

* Erstellt eine Lehrkraft zum ersten Mal Elternbriefe, erzeugt ParentsDay in ihrem Browser einen eigenen Briefkasten mit einem Schlüsselpaar. Der **öffentliche** Schlüssel steht im QR-Code der Elternbriefe. Der **private** Schlüssel bleibt im Browser der Lehrkraft, in ihrer Zwischenspeicher-Datei und – mit ihrem Passwort verschlüsselt – in ihrer Cloud-Sicherung.
* Nur mit dem privaten Schlüssel lassen sich die Rückmeldungen lesen. Cloudflare und Sie als Betreiber können das nicht.
* Ohne Schlüssel sind die Rückmeldungen im Briefkasten nicht lesbar. Mit Cloud-Sicherung ist er nach der Anmeldung mit Passwort auf jedem Gerät der Lehrkraft da. Ohne Cloud-Sicherung sollte sie nach dem Erstellen der Elternbriefe einen Zwischenstand speichern.

**Der bisherige Weg bleibt als Notlösung erhalten.** Ist der Briefkasten nicht erreichbar, bietet die Elternseite wie bisher das Rückmelde-PDF und den Knopf „E-Mail an die Lehrkraft schreiben“ an. Lehrkräfte können PDFs und E-Mail-Texte weiterhin hochladen bzw. einfügen.

## Cloud-Sicherung der Lehrkräfte

Mit der Cloud-Sicherung liegt der **komplette Stand** einer Lehrkraft beim Dienst: Elternsprechtag, Klassen, Namen und Codes der Lernenden, Rückmeldungen, Termine, noch nicht gespeicherte Eingaben zum Elternsprechtag und der Schlüssel ihres Briefkastens. Meldet sie sich an einem anderen Gerät mit ihrem Passwort an, ist dort alles da – ohne Zwischenspeicher-Datei.

Die Cloud-Sicherung ist eingeschaltet, sobald der Briefkasten eingerichtet ist (`MAILBOX_URL`). Eine eigene Einstellung gibt es nicht. Sie braucht die aktuelle Fassung von `worker/briefkasten.js`: `/v1/health` meldet dann `"sync":3` (siehe [Worker aktualisieren](#worker-aktualisieren)).

**So nutzen die Lehrkräfte sie:**

* Bei der **Registrierung** legen sie ein Passwort für die Cloud-Sicherung fest (mindestens 10 Zeichen). Mit ihm melden sie sich künftig an. Es steht nicht in der Registrierungs-PDF. „Passwort auf diesem Gerät merken“ ist dabei voreingestellt. Wer sich erneut registriert (z. B. an einem neuen Gerät) und dasselbe Passwort wie bisher eingibt, bekommt seinen Stand aus der Cloud-Sicherung; die eben eingegebene E-Mail-Adresse gilt trotzdem. Mit einem anderen Passwort entsteht eine zweite, neue Sicherung. **Ausnahme – das Gerät ist schon mit einer Cloud-Sicherung eingerichtet** (auch ohne gemerktes Passwort oder wenn sie noch nicht angelegt ist): Dann entsteht bei der Registrierung keine weitere Sicherung, und das Gerät wechselt zu keiner anderen. Ob die bisherige Sicherung gelöscht wurde, auf einem anderen Gerät ein neues Passwort bekommen hat oder nur dieses Gerät beim Dienst ausgetragen ist, kann ParentsDay dort nicht sicher unterscheiden – der Dienst antwortet in allen Fällen gleich, und eine neue Sicherung entstünde womöglich still neben der umgezogenen. Mit demselben Passwort wird das Gerät ohne Anfrage beim Dienst (wieder) verbunden („Passwort merken“ wie im Formular gewählt) und gleicht ab; die Erfolgsseite meldet „Ihre Cloud-Sicherung bleibt verbunden. Dieses Gerät war schon mit Ihrer Cloud-Sicherung eingerichtet – Ihr Stand wird weiter damit abgeglichen.“ War das Gerät beim Dienst nur ausgetragen (er behält höchstens 20 Geräte je Sicherung), trägt das Passwort es dabei wieder ein – ebenso bei der Anmeldung mit Passwort. Ein anderes Passwort wird nicht übernommen: „Das eingegebene Passwort wurde nicht übernommen. Dieses Gerät ist schon mit einer Cloud-Sicherung eingerichtet, die ein anderes Passwort hat. …“ – ein neues Passwort legt man unter „Weitere Einstellungen“ fest. Meldet der Abgleich, dass das Gerät keinen Zugang mehr hat, heißt es „Ihre Cloud-Sicherung wurde inzwischen geändert. Sie hat auf einem anderen Gerät ein neues Passwort bekommen oder wurde gelöscht. …“, und die Lehrkraft gibt nach „Weiter“ oben über „Passwort eingeben“ das aktuelle Passwort ein (gibt es die Sicherung nicht mehr: dort „Passwort vergessen?“ → „Neue Cloud-Sicherung einrichten“ oder „Cloud-Sicherung auf diesem Gerät nicht mehr verwenden“). Ist die Sicherung des Geräts noch nicht angelegt (z. B. Registrierung ohne Verbindung), bleibt es ebenso bei ihrem Passwort – mit ihm wird sie angelegt. Sind für die Lehrkraft schon Daten in diesem Browser, übernimmt ParentsDay geänderte Angaben (z. B. eine neue E-Mail-Adresse) erst, wenn der Abgleich mit der Cloud-Sicherung fertig ist – so gilt ein veralteter Stand des Geräts nicht als der neuere, und die Adresse geht nicht verloren; die Registrierungs-PDF enthält sie sofort. Kann die Sicherung bei der Registrierung noch nicht angelegt werden (ohne Verbindung oder gesperrt), holt ParentsDay das nach; bis dahin melden sich die Lehrkräfte an anderen Geräten mit dem Registrierungscode an, an diesem Gerät klappt die Anmeldung mit Passwort schon.
* Lehrkräfte, die **schon registriert** sind (ohne Cloud-Sicherung), melden sich wie bisher mit Registrierungs-PDF oder Registrierungscode an. Danach fragt ParentsDay: Sind auf dem Gerät schon Daten, bietet es an, die Cloud-Sicherung einzurichten. Mit „Später“ geht es ohne weiter; dann fragt ParentsDay beim nächsten Anmelden wieder. Auf einem neuen oder leeren Gerät fragt es zuerst nach dem Passwort einer vorhandenen Sicherung („Noch keine Cloud-Sicherung? Jetzt einrichten“ bzw. „Ohne Cloud-Sicherung weiter“). Wer das übersprungen hat, findet auf der leeren Seite „Elternsprechtag erstellen“ neben „Zwischenstand laden“ auch den Knopf „Passwort der Cloud-Sicherung eingeben“. Einrichten lässt sie sich auch jederzeit über die Kopfzeile oder unter „Weitere Einstellungen“ → „Cloud-Sicherung“.
* **Anmelden mit Passwort:** Auf der Anmeldeseite geben sie bei „Mit Ihren Daten“ Vorname, Nachname, Geburtsdatum und ihr Passwort ein – an jedem Gerät. Ihr aktueller Stand wird dabei aus der Cloud-Sicherung geladen; haben Gerät und Cloud-Sicherung zwei verschiedene Stände, fragt ParentsDay, welcher gelten soll.
* **„Passwort auf diesem Gerät merken“** gibt es bei der Registrierung und beim Einrichten (dort voreingestellt) sowie im Dialog „Passwort eingeben“ (an einem weiteren Gerät zunächst leer; war das Gerät schon verbunden, gilt die bisherige Wahl). Auf der Anmeldeseite gibt es das Kästchen nicht: Die Anmeldung mit Passwort lässt die bisherige Wahl des Geräts unverändert; an einem neuen Gerät wird das Passwort dabei nicht gemerkt. Ohne Häkchen gilt das Passwort nur bis zum Abmelden bzw. bis der Tab geschlossen wird – richtig für fremde oder gemeinsam genutzte Computer. Mit Häkchen bleibt das Gerät auch nach dem Abmelden mit der Cloud-Sicherung verbunden (so steht es auch unter dem Kästchen, mit dem Zusatz „Nicht an fremden oder gemeinsam genutzten Computern.“); nach einer Anmeldung mit Registrierungs-PDF oder Registrierungscode entfällt dann die Eingabe. Gespeichert werden dabei nur die aus dem Passwort berechneten Schlüssel, nie das Passwort selbst.
* **Prüfung des Passworts:** Gehört das Passwort zu der Cloud-Sicherung, mit der das Gerät schon eingerichtet ist, bestätigt ParentsDay es im Browser, ohne den Dienst zu fragen. Das gilt auch, wenn das Passwort dort nicht gemerkt ist (z. B. nach dem Abmelden) oder die Sicherung noch gar nicht angelegt werden konnte (z. B. Registrierung ohne Verbindung). Es klappt also auch ohne Verbindung und zählt nicht als Versuch. Danach gleicht ParentsDay wie gewohnt ab und legt eine noch fehlende Sicherung an; wurde das Passwort inzwischen auf einem anderen Gerät geändert oder die Sicherung gelöscht, fragt es im Dialog „Passwort eingeben“ nach. „Eingerichtet“ heißt: Das Gerät wurde bei der Registrierung, beim Einrichten, mit „Passwort eingeben“ oder bei einer früheren Anmeldung mit Passwort mit dieser Sicherung verbunden und seitdem nicht mit „Meine Daten von diesem Gerät entfernen“, „Alle Daten in diesem Browser löschen“, „Nicht mehr verwenden“ oder „Cloud-Sicherung löschen“ davon gelöst. Sonst öffnet ParentsDay mit dem Passwort die Sicherung beim Dienst; ein falsches Passwort zählt dort als Fehlversuch (siehe „Schutz vor Ausprobieren und Missbrauch“ unten). Ist es falsch, speichert ParentsDay **nichts** auf dem Gerät und meldet niemanden an. Solange das Passwort geprüft wird, ist der Knopf „Anmelden“ gesperrt („Bitte warten …“), und die Links zum Umschalten zwischen Passwort und Registrierungscode reagieren nicht. Ohne Verbindung, mit einem Worker ohne Cloud-Sicherung (alte Fassung) oder während einer Sperre lässt sich das Passwort beim Dienst nicht prüfen. Dann melden sich die Lehrkräfte wie bisher mit der Registrierungs-PDF oder mit „Ohne Passwort mit Registrierungscode anmelden“ an; ParentsDay bietet den Wechsel an. Nach der Anmeldung mit PDF oder Registrierungscode fragt ParentsDay bei Bedarf im Dialog „Passwort eingeben“ nach dem Passwort. Welche Art – Passwort oder Registrierungscode – zuletzt geklappt hat, merkt sich der Browser und zeigt sie beim nächsten Mal zuerst.
* Danach gleicht ParentsDay im **Hintergrund** ab: Änderungen – auch Eingaben zum Elternsprechtag, die noch nicht gespeichert sind – werden kurz danach hochgeladen, neuere Stände von anderen Geräten übernommen. Haben zwei Geräte unabhängig voneinander geändert (z. B. eines ohne Internet), fragt ParentsDay, welcher Stand gelten soll. Im selben Dialog lässt sich der Stand dieses Geräts vorher als Zwischenstand-Datei speichern. Ist eine Seite leer, gilt ohne Rückfrage die andere. Zusammengeführt wird nicht. Die Kopfzeile zeigt den Zustand, z. B. „In der Cloud gesichert“.
* Beim **Abmelden** lädt ParentsDay offene Änderungen noch hoch. Mit „Meine Daten von diesem Gerät entfernen“ bleibt nichts auf dem Gerät zurück; die Cloud-Sicherung bleibt erhalten. Klappt das Hochladen nicht, bleiben die Daten auf dem Gerät.
* „Passwort ändern“ und „Cloud-Sicherung löschen“ stehen unter „Weitere Einstellungen“ → „Cloud-Sicherung“. Beides verlangt das Passwort, ein gemerktes Passwort genügt dafür nicht. **„Passwort ändern“** gleicht zuerst ab (ist der Stand danach nicht vollständig in der Cloud, z. B. ohne Verbindung, bricht es mit einem Hinweis ab) und legt ihn dann unter dem neuen Passwort als neue Sicherung an. Danach ersetzt es den Inhalt der alten Sicherung durch den Hinweis „umgezogen“ – nur, wenn sie inzwischen nicht auf einem anderen Gerät geändert wurde – und löscht sie. Wurde sie inzwischen geändert, wird die neue Sicherung wieder entfernt, und es bleibt alles beim Alten. Bricht die Verbindung mittendrin ab, wird nichts gelöscht; im schlimmsten Fall gibt es kurz beide Sicherungen, verloren geht nichts. Die anderen Geräte fragen danach einmal nach dem neuen Passwort. **„Cloud-Sicherung löschen“** entfernt die Sicherung beim Dienst; der Stand im Browser bleibt. Andere Geräte behalten ihren Stand, gleichen aber nicht mehr ab: Dort erscheint „Passwort nötig“ bzw. nach der Anmeldung „Passwort eingeben“ (lösen lassen sie sich mit „Nicht mehr verwenden“, siehe unten). An neuen Geräten melden sich die Lehrkräfte danach wieder mit Registrierungs-PDF oder Registrierungscode an.
* **„Passwort vergessen?“** gibt es auf der Karte „Cloud-Sicherung“, im Dialog „Passwort eingeben“ und im Dialog „Passwort ändern“ („Bisheriges Passwort vergessen?“). Auf der Anmeldeseite führt es zur Anmeldung mit dem Registrierungscode; ein neues Passwort legt die Lehrkraft danach fest. Ist das Gerät noch verbunden, legt die Lehrkraft dort einfach ein neues Passwort fest; sonst richtet sie eine neue Sicherung ein (siehe [Passwort vergessen?](#was-passiert-bei-einem-ausfall)).
* Fragt ein Gerät nach dem Passwort, das es nicht mehr gibt (z. B. weil die Sicherung auf einem anderen Gerät gelöscht wurde), lösen die Lehrkräfte es mit **„Nicht mehr verwenden“** (Karte „Cloud-Sicherung“) bzw. „Cloud-Sicherung auf diesem Gerät nicht mehr verwenden“ (Dialog „Passwort eingeben“) von der Cloud-Sicherung. Der Stand im Browser bleibt, die Sicherung beim Dienst ebenfalls.
* **„Alle Daten in diesem Browser löschen“** lädt zuerst offene Änderungen hoch (höchstens 8 Sekunden). Danach entfernt es nur die Daten in diesem Browser und trennt das Gerät von der Cloud-Sicherung. Die Sicherung selbst bleibt erhalten. Der Dialog sagt dazu, ob der Stand des Geräts vollständig in der Cloud-Sicherung ist. Ist er es nicht (keine Verbindung oder Passwort nicht eingegeben), warnt er: Was seit dem letzten Abgleich geändert wurde, geht beim Löschen verloren.

**So ist sie geschützt:**

* Aus dem Passwort berechnet der Browser mit PBKDF2-SHA256 in 600.000 Durchläufen einen Wert von 256 Bit. Als Salt dient ein Hashwert aus Vorname, Nachname und Geburtsdatum der Lehrkraft; Schreibweise, Umlaute und Akzente der Namen spielen dabei keine Rolle. Aus diesem Wert entstehen mit HKDF-SHA256 vier getrennte Werte:
  * die **Adresse** der Sicherung beim Dienst,
  * der **Schlüssel** für die Verschlüsselung (AES-GCM mit 256 Bit),
  * das **Zugangs-Token** zum Abrufen und Speichern,
  * das **Admin-Token** zum Löschen. Es wird auf keinem Gerät gespeichert; zum Löschen ist deshalb immer das Passwort nötig.
* Weil auch die Adresse aus dem Passwort entsteht, lässt sich eine Sicherung über den Dienst ohne das Passwort weder finden noch lesen, überschreiben oder löschen – auch nicht mit Namen und Geburtsdatum der Lehrkraft. (Das Geburtsdatum lässt sich aus dem Lehrkräftecode berechnen, der in jedem Code der Kinder steht. Als Schutz taugt es deshalb nicht.)
* Zusätzlich schickt der Browser eine **Kennung der Lehrkraft** mit (`who`), einen Hashwert aus Namen und Geburtsdatum. Der Dienst legt eine Sicherung unter dem SHA-256-Hashwert aus Kennung und Adresse ab; Kennung und Adresse selbst speichert er nicht. Abrufen, Speichern und Löschen verlangen deshalb neben dem Token auch die Kennung (im Kopf `X-Who`).
* Der Stand wird im Browser mit gzip verkleinert und dann verschlüsselt. Adresse und Versionsnummer sind dabei mit verschlüsselt (als Zusatzdaten von AES-GCM). So lassen sich Daten weder einer anderen Sicherung noch als andere Version unterschieben. Bekommt ein Gerät einen älteren Stand, als es schon kennt (z. B. nachdem jemand eine alte Datenbank zurückgespielt hat), übernimmt es ihn nicht, sondern lädt seinen eigenen Stand wieder hoch. Passwort und Schlüssel verlassen den Browser nie. Von den beiden Tokens speichert der Dienst nur SHA-256-Hashwerte. Daraus lassen sich weder die Tokens noch der Schlüssel berechnen.
* **Geräte:** Jeder Browser bekommt für die Lehrkraft ein zufälliges Geräte-Geheimnis. Öffnet sie ihre Sicherung dort mit dem Passwort, trägt der Dienst dessen Hashwert bei der Sicherung ein (höchstens 20 Geräte; kommt ein weiteres dazu, fällt das Gerät heraus, das die Sicherung am längsten nicht mehr mit dem Passwort geöffnet hat). Abrufen, Speichern und Löschen gehen nur von eingetragenen Geräten. Das Geräte-Geheimnis bleibt im Browser, auch wenn das Passwort nicht gemerkt wird. Wer sich an einem Computer immer wieder ohne „merken“ anmeldet, bleibt so dasselbe eingetragene Gerät und verdrängt keine anderen. Bei der Anmeldung mit Passwort speichert ParentsDay ein neues Geräte-Geheimnis erst, wenn das Passwort bestätigt ist – im Browser oder vom Dienst (auch wenn danach nur das Lesen des Stands scheitert). Bei einem falschen Passwort, einer umgezogenen Sicherung oder ohne Antwort des Dienstes bleibt es nicht im Browser. Weitere Versuche verwenden bis zum Neuladen der Seite dasselbe Geheimnis – erneut auf der Anmeldeseite, aber auch „Passwort eingeben“ oder das Einrichten danach (z. B. nach einer Anmeldung mit Registrierungscode): Ging nur die Antwort verloren, ist das Gerät beim Dienst schon eingetragen, und es kommt kein zweites dazu. Entfernt wird das Geräte-Geheimnis mit „Meine Daten von diesem Gerät entfernen“, „Alle Daten in diesem Browser löschen“, „Nicht mehr verwenden“ und „Cloud-Sicherung löschen“.
* Ohne das Passwort kann niemand die Sicherung lesen – weder Cloudflare noch Sie als Betreiber noch ParentsDay. Ein vergessenes Passwort lässt sich deshalb auch nicht wiederherstellen. Wer die Datenbank verwaltet, kann eine Sicherung allerdings löschen. Die Geräte fragen dann nach dem Passwort; ihr Stand bleibt im Browser.

**Schutz vor Ausprobieren und Missbrauch:**

* Versuche, eine Sicherung auf einem Gerät zu öffnen oder neu anzulegen, zählt der Dienst **je Lehrkraft** (anhand der Kennung). Passt die Kennung nicht zur Sicherung, gilt das Passwort als falsch. Erlaubt sind höchstens **10 Versuche je Stunde** und Anschluss (IPv4-Adresse bzw. bei IPv6 die ersten 64 Bit) und **30 Versuche am Tag** insgesamt. Gelungenes Öffnen zählt nicht. Dazu gehört auch die Anmeldung mit Passwort: Ein falsches Passwort zählt als Fehlversuch. Gehört das eingegebene zu der Cloud-Sicherung, mit der das Gerät schon eingerichtet ist (gemerkt oder nicht), bestätigt ParentsDay es im Browser und fragt den Dienst gar nicht. Anlegen zählt immer, auch wenn es klappt – sonst ließe sich über die Antwort „gibt es schon“ ohne Grenze raten. Über der Grenze antwortet der Dienst mit `429`, bis die laufende Stunde bzw. der Tag (UTC) vorbei ist; diese abgewiesenen Anfragen zählen nicht mit. ParentsDay meldet dann: „Für Ihre Cloud-Sicherung gab es zu viele Versuche mit einem falschen Passwort (nicht unbedingt von Ihnen). Zum Schutz Ihrer Daten ist das Öffnen und Einrichten für … Minuten gesperrt. Geräte, die schon verbunden sind, gleichen weiter ab.“ (bei höchstens einer Minute „für eine Minute“, bei mehr als 90 Minuten „bis morgen“). Der Abgleich eingetragener Geräte zählt tatsächlich nicht als Versuch und ist von der Sperre nicht betroffen.
* **Neue Sicherungen** nimmt der Dienst je Anschluss und Tag (UTC) höchstens **20-mal** und zusammen höchstens **5 Millionen Zeichen** an (Antwort `429`). Als ein Anschluss gilt dabei eine IPv4-Adresse bzw. bei IPv6 das ganze /48-Netz (die ersten 48 Bit; so viel bekommt ein Anschluss höchstens). Diese Grenze zählt nicht als Versuch der Lehrkraft. Auch „Passwort ändern“ und „Passwort vergessen?“ legen eine neue Sicherung an und zählen mit. Schulen teilen sich oft eine IP-Adresse: Richten mehr Lehrkräfte am selben Tag im Schulnetz ihre Sicherung ein, holt ParentsDay das Einrichten nach Mitternacht (UTC) von selbst nach.
* Gezählt wird in der Tabelle `cloud_limits`. Statt der IP-Adresse steht dort nur ein pseudonymer Hashwert, der jeden Tag wechselt: mit dem Secret `IP_HASH_KEY` ein HMAC-SHA256-Wert ([Schritt 6](#schritt-6-optional-erlaubte-web-adressen-und-weitere-einstellungen)), sonst ein SHA-256-Wert mit einem Zufallswert des Tages aus der Tabelle `meta` (siehe [Datenschutz](#datenschutz)). Die Zähler löscht der tägliche Cron-Trigger nach 2 Tagen.
* Abrufen, Speichern und Löschen antworten bei jedem Fehler gleich (`403`), auch bei falscher Kennung. Ohne Passwort ist also nicht zu erkennen, ob es eine Sicherung gibt.
* Öffnen, Anlegen und Speichern nimmt der Dienst höchstens 120-mal je IP-Adresse und Minute an (einstellbar mit `SYNC_WRITES_PER_MINUTE`, siehe Schritt 6). Der Wert ist höher als bei den Rückmeldungen, weil sich die Lehrkräfte einer Schule oft eine IP-Adresse teilen.
* Sicherungen, die nach dem Anlegen nie geändert, abgerufen oder geöffnet wurden, löscht der Cron-Trigger nach 30 Tagen. So bleiben auch Sicherungen, die Fremde nur zum Ausprobieren angelegt haben, nicht lange liegen.

**Was dieser Schutz nicht verhindert (Restrisiken):**

* Wer Namen und Geburtsdatum einer Lehrkraft kennt, kann ihre **30 Versuche eines Tages aufbrauchen** – mit 10 je Stunde auch von einem einzigen Anschluss aus, mit mehreren Anschlüssen schneller. Das Geburtsdatum lässt sich aus jedem Code der Kinder berechnen, das kann also praktisch jede Person, die einen Elternbrief der Lehrkraft gesehen hat. Bis Mitternacht (UTC) lässt sich die Sicherung dann auf **neuen** Geräten weder öffnen noch einrichten; auch die Anmeldung mit Passwort, „Passwort ändern“ und „Passwort vergessen?“ gehen dort erst am nächsten Tag wieder. Anmelden kann sich die Lehrkraft in dieser Zeit mit Registrierungs-PDF oder Registrierungscode. Geräte, die schon verbunden sind, gleichen ungestört weiter ab. Lesen, ändern oder löschen kann der Angreifer die Sicherung nicht. Im Notfall heben Sie als Betreiber mit `DELETE FROM cloud_limits;` in der Console der Datenbank alle Zählungen auf.
* Wer es darauf anlegt, kann die **kostenlose Tagesgrenze der Datenbank** aufbrauchen: Jeder Versuch schreibt ein paar Zeilen, auch ein abgewiesener. Bis Mitternacht (UTC) sind Briefkasten und Cloud-Sicherung dann nicht erreichbar; verloren geht nichts. Mehr dazu und wie Sie das erschweren können: [Absichtlich aufgebrauchte Tagesgrenzen](#absichtlich-aufgebrauchte-tagesgrenzen).

**Größe:** Ein Stand mit 10 Klassen zu je 28 Lernenden samt Rückmeldungen und Terminen ist verschlüsselt und komprimiert etwa 8 KB groß (rund 11.000 Zeichen). Der Dienst nimmt je Sicherung bis zu 720.000 Zeichen an, das sind etwa 540 KB. Ist ein Stand größer, meldet ParentsDay das und verweist auf „Zwischenstand speichern“. Alle Sicherungen zusammen dürfen höchstens 250 Millionen Zeichen belegen, die Hälfte der 500 MB, die eine Datenbank im kostenlosen Tarif fasst. Gezählt wird die tatsächliche Größe: Platz ist für mehr als 20.000 Sicherungen dieser Größe. Ist die Grenze erreicht, lehnt der Dienst neue Sicherungen ab (Antwort `507`), und ParentsDay versucht das Einrichten stündlich erneut. Vorhandene werden weiter gespeichert.

**Datenbank:** Die Cloud-Sicherung nutzt vier eigene Tabellen: `backups` (je Sicherung eine Zeile), `backup_chunks` (die verschlüsselten Daten in Stücken von höchstens 90.000 Zeichen, weil D1 je SQL-Anweisung höchstens 100 KB annimmt), `cloud_limits` (Zähler für Versuche und neue Sicherungen) und `meta` (der Zufallswert des Tages für die Hashwerte der IP-Adressen, nur ohne `IP_HASH_KEY`). Alle vier legt der Worker bei der ersten Anfrage selbst an – auch in einer Datenbank, die schon in Betrieb ist. Die Tabellen der Vorabfassungen (`sync`, `sync_chunks`, `cloud`, `cloud_chunks`) löscht er dabei. Ein Stand wird zusammen mit allen Stücken in einem Zug gespeichert (als Transaktion). Kommen zwei Speichervorgänge gleichzeitig, bleibt einer vollständig erhalten, und der andere bekommt die Antwort `409`.

**Aufräumen:** Wird eine Cloud-Sicherung **400 Tage** lang weder geändert noch abgerufen, löscht sie der tägliche Cron-Trigger aus [Schritt 5](#schritt-5-tägliches-aufräumen-einschalten). Sicherungen, die nach dem Anlegen nie genutzt wurden, löscht er schon nach **30 Tagen**. Jede Änderung, jeder Abruf von einem eingetragenen Gerät und jedes Öffnen mit dem richtigen Passwort zählt als Nutzung (ParentsDay ruft eine neue Sicherung gleich nach dem Anlegen einmal ab). Die Zähler für Versuche löscht er nach 2 Tagen.

**Schnittstelle** (für Technik-Interessierte; ausführlich im Kopfkommentar von `worker/briefkasten.js`). Die Tokens stehen im Kopf `Authorization: Bearer <Token>`, die Kennung der Lehrkraft im Kopf `X-Who`, das Geräte-Geheimnis im Kopf `X-Device`. Einen öffentlichen Abruf ohne Token gibt es nicht.

| Anfrage | Zweck |
|---|---|
| `POST /v1/sync/<Adresse>/open` | Sicherung auf einem Gerät öffnen (Zugangs-Token), z. B. bei der Anmeldung mit Passwort oder im Dialog „Passwort eingeben“. Im Text stehen die Kennung der Lehrkraft (`who`) und der Hashwert des Geräte-Geheimnisses (`device`). Antwort `{"found":false}` (falsches Passwort, falsche Kennung oder keine Sicherung; der Versuch zählt) oder der verschlüsselte Stand. Danach ist das Gerät eingetragen |
| `GET /v1/sync/<Adresse>` | Stand abrufen (Zugangs-Token, `X-Who` und `X-Device`). Mit `?since=<Version>` antwortet der Dienst bei unverändertem Stand nur kurz mit `"unchanged":true` |
| `PUT /v1/sync/<Adresse>` | Neu anlegen (Zugangs-Token) mit `baseVersion` 0, der Kennung `who` und den Hashwerten beider Tokens und des Geräte-Geheimnisses. Das zählt immer als Versuch; gibt es die Sicherung für diese Kennung schon, antwortet der Dienst mit `409`. Über den Grenzen je Anschluss antwortet er mit `429`, bei vollem Speicher mit `507` (beides zählt nicht als Versuch). Ändern mit Zugangs-Token, `X-Who`, `X-Device` und `baseVersion`, der Version, auf der der Stand beruht. Hat inzwischen ein anderes Gerät gespeichert, antwortet der Dienst mit `409` |
| `DELETE /v1/sync/<Adresse>` | Sicherung löschen (Admin-Token, `X-Who` und `X-Device`) |

## Kosten und Grenzen

Briefkasten und Cloud-Sicherung kommen mit den **kostenlosen Tarifen** von Cloudflare aus. Zahlungsdaten brauchen Sie dafür nicht.

| Dienst | Kostenlose Grenze (Stand: September 2026) |
|---|---|
| Workers Free | 100.000 Anfragen pro Tag, 10 ms Rechenzeit (CPU) je Anfrage |
| D1 Free | 5 Millionen gelesene Zeilen pro Tag, 100.000 geschriebene Zeilen pro Tag, 5 GB Speicher insgesamt (höchstens 500 MB je Datenbank) |
| D1 je Anfrage | höchstens 50 Datenbankabfragen je Aufruf des Workers, 100 KB je SQL-Anweisung, 2 MB je Zeile |

Quellen: [Workers – Limits](https://developers.cloudflare.com/workers/platform/limits), [D1 – Pricing](https://developers.cloudflare.com/d1/platform/pricing/) und [D1 – Limits](https://developers.cloudflare.com/d1/platform/limits/)

**Was passiert, wenn eine Grenze überschritten wird?** Es entstehen keine Kosten. Cloudflare lehnt weitere Anfragen ab, bis die Grenzen um Mitternacht UTC zurückgesetzt werden (in Deutschland um 1 Uhr, im Sommer um 2 Uhr). Für die Datenbank gilt das seit dem 1. September 2026: Abfragen im kostenlosen Tarif schlagen dann fehl. ParentsDay meldet in dieser Zeit, dass der digitale Briefkasten nicht erreichbar ist bzw. einen Fehler gemeldet hat, und die Eltern nutzen die Notlösung per E-Mail. Bei der Cloud-Sicherung zeigt die Kopfzeile „Cloud nicht erreichbar – wird nachgeholt“. Alle Daten bleiben im Browser der Lehrkraft und werden später hochgeladen. Im normalen Betrieb reichen die Grenzen weit (siehe unten); jemand kann sie aber absichtlich aufbrauchen (siehe [Absichtlich aufgebrauchte Tagesgrenzen](#absichtlich-aufgebrauchte-tagesgrenzen)).

**Reicht das für unsere Schule?** Sehr wahrscheinlich ja, mit viel Abstand. Eine grobe Rechnung:

* Eine Rückmeldung braucht etwa 2 Anfragen (eine Vorabfrage des Browsers und den eigentlichen Einwurf).
* Jeder Abruf der Lehrkraft braucht ebenfalls etwa 2 Anfragen. Abgerufen wird beim Öffnen der Klassenübersicht oder einer Klasse (höchstens alle 30 Sekunden) und per Knopf.
* Eine Schule mit 60 Lehrkräften und je 30 Kindern bekommt 1.800 Rückmeldungen – verteilt über mehrere Tage oder Wochen. Das sind wenige tausend Anfragen pro Tag.
* Die Verschlüsselung erledigen die Browser. Der Worker braucht je Anfrage nur sehr wenig Rechenzeit.

Dazu kommt die Cloud-Sicherung:

* **Hochladen:** Nach einer Änderung wartet ParentsDay 2 Sekunden auf weitere Änderungen und lädt dann den ganzen Stand in einer Anfrage hoch. Wer ohne Pause weiterarbeitet, löst spätestens alle 10 Sekunden ein Hochladen aus. Das sind höchstens 6 Anfragen pro Minute und Lehrkraft, meist viel weniger. Speichern ohne inhaltliche Änderung löst kein Hochladen aus. Jedes Hochladen schreibt nur wenige Zeilen in die Datenbank, bei einem üblichen Stand (ein Stück) etwa 3.
* **Abgleich:** Solange ParentsDay sichtbar geöffnet ist, fragt die Seite alle 3 Minuten nach einem neueren Stand. Dazu kommen Abfragen beim Anmelden und beim Zurückkehren auf die Seite (höchstens alle 30 Sekunden). Tabs im Hintergrund fragen nicht. Die Seite schickt dabei die Version mit, die sie schon kennt (`?since=`). Ist nichts neu, antwortet der Dienst nur kurz: Die Datenbank liest dafür eine Zeile und schreibt keine. Nur einmal am Tag vermerkt sie, dass die Sicherung noch genutzt wird.
* **Keine Zähler für eingetragene Geräte:** Abrufen und Speichern von einem eingetragenen Gerät schreiben nichts in die Tabelle der Zähler. Nur das Öffnen auf einem neuen Gerät und das Anlegen einer Sicherung schreiben dafür ein paar Zeilen.
* **Grobe Rechnung:** Eine Lehrkraft, die an einem Tag 3 Stunden mit ParentsDay arbeitet, braucht für den Abgleich etwa 60 Anfragen. Fürs Hochladen kommen je nach Arbeit einige Dutzend bis etwa 100 dazu. Selbst wenn alle 60 Lehrkräfte einer Schule am selben Tag so arbeiten, sind das rund 10.000 Anfragen und 20.000 geschriebene Zeilen – ein Zehntel bzw. ein Fünftel der Tagesgrenzen.
* **Speicher:** Alle Cloud-Sicherungen zusammen belegen höchstens 250 Millionen Zeichen, also etwa die Hälfte der 500 MB je Datenbank. Für Rückmeldungen und Verzeichnis bleibt genug Platz.
* Auch die Grenze von 50 Datenbankabfragen je Aufruf hält der Worker ein: Ein Stand hat höchstens 8 Stücke, Speichern braucht damit höchstens etwa 30 Abfragen.

Der Briefkasten setzt außerdem eigene Grenzen:

* höchstens 16 KB je Rückmeldung (eine normale Rückmeldung ist viel kleiner),
* höchstens 3.000 Rückmeldungen je Lehrkraft,
* höchstens 30 Rückmeldungen je IP-Adresse und Minute, damit niemand den Briefkasten mit Massen-Einwürfen füllt (einstellbar, siehe Schritt 6),
* Rückmeldungen und Einträge für den Termin-Schlüssel werden nach spätestens 200 Tagen gelöscht (täglicher Cron-Trigger, Schritt 5),
* höchstens 720.000 Zeichen je Cloud-Sicherung (etwa 540 KB, verschlüsselt und komprimiert),
* höchstens 250 Millionen Zeichen für alle Cloud-Sicherungen zusammen (gezählt wird die tatsächliche Größe),
* höchstens 20 neue Cloud-Sicherungen mit zusammen höchstens 5 Millionen Zeichen je Anschluss und Tag (IPv4-Adresse bzw. IPv6-/48-Netz),
* beim Öffnen und Anlegen einer Cloud-Sicherung höchstens 10 Versuche je Lehrkraft, Anschluss und Stunde und 30 je Lehrkraft und Tag (gelungenes Öffnen zählt nicht, Anlegen immer),
* höchstens 20 eingetragene Geräte je Cloud-Sicherung,
* höchstens 120 Anfragen zum Öffnen, Anlegen und Speichern der Cloud-Sicherung je IP-Adresse und Minute (einstellbar, siehe Schritt 6),
* Cloud-Sicherungen, die 400 Tage weder geändert noch abgerufen wurden, werden gelöscht, nie genutzte schon nach 30 Tagen, die Zähler für Versuche nach 2 Tagen (Cron-Trigger, Schritt 5).

### Absichtlich aufgebrauchte Tagesgrenzen

Die kostenlosen Grenzen gelten für Ihr ganzes Cloudflare-Konto. Wer es darauf anlegt, kann sie mit vielen Anfragen aufbrauchen, vor allem die 100.000 geschriebenen Zeilen der Datenbank am Tag: Jede Rückmeldung schreibt eine Zeile, jeder Versuch, eine Cloud-Sicherung zu öffnen oder anzulegen, ein paar Zeilen in die Zähler – auch ein Versuch, den der Dienst über der Grenze abweist, denn er muss ihn dafür erst zählen. Die Grenzen des Workers je IP-Adresse bremsen das nur: Mit vielen IP-Adressen (bei IPv6 leicht zu haben) geht es schnell, von einem einzelnen Anschluss aus in einigen Stunden. Ebenso lassen sich die 100.000 Anfragen des Workers aufbrauchen. Bis Mitternacht (UTC) sind Briefkasten und Cloud-Sicherung dann nicht erreichbar. Kosten entstehen nicht, und verloren geht nichts: Die Eltern schicken ihre Rückmeldung per E-Mail, die Cloud-Sicherung holt das Hochladen nach (siehe [Was passiert bei einem Ausfall?](#was-passiert-bei-einem-ausfall)). Tun müssen Sie nichts.

**Optional** können Sie Massenanfragen einzelner IP-Adressen mit einer Regel der Cloudflare-Firewall (WAF, „Rate limiting rule“) abweisen, bevor sie den Worker erreichen. Solche Regeln gelten nur für eine eigene Domain, die bei Cloudflare verwaltet wird – nicht für die `workers.dev`-Adresse. Sie brauchen dafür also eine Domain bei Cloudflare:

1. Worker öffnen → „Settings“ → „Domains & Routes“ → „Add“ → „Custom domain“ und eine Adresse Ihrer Domain eintragen, z. B. `briefkasten.meine-schule.de`.
2. In der Domain unter „Security“ → „WAF“ → „Rate limiting rules“ (bei manchen Konten „Security rules“) eine Regel anlegen: Bedingung „URI Path“ „starts with“ `/v1/`, gezählt je IP-Adresse, z. B. mehr als 100 Anfragen in 10 Sekunden, Aktion „Block“. Im kostenlosen Tarif gibt es eine solche Regel, mit festem Zeitraum von 10 Sekunden. Wählen Sie die Grenze großzügig, denn die Lehrkräfte einer Schule teilen sich oft eine IP-Adresse.
3. Die neue Adresse wie in [Schritt 8](#schritt-8-adresse-in-parentsday-eintragen) in `js/config.js` und `index.html` eintragen. Vorhandene Elternbriefe bleiben gültig, die Adresse des Dienstes steht nicht im QR-Code.
4. Die `workers.dev`-Adresse abschalten („Settings“ → „Domains & Routes“ → bei `workers.dev` „Disable“). Sonst lässt sich die Regel über diese Adresse umgehen.

Gegen Anfragen von sehr vielen verschiedenen IP-Adressen hilft auch diese Regel nur begrenzt.

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

Tabellen müssen Sie nicht anlegen. Das erledigt der Briefkasten bei der ersten Anfrage selbst (auch die Tabellen `backups`, `backup_chunks`, `cloud_limits` und `meta` für die Cloud-Sicherung).

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

Rückmeldungen und Einträge für den Termin-Schlüssel dürfen höchstens 200 Tage gespeichert bleiben – das sagen die Datenschutz-Hinweise von ParentsDay den Eltern zu. Cloud-Sicherungen, die 400 Tage weder geändert noch abgerufen wurden, sollen ebenfalls verschwinden (nie genutzte schon nach 30 Tagen), die Zähler für Versuche (mit den Hashwerten der IP-Adressen) nach 2 Tagen. Gelöscht wird all das von einem **Cron-Trigger**, den Cloudflare einmal am Tag startet:

1. Worker `parentsday-briefkasten` öffnen → „Settings“ → „Trigger Events“ (bei manchen Konten „Triggers“).
2. „Add“ → „Cron Triggers“ wählen.
3. Zeitplan: einmal täglich, z. B. als Ausdruck („Cron expression“) **`17 3 * * *`** (jeden Tag um 3:17 Uhr UTC).
4. Mit „Add“ bzw. „Deploy“ speichern.

Der Cron-Trigger kostet nichts extra. Ohne ihn gibt der Briefkasten ältere Rückmeldungen zwar nicht mehr heraus, sie blieben aber in der Datenbank liegen. Alte Cloud-Sicherungen und Zähler blieben ebenfalls liegen (siehe [Aufräumen](#aufräumen-nach-dem-elternsprechtag)).

### Schritt 6 (optional): Erlaubte Web-Adressen und weitere Einstellungen

Der Briefkasten nimmt Anfragen aus dem Browser nur von bestimmten Web-Adressen an. Voreingestellt ist `https://parentsday.janrickmer.de`. Läuft ParentsDay bei Ihnen unter einer anderen Adresse, stellen Sie sie so ein:

1. Worker öffnen → „Settings“ → „Variables and Secrets“ → „Add“.
2. Typ: „Text“. Name: **`ALLOWED_ORIGINS`**
3. Wert: die Adresse Ihrer ParentsDay-Seite, z. B. `https://parentsday.meine-schule.de` – ohne Schrägstrich am Ende. Mehrere Adressen trennen Sie mit Kommas. Zum Ausprobieren auf dem eigenen Rechner (`npm start`) ergänzen Sie `http://localhost:8080`.
4. Mit „Deploy“ speichern.

Ebenso können Sie **`POSTS_PER_MINUTE`** setzen: So viele Rückmeldungen nimmt der Briefkasten je IP-Adresse und Minute an (Standard: 30). Mit **`SYNC_WRITES_PER_MINUTE`** legen Sie fest, wie oft je IP-Adresse und Minute eine Cloud-Sicherung geöffnet, angelegt oder gespeichert werden darf (Standard: 120). Erhöhen Sie diesen Wert nur, wenn sehr viele Lehrkräfte gleichzeitig über dieselbe Internetverbindung der Schule arbeiten.

**Schlüssel für die IP-Hashwerte (`IP_HASH_KEY`, aus Datenschutzsicht empfohlen):** Um Versuche an der Cloud-Sicherung zu zählen, speichert der Briefkasten statt IP-Adressen pseudonyme Hashwerte, die jeden Tag wechseln (siehe [Datenschutz](#datenschutz)). Ohne diese Einstellung steht der Zufallswert dafür mit in der Datenbank. Mit einem geheimen Schlüssel, den nur der Worker kennt, lassen sich die Hashwerte auch mit Zugriff auf die Datenbank keiner IP-Adresse zuordnen. So legen Sie ihn an:

1. Worker öffnen → „Settings“ → „Variables and Secrets“ → „Add“.
2. Typ: **„Secret“** (nicht „Text“). Name: **`IP_HASH_KEY`**
3. Wert: eine lange Zufallsfolge aus mindestens 32 Zeichen, z. B. aus einem Passwort-Manager oder mit `openssl rand -base64 32`. Aufschreiben müssen Sie ihn nicht: Cloudflare zeigt den Wert nach dem Speichern nicht mehr an, und sonst braucht ihn niemand.
4. Mit „Deploy“ speichern.

Ab dann gilt der Schlüssel. Ändern oder löschen Sie ihn später, beginnen nur die Zähler je Anschluss von vorn.

### Schritt 7: Testen

1. Öffnen Sie im Browser die Adresse Ihres Workers mit `/v1/health` am Ende, z. B.
   `https://parentsday-briefkasten.ihr-kontoname.workers.dev/v1/health`
   Dort muss stehen: `{"ok":true,"service":"ParentsDay-Briefkasten","version":4,"sync":3}`
   (`"sync":3` heißt: Diese Fassung kennt die aktuelle Cloud-Sicherung. Steht dort eine kleinere `"version"` als 4, ist es eine ältere Fassung – siehe [Worker aktualisieren](#worker-aktualisieren).)
2. Prüfen Sie die Datenbank mit dieser Adresse (32-mal der Buchstabe A):
   `https://parentsday-briefkasten.ihr-kontoname.workers.dev/v1/directory/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
   * `{"found":false}` – richtig so: Die Datenbank ist verbunden. (Ältere Fassungen des Briefkastens antworten hier `{"error":"not-found"}` – auch das ist in Ordnung.)
   * `{"error":"no-database"}` – die Verbindung aus Schritt 4 fehlt.
   * `{"error":"server-error"}` – die Datenbank meldet einen Fehler. Prüfen Sie Schritt 2 und 4.
3. Prüfen Sie die Cloud-Sicherung mit dieser Adresse (wieder 32-mal A):
   `https://parentsday-briefkasten.ihr-kontoname.workers.dev/v1/sync/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
   * `{"error":"forbidden"}` – richtig so: Die Tabellen für die Cloud-Sicherung sind angelegt, und ohne Passwort gibt der Dienst nichts heraus.
   * `{"error":"not-found"}` – der Worker ist eine ältere Fassung ohne Cloud-Sicherung.
   * `{"found":false}` – der Worker ist eine Vorabfassung der Cloud-Sicherung (siehe [Worker aktualisieren](#worker-aktualisieren)).
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

**Kontrolle:** Bei der Registrierung fragt ParentsDay jetzt nach einem Passwort für die Cloud-Sicherung. Melden Sie sich als Lehrkraft an und öffnen Sie „Weitere Einstellungen“. Dort stehen jetzt die Karten „Cloud-Sicherung“ und „Digitaler Briefkasten“. Nach dem Erstellen von Elternbriefen können Sie dort auf „Verbindung prüfen“ klicken. Die Datenschutz-Hinweise von ParentsDay enthalten jetzt automatisch Abschnitte zur Cloud-Sicherung und zum Briefkasten.

**Wichtig:** Nur Elternbriefe, die **nach** dieser Umstellung erstellt werden, enthalten den Briefkasten im QR-Code. Eltern mit älteren Briefen schicken ihre Rückmeldung weiter per E-Mail. Lehrkräfte können die Elternbriefe einfach neu erstellen.

## Worker aktualisieren

Ändert sich `worker/briefkasten.js` – etwa mit der Einführung der Cloud-Sicherung –, spielen Sie die neue Fassung bei Cloudflare ein. Dabei ersetzen Sie nur den Programmtext. Datenbank und Rückmeldungen, die Bindung `DB`, Ihre Variablen und Secrets (Schritt 6) und der Cron-Trigger (Schritt 5) bleiben erhalten. Neue Tabellen legt der Worker selbst an. Die Adresse des Workers ändert sich nicht, `js/config.js` und `index.html` bleiben also, wie sie sind.

1. Melden Sie sich unter <https://dash.cloudflare.com> an.
2. Wählen Sie im linken Menü „Workers & Pages“ (ggf. unter „Compute“) und öffnen Sie den Worker **`parentsday-briefkasten`**.
3. Klicken Sie auf „Edit code“ (bei manchen Konten ein Symbol „</>“ oben rechts).
4. Klicken Sie in den Editor, markieren Sie den **gesamten** Text (Strg + A, am Mac Cmd + A) und löschen Sie ihn.
5. Öffnen Sie die aktuelle Datei `worker/briefkasten.js` aus diesem Projekt (auf GitHub: Datei öffnen und über den Knopf „Copy raw file“ kopieren). Fügen Sie den **gesamten** Inhalt in den Editor ein. Zur Kontrolle: Die erste Zeile lautet `// ParentsDay-Briefkasten (Cloudflare Worker + D1-Datenbank)`, die letzte `};`.
6. Klicken Sie auf „Deploy“ und bestätigen Sie, falls Cloudflare nachfragt.
7. Öffnen Sie `https://parentsday-briefkasten.ihr-kontoname.workers.dev/v1/health`. Dort muss jetzt stehen:
   `{"ok":true,"service":"ParentsDay-Briefkasten","version":4,"sync":3}`
   Steht dort noch eine kleinere `"version"` als 4, läuft eine alte Fassung. Warten Sie einige Sekunden und laden Sie die Seite neu. Hilft das nicht, wiederholen Sie die Schritte 3 bis 6.
8. Prüfen Sie zum Schluss die Datenbank wie in [Schritt 7](#schritt-7-testen), Punkt 2 und 3. Die Adresse mit `/v1/sync/AAAA…` muss `{"error":"forbidden"}` zeigen.
9. Empfohlen, falls noch nicht geschehen: Legen Sie das Secret `IP_HASH_KEY` an, wie in [Schritt 6](#schritt-6-optional-erlaubte-web-adressen-und-weitere-einstellungen) beschrieben.

**Reihenfolge:** Spielen Sie den neuen Worker am besten ein, bevor die neue Fassung von ParentsDay online geht. Läuft ParentsDay schon mit Cloud-Sicherung, der Worker aber noch in einer alten Fassung, gilt bis zum Aktualisieren:

* Beim Anmelden fragt ParentsDay noch nicht nach der Cloud-Sicherung. Die Anmeldung mit Passwort klappt nur an Geräten, auf denen die Cloud-Sicherung mit diesem Passwort schon eingerichtet ist (z. B. dort, wo sich die Lehrkraft registriert hat – auch ohne „Passwort merken“); ParentsDay bestätigt das Passwort dann im Browser. Sonst weist ParentsDay darauf hin, dass sie gerade nicht möglich ist, und bietet die Anmeldung mit dem Registrierungscode an.
* Wer sich neu registriert oder die Cloud-Sicherung einrichtet, sieht den Hinweis, dass sie gerade nicht erreichbar bzw. noch nicht verfügbar ist. ParentsDay versucht es regelmäßig und bei jedem neuen Start erneut und holt das Einrichten nach dem Aktualisieren von selbst nach.
* Briefkasten und Rückmeldungen funktionieren wie bisher.

**Vorabfassungen:** Hatten Sie eine Vorabfassung der Cloud-Sicherung eingespielt (`/v1/health` zeigte `"version":2,"sync":true` oder `"version":3,"sync":2`), löscht der aktuelle Worker deren Tabellen (`sync`, `sync_chunks` bzw. `cloud`, `cloud_chunks`) bei der ersten Anfrage selbst. Tun müssen Sie dafür nichts. Die Lehrkräfte richten ihre Cloud-Sicherung beim nächsten Anmelden neu ein.

Per Kommandozeile spielen Sie die neue Fassung mit `npx wrangler deploy` im Ordner `worker/` ein (siehe nächster Abschnitt).

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

Den Schlüssel für die IP-Hashwerte (Schritt 6) legen Sie mit `npx wrangler secret put IP_HASH_KEY` an; Wrangler fragt dann nach dem Wert. Secrets bleiben bei jedem weiteren `npx wrangler deploy` erhalten.

Ändert sich `worker/briefkasten.js` später, veröffentlichen Sie die neue Fassung erneut mit `npx wrangler deploy`. Im Dashboard gehen Sie vor wie unter [Worker aktualisieren](#worker-aktualisieren) beschrieben.

## Datenschutz

Bitte klären Sie den Einsatz vorher mit der bzw. dem Datenschutzbeauftragten Ihrer Schule. Cloudflare verarbeitet Daten im Auftrag (Auftragsverarbeitung) und stellt dafür eine Vereinbarung bereit.

**Was ist verschlüsselt?**

* Rückmeldungen werden im Browser der Eltern **Ende-zu-Ende** verschlüsselt (ECDH P-256 und AES-GCM mit 256 Bit). Name und Code des Kindes und die Zeiten sind nur für die Lehrkraft lesbar.
* Die **Cloud-Sicherung** wird im Browser der Lehrkraft mit einem Schlüssel aus ihrem Passwort verschlüsselt (PBKDF2-SHA256 mit 600.000 Durchläufen und HKDF-SHA256, AES-GCM mit 256 Bit). Das Passwort verlässt den Browser nie. Auch die Adresse der Sicherung beim Dienst ergibt sich aus dem Passwort. Adresse und Versionsnummer sind mit verschlüsselt, ein älterer Stand lässt sich deshalb nicht als neuer ausgeben.
* Der private Schlüssel des Briefkastens verlässt den Browser der Lehrkraft nur in ihrer Zwischenspeicher-Datei und – mit ihrem Passwort verschlüsselt – in ihrer Cloud-Sicherung. Weder Cloudflare noch Sie als Betreiber können ihn lesen.
* Lesen oder leeren kann einen Briefkasten nur, wer das Geheimnis der Lehrkraft kennt. Es liegt ebenfalls nur in ihrem Browser, im Zwischenspeicher und verschlüsselt in der Cloud-Sicherung.

**Was speichert der Briefkasten?**

* Tabelle `messages`: je Rückmeldung eine zufällige Kennung, die Kennung des Briefkastens (sie verrät nicht, zu welcher Lehrkraft er gehört), den Eingangszeitpunkt und den verschlüsselten Inhalt.
* Tabelle `directory`: Einträge für Eltern ohne QR-Code. Sie melden sich mit dem Termin-Schlüssel aus dem Elternbrief an und finden über diesen Eintrag den Briefkasten. Ein Eintrag enthält die Angaben aus dem Elternbrief: Name und E-Mail-Adresse der Lehrkraft, Adresse der Schule, Klasse, Tage, Uhrzeiten und den öffentlichen Schlüssel. Er ist verschlüsselt; der Schlüssel ergibt sich aus Lehrkräftecode, Klasse und Termin-Schlüssel des Elternbriefs. Namen von Kindern oder Eltern enthält er nicht. Ein Eintrag gehört dem Briefkasten, der ihn angelegt hat; wird er 200 Tage lang nicht erneuert, wird er gelöscht.
* Tabelle `backups`: je Cloud-Sicherung eine Zeile. Ihr Schlüssel ist ein SHA-256-Hashwert aus der Kennung der Lehrkraft und der Adresse der Sicherung; beides selbst steht nicht in der Datenbank. Dazu kommen die Versionsnummer, die Zeitpunkte der letzten Änderung und der letzten Nutzung, die Hashwerte von Zugangs- und Admin-Token, die Hashwerte der Geräte-Geheimnisse der eingetragenen Geräte (höchstens 20), Angaben zur Verschlüsselung (Initialisierungsvektor, komprimiert ja/nein), die Zahl der Stücke, die Größe in Zeichen und eine zufällige Kennung des letzten Speichervorgangs.
* Tabelle `backup_chunks`: den verschlüsselten Inhalt der Cloud-Sicherungen in Stücken.
* Tabelle `cloud_limits`: Zähler für Versuche, eine Cloud-Sicherung zu öffnen oder anzulegen – je Kennung der Lehrkraft (für die Stunde zusammen mit dem Hashwert der IP-Adresse) – und für neue Sicherungen (Anzahl und Umfang) je Hashwert der IP-Adresse, jeweils mit dem Beginn der Stunde bzw. des Tages. Sie werden nach 2 Tagen gelöscht.
* Tabelle `meta` (nur ohne das Secret `IP_HASH_KEY`): den Zufallswert des Tages für die Hashwerte der IP-Adressen. Beim ersten Versuch eines neuen Tages wird er durch einen neuen ersetzt.
* Die Kennung der Lehrkraft ist ein Hashwert aus Vorname, Nachname und Geburtsdatum. Sie dient zum Zählen der Versuche und bindet die Sicherung an die Lehrkraft. In der Tabelle `backups` steht sie nicht, nur – höchstens 2 Tage – in den Zählern. Sie ist pseudonym, nicht anonym: Wer die Datenbank einsehen kann und Namen und Geburtsdatum kennt, kann an den Zählern sehen, ob es in den letzten 2 Tagen Versuche für diese Lehrkraft gab. Welche Sicherung ihr gehört, sieht er nicht – dafür bräuchte er das Passwort.
* Wer die Datenbank einsehen kann, könnte ein Passwort nur durch Ausprobieren erraten. Jeder Versuch kostet 600.000 PBKDF2-Durchläufe. Deshalb verlangt ParentsDay Passwörter mit mindestens 10 Zeichen. Wer die Datenbank verwalten kann, kann Sicherungen zwar nicht lesen, aber löschen oder durch einen älteren Stand ersetzen. Einen älteren Stand übernimmt ParentsDay nicht, sondern lädt den Stand des Geräts wieder hoch.
* IP-Adressen legt der Briefkasten **nicht** in der Datenbank ab, nur pseudonyme Hashwerte in `cloud_limits` (höchstens 2 Tage). Sie wechseln jeden Tag. **Mit** dem Secret `IP_HASH_KEY` ([Schritt 6](#schritt-6-optional-erlaubte-web-adressen-und-weitere-einstellungen)) sind es HMAC-SHA256-Werte mit einem Schlüssel, der nicht in der Datenbank steht: Wer nur die Datenbank einsehen kann, kann sie keiner Adresse zuordnen. **Ohne** `IP_HASH_KEY` sind es SHA-256-Werte mit dem Zufallswert des Tages aus der Tabelle `meta`. Wer die Datenbank einsieht, solange dieser Zufallswert dort steht, könnte durch Ausprobieren aller IPv4-Adressen herausfinden, zu welcher Adresse ein Hashwert gehört. Richten Sie deshalb am besten `IP_HASH_KEY` ein.

**Was sieht Cloudflare?**

* Wie bei jeder Verbindung im Internet: die IP-Adressen von Eltern und Lehrkräften, den Zeitpunkt, die aufgerufene Adresse (mit der Kennung des Briefkastens bzw. der Adresse der Cloud-Sicherung), die Größe der verschlüsselten Daten und technische Angaben des Browsers.
* Um Massen-Anfragen zu bremsen, merkt sich der Worker die IP-Adressen der letzten Einwürfe und der letzten Anfragen zum Öffnen, Anlegen und Speichern von Cloud-Sicherungen vorübergehend im Arbeitsspeicher, nicht in der Datenbank.
* Den Inhalt der Rückmeldungen und der Cloud-Sicherungen kann Cloudflare nicht lesen.
* Cloudflare bietet für Worker Protokolle an („Observability“ bzw. „Workers Logs“). Sind sie eingeschaltet, speichert Cloudflare Angaben zu jeder Anfrage für einige Tage. Der Briefkasten braucht diese Protokolle nicht. Prüfen Sie in den Einstellungen des Workers, ob sie eingeschaltet sind, und schalten Sie sie bei Bedarf aus.

## Was passiert bei einem Ausfall?

Ist der Briefkasten nicht erreichbar – wegen einer Störung, weil die kostenlose Grenze erreicht ist oder weil die Adresse falsch eingetragen ist –, geht nichts verloren:

* **Eltern** sehen nach „Absenden“ eine verständliche Meldung. Sie können es erneut versuchen oder die Rückmeldung stattdessen per E-Mail schicken – als Rückmelde-PDF bzw. E-Mail-Text wie bisher.
* **Lehrkräfte** sehen im Abschnitt „Digitaler Briefkasten“ (Klassenübersicht bzw. Klasse) einen Hinweis, dass das Abrufen gerade nicht möglich ist. Rückmeldungen, die schon im Briefkasten liegen, bleiben dort und werden beim nächsten erfolgreichen Abruf übernommen. PDFs und E-Mail-Texte laden bzw. fügen sie wie bisher ein.
* Unter „Weitere Einstellungen“ → „Digitaler Briefkasten“ prüft der Knopf **„Verbindung prüfen“**, ob der Briefkasten erreichbar ist.
* **Cloud-Sicherung:** Lehrkräfte arbeiten ganz normal weiter, alles bleibt in ihrem Browser gespeichert. Die Kopfzeile zeigt „Cloud nicht erreichbar – wird nachgeholt“. ParentsDay versucht es nach 15 und 30 Sekunden, nach 1 und 2 Minuten und danach alle 5 Minuten erneut, außerdem sofort, wenn das Gerät wieder online ist. Wer sich während des Ausfalls an einem Gerät anmeldet, auf dem die Cloud-Sicherung noch nicht verbunden ist, arbeitet mit dem Stand dieses Geräts. Die Anmeldung mit Passwort braucht an einem Gerät, auf dem die Cloud-Sicherung noch nicht eingerichtet ist, den Dienst: ParentsDay meldet, dass die Cloud-Sicherung gerade nicht erreichbar ist, und bietet die Anmeldung mit dem Registrierungscode an (oder mit der Registrierungs-PDF). An einem Gerät, auf dem die Cloud-Sicherung mit diesem Passwort schon eingerichtet ist (Passwort gemerkt oder nicht), klappt die Anmeldung mit Passwort auch ohne Verbindung; abgeglichen wird, sobald der Dienst wieder erreichbar ist. Haben später zwei Geräte verschiedene Stände, fragt ParentsDay, welcher gelten soll.
* Beim **Abmelden** lädt ParentsDay offene Änderungen noch hoch. Geht das nicht, weist ParentsDay darauf hin. Die Daten bleiben dann auf dem Gerät und werden beim nächsten Anmelden dort gesichert.

Soll der Briefkasten dauerhaft abgeschaltet werden, setzen Sie in `js/config.js` wieder `MAILBOX_URL = ''`. ParentsDay arbeitet dann wie vor der Einrichtung, also auch ohne Cloud-Sicherung.

**Schlüssel verloren?** Mit Cloud-Sicherung steckt der Schlüssel in ihr: Nach der Anmeldung mit Passwort ist er auf jedem Gerät wieder da. Löscht eine Lehrkraft **ohne** Cloud-Sicherung ihre Browserdaten und hat keinen Zwischenstand gespeichert, kann niemand mehr die Rückmeldungen in ihrem Briefkasten lesen – auch Sie als Betreiber nicht. Die Eltern müssen ihre Rückmeldung dann erneut schicken. Erinnern Sie Lehrkräfte ohne Cloud-Sicherung deshalb daran, nach dem Erstellen der Elternbriefe einen Zwischenstand zu speichern. (Lädt eine Lehrkraft einen älteren Zwischenstand, der noch keinen Briefkasten enthält, behält ParentsDay den Briefkasten des Browsers. Enthält er einen anderen, warnt ParentsDay vor dem Laden.)

**Passwort vergessen?** Ohne Passwort können weder Sie noch ParentsDay die Cloud-Sicherung öffnen. Was „Passwort vergessen?“ anbietet, hängt vom Gerät ab:

* An einem Gerät, das noch **verbunden** ist (Passwort gemerkt bzw. in diesem Tab schon eingegeben): „Weitere Einstellungen“ → „Cloud-Sicherung“ → „Passwort vergessen?“ (oder „Bisheriges Passwort vergessen?“ im Dialog „Passwort ändern“) → „Neues Passwort festlegen“. Die Sicherung zieht mit dem Stand dieses Geräts unter das neue Passwort um, wie beim Ändern des Passworts. Weil das bisherige Passwort fehlt, lässt sich die alte Sicherung nicht löschen; ihr Inhalt wird durch den Hinweis „umgezogen“ ersetzt. Die anderen Geräte melden dann „Das Passwort Ihrer Cloud-Sicherung wurde auf einem anderen Gerät geändert …“ und fragen einmal nach dem neuen Passwort. Verloren geht nichts. Die alte Sicherung löscht der Cron-Trigger nach 400 Tagen ohne Nutzung.
* An einem Gerät, das **nicht verbunden** ist (im Dialog „Passwort eingeben“ bzw. auf der Karte „Cloud-Sicherung“, wenn das Gerät nach dem Passwort fragt): „Neue Cloud-Sicherung einrichten“ legt eine **neue** Sicherung mit neuem Passwort an. Sie beginnt mit dem Stand dieses Geräts – am besten also an dem Gerät, an dem die Lehrkraft zuletzt gearbeitet hat. Die alte Sicherung bleibt unverändert. Geräte, auf denen das alte Passwort noch gemerkt ist, gleichen weiter mit ihr ab. Damit sie die neue nutzen, wählt die Lehrkraft dort beim Abmelden „Meine Daten von diesem Gerät entfernen“ und meldet sich beim nächsten Mal mit dem neuen Passwort an; was nur auf diesem Gerät geändert wurde, kommt dabei nicht mit. (Meldet sie sich dort ohne „entfernen“ mit dem neuen Passwort an oder wählt sie „Mit neuem Passwort verbinden“, wechselt das Gerät ebenfalls zur neuen Sicherung; sind beide Stände verschieden, fragt ParentsDay, welcher gelten soll.) Ist das Passwort noch auf irgendeinem Gerät gemerkt, ist deshalb der erste Weg besser. Der Dialog weist darauf hin.

„Passwort ändern“ („Weitere Einstellungen“ → „Cloud-Sicherung“) geht nur mit dem bisherigen Passwort.

## Aufräumen nach dem Elternsprechtag

**Lehrkräfte** leeren ihren Briefkasten nach dem Elternsprechtag selbst: „Weitere Einstellungen“ → „Digitaler Briefkasten“ → **„Briefkasten leeren“**. Das löscht die Kopien auf dem Server; die übernommenen Zeiten bleiben in ParentsDay. Neue Rückmeldungen, die noch nicht abgeholt wurden, übernimmt ParentsDay vorher. Passt eine Rückmeldung zu keinem Kind (z. B. weil die Klasse in diesem Browser fehlt), fragt ParentsDay vor dem Löschen nach. Auch „Alle Daten in diesem Browser löschen“ leert den Briefkasten; sind dabei neue Rückmeldungen eingegangen, bietet ParentsDay vorher an, einen Zwischenstand zu speichern. Die Cloud-Sicherung der Lehrkraft bleibt dabei erhalten, das Gerät wird nur von ihr getrennt. Löschen lässt sie sich unter „Weitere Einstellungen“ → „Cloud-Sicherung“ → „Cloud-Sicherung löschen“, mit dem Passwort.

„Briefkasten leeren“ löscht nur die Rückmeldungen, die ParentsDay gerade abgeholt hat. Kommt währenddessen noch eine an, bleibt sie im Briefkasten und wird beim nächsten Abruf übernommen.

**Automatisch:** Der Cron-Trigger aus [Schritt 5](#schritt-5-tägliches-aufräumen-einschalten) löscht jeden Tag Rückmeldungen und Einträge für den Termin-Schlüssel, bevor sie 200 Tage alt sind. Außerdem löscht er Cloud-Sicherungen, die 400 Tage lang weder geändert noch abgerufen wurden, solche, die nach dem Anlegen nie genutzt wurden, nach 30 Tagen, und Zähler für Versuche, die älter als 2 Tage sind. Rückmeldungen, die älter als 200 Tage sind, gibt der Briefkasten auch ohne Cron-Trigger nicht mehr heraus. Prüfen können Sie das Aufräumen im Dashboard unter „Settings“ → „Trigger Events“ bzw. in den Protokollen des Workers („Aufgeräumt: … Rückmeldungen, … Verzeichniseinträge, … Cloud-Sicherungen“).

**Ohne Cron-Trigger** räumt der Briefkasten nur nebenbei auf (etwa bei jeder 50. neuen Rückmeldung). Kommen keine mehr an, bleiben alte Daten liegen. Richten Sie dann den Cron-Trigger ein oder räumen Sie **einmal im Monat** selbst auf:

1. Im Dashboard die Datenbank `parentsday` öffnen (Storage & Databases → D1 SQL Database) und den Reiter „Console“ wählen.
2. Diese Befehle eingeben und ausführen. Die ersten beiden löschen Rückmeldungen und Verzeichniseinträge, die älter als 170 Tage sind. Die nächsten beiden löschen Cloud-Sicherungen, die 370 Tage nicht genutzt wurden (nie genutzte nach 30 Tagen), samt ihren Stücken. Bei monatlichem Aufräumen bleibt so nichts länger als 200 bzw. 400 Tage gespeichert. Der letzte löscht Zähler für Versuche, die älter als 2 Tage sind:
   ```sql
   DELETE FROM messages WHERE created_at < (CAST(strftime('%s', 'now') AS INTEGER) - 170 * 86400) * 1000;
   DELETE FROM directory WHERE updated_at < (CAST(strftime('%s', 'now') AS INTEGER) - 170 * 86400) * 1000;
   DELETE FROM backups WHERE seen_at < (CAST(strftime('%s', 'now') AS INTEGER) - 370 * 86400) * 1000 OR (version = 1 AND seen_at = updated_at AND seen_at < (CAST(strftime('%s', 'now') AS INTEGER) - 30 * 86400) * 1000);
   DELETE FROM backup_chunks WHERE backup_id NOT IN (SELECT id FROM backups);
   DELETE FROM cloud_limits WHERE win < (CAST(strftime('%s', 'now') AS INTEGER) - 2 * 86400) * 1000;
   ```
   Eltern mit einem so alten Elternbrief finden den Briefkasten danach nicht mehr und nutzen den Weg per E-Mail. (Die Tabellen `backups`, `backup_chunks` und `cloud_limits` gibt es erst, wenn die aktuelle Fassung des Workers einmal aufgerufen wurde, z. B. mit der Prüfung aus Schritt 7, Punkt 2 oder 3. Vorher lassen Sie die letzten drei Befehle weg.)
   Bei monatlichem Aufräumen bleiben die Zähler (mit den Hashwerten der IP-Adressen) länger liegen als die 2 Tage, die die Datenschutz-Hinweise nennen. Richten Sie deshalb besser den Cron-Trigger ein.

**Briefkasten ganz abschalten:** Löschen Sie im Dashboard den Worker und die Datenbank. Setzen Sie in `js/config.js` wieder `MAILBOX_URL = ''` und entfernen Sie die Adresse aus `connect-src` in `index.html`. Damit enden auch alle Cloud-Sicherungen. Die Lehrkräfte arbeiten mit dem Stand in ihrem Browser weiter. Wer an mehreren Geräten arbeitet, sollte vorher dort, wo der neueste Stand ist, einen Zwischenstand speichern.

## Häufige Probleme

| Beobachtung | Ursache und Lösung |
|---|---|
| „Verbindung prüfen“ meldet „nicht erreichbar“, aber `/v1/health` zeigt `{"ok":true,…}` | Die Adresse der ParentsDay-Seite fehlt in `ALLOWED_ORIGINS` (Schritt 6), oder die Worker-Adresse fehlt bei `connect-src` in `index.html` (Schritt 8). In den Entwicklerwerkzeugen des Browsers (Taste F12, Reiter „Konsole“) steht dann ein Hinweis auf „CORS“ bzw. „Content Security Policy“. |
| `/v1/health` lädt nicht | Adresse falsch abgetippt, Worker nicht veröffentlicht („Deploy“) oder die `workers.dev`-Adresse ist noch nicht freigeschaltet. Einige Minuten warten und erneut versuchen. |
| `{"error":"no-database"}` | Die Bindung `DB` fehlt oder ist anders geschrieben (Schritt 4). |
| „Verbindung prüfen“ meldet „Verbindung in Ordnung“, beim Abrufen der Rückmeldungen erscheint aber „hat einen Fehler gemeldet“ | „Verbindung prüfen“ fragt nur `/v1/health` ab, die Datenbank prüft es nicht. Prüfen Sie die Datenbank wie in [Schritt 7](#schritt-7-testen), Punkt 2. Meist fehlt die Bindung `DB`, oder die kostenlose Tagesgrenze der Datenbank ist erreicht. |
| In „Weitere Einstellungen“ fehlt die Karte „Digitaler Briefkasten“ bzw. „Cloud-Sicherung“ | `MAILBOX_URL` in `js/config.js` ist leer, oder der Browser zeigt noch die alte Fassung. Seite neu laden (Strg + F5). |
| `/v1/health` zeigt eine kleinere `"version"` als 4 bzw. nicht `"sync":3` | Der Worker ist noch eine alte Fassung ohne bzw. mit einer Vorabfassung der Cloud-Sicherung. Spielen Sie die neue ein, siehe [Worker aktualisieren](#worker-aktualisieren). |
| Die Kopfzeile der Lehrkraft zeigt „Cloud-Sicherung noch nicht verfügbar“, oder ParentsDay fragt beim Anmelden nicht nach der Cloud-Sicherung | Der Worker kennt die Cloud-Sicherung noch nicht (alte Fassung). Nach dem [Aktualisieren](#worker-aktualisieren) holt ParentsDay alles von selbst nach. |
| „Für Ihre Cloud-Sicherung gab es zu viele Versuche mit einem falschen Passwort“ bzw. „Cloud-Sicherung vorübergehend gesperrt“ | Für diese Lehrkraft gab es zu viele Versuche, die Sicherung zu öffnen oder anzulegen: 10 in einer Stunde vom selben Anschluss oder 30 an einem Tag. Das kann auch jemand anderes gewesen sein, der Namen und Geburtsdatum kennt (siehe [Cloud-Sicherung der Lehrkräfte](#cloud-sicherung-der-lehrkräfte), Restrisiken). Öffnen und Einrichten auf einem neuen Gerät, die Anmeldung mit Passwort dort, „Passwort ändern“ und „Passwort vergessen?“ gehen ab der nächsten vollen Stunde bzw. am nächsten Tag (ab Mitternacht UTC) wieder. Anmelden kann sich die Lehrkraft bis dahin mit Registrierungs-PDF oder Registrierungscode. Geräte, die schon verbunden sind, gleichen weiter ab. Sie als Betreiber müssen nichts tun. (Im Notfall hebt `DELETE FROM cloud_limits;` in der Console der Datenbank alle Zählungen auf.) |
| „Von Ihrem Internetanschluss wurden heute schon sehr viele Cloud-Sicherungen eingerichtet“ | Über diese IP-Adresse (bei IPv6: dieses /48-Netz) wurden heute schon 20 Cloud-Sicherungen bzw. zusammen 5 Millionen Zeichen angelegt, z. B. im Schulnetz. Beim Einrichten holt ParentsDay das nach Mitternacht (UTC) von selbst nach; „Passwort ändern“ und „Passwort vergessen?“ gehen dann erst am nächsten Tag wieder. |
| „Der Speicher der Cloud-Sicherung ist voll“ | Alle Cloud-Sicherungen zusammen haben die Grenze von 250 Millionen Zeichen erreicht (gezählt wird ihre tatsächliche Größe). Neue lassen sich nicht mehr anlegen, vorhandene werden weiter gespeichert; ParentsDay versucht das Einrichten stündlich erneut. Nicht mehr genutzte Sicherungen löscht der Cron-Trigger nach 400 Tagen, nie genutzte nach 30 Tagen. Wer mehr Platz braucht, erhöht `SYNC_MAX_TOTAL_CHARS` in `worker/briefkasten.js` (die Datenbank fasst höchstens 500 MB) und spielt den Worker neu ein. |
| Die Kopfzeile zeigt „Cloud-Sicherung: Passwort nötig“, obwohl das Passwort gemerkt war | Das Passwort wurde auf einem anderen Gerät geändert (dann heißt es „Das Passwort Ihrer Cloud-Sicherung wurde auf einem anderen Gerät geändert …“), die Sicherung wurde gelöscht (auch automatisch, wenn sie nach dem Einrichten nie genutzt wurde – nach 30 Tagen), oder das Gerät ist aus der Liste der 20 eingetragenen Geräte gefallen. Die Lehrkraft gibt ihr (neues) Passwort einmal ein. Gibt es die Sicherung nicht mehr, richtet sie über „Passwort vergessen?“ → „Neue Cloud-Sicherung einrichten“ eine neue ein oder löst das Gerät mit „Nicht mehr verwenden“. |
| Nach einer erneuten Registrierung steht „Das eingegebene Passwort wurde nicht übernommen.“ | Das Gerät ist schon mit einer Cloud-Sicherung eingerichtet, und die Lehrkraft hat ein anderes Passwort eingegeben als das dieser Sicherung (z. B. vertippt oder neu ausgedacht). An einem solchen Gerät legt die Registrierung nie eine neue Sicherung an und wechselt zu keiner anderen (siehe [Cloud-Sicherung der Lehrkräfte](#cloud-sicherung-der-lehrkräfte)); die Sicherung des Geräts bleibt unverändert. Ein neues Passwort legt die Lehrkraft unter „Weitere Einstellungen“ → „Cloud-Sicherung“ mit „Passwort ändern“ bzw. „Passwort vergessen?“ fest. Wurde das Passwort schon an einem anderen Gerät geändert und fragt dieses Gerät deshalb danach („Passwort nötig“), gibt sie das neue über „Passwort eingeben“ ein. Hat sie an einem anderen Gerät eine neue Sicherung eingerichtet, während dieses Gerät weiter abgleicht, verbindet es dort „Mit neuem Passwort verbinden“ mit ihr. |
| Nach einer erneuten Registrierung steht „Ihre Cloud-Sicherung wurde inzwischen geändert.“ | Der Dienst hat das Gerät beim Abgleich abgewiesen: Die Sicherung hat auf einem anderen Gerät ein neues Passwort bekommen, sie wurde gelöscht (auch automatisch nach 400 Tagen ohne Nutzung), oder das Gerät ist aus der Liste der 20 eingetragenen Geräte gefallen. Das lässt sich nicht sicher unterscheiden; deshalb legt ParentsDay keine neue Sicherung an und wechselt zu keiner anderen. Die Lehrkraft gibt nach „Weiter“ oben über „Passwort eingeben“ das aktuelle Passwort ein (bei einem herausgefallenen Gerät das bisherige). Gibt es die Sicherung nicht mehr, richtet sie dort über „Passwort vergessen?“ → „Neue Cloud-Sicherung einrichten“ eine neue ein oder löst das Gerät mit „Cloud-Sicherung auf diesem Gerät nicht mehr verwenden“. |
| „Cloud nicht erreichbar – wird nachgeholt“ | Keine Internetverbindung, Worker gestört oder die kostenlose Tagesgrenze ist erreicht. Die Daten bleiben im Browser und werden später hochgeladen. |
| Beim Anmelden mit Passwort erscheint „Das Passwort passt nicht zu Ihren Angaben“ | Das Passwort ist falsch (Groß- und Kleinschreibung beachten), Name oder Geburtsdatum weichen von den Angaben bei der Registrierung ab, oder für die Lehrkraft gibt es keine Cloud-Sicherung (nie eingerichtet oder gelöscht). Der Dienst unterscheidet das bewusst nicht; jeder dieser Versuche zählt als Fehlversuch. Auf dem Gerät wird dabei nichts gespeichert. Die Lehrkraft meldet sich mit Registrierungs-PDF oder Registrierungscode an und richtet danach die Cloud-Sicherung ein bzw. legt über „Passwort vergessen?“ ein neues Passwort fest. Heißt es stattdessen „Das Passwort Ihrer Cloud-Sicherung wurde inzwischen auf einem anderen Gerät geändert“, gilt das neue Passwort. |
| Beim Anmelden mit Passwort erscheint „Die Cloud-Sicherung ist gerade nicht erreichbar“ bzw. „Die Anmeldung mit Passwort ist gerade nicht möglich“ | Keine Verbindung zum Dienst, Worker gestört, kostenlose Tagesgrenze erreicht oder noch eine alte Fassung des Workers ohne Cloud-Sicherung. Die Lehrkraft meldet sich mit „Mit Registrierungscode anmelden“ oder mit der Registrierungs-PDF an. (An einem Gerät, auf dem die Cloud-Sicherung schon eingerichtet ist, bestätigt ParentsDay das passende Passwort ohne Verbindung – auch wenn es nicht gemerkt ist; der Hinweis erscheint dort nur, wenn das eingegebene Passwort ein anderes ist, z. B. bei einem Tippfehler.) |
| Eine Lehrkraft hat ihr Passwort vergessen | Auch Sie können die Sicherung nicht öffnen. Anmelden kann sich die Lehrkraft mit Registrierungs-PDF oder Registrierungscode. Ist das Passwort noch auf einem Gerät gemerkt, legt die Lehrkraft dort mit „Passwort vergessen?“ ein neues fest; sonst richtet „Passwort vergessen?“ eine neue Sicherung mit neuem Passwort ein, siehe [Passwort vergessen?](#was-passiert-bei-einem-ausfall) |
| Eltern-Rückmeldungen kommen nicht im Briefkasten an | Die Elternbriefe wurden vor der Einrichtung erstellt und enthalten noch keinen Briefkasten. Elternbriefe neu erstellen. |
| Nach Mitternacht funktioniert wieder alles | Die kostenlose Tagesgrenze war erreicht (siehe [Kosten und Grenzen](#kosten-und-grenzen)). Kommt das öfter vor, obwohl wenig los ist, hat sie vielleicht jemand absichtlich aufgebraucht, siehe [Absichtlich aufgebrauchte Tagesgrenzen](#absichtlich-aufgebrauchte-tagesgrenzen). |

Für Entwickler: `tests/e2e/mailbox-server.mjs` startet den Briefkasten lokal (mit einer Nachbildung der D1-Datenbank auf Basis von `node:sqlite`). `npm test` und `npm run test:e2e` prüfen ihn zusammen mit der Web-App, die Cloud-Sicherung in `tests/unit/cloud.test.mjs` (Schlüssel, Verschlüsselung und alle Endpunkte samt Grenzen) sowie `tests/e2e/cloud.test.mjs` (Abläufe mit zwei Geräten) und `tests/e2e/cloud-login.test.mjs` (Anmeldung mit Passwort). Die Tests erreichen nie den echten Worker: Ohne ausdrückliche Test-Adresse liefern sie die Seite ohne Dienst aus und blockieren jede Anfrage an `*.workers.dev`.
