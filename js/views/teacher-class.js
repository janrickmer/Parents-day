// Klassenansicht (#/lehrkraft/klasse/<id>): Tabelle der Lernenden (Nr., Nachname, Vorname, Code,
// Verfügbarkeit der Eltern), Codes erzeugen, Elternschreiben als PDF, Rückmeldungen hochladen,
// „Gespräche terminieren“ und „Klasse löschen“.
//
// Eingaben werden sofort (verzögert um SAVE_DELAY bzw. beim Verlassen des Feldes) gespeichert,
// ohne die Tabelle neu aufzubauen – der Fokus bleibt also beim Tippen erhalten.
// Komplett leere Zeilen existieren nur auf der Seite und werden nicht gespeichert.

import { h, mount, toast, confirmDialog, alertBox, plural } from '../core/ui.js';
import { updateState, getCurrentState, findClass, newId } from '../core/storage.js';
import { cleanName, hasCodeLetters, studentCode, studentNameCode, transliterate } from '../core/codes.js';
import { WEEKDAYS_SHORT, parseIsoDate, formatRanges, formatRange, formatTimestamp, toMinutes, fromMinutes } from '../core/time.js';
import { savePdf, preloadPdf } from '../core/pdf.js';
import { createResponseImporter } from '../components/response-import.js';

const SAVE_DELAY = 300;
const MAX_NAME = 80;
// Schutz vor Doppelklicks: zweiter Klick innerhalb dieser Zeit wird ignoriert
const DOUBLE_CLICK_MS = 700;
const LABEL_ENTER = 'Alle Lernenden erfolgreich eingetragen';
const LABEL_LETTERS = 'Elternschreiben für diese Klasse erstellen';

// ---------- Hilfen ----------

function blankRow() {
  return { id: newId(), lastName: '', firstName: '', code: '', response: null, appointment: null };
}

function rowsFromClass(cls) {
  const rows = cls.students.map((s) => ({
    id: s.id,
    lastName: s.lastName || '',
    firstName: s.firstName || '',
    code: s.code || '',
    response: s.response || null,
    appointment: s.appointment || null,
  }));
  return rows.length ? rows : [blankRow()];
}

function isBlank(row) {
  return !cleanName(row.lastName) && !cleanName(row.firstName);
}

/** Zeilen, die gespeichert werden (alles außer komplett leeren Zeilen ohne weitere Daten). */
function keepRow(row) {
  return !isBlank(row) || Boolean(row.code || row.response || row.appointment);
}

function learners(count) {
  return plural(count, 'Lernende(r)', 'Lernende');
}

function displayName(row) {
  return [cleanName(row.firstName), cleanName(row.lastName)].filter(Boolean).join(' ') || 'diese Zeile';
}

/** "2026-11-12" → "Do, 12.11." */
function shortDay(iso) {
  const [, m, d] = String(iso).split('-');
  return `${WEEKDAYS_SHORT[parseIsoDate(iso).getDay()]}, ${d}.${m}.`;
}

/** Tage für die Verfügbarkeits-Spalte: alle Tage des Elternsprechtags plus ggf. weitere Tage aus der Rückmeldung. */
function availabilityDays(event, availability = {}) {
  const dates = new Set((event?.days || []).map((d) => d.date));
  for (const [date, ranges] of Object.entries(availability || {})) if (ranges?.length) dates.add(date);
  return [...dates].sort().map((date) => [date, [...(availability?.[date] || [])].sort((a, b) => toMinutes(a[0]) - toMinutes(b[0]))]);
}

/**
 * Spalten einer Kopfzeile („Nachname | Vorname“, „Nr. | Vorname | Nachname“ …).
 * @returns {null | {last:number, first:number, count:number}} null, wenn die Zeile keine Kopfzeile ist; -1 = Spalte fehlt
 */
function headerColumns(parts) {
  if (!parts.some((p) => /^(nach|vor|familien|ruf)?name$/i.test(p))) return null;
  return {
    last: parts.findIndex((p) => /^(nach|familien)name$/i.test(p)),
    first: parts.findIndex((p) => /^(vor|ruf)name$/i.test(p)),
    count: parts.length,
  };
}

/**
 * Zerlegt eingefügten Text (z. B. aus Excel) in Namen.
 * Zeilen „Nachname<TAB>Vorname“, „Nachname; Vorname“ oder „Nachname, Vorname“; eine einzelne Spalte
 * landet im Feld, in das eingefügt wurde. Eine führende Nummern-Spalte wird übersprungen. Nennt eine
 * Kopfzeile beide Spalten (z. B. „Vorname | Nachname“), gilt deren Reihenfolge.
 * @returns {Array<{lastName?:string, firstName?:string}>}
 */
function parsePastedNames(text, field) {
  const result = [];
  let columns = null;
  const lines = String(text).split(/\r\n|\r|\n/).filter((line) => line.trim() !== '');
  const clip = (value) => cleanName(value).slice(0, MAX_NAME).trim();
  lines.forEach((line, i) => {
    const sep = line.includes('\t') ? '\t' : line.includes(';') ? ';' : line.includes(',') ? ',' : null;
    let parts = (sep ? line.split(sep) : [line]).map((p) => cleanName(p).replace(/^"(.*)"$/, '$1').trim());
    if (i === 0) {
      const head = headerColumns(parts);
      if (head) {
        if (head.last >= 0 && head.first >= 0) columns = head;
        return;
      }
    }
    if (!parts.some(Boolean)) return;
    const numbered = /^\d+\.?$/.test(parts[0]);
    if (columns) {
      // Nummern-Spalte ohne eigene Überschrift („Nachname | Vorname“ über „1 | Beck | Anna“)
      if (numbered && parts.length > columns.count) parts = parts.slice(1);
      result.push({ lastName: clip(parts[columns.last] ?? ''), firstName: clip(parts[columns.first] ?? '') });
      return;
    }
    if (parts.length >= 3 && numbered) parts = parts.slice(1);
    if (parts.length >= 2) result.push({ lastName: clip(parts[0]), firstName: clip(parts[1]) });
    else result.push({ [field]: clip(parts[0]) });
  });
  return result;
}

// ---------- View ----------

export default function render(ctx) {
  const { root, params, navigate, setTitle } = ctx;
  const classId = params.classId;
  let state = getCurrentState() || ctx.state;
  if (!state.event) {
    navigate('/lehrkraft/elternsprechtag', { replace: true });
    return;
  }
  setTitle(`Klasse ${classId}`);
  const initial = findClass(state, classId);
  if (!initial) {
    mount(
      root,
      h(
        'div',
        { class: 'tc-page' },
        h('a', { class: 'back-link', href: '#/lehrkraft/klassen' }, 'Alle Klassen'),
        h(
          'div',
          { class: 'card card-narrow stack' },
          h('h1', {}, `Klasse ${classId} nicht gefunden`),
          alertBox('warning', 'Diese Klasse gibt es in Ihren Daten nicht. Vielleicht wurde sie gelöscht oder ein anderer Zwischenstand geladen.'),
          h('div', {}, h('a', { class: 'btn btn-primary', href: '#/lehrkraft/klassen' }, 'Zur Klassenübersicht')),
        ),
      ),
    );
    return;
  }

  const { grade, letter } = initial;
  let rows = rowsFromClass(initial);
  let saveTimer = null;
  let busy = false;
  let deleted = false;
  let showAvail = false;
  let feedbackKind = '';
  let lastDeleteAt = 0;
  let codesCreatedAt = 0;
  const refs = new Map(); // Zeilen-ID → { tr, last, first, codeCell, availCell, del }

  const expectedCode = (row) => studentCode(grade, letter, state.teacher.teacherCode, row.firstName, row.lastName);
  const codeMatches = (row) => Boolean(row.code) && row.code === expectedCode(row);
  /**
   * Hält den Code einer Zeile passend zu ihrem Namen: geänderter Name → Code leeren (merken),
   * Name wieder wie vorher → gemerkten Code zurückholen. Gibt true zurück, wenn sich der Code geändert hat.
   */
  const syncCode = (row) => {
    if (row.code && !codeMatches(row)) {
      row.prevCode = row.code;
      row.code = '';
      return true;
    }
    if (!row.code && row.prevCode && row.prevCode === expectedCode(row)) {
      row.code = row.prevCode;
      row.prevCode = '';
      return true;
    }
    return false;
  };
  const rowById = (id) => rows.find((r) => r.id === id);
  const rowIndex = (id) => rows.findIndex((r) => r.id === id);
  /** Zustand B („Elternschreiben erstellen“): jede Zeile mit Namen hat einen passenden Code. */
  const isReady = () => {
    const named = rows.filter(keepRow);
    return named.length > 0 && named.every(codeMatches);
  };

  // --- Kopf ---
  const subtitle = h('p', { class: 'subtitle tc-subtitle' });
  const scheduleBtn = h(
    'button',
    { type: 'button', class: 'btn btn-primary', 'data-testid': 'schedule-link', 'aria-describedby': 'tc-schedule-hint', onclick: () => navigate(`/lehrkraft/klasse/${classId}/terminieren`) },
    'Gespräche terminieren',
  );
  const scheduleHint = h('p', { id: 'tc-schedule-hint', class: 'tc-schedule-hint small muted' }, 'Das Terminieren ist möglich, sobald für alle Lernenden Codes erzeugt sind.');
  const deleteBtn = h('button', { type: 'button', class: 'btn btn-ghost tc-btn-danger', 'data-testid': 'delete-class', onclick: onDeleteClass }, 'Klasse löschen');
  const header = h(
    'div',
    { class: 'page-header tc-header' },
    h('div', {}, h('h1', {}, `Klasse ${classId}`), subtitle),
    h('div', { class: 'tc-header-actions' }, deleteBtn, h('div', { class: 'tc-schedule' }, scheduleBtn, scheduleHint)),
  );

  // --- Tabelle der Lernenden ---
  const intro = h('p', { class: 'tc-intro' });
  const thead = h('thead', {});
  const tbody = h('tbody', {});
  const table = h('table', { class: 'table tc-table' }, h('caption', { class: 'visually-hidden' }, `Lernende der Klasse ${classId}`), thead, tbody);
  const addBtn = h('button', { type: 'button', class: 'btn btn-secondary tc-add', 'data-testid': 'add-student', onclick: () => addRow() }, h('span', { 'aria-hidden': 'true', class: 'tc-add-plus' }, '+'), 'Weitere Lernende hinzufügen');
  const feedback = h('div', { class: 'tc-feedback', 'aria-live': 'polite' });
  const primaryBtn = h('button', { type: 'button', class: 'btn btn-primary btn-large tc-primary-btn', 'data-testid': 'primary-action', onclick: onPrimary }, LABEL_ENTER);
  const primaryHint = h('p', { class: 'tc-primary-hint small muted' });
  const studentsCard = h(
    'section',
    { class: 'card tc-students', 'aria-labelledby': 'tc-students-title' },
    h('h2', { id: 'tc-students-title' }, 'Lernende'),
    intro,
    h('div', { class: 'table-wrap tc-table-wrap' }, table),
    h('div', { class: 'tc-below' }, addBtn),
    feedback,
    h('div', { class: 'tc-primary' }, primaryBtn, primaryHint),
  );

  // --- Rückmeldungen der Eltern ---
  const respCount = h('p', { class: 'tc-resp-count' });
  const respBar = h('div', { class: 'tc-resp-bar', 'aria-hidden': 'true' }, h('span', { class: 'tc-resp-bar-fill' }));
  const importHost = h('div', { class: 'tc-import' });
  const respCard = h(
    'section',
    { class: 'card tc-responses', 'aria-labelledby': 'tc-resp-title', hidden: true },
    h('h2', { id: 'tc-resp-title' }, 'Rückmeldungen der Eltern'),
    h('div', { class: 'tc-resp-summary' }, respCount, respBar),
    h(
      'p',
      { class: 'muted' },
      'Die Eltern schicken Ihnen ihre Rückmeldung als PDF-Datei per E-Mail. Laden Sie die Dateien hier hoch – gerne viele auf einmal. Die Zeiten erscheinen danach in der Spalte „Verfügbarkeit der Eltern“.',
    ),
    importHost,
  );
  try {
    importHost.appendChild(createResponseImporter({ classId, onImported }));
  } catch (err) {
    console.warn(err);
    importHost.appendChild(alertBox('warning', 'Der Upload der Rückmeldungen ist im Moment nicht verfügbar. Bitte laden Sie die Seite später neu.'));
  }

  mount(root, h('div', { class: 'tc-page' }, h('a', { class: 'back-link', href: '#/lehrkraft/klassen' }, 'Alle Klassen'), header, studentsCard, respCard));
  renderTable();
  updateUi();
  // Gespeicherten Status angleichen (z. B. nach einem älteren Zwischenstand), damit „Gespräche terminieren“
  // hier und auf der Terminierungsseite dasselbe zeigt.
  if (Boolean(initial.codesGenerated) !== isReady()) persist();
  if (rows.every(isBlank)) refs.get(rows[0].id)?.last.focus({ preventScroll: true });

  const onPageHide = () => flushSave();
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flushSave();
  };
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibility);
    if (!deleted) flushSave();
  };

  // ---------- Tabelle zeichnen ----------

  function renderTable() {
    showAvail = rows.some((r) => r.code || r.response);
    refs.clear();
    table.classList.toggle('tc-with-avail', showAvail);
    mount(
      thead,
      h(
        'tr',
        {},
        h('th', { scope: 'col', class: 'tc-col-num' }, 'Nr.'),
        h('th', { scope: 'col', class: 'tc-col-name' }, 'Nachname'),
        h('th', { scope: 'col', class: 'tc-col-name' }, 'Vorname'),
        h('th', { scope: 'col', class: 'tc-col-code' }, 'Code'),
        showAvail ? h('th', { scope: 'col', class: 'tc-col-avail' }, 'Verfügbarkeit der Eltern') : null,
        h('th', { scope: 'col', class: 'tc-col-del' }, h('span', { class: 'visually-hidden' }, 'Löschen')),
      ),
    );
    mount(tbody, rows.map((r, i) => buildRow(r, i)));
  }

  function buildRow(row, index) {
    const last = nameInput(row, 'lastName', index);
    const first = nameInput(row, 'firstName', index);
    const codeCell = h('td', { class: 'tc-code', 'data-testid': 'student-code', 'data-label': 'Code' });
    const availCell = showAvail ? h('td', { class: 'tc-avail', 'data-testid': 'student-availability', 'data-label': 'Verfügbarkeit der Eltern' }) : null;
    const del = h('button', { type: 'button', class: 'btn btn-ghost btn-icon tc-del', 'aria-label': 'Zeile löschen', title: 'Zeile löschen', onclick: () => onDeleteRow(row.id) }, h('span', { 'aria-hidden': 'true' }, '×'));
    const tr = h(
      'tr',
      { 'data-testid': 'student-row', dataset: { id: row.id } },
      h('td', { class: 'tc-num' }, h('span', { class: 'tc-num-label', 'aria-hidden': 'true' }, 'Nr. '), String(index + 1)),
      h('td', { class: 'tc-name', 'data-label': 'Nachname' }, last),
      h('td', { class: 'tc-name', 'data-label': 'Vorname' }, first),
      codeCell,
      availCell,
      h('td', { class: 'tc-del-cell' }, del),
    );
    refs.set(row.id, { tr, last, first, codeCell, availCell, del });
    fillCode(row);
    return tr;
  }

  function nameInput(row, field, index) {
    const isLast = field === 'lastName';
    const input = h('input', {
      type: 'text',
      class: 'tc-input',
      value: row[field],
      autocomplete: 'off',
      autocapitalize: 'words',
      spellcheck: 'false',
      maxlength: String(MAX_NAME),
      enterkeyhint: isLast ? 'next' : 'enter',
      'aria-label': `${isLast ? 'Nachname' : 'Vorname'}, Zeile ${index + 1}`,
      'data-testid': isLast ? 'student-lastname' : 'student-firstname',
    });
    input.addEventListener('input', () => onNameInput(row.id, field, input));
    input.addEventListener('change', flushSave);
    input.addEventListener('keydown', (e) => onNameKeydown(e, row.id, field));
    input.addEventListener('paste', (e) => onPaste(e, row.id, field));
    return input;
  }

  /** Code- und Verfügbarkeits-Zelle einer Zeile aktualisieren (ohne die Zeile neu aufzubauen). */
  function fillCode(row) {
    const ref = refs.get(row.id);
    if (!ref) return;
    if (row.code) mount(ref.codeCell, h('span', { class: 'code tc-code-value' }, row.code));
    else mount(ref.codeCell, h('span', { class: 'tc-code-empty', title: `Der Code entsteht mit „${LABEL_ENTER}“.` }, '–'));
    if (ref.availCell) fillAvailability(ref.availCell, row);
  }

  function fillAvailability(cell, row) {
    const parts = [];
    if (row.response) {
      parts.push(
        h(
          'ul',
          { class: 'tc-avail-list' },
          availabilityDays(state.event, row.response.availability).map(([date, ranges]) =>
            h('li', { class: ranges.length ? '' : 'tc-avail-none' }, h('span', { class: 'tc-avail-day' }, `${shortDay(date)}:`), ' ', ranges.length ? formatRanges(ranges) : '–'),
          ),
        ),
      );
      const received = formatTimestamp(row.response.submittedAt);
      if (received) parts.push(h('div', { class: 'tc-avail-received small muted' }, `eingegangen am ${received}`));
    } else if (row.code) {
      parts.push(h('span', { class: 'badge tc-pending' }, 'Rückmeldung der Eltern ausstehend'));
    } else {
      parts.push(h('span', { class: 'tc-code-empty' }, '–'));
    }
    const appt = row.appointment;
    if (appt) {
      const end = fromMinutes(toMinutes(appt.start) + Number(appt.duration || 0));
      parts.push(h('div', { class: 'tc-avail-appt' }, h('span', { class: 'badge badge-info' }, `Termin: ${shortDay(appt.date)}, ${formatRange(appt.start, end)}`)));
    }
    mount(cell, parts);
  }

  // ---------- Anzeige außerhalb der Tabelle ----------

  function updateUi() {
    const named = rows.filter(keepRow);
    const ready = isReady();
    const anyCode = rows.some((r) => r.code);
    const responses = named.filter((r) => r.response).length;
    const appointments = named.filter((r) => r.appointment).length;
    // Teile nicht mitten im Ausdruck umbrechen („0 | Termine“)
    const parts = [learners(named.length), plural(responses, 'Rückmeldung', 'Rückmeldungen'), plural(appointments, 'Termin', 'Termine')];
    mount(subtitle, parts.map((text, i) => [i ? ' · ' : '', h('span', { class: 'nowrap' }, text)]));

    if (!busy) {
      primaryBtn.textContent = ready ? LABEL_LETTERS : LABEL_ENTER;
      primaryBtn.classList.toggle('tc-primary-letters', ready);
    }
    const changedCoded = rows.some((r) => r.prevCode && !r.code && keepRow(r));
    primaryHint.textContent = ready
      ? 'Es entsteht eine PDF-Datei mit einer DIN-A4-Seite pro Kind – zum Ausdrucken und Mitgeben.'
      : changedCoded
        ? 'Geänderte Namen erhalten einen neuen Code. Falls Sie den Elternbrief für dieses Kind schon ausgegeben haben, geben Sie bitte den neuen Brief mit – der alte Code passt dann nicht mehr.'
        : anyCode
          ? 'Für neue oder geänderte Namen wird ein neuer Code erzeugt. Unveränderte Namen behalten ihren Code.'
          : 'Danach erzeugt ParentsDay für jedes Kind einen persönlichen Code.';
    intro.textContent = ready
      ? 'Die Codes sind erzeugt. Erstellen Sie jetzt die Elternschreiben und geben Sie jedem Kind seinen Brief mit. Sobald die Eltern antworten, erscheinen ihre Zeiten in der Spalte „Verfügbarkeit der Eltern“.'
      : 'Tragen Sie Nachname und Vorname aller Lernenden ein. Tipp: Eine Namensliste können Sie direkt aus Excel & Co. kopieren (Spalten Nachname und Vorname) und in ein Namensfeld einfügen.';

    scheduleBtn.disabled = !ready;
    scheduleHint.hidden = ready;

    respCard.hidden = !(anyCode || responses > 0);
    respCount.textContent = `${responses} von ${plural(named.length, 'Rückmeldung', 'Rückmeldungen')} eingegangen`;
    respBar.firstChild.style.width = `${named.length ? Math.round((responses / named.length) * 100) : 0}%`;

    if (ready) preloadPdf().catch(() => {});
  }

  function showFeedback(node, kind = '') {
    feedbackKind = node ? kind : '';
    mount(feedback, node);
  }

  // ---------- Speichern ----------

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, SAVE_DELAY);
  }

  function flushSave() {
    if (saveTimer) persist();
  }

  /** Schreibt alle Zeilen (außer komplett leeren) in den Zustand. Rückmeldungen und Termine bleiben erhalten. */
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const keep = rows.filter(keepRow);
    const ready = isReady();
    try {
      state = updateState((s) => {
        const cls = findClass(s, classId);
        if (!cls) return;
        const previous = new Map(cls.students.map((st) => [st.id, st]));
        cls.students = keep.map((r) => {
          const prev = previous.get(r.id);
          return {
            id: r.id,
            lastName: cleanName(r.lastName),
            firstName: cleanName(r.firstName),
            code: r.code,
            response: prev ? prev.response ?? null : r.response,
            appointment: prev ? prev.appointment ?? null : r.appointment,
          };
        });
        cls.codesGenerated = ready;
      });
      return true;
    } catch (err) {
      console.error(err);
      showFeedback(alertBox('error', `Die Änderungen konnten nicht gespeichert werden: ${err.message}`), 'error');
      return false;
    }
  }

  // ---------- Eingaben ----------

  function onNameInput(id, field, input) {
    const row = rowById(id);
    if (!row) return;
    row[field] = input.value;
    input.removeAttribute('aria-invalid');
    const ref = refs.get(id);
    // Doppelter Name: beide Felder der Zeile waren markiert – eine Änderung genügt
    if (ref?.tr.dataset.dup) {
      delete ref.tr.dataset.dup;
      ref.last.removeAttribute('aria-invalid');
      ref.first.removeAttribute('aria-invalid');
    }
    if (ref && !ref.last.hasAttribute('aria-invalid') && !ref.first.hasAttribute('aria-invalid')) ref.tr.classList.remove('tc-row-error');
    // Name geändert → Code passt nicht mehr → Code leeren (Knopf springt zurück auf „eingetragen“);
    // Name wieder wie vorher → alter Code gilt wieder
    if (syncCode(row)) fillCode(row);
    if (feedbackKind === 'success') showFeedback(null);
    scheduleSave();
    updateUi();
  }

  function onNameKeydown(e, id, field) {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const idx = rowIndex(id);
    const ref = refs.get(id);
    if (field === 'lastName') {
      ref?.first.focus();
    } else if (idx < rows.length - 1) {
      refs.get(rows[idx + 1].id)?.last.focus();
    } else if (isBlank(rows[idx])) {
      ref?.last.focus();
    } else {
      flushSave();
      addRow();
    }
  }

  function addRow() {
    const row = blankRow();
    rows.push(row);
    tbody.appendChild(buildRow(row, rows.length - 1));
    updateUi();
    refs.get(row.id).last.focus();
    return row;
  }

  function onPaste(e, id, field) {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    // Einfacher Text ohne Tabulator/Zeilenumbruch → normal einfügen
    if (!/[\t\r\n]/.test(text.replace(/[\r\n]+$/, ''))) return;
    const entries = parsePastedNames(text, field);
    if (!entries.length) return;
    e.preventDefault();
    let idx = rowIndex(id);
    for (const entry of entries) {
      if (!rows[idx]) rows.push(blankRow());
      const row = rows[idx];
      if (entry.lastName !== undefined) row.lastName = entry.lastName;
      if (entry.firstName !== undefined) row.firstName = entry.firstName;
      syncCode(row);
      idx += 1;
    }
    showFeedback(null);
    renderTable();
    persist();
    updateUi();
    const lastRef = refs.get(rows[idx - 1].id);
    (field === 'lastName' ? lastRef?.last : lastRef?.first)?.focus();
    toast(`${plural(entries.length, 'Name', 'Namen')} eingefügt.`, 'success');
  }

  async function onDeleteRow(id) {
    // Nach dem Löschen rückt die nächste Zeile unter den Mauszeiger – ein Doppelklick
    // würde sonst gleich zwei Lernende löschen.
    if (Date.now() - lastDeleteAt < DOUBLE_CLICK_MS) return;
    const row = rowById(id);
    if (!row) return;
    if (row.response || row.appointment) {
      const what = row.response && row.appointment ? 'eine Rückmeldung der Eltern und ein Termin' : row.response ? 'eine Rückmeldung der Eltern' : 'ein Termin';
      const ok = await confirmDialog({
        title: 'Zeile löschen?',
        message: `Für ${displayName(row)} liegt bereits ${what} vor. Beim Löschen der Zeile gehen diese Daten verloren.`,
        confirmText: 'Zeile löschen',
        danger: true,
      });
      if (!ok) return;
    }
    const idx = rowIndex(id);
    if (idx < 0) return;
    rows.splice(idx, 1);
    lastDeleteAt = Date.now();
    if (!rows.length) rows.push(blankRow());
    renderTable();
    persist();
    updateUi();
    // Gelöschte Zeile mit Daten kann wiederhergestellt werden
    if (keepRow(row)) {
      const label = isBlank(row) ? 'Die Zeile wurde gelöscht.' : `„${displayName(row)}“ wurde gelöscht.`;
      showFeedback(
        alertBox('info', h('div', { class: 'cluster' }, h('span', {}, label), h('button', { type: 'button', class: 'btn btn-small btn-secondary', 'data-action': 'undo-delete', onclick: () => undoDelete(row, idx) }, 'Rückgängig machen'))),
        'undo',
      );
    } else {
      showFeedback(null);
    }
    const next = rows[Math.min(idx, rows.length - 1)];
    const ref = refs.get(next.id);
    if (isBlank(next) && rows.length === 1) ref?.last.focus();
    else ref?.del.focus();
  }

  function undoDelete(row, idx) {
    if (rowById(row.id)) return;
    // Einzelne leere Platzhalterzeile wird durch die wiederhergestellte Zeile ersetzt
    if (rows.length === 1 && !keepRow(rows[0])) rows = [];
    rows.splice(Math.min(idx, rows.length), 0, row);
    showFeedback(null);
    renderTable();
    persist();
    updateUi();
    refs.get(row.id)?.last.focus();
    toast(isBlank(row) ? 'Zeile wiederhergestellt.' : `„${displayName(row)}“ wiederhergestellt.`, 'success');
  }

  // ---------- Hauptknopf ----------

  function onPrimary() {
    if (busy) return;
    flushSave();
    if (isReady()) {
      // Doppelklick auf „Alle Lernenden erfolgreich eingetragen“ soll nicht sofort das PDF starten
      if (Date.now() - codesCreatedAt < DOUBLE_CLICK_MS) return;
      createLetters();
    } else {
      generateCodes();
    }
  }

  function focusRow(id, field = 'lastName') {
    const ref = refs.get(id);
    (field === 'firstName' ? ref?.first : ref?.last)?.focus();
  }

  function generateCodes() {
    showFeedback(null);
    state = getCurrentState() || state;
    // Komplett leere Zeilen entfernen, Namen bereinigen
    rows = rows.filter(keepRow);
    for (const r of rows) {
      r.lastName = cleanName(r.lastName);
      r.firstName = cleanName(r.firstName);
    }
    if (!rows.length) {
      rows.push(blankRow());
      renderTable();
      persist();
      updateUi();
      showFeedback(alertBox('error', 'Bitte tragen Sie mindestens eine Lernende oder einen Lernenden ein.'), 'error');
      focusRow(rows[0].id);
      return;
    }
    renderTable();

    // Jede Zeile braucht Nach- und Vorname mit mindestens einem Buchstaben A–Z
    const problems = [];
    rows.forEach((r, i) => {
      for (const [field, label] of [['lastName', 'Nachname'], ['firstName', 'Vorname']]) {
        const value = r[field];
        if (!value) problems.push({ id: r.id, field, text: `Zeile ${i + 1}: Bitte tragen Sie den ${label}n ein.` });
        else if (!hasCodeLetters(value)) problems.push({ id: r.id, field, text: `Zeile ${i + 1}: Der ${label} „${value}“ enthält keine Buchstaben.` });
      }
    });
    if (problems.length) {
      for (const p of problems) {
        const ref = refs.get(p.id);
        ref.tr.classList.add('tc-row-error');
        (p.field === 'lastName' ? ref.last : ref.first).setAttribute('aria-invalid', 'true');
      }
      persist();
      updateUi();
      showFeedback(alertBox('error', h('p', {}, h('strong', {}, 'Bitte ergänzen Sie die markierten Felder:')), h('ul', { class: 'tc-problems' }, problems.map((p) => h('li', {}, p.text)))), 'error');
      focusRow(problems[0].id, problems[0].field);
      return;
    }

    // Gleicher Zahlencode → gleicher Schülercode: nicht erlaubt
    const groups = new Map();
    rows.forEach((r, i) => {
      const key = studentNameCode(r.firstName, r.lastName);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    });
    const duplicates = [...groups.values()].filter((g) => g.length > 1);
    if (duplicates.length) {
      const sameName = (g) => new Set(g.map((i) => `${transliterate(rows[i].firstName)}|${transliterate(rows[i].lastName)}`)).size === 1;
      const lines = duplicates.map((g) => {
        const nums = g.map((i) => i + 1);
        const numText = `Zeilen ${nums.slice(0, -1).join(', ')} und ${nums[nums.length - 1]}`;
        return sameName(g) ? `${numText}: ${displayName(rows[g[0]])}` : `${numText}: ${g.map((i) => `„${displayName(rows[i])}“`).join(' und ')} ergeben zufällig denselben Code`;
      });
      for (const g of duplicates) {
        for (const i of g) {
          const ref = refs.get(rows[i].id);
          ref.tr.classList.add('tc-row-error');
          ref.tr.dataset.dup = '1';
          ref.last.setAttribute('aria-invalid', 'true');
          ref.first.setAttribute('aria-invalid', 'true');
        }
      }
      persist();
      updateUi();
      showFeedback(
        alertBox('error', h('p', {}, h('strong', {}, 'Zwei Lernende haben denselben Namen – bitte unterscheiden (z. B. mit zweitem Vornamen).')), h('p', {}, 'Sonst würden beide Kinder denselben Code erhalten.'), h('ul', { class: 'tc-problems' }, lines.map((t) => h('li', {}, t)))),
        'error',
      );
      focusRow(rows[duplicates[0][1]].id, 'firstName');
      return;
    }

    for (const r of rows) {
      r.code = expectedCode(r);
      r.prevCode = '';
    }
    codesCreatedAt = Date.now();
    renderTable();
    persist();
    updateUi();
    const n = rows.length;
    toast(n === 1 ? 'Code für 1 Lernende(n) erzeugt.' : `Codes für ${n} Lernende erzeugt.`, 'success');
    showFeedback(alertBox('success', h('strong', {}, 'Die Codes sind erzeugt. '), 'Im nächsten Schritt erstellen Sie die Elternschreiben.'), 'success');
    primaryBtn.focus();
  }

  async function createLetters() {
    busy = true;
    primaryBtn.disabled = true;
    mount(primaryBtn, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'PDF wird erstellt …');
    showFeedback(null);
    try {
      const { createParentLettersPdf } = await import('../pdf/letters-pdf.js');
      const result = await createParentLettersPdf(getCurrentState(), classId);
      const name = savePdf(result.doc, result.filename || `Elternschreiben Klasse ${classId}.pdf`);
      const pages = result.pageCount || rows.filter(keepRow).length;
      toast(`Elternschreiben gespeichert: „${name}“`, 'success');
      showFeedback(
        alertBox('success', h('strong', {}, 'Die Elternschreiben wurden erstellt. '), `Die Datei „${name}“ hat ${plural(pages, 'Seite', 'Seiten')} – eine pro Kind. Drucken Sie sie aus und geben Sie jedem Kind seinen Brief mit.`),
        'success',
      );
    } catch (err) {
      console.warn(err);
      showFeedback(alertBox('error', h('strong', {}, 'Die Elternschreiben konnten nicht erstellt werden. '), err?.message || String(err)), 'error');
    } finally {
      busy = false;
      primaryBtn.disabled = false;
      updateUi();
    }
  }

  // ---------- Rückmeldungen und Klasse löschen ----------

  function onImported() {
    flushSave();
    const fresh = getCurrentState();
    const cls = fresh && findClass(fresh, classId);
    if (!cls) return;
    state = fresh;
    rows = rowsFromClass(cls);
    renderTable();
    updateUi();
  }

  async function onDeleteClass() {
    const n = rows.filter(keepRow).length;
    const ok = await confirmDialog({
      title: `Klasse ${classId} löschen?`,
      message: h(
        'div',
        { class: 'stack-small' },
        h('p', {}, n ? `Die Klasse ${classId} mit ${learners(n)} wird samt Codes, Rückmeldungen und Terminen aus diesem Browser gelöscht.` : `Die Klasse ${classId} wird aus diesem Browser gelöscht.`),
        h('p', {}, 'Das lässt sich nicht rückgängig machen. Tipp: Speichern Sie vorher einen Zwischenstand.'),
      ),
      confirmText: 'Klasse löschen',
      danger: true,
    });
    if (!ok) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      updateState((s) => {
        s.classes = s.classes.filter((c) => c.id !== classId);
      });
    } catch (err) {
      showFeedback(alertBox('error', `Die Klasse konnte nicht gelöscht werden: ${err.message}`), 'error');
      return;
    }
    deleted = true;
    toast(`Klasse ${classId} gelöscht.`, 'success');
    navigate('/lehrkraft/klassen');
  }
}
