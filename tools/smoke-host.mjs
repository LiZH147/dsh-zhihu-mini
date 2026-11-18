#!/usr/bin/env node
/**
 * Fixture-based smoke test for the dsh-zhihu-mini Host half.
 *
 * No network access: every helper is exercised against recorded JSON shapes
 * (copied from live responses) so the test is deterministic and offline.
 *
 * Run: node tools/smoke-host.mjs
 */
import assert from 'node:assert/strict';
import os from 'node:os';

import { sanitizeHtml, stripTags, toPlainText, normalizeHttpsUrl } from '../plugin/sanitize.js';
import { isTrustedRequest, isTrustedLoopbackRequest, isLoopbackHostname } from '../plugin/trust.js';
import {
  classifyFailure,
  clampInt,
  cookieHeader,
  hasSession,
  mapAnswers,
  normalizeId,
  parseCookieString,
  parseZhihuJson,
  signZse96,
  toFeedItem,
  toHotItem,
  toQuestion,
  CODES,
} from '../plugin/zhihu.js';

let checks = 0;

/**
 * @param {string} label
 * @param {() => void} body
 */
function test(label, body) {
  try {
    body();
    checks += 1;
    console.log('ok   ' + label);
  } catch (error) {
    console.error('FAIL ' + label);
    throw error;
  }
}

/* ---------------------------------------------------------------- sanitizer */

test('sanitizer keeps allowlisted markup', () => {
  const html = '<p>Hello <strong>world</strong><br><a href="https://www.zhihu.com/x">link</a></p>';
  const out = sanitizeHtml(html);
  assert.equal(out, '<p>Hello <strong>world</strong><br><a href="https://www.zhihu.com/x" rel="nofollow noopener noreferrer" target="_blank">link</a></p>');
});

test('sanitizer drops scripts with their content', () => {
  const out = sanitizeHtml('<p>a</p><script>alert(1)</script><p>b</p>');
  assert.equal(out, '<p>a</p><p>b</p>');
});

test('sanitizer drops style blocks and event handlers', () => {
  const out = sanitizeHtml('<style>p{color:red}</style><p onclick="evil()" class="x">safe</p>');
  assert.equal(out, '<p>safe</p>');
});

test('sanitizer refuses javascript: and http image sources', () => {
  assert.equal(sanitizeHtml('<a href="javascript:alert(1)">x</a>'), '<a rel="nofollow noopener noreferrer" target="_blank">x</a>');
  assert.equal(sanitizeHtml('<img src="http://a/b.png">'), '<img>');
  assert.equal(sanitizeHtml('<img src="https://pic1.zhimg.com/a.png" alt="a">'), '<img src="https://pic1.zhimg.com/a.png" alt="a">');
});

test('sanitizer drops unknown tags but keeps inner text', () => {
  assert.equal(sanitizeHtml('<div>kept<custom>x</custom></div>'), 'keptx');
});

test('sanitizer escapes stray angle brackets', () => {
  assert.equal(sanitizeHtml('a < b && c > d'), 'a &lt; b && c &gt; d');
});

test('sanitizer survives unterminated input', () => {
  assert.equal(sanitizeHtml('<p>open'), '<p>open');
  assert.equal(sanitizeHtml('text <b'), 'text &lt;b');
});

test('plain-text projection removes markup', () => {
  assert.equal(toPlainText('<p>one</p><p>two &amp; three</p>'), 'one two & three');
  assert.equal(stripTags('<b>知乎</b> 热榜'), '知乎 热榜');
});

test('url normalization forces https and rejects junk', () => {
  assert.equal(normalizeHttpsUrl('http://www.zhihu.com/a'), 'https://www.zhihu.com/a');
  assert.equal(normalizeHttpsUrl('/question/1'), 'https://www.zhihu.com/question/1');
  assert.equal(normalizeHttpsUrl('javascript:alert(1)'), '');
  assert.equal(normalizeHttpsUrl(''), '');
});

/* ------------------------------------------------------------------- trust */

const loopbackReq = (headers) => ({ headers });

test('trust fence accepts a loopback host', () => {
  assert.equal(isTrustedRequest(loopbackReq({ host: '127.0.0.1:62154' })), true);
  assert.equal(isTrustedRequest(loopbackReq({ host: 'localhost:62154' })), true);
  assert.equal(isTrustedLoopbackRequest(loopbackReq({ host: '[::1]:62154' })), true);
});

test('trust fence rejects non-loopback hosts and cross-site markers', () => {
  assert.equal(isTrustedRequest(loopbackReq({ host: 'evil.example.com' })), false);
  assert.equal(isTrustedRequest(loopbackReq({ host: '127.0.0.1:62154', 'sec-fetch-site': 'cross-site' })), false);
  assert.equal(isTrustedRequest(loopbackReq({ host: '127.0.0.1:62154', origin: 'https://evil.example.com' })), false);
  assert.equal(isTrustedRequest(loopbackReq({ host: '127.0.0.1:62154', origin: 'http://localhost:62154' })), true);
});

test('trust fence tolerates absent browser markers', () => {
  assert.equal(isTrustedRequest(loopbackReq({ host: '127.0.0.1:62154' })), true);
  assert.equal(isLoopbackHostname('127.0.0.1'), true);
  // All of 127/8 is loopback by definition.
  assert.equal(isLoopbackHostname('127.1.0.0'), true);
  assert.equal(isLoopbackHostname('128.0.0.1'), false);
});

/* ------------------------------------------------------- cookie handling */

test('cookie parsing accepts browser paste formats', () => {
  const jar = parseCookieString('Cookie: SESSDATA=abc%3D; z_c0=xyz\n d_c0=token=');
  assert.equal(jar.SESSDATA, 'abc%3D');
  assert.equal(jar.z_c0, 'xyz');
  assert.equal(jar.d_c0, 'token=');
});

test('cookie parsing rejects header-breaking names and values', () => {
  const jar = parseCookieString('bad name=1; ok=2; inj=3\r\nX: y');
  assert.equal(jar.ok, '2');
  assert.equal(Object.keys(jar).includes('bad name'), false);
});

test('cookie header round-trips and never leaks empty entries', () => {
  assert.equal(cookieHeader({ SESSDATA: 'a', z_c0: '' }), 'SESSDATA=a');
  assert.equal(cookieHeader({}), '');
  assert.equal(hasSession({ SESSDATA: 'a' }), true);
  assert.equal(hasSession({}), false);
});

test('x-zse-96 helper is deterministic and isolated', () => {
  const signature = signZse96('/api/v4/questions/1?x=2', 'dc0value');
  assert.match(signature, /^2\.0_[0-9a-f]{32}$/);
  assert.equal(signature, signZse96('/api/v4/questions/1?x=2', 'dc0value'));
  assert.equal(signZse96('/api/v4/questions/1', ''), '');
});

/* ------------------------------------------------------- failure mapping */

test('login and rate-limit codes map to first-class outcomes', () => {
  assert.equal(classifyFailure(403, { error: { code: 40353, need_login: true } }), CODES.loginRequired);
  assert.equal(classifyFailure(403, { code: 40362 }), CODES.rateLimited);
  assert.equal(classifyFailure(403, { code: 10003 }), CODES.loginRequired);
  assert.equal(classifyFailure(401, {}), CODES.loginRequired);
  assert.equal(classifyFailure(429, {}), CODES.rateLimited);
  assert.equal(classifyFailure(404, {}), CODES.notFound);
  assert.equal(classifyFailure(500, {}), CODES.upstream);
  assert.equal(classifyFailure(200, { data: [] }), '');
});

/* ------------------------------------------------------- hot/feed parsing */

// Zhihu sends 19-digit ids as JSON *numbers*. This fixture keeps the literal
// digits in raw text, exactly like the wire, so the test proves the parser
// preserves them instead of silently rounding through a double.
const BIG_ID = '2103784826771862921';
const HOT_FIXTURE_RAW =
  '{"data":[' +
  '{"type":"hot_list_feed","id":"0_1","card_id":"Q_1","target":{' +
  '"id":' + BIG_ID + ',' +
  '"title":"如何看待 <em>远程办公</em> 成为常态？",' +
  '"url":"https://api.zhihu.com/questions/' + BIG_ID + '",' +
  '"type":"question","created":1700000000,"answer_count":421,' +
  '"follower_count":9001,"comment_count":12,' +
  '"excerpt":"越来越多公司开始尝试远程办公……","author":{"name":"某人"}},' +
  '"detail_text":"1234 万热度","trend":0,' +
  '"children":[{"type":"answer","thumbnail":"https://pic1.zhimg.com/v2-thumb.jpg"}]},' +
  '{"type":"hot_list_feed","id":"0_2","target":{' +
  '"id":9,"title":"一篇文章","type":"article","url":"https://zhuanlan.zhihu.com/p/9"},' +
  '"detail_text":""},' +
  '{"type":"hot_list_feed","id":"0_3","target":{' +
  '"id":246810,"title":"第三条热榜","type":"question","answer_count":7},' +
  '"detail_text":"99 万热度"},' +
  '{"type":"hot_list_feed","target":{"id":3,"title":""}}' +
  ']}';
const HOT_FIXTURE = parseZhihuJson(HOT_FIXTURE_RAW);

test('hot rows normalize into contract HotItem shape', () => {
  const items = HOT_FIXTURE.data.map(toHotItem).filter((item) => item !== null);
  assert.equal(items.length, 3);
  // The 19-digit id must survive byte-for-byte: JSON.parse alone would yield
  // '2103784826771863000' here.
  assert.equal(items[0].id, BIG_ID);
  assert.equal(items[0].url, 'https://www.zhihu.com/question/' + BIG_ID);
  assert.equal(items[0].kind, 'question');
  assert.equal(items[0].title, '如何看待 远程办公 成为常态？');
  assert.equal(items[0].answerCount, 421);
  assert.equal(items[0].heat, '1234 万热度');
  assert.equal(items[0].imageUrl, 'https://pic1.zhimg.com/v2-thumb.jpg');
  assert.equal(items[1].kind, 'article');
  assert.equal(items[1].url, 'https://zhuanlan.zhihu.com/p/9');
});

const FEED_FIXTURE = {
  dataV1: [
    {
      id: 'feed-1',
      type: 'feed',
      verb: '关注了问题',
      created_time: 1700001111,
      target: {
        id: 987654,
        title: '为什么冬天的被窝这么舒服？',
        type: 'question',
        excerpt: '物理学与心理学解释',
        answer_count: 88,
      },
    },
    {
      id: '0_1794579728.126',
      type: 'feed',
      target: {
        id: '2103212638515864306',
        type: 'answer',
        title: '',
        excerpt: '这是真实 recommend 行的形状：标题在 question 上',
        question: { id: 13683755925, title: '真实的推荐问题标题' },
        author: { name: '答主甲' },
        created_time: 1794579728,
      },
    },
    { id: 'feed-2', type: 'feed', target: { id: 1, title: '', type: 'question' } },
  ],
};

test('feed rows normalize into contract HotItem shape', () => {
  const items = FEED_FIXTURE.dataV1.map(toFeedItem).filter((item) => item !== null);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, '987654');
  assert.equal(items[0].excerpt, '物理学与心理学解释');
  assert.equal(items[0].answerCount, 88);
  assert.equal(items[0].heat, '关注了问题');
  assert.equal(items[0].url, 'https://www.zhihu.com/question/987654');
  // Real recommend rows are answers: the card must point at the question.
  assert.equal(items[1].id, '13683755925');
  assert.equal(items[1].kind, 'question');
  assert.equal(items[1].title, '真实的推荐问题标题');
  assert.equal(items[1].url, 'https://www.zhihu.com/question/13683755925');
  assert.equal(items[1].heat, '答主甲 的回答');
  // A zeroed counter in the recommend payload must not surface as "0 answers".
  assert.equal(items[1].answerCount, undefined);
});

/* ------------------------------------------------- question/answer parsing */

const QUESTION_FIXTURE = {
  id: 987654,
  title: '为什么冬天的被窝这么舒服？',
  detail: '<p>认真提问</p>',
  answer_count: 88,
  follower_count: 1024,
  comment_count: 7,
  created: 1600000000,
  topics: [{ name: '物理' }, { name: '生活' }],
};

const ANSWERS_FIXTURE = {
  data: [
    {
      id: 555,
      question: { id: 987654 },
      author: { name: '答主', headline: '睡眠研究者', url_token: 'someone' },
      voteup_count: 3300,
      comment_count: 21,
      created: 1610000000,
      updated_time: 1610000100,
      content: '<p onclick="x()">正文</p><script>alert(1)</script><img src="https://pic1.zhimg.com/a.jpg">',
      is_collapsed: false,
    },
  ],
};

test('question payload normalizes with topics and counts', () => {
  const question = toQuestion(QUESTION_FIXTURE, '987654');
  assert.equal(question.id, '987654');
  assert.equal(question.answerCount, 88);
  assert.equal(question.followerCount, 1024);
  assert.deepEqual(question.topics, ['物理', '生活']);
  assert.equal(question.url, 'https://www.zhihu.com/question/987654');
});

test('answers normalize and sanitize into the contract shape', () => {
  const answers = mapAnswers(ANSWERS_FIXTURE, '987654').map((answer) => ({
    ...answer,
    contentHtml: sanitizeHtml(answer.contentHtml),
    contentText: toPlainText(answer.contentHtml),
  }));
  assert.equal(answers.length, 1);
  assert.equal(answers[0].id, '555');
  assert.equal(answers[0].author.name, '答主');
  assert.equal(answers[0].author.headline, '睡眠研究者');
  assert.equal(answers[0].voteupCount, 3300);
  assert.equal(answers[0].url, 'https://www.zhihu.com/question/987654/answer/555');
  assert.equal(answers[0].contentHtml, '<p>正文</p><img src="https://pic1.zhimg.com/a.jpg">');
  assert.equal(answers[0].contentText, '正文');
});

/* ---------------------------------------------------------------- helpers */

test('parseZhihuJson preserves 19-digit ids as exact strings', () => {
  const parsed = parseZhihuJson('{"id":2103784826771862921,"n":1,"f":1.5,"e":1e10}');
  assert.equal(parsed.id, '2103784826771862921');
  assert.equal(parsed.n, 1);
  assert.equal(parsed.f, 1.5);
  // Number tokens inside string literals must never be rewritten.
  const nested = parseZhihuJson('{"text":"id:2103784826771862921,","id":2103784826771862921}');
  assert.equal(nested.text, 'id:2103784826771862921,');
  assert.equal(nested.id, '2103784826771862921');
  // Escaped quotes inside strings must not desynchronize the scanner.
  const escaped = parseZhihuJson('{"q":"say \\"hi\\" 2103784826771862921","id":2103784826771862921}');
  assert.equal(escaped.id, '2103784826771862921');
});

test('clampInt treats an absent parameter as absent, not as zero', () => {
  // URLSearchParams.get() returns null for a missing parameter, and Number(null)
  // is 0 -- a regression that made every defaulted route return one item.
  assert.equal(clampInt(null, 30, 1, 50), 30);
  assert.equal(clampInt(undefined, 30, 1, 50), 30);
  assert.equal(clampInt('', 30, 1, 50), 30);
  assert.equal(clampInt('0', 30, 1, 50), 1);
  assert.equal(clampInt('7', 30, 1, 50), 7);
  assert.equal(clampInt('abc', 30, 1, 50), 30);
  assert.equal(clampInt(0, 30, 1, 50), 1);
});

test('id and limit normalization rejects junk', () => {
  assert.equal(normalizeId('123456'), '123456');
  assert.equal(normalizeId('12.5'), '');
  assert.equal(normalizeId('-1'), '');
  assert.equal(normalizeId('../../etc'), '');
  assert.equal(clampInt('abc', 7, 1, 10), 7);
  assert.equal(clampInt(999, 7, 1, 10), 10);
});

/* ------------------------------------------------------- module load check */

const indexModule = await import('../plugin/index.js');
assert.equal(typeof indexModule.apply, 'function');
assert.equal(indexModule.name, 'dsh-zhihu-mini');
assert.deepEqual(indexModule.inject, ['webServer', 'tools']);
checks += 1;
console.log('ok   host modules load as ESM and expose apply()');

/* --------------------------------------------------- host integration ---- */

const http = await import('node:http');
const fs = await import('node:fs');
const path = await import('node:path');

/** Keywords the DSH tool registry accepts in a schema (its enforced subset). */
const SCHEMA_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);

/**
 * Fail on any keyword the registry's assertSupportedJsonSchema() would reject,
 * so a schema mistake is caught here instead of at registration time.
 * @param {any} schema
 * @param {string} where
 */
function assertRegistrySchema(schema, where) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(where + ' must be a schema object');
  }
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) throw new Error(where + '.' + key + ' is not a supported schema keyword');
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((entry) => typeof entry !== 'string')) {
      throw new Error(where + '.required must be an array of strings');
    }
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new Error(where + '.enum must be a non-empty array');
  }
  for (const [key, child] of Object.entries(schema.properties || {})) {
    assertRegistrySchema(child, where + '.properties.' + key);
  }
  if (schema.items !== undefined) assertRegistrySchema(schema.items, where + '.items');
}

/** Minimal validator for the supported JSON-Schema subset, mirroring the registry. */
function validateSchema(schema, value, where) {
  const at = where || 'value';
  const violations = [];
  if (schema === undefined) return violations;
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [at + ' must be an object'];
    }
    for (const key of schema.required || []) {
      if (!(key in value)) violations.push(at + '.' + key + ' is required');
    }
    for (const key of Object.keys(schema.properties || {})) {
      if (value[key] === undefined) continue;
      violations.push(...validateSchema(schema.properties[key], value[key], at + '.' + key));
    }
    return violations;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [at + ' must be an array'];
    if (schema.items !== undefined) {
      value.forEach((entry, i) => {
        violations.push(...validateSchema(schema.items, entry, at + '[' + i + ']'));
      });
    }
    return violations;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return [at + ' must be a string'];
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) violations.push(at + ' is not in the enum');
    return violations;
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(at + ' must be finite');
    return violations;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') violations.push(at + ' must be a boolean');
    return violations;
  }
  if (value === undefined) violations.push(at + ' is undefined');
  return violations;
}

const jsonResponse = (payload, status) =>
  new Response(JSON.stringify(payload), {
    status: status === undefined ? 200 : status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const SEARCH_FIXTURE = {
  data: [
    {
      type: 'search_result',
      object: {
        type: 'answer',
        id: 777,
        title: '搜索到的回答标题',
        excerpt: '回答摘要内容',
        voteup_count: 42,
        answer_count: 3,
        question: { id: 987654, title: '问题' },
      },
    },
    { type: 'search_result', object: { type: 'topic', id: 1, name: '话题' } },
  ],
};

const callLog = [];
globalThis.fetch = async (input) => {
  const href = typeof input === 'string' ? input : String(input);
  const url = new URL(href);
  callLog.push(url.hostname + url.pathname + url.search);
  if (url.hostname === 'api.zhihu.com' && url.pathname === '/topstory/hot-list') {
    // Raw text, exactly like Zhihu: a 19-digit id literal.
    return new Response(HOT_FIXTURE_RAW, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  if (url.hostname === 'www.zhihu.com' && url.pathname === '/api/v4/questions/' + BIG_ID) {
    return new Response(
      '{"id":' + BIG_ID + ',"title":"19 位 id 的问题","detail":"<p>正文</p>",' +
        '"answer_count":5,"follower_count":2,"topics":[{"name":"测试"}]}',
      { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } },
    );
  }
  if (url.hostname === 'www.zhihu.com' && url.pathname === '/api/v4/questions/' + BIG_ID + '/answers') {
    return new Response('{"data":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  if (url.hostname === 'api.zhihu.com' && url.pathname === '/topstory/recommend') {
    return jsonResponse(FEED_FIXTURE);
  }
  if (url.hostname === 'www.zhihu.com' && url.pathname === '/api/v4/me') {
    return jsonResponse({
      name: '测试用户',
      headline: '知乎用户',
      avatar_url: 'https://pic1.zhimg.com/avatar.png',
    });
  }
  if (url.hostname === 'www.zhihu.com' && url.pathname === '/api/v4/search_v3') {
    return jsonResponse(SEARCH_FIXTURE);
  }
  if (url.hostname === 'www.zhihu.com' && url.pathname === '/api/v4/questions/987654') {
    return jsonResponse(QUESTION_FIXTURE);
  }
  if (url.hostname === 'www.zhihu.com' && url.pathname === '/api/v4/questions/987654/answers') {
    return jsonResponse(ANSWERS_FIXTURE);
  }
  return jsonResponse({ error: { code: 40353, need_login: true } }, 403);
};

const toolDefs = new Map();
const fakeCtx = {
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  webServer: {
    register(options) {
      fakeCtx.__route = options;
      return () => {
        fakeCtx.__route = undefined;
      };
    },
  },
  tools: {
    register(definition) {
      toolDefs.set(definition.name, definition);
      return () => toolDefs.delete(definition.name);
    },
  },
  effect(fn) {
    const disposer = fn();
    fakeCtx.__dispose = typeof disposer === 'function' ? disposer : undefined;
    return () => {};
  },
};

indexModule.apply(fakeCtx, { feedSize: 20, cacheTtlMs: 60000 });
assert.ok(fakeCtx.__route, 'route registered inside apply()');
assert.equal(fakeCtx.__route.kind, 'prefix');
assert.equal(fakeCtx.__route.path, '/zhihu-mini');

const server = http.createServer((req, res) => fakeCtx.__route.handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

function request(pathname, options) {
  const opts = options || {};
  const headers = Object.assign(
    opts.body === undefined ? {} : { 'content-type': 'application/json' },
    opts.headers || {},
  );
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: opts.method || 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    if (opts.body === undefined) req.end();
    else req.end(JSON.stringify(opts.body));
  });
}

async function runTool(name, args) {
  const definition = toolDefs.get(name);
  assert.ok(definition, 'tool ' + name + ' is registered');
  const violations = validateSchema(definition.parameters, args, 'args');
  assert.deepEqual(violations, [], name + ' parameters: ' + violations.join('; '));
  const value = await definition.execute(args, { signal: AbortSignal.timeout(20000) });
  const outputViolations = validateSchema(definition.output.schema, value, 'value');
  assert.deepEqual(
    outputViolations,
    [],
    name + ' output does not match its declared schema: ' + outputViolations.join('; '),
  );
  const rendered = definition.output.render(args, value);
  assert.ok(Array.isArray(rendered) && rendered.length > 0, name + ' render returns content');
  for (const part of rendered) assert.equal(part.type, 'text');
  return value;
}

/**
 * Remove any stored session so the test starts from the anonymous state.
 *
 * The scratch directory is passed to the plugin through `ZHIHU_MINI_DATA_DIR`
 * (see store.js): resetting the real `plugin/data/` would sign the user out.
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-mini-smoke-'));
process.env.ZHIHU_MINI_DATA_DIR = dataDir;
function resetData() {
  try {
    fs.rmSync(path.join(dataDir, 'credentials.json'), { force: true });
    fs.rmSync(path.join(dataDir, 'panel.json'), { force: true });
    fs.rmSync(path.join(dataDir, 'cache.json'), { force: true });
  } catch {
    /* nothing to reset */
  }
}
resetData();

try {
  /* ---------------------------------------------------- anonymous routes */

  const hot = await request('/zhihu-mini/api/hot?limit=10');
  assert.equal(hot.status, 200);
  assert.equal(hot.json.ok, true);
  assert.equal(hot.json.source, 'hot');
  assert.equal(hot.json.items.length, 3);
  assert.equal(typeof hot.json.fetchedAt, 'number');
  checks += 1;
  console.log('ok   GET /api/hot serves the anonymous hot list');

  // Zhihu ignores the upstream ?limit=, so the route must apply it locally.
  // The id the panel clicks must be the id the route hands back.
  assert.equal(hot.json.items[0].id, BIG_ID);
  checks += 1;
  console.log('ok   GET /api/hot preserves the exact 19-digit id ' + BIG_ID);

  // No limit parameter at all: the documented default must apply, not size 1.
  const hotDefaultRoute = await request('/zhihu-mini/api/hot?refresh=1');
  assert.equal(hotDefaultRoute.json.ok, true);
  assert.ok(hotDefaultRoute.json.items.length > 1, 'absent hot limit must use the default, not clamp to 1');
  assert.equal(hotDefaultRoute.json.items.length, 3);
  checks += 1;
  console.log('ok   GET /api/hot without ?limit uses the default (3 fixture rows)');

  const feedDefaultRoute = await request('/zhihu-mini/api/feed?refresh=1');
  assert.equal(feedDefaultRoute.json.ok, true);
  assert.ok(feedDefaultRoute.json.items.length > 1, 'absent feed limit must use the default, not clamp to 1');
  assert.equal(feedDefaultRoute.json.items.length, 2);
  checks += 1;
  console.log('ok   GET /api/feed without ?limit uses the default');

  const hotSmall = await request('/zhihu-mini/api/hot?limit=1');
  assert.equal(hotSmall.json.ok, true);
  assert.equal(hotSmall.json.items.length, 1);
  checks += 1;
  console.log('ok   GET /api/hot honours ?limit locally (1 of 3 fixture rows)');

  const hotThree = await request('/zhihu-mini/api/hot?limit=3');
  assert.equal(hotThree.json.ok, true);
  assert.equal(hotThree.json.items.length, 3);
  checks += 1;
  console.log('ok   GET /api/hot?limit=3 returns exactly 3 items');

  const feedSmall = await request('/zhihu-mini/api/feed?limit=1');
  assert.equal(feedSmall.json.ok, true);
  assert.equal(feedSmall.json.items.length, 1);

  const feedTwo = await request('/zhihu-mini/api/feed?limit=2');
  assert.equal(feedTwo.json.ok, true);
  assert.equal(feedTwo.json.items.length, 2);
  checks += 1;
  console.log('ok   GET /api/feed?limit=2 returns exactly 2 items');

  const hotCached = await request('/zhihu-mini/api/hot?limit=10');
  assert.equal(hotCached.json.cached, true);
  const hotForced = await request('/zhihu-mini/api/hot?limit=10&refresh=1');
  assert.equal(hotForced.json.cached, false);
  checks += 1;
  console.log('ok   GET /api/hot caches for 60s and refreshes on ?refresh=1');

  const feed = await request('/zhihu-mini/api/feed');
  assert.equal(feed.json.ok, true);
  assert.equal(feed.json.source, 'feed');
  checks += 1;
  console.log('ok   GET /api/feed serves the anonymous recommendation feed');

  /* ------------------------------------------------ login-required routes */

  const anonSearch = await request('/zhihu-mini/api/search?q=' + encodeURIComponent('远程办公'));
  assert.equal(anonSearch.status, 200);
  assert.equal(anonSearch.json.ok, false);
  assert.equal(anonSearch.json.code, 'login-required');
  checks += 1;
  console.log('ok   GET /api/search answers HTTP 200 + login-required anonymously');

  const anonQuestion = await request('/zhihu-mini/api/question?id=987654');
  assert.equal(anonQuestion.status, 200);
  assert.equal(anonQuestion.json.code, 'login-required');
  checks += 1;
  console.log('ok   GET /api/question answers HTTP 200 + login-required anonymously');

  /* ------------------------------------------------------------ login */

  const badLogin = await request('/zhihu-mini/api/login/cookie', {
    method: 'POST',
    body: { cookie: 'nothing-useful=1' },
  });
  assert.equal(badLogin.json.ok, false);
  checks += 1;
  console.log('ok   POST /api/login/cookie rejects a cookie without SESSDATA');

  const goodLogin = await request('/zhihu-mini/api/login/cookie', {
    method: 'POST',
    body: { cookie: 'SESSDATA=fake-session; z_c0=fake; d_c0=fake' },
  });
  assert.equal(goodLogin.json.ok, true);
  assert.equal(goodLogin.json.user.name, '测试用户');
  checks += 1;
  console.log('ok   POST /api/login/cookie validates against /me before storing');

  const status = await request('/zhihu-mini/api/login/status');
  assert.equal(status.json.loggedIn, true);
  assert.equal(status.json.user.name, '测试用户');
  assert.equal(JSON.stringify(status.json).includes('fake-session'), false);
  checks += 1;
  console.log('ok   GET /api/login/status never echoes the stored cookie');

  callLog.length = 0;
  const search = await request('/zhihu-mini/api/search?q=' + encodeURIComponent('远程办公'));
  assert.equal(search.json.ok, true);
  assert.equal(search.json.items.length, 1);
  assert.equal(search.json.items[0].id, '777');
  // /api/search is login-gated, so the absent-parameter default is asserted on
  // the upstream request the loader actually built (CONTRACT: offset=0, limit=20).
  const searchUpstream = callLog.find((entry) => entry.includes('/api/v4/search_v3'));
  assert.ok(searchUpstream, 'search reached upstream');
  assert.ok(searchUpstream.includes('limit=20'), 'absent search limit must default to 20, got: ' + searchUpstream);
  assert.ok(searchUpstream.includes('offset=0'), 'absent search offset must default to 0, got: ' + searchUpstream);
  checks += 1;
  console.log('ok   GET /api/search works once a session is stored; absent limit/offset default to 20/0');

  callLog.length = 0;
  const questionNoParams = await request('/zhihu-mini/api/question?id=987654');
  assert.equal(questionNoParams.json.ok, true);
  // CONTRACT: answerLimit defaults to 5; an absent parameter must not become 1.
  const answersUpstream = callLog.find((entry) => entry.includes('/api/v4/questions/987654/answers'));
  assert.ok(answersUpstream, 'answers reached upstream');
  assert.ok(answersUpstream.includes('limit=5'), 'absent answerLimit must default to 5, got: ' + answersUpstream);
  checks += 1;
  console.log('ok   GET /api/question without answerLimit defaults to 5');

  const question = await request('/zhihu-mini/api/question?id=987654&answerLimit=3');
  assert.equal(question.json.ok, true);
  assert.equal(question.json.question.answerCount, 88);
  assert.equal(question.json.answers.length, 1);
  assert.equal(question.json.answers[0].contentHtml, '<p>正文</p><img src="https://pic1.zhimg.com/a.jpg">');
  assert.equal(question.json.answers[0].contentText, '正文');
  checks += 1;
  console.log('ok   GET /api/question returns sanitized contentHtml + plain contentText');

  // Full reader path with a 19-digit id: the route must reach upstream with the
  // exact id instead of rejecting it or asking for a rounded one.
  const bigQuestion = await request('/zhihu-mini/api/question?id=' + BIG_ID + '&answerLimit=3');
  assert.equal(bigQuestion.json.ok, true);
  assert.equal(bigQuestion.json.question.id, BIG_ID);
  assert.equal(bigQuestion.json.question.url, 'https://www.zhihu.com/question/' + BIG_ID);
  checks += 1;
  console.log('ok   GET /api/question?s exact 19-digit id round-trips through the reader');

  const cachedQuestion = await request('/zhihu-mini/api/question?id=987654');
  assert.equal(cachedQuestion.json.cached, true);
  checks += 1;
  console.log('ok   GET /api/question is cached per id for 5 minutes');

  /* ------------------------------------------------------- panel state */

  const panelPost = await request('/zhihu-mini/api/panel', {
    method: 'POST',
    body: {
      view: 'reader',
      questionId: BIG_ID,
      title: '为什么冬天的被窝这么舒服？',
      selectionText: '物理学与心理学解释',
      visibleItems: [{ id: BIG_ID, title: '为什么冬天的被窝这么舒服？' }],
    },
  });
  assert.equal(panelPost.json.ok, true);
  const panelGet = await request('/zhihu-mini/api/panel');
  assert.equal(panelGet.json.panel.view, 'reader');
  assert.equal(panelGet.json.panel.questionId, BIG_ID);
  assert.equal(panelGet.json.connected, false);
  checks += 1;
  console.log('ok   POST + GET /api/panel round-trip the panel snapshot');

  // A snapshot is a hint, not a promise: the panel restores it and immediately
  // fetches that question, so an id that cannot be a real question must not be
  // restored (that is what once stranded the panel on a failed reader).
  const placeholderPanel = await request('/zhihu-mini/api/panel', {
    method: 'POST',
    body: { view: 'reader', questionId: '987654', title: 'placeholder' },
  });
  assert.equal(placeholderPanel.json.ok, true);
  const degraded = await request('/zhihu-mini/api/panel');
  assert.equal(degraded.json.panel.view, 'hot');
  assert.equal(degraded.json.panel.questionId, undefined);
  checks += 1;
  console.log('ok   an unloadable reader snapshot degrades to the hot list');

  /* --------------------------------------------------------- agent tools */

  for (const toolName of ['zhihu_panel', 'zhihu_hot', 'zhihu_feed', 'zhihu_search', 'zhihu_read', 'zhihu_open']) {
    const definition = toolDefs.get(toolName);
    assert.ok(definition, toolName + ' is registered via ctx.tools.register');
    assert.equal(definition.parameters.type, 'object');
    assertRegistrySchema(definition.parameters, toolName + '.parameters');
    assertRegistrySchema(definition.output.schema, toolName + '.output.schema');
    assert.ok(definition.output && definition.output.schema && typeof definition.output.render === 'function');
    assert.equal(typeof definition.timeoutMs, 'number');
    assert.ok(definition.timeoutMs > 0);
    assert.equal(typeof definition.isConcurrencySafe, 'function');
    assert.equal(typeof definition.isConcurrencySafe({}), 'boolean');
    assert.equal(typeof definition.presentCall, 'function');
    assert.ok(definition.presentCall({}));
  }
  checks += 1;
  console.log('ok   all six tools declare parameters, output schema, render, timeout, safety, presentCall');

  // The placeholder snapshot posted just above degraded to the hot list, so
  // re-post the realistic one for the tool-level assertion.
  await request('/zhihu-mini/api/panel', {
    method: 'POST',
    body: {
      view: 'reader',
      questionId: BIG_ID,
      title: '为什么冬天的被窝这么舒服？',
      selectionText: '物理学与心理学解释',
    },
  });
  const panelTool = await runTool('zhihu_panel', {});
  assert.equal(panelTool.view, 'reader');
  assert.equal(panelTool.questionId, BIG_ID);
  assert.equal(panelTool.loggedIn, true);
  assert.equal(panelTool.selectionText, '物理学与心理学解释');
  assert.ok(panelTool.hint.includes('view=reader'));
  checks += 1;
  console.log('ok   zhihu_panel reports what the user is looking at');

  const hotTool = await runTool('zhihu_hot', { limit: 5 });
  assert.equal(hotTool.ok, true);
  assert.equal(hotTool.items[0].title, '如何看待 远程办公 成为常态？');

  // The limit contract binds the tools too: never more than requested.
  const hotToolSmall = await runTool('zhihu_hot', { limit: 1 });
  assert.equal(hotToolSmall.items.length, 1);
  const hotToolThree = await runTool('zhihu_hot', { limit: 3 });
  assert.ok(hotToolThree.items.length <= 3);
  assert.equal(hotToolThree.items.length, 3);
  const feedToolSmall = await runTool('zhihu_feed', { limit: 1 });
  assert.equal(feedToolSmall.items.length, 1);
  const feedToolTwo = await runTool('zhihu_feed', { limit: 2 });
  assert.ok(feedToolTwo.items.length <= 2);
  // Panel defaults must keep working.
  const hotDefault = await runTool('zhihu_hot', {});
  assert.ok(hotDefault.items.length === 3);
  checks += 1;
  console.log('ok   zhihu_hot returns compact hot items');

  const feedTool = await runTool('zhihu_feed', {});
  assert.equal(feedTool.ok, true);
  assert.equal(feedTool.items.length, 2);
  checks += 1;
  console.log('ok   zhihu_feed returns compact feed items');

  const searchTool = await runTool('zhihu_search', { query: '远程办公' });
  assert.equal(searchTool.ok, true);
  checks += 1;
  console.log('ok   zhihu_search returns search results');

  const readTool = await runTool('zhihu_read', { questionId: '987654', answerLimit: 2 });
  assert.equal(readTool.ok, true);
  assert.equal(readTool.answers[0].author, '答主');
  assert.equal(readTool.answers[0].text, '正文');
  checks += 1;
  console.log('ok   zhihu_read returns question meta + answer text');

  const openNoPanel = await runTool('zhihu_open', { view: 'hot' });
  assert.equal(openNoPanel.delivered, false);
  checks += 1;
  console.log('ok   zhihu_open reports delivered:false when no panel is connected');

  /* --------------------------------------------------------------- SSE */

  const frames = [];
  let streamBuffer = '';
  const streamRes = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/zhihu-mini/api/events', headers: { accept: 'text/event-stream' } },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          streamBuffer += chunk;
          const parts = streamBuffer.split('\n\n');
          streamBuffer = parts.pop() || '';
          for (const part of parts) {
            const line = part.split('\n').find((entry) => entry.startsWith('data: '));
            if (line) frames.push(JSON.parse(line.slice(6)));
          }
        });
        resolve(res);
      },
    );
    req.on('error', reject);
    req.end();
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(frames.length >= 1, 'SSE sends an open frame');
  assert.equal(frames[0].type, 'open');
  assert.equal(frames[0].view, 'reader');
  assert.equal(frames[0].questionId, BIG_ID);
  assert.deepEqual(Object.keys(frames[0]).sort(), ['questionId', 'type', 'view']);

  const openWithPanel = await runTool('zhihu_open', { view: 'search', query: '被窝' });
  assert.equal(openWithPanel.delivered, true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const command = frames.find((frame) => frame.type === 'open' && frame.view === 'search');
  assert.ok(command, 'SSE delivered the panel command');
  assert.equal(command.query, '被窝');
  checks += 1;
  console.log('ok   GET /api/events streams open frames and delivers zhihu_open commands');

  streamRes.destroy();

  /* ------------------------------------------------------------- fences */

  const crossSite = await request('/zhihu-mini/api/panel', {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
  const badHost = await request('/zhihu-mini/api/panel', { headers: { host: 'evil.example.com' } });
  assert.equal(badHost.status, 403);
  const badOrigin = await request('/zhihu-mini/api/panel', {
    headers: { origin: 'https://evil.example.com' },
  });
  assert.equal(badOrigin.status, 403);
  checks += 1;
  console.log('ok   every route refuses cross-site / non-loopback requests');

  const notFound = await request('/zhihu-mini/api/nope');
  assert.equal(notFound.status, 404);
  checks += 1;
  console.log('ok   unknown routes answer 404');

  /* ------------------------------------------------------------- logout */

  const logout = await request('/zhihu-mini/api/login', { method: 'DELETE' });
  assert.equal(logout.json.ok, true);
  const afterLogout = await request('/zhihu-mini/api/login/status');
  assert.equal(afterLogout.json.loggedIn, false);
  const searchAfter = await request('/zhihu-mini/api/search?q=x');
  assert.equal(searchAfter.json.code, 'login-required');
  const anonSearchTool = await runTool('zhihu_search', { query: '远程办公' });
  assert.equal(anonSearchTool.ok, false);
  assert.equal(anonSearchTool.code, 'login-required');
  const anonReadTool = await runTool('zhihu_read', { questionId: '987654' });
  assert.equal(anonReadTool.ok, false);
  assert.equal(anonReadTool.code, 'login-required');
  checks += 1;
  console.log('ok   DELETE /api/login clears the session; tools degrade to login-required');
} finally {
  server.close();
  resetData();
}

console.log('\n' + checks + ' checks passed');
