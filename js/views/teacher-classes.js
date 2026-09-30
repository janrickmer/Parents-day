// Klassenübersicht (#/lehrkraft/klassen): Zusammenfassung des Elternsprechtags, neue Klasse anlegen
// (Jahrgangsstufe 1–13, Buchstabe a–h), Klassen als Kacheln und gesammelter Upload der Rückmeldungen.

import { h, mount, toast, alertBox, plural } from '../core/ui.js';
import { updateState, getCurrentState, findClass } from '../core/storage.js';
import { classId as makeClassId } from '../core/codes.js';
import { WEEKDAYS_SHORT, parseIsoDate, formatDate, formatRange } from '../core/time.js';
import { createResponseImporter } from '../components/response-import.js';

const GRADES = Array.from({ length: 13 }, (_, i) => i + 1);
const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const DOUBLE_CLICK_MS = 700;

// ---------- Hilfen ----------

/** "2026-11-12" + Zeiten → "Do, 12.11.2026, 14:00–18:00 Uhr" */
function formatEventDay(day) {
  return `${WEEKDAYS_SHORT[parseIsoDate(day.date).getDay()]}, ${formatDate(day.date)}, ${formatRange(day.start, day.end)}`;
}

/** Mehrzeilige Adresse → eine Zeile. */
function shortAddress(address) {
  return String(address || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(', ');
}

function hasName(student) {
  return Boolean(String(student.lastName || '').trim() || String(student.firstName || '').trim());
}

/** Kennzahlen einer Klasse für Kachel und Kopf. */
function classStats(cls) {
  const students = cls.students.filter((s) => hasName(s) || s.code || s.response || s.appointment);
  return {
    students: students.length,
    withCode: students.filter((s) => s.code).length,
    responses: students.filter((s) => s.response).length,
    appointments: students.filter((s) => s.appointment).length,
  };
}

function learners(count) {
  return plural(count, 'Lernende(r)', 'Lernende');
}

// ---------- View ----------

export default function render(ctx) {
  const { root, navigate, setTitle } = ctx;
  let state = ctx.state;
  let lastCreatedAt = 0;
  if (!state.event) {
    navigate('/lehrkraft/elternsprechtag', { replace: true });
    return;
  }
  setTitle('Klassen');

  // --- Kopf mit Zusammenfassung des Elternsprechtags ---
  const ev = state.event;
  const header = h(
    'div',
    { class: 'page-header tcl-header' },
    h(
      'div',
      {},
      h('h1', {}, 'Klassen'),
      h('p', { class: 'subtitle' }, 'Legen Sie Ihre Klassen an. Mit einem Klick auf eine Kachel öffnen Sie die Klasse und tragen die Lernenden ein.'),
    ),
  );
  const eventInfo = h(
    'section',
    { class: 'card tcl-event', 'aria-labelledby': 'tcl-event-title' },
    h(
      'div',
      { class: 'tcl-event-head' },
      h('h2', { id: 'tcl-event-title', class: 'tcl-event-title' }, 'Ihr Elternsprechtag'),
      h('a', { class: 'btn btn-small btn-secondary', href: '#/lehrkraft/einstellungen' }, 'Weitere Einstellungen'),
    ),
    h(
      'dl',
      { class: 'tcl-facts' },
      h('div', { class: 'tcl-fact tcl-fact-days' }, h('dt', {}, ev.days.length === 1 ? 'Tag' : 'Tage'), h('dd', {}, h('ul', { class: 'tcl-days' }, ev.days.map((d) => h('li', {}, formatEventDay(d)))))),
      h('div', { class: 'tcl-fact' }, h('dt', {}, 'Terminlänge'), h('dd', {}, `${ev.slotMinutes} Minuten`)),
      shortAddress(ev.schoolAddress) ? h('div', { class: 'tcl-fact' }, h('dt', {}, 'Ort'), h('dd', {}, shortAddress(ev.schoolAddress))) : null,
    ),
  );

  // --- Neue Klasse anlegen ---
  const gradeSelect = h(
    'select',
    { id: 'tcl-grade', 'data-testid': 'class-grade', onchange: clearCreateError },
    h('option', { value: '' }, 'Jahrgangsstufe wählen'),
    GRADES.map((g) => h('option', { value: String(g) }, String(g))),
  );
  const letterSelect = h(
    'select',
    { id: 'tcl-letter', 'data-testid': 'class-letter', onchange: clearCreateError },
    h('option', { value: '' }, 'Buchstabe wählen'),
    LETTERS.map((l) => h('option', { value: l }, l)),
  );
  const createMsg = h('div', { class: 'tcl-create-msg', 'aria-live': 'polite' });
  const createForm = h(
    'form',
    { class: 'tcl-create-form', novalidate: true, onsubmit: onCreate },
    h('div', { class: 'field' }, h('label', { for: 'tcl-grade' }, 'Jahrgangsstufe'), gradeSelect),
    h('div', { class: 'field' }, h('label', { for: 'tcl-letter' }, 'Buchstabe'), letterSelect),
    h('button', { type: 'submit', class: 'btn btn-primary tcl-create-btn', 'data-testid': 'class-create' }, 'Klasse anlegen'),
  );
  const createCard = h(
    'section',
    { class: 'card tcl-create', 'aria-labelledby': 'tcl-create-title' },
    h('h2', { id: 'tcl-create-title' }, 'Neue Klasse anlegen'),
    h('p', { class: 'muted' }, 'Wählen Sie die Jahrgangsstufe und den Buchstaben der Klasse aus.'),
    createForm,
    createMsg,
  );

  // --- Kacheln ---
  const classesTitle = h('h2', { id: 'tcl-classes-title', class: 'tcl-classes-title' }, 'Ihre Klassen');
  const tilesHost = h('div', { class: 'tcl-tiles-host' });
  const classesSection = h('section', { class: 'tcl-classes', 'aria-labelledby': 'tcl-classes-title' }, classesTitle, tilesHost);

  // --- Rückmeldungen hochladen ---
  const importHost = h('div', {});
  const importCard = h(
    'section',
    { class: 'card tcl-import', 'aria-labelledby': 'tcl-import-title' },
    h('h2', { id: 'tcl-import-title' }, 'Rückmeldungen der Eltern hochladen'),
    h(
      'p',
      { class: 'muted' },
      'Laden Sie hier alle Rückmelde-PDFs der Eltern auf einmal hoch – egal aus welcher Klasse. ParentsDay erkennt am Code des Kindes automatisch, zu welcher Klasse eine Rückmeldung gehört.',
    ),
    importHost,
  );
  try {
    importHost.appendChild(createResponseImporter({ onImported: () => refresh() }));
  } catch (err) {
    console.warn(err);
    importHost.appendChild(alertBox('warning', 'Der Upload der Rückmeldungen ist im Moment nicht verfügbar. Bitte laden Sie die Seite später neu.'));
  }

  mount(root, h('div', { class: 'tcl-page' }, header, h('div', { class: 'tcl-top' }, createCard, eventInfo), classesSection, importCard));
  renderTiles();

  // ---------- Verhalten ----------

  function clearCreateError() {
    gradeSelect.removeAttribute('aria-invalid');
    letterSelect.removeAttribute('aria-invalid');
    mount(createMsg);
  }

  function showCreateError(message, invalid = []) {
    for (const [key, el] of [['grade', gradeSelect], ['letter', letterSelect]]) {
      if (invalid.includes(key)) el.setAttribute('aria-invalid', 'true');
      else el.removeAttribute('aria-invalid');
    }
    mount(createMsg, alertBox('error', message));
  }

  function onCreate(e) {
    e.preventDefault();
    // Doppelklick: Der zweite Klick fände den zurückgesetzten Buchstaben und würde die Erfolgsmeldung
    // durch „Bitte wählen Sie einen Buchstaben aus.“ ersetzen.
    if (!letterSelect.value && Date.now() - lastCreatedAt < DOUBLE_CLICK_MS) return;
    const grade = gradeSelect.value;
    const letter = letterSelect.value;
    if (!grade && !letter) return showCreateError('Bitte wählen Sie eine Jahrgangsstufe und einen Buchstaben aus.', ['grade', 'letter']);
    if (!grade) return showCreateError('Bitte wählen Sie eine Jahrgangsstufe aus.', ['grade']);
    if (!letter) return showCreateError('Bitte wählen Sie einen Buchstaben aus.', ['letter']);
    const id = makeClassId(grade, letter);
    if (findClass(getCurrentState(), id)) {
      return showCreateError(`Die Klasse ${id} gibt es bereits.`, ['grade', 'letter']);
    }
    try {
      state = updateState((s) => {
        s.classes.push({ id, grade: Number(grade), letter, codesGenerated: false, students: [] });
      });
    } catch (err) {
      return showCreateError(`Die Klasse konnte nicht angelegt werden: ${err.message}`);
    }
    lastCreatedAt = Date.now();
    letterSelect.value = '';
    mount(createMsg, alertBox('success', `Die Klasse ${id} wurde angelegt. Öffnen Sie die Kachel, um die Lernenden einzutragen.`));
    toast(`Klasse ${id} angelegt.`, 'success');
    renderTiles(id);
  }

  /** Zustand neu lesen und Kacheln neu zeichnen (z. B. nach dem Upload von Rückmeldungen). */
  function refresh() {
    state = getCurrentState() || state;
    renderTiles();
  }

  function renderTiles(newId = '') {
    const classes = state.classes || [];
    classesTitle.textContent = classes.length ? `Ihre Klassen (${classes.length})` : 'Ihre Klassen';
    if (!classes.length) {
      mount(
        tilesHost,
        h(
          'div',
          { class: 'empty-state tcl-empty' },
          h('strong', {}, 'Noch keine Klassen angelegt.'),
          h('p', {}, 'Wählen Sie oben Jahrgangsstufe und Buchstaben aus und klicken Sie auf „Klasse anlegen“.'),
        ),
      );
    } else {
      mount(tilesHost, h('div', { class: 'tiles tcl-tiles' }, classes.map((cls) => tile(cls, cls.id === newId))));
    }
    // Upload erst anbieten, wenn es Codes (und damit mögliche Rückmeldungen) gibt.
    importCard.hidden = !classes.some((c) => c.codesGenerated || c.students.some((s) => s.code || s.response));
  }

  function tile(cls, isNew) {
    const st = classStats(cls);
    const ready = cls.codesGenerated && st.students > 0;
    const badges = [];
    if (ready || st.responses > 0) {
      badges.push(
        h(
          'span',
          { class: `badge ${st.responses >= st.students && st.students > 0 ? 'badge-success' : 'badge-info'}` },
          `${st.responses} von ${plural(st.students, 'Rückmeldung', 'Rückmeldungen')}`,
        ),
      );
      badges.push(h('span', { class: `badge ${st.appointments > 0 ? 'badge-info' : ''}` }, st.appointments > 0 ? plural(st.appointments, 'Termin', 'Termine') : 'Noch keine Termine'));
    }
    return h(
      'a',
      {
        class: `tile tcl-tile${ready ? ' tcl-tile-ready' : ''}${isNew ? ' tcl-tile-new' : ''}`,
        href: `#/lehrkraft/klasse/${cls.id}`,
        'data-testid': `class-tile-${cls.id}`,
      },
      h('span', { class: 'tcl-tile-label' }, 'Klasse'),
      h('span', { class: 'tcl-tile-name' }, cls.id),
      h('span', { class: 'tcl-tile-count' }, st.students ? learners(st.students) : 'Noch keine Lernenden'),
      badges.length ? h('span', { class: 'tcl-tile-badges' }, badges) : null,
      h(
        'span',
        { class: `tcl-tile-status ${ready ? 'tcl-status-ready' : 'tcl-status-todo'}` },
        ready ? 'Codes erzeugt' : st.withCode > 0 ? 'Codes neu erzeugen' : 'Lernende eintragen',
      ),
    );
  }
}
