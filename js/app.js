// Einstiegspunkt: Router (Hash-basiert, funktioniert auf jedem statischen Webspace/GitHub Pages),
// Seitenrahmen für Öffentlichkeit, Lehrkräfte und Eltern.

import { APP_NAME } from './config.js';
import { h, mount, alertBox, confirmDialog, isNetworkError } from './core/ui.js';
import { getSession, getCurrentState, clearSession, onStateChange, isDraftPending, onDraftPendingChange, isPersistentStorage, setReturnTo } from './core/storage.js';
import { saveBackupNow, openLoadBackupDialog } from './components/backup-actions.js';
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
let firstRender = true;

// Ansage des Seitenwechsels für Bildschirmleser (liegt außerhalb von #app und bleibt erhalten).
const announcer = h('div', { class: 'visually-hidden', 'aria-live': 'polite', 'data-testid': 'route-announcer' });
document.body.appendChild(announcer);

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
  // Tolerant: „#/Eltern“, „#/lehrkraft/klasse/5A“ oder ein Schrägstrich am Ende führen zur selben Seite.
  path = path.trim().toLowerCase().replace(/\/+$/, '');
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
  const persistent = isPersistentStorage();
  const savedInfo = h('span', { class: 'save-indicator', 'data-testid': 'save-indicator' });
  let savedAt = state.savedAt;
  const updateSaved = () => {
    const pending = isDraftPending();
    if (!persistent) {
      savedInfo.textContent = 'Achtung: Dieser Browser speichert nichts dauerhaft. Bitte speichern Sie regelmäßig einen Zwischenstand.';
      savedInfo.title = 'Beim Schließen oder Neuladen gehen die Daten sonst verloren (z. B. im privaten Modus).';
    } else if (pending) {
      savedInfo.textContent = `Zuletzt gespeichert: ${formatTimestamp(savedAt)} · Ihre Eingaben auf dieser Seite sind noch nicht gespeichert`;
      savedInfo.title = 'Die Angaben zum Elternsprechtag werden erst mit dem Knopf unten auf dieser Seite gespeichert. Ein Zwischenstand enthält sie trotzdem.';
    } else {
      savedInfo.textContent = `Automatisch gespeichert: ${formatTimestamp(savedAt)}`;
      savedInfo.title = 'Alle Änderungen werden automatisch in diesem Browser gespeichert.';
    }
    savedInfo.classList.toggle('save-indicator-warning', !persistent || pending);
  };
  updateSaved();
  const unsubscribe = onStateChange((s) => {
    savedAt = s.savedAt;
    updateSaved();
  });
  const unsubscribeDraft = onDraftPendingChange(updateSaved);
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
          h('button', { type: 'button', class: 'btn btn-small btn-secondary', onclick: saveBackupNow, 'data-action': 'backup-save' }, 'Zwischenstand speichern'),
          h('button', { type: 'button', class: 'btn btn-small btn-secondary', onclick: () => openLoadBackupDialog({ navigate }), 'data-action': 'backup-load' }, 'Zwischenstand laden'),
          h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: onLogout }, 'Abmelden'),
        ),
      ),
    ),
    h('div', { class: 'container' }, savedInfo),
  );
  header._cleanup = () => {
    unsubscribe();
    unsubscribeDraft();
  };
  return header;
}

function footer() {
  return h(
    'footer',
    { class: 'site-footer' },
    h('div', { class: 'container footer-inner' }, h('span', {}, `${APP_NAME} – Elternsprechtage einfach organisieren`), h('a', { href: '#/datenschutz' }, 'Datenschutz-Hinweise')),
  );
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

// Höhe der klebenden Kopfzeile als CSS-Variable: fokussierte Felder werden nicht von ihr verdeckt
// (scroll-padding-top in base.css).
const headerObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(updateHeaderHeight) : null;
function updateHeaderHeight() {
  const header = app.querySelector('.site-header');
  if (!header) return;
  const sticky = getComputedStyle(header).position === 'sticky';
  document.documentElement.style.setProperty('--header-h', `${sticky ? Math.ceil(header.getBoundingClientRect().height) : 0}px`);
}

/** Seite „Seite nicht gefunden“ (statt stiller Umleitung auf die Startseite). */
function renderNotFound(main, loggedIn) {
  setTitle('Seite nicht gefunden');
  mount(
    main,
    h(
      'div',
      { class: 'card card-narrow stack' },
      h('h1', {}, 'Seite nicht gefunden'),
      h('p', {}, 'Diese Adresse gibt es in ParentsDay nicht. Vielleicht wurde sie falsch abgetippt oder gekürzt.'),
      h(
        'div',
        { class: 'cluster' },
        loggedIn ? h('a', { class: 'btn btn-primary', href: '#/lehrkraft/klassen', 'data-testid': 'notfound-classes' }, 'Zu Ihren Klassen') : null,
        h('a', { class: `btn ${loggedIn ? 'btn-secondary' : 'btn-primary'}`, href: '#/' }, 'Zur Startseite'),
        loggedIn ? null : h('a', { class: 'btn btn-secondary', href: '#/eltern' }, 'Zugang für Eltern'),
      ),
    ),
  );
}

/** Fehler beim Laden einer Seite: verständlicher Text und Knopf zum Neuladen, keine technischen Meldungen. */
function renderLoadError(main, err) {
  const network = isNetworkError(err);
  mount(
    main,
    alertBox(
      'error',
      h(
        'p',
        {},
        h('strong', {}, 'Die Seite konnte nicht geladen werden. '),
        network ? 'Bitte prüfen Sie Ihre Internetverbindung und laden Sie die Seite danach neu.' : 'Bitte laden Sie die Seite neu. Ihre Daten bleiben in diesem Browser gespeichert.',
      ),
      h('p', {}, h('button', { type: 'button', class: 'btn btn-primary', 'data-action': 'reload', onclick: () => location.reload() }, 'Seite neu laden')),
    ),
  );
}

// Seiten desselben Bereichs im Hintergrund vorladen – bricht die Verbindung später ab, lassen sie sich trotzdem öffnen.
const preloaded = new Set();
function preloadViews(layout) {
  if (preloaded.has(layout)) return;
  preloaded.add(layout);
  const run = () => {
    for (const route of ROUTES) if (route.layout === layout) route.load().catch(() => {});
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1000);
}

/** Fokus auf die Überschrift der neuen Seite und Ansage des Titels (nicht beim ersten Aufruf). */
function focusNewPage(main) {
  const active = document.activeElement;
  if (active && active !== document.body && active !== main && active.isConnected) return; // Seite hat den Fokus selbst gesetzt
  const heading = main.querySelector('h1');
  if (heading) {
    if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  } else {
    main.focus({ preventScroll: true });
  }
}

function announce(text) {
  announcer.textContent = '';
  setTimeout(() => (announcer.textContent = text), 60);
}

async function render() {
  const token = ++renderToken;
  const initial = firstRender;
  firstRender = false;
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
  const params = { ...(route?.params || {}) };
  if (route?.classRoute) {
    const m = route.path.exec(path);
    params.classId = `${m[1]}${m[2]}`;
  }

  let state = null;
  if (route?.layout === 'teacher') {
    state = getSession() ? getCurrentState() : null;
    if (!state) {
      // Nach der Anmeldung geht es auf der gewünschten Seite weiter.
      setReturnTo(path);
      navigate('/lehrkraft/anmelden', { replace: true });
      return;
    }
  }
  const notFoundState = route ? null : getSession() ? getCurrentState() : null;
  const layout = route ? route.layout : notFoundState ? 'teacher' : 'public';

  const main = h('main', { id: 'main', class: 'container main', tabindex: '-1' });
  const header = layout === 'teacher' ? teacherHeader(state || notFoundState) : layout === 'parent' ? parentHeader() : publicHeader();
  mount(app, h('a', { class: 'skip-link', href: '#main', onclick: (e) => (e.preventDefault(), main.focus()) }, 'Zum Inhalt springen'), header, main, footer());
  headerObserver?.disconnect();
  headerObserver?.observe(header);
  updateHeaderHeight();
  setTitle('');
  window.scrollTo(0, 0);

  if (!route) {
    renderNotFound(main, Boolean(notFoundState));
    if (!initial) focusNewPage(main);
    announce(document.title);
    return;
  }

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
    preloadViews(route.layout);
    if (!initial) {
      focusNewPage(main);
      announce(document.title);
    }
  } catch (err) {
    console.error(err);
    if (token !== renderToken) return;
    renderLoadError(main, err);
  }
}

window.addEventListener('hashchange', render);
render();
