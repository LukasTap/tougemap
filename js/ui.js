// js/ui.js — view switching, bottom sheet, name/meta modal, onboarding form,
// responsive helper, service worker registration. Pure DOM mechanics: this
// module renders no road/weather data itself — app.js hands it HTML strings
// or containers to fill. Ported: bottom sheet drag logic from v1 L2343-2401.

// (No sync imports: app.js owns persistence; this module just collects input.)

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

function closeSheet() {
  document.getElementById('bottom-sheet').className = 'peek';
}

export function initSheetDrag() {
  const sheet = document.getElementById('bottom-sheet');
  // Drag from the whole header, not the 4px bar — a hairline hit area is
  // unusable with a fingertip. See #sheet-grab in styles.css.
  const handle = document.getElementById('sheet-grab');
  if (!sheet || !handle) return;
  let startY = null;
  // A tap on ✕ must close the sheet, not start a drag.
  const onCloseBtn = (e) => !!(e.target?.closest?.('#sheet-close-btn'));

  // Resting offsets, in px, matching the CSS: the sheet is 75vh tall, `half`
  // translates it 40% of itself (= 30vh) and `peek` all but the 56px header.
  const restOffset = (state) => {
    const h = window.innerHeight * 0.75;
    if (state === 'open') return 0;
    if (state === 'half') return h * 0.4;
    return h - 56;
  };

  const onStart = (y) => { startY = y; sheet.style.transition = 'none'; };
  const onMove = (y) => {
    const dy = y - startY;
    const newY = Math.max(0, Math.min(restOffset('peek'), restOffset(sheet.className) + dy));
    sheet.style.transform = `translateY(${newY}px)`;
  };
  const onEnd = (y) => {
    if (startY === null) return;
    sheet.style.transition = '';
    sheet.style.transform = '';
    const dy = y - startY;
    startY = null;
    const cur = sheet.className;
    if (dy < -50) sheet.className = cur === 'peek' ? 'half' : 'open';
    else if (dy > 50) sheet.className = cur === 'open' ? 'half' : 'peek';
  };

  handle.addEventListener('touchstart', e => { if (!onCloseBtn(e)) onStart(e.touches[0].clientY); }, { passive: true });
  handle.addEventListener('touchmove', e => { if (startY !== null) onMove(e.touches[0].clientY); }, { passive: true });
  handle.addEventListener('touchend', e => onEnd(e.changedTouches[0].clientY));
  handle.addEventListener('touchcancel', () => { startY = null; sheet.style.transition = ''; sheet.style.transform = ''; });
  handle.addEventListener('mousedown', e => {
    if (onCloseBtn(e)) return;
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

// ── UNLOCK (decrypt) & SETTINGS (token / set-passphrase) ─────────────────────
// This module only COLLECTS input and hands it to onSubmit — app.js persists and
// (re)encrypts. Nothing is logged. Two modes share the #onboard overlay.
const $ = (id) => document.getElementById(id);

// Runs the submit handler with the button locked; a failure is shown in the form
// (it used to vanish as an unhandled rejection, leaving the form looking stuck).
function runSubmit(fn) {
  const btn = $('ob-submit');
  const errEl = $('ob-error');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  return Promise.resolve().then(fn)
    .catch(err => {
      if (errEl) { errEl.textContent = err?.message || String(err); errEl.style.display = 'block'; }
    })
    .finally(() => { if (btn) { btn.disabled = false; btn.textContent = label; } });
}

// UNLOCK: one passphrase field. Shown only when the file is encrypted and we
// lack (or have the wrong) passphrase. A wrong passphrase must FAIL to decrypt —
// there is no silent pass-through here.
export function showUnlock({ message = '', onSubmit }) {
  $('onboard').style.display = 'flex';
  $('ob-subtitle').textContent = '// unlock';
  $('ob-desc').textContent = 'Enter your passphrase to unlock your roads. It decrypts them in your browser.';
  $('ob-pass-label').textContent = 'Passphrase';
  $('ob-pass2-row').style.display = 'none';
  $('ob-token-row').style.display = 'none';
  $('ob-cancel').style.display = 'none';
  $('ob-forget').style.display = 'none';
  $('ob-submit').textContent = 'UNLOCK';
  const errEl = $('ob-error');
  errEl.textContent = message || ''; errEl.style.display = message ? 'block' : 'none';
  const passEl = $('ob-pass'); passEl.value = ''; setTimeout(() => passEl.focus(), 50);
  $('onboard-form').onsubmit = (e) => {
    e.preventDefault();
    const passphrase = passEl.value;
    if (!passphrase) { errEl.textContent = 'Passphrase required.'; errEl.style.display = 'block'; return; }
    return runSubmit(() => onSubmit({ passphrase }));
  };
}

// SETTINGS: token + (optional) set/CHANGE passphrase, confirmed by re-typing so a
// typo can't silently lock you out. Cancelable. Opened from the 🔑 button.
export function showSettings({ hasToken = false, hasPassphrase = false, onSubmit, onCancel, onForget }) {
  $('onboard').style.display = 'flex';
  $('ob-subtitle').textContent = '// settings';
  $('ob-desc').innerHTML = hasPassphrase
    ? 'Update your GitHub token, or change your passphrase (re-encrypts your roads).'
    : 'Add your GitHub token to save, and set a passphrase to <b>encrypt</b> your roads.';
  $('ob-pass-label').textContent = hasPassphrase ? 'New passphrase (blank = keep current)' : 'Passphrase (encrypts your roads)';
  $('ob-pass2-row').style.display = 'block';
  $('ob-token-row').style.display = 'block';
  $('ob-cancel').style.display = '';
  $('ob-submit').textContent = 'SAVE';
  const note = $('ob-token-note'); if (note) note.textContent = hasToken ? 'Token already set — blank keeps it.' : '';
  const errEl = $('ob-error'); errEl.textContent = ''; errEl.style.display = 'none';
  const passEl = $('ob-pass'), pass2El = $('ob-pass2'), tokEl = $('ob-token');
  passEl.value = ''; pass2El.value = ''; tokEl.value = '';
  setTimeout(() => tokEl.focus(), 50);
  $('ob-cancel').onclick = () => { hideOnboarding(); if (onCancel) onCancel(); };
  const forgetBtn = $('ob-forget');
  forgetBtn.style.display = onForget && (hasToken || hasPassphrase) ? '' : 'none';
  forgetBtn.onclick = () => { if (onForget) onForget(); };
  $('onboard-form').onsubmit = (e) => {
    e.preventDefault();
    const passphrase = passEl.value, passphrase2 = pass2El.value, token = tokEl.value.trim();
    if (passphrase && passphrase !== passphrase2) { errEl.textContent = 'Passphrases don’t match.'; errEl.style.display = 'block'; return; }
    return runSubmit(() => onSubmit({ passphrase, token }));
  };
}

export function hideOnboarding() {
  document.getElementById('onboard').style.display = 'none';
}

// ── SERVICE WORKER ──────────────────────────────────────────────────────────
export function registerServiceWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ── MISC ─────────────────────────────────────────────────────────────────────
// One line over the map saying why the app is read-only (or null to hide it).
export function setStatusBanner(msg, kind = 'info') {
  const el = document.getElementById('status-banner');
  if (!el) return;
  el.textContent = msg || '';
  el.className = msg ? `on ${kind}` : '';
}

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
