// „Zwischenstand speichern“ und „Zwischenstand laden“ – aus der Kopfzeile und aus Hinweisen auf den Seiten.

import { h, mount, toast, clearToasts, modal, fileDropZone, confirmDialog, alertBox, plural } from '../core/ui.js';
import { getCurrentState, replaceState, loadEventDraft, storeEventDraft, clearEventDraft } from '../core/storage.js';
import { downloadBackup, readBackupFile } from '../core/backup.js';
import { formatTimestamp } from '../core/time.js';
import { mailboxEnabled, isValidTeacherMailbox } from '../core/mailbox.js';

const EMPTY_DEVICE_KEY = 'parentsday.emptyDevice';

/** Merkt sich (für diesen Tab), dass bei der Anmeldung ein neuer, leerer Stand angelegt wurde. */
export function markEmptyDevice(teacherCode, on = true) {
  try {
    if (on) sessionStorage.setItem(EMPTY_DEVICE_KEY, teacherCode);
    else sessionStorage.removeItem(EMPTY_DEVICE_KEY);
  } catch {
    // ohne sessionStorage kein Hinweis
  }
}

export function isEmptyDevice(teacherCode) {
  try {
    return sessionStorage.getItem(EMPTY_DEVICE_KEY) === teacherCode;
  } catch {
    return false;
  }
}

/** Lädt den aktuellen Stand samt noch nicht gespeicherter Eingaben zum Elternsprechtag herunter. */
export function saveBackupNow() {
  const state = getCurrentState();
  if (!state) return;
  const eventDraft = loadEventDraft(state);
  const name = downloadBackup(state, { eventDraft });
  toast(
    eventDraft ? `Zwischenstand gespeichert (mit Ihren noch nicht gespeicherten Eingaben zum Elternsprechtag): „${name}“` : `Zwischenstand gespeichert: „${name}“`,
    'success',
  );
}

/** Seite, auf der der geladene Stand weitergeht. */
function targetPath(state, eventDraft) {
  if (eventDraft) return state.event ? '/lehrkraft/einstellungen' : '/lehrkraft/elternsprechtag';
  return state.event ? '/lehrkraft/klassen' : '/lehrkraft/elternsprechtag';
}

/**
 * Digitaler Briefkasten beim Laden eines Zwischenstands: Sein Schlüssel steht nur im Browser und im
 * Zwischenspeicher. Enthält die Datei keinen Briefkasten (z. B. von vor dem ersten Elternbrief), bleibt der
 * Briefkasten dieses Browsers erhalten – sonst wären alle Rückmeldungen darin für immer unlesbar.
 * Enthält sie einen anderen, gilt der aus der Datei (die Elternbriefe dazu sind meist schon verteilt).
 * @returns {{keep: object|null, replaced: boolean}}
 */
function mailboxOnLoad(loaded, current) {
  const own = isValidTeacherMailbox(current?.mailbox) ? current.mailbox : null;
  if (!own) return { keep: null, replaced: false };
  if (!loaded.mailbox) return { keep: own, replaced: false };
  return { keep: null, replaced: loaded.mailbox.id !== own.id };
}

/** Hinweis im Dialog „Stand ersetzen?“ zum digitalen Briefkasten (nur, wenn er eingerichtet ist). */
function mailboxNote({ keep, replaced }) {
  if (!mailboxEnabled()) return null;
  if (keep) return h('p', {}, 'Ihr digitaler Briefkasten aus diesem Browser bleibt erhalten – der Zwischenstand enthält noch keinen.');
  if (!replaced) return null;
  return alertBox(
    'warning',
    h(
      'p',
      {},
      h('strong', {}, 'Achtung: '),
      'Dieser Zwischenstand enthält einen anderen digitalen Briefkasten als dieser Browser. Danach gilt der Briefkasten aus dem Zwischenstand. Rückmeldungen im Briefkasten dieses Browsers, die noch nicht abgerufen wurden, können Sie dann nur noch mit einem Zwischenstand von jetzt lesen.',
    ),
    h('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: (e) => e.detail > 1 || saveBackupNow() }, 'Aktuellen Stand speichern'),
  );
}

/**
 * Dialog „Zwischenstand laden“. Nach dem Laden geht es auf der passenden Seite weiter.
 * @param {{navigate: (path:string, opts?:object) => void}} opts
 */
export function openLoadBackupDialog({ navigate }) {
  const current = getCurrentState();
  if (!current) return;
  const status = h('div', { 'aria-live': 'polite' });
  const dlg = modal({
    title: 'Zwischenstand laden',
    content: [
      h('p', {}, 'Laden Sie eine Datei „Zwischenspeicher vom … für ParentsDay“ hoch. Der aktuelle Stand in diesem Browser wird dadurch ersetzt.'),
      fileDropZone({
        accept: '.json,application/json',
        label: 'Zwischenspeicher-Datei auswählen oder hierher ziehen',
        testId: 'backup-upload',
        onFiles: async ([file]) => {
          mount(status);
          try {
            const { state, eventDraft } = await readBackupFile(file, current.teacher);
            const students = state.classes.reduce((n, c) => n + c.students.length, 0);
            const classes = state.classes.length ? `${plural(state.classes.length, 'Klasse', 'Klassen')} (${state.classes.map((c) => c.id).join(', ')}) mit ${plural(students, 'Lernenden', 'Lernenden')}` : 'noch keine Klassen';
            const ok = await confirmDialog({
              title: 'Stand ersetzen?',
              message: h(
                'div',
                { class: 'stack-small' },
                h('p', {}, `Zwischenstand von ${state.teacher.firstName} ${state.teacher.lastName} vom ${formatTimestamp(state.savedAt)}: ${classes}${state.event ? '' : ', noch kein Elternsprechtag'}.`),
                h('p', {}, 'Er ersetzt alle aktuellen Daten in diesem Browser.'),
                mailboxNote(mailboxOnLoad(state, getCurrentState() || current)),
              ),
              confirmText: 'Ja, laden',
            });
            if (!ok) return;
            // Erst jetzt entscheiden: Der Briefkasten kann während der Rückfrage entstanden sein.
            const { keep } = mailboxOnLoad(state, getCurrentState() || current);
            if (keep) state.mailbox = keep;
            const saved = replaceState(state);
            if (eventDraft) storeEventDraft(saved, eventDraft);
            else clearEventDraft(saved);
            markEmptyDevice(saved.teacher.teacherCode, false);
            dlg.close();
            clearToasts();
            toast(eventDraft ? 'Zwischenstand geladen – auch Ihre noch nicht gespeicherten Eingaben zum Elternsprechtag.' : 'Zwischenstand geladen.', 'success');
            navigate(targetPath(saved, eventDraft), { replace: true });
          } catch (err) {
            mount(status, alertBox('error', err.message));
          }
        },
      }),
      status,
    ],
    actions: [{ label: 'Schließen', variant: 'secondary' }],
  });
}
