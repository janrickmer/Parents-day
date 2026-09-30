// Upload-Bereich für die Rückmeldungen der Eltern: mehrere PDF-Dateien auf einmal (auch .txt/.eml)
// oder eingefügter E-Mail-Text mit dem Block PARENTSDAY[…]. Die Klasse wird am Code erkannt.
// Ist ein digitaler Briefkasten eingerichtet (MAILBOX_URL), steht darüber der Abschnitt „Digitaler
// Briefkasten“: Beim Einbinden werden neue Rückmeldungen automatisch abgeholt (höchstens alle 30 s je Tab).
// Ohne MAILBOX_URL sieht der Bereich genau so aus wie bisher.

import { h, mount, modal, fileDropZone, alertBox, field, plural, friendlyError } from '../core/ui.js';
import { updateState, getCurrentState } from '../core/storage.js';
import { readResponsesFromFiles, applyResponses, findResponsesInMailText, UP_TO_DATE_REASONS } from '../core/responses.js';
import { formatTimestamp } from '../core/time.js';
import { mailboxEnabled, MailboxError } from '../core/mailbox.js';
import { hasTeacherMailbox, fetchMailboxResponses, publishClassDirectory } from '../core/teacher-mailbox.js';

// Bericht des letzten Imports. Zeichnet die Seite in onImported() neu, zeigt der neu erzeugte
// Upload-Bereich derselben Klasse den Bericht weiter an.
let carryOver = null;
const CARRY_OVER_MS = 15000;

const ACCEPT = '.pdf,application/pdf,.txt,.eml,text/plain,message/rfc822';

// Digitaler Briefkasten: automatischer Abruf höchstens alle 30 s je Tab. Ein laufender Abruf wird von
// allen Upload-Bereichen mitbenutzt (z. B. nach einem schnellen Seitenwechsel). Der Stand gilt je
// Lehrkraft und Briefkasten – meldet sich im selben Tab eine andere Lehrkraft an, beginnt er neu.
const AUTO_FETCH_MS = 30000;
let fetchInfo = { key: '', lastAttemptAt: 0, lastError: null, running: null };
// Verzeichniseinträge (Termin-Schlüssel), die in diesem Tab schon abgelegt wurden
const published = new Set();

/** Abruf-Stand für den Briefkasten der angemeldeten Lehrkraft. */
function currentFetchInfo() {
  const state = getCurrentState();
  const key = hasTeacherMailbox(state) ? `${state.teacher.teacherCode}|${state.mailbox.id}` : '';
  if (fetchInfo.key !== key) fetchInfo = { key, lastAttemptAt: 0, lastError: null, running: null };
  return fetchInfo;
}

/**
 * Legt für alle Klassen mit Codes den Verzeichniseintrag ab (still). Ist der Briefkasten nicht
 * erreichbar, wird es beim nächsten Abruf erneut versucht.
 */
function publishDirectories(state) {
  if (!state?.event || !hasTeacherMailbox(state)) return;
  for (const cls of state.classes || []) {
    if (!cls.students.some((s) => s.code)) continue;
    const key = JSON.stringify([state.mailbox.id, cls.id, state.event, state.teacher]);
    if (published.has(key)) continue;
    published.add(key);
    publishClassDirectory(state, cls.id).catch((err) => {
      if (!(err instanceof MailboxError) || err.offline) published.delete(key);
    });
  }
}

/** Holt die Rückmeldungen aus dem Briefkasten; ein gerade laufender Abruf wird mitbenutzt. */
function fetchShared() {
  const info = currentFetchInfo();
  if (!info.running) {
    info.lastAttemptAt = Date.now();
    info.running = fetchMailboxResponses()
      .then(
        (result) => {
          info.lastError = null;
          publishDirectories(result.state);
          return result;
        },
        (err) => {
          info.lastError = err;
          throw err;
        },
      )
      .finally(() => {
        info.running = null;
      });
  }
  return info.running;
}

function who(entry) {
  return entry.classId ? `${entry.name} (${entry.classId})` : entry.name;
}

/**
 * Bericht als Hinweisboxen: übernommen, nicht übernommen, schon aktuell, Dateifehler.
 * source 'mailbox': Rückmeldungen aus dem digitalen Briefkasten (ohne Liste der schon übernommenen).
 */
function reportNodes({ applied = [], skipped = [], errors = [], upToDateCount = 0 }, source = 'email') {
  const fromMailbox = source === 'mailbox';
  const nodes = [];
  if (applied.length) {
    const other = applied.filter((a) => a.otherClass).length;
    const names = applied.map((a) => `${who(a)}${a.replaced ? ' – aktualisiert' : ''}`).join(', ');
    const title = `${plural(applied.length, 'Rückmeldung', 'Rückmeldungen')}${fromMailbox ? ' aus dem digitalen Briefkasten' : ''} übernommen: `;
    nodes.push(
      alertBox(
        'success',
        h('p', { class: 'resp-names' }, h('strong', {}, title), names),
        other
          ? h('p', { class: 'small' }, other === 1 ? '1 Rückmeldung gehört zu einer anderen Klasse und wurde dort eingetragen.' : `${other} Rückmeldungen gehören zu anderen Klassen und wurden dort eingetragen.`)
          : null,
      ),
    );
  }
  const problems = skipped.filter((s) => !UP_TO_DATE_REASONS.includes(s.reason));
  const upToDate = skipped.filter((s) => UP_TO_DATE_REASONS.includes(s.reason));
  if (fromMailbox && !applied.length) {
    const count = upToDateCount + upToDate.length;
    nodes.push(
      alertBox(
        'info',
        h('p', {}, h('strong', {}, 'Keine neuen Rückmeldungen im digitalen Briefkasten.')),
        count ? h('p', { class: 'small' }, `${plural(count, 'Rückmeldung ist', 'Rückmeldungen sind')} bereits übernommen.`) : null,
      ),
    );
  }
  if (problems.length) {
    nodes.push(
      alertBox(
        'warning',
        h('p', {}, h('strong', {}, `${plural(problems.length, 'Rückmeldung', 'Rückmeldungen')} nicht übernommen:`)),
        h('ul', { class: 'resp-list' }, problems.map((s) => h('li', {}, `${who(s)}: ${s.reason}`))),
      ),
    );
  }
  if (upToDate.length && !fromMailbox) {
    nodes.push(
      alertBox(
        'info',
        h('p', {}, h('strong', {}, 'Schon auf dem neuesten Stand (nicht erneut übernommen):')),
        h('ul', { class: 'resp-list' }, upToDate.map((s) => h('li', {}, `${who(s)}: ${s.reason}`))),
      ),
    );
  }
  if (errors.length) {
    nodes.push(
      alertBox(
        'error',
        h('p', {}, h('strong', {}, `${plural(errors.length, 'Datei', 'Dateien')} ohne Rückmeldung:`)),
        h('ul', { class: 'resp-list' }, errors.map((e) => h('li', {}, e.fileName ? `${e.fileName}: ${e.message}` : e.message))),
        h('p', { class: 'small' }, 'Bitte laden Sie die PDF-Dateien hoch, die Ihnen die Eltern per E-Mail geschickt haben.'),
      ),
    );
  }
  if (!nodes.length) nodes.push(alertBox('warning', 'Es wurde keine Rückmeldung gefunden.'));
  return nodes;
}

/**
 * Upload-Bereich für Rückmelde-PDFs (mehrere Dateien) plus „Rückmeldung aus E-Mail-Text einfügen“,
 * bei eingerichtetem Briefkasten zusätzlich „Neue Rückmeldungen abrufen“.
 * Speichert Ergebnisse selbst über updateState() und ruft danach onImported(report) auf.
 * report = { applied, skipped, errors } (errors: Dateien ohne Rückmeldung);
 * aus dem Briefkasten zusätzlich source: 'mailbox' und unreadable (Anzahl unlesbarer Nachrichten)
 * @param {{classId?: string, onImported?: (report: object) => void}} opts
 * @returns {HTMLElement}
 */
export function createResponseImporter({ classId, onImported } = {}) {
  const report = h('div', { class: 'resp-report', 'data-testid': 'response-report', 'aria-live': 'polite' });
  // Weitere Dateien/Texte, die während des Einlesens kommen, werden danach verarbeitet (nicht verworfen).
  let queue = Promise.resolve();
  let pending = 0;
  let uploads = 0; // Anzahl gestarteter Uploads (ein älterer Briefkasten-Abruf überschreibt ihren Bericht nicht)
  let shown = null;

  function processInput(getInput, busyText) {
    const append = pending > 0;
    pending += 1;
    uploads += 1;
    root.setAttribute('aria-busy', 'true');
    placeReport('email');
    queue = queue
      .then(() => runImport(getInput, busyText, append))
      .catch((err) => console.error(err))
      .finally(() => {
        pending -= 1;
        if (!pending) root.removeAttribute('aria-busy');
      });
    return queue;
  }

  /** Bericht anzeigen; kam die Eingabe während eines laufenden Imports, wird er an den vorigen angehängt. */
  function showReport(full, append) {
    const merged = append && shown ? { applied: [...shown.applied, ...full.applied], skipped: [...shown.skipped, ...full.skipped], errors: [...shown.errors, ...full.errors] } : full;
    shown = merged;
    mount(report, reportNodes(merged));
    return merged;
  }

  /** Meldet übernommene Rückmeldungen an die Seite (die dabei ggf. neu zeichnet). */
  function notifyImported(full, shownReport, source) {
    carryOver = { classId, report: shownReport, source, time: Date.now() };
    try {
      onImported?.(full);
    } catch (err) {
      console.error(err);
    }
    if (root.isConnected) carryOver = null;
  }

  /** Liest Rückmeldungen (getInput), übernimmt sie in den Zustand und zeigt den Bericht. */
  async function runImport(getInput, busyText, append) {
    if (!append) {
      shown = null;
      mount(report, h('p', { class: 'resp-busy muted' }, busyText));
    }
    let payloads = [];
    let errors = [];
    try {
      ({ payloads = [], errors = [] } = await getInput());
    } catch (err) {
      errors = [{ fileName: '', message: err?.message || 'Die Dateien konnten nicht gelesen werden.' }];
    }
    let result = { applied: [], skipped: [] };
    if (payloads.length) {
      try {
        updateState((s) => {
          result = applyResponses(s, payloads, { classId });
        });
      } catch (err) {
        shown = null;
        mount(report, alertBox('error', `Die Rückmeldungen konnten nicht gespeichert werden. ${err?.message || ''}`.trim()));
        return;
      }
    }
    const full = { ...result, errors };
    const merged = showReport(full, append);
    if (payloads.length) notifyImported(full, merged, 'email');
  }

  const zone = fileDropZone({
    accept: ACCEPT,
    multiple: true,
    testId: 'response-upload',
    label: 'Rückmelde-PDFs der Eltern auswählen oder hierher ziehen',
    hint: 'Mehrere Dateien auf einmal möglich. Die Klasse wird am Code erkannt.',
    onFiles: (files) => processInput(() => readResponsesFromFiles(files), `${plural(files.length, 'Datei wird', 'Dateien werden')} gelesen …`),
  });

  function openPasteDialog() {
    const textarea = h('textarea', { class: 'resp-textarea', rows: 10, spellcheck: 'false', 'data-testid': 'response-paste-text' });
    const status = h('div', { class: 'resp-paste-status', 'aria-live': 'polite' });
    textarea.addEventListener('input', () => {
      if (textarea.getAttribute('aria-invalid')) {
        textarea.removeAttribute('aria-invalid');
        mount(status);
      }
    });
    const dlg = modal({
      title: 'Rückmeldung aus E-Mail-Text einfügen',
      wide: true,
      content: [
        h(
          'p',
          {},
          'Öffnen Sie die E-Mail der Eltern, markieren Sie den kompletten Text (Strg + A bzw. ⌘ + A) und fügen Sie ihn hier ein. Wichtig ist der Block, der mit ',
          h('span', { class: 'code' }, 'PARENTSDAY['),
          ' beginnt und mit ',
          h('span', { class: 'code' }, ']'),
          ' endet.',
        ),
        field('Text der E-Mail', textarea, { hint: 'Sie können auch mehrere E-Mails auf einmal einfügen.' }),
        status,
      ],
      actions: [
        { label: 'Abbrechen', variant: 'secondary' },
        {
          label: 'Rückmeldungen übernehmen',
          variant: 'primary',
          onClick: (close) => {
            const payloads = findResponsesInMailText(textarea.value);
            if (!payloads.length) {
              textarea.setAttribute('aria-invalid', 'true');
              mount(
                status,
                alertBox(
                  'error',
                  textarea.value.trim()
                    ? 'In diesem Text wurde keine ParentsDay-Rückmeldung gefunden. Bitte kopieren Sie den kompletten E-Mail-Text einschließlich des Blocks PARENTSDAY[…].'
                    : 'Bitte fügen Sie zuerst den Text der E-Mail ein.',
                ),
              );
              textarea.focus();
              return;
            }
            close(true);
            processInput(async () => ({ payloads, errors: [] }), 'Rückmeldungen werden übernommen …');
          },
        },
      ],
    });
    dlg.element.querySelector('.modal-actions .btn-primary')?.setAttribute('data-testid', 'response-paste-submit');
  }

  const pasteRow = h(
    'div',
    { class: 'resp-paste' },
    h('button', { type: 'button', class: 'btn btn-secondary resp-paste-btn', 'data-testid': 'response-paste', onclick: openPasteDialog }, 'Rückmeldung aus E-Mail-Text einfügen'),
    h('span', { class: 'muted small' }, 'Keine PDF-Datei im Anhang? Dann kopieren Sie einfach den Text der E-Mail.'),
  );

  // ---------- Digitaler Briefkasten ----------

  const withMailbox = mailboxEnabled();
  const mailboxReady = withMailbox && hasTeacherMailbox();
  const fetchBtn = h('button', { type: 'button', class: 'btn btn-secondary resp-mailbox-btn', 'data-testid': 'mailbox-fetch', onclick: () => runFetch(true) }, 'Neue Rückmeldungen abrufen');
  const lastLine = h('p', { class: 'resp-mailbox-last small', 'data-testid': 'mailbox-last' });
  const note = h('div', { class: 'resp-mailbox-note', 'data-testid': 'mailbox-note', 'aria-live': 'polite' });
  let fetching = false;
  // Klick auf „Neue Rückmeldungen abrufen“, während schon (automatisch) abgerufen wird
  let reportRequested = false;
  let mailboxBox = null;
  let reportSource = 'email';
  if (withMailbox) {
    mailboxBox = h(
      'section',
      { class: 'resp-mailbox', 'aria-labelledby': 'resp-mailbox-title', 'data-testid': 'mailbox-section' },
      h('h3', { id: 'resp-mailbox-title', class: 'resp-section-title' }, 'Digitaler Briefkasten'),
      mailboxReady
        ? [
            h('p', { class: 'resp-mailbox-text' }, 'Rückmeldungen, die Eltern mit „Absenden“ schicken, kommen verschlüsselt hier an und werden beim Öffnen dieser Seite automatisch übernommen.'),
            h('div', { class: 'resp-mailbox-row' }, fetchBtn, lastLine),
            note,
          ]
        : h('p', { class: 'resp-mailbox-text muted', 'data-testid': 'mailbox-setup-hint' }, 'Der digitale Briefkasten wird eingerichtet, sobald Sie Elternbriefe erstellen.'),
    );
    showLastFetched();
  }

  function showLastFetched() {
    const at = formatTimestamp(getCurrentState()?.mailbox?.lastFetchedAt || '');
    mount(lastLine, 'Zuletzt abgerufen: ', h('span', { class: 'nowrap' }, at || 'noch nie'));
  }

  function setFetching(on) {
    fetching = on;
    // Nicht „disabled“: sonst verlöre ein Tastatur-Fokus auf dem Knopf seinen Platz.
    if (on) {
      mailboxBox?.setAttribute('aria-busy', 'true');
      fetchBtn.setAttribute('aria-disabled', 'true');
      mount(fetchBtn, h('span', { class: 'spinner resp-mailbox-spinner', 'aria-hidden': 'true' }), 'Wird abgerufen …');
    } else {
      mailboxBox?.removeAttribute('aria-busy');
      fetchBtn.removeAttribute('aria-disabled');
      mount(fetchBtn, 'Neue Rückmeldungen abrufen');
    }
  }

  function showFetchError(err) {
    const message =
      err instanceof MailboxError ? err.message : friendlyError(err, 'Die Rückmeldungen konnten nicht abgerufen werden. Bitte versuchen Sie es später noch einmal.');
    mount(
      note,
      h(
        'div',
        { class: 'resp-mailbox-error' },
        h('p', {}, h('strong', {}, 'Abrufen im Moment nicht möglich. '), message, ' Rückmeldungen per E-Mail können Sie unten trotzdem hochladen.'),
        h('button', { type: 'button', class: 'btn btn-small btn-secondary', 'data-testid': 'mailbox-retry', onclick: () => runFetch(true) }, 'Erneut versuchen'),
      ),
    );
  }

  /** Holt neue Rückmeldungen ab. manual: vom Knopf ausgelöst – dann gibt es immer eine Rückmeldung. */
  async function runFetch(manual) {
    if (!mailboxReady) return;
    if (fetching) {
      // Kein zweiter Abruf; das Ergebnis des laufenden wird dann aber auf jeden Fall gemeldet.
      if (manual) reportRequested = true;
      return;
    }
    reportRequested = false;
    const uploadsBefore = uploads;
    setFetching(true);
    if (manual) {
      // „Erneut versuchen“ verschwindet gleich – der Tastatur-Fokus geht auf „Neue Rückmeldungen abrufen“
      if (note.contains(document.activeElement)) fetchBtn.focus();
      mount(note);
      // Alter Bericht eines Abrufs gilt nicht mehr (z. B. wenn der Briefkasten jetzt nicht erreichbar ist)
      if (reportSource === 'mailbox' && !pending) {
        shown = null;
        mount(report);
      }
    }
    let result;
    try {
      result = await fetchShared();
    } catch (err) {
      setFetching(false);
      showFetchError(err);
      return;
    }
    setFetching(false);
    showLastFetched();
    const wanted = manual || reportRequested;
    reportRequested = false;
    mount(
      note,
      result.unreadable > 0
        ? h(
            'p',
            { class: 'resp-mailbox-unreadable small' },
            `${result.unreadable === 1 ? '1 Nachricht im Briefkasten ließ' : `${result.unreadable} Nachrichten im Briefkasten ließen`} sich nicht lesen und ${result.unreadable === 1 ? 'wurde' : 'wurden'} übersprungen. Fehlt eine Rückmeldung, bitten Sie die Eltern, sie per E-Mail zu schicken.`,
          )
        : null,
    );
    queue = queue.then(() => showMailboxResult(result, wanted, uploads !== uploadsBefore)).catch((err) => console.error(err));
  }

  /** Bericht zum Abruf; ohne Neues bleibt ein automatischer Abruf still. */
  function showMailboxResult(result, manual, uploadedMeanwhile) {
    const applied = result.applied.map((a) => ({ ...a, otherClass: Boolean(classId && a.classId !== classId) }));
    const skipped = result.skipped.filter((s) => !UP_TO_DATE_REASONS.includes(s.reason));
    // „bereits übernommen“ je Kind zählen (ältere Rückmeldungen desselben Kindes nicht doppelt)
    const upToDate = new Set(result.skipped.filter((s) => UP_TO_DATE_REASONS.includes(s.reason)).map((s) => `${s.classId}|${s.name}`));
    for (const a of applied) upToDate.delete(`${a.classId}|${a.name}`);
    const full = { applied, skipped, errors: [], upToDateCount: upToDate.size };
    if (manual || (applied.length && !uploadedMeanwhile)) {
      shown = null;
      placeReport('mailbox');
      mount(report, reportNodes(full, 'mailbox'));
    }
    if (applied.length) notifyImported({ applied, skipped, errors: [], source: 'mailbox', unreadable: result.unreadable }, full, 'mailbox');
  }

  /** Der Bericht steht beim Abschnitt, aus dem er stammt (Briefkasten bzw. E-Mail). */
  function placeReport(source) {
    reportSource = source;
    if (!mailboxBox) return;
    if (source === 'mailbox') mailboxBox.after(report);
    else pasteRow.after(report);
  }

  const root = withMailbox
    ? h(
        'div',
        { class: 'resp-import resp-import-mailbox' },
        mailboxBox,
        h(
          'section',
          { class: 'resp-email', 'aria-labelledby': 'resp-email-title' },
          h('h3', { id: 'resp-email-title', class: 'resp-section-title' }, 'Rückmeldungen per E-Mail (PDF oder Text)'),
          h(
            'p',
            { class: 'muted small resp-email-note', 'data-testid': 'response-email-note' },
            'Normalerweise werden die Rückmeldungen der Eltern automatisch in die Übersicht eingepflegt – Sie müssen dafür nichts tun. ',
            'In seltenen Fällen haben Eltern technische Probleme und schicken Ihnen deshalb den „Beleg“ mit ihren verfügbaren Uhrzeiten als PDF-Datei per E-Mail. ',
            'Laden Sie diese Datei dann einfach hier hoch: Die Angaben werden automatisch bei der Schülerin bzw. dem Schüler eingetragen.',
          ),
          zone,
          pasteRow,
          report,
        ),
      )
    : h('div', { class: 'resp-import' }, zone, pasteRow, report);

  // Bericht nach dem Neuzeichnen der Seite weiter anzeigen
  if (carryOver && carryOver.classId === classId && Date.now() - carryOver.time < CARRY_OVER_MS) {
    placeReport(carryOver.source);
    mount(report, reportNodes(carryOver.report, carryOver.source));
    carryOver = null;
  }

  // Beim Einbinden einmal abrufen (höchstens alle 30 s je Tab); ein laufender Abruf wird mitbenutzt.
  if (mailboxReady) {
    const info = currentFetchInfo();
    if (info.running || Date.now() - info.lastAttemptAt >= AUTO_FETCH_MS) Promise.resolve().then(() => runFetch(false));
    else if (info.lastError) showFetchError(info.lastError);
  }
  return root;
}
