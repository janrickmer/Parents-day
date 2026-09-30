// Oberfläche der Cloud-Sicherung (Logik: core/cloud-sync.js): Passwortfelder, Dialoge zum Einrichten,
// Entsperren, Ersetzen („Passwort vergessen“) und Ändern, Konflikt-Dialog, Anzeige in der Kopfzeile und
// Karte unter „Weitere Einstellungen“.

import { h, mount, toast, modal, alertBox, confirmDialog, friendlyError, plural } from '../core/ui.js';
import { cloudEnabled, passwordProblem, cloudErrorMessage, MIN_PASSWORD_LENGTH } from '../core/cloud.js';
import {
  getCloudStatus,
  onCloudStatus,
  onRemoteApplied,
  setConflictResolver,
  startCloudSync,
  syncCloudNow,
  loadCloudConfig,
  hasCloudKeys,
  rememberLockedCloud,
  forgetCloudOnDevice,
  lookupCloud,
  setupCloud,
  unlockCloud,
  unlockDecision,
  adoptCloud,
  resetCloud,
  changeCloudPassword,
  deleteCloud,
  CloudNotFoundError,
} from '../core/cloud-sync.js';
import { MailboxError } from '../core/mailbox.js';
import { loadTeacherState, getSession, isEmptyTeacherState } from '../core/storage.js';
import { formatTimestamp } from '../core/time.js';

const LOOKUP_TIMEOUT_MS = 10000;
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
 * @returns {{wraps: HTMLElement[], check: () => string|null, focus: () => void}} check(): Passwort oder null (Fehler angezeigt)
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
export function rememberCheckbox(prefix) {
  const input = h('input', { type: 'checkbox', id: `${prefix}-remember`, 'data-testid': `${prefix}-remember`, checked: true });
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
 * bleibt der Dialog offen und zeigt ihn an.
 */
function formDialog({ title, body, submitLabel, submitTestId, busyLabel = 'Bitte warten …', danger = false, buttons = [], onSubmit, dismissible = true, testId }) {
  const status = h('div', { class: 'cloud-dialog-status', 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, 'data-testid': submitTestId }, submitLabel);
  let dlg = null;
  const showError = (message) => mount(status, alertBox('error', h('p', {}, message)));
  const setBusy = (on) => {
    submit.disabled = on;
    for (const btn of extra) btn.disabled = on;
    if (on) mount(submit, h('span', { class: 'spinner', 'aria-hidden': 'true' }), busyLabel);
    else mount(submit, submitLabel);
  };
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
  const form = h(
    'form',
    {
      class: 'cloud-form',
      novalidate: true,
      'data-testid': testId || null,
      onsubmit: async (e) => {
        e.preventDefault();
        if (submit.disabled) return;
        mount(status);
        setBusy(true);
        try {
          await onSubmit({ close: (v) => dlg.close(v), showError });
        } catch (err) {
          showError(err instanceof MailboxError ? cloudErrorMessage(err) : friendlyError(err));
        } finally {
          if (submit.isConnected) setBusy(false);
        }
      },
    },
    body,
    status,
    h('div', { class: 'modal-actions cloud-actions' }, extra, submit),
  );
  dlg = modal({ title, content: form, actions: [], dismissible });
  return dlg;
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
 * @param {{local:{state:object}, remote:{state:object}, context:'login'|'sync'}} opts
 * @returns {Promise<'local'|'remote'>}
 */
export function openConflictDialog({ local, remote, context = 'sync' }) {
  const localAt = Date.parse(local.state?.savedAt) || 0;
  const remoteAt = Date.parse(remote.state?.savedAt) || 0;
  const recommendRemote = remoteAt >= localAt;
  const option = (which, title, state, recommended) =>
    h(
      'div',
      { class: `cloud-choice${recommended ? ' cloud-choice-recommended' : ''}`, 'data-testid': `cloud-choice-${which}` },
      h('h3', { class: 'cloud-choice-title' }, title, recommended ? h('span', { class: 'badge badge-success cloud-choice-badge' }, 'neuer') : null),
      h('p', { class: 'cloud-choice-time' }, `Zuletzt geändert: ${formatTimestamp(state?.savedAt) || 'unbekannt'}`),
      h('p', { class: 'muted small cloud-choice-summary' }, stateSummary(state)),
    );
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
      h('p', { class: 'muted small' }, 'Der andere Stand wird dabei überschrieben. Rückmeldungen, die noch im digitalen Briefkasten liegen, werden beim nächsten Abruf wieder übernommen.'),
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
 * @param {{teacher:object, allowLater?:boolean, intro?:string}} opts
 * @returns {Promise<'created'|'later'|undefined>}
 */
export function openSetupDialog({ teacher, allowLater = false, intro = '' }) {
  const pw = newPasswordFields('cloud-setup');
  const remember = rememberCheckbox('cloud-setup');
  const dlg = formDialog({
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
      alertBox('warning', h('p', {}, h('strong', {}, 'Merken Sie sich das Passwort gut. '), 'Es wird nirgends gespeichert. Ohne das Passwort lässt sich die Cloud-Sicherung nicht entschlüsseln – auch nicht von ParentsDay.')),
      pw.wraps,
      remember.wrap,
    ),
    onSubmit: async ({ close }) => {
      const password = pw.check();
      if (!password) return;
      const status = await setupCloud(teacher, password, { remember: remember.input.checked });
      announceSetup(status);
      close('created');
    },
  });
  return dlg.result;
}

/** Rückmeldung nach dem Einrichten (auch ohne Verbindung klappt es – dann später). */
function announceSetup(status) {
  if (status.kind === 'ok') toast('Cloud-Sicherung eingerichtet. Ihr Stand wird ab jetzt automatisch gesichert.', 'success', 6000);
  else if (status.kind === 'needs-password') toast(status.message || 'Für Sie gibt es bereits eine Cloud-Sicherung. Bitte geben Sie deren Passwort ein.', 'warning', 9000);
  else toast('Cloud-Sicherung eingerichtet. Ihr Stand wird hochgeladen, sobald eine Verbindung besteht.', 'info', 7000);
}

// ---------- Entsperren ----------

/**
 * Übernimmt nach erfolgreichem Entsperren den passenden Stand (fragt bei zwei verschiedenen Ständen nach).
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
 * Dialog „Passwort eingeben“ für die vorhandene Cloud-Sicherung.
 * @param {{teacher:object, message?:string, allowSkip?:boolean}} opts
 * @returns {Promise<'unlocked'|'reset'|'skipped'|undefined>}
 */
export function openUnlockDialog({ teacher, message = '', allowSkip = false }) {
  const pw = passwordField({ id: 'cloud-unlock-password', label: 'Passwort für die Cloud-Sicherung', autocomplete: 'current-password' });
  const remember = rememberCheckbox('cloud-unlock');
  const forgot = h(
    'button',
    {
      type: 'button',
      class: 'link-button cloud-forgot',
      'data-testid': 'cloud-forgot',
      onclick: async (e) => {
        if (isRepeat(e)) return;
        const result = await openResetDialog({ teacher });
        if (result === 'reset') dlg.close('reset');
      },
    },
    'Passwort vergessen?',
  );
  const dlg = formDialog({
    title: 'Passwort eingeben',
    testId: 'cloud-unlock-dialog',
    submitLabel: 'Weiter',
    submitTestId: 'cloud-unlock-submit',
    busyLabel: 'Wird geprüft …',
    buttons: [{ label: allowSkip ? 'Ohne Cloud-Sicherung weiter' : 'Abbrechen', value: allowSkip ? 'skipped' : undefined, testId: 'cloud-unlock-skip' }],
    body: h(
      'div',
      { class: 'stack-small' },
      h('p', {}, message || 'Für Sie gibt es eine Cloud-Sicherung. Geben Sie Ihr Passwort ein, um Ihren aktuellen Stand auf dieses Gerät zu holen.'),
      pw.wrap,
      remember.wrap,
      h('p', { class: 'small' }, forgot),
    ),
    onSubmit: async ({ close, showError }) => {
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
        if (err instanceof MailboxError && err.status === 403) {
          pw.setError('Das Passwort ist falsch. Bitte achten Sie auf Groß- und Kleinschreibung.');
          pw.input.select();
          return;
        }
        if (err instanceof CloudNotFoundError) {
          forgetCloudOnDevice(teacher.teacherCode);
          showError('Ihre Cloud-Sicherung gibt es nicht mehr (sie wurde z. B. auf einem anderen Gerät gelöscht). Sie können sie unter „Weitere Einstellungen“ neu einrichten.');
          return;
        }
        throw err;
      }
      const choice = await adoptAfterUnlock(teacher, unlocked, remember.input.checked);
      toast(choice === 'remote' ? 'Ihr Stand aus der Cloud-Sicherung wurde geladen.' : 'Die Cloud-Sicherung ist wieder aktiv. Ihr Stand von diesem Gerät wird gesichert.', 'success', 6000);
      close('unlocked');
    },
  });
  return dlg.result;
}

// ---------- Passwort vergessen ----------

/**
 * Ersetzt die Cloud-Sicherung durch eine neue mit neuem Passwort und dem Stand dieses Geräts.
 * @returns {Promise<'reset'|undefined>}
 */
export function openResetDialog({ teacher }) {
  const pw = newPasswordFields('cloud-reset', { label: 'Neues Passwort' });
  const remember = rememberCheckbox('cloud-reset');
  const confirmBox = h('input', { type: 'checkbox', id: 'cloud-reset-confirm', 'data-testid': 'cloud-reset-confirm' });
  const confirmError = h('div', { class: 'field-error', hidden: true }, 'Bitte bestätigen Sie, dass die bisherige Cloud-Sicherung ersetzt wird.');
  const local = loadTeacherState(teacher.teacherCode);
  const empty = isEmptyTeacherState(local);
  const dlg = formDialog({
    title: 'Passwort vergessen?',
    testId: 'cloud-reset-dialog',
    submitLabel: 'Cloud-Sicherung ersetzen',
    submitTestId: 'cloud-reset-submit',
    busyLabel: 'Wird ersetzt …',
    danger: true,
    buttons: [{ label: 'Abbrechen', value: undefined, testId: 'cloud-reset-cancel' }],
    body: h(
      'div',
      { class: 'stack-small' },
      h('p', {}, 'Ohne Ihr bisheriges Passwort lässt sich die Cloud-Sicherung nicht entschlüsseln – auch nicht von ParentsDay. Sie können sie aber durch eine neue ersetzen: mit einem neuen Passwort und dem Stand dieses Geräts.'),
      alertBox(
        'info',
        h('p', {}, h('strong', {}, 'Tipp: '), 'Ist Ihr Passwort noch auf einem anderen Gerät gemerkt? Dann ändern Sie es besser dort unter „Weitere Einstellungen“ – so geht nichts verloren.'),
      ),
      empty
        ? alertBox('warning', h('p', {}, h('strong', {}, 'Auf diesem Gerät sind noch keine Daten gespeichert. '), 'Ihre Cloud-Sicherung wäre danach leer.'))
        : h('p', { class: 'muted small' }, `Stand dieses Geräts: ${stateSummary(local)}.`),
      pw.wraps,
      remember.wrap,
      h('div', { class: 'cloud-remember' }, h('label', { class: 'checkbox-label', for: confirmBox.id }, confirmBox, ' Ich habe verstanden, dass die bisherige Cloud-Sicherung ersetzt wird.'), confirmError),
    ),
    onSubmit: async ({ close }) => {
      const password = pw.check();
      if (!password) return;
      confirmError.hidden = confirmBox.checked;
      if (!confirmBox.checked) {
        confirmBox.focus();
        return;
      }
      await resetCloud(teacher, password, { remember: remember.input.checked });
      toast('Ihre Cloud-Sicherung wurde mit dem neuen Passwort neu eingerichtet.', 'success', 7000);
      close('reset');
    },
  });
  confirmBox.addEventListener('change', () => (confirmError.hidden = true));
  return dlg.result;
}

// ---------- Passwort ändern und löschen ----------

export function openChangePasswordDialog() {
  const pw = newPasswordFields('cloud-change', { label: 'Neues Passwort' });
  return formDialog({
    title: 'Passwort ändern',
    testId: 'cloud-change-dialog',
    submitLabel: 'Passwort ändern',
    submitTestId: 'cloud-change-submit',
    busyLabel: 'Wird geändert …',
    buttons: [{ label: 'Abbrechen', value: undefined }],
    body: h(
      'div',
      { class: 'stack-small' },
      h('p', {}, 'Ihre Cloud-Sicherung wird mit dem neuen Passwort neu verschlüsselt. Auf Ihren anderen Geräten geben Sie danach einmal das neue Passwort ein.'),
      pw.wraps,
    ),
    onSubmit: async ({ close }) => {
      const password = pw.check();
      if (!password) return;
      await changeCloudPassword(password);
      toast('Das Passwort wurde geändert.', 'success');
      close('changed');
    },
  }).result;
}

async function confirmDeleteCloud() {
  const ok = await confirmDialog({
    title: 'Cloud-Sicherung löschen?',
    message: h(
      'div',
      { class: 'stack-small' },
      h('p', {}, 'Ihre Cloud-Sicherung wird vom Server gelöscht. Der Stand in diesem Browser bleibt erhalten.'),
      h('p', {}, 'Auf anderen Geräten bleibt der dort gespeicherte Stand ebenfalls erhalten, wird aber nicht mehr abgeglichen. Zum Weiterarbeiten an einem anderen Gerät brauchen Sie dann wieder eine Zwischenspeicher-Datei.'),
    ),
    confirmText: 'Cloud-Sicherung löschen',
    danger: true,
  });
  if (!ok) return;
  try {
    const deleted = await deleteCloud();
    toast(deleted ? 'Die Cloud-Sicherung wurde gelöscht.' : 'Die Cloud-Sicherung wurde auf diesem Gerät abgemeldet. Löschen lässt sie sich nur mit dem Passwort.', deleted ? 'success' : 'info', 7000);
  } catch (err) {
    toast(err instanceof MailboxError ? cloudErrorMessage(err) : friendlyError(err), 'error', 8000);
  }
}

// ---------- Nach der Anmeldung ----------

/**
 * Cloud-Sicherung beim Anmelden: vorhandenen Stand holen (Passwort) bzw. anbieten, sie einzurichten.
 * Der Stand der Lehrkraft muss schon in diesem Browser gespeichert und die Sitzung gesetzt sein.
 * @param {object} teacher
 * @param {{onProgress?: (text: string) => void}} [opts]
 * @returns {Promise<{restored: boolean}>} restored: Stand aus der Cloud übernommen
 */
export async function cloudAfterLogin(teacher, { onProgress = () => {} } = {}) {
  if (!cloudEnabled()) return { restored: false };
  const code = teacher.teacherCode;
  startCloudSync(code, { sync: false });
  const cfg = loadCloudConfig(code);
  if (cfg && hasCloudKeys(code)) {
    // Dieses Gerät kennt das Passwort: kurz abgleichen, damit gleich der neueste Stand zu sehen ist.
    onProgress('Ihr Stand wird mit der Cloud-Sicherung abgeglichen …');
    const before = loadTeacherState(code)?.savedAt;
    try {
      await withTimeout(syncCloudNow(), LOGIN_SYNC_TIMEOUT_MS);
    } catch {
      // läuft im Hintergrund weiter
    }
    return { restored: loadTeacherState(code)?.savedAt !== before };
  }
  onProgress('Cloud-Sicherung wird geprüft …');
  let info;
  try {
    info = await withTimeout(lookupCloud(teacher), LOOKUP_TIMEOUT_MS);
  } catch (err) {
    // 404: Der Dienst kennt die Cloud-Sicherung noch nicht (ältere Fassung) – dann ohne sie weiter.
    if (!(err instanceof MailboxError && err.status === 404)) {
      toast('Die Cloud-Sicherung ist gerade nicht erreichbar. Sie arbeiten mit dem Stand dieses Geräts.', 'warning', 8000);
    }
    return { restored: false };
  }
  onProgress('');
  if (info.found) {
    if (cfg && cfg.syncId !== info.syncId) forgetCloudOnDevice(code);
    const result = await openUnlockDialog({ teacher, allowSkip: true });
    if (result !== 'unlocked' && result !== 'reset') {
      rememberLockedCloud(code, info);
      toast('Sie arbeiten mit dem Stand dieses Geräts. Die Cloud-Sicherung können Sie jederzeit über „Passwort eingeben“ oben wieder verbinden.', 'info', 8000);
    }
    return { restored: result === 'unlocked' && getCloudStatus(code).kind !== 'needs-password' };
  }
  // Noch keine Cloud-Sicherung (oder sie wurde gelöscht)
  if (cfg) forgetCloudOnDevice(code);
  const local = loadTeacherState(code);
  await openSetupDialog({
    teacher,
    allowLater: true,
    intro: isEmptyTeacherState(local)
      ? 'Legen Sie jetzt ein Passwort für Ihre Cloud-Sicherung fest.'
      : 'Neu: Ihr Stand kann jetzt automatisch in der Cloud gesichert werden. Legen Sie dafür einmal ein Passwort fest.',
  });
  return { restored: false };
}

/**
 * Cloud-Sicherung bei der Registrierung: mit dem gewählten Passwort einrichten – oder, falls es schon eine gibt
 * (erneute Registrierung, z. B. an einem neuen Gerät), mit dem Passwort entsperren und den Stand holen.
 * @returns {Promise<'created'|'pending'|'restored'|'exists'>}
 *   pending: wird hochgeladen, sobald der Dienst erreichbar ist; exists: Sicherung mit anderem Passwort
 */
export async function cloudAfterRegister(teacher, password, { remember = true } = {}) {
  const code = teacher.teacherCode;
  startCloudSync(code, { sync: false });
  let info = null;
  try {
    info = await withTimeout(lookupCloud(teacher), LOOKUP_TIMEOUT_MS);
  } catch {
    info = null; // ohne Verbindung: trotzdem einrichten – hochgeladen wird später
  }
  if (info?.found) {
    try {
      const unlocked = await unlockCloud(teacher, password);
      const choice = await adoptAfterUnlock(teacher, unlocked, remember);
      return choice === 'remote' ? 'restored' : 'created';
    } catch (err) {
      if (err instanceof CloudNotFoundError) info = null;
      else {
        rememberLockedCloud(code, info);
        return 'exists';
      }
    }
  }
  const status = await setupCloud(teacher, password, { remember });
  if (status.kind === 'needs-password') return 'exists';
  return status.kind === 'ok' ? 'created' : 'pending';
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
    else if (current.kind === 'not-setup') await openSetupDialog({ teacher });
    else syncCloudNow();
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
    const active = !['not-setup', 'needs-password', 'disabled', 'off'].includes(status.kind);
    badge.className = `badge${active ? ' badge-success' : ''}`;
    badge.textContent = active ? 'Aktiv' : status.kind === 'needs-password' ? 'Passwort nötig' : 'Nicht eingerichtet';
    if (status.kind === 'not-setup') {
      mount(
        body,
        h('p', {}, 'Mit der Cloud-Sicherung ist Ihr aktueller Stand auf jedem Gerät da, an dem Sie sich anmelden – ohne Zwischenspeicher-Datei. Ihre Daten werden dafür in Ihrem Browser mit Ihrem Passwort verschlüsselt.'),
        status.message ? alertBox('warning', h('p', {}, status.message)) : null,
        h('div', { class: 'evt-mailbox-actions' }, button('Cloud-Sicherung einrichten', 'cloud-setup', () => openSetupDialog({ teacher }), 'primary')),
      );
      return;
    }
    if (status.kind === 'needs-password') {
      mount(
        body,
        h('p', {}, status.message || 'Für Sie gibt es eine Cloud-Sicherung. Geben Sie Ihr Passwort ein, damit dieses Gerät wieder abgleicht.'),
        h(
          'div',
          { class: 'evt-mailbox-actions' },
          button('Passwort eingeben', 'cloud-unlock', () => openUnlockDialog({ teacher, message: status.message }), 'primary'),
          button('Passwort vergessen?', 'cloud-card-forgot', () => openResetDialog({ teacher })),
        ),
      );
      return;
    }
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
        button('Passwort ändern', 'cloud-change-password', () => openChangePasswordDialog()),
        button('Cloud-Sicherung löschen', 'cloud-delete', () => confirmDeleteCloud()),
      ),
      h('p', { class: 'muted small' }, 'Ende-zu-Ende-verschlüsselt: Ihr Passwort verlässt diesen Browser nie. Ohne das Passwort kann niemand die Sicherung lesen – auch nicht ParentsDay.'),
    );
  };
  render(getCloudStatus(teacher.teacherCode));
  unsubscribe = onCloudStatus(render);
  return card;
}

// ---------- Einmalig beim Start ----------

let installed = false;

/**
 * Verbindet die Abgleich-Logik mit der Oberfläche: Konflikt-Dialog und Neuzeichnen der Seite, wenn ein neuerer
 * Stand von einem anderen Gerät übernommen wurde.
 * @param {{rerender: () => void}} opts
 */
export function installCloudUi({ rerender }) {
  if (installed) return;
  installed = true;
  setConflictResolver(({ local, remote }) => openConflictDialog({ local, remote, context: 'sync' }));
  let waiting = false;
  onRemoteApplied(({ source }) => {
    if (source !== 'sync' || !getSession()) return;
    toast('Neuer Stand von einem anderen Gerät übernommen.', 'info', 6000);
    // Nicht mitten in einem offenen Dialog neu zeichnen – erst, wenn er geschlossen ist.
    if (waiting) return;
    waiting = true;
    const tryRender = () => {
      if (document.querySelector('.modal-backdrop')) {
        setTimeout(tryRender, 800);
        return;
      }
      waiting = false;
      rerender();
    };
    tryRender();
  });
}
