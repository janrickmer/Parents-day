// Startseite mit den beiden Zugängen. Mit digitalem Briefkasten (MAILBOX_URL) beschreiben Schritte
// und Datenschutz-Zeile den Weg über den Briefkasten statt über die PDF-Datei per E-Mail.

import { h, mount } from '../core/ui.js';
import { mailboxEnabled } from '../core/mailbox.js';

export default function render({ root, setTitle }) {
  setTitle('Startseite');
  const withMailbox = mailboxEnabled();
  const step = (num, title, text) => h('li', { class: 'start-step' }, h('span', { class: 'start-step-num', 'aria-hidden': 'true' }, num), h('div', {}, h('strong', {}, title), h('p', { class: 'muted' }, text)));

  mount(
    root,
    h(
      'section',
      { class: 'start-hero' },
      h('h1', { class: 'start-title' }, 'Parents', h('span', { class: 'logo-accent' }, 'Day')),
      h('p', { class: 'start-lead' }, 'Termine für den Elternsprechtag einfach abstimmen – Lehrkräfte planen, Eltern geben ihre freien Zeiten an.'),
      h(
        'div',
        { class: 'start-actions' },
        h('a', { class: 'btn btn-primary btn-large', href: '#/lehrkraft', 'data-testid': 'start-teacher' }, 'Zugang für Lehrkräfte'),
        h('a', { class: 'btn btn-secondary btn-large', href: '#/eltern', 'data-testid': 'start-parent' }, 'Zugang für Eltern'),
      ),
    ),
    h(
      'section',
      { class: 'grid-2 start-how' },
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'Für Lehrkräfte'),
        h(
          'ol',
          { class: 'start-steps' },
          step('1', 'Registrieren oder anmelden', 'Sie erhalten eine PDF-Datei mit Ihrem Registrierungscode.'),
          step('2', 'Elternsprechtag anlegen', 'Tage, Uhrzeiten, Adresse der Schule und Terminlänge festlegen.'),
          step('3', 'Klassen und Lernende eintragen', 'Für jedes Kind entsteht ein Code und ein fertiger Elternbrief.'),
          withMailbox
            ? step('4', 'Gespräche terminieren', 'Die Rückmeldungen der Eltern kommen automatisch an. Termine per Drag & Drop planen.')
            : step('4', 'Gespräche terminieren', 'Rückmeldungen der Eltern hochladen und Termine per Drag & Drop planen.'),
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('h2', {}, 'Für Eltern'),
        h(
          'ol',
          { class: 'start-steps' },
          step('1', 'QR-Code scannen', 'Der QR-Code steht im Elternbrief. Alternativ oben auf „Zugang für Eltern“ klicken.'),
          step('2', 'Anmelden', 'Mit Vorname, Nachname und Code Ihres Kindes aus dem gelben Kasten.'),
          step('3', 'Freie Zeiten markieren', 'Alle Zeiten grün markieren, zu denen Sie Zeit für ein Gespräch hätten.'),
          withMailbox
            ? step('4', 'Absenden – fertig', 'Ihre Angaben kommen automatisch bei der Lehrkraft an.')
            : step('4', 'Absenden', 'Die erzeugte PDF-Datei per E-Mail an die Lehrkraft schicken.'),
        ),
      ),
    ),
    h(
      'p',
      { class: 'muted small start-privacy', 'data-testid': 'start-privacy' },
      withMailbox
        ? 'ParentsDay speichert Ihre Daten in Ihrem Browser. Die Rückmeldungen der Eltern gehen Ende-zu-Ende-verschlüsselt über den digitalen Briefkasten – lesen kann sie nur die Lehrkraft. '
        : 'ParentsDay speichert keine Daten auf einem Server. Alles bleibt in Ihrem Browser und in den Dateien, die Sie selbst herunterladen. ',
      h('a', { href: '#/datenschutz' }, 'Mehr zum Datenschutz'),
    ),
  );
}
