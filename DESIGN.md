---
name: ParentsDay
description: "Elternsprechtag ohne Zettelrücklauf – das Leitsystem im Schulflur für Lehrkräfte und Eltern."
colors:
  wall: "#0a5f60"
  wall-dark: "#084a4b"
  wall-muted: "#cfe3e1"
  primary: "#0a5f60"
  primary-dark: "#084a4b"
  primary-soft: "#d5e8e5"
  accent: "#f3c522"
  accent-soft: "#fcefbf"
  accent-border: "#d9ab00"
  accent-text: "#5c4600"
  bg: "#e3eceb"
  surface: "#ffffff"
  surface-2: "#f0f5f4"
  text: "#111515"
  ink: "#111515"
  ink-hover: "#2b3535"
  on-ink-muted: "#c9d4d3"
  muted: "#4b5d5c"
  border: "#cddbd9"
  border-strong: "#6f8381"
  available: "#2eaa5c"
  available-soft: "#d7f2e1"
  appt-ok: "#2f6fd6"
  appt-partial: "#f08c00"
  appt-unavailable: "#d63a3a"
  appt-other: "#8a94a6"
  success: "#1e8e4e"
  success-text: "#17703d"
  success-soft: "#e3f5ea"
  warning: "#a14f00"
  warning-soft: "#fff1e0"
  danger: "#c62f2f"
  danger-soft: "#fdeaea"
  info-soft: "#d5e8e5"
  letter-box: "#fff4b3"
  letter-box-border: "#e2b400"
typography:
  display:
    fontFamily: "Barlow Condensed, Arial Narrow, Barlow, system-ui, sans-serif"
    fontSize: "clamp(2.6rem, 5.15vw, 5rem)"
    fontWeight: 800
    lineHeight: 0.92
    letterSpacing: "-0.015em"
  headline-band:
    fontFamily: "Barlow Condensed, Arial Narrow, Barlow, system-ui, sans-serif"
    fontSize: "clamp(2.4rem, 4.6vw, 4.1rem)"
    fontWeight: 800
    lineHeight: 0.95
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Barlow Condensed, Arial Narrow, Barlow, system-ui, sans-serif"
    fontSize: "2.5rem"
    fontWeight: 700
    lineHeight: 1.02
    letterSpacing: "-0.005em"
  title:
    fontFamily: "Barlow Condensed, Arial Narrow, Barlow, system-ui, sans-serif"
    fontSize: "1.6rem"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.005em"
  sign-number:
    fontFamily: "Barlow Condensed, Arial Narrow, Barlow, system-ui, sans-serif"
    fontSize: "3.4rem"
    fontWeight: 800
    lineHeight: 0.9
    letterSpacing: "-0.01em"
  sign:
    fontFamily: "Barlow Condensed, Arial Narrow, Barlow, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.1
  subtitle:
    fontFamily: "Barlow, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.15
  lead:
    fontFamily: "Barlow, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(1.25rem, 2vw, 1.75rem)"
    fontWeight: 400
    lineHeight: 1.3
  body:
    fontFamily: "Barlow, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Barlow, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.2
  code:
    fontFamily: "Barlow, system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.95em"
    fontWeight: 500
    letterSpacing: "0.04em"
    fontFeature: "tnum"
rounded:
  swatch: "2px"
  radius-small: "3px"
  radius: "4px"
  plate: "6px"
spacing:
  stack-small: "8px"
  cluster: "12px"
  stack: "16px"
  gutter: "16px"
  card: "22px"
  card-phone: "18px 16px"
  page-top: "28px"
  page-bottom: "56px"
  band: "clamp(80px, 10vw, 152px)"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.radius-small}"
    padding: "8px 18px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
    textColor: "{colors.surface}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.radius-small}"
    padding: "8px 18px"
    height: "44px"
  button-secondary-hover:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.ink}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.radius-small}"
    padding: "8px 18px"
    height: "44px"
  button-ghost-hover:
    backgroundColor: "{colors.primary-soft}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.surface}"
    rounded: "{rounded.radius-small}"
    padding: "8px 18px"
    height: "44px"
  button-large:
    padding: "12px 28px"
    height: "56px"
  button-small:
    padding: "4px 12px"
    height: "36px"
  direction-sign-teacher:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    typography: "{typography.sign}"
    rounded: "{rounded.radius}"
    padding: "12px 22px 12px 24px"
    height: "64px"
  direction-sign-teacher-hover:
    backgroundColor: "{colors.ink-hover}"
  direction-sign-parent:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ink}"
    typography: "{typography.sign}"
    rounded: "{rounded.radius}"
    padding: "12px 22px 12px 24px"
    height: "64px"
  door-sign-head:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    typography: "{typography.sign-number}"
    padding: "12px 18px 11px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.radius}"
    padding: "{spacing.card}"
  tile:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.radius}"
    padding: "18px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.radius-small}"
    padding: "9px 12px"
    height: "44px"
  input-readonly:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.muted}"
  header-teacher:
    backgroundColor: "{colors.wall}"
    textColor: "{colors.surface}"
    height: "68px"
  header-parent:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ink}"
    height: "68px"
  badge:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.muted}"
    rounded: "{rounded.radius-small}"
    padding: "2px 8px"
  badge-info:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary-dark}"
  badge-success:
    backgroundColor: "{colors.success-soft}"
    textColor: "{colors.success-text}"
  badge-warning:
    backgroundColor: "{colors.warning-soft}"
    textColor: "{colors.warning}"
  badge-danger:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
  code:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary-dark}"
    typography: "{typography.code}"
    rounded: "{rounded.radius-small}"
    padding: "2px 8px"
  chip-selected:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius-small}"
  parent-slot:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.radius-small}"
    height: "56px"
  parent-slot-selected:
    backgroundColor: "{colors.available}"
    textColor: "{colors.text}"
  appointment-ok:
    backgroundColor: "{colors.appt-ok}"
    textColor: "{colors.surface}"
    rounded: "{rounded.radius-small}"
  appointment-partial:
    backgroundColor: "{colors.appt-partial}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius-small}"
  appointment-unavailable:
    backgroundColor: "{colors.appt-unavailable}"
    textColor: "{colors.surface}"
    rounded: "{rounded.radius-small}"
  letter-box:
    backgroundColor: "{colors.letter-box}"
    textColor: "{colors.text}"
    rounded: "{rounded.radius-small}"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.surface}"
    rounded: "{rounded.radius}"
    padding: "12px 8px 12px 14px"
  modal:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.plate}"
    padding: "26px"
    width: "520px"
---

# Design System: ParentsDay

## Overview

**Creative North Star: "Leitsystem im Schulflur"**

ParentsDay sieht aus wie das Leitsystem eines Schulflurs am Elternsprechtag: Flügelfarben zeigen, wo man ist, Schilder tragen Klasse, Datum und Uhrzeit, und die Türliste ist der Terminplan. Petrol (`--c-wall`) ist der Flügel der Lehrkräfte und der öffentlichen Seiten, Signalgelb (`--c-accent`) der Flügel der Eltern. Inhalte stehen auf emaille-weißen Schildern (`.card`) an der hellen, leicht petrol getönten Flurwand (`--c-bg`); die Schildschrift ist fast schwarz.

Zwei Dichten, ein System. Die Startseite (`css/views/start.css`) überzeugt mit Maßstabssprung: volle Bänder in Flurfarben, eine Wegweiser-Tafel mit Überschrift im Wandformat und eine Türliste zum Ausprobieren. Lehrkraft- und Eltern-Bereich sind Arbeitsfläche – Tabelle, Kalender, Status –, die Schilder werden kleiner, die Regeln bleiben. Bewegung ist kurz und entschieden (`--ease-out`, 120/160/220 ms). Bildmaterial sind echte Oberflächen- und PDF-Ausschnitte mit gekennzeichneten Beispieldaten auf weißem Schild (`img/start/*.webp`, Herkunft je Datei in `*.webp.json`).

Abgelehnt sind die zentrierte Überschrift über zwei Knöpfen mit einer Reihe gleicher Schritt-Karten, der blasse Schul-App-Look, Schulheft-Kitsch und Behörden-Look. Harte Rahmenbedingung ist die strenge Content-Security-Policy in `index.html` (`style-src 'self'`, `font-src 'self'`, `img-src 'self' data: blob:`): keine `style`-Attribute, keine Inline-Stile; dynamische Werte setzt der Code über CSSOM, bevorzugt als Custom Property (`--i`, `--parent-cols-sm`/`--parent-cols-lg`, `--header-h`); Schriften und Bilder liegen im Projekt. Die PDFs (`js/pdf/*`, Farben in `COLORS` aus `js/core/pdf.js`) tragen noch das ältere blaue Erscheinungsbild und liegen vorerst außerhalb dieses Systems; nur der gelbe Kasten des Elternbriefs ist mit der Oberfläche farbgleich.

**Key Characteristics:**
- Flügelfarben statt Schmuckfarben: Petrol für Lehrkräfte und öffentliche Seiten, Signalgelb für Eltern.
- Emaille-weiße Schilder mit kleinen Ecken an heller Flurwand, flach im Ruhezustand.
- Das Türschild als wiederkehrende Form: schwarzes Kopfband mit großer Nummer, Datum oder Uhrzeit.
- Schwarz ist die Hauptaktion; Gelb markiert Auswahl, aktuellen Ort, Schrittnummer und Fokus.
- Eine Schriftfamilie in zwei Breiten: Barlow für Text, Barlow Condensed für Überschriften, Nummern und Schilder; Zahlen in Tabellenziffern.
- Fachfarben (grün, blau, orange, rot, grau) mit fester Bedeutung, nie Dekoration.
- Alles selbst gehostet und CSP-fest: keine Inline-Stile, keine fremden Server.

## Colors

Eine Flurpalette: zwei Flügelfarben, Schildschwarz und Emaille-Weiß auf petrol getönter Wand, dazu fünf Fachfarben mit fester Bedeutung.

### Primary
- **Petrol-Wand** (`wall`, #0a5f60): Flügel der Lehrkräfte und der öffentlichen Seiten – Kopfzeile (`.site-header`), Petrol-Bänder der Startseite (erster Bildschirm, „Vom Brief zum Plan“, Abschluss), ausgewählte Kalendertage, Kopf der Wahl „Anmelden“ (`.tauth-choice-login`), `theme-color`. Weiße Schrift darauf (7,5:1).
- **Petrol** (`primary`, #0a5f60): derselbe Ton als Funktionsfarbe für Links, `accent-color`, Cursor, Ablageflächen-Hover und Kalenderpunkte.
- **Tiefes Petrol** (`wall-dark` / `primary-dark`, #084a4b): Hover von Petrol, Lehrkräftecode in der Kopfzeile, Schrift auf Petrol-Hauch.
- **Petrol-Hauch** (`primary-soft`, #d5e8e5): heller Grund für Codes, Info-Badges und Ghost-Hover.
- **Petrol-Nebelschrift** (`wall-muted`, #cfe3e1): Nebentext auf Petrol (5,6:1).

### Secondary
- **Signalgelb** (`accent`, #f3c522): Flügel der Eltern – gelbe Kopfzeile (`.parent-header`), Elternbrief-Band der Startseite, Richtungsschild „Zugang für Eltern“, senkrechter Flügelstreifen (`.start-wing`) – und zugleich der Markierungsstrich: Textauswahl, aktueller Ort in der Navigation, Schrittnummern (`.evt-step`, `.parent-step-num`, `.tauth-way-num`), offener Status an Klassenkacheln, Innenring des Fokus. Schrift darauf immer `ink` (11,2:1).
- **Gelbhauch** (`accent-soft`, #fcefbf): ausgewählter Name in der Wartebank (`.sched-chip[aria-pressed='true']`, `.dp-chip`), Hover von Nebenaktionen und Umschaltern.
- **Ockerkante** (`accent-border`, #d9ab00): heutiger Tag im Kalender.
- **Ockerschrift** (`accent-text`, #5c4600): Schrift auf hellem Gelb.

### Neutral
- **Flurwand** (`bg`, #e3eceb): Arbeitsgrund aller Seiten.
- **Emaille-Weiß** (`surface`, #ffffff): jedes Schild – Karten, Kacheln, Tabellen, Tafel, Türliste, Dialog.
- **Schild-Tonstufe** (`surface-2`, #f0f5f4): Fläche innerhalb eines Schilds – Tabellenkopf, Statuszeile, Ablagefläche, leere Zustände, schreibgeschützte Felder.
- **Schildschwarz** (`ink` / `text`, #111515): Schildschrift, Türschild-Kopfband, Hauptaktion, Fußzeile, Toasts. **Graphit** (`ink-hover`, #2b3535) ist sein Hover.
- **Kreidegrau** (`on-ink-muted`, #c9d4d3): Nebenschrift auf schwarzen Kopfbändern (Uhrzeit im Tageskopf, „Klasse“ vor der Nummer, „Uhr“ im Terminschild); CSS-Variable `--c-on-ink-muted`.
- **Schiefergrün** (`muted`, #4b5d5c): Nebentext, Feldhinweise, Tabellenköpfe (mind. 5,8:1 auf allen hellen Flächen).
- **Fugengrau** (`border`, #cddbd9): Trennlinien in Tabellen und Schildern.
- **Feldrand** (`border-strong`, #6f8381): Rand von Eingabefeldern, Slots und Chips (4,0:1 gegen Weiß).

### Fachfarben
Feste Bedeutung aus dem Produkt, in jeder Ansicht gleich (`--c-available`, `--c-appt-*`):
- **Verfügbar-Grün** (`available`, #2eaa5c) mit **Grünhauch** (`available-soft`, #d7f2e1): Eltern haben Zeit – markierte Slots bei den Eltern, freie Bänder im Terminplan (`.sched-band`), freie Zeilen der Türliste, Rücklauf-Balken, „fertig“-Punkt an Klassenkacheln.
- **Termin-Blau** (`appt-ok`, #2f6fd6): Termin passt.
- **Termin-Orange** (`appt-partial`, #f08c00): Termin ragt in nicht verfügbare Zeit; Schrift darauf `ink`.
- **Termin-Rot** (`appt-unavailable`, #d63a3a): Eltern zu Beginn nicht verfügbar.
- **Fremdklassen-Grau** (`appt-other`, #8a94a6): Rand der Termine anderer Klassen.

Toasts tragen Grün, Orange und Rot als kleine runde Statusmarke (`.toast-success`, `.toast-warning`, `.toast-error`).

### Meldungen
- **Erfolgsgrün** (`success`, #1e8e4e; Schrift `success-text`, #17703d; Fläche `success-soft`, #e3f5ea), **Warnbraun** (`warning`, #a14f00; `warning-soft`, #fff1e0), **Gefahrenrot** (`danger`, #c62f2f; `danger-soft`, #fdeaea), **Hinweis-Petrol** (`info-soft`, #d5e8e5): Hinweisschilder (`.alert-*`), Badges, Feldfehler, Gefahrenknopf, Erfolgszeichen.
- **Elternbrief-Gelb** (`letter-box`, #fff4b3) mit **Elternbrief-Kante** (`letter-box-border`, #e2b400): nur der „gelbe Kasten“ (`.parent-yellow-box`, `.tauth-code-box`), farbgleich mit dem gedruckten Brief, damit Eltern ihn wiedererkennen.

### Named Rules
**The Wing Rule.** Die Flügelfarbe zeigt, wo man ist: Die Kopfzeile trägt immer genau einen Flügel – Petrol für öffentliche Seiten und Lehrkräfte, Signalgelb für Eltern. Gelbe Elemente auf Petrol (Flügelstreifen, Elternschild) weisen den Weg in den Eltern-Flügel.

**The Fixed Meaning Rule.** Grün, Blau, Orange, Rot und Grau bedeuten immer dasselbe: frei, passt, ragt hinein, nicht verfügbar, andere Klasse. Sie dienen nie zur Auszeichnung, Gliederung oder Dekoration, und keine andere Farbe übernimmt ihre Bedeutung.

**The Yellow Marker Rule.** Gelb markiert, was gerade gemeint ist: Auswahl, aktueller Ort, Schrittnummer, offener Status, heutiger Tag, Fokus. Die Hauptaktion ist schwarz, nicht gelb; einzig das Richtungsschild „Zugang für Eltern“ ist gelb, weil es den Eltern-Flügel trägt.

## Typography

**Display Font:** Barlow Condensed (mit Arial Narrow, Barlow, system-ui)
**Body Font:** Barlow (mit system-ui, Segoe UI, Roboto, Helvetica Neue, Arial)
**Label/Mono Font:** keine eigene; Codes stehen in Barlow mit Tabellenziffern (`--font-code: var(--font)`), weil das Code-Alphabet kein I, L, O oder U enthält.

**Character:** Eine Familie in zwei Breiten, wie Schildschrift: die schmale Barlow Condensed (600/700/800) für Überschriften, Nummern, Uhrzeiten und Schilder, die normale Barlow (400/500/600/700) für Text. Selbst gehostet als woff2 (Latin und Latin Extended, SIL OFL, `fonts/`), `font-display: swap`; Barlow 400 und Barlow Condensed 700 werden in `index.html` vorgeladen.

### Hierarchy
- **Display** (800, clamp(2.6rem, 5.15vw, 5rem), 0.92): Überschrift der Wegweiser-Tafel (`.start-title`); nur Startseite.
- **Headline Band** (800, clamp(2.4rem, 4.6vw, 4.1rem), 0.95): Überschriften der Startseiten-Bänder (`.start-band h2`).
- **Headline** (700, 2.5rem, 1.02; 2rem unter 720 px): Seitenüberschrift h1 in den Bereichen.
- **Title** (700, 1.6rem, 1.08): h2, Karten; Dialogtitel 1.75rem.
- **Sign Number** (800, 3.4rem, 0.9): große Nummer im Türschild (`.tcl-tile-name`; Türliste `.dp-class` 3rem).
- **Sign** (700, 1.5rem, 1.1): Richtungsschilder; Kopfbänder nutzen dieselbe Schrift in 1.25–1.75rem, die Navigation 600 in 1.125rem, Tabellenköpfe 600 in 1rem.
- **Subtitle** (Barlow 600, 1.125rem, 1.15): h3.
- **Lead** (Barlow 400, clamp(1.25rem, 2vw, 1.75rem), 1.3; max. 30–32ch): Unterzeile und Aussagen der Startseite, höchstens 28 px, damit sie nicht als Überschrift gelesen werden.
- **Body** (Barlow 400, 16px, 1.5): Fließtext; Lesetext (Datenschutz) 1.0625rem bei 1.6 und max. 68ch.
- **Label** (Barlow 600, 1rem, 1.2): Knöpfe, Feldbeschriftungen; Badges 0.82rem, Hinweise und Legenden 0.875rem.
- **Code** (Barlow 500, 0.95em, Laufweite 0.04em, Tabellenziffern): Codes und Termin-Schlüssel (`.code`).

### Named Rules
**The One Family Rule.** Nur Barlow und Barlow Condensed: keine zweite Familie, keine Monospace, keine Systemschrift als Display. Die schmale Breite gehört Überschriften, Nummern, Uhrzeiten, Tabellenköpfen und Schildern; Fließtext ist nie schmal.

**The Tabular Figures Rule.** Uhrzeiten, Daten, Codes und Anzahlen stehen in Tabellenziffern (`font-variant-numeric: tabular-nums`) – in Tabellen, Zeit- und Zahlfeldern, Slots, Tageskopfbändern, Kalendern, Zählern und der Speicheranzeige.

**The Scale Jump Rule.** Rang entsteht durch Größe und Breite, nicht durch weitere Gewichte (Text 400, Beschriftung 600, Schild 700/800). Den Sprung ins Wandformat – Tafel bis 5rem, „ParentsDay“ im Abschluss bis 10.5rem, „Fragen“ in 30cqw bis 9rem (Obergrenzen höchstens 2,5 × Untergrenze, damit die Wörter beim Zoomen auf 200 % mitwachsen) – gibt es nur auf der Startseite; in den Bereichen endet die Skala bei h1 mit 2.5rem.

## Layout

**Bereiche.** `.container` (max. 1200px, Rand 16px) mit `.main` (28px oben, 56px unten). Der Seitenkopf (`.page-header`) stellt h1 links und Aktionen rechts auf eine gemeinsame Unterkante und bricht um. Inhalte stehen in `.stack` (16px) bzw. `.stack-small` (8px), Gruppen in `.cluster` (8px/12px). Zweispaltige Raster (`.grid-2`, `.form-grid`, 16px Abstand) werden unter 720px bzw. 640px einspaltig; Kacheln füllen automatisch (`.tiles`, min. 190px; Klassen 230px).

**Startseite.** Volle Bänder (`.start-band`, Innenabstand `clamp(80px, 10vw, 152px)`, 72px auf Smartphones) wechseln die Flurfarbe: Petrol (erster Bildschirm, „Vom Brief zum Plan“, Abschluss), Flurwand (Termine, Fragen), Gelb (Elternbrief). Innen max. 1240px bei Seitenrand `clamp(16px, 3vw, 32px)`. Erster Bildschirm: Raster aus Tafel, 18px breitem gelbem Flügelstreifen über die volle Wandhöhe und Türliste (330–410px); die Kopfzeile gehört zur Petrol-Wand. Unter 980px einspaltig, der Flügelstreifen wird zum 14px hohen waagerechten Band. Das Karussell läuft rechts bis an den Fensterrand und rastet je Station ein. Beim Scrollen erscheinen Inhalte nur hier: 16px von unten in 600 ms, je Element 60 ms versetzt; der Brief öffnet sich von oben (`clip-path`). Das gilt nur mit Bewegung und `IntersectionObserver`, ohne beides ist alles sofort sichtbar.

**Eltern-Bereich.** Zuerst Smartphone. Die Slots stehen in einem Raster, dessen Spaltenzahl der Code so setzt, dass jede Zeile an einer vollen Stunde beginnt (`--parent-cols-sm`, ab 600px `--parent-cols-lg`).

**Lehrkraft-Bereich.** Auf Tablets bedienbar. Tagesspalten im Terminplan min. 250px nebeneinander; auf schmalen Bildschirmen wird das Detailfeld zum Blatt am unteren Rand.

**Kopfzeile und Tippflächen.** Die Kopfzeile klebt ab 721px oben (`scroll-padding-top` aus `--header-h`), auf Smartphones scrollt sie mit. Tippflächen sind mindestens 44px hoch (Knöpfe, Felder, Kalendertage), Eltern-Slots und große Knöpfe 56px, Richtungsschilder 64px. Hover-Bewegungen nur unter `(hover: hover) and (pointer: fine)`.

**The Whole Slot Rule.** Zeit erscheint in ganzen Planfeldern: Die Türliste hat eine 44px-Zeile je 10 Minuten, Slot-Zeilen beginnen an vollen Stunden, Uhrzeiten stehen in einer eigenen Spalte links.

## Elevation & Depth

Flach. Tiefe entsteht durch Tonstufen und Kontrast, nicht durch Schatten: Flurwand, weißes Schild, Tonstufe im Schild; schwarze Kopfbänder und Petrol-Flächen setzen die stärksten Kanten. `--shadow` ist `none`, Karten tragen keinen Rand.

### Shadow Vocabulary
- **Schweben** (`box-shadow: 0 14px 36px -10px rgba(0, 0, 0, 0.34), 0 2px 6px rgba(0, 0, 0, 0.1)`, `--shadow-strong`): nur, was wirklich schwebt – Dialog, Toast, gezogener Name (`.sched-ghost`, `.sched-preview`) und Kachel bzw. Auswahl-Karte, die sich bei Maus-Hover um 3px hebt.
- **Blatt** (`box-shadow: 0 0 0 2px var(--c-ink), 0 -10px 30px rgba(0, 0, 0, 0.22)`): Detailfeld des Terminplans als Blatt am unteren Bildschirmrand.
- **Fokus** (`box-shadow: 0 0 0 3px var(--c-accent), 0 0 0 5px var(--c-ink)`, `--focus`): gelber Innen-, schwarzer Außenring wie eine Warnmarkierung, sichtbar auf Weiß, Petrol und Gelb. Dazu immer `outline: 2px solid transparent` – unsichtbar, aber im Hochkontrastmodus (dort fällt `box-shadow` weg) der Fokusrahmen in Systemfarbe; in Klappen mit `overflow: hidden` liegt der Ring innen (`inset`).
- **Auswahlring** (`box-shadow: 0 0 0 2px var(--c-ink)`): harter Ring ohne Versatz und Unschärfe für ausgewählte Namen und Termine.

### Named Rules
**The Flat Enamel Rule.** Im Ruhezustand wirft nichts einen Schatten. Schatten antworten nur auf einen Zustand: geöffnet (Dialog, Toast, Blatt), gezogen oder mit der Maus angehoben.

## Shapes

Kleine Ecken wie gestanzte Schilder: `radius-small` (3px) für Bedienelemente – Knöpfe, Felder, Chips, Badges, Codes, Slots –, `radius` (4px) für Schilder – Karten, Kacheln, Tabellen, Hinweise, Türschilder –, `plate` (6px) für die großen Tafeln – Wegweiser-Tafel, Türliste, Dialog, Blatt – und `swatch` (2px) für Farbfelder, Beispiel-Etiketten und Markierungen. Kreise gibt es nur als Statuspunkte (Klassenkachel, Toast, Kalender). Ränder sind Bedeutung: 2px schwarz für Nebenaktionen und Ausgewähltes, 1px `border-strong` für Felder, 2px durchgehend grün für freie Zeit. Das Logo (`favicon.svg`) ist ein schwarzes Schild mit kleiner Rundung, weißem „PD“ und gelber Leiste unten.

**The Small Corner Rule.** Keine Radien über 6px, keine Pillenformen.

**The Dashed Means Open Rule.** Gestrichelt heißt offen oder unbestimmt: leere Zeile der Türliste, Ablagefläche (`.dropzone`), Termin oder Name mit unbekannten Zeiten (`.sched-appt-unknown`, `.sched-chip-unknown`), Vorschau beim Ziehen. Feste Dinge haben durchgehende Ränder.

## Components

### Buttons
Schilder zum Drücken: flach, eckig, mit kurzer, entschiedener Rückmeldung.
- **Shape:** kleine Ecken (`radius-small`), 2px Rand, mindestens 44px hoch, Barlow 600.
- **Primary:** schwarzes Schild (`ink`, weiße Schrift), Innenabstand 8px 18px; Hover Graphit.
- **Hover / Focus:** Farbwechsel in 160 ms (`--dur-fast`, `--ease-out`), Druck 1px nach unten (`translateY(1px)`) in 120 ms – nicht verkleinern, sonst geht das Loslassen am Rand breiter Knöpfe daneben; Fokus `--focus`, gesperrt mit 50 % Deckkraft.
- **Secondary / Ghost / Tertiary:** Zusatzschild weiß mit 2px schwarzem Rand, Hover Gelbhauch; auf der Petrol-Kopfzeile weiß, Hover Signalgelb. Ghost transparent, Hover Petrol-Hauch (auf Petrol: weiße Schrift, Hover Tiefes Petrol). Danger rot mit weißer Schrift für Löschen; Success dunkelgrün (`success-text`, weiße Schrift 6,1:1) für das Absenden der Eltern; das hellere `success` trägt nur Zeichen ohne Schrift (Haken, Punkte, Ränder). Größen: groß 56px (12px 28px, 1.1rem), klein 36px, Icon-Knopf 32px quadratisch.

### Chips
- **Style:** Namen in der Wartebank (`.sched-chip`, `.dp-chip`) weiß mit Rand, im Terminplan mit Punktraster als Griff zum Ziehen. Badges (`.badge-*`) in der Tonstufe ihrer Meldungsfarbe, 0.82rem/600. Codes (`.code`) auf Petrol-Hauch. Schrittnummern als kleines gelbes Schild (32–34px) mit schmaler 800er Ziffer.
- **State:** ausgewählt Gelbhauch mit schwarzem Rand und schwarzem Ring; Name mit unbekannten Zeiten gestrichelt.

### Cards / Containers
- **Corner Style:** `radius` (4px); große Tafeln `plate` (6px).
- **Background:** Emaille-Weiß; Nebenschilder in der Tonstufe (`.tcl-event`).
- **Shadow Strategy:** keine (siehe Elevation & Depth); Kacheln heben sich nur bei Maus-Hover.
- **Border:** keiner; das Schild hebt sich durch Weiß von der Flurwand ab.
- **Internal Padding:** 22px, auf Smartphones 18px 16px; Kacheln 18px.

### Inputs / Fields
- **Style:** weiß, 1px Feldrand, `radius-small`, Innenabstand 9px 12px, mindestens 44px; Beschriftung darüber in 600, Hinweis 0.875rem in Schiefergrün; Zeit- und Zahlfelder in Tabellenziffern.
- **Focus:** Rand schwarz plus `--focus`; Hover Rand schwarz.
- **Error / Disabled:** `aria-invalid` färbt den Rand `danger`, Fehlertext 600 in `danger`; schreibgeschützt Tonstufe mit Schiefergrün.
- **Eltern-Slot:** zweizeilig (Beginn groß in Barlow Condensed, Ende klein), 56px, 2px Feldrand; markiert Verfügbar-Grün mit gezeichnetem Haken oben rechts und schwarzer Schrift (6,2:1).
- **Gelber Kasten:** Vorname, Nachname und Code wie im Brief in Elternbrief-Gelb mit 2px Elternbrief-Kante.
- **Kalender:** Tage als 44px-Felder; ausgewählt Petrol mit weißer Schrift, heute mit Ockerkante und Punkt, Wochenende in der Tonstufe.

### Navigation
- Kopfzeile in der Flügelfarbe: Petrol für öffentliche Seiten und Lehrkräfte, Signalgelb mit schwarzem Etikett „Elternzugang“ für Eltern. Links das Logo-Schild (36px) und „ParentsDay“ in Barlow Condensed 800. Navigationslinks in Barlow Condensed 600 (1.125rem); aktueller Ort und Hover mit 3px gelbem Unterstrich. Darunter eine Statuszeile in der Tonstufe mit der Speicheranzeige. Fußzeile schwarz. Auf Smartphones scrollt die Kopfzeile mit, Aktionen füllen die Breite. Der Zurück-Link trägt einen Pfeil nach links, der bei Maus-Hover 3px ausweicht.

### Türschild (Signature)
Die wiederkehrende Form des Systems: weißes Schild mit schwarzem Kopfband, darin groß und schmal Nummer, Datum oder Uhrzeit, Nebenangaben in Kreidegrau. Varianten: Klassenkachel (`.tcl-tile`, Klassennummer 3.4rem, Statuspunkt gelb = offen, grün = fertig, unten Statuszeile mit Pfeil), Tagesspalte im Terminplan (`.sched-day-head`), Tag und Eckdaten bei den Eltern (`.parent-day-head`, `.parent-event-title`), Terminschild der Startseite (`.start-appt`), Wahl auf „Zugang für Lehrkräfte“ (`.tauth-choice`, „Anmelden“ mit Petrol-Kopf) und die geöffnete Frage der Startseite.

### Richtungsschild (Signature)
Link als Schild mit Pfeil am Ende (`.start-sign`): Barlow Condensed 700, 1.5rem, mindestens 64px, `radius`. „Zugang für Lehrkräfte“ schwarz, „Zugang für Eltern“ signalgelb mit schwarzer Schrift; auf der Tafel untereinander, auf Smartphones in voller Breite. Bei Maus-Hover rückt der Pfeil 4px nach rechts, Druck 1px nach unten. Bisher nur auf der Startseite; in den Bereichen trägt das schwarze Primary-Schild die Hauptaktion.

### Türliste und Terminblöcke (Signature)
Die Türliste ist der Terminplan: Uhrzeiten links in Barlow Condensed mit Tabellenziffern, rechts die Zeilen. Eine leere Zeile ist gestrichelt auf der Tonstufe, die freie Zeit der ausgewählten Eltern grün. Gesetzte Namen sind volle Blöcke in Termin-Blau, -Orange oder -Rot (`.dp-*`, `.sched-appt-*`), Schrift weiß bzw. schwarz auf Orange. Termine anderer Klassen stehen hellgrau mit grauem Rand und sind gesperrt; Termine mit unbekannter Verfügbarkeit Petrol-Hauch mit gestricheltem blauem Rand. Eine Überschneidung (`.sched-overlap`) liegt als diagonale Schraffur über dem Block (`repeating-linear-gradient(135deg, …)`) – ein Zustandszeichen, kein Schmuck. Ein gesetzter Name rastet in 260 ms ein (`dp-snap`: kurz von links, leicht verkleinert); bei reduzierter Bewegung ohne Animation. Beispieldaten tragen ein schwarzes Etikett „Beispiel“.

### Hinweise, Dialoge, Toasts
- **Hinweisschild** (`.alert-*`): ganze Fläche in der Tonstufe mit 1px Rand derselben Farbfamilie, kein Seitenstreifen.
- **Dialog** (`.modal`): weißes Schild (`plate`), max. 520px (breit 820px), 26px Innenabstand, Schweben-Schatten, Hintergrund Petrol-Schwarz zu 50 %; erscheint in 220 ms aus 8px Tiefe bei 97 % Größe. Auf schmalen Bildschirmen stehen die Knöpfe untereinander in voller Breite.
- **Toast** (`.toast`): schwarzes Schild mit runder Statusmarke vorn statt Farbstreifen und gezeichnetem Schließen-Icon; unten rechts, auf Smartphones oben.

### Icons
Gezeichnete Formen als CSS-Masken (`.icon-check`, `-close`, `-plus`, `-arrow-left`, `-arrow-right`, `-upload`), eingefärbt mit `currentColor`, 1em groß; die SVGs liegen als Data-URIs in CSS-Variablen und laufen so unter der CSP. Im Windows-Kontrastmodus behalten sie die Schriftfarbe (`forced-color-adjust: none`).

## Do's and Don'ts

### Do:
- **Do** Inhalte als emaille-weiße Schilder (`surface`, `radius` 4px, ohne Schatten und Rand) auf die Flurwand (`bg`) setzen.
- **Do** die Kopfzeile in der Flügelfarbe des Bereichs halten: Petrol (`wall`) für öffentliche Seiten und Lehrkräfte, Signalgelb (`accent`) mit schwarzer Schrift für Eltern.
- **Do** Nummern, Daten und Uhrzeiten als Türschild zeigen: schwarzes Kopfband, Barlow Condensed 700/800, Tabellenziffern.
- **Do** die Hauptaktion als schwarzes Schild (`.btn-primary`) und Nebenaktionen als weißes Schild mit 2px schwarzem Rand (`.btn-secondary`) gestalten.
- **Do** Auswahl, aktuellen Ort, Schrittnummer und Fokus gelb markieren; den Fokus immer über `--focus`.
- **Do** Fachfarben nur in ihrer Bedeutung verwenden und in einer Legende (`.legend`) erklären.
- **Do** dynamische Werte über CSSOM setzen, möglichst als Custom Property (`el.style.setProperty('--name', …)`), und Schriften, Bilder und Icons im Projekt ablegen.
- **Do** Bewegung nur mit `--ease-out`, `--ease-in-out` oder `--ease-drawer` und den Dauern `--dur-press`, `--dur-fast`, `--dur` gestalten (Ausnahme: Erscheinen beim Scrollen auf der Startseite), Hover-Bewegung nur unter `(hover: hover) and (pointer: fine)`, und `prefers-reduced-motion` abschalten lassen.
- **Do** Beispieldaten sichtbar mit dem Etikett „Beispiel“ kennzeichnen.

### Don't:
- **Don't** Schatten im Ruhezustand verwenden; `--shadow-strong` gehört nur Dialog, Toast, gezogenen Elementen und dem Anheben bei Maus-Hover.
- **Don't** farbige Seitenstreifen an Karten, Hinweisen oder Toasts setzen; der gelbe Flügelstreifen der Startseite ist ein Element der Wand, kein Kartenschmuck.
- **Don't** Verläufe als Schmuck einsetzen; die Schraffur bleibt das Zeichen für Überschneidung im Terminplan, das Punktraster der Griff zum Ziehen.
- **Don't** Grün, Blau, Orange, Rot oder Grau zur Dekoration oder Gliederung verwenden.
- **Don't** Radien über 6px oder Pillenformen verwenden.
- **Don't** eine zweite Schriftfamilie, Monospace oder Schriften von fremden Servern einbinden.
- **Don't** Schriftzeichen wie ✓, × oder → als Icons verwenden; nur die gezeichneten Masken-Icons.
- **Don't** `style`-Attribute oder Inline-Stile schreiben; die CSP (`style-src 'self'`) blockiert sie.
- **Don't** den Sprung ins Wandformat in den Lehrkraft- oder Eltern-Bereich übertragen.
- **Don't** das blaue Erscheinungsbild der PDFs in die Oberfläche zurückholen; die PDFs liegen vorerst außerhalb dieses Systems.
- **Don't** die zentrierte Überschrift über zwei Knöpfen mit einer Reihe gleicher Schritt-Karten bauen, und nicht den blassen Schul-App-Look, Schulheft-Kitsch oder Behörden-Look.
