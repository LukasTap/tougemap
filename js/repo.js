// js/repo.js — the loaded library, and the only way to change it.
//
// Every change follows one pattern: copy the current data, apply the change to
// the copy, write the copy, and only then make it current. A failed write leaves
// nothing half-applied in memory (the old code mutated first, so a "NOT saved"
// change still went out with the next successful save).
//
// Writes are queued, and each one is pinned to the sha of the version it was
// built on — the loaded file's sha, then each successful write's. A copy that
// is stale for any reason is rejected by GitHub instead of overwriting.
import { readRoads, writeRoads } from './sync.js';
import { emptyData } from './store.js';
import { DEV_FAKE_SAVE } from './config.js';

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

export function createRepo({ read = readRoads, write = writeRoads, online = isOnline } = {}) {
  let state = { data: emptyData(), sha: null, source: 'none', error: null, notice: null };
  let chain = Promise.resolve();

  // Why a write would be refused right now, or null when it's allowed.
  function writeBlock(auth) {
    if (DEV_FAKE_SAVE && state.source === 'fixture') return null; // localhost dev: fake saves
    if (!auth?.token) return 'No GitHub token on this device — add one in 🔑 settings';
    if (state.source === 'fixture') return 'Sample data — saving is switched off';
    if (state.source !== 'remote') return "Roads couldn't be loaded from GitHub, so saving is off until a reload succeeds";
    if (!online()) return "You're offline — changes can't be saved right now";
    return null;
  }

  return {
    get data() { return state.data; },
    get source() { return state.source; },
    get error() { return state.error; },
    get notice() { return state.notice; },
    writeBlock,

    // Lock errors (ENCRYPTED_NO_PASS / BAD_PASSPHRASE) propagate and leave the
    // current state untouched.
    async load(auth) {
      const res = await read(auth);
      state = { error: null, notice: null, ...res };
      return state;
    },

    // change(next) mutates the copy (may be async); its return value is passed through.
    commit(auth, change) {
      const run = chain.then(async () => {
        const blocked = writeBlock(auth);
        if (blocked) throw new Error(blocked);
        const next = structuredClone(state.data);
        const result = await change(next);
        const sha = await write(auth, next, state.sha);
        state = { ...state, data: next, sha };
        return result;
      });
      chain = run.catch(() => {});
      return run;
    }
  };
}
