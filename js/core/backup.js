// Zwischenspeicher: kompletter Stand der Lehrkraft als Datei
// „Zwischenspeicher vom TT.MM.JJJJ um hh:mm für ParentsDay.json“.

import { nowParts } from './time.js';
import { downloadBlob, safeFilename } from './ui.js';
import { normalizeTeacherState } from './storage.js';
import { codesEqual } from './codes.js';

export function backupFilename(date = new Date()) {
  const { date: d, time } = nowParts(date);
  return `Zwischenspeicher vom ${d} um ${time} für ParentsDay.json`;
}

/** Lädt den aktuellen Stand als Datei herunter. Gibt den verwendeten Dateinamen zurück. */
export function downloadBackup(state) {
  const data = { ...state, type: 'teacher-state', exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const name = safeFilename(backupFilename());
  downloadBlob(blob, name);
  return name;
}

/**
 * Liest eine Zwischenspeicher-Datei und prüft, ob sie zur angemeldeten Lehrkraft gehört.
 * @returns {Promise<object>} normalisierter Zustand
 */
export async function readBackupFile(file, expectedTeacherCode) {
  let raw;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new Error('Diese Datei ist kein ParentsDay-Zwischenspeicher.');
  }
  if (!raw || raw.app !== 'ParentsDay' || raw.type !== 'teacher-state') {
    throw new Error('Diese Datei ist kein ParentsDay-Zwischenspeicher.');
  }
  const state = normalizeTeacherState(raw);
  if (expectedTeacherCode && !codesEqual(state.teacher.teacherCode, expectedTeacherCode)) {
    throw new Error('Dieser Zwischenspeicher gehört zu einer anderen Lehrkraft und kann hier nicht geladen werden.');
  }
  return state;
}
