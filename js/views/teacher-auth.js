// Zugang für Lehrkräfte: Auswahl (Registrieren/Anmelden), Registrierung mit PDF-Download und
// Anmeldung per Registrierungs-PDF oder per Eingabe von Name, Geburtsdatum und Registrierungscode.

import { MAX_REGISTRATION_BYTES, NAME_MAX_LENGTH } from '../config.js';
import { h, mount, toast, field, alertBox, fileDropZone, friendlyError } from '../core/ui.js';
import { cleanName, initialOf, isValidIsoDate, registrationCode, teacherCode, codesEqual, normalizeCodeInput, isValidEmail, isSameTeacher } from '../core/codes.js';
import { formatDate, todayIso } from '../core/time.js';
import { getSession, setSession, clearSession, loadTeacherState, createTeacherState, saveTeacherState, updateState, takeReturnTo, isEmptyTeacherState } from '../core/storage.js';
import { savePdf, extractPayloadFromFile, preloadPdf } from '../core/pdf.js';
import { createRegistrationPdf } from '../pdf/registration-pdf.js';
import { markEmptyDevice } from '../components/backup-actions.js';
import { mailboxEnabled } from '../core/mailbox.js';
import { cloudEnabled } from '../core/cloud.js';
import { stopCloudSync, endCloudSession } from '../core/cloud-sync.js';
import { newPasswordFields, rememberCheckbox, cloudAfterRegister, cloudAfterLogin, openUnlockDialog } from '../components/cloud-ui.js';

const MIN_BIRTH_DATE = '1900-01-01';
const NOT_REGISTRATION = 'Diese Datei ist keine ParentsDay-Registrierung.';
const INVALID_REGISTRATION = 'Die Daten in der Datei sind ungültig.';
const CODE_MISMATCH = 'Die Angaben passen nicht zum Registrierungscode. Bitte prüfen Sie Namen, Geburtsdatum und Code.';
const CODE_COLLISION =
  'In diesem Browser sind bereits Daten einer anderen Lehrkraft mit demselben Lehrkräftecode gespeichert (gleiche Anfangsbuchstaben und gleiches Geburtsdatum). Zum Schutz dieser Daten nutzen Sie ParentsDay bitte in einem anderen Browser oder Browserprofil.';
const BACKUP_NOT_LOGIN =
  'Diese Datei ist ein Zwischenstand, keine Registrierungs-PDF. Bitte melden Sie sich zuerst an – mit Ihrer Registrierungs-PDF oder mit Ihren Daten. Danach können Sie den Zwischenstand oben über „Zwischenstand laden“ öffnen.';

export default function render(ctx) {
  const mode = ctx.params?.mode;
  if (mode === 'register') return renderRegister(ctx);
  if (mode === 'login') return renderLogin(ctx);
  return renderChoose(ctx);
}

// ---------- Hilfen ----------

/** Erste Seite nach der Anmeldung: ohne Elternsprechtag dessen Einrichtung, sonst die Klassen. */
function homePath(state) {
  return state?.event ? '/lehrkraft/klassen' : '/lehrkraft/elternsprechtag';
}

/** Ziel nach der Anmeldung: die zuvor direkt aufgerufene Lehrkraft-Seite, sonst die Startseite der Lehrkraft. */
function afterLoginPath(state) {
  return takeReturnTo() || homePath(state);
}

function fullName(teacher) {
  return `${teacher.firstName} ${teacher.lastName}`.trim();
}

/** Zustand der angemeldeten Lehrkraft oder null. */
function sessionState() {
  const code = getSession();
  return code ? loadTeacherState(code) : null;
}

/** Eingabefeld, dessen id zugleich der data-testid ist. */
function input(id, attrs = {}) {
  return h('input', { id, name: id, 'data-testid': id, ...attrs });
}

/** Namensfeld (Vor- oder Nachname). */
function nameInput(id, autocomplete) {
  return input(id, { type: 'text', autocomplete, autocapitalize: 'words', maxlength: NAME_MAX_LENGTH, required: true, spellcheck: 'false' });
}

/** Ganz klein geschriebene Namen erhalten große Anfangsbuchstaben („anna-lena“ → „Anna-Lena“). */
function tidyName(name) {
  const clean = cleanName(name);
  if (clean !== clean.toLocaleLowerCase('de-DE')) return clean;
  return clean.replace(/(^|[\s-])(\p{Ll})/gu, (_, sep, ch) => sep + [...ch.toLocaleUpperCase('de-DE')][0]);
}

/**
 * Formularfeld mit Beschriftung, optionalem Hinweis und Fehlermeldung am Feld.
 * @returns {{wrap: HTMLElement, input: HTMLInputElement, setError: (message: string) => void}}
 */
function formField(label, control, { hint = '', full = false } = {}) {
  const wrap = field(label, control, { hint });
  if (full) wrap.classList.add('field-full');
  const hintEl = wrap.querySelector('.field-hint');
  if (hintEl) hintEl.id = `${control.id}-hint`;
  const error = h('div', { class: 'field-error', id: `${control.id}-error`, hidden: true });
  wrap.appendChild(error);
  const describe = (withError) => {
    const ids = [withError ? error.id : null, hintEl ? hintEl.id : null].filter(Boolean);
    if (ids.length) control.setAttribute('aria-describedby', ids.join(' '));
    else control.removeAttribute('aria-describedby');
  };
  const setError = (message) => {
    error.textContent = message || '';
    error.hidden = !message;
    if (message) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
    describe(Boolean(message));
  };
  describe(false);
  // Fehler verschwindet, sobald korrigiert wird (ohne neu zu zeichnen – der Fokus bleibt erhalten).
  const clear = () => {
    if (control.getAttribute('aria-invalid') === 'true') setError('');
  };
  control.addEventListener('input', clear);
  control.addEventListener('change', clear);
  return { wrap, input: control, setError };
}

/** Datumsfeld auslesen. Browser ohne Datumsauswahl liefern Text – dann auch „TT.MM.JJJJ“ akzeptieren. */
function readDate(control) {
  const raw = control.value.trim();
  const m = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/.exec(raw);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return raw;
}

function birthDateInput(id) {
  return input(id, { type: 'date', min: MIN_BIRTH_DATE, max: todayIso(), autocomplete: 'bday', required: true, placeholder: 'TT.MM.JJJJ' });
}

function nameError(value, accusative, nominative) {
  if (!cleanName(value)) return `Bitte geben Sie Ihren ${accusative} ein.`;
  if (!initialOf(value)) return `Der ${nominative} muss mindestens einen Buchstaben enthalten.`;
  return '';
}

function birthDateError(control) {
  const value = readDate(control);
  if (!value) {
    return control.validity?.badInput ? 'Das Geburtsdatum ist unvollständig. Bitte geben Sie Tag, Monat und Jahr an.' : 'Bitte geben Sie Ihr Geburtsdatum ein.';
  }
  if (!isValidIsoDate(value)) return 'Bitte geben Sie ein gültiges Datum ein (TT.MM.JJJJ).';
  if (value > todayIso()) return 'Das Geburtsdatum darf nicht in der Zukunft liegen.';
  if (value < MIN_BIRTH_DATE) return 'Bitte prüfen Sie das Jahr – es muss 1900 oder später sein.';
  return '';
}

/**
 * Prüft alle Felder, zeigt Fehler am Feld an und setzt den Fokus auf das erste fehlerhafte Feld.
 * @param {Array<[{setError:Function, input:HTMLElement}, string]>} checks – Feld und Fehlermeldung ('' = in Ordnung)
 */
function applyErrors(checks) {
  let first = null;
  for (const [f, message] of checks) {
    f.setError(message);
    if (message && !first) first = f.input;
  }
  first?.focus();
  return !first;
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

/** Umschalter zwischen Registrieren und Anmelden. */
function authSwitch(active) {
  const link = (mode, href, label) => h('a', { href, class: 'tauth-switch-link', 'aria-current': mode === active ? 'page' : null }, label);
  return h(
    'nav',
    { class: 'tauth-switch', 'aria-label': 'Registrieren oder anmelden' },
    link('register', '#/lehrkraft/registrieren', 'Registrieren'),
    link('login', '#/lehrkraft/anmelden', 'Anmelden'),
  );
}

/** Hinweis „Sie sind angemeldet als …“ mit „Weiter“ und „Abmelden“ – oder null. */
function sessionBanner(ctx) {
  const state = sessionState();
  if (!state) return null;
  return alertBox(
    'info',
    h(
      'div',
      { class: 'tauth-session' },
      h('p', { class: 'tauth-session-text' }, 'Sie sind angemeldet als ', h('strong', {}, fullName(state.teacher)), '.'),
      h(
        'div',
        { class: 'cluster' },
        h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'session-continue', onclick: () => ctx.navigate(homePath(state)) }, 'Weiter'),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-ghost',
            onclick: () => {
              endCloudSession(state.teacher.teacherCode);
              stopCloudSync();
              clearSession();
              toast('Sie wurden abgemeldet.', 'info');
              ctx.rerender();
            },
          },
          'Abmelden',
        ),
      ),
    ),
  );
}

function privacyNote() {
  // Mit Dienst liegen Cloud-Sicherung, Rückmeldungen und Elternbrief-Angaben (verschlüsselt) auch dort.
  if (cloudEnabled()) {
    return alertBox(
      'info',
      h(
        'p',
        {},
        h('strong', {}, 'Ihre Daten werden in diesem Browser gespeichert und – mit Ihrem Passwort verschlüsselt – in der Cloud-Sicherung.'),
        ' An einem anderen Gerät melden Sie sich einfach an und geben Ihr Passwort ein. Niemand sonst kann Ihre Daten lesen. ',
        h('a', { href: '#/datenschutz' }, 'Mehr zum Datenschutz'),
      ),
    );
  }
  const withMailbox = mailboxEnabled();
  return alertBox(
    'info',
    h(
      'p',
      {},
      h('strong', {}, withMailbox ? 'Ihre Daten werden in diesem Browser gespeichert.' : 'Ihre Daten werden nur in diesem Browser gespeichert.'),
      withMailbox
        ? ' Beim digitalen Briefkasten liegen nur die Rückmeldungen der Eltern und die Angaben aus Ihren Elternbriefen – verschlüsselt. '
        : ' ParentsDay hat keinen Server. ',
      'Wenn Sie an einem anderen Gerät weiterarbeiten möchten, laden Sie nach der Anmeldung Ihren Zwischenstand über „Zwischenstand laden“. ',
      h('a', { href: '#/datenschutz' }, 'Mehr zum Datenschutz'),
    ),
  );
}

// ---------- Auswahl ----------

function renderChoose(ctx) {
  const { root, setTitle } = ctx;
  setTitle('Zugang für Lehrkräfte');
  const choice = ({ variant, href, testId, icon, eyebrow, title, text, cta }) =>
    h(
      'a',
      { class: `tauth-choice tauth-choice-${variant}`, href, 'data-testid': testId },
      h('span', { class: 'tauth-choice-icon', 'aria-hidden': 'true' }, icon),
      h('span', { class: 'tauth-eyebrow' }, eyebrow),
      h('h2', { class: 'tauth-choice-title' }, title),
      h('p', { class: 'tauth-choice-text' }, text),
      h('span', { class: `btn ${variant === 'register' ? 'btn-primary' : 'btn-secondary'} tauth-choice-cta` }, cta, h('span', { 'aria-hidden': 'true' }, ' →')),
    );

  mount(
    root,
    h(
      'div',
      { class: 'tauth-page' },
      h(
        'header',
        { class: 'page-header' },
        h('div', {}, h('h1', {}, 'Zugang für Lehrkräfte'), h('p', { class: 'subtitle' }, 'Beim ersten Besuch registrieren Sie sich. Danach melden Sie sich einfach an.')),
      ),
      sessionBanner(ctx),
      h(
        'div',
        { class: 'grid-2 tauth-choices' },
        choice({
          variant: 'register',
          href: '#/lehrkraft/registrieren',
          testId: 'auth-choose-register',
          icon: '+',
          eyebrow: 'Zum ersten Mal hier',
          title: 'Registrieren',
          text: 'Tragen Sie Ihren Namen, Ihr Geburtsdatum und Ihre E-Mail-Adresse ein – Sie erhalten sofort eine PDF-Datei mit Ihrem Registrierungscode.',
          cta: 'Jetzt registrieren',
        }),
        choice({
          variant: 'login',
          href: '#/lehrkraft/anmelden',
          testId: 'auth-choose-login',
          icon: '→',
          eyebrow: 'Schon registriert',
          title: 'Anmelden',
          text: 'Laden Sie Ihre Registrierungs-PDF hoch – oder geben Sie Ihren Namen, Ihr Geburtsdatum und Ihren Registrierungscode ein.',
          cta: 'Zur Anmeldung',
        }),
      ),
      privacyNote(),
    ),
  );
}

// ---------- Registrieren ----------

function renderRegister(ctx) {
  const { root, setTitle } = ctx;
  setTitle('Registrieren');
  // PDF-Bibliothek schon laden, während das Formular ausgefüllt wird.
  preloadPdf().catch(() => {});

  const f = {
    firstName: formField('Vorname', nameInput('reg-firstname', 'given-name')),
    lastName: formField('Nachname', nameInput('reg-lastname', 'family-name')),
    birthDate: formField('Geburtsdatum', birthDateInput('reg-birthdate'), { hint: 'Mit Jahr, z. B. 15.03.1990. Wird für Ihren Registrierungscode benötigt.' }),
    email: formField('E-Mail-Adresse', input('reg-email', { type: 'email', autocomplete: 'email', maxlength: 254, required: true, spellcheck: 'false' }), {
      hint: mailboxEnabled()
        ? 'Steht in Ihren Elternbriefen – für Fragen der Eltern und als Notlösung, falls der digitale Briefkasten nicht erreichbar ist.'
        : 'An diese Adresse schicken Eltern ihre Rückmeldungen.',
    }),
  };
  // Passwort für die Cloud-Sicherung (nur mit Dienst)
  const pw = cloudEnabled() ? newPasswordFields('reg') : null;
  const remember = cloudEnabled() ? rememberCheckbox('reg') : null;
  const status = h('div', { class: 'tauth-status', 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-large', 'data-testid': 'reg-submit' }, 'Registrieren und PDF herunterladen');

  const form = h(
    'form',
    { class: 'tauth-form', novalidate: true, onsubmit: onSubmit },
    h('div', { class: 'form-grid' }, f.firstName.wrap, f.lastName.wrap, f.birthDate.wrap, f.email.wrap),
    pw
      ? h(
          'fieldset',
          { class: 'tauth-cloud', 'data-testid': 'reg-cloud' },
          h('legend', {}, 'Cloud-Sicherung'),
          h(
            'p',
            { class: 'muted small tauth-cloud-text' },
            'Ihr Stand wird automatisch gesichert – mit diesem Passwort schon in Ihrem Browser verschlüsselt. An jedem anderen Gerät melden Sie sich an, geben das Passwort ein und haben alles da. Das Passwort steht nicht in der Registrierungs-PDF: Merken Sie es sich gut.',
          ),
          h('div', { class: 'form-grid' }, pw.wraps),
          remember.wrap,
        )
      : null,
    status,
    h('div', { class: 'form-actions tauth-actions' }, submit),
  );

  mount(
    root,
    h(
      'div',
      { class: 'tauth-page tauth-page-narrow' },
      authSwitch('register'),
      h(
        'header',
        { class: 'page-header' },
        h('div', {}, h('h1', {}, 'Registrieren'), h('p', { class: 'subtitle' }, 'Tragen Sie Ihre Daten ein. Danach erhalten Sie eine PDF-Datei mit Ihrem Registrierungscode.')),
      ),
      sessionBanner(ctx),
      h('div', { class: 'card' }, form),
      privacyNote(),
      h('p', { class: 'tauth-alt small' }, 'Sie haben sich schon registriert? ', h('a', { href: '#/lehrkraft/anmelden' }, 'Hier anmelden')),
    ),
  );

  async function onSubmit(event) {
    event.preventDefault();
    if (submit.disabled) return;
    mount(status);
    const values = {
      firstName: f.firstName.input.value,
      lastName: f.lastName.input.value,
      birthDate: readDate(f.birthDate.input),
      email: f.email.input.value.trim(),
    };
    // Passwort zuerst prüfen: Den Fokus bekommt danach das erste fehlerhafte Feld von oben.
    const password = pw ? pw.check() : '';
    const ok = applyErrors([
      [f.firstName, nameError(values.firstName, 'Vornamen', 'Vorname')],
      [f.lastName, nameError(values.lastName, 'Nachnamen', 'Nachname')],
      [f.birthDate, birthDateError(f.birthDate.input)],
      [f.email, !values.email ? 'Bitte geben Sie Ihre E-Mail-Adresse ein.' : isValidEmail(values.email) ? '' : 'Bitte geben Sie eine gültige E-Mail-Adresse ein, z. B. name@schule.de.'],
    ]);
    if (!ok || password === null) {
      mount(status, alertBox('error', 'Bitte prüfen Sie die rot markierten Felder.'));
      return;
    }

    setBusy(submit, true, 'PDF wird erstellt …');
    let state;
    let existed = false;
    try {
      const firstName = cleanName(values.firstName);
      const lastName = cleanName(values.lastName);
      const teacher = {
        firstName,
        lastName,
        birthDate: values.birthDate,
        email: values.email,
        registrationCode: registrationCode(firstName, lastName, values.birthDate),
        teacherCode: teacherCode(firstName, lastName, values.birthDate),
      };
      state = loadTeacherState(teacher.teacherCode);
      if (state && !isSameTeacher(state.teacher, firstName, lastName, values.birthDate)) {
        setBusy(submit, false);
        mount(status, alertBox('error', CODE_COLLISION));
        return;
      }
      if (state) {
        // Schon einmal in diesem Browser registriert: Angaben aktualisieren, Klassen und Termine behalten.
        existed = true;
        state.teacher = { ...state.teacher, ...teacher };
      } else {
        state = createTeacherState(teacher);
      }
      saveTeacherState(state);
      // Gleich angemeldet: Neuladen oder „Zurück“ auf der Erfolgsseite führt nicht zu einem leeren Formular.
      setSession(teacher.teacherCode);
    } catch (err) {
      setBusy(submit, false);
      mount(status, alertBox('error', 'Die Registrierung konnte nicht gespeichert werden. ', friendlyError(err)));
      return;
    }

    let pdf = null;
    let pdfError = '';
    try {
      pdf = await createRegistrationPdf(state.teacher);
      savePdf(pdf.doc, pdf.filename);
    } catch (err) {
      pdf = null;
      pdfError = friendlyError(err);
    }

    // Cloud-Sicherung einrichten (oder eine vorhandene mit dem Passwort holen)
    let cloud = '';
    if (pw && password) {
      mount(submit, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Cloud-Sicherung wird eingerichtet …');
      try {
        cloud = await cloudAfterRegister(state.teacher, password, { remember: remember.input.checked });
      } catch (err) {
        console.warn(err);
        cloud = 'failed';
      }
      state = loadTeacherState(state.teacher.teacherCode) || state;
    }
    // Seite inzwischen verlassen? Dann nicht mehr in die alte Ansicht zeichnen.
    if (!root.isConnected) return;
    renderRegisterSuccess(ctx, state, { pdf, pdfError, existed, cloud });
  }
}

/** Hinweis zur Cloud-Sicherung auf der Erfolgsseite der Registrierung. */
function cloudRegisterNote(ctx, teacher, cloud) {
  if (!cloud) return null;
  if (cloud === 'created') {
    return alertBox('success', h('p', { 'data-testid': 'reg-cloud-note' }, h('strong', {}, 'Cloud-Sicherung eingerichtet. '), 'Ihr Stand wird ab jetzt automatisch gesichert. An einem anderen Gerät melden Sie sich an und geben Ihr Passwort ein.'));
  }
  if (cloud === 'restored') {
    return alertBox('success', h('p', { 'data-testid': 'reg-cloud-note' }, h('strong', {}, 'Ihre Cloud-Sicherung wurde geladen. '), 'Für Sie gab es schon eine Cloud-Sicherung mit diesem Passwort – Ihr Stand ist jetzt auch auf diesem Gerät.'));
  }
  if (cloud === 'exists') {
    return alertBox(
      'warning',
      h('p', { 'data-testid': 'reg-cloud-note' }, h('strong', {}, 'Für Sie gibt es bereits eine Cloud-Sicherung mit einem anderen Passwort. '), 'Geben Sie das bisherige Passwort ein, um Ihren Stand auf dieses Gerät zu holen.'),
      h(
        'p',
        {},
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-secondary',
            'data-testid': 'reg-cloud-unlock',
            onclick: async (e) => {
              if (e.detail > 1) return;
              const result = await openUnlockDialog({ teacher });
              if (result === 'unlocked' || result === 'reset') ctx.rerender();
            },
          },
          'Passwort eingeben',
        ),
      ),
    );
  }
  return alertBox(
    'info',
    h('p', { 'data-testid': 'reg-cloud-note' }, h('strong', {}, 'Cloud-Sicherung eingerichtet. '), 'Die Cloud-Sicherung ist gerade nicht erreichbar – Ihr Stand wird hochgeladen, sobald eine Verbindung besteht.'),
  );
}

function renderRegisterSuccess(ctx, state, { pdf, pdfError, existed, cloud = '' }) {
  const { root, setTitle, navigate } = ctx;
  const teacher = state.teacher;
  setTitle('Registrierung abgeschlossen');
  let current = pdf;

  // Hinweis zum Download mit Knopf „PDF erneut herunterladen“ (bei Fehler rot).
  const downloadText = h('div', { class: 'tauth-download-text', 'aria-live': 'polite' });
  const downloadBtn = h('button', { type: 'button', class: 'btn btn-secondary', 'data-testid': 'reg-download', onclick: onDownload }, '');
  const downloadBox = h('div', { class: 'alert tauth-download' }, downloadText, downloadBtn);
  const showDownload = (ok, message = '') => {
    downloadBox.className = `alert ${ok ? 'alert-success' : 'alert-error'} tauth-download`;
    downloadBtn.textContent = ok ? 'PDF erneut herunterladen' : 'PDF herunterladen';
    mount(
      downloadText,
      ok
        ? h('p', {}, 'Die PDF-Datei wurde heruntergeladen. Bewahren Sie sie gut auf – mit ihr können Sie sich jederzeit anmelden.')
        : h('p', {}, h('strong', {}, 'Die PDF-Datei konnte nicht erstellt werden. '), message ? `(${message}) ` : '', 'Bitte versuchen Sie es mit dem Knopf „PDF herunterladen“ erneut.'),
    );
  };
  showDownload(Boolean(current), pdfError);

  async function onDownload() {
    setBusy(downloadBtn, true, 'PDF wird erstellt …');
    try {
      if (!current) current = await createRegistrationPdf(teacher);
      savePdf(current.doc, current.filename);
      setBusy(downloadBtn, false);
      showDownload(true);
    } catch (err) {
      setBusy(downloadBtn, false);
      showDownload(false, friendlyError(err));
    }
  }

  const onContinue = () => {
    setSession(teacher.teacherCode);
    navigate(afterLoginPath(loadTeacherState(teacher.teacherCode) || state));
  };

  const codeBox = (label, code, testId, hint, big) =>
    h(
      'div',
      { class: `tauth-code-box${big ? ' tauth-code-box-main' : ''}` },
      h('div', { class: 'tauth-code-label' }, label),
      h('div', { class: 'tauth-code-value', 'data-testid': testId }, code),
      h('div', { class: 'tauth-code-hint' }, hint),
    );

  const heading = h('h1', { tabindex: '-1', class: 'tauth-success-title' }, 'Registrierung abgeschlossen');
  mount(
    root,
    h(
      'div',
      { class: 'tauth-page tauth-page-narrow tauth-success' },
      h(
        'header',
        { class: 'tauth-success-head' },
        h('span', { class: 'tauth-success-icon', 'aria-hidden': 'true' }, '✓'),
        h('div', {}, heading, h('p', { class: 'subtitle muted' }, `Willkommen bei ParentsDay, ${fullName(teacher)}!`)),
      ),
      downloadBox,
      h(
        'div',
        { class: 'tauth-codes' },
        codeBox('Ihr Registrierungscode', teacher.registrationCode, 'reg-registration-code', 'Zum Anmelden – zusammen mit Namen und Geburtsdatum.', true),
        codeBox('Ihr Lehrkräftecode', teacher.teacherCode, 'reg-teacher-code', 'Ihre persönliche Kennung. Sie steckt in den Codes Ihrer Schülerinnen und Schüler.', false),
      ),
      h(
        'section',
        { class: 'card tauth-summary-card', 'aria-labelledby': 'tauth-summary-title' },
        h('h2', { id: 'tauth-summary-title' }, 'Ihre Angaben'),
        h(
          'dl',
          { class: 'tauth-summary' },
          h('dt', {}, 'Name'),
          h('dd', {}, fullName(teacher)),
          h('dt', {}, 'Geburtsdatum'),
          h('dd', {}, formatDate(teacher.birthDate)),
          h('dt', {}, 'E-Mail-Adresse'),
          h('dd', {}, teacher.email),
        ),
      ),
      cloudRegisterNote(ctx, teacher, cloud),
      existed && cloud !== 'restored'
        ? alertBox('info', h('p', {}, 'Für Sie waren in diesem Browser schon Daten gespeichert. Ihre Angaben wurden aktualisiert – Elternsprechtag, Klassen und Termine bleiben erhalten.'))
        : null,
      h(
        'div',
        { class: 'form-actions tauth-actions' },
        h(
          'button',
          { type: 'button', class: 'btn btn-primary btn-large', 'data-testid': 'reg-continue', onclick: onContinue },
          (loadTeacherState(teacher.teacherCode) || state).event ? 'Weiter zu Ihren Klassen' : 'Weiter zur Einrichtung des Elternsprechtags',
        ),
      ),
    ),
  );
  window.scrollTo(0, 0);
  heading.focus();
}

// ---------- Anmelden ----------

function renderLogin(ctx) {
  const { root, setTitle } = ctx;
  setTitle('Anmelden');

  // Weg 1: Registrierungs-PDF hochladen
  const uploadStatus = h('div', { class: 'tauth-status', 'aria-live': 'polite' });
  let uploading = false;
  const dropzone = fileDropZone({
    accept: '.pdf,application/pdf',
    testId: 'login-upload',
    label: 'Registrierungs-PDF auswählen oder hierher ziehen',
    hint: 'Datei „ParentsDay Registrierung … .pdf“',
    onFiles: ([file]) => onUpload(file),
  });

  const progress = (el) => (text) => mount(el, text ? h('p', { class: 'muted tauth-checking' }, h('span', { class: 'spinner tauth-spinner', 'aria-hidden': 'true' }), text) : null);
  let loggingIn = false;

  async function onUpload(file) {
    if (uploading || loggingIn || !file) return;
    uploading = true;
    progress(uploadStatus)(`„${file.name}“ wird geprüft …`);
    try {
      const data = await readRegistrationFile(file);
      if (!root.isConnected) return;
      mount(uploadStatus);
      loggingIn = true;
      await completeLogin(ctx, data, { onProgress: progress(uploadStatus) });
    } catch (err) {
      mount(uploadStatus, alertBox('error', h('p', {}, friendlyError(err, NOT_REGISTRATION))));
    } finally {
      uploading = false;
      loggingIn = false;
    }
  }

  // Weg 2: Daten eingeben
  const f = {
    firstName: formField('Vorname', nameInput('login-firstname', 'given-name')),
    lastName: formField('Nachname', nameInput('login-lastname', 'family-name')),
    birthDate: formField('Geburtsdatum', birthDateInput('login-birthdate')),
    code: formField(
      'Registrierungscode',
      input('login-code', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', required: true, class: 'tauth-code-input' }),
      { hint: 'Steht in Ihrer Registrierungs-PDF, z. B. AM60127960.' },
    ),
  };
  const formStatus = h('div', { class: 'tauth-status', 'aria-live': 'polite' });
  const form = h(
    'form',
    { class: 'tauth-form', novalidate: true, onsubmit: onSubmit },
    h('div', { class: 'form-grid' }, f.firstName.wrap, f.lastName.wrap, f.birthDate.wrap, f.code.wrap),
    formStatus,
    h('div', { class: 'form-actions tauth-actions' }, h('button', { type: 'submit', class: 'btn btn-primary', 'data-testid': 'login-submit' }, 'Anmelden')),
  );

  async function onSubmit(event) {
    event.preventDefault();
    if (loggingIn || uploading) return;
    mount(formStatus);
    const values = {
      firstName: f.firstName.input.value,
      lastName: f.lastName.input.value,
      birthDate: readDate(f.birthDate.input),
      code: f.code.input.value,
    };
    const ok = applyErrors([
      [f.firstName, nameError(values.firstName, 'Vornamen', 'Vorname')],
      [f.lastName, nameError(values.lastName, 'Nachnamen', 'Nachname')],
      [f.birthDate, birthDateError(f.birthDate.input)],
      [f.code, normalizeCodeInput(values.code) ? '' : 'Bitte geben Sie Ihren Registrierungscode ein.'],
    ]);
    if (!ok) return;
    let expected = '';
    try {
      expected = registrationCode(values.firstName, values.lastName, values.birthDate);
    } catch {
      expected = '';
    }
    if (!codesEqual(expected, values.code)) {
      f.code.input.setAttribute('aria-invalid', 'true');
      mount(formStatus, alertBox('error', h('p', {}, CODE_MISMATCH)));
      f.code.input.focus();
      return;
    }
    loggingIn = true;
    try {
      await completeLogin(ctx, { firstName: values.firstName, lastName: values.lastName, birthDate: values.birthDate, email: '' }, { typed: true, onProgress: progress(formStatus) });
    } catch (err) {
      mount(formStatus, alertBox('error', h('p', {}, 'Die Anmeldung hat nicht geklappt. ', friendlyError(err))));
    } finally {
      loggingIn = false;
    }
  }

  mount(
    root,
    h(
      'div',
      { class: 'tauth-page' },
      authSwitch('login'),
      h(
        'header',
        { class: 'page-header' },
        h('div', {}, h('h1', {}, 'Anmelden'), h('p', { class: 'subtitle' }, 'Wählen Sie einen der beiden Wege – beide führen zum selben Ziel.')),
      ),
      sessionBanner(ctx),
      h(
        'div',
        { class: 'grid-2 tauth-ways' },
        h(
          'section',
          { class: 'card tauth-way', 'aria-labelledby': 'tauth-way-pdf' },
          h('span', { class: 'tauth-eyebrow' }, 'Möglichkeit 1'),
          h('h2', { id: 'tauth-way-pdf' }, 'Mit Ihrer Registrierungs-PDF'),
          h('p', { class: 'muted' }, 'Laden Sie die PDF-Datei hoch, die Sie bei der Registrierung erhalten haben. ParentsDay liest Ihre Daten automatisch aus.'),
          dropzone,
          uploadStatus,
          h('p', { class: 'small muted tauth-tip' }, 'Tipp: Heruntergeladene Dateien finden Sie meist im Ordner „Downloads“.'),
        ),
        h(
          'section',
          { class: 'card tauth-way', 'aria-labelledby': 'tauth-way-data' },
          h('span', { class: 'tauth-eyebrow' }, 'Möglichkeit 2'),
          h('h2', { id: 'tauth-way-data' }, 'Mit Ihren Daten'),
          h('p', { class: 'muted' }, 'Geben Sie Ihren Namen genau wie bei der Registrierung ein (auch mit Umlauten und Akzenten), dazu Ihr Geburtsdatum und Ihren Registrierungscode.'),
          form,
        ),
      ),
      privacyNote(),
      h('p', { class: 'tauth-alt small' }, 'Noch nicht registriert? ', h('a', { href: '#/lehrkraft/registrieren' }, 'Jetzt registrieren')),
    ),
  );
}

/**
 * Liest und prüft eine Registrierungs-PDF.
 * @returns {Promise<{firstName:string, lastName:string, birthDate:string, email:string}>}
 */
async function readRegistrationFile(file) {
  const notRegistration = new Error(`${NOT_REGISTRATION} Bitte wählen Sie die Datei „ParentsDay Registrierung …“, die Sie bei der Registrierung erhalten haben.`);
  if (file.size > MAX_REGISTRATION_BYTES) throw notRegistration;
  let payload = null;
  try {
    payload = await extractPayloadFromFile(file);
  } catch {
    payload = null;
  }
  if (!payload && (await isBackupFile(file))) throw new Error(BACKUP_NOT_LOGIN);
  if (!payload || payload.app !== 'ParentsDay' || payload.type !== 'teacher-registration') throw notRegistration;
  const data = {
    firstName: cleanName(payload.firstName),
    lastName: cleanName(payload.lastName),
    birthDate: String(payload.birthDate || ''),
    email: String(payload.email || '').trim(),
  };
  // Die Adresse landet später im Elternbrief-Link und in mailto-Links – nur gültige Adressen übernehmen.
  if (!isValidEmail(data.email)) data.email = '';
  let valid = false;
  try {
    valid = Boolean(initialOf(data.firstName) && initialOf(data.lastName) && isValidIsoDate(data.birthDate)) && codesEqual(registrationCode(data.firstName, data.lastName, data.birthDate), payload.registrationCode);
  } catch {
    valid = false;
  }
  if (!valid) throw new Error(INVALID_REGISTRATION);
  return data;
}

/** Erkennt eine Zwischenspeicher-Datei (JSON), die versehentlich statt der Registrierungs-PDF gewählt wurde. */
async function isBackupFile(file) {
  try {
    const raw = JSON.parse(await file.text());
    return Boolean(raw && raw.app === 'ParentsDay' && raw.type === 'teacher-state');
  } catch {
    return false;
  }
}

/**
 * Meldet die Lehrkraft an. Legt einen leeren Zustand an, wenn auf diesem Gerät noch keiner existiert, und holt
 * mit dem Passwort den Stand aus der Cloud-Sicherung (bzw. bietet an, sie einzurichten).
 * @param {{typed?: boolean, onProgress?: (text: string) => void}} [opts] – typed: Namen wurden von Hand eingegeben
 *   (nicht aus der PDF gelesen); onProgress: Hinweis, solange die Cloud-Sicherung geprüft wird
 */
async function completeLogin(ctx, { firstName, lastName, birthDate, email }, { typed = false, onProgress } = {}) {
  // Von Hand eingegebene Namen werden nur für einen neuen Zustand gespeichert – dann ohne reine Kleinschreibung.
  const first = typed ? tidyName(firstName) : cleanName(firstName);
  const last = typed ? tidyName(lastName) : cleanName(lastName);
  const code = teacherCode(first, last, birthDate);
  let state = loadTeacherState(code);
  if (state && !isSameTeacher(state.teacher, first, last, birthDate)) throw new Error(CODE_COLLISION);
  const created = !state;
  if (created) {
    state = saveTeacherState(
      createTeacherState({ firstName: first, lastName: last, birthDate, email: email || '', registrationCode: registrationCode(first, last, birthDate), teacherCode: code }),
    );
  }
  setSession(code);
  if (!created && !state.teacher.email && email) {
    state = updateState((s) => {
      s.teacher.email = email;
    });
  }
  let restored = false;
  if (cloudEnabled()) {
    try {
      ({ restored } = await cloudAfterLogin(state.teacher, { onProgress }));
    } catch (err) {
      console.warn(err);
    }
    onProgress?.('');
    state = loadTeacherState(code) || state;
  }
  toast(`Willkommen, ${fullName(state.teacher)}!`, 'success');
  // Neues Gerät ohne Stand aus der Cloud: „Elternsprechtag erstellen“ zeigt einen Hinweis mit „Zwischenstand laden“.
  markEmptyDevice(code, created && !restored && isEmptyTeacherState(state));
  ctx.navigate(afterLoginPath(state));
}
