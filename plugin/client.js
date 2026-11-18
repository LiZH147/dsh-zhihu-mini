/**
 * Browser half of dsh-zhihu-mini.
 *
 * Registers the sidebar entry (sidebar.panellist) and the page it opens (the
 * layout keyed main slot). The panel is a small Zhihu client: hot list,
 * recommendations, search, and a question/answer reader.
 *
 * The panel reports what the user is looking at to /zhihu-mini/api/panel
 * (debounced 300 ms) so the host agent tools can answer "what is on the panel
 * right now", and it listens on /zhihu-mini/api/events for open commands
 * sent by the zhihu_open tool.
 *
 * Follows the official UI-plugin rules: React comes from the browser module
 * table, the panel renders inside a slot (never an iframe), every visible
 * string goes through ctx.locale, and all styling uses --dsw-alias-* tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-zhihu-mini',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'zhihu-mini';
    const NS = 'zhihu-mini';
    const API = '/zhihu-mini/api';
    const HOT_URL = API + '/hot';
    const FEED_URL = API + '/feed';
    const SEARCH_URL = API + '/search';
    const QUESTION_URL = API + '/question';
    const LOGIN_STATUS_URL = API + '/login/status';
    const LOGIN_COOKIE_URL = API + '/login/cookie';
    const LOGIN_URL = API + '/login';
    const QR_URL = API + '/login/qr';
    const QR_STATUS_URL = API + '/login/qr/status';
    const QR_POLL_MS = 2000;
    const PANEL_URL = API + '/panel';
    const EVENTS_URL = API + '/events';

    const HOT_LIMIT = 30;
    const FEED_LIMIT = 12;
    const SEARCH_LIMIT = 20;
    const ANSWER_PAGE = 5;
    const SELECTION_LIMIT = 500;
    const CACHE_TTL_MS = 3 * 60 * 1000;

    const DICTIONARY = {
      zh: {
        panel: '知乎',
        tagline: '热榜、推荐与问答',
        tabHot: '热榜',
        tabFeed: '推荐',
        tabSearch: '搜索',
        tabReader: '阅读',
        hotSub: '知乎热榜 · {count} 条 · 更新于 {time}',
        feedSub: '推荐阅读 · {count} 条 · 更新于 {time}',
        searchSub: '搜索「{query}」 · {count} 条',
        readerSub: '问题与回答',
        updatedAt: '更新于 {time}',
        refresh: '刷新',
        refreshing: '刷新中…',
        retry: '重试',
        loading: '正在加载…',
        errorTitle: '加载失败',
        unknownError: '未知错误',
        emptyHotTitle: '暂无热榜',
        emptyHotBody: '知乎暂时没有返回热榜内容，稍后再试。',
        emptyFeedTitle: '暂无推荐',
        emptyFeedBody: '推荐列表是空的，刷新一下试试。',
        emptySearchTitle: '没有搜索结果',
        emptySearchBody: '换个关键词再搜一次。',
        searchPrompt: '输入关键词，搜索知乎上的问题。',
        emptyReaderTitle: '正在打开问题',
        emptyReaderBody: '从热榜或搜索结果里点一个问题即可查看回答。',
        searchPlaceholder: '搜索知乎问题…',
        searchAction: '搜索',
        searchBusy: '搜索中…',
        back: '返回',
        openInZhihu: '在知乎打开',
        answers: '{count} 个回答',
        followers: '{count} 人关注',
        comments: '{count} 条评论',
        votes: '{count} 赞同',
        topics: '话题',
        questionNotFound: '这个问题不存在或已被删除',
        questionNotFoundBody:
          '知乎上没有这个问题了（可能已被删除或合并）。换一个问题，或回到热榜继续。',
        questionGone: '那个问题打不开了，已回到热榜',
        backToHot: '返回热榜',
        noAnswers: '这个问题还没有回答。',
        noAnswersBody: '这个问题暂时没有可显示的回答，可以点「在知乎打开」查看完整内容。',
        readerLoginTitle: '登录知乎后可以查看这个问题的高赞回答',
        readerLoginBody: '当前请求需要知乎登录才能返回回答内容。粘贴 Cookie 连接账号后会自动重新加载这个问题。',
        openItemFailed: '这条内容无法打开。',
        answerCollapsed: '该回答被折叠',
        askDsh: '问 DSH',
        askDshCopied: '已复制提示词，粘贴到对话输入框即可',
        askDshFailed: '复制失败，请手动复制问题链接',
        askDshPromptIntro: '请和我一起看下面这个知乎问题。',
        askDshPromptLink: '链接：{url}',
        askDshPromptSelection: '我选中的内容：{text}',
        askDshPromptGoal: '请先概括主要观点，再总结回答里最有价值的信息。',
        loadMoreAnswers: '加载更多回答',
        loadingMore: '加载中…',
        login: '登录',
        loginTitle: '连接知乎账号',
        loginBody: '搜索和完整回答需要知乎登录。请把浏览器里的知乎 Cookie 粘贴到这里。',
        loginCookiePlaceholder: 'z_c0=...; d_c0=...; _xsrf=...',
        loginSubmit: '连接',
        loginConnecting: '正在验证…',
        loginFailed: '连接失败',
        loginHintTitle: '如何获取 Cookie？',
        loginHintBody: 'z_c0 是 HttpOnly，控制台里 document.cookie 看不到它。正确做法：浏览器登录 zhihu.com → F12 → Network → 点任意一条 api.zhihu.com 请求 → 复制 Request Headers 里整行 Cookie（或右键 Copy as cURL）→ 粘贴到这里。三种形式都支持：整行 Cookie、名称=值 列表、cURL 命令。',
        loginSecurity: 'Cookie 只保存在本机 DSH 配置里，不会上传到任何第三方。',
        loginRequiredTitle: '需要登录知乎',
        loginRequiredBody: '当前内容需要登录后才能查看。连接知乎账号后重试。',
        qrScanButton: '用知乎 App 扫码登录',
        qrLoading: '正在获取二维码…',
        qrAlt: '知乎登录二维码',
        qrHintWaiting: '打开知乎 App → 右上角扫一扫',
        qrHintScanned: '已扫描，请在手机上确认登录',
        qrExpired: '二维码已过期',
        qrRefresh: '刷新二维码',
        qrFailed: '二维码加载失败',
        qrDeviceNote: '首次使用请先粘贴一次浏览器 Cookie，之后就能直接扫码登录',
        cookieToggle: '或粘贴 Cookie',
        loggedIn: '已登录',
        logout: '退出',
        accountHint: "知乎账号已连接，可搜索与阅读完整回答",
        signedInAt: "登录时间",
        accountScope: "可用能力",
        accountScopeValue: "热榜 · 推荐 · 搜索 · 阅读 · 与 DSH 对话",
        openProfile: "打开知乎主页",
        close: "关闭",
        logoutDone: '已断开知乎账号',
        loginSuccess: '知乎账号已连接',
        kindQuestion: '问题',
        kindArticle: '文章',
        kindVideo: '视频',
        kindUnknown: '内容',
        selectHint: '选中回答里的文字，DSH 就知道你正在读什么。',
        more: '显示更多',
        collapse: '收起',
      },
      en: {
        panel: 'Zhihu',
        tagline: 'Trending, picks and Q&A',
        tabHot: 'Trending',
        tabFeed: 'For you',
        tabSearch: 'Search',
        tabReader: 'Reader',
        hotSub: 'Zhihu trending · {count} items · updated {time}',
        feedSub: 'Recommended · {count} items · updated {time}',
        searchSub: 'Results for "{query}" · {count}',
        readerSub: 'Question and answers',
        updatedAt: 'Updated {time}',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        retry: 'Retry',
        loading: 'Loading…',
        errorTitle: 'Could not load',
        unknownError: 'Unknown error',
        emptyHotTitle: 'No trending items',
        emptyHotBody: 'Zhihu returned no trending items. Try again in a moment.',
        emptyFeedTitle: 'No recommendations',
        emptyFeedBody: 'The recommendation list is empty. Try refreshing.',
        emptySearchTitle: 'No results',
        emptySearchBody: 'Try a different keyword.',
        searchPrompt: 'Type a keyword to search questions on Zhihu.',
        emptyReaderTitle: 'Open a question',
        emptyReaderBody: 'Pick a question from Trending or Search to read its answers.',
        searchPlaceholder: 'Search Zhihu questions…',
        searchAction: 'Search',
        searchBusy: 'Searching…',
        back: 'Back',
        openInZhihu: 'Open on Zhihu',
        answers: '{count} answers',
        followers: '{count} followers',
        comments: '{count} comments',
        votes: '{count} upvotes',
        topics: 'Topics',
        questionNotFound: 'This question no longer exists',
        questionNotFoundBody:
          'Zhihu does not serve this question any more (deleted or merged). Open another one, or go back to the hot list.',
        questionGone: 'That question is gone — back to the hot list',
        backToHot: 'Back to hot list',
        noAnswers: 'This question has no answers yet.',
        noAnswersBody: 'No answers are available here right now. Use "Open on Zhihu" to read the full thread.',
        readerLoginTitle: 'Sign in to Zhihu to read the top answers',
        readerLoginBody: 'This request needs a Zhihu session to return answers. Paste your cookies to connect, and the question reloads automatically.',
        openItemFailed: 'Could not open this item.',
        answerCollapsed: 'This answer is collapsed',
        askDsh: 'Ask DSH',
        askDshCopied: 'Prompt copied — paste it into the chat input',
        askDshFailed: 'Copy failed. Please copy the question link manually.',
        askDshPromptIntro: 'Look at this Zhihu question with me.',
        askDshPromptLink: 'Link: {url}',
        askDshPromptSelection: 'Text I selected: {text}',
        askDshPromptGoal: 'Summarize the main points first, then the most valuable information in the answers.',
        loadMoreAnswers: 'Load more answers',
        loadingMore: 'Loading…',
        login: 'Sign in',
        loginTitle: 'Connect a Zhihu account',
        loginBody: 'Search and full answers need a Zhihu session. Paste the Zhihu cookies from your browser here.',
        loginCookiePlaceholder: 'z_c0=...; d_c0=...; _xsrf=...',
        loginSubmit: 'Connect',
        loginConnecting: 'Verifying…',
        loginFailed: 'Connection failed',
        loginHintTitle: 'How do I get the cookie?',
        loginHintBody: 'z_c0 is HttpOnly, so document.cookie in the console will not show it. Do this instead: sign in at zhihu.com → F12 → Network → open any api.zhihu.com request → copy the whole Cookie request header (or right-click → Copy as cURL) → paste it here. All three forms work: the full Cookie header, name=value pairs, or a cURL command.',
        loginSecurity: 'The cookie stays in the local DSH profile and is never sent to a third party.',
        loginRequiredTitle: 'Zhihu sign-in required',
        loginRequiredBody: 'This content needs a signed-in session. Connect an account and retry.',
        qrScanButton: 'Scan with the Zhihu app',
        qrLoading: 'Getting the QR code…',
        qrAlt: 'Zhihu sign-in QR code',
        qrHintWaiting: 'Open the Zhihu app → tap the scan icon (top right)',
        qrHintScanned: 'Scanned — confirm the sign-in on your phone',
        qrExpired: 'The QR code has expired',
        qrRefresh: 'Refresh QR code',
        qrFailed: 'Could not load the QR code',
        qrDeviceNote: 'First time here: paste a browser Cookie once, then QR sign-in works.',
        cookieToggle: 'Or paste a Cookie',
        loggedIn: 'Signed in',
        logout: 'Sign out',
        accountHint: "Zhihu account connected — search and full answers are available",
        signedInAt: "Signed in at",
        accountScope: "Available",
        accountScopeValue: "Hot list · Feed · Search · Reader · Chat with DSH",
        openProfile: "Open Zhihu profile",
        close: "Close",
        logoutDone: 'Zhihu account disconnected',
        loginSuccess: 'Zhihu account connected',
        kindQuestion: 'Question',
        kindArticle: 'Article',
        kindVideo: 'Video',
        kindUnknown: 'Post',
        selectHint: 'Select answer text so DSH knows what you are reading.',
        more: 'Show more',
        collapse: 'Show less',
      },
    };

    let t = function (key) {
      return DICTIONARY.en[key] || key;
    };

    /** Localized string with {name} placeholders, no regex needed. */
    function say(key, vars) {
      let text = String(t(key));
      if (vars) {
        Object.keys(vars).forEach(function (name) {
          text = text.split('{' + name + '}').join(String(vars[name]));
        });
      }
      return text;
    }

    /**
     * Panel-scoped list cache. It lives inside this module (never on window,
     * localStorage or a cookie) so switching sidebar tabs does not refetch,
     * while a page reload starts clean.
     */
    const listCache = { hot: null, feed: null };
    function freshCache(entry) {
      return Boolean(entry && entry.at && Date.now() - entry.at < CACHE_TTL_MS);
    }

    function formatTime(value) {
      const timestamp = Number(value);
      if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
      try {
        return new Date(timestamp).toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch (error) {
        return '';
      }
    }

    function formatCount(value) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) return '';
      if (number < 10000) return String(Math.round(number));
      try {
        return new Intl.NumberFormat(undefined, {
          notation: 'compact',
          maximumFractionDigits: 1,
        }).format(number);
      } catch (error) {
        return String(Math.round(number));
      }
    }

    function countText(key, value) {
      if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '';
      return say(key, { count: formatCount(value) });
    }

    function kindText(kind) {
      if (kind === 'question') return t('kindQuestion');
      if (kind === 'article') return t('kindArticle');
      if (kind === 'zvideo' || kind === 'video') return t('kindVideo');
      return t('kindUnknown');
    }

    /**
     * Resolve the canonical Zhihu question id of a list row. A Zhihu id has 19
     * digits, beyond Number.MAX_SAFE_INTEGER, so an id that arrived as a JSON
     * number was already rounded: the id embedded in the canonical URL is the
     * only exact value in that case.
     */
    function questionIdOf(item) {
      if (!item || typeof item !== 'object') return '';
      const explicit = item.questionId || item.id;
      const url = typeof item.url === 'string' ? item.url : '';
      const fromUrl = (url.match(/\/question\/(\d+)/) || [])[1] || '';
      if (typeof explicit === 'number' && Number.isFinite(explicit)) {
        return Number.isSafeInteger(explicit) && explicit > 0 ? String(explicit) : fromUrl;
      }
      const value = typeof explicit === 'string' ? explicit.trim() : '';
      if (/^\d+$/.test(value)) return value;
      return fromUrl || value;
    }

    /** Open a row on Zhihu in a new tab; false only when the call throws. */
    function openInZhihu(url) {
      if (typeof url !== 'string' || !url) return false;
      try {
        window.open(url, '_blank', 'noopener,noreferrer');
        return true;
      } catch (error) {
        return false;
      }
    }

    function authorInitial(name) {
      const text = String(name || '').trim();
      if (!text) {
        // Localized initial so the avatar placeholder never hardcodes text.
        return Array.from(String(t('panel')))[0] || '?';
      }
      return Array.from(text)[0];
    }

    /** One JSON request; non-2xx and malformed bodies become one Error. */
    async function requestJson(path, options) {
      const response = await fetch(
        path,
        Object.assign(
          { headers: { accept: 'application/json' } },
          options || {},
        ),
      );
      let body = null;
      try {
        body = await response.json();
      } catch (error) {
        body = null;
      }
      if (!response.ok) {
        const failure = new Error(
          body && body.error ? body.error : 'HTTP ' + response.status,
        );
        failure.status = response.status;
        throw failure;
      }
      if (!body || typeof body !== 'object') {
        throw new Error('Invalid JSON response');
      }
      // A route reports a refusal as HTTP 200 with {ok:false, code}. Only
      // "login-required" is a UI state of its own (the login card); every
      // other failure is an error the caller shows with a retry action.
      if (body.ok === false && body.code !== 'login-required') {
        const failure = new Error(body.error || body.code || 'Request failed');
        failure.code = body.code || '';
        throw failure;
      }
      return body;
    }

    function loginRequiredOf(body) {
      return Boolean(body && body.ok === false && body.code === 'login-required');
    }

    /**
     * Clipboard write with a selection fallback for restricted webviews.
     * The fallback textarea is attached to the panel's own root element (never
     * document.body) and removed immediately, so the plugin writes no DOM
     * outside its component.
     */
    async function copyText(value, host) {
      const text = String(value || '');
      if (!text) return false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (error) {
        // Fall through to the selection based copy.
      }
      if (!host || typeof document.execCommand !== 'function') return false;
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', 'readonly');
        area.style.position = 'absolute';
        area.style.left = '-9999px';
        area.style.opacity = '0';
        host.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
      } catch (error) {
        return false;
      }
    }

    /**
     * The Zhihu device cookie (d_c0) is not HttpOnly, so the panel can read it
     * and hand it to the host. Zhihu only issues a sign-in QR to a client with
     * a genuine device cookie; the host persists it after the first use.
     * Returns '' when the browser has none (or cookies are blocked).
     */
    function readDeviceId() {
      try {
        const raw = typeof document !== 'undefined' && document.cookie ? String(document.cookie) : '';
        if (!raw) return '';
        const parts = raw.split(';');
        for (let index = 0; index < parts.length; index += 1) {
          const entry = parts[index].trim();
          if (entry.indexOf('d_c0=') === 0) {
            // Keep the value exactly as stored: Zhihu compares the cookie it
            // issued, and some browsers keep the quoting the server used.
            let value = entry.slice('d_c0='.length).trim();
            if (value.length >= 2 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
              value = value.slice(1, -1).trim();
            }
            return value;
          }
        }
        return '';
      } catch (error) {
        return '';
      }
    }

    /**
     * Turn the host's QR response into an <img src> value. The host sends both
     * a ready-made "image" data URL and the raw "svg"; the data URL wins so the
     * browser never has to parse markup, and the SVG path stays as fallback.
     */
    function qrImageSource(body) {
      if (body && typeof body.image === 'string' && body.image.indexOf('data:image/') === 0) {
        return body.image;
      }
      return svgDataUrl(body && body.svg);
    }

    /**
     * Wrap the host-rendered QR SVG in a data URL for an <img src>.
     *
     * btoa() only accepts Latin-1 code units, so the SVG is UTF-8 encoded
     * first; unescape() turns those percent escapes back into the byte code
     * units btoa wants, which keeps any non-ASCII text in the SVG intact.
     * The markup is never injected as HTML: it only ever reaches an <img>.
     */
    function svgDataUrl(svg) {
      const value = String(svg || '');
      if (!value) return '';
      try {
        if (typeof btoa === 'function' && typeof unescape === 'function') {
          return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(value)));
        }
      } catch (error) {
        // Fall through to the percent-encoded form.
      }
      try {
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(value);
      } catch (error) {
        return '';
      }
    }

    /**
     * Build the prompt handed to DSH. The client context exposes no documented
     * way to start a user message from a panel, so this action copies a
     * complete prompt instead of pretending to send one.
     */
    function buildAskPrompt(question, selectionText) {
      const lines = [t('askDshPromptIntro')];
      if (question && question.title) {
        lines.push(t('kindQuestion') + ': ' + question.title);
      }
      if (question && question.url) {
        lines.push(say('askDshPromptLink', { url: question.url }));
      }
      if (selectionText) {
        lines.push(say('askDshPromptSelection', { text: selectionText }));
      }
      lines.push(t('askDshPromptGoal'));
      return lines.join(String.fromCharCode(10));
    }

    /**
     * Commands from the host SSE stream. The EventSource is owned by apply(),
     * while the panel component is mounted and unmounted with the slot, so a
     * tiny module bus carries "open" commands across that boundary and keeps
     * the most recent one until a panel mounts to consume it.
     */
    const commandBus = {
      listeners: new Set(),
      pending: null,
      emit: function (command) {
        if (this.listeners.size === 0) {
          this.pending = command;
          return;
        }
        this.listeners.forEach(function (listener) {
          try {
            listener(command);
          } catch (error) {
            // One broken listener must not stop the others.
          }
        });
      },
      subscribe: function (listener) {
        const bus = this;
        bus.listeners.add(listener);
        if (bus.pending) {
          const queued = bus.pending;
          bus.pending = null;
          try {
            listener(queued);
          } catch (error) {
            // The panel will render again on its own.
          }
        }
        return function () {
          bus.listeners.delete(listener);
        };
      },
    };

    /** EventSource subscription; returns its disposer for ctx.effect. */
    function connectEvents() {
      if (typeof EventSource !== 'function') return function () {};
      let source = null;
      let closed = false;
      try {
        source = new EventSource(EVENTS_URL);
      } catch (error) {
        return function () {};
      }
      source.onmessage = function (event) {
        if (closed) return;
        let command = null;
        try {
          command = JSON.parse(event.data);
        } catch (error) {
          command = null;
        }
        if (!command || command.type !== 'open') return;
        commandBus.emit(command);
      };
      // EventSource reconnects by itself after a transport error; the panel is
      // still fully usable without the stream, so errors stay silent.
      return function () {
        closed = true;
        if (source) {
          try {
            source.close();
          } catch (error) {
            // Already closed.
          }
          source = null;
        }
      };
    }

    let panelTimer = null;
    let panelSignature = '';

    /**
     * Report the panel state to the host, debounced 300 ms as CONTRACT.md
     * requires. A failed report is invisible in the UI: the next interaction
     * sends the whole state again.
     */
    function postPanelState(panel) {
      const signature = JSON.stringify([
        panel.view,
        panel.query || '',
        panel.questionId || '',
        panel.title || '',
        panel.selectionText || '',
        panel.answerId || '',
        Boolean(panel.loggedIn),
        (panel.visibleItems || []).map(function (item) {
          return item.id;
        }).join(','),
      ]);
      if (panelTimer) {
        clearTimeout(panelTimer);
        panelTimer = null;
      }
      if (signature === panelSignature) return;
      panelTimer = setTimeout(function () {
        panelTimer = null;
        panelSignature = signature;
        const payload = Object.assign({}, panel, { updatedAt: Date.now() });
        fetch(PANEL_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(function () {
          panelSignature = '';
        });
      }, 300);
    }

/** 16px sidebar glyph: the Zhihu speech-bubble mark with a question hook. */
    function ZhihuMiniIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', { d: 'M4.5 5.5h10a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H9l-4.5 3v-3a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2z' }),
        h('path', { d: 'M18.5 9.5h1a2 2 0 0 1 2 2v9l-3-2' }),
        h('path', { d: 'M8.5 10.2c.5-.8 1.4-1.2 2.2-1.2 1.3 0 2.2.9 2.2 2.2 0 1.7-2.2 2-2.2 3.3' }),
        h('path', { d: 'M10.7 16.6h.01' }),
      );
    }

    function RefreshIcon({ spinning }) {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          className: spinning ? 'zhihu-mini-spin' : undefined,
        },
        h('path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }),
        h('path', { d: 'M20 4v4h-4' }),
      );
    }

    function SearchIcon() {
      return h(
        'svg',
        {
          width: 15,
          height: 15,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          'aria-hidden': true,
        },
        h('circle', { cx: 11, cy: 11, r: 6.5 }),
        h('path', { d: 'M16 16l4.5 4.5' }),
      );
    }

    function BackIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M15 5l-7 7 7 7' }),
      );
    }

    function ExternalIcon() {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M14 4h6v6' }),
        h('path', { d: 'M20 4l-9 9' }),
        h('path', { d: 'M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4' }),
      );
    }

    /** Centered title/body/action block used by empty, error and login gates. */
    function StateMessage({ title, body, action, tone, icon }) {
      return h(
        'div',
        {
          className: 'zhihu-mini-state' + (tone ? ' zhihu-mini-state-' + tone : ''),
          role: tone === 'error' ? 'alert' : 'status',
        },
        icon || null,
        h('div', { className: 'zhihu-mini-state-title' }, title),
        body ? h('div', { className: 'zhihu-mini-state-body' }, body) : null,
        action
          ? h('div', { className: 'zhihu-mini-state-actions' }, action)
          : null,
      );
    }

    function SkeletonGrid({ count }) {
      const cells = [];
      for (let index = 0; index < (count || 6); index += 1) {
        cells.push(
          h(
            'div',
            { className: 'zhihu-mini-skeleton', key: 'skeleton-' + index },
            h('div', { className: 'zhihu-mini-skel-cover' }),
            h('div', { className: 'zhihu-mini-skel-line' }),
            h('div', { className: 'zhihu-mini-skel-line zhihu-mini-skel-short' }),
            h('div', { className: 'zhihu-mini-skel-line zhihu-mini-skel-tiny' }),
          ),
        );
      }
      return h('div', { className: 'zhihu-mini-grid', 'aria-busy': 'true' }, cells);
    }

    /** Hot-list row: rank badge, title, excerpt and heat/answer facts. */
    function HotItem({ item, index, onOpen }) {
      const rank = index + 1;
      const hot = typeof item.heat === 'string' && item.heat ? item.heat : '';
      const answerCount = countText('answers', item.answerCount);
      const open = function (event) {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (event.defaultPrevented) return;
        event.preventDefault();
        onOpen(item);
      };
      return h(
        'a',
        {
          className: 'zhihu-mini-hot-item',
          href: item.url,
          target: '_blank',
          rel: 'noreferrer',
          title: item.title,
          'data-zhihu-mini-item-id': String(questionIdOf(item) || ''),
          'data-zhihu-mini-item-kind': String(item.kind || ''),
          onClick: open,
        },
        h(
          'span',
          {
            className:
              'zhihu-mini-rank' +
              (rank <= 3 ? ' zhihu-mini-rank-top' : '') +
              ' zhihu-mini-rank-' + Math.min(rank, 4),
          },
          String(rank).padStart(2, '0'),
        ),
        h(
          'span',
          { className: 'zhihu-mini-hot-main' },
          h('span', { className: 'zhihu-mini-hot-title' }, item.title || ''),
          item.excerpt
            ? h('span', { className: 'zhihu-mini-hot-excerpt' }, item.excerpt)
            : null,
        ),
        h(
          'span',
          { className: 'zhihu-mini-hot-facts' },
          hot
            ? h('span', { className: 'zhihu-mini-heat' }, hot)
            : null,
          answerCount
            ? h('span', { className: 'zhihu-mini-fact' }, answerCount)
            : null,
        ),
      );
    }

    /** Recommendation card: optional cover, kind badge, title, excerpt. */
    function FeedCard({ item, onOpen }) {
      const facts = [];
      const answerCount = countText('answers', item.answerCount);
      if (answerCount) facts.push(answerCount);
      if (item.heat) facts.push(item.heat);
      return h(
        'a',
        {
          className: 'zhihu-mini-card',
          href: item.url,
          target: '_blank',
          rel: 'noreferrer',
          title: item.title,
          'data-zhihu-mini-item-id': String(questionIdOf(item) || ''),
          'data-zhihu-mini-item-kind': String(item.kind || ''),
          onClick: function (event) {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            if (event.defaultPrevented) return;
            event.preventDefault();
            onOpen(item);
          },
        },
        h(
          'div',
          { className: 'zhihu-mini-cover' },
          item.imageUrl
            ? h('img', {
                src: item.imageUrl,
                alt: '',
                loading: 'lazy',
                decoding: 'async',
                referrerPolicy: 'no-referrer',
                onError: function (event) {
                  event.currentTarget.style.visibility = 'hidden';
                },
              })
            : h('span', { className: 'zhihu-mini-cover-fallback' }, kindText(item.kind)),
          h('span', { className: 'zhihu-mini-kind' }, kindText(item.kind)),
        ),
        h(
          'div',
          { className: 'zhihu-mini-card-body' },
          h('div', { className: 'zhihu-mini-card-title' }, item.title || ''),
          item.excerpt
            ? h('div', { className: 'zhihu-mini-card-excerpt' }, item.excerpt)
            : null,
          facts.length > 0
            ? h(
                'div',
                { className: 'zhihu-mini-card-facts' },
                facts.map(function (fact, index) {
                  return h('span', { key: 'fact-' + index }, fact);
                }),
              )
            : null,
        ),
      );
    }

    /** Search tab: query box plus result cards. */
    function SearchPanel({ state, query, onQuery, onSubmit, onOpen, onRetry, loginCard }) {
      return h(
        'div',
        { className: 'zhihu-mini-search' },
        h(
          'form',
          {
            className: 'zhihu-mini-search-form',
            onSubmit: function (event) {
              event.preventDefault();
              onSubmit();
            },
          },
          h('span', { className: 'zhihu-mini-search-icon' }, h(SearchIcon)),
          h('input', {
            className: 'zhihu-mini-search-input',
            type: 'search',
            value: query,
            placeholder: t('searchPlaceholder'),
            'aria-label': t('searchPlaceholder'),
            onChange: function (event) {
              onQuery(event.target.value);
            },
            autoComplete: 'off',
            spellCheck: false,
          }),
          h(
            'button',
            {
              type: 'submit',
              className: 'zhihu-mini-search-submit',
              disabled: state.status === 'loading' || !query.trim(),
            },
            state.status === 'loading' ? t('searchBusy') : t('searchAction'),
          ),
        ),
        state.needsLogin
          ? loginCard
          : state.status === 'loading'
            ? h(SkeletonGrid, { count: 4 })
            : state.status === 'error'
              ? h(StateMessage, {
                  title: t('errorTitle'),
                  body: state.error || t('unknownError'),
                  tone: 'error',
                  action: h(
                    'button',
                    {
                      type: 'button',
                      className: 'zhihu-mini-button',
                      onClick: onRetry,
                    },
                    t('retry'),
                  ),
                })
              : state.status === 'idle'
                ? h(StateMessage, {
                    title: t('tabSearch'),
                    body: t('searchPrompt'),
                  })
                : state.items.length === 0
                  ? h(StateMessage, {
                      title: t('emptySearchTitle'),
                      body: t('emptySearchBody'),
                    })
                  : h(
                      'div',
                      { className: 'zhihu-mini-grid' },
                      state.items.map(function (item) {
                        return h(FeedCard, {
                          key: item.id || item.url,
                          item: item,
                          onOpen: onOpen,
                        });
                      }),
                    ),
      );
    }

    /**
     * Sign-in card. QR sign-in with the Zhihu app is the primary path; the
     * cookie paste form stays available underneath as the secondary option
     * (and is the only option until Zhihu has a stored device id).
     *
     * Props: variant ('full' | 'gate'), busy, error, user, savedAt, onConnect(cookie),
     * onLogout, onLoginSuccess(user), onClose.
     */
    function LoginCard({ variant, busy, error, user, savedAt, onConnect, onLogout, onLoginSuccess, onClose }) {
      const [cookie, setCookie] = React.useState('');
      const [showHint, setShowHint] = React.useState(false);
      const [showCookie, setShowCookie] = React.useState(false);
      const [deviceRequired, setDeviceRequired] = React.useState(false);
      const [qr, setQr] = React.useState(null);
      const [qrState, setQrState] = React.useState('idle');
      const [qrError, setQrError] = React.useState('');
      const [qrBusy, setQrBusy] = React.useState(false);
      const compact = variant === 'gate';

      // Refs read by the unmount cleanup, which must not depend on state that
      // has already been torn down.
      const qrRef = React.useRef(null);
      const qrStateRef = React.useRef('idle');
      qrRef.current = qr;
      qrStateRef.current = qrState;

      /** Request a fresh QR session; also used by the refresh button. */
      const startQr = React.useCallback(function () {
        setQrBusy(true);
        setQrError('');
        setQr(null);
        setQrState('loading');
        const deviceId = readDeviceId();
        requestJson(QR_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // A genuine d_c0 lets Zhihu issue the QR; the host persists it.
          body: JSON.stringify(deviceId ? { deviceId: deviceId } : {}),
        })
          .then(function (body) {
            const dataUrl = qrImageSource(body);
            if (!dataUrl) throw new Error(t('qrFailed'));
            setQr({
              token: typeof body.token === 'string' ? body.token : '',
              link: typeof body.link === 'string' ? body.link : '',
              expiresAt: Number(body.expiresAt) || 0,
              dataUrl: dataUrl,
            });
            setQrState('waiting');
            setQrBusy(false);
          })
          .catch(function (failure) {
            setQrBusy(false);
            if (failure && failure.code === 'device-required') {
              // QR sign-in needs one cookie bootstrap on a fresh install, so
              // the paste form takes over and explains why.
              setDeviceRequired(true);
              setShowCookie(true);
              setQr(null);
              setQrState('idle');
              setQrError('');
              return;
            }
            setQrState('error');
            setQrError((failure && failure.message) || t('qrFailed'));
          });
      }, []);

      /**
       * Poll the QR session while it is visible and still pending. The effect
       * owns the interval, so it stops on confirmed/expired/qr-not-found, on
       * card close, and on unmount.
       */
      React.useEffect(function () {
        if (!qr || !qr.token) return undefined;
        if (qrState !== 'waiting' && qrState !== 'scanned') return undefined;
        let disposed = false;
        const timer = setInterval(function () {
          requestJson(QR_STATUS_URL + '?token=' + encodeURIComponent(qr.token))
            .then(function (body) {
              if (disposed || !body) return;
              const next = String(body.state || '');
              if (next === 'confirmed') {
                setQrState('confirmed');
                if (onLoginSuccess) onLoginSuccess(body.user || null);
              } else if (next === 'expired') {
                setQrState('expired');
              } else if (next === 'scanned') {
                setQrState('scanned');
              }
            })
            .catch(function (failure) {
              if (disposed) return;
              if (failure && (failure.code === 'qr-not-found' || failure.status === 404)) {
                setQrState('expired');
              }
            });
        }, QR_POLL_MS);
        return function () {
          disposed = true;
          clearInterval(timer);
        };
      }, [qr, qrState, onLoginSuccess]);

      // Best-effort session cleanup: a pending QR is discarded when the card
      // goes away, so the host does not keep an abandoned session around.
      React.useEffect(function () {
        return function () {
          const token = qrRef.current && qrRef.current.token;
          if (!token || qrStateRef.current === 'confirmed') return;
          try {
            fetch(QR_URL + '?token=' + encodeURIComponent(token), {
              method: 'DELETE',
              keepalive: true,
            }).catch(function () {
              // The host expires abandoned sessions on its own TTL.
            });
          } catch (error) {
            // Nothing to do: the session expires anyway.
          }
        };
      }, []);

      if (user) {
        // Signed in: the card becomes an account sheet rather than a sign-in
        // form. It stays useful — who am I, since when, and the way out — and it
        // never traps the panel: the tab row above it stays live.
        const since =
          Number(savedAt) > 0
            ? new Date(Number(savedAt)).toLocaleString('zh-CN', {
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })
            : '';
        return h(
          'div',
          { className: 'zhihu-mini-account' },
          h(
            'div',
            { className: 'zhihu-mini-account-user' },
            h(
              'span',
              { className: 'zhihu-mini-avatar' },
              h('span', { className: 'zhihu-mini-avatar-fallback' }, authorInitial(user.name)),
              user.avatarUrl
                ? h('img', {
                    src: user.avatarUrl,
                    alt: '',
                    referrerPolicy: 'no-referrer',
                    onError: function (event) {
                      event.currentTarget.style.display = 'none';
                    },
                  })
                : null,
            ),
            h(
              'span',
              { className: 'zhihu-mini-account-text' },
              h('span', { className: 'zhihu-mini-account-name' }, user.name || t('loggedIn')),
              h(
                'span',
                { className: 'zhihu-mini-account-headline' },
                user.headline || t('accountHint'),
              ),
            ),
          ),
          h(
            'div',
            { className: 'zhihu-mini-account-meta' },
            since === ''
              ? null
              : h(
                  'div',
                  { className: 'zhihu-mini-account-meta-row' },
                  h('span', { className: 'zhihu-mini-account-meta-key' }, t('signedInAt')),
                  h('span', { className: 'zhihu-mini-account-meta-value' }, since),
                ),
            h(
              'div',
              { className: 'zhihu-mini-account-meta-row' },
              h('span', { className: 'zhihu-mini-account-meta-key' }, t('accountScope')),
              h('span', { className: 'zhihu-mini-account-meta-value' }, t('accountScopeValue')),
            ),
          ),
          h(
            'div',
            { className: 'zhihu-mini-account-actions' },
            user.profileUrl
              ? h(
                  'a',
                  {
                    className: 'zhihu-mini-button zhihu-mini-button-quiet',
                    href: user.profileUrl,
                    target: '_blank',
                    rel: 'noreferrer',
                  },
                  t('openProfile'),
                )
              : null,
            onClose
              ? h(
                  'button',
                  { type: 'button', className: 'zhihu-mini-button', onClick: onClose },
                  t('close'),
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'zhihu-mini-button zhihu-mini-button-quiet',
                onClick: onLogout,
              },
              t('logout'),
            ),
          ),
        );
      }

      const qrPending = qrState === 'waiting' || qrState === 'scanned';
      let qrStatusText = '';
      if (qrState === 'loading') qrStatusText = t('qrLoading');
      else if (qrState === 'waiting') qrStatusText = t('qrHintWaiting');
      else if (qrState === 'scanned') qrStatusText = t('qrHintScanned');
      else if (qrState === 'expired') qrStatusText = t('qrExpired');
      else if (qrState === 'error') qrStatusText = qrError || t('qrFailed');

      return h(
        'div',
        { className: 'zhihu-mini-login' + (compact ? ' zhihu-mini-login-compact' : '') },
        h('div', { className: 'zhihu-mini-login-title' }, t('loginTitle')),
        h('div', { className: 'zhihu-mini-login-body' }, t(compact ? 'loginRequiredBody' : 'loginBody')),
        deviceRequired
          ? null
          : h(
              'div',
              { className: 'zhihu-mini-qr', 'data-zhihu-mini-qr-state': qrState },
              qr || qrState === 'loading'
                ? h(
                    'div',
                    { className: 'zhihu-mini-qr-frame' },
                    qrState === 'loading' || !qr
                      ? h('span', { className: 'zhihu-mini-qr-spinner', 'aria-hidden': true })
                      : h('img', {
                          className: 'zhihu-mini-qr-image',
                          src: qr.dataUrl,
                          alt: t('qrAlt'),
                          width: 156,
                          height: 156,
                          draggable: false,
                          'data-zhihu-mini-qr-image': qrState,
                        }),
                  )
                : null,
              qrState === 'idle'
                ? h(
                    'button',
                    {
                      type: 'button',
                      className:
                        'zhihu-mini-button zhihu-mini-button-primary zhihu-mini-qr-start',
                      disabled: qrBusy,
                      onClick: startQr,
                    },
                    t('qrScanButton'),
                  )
                : qrStatusText
                  ? h(
                      'div',
                      {
                        className:
                          'zhihu-mini-qr-status' +
                          (qrState === 'error' ? ' zhihu-mini-qr-status-error' : ''),
                        role: 'status',
                        'aria-live': 'polite',
                      },
                      qrStatusText,
                    )
                  : null,
              qrState === 'expired' || qrState === 'error'
                ? h(
                    'div',
                    { className: 'zhihu-mini-qr-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'zhihu-mini-button zhihu-mini-qr-refresh',
                        disabled: qrBusy,
                        onClick: startQr,
                      },
                      t('qrRefresh'),
                    ),
                  )
                : null,
              qrPending
                ? h(
                    'div',
                    { className: 'zhihu-mini-qr-hint', role: 'status', 'aria-live': 'polite' },
                    qrState === 'scanned' ? t('qrHintScanned') : t('qrHintWaiting'),
                  )
                : null,
            ),
        deviceRequired
          ? h('div', { className: 'zhihu-mini-qr-device-note' }, t('qrDeviceNote'))
          : h(
              'button',
              {
                type: 'button',
                className: 'zhihu-mini-button zhihu-mini-button-quiet zhihu-mini-cookie-toggle',
                onClick: function () {
                  setShowCookie(!showCookie);
                },
                'aria-expanded': showCookie,
              },
              t('cookieToggle'),
            ),
        deviceRequired || showCookie
          ? h(
              'div',
              { className: 'zhihu-mini-cookie-section' },
              h('textarea', {
                className: 'zhihu-mini-login-input',
                value: cookie,
                rows: 3,
                spellCheck: false,
                placeholder: t('loginCookiePlaceholder'),
                'aria-label': t('loginCookiePlaceholder'),
                onChange: function (event) {
                  setCookie(event.target.value);
                },
              }),
              error
                ? h('div', { className: 'zhihu-mini-login-error', role: 'alert' }, error)
                : null,
              h(
                'div',
                { className: 'zhihu-mini-login-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'zhihu-mini-button zhihu-mini-button-primary',
                    disabled: busy || !cookie.trim(),
                    onClick: function () {
                      onConnect(cookie);
                    },
                  },
                  busy ? t('loginConnecting') : t('loginSubmit'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'zhihu-mini-button zhihu-mini-button-quiet',
                    onClick: function () {
                      setShowHint(!showHint);
                    },
                    'aria-expanded': showHint,
                  },
                  t('loginHintTitle'),
                ),
              ),
              showHint
                ? h('div', { className: 'zhihu-mini-login-hint' }, t('loginHintBody'))
                : null,
            )
          : null,
        h('div', { className: 'zhihu-mini-login-note' }, t('loginSecurity')),
      );
    }

    function AnswerCard({ answer, index, selected, onSelect }) {
      const votes = countText('votes', answer.voteupCount);
      const comments = countText('comments', answer.commentCount);
      const meta = [votes, comments].filter(Boolean);
      return h(
        'article',
        {
          className:
            'zhihu-mini-answer' + (selected ? ' zhihu-mini-answer-selected' : ''),
          onClick: function () {
            onSelect(answer);
          },
        },
        h(
          'div',
          { className: 'zhihu-mini-answer-head' },
          h(
            'span',
            { className: 'zhihu-mini-avatar zhihu-mini-avatar-small' },
            h(
              'span',
              { className: 'zhihu-mini-avatar-fallback' },
              authorInitial(answer.author && answer.author.name),
            ),
          ),
          h(
            'span',
            { className: 'zhihu-mini-answer-author' },
            h(
              'span',
              { className: 'zhihu-mini-answer-name' },
              (answer.author && answer.author.name) || t('kindUnknown'),
            ),
            answer.author && answer.author.headline
              ? h('span', { className: 'zhihu-mini-answer-headline' }, answer.author.headline)
              : null,
          ),
          meta.length > 0
            ? h(
                'span',
                { className: 'zhihu-mini-answer-facts' },
                meta.map(function (fact, factIndex) {
                  return h('span', { key: 'fact-' + factIndex }, fact);
                }),
              )
            : null,
        ),
        answer.isCollapsed
          ? h('div', { className: 'zhihu-mini-answer-collapsed' }, t('answerCollapsed'))
          : h('div', {
              /**
               * contentHtml is sanitized on the HOST (allowlist tags, https
               * links only, scripts/styles/ons* stripped) before it ever
               * reaches the browser: this is the only trusted HTML path in the
               * panel, and it is never used for anything else.
               */
              className: 'zhihu-mini-answer-content',
              dangerouslySetInnerHTML: { __html: answer.contentHtml || '' },
            }),
        h(
          'div',
          { className: 'zhihu-mini-answer-foot' },
          h(
            'a',
            {
              className: 'zhihu-mini-link',
              href: answer.url,
              target: '_blank',
              rel: 'noreferrer',
            },
            t('openInZhihu'),
            h('span', { className: 'zhihu-mini-link-icon' }, h(ExternalIcon)),
          ),
        ),
      );
    }

    /**
     * Reader view: question header plus the answer list.
     *
     * Three outcomes stay distinct instead of collapsing into one empty state:
     *  - login-required: the login card (with the cookie control) fills the body;
     *  - ok with zero answers: "no answers yet";
     *  - any other failure: an error with retry.
     * The header keeps the title/url of the clicked list row, so it stays
     * truthful while the question request is refused or fails.
     *
     * contentHtml is sanitized on the HOST before it reaches this component;
     * AnswerCard is the only place that renders it.
     */
    function ReaderView({ state, onRetry, onBack, onAsk, onExpandAnswers, onSelectAnswer, selectedAnswerId, loginCard, loggedIn, onLogin }) {
      if (state.status === 'idle') {
        return h(StateMessage, {
          title: t('emptyReaderTitle'),
          body: t('emptyReaderBody'),
        });
      }

      const answers = Array.isArray(state.answers) ? state.answers : [];
      const question = state.question || {};
      const fallback = state.fallback || {};
      const questionTitle = question.title || fallback.title || '';
      const questionId = question.id || state.questionId || '';
      const questionUrl =
        question.url ||
        fallback.url ||
        (questionId ? 'https://www.zhihu.com/question/' + questionId : '');
      const answerCount =
        Number(question.answerCount) || Number(fallback.answerCount) || 0;
      const meta = [
        countText('answers', answerCount),
        countText('followers', question.followerCount),
        countText('comments', question.commentCount),
      ].filter(Boolean);

      let body = null;
      if (state.status === 'loading') {
        body = h(
          'div',
          { className: 'zhihu-mini-reader-skeleton', 'aria-busy': 'true' },
          h('div', { className: 'zhihu-mini-skel-line' }),
          h('div', { className: 'zhihu-mini-skel-line zhihu-mini-skel-short' }),
          h(SkeletonGrid, { count: 2 }),
        );
      } else if (state.status === 'login-required') {
        // CONTRACT: a login-only route answers {ok:false, code:'login-required'}
        // and must show the login card, never an error or an empty state.
        body = h(
          'div',
          {
            className: 'zhihu-mini-reader-gate',
            'data-zhihu-mini-reader-state': 'login-required',
          },
          h('div', { className: 'zhihu-mini-reader-gate-title' }, t('readerLoginTitle')),
          h('div', { className: 'zhihu-mini-reader-gate-body' }, t('readerLoginBody')),
          loginCard,
        );
      } else if (state.status === 'error') {
        body = h(
          'div',
          {
            className: 'zhihu-mini-reader-error',
            'data-zhihu-mini-reader-state': 'error',
          },
          h(StateMessage, {
            title: state.gone ? t('questionNotFound') : t('errorTitle'),
            body: state.error || t('unknownError'),
            tone: 'error',
            action: h(
              'div',
              { className: 'zhihu-mini-state-actions' },
              state.gone
                ? null
                : h(
                    'button',
                    { type: 'button', className: 'zhihu-mini-button', onClick: onRetry },
                    t('retry'),
                  ),
              h(
                'button',
                { type: 'button', className: 'zhihu-mini-button', onClick: onBack },
                t('backToHot'),
              ),
            ),
          }),
        );
      } else if (answers.length === 0) {
        body = h(
          'div',
          {
            className: 'zhihu-mini-reader-empty',
            'data-zhihu-mini-reader-state': 'empty',
          },
          h(StateMessage, {
            title: t('noAnswers'),
            body: t('noAnswersBody'),
            action: loggedIn
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'zhihu-mini-button',
                    onClick: function () {
                      if (onLogin) onLogin();
                    },
                  },
                  t('login'),
                ),
          }),
        );
      } else {
        body = h(
          'div',
          { className: 'zhihu-mini-answers' },
          answers.map(function (answer, index) {
            return h(AnswerCard, {
              key: answer.id || 'answer-' + index,
              answer: answer,
              index: index,
              selected: Boolean(selectedAnswerId && selectedAnswerId === answer.id),
              onSelect: onSelectAnswer,
            });
          }),
        );
      }

      return h(
        'div',
        {
          className: 'zhihu-mini-reader',
          'data-zhihu-mini-reader-state': state.status,
        },
        h(
          'div',
          { className: 'zhihu-mini-reader-toolbar' },
          h(
            'button',
            { type: 'button', className: 'zhihu-mini-button zhihu-mini-button-quiet', onClick: onBack },
            h('span', { className: 'zhihu-mini-back-icon' }, h(BackIcon)),
            t('back'),
          ),
          h(
            'div',
            { className: 'zhihu-mini-reader-toolbar-right' },
            h(
              'button',
              { type: 'button', className: 'zhihu-mini-button', onClick: function () { onAsk(); } },
              t('askDsh'),
            ),
            questionUrl
              ? h(
                  'a',
                  {
                    className: 'zhihu-mini-button zhihu-mini-button-quiet',
                    href: questionUrl,
                    target: '_blank',
                    rel: 'noreferrer',
                  },
                  t('openInZhihu'),
                )
              : null,
          ),
        ),
        h(
          'header',
          { className: 'zhihu-mini-question' },
          questionTitle
            ? h('h2', { className: 'zhihu-mini-question-title' }, questionTitle)
            : h(
                'h2',
                { className: 'zhihu-mini-question-title zhihu-mini-question-title-muted' },
                state.status === 'loading' ? t('loading') : t('readerSub'),
              ),
          meta.length > 0
            ? h(
                'div',
                { className: 'zhihu-mini-question-meta' },
                meta.map(function (fact, index) {
                  return h('span', { key: 'meta-' + index }, fact);
                }),
              )
            : null,
          question.detailText
            ? h('p', { className: 'zhihu-mini-question-detail' }, question.detailText)
            : null,
          Array.isArray(question.topics) && question.topics.length > 0
            ? h(
                'div',
                { className: 'zhihu-mini-topics' },
                question.topics.map(function (topic, index) {
                  return h('span', { className: 'zhihu-mini-topic', key: 'topic-' + index }, topic);
                }),
              )
            : null,
          state.status === 'ok' && answers.length > 0
            ? h('div', { className: 'zhihu-mini-selection-hint' }, t('selectHint'))
            : null,
        ),
        body,
        state.status === 'ok' && state.hasMore
          ? h(
              'div',
              { className: 'zhihu-mini-more' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'zhihu-mini-button',
                  disabled: state.loadingMore,
                  onClick: onExpandAnswers,
                },
                state.loadingMore ? t('loadingMore') : t('loadMoreAnswers'),
              ),
            )
          : null,
      );
    }

    function Toast({ text, tone, onDismiss }) {
      React.useEffect(
        function () {
          const timer = setTimeout(function () {
            onDismiss();
          }, 3200);
          return function () {
            clearTimeout(timer);
          };
        },
        [text, onDismiss],
      );
      return h(
        'div',
        {
          className: 'zhihu-mini-toast' + (tone === 'error' ? ' zhihu-mini-toast-error' : ''),
          role: 'status',
          'aria-live': 'polite',
        },
        text,
      );
    }

/**
     * Cross-mount panel memory: the slot unmounts the panel when the user
     * switches sidebar entries, and remounting should return to the same view.
     */
    /**
     * Cross-mount panel memory. questionId/title/url keep the clicked list row
     * so a remounted slot or a retry can still render a truthful reader header
     * when the question request itself is refused (login-required) or fails.
     */
    const panelMemory = { view: 'hot', query: '', questionId: '', title: '', url: '', answerCount: 0 };

    function ZhihuMiniPanel() {
      const [view, setView] = React.useState(panelMemory.view || 'hot');
      const [hot, setHot] = React.useState(function () {
        return freshCache(listCache.hot)
          ? { status: 'ok', items: listCache.hot.items, fetchedAt: listCache.hot.fetchedAt, error: '' }
          : { status: 'idle', items: [], fetchedAt: 0, error: '' };
      });
      const [feed, setFeed] = React.useState(function () {
        return freshCache(listCache.feed)
          ? { status: 'ok', items: listCache.feed.items, fetchedAt: listCache.feed.fetchedAt, error: '' }
          : { status: 'idle', items: [], fetchedAt: 0, error: '' };
      });
      const [refreshing, setRefreshing] = React.useState(false);
      const [searchQuery, setSearchQuery] = React.useState(panelMemory.query || '');
      const [search, setSearch] = React.useState({
        status: 'idle',
        items: [],
        error: '',
        needsLogin: false,
        query: '',
      });
      const [reader, setReader] = React.useState({
        status: 'idle',
        question: null,
        answers: [],
        error: '',
        questionId: '',
        answerLimit: ANSWER_PAGE,
        hasMore: false,
        loadingMore: false,
        fallback: null,
      });
      const [account, setAccount] = React.useState({
        status: 'checking',
        loggedIn: false,
        user: null,
        savedAt: 0,
      });
      const [showLogin, setShowLogin] = React.useState(false);
      const [loginBusy, setLoginBusy] = React.useState(false);
      const [loginError, setLoginError] = React.useState('');
      const [toast, setToast] = React.useState(null);
      const [selectionText, setSelectionText] = React.useState('');
      const [selectedAnswerId, setSelectedAnswerId] = React.useState('');
      const rootRef = React.useRef(null);
      const abortRef = React.useRef({ hot: null, feed: null, search: null, reader: null });
      const readerRef = React.useRef(reader);
      const searchRef = React.useRef(search);
      readerRef.current = reader;
      searchRef.current = search;

      const notify = React.useCallback(function (text, tone) {
        setToast({ text: text, tone: tone || 'ok' });
      }, []);

      /** Abort any in-flight request for one lane, then start a fresh one. */
      function restartAbort(lane) {
        if (abortRef.current[lane]) {
          try {
            abortRef.current[lane].abort();
          } catch (error) {
            // Already aborted.
          }
        }
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        abortRef.current[lane] = controller;
        return controller;
      }

      const loadList = React.useCallback(function (kind, force) {
        const cache = listCache[kind];
        const setter = kind === 'hot' ? setHot : setFeed;
        const url = (kind === 'hot' ? HOT_URL : FEED_URL) + '?limit=' + HOT_LIMIT;
        const controller = restartAbort(kind);
        if (kind === 'hot') setRefreshing(true);
        if (!force && freshCache(cache)) {
          setter({ status: 'ok', items: cache.items, fetchedAt: cache.fetchedAt, error: '' });
          if (kind === 'hot') setRefreshing(false);
          return Promise.resolve();
        }
        setter(function (previous) {
          return {
            status: previous.items.length ? 'ok' : 'loading',
            items: previous.items,
            fetchedAt: previous.fetchedAt,
            error: '',
          };
        });
        const requestUrl = url + (force ? '&refresh=1' : '');
        return requestJson(requestUrl, controller ? { signal: controller.signal } : undefined)
          .then(function (body) {
            if (controller && controller.signal.aborted) return;
            const items = Array.isArray(body.items) ? body.items : [];
            const fetchedAt = Number(body.fetchedAt) || Date.now();
            listCache[kind] = { items: items, fetchedAt: fetchedAt, at: Date.now() };
            if (kind === 'hot' && body.loginRequired) setShowLogin(true);
            setter({ status: 'ok', items: items, fetchedAt: fetchedAt, error: '' });
          })
          .catch(function (error) {
            if (error && error.name === 'AbortError') return;
            if (controller && controller.signal.aborted) return;
            setter(function (previous) {
              return {
                status: previous.items.length ? 'ok' : 'error',
                items: previous.items,
                fetchedAt: previous.fetchedAt,
                error: error.message || t('unknownError'),
              };
            });
          })
          .then(function () {
            if (kind === 'hot') setRefreshing(false);
          });
      }, []);

      const loadHot = React.useCallback(
        function (force) {
          return loadList('hot', force);
        },
        [loadList],
      );
      const loadFeed = React.useCallback(
        function (force) {
          return loadList('feed', force);
        },
        [loadList],
      );

      const runSearch = React.useCallback(function (query, append) {
        const keyword = String(query || '').trim();
        if (!keyword) return Promise.resolve();
        const controller = restartAbort('search');
        if (!append) {
          setSearch({
            status: 'loading',
            items: [],
            error: '',
            needsLogin: false,
            query: keyword,
          });
        }
        const url =
          SEARCH_URL +
          '?q=' +
          encodeURIComponent(keyword) +
          '&limit=' +
          SEARCH_LIMIT +
          (append ? '&offset=' + searchRef.current.items.length : '');
        return requestJson(url, controller ? { signal: controller.signal } : undefined)
          .then(function (body) {
            if (controller && controller.signal.aborted) return;
            if (loginRequiredOf(body)) {
              setSearch({
                status: 'ok',
                items: [],
                error: body.error || '',
                needsLogin: true,
                query: keyword,
              });
              return;
            }
            const items = Array.isArray(body.items) ? body.items : [];
            setSearch(function (previous) {
              return {
                status: 'ok',
                items: append ? previous.items.concat(items) : items,
                error: '',
                needsLogin: false,
                query: keyword,
              };
            });
          })
          .catch(function (error) {
            if (error && error.name === 'AbortError') return;
            if (controller && controller.signal.aborted) return;
            setSearch({
              status: 'error',
              items: [],
              error: error.message || t('unknownError'),
              needsLogin: false,
              query: keyword,
            });
          });
      }, []);

      /** Header facts of the last clicked list row, used when a fetch is refused. */
      const rememberedMeta = React.useCallback(function () {
        return {
          title: panelMemory.title || '',
          url: panelMemory.url || '',
          answerCount: panelMemory.answerCount || 0,
        };
      }, []);

      const openQuestion = React.useCallback(function (questionId, answerLimit, keep, meta, auto) {
        const id = String(questionId || '').trim();
        if (!id) return Promise.resolve();
        const controller = restartAbort('reader');
        // The clicked list row supplies a title/url so the reader header stays
        // truthful even when the question request is refused or fails.
        const fallback = {
          title: (meta && meta.title) || '',
          url: (meta && meta.url) || '',
          answerCount: Number(meta && meta.answerCount) || 0,
        };
        setSelectedAnswerId('');
        setSelectionText('');
        if (keep) {
          setReader(function (previous) {
            return Object.assign({}, previous, {
              loadingMore: true,
              fallback: fallback,
            });
          });
        } else {
          setReader({
            status: 'loading',
            question: null,
            answers: [],
            error: '',
            questionId: id,
            answerLimit: answerLimit || ANSWER_PAGE,
            hasMore: false,
            loadingMore: false,
            fallback: fallback,
          });
        }
        const limit = answerLimit || ANSWER_PAGE;
        const url = QUESTION_URL + '?id=' + encodeURIComponent(id) + '&answerLimit=' + limit;
        return requestJson(url, controller ? { signal: controller.signal } : undefined)
          .then(function (body) {
            if (controller && controller.signal.aborted) return;
            if (loginRequiredOf(body)) {
              setReader({
                status: 'login-required',
                question: null,
                answers: [],
                error: body.error || '',
                questionId: id,
                answerLimit: limit,
                hasMore: false,
                loadingMore: false,
                fallback: fallback,
              });
              return;
            }
            const answers = Array.isArray(body.answers) ? body.answers : [];
            setReader({
              status: 'ok',
              question: body.question || null,
              answers: answers,
              error: '',
              questionId: id,
              answerLimit: limit,
              hasMore: answers.length >= limit,
              loadingMore: false,
              fallback: fallback,
            });
            if (body.question && body.question.title) {
              panelMemory.title = body.question.title;
            }
          })
          .catch(function (error) {
            if (error && error.name === 'AbortError') return;
            if (controller && controller.signal.aborted) return;
            const gone = error && error.code === 'not-found';
            // A question that Zhihu no longer serves and that the user did not
            // just click came from a restored snapshot or a replayed command.
            // Stranding the panel on an error page hides the whole feature, so
            // fall back to the hot list and say why.
            if (gone && auto) {
              panelMemory.view = 'hot';
              panelMemory.questionId = '';
              panelMemory.title = '';
              panelMemory.url = '';
              panelMemory.answerCount = 0;
              setReader({
                status: 'idle',
                question: null,
                answers: [],
                error: '',
                questionId: '',
                answerLimit: limit,
                hasMore: false,
                loadingMore: false,
                fallback: null,
              });
              setView('hot');
              loadList('hot', false);
              notify(t('questionGone'), 'error');
              return;
            }
            setReader({
              status: 'error',
              question: null,
              answers: [],
              error: gone ? t('questionNotFoundBody') : error.message || t('unknownError'),
              gone: gone === true,
              questionId: id,
              answerLimit: limit,
              hasMore: false,
              loadingMore: false,
              fallback: fallback,
            });
          });
      }, []);

      // Load login status once; a failed probe means "signed out", not an error.
      React.useEffect(function () {
        let cancelled = false;
        requestJson(LOGIN_STATUS_URL)
          .then(function (body) {
            if (cancelled) return;
            setAccount({
              status: 'ok',
              loggedIn: body && body.loggedIn === true,
              user: (body && body.user) || null,
              savedAt: Number(body && body.savedAt) || 0,
            });
          })
          .catch(function () {
            if (!cancelled) setAccount({ status: 'ok', loggedIn: false, user: null });
          });
        return function () {
          cancelled = true;
        };
      }, []);

      // First paint: honor the remembered view and fetch only what it needs.
      React.useEffect(function () {
        if (view === 'hot') loadHot(false);
        else if (view === 'feed') loadFeed(false);
        else if (view === 'search' && panelMemory.query) runSearch(panelMemory.query, false);
        else if (view === 'reader' && panelMemory.questionId) {
          openQuestion(
            panelMemory.questionId,
            ANSWER_PAGE,
            false,
            {
              title: panelMemory.title,
              url: panelMemory.url,
              answerCount: panelMemory.answerCount,
            },
            true,
          );
        }
        // Intentionally mount-only: later switches call the loaders directly.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      // Unmount/remount cleanup: abort every in-flight request.
      React.useEffect(function () {
        const lanes = abortRef.current;
        return function () {
          Object.keys(lanes).forEach(function (lane) {
            const controller = lanes[lane];
            if (controller) {
              try {
                controller.abort();
              } catch (error) {
                // Already aborted.
              }
            }
          });
        };
      }, []);

      const selectView = React.useCallback(
        function (nextView) {
          panelMemory.view = nextView;
          // A tab always means "show me that view", so it also dismisses the
          // sign-in/account sheet; leaving the sheet up made the tabs look dead.
          setShowLogin(false);
          setView(nextView);
          if (nextView === 'hot') loadHot(false);
          else if (nextView === 'feed') loadFeed(false);
        },
        [loadHot, loadFeed],
      );

      /**
       * Open a list row. Questions open in the in-panel reader; articles,
       * videos and rows without a resolvable question id open on Zhihu, so a
       * click never lands on a reader that has nothing to show.
       */
      const openItem = React.useCallback(
        function (item) {
          if (!item) return;
          const questionId = questionIdOf(item);
          const isQuestion = !item.kind || item.kind === 'question';
          if (!isQuestion || !questionId) {
            if (!openInZhihu(item.url)) notify(t('openItemFailed'), 'error');
            return;
          }
          panelMemory.questionId = questionId;
          panelMemory.view = 'reader';
          panelMemory.title = item.title || '';
          panelMemory.url = item.url || '';
          panelMemory.answerCount = Number(item.answerCount) || 0;
          setView('reader');
          panelMemory.query = searchQuery;
          openQuestion(questionId, ANSWER_PAGE, false, {
            title: item.title,
            url: item.url,
            answerCount: item.answerCount,
          });
        },
        [notify, openQuestion, rememberedMeta, searchQuery],
      );

      /**
       * One success path for both sign-in methods: QR confirmation and cookie
       * connect land here, so the account chip, the toast and the refresh of
       * the current view behave identically.
       */
      const handleLoggedIn = React.useCallback(
        function (user) {
          setAccount({ status: 'ok', loggedIn: true, user: user || null });
          setShowLogin(false);
          setLoginError('');
          notify(t('loginSuccess'));
          if (searchRef.current.needsLogin && searchQuery.trim()) {
            runSearch(searchQuery, false);
          }
          if (readerRef.current.status === 'login-required') {
            openQuestion(
              readerRef.current.questionId,
              readerRef.current.answerLimit || ANSWER_PAGE,
              false,
              rememberedMeta(),
            );
          }
        },
        [notify, openQuestion, rememberedMeta, runSearch, searchQuery],
      );

      const connectCookie = React.useCallback(
        function (value) {
          const cookie = String(value || '').trim();
          if (!cookie) return;
          setLoginBusy(true);
          setLoginError('');
          requestJson(LOGIN_COOKIE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cookie: cookie }),
          })
            .then(function (body) {
              if (!body || body.ok !== true) {
                setLoginError((body && body.error) || t('loginFailed'));
                return;
              }
              handleLoggedIn(body.user || null);
            })
            .catch(function (error) {
              setLoginError(error.message || t('loginFailed'));
            })
            .then(function () {
              setLoginBusy(false);
            });
        },
        [handleLoggedIn],
      );

      const logout = React.useCallback(function () {
        requestJson(LOGIN_URL, { method: 'DELETE' })
          .then(function () {
            setAccount({ status: 'ok', loggedIn: false, user: null });
            notify(t('logoutDone'));
          })
          .catch(function (error) {
            notify(error.message || t('unknownError'), 'error');
          });
      }, [notify]);

      const askDsh = React.useCallback(
        function () {
          const question = readerRef.current.question || {
            title: panelMemory.title,
            url: 'https://www.zhihu.com/question/' + (readerRef.current.questionId || ''),
          };
          copyText(buildAskPrompt(question, selectionText), rootRef.current).then(function (ok) {
            notify(ok ? t('askDshCopied') : t('askDshFailed'), ok ? 'ok' : 'error');
          });
        },
        [notify, selectionText],
      );

      const expandAnswers = React.useCallback(function () {
        const current = readerRef.current;
        if (!current.questionId || current.loadingMore) return;
        openQuestion(current.questionId, current.answerLimit + ANSWER_PAGE, true);
      }, [openQuestion]);

      // Apply an "open" command delivered over SSE.
      const applyCommand = React.useCallback(
        function (command) {
          if (!command || typeof command !== 'object') return;
          const target = command.view;
          if (target === 'reader') {
            if (!command.questionId) return;
            const nextId = String(command.questionId);
            if (nextId !== panelMemory.questionId) {
              // A host-driven open has no list row behind it: drop stale meta.
              panelMemory.title = '';
              panelMemory.url = '';
              panelMemory.answerCount = 0;
            }
            panelMemory.questionId = nextId;
            panelMemory.view = 'reader';
            setView('reader');
            openQuestion(nextId, ANSWER_PAGE, false, rememberedMeta(), true);
            return;
          }
          if (target === 'search') {
            selectView('search');
            if (command.query) {
              setSearchQuery(command.query);
              panelMemory.query = command.query;
              runSearch(command.query, false);
            }
            return;
          }
          if (target === 'feed' || target === 'hot') {
            if (command.query) {
              setSearchQuery(command.query);
              panelMemory.query = command.query;
            }
            selectView(target);
          }
        },
        [openQuestion, rememberedMeta, runSearch, selectView],
      );

      const applyCommandRef = React.useRef(applyCommand);
      applyCommandRef.current = applyCommand;
      React.useEffect(function () {
        return commandBus.subscribe(function (command) {
          if (applyCommandRef.current) applyCommandRef.current(command);
        });
      }, []);

      // Remember the view for the next mount.
      React.useEffect(function () {
        panelMemory.view = view;
        panelMemory.query = searchQuery;
      }, [view, searchQuery]);

      /**
       * Selection tracking: when the user selects answer text inside the
       * panel, report it so the agent can see what is being read. Selections
       * outside the panel are ignored, and the text is clamped.
       */
      React.useEffect(function () {
        let timer = null;
        const readSelection = function () {
          if (timer) clearTimeout(timer);
          timer = setTimeout(function () {
            timer = null;
            const root = rootRef.current;
            let text = '';
            try {
              const selection = window.getSelection ? window.getSelection() : null;
              if (selection && selection.rangeCount > 0) {
                const range = selection.getRangeAt(0);
                let container = range.commonAncestorContainer;
                if (container && container.nodeType === 3) container = container.parentNode;
                if (root && container && root.contains(container)) {
                  text = String(selection)
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, SELECTION_LIMIT);
                }
              }
            } catch (error) {
              text = '';
            }
            setSelectionText(text);
          }, 180);
        };
        document.addEventListener('selectionchange', readSelection);
        return function () {
          document.removeEventListener('selectionchange', readSelection);
          if (timer) clearTimeout(timer);
        };
      }, []);

      /**
       * The panel state snapshot the agent tools read. It is derived from what
       * is actually rendered, never from optimistic guesses.
       */
      const panelPayload = React.useMemo(
        function () {
          const payload = {
            view: view,
            loggedIn: account.loggedIn === true,
          };
          if (view === 'search' && searchQuery.trim()) payload.query = searchQuery.trim();
          if (view === 'reader') {
            if (reader.question && reader.question.id) payload.questionId = reader.question.id;
            else if (reader.questionId) payload.questionId = reader.questionId;
            const fallback = reader.fallback || {};
            const title = (reader.question && reader.question.title) || fallback.title;
            if (title) payload.title = title;
            if (selectedAnswerId) payload.answerId = selectedAnswerId;
          }
          const items =
            view === 'hot'
              ? hot.items
              : view === 'feed'
                ? feed.items
                : view === 'search'
                  ? search.items
                  : reader.answers;
          if (items && items.length > 0) {
            payload.visibleItems = items.slice(0, 12).map(function (item) {
              const label =
                item.title || (item.author && item.author.name) || '';
              return { id: String(item.id || ''), title: String(label) };
            });
          }
          if (selectionText) payload.selectionText = selectionText;
          return payload;
        },
        [view, searchQuery, reader, selectedAnswerId, hot.items, feed.items, search.items, selectionText, account.loggedIn],
      );

      React.useEffect(
        function () {
          // Wait for the login probe so the first snapshot the agent can read
          // never claims the user is signed out while the status is unknown.
          if (account.status === 'checking') return;
          postPanelState(panelPayload);
        },
        [panelPayload, account.status],
      );


      const title = t('panel');
      let subtitle = t('tagline');
      if (view === 'hot' && hot.status === 'ok') {
        subtitle = say('hotSub', { count: hot.items.length, time: formatTime(hot.fetchedAt) });
      } else if (view === 'feed' && feed.status === 'ok') {
        subtitle = say('feedSub', { count: feed.items.length, time: formatTime(feed.fetchedAt) });
      } else if (view === 'search' && search.status === 'ok') {
        subtitle = search.needsLogin
          ? t('loginRequiredTitle')
          : say('searchSub', { count: search.items.length, query: search.query || searchQuery });
      } else if (view === 'reader') {
        subtitle = t('readerSub');
      }

      const loginCard = h(LoginCard, {
        variant: 'gate',
        busy: loginBusy,
        error: loginError,
        onConnect: connectCookie,
        onLoginSuccess: handleLoggedIn,
        onLogout: logout,
        user: account.loggedIn ? account.user : null,
      });

      let content = null;
      if (view === 'hot' || view === 'feed') {
        const state = view === 'hot' ? hot : feed;
        if (state.status === 'idle' || (state.status === 'loading' && state.items.length === 0)) {
          content = h(SkeletonGrid, { count: 6 });
        } else if (state.status === 'error') {
          content = h(StateMessage, {
            title: t('errorTitle'),
            body: state.error || t('unknownError'),
            tone: 'error',
            action: h(
              'button',
              {
                type: 'button',
                className: 'zhihu-mini-button',
                onClick: function () {
                  if (view === 'hot') loadHot(true);
                  else loadFeed(true);
                },
              },
              t('retry'),
            ),
          });
        } else if (state.items.length === 0) {
          content = h(StateMessage, {
            title: t(view === 'hot' ? 'emptyHotTitle' : 'emptyFeedTitle'),
            body: t(view === 'hot' ? 'emptyHotBody' : 'emptyFeedBody'),
            action: h(
              'button',
              {
                type: 'button',
                className: 'zhihu-mini-button',
                onClick: function () {
                  if (view === 'hot') loadHot(true);
                  else loadFeed(true);
                },
              },
              t('retry'),
            ),
          });
        } else if (view === 'hot') {
          content = h(
            'div',
            { className: 'zhihu-mini-hot-list' },
            state.items.map(function (item, index) {
              return h(HotItem, {
                key: item.id || item.url || 'hot-' + index,
                item: item,
                index: index,
                onOpen: openItem,
              });
            }),
          );
        } else {
          content = h(
            'div',
            { className: 'zhihu-mini-grid' },
            state.items.map(function (item, index) {
              return h(FeedCard, {
                key: item.id || item.url || 'feed-' + index,
                item: item,
                onOpen: openItem,
              });
            }),
          );
        }
      } else if (view === 'search') {
        content = h(SearchPanel, {
          state: search,
          query: searchQuery,
          onQuery: function (value) {
            setSearchQuery(value);
            panelMemory.query = value;
          },
          onSubmit: function () {
            runSearch(searchQuery, false);
          },
          onOpen: openItem,
          onRetry: function () {
            runSearch(searchQuery, false);
          },
          loginCard: loginCard,
        });
      } else {
        content = h(ReaderView, {
          state: reader,
          loggedIn: account.loggedIn === true,
          onLogin: function () {
            setShowLogin(true);
          },
          onRetry: function () {
            openQuestion(
              readerRef.current.questionId || panelMemory.questionId,
              readerRef.current.answerLimit || ANSWER_PAGE,
              false,
              rememberedMeta(),
            );
          },
          onBack: function () {
            selectView('hot');
          },
          onAsk: askDsh,
          onExpandAnswers: expandAnswers,
          onSelectAnswer: function (answer) {
            setSelectedAnswerId(answer && answer.id ? String(answer.id) : '');
          },
          selectedAnswerId: selectedAnswerId,
          loginCard: loginCard,
        });
      }

      const refresh = function () {
        if (view === 'hot') loadHot(true);
        else if (view === 'feed') loadFeed(true);
        else if (view === 'search') runSearch(searchQuery, false);
        else if (view === 'reader' && reader.questionId) {
          openQuestion(reader.questionId, reader.answerLimit, false, rememberedMeta(), true);
        }
      };
      const canRefresh = view !== 'search' || Boolean(searchQuery.trim());


      return h(
        React.Fragment,
        null,
        h('style', null, STYLE),
        h(
          'div',
          {
            className: 'zhihu-mini-root',
            ref: rootRef,
            'data-zhihu-mini-panel': PANEL_ID,
            'data-zhihu-mini-view': view,
          },
          h(
            'div',
            { className: 'zhihu-mini-head' },
            h(
              'div',
              { className: 'zhihu-mini-heading' },
              h('div', { className: 'zhihu-mini-title' }, title),
              h(
                'div',
                { className: 'zhihu-mini-sub', role: 'status' },
                refreshing ? t('refreshing') : subtitle,
              ),
            ),
            h(
              'div',
              { className: 'zhihu-mini-head-actions' },
              account.loggedIn
                ? h(
                    'button',
                    {
                      type: 'button',
                      className:
                        'zhihu-mini-account-chip' + (showLogin ? ' is-open' : ''),
                      'aria-expanded': showLogin,
                      onClick: function () {
                        setShowLogin(function (open) {
                          return !open;
                        });
                      },
                      title: (account.user && account.user.name) || t('loggedIn'),
                    },
                    h(
                      'span',
                      { className: 'zhihu-mini-avatar zhihu-mini-avatar-tiny' },
                      h(
                        'span',
                        { className: 'zhihu-mini-avatar-fallback' },
                        authorInitial(account.user && account.user.name),
                      ),
                      account.user && account.user.avatarUrl
                        ? h('img', {
                            src: account.user.avatarUrl,
                            alt: '',
                            referrerPolicy: 'no-referrer',
                            onError: function (event) {
                              event.currentTarget.style.display = 'none';
                            },
                          })
                        : null,
                    ),
                    h(
                      'span',
                      { className: 'zhihu-mini-account-chip-name' },
                      (account.user && account.user.name) || t('loggedIn'),
                    ),
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'zhihu-mini-button zhihu-mini-button-primary zhihu-mini-button-small',
                      onClick: function () {
                        setShowLogin(true);
                      },
                    },
                    t('login'),
                  ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'zhihu-mini-refresh',
                  onClick: refresh,
                  disabled: refreshing || !canRefresh,
                  title: t('refresh'),
                  'aria-label': t('refresh'),
                },
                h(RefreshIcon, { spinning: refreshing }),
              ),
            ),
          ),
          h(
            'div',
            { className: 'zhihu-mini-tabs', role: 'tablist', 'aria-label': title },
            [
              { id: 'hot', label: 'tabHot' },
              { id: 'feed', label: 'tabFeed' },
              { id: 'search', label: 'tabSearch' },
              { id: 'reader', label: 'tabReader' },
            ].map(function (tab) {
              const active = view === tab.id;
              return h(
                'button',
                {
                  type: 'button',
                  key: tab.id,
                  role: 'tab',
                  'aria-selected': active,
                  className: 'zhihu-mini-tab' + (active ? ' is-active' : ''),
                  onClick: function () {
                    selectView(tab.id);
                  },
                },
                t(tab.label),
              );
            }),
          ),
          h(
            'div',
            { className: 'zhihu-mini-body' },
            showLogin
              ? h(
                  'div',
                  { className: 'zhihu-mini-login-slot' },
                  h(LoginCard, {
                    variant: 'full',
                    busy: loginBusy,
                    error: loginError,
                    onConnect: connectCookie,
                    onLoginSuccess: handleLoggedIn,
                    onLogout: function () {
                      setShowLogin(false);
                      logout();
                    },
                    user: account.loggedIn ? account.user : null,
                    savedAt: account.savedAt || 0,
                    onClose: function () {
                      setShowLogin(false);
                    },
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'zhihu-mini-button zhihu-mini-button-quiet',
                      onClick: function () {
                        setShowLogin(false);
                      },
                    },
                    t('back'),
                  ),
                )
              : content,
            toast
              ? h(Toast, {
                  text: toast.text,
                  tone: toast.tone,
                  onDismiss: function () {
                    setToast(null);
                  },
                })
              : null,
          ),
        ),
      );
    }

    /**
     * Panel stylesheet. Every color, border and surface comes from the host
     * theme tokens (--dsw-alias-*), so light/dark and future theme revisions
     * work without changes. All class names are zhihu-mini-prefixed.
     */
    const STYLE = `
.zhihu-mini-root {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 100%;
  max-width: 1040px;
  /* The harness hands a panel a fixed-height frame that clips (its own centre
     column is overflow: hidden), so the panel has to own its scroll area: the
     root is sized to that frame and the body scrolls inside it. Without this the
     root grew to its content height and everything below the fold was simply
     unreachable. */
  flex: 1 1 auto;
  height: 100%;
  max-height: 100%;
  min-height: 0;
  overflow: hidden;
  margin: 0 auto;
  padding: 20px 24px 32px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.55;
}
.zhihu-mini-root *,
.zhihu-mini-root *::before,
.zhihu-mini-root *::after {
  box-sizing: border-box;
}
.zhihu-mini-head {
  display: flex;
  align-items: flex-start;
  flex: 0 0 auto;
  gap: 12px;
}
.zhihu-mini-heading {
  flex: 1 1 auto;
  min-width: 0;
}
.zhihu-mini-title {
  font-size: 17px;
  font-weight: 650;
  letter-spacing: 0.01em;
}
.zhihu-mini-sub {
  margin-top: 2px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zhihu-mini-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}
.zhihu-mini-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  /* overflow-x: auto also makes this a scroll container, which zeroes the
     automatic minimum height; without this the flex parent squeezed the row to
     ~15px and the 32px tab buttons overflowed it, drawing the underline across
     the labels. */
  flex: 0 0 auto;
  min-height: 33px;
  padding-bottom: 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.zhihu-mini-tabs::-webkit-scrollbar {
  display: none;
}
.zhihu-mini-tab {
  flex: 0 0 auto;
  padding: 7px 12px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  line-height: 1.2;
}
.zhihu-mini-tab:hover {
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.zhihu-mini-tab.is-active {
  border-bottom-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}
.zhihu-mini-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  padding-right: 2px;
}
.zhihu-mini-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.zhihu-mini-refresh:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.zhihu-mini-refresh:disabled {
  cursor: default;
  opacity: 0.55;
}
.zhihu-mini-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  text-decoration: none;
}
.zhihu-mini-button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.zhihu-mini-button:disabled {
  cursor: default;
  opacity: 0.55;
}
.zhihu-mini-button-primary {
  border-color: var(--dsw-alias-brand-primary);
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
  font-weight: 600;
}
.zhihu-mini-button-primary:hover:not(:disabled) {
  background: var(--dsw-alias-brand-primary);
  opacity: 0.88;
}
.zhihu-mini-button-quiet {
  border-color: transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
}
.zhihu-mini-button-small {
  padding: 4px 10px;
  font-size: 12px;
}
.zhihu-mini-account-chip {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 6px;
  max-width: 150px;
  padding: 3px 8px 3px 3px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}
.zhihu-mini-account-chip:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.zhihu-mini-account-chip-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zhihu-mini-avatar {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  overflow: hidden;
  border-radius: 50%;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  font-weight: 600;
}
.zhihu-mini-avatar-tiny {
  width: 20px;
  height: 20px;
  font-size: 10px;
}
.zhihu-mini-avatar-small {
  width: 24px;
  height: 24px;
  font-size: 11px;
}
.zhihu-mini-avatar img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.zhihu-mini-avatar-fallback {
  line-height: 1;
  text-transform: uppercase;
}
.zhihu-mini-hot-list {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.zhihu-mini-hot-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
  color: inherit;
  text-decoration: none;
}
.zhihu-mini-hot-item:last-child {
  border-bottom: 0;
}
.zhihu-mini-hot-item:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.zhihu-mini-rank {
  flex: 0 0 auto;
  width: 24px;
  padding-top: 1px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.zhihu-mini-rank-top {
  color: var(--dsw-alias-brand-primary);
}
.zhihu-mini-hot-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}
.zhihu-mini-hot-title {
  display: -webkit-box;
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 550;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.zhihu-mini-hot-item:hover .zhihu-mini-hot-title {
  color: var(--dsw-alias-link);
}
.zhihu-mini-hot-excerpt {
  display: -webkit-box;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
}
.zhihu-mini-hot-facts {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex: 0 0 auto;
  padding-top: 1px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  white-space: nowrap;
}
.zhihu-mini-heat {
  color: var(--dsw-alias-state-warn-label);
  font-variant-numeric: tabular-nums;
}
.zhihu-mini-hot-item,
.zhihu-mini-card {
  cursor: pointer;
}
.zhihu-mini-hot-item:focus-visible,
.zhihu-mini-card:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
.zhihu-mini-question-title-muted {
  color: var(--dsw-alias-label-tertiary);
  font-weight: 550;
}
.zhihu-mini-reader-gate,
.zhihu-mini-reader-error,
.zhihu-mini-reader-empty,
.zhihu-mini-reader-skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.zhihu-mini-reader-gate-title {
  font-size: 14px;
  font-weight: 600;
}
.zhihu-mini-reader-gate-body {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.zhihu-mini-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 12px;
}
.zhihu-mini-card {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  color: inherit;
  text-decoration: none;
  transition: border-color 120ms ease;
}
.zhihu-mini-card:hover {
  border-color: var(--dsw-alias-border-l3);
  background: var(--dsw-alias-interactive-bg-hover);
}
.zhihu-mini-cover {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-2);
}
.zhihu-mini-cover img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.zhihu-mini-cover-fallback {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.zhihu-mini-kind {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-secondary);
  font-size: 10px;
  opacity: 0.92;
}
.zhihu-mini-card-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px 12px;
}
.zhihu-mini-card-title {
  display: -webkit-box;
  overflow: hidden;
  min-height: 2.9em;
  font-size: 13px;
  font-weight: 550;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.zhihu-mini-card-excerpt {
  display: -webkit-box;
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.zhihu-mini-card-facts {
  display: flex;
  gap: 8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
}
.zhihu-mini-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 36px 12px;
  text-align: center;
}
.zhihu-mini-state-title {
  font-size: 14px;
  font-weight: 600;
}
.zhihu-mini-state-body {
  max-width: 420px;
  margin-top: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.zhihu-mini-state-error .zhihu-mini-state-title {
  color: var(--dsw-alias-state-error-primary);
}
.zhihu-mini-state-actions {
  margin-top: 14px;
}
.zhihu-mini-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.zhihu-mini-skel-cover {
  width: 100%;
  aspect-ratio: 16 / 9;
  border-radius: 8px;
}
.zhihu-mini-skel-cover,
.zhihu-mini-skel-line {
  background: var(--dsw-alias-bg-layer-2);
  animation: zhihu-mini-shimmer 1.4s ease infinite;
}
.zhihu-mini-skel-line {
  width: 100%;
  height: 10px;
  border-radius: 5px;
}
.zhihu-mini-skel-short {
  width: 58%;
}
.zhihu-mini-skel-tiny {
  width: 34%;
}
.zhihu-mini-skel-title {
  width: 72%;
  height: 16px;
  margin-bottom: 14px;
}
.zhihu-mini-search {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.zhihu-mini-search-form {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 4px 4px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
}
.zhihu-mini-search-form:focus-within {
  border-color: var(--dsw-alias-brand-primary);
}
.zhihu-mini-search-icon {
  display: inline-flex;
  color: var(--dsw-alias-label-tertiary);
}
.zhihu-mini-search-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 7px 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  outline: none;
}
.zhihu-mini-search-input::placeholder {
  color: var(--dsw-alias-label-tertiary);
}
.zhihu-mini-search-submit {
  flex: 0 0 auto;
  padding: 6px 16px;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-bg-base);
  cursor: pointer;
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
}
.zhihu-mini-search-submit:disabled {
  cursor: default;
  opacity: 0.5;
}
.zhihu-mini-reader {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 780px;
  margin: 0 auto;
}
.zhihu-mini-reader-toolbar {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--dsw-alias-bg-base);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.zhihu-mini-reader-toolbar-right {
  display: flex;
  gap: 8px;
}
.zhihu-mini-back-icon {
  display: inline-flex;
  align-items: center;
}
.zhihu-mini-question {
  padding: 16px 18px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.zhihu-mini-question-title {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.zhihu-mini-question-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 8px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.zhihu-mini-question-detail {
  margin: 10px 0 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.zhihu-mini-topics {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.zhihu-mini-topic {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}
.zhihu-mini-selection-hint {
  margin-top: 10px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
}
.zhihu-mini-answers {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.zhihu-mini-answer {
  padding: 14px 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  cursor: default;
}
.zhihu-mini-answer-selected {
  border-color: var(--dsw-alias-brand-primary);
}
.zhihu-mini-answer-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.zhihu-mini-answer-author {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
}
.zhihu-mini-answer-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zhihu-mini-answer-headline {
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zhihu-mini-answer-facts {
  display: flex;
  gap: 10px;
  flex: 0 0 auto;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  white-space: nowrap;
}
.zhihu-mini-answer-content {
  margin-top: 10px;
  color: var(--dsw-alias-label-primary);
  font-size: 13.5px;
  line-height: 1.7;
  overflow-wrap: anywhere;
  user-select: text;
}
.zhihu-mini-answer-content p {
  margin: 0 0 10px;
}
.zhihu-mini-answer-content p:last-child {
  margin-bottom: 0;
}
.zhihu-mini-answer-content img {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
}
.zhihu-mini-answer-content a {
  color: var(--dsw-alias-link);
  text-decoration: none;
}
.zhihu-mini-answer-content a:hover {
  text-decoration: underline;
}
.zhihu-mini-answer-content blockquote {
  margin: 10px 0;
  padding: 4px 0 4px 12px;
  border-left: 3px solid var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-secondary);
}
.zhihu-mini-answer-content code {
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--dsw-alias-bg-layer-2);
  font-size: 12px;
}
.zhihu-mini-answer-content pre {
  overflow-x: auto;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}
.zhihu-mini-answer-content h1,
.zhihu-mini-answer-content h2,
.zhihu-mini-answer-content h3,
.zhihu-mini-answer-content h4 {
  margin: 14px 0 6px;
  font-size: 14.5px;
  line-height: 1.5;
}
.zhihu-mini-answer-content ul,
.zhihu-mini-answer-content ol {
  margin: 8px 0;
  padding-left: 20px;
}
.zhihu-mini-answer-content table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.zhihu-mini-answer-content th,
.zhihu-mini-answer-content td {
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l2);
}
.zhihu-mini-answer-content hr {
  border: 0;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.zhihu-mini-answer-collapsed {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
}
.zhihu-mini-answer-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 10px;
}
.zhihu-mini-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--dsw-alias-link);
  font-size: 12px;
  text-decoration: none;
}
.zhihu-mini-link:hover {
  text-decoration: underline;
}
.zhihu-mini-link-icon {
  display: inline-flex;
}
.zhihu-mini-more {
  display: flex;
  justify-content: center;
  padding: 4px 0 12px;
}
.zhihu-mini-login,
.zhihu-mini-account {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
}
.zhihu-mini-account-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-base);
}
.zhihu-mini-account-meta-row {
  display: flex;
  gap: 10px;
  font-size: 12px;
  line-height: 1.5;
}
.zhihu-mini-account-meta-key {
  flex: 0 0 auto;
  min-width: 62px;
  color: var(--dsw-alias-label-tertiary);
}
.zhihu-mini-account-meta-value {
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.zhihu-mini-account-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.zhihu-mini-account-chip.is-open {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-label-primary);
}
.zhihu-mini-login-compact {
  max-width: 560px;
  margin: 0 auto;
}
.zhihu-mini-login-title {
  font-size: 15px;
  font-weight: 650;
}
.zhihu-mini-login-body {
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
}
.zhihu-mini-login-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.5;
  outline: none;
  resize: vertical;
}
.zhihu-mini-login-input:focus {
  border-color: var(--dsw-alias-brand-primary);
}
.zhihu-mini-login-actions {
  display: flex;
  gap: 8px;
}
.zhihu-mini-login-error {
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}
.zhihu-mini-login-hint {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.zhihu-mini-login-note {
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
}
.zhihu-mini-qr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 4px 0 2px;
}
.zhihu-mini-qr-frame {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 172px;
  height: 172px;
  padding: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-base);
}
.zhihu-mini-qr-image {
  display: block;
  width: 156px;
  height: 156px;
  image-rendering: pixelated;
}
.zhihu-mini-qr-spinner {
  width: 28px;
  height: 28px;
  border: 2px solid var(--dsw-alias-border-l3);
  border-top-color: var(--dsw-alias-brand-primary);
  border-radius: 50%;
  animation: zhihu-mini-spin 0.8s linear infinite;
}
.zhihu-mini-qr-status,
.zhihu-mini-qr-hint {
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  text-align: center;
  overflow-wrap: anywhere;
}
.zhihu-mini-qr-status-error {
  color: var(--dsw-alias-state-error-primary);
}
.zhihu-mini-qr-actions {
  display: flex;
  gap: 8px;
}
.zhihu-mini-qr-device-note {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.zhihu-mini-cookie-toggle {
  align-self: flex-start;
}
.zhihu-mini-cookie-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--dsw-alias-border-l2);
}
.zhihu-mini-login-slot {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
}
.zhihu-mini-account {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.zhihu-mini-account-user {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.zhihu-mini-account-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.zhihu-mini-account-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zhihu-mini-account-headline {
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zhihu-mini-toast {
  position: sticky;
  bottom: 12px;
  z-index: 5;
  align-self: center;
  max-width: 90%;
  margin-top: 14px;
  padding: 8px 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  box-shadow: 0 6px 20px var(--dsw-alias-border-l3);
}
.zhihu-mini-toast-error {
  color: var(--dsw-alias-state-error-primary);
}
.zhihu-mini-spin {
  animation: zhihu-mini-spin 0.8s linear infinite;
  transform-box: fill-box;
  transform-origin: center;
}
@keyframes zhihu-mini-shimmer {
  0% { opacity: 0.65; }
  50% { opacity: 1; }
  100% { opacity: 0.65; }
}
@keyframes zhihu-mini-spin {
  to { transform: rotate(360deg); }
}
@media (max-width: 520px) {
  .zhihu-mini-root { padding: 14px 14px 24px; }
  .zhihu-mini-grid { grid-template-columns: 1fr; }
  .zhihu-mini-hot-facts { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .zhihu-mini-skel-cover,
  .zhihu-mini-skel-line,
  .zhihu-mini-spin {
    animation: none;
  }
}
    `;

    function registerUi(ctx) {
      ctx.slots.inject('main', function () {
        return ctx.slots.register(
          { name: 'main', key: PANEL_ID, locale: NS },
          ZhihuMiniPanel,
        );
      });

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 61,
            locale: NS,
            label: function () {
              return t('panel');
            },
          },
          ZhihuMiniIcon,
        );
      });
    }

    function apply(ctx) {
      const disposeLocale = ctx.locale.register(NS, DICTIONARY);
      t = ctx.locale.bind(NS);
      const ui = ctx.inject(['slots'], function () {
        registerUi(ctx);
      });
      // The SSE stream lives with the plugin, not the panel component, so an
      // "open" command arriving while the slot is unmounted is queued by the
      // command bus and applied on the next mount.
      const disposeEvents = connectEvents();

      return function () {
        disposeEvents();
        if (ui && typeof ui.dispose === 'function') ui.dispose();
        if (typeof disposeLocale === 'function') disposeLocale();
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply: apply,
    };
  },
});