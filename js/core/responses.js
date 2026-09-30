// PLATZHALTER – Signaturen sind verbindlich.
/**
 * Liest Rückmelde-PDFs der Eltern.
 * @param {File[]} files
 * @returns {Promise<{payloads: object[], errors: Array<{fileName: string, message: string}>}>}
 */
export async function readResponsesFromFiles(files) {
  throw new Error('readResponsesFromFiles ist noch nicht implementiert.');
}

/**
 * Überträgt Rückmeldungen in den Zustand (verändert `state`).
 * @param {object} state – TeacherState
 * @param {object[]} payloads – ResponsePayloads
 * @param {{classId?: string}} [options] – nur Rückmeldungen dieser Klasse übernehmen
 * @returns {{applied: Array<{classId,studentId,name,replaced:boolean}>, skipped: Array<{name, classId, reason}>}}
 */
export function applyResponses(state, payloads, options = {}) {
  throw new Error('applyResponses ist noch nicht implementiert.');
}
