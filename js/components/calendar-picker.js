// PLATZHALTER – Signatur ist verbindlich.
import { h } from '../core/ui.js';
/**
 * Monatskalender mit Mehrfachauswahl von Tagen.
 * @param {{selected?: string[], onChange: (dates: string[]) => void, month?: string}} opts – month: 'JJJJ-MM' (Startmonat)
 * @returns {HTMLElement & {setSelected?: (dates: string[]) => void}}
 */
export function createCalendarPicker({ selected = [], onChange, month } = {}) {
  return h('div', {}, 'Kalender – in Arbeit.');
}
