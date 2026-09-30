// Elternzugang: Anmeldung mit Vorname, Nachname und Code des Kindes, freie Zeitslots grün markieren und
// „Absenden“. Mit digitalem Briefkasten (MAILBOX_URL gesetzt und Elternbrief mit Briefkasten) wird die
// Rückmeldung verschlüsselt in den Briefkasten der Lehrkraft gelegt, den ihre Seite abholt. Sonst – und als
// Notlösung, wenn der Briefkasten nicht erreichbar ist – wie bisher: Rückmelde-PDF herunterladen und E-Mail.
// Die Termindaten kommen aus dem Link des Elternbriefs (#/eltern?e=…) oder aus dem Termin-Schlüssel
// (mit Briefkasten zusätzlich aus dem Verzeichnis, das die Lehrkraft unter dem Schlüssel abgelegt hat).
// Der Stand der Eltern bleibt im Browser (loadParentState/saveParentState).
// Jeder Tab hat seinen eigenen Stand: Eltern, die die QR-Codes von Geschwistern in zwei Tabs öffnen,
// schicken so jede Rückmeldung an die richtige Lehrkraft.

import { MAX_EVENT_DAYS, SLOT_MIN, KEY_SLOT_MAX, ADDRESS_MAX_CHARS, ADDRESS_MAX_LINES, NAME_MAX_LENGTH } from '../config.js';
import { h, mount, toast, field, alertBox, copyToClipboard, confirmDialog, isNetworkError, friendlyError as friendlyText } from '../core/ui.js';
import { loadParentState, saveParentState, clearParentState } from '../core/storage.js';
import { decodeEventParam, decodeEventKey, encodeEventKey, eventInfoFromCompact, buildResponsePayload, encodeResponseText } from '../core/transport.js';
import { mailboxEnabled, isValidMailboxRef, sendToMailbox, lookupDirectoryEntry, MailboxError } from '../core/mailbox.js';
import { checkStudentLogin, cleanName, parseStudentCode, studentNameCode, isValidIsoDate, isValidEmail, codesEqual, teacherCodesMatch } from '../core/codes.js';
import { slotStarts, slotsToRanges, formatRanges, formatDateLong, formatDateWithWeekday, formatRange, formatTimestamp, fromMinutes, toMinutes } from '../core/time.js';
import { savePdf, preloadPdf } from '../core/pdf.js';
import { createResponsePdf } from '../pdf/response-pdf.js';

const TIME_RE = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const LINK_ERROR = 'Der Link aus dem Elternbrief ist unvollständig oder beschädigt.';
// Ältere Mailprogramme (z. B. Outlook unter Windows) schneiden sehr lange mailto-Links ab.
const MAILTO_MAX = 2000;
// So lange wird bei der Anmeldung mit Termin-Schlüssel höchstens auf das Verzeichnis gewartet.
const LOOKUP_TIMEOUT_MS = 8000;

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

/**
 * Sind die Termindaten verwendbar? Es gelten dieselben Grenzen wie für die Lehrkraft: 1–8 verschiedene
 * echte Kalendertage, Uhrzeiten HH:MM auf 5 Minuten, Ende nach Beginn, Terminlänge in 5-Minuten-Schritten.
 * (Ein manipulierter Link mit tausenden Zeitslots würde die Seite sonst lahmlegen.)
 */
function isValidEvent(ev) {
  const slot = Number(ev?.slotMinutes);
  if (!Number.isInteger(slot) || slot < SLOT_MIN || slot > KEY_SLOT_MAX || slot % 5 !== 0) return false;
  if (!Array.isArray(ev?.days) || ev.days.length === 0 || ev.days.length > MAX_EVENT_DAYS) return false;
  const dates = new Set();
  return ev.days.every((d) => {
    if (!d || !isValidIsoDate(d.date) || dates.has(d.date) || !TIME_RE.test(d.start) || !TIME_RE.test(d.end)) return false;
    dates.add(d.date);
    const s = toMinutes(d.start);
    const e = toMinutes(d.end);
    return s % 5 === 0 && e % 5 === 0 && e > s;
  });
}

/** Texte aus Link bzw. Speicher auf die Grenzen der Lehrkraft-Formulare kürzen; ungültige E-Mail verwerfen. */
function cleanEvent(ev) {
  const address = String(ev.schoolAddress || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, ADDRESS_MAX_LINES)
    .join('\n')
    .slice(0, ADDRESS_MAX_CHARS);
  const email = String(ev.teacherEmail || '').trim();
  const teacherCode = String(ev.teacherCode || '');
  const classId = String(ev.classId || '').toLowerCase();
  const { mailbox, ...rest } = ev;
  return {
    ...rest,
    teacherName: cleanName(ev.teacherName).slice(0, 2 * NAME_MAX_LENGTH + 1),
    // Nur echte Adressen: sonst könnte ein veränderter Link weitere Empfänger in die E-Mail schmuggeln.
    teacherEmail: isValidEmail(email) ? email : '',
    teacherCode: /^\p{L}\d{1,12}\p{L}$/u.test(teacherCode) ? teacherCode : '',
    schoolAddress: address,
    classId: /^(1[0-3]|[1-9])[a-h]$/.test(classId) ? classId : '',
    // Digitaler Briefkasten nur mit gültiger ID und gültigem Schlüssel – sonst geht die Rückmeldung per E-Mail.
    ...(isValidMailboxRef(mailbox) ? { mailbox: { id: String(mailbox.id), publicKey: String(mailbox.publicKey) } } : {}),
  };
}

/** Kann die Rückmeldung über den digitalen Briefkasten gehen? (Dienst eingerichtet, Elternbrief mit Briefkasten) */
function canUseMailbox(event) {
  return mailboxEnabled() && isValidMailboxRef(event?.mailbox);
}

/** Lehrkraft im Satz: „an Anna Meier“ bzw. „an die Lehrkraft“ … */
function teacherAcc(event) {
  return event?.teacherName || 'die Lehrkraft';
}

/** … und „bei Anna Meier“ bzw. „bei der Lehrkraft“. */
function teacherDat(event) {
  return event?.teacherName || 'der Lehrkraft';
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
  if (ps.event) ps.event = cleanEvent(ps.event);
  // Termindaten aus einem Termin-Schlüssel ohne bekannte Lehrkraft (älterer Stand nach dem Abmelden):
  // Für das nächste Kind wird der Schlüssel neu abgefragt.
  if (ps.event?.source === 'key' && !ps.login && !ps.event.teacherCode) ps.event = null;
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
  return cleanEvent(ev);
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
  delete ps.sentVia;
  delete ps.sentAt;
}

/**
 * Wurde die Rückmeldung in einen anderen Briefkasten geworfen, als ihn die neuen Termindaten nennen
 * (z. B. neuer Elternbrief)? Dann muss sie erneut abgesendet werden – die markierten Zeiten bleiben.
 */
function mailboxChanged(ps, prev, next) {
  return ps.sentVia === 'mailbox' && prev?.mailbox?.id !== next?.mailbox?.id;
}

function logout(ps) {
  ps.login = null;
  ps.selection = {};
  clearSubmission(ps);
  // Die eingetippte Adresse gehört zur Lehrkraft dieses Kindes.
  delete ps.teacherEmailInput;
  delete ps.teacherEmailFor;
  // Beim Termin-Schlüssel bleiben Klasse und Lehrkräftecode des Kindes stehen: Ein Kind aus einem
  // anderen Elternbrief muss dann dessen Termin-Schlüssel eingeben (andere Tage, andere Lehrkraft).
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
  } else if (mailboxChanged(ps, prev, event)) {
    clearSubmission(ps);
  }
}

/**
 * Termin-Schlüssel-Weg mit digitalem Briefkasten: holt die Daten des Elternbriefs (Lehrkraft, Schule,
 * Briefkasten), die die Lehrkraft unter dem Schlüssel abgelegt hat. Übernommen werden sie nur, wenn
 * Lehrkraft, Klasse, Tage, Uhrzeiten und Terminlänge genau zum Schlüssel passen.
 * @returns {Promise<object|null>} Termindaten oder null (nicht gefunden, unpassend, keine Verbindung)
 */
async function findLetterData(keyEvent, owner) {
  // Kanonischer Schlüssel: gleiche Schreibweise wie beim Ablegen, egal wie die Eltern ihn abgetippt haben.
  const eventKey = encodeEventKey(keyEvent, owner);
  if (!eventKey) return null;
  let timer = 0;
  try {
    const raw = await Promise.race([
      lookupDirectoryEntry({ teacherCode: owner.teacherCode, classId: owner.classId, eventKey }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS);
      }),
    ]);
    if (!raw) return null;
    const info = eventInfoFromCompact(raw, 'link');
    if (!isValidEvent(info) || !sameSchedule(info, keyEvent)) return null;
    const ev = cleanEvent(info);
    if (!teacherCodesMatch(ev.teacherCode, owner.teacherCode) || ev.classId !== owner.classId) return null;
    return ev;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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

// Dauert das Senden länger als üblich, beruhigt ein Hinweis am Knopf. Spätestens nach 15 Sekunden
// (Zeitgrenze in core/mailbox.js) erscheint sonst die Meldung mit dem Weg per E-Mail.
const SLOW_MS = 5000;

function slowNotice(button) {
  const timer = setTimeout(() => {
    if (button?.isConnected && button.getAttribute('aria-busy') === 'true') {
      mount(button, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Wird noch gesendet – bitte warten …');
    }
  }, SLOW_MS);
  return () => clearTimeout(timer);
}

function friendlyError(err) {
  const msg = err?.message || String(err || '');
  if (/noch nicht implementiert/i.test(msg)) return 'Diese Funktion steht gerade noch nicht zur Verfügung. Bitte versuchen Sie es später noch einmal.';
  return friendlyText(err);
}

const EMAIL_ADVICE = 'Oder schicken Sie Ihre Zeiten stattdessen als PDF-Datei per E-Mail an die Lehrkraft.';

/**
 * Warum das Senden an den Briefkasten nicht geklappt hat und was die Eltern jetzt tun können.
 * `retry: false` – ein erneuter Versuch hilft voraussichtlich nicht (dann zuerst der Weg per E-Mail).
 */
function sendProblem(err) {
  const later = { retry: true, advice: `Bitte versuchen Sie es gleich noch einmal. ${EMAIL_ADVICE}` };
  const emailOnly = { retry: false, advice: 'Bitte schicken Sie Ihre Zeiten stattdessen als PDF-Datei per E-Mail an die Lehrkraft.' };
  if (err instanceof MailboxError) {
    if (err.status === 429) return { reason: 'Gerade kommen sehr viele Rückmeldungen an.', retry: true, advice: `Bitte warten Sie eine Minute und versuchen Sie es dann noch einmal. ${EMAIL_ADVICE}` };
    if (err.status === 507) return { reason: 'Der Briefkasten der Lehrkraft ist voll.', ...emailOnly };
    if (err.status >= 500) return { reason: 'Der digitale Briefkasten ist gerade gestört.', ...later };
    if (err.status) return { reason: 'Der digitale Briefkasten hat Ihre Rückmeldung nicht angenommen.', ...emailOnly };
    return { reason: err.message || 'Der digitale Briefkasten ist gerade nicht erreichbar.', ...(err.offline ? later : emailOnly) };
  }
  if (isNetworkError(err)) return { reason: friendlyError(err), ...later };
  // Sonst ein Problem in diesem Browser (z. B. Verschlüsselung nicht möglich, Schlüssel im Link beschädigt).
  // Technische Meldungen wie „DataError“ bekommen die Eltern nicht zu sehen.
  return { reason: 'Ihre Rückmeldung konnte in diesem Browser nicht verschlüsselt werden.', ...emailOnly };
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
      ps.submittedAt
        ? alertBox(
            'success',
            h(
              'p',
              {},
              ps.sentVia === 'mailbox'
                ? `Ihre Zeiten sind am ${formatTimestamp(ps.sentAt || ps.submittedAt)} bei ${teacherDat(ps.event)} angekommen.`
                : `Sie haben Ihre Zeiten am ${formatTimestamp(ps.submittedAt)} abgesendet.`,
            ),
          )
        : null,
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
                let question = 'Haben Sie die PDF-Datei schon an die Lehrkraft geschickt?';
                if (s.sentVia === 'mailbox' && s.lastPayload && s.event && changedAfterSubmit(s)) {
                  question = 'Ihre Änderungen nach dem Absenden sind noch nicht bei der Lehrkraft.';
                } else if (s.sentVia === 'mailbox') {
                  question = 'Ihre abgesendete Rückmeldung ist bereits bei der Lehrkraft angekommen.';
                } else if (!s.lastPayload && canUseMailbox(s.event)) {
                  question = 'Haben Sie Ihre Zeiten schon abgesendet?';
                }
                const ok = await confirmDialog({
                  title: 'Abmelden?',
                  message: `Die markierten Zeiten für ${childName(s.login)} werden aus diesem Browser gelöscht. ${question}`,
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
    // Ohne Termindaten wird der Termin-Schlüssel gebraucht; mit Termindaten erscheint das Feld, sobald der
    // Code zu einem anderen Elternbrief gehört (Geschwisterkind) oder die Eltern es selbst öffnen.
    let keyShown = !event;
    const first = input('parent-firstname', { autocomplete: 'off', required: true });
    const last = input('parent-lastname', { autocomplete: 'off', required: true });
    const code = input('parent-code', { class: 'parent-code-input', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', required: true });
    const key = input('parent-key', { class: 'parent-code-input', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', required: true, placeholder: 'z. B. 1A2B-3C4D-…' });
    const keyField = formField('Termin-Schlüssel', key, {
      hint: 'Steht im Elternbrief unter dem gelben Kasten („Ohne QR-Code: Termin-Schlüssel …“). Einfacher ist es, den QR-Code zu scannen.',
      full: true,
    });
    const errorHost = h('div', { class: 'parent-login-error', 'aria-live': 'polite' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-large btn-block', 'data-testid': 'parent-login' }, 'Anmelden');

    const grid = h(
      'div',
      { class: 'form-grid' },
      formField('Vorname des Kindes', first),
      formField('Nachname des Kindes', last),
      formField('Code', code, { hint: 'Der Code steht im gelben Kasten des Elternbriefs.', full: true }),
    );
    // Das Feld steht nur im Formular, wenn es gebraucht wird.
    const setKeyShown = (on) => {
      keyShown = on;
      if (on && !keyField.isConnected) grid.appendChild(keyField);
      if (!on) keyField.remove();
    };
    setKeyShown(keyShown);

    const showError = (message, invalid) => {
      for (const el of [first, last, code, key]) {
        if (invalid.includes(el)) el.setAttribute('aria-invalid', 'true');
        else el.removeAttribute('aria-invalid');
      }
      mount(errorHost, alertBox('error', message));
      invalid[0]?.focus();
    };

    let busy = false;
    const onSubmit = async (e) => {
      e.preventDefault();
      if (busy) return;
      const values = { firstName: first.value, lastName: last.value, code: code.value };
      const typedKey = keyShown ? key.value.trim() : '';
      let result;
      let ev = event;
      if (event && !typedKey) {
        // Termindaten aus dem Link (bzw. vom ersten Kind mit Termin-Schlüssel): Code muss zu Lehrkraft und Klasse passen
        result = checkStudentLogin(values, expectedFor(event));
        if (!result.ok && (result.reason === 'teacher' || result.reason === 'class')) {
          setKeyShown(true);
          showError(result.error, [key]);
          return;
        }
        if (!result.ok) {
          showError(result.error, invalidFields(values, { first, last, code }));
          return;
        }
      } else {
        result = checkStudentLogin(values, {});
        if (!result.ok) {
          showError(result.error, invalidFields(values, { first, last, code }));
          return;
        }
        if (!typedKey) {
          showError('Bitte geben Sie den Termin-Schlüssel aus dem Elternbrief ein.', [key]);
          return;
        }
        try {
          // Der Schlüssel passt nur zu Lehrkraft und Klasse aus dem Code (Tippfehler dort fallen hier auf).
          ev = decodeEventKey(key.value, { teacherCode: result.parsed.teacherCode, classId: result.parsed.classId });
        } catch (err) {
          showError(err.message, err.mismatch ? [key, code] : [key]);
          return;
        }
        ev = { ...ev, classId: result.parsed.classId, teacherCode: result.parsed.teacherCode };
        if (mailboxEnabled()) {
          // Digitaler Briefkasten: Name, Schule und Briefkasten der Lehrkraft nachschlagen. Klappt das
          // nicht, geht es ohne Meldung wie bisher weiter (Rückmeldung dann per E-Mail).
          busy = true;
          setBusy(submit, true, 'Termindaten werden geladen …');
          const found = await findLetterData(ev, { teacherCode: result.parsed.teacherCode, classId: result.parsed.classId });
          busy = false;
          if (!form.isConnected) return;
          setBusy(submit, false);
          const checked = found ? checkStudentLogin(values, expectedFor(found)) : null;
          if (checked?.ok) {
            ev = found;
            result = checked;
          }
        }
      }
      const s = loadState();
      const login = { firstName: cleanName(values.firstName), lastName: cleanName(values.lastName), code: result.code };
      if (!s.login || s.login.code !== login.code || !s.event || !sameSchedule(s.event, ev)) {
        s.selection = {};
        clearSubmission(s);
      } else if (mailboxChanged(s, s.event, ev)) {
        clearSubmission(s);
      }
      if (!s.login || s.login.code !== login.code) {
        delete s.teacherEmailInput;
        delete s.teacherEmailFor;
      }
      s.event = ev;
      s.login = login;
      saveParentState(s);
      navigate('/eltern/zeiten');
    };

    const form = h(
      'form',
      { class: 'card stack parent-login', novalidate: true, onsubmit: onSubmit },
      h('h2', {}, 'Anmeldung für Eltern'),
      !event
        ? alertBox(
            'info',
            h('p', {}, h('strong', {}, 'Tipp: '), 'Am einfachsten scannen Sie den QR-Code im Elternbrief mit der Kamera Ihres Smartphones. Dann sind die Termine schon eingetragen.'),
          )
        : h('p', { class: 'muted' }, 'Bitte geben Sie die Angaben genau so ein, wie sie im gelben Kasten des Elternbriefs stehen.'),
      grid,
      errorHost,
      submit,
      event
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-ghost btn-small parent-other-key',
              'data-testid': 'parent-other-key',
              onclick: () => {
                const s = loadState();
                s.event = null;
                logout(s);
                saveParentState(s);
                ctx.rerender();
              },
            },
            'Anderer Elternbrief? Termin-Schlüssel eingeben',
          )
        : null,
    );
    return form;
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
  const viaMailbox = canUseMailbox(event);

  const selectionCopy = () => Object.fromEntries(Object.entries(selection).map(([d, list]) => [d, [...list]]));
  const persist = () => {
    const s = loadState();
    s.selection = selectionCopy();
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
      fact('Terminlänge', `${slot} Minuten`),
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
  const submitError = h('div', { class: 'parent-submit-error', 'aria-live': 'polite' });
  const submitBtn = h(
    'button',
    { type: 'button', class: 'btn btn-success btn-large btn-block parent-submit', 'data-testid': 'parent-submit', 'aria-describedby': 'parent-submit-hint', onclick: onSubmit },
    'Absenden',
  );
  // Fehler beim Senden an den Briefkasten: Statt „Absenden“ stehen dann „Erneut versuchen“ und
  // „Stattdessen per E-Mail senden“ zur Wahl.
  let sendFailed = false;
  // Solange gesendet wird, bleibt „Absenden“ gesperrt – auch wenn die Eltern dabei Zeiten ändern
  // (sonst ginge die Rückmeldung doppelt hinaus).
  let sending = false;

  const selectedCount = () => Object.values(selection).reduce((n, list) => n + list.length, 0);

  const refreshSubmit = () => {
    const total = selectedCount();
    submitBtn.disabled = total === 0 || sending;
    if (total === 0) {
      submitHint.textContent = 'Bitte markieren Sie zuerst mindestens einen Zeitslot, zu dem Sie Zeit hätten.';
      submitHint.classList.remove('parent-submit-hint-ok');
    } else {
      const rangeCount = days.reduce((n, d) => n + slotsToRanges(selection[d.date], slot).length, 0);
      // Nach einem Fehler beim Senden sagt der Fehlerkasten darunter, wie es weitergeht.
      let next = 'Nach dem Absenden wird eine PDF-Datei mit Ihren Zeiten heruntergeladen.';
      if (sendFailed) next = '';
      else if (viaMailbox) next = `Nach dem Absenden werden Ihre Zeiten verschlüsselt an ${teacherAcc(event)} übermittelt.`;
      submitHint.textContent = `Sie haben ${rangeCount === 1 ? '1 Zeitraum' : `${rangeCount} Zeiträume`} markiert. ${next}`.trim();
      submitHint.classList.add('parent-submit-hint-ok');
    }
  };

  const clearSendError = () => {
    sendFailed = false;
    submitBtn.hidden = false;
    mount(submitError);
    refreshSubmit();
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
    // Nach einer Änderung wieder mit „Absenden“ beginnen (nicht, während ein erneuter Versuch läuft)
    if (sendFailed && !sending) clearSendError();
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
        h('p', { class: 'muted small' }, `${day.start} bis ${day.end} Uhr · ${day.starts.length} Zeitslots · Terminlänge ${slot} Minuten`),
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

  const buildPayload = () => {
    const availability = {};
    for (const day of days) availability[day.date] = slotsToRanges(selection[day.date] || [], slot);
    return buildResponsePayload({
      code: ps.login.code,
      firstName: ps.login.firstName,
      lastName: ps.login.lastName,
      classId: info.classId,
      teacherCode: info.teacherCode,
      slotMinutes: slot,
      availability,
    });
  };

  /** Abgesendete Rückmeldung merken und zur Fertig-Seite. */
  const finish = (payload, extra) => {
    const s = loadState();
    // Dauerte das Senden so lange, dass die Eltern sich inzwischen abgemeldet oder ein anderes Kind
    // angemeldet haben, darf dessen Stand weder diese Zeiten noch „angekommen“ bekommen.
    if (!s.login || !codesEqual(s.login.code, payload.code) || !s.event || !sameSchedule(s.event, event)) {
      if (extra.sentVia === 'mailbox') toast(`Die Rückmeldung für ${childName(payload)} ist bei ${teacherDat(event)} angekommen.`, 'success', 8000);
      return;
    }
    s.selection = selectionCopy();
    clearSubmission(s);
    s.submittedAt = payload.submittedAt;
    s.lastPayload = payload;
    Object.assign(s, extra);
    saveParentState(s);
    navigate('/eltern/fertig');
  };

  /** Bisheriger Weg (und Notlösung): Rückmelde-PDF herunterladen, danach E-Mail. Wirft bei Fehlern. */
  const sendByEmail = async () => {
    const payload = buildPayload();
    const { doc, filename } = await createResponsePdf(payload, event);
    const saved = savePdf(doc, filename);
    finish(payload, { sentVia: 'email', lastFilename: saved });
  };

  /** Digitaler Briefkasten: verschlüsselt in den Briefkasten der Lehrkraft. Wirft bei Fehlern (z. B. MailboxError). */
  const sendByMailbox = async (button) => {
    const payload = buildPayload();
    const stopNotice = slowNotice(button);
    let result;
    try {
      result = await sendToMailbox(event.mailbox, payload);
    } finally {
      stopNotice();
    }
    const at = new Date(Number(result?.createdAt) || Date.now());
    finish(payload, { sentVia: 'mailbox', sentAt: Number.isNaN(at.getTime()) ? new Date().toISOString() : at.toISOString() });
  };

  /** Nichts mehr markiert (z. B. während des Sendens gelöscht)? Dann wieder „Absenden“ mit Hinweis. */
  const nothingSelected = () => {
    if (selectedCount() > 0) return false;
    clearSendError();
    refreshSubmit();
    return true;
  };

  /**
   * Senden an den Briefkasten ist gescheitert: freundliche Meldung mit „Erneut versuchen“ und
   * „Stattdessen per E-Mail senden“ (bisheriger Weg mit PDF und E-Mail). Hilft ein erneuter Versuch
   * voraussichtlich nicht (z. B. Briefkasten voll), steht der Weg per E-Mail vorn.
   */
  function showSendError(err, { again = false, pdfError = null } = {}) {
    sendFailed = true;
    submitBtn.hidden = true;
    refreshSubmit();
    const problem = sendProblem(err);
    // Der zweite Klick eines Doppelklicks auf „Absenden“ darf keinen der neuen Knöpfe auslösen.
    const accept = (e) => !(e.detail > 1);
    const retryBtn = h('button', { type: 'button', class: `btn ${problem.retry ? 'btn-success' : 'btn-secondary'} btn-large`, 'data-testid': 'parent-retry' }, 'Erneut versuchen');
    const fallbackBtn = h('button', { type: 'button', class: `btn ${problem.retry ? 'btn-secondary' : 'btn-success'} btn-large`, 'data-testid': 'parent-fallback' }, 'Stattdessen per E-Mail senden');
    retryBtn.addEventListener('click', async (e) => {
      if (!accept(e) || retryBtn.disabled || nothingSelected()) return;
      sending = true;
      setBusy(retryBtn, true, 'Wird gesendet …');
      fallbackBtn.disabled = true;
      try {
        await sendByMailbox(retryBtn);
      } catch (err2) {
        sending = false;
        if (submitError.isConnected) showSendError(err2, { again: true });
      }
    });
    fallbackBtn.addEventListener('click', async (e) => {
      if (!accept(e) || fallbackBtn.disabled || nothingSelected()) return;
      sending = true;
      setBusy(fallbackBtn, true, 'PDF wird erstellt …');
      retryBtn.disabled = true;
      try {
        await sendByEmail();
      } catch (err2) {
        sending = false;
        if (submitError.isConnected) showSendError(err, { again, pdfError: err2 });
      }
    });
    const buttons = problem.retry ? [retryBtn, fallbackBtn] : [fallbackBtn, retryBtn];
    mount(
      submitError,
      alertBox(
        'error',
        h('p', { class: 'parent-send-error-title' }, h('strong', {}, again ? 'Leider hat es wieder nicht geklappt. ' : '', 'Ihre Rückmeldung konnte gerade nicht übermittelt werden.')),
        h('p', {}, problem.reason),
        pdfError ? h('p', {}, h('strong', {}, 'Die PDF-Datei konnte nicht erstellt werden. '), friendlyError(pdfError)) : null,
        h('p', {}, pdfError ? 'Bitte versuchen Sie es gleich noch einmal.' : problem.advice),
        h('div', { class: 'parent-actions parent-send-actions' }, buttons),
      ),
    );
    buttons[0].focus();
  }

  async function onSubmit() {
    if (submitBtn.disabled || sending) return;
    clearSendError();
    sending = true;
    if (viaMailbox) {
      setBusy(submitBtn, true, 'Wird gesendet …');
      try {
        await sendByMailbox(submitBtn);
      } catch (err) {
        sending = false;
        setBusy(submitBtn, false);
        refreshSubmit();
        if (submitError.isConnected) showSendError(err);
      }
      return;
    }
    setBusy(submitBtn, true, 'PDF wird erstellt …');
    try {
      await sendByEmail();
    } catch (err) {
      sending = false;
      setBusy(submitBtn, false);
      refreshSubmit();
      mount(submitError, alertBox('error', h('p', {}, h('strong', {}, 'Die PDF-Datei konnte nicht erstellt werden. '), friendlyError(err))));
    }
  }

  let submitted = null;
  if (ps.submittedAt && ps.sentVia === 'mailbox') {
    submitted = alertBox(
      'success',
      h('p', {}, `Ihre Zeiten sind am ${formatTimestamp(ps.sentAt || ps.submittedAt)} bei ${teacherDat(event)} angekommen. `, h('a', { href: '#/eltern/fertig' }, 'Zur Bestätigung')),
      h('p', { class: 'small' }, 'Wenn Sie etwas ändern, klicken Sie danach bitte erneut auf „Absenden“. Bei der Lehrkraft gilt immer Ihre zuletzt gesendete Rückmeldung.'),
    );
  } else if (ps.submittedAt) {
    submitted = alertBox(
      'success',
      h('p', {}, `Sie haben Ihre Zeiten am ${formatTimestamp(ps.submittedAt)} abgesendet. `, h('a', { href: '#/eltern/fertig' }, 'Zur E-Mail an die Lehrkraft')),
      h(
        'p',
        { class: 'small' },
        viaMailbox
          ? 'Wenn Sie etwas ändern, klicken Sie danach bitte erneut auf „Absenden“.'
          : 'Wenn Sie etwas ändern, klicken Sie danach bitte erneut auf „Absenden“ und schicken Sie die neue PDF-Datei an die Lehrkraft.',
      ),
    );
  }

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
  // Empfänger kodieren: Komma, Semikolon, %2C oder Zeilenumbrüche ergeben so keinen zweiten Empfänger.
  // „@“ und „+“ bleiben lesbar.
  const to = encodeURIComponent(String(email || '').replace(/\s+/g, ''))
    .replace(/%40/g, '@')
    .replace(/%2B/gi, '+');
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

/** PDF bei Bedarf aus der gespeicherten Rückmeldung (neu) erzeugen – gleiche Daten wie beim Absenden. */
function pdfMaker(payload, event) {
  let pdfPromise = null;
  return () => {
    if (!pdfPromise) {
      pdfPromise = createResponsePdf(payload, event).catch((err) => {
        pdfPromise = null;
        throw err;
      });
    }
    return pdfPromise;
  };
}

/** Wurde die Auswahl nach dem Absenden geändert? */
function changedAfterSubmit(ps) {
  const event = ps.event;
  const slot = slotLength(event);
  const current = cleanSelection(ps, eventDays(event));
  return (event.days || []).some(
    (d) => JSON.stringify(slotsToRanges(current[d.date] || [], slot)) !== JSON.stringify(ps.lastPayload?.availability?.[d.date] || []),
  );
}

/** Abgesendete Zeiten je Tag. */
function timesList(event, payload) {
  return h(
    'ul',
    { class: 'parent-done-times' },
    (event.days || []).map((d) => {
      const ranges = payload.availability?.[d.date] || [];
      return h('li', {}, h('strong', {}, formatDateWithWeekday(d.date)), ': ', ranges.length ? formatRanges(ranges) : h('span', { class: 'muted' }, 'keine Zeit'));
    }),
  );
}

function renderDone(ctx) {
  const { root, setTitle, navigate } = ctx;
  const ps = loadState();
  if (!ps.event || !ps.login) {
    navigate('/eltern', { replace: true });
    return;
  }
  const info = classInfo(ps);
  const payload = ps.lastPayload;
  // Die Rückmeldung muss zum angemeldeten Kind und zu dessen Lehrkraft gehören – sonst ginge die E-Mail
  // an die falsche Adresse.
  const matches =
    payload &&
    codesEqual(payload.code, ps.login.code) &&
    (!payload.teacherCode || !info.teacherCode || teacherCodesMatch(payload.teacherCode, info.teacherCode)) &&
    (!payload.classId || !info.classId || payload.classId === info.classId);
  if (!matches) {
    navigate('/eltern/zeiten', { replace: true });
    return;
  }
  if (ps.sentVia === 'mailbox') {
    renderSent(ctx, ps);
    return;
  }
  setTitle('Fast geschafft');
  const event = ps.event;
  const filename = ps.lastFilename || 'Rückmeldung.pdf';
  const subject = mailSubject(payload);
  const knownEmail = event.teacherEmail || '';
  const teacherLabel = teacherAcc(event);

  const getPdf = pdfMaker(payload, event);

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
      // Nur vorbelegen, wenn die Adresse für die Lehrkraft dieses Kindes eingetippt wurde
      value: ps.teacherEmailInput && ps.teacherEmailFor && teacherCodesMatch(ps.teacherEmailFor, info.teacherCode) ? ps.teacherEmailInput : '',
      placeholder: 'name@schule.de',
    });
    emailInput.addEventListener('input', () => {
      const value = emailInput.value.trim();
      updateMailto(value);
      if (!value || isValidEmail(value)) emailInput.removeAttribute('aria-invalid');
      const s = loadState();
      s.teacherEmailInput = value;
      s.teacherEmailFor = info.teacherCode;
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

  const changedSince = changedAfterSubmit(ps);

  // Nummer und Überschrift in einer Zeile, der Inhalt nutzt am Smartphone die volle Breite.
  const step = (num, title, ...children) =>
    h(
      'li',
      { class: 'card parent-step' },
      h('div', { class: 'parent-step-head' }, h('span', { class: 'parent-step-num', 'aria-hidden': 'true' }, num), h('h2', {}, title)),
      h('div', { class: 'parent-step-body stack-small' }, ...children),
    );

  const summaryList = timesList(event, payload);

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

// ---------- Schritt 3 mit digitalem Briefkasten: angekommen ----------

/** Fertig-Seite, wenn die Rückmeldung über den digitalen Briefkasten angekommen ist: Es ist nichts mehr zu tun. */
function renderSent(ctx, ps) {
  const { root, setTitle, navigate } = ctx;
  setTitle('Rückmeldung angekommen');
  const event = ps.event;
  const payload = ps.lastPayload;
  const info = classInfo(ps);
  const changedSince = changedAfterSubmit(ps);
  const getPdf = pdfMaker(payload, event);

  // Beleg für die eigenen Unterlagen (dieselbe PDF-Datei wie beim Weg per E-Mail)
  const downloadBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-secondary',
      'data-testid': 'parent-download',
      onclick: async () => {
        setBusy(downloadBtn, true, 'PDF wird erstellt …');
        try {
          const { doc, filename } = await getPdf();
          savePdf(doc, filename);
          toast('Der Beleg wurde als PDF-Datei gespeichert.', 'success');
        } catch (err) {
          toast(`Die PDF-Datei konnte nicht erstellt werden. ${friendlyError(err)}`, 'error', 8000);
        } finally {
          setBusy(downloadBtn, false);
        }
      },
    },
    'Beleg als PDF speichern',
  );

  const onLogout = async () => {
    const ok = await confirmDialog({
      title: 'Fertig und abmelden?',
      message: changedSince
        ? 'Ihre Änderungen nach dem Absenden sind noch nicht bei der Lehrkraft. Wenn Sie sich jetzt abmelden, werden sie aus diesem Browser gelöscht.'
        : `Ihre Rückmeldung ist bei ${teacherDat(event)} angekommen. Ihre markierten Zeiten werden nur aus diesem Browser gelöscht.`,
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
      { class: 'parent-page parent-done parent-sent' },
      h(
        'section',
        { class: 'parent-sent-hero', 'data-testid': 'parent-sent-ok', 'aria-labelledby': 'parent-sent-title' },
        h('span', { class: 'parent-sent-check', 'aria-hidden': 'true' }, '✓'),
        h('h1', { id: 'parent-sent-title' }, 'Vielen Dank!'),
        // Nach einer Änderung stimmt „nichts weiter tun“ nicht mehr – dann folgt der Hinweis zum erneuten Absenden.
        changedSince
          ? h('p', { class: 'parent-sent-lead' }, `Ihre zuletzt gesendete Rückmeldung ist bei ${teacherDat(event)} angekommen.`)
          : h('p', { class: 'parent-sent-lead' }, `Ihre Rückmeldung ist bei ${teacherDat(event)} angekommen. `, h('strong', {}, 'Sie müssen nichts weiter tun.')),
      ),
      changedSince
        ? alertBox(
            'warning',
            h('p', {}, h('strong', {}, 'Sie haben Ihre Zeiten nach dem Absenden geändert. '), 'Die Änderungen sind noch nicht bei der Lehrkraft. Bitte klicken Sie unter „Zeiten ändern“ erneut auf „Absenden“.'),
          )
        : null,
      h(
        'section',
        { class: 'card stack-small parent-done-summary', 'aria-labelledby': 'parent-done-summary-title' },
        h('h2', { id: 'parent-done-summary-title' }, 'Ihre gesendeten Zeiten'),
        h('p', { class: 'muted small' }, `${childName(payload)}${info.classId ? `, Klasse ${info.classId}` : ''} · gesendet am ${formatTimestamp(ps.sentAt || payload.submittedAt)}`),
        timesList(event, payload),
        h('p', { class: 'muted small' }, `Ihre Angaben wurden verschlüsselt übermittelt. Nur ${teacherAcc(event)} kann sie lesen.`),
        h('div', { class: 'parent-actions' }, downloadBtn),
      ),
      h(
        'section',
        { class: 'card stack-small parent-sent-change', 'aria-labelledby': 'parent-sent-change-title' },
        h('h2', { id: 'parent-sent-change-title' }, 'Möchten Sie etwas ändern?'),
        h('p', {}, 'Klicken Sie auf „Zeiten ändern“ und danach erneut auf „Absenden“. Bei der Lehrkraft gilt immer Ihre zuletzt gesendete Rückmeldung.'),
        h('div', { class: 'parent-actions' }, h('a', { class: 'btn btn-secondary', href: '#/eltern/zeiten' }, 'Zeiten ändern')),
      ),
      h('div', { class: 'parent-actions parent-done-links' }, h('button', { type: 'button', class: 'btn btn-ghost', 'data-testid': 'parent-logout', onclick: onLogout }, 'Fertig – abmelden')),
    ),
  );
}
