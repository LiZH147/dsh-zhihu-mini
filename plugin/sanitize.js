/**
 * HTML allowlist sanitizer for Zhihu answer bodies.
 *
 * The upstream payload is untrusted: answers carry arbitrary embedded HTML.
 * Everything that reaches the panel or an agent tool passes through
 * sanitizeHtml(), and contentText is the plain-text projection of the same
 * sanitized string.
 *
 * Allowlist (tags): p, br, strong, em, b, i, a, h1-h6, ul, ol, li, blockquote,
 * code, pre, img, figure, figcaption, hr, table, thead, tbody, tr, th, td.
 * Attributes: a[href, title], img[src, alt, title]; href accepts http(s), img
 * src accepts https only. Everything else (style, class, id, on*, srcset,
 * data-*, ...) is dropped; script/style/iframe/object/embed/svg/math and their
 * contents are removed entirely.
 *
 * This is a tokenizer, not a DOM parser: it never executes or re-serializes
 * anything it does not understand, and it escapes stray angle brackets in text
 * nodes so a malformed tag cannot swallow later content.
 */

/** Tags kept in the output. */
const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'strong',
  'em',
  'b',
  'i',
  'a',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
  'img',
  'figure',
  'figcaption',
  'hr',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]);

/** Tags that never have a closing form. */
const VOID_TAGS = new Set(['br', 'hr', 'img']);

/** Elements dropped together with their entire subtree. */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
]);

/** Per-element attribute allowlist. */
const ALLOWED_ATTRS = new Map([
  ['a', ['href', 'title']],
  ['img', ['src', 'alt', 'title']],
]);

/** Hard input ceiling: sanitizing is linear, but bound the work anyway. */
const MAX_INPUT = 400000;

/** Named entities decoded in the text projection. */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
};

/**
 * Decode the small entity set Zhihu actually emits, plus numeric references.
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body.charCodeAt(0) === 35) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

/**
 * Escape the two characters that could start a tag in a text node.
 * Entities are left intact so &amp; keeps rendering as &amp;.
 * @param {string} text
 * @returns {string}
 */
function escapeText(text) {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Escape one attribute value for a double-quoted attribute.
 * @param {string} value
 * @returns {string}
 */
function escapeAttr(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Normalize a link/image URL, or return an empty string when it is not safe.
 * Protocol-relative URLs are refused because they inherit the page scheme.
 * @param {unknown} value
 * @param {boolean} allowHttp
 * @returns {string}
 */
function safeUrl(value, allowHttp) {
  const raw = String(value == null ? '' : value).trim();
  if (raw === '' || raw.length > 2000) return '';
  if (/^(javascript|data|vbscript|file|blob):/i.test(raw)) return '';
  if (raw.slice(0, 2) === '//') return '';
  let url;
  try {
    url = new URL(raw, 'https://www.zhihu.com/');
  } catch {
    return '';
  }
  if (url.protocol === 'https:') return url.href;
  if (allowHttp && url.protocol === 'http:') return url.href;
  return '';
}

/**
 * Find the index of the '>' that ends a tag, ignoring '>' inside quoted values.
 * @param {string} html
 * @param {number} start
 * @returns {number} index of '>' or -1 when the tag never closes
 */
function findTagEnd(html, start) {
  let quote = '';
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quote !== '') {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') return index;
  }
  return -1;
}

/**
 * Parse a tag's attribute source into a case-insensitive name/value map.
 * Duplicate attributes keep the first occurrence.
 * @param {string} source
 * @returns {Map<string, string>}
 */
function parseAttributes(source) {
  const attrs = new Map();
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g;
  let match = pattern.exec(source);
  while (match !== null) {
    const name = match[1].toLowerCase();
    const rawValue = match[2];
    const singleValue = match[3];
    const bareValue = match[4];
    const value =
      rawValue !== undefined ? rawValue : singleValue !== undefined ? singleValue : bareValue !== undefined ? bareValue : '';
    if (!attrs.has(name)) attrs.set(name, value);
    match = pattern.exec(source);
  }
  return attrs;
}

/**
 * Build a normalized opening tag from the allowlisted attributes only.
 * @param {string} tagName
 * @param {Map<string, string>} rawAttrs
 * @returns {string}
 */
function buildOpenTag(tagName, rawAttrs) {
  const allowed = ALLOWED_ATTRS.get(tagName) || [];
  const parts = [tagName];
  for (let index = 0; index < allowed.length; index += 1) {
    const attrName = allowed[index];
    if (!rawAttrs.has(attrName)) continue;
    const rawValue = rawAttrs.get(attrName);
    let value;
    if (attrName === 'href') {
      value = safeUrl(rawValue, true);
      if (value === '') continue;
    } else if (attrName === 'src') {
      value = safeUrl(rawValue, false);
      if (value === '') continue;
    } else {
      value = String(rawValue).slice(0, 500);
    }
    parts.push(attrName + '="' + escapeAttr(value) + '"');
  }
  if (tagName === 'a') {
    parts.push('rel="nofollow noopener noreferrer"');
    parts.push('target="_blank"');
  }
  return '<' + parts.join(' ') + '>';
}

/**
 * Sanitize untrusted answer HTML down to the allowlisted subset.
 * @param {unknown} input
 * @returns {string}
 */
export function sanitizeHtml(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  const html = input.length > MAX_INPUT ? input.slice(0, MAX_INPUT) : input;
  const out = [];
  let index = 0;

  while (index < html.length) {
    const lt = html.indexOf('<', index);
    if (lt === -1) {
      out.push(escapeText(html.slice(index)));
      break;
    }
    if (lt > index) out.push(escapeText(html.slice(index, lt)));

    if (html.slice(lt, lt + 4) === '<!--') {
      const end = html.indexOf('-->', lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.slice(lt, lt + 2) === '<!' || html.slice(lt, lt + 2) === '<?') {
      const end = findTagEnd(html, lt + 2);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const head = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)(?=[\s/>]|$)/.exec(html.slice(lt, lt + 64));
    if (head === null) {
      out.push('&lt;');
      index = lt + 1;
      continue;
    }

    const end = findTagEnd(html, lt + 1);
    if (end === -1) {
      out.push(escapeText(html.slice(lt)));
      break;
    }

    const closing = head[1] === '/';
    const tagName = head[2].toLowerCase();
    const attrSource = html.slice(lt + head[0].length, end);
    index = end + 1;

    if (DROP_WITH_CONTENT.has(tagName)) {
      if (!closing) {
        const closePattern = new RegExp('</\\s*' + tagName + '\\b', 'i');
        const rest = html.slice(index);
        const closeMatch = closePattern.exec(rest);
        if (closeMatch === null) {
          index = html.length;
        } else {
          const closeEnd = findTagEnd(html, index + closeMatch.index + 1);
          index = closeEnd === -1 ? html.length : closeEnd + 1;
        }
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(tagName)) continue;

    if (closing) {
      if (!VOID_TAGS.has(tagName)) out.push('</' + tagName + '>');
      continue;
    }
    out.push(buildOpenTag(tagName, parseAttributes(attrSource)));
  }

  return out.join('');
}

/**
 * Plain-text projection of an HTML fragment (entity-decoded, single-spaced).
 * @param {unknown} input
 * @returns {string}
 */
export function toPlainText(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  // Defense in depth: plain text must never expose the contents of an element
  // the sanitizer would have dropped (script, style, template, ...).
  const broken = input
    .replace(/<\s*(script|style|textarea|title|xmp|noscript|template|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|blockquote|tr|figure|figcaption|pre|table)\s*>/gi, '\n');
  const stripped = broken.replace(/<[^>]*>/g, ' ');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

/**
 * Strip tags and decode entities from a short upstream string (titles,
 * excerpts, author names). No allowlist applies: the result is plain text.
 * @param {unknown} value
 * @returns {string}
 */
export function stripTags(value) {
  const text = String(value == null ? '' : value).replace(/<[^>]*>/g, ' ');
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

/**
 * Convert an already-trusted upstream URL to https, or return an empty string.
 * Relative Zhihu paths are resolved against www.zhihu.com.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeHttpsUrl(value) {
  const raw = String(value == null ? '' : value).trim();
  if (raw === '' || raw.length > 2000) return '';
  try {
    const url = new URL(raw, 'https://www.zhihu.com/');
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    url.protocol = 'https:';
    return url.href;
  } catch {
    return '';
  }
}
