/**
 * Zhihu data access for dsh-zhihu-mini.
 *
 * Reality verified against the live API:
 *   - https://api.zhihu.com/topstory/hot-list and /topstory/recommend answer
 *     anonymously with a plain desktop UA. They are the only two reliable
 *     anonymous content sources.
 *   - Every question/answer/search read is cookie-gated: www.zhihu.com/api/v4/*
 *     returns 403 { code: 40353, need_login: true } (or 40362 rate-limit,
 *     10003 access-denied) without a logged-in z_c0 session. The HTML question page
 *     is behind a JS challenge that cannot be solved server-side, so it is
 *     never fetched.
 *
 * Therefore every content read is modelled as an outcome, never a throw:
 *   { ok: true, ...data } | { ok: false, code, error, status? }
 * with code in 'login-required' | 'rate-limited' | 'forbidden' | 'not-found' |
 * 'upstream' | 'network' | 'bad-input'. Callers (routes, tools) render the code
 * as a user-facing card; a raw error string never reaches the panel.
 *
 * x-zse-96 signing is implemented but deliberately isolated: the Lead measured
 * that it does not lift the login wall on its own, so it is only attached when
 * a d_c0 cookie exists and never gates any read.
 */
import { createHash } from 'node:crypto';

import { normalizeHttpsUrl, stripTags } from './sanitize.js';

/** Desktop Chrome UA: Zhihu serves the anonymous JSON endpoints with it. */
export const ZHIHU_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 9000;

const API_ORIGIN = 'https://api.zhihu.com';
const WEB_ORIGIN = 'https://www.zhihu.com';

/**
 * Outcome codes shared with index.js and the client.
 * @type {Readonly<Record<string, string>>}
 */
export const CODES = Object.freeze({
  loginRequired: 'login-required',
  rateLimited: 'rate-limited',
  forbidden: 'forbidden',
  notFound: 'not-found',
  upstream: 'upstream',
  network: 'network',
  badInput: 'bad-input',
});

/** Upstream JSON codes that mean "you are not logged in (or barely are)". */
const LOGIN_CODES = new Set([40353, 40362, 10001, 10003, 10004, 101]);
/** Upstream JSON codes that mean "slow down". */
const RATE_CODES = new Set([40362, 429]);

/**
 * Failure outcome.
 * @param {string} code one of CODES
 * @param {string} error human-readable message (English; the panel localizes)
 * @param {number} [status] upstream HTTP status when known
 * @returns {{ ok: false, code: string, error: string, status?: number }}
 */
export function fail(code, error, status) {
  return { ok: false, code, error, ...(status === undefined ? {} : { status }) };
}

/**
 * Serialize a parsed cookie map into a Cookie header value. Values that could
 * break the header are dropped; the result is never logged.
 * @param {Record<string, string>} [cookies]
 * @returns {string}
 */
export function cookieHeader(cookies) {
  if (!cookies || typeof cookies !== 'object') return '';
  return Object.entries(cookies)
    .filter(
      ([name, value]) =>
        typeof name === 'string' &&
        name.length > 0 &&
        /^[A-Za-z0-9_.-]+$/.test(name) &&
        typeof value === 'string' &&
        value.length > 0 &&
        value.length < 4096 &&
        !/[\r\n;]/.test(value),
    )
    .map(([name, value]) => name + '=' + value)
    .join('; ');
}

/**
 * Pull the cookie payload out of the three forms people actually paste:
 *   - a bare `name=value; name=value` list;
 *   - a whole `Cookie: ...` request header;
 *   - a DevTools "Copy as cURL" command, whose `-H 'cookie: ...'` or
 *     `-b '...'` carries the HttpOnly cookies that `document.cookie` hides
 *     (Zhihu's `z_c0` is HttpOnly, so this is usually the only scriptable way).
 * @param {string} input
 * @returns {string} the cookie text, or the input unchanged when no form matches
 */
function extractCookieText(input) {
  const header = input.match(/(?:-H|--header)\s+(['"])\s*cookie\s*:\s*([\s\S]*?)\1/i);
  if (header !== null) return header[2];
  const jar = input.match(/(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/i);
  if (jar !== null) return jar[2];
  return input;
}

/**
 * Merge one response's `Set-Cookie` headers into a mutable jar.
 *
 * Node's fetch exposes them through `getSetCookie()`; only the name=value pair
 * is kept (attributes describe the browser's own storage, not ours).
 * @param {Response} response
 * @param {Record<string, string>} jar mutated in place
 * @returns {string[]} the cookie names that were set, for diagnostics
 */
export function absorbCookies(response, jar) {
  const names = [];
  const header = response?.headers;
  const list = typeof header?.getSetCookie === 'function' ? header.getSetCookie() : [];
  for (const entry of list) {
    const pair = String(entry).split(';')[0] ?? '';
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (name === '' || value === '' || !/^[A-Za-z0-9_.-]+$/.test(name)) continue;
    jar[name] = value;
    names.push(name);
  }
  return names;
}

/**
 * Parse a pasted browser cookie string into a name->value map. Accepts the raw
 * "a=1; b=2" form and the common copied variants (newlines, "Cookie:" prefix).
 * @param {unknown} input
 * @returns {Record<string, string>}
 */
export function parseCookieString(input) {
  if (typeof input !== 'string') return {};
  const text = extractCookieText(input)
    .replace(/^\s*cookie\s*:\s*/i, '')
    .replace(/\r?\n/g, '; ')
    .trim();
  const jar = {};
  const parts = text.split(';');
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index].trim();
    if (part === '') continue;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === '' || value === '') continue;
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) continue;
    if (value.length >= 4096 || /[\r\n;]/.test(value)) continue;
    jar[name] = value;
  }
  return jar;
}

/**
 * Cookie names that can carry a signed-in Zhihu web session.
 *
 * Zhihu is not Bilibili: a signed-in zhihu.com session uses `z_c0`, the auth
 * token, and it is HttpOnly. `SESSIONID` exists on every visitor (signed in or
 * not), `d_c0` is the device id and `_xsrf` the CSRF token. `SESSDATA` is
 * Bilibili's cookie and is accepted only because pasted strings get mixed up.
 */
export const AUTH_COOKIE_NAMES = ['z_c0', 'SESSDATA'];

/**
 * Whether a cookie jar could carry a signed-in Zhihu session.
 *
 * A local fast-fail only: `/api/v4/me` remains the authority, so a forged or
 * stale value still fails validation before it is stored.
 * @param {Record<string, string>} [cookies]
 * @returns {boolean}
 */
export function hasSession(cookies) {
  if (!cookies || typeof cookies !== 'object') return false;
  return AUTH_COOKIE_NAMES.some(
    (name) => typeof cookies[name] === 'string' && cookies[name].length > 0,
  );
}

/**
 * Sorted cookie names in a jar, for diagnostics. Values are never returned.
 * @param {Record<string, string>} [cookies]
 * @returns {string[]}
 */
export function cookieNames(cookies) {
  if (!cookies || typeof cookies !== 'object') return [];
  return Object.keys(cookies).sort();
}

/**
 * Isolated x-zse-96 helper.
 *
 * Zhihu's web client signs requests with md5("101_3_3.0+" + pathAndQuery + "+" +
 * d_c0). The Lead verified that supplying it does not lift the login wall, so
 * this is only attached when a d_c0 cookie happens to exist and must never be
 * relied on. Documented here rather than spread through the client.
 * @param {string} pathAndQuery request path plus query string, starting with "/"
 * @param {string} dc0 the d_c0 cookie value
 * @returns {string} the signature, or an empty string when it cannot be built
 */
export function signZse96(pathAndQuery, dc0) {
  if (typeof pathAndQuery !== 'string' || pathAndQuery === '') return '';
  if (typeof dc0 !== 'string' || dc0 === '') return '';
  const source = '101_3_3.0+' + pathAndQuery + '+' + dc0;
  return '2.0_' + createHash('md5').update(source, 'utf8').digest('hex');
}

/**
 * Map an upstream HTTP status plus parsed body onto an outcome code.
 * @param {number} status
 * @param {any} payload
 * @returns {string} empty string when the response is usable
 */
export function classifyFailure(status, payload) {
  const code = Number(payload?.error?.code ?? payload?.code);
  const needLogin =
    payload?.error?.need_login === true ||
    payload?.need_login === true ||
    payload?.error?.need_login === 1;

  if (needLogin || LOGIN_CODES.has(code)) {
    return RATE_CODES.has(code) && !needLogin ? CODES.rateLimited : CODES.loginRequired;
  }
  if (status === 401) return CODES.loginRequired;
  if (status === 403) {
    return RATE_CODES.has(code) ? CODES.rateLimited : CODES.loginRequired;
  }
  if (status === 429) return CODES.rateLimited;
  if (status === 404) return CODES.notFound;
  if (status >= 500) return CODES.upstream;
  if (status >= 400) return CODES.forbidden;
  if (code !== undefined && !Number.isNaN(code) && code !== 0) {
    return RATE_CODES.has(code) ? CODES.rateLimited : CODES.upstream;
  }
  return '';
}

/**
 * Human-readable text for an outcome code (the panel localizes its own copy).
 * @param {string} code
 * @returns {string}
 */
export function failureText(code) {
  switch (code) {
    case CODES.loginRequired:
      return 'Zhihu requires a logged-in session for this content';
    case CODES.rateLimited:
      return 'Zhihu is rate-limiting this client; try again in a moment';
    case CODES.forbidden:
      return 'Zhihu refused the request';
    case CODES.notFound:
      return 'Not found on Zhihu';
    case CODES.network:
      return 'Could not reach Zhihu';
    case CODES.badInput:
      return 'Invalid request';
    default:
      return 'Zhihu returned an unexpected response';
  }
}


/**
 * Characters that end a JSON number token.
 * @param {string} char
 * @returns {boolean}
 */
function isNumberBoundary(char) {
  return char === ',' || char === '}' || char === ']' || char === ' ' || char === '\n' || char === '\r' || char === '\t';
}

/**
 * Parse a Zhihu JSON body without corrupting large integer ids.
 *
 * Zhihu sends 19-digit question/answer ids as JSON numbers. A plain
 * JSON.parse() reads them as IEEE-754 doubles, so 2103784826771862921 becomes
 * 2103784826771863000 and every subsequent ?id= lookup fails. This scanner
 * walks the raw text, copies string literals untouched, and re-quotes any
 * integer literal of 16 digits or more before handing the document to
 * JSON.parse, so such ids survive as exact decimal strings.
 *
 * Only integer tokens are rewritten: fractional/exponent numbers keep their
 * numeric type (they are timestamps and counters, where double precision is
 * correct).
 *
 * @param {string} text raw response body
 * @returns {any} the parsed payload
 */
export function parseZhihuJson(text) {
  if (typeof text !== 'string') throw new TypeError('body must be a string');
  const threshold = 16;
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    // Copy a string literal verbatim, honoring backslash escapes.
    if (char === '"') {
      let end = index + 1;
      while (end < text.length) {
        const current = text[end];
        if (current === '\\') {
          end += 2;
          continue;
        }
        if (current === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      out += text.slice(index, end);
      index = end;
      continue;
    }
    // A number token outside a string: collect its full extent.
    const startsNumber =
      (char >= '0' && char <= '9') || (char === '-' && text[index + 1] >= '0' && text[index + 1] <= '9');
    if (startsNumber) {
      let end = index + 1;
      while (end < text.length) {
        const current = text[end];
        if (
          (current >= '0' && current <= '9') ||
          current === '.' ||
          current === 'e' ||
          current === 'E' ||
          current === '+' ||
          current === '-'
        ) {
          end += 1;
          continue;
        }
        break;
      }
      const token = text.slice(index, end);
      const isInteger = /^-?\d+$/.test(token);
      const digits = token.replace('-', '').length;
      if (isInteger && digits >= threshold && isNumberBoundary(text[end] === undefined ? '' : text[end])) {
        out += '"' + token + '"';
      } else {
        out += token;
      }
      index = end;
      continue;
    }
    out += char;
    index += 1;
  }
  return JSON.parse(out);
}

/**
 * One JSON request against Zhihu.
 *
 * Never retries a login-required answer; retries a network error or a 5xx once,
 * because those are plausibly transient. The response body is parsed only when
 * the content type is JSON.
 *
 * @param {string} url absolute https URL
 * @param {{ cookies?: Record<string, string>, timeoutMs?: number, retries?: number }} [options]
 * @returns {Promise<{ ok: true, status: number, payload: any, at: number }
 *   | { ok: false, code: string, error: string, status?: number }>}
 */
export async function getZhihuJson(url, { cookies, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1 } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:') {
    return fail(CODES.badInput, 'only https upstreams are allowed');
  }
  const headers = {
    'User-Agent': ZHIHU_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: WEB_ORIGIN + '/',
    Origin: WEB_ORIGIN,
  };
  if (target.hostname === 'api.zhihu.com') headers.Referer = WEB_ORIGIN + '/hot';
  const cookie = cookieHeader(cookies);
  if (cookie !== '') headers.Cookie = cookie;
  // Only attach the signature when the cookie set makes it meaningful.
  //
  // x-zse-93 (the algorithm version) and x-zse-96 (the digest) travel as a PAIR.
  // Measured against the live API: x-zse-96 alone answers 403 / code 10003
  // ("请求参数异常"), while the pair answers 200. Sending neither also works, so
  // the pair is only attached when d_c0 is present to sign with.
  if (cookie !== '' && cookies && typeof cookies.d_c0 === 'string' && cookies.d_c0 !== '') {
    const signature = signZse96(target.pathname + target.search, cookies.d_c0);
    if (signature !== '') {
      headers['x-zse-93'] = '101_3_3.0';
      headers['x-zse-96'] = signature;
    }
  }

  const attempts = Math.max(0, Math.min(3, Number(retries) + 1));
  let lastNetworkError = '';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await fetch(target, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1000, Math.min(30_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))),
      });
    } catch (error) {
      lastNetworkError = String(error?.message || error);
      if (attempt + 1 < attempts) continue;
      return fail(CODES.network, lastNetworkError);
    }

    // Read as text first: parseZhihuJson() re-quotes 19-digit ids so JSON.parse
    // cannot round them through a double. Every upstream reader funnels here.
    let payload = null;
    const contentType = String(response.headers.get('content-type') || '');
    if (contentType.includes('json')) {
      try {
        payload = parseZhihuJson(await response.text());
      } catch {
        payload = null;
      }
    }

    if (response.ok) {
      if (payload === null) {
        return fail(CODES.upstream, 'Zhihu returned a non-JSON response', response.status);
      }
      return { ok: true, status: response.status, payload, at: Date.now() };
    }

    const code = classifyFailure(response.status, payload);
    if (code === CODES.upstream && attempt + 1 < attempts) continue;
    return fail(code, failureText(code), response.status);
  }
  return fail(CODES.network, lastNetworkError || 'request failed');
}

/**
 * Resolve a Zhihu target object into a canonical https URL.
 * @param {any} target
 * @returns {string}
 */
function targetUrl(target) {
  const type = String(target?.type || '').toLowerCase();
  const id = target?.id == null ? '' : String(target.id);
  // The hot/recommend payloads point target.url at api.zhihu.com; the canonical
  // human page is always rebuilt from the type and id.
  if (type === 'question' && id !== '') {
    return 'https://www.zhihu.com/question/' + id;
  }
  if (type === 'answer' && id !== '') {
    return 'https://www.zhihu.com/answer/' + id;
  }
  if (type === 'article' && id !== '') {
    return 'https://zhuanlan.zhihu.com/p/' + id;
  }
  if (type === 'zvideo' && id !== '') {
    return 'https://www.zhihu.com/zvideo/' + id;
  }
  const direct = normalizeHttpsUrl(target?.url);
  if (direct !== '') return direct;
  if (id !== '') return 'https://www.zhihu.com/question/' + id;
  return '';
}

/**
 * Map an upstream target type onto the contract's HotItem kind.
 * @param {any} target
 * @returns {'question'|'article'|'zvideo'|'unknown'}
 */
function itemKind(target) {
  const type = String(target?.type || '').toLowerCase();
  if (type === 'question' || type === 'answer') return 'question';
  if (type === 'article') return 'article';
  if (type === 'zvideo' || type === 'video') return 'zvideo';
  return 'unknown';
}

/**
 * Extract a thumbnail URL from the many shapes Zhihu uses.
 * @param {any} source
 * @returns {string}
 */
function thumbnail(source) {
  const children = Array.isArray(source?.children) ? source.children : [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    const thumb = child?.thumbnail;
    const direct =
      typeof thumb === 'string'
        ? thumb
        : typeof thumb?.url === 'string'
          ? thumb.url
          : typeof child?.thumbnail_url === 'string'
            ? child.thumbnail_url
            : '';
    const safe = normalizeHttpsUrl(direct);
    if (safe !== '') return safe;
  }
  const fallback = source?.target?.thumbnail ?? source?.thumbnail;
  return normalizeHttpsUrl(
    typeof fallback === 'string' ? fallback : typeof fallback?.url === 'string' ? fallback.url : '',
  );
}

/**
 * Normalize one hot-list row into the contract HotItem shape.
 * @param {any} row
 * @returns {any | null}
 */
export function toHotItem(row) {
  if (!row || typeof row !== 'object') return null;
  const target = row.target && typeof row.target === 'object' ? row.target : row;
  const id = target?.id == null ? '' : String(target.id);
  const title = stripTags(target?.title ?? row?.title);
  if (id === '' || title === '') return null;
  const excerpt = stripTags(target?.excerpt ?? row?.excerpt);
  const answerCount = Number(target?.answer_count ?? row?.answer_count);
  const heat = stripTags(row?.detail_text ?? target?.detail_text ?? '');
  const imageUrl = thumbnail(row);
  const created = Number(target?.created ?? row?.created);
  return {
    id,
    kind: itemKind(target),
    title,
    ...(excerpt === '' ? {} : { excerpt }),
    ...(Number.isFinite(answerCount) && answerCount >= 0 ? { answerCount } : {}),
    ...(heat === '' ? {} : { heat }),
    ...(imageUrl === '' ? {} : { imageUrl }),
    url: targetUrl(target) || 'https://www.zhihu.com/question/' + id,
    ...(Number.isFinite(created) && created > 0 ? { created } : {}),
  };
}

/**
 * Normalize one recommendation row into the contract HotItem shape.
 * @param {any} row
 * @returns {any | null}
 */
export function toFeedItem(row) {
  if (!row || typeof row !== 'object') return null;
  const target = row.target && typeof row.target === 'object' ? row.target : row;
  const rawId = target?.id == null ? '' : String(target.id);
  const questionId = target?.question?.id == null ? '' : String(target.question.id);

  // The anonymous recommend feed is mostly answers: the target carries an empty
  // title and the real heading lives on target.question. Point the card at the
  // question (id + url) so the panel can open it in the reader.
  if (String(target?.type || '').toLowerCase() === 'answer' && questionId !== '') {
    const title = stripTags(target?.question?.title);
    if (title === '') return null;
    const excerpt = stripTags(target?.excerpt ?? target?.preview_text ?? '');
    const answerCount = Number(target?.question?.answer_count ?? target?.answer_count);
    const heat = stripTags(target?.author?.name === undefined ? '' : String(target.author.name) + ' 的回答');
    const imageUrl = thumbnail(row) || normalizeHttpsUrl(target?.thumbnail ?? '');
    const created = Number(row?.created_time ?? target?.created_time ?? target?.created);
    return {
      id: questionId,
      kind: 'question',
      title,
      ...(excerpt === '' ? {} : { excerpt: excerpt.slice(0, 300) }),
      // The recommend payload zeroes answer_count/follower_count, so a 0 here
      // means "not disclosed", not "no answers": omit it instead of lying.
      ...(Number.isFinite(answerCount) && answerCount > 0 ? { answerCount } : {}),
      ...(heat === '' ? {} : { heat }),
      ...(imageUrl === '' ? {} : { imageUrl }),
      url: 'https://www.zhihu.com/question/' + questionId,
      ...(rawId === '' ? {} : { answerId: rawId }),
      ...(Number.isFinite(created) && created > 0 ? { created } : {}),
    };
  }

  const id = rawId;
  const title = stripTags(target?.title ?? row?.title);
  if (id === '' || title === '') return null;
  const excerpt = stripTags(target?.excerpt ?? row?.brief ?? row?.excerpt);
  const answerCount = Number(target?.answer_count);
  const heat = stripTags(row?.verb ?? '');
  const imageUrl = thumbnail(row) || normalizeHttpsUrl(target?.image_url ?? '');
  const created = Number(row?.created_time ?? target?.created ?? row?.created);
  return {
    id,
    kind: itemKind(target),
    title,
    ...(excerpt === '' ? {} : { excerpt }),
    ...(Number.isFinite(answerCount) && answerCount >= 0 ? { answerCount } : {}),
    ...(heat === '' ? {} : { heat }),
    ...(imageUrl === '' ? {} : { imageUrl }),
    url: targetUrl(target) || 'https://www.zhihu.com/question/' + id,
    ...(Number.isFinite(created) && created > 0 ? { created } : {}),
  };
}

/**
 * Fetch the anonymous hot list.
 * @param {{ limit?: number, timeoutMs?: number, cookies?: Record<string, string> }} [options]
 * @returns {Promise<{ ok: true, items: any[], fetchedAt: number } | { ok: false, code: string, error: string }>}
 */
export async function fetchHot({ limit = 30, timeoutMs = DEFAULT_TIMEOUT_MS, cookies } = {}) {
  const size = clampInt(limit, 30, 1, 50);
  const url = new URL(API_ORIGIN + '/topstory/hot-list');
  url.searchParams.set('limit', String(size));
  // A stored session makes the list slightly richer; a stale one must not break it.
  const result = await getZhihuJson(url.href, { cookies, timeoutMs });
  if (!result.ok) {
    if (result.code === CODES.loginRequired && !hasSession(cookies)) {
      // The list is anonymous by contract; an anonymous 403 is an upstream
      // regression, not a login prompt.
      return fail(CODES.upstream, result.error, result.status);
    }
    return result;
  }
  const rows = Array.isArray(result.payload?.data) ? result.payload.data : [];
  const mapped = rows.map(toHotItem).filter((entry) => entry !== null);
  if (mapped.length === 0) return fail(CODES.upstream, 'Zhihu returned an empty hot list');
  // /topstory/hot-list ignores the upstream ?limit= and always answers with its
  // fixed payload, so the requested limit is applied here, after normalization.
  const items = mapped.slice(0, size);
  return { ok: true, items, fetchedAt: result.at };
}

/**
 * Fetch the anonymous recommendation feed.
 * @param {{ limit?: number, timeoutMs?: number, cookies?: Record<string, string> }} [options]
 * @returns {Promise<{ ok: true, items: any[], fetchedAt: number } | { ok: false, code: string, error: string }>}
 */
export async function fetchFeed({ limit = 12, timeoutMs = DEFAULT_TIMEOUT_MS, cookies } = {}) {
  const size = clampInt(limit, 12, 1, 30);
  const url = new URL(API_ORIGIN + '/topstory/recommend');
  url.searchParams.set('limit', String(size));
  url.searchParams.set('action', 'down');
  url.searchParams.set('ad_interval', '-1');
  const result = await getZhihuJson(url.href, { cookies, timeoutMs });
  if (!result.ok) {
    if (result.code === CODES.loginRequired && !hasSession(cookies)) {
      return fail(CODES.upstream, result.error, result.status);
    }
    return result;
  }
  const payload = result.payload;
  const rows = Array.isArray(payload?.dataV1)
    ? payload.dataV1
    : Array.isArray(payload?.data)
      ? payload.data
      : [];
  const mapped = rows.map(toFeedItem).filter((entry) => entry !== null);
  if (mapped.length === 0) return fail(CODES.upstream, 'Zhihu returned an empty feed');
  // The recommend endpoint ignores ?limit= and sends a fixed batch (about six
  // rows). The effective limit is therefore min(upstream batch, requested):
  // asking for more than Zhihu sends cannot conjure extra cards, but asking for
  // fewer must be honoured.
  const items = mapped.slice(0, size);
  return { ok: true, items, fetchedAt: result.at };
}

/**
 * Search Zhihu. Cookie-gated: without a session the caller must render the
 * login card instead of retrying.
 * @param {{ query: string, offset?: number, limit?: number, timeoutMs?: number, cookies?: Record<string, string> }} options
 * @returns {Promise<{ ok: true, items: any[], fetchedAt: number } | { ok: false, code: string, error: string }>}
 */
export async function fetchSearch({ query = '', offset = 0, limit = 20, timeoutMs = DEFAULT_TIMEOUT_MS, cookies } = {}) {
  const text = stripTags(query).slice(0, 100);
  if (text === '') return fail(CODES.badInput, 'search needs a non-empty query');
  if (!hasSession(cookies)) return fail(CODES.loginRequired, failureText(CODES.loginRequired));

  const url = new URL(WEB_ORIGIN + '/api/v4/search_v3');
  url.searchParams.set('t', 'general');
  url.searchParams.set('q', text);
  url.searchParams.set('correction', '1');
  url.searchParams.set('offset', String(clampInt(offset, 0, 0, 5000)));
  url.searchParams.set('limit', String(clampInt(limit, 20, 1, 50)));
  url.searchParams.set('filter_fields', '');
  url.searchParams.set('lc_idx', String(clampInt(offset, 0, 0, 5000)));
  url.searchParams.set('show_all_topics', '0');
  const result = await getZhihuJson(url.href, { cookies, timeoutMs });
  if (!result.ok) return result;

  const rows = Array.isArray(result.payload?.data) ? result.payload.data : [];
  const items = [];
  for (let index = 0; index < rows.length; index += 1) {
    const entry = rows[index];
    const object = entry?.object && typeof entry.object === 'object' ? entry.object : null;
    if (object === null || typeof object.type !== 'string') continue;
    const normalized = normalizeSearchObject(object);
    if (normalized !== null) items.push(normalized);
  }
  return { ok: true, items, fetchedAt: result.at };
}

/**
 * Normalize one search result object (answer, article, question, ...).
 * @param {any} object
 * @returns {any | null}
 */
function normalizeSearchObject(object) {
  const type = String(object.type || '').toLowerCase();
  const title = stripTags(object.title ?? object.question?.title ?? '');
  if (title === '') return null;
  const id = object.id == null ? '' : String(object.id);
  const questionId = object.question?.id == null ? '' : String(object.question.id);
  const excerpt = stripTags(object.excerpt ?? object.content ?? '').slice(0, 220);
  const answerCount = Number(object.answer_count);
  const url =
    type === 'answer' && id !== ''
      ? 'https://www.zhihu.com/answer/' + id
      : type === 'article' && id !== ''
        ? 'https://zhuanlan.zhihu.com/p/' + id
        : questionId !== ''
          ? 'https://www.zhihu.com/question/' + questionId
          : normalizeHttpsUrl(object.url);
  if (url === '') return null;
  const heat = stripTags(object.voteup_count != null ? object.voteup_count + ' 赞同' : '');
  return {
    id: id !== '' ? id : questionId,
    kind: type === 'article' ? 'article' : type === 'zvideo' ? 'zvideo' : 'question',
    title,
    ...(excerpt === '' ? {} : { excerpt }),
    ...(Number.isFinite(answerCount) && answerCount >= 0 ? { answerCount } : {}),
    ...(heat === '' ? {} : { heat }),
    url,
    ...(questionId === '' ? {} : { questionId }),
  };
}

/**
 * Fetch one question's metadata plus its top answers. Cookie-gated as a whole.
 * @param {{ questionId: string, answerLimit?: number, timeoutMs?: number, cookies?: Record<string, string> }} options
 * @returns {Promise<{ ok: true, question: any, answers: any[], fetchedAt: number } | { ok: false, code: string, error: string }>}
 */
export async function fetchQuestion({ questionId = '', answerLimit = 5, timeoutMs = DEFAULT_TIMEOUT_MS, cookies } = {}) {
  const id = normalizeId(questionId);
  if (id === '') return fail(CODES.badInput, 'invalid question id');
  if (!hasSession(cookies)) return fail(CODES.loginRequired, failureText(CODES.loginRequired));

  const limit = clampInt(answerLimit, 5, 1, 10);
  const questionUrl = new URL(WEB_ORIGIN + '/api/v4/questions/' + id);
  questionUrl.searchParams.set('include', 'detail,answer_count,follower_count,comment_count,topics,created');
  const answersUrl = new URL(WEB_ORIGIN + '/api/v4/questions/' + id + '/answers');
  answersUrl.searchParams.set('include', 'data[*].content,voteup_count,comment_count,created,updated,author,is_collapsed');
  answersUrl.searchParams.set('limit', String(limit));
  answersUrl.searchParams.set('offset', '0');
  answersUrl.searchParams.set('sort_by', 'default');

  const questionResult = await getZhihuJson(questionUrl.href, { cookies, timeoutMs });
  if (!questionResult.ok) return questionResult;

  // Answers may legitimately be unavailable while the question itself loads:
  // report the question and an empty list rather than failing the whole read.
  const answersResult = await getZhihuJson(answersUrl.href, { cookies, timeoutMs });
  const answers = answersResult.ok ? mapAnswers(answersResult.payload, id) : [];

  return {
    ok: true,
    question: toQuestion(questionResult.payload, id),
    answers,
    ...(answersResult.ok ? {} : { answersCode: answersResult.code }),
    fetchedAt: questionResult.at,
  };
}

/**
 * Normalize a question payload.
 * @param {any} payload
 * @param {string} id
 * @returns {any}
 */
export function toQuestion(payload, id) {
  const topics = Array.isArray(payload?.topics)
    ? payload.topics
        .map((topic) => stripTags(topic?.name))
        .filter((name) => name !== '')
        .slice(0, 10)
    : [];
  const detail = stripTags(payload?.detail ?? payload?.excerpt ?? '');
  return {
    id: payload?.id == null ? id : String(payload.id),
    title: stripTags(payload?.title) || 'Untitled question',
    ...(detail === '' ? {} : { detailText: detail.slice(0, 4000) }),
    answerCount: Number(payload?.answer_count) || 0,
    ...(Number.isFinite(Number(payload?.follower_count)) ? { followerCount: Number(payload.follower_count) } : {}),
    ...(Number.isFinite(Number(payload?.comment_count)) ? { commentCount: Number(payload.comment_count) } : {}),
    ...(Number(payload?.created) > 0 ? { created: Number(payload.created) } : {}),
    url: 'https://www.zhihu.com/question/' + (payload?.id == null ? id : String(payload.id)),
    ...(topics.length === 0 ? {} : { topics }),
  };
}

/**
 * Normalize an answers payload into the contract Answer shape.
 * @param {any} payload
 * @param {string} questionId
 * @returns {any[]}
 */
export function mapAnswers(payload, questionId) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const answers = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || typeof row !== 'object') continue;
    const id = row.id == null ? '' : String(row.id);
    if (id === '') continue;
    answers.push({
      id,
      questionId: row.question?.id == null ? questionId : String(row.question.id),
      author: {
        name: stripTags(row.author?.name) || '匿名用户',
        ...(stripTags(row.author?.headline) === '' ? {} : { headline: stripTags(row.author.headline) }),
        ...(typeof row.author?.url_token === 'string' && row.author.url_token !== ''
          ? { url: 'https://www.zhihu.com/people/' + row.author.url_token }
          : {}),
      },
      voteupCount: Number(row.voteup_count) || 0,
      commentCount: Number(row.comment_count) || 0,
      ...(Number(row.created) > 0 ? { created: Number(row.created) } : {}),
      ...(Number(row.updated_time ?? row.updated) > 0
        ? { updated: Number(row.updated_time ?? row.updated) }
        : {}),
      contentHtml: typeof row.content === 'string' ? row.content : '',
      contentText: '',
      url: 'https://www.zhihu.com/question/' + (row.question?.id == null ? questionId : String(row.question.id)) + '/answer/' + id,
      ...(row.is_collapsed === true ? { isCollapsed: true } : {}),
    });
  }
  return answers;
}

/**
 * Where the web client creates and polls a sign-in QR code.
 *
 * Measured from the live sign-in page: the browser
 *   POST /api/v3/account/api/login/qrcode                   -> { link, token, expires_at }
 *   GET  /api/v3/account/api/login/qrcode/<token>/scan_info  -> { status }
 * and both calls carry the `d_c0` device cookie plus the x-zse-93/96 pair and
 * `x-xsrftoken`. The POST is refused for a jar that is already signed in, and a
 * *synthesized* `d_c0` answers 400 — the server validates the value it issued.
 * That is why the caller supplies the stored device id instead of inventing one.
 */
export const LOGIN_QR_PATH = '/api/v3/account/api/login/qrcode';

/** `scan_info.status` values observed on the web client. */
export const QR_STATUS = { waiting: 0, scanned: 1, confirmed: 2, expired: 3, cancelled: 4 };

/**
 * Start a sign-in QR session.
 *
 * A fresh jar is warmed from the sign-in page (`_zap`, `_xsrf`, `BEC`) and then
 * gets the supplied genuine device id, so the request is signed with a `d_c0`
 * the server accepts. The caller must keep the returned jar: polling and the
 * cookies set at confirmation only mean anything against the same jar.
 *
 * @param {{ deviceId?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true, token: string, link: string, expiresAt: number, jar: Record<string, string> }
 *   | { ok: false, code: string, error: string }>}
 */
export async function createLoginQr({ deviceId = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const device = typeof deviceId === 'string' ? deviceId.trim() : '';
  if (device === '') return fail(CODES.loginRequired, 'no Zhihu device cookie yet');
  const budget = Math.max(1000, Math.min(30_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  const jar = {};
  try {
    const warm = await fetch(WEB_ORIGIN + '/signin', {
      headers: { 'User-Agent': ZHIHU_UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'error',
      signal: AbortSignal.timeout(budget),
    });
    absorbCookies(warm, jar);
  } catch (error) {
    return fail(CODES.network, String(error?.message || error));
  }
  jar.d_c0 = device;
  const headers = {
    'User-Agent': ZHIHU_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: WEB_ORIGIN + '/signin',
    Origin: WEB_ORIGIN,
    Cookie: cookieHeader(jar),
    'x-requested-with': 'fetch',
  };
  const signature = signZse96(LOGIN_QR_PATH, device);
  if (signature !== '') {
    headers['x-zse-93'] = '101_3_3.0';
    headers['x-zse-96'] = signature;
  }
  if (typeof jar._xsrf === 'string' && jar._xsrf !== '') headers['x-xsrftoken'] = jar._xsrf;
  let response;
  try {
    response = await fetch(WEB_ORIGIN + LOGIN_QR_PATH, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(budget),
    });
  } catch (error) {
    return fail(CODES.network, String(error?.message || error));
  }
  absorbCookies(response, jar);
  let payload = null;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    payload = null;
  }
  if (!response.ok || payload === null || typeof payload.link !== 'string' || typeof payload.token !== 'string') {
    return fail(classifyFailure(response.status, payload) || CODES.upstream, 'Zhihu refused to create a sign-in QR');
  }
  const expiresAt = Number(payload.expires_at);
  return {
    ok: true,
    token: payload.token,
    link: payload.link,
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt * 1000 : Date.now() + 120_000,
    jar,
  };
}

/**
 * Poll one sign-in QR session against the jar that created it.
 *
 * Every response may add cookies, and the ones set when the phone approves are
 * the session itself; a jar holding `z_c0` therefore means confirmed even if the
 * numeric status lags behind.
 *
 * @param {{ token: string, jar: Record<string, string>, timeoutMs?: number }} options
 * @returns {Promise<{ ok: true, state: 'waiting'|'scanned'|'confirmed'|'expired', jar: Record<string, string> }
 *   | { ok: false, code: string, error: string }>}
 */
export async function pollLoginQr({ token = '', jar = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const sessionToken = typeof token === 'string' ? token : '';
  if (sessionToken === '' || !/^[A-Za-z0-9_-]+$/.test(sessionToken)) {
    return fail(CODES.badInput, 'invalid QR session token');
  }
  const cookies = jar && typeof jar === 'object' ? jar : {};
  let response;
  try {
    response = await fetch(
      WEB_ORIGIN + LOGIN_QR_PATH + '/' + encodeURIComponent(sessionToken) + '/scan_info',
      {
        headers: {
          'User-Agent': ZHIHU_UA,
          Accept: 'application/json, text/plain, */*',
          Referer: WEB_ORIGIN + '/signin',
          Cookie: cookieHeader(cookies),
          'x-requested-with': 'fetch',
        },
        signal: AbortSignal.timeout(Math.max(1000, Math.min(30_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))),
      },
    );
  } catch (error) {
    return fail(CODES.network, String(error?.message || error));
  }
  absorbCookies(response, cookies);
  let payload = null;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    payload = null;
  }
  if (!response.ok || payload === null) {
    return fail(classifyFailure(response.status, payload) || CODES.upstream, 'QR session could not be polled');
  }
  if (hasSession(cookies)) return { ok: true, state: 'confirmed', jar: cookies };
  const status = Number(payload.status);
  if (status === QR_STATUS.expired || status === QR_STATUS.cancelled) return { ok: true, state: 'expired', jar: cookies };
  if (status === QR_STATUS.confirmed) return { ok: true, state: 'confirmed', jar: cookies };
  if (status === QR_STATUS.scanned) return { ok: true, state: 'scanned', jar: cookies };
  return { ok: true, state: 'waiting', jar: cookies };
}

/**
 * Fetch the logged-in user's profile. Doubles as cookie validation: only an
 * HTTP 200 with a JSON object carrying a name is accepted.
 * @param {{ cookies: Record<string, string>, timeoutMs?: number }} options
 * @returns {Promise<{ ok: true, user: { name: string, headline?: string, avatarUrl?: string } } | { ok: false, code: string, error: string }>}
 */
export async function fetchCurrentUser({ cookies, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!hasSession(cookies)) return fail(CODES.loginRequired, failureText(CODES.loginRequired));
  const url = new URL(WEB_ORIGIN + '/api/v4/me');
  url.searchParams.set('include', 'name,headline,avatar_url,url_token');
  const result = await getZhihuJson(url.href, { cookies, timeoutMs, retries: 0 });
  if (!result.ok) return result;
  const payload = result.payload;
  const name = stripTags(payload?.name);
  if (name === '') return fail(CODES.loginRequired, 'cookie invalid or expired', result.status);
  const headline = stripTags(payload?.headline);
  const avatarUrl = normalizeHttpsUrl(payload?.avatar_url);
  // url_token is the handle in a profile URL; without it the account card has
  // no way to link back to the person the panel is showing.
  const token = typeof payload?.url_token === 'string' ? payload.url_token.trim() : '';
  const profileUrl = /^[A-Za-z0-9_-]{1,64}$/.test(token)
    ? 'https://www.zhihu.com/people/' + token
    : '';
  return {
    ok: true,
    user: {
      name,
      ...(headline === '' ? {} : { headline }),
      ...(avatarUrl === '' ? {} : { avatarUrl }),
      ...(profileUrl === '' ? {} : { profileUrl }),
    },
  };
}

/**
 * @param {unknown} value
 * @returns {string} a safe Zhihu numeric id, or an empty string
 */
export function normalizeId(value) {
  const text = typeof value === 'number' ? String(value) : String(value == null ? '' : value).trim();
  // Zhihu question/answer ids are 19-digit integers, far beyond
  // Number.MAX_SAFE_INTEGER. Validate the decimal string itself and return it
  // verbatim: running it through Number() would round it (…921 -> …000) and
  // Number.isSafeInteger() would reject every real id as "invalid input".
  if (!/^[1-9]\d{0,19}$/.test(text)) return '';
  return text;
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampInt(value, fallback, min, max) {
  // A missing query parameter arrives as null, and Number(null) is 0 -- which is
  // finite, so a naive check clamps an absent limit down to min instead of using
  // the documented default. Treat the empty forms as absent explicitly.
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.trunc(number), min), max);
}
