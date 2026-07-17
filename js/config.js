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
