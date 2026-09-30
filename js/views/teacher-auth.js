// PLATZHALTER – wird durch die eigentliche Implementierung ersetzt.
import { h, mount } from '../core/ui.js';

export default function render({ root, setTitle }) {
  setTitle('In Arbeit');
  mount(root, h('div', { class: 'card' }, h('h1', {}, 'Diese Seite (teacher-auth) ist noch in Arbeit.')));
}
