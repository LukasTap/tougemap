// js/config.js — where your data lives. These are NOT secrets (they just point
// at the public repo that holds your encrypted roads.json), so they're baked in
// here instead of asked for on every visit.
//
// If you fork/copy this app, change `owner` (and repo/branch/path if you renamed
// them) to point at YOUR repo, then pick your own passphrase + token in the app.
export const REPO = {
  owner: 'LukasTap', // ← set this to your GitHub username
  repo: 'tougemap',
  branch: 'main',
  path: 'roads.json'
};

// Local development only: open http://localhost:<port>/?fixture to load the
// made-up sample roads in dev/fixture-roads.json instead of the real library.
// Saving is switched off in that mode. Never active on the deployed site.
const isLocalHost = typeof location !== 'undefined' &&
  /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
export const DEV_FIXTURE = isLocalHost && new URLSearchParams(location.search).has('fixture')
  ? 'dev/fixture-roads.json'
  : null;

// Local development only, on top of ?fixture: open /?fixture&fakesave to try
// every editing flow (pins, rename, home…) against the sample data. "Saving"
// then only updates the page's memory — nothing is sent anywhere.
export const DEV_FAKE_SAVE = !!DEV_FIXTURE && new URLSearchParams(location.search).has('fakesave');
