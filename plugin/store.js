/**
 * Local persistence for dsh-zhihu-mini.
 *
 * Everything the plugin must remember between restarts lives in a \`data/\`
 * directory next to the package: the Zhihu cookie jar, the resolved user
 * profile, the panel snapshot the agent reads, and a small response cache.
 *
 * Guarantees:
 *   - atomic writes: a temp file in the same directory plus rename(2), so a
 *     crash mid-write never leaves a truncated JSON document behind;
 *   - best-effort 0600 permissions on POSIX (Windows has no equivalent);
 *   - the cookie is never returned by any response body or log line: only
 *     loadCredentials() reads it, and callers must not echo it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Directory holding the plugin's JSON documents.
 *
 * `ZHIHU_MINI_DATA_DIR` overrides it so a test harness can point at a scratch
 * directory. Without that override `tools/smoke-host.mjs` would reset the REAL
 * `data/` directory and destroy a signed-in user's session — a hazard this
 * override exists to close.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the data directory on every use instead of at import time.
 *
 * ESM imports are hoisted, so a harness that sets `ZHIHU_MINI_DATA_DIR` after
 * its import block would otherwise still be pointed at the real directory —
 * which is exactly how a test run once deleted a signed-in user's session.
 * @returns {string} absolute data directory
 */
export function dataDir() {
  const override =
    typeof process.env.ZHIHU_MINI_DATA_DIR === 'string'
      ? process.env.ZHIHU_MINI_DATA_DIR.trim()
      : '';
  if (override !== '') return path.resolve(override);
  // An installed copy of the plugin lives inside node_modules, which the next
  // install replaces — keeping the session there would sign the user out on every
  // update. State therefore belongs to the harness home, like other DSH state.
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : path.join(os.homedir(), '.dsh');
  const stable = path.join(home, 'zhihu-mini');
  const legacy = path.join(HERE, 'data');
  if (!fs.existsSync(stable) && fs.existsSync(legacy)) {
    // One-time move from the pre-publish layout (data/ inside the package), so a
    // plugin installed by link keeps its signed-in session after this change.
    try {
      fs.mkdirSync(stable, { recursive: true, mode: 0o700 });
      for (const name of [CREDENTIALS_FILE, PANEL_FILE, CACHE_FILE]) {
        const from = path.join(legacy, name);
        if (fs.existsSync(from)) fs.copyFileSync(from, path.join(stable, name));
      }
    } catch {
      return legacy;
    }
  }
  return fs.existsSync(stable) ? stable : legacy;
}

const CREDENTIALS_FILE = 'credentials.json';
const PANEL_FILE = 'panel.json';
const CACHE_FILE = 'cache.json';

/**
 * The smallest shape a Zhihu question id can have.
 *
 * Real ids run from 8 to 19 digits; the lower bound rejects the placeholder
 * values that leak out of tests (`987654`) and any other token that could never
 * resolve to a question.
 */
const QUESTION_ID_PATTERN = /^\d{8,20}$/;

/** Default panel snapshot: nothing has been reported yet. */
const DEFAULT_PANEL = Object.freeze({
  view: 'hot',
  updatedAt: 0,
});

/**
 * Create the data directory once, tolerating a read-only install (the plugin
 * then degrades to in-memory state instead of throwing).
 * @returns {boolean} whether the directory is writable
 */
function ensureDataDir() {
  try {
    fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and parse one JSON document.
 * @param {string} file file name inside DATA_DIR
 * @param {unknown} fallback value returned for a missing or corrupt document
 * @returns {any}
 */
function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(path.join(dataDir(), file), 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Atomically replace one JSON document.
 * @param {string} file file name inside DATA_DIR
 * @param {unknown} value JSON-serializable value
 * @returns {boolean} whether the write succeeded
 */
function writeJson(file, value) {
  if (!ensureDataDir()) return false;
  const target = path.join(dataDir(), file);
  const temp = path.join(dataDir(), '.' + file + '.' + process.pid + '.tmp');
  try {
    const text = JSON.stringify(value, null, 2);
    fs.writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
    // Best effort: Windows ignores the mode, POSIX honors it.
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      /* not supported on this platform */
    }
    return true;
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* nothing left to clean */
    }
    return false;
  }
}

/**
 * Load the stored Zhihu session.
 *
 * The returned object is the only place the raw cookie is exposed; routes that
 * serialize login status must go through publicLogin() instead.
 * @returns {{ cookie: string, cookies: Record<string, string>, user: { name: string, headline?: string, avatarUrl?: string } | null, savedAt: number }}
 */
export function loadCredentials() {
  const doc = readJson(CREDENTIALS_FILE, null);
  const cookie = typeof doc?.cookie === 'string' ? doc.cookie : '';
  const cookies =
    doc?.cookies && typeof doc.cookies === 'object' && !Array.isArray(doc.cookies)
      ? Object.fromEntries(
          Object.entries(doc.cookies).filter(
            ([name, value]) =>
              typeof name === 'string' &&
              typeof value === 'string' &&
              name.length > 0 &&
              value.length > 0,
          ),
        )
      : {};
  const user =
    doc?.user && typeof doc.user === 'object' && typeof doc.user.name === 'string'
      ? {
          name: doc.user.name,
          ...(typeof doc.user.headline === 'string' ? { headline: doc.user.headline } : {}),
          ...(typeof doc.user.avatarUrl === 'string' ? { avatarUrl: doc.user.avatarUrl } : {}),
          ...(typeof doc.user.profileUrl === 'string' ? { profileUrl: doc.user.profileUrl } : {}),
        }
      : null;
  const savedAt = Number(doc?.savedAt) || 0;
  const deviceId = typeof doc?.deviceId === 'string' ? doc.deviceId : '';
  return { cookie, cookies, user, savedAt, deviceId };
}

/**
 * Persist a validated session. Callers must validate the cookie first: this
 * function performs no network access.
 * @param {{ cookie: string, cookies: Record<string, string>, user: object | null }} session
 * @returns {boolean}
 */
export function saveCredentials({ cookie, cookies, user, deviceId }) {
  const previous = readJson(CREDENTIALS_FILE, null);
  // The device id is Zhihu's d_c0: any session jar carries one, and it is what a
  // later scan-to-sign-in must be signed with. Capture it here so a sign-out never
  // costs the user the ability to log back in by QR.
  const fromCookies = cookies && typeof cookies === 'object' ? cookies.d_c0 : '';
  const keepDevice =
    typeof deviceId === 'string' && deviceId !== ''
      ? deviceId
      : typeof fromCookies === 'string' && fromCookies !== ''
        ? fromCookies
        : typeof previous?.deviceId === 'string'
          ? previous.deviceId
          : '';
  return writeJson(CREDENTIALS_FILE, {
    cookie: cookie || '',
    cookies: cookies || {},
    user: user || null,
    ...(keepDevice === '' ? {} : { deviceId: keepDevice }),
    savedAt: Date.now(),
  });
}

/**
 * Remove the stored session. Idempotent.
 * @returns {boolean} whether the on-disk document is gone
 */
export function clearCredentials() {
  try {
    // The device id (`d_c0`) is not a credential: it identifies this install to
    // Zhihu and is exactly what a fresh QR sign-in needs. Signing out drops the
    // cookie and the user but keeps the device so scan-to-sign-in still works.
    const previous = readJson(CREDENTIALS_FILE, null);
    const fromSession = previous?.cookies?.d_c0;
    const deviceId =
      typeof previous?.deviceId === 'string' && previous.deviceId !== ''
        ? previous.deviceId
        : typeof fromSession === 'string'
          ? fromSession
          : '';
    if (deviceId === '') {
      fs.rmSync(path.join(dataDir(), CREDENTIALS_FILE), { force: true });
      return true;
    }
    return writeJson(CREDENTIALS_FILE, { cookie: '', cookies: {}, user: null, deviceId, savedAt: 0 });
  } catch {
    return false;
  }
}

/**
 * The login state safe to send to the browser and to the agent: never contains
 * the cookie itself.
 * @returns {{ loggedIn: boolean, user: object | null, savedAt?: number }}
 */
export function publicLogin() {
  const session = loadCredentials();
  const loggedIn = session.cookie.length > 0;
  return {
    loggedIn,
    user: loggedIn ? session.user : null,
    ...(loggedIn && session.savedAt > 0 ? { savedAt: session.savedAt } : {}),
  };
}

/**
 * Load the last panel snapshot reported by the client.
 * @returns {{ view: 'hot'|'feed'|'search'|'reader', query?: string, questionId?: string, title?: string, visibleItems?: Array<{ id: string, title: string }>, selectionText?: string, answerId?: string, updatedAt: number }}
 */
export function loadPanel() {
  const doc = readJson(PANEL_FILE, null);
  if (!doc || typeof doc !== 'object') return { ...DEFAULT_PANEL };
  const views = new Set(['hot', 'feed', 'search', 'reader']);
  const view = views.has(doc.view) ? doc.view : DEFAULT_PANEL.view;
  /**
   * A snapshot is a hint, never a promise: the panel restores it and, for
   * `reader`, immediately fetches that question. An id that cannot be a Zhihu
   * question (or a `search` with no query) would restore the panel straight
   * into a failed request, so such a snapshot degrades to the hot list.
   */
  const restorable =
    (view !== 'reader' || QUESTION_ID_PATTERN.test(String(doc.questionId == null ? '' : doc.questionId))) &&
    (view !== 'search' || typeof doc.query === 'string') &&
    (view !== 'search' || String(doc.query).trim() !== '');
  if (!restorable) return { view: DEFAULT_PANEL.view, updatedAt: Number(doc.updatedAt) || 0 };
  const panel = { view, updatedAt: Number(doc.updatedAt) || 0 };
  if (typeof doc.query === 'string') panel.query = doc.query.slice(0, 200);
  if (typeof doc.questionId === 'string') panel.questionId = doc.questionId;
  if (typeof doc.title === 'string') panel.title = doc.title.slice(0, 300);
  if (typeof doc.answerId === 'string') panel.answerId = doc.answerId;
  if (typeof doc.selectionText === 'string') panel.selectionText = doc.selectionText.slice(0, 1000);
  if (Array.isArray(doc.visibleItems)) {
    panel.visibleItems = doc.visibleItems
      .filter((entry) => entry && typeof entry === 'object')
      .slice(0, 30)
      .map((entry) => ({
        id: String(entry.id == null ? '' : entry.id).slice(0, 64),
        title: String(entry.title == null ? '' : entry.title).slice(0, 200),
      }))
      .filter((entry) => entry.id !== '');
  }
  return panel;
}

/**
 * Persist the panel snapshot.
 * @param {object} panel normalized panel state
 * @returns {boolean}
 */
export function savePanel(panel) {
  return writeJson(PANEL_FILE, panel);
}

/**
 * Read a cached upstream response.
 * @param {string} key cache bucket
 * @param {number} ttl maximum acceptable age in milliseconds
 * @returns {{ value: any, at: number } | null}
 */
export function readCache(key, ttl) {
  const doc = readJson(CACHE_FILE, null);
  const entry = doc && typeof doc === 'object' ? doc[key] : null;
  if (!entry || typeof entry !== 'object') return null;
  const at = Number(entry.at) || 0;
  if (age(at) > ttl) return null;
  return { value: entry.value, at };
}

/**
 * Store a cached upstream response. The cache only ever keeps the last value
 * per key, so the file stays tiny.
 * @param {string} key cache bucket
 * @param {unknown} value JSON-serializable response
 * @returns {boolean}
 */
export function writeCache(key, value) {
  const doc = readJson(CACHE_FILE, {});
  const next = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  next[key] = { at: Date.now(), value };
  return writeJson(CACHE_FILE, next);
}

/**
 * Whether an on-disk data directory exists and is writable.
 * @returns {boolean}
 */
export function storageAvailable() {
  return ensureDataDir();
}

/**
 * @param {number} at
 * @returns {number}
 */
function age(at) {
  return at > 0 ? Date.now() - at : Number.MAX_SAFE_INTEGER;
}
