// Startseite: ParentsDay als Leitsystem im Schulflur. Oben ein großes Schild mit der Botschaft und den beiden
// Zugängen als Richtungsschildern, daneben die Türliste einer Klasse zum Ausprobieren (Beispieldaten).
// Mit digitalem Briefkasten (MAILBOX_URL) beschreiben Schritte, Fragen und Datenschutz-Zeile den Weg über den
// Briefkasten statt über die PDF-Datei per E-Mail.

import { h, mount } from '../core/ui.js';
import { mailboxEnabled } from '../core/mailbox.js';

/** Setzt die Reihenfolge für das gestaffelte Erscheinen (CSS-Variable --i, über CSSOM). */
function rise(el, i = 0) {
  el.setAttribute('data-rise', '');
  el.style.setProperty('--i', String(i));
  return el;
}

function icon(name) {
  return h('span', { class: `icon icon-${name}`, 'aria-hidden': 'true' });
}

/** Richtungsschild: Link mit Pfeil. */
function sign(href, label, variant, testId) {
  return h('a', { class: `start-sign start-sign-${variant}`, href, 'data-testid': testId || null }, h('span', {}, label), icon('arrow-right'));
}

// ---------- Türliste zum Ausprobieren ----------

const START = 14 * 60;
const ROWS = 6; // 14:00–15:00 in Schritten von 10 Minuten
const STEP = 10;
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// Beispielfamilien: freie Zeit der Eltern [von, bis) in Minuten, Gesprächsdauer
const FAMILIES = [
  { id: 'beck', name: 'Anna Beck', free: [14 * 60, 14 * 60 + 30], duration: 10 },
  { id: 'mueller', name: 'Jörg Müller', free: [14 * 60 + 20, 14 * 60 + 50], duration: 10 },
  { id: 'krueger', name: 'Mats Krüger', free: [14 * 60 + 30, 14 * 60 + 40], duration: 20 },
  { id: 'celik', name: 'Ayşe Çelik', free: [14 * 60 + 10, 14 * 60 + 40], duration: 10 },
  { id: 'schulz', name: 'Lina Schulz', free: [14 * 60 + 50, 15 * 60], duration: 10 },
];
const INITIAL = { placed: { beck: 0 }, selected: 'mueller' };

const STATUS_TEXT = { ok: 'Termin passt', partial: 'ragt in nicht verfügbare Zeit', unavailable: 'Eltern haben keine Zeit' };

/** Wie im Terminplan: blau = passt, orange = ragt in nicht verfügbare Zeit, rot = zu Beginn nicht verfügbar. */
function statusOf(fam, row) {
  const start = START + row * STEP;
  const end = start + fam.duration;
  if (start < fam.free[0] || start >= fam.free[1]) return 'unavailable';
  return end <= fam.free[1] ? 'ok' : 'partial';
}

function doorList() {
  let placed = { ...INITIAL.placed };
  let selected = INITIAL.selected;
  const byId = Object.fromEntries(FAMILIES.map((f) => [f.id, f]));

  const grid = h('div', { class: 'dp-grid', role: 'group', 'aria-label': 'Gesprächszeiten am Donnerstag, 14:00 bis 15:00 Uhr' });
  const bench = h('ul', { class: 'dp-bench-list' });
  const hint = h('p', { class: 'dp-hint', 'aria-live': 'polite' });

  const covered = () => {
    const map = new Map();
    for (const [id, row] of Object.entries(placed)) {
      const rows = byId[id].duration / STEP;
      for (let r = row; r < Math.min(ROWS, row + rows); r++) map.set(r, id);
    }
    return map;
  };

  const select = (id) => {
    selected = selected === id ? null : id;
    render();
    const chip = bench.querySelector(`[data-family="${selected || id}"]`);
    chip?.focus();
  };

  const place = (row) => {
    if (!selected) return;
    const id = selected;
    placed = { ...placed, [id]: row };
    const fam = byId[id];
    const st = statusOf(fam, row);
    selected = null;
    render({ justPlaced: id });
    hint.textContent = `${fam.name} steht um ${hhmm(START + row * STEP)} Uhr in der Liste: ${STATUS_TEXT[st]}.`;
    grid.querySelector(`[data-entry="${id}"]`)?.focus();
  };

  const unplace = (id) => {
    const { [id]: _drop, ...rest } = placed;
    placed = rest;
    selected = id;
    render();
    bench.querySelector(`[data-family="${id}"]`)?.focus();
  };

  const reset = () => {
    placed = { ...INITIAL.placed };
    selected = INITIAL.selected;
    render();
  };

  function render({ justPlaced = null } = {}) {
    const cov = covered();
    const sel = selected ? byId[selected] : null;
    const cells = [];
    for (let r = 0; r < ROWS; r++) {
      const time = hhmm(START + r * STEP);
      const free = sel && START + r * STEP >= sel.free[0] && START + r * STEP < sel.free[1];
      const timeEl = h('span', { class: 'dp-time' }, time);
      timeEl.style.gridRow = String(r + 1);
      cells.push(timeEl);
      const id = cov.get(r);
      if (id && placed[id] === r) {
        const fam = byId[id];
        const st = statusOf(fam, r);
        const entry = h(
          'button',
          {
            type: 'button',
            class: `dp-entry dp-${st}${justPlaced === id ? ' dp-entry-new' : ''}`,
            'data-entry': id,
            'aria-label': `${time} Uhr: ${fam.name}, ${STATUS_TEXT[st]}. Antippen, um den Termin zurückzunehmen.`,
            onclick: () => unplace(id),
          },
          h('span', { class: 'dp-entry-name' }, fam.name),
          fam.duration > STEP ? h('span', { class: 'dp-entry-dur' }, `${fam.duration} Min.`) : null,
        );
        entry.style.gridRow = `${r + 1} / span ${Math.min(ROWS - r, fam.duration / STEP)}`;
        cells.push(entry);
      } else if (!id) {
        // Ein längeres Gespräch darf nicht in einen schon gesetzten Namen hineinragen
        const blocked = sel ? Array.from({ length: sel.duration / STEP - 1 }, (_, k) => r + k + 1).some((row) => row < ROWS && cov.has(row)) : true;
        const slot = h(
          'button',
          {
            type: 'button',
            class: `dp-slot${free ? ' dp-slot-free' : ''}`,
            disabled: blocked,
            'aria-label': sel ? `${time} Uhr: ${sel.name} hier eintragen${free ? ' (Eltern haben Zeit)' : ''}` : `${time} Uhr: frei`,
            onclick: () => place(r),
          },
          free ? h('span', { class: 'dp-slot-mark' }, 'Eltern haben Zeit') : null,
        );
        slot.style.gridRow = String(r + 1);
        cells.push(slot);
      }
    }
    mount(grid, cells);

    const waiting = FAMILIES.filter((f) => !(f.id in placed));
    mount(
      bench,
      waiting.length
        ? waiting.map((f) =>
            h(
              'li',
              {},
              h(
                'button',
                { type: 'button', class: 'dp-chip', 'data-family': f.id, 'aria-pressed': String(selected === f.id), onclick: () => select(f.id) },
                f.name,
                f.duration > STEP ? h('span', { class: 'dp-chip-dur' }, ` · ${f.duration} Min.`) : null,
              ),
            ),
          )
        : h('li', { class: 'dp-bench-done' }, 'Alle Familien haben einen Termin.'),
    );
    if (!justPlaced) {
      hint.textContent = sel
        ? `Grün: Hier haben die Eltern von ${sel.name} Zeit. Tippen Sie eine Uhrzeit an.`
        : waiting.length
          ? 'Tippen Sie einen Namen an und dann eine Uhrzeit.'
          : 'Fertig. Im echten Plan ziehen Sie die Namen einfach mit der Maus.';
    }
  }

  render();

  return h(
    'figure',
    { class: 'dp', 'data-ui': '', 'aria-labelledby': 'dp-title' },
    h(
      'div',
      { class: 'dp-head' },
      h('span', { class: 'dp-class', 'aria-hidden': 'true' }, '5a'),
      h('span', { class: 'dp-who' }, h('span', { class: 'dp-who-name', id: 'dp-title' }, 'Klasse 5a · Frau Meier'), h('span', { class: 'dp-who-day' }, 'Donnerstag, Elternsprechtag')),
    ),
    grid,
    h('div', { class: 'dp-bench' }, h('p', { class: 'dp-bench-title' }, 'Noch nicht terminiert'), bench),
    hint,
    h(
      'figcaption',
      { class: 'dp-foot' },
      h(
        'ul',
        { class: 'dp-legend' },
        h('li', {}, h('i', { class: 'dp-sw dp-sw-ok' }), 'passt'),
        h('li', {}, h('i', { class: 'dp-sw dp-sw-partial' }), 'ragt in nicht verfügbare Zeit'),
        h('li', {}, h('i', { class: 'dp-sw dp-sw-unavailable' }), 'keine Zeit'),
      ),
      h('span', { class: 'dp-sample' }, 'Beispiel'),
      h('button', { type: 'button', class: 'dp-reset', onclick: reset }, 'Von vorn'),
    ),
  );
}

// ---------- Termine der Familien als Türschilder ----------

const APPOINTMENTS = [
  ['14:00–14:10', 'Anna Beck'],
  ['14:20–14:30', 'Jörg Müller'],
  ['14:30–14:40', 'Ayşe Çelik'],
  ['14:50–15:00', 'Lina Schulz'],
  ['15:10–15:30', 'Mats Krüger'],
  ['16:10–16:20', 'Tom Richter'],
];

function appointmentPlate([time, name], i) {
  return rise(
    h(
      'li',
      { class: 'start-appt' },
      h('p', { class: 'start-appt-time' }, time, h('span', { class: 'start-appt-unit' }, ' Uhr')),
      h('p', { class: 'start-appt-name' }, name),
    ),
    i,
  );
}

// ---------- Weg der Lehrkraft (Karussell mit echten Bildschirmfotos) ----------

function stations(withMailbox) {
  return [
    ['Zuerst registrieren', 'Name, Geburtsdatum und E-Mail-Adresse eintragen. Sie erhalten sofort eine PDF-Datei mit Ihrem Registrierungscode.', 'registriert', 'Registrierung abgeschlossen: Registrierungscode und Lehrkräftecode in gelben Kästen'],
    ['Dann den Tag anlegen', 'Tage im Kalender antippen, Uhrzeiten, Adresse der Schule und Terminlänge festlegen.', 'kalender', 'Kalender mit zwei ausgewählten Tagen im November'],
    ['Klassen anlegen', 'Jede Klasse bekommt ein eigenes Schild und zeigt, wie weit sie ist.', 'klassen', 'Klassenübersicht mit Schildern für die Klassen 5a, 7c und 9b'],
    ['Lernende eintragen', 'Namen eintippen oder aus einer Liste einfügen. Für jedes Kind entsteht ein Code.', 'tabelle', 'Tabelle der Lernenden mit Codes und den freien Zeiten der Eltern'],
    ['Briefe mitgeben', 'Ein DIN-A4-Blatt pro Kind, mit QR-Code und dem gelben Kasten zum Anmelden.', withMailbox ? 'elternbrief' : 'elternbrief-email', 'Ausschnitt aus einem Elternbrief mit dem gelben Kasten'],
    ['Eltern antworten', 'Am Handy die freien Zeiten grün markieren und absenden. Ein Konto brauchen sie nicht.', 'eltern-zeiten', 'Eltern-Ansicht am Smartphone mit grün markierten Zeiten'],
    [
      'Namen ziehen',
      withMailbox ? 'Die Rückmeldungen der Eltern kommen automatisch an. Sie ziehen die Namen in die Tagesansicht.' : 'Rückmeldungen der Eltern hochladen und die Namen in die Tagesansicht ziehen.',
      'terminieren',
      'Tagesansicht mit blauen, orangen und roten Terminen',
    ],
    ['Termine drucken', 'Eine Terminbestätigung für jede Familie und eine Übersicht für Sie.', 'terminbestaetigung', 'Übersicht der Gesprächstermine für die Lehrkraft mit beiden Tagen'],
  ];
}

function carousel(withMailbox) {
  const row = h('ol', { class: 'start-route-row', tabindex: '0', 'aria-label': 'Der Weg der Lehrkraft in acht Stationen' });
  // Bild zuerst, damit alle Bilder auf einer Oberkante stehen; jedes Bild liegt auf demselben weißen Schild
  const items = stations(withMailbox).map(([title, text, img, alt], i) =>
    rise(
      h(
        'li',
        { class: 'start-route-item' },
        h('div', { class: 'start-route-plate' }, h('img', { class: 'start-route-img', src: `img/start/${img}.webp`, width: '680', height: '850', alt, loading: 'lazy', decoding: 'async' })),
        h('h3', { class: 'start-route-title' }, title),
        h('p', { class: 'start-route-text' }, text),
      ),
      i,
    ),
  );
  mount(row, items);
  const fill = h('span', { class: 'start-route-fill' });
  const bar = h('div', { class: 'start-route-bar', 'aria-hidden': 'true' }, fill);
  const atStart = () => row.scrollLeft <= 2;
  const atEnd = () => row.scrollLeft >= row.scrollWidth - row.clientWidth - 2;
  const step = (dir) => {
    if ((dir < 0 && atStart()) || (dir > 0 && atEnd())) return;
    const item = row.querySelector('.start-route-item');
    const by = item ? item.getBoundingClientRect().width + parseFloat(getComputedStyle(row).columnGap || '32') : 300;
    row.scrollBy({ left: dir * by, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  // aria-disabled statt disabled: ein gesperrter Knopf verlöre sonst den Tastaturfokus
  const prev = h('button', { type: 'button', class: 'start-route-btn', 'aria-label': 'Zurück', onclick: () => step(-1) }, icon('arrow-left'));
  const next = h('button', { type: 'button', class: 'start-route-btn', 'aria-label': 'Weiter', onclick: () => step(1) }, icon('arrow-right'));
  const update = () => {
    const max = row.scrollWidth - row.clientWidth;
    const p = max > 0 ? row.scrollLeft / max : 1;
    fill.style.transform = `scaleX(${Math.max(0.08, p)})`;
    prev.setAttribute('aria-disabled', String(atStart()));
    next.setAttribute('aria-disabled', String(atEnd()));
  };
  row.addEventListener('scroll', update, { passive: true });
  row.addEventListener('load', update, true); // Bilder laden nach und ändern die Breite
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
  ro?.observe(row);
  const head = h('div', { class: 'start-route-head' }, rise(h('h2', { id: 'start-route-title' }, 'Vom Brief zum Plan'), 0), h('div', { class: 'start-route-nav' }, prev, next));
  return { el: h('div', { class: 'start-route' }, head, bar, row), update, cleanup: () => ro?.disconnect() };
}

// ---------- Der Elternbrief (angeheftet, die Schritte ziehen vorbei) ----------

function letterSteps(withMailbox) {
  return [
    ['qr', 'QR-Code scannen', 'Die Kamera des Handys öffnet ParentsDay mit den Terminen. Ohne QR-Code geht es mit dem Termin-Schlüssel unter dem gelben Kasten.'],
    ['box', 'Mit dem gelben Kasten anmelden', 'Vorname, Nachname und Code des Kindes stehen im gelben Kasten des Elternbriefs.'],
    ['times', 'Freie Zeiten markieren', 'Alle Zeiten grün markieren, zu denen ein Gespräch passt. Auch mehrere getrennte Zeiträume sind möglich.'],
    withMailbox ? ['send', 'Absenden – fertig', 'Ihre Angaben kommen automatisch bei der Lehrkraft an.'] : ['send', 'Absenden', 'Die erzeugte PDF-Datei per E-Mail an die Lehrkraft schicken.'],
  ];
}

// Stellen im Elternbrief als [links, oben, Breite, Höhe] in % des Bildes, ausgegeben von tools/startseite-bilder.mjs.
// Der Brief mit Briefkasten hat einen anderen Schritt 4 und steht deshalb etwas anders.
const LETTER_MARKS = {
  brief: { qr: [74.9, 33.2, 24.3, 18.4], box: [2.3, 61.9, 96.4, 18.1], times: [2.3, 21.4, 96.4, 10.5], send: [2.6, 52.3, 71.1, 8.2] },
  'brief-email': { qr: [76.1, 36.2, 23, 17.5], box: [2.3, 63.8, 96.4, 18.4], times: [2.3, 23.7, 96.4, 11.1], send: [2.6, 57.2, 61.8, 5] },
};

function letterStory(withMailbox) {
  const img = withMailbox ? 'brief' : 'brief-email';
  const figure = h(
    'figure',
    { class: 'start-letter-figure' },
    h(
      'div',
      { class: 'start-letter-sheet' },
      h('img', { class: 'start-letter-img', src: `img/start/${img}.webp`, width: '1050', height: '1388', alt: 'Ausschnitt aus einem Elternbrief: Zeiten des Elternsprechtags, „So geht’s“ in vier Schritten und der gelbe Kasten mit Vorname, Nachname und Code', loading: 'lazy', decoding: 'async' }),
      Object.entries(LETTER_MARKS[img]).map(([k, [left, top, width, height]]) =>
        h('span', { class: `start-letter-mark start-letter-mark-${k}`, 'data-mark': k, 'aria-hidden': 'true', style: { left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` } }),
      ),
    ),
    h('figcaption', { class: 'start-letter-caption' }, 'Elternbrief mit Beispieldaten'),
  );
  const steps = letterSteps(withMailbox).map(([key, title, text], i) => rise(h('li', { class: 'start-letter-step', 'data-step': key }, h('h3', {}, title), h('p', {}, text)), i));
  const list = h('ol', { class: 'start-letter-steps' }, steps);
  const setActive = (key) => {
    figure.dataset.active = key;
    for (const s of steps) s.classList.toggle('is-active', s.dataset.step === key);
  };
  setActive('box');
  let io = null;
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.dataset.step);
      },
      { rootMargin: '-45% 0px -45% 0px' },
    );
    steps.forEach((s) => io.observe(s));
  }
  return { figure, list, cleanup: () => io?.disconnect() };
}

// ---------- Bildnachweis der Fotos (erster Bildschirm und Abschluss) ----------

const COMMONS = 'https://commons.wikimedia.org/wiki/File:Berlin_Louise-Schroeder-Schule_lub_2024-01-20_';

function photoCredit() {
  const link = (href, text) => h('a', { href, rel: 'noopener' }, text);
  return h(
    'p',
    { class: 'start-photo-credit' },
    'Fotos: Lukas Beck, Flure der Louise-Schroeder-Schule in Berlin (Wikimedia Commons: ',
    link(`${COMMONS}img08_Interieur.jpg`, 'Flur'),
    ', ',
    link(`${COMMONS}img06_Interieur.jpg`, 'Tür'),
    '), Lizenz ',
    link('https://creativecommons.org/licenses/by/4.0/deed.de', 'CC BY 4.0'),
    '; bearbeitet: retuschiert, Ausschnitt (Tür), in Graustufen und eingefärbt.',
  );
}

// ---------- Fragen ----------

function questions(withMailbox) {
  const privacy = h(
    'p',
    { class: 'start-privacy', 'data-testid': 'start-privacy' },
    withMailbox
      ? 'ParentsDay speichert Ihre Daten in Ihrem Browser und – für Lehrkräfte mit ihrem Passwort verschlüsselt – in der Cloud-Sicherung. Die Rückmeldungen der Eltern gehen Ende-zu-Ende-verschlüsselt über den digitalen Briefkasten – lesen kann sie nur die Lehrkraft. '
      : 'ParentsDay speichert keine Daten auf einem Server. Alles bleibt in Ihrem Browser und in den Dateien, die Sie selbst herunterladen. ',
    h('a', { href: '#/datenschutz' }, 'Mehr zum Datenschutz'),
  );
  const rows = (pairs) => h('dl', { class: 'start-q-rows' }, pairs.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))));
  const items = [
    ['Wo bleiben die Daten?', privacy, true],
    ['Brauchen Eltern ein Konto?', h('p', {}, 'Nein. Eltern brauchen nur den Elternbrief und ein Handy. Sie melden sich mit Vorname, Nachname und Code ihres Kindes an.')],
    [
      'Wie kommen die Rückmeldungen zu mir?',
      h(
        'p',
        {},
        withMailbox
          ? 'Automatisch über den digitalen Briefkasten, Ende-zu-Ende-verschlüsselt. Schickt Ihnen doch jemand eine PDF-Datei per E-Mail, laden Sie sie in der Klasse hoch.'
          : 'Die Eltern schicken Ihnen eine PDF-Datei per E-Mail. Sie laden die Dateien in der Klasse hoch, die Zeiten erscheinen sofort bei den Lernenden.',
      ),
    ],
    ['Was sehen die Eltern?', rows([['Tage und Uhrzeiten', 'ja'], ['Ihr Name und die Klasse', 'ja'], ['Adresse der Schule', 'ja'], ['Andere Familien', 'nein']])],
    ['Geht das mit mehreren Klassen?', h('p', {}, 'Ja. Jede Klasse bekommt ein eigenes Schild. Im Terminplan sehen Sie die Termine Ihrer anderen Klassen grau, damit sich nichts überschneidet.')],
    ['Muss ich etwas installieren?', h('p', {}, 'Nein. ParentsDay läuft im Browser. Ihre Angaben speichert der Browser automatisch; einen Zwischenstand können Sie zusätzlich als Datei sichern.')],
  ];
  return items.map(([q, body, open], i) =>
    rise(h('details', { class: 'start-q', open: Boolean(open) }, h('summary', {}, h('span', {}, q), icon('plus')), h('div', { class: 'start-q-body' }, body)), i + 1),
  );
}

// ---------- Seite ----------

export default function render({ root, setTitle }) {
  setTitle('Startseite');
  const withMailbox = mailboxEnabled();
  root.classList.add('start-main');

  const hero = h(
    'section',
    { class: 'start-band start-hero', 'aria-labelledby': 'start-title' },
    h(
      'div',
      { class: 'start-inner start-hero-grid' },
      h(
        'div',
        { class: 'start-hero-main' },
        // Wegweiser-Tafel: Überschrift, Unterzeile und die beiden Zugänge als Richtungszeilen
        rise(
          h(
            'div',
            { class: 'start-plate' },
            h('h1', { id: 'start-title', class: 'start-title' }, 'Elternsprechtag ohne Zettelrücklauf'),
            h('p', { class: 'start-lead' }, 'Eltern tippen ihre freien Zeiten am Handy an. Sie setzen nur noch die Namen in den Plan.'),
            rise(h('nav', { class: 'start-signs start-signs-board', 'aria-label': 'Zugänge' }, sign('#/lehrkraft', 'Zugang für Lehrkräfte', 'teacher', 'start-teacher'), sign('#/eltern', 'Zugang für Eltern', 'parent', 'start-parent')), 2),
          ),
          0,
        ),
      ),
      // Flügelstreifen in Elterngelb zwischen Tafel und Türliste, vom Boden bis zur Decke
      h('span', { class: 'start-wing', 'aria-hidden': 'true' }),
      h('div', { class: 'start-hero-side' }, rise(doorList(), 2)),
    ),
  );

  const appts = h(
    'section',
    { class: 'start-band start-appts', 'aria-labelledby': 'start-appts-title' },
    h(
      'div',
      { class: 'start-inner' },
      h(
        'div',
        { class: 'start-appts-text' },
        rise(h('h2', { id: 'start-appts-title' }, 'Jede Familie hat ihren Termin'), 0),
        rise(h('p', { class: 'start-statement' }, 'Sind alle Namen gesetzt, entsteht für jede Familie eine Terminbestätigung zum Mitgeben und für Sie eine Übersicht.'), 1),
        rise(h('p', { class: 'start-appts-note' }, '„Termine festlegen, speichern und drucken“ heißt der Knopf am Ende der Tagesansicht.'), 2),
      ),
      h(
        'div',
        { class: 'start-appts-body' },
        rise(
          h(
            'figure',
            { class: 'start-appts-pdf' },
            h('img', { src: 'img/start/bestaetigung.webp', width: '1000', height: '1036', alt: 'Terminbestätigung als PDF: „Ihr Gesprächstermin zum Elternsprechtag“ mit Kind, Datum, Uhrzeit, Ort und Lehrkraft im gelben Kasten', loading: 'lazy', decoding: 'async' }),
            h('figcaption', {}, 'Die Terminbestätigung als PDF, mit Beispieldaten'),
          ),
          0,
        ),
        h(
          'div',
          { class: 'start-appts-plates', 'data-ui': '' },
          h('p', { class: 'start-appts-label' }, h('span', { class: 'start-sample' }, 'Beispiel'), ' Termine der Klasse 5a am Donnerstag'),
          h('ul', { class: 'start-appts-list', 'aria-label': 'Termine mit Beispieldaten' }, APPOINTMENTS.map(appointmentPlate)),
        ),
      ),
    ),
  );

  const route = carousel(withMailbox);
  const routeSection = h('section', { class: 'start-band start-route-band', 'aria-labelledby': 'start-route-title' }, h('div', { class: 'start-inner' }, route.el));

  const letter = letterStory(withMailbox);
  const letterSection = h(
    'section',
    { class: 'start-band start-letter', 'aria-labelledby': 'start-letter-title' },
    h(
      'div',
      { class: 'start-inner start-letter-grid' },
      h('div', { class: 'start-letter-pin' }, rise(letter.figure, 0)),
      h(
        'div',
        { class: 'start-letter-text' },
        rise(h('h2', { id: 'start-letter-title' }, 'Für Eltern genügt der Brief'), 0),
        rise(h('p', { class: 'start-statement' }, 'Kein Konto und keine App: Eltern brauchen den Elternbrief und ein Handy.'), 1),
        letter.list,
      ),
    ),
  );

  const faq = h(
    'section',
    { class: 'start-band start-faq', 'aria-labelledby': 'start-faq-title' },
    h('div', { class: 'start-inner start-faq-col' }, rise(h('h2', { id: 'start-faq-title', class: 'start-giant' }, 'Fragen'), 0), h('div', { class: 'start-q-list' }, questions(withMailbox))),
  );

  const close = h(
    'section',
    { class: 'start-band start-close', 'aria-labelledby': 'start-close-title' },
    h(
      'div',
      { class: 'start-inner start-close-grid' },
      rise(h('p', { class: 'start-close-name', id: 'start-close-title' }, 'ParentsDay'), 0),
      rise(h('p', { class: 'start-close-line' }, 'Für den nächsten Elternsprechtag.'), 1),
      rise(h('div', { class: 'start-signs start-signs-close' }, sign('#/lehrkraft', 'Zugang für Lehrkräfte', 'teacher'), sign('#/eltern', 'Zugang für Eltern', 'parent')), 2),
      photoCredit(),
    ),
  );

  mount(root, hero, appts, routeSection, letterSection, faq, close);

  // Erscheinen beim Scrollen: nur mit Bewegung erlaubt und nur, wenn der Beobachter verfügbar ist. Was beim Laden
  // schon zu sehen ist, erscheint sofort; Inhalte ohne Skript gibt es auf dieser Seite nicht.
  const sections = [hero, appts, routeSection, letterSection, faq, close];
  let io = null;
  if ('IntersectionObserver' in window && matchMedia('(prefers-reduced-motion: no-preference)').matches) {
    root.classList.add('start-motion');
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.05 },
    );
    requestAnimationFrame(() => {
      hero.classList.add('is-in');
      sections.slice(1).forEach((s) => io.observe(s));
    });
  }
  const onResize = () => route.update();
  window.addEventListener('resize', onResize);

  return () => {
    io?.disconnect();
    letter.cleanup();
    route.cleanup();
    window.removeEventListener('resize', onResize);
  };
}
