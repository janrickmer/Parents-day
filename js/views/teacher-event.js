// Elternsprechtag erstellen (mode 'create') und „Weitere Einstellungen“ (mode 'settings'):
// Tage im Kalender wählen, Anfangs- und Endzeit je Tag, Adresse der Schule, Terminlänge und
// E-Mail-Adresse für Rückmeldungen. In den Einstellungen zusätzlich: Hinweis auf bereits erstellte
// Elternbriefe, digitaler Briefkasten (nur wenn MAILBOX_URL gesetzt ist), Profil (nur lesen) und
// „Alle Daten in diesem Browser löschen“.

import { MAX_EVENT_DAYS as MAX_DAYS, SLOT_MIN, SLOT_MAX, ADDRESS_MAX_CHARS, ADDRESS_MAX_LINES } from '../config.js';
import { h, mount, toast, confirmDialog, alertBox, plural, friendlyError } from '../core/ui.js';
import { updateState, getCurrentState, deleteTeacherState, clearSession, loadEventDraft, storeEventDraft, clearEventDraft, setDraftPending } from '../core/storage.js';
import { toMinutes, fromMinutes, slotStarts, formatDate, formatDateWithWeekday, formatTimestamp, nowParts, todayIso } from '../core/time.js';
import { createCalendarPicker } from '../components/calendar-picker.js';
import { saveBackupNow, openLoadBackupDialog, isEmptyDevice, markEmptyDevice } from '../components/backup-actions.js';
import { isValidEmail } from '../core/codes.js';
import { mailboxEnabled, checkMailboxService } from '../core/mailbox.js';
import { hasTeacherMailbox, fetchMailboxResponses, clearTeacherMailbox } from '../core/teacher-mailbox.js';
import { UP_TO_DATE_REASONS } from '../core/responses.js';
import { isCloudConnected, loadCloudConfig, forgetCloudOnDevice, endCloudSession, stopCloudSync } from '../core/cloud-sync.js';
import { cloudSettingsCard } from '../components/cloud-ui.js';

// Höchstens MAX_DAYS Tage: Grenze des Termin-Schlüssels (siehe core/transport.js).
// Die Adresse steht im Link/QR-Code des Elternbriefs – längere Texte machen den QR-Code unlesbar.
const DEFAULT_START = '14:00';
const DEFAULT_END = '18:00';
const DEFAULT_SLOT = 10;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- Entwurf und Prüfung ----------

function draftFromState(state) {
  const ev = state.event;
  return {
    days: (ev?.days || []).map((d) => ({ date: d.date, start: d.start, end: d.end })),
    address: ev?.schoolAddress || '',
    slot: String(ev?.slotMinutes ?? DEFAULT_SLOT),
    email: state.teacher.email || '',
  };
}

// ---------- Ungespeicherte Eingaben (bleiben bei Neuladen/Seitenwechsel im Tab erhalten) ----------
// Sie liegen im localStorage (core/storage.js) und kommen auch in den Zwischenspeicher.

/** Liest einen noch nicht gespeicherten Entwurf (oder null). */
function loadStoredDraft(state) {
  try {
    const d = loadEventDraft(state);
    if (!d) return null;
    // Tage, die inzwischen in der Vergangenheit liegen, nur behalten, wenn sie schon gespeichert waren.
    const today = todayIso();
    const savedDates = new Set((state.event?.days || []).map((x) => x.date));
    const seen = new Set();
    const days = d.days
      .filter((x) => x && ISO_RE.test(x.date) && (x.date >= today || savedDates.has(x.date)) && !seen.has(x.date) && seen.add(x.date))
      .map((x) => ({ date: x.date, start: String(x.start ?? ''), end: String(x.end ?? '') }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return { days, address: String(d.address ?? ''), slot: String(d.slot ?? ''), email: String(d.email ?? '') };
  } catch {
    return null;
  }
}

/** Uhrzeit aus einem Eingabefeld als "HH:MM" (Sekunden werden abgeschnitten). */
function readTime(input) {
  const m = /^(\d{2}):(\d{2})/.exec(input.value || '');
  return m ? `${m[1]}:${m[2]}` : '';
}

function cleanAddress(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Gültige Slotlänge als Zahl oder null. */
function validSlot(raw) {
  const slot = Number(raw);
  return String(raw).trim() !== '' && Number.isInteger(slot) && slot >= SLOT_MIN && slot <= SLOT_MAX && slot % 5 === 0 ? slot : null;
}

function eventFromDraft(draft) {
  return {
    schoolAddress: cleanAddress(draft.address),
    slotMinutes: validSlot(draft.slot),
    days: draft.days.map((d) => ({ date: d.date, start: d.start, end: d.end })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** Prüft einen Tag. Gibt { message, fields } oder null zurück. */
function dayProblem(day, slot) {
  const s = toMinutes(day.start);
  const e = toMinutes(day.end);
  if (Number.isNaN(s) && Number.isNaN(e)) return { message: 'Bitte geben Sie die Anfangs- und die Endzeit ein.', fields: ['start', 'end'] };
  if (Number.isNaN(s)) return { message: 'Bitte geben Sie eine Anfangszeit ein.', fields: ['start'] };
  if (Number.isNaN(e)) return { message: 'Bitte geben Sie eine Endzeit ein.', fields: ['end'] };
  const off = [s % 5 ? 'start' : null, e % 5 ? 'end' : null].filter(Boolean);
  if (off.length) return { message: 'Bitte geben Sie die Uhrzeiten in 5-Minuten-Schritten an (z. B. 14:00, 14:05 oder 14:10).', fields: off };
  if (e <= s) return { message: 'Die Endzeit muss nach der Anfangszeit liegen.', fields: ['end'] };
  if (slot && e - s < slot) {
    return { message: `In diese Zeit passt kein Termin von ${slot} Minuten. Bitte wählen Sie eine spätere Endzeit oder eine kürzere Terminlänge.`, fields: ['end'] };
  }
  return null;
}

/**
 * Prüft den gesamten Entwurf.
 * @returns {Array<{key:string, label:string, message:string, fields?:string[]}>}
 */
function validateDraft(draft) {
  const errors = [];
  const slot = validSlot(draft.slot);
  if (draft.days.length === 0) {
    errors.push({ key: 'days', label: 'Tage', message: 'Bitte wählen Sie im Kalender mindestens einen Tag aus.' });
  } else if (draft.days.length > MAX_DAYS) {
    errors.push({ key: 'days', label: 'Tage', message: `Bitte wählen Sie höchstens ${MAX_DAYS} Tage aus. Zurzeit sind ${draft.days.length} Tage ausgewählt.` });
  }
  for (const day of draft.days) {
    const problem = dayProblem(day, slot);
    if (problem) errors.push({ key: `day:${day.date}`, label: formatDateWithWeekday(day.date), ...problem });
  }
  const address = cleanAddress(draft.address);
  if (!address) {
    errors.push({ key: 'address', label: 'Adresse der Schule', message: 'Bitte geben Sie die Adresse der Schule ein.' });
  } else if (address.length > ADDRESS_MAX_CHARS) {
    errors.push({ key: 'address', label: 'Adresse der Schule', message: `Die Adresse ist zu lang (${address.length} Zeichen). Bitte kürzen Sie sie auf höchstens ${ADDRESS_MAX_CHARS} Zeichen, damit der QR-Code im Elternbrief gut lesbar bleibt.` });
  } else if (address.split('\n').filter(Boolean).length > ADDRESS_MAX_LINES) {
    errors.push({ key: 'address', label: 'Adresse der Schule', message: `Bitte geben Sie die Adresse in höchstens ${ADDRESS_MAX_LINES} Zeilen an.` });
  }
  if (slot === null) {
    const n = Number(draft.slot);
    let message = 'Bitte geben Sie die Terminlänge in Minuten ein.';
    if (String(draft.slot).trim() !== '' && !Number.isNaN(n)) {
      message = n < SLOT_MIN || n > SLOT_MAX ? `Die Terminlänge muss zwischen ${SLOT_MIN} und ${SLOT_MAX} Minuten liegen.` : 'Bitte geben Sie die Terminlänge in 5-Minuten-Schritten an (z. B. 10 oder 15).';
    }
    errors.push({ key: 'slot', label: 'Terminlänge', message });
  }
  const email = draft.email.trim();
  if (!email) errors.push({ key: 'email', label: 'E-Mail-Adresse', message: 'Bitte geben Sie Ihre E-Mail-Adresse ein.' });
  else if (!isValidEmail(email)) errors.push({ key: 'email', label: 'E-Mail-Adresse', message: 'Bitte geben Sie eine gültige E-Mail-Adresse ein (z. B. name@schule.de).' });
  return errors;
}

/** Vergleichbare Darstellung eines Entwurfs (für „ungespeicherte Änderungen“). */
function draftSignature(draft) {
  const ev = eventFromDraft(draft);
  // „010“ und „10“ gelten als gleich, ungültige Eingaben werden als Text verglichen.
  return JSON.stringify({ ...ev, slotMinutes: validSlot(draft.slot) ?? String(draft.slot).trim(), email: draft.email.trim() });
}

/** true beim zweiten (dritten …) Klick eines Doppelklicks – viele Nutzer doppelklicken aus Gewohnheit. */
function ignoreRepeat(e) {
  return e.detail > 1;
}

function classList(ids) {
  return ids.length === 1 ? `die Klasse ${ids[0]}` : `die Klassen ${ids.slice(0, -1).join(', ')} und ${ids[ids.length - 1]}`;
}

// Gründe aus applyResponses() (core/responses.js), bei denen nichts verloren geht: Die Zeiten stehen schon in ParentsDay.
const ALREADY_THERE = new Set(UP_TO_DATE_REASONS);

/** Abgerufene Rückmeldungen, die zu keinem Kind in ParentsDay passen (z. B. Klasse nicht angelegt). */
function unmatchedResponses(fetched) {
  return (fetched?.skipped || []).filter((s) => !ALREADY_THERE.has(s.reason));
}

/** Kurze Liste „Name (Klasse 5a) – Grund“, höchstens 6 Einträge. */
function responseList(items) {
  const shown = items.slice(0, 6);
  return h(
    'ul',
    { class: 'evt-affected' },
    shown.map((r) => h('li', {}, `${r.name}${r.classId ? ` (Klasse ${r.classId})` : ''}${r.reason ? ` – ${r.reason}` : ''}`)),
    items.length > shown.length ? h('li', {}, `… und ${items.length - shown.length} weitere`) : null,
  );
}

// ---------- View ----------

export default function render(ctx) {
  const { root, params, navigate, setTitle } = ctx;
  let saved = ctx.state;
  // Ohne Elternsprechtag gibt es noch nichts einzustellen → zuerst erstellen.
  if (params.mode === 'settings' && !saved.event) {
    navigate('/lehrkraft/elternsprechtag', { replace: true });
    return;
  }
  // Ist bereits ein Elternsprechtag angelegt, verhält sich „erstellen“ wie „Weitere Einstellungen“.
  const isSettings = Boolean(saved.event);
  setTitle(isSettings ? 'Weitere Einstellungen' : 'Elternsprechtag erstellen');

  let savedSignature = draftSignature(draftFromState(saved));
  // Noch nicht gespeicherte Eingaben aus diesem Tab (z. B. nach Neuladen oder Seitenwechsel) wiederherstellen.
  const restored = loadStoredDraft(saved);
  const draft = restored || draftFromState(saved);
  if (restored && draftSignature(restored) === savedSignature) clearEventDraft(saved);
  else if (restored) {
    toast(isSettings ? 'Ihre noch nicht gespeicherten Änderungen wurden wiederhergestellt.' : 'Ihre bisherigen Eingaben wurden wiederhergestellt.', 'info', 6000);
  }
  let showErrors = false;
  let busy = false;
  let finished = false; // nach dem Erstellen wird weitergeleitet – kein zweites Speichern
  const dayRefs = new Map(); // Datum → { item, start, end, info, error, remove }

  // --- Sammelhinweis oben ---
  const summary = h('div', { class: 'alert alert-error evt-summary', tabindex: '-1', role: 'group', 'aria-labelledby': 'evt-summary-title', hidden: true });

  // --- Kalender und Liste der Tage ---
  const calendar = createCalendarPicker({ selected: draft.days.map((d) => d.date), onChange: onCalendarChange });
  const daysError = h('div', { class: 'field-error evt-days-error', id: 'evt-days-error', 'aria-live': 'polite', hidden: true });
  const dayCount = h('p', { class: 'evt-day-count', 'aria-live': 'polite' });
  const emptyState = h('div', { class: 'empty-state evt-empty' }, 'Bitte wählen Sie im Kalender mindestens einen Tag aus.');
  const dayList = h('ul', { class: 'evt-day-list', 'aria-label': 'Ausgewählte Tage' });
  const copyBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-small evt-copy', onclick: copyFirstTimes }, 'Zeiten des ersten Tages für alle Tage übernehmen');

  // --- Formularfelder ---
  const fields = {};
  const addressInput = h('textarea', {
    rows: '4',
    placeholder: 'Name der Schule\nStraße Hausnummer\nPLZ Ort',
    autocomplete: 'off',
    'data-testid': 'event-address',
    oninput: () => {
      draft.address = addressInput.value;
      onDraftInput();
    },
  });
  addressInput.value = draft.address;
  const slotInput = h('input', {
    type: 'number',
    min: String(SLOT_MIN),
    max: String(SLOT_MAX),
    step: '5',
    inputmode: 'numeric',
    value: draft.slot,
    'data-testid': 'event-slot',
    oninput: () => {
      draft.slot = slotInput.value;
      onDraftInput();
    },
  });
  const emailInput = h('input', {
    type: 'email',
    autocomplete: 'email',
    spellcheck: 'false',
    maxlength: '254',
    value: draft.email,
    'data-testid': 'event-email',
    oninput: () => {
      draft.email = emailInput.value;
      onDraftInput();
    },
  });

  function formField(key, id, label, control, hint, extraClass = '') {
    const hintEl = hint ? h('div', { class: 'field-hint', id: `${id}-hint` }, hint) : null;
    const errorEl = h('div', { class: 'field-error', id: `${id}-error`, hidden: true });
    control.id = id;
    control.setAttribute('aria-describedby', [errorEl.id, hintEl?.id].filter(Boolean).join(' '));
    fields[key] = { control, errorEl };
    return h('div', { class: `field ${extraClass}`.trim() }, h('label', { for: id }, label), control, errorEl, hintEl);
  }

  const submitBtn = h(
    'button',
    { type: 'submit', class: 'btn btn-primary btn-large', 'data-testid': 'event-submit', onclick: (e) => ignoreRepeat(e) && e.preventDefault() },
    isSettings ? 'Änderungen speichern' : 'Elternsprechtag erstellen',
  );
  const dirtyNote = h('span', { class: 'evt-dirty', 'aria-live': 'polite' });
  const discardBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-small evt-discard', onclick: discardChanges }, 'Änderungen verwerfen');
  // Hinweis und „Verwerfen“ gehören zusammen und brechen gemeinsam um.
  const dirtyGroup = h('div', { class: 'evt-dirty-group', hidden: true }, dirtyNote, discardBtn);

  function cardTitle(num, text, id) {
    return h('h2', { class: 'evt-card-title', id }, h('span', { class: 'evt-step', 'aria-hidden': 'true' }, num), text);
  }

  const form = h(
    'form',
    { class: 'stack evt-form', novalidate: true, onsubmit: onSubmit },
    summary,
    h(
      'section',
      { class: 'card', 'aria-labelledby': 'evt-days-title' },
      cardTitle('1', 'Tage und Uhrzeiten', 'evt-days-title'),
      h('p', { class: 'muted evt-card-intro' }, 'Klicken Sie im Kalender auf jeden Tag, an dem der Elternsprechtag stattfindet. Ein zweiter Klick entfernt den Tag wieder.'),
      h(
        'div',
        { class: 'evt-days-layout' },
        h('div', { class: 'evt-calendar-col' }, calendar),
        h(
          'div',
          { class: 'evt-list-col' },
          h('div', { class: 'evt-list-head' }, h('h3', { class: 'evt-list-title', id: 'evt-list-title', tabindex: '-1' }, 'Ausgewählte Tage'), dayCount),
          daysError,
          emptyState,
          dayList,
          copyBtn,
        ),
      ),
    ),
    h(
      'section',
      { class: 'card', 'aria-labelledby': 'evt-info-title' },
      cardTitle('2', 'Angaben für die Eltern', 'evt-info-title'),
      h(
        'div',
        { class: 'form-grid' },
        formField('address', 'evt-address', 'Adresse der Schule', addressInput, `Wird den Eltern angezeigt, damit sie wissen, wo die Gespräche stattfinden (höchstens ${ADDRESS_MAX_CHARS} Zeichen).`, 'field-full'),
        formField(
          'slot',
          'evt-slot',
          'Terminlänge in Minuten',
          slotInput,
          isSettings
            ? 'Standardlänge eines Termins. Gilt für die Zeitauswahl der Eltern und für neue Termine. Bereits geplante Termine behalten ihre Dauer.'
            : 'Standardlänge eines Termins, z. B. 10 Minuten. Kann später unter „Weitere Einstellungen“ geändert werden.',
        ),
        formField(
          'email',
          'evt-email',
          'E-Mail-Adresse für Rückmeldungen der Eltern',
          emailInput,
          // Mit Briefkasten ist die E-Mail nur noch die Notlösung.
          mailboxEnabled()
            ? 'Steht im Elternbrief. Ist der digitale Briefkasten nicht erreichbar, schicken die Eltern ihre Rückmeldung an diese Adresse.'
            : 'Steht im Elternbrief. An diese Adresse schicken die Eltern ihre Rückmeldung.',
        ),
      ),
    ),
    h(
      'div',
      { class: 'evt-actions' },
      submitBtn,
      isSettings ? h('a', { class: 'btn btn-secondary btn-large', href: '#/lehrkraft/klassen' }, 'Zurück zu den Klassen') : null,
      isSettings ? dirtyGroup : null,
    ),
  );

  // --- Tage zeichnen ---

  function dayItem(day) {
    const base = `evt-day-${day.date}`;
    const label = formatDateWithWeekday(day.date);
    const info = h('p', { class: 'evt-day-info', id: `${base}-info` });
    const error = h('div', { class: 'field-error evt-day-error', id: `${base}-error`, hidden: true });
    const timeInput = (which) => {
      const input = h('input', {
        type: 'time',
        step: '300',
        id: `${base}-${which}`,
        value: day[which],
        required: true,
        'data-testid': `event-day-${which}-${day.date}`,
        'aria-describedby': `${error.id} ${info.id}`,
      });
      input.addEventListener('input', () => {
        day[which] = readTime(input);
        onDraftInput();
      });
      return input;
    };
    const start = timeInput('start');
    const end = timeInput('end');
    const remove = h(
      'button',
      { type: 'button', class: 'btn btn-ghost btn-small evt-day-remove', 'aria-label': `${label} entfernen`, title: 'Tag entfernen', onclick: (e) => ignoreRepeat(e) || removeDay(day.date) },
      h('span', { 'aria-hidden': 'true' }, '✕'),
      h('span', { class: 'evt-day-remove-text' }, 'Entfernen'),
    );
    const timeField = (input, text) => h('div', { class: 'field evt-time' }, h('label', { for: input.id }, text, h('span', { class: 'visually-hidden' }, ` am ${formatDate(day.date)}`)), input);
    const item = h(
      'li',
      { class: 'evt-day', dataset: { date: day.date } },
      h('div', { class: 'evt-day-head' }, h('div', { class: 'evt-day-title' }, label), info),
      h('div', { class: 'evt-day-times' }, timeField(start, 'Anfangszeit'), h('span', { class: 'evt-day-sep', 'aria-hidden': 'true' }, 'bis'), timeField(end, 'Endzeit')),
      remove,
      error,
    );
    dayRefs.set(day.date, { item, start, end, info, error, remove });
    return item;
  }

  function renderDays() {
    dayRefs.clear();
    const n = draft.days.length;
    emptyState.hidden = n > 0;
    dayList.hidden = n === 0;
    copyBtn.hidden = n < 2;
    dayCount.textContent = n ? `${plural(n, 'Tag', 'Tage')} ausgewählt` : 'noch kein Tag ausgewählt';
    mount(dayList, draft.days.map(dayItem));
    refresh();
  }

  /** Aktualisiert Hinweise, Fehlermeldungen und Speicherstatus, ohne Eingabefelder neu zu erzeugen. */
  function refresh() {
    updateDayInfos();
    // Mehr als 8 Tage sofort melden, alles andere erst nach dem ersten Speicherversuch.
    if (showErrors) applyErrors(validateDraft(draft));
    else if (draft.days.length > MAX_DAYS) setDaysError(validateDraft(draft).find((e) => e.key === 'days')?.message || '');
    else setDaysError('');
    updateDirty();
  }

  function onDraftInput() {
    refresh();
  }

  function updateDayInfos() {
    const slot = validSlot(draft.slot);
    for (const day of draft.days) {
      const ref = dayRefs.get(day.date);
      if (!ref) continue;
      const s = toMinutes(day.start);
      const e = toMinutes(day.end);
      let text = '';
      if (slot && !Number.isNaN(s) && !Number.isNaN(e) && e > s) {
        const starts = slotStarts(day.start, day.end, slot);
        if (starts.length) {
          const lastEnd = starts[starts.length - 1] + slot;
          text = `${plural(starts.length, 'Termin', 'Termine')} zu je ${slot} Minuten`;
          if (lastEnd < e) text += ` (der letzte endet um ${fromMinutes(lastEnd)} Uhr)`;
        }
      }
      ref.info.textContent = text;
      ref.info.hidden = !text;
    }
  }

  /** Merkt sich ungespeicherte Eingaben im Tab und zeigt (nur in den Einstellungen) den Hinweis dazu. */
  function updateDirty() {
    const dirty = !finished && draftSignature(draft) !== savedSignature;
    if (dirty) storeEventDraft(saved, draft);
    else clearEventDraft(saved);
    // Kopfzeile: nicht „Automatisch gespeichert“ behaupten, solange hier Eingaben offen sind
    setDraftPending(dirty);
    if (!isSettings) return;
    dirtyNote.textContent = dirty ? 'Sie haben ungespeicherte Änderungen.' : '';
    dirtyGroup.hidden = !dirty;
  }

  /** Setzt alle Felder auf den gespeicherten Stand zurück. */
  function discardChanges() {
    saved = getCurrentState() || saved;
    savedSignature = draftSignature(draftFromState(saved));
    Object.assign(draft, draftFromState(saved));
    addressInput.value = draft.address;
    slotInput.value = draft.slot;
    emailInput.value = draft.email;
    calendar.setSelected(draft.days.map((d) => d.date));
    showErrors = false;
    applyErrors([]);
    renderDays();
    toast('Ihre Änderungen wurden verworfen.', 'info');
    submitBtn.focus();
  }

  // --- Fehlermeldungen ---

  function setFieldError(control, errorEl, message) {
    errorEl.textContent = message;
    errorEl.hidden = !message;
    if (message) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
  }

  function setDaysError(message) {
    daysError.textContent = message;
    daysError.hidden = !message;
  }

  function applyErrors(errors) {
    for (const { control, errorEl } of Object.values(fields)) setFieldError(control, errorEl, '');
    setDaysError('');
    for (const ref of dayRefs.values()) {
      ref.error.textContent = '';
      ref.error.hidden = true;
      ref.item.classList.remove('evt-day-invalid');
      ref.start.removeAttribute('aria-invalid');
      ref.end.removeAttribute('aria-invalid');
    }
    for (const err of errors) {
      if (err.key === 'days') setDaysError(err.message);
      else if (err.key.startsWith('day:')) {
        const ref = dayRefs.get(err.key.slice(4));
        if (!ref) continue;
        ref.error.textContent = err.message;
        ref.error.hidden = false;
        ref.item.classList.add('evt-day-invalid');
        for (const f of err.fields || []) ref[f].setAttribute('aria-invalid', 'true');
      } else if (fields[err.key]) setFieldError(fields[err.key].control, fields[err.key].errorEl, err.message);
    }
    renderSummary(errors);
    return errors;
  }

  function focusError(err) {
    if (err.key === 'days') {
      calendar.focusDay();
      return;
    }
    if (err.key.startsWith('day:')) {
      const ref = dayRefs.get(err.key.slice(4));
      ref?.[err.fields?.[0] || 'start']?.focus();
      return;
    }
    fields[err.key]?.control.focus();
  }

  function renderSummary(errors) {
    if (!errors.length) {
      summary.hidden = true;
      mount(summary);
      return;
    }
    summary.hidden = false;
    mount(
      summary,
      h('p', { id: 'evt-summary-title' }, h('strong', {}, errors.length === 1 ? 'Bitte prüfen Sie diese Angabe:' : `Bitte prüfen Sie diese ${errors.length} Angaben:`)),
      h(
        'ul',
        { class: 'evt-summary-list' },
        errors.map((err) => h('li', {}, h('button', { type: 'button', class: 'evt-summary-link', onclick: () => focusError(err) }, `${err.label}: ${err.message}`))),
      ),
    );
  }

  // --- Aktionen ---

  function onCalendarChange(dates) {
    const byDate = new Map(draft.days.map((d) => [d.date, d]));
    // Neuer Tag übernimmt die Zeiten des letzten vorhandenen Tages (sofern gültig), sonst 14:00–18:00.
    const last = draft.days[draft.days.length - 1];
    const lastOk = last && toMinutes(last.end) > toMinutes(last.start);
    const template = lastOk ? { start: last.start, end: last.end } : { start: DEFAULT_START, end: DEFAULT_END };
    draft.days = dates.map((date) => byDate.get(date) || { date, ...template });
    renderDays();
  }

  function removeDay(date) {
    const index = draft.days.findIndex((d) => d.date === date);
    draft.days = draft.days.filter((d) => d.date !== date);
    calendar.setSelected(draft.days.map((d) => d.date));
    renderDays();
    // Fokus auf den nächsten Tag (bzw. die Überschrift), damit Tastaturnutzer nicht „verloren“ gehen.
    const nextDay = draft.days[Math.min(index, draft.days.length - 1)];
    if (nextDay) dayRefs.get(nextDay.date)?.remove.focus();
    else document.getElementById('evt-list-title')?.focus();
  }

  function copyFirstTimes() {
    const [first, ...rest] = draft.days;
    if (!first) return;
    if (dayProblem(first, null)) {
      toast(`Bitte legen Sie zuerst gültige Uhrzeiten für ${formatDateWithWeekday(first.date)} fest.`, 'warning');
      dayRefs.get(first.date)?.start.focus();
      return;
    }
    for (const day of rest) {
      day.start = first.start;
      day.end = first.end;
      const ref = dayRefs.get(day.date);
      if (ref) {
        ref.start.value = first.start;
        ref.end.value = first.end;
      }
    }
    refresh();
    toast(`Die Zeiten ${first.start}–${first.end} Uhr gelten jetzt für alle Tage.`, 'success');
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (busy || finished) return;
    showErrors = true;
    const errors = applyErrors(validateDraft(draft));
    if (errors.length) {
      summary.focus();
      return;
    }
    busy = true;
    submitBtn.disabled = true;
    try {
      if (isSettings) await saveSettings();
      else saveNewEvent();
    } catch (err) {
      console.error(err);
      toast(`Speichern fehlgeschlagen. ${friendlyError(err)}`, 'error', 8000);
    } finally {
      busy = false;
      submitBtn.disabled = false;
    }
  }

  function saveNewEvent() {
    const event = eventFromDraft(draft);
    const email = draft.email.trim();
    updateState((s) => {
      s.event = event;
      s.teacher.email = email;
    });
    clearEventDraft(saved);
    finished = true;
    setDraftPending(false);
    markEmptyDevice(saved.teacher.teacherCode, false);
    toast('Ihr Elternsprechtag wurde erstellt. Legen Sie jetzt Ihre Klassen an.', 'success');
    navigate('/lehrkraft/klassen');
  }

  async function saveSettings() {
    const event = eventFromDraft(draft);
    const email = draft.email.trim();
    const current = getCurrentState() || saved;
    const newDates = new Set(event.days.map((d) => d.date));
    const removed = new Set((current.event?.days || []).map((d) => d.date).filter((d) => !newDates.has(d)));

    // Termine auf entfernten Tagen
    const affected = [];
    for (const cls of current.classes) {
      for (const st of cls.students) {
        if (st.appointment && removed.has(st.appointment.date)) affected.push({ cls, st });
      }
    }
    if (affected.length) {
      const n = affected.length;
      const shown = affected.slice(0, 6);
      const ok = await confirmDialog({
        title: 'Geplante Termine löschen?',
        message: h(
          'div',
          { class: 'stack-small' },
          h('p', {}, `Auf ${removed.size === 1 ? 'dem entfernten Tag' : 'den entfernten Tagen'} ${n === 1 ? 'liegt bereits 1 geplanter Termin' : `liegen bereits ${n} geplante Termine`}. Wenn Sie speichern, ${n === 1 ? 'wird dieser Termin' : 'werden diese Termine'} gelöscht und ${n === 1 ? 'muss' : 'müssen'} neu geplant werden.`),
          h(
            'ul',
            { class: 'evt-affected' },
            shown.map(({ cls, st }) => h('li', {}, `${st.firstName} ${st.lastName} (Klasse ${cls.id}) – ${formatDate(st.appointment.date)}, ${st.appointment.start} Uhr`)),
            n > shown.length ? h('li', {}, `… und ${n - shown.length} weitere`) : null,
          ),
        ),
        confirmText: n === 1 ? 'Speichern und Termin löschen' : 'Speichern und Termine löschen',
        cancelText: 'Abbrechen',
        danger: true,
      });
      if (!ok) return;
    }

    const eventChanged = JSON.stringify(current.event) !== JSON.stringify(event) || (current.teacher.email || '') !== email;
    saved = updateState((s) => {
      s.event = event;
      s.teacher.email = email;
      for (const cls of s.classes) {
        for (const st of cls.students) {
          if (st.appointment && removed.has(st.appointment.date)) st.appointment = null;
        }
      }
    });
    savedSignature = draftSignature(draftFromState(saved));
    updateDirty();

    toast('Einstellungen gespeichert.', 'success');
    if (affected.length) toast(`${plural(affected.length, 'Termin wurde', 'Termine wurden')} gelöscht.`, 'warning');
    const outside = countOutsideAppointments(saved);
    if (outside) toast(`${plural(outside, 'geplanter Termin liegt', 'geplante Termine liegen')} jetzt außerhalb der Uhrzeiten. Bitte prüfen Sie diese unter „Gespräche terminieren“.`, 'warning', 9000);
    if (eventChanged && saved.classes.some((c) => c.codesGenerated)) {
      toast('Bitte erstellen Sie die Elternbriefe neu, damit die Eltern die geänderten Angaben erhalten.', 'warning', 9000);
    }
  }

  async function onDeleteAll(e) {
    if (ignoreRepeat(e) || deleteAllBtn.getAttribute('aria-disabled') === 'true') return;
    // Digitaler Briefkasten: wird vorher geleert (best effort), damit keine Kopien auf dem Server bleiben.
    const withMailbox = hasTeacherMailbox(getCurrentState() || saved);
    const withCloud = Boolean(loadCloudConfig(saved.teacher.teacherCode));
    const cloudConnected = isCloudConnected(saved.teacher.teacherCode);
    const content = h(
      'div',
      { class: 'stack-small' },
      h('p', {}, 'Ihr Elternsprechtag, alle Klassen, Lernenden, Rückmeldungen und Termine werden endgültig aus diesem Browser gelöscht. Das lässt sich nicht rückgängig machen.'),
      withMailbox
        ? h(
            'p',
            { 'data-testid': 'delete-all-mailbox-note' },
            'Auch Ihr digitaler Briefkasten wird geleert: Rückmeldungen, die dort noch liegen, werden vom Server gelöscht. Sind neue darunter, fragt ParentsDay vorher noch einmal nach.',
          )
        : null,
      withCloud
        ? h(
            'p',
            { 'data-testid': 'delete-all-cloud-note' },
            'Ihre Cloud-Sicherung bleibt erhalten: Melden Sie sich wieder an und geben Ihr Passwort ein, ist Ihr Stand wieder da.',
            cloudConnected ? ' Möchten Sie auch sie löschen, nutzen Sie vorher oben „Cloud-Sicherung löschen“.' : '',
          )
        : null,
      alertBox('warning', h('strong', {}, 'Wichtig: '), 'Speichern Sie vorher einen Zwischenstand, wenn Sie die Daten später noch brauchen. Mit dieser Datei können Sie alles wiederherstellen.'),
      h(
        'div',
        {},
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-secondary',
            onclick: (e) => {
              if (ignoreRepeat(e)) return;
              saveBackupNow();
            },
          },
          'Zwischenstand jetzt speichern',
        ),
      ),
    );
    const ok = await confirmDialog({ title: 'Alle Daten in diesem Browser löschen?', message: content, confirmText: 'Endgültig löschen', cancelText: 'Abbrechen', danger: true });
    if (!ok) return;
    let mailboxLeft = false;
    if (withMailbox) {
      setBusy(deleteAllBtn, true, 'Wird gelöscht …');
      mailboxBusy(true);
      let proceed = true;
      let fetched = null;
      try {
        // Zuerst abrufen: Neue Rückmeldungen stehen in keinem früher gespeicherten Zwischenstand und
        // gingen sonst unbemerkt verloren. Scheitert der Abruf, bleibt der Briefkasten unverändert.
        fetched = await fetchMailboxResponses();
        showFetched();
        if (fetched.applied.length || unmatchedResponses(fetched).length) proceed = await confirmNewBeforeDelete(fetched);
        // Nur löschen, was abgeholt wurde – was inzwischen eingegangen ist, bleibt (lesbar mit dem Zwischenstand).
        if (proceed) await clearTeacherMailbox({ upTo: fetched.newest });
      } catch (err) {
        // Abruf oder Leeren gescheitert (meist nicht erreichbar): trotzdem löschen – im Briefkasten liegen nur
        // verschlüsselte Kopien, die sich mit dem Zwischenstand später noch abrufen bzw. leeren lassen.
        console.warn(err);
        mailboxLeft = true;
      }
      if (!proceed) {
        setBusy(deleteAllBtn, false);
        mailboxBusy(false);
        toast(fetched?.applied.length ? 'Es wurde nichts gelöscht. Die neuen Rückmeldungen wurden in ParentsDay übernommen.' : 'Es wurde nichts gelöscht.', 'info');
        return;
      }
    }
    // Die Verbindung zur Cloud-Sicherung gehört zu den Daten dieses Browsers – sie wird mit entfernt.
    stopCloudSync();
    endCloudSession(saved.teacher.teacherCode);
    forgetCloudOnDevice(saved.teacher.teacherCode);
    clearEventDraft(saved);
    setDraftPending(false);
    deleteTeacherState(saved.teacher.teacherCode);
    clearSession();
    toast('Ihre Daten wurden aus diesem Browser gelöscht.', 'success');
    if (mailboxLeft) {
      toast(
        'Der digitale Briefkasten war nicht erreichbar und konnte nicht geleert werden. Die Rückmeldungen darin bleiben verschlüsselt – lesen kann sie nur, wer Ihren Schlüssel hat. Mit Ihrem Zwischenstand können Sie den Briefkasten später noch leeren.',
        'warning',
        12000,
      );
    }
    navigate('/');
  }

  /** Rückfrage, wenn beim Löschen aller Daten eben noch neue Rückmeldungen abgerufen wurden. */
  function confirmNewBeforeDelete(fetched) {
    const unmatched = unmatchedResponses(fetched);
    const n = fetched.applied.length + unmatched.length;
    return confirmDialog({
      title: 'Neue Rückmeldungen eingegangen',
      message: h(
        'div',
        { class: 'stack-small', 'data-testid': 'delete-all-new-responses' },
        h('p', {}, `Im digitalen Briefkasten ${n === 1 ? 'lag noch 1 neue Rückmeldung' : `lagen noch ${n} neue Rückmeldungen`}. Beim Löschen ${n === 1 ? 'geht sie' : 'gehen sie'} verloren:`),
        responseList([...fetched.applied.map((a) => ({ name: a.name, classId: a.classId })), ...unmatched]),
        fetched.applied.length
          ? [
              h(
                'p',
                {},
                `Wenn Sie die Daten noch brauchen, speichern Sie jetzt einen Zwischenstand. Er enthält ${fetched.applied.length === 1 ? 'die neue Rückmeldung' : 'die neuen Rückmeldungen'}.`,
                unmatched.length ? ' Rückmeldungen, die zu keinem Kind in diesem Browser passen, enthält er nicht.' : null,
              ),
              h('div', {}, h('button', { type: 'button', class: 'btn btn-secondary', onclick: (e) => ignoreRepeat(e) || saveBackupNow() }, 'Zwischenstand jetzt speichern')),
            ]
          : h('p', {}, n === 1 ? 'Diese Rückmeldung passt zu keinem Kind in diesem Browser. Brechen Sie ab, wenn Sie sie noch brauchen.' : 'Diese Rückmeldungen passen zu keinem Kind in diesem Browser. Brechen Sie ab, wenn Sie sie noch brauchen.'),
      ),
      confirmText: 'Endgültig löschen',
      cancelText: 'Abbrechen',
      danger: true,
    });
  }

  // --- Digitaler Briefkasten (nur mit MAILBOX_URL) ---

  /** Zeigt am Knopf, dass gerade etwas läuft. Nicht „disabled“, damit der Tastaturfokus bleibt. */
  function setBusy(btn, on, busyText) {
    if (on) {
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.setAttribute('aria-disabled', 'true');
      btn.classList.add('evt-busy');
      mount(btn, h('span', { class: 'spinner evt-spinner', 'aria-hidden': 'true' }), busyText);
    } else {
      btn.removeAttribute('aria-disabled');
      btn.classList.remove('evt-busy');
      if (btn.dataset.label) mount(btn, btn.dataset.label);
    }
  }

  let mailboxRunning = false;
  const mailboxStatus = h('div', { class: 'evt-mailbox-status', 'data-testid': 'mailbox-status', 'aria-live': 'polite' });
  const checkBtn = h('button', { type: 'button', class: 'btn btn-secondary', 'data-testid': 'mailbox-check', onclick: onCheckMailbox }, 'Verbindung prüfen');
  const clearBtn = h('button', { type: 'button', class: 'btn btn-secondary', 'data-testid': 'mailbox-clear', onclick: onClearMailbox }, 'Briefkasten leeren');
  const fetchedValue = h('dd', { 'data-testid': 'mailbox-fetched' });

  /** Sperrt die Briefkasten-Knöpfe, solange eine Anfrage läuft. */
  function mailboxBusy(on) {
    mailboxRunning = on;
    for (const btn of [checkBtn, clearBtn]) {
      if (on) btn.setAttribute('aria-disabled', 'true');
      else btn.removeAttribute('aria-disabled');
    }
  }

  function showMailboxStatus(node) {
    mount(mailboxStatus, node);
  }

  function showFetched() {
    fetchedValue.textContent = formatTimestamp(getCurrentState()?.mailbox?.lastFetchedAt || '') || 'noch nie';
  }

  async function onCheckMailbox(e) {
    if (ignoreRepeat(e) || mailboxRunning) return;
    mailboxBusy(true);
    setBusy(checkBtn, true, 'Wird geprüft …');
    showMailboxStatus(null);
    try {
      const ok = await checkMailboxService();
      if (!ok) throw new Error('Der digitale Briefkasten antwortet nicht wie erwartet.');
      showMailboxStatus(
        alertBox('success', h('strong', {}, 'Verbindung in Ordnung. '), `Der digitale Briefkasten ist erreichbar (geprüft um ${nowParts().time} Uhr).`),
      );
    } catch (err) {
      console.warn(err);
      showMailboxStatus(
        alertBox(
          'error',
          h('p', {}, h('strong', {}, 'Verbindung fehlgeschlagen. '), friendlyError(err, 'Der digitale Briefkasten ist gerade nicht erreichbar.')),
          h(
            'p',
            {},
            'Bereits eingegangene Rückmeldungen bleiben im Briefkasten erhalten. Solange er nicht erreichbar ist, können Eltern ihre Rückmeldung per E-Mail schicken. Besteht das Problem weiter, wenden Sie sich an die Person, die ParentsDay an Ihrer Schule betreut.',
          ),
        ),
      );
    } finally {
      setBusy(checkBtn, false);
      mailboxBusy(false);
    }
  }

  async function onClearMailbox(e) {
    if (ignoreRepeat(e) || mailboxRunning) return;
    const ok = await confirmDialog({
      title: 'Briefkasten leeren?',
      message: h(
        'div',
        { class: 'stack-small' },
        h('p', {}, 'Alle Rückmeldungen im digitalen Briefkasten werden vom Server gelöscht. Neue Rückmeldungen, die noch nicht abgeholt wurden, übernimmt ParentsDay vorher.'),
        h('p', {}, 'Zeiten, die bereits in ParentsDay übernommen wurden, bleiben erhalten. Eltern können auch danach noch Rückmeldungen schicken.'),
        h('p', { class: 'muted' }, 'Empfohlen nach dem Elternsprechtag.'),
      ),
      confirmText: 'Briefkasten leeren',
      cancelText: 'Abbrechen',
      danger: true,
    });
    if (!ok) return;
    mailboxBusy(true);
    setBusy(clearBtn, true, 'Wird geleert …');
    showMailboxStatus(null);
    let fetched = null;
    // Hinweis, wie viele Rückmeldungen dabei übernommen wurden (auch wenn danach etwas scheitert)
    const appliedNote = (before) => {
      const n = fetched?.applied.length || 0;
      if (!n) return null;
      return h('p', {}, before ? `Vorher ${n === 1 ? 'wurde 1 neue Rückmeldung' : `wurden ${n} neue Rückmeldungen`} in ParentsDay übernommen.` : `${n === 1 ? '1 neue Rückmeldung wurde' : `${n} neue Rückmeldungen wurden`} in ParentsDay übernommen.`);
    };
    try {
      // Zuerst abholen, damit keine neue Rückmeldung verloren geht. Scheitert das (z. B. Speicher voll),
      // wird nicht gelöscht.
      fetched = await fetchMailboxResponses();
      showFetched();
      // Rückmeldungen, die zu keinem Kind passen, stehen nicht in ParentsDay – vor dem Löschen nachfragen.
      const unmatched = unmatchedResponses(fetched);
      if (unmatched.length && !(await confirmClearUnmatched(unmatched))) {
        showMailboxStatus(alertBox('info', h('p', {}, h('strong', {}, 'Der Briefkasten wurde nicht geleert. '), 'Die Rückmeldungen bleiben darin.'), appliedNote(false)));
        return;
      }
      // Nur löschen, was abgeholt wurde: Rückmeldungen, die während der Rückfrage eingehen, bleiben im Briefkasten.
      const deleted = await clearTeacherMailbox({ upTo: fetched.newest });
      showMailboxStatus(
        alertBox(
          'success',
          h('p', {}, h('strong', {}, 'Der Briefkasten wurde geleert. '), deleted ? `${plural(deleted, 'Rückmeldung wurde', 'Rückmeldungen wurden')} vom Server gelöscht.` : 'Es lagen keine Rückmeldungen darin.'),
          appliedNote(true),
        ),
      );
    } catch (err) {
      console.warn(err);
      showMailboxStatus(
        alertBox('error', h('p', {}, h('strong', {}, 'Der Briefkasten konnte nicht geleert werden. '), friendlyError(err, 'Bitte versuchen Sie es später noch einmal.')), appliedNote(false)),
      );
    } finally {
      setBusy(clearBtn, false);
      mailboxBusy(false);
    }
  }

  /** Rückfrage vor dem Leeren, wenn Rückmeldungen im Briefkasten zu keinem Kind in ParentsDay passen. */
  function confirmClearUnmatched(unmatched) {
    const n = unmatched.length;
    return confirmDialog({
      title: 'Nicht zugeordnete Rückmeldungen löschen?',
      message: h(
        'div',
        { class: 'stack-small', 'data-testid': 'mailbox-unmatched' },
        h('p', {}, `${n === 1 ? '1 Rückmeldung im Briefkasten passt' : `${n} Rückmeldungen im Briefkasten passen`} zu keinem Kind in ParentsDay, zum Beispiel weil die Klasse in diesem Browser nicht angelegt ist:`),
        responseList(unmatched),
        h(
          'p',
          {},
          `Wenn Sie den Briefkasten jetzt leeren, ${n === 1 ? 'geht sie' : 'gehen sie'} verloren. Legen Sie vorher die Klasse bzw. das Kind an oder laden Sie Ihren aktuellen Zwischenstand – dann ${n === 1 ? 'wird sie' : 'werden sie'} beim nächsten Abruf übernommen.`,
        ),
      ),
      confirmText: 'Trotzdem leeren',
      cancelText: 'Abbrechen',
      danger: true,
    });
  }

  /** Karte „Digitaler Briefkasten“. Ohne eingerichteten Dienst gibt es sie nicht. */
  function mailboxCard() {
    if (!mailboxEnabled()) return null;
    const mb = hasTeacherMailbox(saved) ? saved.mailbox : null;
    const head = h(
      'div',
      { class: 'evt-mailbox-head' },
      h('h2', { id: 'evt-mailbox-title' }, 'Digitaler Briefkasten'),
      mb ? h('span', { class: 'badge badge-success' }, 'Aktiv') : h('span', { class: 'badge' }, 'Noch nicht eingerichtet'),
    );
    if (!mb) {
      return h(
        'section',
        { class: 'card evt-mailbox', 'aria-labelledby': 'evt-mailbox-title', 'data-testid': 'mailbox-card' },
        head,
        h('p', { 'data-testid': 'mailbox-pending' }, 'Wird automatisch eingerichtet, wenn Sie Elternbriefe erstellen.'),
        h('p', { class: 'muted small' }, 'Danach schicken die Eltern ihre Rückmeldung mit einem Klick auf „Absenden“ direkt an Sie – Ende-zu-Ende-verschlüsselt, nur Sie können sie lesen. Der Weg per E-Mail bleibt als Notlösung erhalten.'),
        // Briefe von früher enthalten noch keinen Briefkasten (QR-Code ohne Briefkasten-Angaben).
        lettersClasses.length
          ? h('p', {}, `Die Elternbriefe für ${classList(lettersClasses)} enthalten noch keinen Briefkasten. Erstellen Sie sie neu, wenn die Eltern ihn nutzen sollen – sonst schicken sie ihre Rückmeldung wie bisher per E-Mail.`)
          : null,
      );
    }
    const since = mb.createdAt && !Number.isNaN(Date.parse(mb.createdAt)) ? nowParts(new Date(mb.createdAt)).date : '';
    showFetched();
    return h(
      'section',
      { class: 'card evt-mailbox', 'aria-labelledby': 'evt-mailbox-title', 'data-testid': 'mailbox-card' },
      head,
      h('p', {}, 'Eltern schicken ihre Rückmeldung mit „Absenden“ direkt an Sie. Die Zeiten erscheinen automatisch in der Tabelle der Klasse.'),
      h(
        'dl',
        { class: 'evt-profile evt-mailbox-facts' },
        since ? h('div', { class: 'evt-profile-row' }, h('dt', {}, 'Aktiv seit'), h('dd', { 'data-testid': 'mailbox-since' }, since)) : null,
        h('div', { class: 'evt-profile-row' }, h('dt', {}, 'Zuletzt abgerufen'), fetchedValue),
      ),
      alertBox(
        'info',
        isCloudConnected(saved.teacher.teacherCode)
          ? h(
              'p',
              {},
              h('strong', {}, 'Ende-zu-Ende-verschlüsselt: '),
              'Nur Sie können die Rückmeldungen lesen. Der Schlüssel dazu steckt in Ihrem Stand – und damit auch in Ihrer Cloud-Sicherung. An einem anderen Gerät ist er nach der Anmeldung mit Passwort automatisch da.',
            )
          : [
              h('p', {}, h('strong', {}, 'Ende-zu-Ende-verschlüsselt: '), 'Nur Sie können die Rückmeldungen lesen. Der Schlüssel dazu steckt in Ihrem Browser und in Ihrem Zwischenspeicher – ohne ihn sind die Rückmeldungen nicht lesbar.'),
              h('p', {}, 'Speichern Sie deshalb einen Zwischenstand, bevor Sie die Browserdaten löschen oder das Gerät wechseln.'),
            ],
      ),
      h('div', { class: 'evt-mailbox-actions' }, checkBtn, clearBtn),
      h('p', { class: 'muted small' }, '„Briefkasten leeren“ löscht nur die Kopien auf dem Server. Übernommene Zeiten bleiben in ParentsDay. Empfohlen nach dem Elternsprechtag.'),
      mailboxStatus,
    );
  }

  // --- Seite zusammensetzen ---

  const lettersClasses = saved.classes.filter((c) => c.codesGenerated).map((c) => c.id);
  // Neues Gerät: dauerhafter Hinweis mit eigenem Knopf „Zwischenstand laden“ (statt eines kurzen Toasts)
  const emptyDeviceHint =
    !isSettings && saved.classes.length === 0 && isEmptyDevice(saved.teacher.teacherCode)
      ? alertBox(
          'info',
          h(
            'div',
            { class: 'evt-empty-device' },
            h('p', {}, h('strong', {}, 'Auf diesem Gerät sind noch keine Daten gespeichert. '), 'Falls Sie schon an einem anderen Gerät gearbeitet haben, laden Sie hier Ihren Zwischenstand – dann müssen Sie nichts neu eingeben.'),
            h('button', { type: 'button', class: 'btn btn-secondary', 'data-testid': 'empty-device-load', onclick: () => openLoadBackupDialog({ navigate }) }, 'Zwischenstand laden'),
          ),
        )
      : null;
  const t = saved.teacher;
  const profileRow = (label, value) => h('div', { class: 'evt-profile-row' }, h('dt', {}, label), h('dd', {}, value));
  const deleteAllBtn = h('button', { type: 'button', class: 'btn btn-danger', onclick: onDeleteAll }, 'Alle Daten in diesem Browser löschen');

  mount(
    root,
    h(
      'div',
      { class: 'evt-page' },
      isSettings ? h('a', { class: 'back-link', href: '#/lehrkraft/klassen' }, 'Zurück zu den Klassen') : null,
      h(
        'div',
        { class: 'page-header' },
        h(
          'div',
          {},
          h('h1', {}, isSettings ? 'Weitere Einstellungen' : 'Elternsprechtag erstellen'),
          h(
            'p',
            { class: 'subtitle' },
            isSettings
              ? 'Hier ändern Sie die Tage, Uhrzeiten, die Adresse der Schule, die Terminlänge und Ihre E-Mail-Adresse.'
              : 'Wählen Sie im Kalender den Tag bzw. die Tage des Elternsprechtags aus und legen Sie für jeden Tag die Anfangs- und die Endzeit fest.',
          ),
        ),
      ),
      emptyDeviceHint,
      isSettings && lettersClasses.length
        ? alertBox(
            'warning',
            h('p', {}, h('strong', {}, 'Elternbriefe wurden bereits erstellt.')),
            h(
              'p',
              {},
              `Für ${classList(lettersClasses)} wurden bereits Codes und Elternbriefe erstellt. Bereits verteilte Elternbriefe und QR-Codes enthalten die bisherigen Tage, Uhrzeiten und die bisherige Terminlänge. Wenn Sie hier etwas ändern, erstellen Sie die Elternbriefe danach bitte neu und verteilen Sie sie erneut.`,
            ),
          )
        : null,
      form,
      isSettings ? cloudSettingsCard(saved.teacher) : null,
      isSettings ? mailboxCard() : null,
      isSettings
        ? h(
            'div',
            { class: 'grid-2 evt-extra' },
            h(
              'section',
              { class: 'card', 'aria-labelledby': 'evt-profile-title' },
              h('h2', { id: 'evt-profile-title' }, 'Ihr Profil'),
              h(
                'dl',
                { class: 'evt-profile' },
                profileRow('Name', `${t.firstName} ${t.lastName}`),
                profileRow('Geburtsdatum', t.birthDate ? formatDate(t.birthDate) : '–'),
                profileRow('Registrierungscode', h('span', { class: 'code' }, t.registrationCode || '–')),
                profileRow('Lehrkräftecode', h('span', { class: 'code' }, t.teacherCode)),
              ),
              h('p', { class: 'muted small' }, 'Diese Angaben stammen aus Ihrer Registrierung und können nicht geändert werden, weil Ihre Codes daraus berechnet werden.'),
            ),
            h(
              'section',
              { class: 'card evt-danger', 'aria-labelledby': 'evt-danger-title' },
              h('h2', { id: 'evt-danger-title' }, 'Gefahrenbereich'),
              h('p', {}, 'Entfernt Ihren Elternsprechtag, alle Klassen, Lernenden, Rückmeldungen und Termine aus diesem Browser. Anschließend werden Sie abgemeldet.'),
              h('p', { class: 'muted small' }, 'Tipp: Speichern Sie vorher einen Zwischenstand, damit Sie Ihre Daten bei Bedarf wiederherstellen können.'),
              deleteAllBtn,
            ),
          )
        : null,
    ),
  );
  renderDays();
  // Beim Verlassen der Seite gilt der Hinweis „noch nicht gespeichert“ in der Kopfzeile nicht mehr.
  return () => setDraftPending(false);
}

/** Zählt geplante Termine, die nicht mehr in die Uhrzeiten ihres Tages passen. */
function countOutsideAppointments(state) {
  const days = new Map((state.event?.days || []).map((d) => [d.date, d]));
  let count = 0;
  for (const cls of state.classes) {
    for (const st of cls.students) {
      const a = st.appointment;
      const day = a && days.get(a.date);
      if (!day) continue;
      const s = toMinutes(a.start);
      if (s < toMinutes(day.start) || s + (Number(a.duration) || 0) > toMinutes(day.end)) count++;
    }
  }
  return count;
}
