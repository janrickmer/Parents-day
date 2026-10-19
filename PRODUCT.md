# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Lehrkräfte:** die Betreiberin bzw. der Betreiber selbst und Kolleginnen und Kollegen, auf die sie oder er ParentsDay hinweist (kein öffentliches Produkt für beliebige Schulen). Klassenlehrkräfte an einer deutschen Schule, die vor jedem Elternsprechtag (ein- bis zweimal im Jahr) die Gesprächstermine mit allen Eltern ihrer Klassen abstimmen. Sie arbeiten am Laptop oder PC, in der Schule oder zu Hause, meist zwischen anderen Aufgaben.
- **Eltern bzw. Erziehungsberechtigte:** bekommen einen gedruckten Elternbrief mit QR-Code und Code ihres Kindes, öffnen ParentsDay einmal je Elternsprechtag, überwiegend am Smartphone, und markieren ihre freien Zeiten. Ihre Deutschkenntnisse und digitalen Vorkenntnisse sind sehr unterschiedlich; viele tun sich schwer damit, selbst eine E-Mail mit Anhang zu verschicken (deshalb der digitale Briefkasten).

## Product Purpose

ParentsDay ersetzt Zettelrücklauf, Listen und E-Mail-Pingpong vor dem Elternsprechtag: Die Lehrkraft legt Tage, Zeiten und Klassen an und erzeugt für jedes Kind einen Elternbrief; die Eltern markieren ihre freien Zeiten; die Lehrkraft zieht die Kinder per Drag & Drop in die Tagesansicht und druckt Terminbestätigungen samt Übersicht. Erfolg heißt: alle Eltern haben geantwortet, alle Gespräche sind ohne Rückfragen geplant, und niemand musste ein Konto anlegen.

## Positioning

Der Elternbrief ist der Zugang: kein Konto für Eltern, kein eigener Server, keine Datenbank mit Schülerdaten. Alles liegt im Browser der Lehrkraft bzw. der Eltern; der optionale digitale Briefkasten und die Cloud-Sicherung sehen nur Ende-zu-Ende-verschlüsselte Daten.

## Operating Context

- Gedruckter Elternbrief (DIN A4, ein Blatt pro Kind) mit QR-Code, Termin-Schlüssel und einem gelben Kasten mit Vorname, Nachname und Code des Kindes – die Eltern-Oberfläche verweist darauf („Code aus dem gelben Kasten“).
- Ablauf der Lehrkraft: Registrieren (Registrierungs-PDF) → Elternsprechtag anlegen (Tage im Kalender, Uhrzeiten, Adresse der Schule, Terminlänge) → Klassen als Kacheln → Lernende in einer Tabelle → Codes und Elternbriefe → Rückmeldungen (automatisch über den Briefkasten oder als PDF-Upload) → Gespräche terminieren (Tagesansicht mit Uhrzeiten, Drag & Drop) → Terminbestätigungen und Übersicht als PDF.
- Ablauf der Eltern: QR-Code scannen oder Termin-Schlüssel eintippen → Anmelden mit Vorname, Nachname und Code des Kindes → freie Zeiten grün markieren → Absenden → Bestätigung (Beleg als PDF).
- Fachliche Farben mit fester Bedeutung: Grün = Eltern haben Zeit; im Terminplan Blau = Termin passt, Orange = ragt in nicht verfügbare Zeit, Rot = Eltern zu Beginn nicht verfügbar, Grau = andere Klasse.

## Capabilities and Constraints

- Rein statische Seite (HTML, CSS, JavaScript als ES-Module, ohne Build-Schritt), veröffentlicht über GitHub Pages unter parentsday.janrickmer.de.
- Content-Security-Policy: Skripte, Stile, Schriften und Bilder nur aus dem eigenen Projekt (`'self'`); keine fremden Server, keine `style`-Attribute (Stile setzt der Code über CSSOM). Externe Schriften oder Bilder müssen ins Projekt kopiert werden.
- Feste Bezeichnungen aus der ursprünglichen Aufgabenbeschreibung: „Zugang für Lehrkräfte“, „Weitere Lernende hinzufügen“, „Alle Lernenden erfolgreich eingetragen“, „Elternschreiben für diese Klasse erstellen“, „Gespräche terminieren“, „Termine festlegen, speichern und drucken“, „Zwischenstand speichern/laden“.
- Umfangreiche Browser-Tests (Playwright) prüfen Abläufe über `data-testid`-Attribute und Texte; Funktionen und Abläufe bleiben bei einer Neugestaltung erhalten.
- Die PDF-Dokumente (Elternbrief, Registrierungs-PDF, Terminbestätigungen, Rückmelde-Beleg) sind nicht Teil der aktuellen Neugestaltung.

## Brand Commitments

- Name **ParentsDay** – immer mit großem „D“.
- Sprache: Deutsch, Sie-Form, freundlich und sachlich; Gendern mit neutralen Formen („Lehrkräfte“, „Lernende“, „Eltern“).
- Das bisherige Erscheinungsbild (Blau `#1f5fae` mit gelbem Punkt, P-Logo) ist bewusst **nicht** verbindlich: Farbwelt, Schrift und Logo-Gestaltung dürfen komplett neu entstehen.

## Evidence on Hand

- Keine eigenen Fotos, kein Logo außer `favicon.svg`, keine Erfahrungsberichte oder Zahlen – nichts davon erfinden.
- Frei lizenzierte Fotos aus offenen Archiven sind erlaubt (mit Quellenangabe); sie zeigen das Umfeld, nie angeblich die eigene Schule oder echte Personen der Schule.
- Echte Oberfläche: Elternbrief, Kalenderauswahl, Klassentabelle, Terminplan, Eltern-Ansicht am Handy können als Ausschnitte gezeigt werden (Beispieldaten als solche erkennbar).

## Product Principles

1. **Der Brief genügt.** Eltern brauchen nichts außer dem Elternbrief und einem Handy: scannen, Zeiten tippen, absenden.
2. **Daten bleiben bei der Lehrkraft.** Keine fremden Server, keine Tracker, keine externen Ressourcen; Datenschutz wird erklärt, nicht nur behauptet.
3. **Arbeitsfläche vor Ausdruck.** Im Lehrkraft-Bereich zählen Tabelle, Kalender und Status; Farben tragen Bedeutung und werden nicht zur Dekoration verbraucht.
4. **Funktioniert überall.** Ältere Handys, langsame Netze, Bildschirmleser und Tastatur, ohne Installation.

## Accessibility & Inclusion

- WCAG 2.1 AA als Untergrenze (Kontrast, sichtbarer Fokus, Tastaturbedienung auch für Drag & Drop, Bildschirmleser-Ansagen).
- Eltern-Bereich zuerst für kleine Handy-Bildschirme und Touch; große Tippflächen, kurze Sätze.
- Bewegung respektiert `prefers-reduced-motion`.
