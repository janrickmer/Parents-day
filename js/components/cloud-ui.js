// Oberfläche der Cloud-Sicherung (Logik: core/cloud-sync.js): Passwortfelder, Dialoge zum Einrichten,
// Öffnen, Passwort vergessen/ändern und Löschen, Konflikt-Dialog, Anzeige in der Kopfzeile und Karte unter
// „Weitere Einstellungen“.

import { h, mount, toast, modal, alertBox, confirmDialog, friendlyError, plural } from '../core/ui.js';
import { cloudEnabled, passwordProblem, cloudErrorMessage, cloudServiceReady, MIN_PASSWORD_LENGTH } from '../core/cloud.js';
import {
  getCloudStatus,
  onCloudStatus,
  onRemoteApplied,
  setConflictResolver,
  startCloudSync,
  syncCloudNow,
  loadCloudConfig,
  isCloudConnected,
  forgetCloudOnDevice,
  setupCloud,
  unlockCloud,
  unlockDecision,
  adoptCloud,
  changeCloudPassword,
  moveCloudToNewPassword,
  deleteCloud,
  CloudNotFoundError,
  WrongPasswordError,
} from '../core/cloud-sync.js';
import { MailboxError, isValidTeacherMailbox } from '../core/mailbox.js';
import { loadTeacherState, loadEventDraft, getSession, isEmptyTeacherState, updateState } from '../core/storage.js';
import { downloadBackup } from '../core/backup.js';
import { formatTimestamp } from '../core/time.js';

const READY_TIMEOUT_MS = 8000;
const LOGIN_SYNC_TIMEOUT_MS = 8000;

/** Wartet höchstens `ms` Millisekunden; danach Fehler wie ohne Verbindung. */
function withTimeout(promise, ms) {
  let timer = 0;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new MailboxError('Die Cloud-Sicherung antwortet gerade nicht.', { offline: true })), ms);
    }),
  ]);
}

const isRepeat = (e) => e?.detail > 1;

// ---------- Passwortfelder ----------

let fieldCounter = 0;

/**
 * Passwortfeld mit Beschriftung, Hinweis, Fehlermeldung und „Anzeigen“-Knopf (gleicher Aufbau wie die übrigen Formularfelder).
 * @returns {{wrap: HTMLElement, input: HTMLInputElement, setError: (message: string) => void}}
 */
export function passwordField({ id, label, hint = '', autocomplete = 'new-password' }) {
  const fieldId = id || `pw-${++fieldCounter}`;
  const input = h('input', {
    id: fieldId,
    name: fieldId,
    'data-testid': fieldId,
    type: 'password',
    autocomplete,
    autocapitalize: 'off',
    spellcheck: 'false',
    required: true,
    maxlength: 200,
    class: 'cloud-pw-input',
  });
  const toggle = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-ghost btn-small cloud-pw-toggle',
      'aria-controls': fieldId,
      'aria-pressed': 'false',
      onclick: () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        toggle.textContent = show ? 'Verbergen' : 'Anzeigen';
        toggle.setAttribute('aria-pressed', String(show));
        input.focus();
      },
    },
    'Anzeigen',
  );
  const hintEl = hint ? h('div', { class: 'field-hint', id: `${fieldId}-hint` }, hint) : null;
  const error = h('div', { class: 'field-error', id: `${fieldId}-error`, hidden: true });
  const wrap = h('div', { class: 'field' }, h('label', { for: fieldId }, label), h('div', { class: 'cloud-pw' }, input, toggle), hintEl, error);
  const describe = (withError) => {
    const ids = [withError ? error.id : null, hintEl ? hintEl.id : null].filter(Boolean);
    if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
    else input.removeAttribute('aria-describedby');
  };
  const setError = (message) => {
    error.textContent = message || '';
    error.hidden = !message;
    // Als Meldung ansagen – der Fokus bleibt oft im Feld (Absenden mit Enter), dann käme sie sonst nicht an.
    if (message) error.setAttribute('role', 'alert');
    else error.removeAttribute('role');
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
    describe(Boolean(message));
  };
  describe(false);
  input.addEventListener('input', () => input.getAttribute('aria-invalid') === 'true' && setError(''));
  return { wrap, input, setError };
}

/** Hinweis unter einem neuen Passwort. */
export const NEW_PASSWORD_HINT = `Mindestens ${MIN_PASSWORD_LENGTH} Zeichen. Gut zu merken sind mehrere Wörter, z. B. „Sonne Tafel Kreide 7“.`;

/**
 * Neues Passwort mit Wiederholung.
 * @returns {{wraps: HTMLElement[], check: () => string|null}} check(): Passwort oder null (Fehler angezeigt)
 */
export function newPasswordFields(prefix, { label = 'Passwort für die Cloud-Sicherung' } = {}) {
  const pw = passwordField({ id: `${prefix}-password`, label, hint: NEW_PASSWORD_HINT, autocomplete: 'new-password' });
  const repeat = passwordField({ id: `${prefix}-password2`, label: 'Passwort wiederholen', autocomplete: 'new-password' });
  return {
    wraps: [pw.wrap, repeat.wrap],
    fields: [pw, repeat],
    check() {
      const problem = passwordProblem(pw.input.value);
      const mismatch = !problem && pw.input.value !== repeat.input.value ? 'Die beiden Passwörter stimmen nicht überein.' : '';
      pw.setError(problem);
      repeat.setError(mismatch);
      if (problem) pw.input.focus();
      else if (mismatch) repeat.input.focus();
      return problem || mismatch ? null : pw.input.value;
    },
  };
}

/** Kästchen „Passwort auf diesem Gerät merken“. */
export function rememberCheckbox(prefix, { checked = true } = {}) {
  const input = h('input', { type: 'checkbox', id: `${prefix}-remember`, 'data-testid': `${prefix}-remember`, checked });
  const wrap = h(
    'div',
    { class: 'cloud-remember' },
    h('label', { class: 'checkbox-label', for: input.id }, input, ' Passwort auf diesem Gerät merken'),
    h('div', { class: 'field-hint' }, 'Dann müssen Sie es hier nicht noch einmal eingeben. Nicht an fremden oder gemeinsam genutzten Computern.'),
  );
  return { wrap, input };
}

// ---------- Dialog-Gerüst ----------

/**
 * Dialog mit Formular. onSubmit({close, showError}) läuft beim Absenden (auch mit Enter); wirft er einen Fehler,
 * bleibt der Dialog offen und zeigt ihn an. Solange er läuft, lässt sich der Dialog nicht schließen.
 */
function formDialog({ title, body, submitLabel, submitTestId, busyLabel = 'Bitte warten …', danger = false, buttons = [], onSubmit, testId }) {
  const status = h('div', { class: 'cloud-dialog-status', 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, 'data-testid': submitTestId }, submitLabel);
  let dlg = null;
  let busy = false;
  const showError = (...message) => mount(status, alertBox('error', h('p', {}, ...message)));
  const extra = buttons.map((b) =>
    h(
      'button',
      {
        type: 'button',
        class: `btn btn-${b.variant || 'secondary'}`,
        'data-testid': b.testId || null,
        onclick: (e) => {
          if (isRepeat(e)) return;
          if (b.onClick) b.onClick(dlg.close);
          else dlg.close(b.value);
        },
      },
      b.label,
    ),
  );
  const form = h('form', { class: 'cloud-form', novalidate: true, 'data-testid': testId || null }, body, status, h('div', { class: 'modal-actions cloud-actions' }, extra, submit));
  const setBusy = (on) => {
    busy = on;
    submit.disabled = on;
    for (const btn of form.querySelectorAll('button:not([type=submit])')) btn.disabled = on;
    if (on) mount(submit, h('span', { class: 'spinner', 'aria-hidden': 'true' }), busyLabel);
    else mount(submit, submitLabel);
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    mount(status);
    setBusy(true);
    try {
      await onSubmit({ close: (v) => dlg.close(v), showError });
    } catch (err) {
      showError(err instanceof MailboxError ? cloudErrorMessage(err) : friendlyError(err));
    } finally {
      if (submit.isConnected) setBusy(false);
    }
  });
  dlg = modal({ title, content: form, actions: [], dismissible: () => !busy });
  return dlg;
}

/** Knopf, der wie ein Link aussieht (in Dialogen). */
function linkButton(label, testId, onClick) {
  return h('button', { type: 'button', class: 'link-button', 'data-testid': testId, onclick: (e) => isRepeat(e) || onClick() }, label);
}

// ---------- Zusammenfassung eines Stands ----------

function stateSummary(state) {
  if (!state) return 'keine Daten';
  const classes = state.classes || [];
  const students = classes.reduce((n, c) => n + c.students.length, 0);
  const responses = classes.reduce((n, c) => n + c.students.filter((s) => s.response).length, 0);
  const appointments = classes.reduce((n, c) => n + c.students.filter((s) => s.appointment).length, 0);
  const parts = [];
  parts.push(state.event ? plural(state.event.days.length, 'Tag', 'Tage') + ' Elternsprechtag' : 'noch kein Elternsprechtag');
  parts.push(classes.length ? `${plural(classes.length, 'Klasse', 'Klassen')} (${classes.map((c) => c.id).join(', ')})` : 'keine Klassen');
  if (students) parts.push(plural(students, 'Lernende/r', 'Lernende'));
  if (responses) parts.push(plural(responses, 'Rückmeldung', 'Rückmeldungen'));
  if (appointments) parts.push(plural(appointments, 'Termin', 'Termine'));
  return parts.join(', ');
}

// ---------- Konflikt ----------

/**
 * Welcher Stand soll gelten? Beide Stände unterscheiden sich; der andere wird überschrieben.
 * Empfohlen wird der Stand mit Inhalt; bei zwei gefüllten nach einem echten Konflikt der neuere, ohne gemeinsamen
 * Stand (context 'login': Gerät gerade verbunden) die Cloud-Sicherung.
 * @param {{local:{state:object}, remote:{state:object}, context:'login'|'sync'}} opts
 * @returns {Promise<'local'|'remote'>}
 */
export function openConflictDialog({ local, remote, context = 'sync' }) {
  const localEmpty = isEmptyTeacherState(local.state);
  const remoteEmpty = isEmptyTeacherState(remote.state);
  const localAt = Date.parse(local.state?.savedAt) || 0;
  const remoteAt = Date.parse(remote.state?.savedAt) || 0;
  const recommendRemote = localEmpty !== remoteEmpty ? localEmpty : context === 'login' || remoteAt >= localAt;
  const backupBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-secondary btn-small',
      'data-testid': 'cloud-conflict-backup',
      onclick: (e) => {
        if (isRepeat(e)) return;
        const name = downloadBackup(local.state, { eventDraft: loadEventDraft(local.state) });
        toast(`Stand dieses Geräts gespeichert: „${name}“`, 'success', 6000);
      },
    },
    'Stand dieses Geräts als Zwischenstand speichern',
  );
  const option = (which, title, state, recommended) =>
    h(
      'div',
      { class: `cloud-choice${recommended ? ' cloud-choice-recommended' : ''}`, 'data-testid': `cloud-choice-${which}` },
      h('h3', { class: 'cloud-choice-title' }, title, recommended ? h('span', { class: 'badge badge-success cloud-choice-badge' }, 'empfohlen') : null),
      h('p', { class: 'cloud-choice-time' }, `Zuletzt geändert: ${formatTimestamp(state?.savedAt) || 'unbekannt'}`),
      h('p', { class: 'muted small cloud-choice-summary' }, stateSummary(state)),
    );
  const lm = local.state?.mailbox;
  const rm = remote.state?.mailbox;
  const differentMailboxes = isValidTeacherMailbox(lm) && isValidTeacherMailbox(rm) && lm.id !== rm.id;
  const dlg = modal({
    title: 'Welchen Stand möchten Sie verwenden?',
    dismissible: false,
    content: h(
      'div',
      { class: 'stack-small', 'data-testid': 'cloud-conflict' },
      h(
        'p',
        {},
        context === 'login'
          ? 'Auf diesem Gerät ist ein anderer Stand gespeichert als in Ihrer Cloud-Sicherung.'
          : 'Ihr Stand wurde auf einem anderen Gerät geändert, während hier noch nicht gesicherte Änderungen vorlagen.',
      ),
      h('div', { class: 'cloud-choices' }, option('remote', 'Cloud-Sicherung', remote.state, recommendRemote), option('local', 'Dieses Gerät', local.state, !recommendRemote)),
      h('p', { class: 'muted small' }, 'Der andere Stand wird dabei überschrieben. Sind Sie unsicher, speichern Sie vorher den Stand dieses Geräts als Datei – mit „Zwischenstand laden“ lässt er sich später wiederherstellen.'),
      h('div', {}, backupBtn),
      differentMailboxes
        ? alertBox(
            'warning',
            h(
              'p',
              { 'data-testid': 'cloud-conflict-mailbox' },
              'Die beiden Stände haben verschiedene digitale Briefkästen. Rückmeldungen im Briefkasten des Stands, den Sie nicht wählen, lassen sich danach nur noch mit einem Zwischenstand dieses Stands lesen – speichern Sie deshalb vorher den Stand dieses Geräts.',
            ),
          )
        : null,
    ),
    actions: [
      { label: 'Stand dieses Geräts behalten', variant: recommendRemote ? 'secondary' : 'primary', value: 'local', testId: 'cloud-choose-local' },
      { label: 'Stand aus der Cloud übernehmen', variant: recommendRemote ? 'primary' : 'secondary', value: 'remote', testId: 'cloud-choose-remote' },
    ],
  });
  return dlg.result.then((v) => (v === 'local' ? 'local' : 'remote'));
}

// ---------- Einrichten ----------

/**
 * Dialog „Cloud-Sicherung einrichten“ (neues Passwort).
 * @param {{teacher:object, allowLater?:boolean, intro?:string, offerUnlock?:boolean}} opts
 *   offerUnlock: Link „Ich habe schon eine Cloud-Sicherung“ (schließt mit 'unlock')
 * @returns {Promise<'created'|'later'|'unlock'|undefined>}
 */
export function openSetupDialog({ teacher, allowLater = false, intro = '', offerUnlock = false }) {
  const pw = newPasswordFields('cloud-setup');
  const remember = rememberCheckbox('cloud-setup');
  let dlg = null;
  dlg = formDialog({
    title: 'Cloud-Sicherung einrichten',
    testId: 'cloud-setup-dialog',
    submitLabel: 'Cloud-Sicherung einrichten',
    submitTestId: 'cloud-setup-submit',
    busyLabel: 'Wird eingerichtet …',
    buttons: [{ label: allowLater ? 'Später' : 'Abbrechen', value: allowLater ? 'later' : undefined, testId: 'cloud-setup-later' }],
    body: h(
      'div',
      { class: 'stack-small' },
      intro ? h('p', {}, intro) : null,
      h(
        'p',
        {},
        'Mit der Cloud-Sicherung ist Ihr aktueller Stand auf jedem Gerät da, an dem Sie sich anmelden – ohne Zwischenspeicher-Datei. Ihre Daten werden dafür schon in Ihrem Browser mit Ihrem Passwort verschlüsselt. Niemand sonst kann sie lesen.',
      ),
      alertBox('warning', h('p', {}, h('strong', {}, 'Merken Sie sich das Passwort gut. '), 'Es wird nirgends gespeichert. Ohne das Passwort lässt sich die Cloud-Sicherung nicht öffnen – auch nicht von ParentsDay.')),
      pw.wraps,
      remember.wrap,
      offerUnlock ? h('p', { class: 'small' }, linkButton('Ich habe schon eine Cloud-Sicherung', 'cloud-setup-have', () => dlg.close('unlock'))) : null,
    ),
    onSubmit: async ({ close }) => {
      const password = pw.check();
      if (!password) return;
      const before = loadTeacherState(teacher.teacherCode);
      const status = await setupCloud(teacher, password, { remember: remember.input.checked });
      announceSetup(status, before, loadTeacherState(teacher.teacherCode));
      close('created');
    },
  });
  return dlg.result;
}

/** Rückmeldung nach dem Einrichten (auch ohne Verbindung klappt es – dann später). */
function announceSetup(status, before, after) {
  if (isEmptyTeacherState(before) && !isEmptyTeacherState(after)) toast('Mit diesem Passwort gab es schon eine Cloud-Sicherung – Ihr Stand wurde geladen.', 'success', 7000);
  else if (['ok', 'pending', 'syncing', 'conflict'].includes(status.kind)) toast('Cloud-Sicherung eingerichtet. Ihr Stand wird ab jetzt automatisch gesichert.', 'success', 6000);
  else toast('Cloud-Sicherung eingerichtet. Ihr Stand wird hochgeladen, sobald eine Verbindung besteht.', 'info', 7000);
}

// ---------- Öffnen (Passwort eingeben) ----------

/**
 * Übernimmt nach erfolgreichem Öffnen den passenden Stand (fragt bei zwei verschiedenen Ständen nach).
 * @returns {Promise<'remote'|'local'>}
 */
async function adoptAfterUnlock(teacher, unlocked, remember) {
  const code = teacher.teacherCode;
  let choice = unlockDecision(code, unlocked);
  if (choice === 'ask') {
    choice = await openConflictDialog({ local: { state: loadTeacherState(code) }, remote: unlocked.remote, context: 'login' });
  }
  await adoptCloud(teacher, unlocked, choice, { remember });
  return choice;
}

/**
 * Dialog „Passwort eingeben“: öffnet die Cloud-Sicherung auf diesem Gerät.
 * @param {{teacher:object, message?:string, allowSkip?:boolean, offerSetup?:boolean}} opts
 *   offerSetup: Link „Noch keine Cloud-Sicherung? Jetzt einrichten“ (schließt mit 'setup')
 * @returns {Promise<'unlocked'|'created'|'setup'|'skipped'|'disconnected'|undefined>}
 */
export function openUnlockDialog({ teacher, message = '', allowSkip = false, offerSetup = false }) {
  const pw = passwordField({ id: 'cloud-unlock-password', label: 'Passwort für die Cloud-Sicherung', autocomplete: 'current-password' });
  // Auf einem weiteren Gerät (evtl. fremd) wird das Passwort nur gemerkt, wenn die Lehrkraft das möchte; war dieses
  // Gerät schon verbunden, gilt die bisherige Wahl.
  const cfg = loadCloudConfig(teacher.teacherCode);
  const remember = rememberCheckbox('cloud-unlock', { checked: cfg ? cfg.remember : false });
  let dlg = null;
  const forgot = linkButton('Passwort vergessen?', 'cloud-forgot', async () => {
    const result = await openForgotDialog({ teacher });
    if (result === 'created') dlg.close('created');
  });
  // Eingerichtet, aber das Passwort passt nicht mehr (z. B. Sicherung auf einem anderen Gerät gelöscht): lösen.
  const disconnect = cfg
    ? linkButton('Cloud-Sicherung auf diesem Gerät nicht mehr verwenden', 'cloud-unlock-disconnect', async () => {
        if (await confirmDisconnect(teacher)) dlg.close('disconnected');
      })
    : null;
  dlg = formDialog({
    title: 'Passwort eingeben',
    testId: 'cloud-unlock-dialog',
    submitLabel: 'Weiter',
    submitTestId: 'cloud-unlock-submit',
    busyLabel: 'Wird geprüft …',
    buttons: [{ label: allowSkip ? 'Ohne Cloud-Sicherung weiter' : 'Abbrechen', value: allowSkip ? 'skipped' : undefined, testId: 'cloud-unlock-skip' }],
    body: h(
      'div',
      { class: 'stack-small' },
      h('p', {}, message || 'Haben Sie eine Cloud-Sicherung? Dann geben Sie Ihr Passwort ein – Ihr aktueller Stand wird auf dieses Gerät geholt.'),
      pw.wrap,
      remember.wrap,
      h(
        'p',
        { class: 'small cloud-links' },
        forgot,
        offerSetup ? [' · ', linkButton('Noch keine Cloud-Sicherung? Jetzt einrichten', 'cloud-unlock-setup', () => dlg.close('setup'))] : null,
        disconnect ? [' · ', disconnect] : null,
      ),
    ),
    onSubmit: async ({ close }) => {
      const password = pw.input.value;
      if (!password) {
        pw.setError('Bitte geben Sie Ihr Passwort ein.');
        pw.input.focus();
        return;
      }
      let unlocked;
      try {
        unlocked = await unlockCloud(teacher, password);
      } catch (err) {
        if (err instanceof CloudNotFoundError) {
          pw.setError(
            err.moved
              ? 'Das Passwort dieser Cloud-Sicherung wurde inzwischen auf einem anderen Gerät geändert. Bitte geben Sie das neue Passwort ein.'
              : `Mit diesem Passwort gibt es keine Cloud-Sicherung. Bitte prüfen Sie das Passwort, auch Groß- und Kleinschreibung${offerSetup ? ' – oder richten Sie eine neue Cloud-Sicherung ein' : ''}.`,
          );
          pw.input.select();
          return;
        }
        throw err;
      }
      const choice = await adoptAfterUnlock(teacher, unlocked, remember.input.checked);
      toast(choice === 'remote' ? 'Ihr Stand aus der Cloud-Sicherung wurde geladen.' : 'Die Cloud-Sicherung ist verbunden. Der Stand von diesem Gerät wird gesichert.', 'success', 6000);
      close('unlocked');
    },
  });
  return dlg.result;
}

// ---------- Passwort vergessen ----------

/** Rückfrage „Cloud-Sicherung auf diesem Gerät nicht mehr verwenden“. Gibt true zurück, wenn gelöst. */
async function confirmDisconnect(teacher) {
  const ok = await confirmDialog({
    title: 'Cloud-Sicherung nicht mehr verwenden?',
    message: 'Dieses Gerät gleicht dann nicht mehr mit der Cloud-Sicherung ab. Ihr Stand in diesem Browser bleibt erhalten. Die Cloud-Sicherung selbst wird dadurch nicht gelöscht.',
    confirmText: 'Nicht mehr verwenden',
  });
  if (!ok) return false;
  forgetCloudOnDevice(teacher.teacherCode);
  toast('Dieses Gerät verwendet die Cloud-Sicherung nicht mehr.', 'info');
  return true;
}

/**
 * Erklärt, was ohne Passwort möglich ist. Auf einem verbundenen Gerät zieht die Sicherung mit dem Stand dieses
 * Geräts unter ein neues Passwort um (andere Geräte fragen dann nach dem neuen); sonst entsteht eine neue
 * Sicherung mit neuem Passwort.
 * @returns {Promise<'created'|undefined>}
 */
export function openForgotDialog({ teacher }) {
  const code = teacher.teacherCode;
  const local = loadTeacherState(code);
  const empty = isEmptyTeacherState(local);
  const connected = isCloudConnected(code);
  const dlg = modal({
    title: 'Passwort vergessen?',
    content: h(
      'div',
      { class: 'stack-small', 'data-testid': 'cloud-forgot-dialog' },
      h('p', {}, 'Ohne Ihr Passwort lässt sich Ihre Cloud-Sicherung nicht öffnen – auch nicht von ParentsDay. Das schützt Ihre Daten.'),
      connected
        ? h(
            'p',
            {},
            'Dieses Gerät ist aber noch mit Ihrer Cloud-Sicherung verbunden. Sie können hier ein neues Passwort festlegen: Ihr Stand zieht dann in eine neue Sicherung um. Ihre anderen Geräte fragen danach einmal nach dem neuen Passwort – nichts geht verloren.',
          )
        : [
            h(
              'p',
              {},
              'Ist Ihr Passwort noch auf einem anderen Gerät gemerkt, wählen Sie am besten dort „Passwort vergessen?“ (unter „Weitere Einstellungen“) – dann werden alle Geräte umgestellt und nichts geht verloren.',
            ),
            h(
              'p',
              {},
              'Sonst können Sie hier eine neue Cloud-Sicherung mit neuem Passwort einrichten. Sie beginnt mit dem Stand dieses Geräts. Die alte wird nach 400 Tagen ohne Nutzung automatisch gelöscht; Geräte, die noch mit ihr verbunden sind, verbinden Sie dort mit „Passwort vergessen?“ bzw. dem neuen Passwort.',
            ),
            empty
              ? alertBox('warning', h('p', {}, h('strong', {}, 'Auf diesem Gerät sind noch keine Daten gespeichert. '), 'Richten Sie die neue Cloud-Sicherung am besten an dem Gerät ein, an dem Sie zuletzt gearbeitet haben.'))
              : h('p', { class: 'muted small' }, `Stand dieses Geräts: ${stateSummary(local)}.`),
          ],
    ),
    actions: [
      { label: 'Abbrechen', value: undefined, testId: 'cloud-forgot-cancel' },
      connected
        ? { label: 'Neues Passwort festlegen', variant: 'primary', value: 'move', testId: 'cloud-forgot-move' }
        : { label: 'Neue Cloud-Sicherung einrichten', variant: 'primary', value: 'setup', testId: 'cloud-forgot-setup' },
    ],
  });
  return dlg.result
    .then((v) => (v === 'setup' ? openSetupDialog({ teacher }) : v === 'move' ? openMoveDialog(teacher) : undefined))
    .then((v) => (v === 'created' ? 'created' : undefined));
}

/** Neues Passwort ohne das bisherige – nur auf einem verbundenen Gerät („Passwort vergessen?“). */
function openMoveDialog(teacher) {
  const pw = newPasswordFields('cloud-move', { label: 'Neues Passwort' });
  return formDialog({
    title: 'Neues Passwort festlegen',
    testId: 'cloud-move-dialog',
    submitLabel: 'Neues Passwort festlegen',
    submitTestId: 'cloud-move-submit',
    busyLabel: 'Wird umgestellt …',
    buttons: [{ label: 'Abbrechen', value: undefined }],
    body: h('div', { class: 'stack-small' }, h('p', {}, 'Ihr aktueller Stand wird mit dem neuen Passwort gesichert. Auf Ihren anderen Geräten geben Sie danach einmal das neue Passwort ein.'), pw.wraps),
    onSubmit: async ({ close }) => {
      const password = pw.check();
      if (!password) return;
      await moveCloudToNewPassword(teacher, password);
      toast('Das neue Passwort gilt ab sofort. Ihre anderen Geräte fragen einmal danach.', 'success', 7000);
      close('created');
    },
  }).result;
}

// ---------- Passwort ändern und löschen ----------

export function openChangePasswordDialog(teacher) {
  const current = passwordField({ id: 'cloud-change-current', label: 'Bisheriges Passwort', autocomplete: 'current-password' });
  const pw = newPasswordFields('cloud-newpw', { label: 'Neues Passwort' });
  let dlg = null;
  dlg = formDialog({
    title: 'Passwort ändern',
    testId: 'cloud-change-dialog',
    submitLabel: 'Passwort ändern',
    submitTestId: 'cloud-change-submit',
    busyLabel: 'Wird geändert …',
    buttons: [{ label: 'Abbrechen', value: undefined }],
    body: h(
      'div',
      { class: 'stack-small' },
      h('p', {}, 'Ihr Stand wird mit dem neuen Passwort neu verschlüsselt. Auf Ihren anderen Geräten geben Sie danach einmal das neue Passwort ein.'),
      current.wrap,
      h(
        'p',
        { class: 'small' },
        linkButton('Bisheriges Passwort vergessen?', 'cloud-change-forgot', async () => {
          dlg.close();
          await openForgotDialog({ teacher });
        }),
      ),
      pw.wraps,
    ),
    onSubmit: async ({ close }) => {
      if (!current.input.value) {
        current.setError('Bitte geben Sie Ihr bisheriges Passwort ein.');
        current.input.focus();
        return;
      }
      const password = pw.check();
      if (!password) return;
      try {
        const { oldLeft } = await changeCloudPassword(teacher, current.input.value, password);
        toast(oldLeft ? 'Das Passwort wurde geändert. Die alte Sicherung wird nach 400 Tagen ohne Nutzung automatisch gelöscht.' : 'Das Passwort wurde geändert.', 'success', 7000);
      } catch (err) {
        if (err instanceof WrongPasswordError) {
          current.setError('Das bisherige Passwort ist falsch.');
          current.input.select();
          return;
        }
        throw err;
      }
      close('changed');
    },
  });
  return dlg.result;
}

export function openDeleteCloudDialog(teacher) {
  const pw = passwordField({ id: 'cloud-delete-password', label: 'Passwort für die Cloud-Sicherung', autocomplete: 'current-password' });
  return formDialog({
    title: 'Cloud-Sicherung löschen?',
    testId: 'cloud-delete-dialog',
    submitLabel: 'Cloud-Sicherung löschen',
    submitTestId: 'cloud-delete-submit',
    busyLabel: 'Wird gelöscht …',
    danger: true,
    buttons: [{ label: 'Abbrechen', value: undefined }],
    body: h(
      'div',
      { class: 'stack-small' },
      h('p', {}, 'Ihre Cloud-Sicherung wird vom Server gelöscht. Der Stand in diesem Browser bleibt erhalten.'),
      h('p', {}, 'Auf anderen Geräten bleibt der dort gespeicherte Stand ebenfalls erhalten, wird aber nicht mehr abgeglichen – dort erscheint einmal „Passwort nötig“; mit „Cloud-Sicherung auf diesem Gerät nicht mehr verwenden“ lösen Sie das Gerät. Zum Weiterarbeiten an einem anderen Gerät brauchen Sie dann wieder eine Zwischenspeicher-Datei.'),
      pw.wrap,
    ),
    onSubmit: async ({ close }) => {
      if (!pw.input.value) {
        pw.setError('Bitte geben Sie Ihr Passwort ein.');
        pw.input.focus();
        return;
      }
      try {
        await deleteCloud(teacher, pw.input.value);
      } catch (err) {
        if (err instanceof WrongPasswordError) {
          pw.setError('Das Passwort ist falsch.');
          pw.input.select();
          return;
        }
        throw err;
      }
      toast('Die Cloud-Sicherung wurde gelöscht.', 'success');
      close('deleted');
    },
  }).result;
}

// ---------- Nach der Anmeldung bzw. Registrierung ----------

/** Unterstützt der Dienst die Cloud-Sicherung? true/false, null ohne Verbindung. */
async function serviceReady() {
  try {
    return await withTimeout(cloudServiceReady(), READY_TIMEOUT_MS);
  } catch {
    return null;
  }
}

function sameSaved(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

/**
 * Cloud-Sicherung beim Anmelden: Auf einem verbundenen Gerät wird abgeglichen; sonst fragt ParentsDay nach dem
 * Passwort (neues bzw. leeres Gerät) oder bietet an, die Cloud-Sicherung einzurichten (Gerät mit Daten).
 * Der Stand der Lehrkraft muss schon in diesem Browser gespeichert und die Sitzung gesetzt sein.
 * @param {object} teacher
 * @param {{onProgress?: (text: string) => void}} [opts]
 * @returns {Promise<{restored: boolean}>} restored: Stand aus der Cloud übernommen
 */
export async function cloudAfterLogin(teacher, { onProgress = () => {} } = {}) {
  if (!cloudEnabled()) return { restored: false };
  const code = teacher.teacherCode;
  startCloudSync(code, { sync: false });
  const before = loadTeacherState(code);
  const changed = () => !sameSaved(before, loadTeacherState(code));
  if (isCloudConnected(code)) {
    // Dieses Gerät kennt das Passwort: kurz abgleichen, damit gleich der neueste Stand zu sehen ist.
    onProgress('Ihr Stand wird mit der Cloud-Sicherung abgeglichen …');
    try {
      await withTimeout(syncCloudNow(), LOGIN_SYNC_TIMEOUT_MS);
    } catch {
      // läuft im Hintergrund weiter
    }
    onProgress('');
    const status = getCloudStatus(code);
    if (status.kind === 'needs-password') await openUnlockDialog({ teacher, message: status.message, allowSkip: true });
    return { restored: changed() };
  }
  onProgress('Cloud-Sicherung wird geprüft …');
  const ready = await serviceReady();
  onProgress('');
  if (ready === null) {
    toast('Die Cloud-Sicherung ist gerade nicht erreichbar. Sie arbeiten mit dem Stand dieses Geräts.', 'warning', 8000);
    return { restored: false };
  }
  if (!ready) return { restored: false }; // Dienst ohne Cloud-Sicherung (ältere Fassung)
  const locked = loadCloudConfig(code); // eingerichtet, aber Passwort (noch) nicht eingegeben
  let step = locked || isEmptyTeacherState(before) ? 'unlock' : 'setup';
  for (let i = 0; step && i < 6; i++) {
    if (step === 'unlock') {
      const result = await openUnlockDialog({ teacher, allowSkip: true, offerSetup: true, message: locked ? getCloudStatus(code).message : '' });
      step = result === 'setup' ? 'setup' : null;
    } else {
      const result = await openSetupDialog({
        teacher,
        allowLater: true,
        offerUnlock: true,
        intro: isEmptyTeacherState(loadTeacherState(code))
          ? ''
          : 'Neu: Ihr Stand kann jetzt automatisch in der Cloud gesichert werden – dann ist er auf jedem Gerät da, an dem Sie sich anmelden. Legen Sie dafür einmal ein Passwort fest.',
      });
      step = result === 'unlock' ? 'unlock' : null;
    }
  }
  return { restored: changed() };
}

/**
 * Cloud-Sicherung bei der Registrierung mit dem gewählten Passwort einrichten. Gibt es mit diesem Passwort schon
 * eine (erneute Registrierung, z. B. an einem neuen Gerät), wird deren Stand geladen.
 * @param {{remember?: boolean, email?: string}} [opts] – email: bei der Registrierung eingegebene Adresse
 * @returns {Promise<'created'|'pending'|'restored'|'kept'>}
 *   pending: wird hochgeladen, sobald der Dienst erreichbar ist; kept: dieses Gerät war schon verbunden
 */
export async function cloudAfterRegister(teacher, password, { remember = true, email = '' } = {}) {
  const code = teacher.teacherCode;
  startCloudSync(code, { sync: false });
  if (isCloudConnected(code)) {
    syncCloudNow();
    return 'kept';
  }
  const before = loadTeacherState(code);
  const status = await setupCloud(teacher, password, { remember });
  const after = loadTeacherState(code);
  const restored = isEmptyTeacherState(before) && !isEmptyTeacherState(after);
  // Stand aus der Cloud übernommen: die eben eingegebene E-Mail-Adresse gilt trotzdem.
  if (restored && email && after.teacher.email !== email) {
    updateState((s) => {
      s.teacher.email = email;
    });
  }
  if (restored) return 'restored';
  return ['ok', 'pending', 'syncing', 'conflict'].includes(status.kind) ? 'created' : 'pending';
}

// ---------- Kopfzeile ----------

const INDICATOR = {
  'not-setup': ['Nur in diesem Browser gespeichert', 'muted'],
  'needs-password': ['Cloud-Sicherung: Passwort nötig', 'warning'],
  syncing: ['Wird in der Cloud gesichert …', 'muted'],
  pending: ['Wird in der Cloud gesichert …', 'muted'],
  ok: ['In der Cloud gesichert', 'success'],
  offline: ['Cloud nicht erreichbar – wird nachgeholt', 'warning'],
  unsupported: ['Cloud-Sicherung noch nicht verfügbar', 'warning'],
  locked: ['Cloud-Sicherung vorübergehend gesperrt', 'warning'],
  conflict: ['Cloud-Sicherung: Entscheidung nötig', 'warning'],
  error: ['Cloud-Sicherung: Fehler – wird wiederholt', 'warning'],
};

/**
 * Anzeige der Cloud-Sicherung in der Kopfzeile der Lehrkraft (mit Knopf, wenn etwas zu tun ist).
 * @returns {{element: HTMLElement|null, cleanup: () => void}}
 */
export function cloudIndicator(teacher) {
  if (!cloudEnabled()) return { element: null, cleanup: () => {} };
  const text = h('span', { class: 'cloud-indicator-text' });
  const action = h('button', { type: 'button', class: 'link-button cloud-indicator-action', 'data-testid': 'cloud-indicator-action', hidden: true });
  const element = h('span', { class: 'cloud-indicator', 'data-testid': 'cloud-indicator' }, h('span', { class: 'cloud-indicator-dot', 'aria-hidden': 'true' }), text, action);
  let current = null;
  action.addEventListener('click', async (e) => {
    if (isRepeat(e) || !current) return;
    if (current.kind === 'needs-password') await openUnlockDialog({ teacher, message: current.message });
    else if (current.kind === 'not-setup') {
      const result = await openSetupDialog({ teacher, offerUnlock: true });
      if (result === 'unlock') await openUnlockDialog({ teacher });
    } else syncCloudNow();
  });
  const update = (status) => {
    current = status;
    const [label, tone] = INDICATOR[status.kind] || ['', 'muted'];
    element.hidden = !label;
    element.dataset.state = status.kind;
    element.className = `cloud-indicator cloud-indicator-${tone}`;
    text.textContent = label;
    element.title = status.message || (status.syncedAt ? `Zuletzt abgeglichen: ${formatTimestamp(status.syncedAt)}` : '');
    const actionLabel = { 'needs-password': 'Passwort eingeben', 'not-setup': 'Cloud-Sicherung einrichten', offline: 'Erneut versuchen', error: 'Erneut versuchen' }[status.kind];
    action.hidden = !actionLabel;
    action.textContent = actionLabel || '';
  };
  update(getCloudStatus(teacher.teacherCode));
  const cleanup = onCloudStatus(update);
  return { element, cleanup };
}

// ---------- Weitere Einstellungen ----------

/** Karte „Cloud-Sicherung“ unter „Weitere Einstellungen“. Ohne Dienst gibt es sie nicht. */
export function cloudSettingsCard(teacher) {
  if (!cloudEnabled()) return null;
  const body = h('div', { class: 'stack-small' });
  const badge = h('span', { class: 'badge' });
  const card = h(
    'section',
    { class: 'card evt-mailbox cloud-card', 'aria-labelledby': 'cloud-card-title', 'data-testid': 'cloud-card' },
    h('div', { class: 'evt-mailbox-head' }, h('h2', { id: 'cloud-card-title' }, 'Cloud-Sicherung'), badge),
    body,
  );
  let lastKey = '';
  const title = card.querySelector('h2');
  title.setAttribute('tabindex', '-1');
  const button = (label, testId, onClick, variant = 'secondary') =>
    h(
      'button',
      {
        type: 'button',
        class: `btn btn-${variant}`,
        'data-testid': testId,
        onclick: async (e) => {
          if (isRepeat(e)) return;
          await onClick();
          render(getCloudStatus(teacher.teacherCode));
          // Der Knopf kann inzwischen neu aufgebaut worden sein: Fokus auf den neuen (oder die Überschrift)
          const focus = document.activeElement;
          if (!focus || focus === document.body || !focus.isConnected) (body.querySelector(`[data-testid="${testId}"]`) || title).focus();
        },
      },
      label,
    );
  let unsubscribe = null;
  const render = (status) => {
    if (!card.isConnected && unsubscribe && body.childNodes.length) {
      unsubscribe();
      return;
    }
    // Nur neu aufbauen, wenn sich etwas Sichtbares ändert – und den Tastaturfokus dabei behalten.
    const key = JSON.stringify([status.kind, status.message, status.syncedAt, status.remember]);
    if (key === lastKey) return;
    lastKey = key;
    const focused = card.contains(document.activeElement) ? document.activeElement.dataset?.testid : '';
    const connected = !['not-setup', 'needs-password', 'disabled', 'off'].includes(status.kind);
    badge.className = `badge${connected ? ' badge-success' : ''}`;
    badge.textContent = connected ? 'Aktiv' : status.kind === 'needs-password' ? 'Passwort nötig' : 'Nicht eingerichtet';
    if (status.kind === 'not-setup') {
      mount(
        body,
        h('p', {}, 'Mit der Cloud-Sicherung ist Ihr aktueller Stand auf jedem Gerät da, an dem Sie sich anmelden – ohne Zwischenspeicher-Datei. Ihre Daten werden dafür in Ihrem Browser mit Ihrem Passwort verschlüsselt.'),
        h(
          'div',
          { class: 'evt-mailbox-actions' },
          button('Cloud-Sicherung einrichten', 'cloud-setup', () => openSetupDialog({ teacher }), 'primary'),
          button('Ich habe schon eine', 'cloud-card-unlock', () => openUnlockDialog({ teacher })),
        ),
      );
    } else if (status.kind === 'needs-password') {
      mount(
        body,
        h('p', {}, status.message || 'Geben Sie Ihr Passwort ein, damit dieses Gerät wieder mit Ihrer Cloud-Sicherung abgleicht.'),
        h(
          'div',
          { class: 'evt-mailbox-actions' },
          button('Passwort eingeben', 'cloud-unlock', () => openUnlockDialog({ teacher, message: status.message }), 'primary'),
          button('Passwort vergessen?', 'cloud-card-forgot', () => openForgotDialog({ teacher })),
          button('Nicht mehr verwenden', 'cloud-card-disconnect', () => confirmDisconnect(teacher)),
        ),
      );
    } else {
      const [label] = INDICATOR[status.kind] || [''];
      mount(
        body,
        h('p', {}, 'Ihr kompletter Stand wird nach jeder Änderung verschlüsselt gesichert. An einem anderen Gerät melden Sie sich einfach an und geben Ihr Passwort ein – dann ist alles da.'),
        h(
          'dl',
          { class: 'evt-profile evt-mailbox-facts' },
          h('div', { class: 'evt-profile-row' }, h('dt', {}, 'Zustand'), h('dd', { 'data-testid': 'cloud-card-state' }, label)),
          h('div', { class: 'evt-profile-row' }, h('dt', {}, 'Zuletzt abgeglichen'), h('dd', { 'data-testid': 'cloud-card-synced' }, status.syncedAt ? formatTimestamp(status.syncedAt) : 'noch nicht')),
          h('div', { class: 'evt-profile-row' }, h('dt', {}, 'Passwort gemerkt'), h('dd', {}, status.remember ? 'Ja, auf diesem Gerät' : 'Nein, nur bis zum Abmelden')),
        ),
        status.message && status.kind !== 'ok' ? alertBox('warning', h('p', {}, status.message)) : null,
        h(
          'div',
          { class: 'evt-mailbox-actions' },
          button('Jetzt abgleichen', 'cloud-sync-now', async () => {
            const after = await syncCloudNow();
            if (after.kind === 'ok') toast('Ihr Stand ist in der Cloud gesichert.', 'success');
          }),
          button('Passwort ändern', 'cloud-change-password', () => openChangePasswordDialog(teacher)),
          button('Passwort vergessen?', 'cloud-card-forgot', () => openForgotDialog({ teacher })),
          button('Cloud-Sicherung löschen', 'cloud-delete', () => openDeleteCloudDialog(teacher)),
        ),
        h('p', { class: 'muted small' }, 'Ende-zu-Ende-verschlüsselt: Ihr Passwort verlässt diesen Browser nie. Ohne das Passwort kann niemand die Sicherung lesen – auch nicht ParentsDay.'),
      );
    }
    if (focused) body.querySelector(`[data-testid="${focused}"]`)?.focus();
  };
  render(getCloudStatus(teacher.teacherCode));
  unsubscribe = onCloudStatus(render);
  return card;
}

// ---------- Einmalig beim Start ----------

let installed = false;

/** Seiten der Lehrkraft, die nach einem übernommenen Stand neu gezeichnet werden (nicht Anmelden/Registrieren). */
function onTeacherPage() {
  return /^#\/lehrkraft\/(elternsprechtag|einstellungen|klassen|klasse\/)/i.test(location.hash);
}

/**
 * Verbindet die Abgleich-Logik mit der Oberfläche: Konflikt-Dialog und Neuzeichnen der Seite, wenn ein Stand aus
 * der Cloud übernommen wurde (im Hintergrund oder nach Eingabe des Passworts).
 * @param {{rerender: () => void}} opts
 */
export function installCloudUi({ rerender }) {
  if (installed) return;
  installed = true;
  setConflictResolver(({ local, remote, noBase }) => openConflictDialog({ local, remote, context: noBase ? 'login' : 'sync' }));
  let waiting = false;
  onRemoteApplied(({ source }) => {
    if (!getSession() || !onTeacherPage()) return;
    if (source === 'sync') toast('Neuer Stand von einem anderen Gerät übernommen.', 'info', 6000);
    // Nicht mitten in einem offenen Dialog neu zeichnen – erst, wenn er geschlossen ist.
    if (waiting) return;
    waiting = true;
    const tryRender = () => {
      if (document.querySelector('.modal-backdrop')) {
        setTimeout(tryRender, 400);
        return;
      }
      waiting = false;
      if (getSession() && onTeacherPage()) rerender();
    };
    tryRender();
  });
}
