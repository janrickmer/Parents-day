// Rückmelde-PDF der Eltern: Angaben zum Kind und die verfügbaren Zeiten je Tag (als Text und als
// Zeitbalken mit grünen Abschnitten). Die Daten stehen zusätzlich maschinenlesbar in den
// PDF-Metadaten, damit die Lehrkraft die Datei direkt in ParentsDay hochladen kann.

import { APP_NAME } from '../config.js';
import { createPdf, drawBrandHeader, writeParagraph, drawInfoBox, drawFooters, embedPayload, ensureSpace, setText, lineHeight, PAGE, CONTENT_WIDTH, COLORS } from '../core/pdf.js';
import { formatDateWithWeekday, formatRange, formatRanges, formatTimestamp, fromMinutes, normalizeRanges, nowParts, toMinutes } from '../core/time.js';

// Gleiche Farben wie --c-available / --c-success in css/base.css
const GREEN = '#2eaa5c';
const GREEN_DARK = '#1e8e4e';
const BAR_FILL = '#eef1f6';
const BAR_HEIGHT = 8;

/** Dateiname, z. B. „ParentsDay Rückmeldung 5a Beck Anna.pdf“. */
export function responseFilename(payload) {
  return `${APP_NAME} Rückmeldung ${payload.classId || ''} ${payload.lastName || ''} ${payload.firstName || ''}`.replace(/\s+/g, ' ').trim() + '.pdf';
}

/** Schulanschrift für die Kopfzeile: höchstens fünf nicht leere Zeilen. */
function addressText(address) {
  return String(address || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join('\n');
}

/**
 * Tage des Elternsprechtags. Tage, die nur in der Rückmeldung vorkommen, werden ergänzt
 * (ohne bekannte Anfangs-/Endzeit reicht der Balken von der ersten bis zur letzten Angabe).
 */
function dayList(payload, eventInfo) {
  const days = (eventInfo?.days || []).map((d) => ({ date: d.date, start: d.start, end: d.end }));
  const known = new Set(days.map((d) => d.date));
  for (const [date, ranges] of Object.entries(payload.availability || {})) {
    if (known.has(date)) continue;
    const merged = normalizeRanges(ranges);
    days.push({
      date,
      start: merged.length ? fromMinutes(merged[0][0]) : '',
      end: merged.length ? fromMinutes(merged[merged.length - 1][1]) : '',
    });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

/** Kleine Legende: grünes und graues Kästchen. */
function drawLegend(doc, y) {
  const size = 3.6;
  let x = PAGE.margin;
  const item = (fill, label) => {
    doc.setFillColor(fill);
    doc.setDrawColor(COLORS.line);
    doc.setLineWidth(0.2);
    doc.rect(x, y, size, size, 'FD');
    setText(doc, { size: 9, color: COLORS.muted });
    doc.text(label, x + size + 1.8, y + size - 0.6);
    x += size + 1.8 + doc.getTextWidth(label) + 8;
  };
  item(GREEN, 'Zeit für ein Gespräch');
  item(BAR_FILL, 'keine Zeit');
  setText(doc);
  return y + size + 5;
}

/**
 * Zeitbalken eines Tages: grauer Hintergrund mit Slot-Raster, grüne Abschnitte für die verfügbaren
 * Zeiten und darunter Uhrzeiten.
 * @returns {number} y-Position unter dem Balken
 */
function drawTimeBar(doc, y, day, ranges, slotMinutes) {
  const s = toMinutes(day.start);
  const e = toMinutes(day.end);
  if (!(e > s)) return y;
  const x = PAGE.margin;
  const w = CONTENT_WIDTH;
  const scale = w / (e - s);
  const px = (t) => x + (t - s) * scale;

  doc.setFillColor(BAR_FILL);
  doc.rect(x, y, w, BAR_HEIGHT, 'F');

  // Raster der Zeitslots (nur wenn breit genug, sonst wird es unruhig)
  const slot = Number(slotMinutes);
  if (slot > 0 && slot * scale >= 1.6) {
    doc.setDrawColor('#ffffff');
    doc.setLineWidth(0.35);
    for (let t = s + slot; t < e; t += slot) doc.line(px(t), y, px(t), y + BAR_HEIGHT);
  }

  // Verfügbare Zeiten in Grün, beschriftet, wenn Platz ist
  for (const [rs, re] of normalizeRanges(ranges)) {
    const a = Math.max(s, rs);
    const b = Math.min(e, re);
    if (b <= a) continue;
    doc.setFillColor(GREEN);
    doc.rect(px(a), y, (b - a) * scale, BAR_HEIGHT, 'F');
    const label = formatRange(a, b, false);
    setText(doc, { size: 7.5, bold: true, color: '#ffffff' });
    if (doc.getTextWidth(label) + 2 <= (b - a) * scale) doc.text(label, (px(a) + px(b)) / 2, y + BAR_HEIGHT / 2 + 1, { align: 'center' });
  }

  doc.setDrawColor(COLORS.line);
  doc.setLineWidth(0.3);
  doc.rect(x, y, w, BAR_HEIGHT, 'S');

  // Uhrzeiten: Anfang und Ende immer, volle Stunden dazwischen, wenn sie sich nicht überlappen
  const labelY = y + BAR_HEIGHT + 3.4;
  setText(doc, { size: 7, color: COLORS.muted });
  const labelWidth = doc.getTextWidth('00:00');
  const minGap = labelWidth + 3;
  const hourStep = [1, 2, 3, 4, 6, 12].find((n) => n * 60 * scale >= minGap) || 12;
  doc.setDrawColor(COLORS.muted);
  doc.setLineWidth(0.2);
  const tick = (t) => doc.line(px(t), y + BAR_HEIGHT, px(t), y + BAR_HEIGHT + 1.2);
  tick(s);
  tick(e);
  doc.text(fromMinutes(s), px(s), labelY, { align: 'left' });
  doc.text(day.end === '24:00' ? '24:00' : fromMinutes(e), px(e), labelY, { align: 'right' });
  for (let t = Math.ceil(s / 60) * 60; t < e; t += 60 * hourStep) {
    // Abstand zu den Rand-Beschriftungen (die links- bzw. rechtsbündig stehen)
    if (px(t) - labelWidth / 2 < px(s) + labelWidth + 2 || px(t) + labelWidth / 2 > px(e) - labelWidth - 2) continue;
    tick(t);
    doc.text(fromMinutes(t), px(t), labelY, { align: 'center' });
  }
  setText(doc);
  return labelY + 3;
}

/** Abschnitt eines Tages: Überschrift, Zeiträume als Text und Zeitbalken. */
function drawDay(doc, y, day, ranges, slotMinutes) {
  const titleSize = 11.5;
  const lh = lineHeight(doc, titleSize);
  // Höhe des ganzen Abschnitts vorab messen, damit er nicht über einen Seitenumbruch läuft.
  setText(doc, { size: 10.5, bold: true });
  const textLines = ranges.length ? doc.splitTextToSize(`Zeit für ein Gespräch: ${formatRanges(ranges)}`, CONTENT_WIDTH).length : 1;
  const barHeight = toMinutes(day.end) > toMinutes(day.start) ? BAR_HEIGHT + 6.4 : 0;
  y = ensureSpace(doc, y, lh + 0.5 + textLines * lineHeight(doc, 10.5) + 1.5 + barHeight);
  const title = formatDateWithWeekday(day.date);
  setText(doc, { size: titleSize, bold: true });
  doc.text(title, PAGE.margin, y + lh * 0.75);
  if (day.start && day.end) {
    const titleWidth = doc.getTextWidth(title);
    setText(doc, { size: 10, color: COLORS.muted });
    doc.text(` (Elternsprechtag ${formatRange(day.start, day.end)})`, PAGE.margin + titleWidth, y + lh * 0.75);
  }
  y += lh + 0.5;
  if (ranges.length) {
    y = writeParagraph(doc, `Zeit für ein Gespräch: ${formatRanges(ranges)}`, y, { size: 10.5, bold: true, color: GREEN_DARK, spacingAfter: 1.5 });
  } else {
    y = writeParagraph(doc, 'An diesem Tag keine Zeit', y, { size: 10.5, color: COLORS.muted, spacingAfter: 1.5 });
  }
  y = drawTimeBar(doc, y, day, ranges, slotMinutes);
  return y + 5;
}

/**
 * Rückmelde-PDF der Eltern mit eingebetteten Daten.
 * @param {object} payload – ResponsePayload (siehe core/transport.js)
 * @param {object} eventInfo – EventInfo (siehe core/transport.js)
 * @returns {Promise<{doc: object, filename: string}>}
 */
export async function createResponsePdf(payload, eventInfo) {
  const child = `${payload.firstName || ''} ${payload.lastName || ''}`.trim();
  const classId = payload.classId || eventInfo?.classId || '';
  const teacherName = eventInfo?.teacherName || '';
  const slotMinutes = Number(payload.slotMinutes || eventInfo?.slotMinutes) || 0;

  const doc = await createPdf();
  let y = drawBrandHeader(doc, { subtitle: 'Rückmeldung zum Elternsprechtag', rightText: addressText(eventInfo?.schoolAddress) });

  y = writeParagraph(doc, 'Rückmeldung der Eltern', y, { size: 20, bold: true, spacingAfter: 3 });
  y = writeParagraph(
    doc,
    `Die Eltern von ${child}${classId ? ` (Klasse ${classId})` : ''} haben für den Elternsprechtag alle Zeiten angegeben, zu denen sie Zeit für ein Gespräch hätten.`,
    y,
    { spacingAfter: 5 },
  );

  const rows = [
    ['Kind', child || '–'],
    ['Klasse', classId || '–'],
    ['Code', payload.code || '–'],
  ];
  if (teacherName) rows.push(['Lehrkraft', teacherName]);
  const submitted = formatTimestamp(payload.submittedAt);
  if (submitted) rows.push(['Abgesendet am', submitted]);
  y = drawInfoBox(doc, y, rows, { title: 'Angaben', fill: COLORS.primaryLight, border: COLORS.primary, labelWidth: 38, valueSize: 12 });

  y = ensureSpace(doc, y + 1, 45);
  y = writeParagraph(doc, 'Verfügbare Zeiten', y, { size: 14, bold: true, color: COLORS.primary, spacingAfter: 1.5 });
  if (slotMinutes) {
    y = writeParagraph(doc, `Gesprächsraster: ${slotMinutes} Minuten`, y, { size: 9.5, color: COLORS.muted, spacingAfter: 1.5 });
  }
  y = drawLegend(doc, y + 0.5);

  for (const day of dayList(payload, eventInfo)) {
    const ranges = (payload.availability?.[day.date] || []).filter((r) => Array.isArray(r) && r.length === 2);
    y = drawDay(doc, y, day, ranges, slotMinutes);
  }

  y = ensureSpace(doc, y + 1, 16);
  const now = nowParts();
  writeParagraph(
    doc,
    `Erstellt am ${now.date} um ${now.time} Uhr mit ${APP_NAME}. Diese Datei enthält die Angaben zusätzlich in maschinenlesbarer Form – die Lehrkraft kann sie direkt in ${APP_NAME} hochladen.`,
    y,
    { size: 9, color: COLORS.muted, spacingAfter: 0 },
  );

  drawFooters(doc);
  embedPayload(doc, payload, { title: `${APP_NAME} – Rückmeldung ${child}${classId ? ` (${classId})` : ''}` });
  return { doc, filename: responseFilename({ ...payload, classId }) };
}
