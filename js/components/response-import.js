// PLATZHALTER – Signatur ist verbindlich.
import { h } from '../core/ui.js';
/**
 * Upload-Bereich für Rückmelde-PDFs (mehrere Dateien) plus „Rückmeldung aus E-Mail-Text einfügen“.
 * Speichert Ergebnisse selbst über updateState() und ruft danach onImported(report) auf.
 * @param {{classId?: string, onImported?: (report: object) => void}} opts
 * @returns {HTMLElement}
 */
export function createResponseImporter({ classId, onImported } = {}) {
  return h('div', { class: 'alert alert-info' }, 'Upload von Rückmeldungen – in Arbeit.');
}
