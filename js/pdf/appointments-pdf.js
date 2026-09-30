// Terminbestätigungen einer Klasse: eine DIN-A4-Seite je terminiertem Kind (Name, Datum, Uhrzeit,
// Ort, Lehrkraft, E-Mail mit Hinweis für spontane Absagen oder Anfragen). Die letzte Seite ist eine
// Übersicht für die Lehrkraft mit allen Terminen aller ihrer Klassen, nach Tag und Uhrzeit sortiert.

import { APP_NAME } from '../config.js';
import { createPdf, drawBrandHeader, writeParagraph, drawInfoBox, drawTable, drawFooters, embedPayload, ensureSpace, setText, lineHeight, PAGE, CONTENT_WIDTH, COLORS } from '../core/pdf.js';
import { findClass } from '../core/storage.js';
import { toMinutes, fromMinutes, formatDateWithWeekday, formatRange, availabilityStatus, nowParts } from '../core/time.js';

/** Text der Spalte „Eltern verfügbar“ je Terminfarbe. */
const AVAILABILITY_TEXT = { ok: 'ja', partial: 'nur teilweise', unavailable: 'nein', unknown: 'keine Rückmeldung' };

/** Spalten der Übersichtstabelle (Summe = CONTENT_WIDTH = 170 mm). */
const OVERVIEW_COLUMNS = [
  { header: 'Beginn', width: 15 },
  { header: 'Ende', width: 15 },
  { header: 'Dauer', width: 17 },
  { header: 'Klasse', width: 15 },
  { header: 'Kind (Eltern von …)', width: 70 },
  { header: 'Eltern verfügbar', width: 38 },
];
/** Kompakter Satz der Übersicht: eine übliche Klasse (bis etwa 30 Termine) passt auf eine Seite. */
const OVERVIEW_SIZE = 8.5;
const OVERVIEW_PAD = 1.1;
const SUMMARY_SIZE = 10;

/** Dateiname, z. B. „ParentsDay Termine Klasse 5a.pdf“. */
export function appointmentsFilename(classId) {
  return `${APP_NAME} Termine Klasse ${classId}.pdf`;
}

const fullName = (s) => `${s.firstName || ''} ${s.lastName || ''}`.replace(/\s+/g, ' ').trim();

/** Termin eines Kindes als Zeitspanne in Minuten oder null. */
function appointmentOf(student, classId) {
  const a = student.appointment;
  const start = toMinutes(a?.start);
  if (!a || !a.date || Number.isNaN(start)) return null;
  const duration = Number(a.duration) > 0 ? Number(a.duration) : 10;
  return { student, classId, date: a.date, start, duration, end: start + duration };
}

/** Farbe des Termins wie im Kalender: ok | partial | unavailable | unknown. */
function statusOf(appt) {
  const response = appt.student.response;
  if (!response) return 'unknown';
  return availabilityStatus(response.availability?.[appt.date], appt.start, appt.duration);
}

function byTime(a, b) {
  return a.date.localeCompare(b.date) || a.start - b.start || a.classId.localeCompare(b.classId, 'de', { numeric: true }) || fullName(a.student).localeCompare(fullName(b.student), 'de');
}

/** Schulanschrift für die Kopfzeile: umbrochen, höchstens sechs Zeilen. */
function headerAddress(doc, address) {
  setText(doc, { size: 9 });
  const lines = String(address || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => doc.splitTextToSize(l, 95));
  setText(doc);
  if (lines.length > 6) return [...lines.slice(0, 5), `${lines[5]} …`].join('\n');
  return lines.join('\n');
}

/** Schulanschrift in einer Zeile (für den Kasten). */
function inlineAddress(address) {
  return String(address || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(', ');
}

/** Hellblauer Hinweiskasten; eine E-Mail-Adresse wird hervorgehoben und anklickbar. */
function noteBox(doc, y, text, email) {
  const pad = 5;
  const inner = CONTENT_WIDTH - 2 * pad - 3;
  const x = PAGE.margin;
  setText(doc, { size: 11, bold: true });
  const textLines = doc.splitTextToSize(text, inner);
  setText(doc, { size: 12.5, bold: true });
  const mailLines = email ? doc.splitTextToSize(email, inner) : [];
  const lhText = lineHeight(doc, 11);
  const lhMail = lineHeight(doc, 12.5);
  const height = pad * 2 + textLines.length * lhText + (mailLines.length ? 1.5 + mailLines.length * lhMail : 0);

  doc.setFillColor(COLORS.primaryLight);
  doc.setDrawColor(COLORS.primary);
  doc.setLineWidth(0.4);
  doc.roundedRect(x, y, CONTENT_WIDTH, height, 2.5, 2.5, 'FD');
  doc.setFillColor(COLORS.primary);
  doc.rect(x + 0.2, y + 2.5, 1.6, height - 5, 'F');

  let cy = y + pad;
  setText(doc, { size: 11, bold: true });
  doc.text(textLines, x + pad + 3, cy + lhText * 0.75);
  cy += textLines.length * lhText;
  if (mailLines.length) {
    cy += 1.5;
    setText(doc, { size: 12.5, bold: true, color: COLORS.primary });
    doc.text(mailLines, x + pad + 3, cy + lhMail * 0.75);
    const width = Math.max(...mailLines.map((l) => doc.getTextWidth(l)));
    doc.link(x + pad + 3, cy, width, mailLines.length * lhMail, { url: `mailto:${email}` });
  }
  setText(doc);
  return y + height + 6;
}

/** Eine Seite „Terminbestätigung“ für die Eltern eines Kindes. */
function drawConfirmationPage(doc, appt, ctx) {
  const student = appt.student;
  const name = fullName(student);
  let y = drawBrandHeader(doc, { subtitle: 'Elternsprechtag – Terminbestätigung', rightText: ctx.headerAddress });

  setText(doc, { size: 10, color: COLORS.muted });
  const lh = lineHeight(doc, 10);
  doc.text(`Klasse ${ctx.classId}`, PAGE.margin, y + lh * 0.75);
  doc.text(`Datum: ${ctx.created.date}`, PAGE.margin + CONTENT_WIDTH, y + lh * 0.75, { align: 'right' });
  y += lh + 5;

  y = writeParagraph(doc, 'Ihr Gesprächstermin zum Elternsprechtag', y, { size: 17, bold: true, spacingAfter: 6 });
  y = writeParagraph(doc, `Liebe Eltern und Erziehungsberechtigte von ${name},`, y, { spacingAfter: 2.5 });
  y = writeParagraph(doc, 'hiermit bestätige ich Ihnen folgenden Gesprächstermin:', y, { spacingAfter: 4 });

  const rows = [
    ['Kind', `${name} (Klasse ${ctx.classId})`],
    ['Datum', formatDateWithWeekday(appt.date)],
    ['Uhrzeit', `${formatRange(appt.start, appt.end)} (${appt.duration} Minuten)`],
  ];
  if (ctx.address) rows.push(['Ort', ctx.address]);
  rows.push(['Lehrkraft', ctx.teacherName]);
  if (ctx.teacherEmail) rows.push(['E-Mail', ctx.teacherEmail]);
  y = drawInfoBox(doc, y, rows, { title: 'Ihr Termin', labelWidth: 32, valueSize: 12.5 });

  y = writeParagraph(doc, 'Bitte seien Sie ein paar Minuten vor Beginn da, damit alle Gespräche pünktlich stattfinden können. Ich freue mich auf das Gespräch mit Ihnen.', y + 1, { spacingAfter: 5 });

  y = noteBox(
    doc,
    y,
    ctx.teacherEmail ? 'Bei spontanen Absagen oder Anfragen melden Sie sich gerne per E-Mail bei mir:' : 'Bei spontanen Absagen oder Anfragen melden Sie sich gerne bei mir.',
    ctx.teacherEmail,
  );

  y = writeParagraph(doc, 'Mit freundlichen Grüßen', y + 2, { spacingAfter: 3 });
  y = writeParagraph(doc, ctx.teacherName, y, { bold: true, spacingAfter: 0 });
  if (ctx.teacherEmail) writeParagraph(doc, ctx.teacherEmail, y, { color: COLORS.muted, spacingAfter: 0 });
}

/** Letzte Seite(n): Übersicht aller Termine der Lehrkraft, je Tag eine Tabelle. */
function drawOverview(doc, all, ctx, cls) {
  doc.addPage();
  let y = drawBrandHeader(doc, {
    subtitle: 'Elternsprechtag – Übersicht für die Lehrkraft',
    rightText: `${ctx.teacherName}\nErstellt am ${ctx.created.date} um ${ctx.created.time} Uhr`,
  });
  y = writeParagraph(doc, 'Übersicht der Gesprächstermine', y, { size: 15, bold: true, spacingAfter: 2 });
  const classIds = [...new Set(all.map((a) => a.classId))];
  const scope = classIds.length > 1 ? `aller Ihrer Klassen (${classIds.map((c) => `Klasse ${c}`).join(', ')})` : `aller Ihrer Klassen (zurzeit nur Klasse ${classIds[0]})`;
  y = writeParagraph(
    doc,
    `Für ${ctx.teacherName}: Diese Übersicht enthält die Termine ${scope}, sortiert nach Uhrzeit. So sehen Sie, wann die Eltern welchen Kindes kommen und bis wann das Gespräch dauert.`,
    y,
    { size: 9, color: COLORS.muted, spacingAfter: 4 },
  );

  const firstPage = doc.getNumberOfPages();
  const continuedDay = new Map(); // Seite → Tag, dessen Tabelle oben auf dieser Seite weitergeht
  const dayInfo = new Map((ctx.days || []).map((d) => [d.date, d]));
  const dates = [...new Set(all.map((a) => a.date))].sort();

  // Zeilen unter der letzten Tabelle: Summe und (falls vorhanden) Lernende ohne Termin. Sie werden vorher
  // gemessen und bleiben mit den letzten Tabellenzeilen auf einer Seite – nie allein auf einer eigenen Seite.
  const total = all.length;
  const totalText = `Insgesamt ${total === 1 ? '1 Termin' : `${total} Termine`}.`;
  const open = (cls.students || []).filter((s) => !s.appointment && fullName(s));
  const openText = open.length ? `Noch ohne Termin in Klasse ${cls.id}: ${open.map(fullName).join(', ')}.` : '';
  const lhSummary = lineHeight(doc, SUMMARY_SIZE);
  setText(doc, { size: SUMMARY_SIZE });
  const openLines = openText ? doc.splitTextToSize(openText, CONTENT_WIDTH).length : 0;
  setText(doc);
  const summaryHeight = lhSummary + 2 + (openLines ? openLines * lhSummary : 0);
  const reserve = 4 + 2 + summaryHeight; // Abstand unter der Tabelle + Summenzeilen
  const rowHeight = lineHeight(doc, OVERVIEW_SIZE) + 2 * OVERVIEW_PAD;
  const headingHeight = lineHeight(doc, 12) + 2;

  dates.forEach((date, index) => {
    const list = all.filter((a) => a.date === date);
    const day = dayInfo.get(date);
    const isLast = index === dates.length - 1;
    // Überschrift nicht allein am Seitenende: Tabellenkopf und die ersten Zeilen müssen darunter passen
    const firstRows = isLast && list.length <= 2 ? list.length * rowHeight + reserve : 2 * rowHeight;
    y = ensureSpace(doc, y, headingHeight + rowHeight + firstRows);
    const heading = `${formatDateWithWeekday(date)}${day ? ` · ${formatRange(day.start, day.end)}` : ''} · ${list.length === 1 ? '1 Termin' : `${list.length} Termine`}`;
    y = writeParagraph(doc, heading, y, { size: 12, bold: true, color: COLORS.primary, spacingAfter: 2 });
    const tableStart = doc.getNumberOfPages();
    y = drawTable(doc, y, {
      columns: OVERVIEW_COLUMNS,
      size: OVERVIEW_SIZE,
      pad: OVERVIEW_PAD,
      reserveAfterLast: isLast ? reserve : 0,
      rows: list.map((a) => [
        fromMinutes(a.start),
        fromMinutes(a.end),
        `${a.duration} Min.`,
        a.classId,
        fullName(a.student),
        AVAILABILITY_TEXT[statusOf(a)],
      ]),
    });
    for (let p = tableStart + 1; p <= doc.getNumberOfPages(); p++) continuedDay.set(p, date);
    y += 2;
  });

  y = ensureSpace(doc, y, summaryHeight);
  y = writeParagraph(doc, totalText, y, { size: SUMMARY_SIZE, bold: true, spacingAfter: 2 });
  if (openText) writeParagraph(doc, openText, y, { size: SUMMARY_SIZE, color: COLORS.muted, spacingAfter: 0 });

  // Folgeseiten der Übersicht: kurze Zeile über der Tabelle, damit klar ist, zu welchem Tag die Zeilen gehören
  const lastPage = doc.getNumberOfPages();
  for (let p = firstPage + 1; p <= lastPage; p++) {
    const date = continuedDay.get(p);
    doc.setPage(p);
    setText(doc, { size: 9, bold: true, color: COLORS.muted });
    doc.text(`Übersicht der Gesprächstermine (Fortsetzung)${date ? ` – ${formatDateWithWeekday(date)}` : ''}`, PAGE.margin, PAGE.margin - 5);
  }
  doc.setPage(lastPage);
  setText(doc);
}

/**
 * Terminbestätigungen einer Klasse (eine Seite je Termin) plus Übersichtstabelle als letzte Seite.
 * @param {object} state – TeacherState
 * @param {string} classId
 * @returns {Promise<{doc: object, filename: string, appointmentCount: number}>}
 */
export async function createAppointmentsPdf(state, classId) {
  const cls = findClass(state, classId);
  if (!cls) throw new Error(`Die Klasse ${classId} wurde nicht gefunden.`);
  const own = (cls.students || [])
    .map((s) => appointmentOf(s, cls.id))
    .filter(Boolean)
    .sort(byTime);
  if (own.length === 0) throw new Error('In dieser Klasse ist noch kein Termin eingetragen.');

  const all = (state.classes || [])
    .flatMap((c) => (c.students || []).map((s) => appointmentOf(s, c.id)))
    .filter(Boolean)
    .sort(byTime);

  const t = state.teacher || {};
  const doc = await createPdf();
  const ctx = {
    classId: cls.id,
    teacherName: `${t.firstName || ''} ${t.lastName || ''}`.trim(),
    teacherEmail: (t.email || '').trim(),
    address: inlineAddress(state.event?.schoolAddress),
    headerAddress: headerAddress(doc, state.event?.schoolAddress),
    days: state.event?.days || [],
    created: nowParts(),
  };

  own.forEach((appt, i) => {
    if (i > 0) doc.addPage();
    drawConfirmationPage(doc, appt, ctx);
  });
  drawOverview(doc, all, ctx, cls);
  drawFooters(doc, `Erstellt mit ${APP_NAME}`);
  embedPayload(
    doc,
    { app: APP_NAME, type: 'appointments', v: 1, classId: cls.id, count: own.length, createdAt: new Date().toISOString() },
    { title: `${APP_NAME} – Termine Klasse ${cls.id}`, author: ctx.teacherName },
  );
  return { doc, filename: appointmentsFilename(cls.id), appointmentCount: own.length };
}
