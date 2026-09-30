// Monatskalender mit Mehrfachauswahl von Tagen (z. B. die Tage des Elternsprechtags).
// Bedienung: Klick, Leertaste oder Eingabetaste schaltet einen Tag um. Pfeiltasten wechseln den Tag,
// Bild auf/ab den Monat, Pos1/Ende springen zum Wochenanfang/-ende. Die Woche beginnt am Montag.
// Tage vor heute sind gesperrt – außer sie sind bereits ausgewählt (dann können sie abgewählt werden).

import { h, mount } from '../core/ui.js';
import { MONTHS, parseIsoDate, toIsoDate, todayIso, formatDateLong } from '../core/time.js';

const WEEK_HEAD = [
  ['Mo', 'Montag'],
  ['Di', 'Dienstag'],
  ['Mi', 'Mittwoch'],
  ['Do', 'Donnerstag'],
  ['Fr', 'Freitag'],
  ['Sa', 'Samstag'],
  ['So', 'Sonntag'],
];

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

const monthOf = (iso) => iso.slice(0, 7);

function addDays(iso, n) {
  const d = parseIsoDate(iso);
  d.setDate(d.getDate() + n);
  return toIsoDate(d);
}

function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  return toIsoDate(new Date(y, m - 1 + n, 1)).slice(0, 7);
}

function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** Wochentag mit Montag = 0 … Sonntag = 6. */
function mondayIndex(iso) {
  return (parseIsoDate(iso).getDay() + 6) % 7;
}

/** Gleicher Tag im Nachbarmonat (am Monatsende gekürzt, z. B. 31.01. → 28.02.). */
function shiftMonthKeepDay(iso, n) {
  const ym = addMonths(monthOf(iso), n);
  const day = Math.min(Number(iso.slice(8, 10)), daysInMonth(ym));
  return `${ym}-${String(day).padStart(2, '0')}`;
}

function monthTitle(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

let instanceCount = 0;

/**
 * Monatskalender mit Mehrfachauswahl von Tagen.
 * @param {{selected?: string[], onChange: (dates: string[]) => void, month?: string, testId?: string}} opts
 *   month: 'JJJJ-MM' (Startmonat; sonst Monat des ersten ausgewählten Tages bzw. aktueller Monat)
 *   testId: Präfix der data-testid-Werte (Standard 'event-calendar', Knöpfe '-prev'/'-next')
 * @returns {HTMLElement & {setSelected: (dates: string[]) => void, getSelected: () => string[], showMonth: (month: string) => void}}
 */
export function createCalendarPicker({ selected = [], onChange, month, testId = 'event-calendar' } = {}) {
  const uid = `calp-${++instanceCount}`;
  const today = todayIso();
  let chosen = new Set((selected || []).filter((d) => ISO_RE.test(d)));
  const sortedChosen = () => [...chosen].sort();

  let view = MONTH_RE.test(month || '') ? month : monthOf(sortedChosen()[0] || today);
  let focusDate = null;

  /** Frühester Monat, zu dem geblättert werden kann: aktueller Monat bzw. Monat eines früheren gewählten Tages. */
  const minMonth = () => {
    const first = sortedChosen()[0];
    const current = monthOf(today);
    return first && monthOf(first) < current ? monthOf(first) : current;
  };
  const isDisabled = (iso) => iso < today && !chosen.has(iso);

  const title = h('div', { class: 'calp-title', id: `${uid}-title`, 'aria-live': 'polite' });
  const prev = h(
    'button',
    { type: 'button', class: 'calp-nav', 'data-testid': `${testId}-prev`, onclick: () => stepMonth(-1) },
    h('span', { 'aria-hidden': 'true' }, '‹'),
  );
  const next = h(
    'button',
    { type: 'button', class: 'calp-nav', 'data-testid': `${testId}-next`, onclick: () => stepMonth(1) },
    h('span', { 'aria-hidden': 'true' }, '›'),
  );
  const body = h('tbody', {});
  const hint = h(
    'p',
    { class: 'visually-hidden', id: `${uid}-hint` },
    'Mit den Pfeiltasten wechseln Sie zwischen den Tagen, mit Bild auf und Bild ab zwischen den Monaten. Mit Leertaste oder Eingabetaste wählen Sie einen Tag aus oder ab.',
  );
  const table = h(
    'table',
    { class: 'calp-grid', 'aria-labelledby': `${uid}-title`, 'aria-describedby': `${uid}-hint` },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        WEEK_HEAD.map(([short, long], i) => h('th', { scope: 'col', abbr: long, class: i >= 5 ? 'calp-weekend' : null }, h('span', { 'aria-hidden': 'true' }, short), h('span', { class: 'visually-hidden' }, long))),
      ),
    ),
    body,
  );
  const legend = h(
    'div',
    { class: 'legend calp-legend', 'aria-hidden': 'true' },
    h('span', {}, h('span', { class: 'legend-swatch calp-swatch-selected' }), 'ausgewählt'),
    h('span', {}, h('span', { class: 'legend-swatch calp-swatch-today' }), 'heute'),
    h('span', {}, h('span', { class: 'legend-swatch calp-swatch-weekend' }), 'Wochenende'),
  );

  const el = h('div', { class: 'calp', 'data-testid': testId }, h('div', { class: 'calp-head' }, prev, title, next), table, hint, legend);

  /** Tag, der per Tab erreichbar ist (Roving Tabindex). */
  function pickFocus() {
    const inView = sortedChosen().find((d) => monthOf(d) === view);
    if (inView) return inView;
    if (monthOf(today) === view) return today;
    return `${view}-01`;
  }

  function dayButton(iso) {
    const weekend = mondayIndex(iso) >= 5;
    return h(
      'button',
      {
        type: 'button',
        class: `calp-day${weekend ? ' calp-weekend' : ''}${iso === today ? ' calp-today' : ''}`,
        'data-date': iso,
        'aria-current': iso === today ? 'date' : null,
      },
      String(Number(iso.slice(8, 10))),
    );
  }

  function renderMonth() {
    title.textContent = monthTitle(view);
    if (!focusDate || monthOf(focusDate) !== view) focusDate = pickFocus();
    const count = daysInMonth(view);
    const lead = mondayIndex(`${view}-01`);
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(h('td', { class: 'calp-empty' }));
    for (let d = 1; d <= count; d++) cells.push(h('td', {}, dayButton(`${view}-${String(d).padStart(2, '0')}`)));
    while (cells.length % 7) cells.push(h('td', { class: 'calp-empty' }));
    const rows = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(h('tr', {}, cells.slice(i, i + 7)));
    mount(body, rows);
    syncButtons();
  }

  /** Aktualisiert Auswahl, Sperren und Tab-Reihenfolge, ohne die Knöpfe neu zu erzeugen (Fokus bleibt erhalten). */
  function syncButtons() {
    for (const btn of body.querySelectorAll('button[data-date]')) {
      const iso = btn.dataset.date;
      const pressed = chosen.has(iso);
      const disabled = isDisabled(iso);
      btn.setAttribute('aria-pressed', String(pressed));
      if (disabled) btn.setAttribute('aria-disabled', 'true');
      else btn.removeAttribute('aria-disabled');
      btn.tabIndex = iso === focusDate ? 0 : -1;
      const extra = [iso === today ? 'heute' : '', disabled ? 'liegt in der Vergangenheit, nicht wählbar' : ''].filter(Boolean).join(', ');
      btn.setAttribute('aria-label', `${formatDateLong(iso)}${extra ? ` (${extra})` : ''}`);
      btn.title = disabled ? 'Dieser Tag liegt in der Vergangenheit.' : '';
    }
    const all = sortedChosen();
    const before = all.filter((d) => monthOf(d) < view).length;
    const after = all.filter((d) => monthOf(d) > view).length;
    prev.disabled = view <= minMonth();
    prev.classList.toggle('calp-nav-has', before > 0);
    next.classList.toggle('calp-nav-has', after > 0);
    prev.setAttribute('aria-label', `Vorheriger Monat${before ? ` (dort ${before === 1 ? 'ist 1 Tag' : `sind ${before} Tage`} ausgewählt)` : ''}`);
    next.setAttribute('aria-label', `Nächster Monat${after ? ` (dort ${after === 1 ? 'ist 1 Tag' : `sind ${after} Tage`} ausgewählt)` : ''}`);
  }

  function showMonth(ym) {
    if (!MONTH_RE.test(ym || '')) return;
    view = ym < minMonth() ? minMonth() : ym;
    renderMonth();
  }

  function stepMonth(n) {
    const target = addMonths(view, n);
    if (target < minMonth()) return;
    const prevHadFocus = document.activeElement === prev;
    view = target;
    renderMonth();
    // Ist der Zurück-Knopf jetzt gesperrt, den Fokus nicht verlieren.
    if (prevHadFocus && prev.disabled) next.focus();
  }

  function toggle(iso) {
    if (isDisabled(iso)) return;
    if (chosen.has(iso)) chosen.delete(iso);
    else chosen.add(iso);
    focusDate = iso;
    syncButtons();
    onChange?.(sortedChosen());
  }

  function focusDay(iso) {
    if (monthOf(iso) < minMonth()) return;
    focusDate = iso;
    if (monthOf(iso) !== view) {
      view = monthOf(iso);
      renderMonth();
    } else {
      syncButtons();
    }
    body.querySelector(`button[data-date="${iso}"]`)?.focus();
  }

  body.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-date]');
    // Doppelklick (e.detail 2, 3 …) nicht als zweites Umschalten werten – sonst wäre der Tag gleich wieder abgewählt.
    // Tastatur-Klicks haben e.detail 0.
    if (btn && e.detail <= 1) toggle(btn.dataset.date);
  });

  body.addEventListener('keydown', (e) => {
    const btn = e.target.closest('button[data-date]');
    if (!btn || e.altKey || e.ctrlKey || e.metaKey) return;
    const iso = btn.dataset.date;
    const moves = {
      ArrowLeft: () => addDays(iso, -1),
      ArrowRight: () => addDays(iso, 1),
      ArrowUp: () => addDays(iso, -7),
      ArrowDown: () => addDays(iso, 7),
      Home: () => addDays(iso, -mondayIndex(iso)),
      End: () => addDays(iso, 6 - mondayIndex(iso)),
      PageUp: () => shiftMonthKeepDay(iso, -1),
      PageDown: () => shiftMonthKeepDay(iso, 1),
    };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault();
    focusDay(move());
  });

  /** Setzt die Auswahl von außen (ohne onChange auszulösen). */
  el.setSelected = (dates) => {
    chosen = new Set((dates || []).filter((d) => ISO_RE.test(d)));
    if (view < minMonth()) showMonth(minMonth());
    else syncButtons();
  };
  el.getSelected = () => sortedChosen();
  el.showMonth = showMonth;
  /** Setzt den Fokus auf den per Tab erreichbaren Tag. */
  el.focusDay = () => body.querySelector('button[tabindex="0"]')?.focus();

  renderMonth();
  return el;
}
