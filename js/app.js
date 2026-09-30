// Einstiegspunkt: Router (Hash-basiert, funktioniert auf jedem statischen Webspace/GitHub Pages),
// Seitenrahmen für Öffentlichkeit, Lehrkräfte und Eltern.

import { APP_NAME } from './config.js';
import { h, mount, toast, modal, fileDropZone, confirmDialog, alertBox } from './core/ui.js';
import { getSession, getCurrentState, clearSession, replaceState, onStateChange } from './core/storage.js';
import { downloadBackup, readBackupFile } from './core/backup.js';
import { formatTimestamp } from './core/time.js';

/**
 * Routen. Jede View ist ein ES-Modul mit
 *   export default async function render(ctx) { … return optionaleAufräumFunktion; }
 * ctx = { root, params, query, navigate, state, rerender, setTitle }
 */
const ROUTES = [
  { path: /^\/$/, load: () => import('./views/start.js'), layout: 'public' },
  { path: /^\/datenschutz$/, load: () => import('./views/privacy.js'), layout: 'public' },
  { path: /^\/lehrkraft$/, load: () => import('./views/teacher-auth.js'), layout: 'public', params: { mode: 'choose' } },
  { path: /^\/lehrkraft\/registrieren$/, load: () => import('./views/teacher-auth.js'), layout: 'public', params: { mode: 'register' } },
  { path: /^\/lehrkraft\/anmelden$/, load: () => import('./views/teacher-auth.js'), layout: 'public', params: { mode: 'login' } },
  { path: /^\/lehrkraft\/elternsprechtag$/, load: () => import('./views/teacher-event.js'), layout: 'teacher', params: { mode: 'create' } },
  { path: /^\/lehrkraft\/einstellungen$/, load: () => import('./views/teacher-event.js'), layout: 'teacher', params: { mode: 'settings' } },
  { path: /^\/lehrkraft\/klassen$/, load: () => import('./views/teacher-classes.js'), layout: 'teacher' },
  { path: /^\/lehrkraft\/klasse\/(1[0-3]|[1-9])([a-h])$/, load: () => import('./views/teacher-class.js'), layout: 'teacher', classRoute: true },
  { path: /^\/lehrkraft\/klasse\/(1[0-3]|[1-9])([a-h])\/terminieren$/, load: () => import('./views/teacher-schedule.js'), layout: 'teacher', classRoute: true },
  { path: /^\/eltern$/, load: () => import('./views/parent.js'), layout: 'parent', params: { step: 'login' } },
  { path: /^\/eltern\/zeiten$/, load: () => import('./views/parent.js'), layout: 'parent', params: { step: 'times' } },
  { path: /^\/eltern\/fertig$/, load: () => import('./views/parent.js'), layout: 'parent', params: { step: 'done' } },
];

const app = document.getElementById('app');
let cleanup = null;
let renderToken = 0;

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const q = raw.indexOf('?');
  const pathPart = q >= 0 ? raw.slice(0, q) : raw;
  const queryString = q >= 0 ? raw.slice(q + 1) : '';
  let path;
  try {
    path = decodeURIComponent(pathPart);
  } catch {
    path = pathPart;
  }
  return { path: path || '/', query: new URLSearchParams(queryString) };
}

/** Navigiert zu einer Route, z. B. navigate('/lehrkraft/klassen'). */
export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (location.hash === target) {
    render();
    return;
  }
  if (replace) {
    history.replaceState(null, '', target);
    render();
  } else {
    location.hash = target;
  }
}

function logo(href) {
  return h('a', { class: 'logo', href, 'aria-label': `${APP_NAME} – Startseite` }, h('span', { class: 'logo-mark', 'aria-hidden': 'true' }, 'P'), h('span', { class: 'logo-text' }, 'Parents', h('span', { class: 'logo-accent' }, 'Day')));
}

function publicHeader() {
  return h(
    'header',
    { class: 'site-header' },
    h('div', { class: 'container header-inner' }, logo('#/'), h('nav', { class: 'header-nav', 'aria-label': 'Hauptnavigation' }, h('a', { href: '#/lehrkraft' }, 'Zugang für Lehrkräfte'), h('a', { href: '#/eltern' }, 'Zugang für Eltern'))),
  );
}

function parentHeader() {
  return h('header', { class: 'site-header' }, h('div', { class: 'container header-inner' }, logo('#/'), h('span', { class: 'header-badge' }, 'Elternzugang')));
}

function teacherHeader(state) {
  const t = state.teacher;
  const savedInfo = h('span', { class: 'save-indicator', title: 'Alle Änderungen werden automatisch in diesem Browser gespeichert.' }, `Automatisch gespeichert: ${formatTimestamp(state.savedAt)}`);
  const unsubscribe = onStateChange((s) => {
    savedInfo.textContent = `Automatisch gespeichert: ${formatTimestamp(s.savedAt)}`;
  });
  const header = h(
    'header',
    { class: 'site-header teacher-header' },
    h(
      'div',
      { class: 'container header-inner' },
      logo('#/lehrkraft/klassen'),
      h(
        'nav',
        { class: 'header-nav', 'aria-label': 'Lehrkräfte-Navigation' },
        state.event ? h('a', { href: '#/lehrkraft/klassen' }, 'Klassen') : h('a', { href: '#/lehrkraft/elternsprechtag' }, 'Elternsprechtag erstellen'),
        state.event ? h('a', { href: '#/lehrkraft/einstellungen' }, 'Weitere Einstellungen') : null,
      ),
      h(
        'div',
        { class: 'header-user' },
        h('div', { class: 'header-user-name' }, `${t.firstName} ${t.lastName}`, h('span', { class: 'header-user-code', title: 'Ihr Lehrkräftecode' }, t.teacherCode)),
        h(
          'div',
          { class: 'header-actions' },
          h('button', { type: 'button', class: 'btn btn-small btn-secondary', onclick: onSaveBackup, 'data-action': 'backup-save' }, 'Zwischenstand speichern'),
          h('button', { type: 'button', class: 'btn btn-small btn-secondary', onclick: onLoadBackup, 'data-action': 'backup-load' }, 'Zwischenstand laden'),
          h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: onLogout }, 'Abmelden'),
        ),
      ),
    ),
    h('div', { class: 'container' }, savedInfo),
  );
  header._cleanup = unsubscribe;
  return header;
}

function footer() {
  return h(
    'footer',
    { class: 'site-footer' },
    h('div', { class: 'container footer-inner' }, h('span', {}, `${APP_NAME} – Elternsprechtage einfach organisieren`), h('a', { href: '#/datenschutz' }, 'Datenschutz-Hinweise')),
  );
}

function onSaveBackup() {
  const state = getCurrentState();
  if (!state) return;
  const name = downloadBackup(state);
  toast(`Zwischenstand gespeichert: „${name}“`, 'success');
}

function onLoadBackup() {
  const state = getCurrentState();
  if (!state) return;
  const status = h('div', {});
  const dlg = modal({
    title: 'Zwischenstand laden',
    content: [
      h('p', {}, 'Laden Sie eine Datei „Zwischenspeicher vom … für ParentsDay“ hoch. Der aktuelle Stand in diesem Browser wird dadurch ersetzt.'),
      fileDropZone({
        accept: '.json,application/json',
        label: 'Zwischenspeicher-Datei auswählen oder hierher ziehen',
        onFiles: async ([file]) => {
          try {
            const loaded = await readBackupFile(file, state.teacher.teacherCode);
            const ok = await confirmDialog({
              title: 'Stand ersetzen?',
              message: `Der Zwischenstand vom ${formatTimestamp(loaded.savedAt)} ersetzt alle aktuellen Daten in diesem Browser.`,
              confirmText: 'Ja, laden',
            });
            if (!ok) return;
            replaceState(loaded);
            dlg.close();
            toast('Zwischenstand geladen.', 'success');
            render();
          } catch (err) {
            mount(status, alertBox('error', err.message));
          }
        },
      }),
      status,
    ],
    actions: [{ label: 'Schließen', variant: 'secondary' }],
  });
}

async function onLogout() {
  const ok = await confirmDialog({
    title: 'Abmelden?',
    message: 'Ihre Daten bleiben in diesem Browser gespeichert. Tipp: Speichern Sie vorher einen Zwischenstand, wenn Sie an einem anderen Gerät weiterarbeiten möchten.',
    confirmText: 'Abmelden',
  });
  if (!ok) return;
  clearSession();
  navigate('/');
}

function setTitle(title) {
  document.title = title ? `${title} – ${APP_NAME}` : `${APP_NAME} – Elternsprechtag`;
}

async function render() {
  const token = ++renderToken;
  if (typeof cleanup === 'function') {
    try {
      cleanup();
    } catch (err) {
      console.error(err);
    }
  }
  cleanup = null;
  for (const el of app.querySelectorAll('.site-header')) el._cleanup?.();

  const { path, query } = parseHash();
  const route = ROUTES.find((r) => r.path.test(path));
  if (!route) {
    navigate('/', { replace: true });
    return;
  }
  const params = { ...(route.params || {}) };
  if (route.classRoute) {
    const m = route.path.exec(path);
    params.classId = `${m[1]}${m[2]}`;
  }

  let state = null;
  if (route.layout === 'teacher') {
    state = getSession() ? getCurrentState() : null;
    if (!state) {
      navigate('/lehrkraft/anmelden', { replace: true });
      return;
    }
  }

  const main = h('main', { id: 'main', class: 'container main', tabindex: '-1' });
  const header = route.layout === 'teacher' ? teacherHeader(state) : route.layout === 'parent' ? parentHeader() : publicHeader();
  mount(app, h('a', { class: 'skip-link', href: '#main', onclick: (e) => (e.preventDefault(), main.focus()) }, 'Zum Inhalt springen'), header, main, footer());
  setTitle('');
  window.scrollTo(0, 0);

  try {
    const mod = await route.load();
    if (token !== renderToken) return;
    const result = await mod.default({
      root: main,
      params,
      query,
      state,
      navigate,
      rerender: render,
      setTitle,
    });
    if (token !== renderToken) {
      if (typeof result === 'function') result();
      return;
    }
    cleanup = typeof result === 'function' ? result : null;
  } catch (err) {
    console.error(err);
    mount(main, alertBox('error', h('strong', {}, 'Die Seite konnte nicht geladen werden. '), err.message || String(err)));
  }
}

window.addEventListener('hashchange', render);
render();
