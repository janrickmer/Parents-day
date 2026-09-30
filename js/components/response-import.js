// Upload-Bereich für die Rückmeldungen der Eltern: mehrere PDF-Dateien auf einmal (auch .txt/.eml)
// oder eingefügter E-Mail-Text mit dem Block PARENTSDAY[…]. Die Klasse wird am Code erkannt.

import { h, mount, modal, fileDropZone, alertBox, field, plural } from '../core/ui.js';
import { updateState } from '../core/storage.js';
import { readResponsesFromFiles, applyResponses, findResponsesInMailText, UP_TO_DATE_REASONS } from '../core/responses.js';

// Bericht des letzten Imports. Zeichnet die Seite in onImported() neu, zeigt der neu erzeugte
// Upload-Bereich derselben Klasse den Bericht weiter an.
let carryOver = null;
const CARRY_OVER_MS = 15000;

const ACCEPT = '.pdf,application/pdf,.txt,.eml,text/plain,message/rfc822';

function who(entry) {
  return entry.classId ? `${entry.name} (${entry.classId})` : entry.name;
}

/** Bericht als Hinweisboxen: übernommen, nicht übernommen, schon aktuell, Dateifehler. */
function reportNodes({ applied = [], skipped = [], errors = [] }) {
  const nodes = [];
  if (applied.length) {
    const other = applied.filter((a) => a.otherClass).length;
    const names = applied.map((a) => `${who(a)}${a.replaced ? ' – aktualisiert' : ''}`).join(', ');
    nodes.push(
      alertBox(
        'success',
        h('p', { class: 'resp-names' }, h('strong', {}, `${plural(applied.length, 'Rückmeldung', 'Rückmeldungen')} übernommen: `), names),
        other
          ? h('p', { class: 'small' }, other === 1 ? '1 Rückmeldung gehört zu einer anderen Klasse und wurde dort eingetragen.' : `${other} Rückmeldungen gehören zu anderen Klassen und wurden dort eingetragen.`)
          : null,
      ),
    );
  }
  const problems = skipped.filter((s) => !UP_TO_DATE_REASONS.includes(s.reason));
  const upToDate = skipped.filter((s) => UP_TO_DATE_REASONS.includes(s.reason));
  if (problems.length) {
    nodes.push(
      alertBox(
        'warning',
        h('p', {}, h('strong', {}, `${plural(problems.length, 'Rückmeldung', 'Rückmeldungen')} nicht übernommen:`)),
        h('ul', { class: 'resp-list' }, problems.map((s) => h('li', {}, `${who(s)}: ${s.reason}`))),
      ),
    );
  }
  if (upToDate.length) {
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
 * Upload-Bereich für Rückmelde-PDFs (mehrere Dateien) plus „Rückmeldung aus E-Mail-Text einfügen“.
 * Speichert Ergebnisse selbst über updateState() und ruft danach onImported(report) auf.
 * report = { applied, skipped, errors } (errors: Dateien ohne Rückmeldung)
 * @param {{classId?: string, onImported?: (report: object) => void}} opts
 * @returns {HTMLElement}
 */
export function createResponseImporter({ classId, onImported } = {}) {
  const report = h('div', { class: 'resp-report', 'data-testid': 'response-report', 'aria-live': 'polite' });
  // Weitere Dateien/Texte, die während des Einlesens kommen, werden danach verarbeitet (nicht verworfen).
  let queue = Promise.resolve();
  let pending = 0;
  let shown = null;

  function processInput(getInput, busyText) {
    const append = pending > 0;
    pending += 1;
    root.setAttribute('aria-busy', 'true');
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
    if (payloads.length) {
      carryOver = { classId, report: merged, time: Date.now() };
      try {
        onImported?.(full);
      } catch (err) {
        console.error(err);
      }
      if (root.isConnected) carryOver = null;
    }
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

  const root = h(
    'div',
    { class: 'resp-import' },
    zone,
    h(
      'div',
      { class: 'resp-paste' },
      h('button', { type: 'button', class: 'btn btn-secondary resp-paste-btn', 'data-testid': 'response-paste', onclick: openPasteDialog }, 'Rückmeldung aus E-Mail-Text einfügen'),
      h('span', { class: 'muted small' }, 'Keine PDF-Datei im Anhang? Dann kopieren Sie einfach den Text der E-Mail.'),
    ),
    report,
  );

  // Bericht nach dem Neuzeichnen der Seite weiter anzeigen
  if (carryOver && carryOver.classId === classId && Date.now() - carryOver.time < CARRY_OVER_MS) {
    mount(report, reportNodes(carryOver.report));
    carryOver = null;
  }
  return root;
}
