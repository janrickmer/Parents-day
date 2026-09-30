# ParentsDay – Anforderungen

Dieses Dokument enthält die ursprüngliche Aufgabenbeschreibung und die dazu getroffenen Entscheidungen.

## Getroffene Entscheidungen

| Frage | Entscheidung |
|---|---|
| Betrieb | **Rein statisch**, also nur HTML, CSS und JavaScript ohne Server (z. B. GitHub Pages). Die Termindaten des Elternsprechtags stehen im **QR-Code bzw. Link des Elternbriefs**. Als Ausweichweg gibt es einen kurzen, abtippbaren **Termin-Schlüssel**. Die Eltern schicken ihre Rückmeldung als **PDF per E-Mail** an die Lehrkraft. Die Lehrkraft lädt die PDFs gesammelt hoch. |
| „Geburtstag ohne Punkte“ | **TTMMJJJJ**, z. B. 15.03.1990 → 15031990. Als Zahl entfällt eine führende Null: 05.03.1990 → 5031990. |
| Umlaute im Zahlencode | **Umschreiben**: ä→ae, ö→oe, ü→ue, ß→ss. Akzente werden entfernt (é→e, ş→s, ł→l). Alle anderen Zeichen wie Bindestrich, Leerzeichen und Apostroph werden ignoriert. Groß- und Kleinschreibung spielt keine Rolle. |
| Reihenfolge im Zahlencode | Erst der Vorname, dann der Nachname. Beispiel: Anna Beck → 114141 + 25311 = 11414125311. |
| Tippfehler in der Beschreibung | „Einfuhrzeit“ bedeutet **Endzeit**. Der Knopf heißt „Termine festlegen, speichern und **drucken**“. |
| Dateiname Zwischenspeicher | `Zwischenspeicher vom TT.MM.JJJJ um hh꞉mm für ParentsDay.json`. Ein echter Doppelpunkt ist in Dateinamen unter Windows/macOS verboten. Deshalb steht dort das gleich aussehende Zeichen „꞉“ (U+A789). |

### Rechenbeispiele

Anna Meier, geboren am 15.03.1990, E-Mail anna.meier@schule.de:

* Registrierungscode: `A` + `M` + (4 × 15031990) = **AM60127960**
* Lehrkräftecode: `A` + (15031990 × 1104) + `M` = **A16595316960M**
* Schülercode für Anna Beck in Klasse 5a: `5a` + `A16595316960M` + `114141` + `25311` = **5aA16595316960M11414125311**

## Ursprüngliche Aufgabenbeschreibung

> Diese Internetseite soll ParentsDay heißen. Bitte achte darauf, dass du das "D" tatsächlich groß schreibst.
>
> Die Internetseite soll als Portal genutzt werden, damit Lehrer einer Schule mit Eltern leichter Termine für den Elternsprechtag vereinbaren können.
>
> Zuerst kommen wir zum Zugang für die Lehrer, zu dem man gelangt, wenn man auf der Startseite den Button "Zugang für Lehrkräfte" anklickt. In der Registrierungsmaske soll man seinen Vornamen, deinen Nachnamen und sein Geburtsdatum inkl. Jahr eintragen und auch die E-Mail Adresse soll angegeben werden. Wenn man dies erledigt hat, erhält man zum Download eine PDF-Datei, in der diese Daten nochmal stehen. Zusätzlich steht dort auch der "Registrierungscode", der folgendermaßen berechnet ist: Anfangsbuchstabe des Vornamens und dann der Anfangsbuchstabe des Nachnamens und direkt dahinter die Zahl, die sich aus folgender Rechnung ergibt: Anzahl der Buchstaben des Vornamens multipliziert mit dem eigenen Geburtstag (wenn man diesen ohne Punkte schreiben würde). Wenn man nicht auf Registrieren, sondern auch "Anmelden" klicken würde, kommt man zu der Seite, bei der man darum gebeten wird, entweder diese Datei hochzuladen, damit die Webseite alle notwendigen Daten aus ihr herauslesen kann oder wo man um die Eingabe von Vorname, Nachname, Geburtstag ink. Jahr und Registrierungscode gebeten wird.
> Jede Lehrkraft erhält außerdem einen Lehrkräftecode, der sich so zusammensetzt: Anfangsbuchstabe des Vornamens, Geburtstag (ohne Punkt geschrieben und multipliziert mit 1104) und dann Anfangsbuchstabe des Nachnamens.
>
> Auf der ersten Seite nach der Anmeldung folgt die Erstellung des Elternsprechtags. Hierzu wählt die Lehrkraft in einer Kalenderauswahl den Tag bzw. die Tage aus, an denen der Elternsprechtag stattfinden wird. Auch erfragt wird hier die Adresse der Schule.
> Ebenfalls sollte die Lehrkraft hier angeben, wie lang ein Terminslot standardmäßig sein soll (bspw. 10 Minuten), was aber später noch geändert werden kann, wenn es in weitere Einstellungen geht. Die Lehrkraft soll die Anfangsuhrzeit und auch die Einfuhrzeit zu jedem einzelnen Tag, der zum Elternsprechtag gehört, angeben.
>
> Auf der ersten Seite nach der Erstellung des Elternsprechtags kann die Lehrkraft dann Klassen anlegen. Hierfür gibt sie in einem Drop-Down-Menü die Jahrgangsstufe an (1-13) und sucht einen passendem Buchstaben dafür aus (a-h).
> Diese Klassen werden dann als eigene Kacheln dargestellt. Wenn man eine Klasse mit einem Klick öffnet, wird man gebeten, in einer Tabelle die Schülerinnen und Schüler dieser Klasse hinzuzufügen. Dies geschieht innerhalb der Spalten mit Textfeldern. Man kann mit einem Klick auf den Button "Weitere Lernende hinzufügen" immer wieder eine weitere Zeile zur Tabelle hinzufügen, um den nächsten Schüler oder die nächste Schülerin zu ergänzen.
> Spalte 1: Nachname
> Spalte 2; Vorname
> Spalte 3 bleibt erstmal leer und ist nicht ausfullbar.
>
> Die Zeilen der Tabelle werden ab dem ersten Schüler nummeriert. Dies geschieht links neben der ersten Spalte.
>
> Unter der Tabelle gibt es einen Button "Alle Lernenden erfolgreich eingetragen". Wenn dieser angeklickt wird, wird zu jedem Lernenden ein Code entwickelt, der dann im der 3. Spalte erscheint. Dieser Code setzt sich folgendermaßen zusammen: Jahrgangsstufe der Klasse, direkt dahinter der Buchstabe der Klasse, Lehrkräftecode dieser aktuell eingeloggten Lehrkraft, direkt dahinter der Zahlencode des Namens. Dieser Zahlencode des Namens wird so berechnet: Jeder Buchstabe des Alphabets hat den Zahlenwert der Stelle, an der er sich im Alphabet befindet. Anna ist dann also 114141, weil A=1 und N=14 ist. Dieser Zahlencode wird für den Vornamen und den Nachnamen generiert und zusammengesetzt.
>
> Dieser Code wird in der Tabelle an 3. Stelle angezeigt. Sobald die Codes generiert wurden, ändert sich der Button, mit dem die Codes generiert wurden zu "Elternschreiben für diese Klasse erstellen". Wenn auf diesen Button geklickt wird, entsteht eine PDF-Datei, die so viele Seiten hat, wie Schüler in der Klasse sind. Zu jedem Schüler gibt es eine DIN-A4-Seite.
>
> Diese Seite ist ein Elternbrief, der an die Eltern verfasst ist und darauf hinweist, dass die Terminkoordination zum Elternsprechtag erfordert, dass für den besagten Tag alle verfügbaren Terminslots angegeben werden.
> Hierfür sollen sich die Eltern auf https://parents-day.janrickmer.de beim Elternzugang einloggen und den Anweisungen folgen.
> In dem Schreiben soll außerdem in einem gelben Kasten der Vorname des Kindes, der Nachname des Kindes und der zugewiesene Code des Kindes stehen.
>
> Wenn die Eltern auf der Seite auf den Button zum Einloggen für Eltern klicken, werden sie um folgende Daten gebeten: Vorname des Kindes, Nachname des Kindes, Code.
> Wenn dies eingetragen wurde, kommen die Eltern zu einer Übersicht, auf der bereits ausgefüllt steht (anhand der zuvor von der Lehrkraft eingetragenen Daten), wann der Elternsprechtag stattfinden wird, welche Anfangsuhrzeit und welche Enduhrzeit festgelegt wurden. Die Eltern erhalten die Anweisung, nun alle Zeitslots grün zu markieren, zu denen sie Zeit für ein Gespräch hätten. Hierfür soll das Intervall genutzt werden, das die Lehrrkraft zuvor eingestellt hat. Die Eltern geben somit ihren Zeitraum an und können auch mehrere Zeiträume angeben, die durch eine Unterbrechung voneinander getrennt sind. Wenn diese Eingaben erfolgreich waren, klicken sie auf "Absenden". Der Button "Absenden" bedeutet, dass nun die angegebenen Zeiten dieses Schülers in der Lehrer-Ansicht erscheinen und zwar als weitere Spalte in der Tabelle von dieser Klasse. Dort wird aufgelistet von wann bis wann die Eltern dieses Schülers Zeit haben. Sofern noch keine Rückmeldung von den Eltern vorliegt, steht dort "Rückmeldung der Eltern ausstehend".
> Die Lehrkraft kann sich immer wieder einloggen und diese Daten einsehen.
>
> Wahrscheinlich ist es schwer, ohne Server diese Datenübertragung vom Elternkonto in das Benutzerkonto der Lehrrkraft zu gewährleisten. Darum sollte eine Alternative sein, dass die Internetseite eine E-Mail an die Lehrkräfte verschickt, in der eine PDF-Datei ist, die die verfügbaren Zeiten der Eltern und alle Daten zu ihnen beinhaltet. I'm Hintergrund sollen diese Daten alle auslesbar sein von der Internetseite, sodass man diese Datei in einem Upload-Feld hochladen könnte, um sich organisatorisch Einiges zu sparen. Die E-Mail schickt die Internetseite an die E-Mail Adresse der Lehrrkraft.
> Theoretisch erhält die Lehrkraft dann zwar sehr viele Dateien einzeln per E-Mail, diese können aber gebündelt dann in der Lehrer-Ansicht hochgeladen werden. Der Code verrät, um welche Klasse es sich handelt und das Auslesen der Datei ermöglicht es dann, die letzte Spalte der Tabelle zu füllen.
>
> Wenn die Daten soweit vollständig sind, dass die Lehrkraft das Terminieren beginnen möchte, tut sie das, indem sie auf den Button "Gespräche terminieren" klickt, der sich ebenfalls innerhalb der Klasse befindet. Dort öffnet sich eine Kalenderansicht für den Tag bzw. die Tage, an denen Elternsprechtag ist. Nun können die Schülernamen per Drag&Drop einfach in diese Kalenderansicht (Tagesansicht mit Uhrzeiten) geschoben werden, damit sie einer Uhrzeit zugeordnet werden. Dabei soll der Schülername immer zur Anfangsuhrzeit des Elterngesprächs geschoben werden und hinter dem Schülernamen steht in Klammern, wie lange das Gespräch dauern wird. Dieser Wert kann manuell von der Lehrkraft geändert werden und entsprechend vergrößert oder verkleinert sich auch der Terminblock zu diesem Schüler. Wenn die Eltern eines Schülers zu einer Anfangsuhrzeit, zu der der Name des Schülers gezogen wird, keine Zeit haben sollten, soll das Feld mit dem Schülernamen, das standardmäßig blau sein soll, die Farbe zu rot ändern. Wenn die Eltern zwar zur Anfangsuhrzeit zur Verfügung stehen, der Termin aber in ihre nicht verfügbare Zeit hineinraken sollte, soll die Farbe auf orange geändert werden.
> Wenn dieser Kalender nach uns nach gefüllt wird, soll die Lehrkraft jederzeit die Möglichkeit bekommen, auf den Button "Termine festlegen, speichern und drücken" zu klicken.
> Erneut wird eine PDF-Datei erstellt und zu jedem Schüler, dessen Termin eingetragen wurde, wird eine Seite verfasst, die den Namen des Schülers (auch Nachnamen) und die Uhrzeit des Termins angibt. Der Name der Lehrkraft steht auch drauf und die E-Mail Adresse der Lehrkraft ebenfalls mit dem Hinweis, dass man sich bei spontanen Absagen oder Anfragen gerne per E-Mail melden sollte.
>
> Die letzte Seite dieser PDF-Datei soll eine Übersicht für die Lehrkraft sein in Form einer Tabelle, damit sie weiß, zu welcher Uhrzeit welche Eltern welchen Kindes kommen und bis wann das jeweilige Gespräch dauern wird.
>
> Zu jedem Moment soll es für die Lehrkraft möglich sein, ihren aktuellsten Zwischenstand in Form einer Datei herunterladen und zu speichern. Diese Datei soll den Namen "Zwischenspeicher vom TT.MM.JJJJ um hh:mm für ParentsDay" haben und absolut alle für die Lehrkraft in ihrer Umgebung in dem Moment sichtbaren Informationen einspeichern. Die Lehrkraft kann nach dem Anmelden eine solche Datei hochladen, um den aktuellsten Stand zu füllen.
