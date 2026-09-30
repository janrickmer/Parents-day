// Digitaler Briefkasten aus Sicht der Lehrkraft: anlegen, Verzeichniseintrag für den Termin-Schlüssel
// ablegen und Rückmeldungen abholen. Die Verschlüsselung steckt in core/mailbox.js.

import { getCurrentState, updateState } from './storage.js';
import { mailboxEnabled, createTeacherMailbox, isValidTeacherMailbox, fetchFromMailbox, publishDirectoryEntry, clearMailbox } from './mailbox.js';
import { compactEvent, eventInfoFromState, encodeEventKey, validateResponsePayload } from './transport.js';
import { applyResponses } from './responses.js';

/** Hat die angemeldete Lehrkraft einen nutzbaren Briefkasten? */
export function hasTeacherMailbox(state = getCurrentState()) {
  return mailboxEnabled() && isValidTeacherMailbox(state?.mailbox);
}

/**
 * Legt den Briefkasten der angemeldeten Lehrkraft an, falls der Dienst eingerichtet ist und noch keiner existiert.
 * @returns {Promise<object|null>} der (neue oder vorhandene) Briefkasten oder null ohne Dienst
 */
export async function ensureTeacherMailbox() {
  if (!mailboxEnabled()) return null;
  const current = getCurrentState();
  if (!current) return null;
  if (isValidTeacherMailbox(current.mailbox)) return current.mailbox;
  const created = await createTeacherMailbox();
  const saved = updateState((s) => {
    if (!isValidTeacherMailbox(s.mailbox)) s.mailbox = created;
  });
  return saved.mailbox;
}

/**
 * Legt für eine Klasse den Verzeichniseintrag ab, über den Eltern mit Termin-Schlüssel (ohne QR-Code)
 * die Termindaten und den Briefkasten finden. Wirft bei Verbindungsproblemen (MailboxError).
 * @returns {Promise<boolean>} ob ein Eintrag abgelegt wurde
 */
export async function publishClassDirectory(state, classId) {
  if (!hasTeacherMailbox(state) || !state.event) return false;
  const eventKey = encodeEventKey(state.event, { teacherCode: state.teacher.teacherCode, classId });
  if (!eventKey) return false;
  const compact = compactEvent(eventInfoFromState(state, classId));
  return publishDirectoryEntry(state.mailbox, { teacherCode: state.teacher.teacherCode, classId, eventKey }, compact);
}

/**
 * Holt alle Rückmeldungen aus dem Briefkasten und übernimmt sie in den Zustand (wie beim Hochladen).
 * Wirft bei Verbindungsproblemen (MailboxError).
 * `newest`: Eingangszeitpunkt der neuesten abgeholten Nachricht – für clearTeacherMailbox({ upTo }).
 * @param {{classId?: string}} [options] – Klasse, in der gerade abgerufen wird (nur für den Bericht)
 * @returns {Promise<{applied: object[], skipped: object[], unreadable: number, total: number, newest: number, state: object}>}
 */
export async function fetchMailboxResponses({ classId } = {}) {
  const current = getCurrentState();
  if (!hasTeacherMailbox(current)) return { applied: [], skipped: [], unreadable: 0, total: 0, newest: 0, state: current };
  const { payloads, unreadable, total, newest } = await fetchFromMailbox(current.mailbox);
  // Während des Abrufs abgemeldet, andere Lehrkraft angemeldet oder anderer Briefkasten (Zwischenstand geladen)?
  // Dann gehören die Rückmeldungen nicht zum jetzigen Stand – nichts übernehmen, nichts vermerken.
  const latest = getCurrentState();
  if (!latest || latest.teacher.teacherCode !== current.teacher.teacherCode || latest.mailbox?.id !== current.mailbox.id) {
    return { applied: [], skipped: [], unreadable: 0, total: 0, newest: 0, state: latest };
  }
  const valid = payloads.map(validateResponsePayload).filter(Boolean);
  let report = { applied: [], skipped: [] };
  const state = updateState((s) => {
    report = applyResponses(s, valid, { classId });
    if (s.mailbox) s.mailbox.lastFetchedAt = new Date().toISOString();
  });
  return { ...report, unreadable: unreadable + (payloads.length - valid.length), total, newest, state };
}

/**
 * Löscht die Rückmeldungen im Briefkasten (übernommene Zeiten bleiben in ParentsDay erhalten).
 * @param {{upTo?: number}} [options] – nur bis zu diesem Eingangszeitpunkt (`newest` aus fetchMailboxResponses):
 *   Rückmeldungen, die nach dem Abruf eingegangen sind, bleiben dann im Briefkasten.
 */
export async function clearTeacherMailbox({ upTo } = {}) {
  const current = getCurrentState();
  if (!hasTeacherMailbox(current)) return 0;
  return clearMailbox(current.mailbox, { upTo });
}
