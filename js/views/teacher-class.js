// Klassenansicht (#/lehrkraft/klasse/<id>): Tabelle der Lernenden (Nr., Nachname, Vorname, Code,
// Verfügbarkeit der Eltern), Codes erzeugen, Elternbriefe als PDF („Elternschreiben für diese Klasse
// erstellen“), Rückmeldungen hochladen, „Gespräche terminieren“ und „Klasse löschen“.
// Mit digitalem Briefkasten (MAILBOX_URL) wird er beim Erstellen der Elternbriefe angelegt; der QR-Code
// enthält dann Briefkasten-ID und öffentlichen Schlüssel, und Rückmeldungen kommen automatisch an.
//
// Eingaben werden sofort (verzögert um SAVE_DELAY bzw. beim Verlassen des Feldes) gespeichert,
// ohne die Tabelle neu aufzubauen – der Fokus bleibt also beim Tippen erhalten.
// Komplett leere Zeilen existieren nur auf der Seite und werden nicht gespeichert.
// Gespeichert werden nur die in diesem Tab geänderten bzw. gelöschten Zeilen: Ist dieselbe Klasse in
// einem zweiten Tab offen, gehen dort ergänzte Lernende und Rückmeldungen nicht verloren.

import { h, mount, toast, confirmDialog, alertBox, plural, friendlyError } from '../core/ui.js';
import { updateState, getCurrentState, findClass, newId, teacherStorageKey } from '../core/storage.js';
import { cleanName, hasCodeLetters, studentCode, studentNameCode, transliterate } from '../core/codes.js';
import { WEEKDAYS_SHORT, parseIsoDate, formatRanges, formatRange, formatTimestamp, toMinutes, fromMinutes } from '../core/time.js';
import { savePdf, preloadPdf } from '../core/pdf.js';
import { createResponseImporter } from '../components/response-import.js';
import { mailboxEnabled, MailboxError } from '../core/mailbox.js';
import { ensureTeacherMailbox, hasTeacherMailbox, publishClassDirectory } from '../core/teacher-mailbox.js';
import { loadCloudConfig, hasCloudKeys } from '../core/cloud-sync.js';

const SAVE_DELAY = 300;
const MAX_NAME = 80;
// Schutz vor Doppelklicks: zweiter Klick innerhalb dieser Zeit wird ignoriert
const DOUBLE_CLICK_MS = 700;
const CLASS_GONE = 'Die Klasse wurde inzwischen gelöscht (z. B. in einem anderen Fenster).';
const LABEL_ENTER = 'Alle Lernenden erfolgreich eingetragen';
// Knopftext laut Anforderung; sonst heißt es überall „Elternbrief“.
const LABEL_LETTERS = 'Elternschreiben für diese Klasse erstellen';

// ---------- Hilfen ----------

function blankRow() {
  return { id: newId(), lastName: '', firstName: '', code: '', response: null, appointment: null };
}

function rowFromStudent(s) {
  return {
    id: s.id,
    lastName: s.lastName || '',
    firstName: s.firstName || '',
    code: s.code || '',
    response: s.response || null,
    appointment: s.appointment || null,
  };
}

function rowsFromClass(cls) {
  const rows = cls.students.map(rowFromStudent);
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

/** Ist die Cloud-Sicherung der Lehrkraft auf diesem Gerät verbunden (der Stand wird dort gesichert)? */
function cloudConnected(code) {
  return Boolean(loadCloudConfig(code)) && hasCloudKeys(code);
}

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
  // Zeilen, die in diesem Tab geändert bzw. gelöscht wurden, und die zuletzt gespeicherten IDs –
  // nur diese Änderungen werden auf den (vielleicht in einem anderen Tab geänderten) Stand angewendet.
  const dirty = new Set();
  const removed = new Set();
  let loadedIds = new Set(initial.students.map((s) => s.id));
  let saveTimer = null;
  let busy = false;
  let deleted = false;
  let showAvail = false;
  let feedbackKind = '';
  let lastDeleteAt = 0;
  let codesCreatedAt = 0;
  let lettersCreatedAt = 0;
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
  /** Zustand B („Elternschreiben für diese Klasse erstellen“): jede Zeile mit Namen hat einen passenden Code. */
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
      mailboxEnabled()
        ? 'Rückmeldungen kommen automatisch über den digitalen Briefkasten; Rückmeldungen per E-Mail können Sie weiterhin hier hochladen. Die Zeiten erscheinen in der Spalte „Verfügbarkeit der Eltern“.'
        : 'Die Eltern schicken Ihnen ihre Rückmeldung als PDF-Datei per E-Mail. Laden Sie die Dateien hier hoch – gerne viele auf einmal. Die Zeiten erscheinen danach in der Spalte „Verfügbarkeit der Eltern“.',
    ),
    importHost,
  );
  renderImporter();

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
  // Änderungen aus einem anderen Tab übernehmen (z. B. dort ergänzte Lernende oder Rückmeldungen)
  const onStorage = (e) => {
    if (deleted || e.key !== teacherStorageKey(state.teacher.teacherCode)) return;
    if (saveTimer) persist();
    else syncFromStorage();
  };
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('storage', onStorage);
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

  /** Upload-Bereich (neu) einsetzen – z. B. nachdem der digitale Briefkasten eingerichtet wurde. */
  function renderImporter() {
    try {
      mount(importHost, createResponseImporter({ classId, onImported }));
    } catch (err) {
      console.warn(err);
      mount(importHost, alertBox('warning', 'Der Upload der Rückmeldungen ist im Moment nicht verfügbar. Bitte laden Sie die Seite später neu.'));
    }
  }

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
      ? 'Die Codes sind erzeugt. Erstellen Sie jetzt die Elternbriefe und geben Sie jedem Kind seinen Brief mit. Sobald die Eltern antworten, erscheinen ihre Zeiten in der Spalte „Verfügbarkeit der Eltern“.'
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

  function markDirty(...ids) {
    for (const id of ids) {
      dirty.add(id);
      removed.delete(id);
    }
  }

  /**
   * Schreibt die in diesem Tab geänderten Zeilen in den Zustand (außer komplett leeren Zeilen).
   * Unveränderte Zeilen behalten den gespeicherten Stand, Lernende aus einem anderen Tab bleiben
   * erhalten, dort gelöschte bleiben gelöscht. Rückmeldungen und Termine bleiben immer erhalten.
   */
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const keep = rows.filter(keepRow);
    const localIds = new Set(rows.map((r) => r.id));
    let merged = null;
    try {
      state = updateState((s) => {
        const cls = findClass(s, classId);
        if (!cls) throw new Error(CLASS_GONE);
        const previous = new Map(cls.students.map((st) => [st.id, st]));
        const out = [];
        for (const r of keep) {
          const prev = previous.get(r.id);
          if (!prev && loadedIds.has(r.id) && !dirty.has(r.id)) continue; // in einem anderen Tab gelöscht
          if (prev && !dirty.has(r.id)) {
            out.push(prev);
            continue;
          }
          out.push({
            id: r.id,
            lastName: cleanName(r.lastName),
            firstName: cleanName(r.firstName),
            code: r.code,
            response: prev ? prev.response ?? null : r.response,
            appointment: prev ? prev.appointment ?? null : r.appointment,
          });
        }
        // In einem anderen Tab ergänzte Lernende anhängen
        for (const st of cls.students) if (!localIds.has(st.id) && !removed.has(st.id)) out.push(st);
        cls.students = out;
        cls.codesGenerated = out.length > 0 && out.every((st) => st.code && st.code === studentCode(grade, letter, s.teacher.teacherCode, st.firstName, st.lastName));
        merged = out;
      });
    } catch (err) {
      console.error(err);
      showFeedback(alertBox('error', h('strong', {}, 'Die Änderungen konnten nicht gespeichert werden. '), friendlyError(err)), 'error');
      return false;
    }
    dirty.clear();
    removed.clear();
    loadedIds = new Set(merged.map((st) => st.id));
    adoptStudents(merged);
    return true;
  }

  /** Übernimmt gespeicherte Lernende in die Tabelle, wenn sie sich (durch einen anderen Tab) unterscheiden. */
  function adoptStudents(students) {
    const current = rows.filter(keepRow);
    const sameIds = current.length === students.length && current.every((r, i) => r.id === students[i].id);
    const local = new Map(rows.map((r) => [r.id, r]));
    let changed = !sameIds;
    const next = students.map((st) => {
      const row = local.get(st.id);
      if (!row) return rowFromStudent(st);
      // Eigene Eingaben bleiben stehen (z. B. ein Leerzeichen am Ende beim Tippen) – nur fremde Änderungen übernehmen
      if (cleanName(row.lastName) !== st.lastName || cleanName(row.firstName) !== st.firstName) {
        row.lastName = st.lastName;
        row.firstName = st.firstName;
        changed = true;
      }
      if (row.code !== st.code || JSON.stringify(row.response) !== JSON.stringify(st.response) || JSON.stringify(row.appointment) !== JSON.stringify(st.appointment)) changed = true;
      row.code = st.code;
      row.response = st.response;
      row.appointment = st.appointment;
      return row;
    });
    if (!changed) return;
    // Noch leere Zeilen (nur auf dieser Seite) bleiben am Ende stehen.
    for (const r of rows) if (!keepRow(r) && !next.includes(r)) next.push(r);
    rows = next.length ? next : [blankRow()];
    rerenderKeepingFocus();
    updateUi();
  }

  /** Stand aus dem Speicher übernehmen (nach Änderungen in einem anderen Tab). */
  function syncFromStorage() {
    const fresh = getCurrentState();
    const cls = fresh && findClass(fresh, classId);
    if (!cls) {
      showFeedback(
        alertBox('error', h('strong', {}, `Die Klasse ${classId} wurde inzwischen gelöscht`), ' (z. B. in einem anderen Fenster). Änderungen hier werden nicht mehr gespeichert. ', h('a', { href: '#/lehrkraft/klassen' }, 'Zur Klassenübersicht')),
        'error',
      );
      return;
    }
    state = fresh;
    loadedIds = new Set(cls.students.map((st) => st.id));
    adoptStudents(cls.students);
  }

  /** Tabelle neu zeichnen, ohne dass das gerade bearbeitete Feld den Fokus verliert. */
  function rerenderKeepingFocus() {
    const active = document.activeElement;
    const tr = active?.closest?.('tr[data-id]');
    const focus = tr && tbody.contains(tr) ? { id: tr.dataset.id, testid: active.dataset.testid, start: active.selectionStart, end: active.selectionEnd } : null;
    renderTable();
    if (!focus) return;
    const el = refs.get(focus.id)?.tr.querySelector(`[data-testid="${focus.testid}"]`);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (typeof focus.start === 'number') el.setSelectionRange?.(focus.start, focus.end);
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
    markDirty(id);
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
      markDirty(row.id);
      idx += 1;
    }
    showFeedback(null);
    renderTable();
    const saved = persist();
    updateUi();
    const lastRef = refs.get(rows[idx - 1].id);
    (field === 'lastName' ? lastRef?.last : lastRef?.first)?.focus();
    if (saved) toast(`${plural(entries.length, 'Name', 'Namen')} eingefügt.`, 'success');
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
    dirty.delete(id);
    removed.add(id);
    lastDeleteAt = Date.now();
    if (!rows.length) rows.push(blankRow());
    renderTable();
    const saved = persist();
    updateUi();
    // Gelöschte Zeile mit Daten kann wiederhergestellt werden; bei einem Speicherfehler bleibt dessen Meldung stehen
    if (saved && keepRow(row)) {
      const label = isBlank(row) ? 'Die Zeile wurde gelöscht.' : `„${displayName(row)}“ wurde gelöscht.`;
      showFeedback(
        alertBox('info', h('div', { class: 'cluster' }, h('span', {}, label), h('button', { type: 'button', class: 'btn btn-small btn-secondary', 'data-action': 'undo-delete', onclick: () => undoDelete(row, idx) }, 'Rückgängig machen'))),
        'undo',
      );
    } else if (saved) {
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
    markDirty(row.id);
    showFeedback(null);
    renderTable();
    const saved = persist();
    updateUi();
    refs.get(row.id)?.last.focus();
    if (saved) toast(isBlank(row) ? 'Zeile wiederhergestellt.' : `„${displayName(row)}“ wiederhergestellt.`, 'success');
  }

  // ---------- Hauptknopf ----------

  function onPrimary(e) {
    // Zweiter Klick eines Doppelklicks: nichts doppelt ausführen
    if (busy || e?.detail > 1) return;
    flushSave();
    if (isReady()) {
      // Doppelklick auf „Alle Lernenden erfolgreich eingetragen“ bzw. kurz nach dem letzten PDF: kein (weiteres) PDF
      if (Date.now() - codesCreatedAt < DOUBLE_CLICK_MS || Date.now() - lettersCreatedAt < DOUBLE_CLICK_MS) return;
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
    for (const r of rows) if (!keepRow(r) && loadedIds.has(r.id)) removed.add(r.id);
    rows = rows.filter(keepRow);
    for (const r of rows) {
      r.lastName = cleanName(r.lastName);
      r.firstName = cleanName(r.firstName);
      markDirty(r.id);
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
    const saved = persist();
    updateUi();
    if (!saved) return; // Fehlermeldung steht schon da
    const n = rows.length;
    showFeedback(
      alertBox('success', h('strong', {}, n === 1 ? 'Code für 1 Lernende(n) erzeugt. ' : `Codes für ${n} Lernende erzeugt. `), 'Im nächsten Schritt erstellen Sie die Elternbriefe.'),
      'success',
    );
    // Die Zeilen sind durch die Codes höher geworden: Meldung und nächsten Knopf ins Bild holen
    // (focus() allein scrollt nicht, weil der Knopf schon fokussiert ist).
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    feedback.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    primaryBtn.focus({ preventScroll: true });
  }

  async function createLetters() {
    busy = true;
    primaryBtn.disabled = true;
    mount(primaryBtn, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'PDF wird erstellt …');
    showFeedback(null);
    try {
      // Digitaler Briefkasten: vor den Briefen anlegen, damit der QR-Code Briefkasten-ID und Schlüssel enthält.
      // Klappt das nicht (z. B. Speicher voll), entstehen die Briefe wie bisher für den Weg per E-Mail.
      const hadMailbox = hasTeacherMailbox();
      let mailboxFailed = false;
      if (mailboxEnabled() && !hadMailbox) {
        try {
          await ensureTeacherMailbox();
        } catch (err) {
          console.warn(err);
          mailboxFailed = true;
        }
        // Upload-Bereich zeigt jetzt den Briefkasten (auch falls die PDF danach scheitert)
        if (hasTeacherMailbox()) renderImporter();
      }
      const current = getCurrentState();
      const { createParentLettersPdf } = await import('../pdf/letters-pdf.js');
      const result = await createParentLettersPdf(current, classId);
      const name = savePdf(result.doc, result.filename || `Elternbriefe Klasse ${classId}.pdf`);
      const pages = result.pageCount || rows.filter(keepRow).length;
      const text = `Die Datei „${name}“ hat ${plural(pages, 'Seite', 'Seiten')} – eine pro Kind. Drucken Sie sie aus und geben Sie jedem Kind seinen Brief mit.`;
      const withMailbox = hasTeacherMailbox(current);
      if (!withMailbox && !mailboxFailed) {
        showFeedback(alertBox('success', h('strong', {}, 'Die Elternbriefe wurden erstellt. '), text), 'success');
      } else {
        const success = alertBox(
          'success',
          h('p', {}, h('strong', {}, 'Die Elternbriefe wurden erstellt. '), text),
          h(
            'p',
            { class: 'small', 'data-testid': 'letters-mailbox-note' },
            withMailbox
              ? 'Die Eltern senden ihre Rückmeldung über den digitalen Briefkasten. ParentsDay übernimmt sie automatisch, wenn Sie Ihre Klassen öffnen – sofort geht es mit „Neue Rückmeldungen abrufen“.'
              : 'Der digitale Briefkasten konnte nicht eingerichtet werden. Die Eltern schicken ihre Rückmeldung deshalb per E-Mail.',
            // Der Schlüssel zum Briefkasten liegt nur in diesem Browser (und im Zwischenspeicher) – mit
            // Cloud-Sicherung auch dort, dann braucht es keinen Zwischenstand.
            withMailbox && !hadMailbox && !cloudConnected(current.teacher.teacherCode)
              ? ' Tipp: Speichern Sie jetzt einen Zwischenstand. Nur damit können Sie die Rückmeldungen auch auf einem anderen Gerät oder nach dem Löschen der Browserdaten lesen.'
              : null,
          ),
        );
        showFeedback(success, 'success');
        // Verzeichniseintrag für Eltern mit Termin-Schlüssel (ohne QR-Code)
        if (withMailbox) {
          publishClassDirectory(getCurrentState() || current, classId).catch((err) => {
            if (!feedback.contains(success)) return;
            const note = h('p', { class: 'small', 'data-testid': 'letters-directory-note' }, directoryNote(err));
            // Eintrag gehört einem anderen Briefkasten: eigene Warnung statt Randnotiz
            if (err instanceof MailboxError && err.status === 409) feedback.appendChild(alertBox('warning', note));
            else success.appendChild(note);
          });
        }
      }
    } catch (err) {
      console.warn(err);
      showFeedback(alertBox('error', h('strong', {}, 'Die Elternbriefe konnten nicht erstellt werden. '), friendlyError(err)), 'error');
    } finally {
      busy = false;
      lettersCreatedAt = Date.now();
      primaryBtn.disabled = false;
      updateUi();
    }
  }

  /** Hinweis, wenn der Verzeichniseintrag für den Termin-Schlüssel nicht abgelegt werden konnte. */
  function directoryNote(err) {
    // Ein anderer (früherer) Briefkasten dieser Lehrkraft hat den Eintrag schon – z. B. vor dem Löschen der Browserdaten.
    if (err instanceof MailboxError && err.status === 409) {
      return [
        h('strong', {}, 'Achtung: '),
        'Für den Termin-Schlüssel dieser Klasse ist schon ein anderer digitaler Briefkasten eingetragen – meist ein früherer von Ihnen (z. B. von vor dem Löschen der Browserdaten). Rückmeldungen von Eltern, die den Termin-Schlüssel abtippen statt den QR-Code zu scannen, kommen deshalb nicht hier an. Haben Sie noch den Zwischenstand, mit dem Sie die ersten Elternbriefe erstellt haben, laden Sie ihn und erstellen Sie die Elternbriefe danach neu.',
      ];
    }
    if (err instanceof MailboxError && !err.offline) {
      return `Hinweis: Eltern ohne QR-Code (mit Termin-Schlüssel) schicken ihre Rückmeldung vorerst per E-Mail. ${err.message}`;
    }
    return 'Hinweis: Der digitale Briefkasten war gerade nicht erreichbar. Eltern ohne QR-Code (mit Termin-Schlüssel) schicken ihre Rückmeldung deshalb vorerst per E-Mail. Beim nächsten Abrufen der Rückmeldungen wird es erneut versucht.';
  }

  // ---------- Rückmeldungen und Klasse löschen ----------

  // Rückmeldungen können auch ankommen, während die Lehrkraft tippt (automatischer Abruf aus dem
  // digitalen Briefkasten): Eingaben, noch leere Zeilen und der Fokus im Namensfeld bleiben erhalten.
  function onImported() {
    flushSave();
    const fresh = getCurrentState();
    const cls = fresh && findClass(fresh, classId);
    if (!cls) return;
    state = fresh;
    loadedIds = new Set(cls.students.map((st) => st.id));
    adoptStudents(cls.students);
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
      showFeedback(alertBox('error', h('strong', {}, 'Die Klasse konnte nicht gelöscht werden. '), friendlyError(err)), 'error');
      return;
    }
    deleted = true;
    toast(`Klasse ${classId} gelöscht.`, 'success');
    navigate('/lehrkraft/klassen');
  }
}
