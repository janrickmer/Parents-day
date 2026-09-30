// Datums- und Uhrzeit-Hilfen. Datumswerte werden intern immer als ISO-String (JJJJ-MM-TT),
// Uhrzeiten als "HH:MM" gespeichert. Zeitspannen: [start, ende) in Minuten seit Mitternacht.

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const WEEKDAYS_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

export { WEEKDAYS, WEEKDAYS_SHORT, MONTHS };

const pad = (n) => String(n).padStart(2, '0');

/** "14:05" → 845 */
export function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ''));
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 845 → "14:05" */
export function fromMinutes(minutes) {
  const m = Math.max(0, Math.round(minutes));
  return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
}

/** ISO-Datum → lokales Date-Objekt (Mitternacht). */
export function parseIsoDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Date → ISO-Datum (lokal). */
export function toIsoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function todayIso() {
  return toIsoDate(new Date());
}

/** "2026-11-12" → "12.11.2026" */
export function formatDate(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${d}.${m}.${y}`;
}

/** "2026-11-12" → "Donnerstag" */
export function weekday(iso) {
  return WEEKDAYS[parseIsoDate(iso).getDay()];
}

/** "2026-11-12" → "Donnerstag, 12.11.2026" */
export function formatDateWithWeekday(iso) {
  return `${weekday(iso)}, ${formatDate(iso)}`;
}

/** "2026-11-12" → "Donnerstag, 12. November 2026" */
export function formatDateLong(iso) {
  const dt = parseIsoDate(iso);
  return `${WEEKDAYS[dt.getDay()]}, ${dt.getDate()}. ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
}

/** Zeitspanne als Text: "14:00–15:30 Uhr" */
export function formatRange(start, end, withUhr = true) {
  const s = typeof start === 'number' ? fromMinutes(start) : start;
  const e = typeof end === 'number' ? fromMinutes(end) : end;
  return `${s}–${e}${withUhr ? ' Uhr' : ''}`;
}

/** Liste von Zeitspannen [["14:00","15:30"], …] als Text: "14:00–15:30, 16:00–17:00 Uhr" */
export function formatRanges(ranges) {
  if (!ranges || ranges.length === 0) return '';
  return `${ranges.map(([s, e]) => formatRange(s, e, false)).join(', ')} Uhr`;
}

/**
 * Alle Slot-Anfänge eines Tages (in Minuten). Der letzte Slot endet spätestens zur Endzeit.
 * slotStarts("14:00", "15:00", 20) → [840, 860, 880]
 */
export function slotStarts(start, end, slotMinutes) {
  const s = toMinutes(start);
  const e = toMinutes(end);
  const len = Number(slotMinutes);
  const result = [];
  if (!(len > 0) || Number.isNaN(s) || Number.isNaN(e)) return result;
  for (let t = s; t + len <= e; t += len) result.push(t);
  return result;
}

/**
 * Wandelt ausgewählte Slot-Anfänge in zusammenhängende Zeitspannen um.
 * slotsToRanges([840, 850, 870], 10) → [["14:00","14:20"], ["14:30","14:40"]]
 */
export function slotsToRanges(starts, slotMinutes) {
  const sorted = [...new Set(starts.map(Number))].sort((a, b) => a - b);
  const ranges = [];
  for (const t of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last[1] === t) last[1] = t + slotMinutes;
    else ranges.push([t, t + slotMinutes]);
  }
  return ranges.map(([s, e]) => [fromMinutes(s), fromMinutes(e)]);
}

/** Zeitspannen ["HH:MM","HH:MM"] → [[min, min]] zusammengeführt und sortiert. */
export function normalizeRanges(ranges) {
  const list = (ranges || [])
    .map(([s, e]) => [toMinutes(s), toMinutes(e)])
    .filter(([s, e]) => !Number.isNaN(s) && !Number.isNaN(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of list) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/**
 * Bewertet einen Termin gegen die Verfügbarkeit der Eltern.
 * @param {Array<[string,string]>|undefined|null} ranges – verfügbare Zeitspannen des Tages
 * @param {number} start – Beginn in Minuten
 * @param {number} duration – Dauer in Minuten
 * @returns {'ok'|'partial'|'unavailable'}
 *   ok          – Eltern haben während des ganzen Termins Zeit (blau)
 *   partial     – zum Beginn verfügbar, aber der Termin ragt in nicht verfügbare Zeit (orange)
 *   unavailable – zum Beginn nicht verfügbar (rot)
 */
export function availabilityStatus(ranges, start, duration) {
  const merged = normalizeRanges(ranges);
  const end = start + duration;
  const startRange = merged.find(([s, e]) => s <= start && start < e);
  if (!startRange) return 'unavailable';
  return end <= startRange[1] ? 'ok' : 'partial';
}

/** Datum und Uhrzeit für Dateinamen/Anzeigen: { date: "30.09.2026", time: "14:35" } */
export function nowParts(date = new Date()) {
  return {
    date: `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

/** Formatiert einen ISO-Zeitstempel als "30.09.2026, 14:35 Uhr". */
export function formatTimestamp(isoTimestamp) {
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return '';
  const p = nowParts(d);
  return `${p.date}, ${p.time} Uhr`;
}
