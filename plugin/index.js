/**
 * Host half of dsh-zhihu-mini.
 *
 * Routes (all under /zhihu-mini, JSON unless noted):
 *   GET    /api/hot?limit=30&refresh=1        anonymous hot list
 *   GET    /api/feed?limit=12&refresh=1       anonymous recommendation feed
 *   GET    /api/search?q=..&offset=0&limit=20 cookie-gated search
 *   GET    /api/question?id=..&answerLimit=5  cookie-gated question + answers
 *   GET    /api/login/status                  local login state (no cookie)
 *   POST   /api/login/cookie   { cookie }     validate against Zhihu, then store
 *   DELETE /api/login                         forget the stored session
 *   GET    /api/panel                         last panel snapshot
 *   POST   /api/panel          PanelState     panel reports what the user sees
 *   GET    /api/events                        text/event-stream panel commands
 *
 * Agent tools: zhihu_panel, zhihu_hot, zhihu_feed, zhihu_search, zhihu_read,
 * zhihu_open. Each declares JSON-Schema parameters, an output schema, a text
 * projection for rendering, a cooperative timeout, and a concurrency policy.
 *
 * Every route runs the loopback trust fence first. A login-only route answers
 * HTTP 200 with { ok:false, code:'login-required' } so the panel can show its
 * login card; a raw upstream error never reaches the browser.
 */
import {
  CODES,
  clampInt,
  cookieHeader,
  cookieNames,
  createLoginQr,
  fail,
  fetchCurrentUser,
  fetchFeed,
  fetchHot,
  fetchQuestion,
  fetchSearch,
  hasSession,
  normalizeId,
  parseCookieString,
  pollLoginQr,
} from './zhihu.js';
import { qrSvg, svgDataUrl } from './qr.js';
import { isTrustedRequest } from './trust.js';
import { sanitizeHtml, toPlainText } from './sanitize.js';
import {
  clearCredentials,
  loadCredentials,
  loadPanel,
  publicLogin,
  readCache,
  saveCredentials,
  savePanel,
  storageAvailable,
  writeCache,
} from './store.js';

export const name = 'dsh-zhihu-mini';
export const inject = ['webServer', 'tools'];

/** Route prefix shared with the client module. */
const PREFIX = '/zhihu-mini';

/** Cache TTLs from the Lead's measurement. */
const HOT_TTL_MS = 60_000;
const FEED_TTL_MS = 60_000;
const QUESTION_TTL_MS = 5 * 60_000;
const MAX_QUESTION_CACHE = 100;

/** SSE limits. */
const MAX_STREAM_CLIENTS = 8;
const PING_INTERVAL_MS = 25_000;

/**
 * @param {any} ctx
 * @param {{ feedSize?: number, cacheTtlMs?: number }} [config]
 */
export function apply(ctx, config = {}) {
  const feedSize = clampInt(config.feedSize, 12, 1, 20);
  const hotTtl = clampInt(config.cacheTtlMs, HOT_TTL_MS, 5_000, 10 * 60_000);
  const feedTtl = clampInt(config.cacheTtlMs, FEED_TTL_MS, 5_000, 10 * 60_000);

  /** id -> { at, value }; insertion order doubles as the LRU order. */
  const questionCache = new Map();
  /** Open SSE responses. */
  const streamClients = new Set();
  /**
   * token -> { createdAt, expiresAt, jar }. A QR session lives only in memory:
   * the jar it accumulates is the half-authenticated cookie set, so writing it
   * to disk before the phone confirms would leave a session that can never
   * finish and must never be replayed after a restart.
   */
  const qrSessions = new Map();

  if (!storageAvailable()) {
    ctx.logger?.warn?.('[zhihu-mini] data directory is not writable; login state will not persist');
  }

  /**
   * Read the stored session once per request; never serialize it out.
   * @returns {{ cookies: Record<string, string>, loggedIn: boolean }}
   */
  function session() {
    const stored = loadCredentials();
    return { cookies: stored.cookies, loggedIn: hasSession(stored.cookies) };
  }

  /** Drop QR sessions past their expiry, and cap the map so a hostile client
   * cannot grow it without bound. */
  function pruneQrSessions(now = Date.now()) {
    for (const [token, entry] of qrSessions) {
      if (entry.expiresAt <= now) qrSessions.delete(token);
    }
    while (qrSessions.size >= 16) {
      const oldest = qrSessions.keys().next().value;
      if (oldest === undefined) break;
      qrSessions.delete(oldest);
    }
  }

  /**
   * The device id a QR request must be signed with.
   *
   * A signed-in jar already holds a genuine `d_c0`; an anonymous browser gets
   * one from Zhihu on its first page view and the panel stores it during a
   * cookie paste. Absent both, the caller is told to paste a cookie once.
   * @returns {string}
   */
  function storedDeviceId() {
    const stored = loadCredentials();
    const fromSession = stored.cookies?.d_c0;
    if (typeof fromSession === 'string' && fromSession !== '') return fromSession;
    const fromDevice = stored.deviceId;
    return typeof fromDevice === 'string' ? fromDevice : '';
  }

  /**
   * Keep the browser-supplied device id so later QR requests do not depend on
   * the panel still holding that cookie.
   * @param {string} deviceId
   * @returns {boolean}
   */
  function rememberDeviceId(deviceId) {
    const stored = loadCredentials();
    return saveCredentials({
      cookie: stored.cookie,
      cookies: stored.cookies,
      user: stored.user,
      deviceId,
    });
  }

  /**
   * Cache-aware hot list loader.
   * @param {number} limit
   * @param {boolean} force
   * @param {Record<string, string>} [cookies]
   */
  async function loadHot(limit, force, cookies) {
    const size = clampInt(limit, 30, 1, 50);
    const key = 'hot:' + size;
    if (!force) {
      const cached = readCache(key, hotTtl);
      if (cached !== null && Array.isArray(cached.value?.items)) {
        // Slice on read as well: a cache document written by an older build (or
        // by a request whose limit was clamped differently) must never serve
        // more rows than this request asked for.
        return { ok: true, items: cached.value.items.slice(0, size), fetchedAt: cached.at, cached: true };
      }
    }
    const result = await fetchHot({ limit: size, cookies });
    if (!result.ok) return result;
    writeCache(key, { items: result.items });
    return { ok: true, items: result.items, fetchedAt: result.fetchedAt, cached: false };
  }

  /**
   * Cache-aware feed loader.
   * @param {number} limit
   * @param {boolean} force
   * @param {Record<string, string>} [cookies]
   */
  async function loadFeed(limit, force, cookies) {
    const size = clampInt(limit, feedSize, 1, 30);
    const key = 'feed:' + size;
    if (!force) {
      const cached = readCache(key, feedTtl);
      if (cached !== null && Array.isArray(cached.value?.items)) {
        return { ok: true, items: cached.value.items.slice(0, size), fetchedAt: cached.at, cached: true };
      }
    }
    const result = await fetchFeed({ limit: size, cookies });
    if (!result.ok) return result;
    writeCache(key, { items: result.items });
    return { ok: true, items: result.items, fetchedAt: result.fetchedAt, cached: false };
  }

  /**
   * Question + answers with a bounded per-id LRU.
   * @param {string} rawId
   * @param {number} answerLimit
   * @param {Record<string, string>} cookies
   */
  async function loadQuestion(rawId, answerLimit, cookies) {
    const id = normalizeId(rawId);
    if (id === '') return fail(CODES.badInput, 'invalid question id');
    const cached = questionCache.get(id);
    if (cached !== undefined && Date.now() - cached.at < QUESTION_TTL_MS) {
      return { ...cached.value, cached: true };
    }
    const result = await fetchQuestion({ questionId: id, answerLimit, cookies });
    if (!result.ok) return result;
    const answers = result.answers.map((answer) => {
      // Sanitize once: the plain-text projection is derived from the same
      // sanitized string, never from the raw upstream HTML.
      const contentHtml = sanitizeHtml(answer.contentHtml);
      return {
        ...answer,
        contentHtml,
        contentText: toPlainText(contentHtml).slice(0, 4000),
      };
    });
    const value = {
      ok: true,
      question: result.question,
      answers,
      fetchedAt: result.fetchedAt,
      ...(result.answersCode === undefined ? {} : { answersCode: result.answersCode }),
    };
    questionCache.set(id, { at: Date.now(), value });
    while (questionCache.size > MAX_QUESTION_CACHE) {
      const oldest = questionCache.keys().next().value;
      if (oldest === undefined) break;
      questionCache.delete(oldest);
    }
    return { ...value, cached: false };
  }

  /**
   * Send one SSE frame to every connected panel.
   * @param {object} event
   * @returns {number} the number of panels the frame was written to
   */
  function broadcast(event) {
    const frame = 'data: ' + JSON.stringify(event) + '\n\n';
    let delivered = 0;
    for (const client of streamClients) {
      try {
        client.res.write(frame);
        delivered += 1;
      } catch {
        dropClient(client);
      }
    }
    return delivered;
  }

  /**
   * @param {{ res: import('node:http').ServerResponse, timer: NodeJS.Timeout }} client
   */
  function dropClient(client) {
    if (client.timer !== undefined) clearInterval(client.timer);
    streamClients.delete(client);
  }

  /**
   * Routes that act on the saved Zhihu credentials.
   *
   * The trust fence only proves the shape of the request — a browser page on
   * this origin, or anything that simply omits Origin/Referer. A local process
   * can therefore reach these routes and read the user's personalised feed,
   * sign the saved account out, or replace the stored cookie. They also require
   * an authenticated DSH browser session.
   */
  const STATEFUL_PATHS = new Set([
    PREFIX + '/api/feed',
    PREFIX + '/api/search',
    PREFIX + '/api/question',
    PREFIX + '/api/login',
    PREFIX + '/api/login/status',
    PREFIX + '/api/login/cookie',
    PREFIX + '/api/login/qr',
    PREFIX + '/api/login/qr/status',
  ]);

  /**
   * Read one harness service by name.
   *
   * Resolved per request on purpose: services may register after this plugin
   * applies, and a stale miss must not latch the gate into refusing forever.
   * @param {string} name
   */
  function serviceOf(name) {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) ?? null : null;
    } catch {
      return null;
    }
  }

  /**
   * Normalize the harness's admission shapes to one verdict.
   *
   * DSH reports credentials in two shapes across versions:
   *   - `PeerAdmission`: `{ peer }` or `{ rejection: 401 | 403 | 503 }`
   *     (0.2.3 `connection.authentication.authenticate` / `connection.admit`);
   *   - a bare status number from 0.2.2's `connection.requestRejection`.
   * `undefined` means admitted; `'unavailable'` means nothing could be asked.
   * @param {unknown} value
   * @returns {number | undefined | 'unavailable'}
   */
  function admissionVerdict(value) {
    if (value === undefined) return undefined;
    if (typeof value === 'number') return value;
    if (value !== null && typeof value === 'object') {
      if ('rejection' in value) {
        const rejection = value.rejection;
        return typeof rejection === 'number' ? rejection : 'unavailable';
      }
      if ('peer' in value) return undefined;
    }
    return 'unavailable';
  }

  /**
   * Verify the DSH session behind a request, newest API first.
   *
   * 0.2.3 replaced `requestRejection` with a `connection.authentication`
   * sub-service and moved admission onto `PeerAdmission`; 0.2.2 only has
   * `requestRejection`. Every documented shape is tried so one build serves both.
   * @param {import('node:http').IncomingMessage} req
   * @returns {number | undefined | 'unavailable'}
   */
  function sessionVerdict(req) {
    const authentication = serviceOf('connection.authentication');
    if (authentication !== null && typeof authentication.authenticate === 'function') {
      return admissionVerdict(authentication.authenticate(req));
    }
    const connection = serviceOf('connection');
    if (connection !== null && typeof connection.admit === 'function') {
      return admissionVerdict(connection.admit(req));
    }
    if (connection !== null && typeof connection.requestRejection === 'function') {
      return admissionVerdict(connection.requestRejection(req));
    }
    return 'unavailable';
  }

  /** Warn once when this profile cannot verify sessions at all. */
  let warnedNoVerifier = false;
  function warnNoVerifier(detail) {
    if (warnedNoVerifier) return;
    warnedNoVerifier = true;
    ctx.logger?.warn?.(
      '[zhihu-mini] cannot verify DSH sessions (' +
        detail +
        '); account-related routes answer 503 until the connection service is available',
    );
  }

  /**
   * Verify the DSH browser session behind a stateful request.
   *
   * DSH issues a signed `dsh-auth-<authority>` cookie to its own page, and the
   * connection service reports 403 for a fence failure and 401 when no valid
   * session accompanies the request.
   *
   * This check **fails closed**. If the profile does not expose the connection
   * service, or that service has no usable verification method, these routes
   * refuse instead of falling back to the trust fence alone: the fence cannot
   * tell a browser page from a local process, and letting it stand in would hand
   * the signed-in feed, sign-out and cookie replacement to any local caller.
   * `session-unavailable` (503) names that case, so a client can tell "this
   * profile cannot verify" from "you are not authenticated".
   *
   * @returns {boolean} whether the request may proceed
   */
  function allowStateful(req, res) {
    let verdict;
    try {
      verdict = sessionVerdict(req);
    } catch (error) {
      // A throwing verification is a failed verification, never a pass.
      const message = error instanceof Error ? error.message : String(error);
      warnNoVerifier('session verification threw: ' + message);
      sendJson(res, 503, {
        ok: false,
        code: 'session-unavailable',
        error: 'the DSH session check failed: ' + message,
      });
      return false;
    }
    if (verdict === undefined) return true;
    if (verdict === 'unavailable') {
      warnNoVerifier('no connection authentication service');
      sendJson(res, 503, {
        ok: false,
        code: 'session-unavailable',
        error:
          'this DSH profile cannot verify the session behind the saved Zhihu credentials ' +
          '(no connection authentication service), so account-related routes are refused',
      });
      return false;
    }
    if (verdict === 401) {
      sendJson(res, 401, {
        ok: false,
        code: 'session-required',
        error: 'this route acts on the saved Zhihu session and needs an authenticated DSH session',
      });
      return false;
    }
    if (verdict === 403) {
      sendJson(res, 403, { ok: false, code: 'forbidden', error: 'forbidden' });
      return false;
    }
    // 503 (no usable verifier in the harness) and anything unexpected fail closed.
    sendJson(res, 503, {
      ok: false,
      code: 'session-unavailable',
      error: 'the DSH session check could not complete',
    });
    return false;
  }

  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');

      // The loopback trust fence is the first thing every route touches: the
      // harness only applies its own fence to /api, not to webServer routes.
      if (!isTrustedRequest(req)) {
        sendJson(res, 403, { ok: false, error: 'forbidden' });
        return;
      }

      // Stateful routes carry a second gate: the fence says "a page on this
      // origin", the DSH session says "this installation's user".
      if (STATEFUL_PATHS.has(url.pathname) && !allowStateful(req, res)) return;

      try {
        if (url.pathname === PREFIX + '/api/events') {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          openStream(req, res);
          return;
        }

        if (url.pathname === PREFIX + '/api/hot') {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          const force = url.searchParams.get('refresh') === '1';
          const limit = clampInt(url.searchParams.get('limit'), 30, 1, 50);
          const { cookies } = session();
          const result = await loadHot(limit, force, cookies);
          if (!result.ok) {
            sendJson(res, 200, { ok: false, code: result.code, error: result.error });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            source: 'hot',
            fetchedAt: result.fetchedAt,
            cached: result.cached === true,
            items: result.items,
          });
          return;
        }

        if (url.pathname === PREFIX + '/api/feed') {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          const force = url.searchParams.get('refresh') === '1';
          const limit = clampInt(url.searchParams.get('limit'), feedSize, 1, 30);
          const { cookies } = session();
          const result = await loadFeed(limit, force, cookies);
          if (!result.ok) {
            sendJson(res, 200, { ok: false, code: result.code, error: result.error });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            source: 'feed',
            fetchedAt: result.fetchedAt,
            cached: result.cached === true,
            items: result.items,
          });
          return;
        }

        if (url.pathname === PREFIX + '/api/search') {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          const query = (url.searchParams.get('q') || '').trim();
          if (query === '') {
            sendJson(res, 200, { ok: false, code: CODES.badInput, error: 'missing query' });
            return;
          }
          const { cookies, loggedIn } = session();
          if (!loggedIn) {
            sendJson(res, 200, loginRequired('search'));
            return;
          }
          const result = await fetchSearch({
            query,
            offset: clampInt(url.searchParams.get('offset'), 0, 0, 5000),
            limit: clampInt(url.searchParams.get('limit'), 20, 1, 50),
            cookies,
          });
          if (!result.ok) {
            sendJson(res, 200, { ok: false, code: result.code, error: result.error });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            source: 'search',
            query,
            fetchedAt: result.fetchedAt,
            items: result.items,
          });
          return;
        }

        if (url.pathname === PREFIX + '/api/question') {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          const id = normalizeId(url.searchParams.get('id'));
          if (id === '') {
            sendJson(res, 200, { ok: false, code: CODES.badInput, error: 'invalid question id' });
            return;
          }
          const { cookies, loggedIn } = session();
          if (!loggedIn) {
            sendJson(res, 200, loginRequired('reader'));
            return;
          }
          const result = await loadQuestion(id, clampInt(url.searchParams.get('answerLimit'), 5, 1, 10), cookies);
          if (!result.ok) {
            sendJson(res, 200, { ok: false, code: result.code, error: result.error });
            return;
          }
          sendJson(res, 200, {
            ok: true,
            source: 'question',
            cached: result.cached === true,
            fetchedAt: result.fetchedAt,
            question: result.question,
            answers: result.answers,
            ...(result.answersCode === undefined ? {} : { answersCode: result.answersCode }),
          });
          return;
        }

        if (url.pathname === PREFIX + '/api/login/qr') {
          if (req.method === 'POST') {
            pruneQrSessions();
            // The panel runs in a browser that already holds Zhihu's genuine
            // device cookie (`d_c0` is not HttpOnly), so it can supply one even
            // before any login happened here. A stored cookie wins, because it
            // belongs to the same device the session will be validated on.
            let supplied = '';
            if (String(req.headers['content-type'] || '').includes('application/json')) {
              try {
                const body = await readJsonBody(req);
                supplied = typeof body?.deviceId === 'string' ? body.deviceId.trim() : '';
              } catch {
                supplied = '';
              }
            }
            if (supplied !== '' && !/^[\x21-\x7e]{16,512}$/.test(supplied)) supplied = '';
            const deviceId = storedDeviceId() || supplied;
            if (supplied !== '' && storedDeviceId() === '') rememberDeviceId(supplied);
            if (deviceId === '') {
              sendJson(res, 200, {
                ok: false,
                code: 'device-required',
                error:
                  'Zhihu needs a device cookie before it will issue a QR code. Paste the ' +
                  'Cookie header once; after that the panel can sign in by scan.',
              });
              return;
            }
            const created = await createLoginQr({ deviceId });
            if (!created.ok) {
              sendJson(res, 200, { ok: false, code: created.code, error: created.error });
              return;
            }
            qrSessions.set(created.token, {
              createdAt: Date.now(),
              expiresAt: created.expiresAt,
              jar: created.jar,
            });
            let svg = '';
            try {
              svg = qrSvg(created.link);
            } catch (error) {
              sendJson(res, 200, {
                ok: false,
                code: 'qr-render-failed',
                error: 'The sign-in link could not be rendered as a QR code',
              });
              return;
            }
            sendJson(res, 200, {
              ok: true,
              token: created.token,
              link: created.link,
              svg,
              image: svgDataUrl(svg),
              expiresAt: created.expiresAt,
            });
            return;
          }
          if (req.method === 'DELETE') {
            const token = String(url.searchParams.get('token') || '');
            qrSessions.delete(token);
            sendJson(res, 200, { ok: true });
            return;
          }
          sendJson(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }

        if (url.pathname === PREFIX + '/api/login/qr/status') {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          const token = String(url.searchParams.get('token') || '');
          const entry = qrSessions.get(token);
          if (entry === undefined) {
            sendJson(res, 200, { ok: false, code: 'qr-not-found', error: 'this QR session is not open' });
            return;
          }
          if (entry.expiresAt <= Date.now()) {
            qrSessions.delete(token);
            sendJson(res, 200, { ok: true, state: 'expired' });
            return;
          }
          const polled = await pollLoginQr({ token, jar: entry.jar });
          if (!polled.ok) {
            sendJson(res, 200, { ok: false, code: polled.code, error: polled.error });
            return;
          }
          entry.jar = polled.jar;
          if (polled.state !== 'confirmed') {
            sendJson(res, 200, { ok: true, state: polled.state });
            return;
          }
          // Confirmed: the jar now carries z_c0. Validate it exactly like a pasted
          // cookie, so a half-finished handshake can never be stored as a session.
          const validated = await fetchCurrentUser({ cookies: polled.jar });
          if (!validated.ok) {
            qrSessions.delete(token);
            sendJson(res, 200, {
              ok: false,
              code: validated.code,
              error: 'the scan completed but Zhihu did not accept the session',
            });
            return;
          }
          const stored = saveCredentials({
            cookie: cookieHeader(polled.jar),
            cookies: polled.jar,
            user: validated.user,
          });
          qrSessions.delete(token);
          if (!stored) {
            sendJson(res, 200, { ok: false, error: 'could not persist the session' });
            return;
          }
          questionCache.clear();
          sendJson(res, 200, { ok: true, state: 'confirmed', user: validated.user });
          return;
        }

        if (url.pathname === PREFIX + '/api/login/status') {
          if (req.method !== 'GET') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          // A session stored before this build learned about profile URLs has a
          // user object without one. Enrich it once here (no extra calls after
          // that) so the account sheet can link to the person it is showing.
          const stored = loadCredentials();
          if (
            hasSession(stored.cookies) &&
            stored.user !== null &&
            stored.user.profileUrl === undefined
          ) {
            const who = await fetchCurrentUser({ cookies: stored.cookies });
            if (who.ok) {
              saveCredentials({
                cookie: stored.cookie,
                cookies: stored.cookies,
                user: who.user,
                ...(stored.deviceId === '' ? {} : { deviceId: stored.deviceId }),
              });
            }
          }
          sendJson(res, 200, { ok: true, ...publicLogin() });
          return;
        }

        if (url.pathname === PREFIX + '/api/login/cookie') {
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          if (!String(req.headers['content-type'] || '').includes('application/json')) {
            sendJson(res, 415, { ok: false, error: 'unsupported media type' });
            return;
          }
          let body;
          try {
            body = await readJsonBody(req);
          } catch {
            sendJson(res, 400, { ok: false, error: 'invalid body' });
            return;
          }
          const raw = typeof body?.cookie === 'string' ? body.cookie : '';
          const cookies = parseCookieString(raw);
          if (Object.keys(cookies).length === 0) {
            sendJson(res, 200, {
              ok: false,
              error:
                'no cookie found: paste the zhihu.com Cookie header (DevTools → Network → ' +
                'request headers), which includes the HttpOnly z_c0',
            });
            return;
          }
          // Validate before storing: an expired paste must never overwrite a
          // working session, and a stored cookie must already be proven good.
          const validated = await fetchCurrentUser({ cookies });
          if (!validated.ok) {
            sendJson(res, 200, {
              ok: false,
              code: validated.code,
              error: hasSession(cookies)
                ? 'cookie invalid or expired'
                : 'these cookies are not a signed-in Zhihu session: z_c0 is missing ' +
                  '(SESSIONID alone exists for every visitor)',
              cookieNames: cookieNames(cookies),
            });
            return;
          }
          const stored = saveCredentials({
            cookie: cookieHeader(cookies),
            cookies,
            user: validated.user,
          });
          if (!stored) {
            sendJson(res, 200, { ok: false, error: 'could not persist the session' });
            return;
          }
          sendJson(res, 200, { ok: true, user: validated.user });
          return;
        }

        if (url.pathname === PREFIX + '/api/login') {
          if (req.method !== 'DELETE') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          clearCredentials();
          questionCache.clear();
          sendJson(res, 200, { ok: true, loggedIn: false });
          return;
        }

        if (url.pathname === PREFIX + '/api/panel') {
          if (req.method === 'GET') {
            const panel = loadPanel();
            sendJson(res, 200, {
              ok: true,
              panel,
              connected: streamClients.size > 0,
              loggedIn: session().loggedIn,
            });
            return;
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' });
            return;
          }
          if (!String(req.headers['content-type'] || '').includes('application/json')) {
            sendJson(res, 415, { ok: false, error: 'unsupported media type' });
            return;
          }
          let body;
          try {
            body = await readJsonBody(req);
          } catch {
            sendJson(res, 400, { ok: false, error: 'invalid body' });
            return;
          }
          const panel = normalizePanel(body);
          if (panel === null) {
            sendJson(res, 400, { ok: false, error: 'invalid panel state' });
            return;
          }
          savePanel(panel);
          sendJson(res, 200, { ok: true });
          return;
        }

        sendJson(res, 404, { ok: false, error: 'not found' });
      } catch (error) {
        const message = redact(error?.message || String(error));
        ctx.logger?.warn?.('[zhihu-mini] ' + url.pathname + ' failed: ' + message);
        if (res.headersSent) {
          res.destroy();
        } else {
          sendJson(res, 200, { ok: false, code: CODES.upstream, error: message });
        }
      }
    },
  });

  /**
   * Open one text/event-stream response and register it for panel commands.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function openStream(req, res) {
    if (streamClients.size >= MAX_STREAM_CLIENTS) {
      sendJson(res, 503, { ok: false, error: 'too many event streams' });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // Tell EventSource to retry quickly, then announce the current view so a
    // reconnecting panel re-syncs. Contract event: { type:'open', view, questionId?, query? }.
    res.write('retry: 3000\n\n');
    const panel = loadPanel();
    // Replaying `reader` makes the panel fetch that question the moment it
    // mounts, so a snapshot pointing at a question Zhihu no longer serves (a
    // deleted question, or a placeholder id that leaked out of a test) would
    // restore the whole panel into an error page. Only a question this process
    // served recently is replayed; anything else re-syncs to the hot list.
    const replayView =
      panel.view === 'reader' && !questionCache.has(String(panel.questionId || ''))
        ? 'hot'
        : panel.view;
    res.write(
      'data: ' +
        JSON.stringify({
          type: 'open',
          view: replayView,
          ...(replayView !== 'reader' || panel.questionId === undefined
            ? {}
            : { questionId: panel.questionId }),
          ...(panel.query === undefined ? {} : { query: panel.query }),
        }) +
        '\n\n',
    );

    const client = { res, timer: undefined };
    client.timer = setInterval(() => {
      try {
        res.write('data: ' + JSON.stringify({ type: 'ping' }) + '\n\n');
      } catch {
        dropClient(client);
      }
    }, PING_INTERVAL_MS);
    client.timer.unref?.();
    streamClients.add(client);

    const cleanup = () => {
      dropClient(client);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  const disposeTools = [];
  const registerTool = (definition) => {
    disposeTools.push(ctx.tools.register(definition));
  };

  const panelState = () => {
    const panel = loadPanel();
    const login = publicLogin();
    const connected = streamClients.size > 0;
    return {
      view: panel.view,
      ...(panel.query === undefined ? {} : { query: panel.query }),
      ...(panel.questionId === undefined ? {} : { questionId: panel.questionId }),
      ...(panel.title === undefined ? {} : { title: panel.title }),
      ...(panel.selectionText === undefined ? {} : { selectionText: panel.selectionText }),
      ...(panel.visibleItems === undefined ? {} : { visibleItems: panel.visibleItems }),
      ...(panel.answerId === undefined ? {} : { answerId: panel.answerId }),
      loggedIn: login.loggedIn,
      updatedAt: panel.updatedAt,
      panelConnected: connected,
      hint: panelHint(panel, login.loggedIn, connected),
    };
  };

  registerTool({
    name: 'zhihu_panel',
    description:
      'Read what the user is currently looking at in the Zhihu sidebar panel: active view, search query, open question, visible cards and any selected text. Call this before answering questions about "this" or "the panel".',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: {
          view: { type: 'string' },
          query: { type: 'string' },
          questionId: { type: 'string' },
          title: { type: 'string' },
          selectionText: { type: 'string' },
          visibleItems: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, title: { type: 'string' } },
            },
          },
          answerId: { type: 'string' },
          loggedIn: { type: 'boolean' },
          updatedAt: { type: 'number' },
          panelConnected: { type: 'boolean' },
          hint: { type: 'string' },
        },
        required: ['view', 'loggedIn', 'updatedAt', 'hint'],
      },
      render: (_args, value) => [{ type: 'text', text: renderPanel(value) }],
    },
    timeoutMs: 5_000,
    isConcurrencySafe: () => true,
    presentCall: () => ({ title: 'Zhihu panel', subtitle: 'current view' }),
    execute: async () => panelState(),
  });

  registerTool({
    name: 'zhihu_hot',
    description: 'Read the current Zhihu hot list (works without login).',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many entries to return (1-50, default 20)' },
      },
    },
    output: {
      schema: listOutputSchema(),
      render: (_args, value) => [{ type: 'text', text: renderItems(value, 'Zhihu hot list') }],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    presentCall: () => ({ title: 'Zhihu hot list' }),
    execute: async (args) => {
      const { cookies } = session();
      const result = await loadHot(clampInt(args?.limit, 20, 1, 50), false, cookies);
      if (!result.ok) return listFailure(result);
      return {
        ok: true,
        source: 'hot',
        fetchedAt: result.fetchedAt,
        items: result.items.map(compactItem),
      };
    },
  });

  registerTool({
    name: 'zhihu_feed',
    description: 'Read the Zhihu recommended feed (works without login).',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many entries to return (1-30, default 12)' },
      },
    },
    output: {
      schema: listOutputSchema(),
      render: (_args, value) => [{ type: 'text', text: renderItems(value, 'Zhihu feed') }],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    presentCall: () => ({ title: 'Zhihu feed' }),
    execute: async (args) => {
      const { cookies } = session();
      const result = await loadFeed(clampInt(args?.limit, feedSize, 1, 30), false, cookies);
      if (!result.ok) return listFailure(result);
      return {
        ok: true,
        source: 'feed',
        fetchedAt: result.fetchedAt,
        items: result.items.map(compactItem),
      };
    },
  });

  registerTool({
    name: 'zhihu_search',
    description: 'Search Zhihu. Requires a stored login cookie; without one it reports login-required.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords' },
        limit: { type: 'number', description: 'How many results (1-50, default 20)' },
      },
      required: ['query'],
    },
    output: {
      schema: listOutputSchema(),
      render: (_args, value) => [{ type: 'text', text: renderItems(value, 'Zhihu search') }],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ title: 'Zhihu search', subtitle: String(args?.query ?? '') }),
    execute: async (args) => {
      const query = String(args?.query ?? '').trim();
      if (query === '') return listFailure(fail(CODES.badInput, 'query is required'));
      const { cookies, loggedIn } = session();
      if (!loggedIn) return listFailure(fail(CODES.loginRequired, loginHint('search')));
      const result = await fetchSearch({ query, limit: clampInt(args?.limit, 20, 1, 50), cookies });
      if (!result.ok) return listFailure(result);
      return {
        ok: true,
        source: 'search',
        query,
        fetchedAt: result.fetchedAt,
        items: result.items.map(compactItem),
      };
    },
  });

  registerTool({
    name: 'zhihu_read',
    description:
      'Read one Zhihu question and its top answers as plain text. Requires a stored login cookie; without one it reports login-required.',
    parameters: {
      type: 'object',
      properties: {
        questionId: { type: 'string', description: 'Numeric Zhihu question id' },
        answerLimit: { type: 'number', description: 'How many answers (1-10, default 3)' },
      },
      required: ['questionId'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string' },
          message: { type: 'string' },
          question: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              detailText: { type: 'string' },
              answerCount: { type: 'number' },
              followerCount: { type: 'number' },
              url: { type: 'string' },
              topics: { type: 'array', items: { type: 'string' } },
            },
          },
          answers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                questionId: { type: 'string' },
                author: { type: 'string' },
                voteupCount: { type: 'number' },
                commentCount: { type: 'number' },
                text: { type: 'string' },
                url: { type: 'string' },
              },
            },
          },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: renderQuestion(value) }],
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    presentCall: (args) => ({ title: 'Zhihu question', subtitle: String(args?.questionId ?? '') }),
    execute: async (args) => {
      const id = normalizeId(args?.questionId);
      if (id === '') return { ok: false, code: CODES.badInput, message: 'invalid question id' };
      const { cookies, loggedIn } = session();
      if (!loggedIn) return { ok: false, code: CODES.loginRequired, message: loginHint('reader') };
      const result = await loadQuestion(id, clampInt(args?.answerLimit, 3, 1, 10), cookies);
      if (!result.ok) return { ok: false, code: result.code, message: result.error };
      return {
        ok: true,
        question: result.question,
        answers: result.answers.map((answer) => ({
          id: answer.id,
          questionId: answer.questionId,
          author: answer.author?.name ?? '',
          voteupCount: answer.voteupCount,
          commentCount: answer.commentCount,
          text: (answer.contentText || '').slice(0, 1200),
          url: answer.url,
        })),
      };
    },
  });

  registerTool({
    name: 'zhihu_open',
    description:
      'Navigate the Zhihu sidebar panel: switch to the hot list, the feed, a search, or a question reader. Reports delivered:false when no panel is connected.',
    parameters: {
      type: 'object',
      properties: {
        view: {
          type: 'string',
          enum: ['hot', 'feed', 'search', 'reader'],
          description: 'Target view',
        },
        query: { type: 'string', description: 'Search keywords (view=search)' },
        questionId: { type: 'string', description: 'Question id (view=reader)' },
      },
      required: ['view'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          delivered: { type: 'boolean' },
          view: { type: 'string' },
          query: { type: 'string' },
          questionId: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['delivered', 'view'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            (value.delivered ? 'Panel switched to ' : 'No panel connected; could not switch to ') +
            value.view +
            (value.view === 'search' && value.query ? ' (' + value.query + ')' : '') +
            (value.view === 'reader' && value.questionId ? ' (question ' + value.questionId + ')' : ''),
        },
      ],
    },
    timeoutMs: 5_000,
    isConcurrencySafe: () => false,
    presentCall: (args) => ({ title: 'Open in Zhihu panel', subtitle: String(args?.view ?? '') }),
    execute: async (args) => {
      const view = String(args?.view ?? '');
      if (!['hot', 'feed', 'search', 'reader'].includes(view)) {
        return { delivered: false, view: 'hot', message: 'unsupported view' };
      }
      const event = { type: 'open', view };
      if (view === 'search') {
        const query = String(args?.query ?? '').trim();
        if (query === '') return { delivered: false, view, message: 'search needs a query' };
        event.query = query.slice(0, 100);
      }
      if (view === 'reader') {
        const id = normalizeId(args?.questionId);
        if (id === '') return { delivered: false, view, message: 'reader needs a question id' };
        event.questionId = id;
      }
      const delivered = broadcast(event) > 0;
      return {
        delivered,
        view,
        ...(event.query === undefined ? {} : { query: event.query }),
        ...(event.questionId === undefined ? {} : { questionId: event.questionId }),
        ...(delivered ? {} : { message: 'no panel is connected; the command was not applied' }),
      };
    },
  });

  ctx.logger?.info?.('[zhihu-mini] routes ready under ' + PREFIX);

  ctx.effect(() => () => {
    for (const dispose of disposeTools) {
      try {
        dispose();
      } catch {
        /* the registry may already be gone */
      }
    }
    for (const client of [...streamClients]) dropClient(client);
    try {
      disposeRoute();
    } catch {
      /* the route table may already be gone */
    }
  });
}

/**
 * Output schema shared by the three list tools.
 * @returns {object}
 */
function listOutputSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      source: { type: 'string' },
      query: { type: 'string' },
      fetchedAt: { type: 'number' },
      code: { type: 'string' },
      message: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string' },
            title: { type: 'string' },
            excerpt: { type: 'string' },
            heat: { type: 'string' },
            answerCount: { type: 'number' },
            url: { type: 'string' },
          },
        },
      },
    },
    required: ['ok'],
  };
}

/**
 * Tool-facing compaction of a HotItem.
 * @param {any} item
 * @returns {any}
 */
function compactItem(item) {
  return {
    id: String(item.id),
    kind: String(item.kind || 'unknown'),
    title: String(item.title || ''),
    ...(item.excerpt === undefined ? {} : { excerpt: String(item.excerpt).slice(0, 200) }),
    ...(item.heat === undefined ? {} : { heat: String(item.heat) }),
    ...(item.answerCount === undefined ? {} : { answerCount: Number(item.answerCount) }),
    url: String(item.url || ''),
  };
}

/**
 * @param {{ code: string, error: string }} result
 * @returns {object}
 */
function listFailure(result) {
  return {
    ok: false,
    code: String(result.code),
    message: result.code === CODES.loginRequired ? loginHint('this content') : String(result.error),
  };
}

/**
 * Normalize a panel snapshot posted by the client.
 * @param {any} body
 * @returns {object | null}
 */
function normalizePanel(body) {
  if (!body || typeof body !== 'object') return null;
  const views = ['hot', 'feed', 'search', 'reader'];
  const view = views.includes(body.view) ? body.view : 'hot';
  const panel = { view, updatedAt: Date.now() };
  if (typeof body.query === 'string' && body.query !== '') panel.query = body.query.slice(0, 200);
  if (typeof body.questionId === 'string' && normalizeId(body.questionId) !== '') {
    panel.questionId = normalizeId(body.questionId);
  }
  if (typeof body.title === 'string' && body.title !== '') panel.title = body.title.slice(0, 300);
  if (typeof body.answerId === 'string' && body.answerId !== '') panel.answerId = body.answerId.slice(0, 64);
  if (typeof body.selectionText === 'string' && body.selectionText.trim() !== '') {
    panel.selectionText = body.selectionText.slice(0, 1000);
  }
  if (Array.isArray(body.visibleItems)) {
    const items = [];
    for (const entry of body.visibleItems.slice(0, 30)) {
      if (!entry || typeof entry !== 'object') continue;
      const id = String(entry.id == null ? '' : entry.id).slice(0, 64);
      if (id === '') continue;
      items.push({ id, title: String(entry.title == null ? '' : entry.title).slice(0, 200) });
    }
    if (items.length > 0) panel.visibleItems = items;
  }
  return panel;
}

/**
 * One-line orientation hint for the agent.
 * @param {{ view: string, query?: string, questionId?: string, title?: string, updatedAt: number }} panel
 * @param {boolean} loggedIn
 * @param {boolean} connected
 * @returns {string}
 */
function panelHint(panel, loggedIn, connected) {
  const parts = [];
  parts.push('view=' + panel.view);
  if (panel.query) parts.push('query="' + panel.query + '"');
  if (panel.questionId) parts.push('questionId=' + panel.questionId);
  parts.push(loggedIn ? 'logged in' : 'not logged in (reader/search unavailable)');
  parts.push(connected ? 'panel connected' : 'panel not connected');
  if (panel.updatedAt === 0) parts.push('panel has not reported state yet');
  return parts.join('; ');
}

/**
 * Readable login guidance shared by routes and tools.
 * @param {string} feature
 * @returns {string}
 */
function loginHint(feature) {
  return (
    'Zhihu requires a logged-in session for ' +
    feature +
    '. If the panel shows a login card the user can paste the zhihu.com Cookie header ' +
    '(it must include z_c0; SESSIONID alone means the browser is not signed in).'
  );
}

/**
 * @param {string} feature
 * @returns {object}
 */
function loginRequired(feature) {
  return { ok: false, code: CODES.loginRequired, error: loginHint(feature), needsLogin: true };
}

/**
 * @param {any} value
 * @returns {string}
 */
function renderPanel(value) {
  const lines = ['Zhihu panel: ' + value.view];
  if (value.query) lines.push('Query: ' + value.query);
  if (value.title) lines.push('Title: ' + value.title);
  if (value.questionId) lines.push('Question id: ' + value.questionId);
  if (value.selectionText) lines.push('Selected text: ' + value.selectionText);
  if (Array.isArray(value.visibleItems) && value.visibleItems.length > 0) {
    lines.push('Visible cards:');
    for (const item of value.visibleItems.slice(0, 10)) lines.push('- ' + item.title);
  }
  lines.push('Login: ' + (value.loggedIn ? 'yes' : 'no'));
  if (value.hint) lines.push('Hint: ' + value.hint);
  return lines.join('\n');
}

/**
 * @param {any} value
 * @param {string} heading
 * @returns {string}
 */
function renderItems(value, heading) {
  if (value?.ok === false) return heading + ': unavailable — ' + (value.message || value.code || 'unknown');
  const items = Array.isArray(value?.items) ? value.items : [];
  const lines = [heading + ' (' + items.length + ' entries)'];
  for (const item of items.slice(0, 20)) {
    const heat = item.heat ? ' · ' + item.heat : '';
    const answers = item.answerCount === undefined ? '' : ' · ' + item.answerCount + ' answers';
    lines.push('- ' + item.title + heat + answers + '\n  ' + item.url);
  }
  return lines.join('\n');
}

/**
 * @param {any} value
 * @returns {string}
 */
function renderQuestion(value) {
  if (value?.ok === false) return 'Zhihu question: unavailable — ' + (value.message || value.code || 'unknown');
  const question = value?.question ?? {};
  const lines = ['# ' + (question.title || 'Question')];
  if (question.detailText) lines.push(question.detailText);
  lines.push(question.url || '');
  const answers = Array.isArray(value?.answers) ? value.answers : [];
  for (const answer of answers.slice(0, 5)) {
    lines.push('');
    lines.push('## ' + answer.author + ' · ' + answer.voteupCount + ' upvotes');
    lines.push(answer.text || '');
  }
  return lines.join('\n');
}

/**
 * Read a JSON request body with a hard size limit.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<any>}
 */
function readJsonBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const failWith = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        failWith(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text === '' ? {} : JSON.parse(text));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', failWith);
  });
}

/**
 * Remove anything that could leak the stored cookie from a message.
 * @param {unknown} value
 * @returns {string}
 */
function redact(value) {
  return String(value == null ? '' : value)
    .replace(/SESSDATA=[^;\s]+/gi, 'SESSDATA=***')
    .replace(/z_c0=[^;\s]+/gi, 'z_c0=***')
    .replace(/d_c0=[^;\s]+/gi, 'd_c0=***')
    .replace(/SESSIONID=[^;\s]+/gi, 'SESSIONID=***')
    .replace(/_xsrf=[^;\s]+/gi, '_xsrf=***')
    .replace(/JOID=[^;\s]+/gi, 'JOID=***')
    .slice(0, 300);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}
