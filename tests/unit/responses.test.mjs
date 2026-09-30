// Unit-Tests: Rückmeldungen der Eltern einlesen und übernehmen (core/responses.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyResponses, readResponsesFromFiles, findResponsesInMailText, UP_TO_DATE_REASONS } from '../../js/core/responses.js';
import { buildResponsePayload, encodeResponseText, pdfPayloadString } from '../../js/core/transport.js';
import { studentCode } from '../../js/core/codes.js';

const T_CODE = 'A16595316960M';

function student(grade, letter, firstName, lastName, extra = {}) {
  return { id: `${grade}${letter}-${firstName}`, firstName, lastName, code: studentCode(grade, letter, T_CODE, firstName, lastName), response: null, appointment: null, ...extra };
}

function makeState() {
  return {
    app: 'ParentsDay',
    type: 'teacher-state',
    version: 1,
    teacher: { firstName: 'Anna', lastName: 'Meier', birthDate: '1990-03-15', email: 'anna.meier@schule.de', teacherCode: T_CODE },
    event: { schoolAddress: 'Schule', slotMinutes: 10, days: [{ date: '2026-11-12', start: '14:00', end: '18:00' }] },
    classes: [
      { id: '5a', grade: 5, letter: 'a', codesGenerated: true, students: [student(5, 'a', 'Anna', 'Beck'), student(5, 'a', 'Ben', 'Cem'), student(5, 'a', 'Clara', 'Dorn')] },
      { id: '6b', grade: 6, letter: 'b', codesGenerated: true, students: [student(6, 'b', 'Emil', 'Faber')] },
    ],
  };
}

function response(firstName, lastName, classId, { submittedAt = '2026-10-01T10:00:00.000Z', availability, teacherCode = T_CODE, code } = {}) {
  const grade = Number(classId.slice(0, -1));
  const letter = classId.slice(-1);
  return buildResponsePayload({
    code: code ?? studentCode(grade, letter, teacherCode, firstName, lastName),
    firstName,
    lastName,
    classId,
    teacherCode,
    slotMinutes: 10,
    submittedAt,
    availability: availability ?? { '2026-11-12': [['14:00', '15:00'], ['16:30', '17:00']] },
  });
}

const findStudent = (state, classId, firstName) => state.classes.find((c) => c.id === classId).students.find((s) => s.firstName === firstName);

test('Rückmeldung wird dem Kind mit passendem Code zugeordnet', () => {
  const state = makeState();
  const report = applyResponses(state, [response('Anna', 'Beck', '5a')], { classId: '5a' });
  assert.equal(report.skipped.length, 0);
  assert.deepEqual(report.applied, [{ classId: '5a', studentId: '5a-Anna', name: 'Anna Beck', replaced: false, otherClass: false }]);
  assert.deepEqual(findStudent(state, '5a', 'Anna').response, {
    submittedAt: '2026-10-01T10:00:00.000Z',
    availability: { '2026-11-12': [['14:00', '15:00'], ['16:30', '17:00']] },
  });
  assert.equal(findStudent(state, '5a', 'Ben').response, null);
});

test('Code ohne Beachtung von Groß-/Kleinschreibung und Leerzeichen', () => {
  const state = makeState();
  const code = studentCode(5, 'a', T_CODE, 'Ben', 'Cem').toUpperCase().replace(/(.{4})/g, '$1 ');
  const report = applyResponses(state, [response('Ben', 'Cem', '5a', { code })]);
  assert.equal(report.applied.length, 1);
  assert.equal(report.applied[0].name, 'Ben Cem');
  assert.ok(findStudent(state, '5a', 'Ben').response);
});

test('Übersprungene Rückmeldungen mit verständlichem Grund', () => {
  const state = makeState();
  const report = applyResponses(state, [
    response('Anna', 'Beck', '5a', { code: 'kein-code' }),
    response('Anna', 'Beck', '5a', { teacherCode: 'B12345678X' }),
    response('Max', 'Muster', '7b'),
    response('Zoe', 'Zander', '5a'),
  ]);
  assert.equal(report.applied.length, 0);
  assert.deepEqual(report.skipped, [
    { name: 'Anna Beck', classId: '5a', reason: 'Ungültiger Code' },
    { name: 'Anna Beck', classId: '5a', reason: 'Gehört zu einer anderen Lehrkraft' },
    { name: 'Max Muster', classId: '7b', reason: 'Klasse 7b ist nicht angelegt' },
    { name: 'Zoe Zander', classId: '5a', reason: 'Kein Kind mit diesem Code in Klasse 5a' },
  ]);
  assert.ok(state.classes.every((c) => c.students.every((s) => s.response === null)), 'Zustand darf nicht verändert werden');
});

test('Ungültige Daten werden übersprungen, ohne zu werfen', () => {
  const state = makeState();
  const report = applyResponses(state, [null, { app: 'ParentsDay', type: 'teacher-registration', firstName: 'X' }]);
  assert.equal(report.applied.length, 0);
  assert.equal(report.skipped.length, 2);
  assert.ok(report.skipped.every((s) => s.reason === 'Keine gültige Rückmeldung'));
  assert.deepEqual(applyResponses(state, undefined), { applied: [], skipped: [] });
});

test('Neuere Rückmeldung ersetzt ältere, ältere wird nicht übernommen', () => {
  const state = makeState();
  applyResponses(state, [response('Anna', 'Beck', '5a', { submittedAt: '2026-10-02T08:00:00.000Z' })]);

  // Ältere Datei nachträglich hochgeladen
  let report = applyResponses(state, [response('Anna', 'Beck', '5a', { submittedAt: '2026-10-01T08:00:00.000Z', availability: { '2026-11-12': [['17:00', '18:00']] } })]);
  assert.deepEqual(report.skipped, [{ name: 'Anna Beck', classId: '5a', reason: 'Neuere Rückmeldung bereits vorhanden' }]);
  assert.equal(findStudent(state, '5a', 'Anna').response.submittedAt, '2026-10-02T08:00:00.000Z');

  // Dieselbe Datei noch einmal
  report = applyResponses(state, [response('Anna', 'Beck', '5a', { submittedAt: '2026-10-02T08:00:00.000Z' })]);
  assert.deepEqual(report.skipped, [{ name: 'Anna Beck', classId: '5a', reason: 'Bereits übernommen' }]);
  assert.ok(report.skipped.every((s) => UP_TO_DATE_REASONS.includes(s.reason)));

  // Neuere Rückmeldung ersetzt die vorhandene
  report = applyResponses(state, [response('Anna', 'Beck', '5a', { submittedAt: '2026-10-03T08:00:00.000Z', availability: { '2026-11-12': [['15:00', '16:00']] } })]);
  assert.equal(report.applied.length, 1);
  assert.equal(report.applied[0].replaced, true);
  assert.deepEqual(findStudent(state, '5a', 'Anna').response.availability, { '2026-11-12': [['15:00', '16:00']] });
});

test('Mehrere Rückmeldungen desselben Kindes in einem Upload: die neueste gewinnt', () => {
  const state = makeState();
  const newest = response('Clara', 'Dorn', '5a', { submittedAt: '2026-10-05T12:00:00.000Z', availability: { '2026-11-12': [['17:00', '18:00']] } });
  const report = applyResponses(state, [
    response('Clara', 'Dorn', '5a', { submittedAt: '2026-10-04T12:00:00.000Z' }),
    newest,
    response('Clara', 'Dorn', '5a', { submittedAt: '2026-10-01T12:00:00.000Z' }),
  ]);
  assert.equal(report.applied.length, 1, 'jedes Kind höchstens einmal als übernommen melden');
  assert.equal(report.applied[0].replaced, false);
  assert.equal(report.skipped.length, 2);
  assert.ok(report.skipped.every((s) => s.reason === 'Neuere Rückmeldung bereits vorhanden'));
  assert.deepEqual(findStudent(state, '5a', 'Clara').response, { submittedAt: newest.submittedAt, availability: newest.availability });
});

test('Rückmeldungen anderer Klassen werden übernommen und markiert, Bericht in Tabellen-Reihenfolge', () => {
  const state = makeState();
  const report = applyResponses(
    state,
    [response('Emil', 'Faber', '6b'), response('Clara', 'Dorn', '5a', { submittedAt: '2026-10-09T10:00:00.000Z' }), response('Anna', 'Beck', '5a')],
    { classId: '5a' },
  );
  assert.deepEqual(
    report.applied.map((a) => [a.name, a.classId, a.otherClass]),
    [
      ['Anna Beck', '5a', false],
      ['Clara Dorn', '5a', false],
      ['Emil Faber', '6b', true],
    ],
  );
  assert.ok(findStudent(state, '6b', 'Emil').response);
  // Ohne classId gibt es keine „andere Klasse“
  const state2 = makeState();
  assert.equal(applyResponses(state2, [response('Emil', 'Faber', '6b')]).applied[0].otherClass, false);
});

test('Rückmeldung wird nicht einem Kind ohne Code zugeordnet', () => {
  const state = makeState();
  state.classes[0].students.push({ id: 'neu', firstName: 'Dora', lastName: 'Ebel', code: '', response: null, appointment: null });
  const report = applyResponses(state, [response('Dora', 'Ebel', '5a')]);
  assert.deepEqual(report.skipped, [{ name: 'Dora Ebel', classId: '5a', reason: 'Kein Kind mit diesem Code in Klasse 5a' }]);
});

test('E-Mail-Text: Block wird auch zitiert, umbrochen, als Quoted-Printable oder HTML gefunden', () => {
  const p1 = response('Anna', 'Beck', '5a');
  const p2 = response('Ben', 'Cem', '5a');
  const block1 = encodeResponseText(p1);
  const block2 = encodeResponseText(p2);
  const wrapped = block1.match(/.{1,60}/g).join('\n> ');
  const qp = block2.match(/.{1,70}/g).join('=\r\n');
  const text = `Hallo Frau Meier,\n> ${wrapped}\n\nViele Grüße\n${qp}\n<p>${block1.slice(0, 30)}<br>${block1.slice(30)}</p>`;
  const found = findResponsesInMailText(text);
  assert.deepEqual(
    found.map((p) => p.firstName).sort(),
    ['Anna', 'Ben'],
  );
  assert.deepEqual(findResponsesInMailText('Kein Block hier. PARENTSDAY[kaputt]'), []);
});

test('Dateien: Textdatei, gespeicherte E-Mail mit PDF-Anhang und Fehler', async () => {
  const p1 = response('Anna', 'Beck', '5a');
  const p2 = response('Ben', 'Cem', '5a');
  const p3 = response('Clara', 'Dorn', '5a');
  const fakePdf = `%PDF-1.3\n1 0 obj << /Subject (${pdfPayloadString(p2)}) >> endobj\n%%EOF\n`;
  const eml = [
    'From: eltern@example.org',
    'Subject: Rückmeldung',
    'Content-Type: multipart/mixed; boundary="XYZ"',
    '',
    '--XYZ',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    ...Buffer.from(`Hallo!\n${encodeResponseText(p3)}\n`).toString('base64').match(/.{1,76}/g),
    '--XYZ',
    'Content-Type: application/pdf; name="Rueckmeldung.pdf"',
    'Content-Disposition: attachment; filename="Rueckmeldung.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    ...Buffer.from(fakePdf, 'latin1').toString('base64').match(/.{1,76}/g),
    '--XYZ--',
    '',
  ].join('\r\n');
  const registration = `%PDF-1.3\n1 0 obj << /Subject (${pdfPayloadString({ app: 'ParentsDay', type: 'teacher-registration', v: 1 })}) >> endobj\n`;
  const files = [
    new File([`Text\n${encodeResponseText(p1)}\n`], 'mail.txt', { type: 'text/plain' }),
    new File([eml], 'Rückmeldung.eml', { type: 'message/rfc822' }),
    new File([fakePdf], 'doppelt.pdf', { type: 'application/pdf' }),
    new File(['%PDF-1.3\nnichts\n'], 'leer.pdf', { type: 'application/pdf' }),
    new File([registration], 'Registrierung.pdf', { type: 'application/pdf' }),
    new File(['Hallo'], 'notiz.txt', { type: 'text/plain' }),
  ];
  const { payloads, errors } = await readResponsesFromFiles(files);
  assert.deepEqual(payloads.map((p) => p.firstName), ['Anna', 'Clara', 'Ben']);
  assert.deepEqual(errors, [
    { fileName: 'leer.pdf', message: 'Keine ParentsDay-Rückmeldung gefunden.' },
    { fileName: 'Registrierung.pdf', message: 'Das ist Ihre Registrierungs-PDF, keine Rückmeldung der Eltern.' },
    { fileName: 'notiz.txt', message: 'Keine ParentsDay-Rückmeldung gefunden.' },
  ]);
  // Wirft nie – auch nicht bei unbrauchbaren Eingaben
  assert.deepEqual(await readResponsesFromFiles(null), { payloads: [], errors: [] });
  const broken = await readResponsesFromFiles([{ name: 'kaputt.pdf', arrayBuffer: () => Promise.reject(new Error('x')) }]);
  assert.deepEqual(broken.errors, [{ fileName: 'kaputt.pdf', message: 'Die Datei konnte nicht gelesen werden.' }]);
});

test('Andere Dateiformate (z. B. aus Outlook gezogene .msg-Mail): eingebettete PDF und UTF-16-Text werden erkannt', async () => {
  const p1 = response('Anna', 'Beck', '5a');
  const p2 = response('Ben', 'Cem', '5a');
  // Binärer Container mit unverändert eingebetteter Rückmelde-PDF (wie ein Anhang in einer .msg-Datei)
  const pdf = Buffer.from(`%PDF-1.3\n1 0 obj << /Subject (${pdfPayloadString(p1)}) >> endobj\n%%EOF\n`, 'latin1');
  const container = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0xff, 0xfe]), pdf, Buffer.alloc(64)]);
  // E-Mail-Text als UTF-16 (so speichert Outlook den Text einer .msg-Datei)
  const utf16 = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]), Buffer.from(`Guten Tag,\r\nhier unsere Zeiten.\r\n${encodeResponseText(p2)}\r\n`, 'utf16le')]);
  const files = [
    new File([container], 'Rückmeldung Anna.msg', { type: 'application/vnd.ms-outlook' }),
    new File([utf16], 'Rückmeldung Ben.msg', { type: '' }),
    new File([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3])], 'leer.msg', { type: '' }),
  ];
  const { payloads, errors } = await readResponsesFromFiles(files);
  assert.deepEqual(payloads.map((p) => p.firstName), ['Anna', 'Ben']);
  assert.deepEqual(errors, [{ fileName: 'leer.msg', message: 'Keine ParentsDay-Rückmeldung gefunden.' }]);
});

test('Zu große Dateien werden nicht eingelesen', async () => {
  const huge = { name: 'Urlaub.mp4', size: 300 * 1024 * 1024, arrayBuffer: () => Promise.reject(new Error('darf nicht gelesen werden')) };
  const { payloads, errors } = await readResponsesFromFiles([huge, new File([`${encodeResponseText(response('Anna', 'Beck', '5a'))}`], 'mail.txt')]);
  assert.equal(payloads.length, 1);
  assert.deepEqual(errors, [{ fileName: 'Urlaub.mp4', message: 'Die Datei ist zu groß – das ist keine Rückmelde-PDF.' }]);
});

test('Abgetippte Anfangsbuchstaben (L statt Ł, l statt I) werden trotzdem zugeordnet', async () => {
  const { teacherCode } = await import('../../js/core/codes.js');
  const tc = teacherCode('Łukasz', 'Żak', '1987-06-24');
  const state = makeState();
  state.teacher = { ...state.teacher, firstName: 'Łukasz', lastName: 'Żak', teacherCode: tc };
  state.classes[0].students = [{ ...student(5, 'a', 'Anna', 'Beck'), code: studentCode(5, 'a', tc, 'Anna', 'Beck') }];
  const typed = studentCode(5, 'a', tc.replace('Ł', 'L').replace('Ż', 'Z'), 'Anna', 'Beck');
  const { applied, skipped } = applyResponses(state, [response('Anna', 'Beck', '5a', { code: typed, teacherCode: tc.replace('Ł', 'L').replace('Ż', 'Z') })]);
  assert.deepEqual(skipped, []);
  assert.equal(applied.length, 1);
  assert.ok(state.classes[0].students[0].response);
});
