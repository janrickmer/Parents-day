// Zugang für Lehrkräfte: Auswahl (Registrieren/Anmelden), Registrierung mit PDF-Download und
// Anmeldung per Registrierungs-PDF oder per Eingabe von Name, Geburtsdatum und Passwort der Cloud-Sicherung
// (mit dem Briefkasten-Dienst) bzw. Registrierungscode.

import { MAX_REGISTRATION_BYTES, NAME_MAX_LENGTH } from '../config.js';
import { h, mount, toast, field, alertBox, fileDropZone, friendlyError } from '../core/ui.js';
import { cleanName, initialOf, isValidIsoDate, registrationCode, teacherCode, codesEqual, normalizeCodeInput, isValidEmail, isSameTeacher } from '../core/codes.js';
import { formatDate, todayIso } from '../core/time.js';
import { getSession, setSession, clearSession, loadTeacherState, createTeacherState, saveTeacherState, updateState, takeReturnTo, isEmptyTeacherState } from '../core/storage.js';
import { savePdf, extractPayloadFromFile, preloadPdf } from '../core/pdf.js';
import { createRegistrationPdf } from '../pdf/registration-pdf.js';
import { markEmptyDevice } from '../components/backup-actions.js';
import { mailboxEnabled, MailboxError } from '../core/mailbox.js';
import { cloudEnabled, cloudErrorMessage } from '../core/cloud.js';
import { stopCloudSync, endCloudSession, flushCloudSync, whenCloudIdle, checkLoginPassword, CloudNotFoundError } from '../core/cloud-sync.js';
import { passwordField, newPasswordFields, rememberCheckbox, cloudAfterRegister, cloudAfterLogin, cloudAfterPasswordLogin } from '../components/cloud-ui.js';

const MIN_BIRTH_DATE = '1900-01-01';
const NOT_REGISTRATION = 'Diese Datei ist keine ParentsDay-Registrierung.';
const INVALID_REGISTRATION = 'Die Daten in der Datei sind ungültig.';
const CODE_MISMATCH = 'Die Angaben passen nicht zum Registrierungscode. Bitte prüfen Sie Namen, Geburtsdatum und Code.';
const CODE_COLLISION =
  'In diesem Browser sind bereits Daten einer anderen Lehrkraft mit demselben Lehrkräftecode gespeichert (gleiche Anfangsbuchstaben und gleiches Geburtsdatum). Zum Schutz dieser Daten nutzen Sie ParentsDay bitte in einem anderen Browser oder Browserprofil.';
const BACKUP_NOT_LOGIN =
  'Diese Datei ist ein Zwischenstand, keine Registrierungs-PDF. Bitte melden Sie sich zuerst an – mit Ihrer Registrierungs-PDF oder mit Ihren Daten. Danach können Sie den Zwischenstand oben über „Zwischenstand laden“ öffnen.';
const WRONG_PASSWORD =
  'Das Passwort passt nicht zu Ihren Angaben. Bitte prüfen Sie das Passwort (auch Groß- und Kleinschreibung), Ihren Namen und Ihr Geburtsdatum. Ohne Cloud-Sicherung melden Sie sich mit Ihrem Registrierungscode an.';
const MOVED_PASSWORD = 'Das Passwort Ihrer Cloud-Sicherung wurde inzwischen auf einem anderen Gerät geändert. Bitte melden Sie sich mit dem neuen Passwort an.';
const FORGOT_PASSWORD =
  'Ohne Passwort melden Sie sich mit Ihrem Registrierungscode an – er steht in Ihrer Registrierungs-PDF – oder Sie laden die PDF hoch. Ein neues Passwort legen Sie danach über „Passwort vergessen?“ fest: im Fenster „Passwort eingeben“ oder unter „Weitere Einstellungen“ bei der Cloud-Sicherung. Am besten an einem Gerät, das noch mit Ihrer Cloud-Sicherung verbunden ist – dann bleibt Ihr Stand erhalten.';
// Zuletzt erfolgreich genutzte Art der Anmeldung mit Daten ('password' oder 'code') – je Browser.
const LOGIN_MODE_KEY = 'parentsday.loginMode';

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
            onclick: async (e) => {
              if (e.detail > 1 || e.currentTarget.disabled) return;
              e.currentTarget.disabled = true;
              // Noch nicht hochgeladene Änderungen zuerst in die Cloud-Sicherung
              await flushCloudSync();
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
        ' An einem anderen Gerät melden Sie sich einfach mit Ihrem Passwort an. Niemand sonst kann Ihre Daten lesen. ',
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
          text: cloudEnabled()
            ? 'Geben Sie Ihren Namen, Ihr Geburtsdatum und Ihr Passwort ein – oder melden Sie sich mit Ihrer Registrierungs-PDF bzw. Ihrem Registrierungscode an.'
            : 'Laden Sie Ihre Registrierungs-PDF hoch – oder geben Sie Ihren Namen, Ihr Geburtsdatum und Ihren Registrierungscode ein.',
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
            'Mit diesem Passwort melden Sie sich künftig an – an jedem Gerät, und Ihr aktueller Stand ist sofort da. Er wird automatisch gesichert, mit diesem Passwort schon in Ihrem Browser verschlüsselt. Das Passwort steht nicht in der Registrierungs-PDF: Merken Sie es sich gut. Hatten Sie schon eine Cloud-Sicherung, verwenden Sie dasselbe Passwort – dann wird Ihr Stand geladen.',
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
    let pending = null; // geänderte Angaben, die erst nach dem Abgleich mit der Cloud-Sicherung übernommen werden
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
        // Schon einmal in diesem Browser registriert: Angaben aktualisieren, Klassen und Termine behalten. Mit
        // Cloud-Sicherung erst nach dem Abgleich – sonst gälte der Stand dieses (vielleicht veralteten) Geräts als
        // der neuere.
        existed = true;
        if (pw && password) pending = teacher;
        else {
          state.teacher = { ...state.teacher, ...teacher };
          saveTeacherState(state);
        }
      } else {
        state = saveTeacherState(createTeacherState(teacher));
      }
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
      pdf = await createRegistrationPdf({ ...state.teacher, ...pending });
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
        cloud = await cloudAfterRegister(state.teacher, password, { remember: remember.input.checked, email: values.email });
      } catch (err) {
        console.warn(err);
        cloud = 'failed';
      }
      if (pending) {
        // Erst wenn der Abgleich wirklich fertig ist (er kann länger dauern als die Wartezeit oben).
        await whenCloudIdle();
        const current = loadTeacherState(state.teacher.teacherCode);
        if (current && Object.keys(pending).some((key) => current.teacher[key] !== pending[key])) {
          try {
            updateState((s) => {
              s.teacher = { ...s.teacher, ...pending };
            });
          } catch (err) {
            console.warn(err);
          }
        }
      }
      state = loadTeacherState(state.teacher.teacherCode) || state;
    }
    // Seite inzwischen verlassen? Dann nicht mehr in die alte Ansicht zeichnen.
    if (!root.isConnected) return;
    renderRegisterSuccess(ctx, state, { pdf, pdfError, existed, cloud });
  }
}

/** Hinweis zur Cloud-Sicherung auf der Erfolgsseite der Registrierung. */
function cloudRegisterNote(cloud) {
  if (!cloud) return null;
  const note = (type, strong, text) => alertBox(type, h('p', { 'data-testid': 'reg-cloud-note' }, h('strong', {}, strong), text));
  if (cloud === 'created') return note('success', 'Cloud-Sicherung eingerichtet. ', 'Ihr Stand wird ab jetzt automatisch gesichert. Anmelden können Sie sich an jedem Gerät mit Namen, Geburtsdatum und Ihrem Passwort.');
  if (cloud === 'restored') return note('success', 'Ihre Cloud-Sicherung wurde geladen. ', 'Mit diesem Passwort gab es schon eine Cloud-Sicherung – Ihr Stand ist jetzt auch auf diesem Gerät.');
  if (cloud === 'kept') return note('info', 'Ihre Cloud-Sicherung bleibt verbunden. ', 'Dieses Gerät war schon mit Ihrer Cloud-Sicherung eingerichtet – Ihr Stand wird weiter damit abgeglichen.');
  if (cloud === 'kept-other') {
    return note(
      'info',
      'Das eingegebene Passwort wurde nicht übernommen. ',
      'Dieses Gerät ist schon mit einer Cloud-Sicherung eingerichtet, die ein anderes Passwort hat. Ein neues Passwort legen Sie unter „Weitere Einstellungen“ fest. Wurde es inzwischen auf einem anderen Gerät geändert, geben Sie es nach „Weiter“ oben über „Passwort eingeben“ ein.',
    );
  }
  if (cloud === 'failed') {
    return note(
      'warning',
      'Die Cloud-Sicherung konnte noch nicht angelegt werden. ',
      'Der Dienst lässt es gerade nicht zu (z. B. zu viele Versuche). ParentsDay holt das Einrichten später automatisch nach – den Zustand sehen Sie oben in der Kopfzeile. Bis dahin melden Sie sich an anderen Geräten mit Ihrem Registrierungscode an.',
    );
  }
  if (cloud === 'moved') {
    return note(
      'warning',
      'Ihre Cloud-Sicherung wurde inzwischen geändert. ',
      'Sie hat auf einem anderen Gerät ein neues Passwort bekommen oder wurde gelöscht. Geben Sie nach „Weiter“ oben über „Passwort eingeben“ das aktuelle Passwort ein.',
    );
  }
  return note(
    'info',
    'Cloud-Sicherung eingerichtet. ',
    'Die Cloud-Sicherung ist gerade nicht erreichbar – Ihr Stand wird hochgeladen, sobald eine Verbindung besteht. Bis dahin melden Sie sich an anderen Geräten mit Ihrem Registrierungscode an.',
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
        codeBox(
          'Ihr Registrierungscode',
          teacher.registrationCode,
          'reg-registration-code',
          cloudEnabled() ? 'Zum Anmelden ohne Passwort – zusammen mit Namen und Geburtsdatum.' : 'Zum Anmelden – zusammen mit Namen und Geburtsdatum.',
          true,
        ),
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
      cloudRegisterNote(cloud),
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

  // Weg 2: Daten eingeben – mit dem Passwort der Cloud-Sicherung (nur mit Dienst) oder dem Registrierungscode
  const withPassword = cloudEnabled();
  let mode = withPassword && loadLoginMode() !== 'code' ? 'password' : 'code';
  const f = {
    firstName: formField('Vorname', nameInput('login-firstname', 'given-name')),
    lastName: formField('Nachname', nameInput('login-lastname', 'family-name')),
    birthDate: formField('Geburtsdatum', birthDateInput('login-birthdate')),
    code: formField(
      'Registrierungscode',
      input('login-code', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', required: true, class: 'tauth-code-input' }),
      { hint: 'Steht in Ihrer Registrierungs-PDF, z. B. AM60127960.' },
    ),
    password: withPassword
      ? passwordField({
          id: 'login-password',
          label: 'Passwort',
          hint: 'Das Passwort Ihrer Cloud-Sicherung – festgelegt bei der Registrierung oder beim Einrichten der Cloud-Sicherung.',
          autocomplete: 'current-password',
        })
      : null,
  };
  const intro = h('p', { class: 'muted', 'data-testid': 'login-data-intro' });
  const formStatus = h('div', { class: 'tauth-status', 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary', 'data-testid': 'login-submit' }, 'Anmelden');
  // Während der Anmeldung lässt sich nicht umschalten (sonst passten Meldungen und gemerkter Weg nicht mehr).
  const linkButton = (label, testId, onClick) =>
    h('button', { type: 'button', class: 'link-button', 'data-testid': testId, onclick: (e) => e.detail > 1 || loggingIn || onClick() }, label);
  const passwordLinks = withPassword
    ? h(
        'p',
        { class: 'small tauth-login-links' },
        linkButton('Passwort vergessen?', 'login-forgot', () => {
          switchMode('code', { focus: true });
          mount(formStatus, alertBox('info', h('p', { 'data-testid': 'login-forgot-note' }, FORGOT_PASSWORD)));
        }),
        ' · ',
        linkButton('Ohne Passwort mit Registrierungscode anmelden', 'login-use-code', () => switchMode('code', { focus: true })),
      )
    : null;
  const codeLinks = withPassword ? h('p', { class: 'small tauth-login-links' }, linkButton('Mit Passwort anmelden', 'login-use-password', () => switchMode('password', { focus: true }))) : null;
  const form = h(
    'form',
    { class: 'tauth-form', novalidate: true, onsubmit: onSubmit },
    h('div', { class: 'form-grid' }, f.firstName.wrap, f.lastName.wrap, f.birthDate.wrap, f.code.wrap, f.password?.wrap),
    passwordLinks,
    codeLinks,
    formStatus,
    h('div', { class: 'form-actions tauth-actions' }, submit),
  );

  /** Passwort oder Registrierungscode – nur das jeweilige Feld ist zu sehen. */
  function switchMode(next, { focus = false } = {}) {
    mode = withPassword ? next : 'code';
    const usePassword = mode === 'password';
    f.code.wrap.hidden = usePassword;
    if (f.password) f.password.wrap.hidden = !usePassword;
    if (passwordLinks) passwordLinks.hidden = !usePassword;
    if (codeLinks) codeLinks.hidden = usePassword;
    f.code.setError('');
    f.password?.setError('');
    mount(formStatus);
    intro.textContent = usePassword
      ? 'Geben Sie Ihren Namen genau wie bei der Registrierung ein (auch mit Umlauten und Akzenten), dazu Ihr Geburtsdatum und Ihr Passwort. Ihr aktueller Stand wird dabei aus der Cloud-Sicherung geladen.'
      : 'Geben Sie Ihren Namen genau wie bei der Registrierung ein (auch mit Umlauten und Akzenten), dazu Ihr Geburtsdatum und Ihren Registrierungscode.';
    if (focus) (usePassword ? f.password.input : f.code.input).focus();
  }
  switchMode(mode);

  async function onSubmit(event) {
    event.preventDefault();
    if (loggingIn || uploading) return;
    mount(formStatus);
    const values = {
      firstName: f.firstName.input.value,
      lastName: f.lastName.input.value,
      birthDate: readDate(f.birthDate.input),
      code: f.code.input.value,
      password: f.password ? f.password.input.value : '',
    };
    const usePassword = mode === 'password';
    const ok = applyErrors([
      [f.firstName, nameError(values.firstName, 'Vornamen', 'Vorname')],
      [f.lastName, nameError(values.lastName, 'Nachnamen', 'Nachname')],
      [f.birthDate, birthDateError(f.birthDate.input)],
      usePassword ? [f.password, values.password ? '' : 'Bitte geben Sie Ihr Passwort ein.'] : [f.code, normalizeCodeInput(values.code) ? '' : 'Bitte geben Sie Ihren Registrierungscode ein.'],
    ]);
    if (!ok) return;
    if (!usePassword) {
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
    }
    loggingIn = true;
    setBusy(submit, true, 'Bitte warten …');
    try {
      await completeLogin(
        ctx,
        { firstName: values.firstName, lastName: values.lastName, birthDate: values.birthDate, email: '' },
        { typed: true, onProgress: progress(formStatus), password: usePassword ? values.password : '' },
      );
      if (withPassword) saveLoginMode(usePassword ? 'password' : 'code');
    } catch (err) {
      if (usePassword) showPasswordError(err);
      else mount(formStatus, alertBox('error', h('p', {}, 'Die Anmeldung hat nicht geklappt. ', friendlyError(err))));
    } finally {
      loggingIn = false;
      if (submit.isConnected) setBusy(submit, false);
    }
  }

  /** Anmeldung mit Passwort gescheitert: Meldung am Feld bzw. Hinweis auf den Registrierungscode. */
  function showPasswordError(err) {
    if (err instanceof CloudNotFoundError) {
      f.password.setError(err.moved ? MOVED_PASSWORD : WRONG_PASSWORD);
      f.password.input.select();
      return;
    }
    if (err instanceof MailboxError && err.status !== 429) {
      const reason = err.offline
        ? 'Die Cloud-Sicherung ist gerade nicht erreichbar – ohne sie lässt sich dieses Passwort nicht prüfen.'
        : 'Die Anmeldung mit Passwort ist gerade nicht möglich.';
      mount(
        formStatus,
        alertBox(
          'warning',
          h('p', { 'data-testid': 'login-password-unavailable' }, h('strong', {}, reason), ' Bitte melden Sie sich mit Ihrem Registrierungscode oder Ihrer Registrierungs-PDF an.'),
          h('p', {}, linkButton('Mit Registrierungscode anmelden', 'login-unavailable-use-code', () => switchMode('code', { focus: true }))),
        ),
      );
      return;
    }
    const message = err instanceof MailboxError ? cloudErrorMessage(err) : friendlyError(err);
    mount(formStatus, alertBox('error', h('p', {}, 'Die Anmeldung hat nicht geklappt. ', message)));
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
          intro,
          form,
        ),
      ),
      privacyNote(),
      h('p', { class: 'tauth-alt small' }, 'Noch nicht registriert? ', h('a', { href: '#/lehrkraft/registrieren' }, 'Jetzt registrieren')),
    ),
  );
}

function loadLoginMode() {
  try {
    return localStorage.getItem(LOGIN_MODE_KEY);
  } catch {
    return null;
  }
}

function saveLoginMode(mode) {
  try {
    localStorage.setItem(LOGIN_MODE_KEY, mode);
  } catch {
    // Speicher nicht zugänglich – beim nächsten Mal wieder mit Passwort
  }
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
 * Mit `password` (Anmeldung mit Passwort) wird es zuerst geprüft: Ist es falsch, wirft completeLogin
 * (CloudNotFoundError, MailboxError) – dann wird nichts gespeichert und niemand angemeldet.
 * @param {{typed?: boolean, onProgress?: (text: string) => void, password?: string}} [opts]
 *   typed: Namen wurden von Hand eingegeben (nicht aus der PDF gelesen); onProgress: Hinweis, solange die
 *   Cloud-Sicherung geprüft wird
 */
async function completeLogin(ctx, { firstName, lastName, birthDate, email }, { typed = false, onProgress, password = '' } = {}) {
  // Von Hand eingegebene Namen werden nur für einen neuen Zustand gespeichert – dann ohne reine Kleinschreibung.
  const first = typed ? tidyName(firstName) : cleanName(firstName);
  const last = typed ? tidyName(lastName) : cleanName(lastName);
  const code = teacherCode(first, last, birthDate);
  let state = loadTeacherState(code);
  if (state && !isSameTeacher(state.teacher, first, last, birthDate)) throw new Error(CODE_COLLISION);
  let login = null;
  if (password) {
    onProgress?.('Ihr Passwort wird geprüft …');
    try {
      login = await checkLoginPassword(state ? state.teacher : { firstName: first, lastName: last, birthDate, teacherCode: code }, password);
    } finally {
      onProgress?.('');
    }
    // Inzwischen in einem anderen Tab angelegt? Dann diesen Stand verwenden.
    state = loadTeacherState(code);
    if (state && !isSameTeacher(state.teacher, first, last, birthDate)) throw new Error(CODE_COLLISION);
  }
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
      ({ restored } = login ? await cloudAfterPasswordLogin(state.teacher, login, { onProgress }) : await cloudAfterLogin(state.teacher, { onProgress }));
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
