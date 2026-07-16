// js/ui.js — view switching, bottom sheet, name/meta modal, onboarding form,
// responsive helper, service worker registration. Pure DOM mechanics: this
// module renders no road/weather data itself — app.js hands it HTML strings
// or containers to fill. Ported: bottom sheet drag logic from v1 L2343-2401.

import { saveConfig, testConnection } from './sync.js';

export function isDesktop() {
  return matchMedia('(min-width: 769px)').matches;
}

// ── VIEW SWITCHING ──────────────────────────────────────────────────────────
// Desktop panels live in #sidebar (data-view="library|tonight|discover").
// Mobile has its own tab strip (#mobile-topbar) and renders view content into
// the bottom sheet instead of a sidebar panel (data-view="library|tonight|nearme").
// showView() flips the "active" tab styling on whichever tab strip matches the
// given name and returns the DOM node the caller (app.js) should render into.

const DESKTOP_CONTAINERS = {
  library: 'library-list',
  tonight: 'tonight-list',
  discover: 'discover-list'
};

export function showView(name) {
  // Desktop: toggle tab + panel visibility
  document.querySelectorAll('#mode-tabs .mode-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('#sidebar .view-panel').forEach(p =>
    p.style.display = (p.dataset.view === name) ? 'flex' : 'none');

  // Mobile: toggle tab strip; render target becomes the bottom sheet
  document.querySelectorAll('#mobile-topbar .mobile-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.view === name));

  // Hide the shared inspector whenever the active view changes (it only
  // shows again once a road is selected within the new view).
  hideInspector();

  if (!isDesktop()) {
    const titles = { library: 'Library', tonight: 'Tonight', nearme: 'Near me' };
    openSheet(titles[name] || name, '');
    return document.getElementById('sheet-content');
  }
  const id = DESKTOP_CONTAINERS[name];
  return id ? document.getElementById(id) : null;
}

// ── SHARED ROAD INSPECTOR (desktop sidebar panel) ───────────────────────────
export function showInspector(html) {
  const el = document.getElementById('inspector');
  document.getElementById('inspector-content').innerHTML = html;
  el.style.display = 'block';
  document.querySelectorAll('#sidebar .view-panel').forEach(p => (p.style.display = 'none'));
}
export function hideInspector() {
  document.getElementById('inspector').style.display = 'none';
}

// ── BOTTOM SHEET (mobile) — ported from v1 L2343-2401 ──────────────────────
export function openSheet(title, contentHtml, state = 'half') {
  const sheet = document.getElementById('bottom-sheet');
  document.getElementById('sheet-title-text').textContent = title;
  document.getElementById('sheet-content').innerHTML = contentHtml;
  sheet.className = state;
}

export function closeSheet() {
  document.getElementById('bottom-sheet').className = 'peek';
}

export function peekSheet(title) {
  const sheet = document.getElementById('bottom-sheet');
  document.getElementById('sheet-title-text').textContent = title;
  sheet.classList.remove('open', 'half');
  sheet.classList.add('peek');
}

export function initSheetDrag() {
  const sheet = document.getElementById('bottom-sheet');
  const handle = document.getElementById('sheet-handle-bar');
  if (!sheet || !handle) return;
  let startY;

  const onStart = (y) => { startY = y; sheet.style.transition = 'none'; };
  const onMove = (y) => {
    const dy = y - startY;
    const current = sheet.className;
    const base = current === 'open' ? 0 : current === 'half' ? window.innerHeight * 0.4 : window.innerHeight - 56;
    const newY = Math.max(0, Math.min(window.innerHeight * 0.85, base + dy));
    sheet.style.transform = `translateY(${newY}px)`;
  };
  const onEnd = (y) => {
    sheet.style.transition = '';
    sheet.style.transform = '';
    const dy = y - startY;
    const cur = sheet.className;
    if (dy < -60) sheet.className = cur === 'peek' ? 'half' : 'open';
    else if (dy > 60) sheet.className = cur === 'open' ? 'half' : 'peek';
  };

  handle.addEventListener('touchstart', e => onStart(e.touches[0].clientY), { passive: true });
  handle.addEventListener('touchmove', e => onMove(e.touches[0].clientY), { passive: true });
  handle.addEventListener('touchend', e => onEnd(e.changedTouches[0].clientY));
  handle.addEventListener('mousedown', e => {
    onStart(e.clientY);
    const mm = e2 => onMove(e2.clientY);
    const mu = e2 => { onEnd(e2.clientY); document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', mu);
  });

  document.getElementById('sheet-close-btn')?.addEventListener('click', closeSheet);
}

// ── GENERIC NAME / METADATA MODAL ───────────────────────────────────────────
let modalSaveHandler = null;

export function openNameModal({ title = 'Name this road', value = '', onSave }) {
  document.getElementById('name-modal-title').textContent = title;
  const input = document.getElementById('road-name-input');
  input.value = value;
  modalSaveHandler = onSave;
  document.getElementById('name-modal').classList.add('open');
  input.focus();
}

export function closeNameModal() {
  document.getElementById('name-modal').classList.remove('open');
  modalSaveHandler = null;
}

function wireModal() {
  document.getElementById('name-modal-ok')?.addEventListener('click', () => {
    const val = document.getElementById('road-name-input').value;
    const cb = modalSaveHandler;
    closeNameModal();
    if (cb) cb(val);
  });
  document.getElementById('name-modal-cancel')?.addEventListener('click', closeNameModal);
}

// ── ONBOARDING ───────────────────────────────────────────────────────────────
// Collects owner/repo/branch/path (+ optional token, desktop-only) and calls
// saveConfig(), then invokes onDone() so app.js can re-boot with the new cfg.
// Never logs or persists the token anywhere but localStorage via saveConfig.
export function showOnboarding(appState, onDone) {
  const overlay = document.getElementById('onboard');
  overlay.style.display = 'flex';

  // Token is only meaningful for writing (desktop draws/saves roads); hide
  // the field on phones to avoid inviting users to paste a PAT on mobile.
  document.getElementById('ob-token-row').style.display = isDesktop() ? 'block' : 'none';

  const form = document.getElementById('onboard-form');
  const errEl = document.getElementById('ob-error');

  const handler = async (e) => {
    e.preventDefault();
    errEl.style.display = 'none';
    const owner = document.getElementById('ob-owner').value.trim();
    const repo = document.getElementById('ob-repo').value.trim();
    const branch = document.getElementById('ob-branch').value.trim() || 'main';
    const path = document.getElementById('ob-path').value.trim() || 'roads.json';
    const token = isDesktop() ? document.getElementById('ob-token').value.trim() : '';

    if (!owner || !repo) {
      errEl.textContent = 'Owner and repo are required.';
      errEl.style.display = 'block';
      return;
    }

    const cfg = { owner, repo, branch, path };
    if (token) cfg.token = token;

    const submitBtn = document.getElementById('ob-submit');
    const originalLabel = submitBtn ? submitBtn.textContent : '';
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Testing…'; }

    let result;
    try {
      result = await testConnection(cfg);
    } finally {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = originalLabel; }
    }

    if (!result.ok) {
      errEl.textContent = result.message || 'Could not connect to GitHub.';
      errEl.style.display = 'block';
      return;
    }

    saveConfig(cfg);
    appState.cfg = cfg;
    form.removeEventListener('submit', handler);
    overlay.style.display = 'none';
    onDone();
  };
  form.addEventListener('submit', handler);
}

export function hideOnboarding() {
  document.getElementById('onboard').style.display = 'none';
}

// ── SERVICE WORKER ──────────────────────────────────────────────────────────
export function registerServiceWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ── MISC ─────────────────────────────────────────────────────────────────────
export function setDiscoverStatus(msg, cls = '') {
  const el = document.getElementById('discover-status');
  if (!el) return;
  el.textContent = msg;
  el.className = cls;
}

let uiInited = false;
export function initUi() {
  if (uiInited) return;
  uiInited = true;
  wireModal();
  initSheetDrag();
  registerServiceWorker();
}
