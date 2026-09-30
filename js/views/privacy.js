// Datenschutz-Hinweise: beschreibt, wie ParentsDay mit Daten umgeht.

import { h, mount } from '../core/ui.js';

export default function render({ root, setTitle }) {
  setTitle('Datenschutz-Hinweise');
  mount(
    root,
    h(
      'article',
      { class: 'card card-narrow stack' },
      h('h1', {}, 'Datenschutz-Hinweise'),
      h('p', {}, 'ParentsDay ist eine reine Browser-Anwendung. Es gibt keinen Server, der Namen, Codes oder Termine speichert oder auswertet.'),
      h('h2', {}, 'Lehrkräfte'),
      h(
        'ul',
        {},
        h('li', {}, 'Registrierungsdaten, Klassen, Namen der Lernenden, Rückmeldungen und Termine werden nur im Speicher dieses Browsers (localStorage) abgelegt.'),
        h('li', {}, 'Mit „Zwischenstand speichern“ erhalten Sie eine Datei mit allen Daten. Bewahren Sie sie sicher auf – sie enthält personenbezogene Daten.'),
        h('li', {}, 'Auf gemeinsam genutzten Geräten sollten Sie sich nach der Arbeit abmelden und die Browserdaten löschen.'),
      ),
      h('h2', {}, 'Eltern'),
      h(
        'ul',
        {},
        h('li', {}, 'Die Termindaten des Elternsprechtags stehen im Link bzw. QR-Code des Elternbriefs. Dieser Teil des Links wird nicht an den Webserver übertragen.'),
        h('li', {}, 'Ihre Anmeldung und Ihre ausgewählten Zeiten werden nur in Ihrem Browser gespeichert.'),
        h('li', {}, 'Die Rückmeldung an die Lehrkraft erfolgt ausschließlich über die PDF-Datei, die Sie selbst per E-Mail versenden.'),
      ),
      h('h2', {}, 'Technik'),
      h('p', {}, 'Alle Programmbibliotheken und Schriften werden direkt von dieser Seite geladen, nicht von fremden Servern. Es werden keine Cookies und keine Analyse-Werkzeuge verwendet.'),
      h('p', {}, h('a', { href: '#/' }, 'Zur Startseite')),
    ),
  );
}
