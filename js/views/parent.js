// Elternzugang: Anmeldung mit Vorname, Nachname und Code des Kindes, freie Zeitslots grün markieren,
// „Absenden“ (Rückmelde-PDF herunterladen) und vorbereitete E-Mail an die Lehrkraft.
// Die Termindaten kommen aus dem Link des Elternbriefs (#/eltern?e=…) oder aus dem Termin-Schlüssel.
// Alles bleibt im Browser der Eltern (loadParentState/saveParentState), es gibt keinen Server.

import { h, mount, toast, field, alertBox, copyToClipboard, confirmDialog } from '../core/ui.js';
import { loadParentState, saveParentState, clearParentState } from '../core/storage.js';
import { decodeEventParam, decodeEventKey, buildResponsePayload, encodeResponseText } from '../core/transport.js';
import { checkStudentLogin, cleanName, parseStudentCode, studentNameCode, isValidIsoDate, isValidEmail } from '../core/codes.js';
import { slotStarts, slotsToRanges, formatRanges, formatDateLong, formatDateWithWeekday, formatRange, formatTimestamp, fromMinutes, toMinutes } from '../core/time.js';
import { savePdf, preloadPdf } from '../core/pdf.js';
import { createResponsePdf } from '../pdf/response-pdf.js';

const TIME_RE = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const LINK_ERROR = 'Der Link aus dem Elternbrief ist unvollständig oder beschädigt.';
// Ältere Mailprogramme (z. B. Outlook unter Windows) schneiden sehr lange mailto-Links ab.
const MAILTO_MAX = 2000;

export default function render(ctx) {
  const step = ctx.params?.step;
  if (step === 'times') return renderTimes(ctx);
  if (step === 'done') return renderDone(ctx);
  return renderLogin(ctx);
}

// ---------- Hilfen ----------

function childName(login) {
  return `${login?.firstName || ''} ${login?.lastName || ''}`.trim();
}

/** Klasse und Lehrkräftecode: aus den Termindaten, sonst aus dem Code des Kindes. */
function classInfo(ps) {
  const parsed = parseStudentCode(ps.login?.code || '');
  return {
    classId: ps.event?.classId || parsed?.classId || '',
    teacherCode: ps.event?.teacherCode || parsed?.teacherCode || '',
  };
}

/** Sind die Termindaten verwendbar (echte Kalendertage, Uhrzeiten HH:MM, Ende nach Beginn)? */
function isValidEvent(ev) {
  const slot = Number(ev?.slotMinutes);
  if (!Number.isInteger(slot) || slot <= 0 || slot > 600 || !Array.isArray(ev?.days) || ev.days.length === 0) return false;
  return ev.days.every((d) => d && isValidIsoDate(d.date) && TIME_RE.test(d.start) && TIME_RE.test(d.end) && toMinutes(d.end) > toMinutes(d.start));
}

/** Elternzustand laden; unbrauchbare (z. B. von Hand veränderte) Termindaten werden verworfen. */
function loadState() {
  const ps = loadParentState();
  if (!ps.selection || typeof ps.selection !== 'object') ps.selection = {};
  if (ps.event && !isValidEvent(ps.event)) {
    ps.event = null;
    ps.login = null;
    ps.selection = {};
    clearSubmission(ps);
  }
  return ps;
}

/** Link-Parameter lesen; wirft bei beschädigten Daten immer dieselbe verständliche Meldung. */
function readEventParam(param) {
  let ev;
  try {
    ev = decodeEventParam(param);
  } catch {
    throw new Error(LINK_ERROR);
  }
  if (!isValidEvent(ev)) throw new Error(LINK_ERROR);
  return ev;
}

function expectedFor(event) {
  return { teacherCode: event?.teacherCode || '', classId: event?.classId || '' };
}

/** Gleiche Tage, Uhrzeiten und Slotlänge? */
function sameSchedule(a, b) {
  const key = (ev) => JSON.stringify([Number(ev?.slotMinutes), (ev?.days || []).map((d) => [d.date, d.start, d.end])]);
  return key(a) === key(b);
}

function clearSubmission(ps) {
  delete ps.submittedAt;
  delete ps.lastPayload;
  delete ps.lastFilename;
}

function logout(ps) {
  ps.login = null;
  ps.selection = {};
  clearSubmission(ps);
  // Beim Termin-Schlüssel stammen Klasse und Lehrkräftecode aus dem Code des Kindes.
  if (ps.event?.source === 'key') ps.event = { ...ps.event, classId: '', teacherCode: '' };
}

/** Übernimmt neue Termindaten. Anmeldung und Auswahl bleiben nur erhalten, wenn sie weiterhin passen. */
function adoptEvent(ps, event) {
  const prev = ps.event;
  ps.event = event;
  if (ps.login && !checkStudentLogin(ps.login, expectedFor(event)).ok) {
    logout(ps);
  } else if (!prev || !sameSchedule(prev, event)) {
    ps.selection = {};
    clearSubmission(ps);
  }
}

function slotLength(event) {
  return Number(event?.slotMinutes) || 10;
}

/** Tage mit allen Slot-Anfängen (Minuten). */
function eventDays(event) {
  const slot = slotLength(event);
  return (event?.days || []).map((d) => ({ ...d, starts: slotStarts(d.start, d.end, slot) }));
}

/** Gespeicherte Auswahl, bereinigt auf gültige Slots, je Tag sortiert. */
function cleanSelection(ps, days) {
  const result = {};
  for (const day of days) {
    const valid = new Set(day.starts);
    const list = (ps.selection?.[day.date] || []).map(Number).filter((t) => valid.has(t));
    result[day.date] = [...new Set(list)].sort((a, b) => a - b);
  }
  return result;
}

function schoolLine(address) {
  return String(address || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(', ');
}

function dayText(day) {
  return `${formatDateLong(day.date)} – von ${day.start} bis ${day.end} Uhr`;
}

/** Knopf während einer längeren Aktion sperren und einen Lade-Hinweis zeigen. */
function setBusy(button, busy, busyLabel = '') {
  if (busy) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    mount(button, h('span', { class: 'spinner', 'aria-hidden': 'true' }), busyLabel);
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    mount(button, button.dataset.label || '');
  }
}

function friendlyError(err) {
  const msg = err?.message || String(err || '');
  if (/noch nicht implementiert/i.test(msg)) return 'Diese Funktion steht gerade noch nicht zur Verfügung. Bitte versuchen Sie es später noch einmal.';
  return msg || 'Unbekannter Fehler.';
}

/** Eingabefeld, dessen id zugleich der data-testid ist. */
function input(id, attrs = {}) {
  return h('input', { id, name: id, type: 'text', 'data-testid': id, ...attrs });
}

/** Formularfeld mit Hinweis (per aria-describedby verknüpft). */
function formField(label, control, { hint = '', full = false } = {}) {
  const wrap = field(label, control, { hint });
  if (full) wrap.classList.add('field-full');
  const hintEl = wrap.querySelector('.field-hint');
  if (hintEl) {
    hintEl.id = `${control.id}-hint`;
    control.setAttribute('aria-describedby', hintEl.id);
  }
  // Markierung verschwindet beim Korrigieren (ohne neu zu zeichnen – der Fokus bleibt erhalten).
  control.addEventListener('input', () => control.removeAttribute('aria-invalid'));
  return wrap;
}

/** Kasten mit den Eckdaten des Elternsprechtags (Anmeldeseite). */
function eventCard(event) {
  const title = event.teacherName ? `Elternsprechtag bei ${event.teacherName}` : 'Elternsprechtag';
  const school = schoolLine(event.schoolAddress);
  return h(
    'section',
    { class: 'card parent-event', 'aria-label': 'Ihr Elternsprechtag' },
    h('p', { class: 'parent-event-title' }, title, event.classId ? h('span', { class: 'parent-event-class' }, ` · Klasse ${event.classId}`) : null),
    school ? h('p', { class: 'parent-event-school muted' }, school) : null,
    h(
      'ul',
      { class: 'parent-event-days' },
      (event.days || []).map((d) => h('li', {}, `${formatDateLong(d.date)}, ${formatRange(d.start, d.end)}`)),
    ),
  );
}

// ---------- Schritt 1: Anmeldung ----------

function renderLogin(ctx) {
  const { root, setTitle, navigate } = ctx;
  setTitle('Zugang für Eltern');
  const ps = loadState();

  // Termindaten aus dem Link des Elternbriefs übernehmen und die Adresse bereinigen.
  let linkError = '';
  const param = ctx.query?.get('e');
  if (param !== null && param !== undefined) {
    try {
      adoptEvent(ps, readEventParam(param));
      saveParentState(ps);
    } catch (err) {
      linkError = err.message;
    }
    history.replaceState(null, '', '#/eltern');
  }

  const event = ps.event;
  const content = [];
  content.push(
    h(
      'div',
      { class: 'page-header' },
      h('div', {}, h('h1', {}, 'Zugang für Eltern'), h('p', { class: 'subtitle' }, 'Geben Sie Ihre freien Zeiten für den Elternsprechtag an.')),
    ),
  );
  if (linkError) {
    content.push(
      alertBox(
        'error',
        h('p', {}, h('strong', {}, linkError)),
        h('p', {}, event ? 'Es werden die zuletzt geladenen Termindaten verwendet.' : 'Bitte scannen Sie den QR-Code erneut oder geben Sie unten den Termin-Schlüssel aus dem Elternbrief ein.'),
      ),
    );
  }
  if (event) content.push(eventCard(event));

  if (event && ps.login) content.push(loggedInCard());
  else content.push(loginForm());

  mount(root, h('div', { class: 'parent-page' }, content));

  function loggedInCard() {
    const info = classInfo(ps);
    return h(
      'section',
      { class: 'card stack parent-loggedin' },
      h('h2', {}, 'Angemeldet für ', childName(ps.login)),
      h('p', { class: 'muted' }, info.classId ? `Klasse ${info.classId} · ` : '', 'Code ', h('span', { class: 'code' }, ps.login.code)),
      ps.submittedAt ? alertBox('success', h('p', {}, `Sie haben Ihre Zeiten am ${formatTimestamp(ps.submittedAt)} abgesendet.`)) : null,
      h(
        'div',
        { class: 'parent-actions' },
        h('button', { type: 'button', class: 'btn btn-primary btn-large', 'data-testid': 'parent-continue', onclick: () => navigate('/eltern/zeiten') }, 'Weiter'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-secondary',
            'data-testid': 'parent-switch',
            onclick: async () => {
              const s = loadState();
              const hasTimes = Object.values(s.selection || {}).some((list) => Array.isArray(list) && list.length > 0);
              if (hasTimes || s.lastPayload) {
                const ok = await confirmDialog({
                  title: 'Abmelden?',
                  message: `Die markierten Zeiten für ${childName(s.login)} werden aus diesem Browser gelöscht. Haben Sie die PDF-Datei schon an die Lehrkraft geschickt?`,
                  confirmText: 'Ja, abmelden',
                  cancelText: 'Zurück',
                });
                if (!ok) return;
              }
              logout(s);
              saveParentState(s);
              ctx.rerender();
            },
          },
          'Anderes Kind / abmelden',
        ),
      ),
    );
  }

  function loginForm() {
    const needsKey = !event;
    const first = input('parent-firstname', { autocomplete: 'off', required: true });
    const last = input('parent-lastname', { autocomplete: 'off', required: true });
    const code = input('parent-code', { class: 'parent-code-input', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', required: true });
    const key = needsKey ? input('parent-key', { class: 'parent-code-input', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', required: true, placeholder: 'z. B. 1A2B-3C4D-…' }) : null;
    const errorHost = h('div', { class: 'parent-login-error', 'aria-live': 'polite' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-large btn-block', 'data-testid': 'parent-login' }, 'Anmelden');

    const showError = (message, invalid) => {
      for (const el of [first, last, code, key].filter(Boolean)) {
        if (invalid.includes(el)) el.setAttribute('aria-invalid', 'true');
        else el.removeAttribute('aria-invalid');
      }
      mount(errorHost, alertBox('error', message));
      invalid[0]?.focus();
    };

    const onSubmit = (e) => {
      e.preventDefault();
      const values = { firstName: first.value, lastName: last.value, code: code.value };
      const result = checkStudentLogin(values, needsKey || event.source === 'key' ? {} : expectedFor(event));
      if (!result.ok) {
        showError(result.error, invalidFields(values, { first, last, code }));
        return;
      }
      let ev = event;
      if (needsKey) {
        try {
          ev = decodeEventKey(key.value);
        } catch (err) {
          showError(key.value.trim() ? err.message : 'Bitte geben Sie den Termin-Schlüssel aus dem Elternbrief ein.', [key]);
          return;
        }
      }
      if (ev.source === 'key') ev = { ...ev, classId: result.parsed.classId, teacherCode: result.parsed.teacherCode };
      const s = loadState();
      const login = { firstName: cleanName(values.firstName), lastName: cleanName(values.lastName), code: result.code };
      if (!s.login || s.login.code !== login.code || !s.event || !sameSchedule(s.event, ev)) {
        s.selection = {};
        clearSubmission(s);
      }
      s.event = ev;
      s.login = login;
      saveParentState(s);
      navigate('/eltern/zeiten');
    };

    return h(
      'form',
      { class: 'card stack parent-login', novalidate: true, onsubmit: onSubmit },
      h('h2', {}, 'Anmeldung für Eltern'),
      needsKey
        ? alertBox(
            'info',
            h('p', {}, h('strong', {}, 'Tipp: '), 'Am einfachsten scannen Sie den QR-Code im Elternbrief mit der Kamera Ihres Smartphones. Dann sind die Termine schon eingetragen.'),
          )
        : h('p', { class: 'muted' }, 'Bitte geben Sie die Angaben genau so ein, wie sie im gelben Kasten des Elternbriefs stehen.'),
      h(
        'div',
        { class: 'form-grid' },
        formField('Vorname des Kindes', first),
        formField('Nachname des Kindes', last),
        formField('Code', code, { hint: 'Der Code steht im gelben Kasten des Elternbriefs.', full: true }),
        needsKey
          ? formField('Termin-Schlüssel', key, {
              hint: 'Steht im Elternbrief unter dem gelben Kasten („Ohne QR-Code: Termin-Schlüssel …“). Einfacher ist es, den QR-Code zu scannen.',
              full: true,
            })
          : null,
      ),
      errorHost,
      submit,
      event?.source === 'key'
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-ghost btn-small parent-other-key',
              onclick: () => {
                const s = loadState();
                s.event = null;
                logout(s);
                saveParentState(s);
                ctx.rerender();
              },
            },
            'Anderer Elternsprechtag? Termin-Schlüssel neu eingeben',
          )
        : null,
    );
  }
}

/** Welche Felder bei einer fehlgeschlagenen Anmeldung markiert werden. */
function invalidFields(values, { first, last, code }) {
  const list = [];
  if (!cleanName(values.firstName)) list.push(first);
  if (!cleanName(values.lastName)) list.push(last);
  if (list.length) return list;
  const parsed = parseStudentCode(values.code);
  if (parsed && parsed.nameCode !== studentNameCode(values.firstName, values.lastName)) return [first, last, code];
  return [code];
}

// ---------- Schritt 2: freie Zeiten markieren ----------

/** Spaltenzahl, bei der jede Rasterzeile an einer vollen Stunde beginnt (0 = automatisch). */
function alignedColumns(slot, max) {
  if (!(slot > 0) || 60 % slot !== 0) {
    if (slot > 60 && slot % 60 === 0) return max;
    return 0;
  }
  const perHour = 60 / slot;
  for (let c = max; c >= 2; c--) if (c % perHour === 0 || perHour % c === 0) return c;
  return 0;
}

function renderTimes(ctx) {
  const { root, setTitle, navigate } = ctx;
  const ps = loadState();
  if (!ps.event || !ps.login) {
    navigate('/eltern', { replace: true });
    return undefined;
  }
  setTitle('Ihre freien Zeiten');
  preloadPdf().catch(() => {});

  const event = ps.event;
  const slot = slotLength(event);
  const days = eventDays(event);
  const selection = cleanSelection(ps, days);
  const info = classInfo(ps);
  const views = new Map();

  const persist = () => {
    const s = loadState();
    s.selection = Object.fromEntries(Object.entries(selection).map(([d, list]) => [d, [...list]]));
    saveParentState(s);
  };

  // --- Übersicht ---
  const fact = (label, value, wide = false) => h('div', { class: `parent-fact${wide ? ' parent-fact-wide' : ''}` }, h('dt', {}, label), h('dd', {}, value));
  const overview = h(
    'section',
    { class: 'card parent-overview', 'aria-labelledby': 'parent-overview-title' },
    h('h2', { id: 'parent-overview-title' }, 'Übersicht'),
    h(
      'dl',
      { class: 'parent-facts' },
      fact('Kind', childName(ps.login)),
      info.classId ? fact('Klasse', info.classId) : null,
      event.teacherName ? fact('Lehrkraft', event.teacherName) : null,
      fact('Gesprächsraster', `${slot} Minuten`),
      event.schoolAddress ? fact('Schule', schoolLine(event.schoolAddress), true) : null,
      fact(
        days.length === 1 ? 'Elternsprechtag' : 'Elternsprechtage',
        h(
          'ul',
          { class: 'parent-facts-days' },
          days.map((d) => h('li', {}, dayText(d))),
        ),
        true,
      ),
    ),
  );

  const instruction = alertBox(
    'info',
    h('p', { class: 'parent-instruction' }, 'Bitte markieren Sie alle Zeitslots grün, zu denen Sie Zeit für ein Gespräch hätten. Sie können auch mehrere, voneinander getrennte Zeiträume markieren.'),
    h('p', { class: 'small' }, 'Tippen Sie auf einen Zeitslot, um ihn zu markieren. Ein zweites Tippen hebt die Markierung wieder auf. Am Computer können Sie auch mit gedrückter Maustaste über mehrere Zeitslots ziehen.'),
  );

  const legend = h(
    'div',
    { class: 'legend parent-legend' },
    h('span', {}, h('span', { class: 'legend-swatch parent-swatch-free', 'aria-hidden': 'true' }), 'Zeit für ein Gespräch'),
    h('span', {}, h('span', { class: 'legend-swatch parent-swatch-busy', 'aria-hidden': 'true' }), 'keine Zeit'),
  );

  // --- Absenden ---
  const submitHint = h('p', { class: 'parent-submit-hint', id: 'parent-submit-hint', 'aria-live': 'polite' });
  const submitError = h('div', { 'aria-live': 'polite' });
  const submitBtn = h(
    'button',
    { type: 'button', class: 'btn btn-success btn-large btn-block parent-submit', 'data-testid': 'parent-submit', 'aria-describedby': 'parent-submit-hint', onclick: onSubmit },
    'Absenden',
  );

  const refreshSubmit = () => {
    const total = Object.values(selection).reduce((n, list) => n + list.length, 0);
    submitBtn.disabled = total === 0;
    if (total === 0) {
      submitHint.textContent = 'Bitte markieren Sie zuerst mindestens einen Zeitslot, zu dem Sie Zeit hätten.';
      submitHint.classList.remove('parent-submit-hint-ok');
    } else {
      const rangeCount = days.reduce((n, d) => n + slotsToRanges(selection[d.date], slot).length, 0);
      submitHint.textContent = `Sie haben ${rangeCount === 1 ? '1 Zeitraum' : `${rangeCount} Zeiträume`} markiert. Nach dem Absenden wird eine PDF-Datei mit Ihren Zeiten heruntergeladen.`;
      submitHint.classList.add('parent-submit-hint-ok');
    }
  };

  const refreshDay = (date) => {
    const view = views.get(date);
    if (!view) return;
    const chosen = new Set(selection[date]);
    for (const [t, btn] of view.buttons) {
      const on = chosen.has(t);
      if (btn.getAttribute('aria-pressed') !== String(on)) btn.setAttribute('aria-pressed', String(on));
    }
    const ranges = slotsToRanges(selection[date], slot);
    view.summary.classList.toggle('parent-day-summary-empty', ranges.length === 0);
    view.summary.textContent = ranges.length ? `Ihre Zeiträume: ${formatRanges(ranges)}` : 'Noch keine Zeiten markiert';
  };

  const toggleSlot = (date, start) => {
    const set = new Set(selection[date]);
    if (set.has(start)) set.delete(start);
    else set.add(start);
    selection[date] = [...set].sort((a, b) => a - b);
  };

  const changed = (date) => {
    refreshDay(date);
    refreshSubmit();
    persist();
  };

  // --- Ziehen mit Maus/Stift über mehrere Slots; auf Touch nur Tippen (Scrollen bleibt möglich) ---
  // Beim Ziehen gilt der Modus des ersten Slots für alle Slots vom ersten bis zum aktuellen –
  // so entstehen auch bei schnellen Bewegungen keine Lücken, und Zurückziehen macht es rückgängig.
  let drag = null;
  let pointerHandled = false;
  const slotOf = (target) => target?.closest?.('.parent-slot');
  const endDrag = () => {
    if (!drag) return;
    const { date } = drag;
    drag = null;
    changed(date);
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  const dragTo = (day, t) => {
    const lo = Math.min(drag.anchor, t);
    const hi = Math.max(drag.anchor, t);
    const set = new Set(drag.base);
    for (const s of day.starts) {
      if (s < lo || s > hi) continue;
      if (drag.mode) set.add(s);
      else set.delete(s);
    }
    selection[day.date] = [...set].sort((a, b) => a - b);
    refreshDay(day.date);
  };

  const dayCard = (day) => {
    const buttons = new Map();
    const grid = h('div', { class: 'parent-slots', role: 'group', 'aria-label': `Zeitslots am ${formatDateLong(day.date)}` });
    const colsSm = alignedColumns(slot, 3);
    const colsLg = alignedColumns(slot, 6);
    if (colsSm) grid.style.setProperty('--parent-cols-sm', String(colsSm));
    if (colsLg) grid.style.setProperty('--parent-cols-lg', String(colsLg));
    grid.classList.toggle('parent-slots-aligned', Boolean(colsSm && colsLg));
    for (const t of day.starts) {
      const start = fromMinutes(t);
      const end = fromMinutes(t + slot);
      const btn = h(
        'button',
        { type: 'button', class: 'parent-slot', 'data-testid': `slot-${day.date}-${start}`, 'aria-pressed': 'false', 'aria-label': `${start} bis ${end} Uhr` },
        h('span', { class: 'parent-slot-start' }, start),
        h('span', { class: 'parent-slot-end' }, `–${end}`),
      );
      btn.dataset.start = String(t);
      buttons.set(t, btn);
      grid.appendChild(btn);
    }

    grid.addEventListener('pointerdown', (e) => {
      pointerHandled = false;
      const btn = slotOf(e.target);
      if (!btn || e.pointerType === 'touch' || e.button !== 0) return;
      // Stifte werden sonst am ersten Slot „festgehalten“ – dann kämen keine pointerover-Ereignisse.
      if (btn.hasPointerCapture?.(e.pointerId)) btn.releasePointerCapture(e.pointerId);
      const t = Number(btn.dataset.start);
      const base = new Set(selection[day.date]);
      drag = { date: day.date, mode: !base.has(t), anchor: t, base };
      dragTo(day, t);
      pointerHandled = true;
    });
    grid.addEventListener('pointerover', (e) => {
      if (!drag || drag.date !== day.date) return;
      const btn = slotOf(e.target);
      if (btn) dragTo(day, Number(btn.dataset.start));
    });
    grid.addEventListener('click', (e) => {
      const btn = slotOf(e.target);
      // Mausklicks wurden schon bei pointerdown ausgewertet; Tastatur (detail 0) und Tippen hier.
      if (e.detail !== 0 && pointerHandled) {
        pointerHandled = false;
        return;
      }
      if (!btn) return;
      toggleSlot(day.date, Number(btn.dataset.start));
      changed(day.date);
    });

    const summary = h('p', { class: 'parent-day-summary', 'aria-live': 'polite', 'data-testid': `day-summary-${day.date}` });
    views.set(day.date, { buttons, summary });

    const fillDay = () => {
      selection[day.date] = [...day.starts];
      changed(day.date);
    };
    const clearDay = () => {
      selection[day.date] = [];
      changed(day.date);
    };

    return h(
      'section',
      { class: 'card parent-day', 'aria-labelledby': `parent-day-${day.date}` },
      h(
        'div',
        { class: 'parent-day-head' },
        h('h2', { id: `parent-day-${day.date}` }, formatDateLong(day.date)),
        h('p', { class: 'muted small' }, `${day.start} bis ${day.end} Uhr · ${day.starts.length} Zeitslots à ${slot} Minuten`),
      ),
      day.starts.length
        ? [
            h(
              'div',
              { class: 'parent-day-tools' },
              h('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: fillDay }, 'Ganzen Tag markieren'),
              h('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: clearDay }, 'Auswahl löschen'),
            ),
            grid,
            summary,
          ]
        : h('p', { class: 'muted' }, 'An diesem Tag gibt es keine Zeitslots.'),
    );
  };

  async function onSubmit() {
    if (submitBtn.disabled) return;
    mount(submitError);
    setBusy(submitBtn, true, 'PDF wird erstellt …');
    try {
      const availability = {};
      for (const day of days) availability[day.date] = slotsToRanges(selection[day.date] || [], slot);
      const payload = buildResponsePayload({
        code: ps.login.code,
        firstName: ps.login.firstName,
        lastName: ps.login.lastName,
        classId: info.classId,
        teacherCode: info.teacherCode,
        slotMinutes: slot,
        availability,
      });
      const { doc, filename } = await createResponsePdf(payload, event);
      const saved = savePdf(doc, filename);
      const s = loadState();
      s.selection = Object.fromEntries(Object.entries(selection).map(([d, list]) => [d, [...list]]));
      s.submittedAt = payload.submittedAt;
      s.lastPayload = payload;
      s.lastFilename = saved;
      saveParentState(s);
      navigate('/eltern/fertig');
    } catch (err) {
      setBusy(submitBtn, false);
      refreshSubmit();
      mount(submitError, alertBox('error', h('p', {}, h('strong', {}, 'Die PDF-Datei konnte nicht erstellt werden. '), friendlyError(err))));
    }
  }

  const submitted = ps.submittedAt
    ? alertBox(
        'success',
        h('p', {}, `Sie haben Ihre Zeiten am ${formatTimestamp(ps.submittedAt)} abgesendet. `, h('a', { href: '#/eltern/fertig' }, 'Zur E-Mail an die Lehrkraft')),
        h('p', { class: 'small' }, 'Wenn Sie etwas ändern, klicken Sie danach bitte erneut auf „Absenden“ und schicken Sie die neue PDF-Datei an die Lehrkraft.'),
      )
    : null;

  mount(
    root,
    h(
      'div',
      { class: 'parent-page parent-times' },
      h('a', { class: 'back-link', href: '#/eltern' }, 'Zur Anmeldung'),
      h('div', { class: 'page-header' }, h('div', {}, h('h1', {}, 'Ihre freien Zeiten'), h('p', { class: 'subtitle' }, `für ${childName(ps.login)}${info.classId ? `, Klasse ${info.classId}` : ''}`))),
      submitted,
      overview,
      instruction,
      legend,
      days.map(dayCard),
      h(
        'section',
        { class: 'card stack parent-submit-card', 'aria-label': 'Absenden' },
        h('h2', {}, 'Alle freien Zeiten markiert?'),
        submitHint,
        submitError,
        submitBtn,
      ),
    ),
  );
  for (const day of days) refreshDay(day.date);
  refreshSubmit();

  return () => {
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
  };
}

// ---------- Schritt 3: fertig – PDF per E-Mail schicken ----------

function mailSubject(payload) {
  return `ParentsDay – Rückmeldung für ${childName(payload)}${payload.classId ? ` (Klasse ${payload.classId})` : ''}`;
}

/**
 * E-Mail-Text. `compact` lässt die Zeiten je Tag weg (sie stehen in der PDF-Datei und im Datenblock),
 * damit der mailto-Link auch bei sehr vielen Zeiträumen kurz genug bleibt.
 */
function mailBody(ps, filename, { compact = false } = {}) {
  const p = ps.lastPayload;
  const event = ps.event;
  const lines = [];
  const child = `${childName(p)}${p.classId ? ` (Klasse ${p.classId})` : ''}`;
  lines.push(`(Bitte hängen Sie vor dem Senden die PDF-Datei „${filename}“ an diese E-Mail an.)`, '');
  lines.push(event.teacherName ? `Guten Tag ${event.teacherName},` : 'Guten Tag,', '');
  if (compact) {
    lines.push(`anbei unsere freien Zeiten für den Elternsprechtag für ${child}.`);
    lines.push(`Alle Angaben finden Sie in der angehängten PDF-Datei „${filename}“.`, '');
  } else {
    lines.push(`hier sind unsere freien Zeiten für den Elternsprechtag für ${child}:`, '');
    for (const day of event.days || []) {
      const ranges = p.availability?.[day.date] || [];
      lines.push(`${formatDateWithWeekday(day.date)}: ${ranges.length ? formatRanges(ranges) : 'keine Zeit'}`);
    }
    lines.push('', `Alle Angaben finden Sie auch in der angehängten PDF-Datei „${filename}“.`, '');
  }
  lines.push('Mit freundlichen Grüßen', '', '');
  lines.push('----------------------------------------');
  lines.push('Daten für ParentsDay (bitte nicht verändern):');
  lines.push(encodeResponseText(p));
  return lines.join('\r\n');
}

function mailtoHref(email, subject, body) {
  // Empfänger unverschlüsselt; Leerzeichen und Zeichen, die den Link zerteilen würden, fallen weg.
  const to = String(email || '').replace(/[\s?#&]+/g, '');
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** mailto-Link mit vollständigem Text – bei Überlänge mit der kurzen Fassung. */
function buildMailto(ps, email, subject, filename) {
  const full = mailtoHref(email, subject, mailBody(ps, filename));
  return full.length <= MAILTO_MAX ? full : mailtoHref(email, subject, mailBody(ps, filename, { compact: true }));
}

/** Kann dieser Browser PDF-Dateien teilen (Web Share API, z. B. direkt in die Mail-App)? */
function canShareFiles() {
  try {
    const probe = new File([new Blob(['%PDF-1.4'])], 'ParentsDay.pdf', { type: 'application/pdf' });
    return Boolean(navigator.canShare?.({ files: [probe] }));
  } catch {
    return false;
  }
}

function renderDone(ctx) {
  const { root, setTitle, navigate } = ctx;
  const ps = loadState();
  if (!ps.event || !ps.login) {
    navigate('/eltern', { replace: true });
    return;
  }
  if (!ps.lastPayload) {
    navigate('/eltern/zeiten', { replace: true });
    return;
  }
  setTitle('Fast geschafft');
  const payload = ps.lastPayload;
  const event = ps.event;
  const filename = ps.lastFilename || 'Rückmeldung.pdf';
  const subject = mailSubject(payload);
  const knownEmail = event.teacherEmail || '';
  const teacherLabel = event.teacherName || 'die Lehrkraft';

  // PDF bei Bedarf aus der gespeicherten Rückmeldung neu erzeugen (gleiche Daten wie beim Absenden).
  let pdfPromise = null;
  const getPdf = () => {
    if (!pdfPromise) {
      pdfPromise = createResponsePdf(payload, event).catch((err) => {
        pdfPromise = null;
        throw err;
      });
    }
    return pdfPromise;
  };

  // --- E-Mail ---
  const mailLink = h('a', { class: 'btn btn-primary btn-large parent-mail-btn', 'data-testid': 'parent-mailto' }, 'E-Mail an die Lehrkraft schreiben');
  const updateMailto = (email) => {
    mailLink.setAttribute('href', buildMailto(ps, email, subject, filename));
  };

  let emailField = null;
  if (!knownEmail) {
    const emailInput = h('input', {
      id: 'parent-teacher-email',
      name: 'parent-teacher-email',
      type: 'email',
      inputmode: 'email',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      'data-testid': 'parent-teacher-email',
      value: ps.teacherEmailInput || '',
      placeholder: 'name@schule.de',
    });
    emailInput.addEventListener('input', () => {
      const value = emailInput.value.trim();
      updateMailto(value);
      if (!value || isValidEmail(value)) emailInput.removeAttribute('aria-invalid');
      const s = loadState();
      s.teacherEmailInput = value;
      saveParentState(s);
    });
    // Erst beim Verlassen des Feldes prüfen, nicht bei jedem Tastendruck.
    emailInput.addEventListener('change', () => {
      const value = emailInput.value.trim();
      if (value && !isValidEmail(value)) emailInput.setAttribute('aria-invalid', 'true');
    });
    emailField = field('E-Mail-Adresse der Lehrkraft', emailInput, { hint: 'Die Adresse steht im Elternbrief.' });
    updateMailto(emailInput.value);
  } else {
    updateMailto(knownEmail);
  }

  const copyBtn = knownEmail
    ? h(
        'button',
        {
          type: 'button',
          class: 'btn btn-secondary',
          onclick: async () => {
            const ok = await copyToClipboard(knownEmail);
            toast(ok ? 'E-Mail-Adresse kopiert.' : 'Kopieren hat nicht geklappt. Bitte schreiben Sie die Adresse ab.', ok ? 'success' : 'warning');
          },
        },
        'E-Mail-Adresse kopieren',
      )
    : null;

  // --- Teilen (Web Share API) ---
  // Die Datei wird vorab erzeugt: Safari erlaubt navigator.share() nur direkt im Tipp-Ereignis,
  // ein Warten auf die PDF-Erstellung würde das Teilen dort verhindern.
  let shareBtn = null;
  let shareFile = null;
  const makeShareFile = async () => {
    if (!shareFile) {
      const { doc } = await getPdf();
      shareFile = new File([doc.output('blob')], filename, { type: 'application/pdf' });
    }
    return shareFile;
  };
  if (canShareFiles()) {
    makeShareFile().catch(() => {});
    shareBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn-secondary',
        'data-testid': 'parent-share',
        onclick: async () => {
          try {
            const file = shareFile || (await makeShareFile());
            await navigator.share({ files: [file], title: subject, text: subject });
          } catch (err) {
            if (err?.name === 'AbortError') return;
            toast('Teilen hat nicht geklappt. Bitte verwenden Sie „E-Mail an die Lehrkraft schreiben“.', 'warning');
          }
        },
      },
      'PDF teilen …',
    );
  }

  // --- Erneut herunterladen ---
  const downloadBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-secondary',
      'data-testid': 'parent-download',
      onclick: async () => {
        setBusy(downloadBtn, true, 'PDF wird erstellt …');
        try {
          const { doc } = await getPdf();
          savePdf(doc, filename);
          toast('Die PDF-Datei wurde erneut heruntergeladen.', 'success');
        } catch (err) {
          toast(`Die PDF-Datei konnte nicht erstellt werden. ${friendlyError(err)}`, 'error', 8000);
        } finally {
          setBusy(downloadBtn, false);
        }
      },
    },
    'PDF erneut herunterladen',
  );

  // Wurde die Auswahl nach dem Absenden geändert?
  const slot = slotLength(event);
  const current = cleanSelection(ps, eventDays(event));
  const changedSince = (event.days || []).some(
    (d) => JSON.stringify(slotsToRanges(current[d.date] || [], slot)) !== JSON.stringify(payload.availability?.[d.date] || []),
  );

  // Nummer und Überschrift in einer Zeile, der Inhalt nutzt am Smartphone die volle Breite.
  const step = (num, title, ...children) =>
    h(
      'li',
      { class: 'card parent-step' },
      h('div', { class: 'parent-step-head' }, h('span', { class: 'parent-step-num', 'aria-hidden': 'true' }, num), h('h2', {}, title)),
      h('div', { class: 'parent-step-body stack-small' }, ...children),
    );

  const summaryList = h(
    'ul',
    { class: 'parent-done-times' },
    (event.days || []).map((d) => {
      const ranges = payload.availability?.[d.date] || [];
      return h('li', {}, h('strong', {}, formatDateWithWeekday(d.date)), ': ', ranges.length ? formatRanges(ranges) : h('span', { class: 'muted' }, 'keine Zeit'));
    }),
  );

  const onLogout = async () => {
    const ok = await confirmDialog({
      title: 'Fertig und abmelden?',
      message: 'Ihre markierten Zeiten werden aus diesem Browser gelöscht. Bitte schicken Sie die PDF-Datei vorher per E-Mail an die Lehrkraft.',
      confirmText: 'Ja, abmelden',
      cancelText: 'Zurück',
    });
    if (!ok) return;
    clearParentState();
    navigate('/');
  };

  mount(
    root,
    h(
      'div',
      { class: 'parent-page parent-done' },
      h(
        'div',
        { class: 'parent-done-hero' },
        h('span', { class: 'parent-done-check', 'aria-hidden': 'true' }, '✓'),
        h('h1', {}, 'Fast geschafft!'),
        h('p', { class: 'subtitle' }, `Ihre Zeiten für ${childName(payload)} stehen jetzt in einer PDF-Datei. Es fehlt nur noch die E-Mail an ${teacherLabel}.`),
      ),
      changedSince
        ? alertBox(
            'warning',
            h('p', {}, h('strong', {}, 'Sie haben Ihre Zeiten nach dem Absenden geändert. '), 'Bitte klicken Sie unter „Zeiten ändern“ erneut auf „Absenden“, damit die PDF-Datei aktuell ist.'),
          )
        : null,
      h(
        'ol',
        { class: 'parent-steps' },
        step(
          '1',
          'PDF-Datei gespeichert',
          h('p', {}, 'Die PDF-Datei „', h('strong', { class: 'parent-filename' }, filename), '“ wurde heruntergeladen.'),
          h('p', { class: 'muted small' }, 'Sie finden sie meist im Ordner „Downloads“.'),
          h('div', { class: 'parent-actions' }, downloadBtn),
        ),
        step(
          '2',
          'An die Lehrkraft schicken',
          knownEmail
            ? h('p', {}, `Schicken Sie diese Datei per E-Mail an ${teacherLabel} (`, h('strong', { class: 'parent-email' }, knownEmail), ').')
            : h('p', {}, `Schicken Sie diese Datei per E-Mail an ${teacherLabel}.`),
          emailField,
          alertBox(
            'warning',
            h('p', {}, h('strong', {}, 'Wichtig: '), 'Bitte hängen Sie die PDF-Datei selbst an die E-Mail an (Büroklammer-Symbol) – das geht leider nicht automatisch.'),
          ),
          h('div', { class: 'parent-actions' }, mailLink, shareBtn, copyBtn),
          shareBtn ? h('p', { class: 'muted small' }, '„PDF teilen“ übergibt die Datei direkt an Ihre E-Mail-App. Die Adresse der Lehrkraft tragen Sie dort selbst ein.') : null,
        ),
      ),
      h('section', { class: 'card parent-done-summary', 'aria-labelledby': 'parent-done-summary-title' }, h('h2', { id: 'parent-done-summary-title' }, 'Ihre angegebenen Zeiten'), summaryList),
      h(
        'div',
        { class: 'parent-actions parent-done-links' },
        h('a', { class: 'btn btn-secondary', href: '#/eltern/zeiten' }, 'Zeiten ändern'),
        h('button', { type: 'button', class: 'btn btn-ghost', 'data-testid': 'parent-logout', onclick: onLogout }, 'Fertig – abmelden'),
      ),
    ),
  );
}
