// Gespräche terminieren (#/lehrkraft/klasse/<id>/terminieren): Kalender mit einer Spalte je Tag des
// Elternsprechtags. Namen werden per Drag & Drop (Pointer-Events: Maus, Touch, Stift) auf die
// Anfangsuhrzeit gezogen – die Oberkante des Blocks ist der Beginn des Gesprächs.
//
// Farbe eines Termins (availabilityStatus aus core/time.js): blau = Eltern haben Zeit, orange = ragt in
// nicht verfügbare Zeit, rot = zu Beginn nicht verfügbar; ohne Rückmeldung blau gestrichelt mit „?“.
// Termine anderer Klassen derselben Lehrkraft erscheinen grau und sind nicht verschiebbar.
//
// Ohne Ziehen (Touch/Tastatur): Namen antippen (auswählen) und danach in eine Tagesspalte tippen –
// oder im Detailfeld Tag und Uhrzeit wählen. Jede Änderung wird sofort gespeichert.

import { h, mount, toast, alertBox, friendlyError } from '../core/ui.js';
import { updateState, getCurrentState, findClass } from '../core/storage.js';
import { toMinutes, fromMinutes, formatDate, formatDateWithWeekday, formatRange, formatRanges, availabilityStatus, normalizeRanges, parseIsoDate, WEEKDAYS_SHORT } from '../core/time.js';
import { savePdf, openPdfForPrint, preloadPdf } from '../core/pdf.js';
import { createAppointmentsPdf } from '../pdf/appointments-pdf.js';

const PX = 3; // Pixel pro Minute (10 Minuten = 30 px)
const SNAP = 5; // Raster für Beginn und Dauer in Minuten
const MIN_DURATION = 5;
const DRAG_THRESHOLD = 4; // Bewegung in px, ab der aus einem Klick ein Ziehen wird
const EDGE_TOLERANCE = 14; // px oberhalb/unterhalb einer Tagesspalte, die noch als Ziel gelten
const FINALIZE_LABEL = 'Termine festlegen, speichern und drucken';

const STATUS_TEXT = {
  ok: 'Eltern haben Zeit',
  partial: 'Termin ragt in nicht verfügbare Zeit',
  unavailable: 'Eltern sind zu Beginn nicht verfügbar',
  unknown: 'Noch keine Rückmeldung der Eltern',
};

// ---------- Hilfen ----------

const fullName = (s) => `${s.firstName || ''} ${s.lastName || ''}`.replace(/\s+/g, ' ').trim();
const snap = (minutes) => Math.round(minutes / SNAP) * SNAP;
const durationText = (minutes) => `(${minutes} Min.)`;

/**
 * Name und Dauer als getrennte Teile: gekürzt wird nur der Name, „(10 Min.)“ bleibt immer sichtbar.
 * In sehr schmalen Spalten zeigt CSS die Kurzform „(10′)“.
 */
function nameWithDuration(name, minutes, prefix = '') {
  return h(
    'span',
    { class: 'sched-appt-text' },
    h('span', { class: 'sched-appt-name' }, prefix, name),
    ' ', // Leerzeichen für Textauszug und Vorlesen (im Flex-Layout unsichtbar)
    h('span', { class: 'sched-appt-dur' }, h('span', { class: 'sched-dur-long' }, durationText(minutes)), h('span', { class: 'sched-dur-short', 'aria-hidden': 'true' }, `(${minutes}′)`)),
  );
}

/** "2026-11-12" → "Do, 12.11.2026" */
function dayShort(iso) {
  return `${WEEKDAYS_SHORT[parseIsoDate(iso).getDay()]}, ${formatDate(iso)}`;
}

/** "2026-11-12" → "Do, 12.11." */
function dayTiny(iso) {
  const [, m, d] = String(iso).split('-');
  return `${WEEKDAYS_SHORT[parseIsoDate(iso).getDay()]}, ${d}.${m}.`;
}

/** Tage des Elternsprechtags in Minuten; ungültige Tage werden übersprungen. */
function eventDays(event) {
  return (event?.days || [])
    .map((d) => ({ date: d.date, start: toMinutes(d.start), end: toMinutes(d.end) }))
    .filter((d) => d.date && !Number.isNaN(d.start) && !Number.isNaN(d.end) && d.end > d.start);
}

/** Farbe eines Termins: ok | partial | unavailable | unknown (keine Rückmeldung). */
function statusFor(student, date, start, duration) {
  if (!student?.response) return 'unknown';
  return availabilityStatus(student.response.availability?.[date], start, duration);
}

/** Beginn begrenzen auf [Tagesbeginn, Tagesende − Dauer]. */
function clampStart(start, duration, day) {
  return Math.min(Math.max(start, day.start), Math.max(day.start, day.end - duration));
}

/** Kurztext der Verfügbarkeit je Tag, z. B. ["Do, 12.11.: 14:00–15:00 Uhr"]. */
function availabilityLines(student, days) {
  if (!student.response) return [];
  const availability = student.response.availability || {};
  const dates = new Set(days.map((d) => d.date));
  for (const [date, ranges] of Object.entries(availability)) if (ranges?.length) dates.add(date);
  return [...dates]
    .sort()
    .map((date) => ({ date, ranges: [...(availability[date] || [])].sort((a, b) => toMinutes(a[0]) - toMinutes(b[0])) }))
    .filter((d) => d.ranges.length)
    .map((d) => `${dayTiny(d.date)}: ${formatRanges(d.ranges)}`);
}

/**
 * Ordnet sich überschneidende Blöcke nebeneinander an (Spur/lane, Anzahl Spuren/lanes).
 * @returns {Array<Array<object>>} Gruppen mit Überschneidungen
 */
function layoutLanes(items) {
  items.sort((a, b) => a.start - b.start || b.end - a.end);
  const clusters = [];
  let cluster = [];
  let clusterEnd = -Infinity;
  for (const it of items) {
    if (cluster.length && it.start >= clusterEnd) {
      clusters.push(cluster);
      cluster = [];
      clusterEnd = -Infinity;
    }
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  if (cluster.length) clusters.push(cluster);
  for (const c of clusters) {
    const laneEnds = [];
    for (const it of c) {
      let lane = laneEnds.findIndex((end) => end <= it.start);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(it.end);
      } else laneEnds[lane] = it.end;
      it.lane = lane;
    }
    for (const it of c) {
      it.lanes = laneEnds.length;
      it.overlap = c.length > 1;
    }
  }
  return clusters.filter((c) => c.length > 1);
}

function laneStyle(lane, lanes) {
  if (lanes <= 1) return { left: '4px', right: '4px' };
  return { left: `calc(4px + (100% - 8px) * ${lane} / ${lanes})`, width: `calc((100% - 8px) / ${lanes} - 2px)` };
}

// ---------- View ----------

export default function render(ctx) {
  const { root, params, navigate, setTitle } = ctx;
  const classId = params.classId;
  let state = getCurrentState() || ctx.state;
  if (!state?.event) {
    navigate('/lehrkraft/elternsprechtag', { replace: true });
    return;
  }
  setTitle(`Gespräche terminieren – Klasse ${classId}`);
  let cls = findClass(state, classId);

  if (!cls) {
    mount(
      root,
      h(
        'div',
        { class: 'sched-page' },
        h('a', { class: 'back-link', href: '#/lehrkraft/klassen' }, 'Alle Klassen'),
        h(
          'div',
          { class: 'card card-narrow stack' },
          h('h1', {}, `Klasse ${classId} nicht gefunden`),
          alertBox('warning', 'Diese Klasse gibt es in Ihren Daten nicht. Vielleicht wurde sie gelöscht oder ein anderer Zwischenstand geladen.'),
          h('div', {}, h('a', { class: 'btn btn-primary', href: '#/lehrkraft/klassen' }, 'Zur Klassenübersicht')),
        ),
      ),
    );
    return;
  }

  const namedStudents = () => cls.students.filter((s) => fullName(s));
  if (!cls.codesGenerated || namedStudents().length === 0) {
    // Codes gibt es schon, aber neue Lernende kamen hinzu: vorhandene Termine bleiben erhalten.
    const partlyDone = cls.students.some((s) => s.code);
    mount(
      root,
      h(
        'div',
        { class: 'sched-page' },
        h('a', { class: 'back-link', href: `#/lehrkraft/klasse/${classId}` }, `Klasse ${classId}`),
        h(
          'div',
          { class: 'card card-narrow stack' },
          h('h1', {}, `Gespräche terminieren – Klasse ${classId}`),
          alertBox(
            'info',
            h('strong', {}, 'Bitte erzeugen Sie zuerst in der Klasse die Codes. '),
            partlyDone
              ? 'Für neu eingetragene Lernende fehlen noch Codes. Klicken Sie in der Klasse auf „Alle Lernenden erfolgreich eingetragen“ – bereits eingetragene Termine bleiben erhalten.'
              : 'Tragen Sie dazu alle Lernenden ein und klicken Sie auf „Alle Lernenden erfolgreich eingetragen“. Danach können Sie hier die Gespräche terminieren.',
          ),
          h('div', {}, h('a', { class: 'btn btn-primary', href: `#/lehrkraft/klasse/${classId}` }, `Zur Klasse ${classId}`)),
        ),
      ),
    );
    return;
  }

  const days = eventDays(state.event);
  const dayMap = new Map(days.map((d) => [d.date, d]));
  const slotMinutes = Number(state.event.slotMinutes) > 0 ? Number(state.event.slotMinutes) : 10;

  let selectedId = null;
  let drag = null;
  let suppressClick = false; // Klick, der direkt aus einem Ziehen entsteht, nicht als Auswahl werten
  let suppressTimer = 0;
  let finalizing = false;
  let detailRefs = null;
  const trackRefs = new Map(); // Datum → { track, bands, day }

  preloadPdf().catch(() => {});

  // ---------- Zugriff auf Daten ----------

  const studentById = (id) => cls.students.find((s) => s.id === id) || null;

  /** Lage eines Termins im Kalender – oder { outside: true }, wenn er nicht in die Sprechzeiten passt. */
  function placement(st) {
    const a = st?.appointment;
    if (!a) return null;
    const day = dayMap.get(a.date);
    const start = toMinutes(a.start);
    const duration = Number(a.duration) > 0 ? Number(a.duration) : slotMinutes;
    if (!day || Number.isNaN(start) || start < day.start || start + duration > day.end) return { outside: true, date: a.date, start, duration };
    return { day, date: a.date, start, duration, end: start + duration };
  }

  /** Dauer für einen neuen Termin bzw. beim Verschieben (vorhandene Dauer bleibt erhalten). */
  function durationFor(st, day) {
    const current = Number(st?.appointment?.duration) > 0 ? Number(st.appointment.duration) : slotMinutes;
    return Math.max(MIN_DURATION, Math.min(current, day.end - day.start));
  }

  /** Alle Termine (dieser und anderer Klassen) an einem Tag. */
  function itemsOfDay(day) {
    const items = [];
    for (const c of state.classes) {
      for (const st of c.students) {
        const a = st.appointment;
        if (!a || a.date !== day.date) continue;
        if (c.id === cls.id) {
          const p = placement(st);
          if (!p || p.outside) continue;
          items.push({ own: true, student: st, classId: c.id, start: p.start, end: p.end, duration: p.duration });
        } else {
          const start = toMinutes(a.start);
          const duration = Number(a.duration) > 0 ? Number(a.duration) : slotMinutes;
          if (Number.isNaN(start)) continue;
          const s = Math.max(start, day.start);
          const e = Math.min(start + duration, day.end);
          if (e <= s) continue;
          items.push({ own: false, student: st, classId: c.id, start: s, end: e, realStart: start, duration });
        }
      }
    }
    return items;
  }

  /** Speichert eine Änderung und liest den Zustand neu ein. */
  function save(mutator) {
    try {
      state = updateState(mutator);
      cls = findClass(state, classId) || cls;
      return true;
    } catch (err) {
      console.error(err);
      toast(`Die Änderung konnte nicht gespeichert werden. ${friendlyError(err)}`, 'error', 8000);
      return false;
    }
  }

  function setAppointment(studentId, appointment) {
    return save((s) => {
      const st = findClass(s, classId)?.students.find((x) => x.id === studentId);
      if (st) st.appointment = appointment ? { ...appointment } : null;
    });
  }

  /** Trägt einen Termin ein bzw. verschiebt ihn (Beginn/Dauer in Minuten). */
  function place(studentId, date, start, duration) {
    const st = studentById(studentId);
    const day = dayMap.get(date);
    if (!st || !day) return;
    const dur = Math.max(MIN_DURATION, Math.min(duration, day.end - day.start));
    const begin = clampStart(start, dur, day);
    if (!setAppointment(studentId, { date, start: fromMinutes(begin), duration: dur })) return;
    const status = statusFor(st, date, begin, dur);
    announce(`${fullName(st)}: ${formatDateWithWeekday(date)}, ${formatRange(begin, begin + dur)} – ${STATUS_TEXT[status]}.`);
  }

  function removeAppointment(studentId, { focusChip = false } = {}) {
    const st = studentById(studentId);
    if (!st || !setAppointment(studentId, null)) return;
    if (selectedId === studentId) selectedId = null;
    renderAll();
    announce(`Der Termin von ${fullName(st)} wurde entfernt.`);
    if (focusChip) root.querySelector(`[data-testid="schedule-student-${studentId}"]`)?.focus();
  }

  // ---------- Grundgerüst ----------

  const live = h('div', { class: 'visually-hidden', 'aria-live': 'polite', role: 'status' });
  function announce(text) {
    live.textContent = '';
    setTimeout(() => (live.textContent = text), 30);
  }

  const counter = h('span', { class: 'badge badge-info sched-counter', 'aria-live': 'polite' });
  const finalizeBtn = h('button', { type: 'button', class: 'btn btn-primary sched-finalize', 'data-testid': 'schedule-finalize', onclick: onFinalize }, FINALIZE_LABEL);
  const messages = h('div', { class: 'sched-messages', 'aria-live': 'polite' });
  const warnings = h('div', { class: 'sched-warnings', 'aria-live': 'polite' });
  const detail = h('section', { class: 'card sched-detail', 'aria-label': 'Ausgewählter Termin', hidden: true });
  const poolCount = h('span', { class: 'badge sched-pool-count' });
  const chipList = h('ul', { class: 'sched-chips', role: 'list' });
  const poolHint = h('p', { class: 'small muted sched-pool-hint', id: 'sched-pool-hint' }, 'Ziehen Sie einen Namen auf die gewünschte Anfangsuhrzeit – oder tippen Sie ihn an und danach im Kalender auf die Uhrzeit.');
  const dropHint = h('p', { class: 'sched-drop-hint', 'aria-hidden': 'true' }, 'Hier loslassen, um den Termin zu entfernen');
  const pool = h(
    'section',
    { class: 'card sched-pool', 'aria-labelledby': 'sched-pool-title' },
    h('div', { class: 'sched-pool-head' }, h('h2', { id: 'sched-pool-title' }, 'Noch nicht terminiert'), poolCount),
    poolHint,
    chipList,
    dropHint,
  );
  const sidebar = h('aside', { class: 'sched-sidebar', 'aria-label': 'Lernende ohne Termin' }, detail, pool);
  const daysHost = h('div', { class: 'sched-days' });
  const scroller = h('div', { class: 'sched-scroll' }, daysHost);
  const calendar = h('section', { class: 'card sched-main', 'aria-label': 'Kalender des Elternsprechtags' }, scroller);

  const swatch = (cls2, text, title) => h('span', { class: 'sched-legend-item', title }, h('span', { class: `legend-swatch ${cls2}`, 'aria-hidden': 'true' }), text);
  const legend = h(
    'div',
    { class: 'legend sched-legend', 'aria-label': 'Bedeutung der Farben' },
    swatch('sched-sw-ok', 'Blau: Eltern haben Zeit'),
    swatch('sched-sw-partial', 'Orange: ragt in nicht verfügbare Zeit'),
    swatch('sched-sw-unavailable', 'Rot: Eltern zu Beginn nicht verfügbar'),
    swatch('sched-sw-unknown', 'Keine Rückmeldung (?)', 'Noch keine Rückmeldung der Eltern'),
    swatch('sched-sw-other', 'Grau: andere Klasse'),
    swatch('sched-sw-free', 'Grün: freie Zeiten der Eltern (beim Ziehen)'),
  );
  const help = h(
    'details',
    { class: 'sched-help' },
    h('summary', {}, 'Tipps zur Bedienung'),
    h(
      'ul',
      {},
      h('li', {}, h('strong', {}, 'Termin eintragen: '), 'Namen aus der Liste „Noch nicht terminiert“ auf die Anfangsuhrzeit ziehen. Die Oberkante des Blocks ist der Beginn des Gesprächs.'),
      h('li', {}, h('strong', {}, 'Ohne Ziehen: '), 'Namen antippen und danach im Kalender auf die gewünschte Uhrzeit tippen – oder Tag und Uhrzeit im Feld „Termin eintragen“ wählen.'),
      h('li', {}, h('strong', {}, 'Verschieben: '), 'Block an eine andere Uhrzeit oder einen anderen Tag ziehen. Auf Tablet und Smartphone den Block zuerst antippen und dann ziehen – so verschiebt ein Wischen zum Blättern keinen Termin aus Versehen. Mit der Tastatur: Block mit Tab ansteuern und die Pfeiltasten ↑/↓ drücken.'),
      h('li', {}, h('strong', {}, 'Dauer ändern: '), 'Unterkante eines Blocks ziehen oder den Block anklicken und die Minuten eintragen.'),
      h('li', {}, h('strong', {}, 'Entfernen: '), 'Auf × klicken oder den Block zurück in die Liste ziehen. Mit Esc brechen Sie das Ziehen ab.'),
    ),
  );

  const page = h(
    'div',
    { class: 'sched-page' },
    h('a', { class: 'back-link', href: `#/lehrkraft/klasse/${classId}` }, `Klasse ${classId}`),
    h(
      'div',
      { class: 'page-header sched-header' },
      h(
        'div',
        { class: 'sched-title' },
        h('h1', {}, `Gespräche terminieren – Klasse ${classId}`),
        h('p', { class: 'subtitle' }, 'Ziehen Sie die Namen auf die Anfangsuhrzeit des Gesprächs. Die Farbe zeigt, ob die Eltern zu dieser Zeit können.'),
      ),
      h('div', { class: 'sched-header-actions' }, counter, finalizeBtn),
    ),
    h('div', { class: 'sched-info' }, legend, help),
    messages,
    warnings,
    h('div', { class: 'sched-layout' }, sidebar, calendar),
    live,
  );
  mount(root, page);

  // Abstand der klebenden Seitenleiste unter der (ebenfalls klebenden) Kopfzeile
  function updateStickyTop() {
    const header = document.querySelector('.site-header');
    const top = header ? Math.round(header.getBoundingClientRect().height) : 0;
    page.style.setProperty('--sched-top', `${top + 12}px`);
  }
  updateStickyTop();

  renderAll();

  // ---------- Darstellung ----------

  function renderAll() {
    renderCounter();
    renderPool();
    renderCalendar();
    renderWarnings();
    renderDetail();
  }

  function renderCounter() {
    const students = namedStudents();
    const done = students.filter((s) => s.appointment).length;
    const text = `${done} von ${students.length} terminiert`;
    if (counter.textContent !== text) counter.textContent = text; // aria-live: nur bei Änderung vorlesen
  }

  function renderPool() {
    const open = namedStudents().filter((s) => !s.appointment);
    poolCount.textContent = String(open.length);
    poolHint.hidden = open.length === 0;
    if (open.length === 0) {
      mount(chipList, h('li', { class: 'sched-pool-empty' }, h('span', { 'aria-hidden': 'true' }, '✓ '), 'Alle Lernenden sind terminiert.'));
      return;
    }
    mount(chipList, open.map((st) => h('li', {}, chip(st))));
  }

  function chip(st) {
    const lines = availabilityLines(st, days);
    let info;
    if (!st.response) info = h('span', { class: 'sched-chip-info sched-chip-pending' }, 'Rückmeldung ausstehend');
    else if (lines.length === 0) info = h('span', { class: 'sched-chip-info' }, 'Keine freien Zeiten angegeben');
    else info = h('span', { class: 'sched-chip-info' }, lines.map((l) => h('span', { class: 'sched-chip-line' }, l)));
    return h(
      'button',
      {
        type: 'button',
        class: `sched-chip${st.response ? '' : ' sched-chip-unknown'}`,
        'data-testid': `schedule-student-${st.id}`,
        'data-student': st.id,
        'aria-pressed': String(selectedId === st.id),
        'aria-describedby': 'sched-pool-hint',
        onclick: (e) => {
          if (consumeClick(e)) return;
          const on = selectedId !== st.id;
          select(on ? st.id : null);
          // Tastatur (Enter/Leertaste): direkt ins Formular „Termin eintragen“ springen – Esc führt zurück.
          if (on && e.detail === 0) focusDetail();
        },
      },
      h('span', { class: 'sched-chip-grip', 'aria-hidden': 'true' }),
      h(
        'span',
        { class: 'sched-chip-body' },
        h('span', { class: 'sched-chip-name' }, h('span', { class: 'sched-chip-text' }, fullName(st)), st.response ? null : h('span', { class: 'sched-q', title: STATUS_TEXT.unknown, 'aria-hidden': 'true' }, '?')),
        info,
      ),
    );
  }

  /** Setzt den Fokus auf das erste Eingabefeld im Detailfeld (nach Auswahl mit der Tastatur). */
  function focusDetail() {
    for (const d of detail.querySelectorAll('details.sched-place-toggle')) d.open = true;
    detail.querySelector('input, select')?.focus();
  }

  function renderCalendar() {
    trackRefs.clear();
    if (days.length === 0) {
      mount(daysHost, alertBox('warning', 'Für den Elternsprechtag sind noch keine Tage mit Uhrzeiten eingetragen. ', h('a', { href: '#/lehrkraft/einstellungen' }, 'Zu den Einstellungen')));
      return;
    }
    mount(daysHost, days.map(dayColumn));
    paintBands();
    markSelection();
  }

  function dayColumn(day) {
    const height = (day.end - day.start) * PX;
    const labelEvery = slotMinutes < 10 ? 2 : 1;
    const lines = [];
    const labels = [];
    let i = 0;
    for (let t = day.start; t <= day.end; t += slotMinutes, i++) {
      const top = (t - day.start) * PX;
      if (t > day.start && t < day.end) lines.push(h('div', { class: `sched-line${t % 60 === 0 ? ' sched-line-hour' : ''}`, style: { top: `${top}px` } }));
      if (i % labelEvery === 0) labels.push(h('span', { class: `sched-label${t % 60 === 0 ? ' sched-label-hour' : ''}`, style: { top: `${top}px` } }, fromMinutes(t)));
    }
    if ((day.end - day.start) % (slotMinutes * labelEvery) !== 0) labels.push(h('span', { class: 'sched-label', style: { top: `${height}px` } }, fromMinutes(day.end)));

    const bands = h('div', { class: 'sched-bands', 'aria-hidden': 'true' });
    const items = itemsOfDay(day);
    layoutLanes(items);
    const track = h(
      'div',
      {
        class: 'sched-track',
        'data-testid': `schedule-day-${day.date}`,
        'data-date': day.date,
        style: { height: `${height}px` },
        onclick: (e) => onTrackClick(e, day, track),
      },
      bands,
      lines,
      items.map((it) => (it.own ? appointmentBlock(it, day) : otherBlock(it, day))),
    );
    trackRefs.set(day.date, { track, bands, day });
    const headId = `sched-day-${day.date}`;
    const count = items.filter((it) => it.own).length;
    return h(
      'section',
      { class: 'sched-day', 'aria-labelledby': headId },
      h(
        'h3',
        { class: 'sched-day-head', id: headId },
        h('span', { class: 'sched-day-date' }, dayShort(day.date)),
        h('span', { class: 'sched-day-sep', 'aria-hidden': 'true' }, ' · '),
        h('span', { class: 'sched-day-time' }, formatRange(day.start, day.end)),
        count ? h('span', { class: 'visually-hidden' }, ` – ${count} ${count === 1 ? 'Termin' : 'Termine'} dieser Klasse`) : null,
      ),
      h('div', { class: 'sched-day-body' }, h('div', { class: 'sched-axis', 'aria-hidden': 'true', style: { height: `${height}px` } }, labels), track),
    );
  }

  function appointmentBlock(it, day) {
    const st = it.student;
    const status = statusFor(st, day.date, it.start, it.duration);
    const name = fullName(st);
    const label = h('span', { class: 'sched-appt-label' });
    const main = h(
      'button',
      {
        type: 'button',
        class: 'sched-appt-main',
        'aria-pressed': String(selectedId === st.id),
        onclick: (e) => {
          if (consumeClick(e)) return;
          select(st.id);
          if (e.detail === 0) focusDetail(); // Tastatur: weiter zur Dauer-Eingabe
        },
        onkeydown: (e) => onBlockKey(e, st.id),
      },
      label,
    );
    const block = h(
      'div',
      {
        class: `sched-appt sched-appt-${status}${it.overlap ? ' sched-overlap' : ''}`,
        'data-testid': `appointment-${st.id}`,
        'data-status': status,
        'data-student': st.id,
        style: { top: `${(it.start - day.start) * PX}px`, height: `${it.duration * PX}px`, ...laneStyle(it.lane, it.lanes) },
      },
      main,
      h('button', { type: 'button', class: 'sched-appt-remove', 'aria-label': `Termin von ${name} entfernen`, title: 'Termin entfernen', onclick: () => removeAppointment(st.id, { focusChip: true }) }, '×'),
      h('div', { class: 'sched-appt-resize', 'aria-hidden': 'true', title: 'Ziehen, um die Dauer zu ändern' }),
    );
    block._label = label;
    block._main = main;
    fillBlock(block, st, day.date, it.start, it.duration, it.overlap);
    return block;
  }

  /** Beschriftung, Größe und Farbe eines Blocks (auch live beim Ändern der Dauer). */
  function fillBlock(block, st, date, start, duration, overlap = block.classList.contains('sched-overlap')) {
    const status = statusFor(st, date, start, duration);
    const name = fullName(st);
    block.dataset.status = status;
    block.classList.remove('sched-appt-ok', 'sched-appt-partial', 'sched-appt-unavailable', 'sched-appt-unknown');
    block.classList.add(`sched-appt-${status}`);
    block.classList.toggle('sched-appt-short', duration < 10);
    block.classList.toggle('sched-appt-tall', duration >= 20);
    block.style.height = `${duration * PX}px`;
    const time = formatRange(start, start + duration);
    mount(
      block._label,
      h(
        'span',
        { class: 'sched-appt-row' },
        nameWithDuration(name, duration),
        status === 'unknown' ? h('span', { class: 'sched-q', title: STATUS_TEXT.unknown, 'aria-hidden': 'true' }, '?') : null,
      ),
      duration >= 20 ? h('span', { class: 'sched-appt-time' }, time) : null,
    );
    const info = `${name} ${durationText(duration)}, ${dayTiny(date)} ${time} – ${STATUS_TEXT[status]}${overlap ? ' – überschneidet sich mit einem anderen Termin' : ''}`;
    block._main.title = info;
    block._main.setAttribute('aria-label', `${info}. Zum Bearbeiten auswählen.`);
  }

  function otherBlock(it, day) {
    const name = fullName(it.student);
    const time = formatRange(it.realStart, it.realStart + it.duration);
    return h(
      'div',
      {
        class: `sched-other${it.overlap ? ' sched-overlap' : ''}`,
        style: { top: `${(it.start - day.start) * PX}px`, height: `${(it.end - it.start) * PX}px`, ...laneStyle(it.lane, it.lanes) },
        title: `Klasse ${it.classId}: ${name}, ${time} (Termin einer anderen Klasse)`,
      },
      h('span', { class: 'sched-other-text' }, `${it.classId} · ${name}`),
      h('span', { class: 'visually-hidden' }, `, ${time}, Termin einer anderen Klasse`),
    );
  }

  /** Grüne Bänder mit den freien Zeiten der Eltern (beim Ziehen oder für das ausgewählte Kind). */
  function paintBands() {
    const st = drag && drag.phase !== 'pending' ? studentById(drag.studentId) : studentById(selectedId);
    for (const { bands, day } of trackRefs.values()) {
      const ranges = st?.response ? normalizeRanges(st.response.availability?.[day.date]) : [];
      mount(
        bands,
        ranges
          .map(([s, e]) => [Math.max(s, day.start), Math.min(e, day.end)])
          .filter(([s, e]) => e > s)
          .map(([s, e]) => h('div', { class: 'sched-band', style: { top: `${(s - day.start) * PX}px`, height: `${(e - s) * PX}px` }, title: `Eltern verfügbar: ${formatRange(s, e)}` })),
      );
    }
  }

  function markSelection() {
    for (const el of root.querySelectorAll('.sched-chip')) el.setAttribute('aria-pressed', String(el.dataset.student === selectedId));
    for (const el of root.querySelectorAll('.sched-appt[data-student]')) {
      const on = el.dataset.student === selectedId;
      el.classList.toggle('sched-selected', on);
      el._main?.setAttribute('aria-pressed', String(on));
    }
    const st = studentById(selectedId);
    page.classList.toggle('sched-has-selection', Boolean(st));
    page.classList.toggle('sched-placing', Boolean(st && !st.appointment));
  }

  function renderWarnings() {
    const parts = [];
    // Überschneidungen (auch mit Terminen anderer Klassen)
    const overlapItems = [];
    for (const day of days) {
      const items = itemsOfDay(day);
      for (const c of layoutLanes(items)) {
        if (!c.some((it) => it.own)) continue;
        const start = Math.min(...c.map((it) => it.start));
        const end = Math.max(...c.map((it) => it.end));
        const names = c.map((it) => (it.own ? fullName(it.student) : `${fullName(it.student)} (Klasse ${it.classId})`));
        overlapItems.push(h('li', {}, h('strong', {}, `${dayShort(day.date)}, ${formatRange(start, end)}: `), names.join(', ')));
      }
    }
    if (overlapItems.length) {
      parts.push(
        alertBox(
          'warning',
          h('strong', {}, 'Diese Termine überschneiden sich:'),
          h('ul', { class: 'sched-warning-list' }, overlapItems),
          h('p', { class: 'small' }, 'Verschieben Sie einen der Termine oder verkürzen Sie die Dauer, damit sich die Gespräche nicht überschneiden.'),
        ),
      );
    }
    // Termine außerhalb der Sprechzeiten (z. B. nach geänderten Uhrzeiten)
    const outside = namedStudents().filter((st) => placement(st)?.outside);
    if (outside.length) {
      parts.push(
        alertBox(
          'warning',
          h('strong', {}, 'Diese Termine liegen außerhalb der Sprechzeiten des Elternsprechtags:'),
          h(
            'ul',
            { class: 'sched-warning-list' },
            outside.map((st) => {
              const p = placement(st);
              const when = Number.isNaN(p.start) ? formatDateWithWeekday(p.date) : `${formatDateWithWeekday(p.date)}, ${formatRange(p.start, p.start + p.duration)}`;
              return h(
                'li',
                { class: 'sched-outside-item' },
                h('span', {}, h('strong', {}, fullName(st)), ` – ${when}`),
                // Ohne Tage im Kalender ließe sich der Termin nicht neu setzen – dann nur der Hinweis
                days.length ? h('button', { type: 'button', class: 'btn btn-small btn-secondary', onclick: () => replan(st.id) }, 'Neu einplanen') : null,
              );
            }),
          ),
        ),
      );
    }
    // aria-live: unveränderte Hinweise nicht neu einsetzen (sonst bei jedem Tastendruck erneut vorgelesen)
    const next = h('div', {}, parts);
    if (next.textContent === warnings.textContent) return;
    mount(warnings, [...next.childNodes]);
  }

  function replan(studentId) {
    if (!setAppointment(studentId, null)) return;
    selectedId = studentId;
    renderAll();
    root.querySelector(`[data-testid="schedule-student-${studentId}"]`)?.focus();
  }

  // ---------- Detailfeld ----------

  function select(id) {
    selectedId = id && studentById(id) ? id : null;
    markSelection();
    paintBands();
    renderDetail();
    if (selectedId) {
      const st = studentById(selectedId);
      const p = placement(st);
      announce(p && !p.outside ? `${fullName(st)} ausgewählt: ${formatDateWithWeekday(p.date)}, ${formatRange(p.start, p.end)}.` : `${fullName(st)} ausgewählt. Tippen Sie jetzt im Kalender auf die gewünschte Uhrzeit oder wählen Sie Tag und Uhrzeit im Feld „Termin eintragen“.`);
    }
  }

  function renderDetail() {
    const st = studentById(selectedId);
    detailRefs = null;
    if (!st) {
      detail.hidden = true;
      mount(detail);
      return;
    }
    detail.hidden = false;
    const p = placement(st);
    const scheduled = p && !p.outside;
    const head = h(
      'div',
      { class: 'sched-detail-head' },
      h('div', {}, h('p', { class: 'sched-detail-kicker' }, scheduled ? 'Ausgewählter Termin' : 'Ausgewählt – noch ohne Termin'), h('h2', { class: 'sched-detail-name' }, fullName(st))),
      h('button', { type: 'button', class: 'btn btn-ghost btn-icon sched-detail-close', 'aria-label': 'Auswahl schließen', title: 'Schließen', 'data-focus': 'detail-close', onclick: () => select(null) }, '×'),
    );
    const lines = availabilityLines(st, days);
    const avail = h(
      'div',
      { class: 'sched-detail-avail' },
      h('h3', {}, 'Verfügbarkeit der Eltern'),
      !st.response
        ? h('p', { class: 'sched-chip-pending' }, 'Rückmeldung ausstehend')
        : lines.length
          ? h('ul', {}, lines.map((l) => h('li', {}, l)))
          : h('p', {}, 'Keine freien Zeiten angegeben'),
    );
    detail.setAttribute('aria-label', scheduled ? `Termin von ${fullName(st)}` : `${fullName(st)} – noch ohne Termin`);
    if (scheduled) mount(detail, head, scheduledDetail(st, p), avail);
    else mount(detail, head, unscheduledDetail(st), avail);
  }

  function scheduledDetail(st, p) {
    const when = h('p', { class: 'sched-detail-when' });
    const status = h('p', { class: 'sched-detail-status' });
    const limitHint = h('p', { class: 'field-hint sched-limit-hint', 'aria-live': 'polite' });
    const durId = `sched-dur-${st.id}`;
    const durInput = h('input', {
      type: 'number',
      id: durId,
      min: String(MIN_DURATION),
      max: String(p.day.end - p.start),
      step: String(SNAP),
      inputmode: 'numeric',
      value: String(p.duration),
      'data-testid': `appointment-duration-${st.id}`,
      oninput: () => {
        const v = Number(durInput.value);
        if (durInput.value === '' || !Number.isFinite(v) || v < MIN_DURATION) return;
        applyDuration(st.id, snap(v));
      },
      onchange: () => {
        const v = Number(durInput.value);
        if (durInput.value !== '' && Number.isFinite(v) && v >= MIN_DURATION) applyDuration(st.id, snap(v));
        const cur = placement(studentById(st.id));
        if (cur && !cur.outside) durInput.value = String(cur.duration);
      },
    });
    const stepBtn = (delta, text, labelText) =>
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-secondary btn-icon sched-step',
          'aria-label': labelText,
          onclick: () => {
            const cur = placement(studentById(st.id));
            if (!cur || cur.outside) return;
            applyDuration(st.id, cur.duration + delta);
            const now = placement(studentById(st.id));
            durInput.value = String(now.duration);
          },
        },
        text,
      );
    const durField = h(
      'div',
      { class: 'field sched-dur-field' },
      h('label', { for: durId }, 'Dauer des Gesprächs'),
      h('div', { class: 'sched-stepper' }, stepBtn(-SNAP, '−', '5 Minuten kürzer'), durInput, stepBtn(SNAP, '+', '5 Minuten länger'), h('span', { class: 'sched-unit' }, 'Minuten')),
      limitHint,
    );

    const moveForm = h('details', { class: 'sched-move' }, h('summary', {}, 'Anderen Tag oder andere Uhrzeit wählen'), placeForm(st, { date: p.date, start: p.start }, 'Verschieben', 'Termin verschieben'));
    detailRefs = { studentId: st.id, when, status, limitHint };
    updateDetailInfo();
    return h(
      'div',
      { class: 'sched-detail-body' },
      when,
      status,
      durField,
      moveForm,
      h('button', { type: 'button', class: 'btn btn-ghost sched-remove-btn', 'data-focus': 'detail-remove', onclick: () => removeAppointment(st.id, { focusChip: true }) }, 'Termin entfernen'),
    );
  }

  function unscheduledDetail(st) {
    if (days.length === 0) {
      return h('div', { class: 'sched-detail-body' }, alertBox('warning', 'Für den Elternsprechtag sind noch keine Tage mit Uhrzeiten eingetragen. ', h('a', { href: '#/lehrkraft/einstellungen' }, 'Zu den Einstellungen')));
    }
    // Schmale Bildschirme: Formular zugeklappt, damit das Blatt unten den Kalender nicht verdeckt
    const wide = window.matchMedia?.('(min-width: 900px)').matches ?? true;
    return h(
      'div',
      { class: 'sched-detail-body' },
      h('p', { class: 'sched-detail-tip' }, 'Tippen Sie jetzt im Kalender auf die gewünschte Anfangsuhrzeit – oder wählen Sie hier Tag und Uhrzeit.'),
      h('details', { class: 'sched-move sched-place-toggle', open: wide }, h('summary', {}, 'Tag und Uhrzeit eingeben'), placeForm(st, suggestSlot(st), 'Eintragen', 'Termin eintragen')),
    );
  }

  /** Formular „Tag + Uhrzeit“ (Alternative zum Ziehen). */
  function placeForm(st, initial, buttonText, legendText) {
    const uid = `${st.id}-${buttonText}`;
    const daySelect = h(
      'select',
      { id: `sched-day-${uid}` },
      days.map((d) => h('option', { value: d.date, selected: d.date === initial?.date }, `${dayShort(d.date)} (${formatRange(d.start, d.end)})`)),
    );
    const timeInput = h('input', { type: 'time', id: `sched-time-${uid}`, step: '300', value: initial ? fromMinutes(initial.start) : fromMinutes(days[0]?.start || 0), required: true });
    const error = h('p', { class: 'field-error', 'aria-live': 'polite' });
    const syncLimits = () => {
      const day = dayMap.get(daySelect.value);
      if (!day) return;
      timeInput.min = fromMinutes(day.start);
      timeInput.max = fromMinutes(Math.max(day.start, day.end - durationFor(st, day)));
    };
    syncLimits();
    daySelect.addEventListener('change', syncLimits);
    return h(
      'form',
      {
        class: 'sched-place-form',
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          const day = dayMap.get(daySelect.value);
          const start = toMinutes(timeInput.value);
          if (!day) return;
          if (Number.isNaN(start)) {
            error.textContent = 'Bitte geben Sie eine Uhrzeit ein.';
            timeInput.setAttribute('aria-invalid', 'true');
            timeInput.focus();
            return;
          }
          const dur = durationFor(studentById(st.id), day);
          if (start < day.start || start + dur > day.end) {
            error.textContent = `Bitte wählen Sie eine Uhrzeit zwischen ${fromMinutes(day.start)} und ${fromMinutes(Math.max(day.start, day.end - dur))} Uhr.`;
            timeInput.setAttribute('aria-invalid', 'true');
            timeInput.focus();
            return;
          }
          place(st.id, day.date, start, dur);
          selectedId = st.id;
          renderAll();
          root.querySelector(`[data-testid="appointment-${st.id}"] .sched-appt-main`)?.focus({ preventScroll: true });
        },
      },
      h('fieldset', {}, h('legend', {}, legendText), h('div', { class: 'sched-place-grid' }, h('div', { class: 'field' }, h('label', { for: daySelect.id }, 'Tag'), daySelect), h('div', { class: 'field' }, h('label', { for: timeInput.id }, 'Beginn'), timeInput)), error, h('button', { type: 'submit', class: 'btn btn-secondary', 'data-focus': `detail-${buttonText}` }, buttonText)),
    );
  }

  /** Vorschlag für das Formular: erster freier Zeitpunkt, zu dem die Eltern Zeit haben. */
  function suggestSlot(st) {
    const busy = (day, start, dur) => itemsOfDay(day).some((it) => it.student !== st && it.start < start + dur && start < it.end);
    for (const day of days) {
      const dur = durationFor(st, day);
      const ranges = st.response ? normalizeRanges(st.response.availability?.[day.date]) : [[day.start, day.end]];
      for (const [s, e] of ranges) {
        for (let t = Math.max(s, day.start); t + dur <= Math.min(e, day.end); t += SNAP) if (!busy(day, t, dur)) return { date: day.date, start: t };
      }
    }
    return days[0] ? { date: days[0].date, start: days[0].start } : null;
  }

  /** Aktualisiert Uhrzeit und Status im Detailfeld, ohne die Eingabefelder neu aufzubauen. */
  function updateDetailInfo() {
    if (!detailRefs) return;
    const st = studentById(detailRefs.studentId);
    const p = placement(st);
    if (!p || p.outside) return;
    const status = statusFor(st, p.date, p.start, p.duration);
    mount(detailRefs.when, h('strong', {}, dayShort(p.date)), h('br'), formatRange(p.start, p.end));
    detailRefs.status.className = `sched-detail-status sched-status-${status}`;
    mount(detailRefs.status, h('span', { class: 'sched-status-dot', 'aria-hidden': 'true' }), STATUS_TEXT[status]);
  }

  /** Neue Dauer (5-Minuten-Schritte, höchstens bis Tagesende) speichern und anzeigen. */
  function applyDuration(studentId, duration) {
    const st = studentById(studentId);
    const p = placement(st);
    if (!p || p.outside) return;
    const max = p.day.end - p.start;
    const dur = Math.max(MIN_DURATION, Math.min(snap(duration), max));
    if (detailRefs?.studentId === studentId) {
      detailRefs.limitHint.textContent = snap(duration) > max ? `Das Gespräch kann höchstens bis ${fromMinutes(p.day.end)} Uhr (Ende des Tages) dauern.` : '';
    }
    if (dur === p.duration) return;
    if (!setAppointment(studentId, { date: p.date, start: fromMinutes(p.start), duration: dur })) return;
    renderCounter();
    renderCalendar();
    renderWarnings();
    updateDetailInfo();
  }

  function onBlockKey(e, studentId) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const st = studentById(studentId);
    const p = placement(st);
    if (!p || p.outside) return;
    const start = clampStart(p.start + (e.key === 'ArrowUp' ? -SNAP : SNAP), p.duration, p.day);
    if (start === p.start) return;
    place(studentId, p.date, start, p.duration);
    selectedId = studentId;
    renderAll();
    root.querySelector(`[data-testid="appointment-${studentId}"] .sched-appt-main`)?.focus({ preventScroll: true });
  }

  function onTrackClick(e, day, track) {
    if (consumeClick(e)) return;
    if (e.target.closest('.sched-appt, .sched-other')) return;
    const st = studentById(selectedId);
    if (!st || st.appointment) {
      if (selectedId) select(null);
      return;
    }
    const dur = durationFor(st, day);
    const start = clampStart(snap(day.start + (e.clientY - track.getBoundingClientRect().top) / PX), dur, day);
    place(st.id, day.date, start, dur);
    // Auswahl aufheben: die Liste rückt wieder nach oben, das nächste Kind kann direkt angetippt werden.
    selectedId = null;
    renderAll();
  }

  // ---------- Ziehen (Pointer-Events) ----------

  /** true, wenn der Klick direkt aus einem Ziehen entsteht und ignoriert werden soll (Tastatur-Klicks nie). */
  function consumeClick(e) {
    if (!suppressClick || e?.detail === 0) return false;
    suppressClick = false;
    return true;
  }

  function onPointerDown(e) {
    suppressClick = false; // neuer Klick/neues Ziehen beginnt
    if (drag || finalizing) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    const handle = target.closest('.sched-appt-resize');
    if (handle) {
      startResize(e, handle.closest('.sched-appt'));
      return;
    }
    if (target.closest('.sched-appt-remove')) return;
    const block = target.closest('.sched-appt[data-student]');
    const source = block || target.closest('.sched-chip');
    if (!source) return;
    const studentId = source.dataset.student;
    const st = studentById(studentId);
    if (!st) return;
    drag = {
      phase: 'pending',
      kind: block ? 'move' : 'chip',
      studentId,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      source,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      grab: block ? Math.max(0, e.clientY - block.getBoundingClientRect().top) : 0,
      target: null,
    };
    // Capture erst beim eigentlichen Ziehen setzen – sonst landet ein einfacher Klick nicht mehr auf dem inneren Knopf.
    addDragListeners();
  }

  function addDragListeners() {
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
  }

  function removeDragListeners() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (drag.phase === 'pending') {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) <= DRAG_THRESHOLD) return;
      beginDrag();
    }
    if (drag.phase === 'drag') {
      e.preventDefault();
      updateDrag();
    } else if (drag.phase === 'resize') {
      e.preventDefault();
      updateResize();
    }
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag;
    if (d.phase === 'pending') {
      finishPointer(false);
      return;
    }
    if (d.phase === 'drag') {
      d.x = e.clientX;
      d.y = e.clientY;
      updateDrag();
      const t = d.target;
      endDragVisuals();
      finishPointer(true);
      if (t?.type === 'day') place(d.studentId, t.day.date, t.start, t.duration);
      if (t?.type === 'pool' && d.kind === 'move') {
        removeAppointment(d.studentId);
        return;
      }
      renderAll();
      return;
    }
    if (d.phase === 'resize') {
      endResizeVisuals();
      finishPointer(true);
      if (d.duration !== d.original) {
        const st = studentById(d.studentId);
        if (setAppointment(d.studentId, { date: d.day.date, start: fromMinutes(d.start), duration: d.duration })) {
          announce(`${fullName(st)}: Dauer ${d.duration} Minuten, ${formatRange(d.start, d.start + d.duration)} – ${STATUS_TEXT[statusFor(st, d.day.date, d.start, d.duration)]}.`);
        }
      }
      renderAll();
      return;
    }
    finishPointer(true); // abgebrochen (Esc) – nachfolgenden Klick ignorieren
  }

  function onPointerCancel(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    cancelDrag();
    finishPointer(false);
  }

  /** Beendet die Zeigerverfolgung. `swallowClick`: den folgenden Klick nicht als Auswahl werten. */
  function finishPointer(swallowClick) {
    const d = drag;
    drag = null;
    removeDragListeners();
    try {
      if (d?.source?.hasPointerCapture?.(d.pointerId)) d.source.releasePointerCapture(d.pointerId);
    } catch {
      /* egal */
    }
    if (swallowClick) {
      suppressClick = true;
      clearTimeout(suppressTimer);
      suppressTimer = setTimeout(() => (suppressClick = false), 600);
    }
  }

  /** Esc oder Abbruch durch den Browser: alles zurücksetzen, nichts speichern. */
  function cancelDrag() {
    if (!drag) return;
    const phase = drag.phase;
    if (phase === 'drag') endDragVisuals();
    if (phase === 'resize') endResizeVisuals();
    drag.phase = 'cancelled';
    if (phase === 'drag' || phase === 'resize') {
      renderCalendar();
      announce(phase === 'drag' ? 'Ziehen abgebrochen.' : 'Ändern der Dauer abgebrochen.');
    }
  }

  function beginDrag() {
    const st = studentById(drag.studentId);
    drag.phase = 'drag';
    drag.ghost = h(
      'div',
      { class: `sched-ghost${st.response ? '' : ' sched-ghost-unknown'}`, 'aria-hidden': 'true' },
      h('span', { class: 'sched-ghost-name' }, `${fullName(st)} ${durationText(st.appointment?.duration || slotMinutes)}`),
      h('span', { class: 'sched-ghost-where' }),
    );
    drag.preview = h('div', { class: 'sched-appt sched-preview', 'aria-hidden': 'true' }, h('span', { class: 'sched-preview-text' }));
    drag.previewKey = '';
    try {
      drag.source.setPointerCapture(drag.pointerId);
    } catch {
      /* ohne Capture funktionieren die Fenster-Listener trotzdem */
    }
    document.body.appendChild(drag.ghost);
    document.body.classList.add('sched-body-dragging');
    page.classList.add('sched-is-dragging');
    if (drag.kind === 'move') {
      drag.source.classList.add('sched-drag-source');
      pool.classList.add('sched-pool-droppable');
    }
    paintBands();
    startAutoScroll();
  }

  function endDragVisuals() {
    const d = drag;
    if (!d) return;
    cancelAnimationFrame(d.raf);
    d.ghost?.remove();
    d.preview?.remove();
    d.source?.classList.remove('sched-drag-source');
    document.body.classList.remove('sched-body-dragging');
    page.classList.remove('sched-is-dragging');
    pool.classList.remove('sched-pool-droppable', 'sched-pool-over');
    for (const { track } of trackRefs.values()) track.classList.remove('sched-track-over');
  }

  /** Ziel unter dem Zeiger: Tagesspalte (mit Beginn) oder Liste „Noch nicht terminiert“. */
  function hitTest(x, y) {
    const sc = scroller.getBoundingClientRect();
    if (x >= sc.left && x <= sc.right) {
      for (const ref of trackRefs.values()) {
        const r = ref.track.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top - EDGE_TOLERANCE && y <= r.bottom + EDGE_TOLERANCE) return { type: 'day', ...ref, rect: r };
      }
    }
    const pr = pool.getBoundingClientRect();
    if (x >= pr.left && x <= pr.right && y >= pr.top && y <= pr.bottom) return { type: 'pool' };
    return null;
  }

  function updateDrag() {
    const d = drag;
    const st = studentById(d.studentId);
    const hit = hitTest(d.x, d.y);
    const offset = d.pointerType === 'touch' ? { x: 18, y: -64 } : { x: 16, y: 18 };
    d.ghost.style.transform = `translate(${Math.round(d.x + offset.x)}px, ${Math.round(d.y + offset.y)}px)`;
    const where = d.ghost.querySelector('.sched-ghost-where');
    for (const { track } of trackRefs.values()) track.classList.toggle('sched-track-over', hit?.type === 'day' && hit.track === track);
    pool.classList.toggle('sched-pool-over', hit?.type === 'pool' && d.kind === 'move');

    if (hit?.type === 'day') {
      const day = hit.day;
      const duration = durationFor(st, day);
      const start = clampStart(snap(day.start + (d.y - d.grab - hit.rect.top) / PX), duration, day);
      const status = statusFor(st, day.date, start, duration);
      d.target = { type: 'day', day, start, duration };
      const pv = d.preview;
      if (pv.parentNode !== hit.track) hit.track.appendChild(pv);
      pv.className = `sched-appt sched-preview sched-appt-${status}`;
      pv.dataset.status = status;
      pv.style.top = `${(start - day.start) * PX}px`;
      pv.style.height = `${duration * PX}px`;
      // Uhrzeit und Name dürfen gekürzt werden, die Dauer nicht
      const key = `${start}|${duration}`;
      if (d.previewKey !== key) {
        d.previewKey = key;
        mount(pv.firstChild, nameWithDuration(fullName(st), duration, `${fromMinutes(start)} · `));
      }
      where.textContent = `${dayTiny(day.date)} · ${formatRange(start, start + duration)} – ${STATUS_TEXT[status]}`;
      d.ghost.dataset.status = status;
    } else {
      d.target = hit?.type === 'pool' && d.kind === 'move' ? { type: 'pool' } : null;
      d.preview.remove();
      where.textContent = d.target ? 'Loslassen, um den Termin zu entfernen' : '';
      delete d.ghost.dataset.status;
    }
  }

  // Automatisches Blättern, wenn der Zeiger beim Ziehen an den Rand kommt
  function startAutoScroll() {
    let lastX = scroller.scrollLeft;
    let lastY = window.scrollY;
    const tick = () => {
      if (!drag || (drag.phase !== 'drag' && drag.phase !== 'resize')) return;
      const header = document.querySelector('.site-header');
      const topEdge = (header ? header.getBoundingClientRect().bottom : 0) + 36;
      const bottomEdge = window.innerHeight - 36;
      let dy = 0;
      if (drag.y < topEdge && window.scrollY > 0) dy = -Math.min(16, 2 + (topEdge - drag.y) / 3);
      else if (drag.y > bottomEdge) dy = Math.min(16, 2 + (drag.y - bottomEdge) / 3);
      let dx = 0;
      if (drag.phase === 'drag' && scroller.scrollWidth > scroller.clientWidth) {
        const r = scroller.getBoundingClientRect();
        if (drag.y >= r.top && drag.y <= r.bottom) {
          if (drag.x < r.left + 36 && drag.x > r.left - 24) dx = -10;
          else if (drag.x > r.right - 36 && drag.x < r.right + 24) dx = 10;
        }
      }
      if (dy) window.scrollBy(0, dy);
      if (dx) scroller.scrollLeft += dx;
      // Auch nach Blättern mit Mausrad/Touchpad die Vorschau an die neue Zielzeit anpassen
      if (window.scrollY !== lastY || scroller.scrollLeft !== lastX) {
        lastY = window.scrollY;
        lastX = scroller.scrollLeft;
        if (drag.phase === 'drag') updateDrag();
        else updateResize();
      }
      drag.raf = requestAnimationFrame(tick);
    };
    drag.raf = requestAnimationFrame(tick);
  }

  // ---------- Dauer über die Unterkante ändern ----------

  function startResize(e, block) {
    const st = studentById(block?.dataset.student);
    const p = placement(st);
    if (!p || p.outside) return;
    e.preventDefault();
    e.stopPropagation();
    const handle = e.target.closest('.sched-appt-resize');
    drag = {
      phase: 'resize',
      studentId: st.id,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      source: handle,
      block,
      day: p.day,
      start: p.start,
      original: p.duration,
      duration: p.duration,
      x: e.clientX,
      y: e.clientY,
    };
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* egal */
    }
    block.classList.add('sched-resizing');
    document.body.classList.add('sched-body-resizing');
    addDragListeners();
    startAutoScroll();
  }

  function updateResize() {
    const d = drag;
    const top = d.block.getBoundingClientRect().top;
    const dur = Math.max(MIN_DURATION, Math.min(snap((d.y - top) / PX), d.day.end - d.start));
    if (dur === d.duration) return;
    d.duration = dur;
    fillBlock(d.block, studentById(d.studentId), d.day.date, d.start, dur);
  }

  function endResizeVisuals() {
    if (!drag) return;
    cancelAnimationFrame(drag.raf);
    drag.block?.classList.remove('sched-resizing');
    document.body.classList.remove('sched-body-resizing');
  }

  // ---------- Tastatur ----------

  function onKeyDown(e) {
    if (e.key !== 'Escape') return;
    if (drag && (drag.phase === 'drag' || drag.phase === 'resize')) {
      e.preventDefault();
      cancelDrag();
      return;
    }
    if (drag?.phase === 'pending') {
      finishPointer(true);
      return;
    }
    if (selectedId && !document.querySelector('.modal-backdrop')) {
      const wasInDetail = detail.contains(document.activeElement);
      const id = selectedId;
      select(null);
      if (wasInDetail) (root.querySelector(`[data-testid="appointment-${id}"] .sched-appt-main`) || root.querySelector(`[data-testid="schedule-student-${id}"]`))?.focus();
    }
  }

  // ---------- Termine festlegen, speichern und drucken ----------

  async function onFinalize() {
    if (finalizing) return;
    mount(messages);
    const count = cls.students.filter((s) => s.appointment).length;
    if (count === 0) {
      mount(messages, alertBox('warning', h('strong', {}, 'Noch keine Termine eingetragen. '), 'Ziehen Sie zuerst mindestens einen Namen in den Kalender. Danach können Sie die Termine festlegen und drucken.'));
      return;
    }
    // Fenster sofort im Klick-Handler öffnen, damit der Popup-Blocker nicht eingreift (kann null sein).
    const w = window.open('', '_blank');
    try {
      if (w) {
        w.document.title = 'ParentsDay – Termine';
        w.document.body.textContent = 'Die PDF-Datei wird erstellt …';
      }
    } catch {
      /* nicht wichtig */
    }
    finalizing = true;
    finalizeBtn.disabled = true;
    mount(finalizeBtn, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'PDF wird erstellt …');
    try {
      const result = await createAppointmentsPdf(getCurrentState() || state, classId);
      const name = savePdf(result.doc, result.filename);
      let printed = false;
      try {
        printed = openPdfForPrint(result.doc, w);
      } catch {
        printed = false;
      }
      if (!printed) w?.close();
      const pages = result.appointmentCount === 1 ? '1 Terminbestätigung' : `${result.appointmentCount} Terminbestätigungen`;
      mount(
        messages,
        alertBox(
          'success',
          h('strong', {}, 'Termine gespeichert. '),
          `Die Datei „${name}“ mit ${pages} und der Übersicht für Sie wurde heruntergeladen.`,
          printed ? ' Zum Drucken wurde sie außerdem in einem neuen Tab geöffnet.' : ' Öffnen Sie die Datei zum Drucken aus Ihrem Download-Ordner.',
        ),
      );
    } catch (err) {
      console.error(err);
      w?.close();
      mount(messages, alertBox('error', h('strong', {}, 'Die PDF-Datei konnte nicht erstellt werden. '), friendlyError(err)));
    } finally {
      finalizing = false;
      finalizeBtn.disabled = false;
      mount(finalizeBtn, FINALIZE_LABEL);
    }
  }

  // ---------- Ereignisse und Aufräumen ----------

  page.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', updateStickyTop);

  return () => {
    if (drag) {
      if (drag.phase === 'drag') endDragVisuals();
      if (drag.phase === 'resize') endResizeVisuals();
      finishPointer(false);
    }
    clearTimeout(suppressTimer);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', updateStickyTop);
    document.body.classList.remove('sched-body-dragging', 'sched-body-resizing');
  };
}
