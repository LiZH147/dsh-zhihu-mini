# dsh-zhihu-mini — implementation notes

Internal notes for maintainers: architecture, contracts, and the deviation log against
`CONTRACT.md`. User-facing documentation lives in `README.md`.

## Layering

```
DSH Client (React, sidebar.panellist + main slot)
   │ HTTP: /zhihu-mini/api/{hot,feed,search,question,login/status,login/cookie,panel}
   │ SSE : /zhihu-mini/api/events  (agent -> panel navigation)
   ▼
DSH Host (Node >= 20, ESM, zero dependencies)
   │ trust fence -> route handler -> cache -> zhihu.js (fetch) -> api.zhihu.com
   │ store.js (atomic JSON) under <package>/data/
   ▼
api.zhihu.com
```

- The panel is a React component registered into harness slots; there is no iframe and no
  served HTML page.
- The client module registers a lazy factory through `window.__ModuleLoader__.load` and
  takes React from `require('react')`. It imports no other DSH client package.
- Everything the Host registers is created inside `apply` under `ctx.effect` (routes, SSE
  hub, tools) so uninstalling/disabling the plugin disposes it cleanly.

## Agent tools

`zhihu_panel`, `zhihu_hot`, `zhihu_feed`, `zhihu_search`, `zhihu_read`, `zhihu_open` —
registered with `ctx.tools.register` from `apply`. Each declares JSON-Schema parameters,
`timeoutMs`, `isConcurrencySafe`, `output.schema`, an `output.render` text projection and
a `presentCall` card. Tools work with the panel closed: they read the Host cache or fetch
fresh. `zhihu_open` reports `delivered:false` when no SSE subscriber is connected.

## Panel state / SSE

- The client debounces panel changes by 300 ms and `POST /api/panel` with a `PanelState`
  snapshot; `selectionText` comes from the document selection inside answer bodies.
- `GET /api/events` is a plain Node `http` SSE stream: one `data:` line plus a blank line, a
  `{"type":"ping"}` every 25 s, max 8 concurrent subscribers, cleanup on `close`.
- `zhihu_open` delivers `{"type":"open", view, questionId?, query?}` to every subscriber and
  reports whether at least one delivery happened.

## Security model

- Every route passes the loopback trust fence (`trust.js`): loopback Host header, no
  `Sec-Fetch-Site: cross-site`, same-origin `Origin`/`Referer` when present.
- Cookies live only in the Host data dir (`data/credentials.json`, atomic write, 0600 best-effort
  on POSIX). The client never receives them.
- Answer HTML is sanitized on the Host with a tag/attribute allowlist; the client only ever
  sees already-sanitized `contentHtml` plus a `contentText` projection.
- Error logging is redacted; no telemetry, no third-party relay.

## DSH-session gate on stateful routes (0.2.2)

Market review for 0.2.1 confirmed the Host/Origin fence and asked for one more thing: routes that
act on the saved Zhihu login state must verify the **DSH session**, especially the feed, sign-in and
sign-out entry points. The fence cannot do that — it answers "does this look like a request from a
page this server hosts?", and it deliberately allows requests with no browser markers at all, which
is exactly what a local `curl` sends. Measured before the change, with no Origin header:
`GET /api/feed` → 200 (personalised data), `GET /api/login/status` → 200, `DELETE /api/login` and
`POST /api/login/cookie` reachable. So any local process could read the signed-in feed, sign the
account out, or replace the stored cookie with its own.

`connection.requestRejection(req)` is the harness's own answer: it applies the fence and then
requires a signed `dsh-auth-<authority>` cookie, returning `undefined` / `403` / `401`. The eight
credential-touching routes now answer **401 `session-required`** without that session; `/api/hot`
stays anonymous and `/api/panel` + `/api/events` stay on the fence (no credentials involved).

Verified live: no-cookie `curl` gets 401 on feed / login-status / logout while `hot` and `panel`
still answer 200; a forged session cookie gets 200; and the real panel (which sends `dsh-auth-…`
on every `/zhihu-mini/api/*` request — checked over CDP `requestWillBeSentExtraInfo`) loads hot,
feed and search with zero 4xx and no console errors.

Degradation: a profile without the `connection` service has no browser session to verify, so the
fence stays the only gate there. That is recorded rather than silently failing closed, because a
headless profile would otherwise lose every stateful route.

## DSH 0.2.2-rc.5 compatibility (2026-11-19)

Re-verified after the desktop app updated to `@deepseek-ai/dsh` 0.2.2-rc.5. Nothing in the
plugin needed a code change: the panel still mounts through `sidebar.panellist`, the
`window.__ModuleLoader__` client contract is unchanged, all 14 `--dsw-alias-*` tokens the
stylesheet uses still resolve, the six agent tools answer, SSE commands still move the panel,
and smoke (57) plus e2e (38) pass with no console error or warning.

Two distribution-facing changes in 0.2.2 were adopted in the docs instead of the code:

- The Plugins page now has **Installed** and **Discover** tabs; Discover reads plugin indexes,
  and an index entry must declare `engines.dsh` or its Install button is disabled. A ready entry
  lives in `market/plugin-entry.json`.
- The `desktop` profile is Electron-owned: the npm CLI rejects plugin management for it, so the
  desktop install path is **Plugins → Add plugin** (the earlier README claimed a CLI flag).

## Scrolling ownership (regression note)

The harness gives a panel a fixed-height frame and clips it (its centre column is
`overflow: hidden`), so a panel that does not own a scroll container simply
overflows and the content below the fold is unreachable — the panel looked
non-scrollable. The root is now sized to that frame (`height/max-height: 100%`,
`min-height: 0`, `overflow: hidden`) and `.zhihu-mini-body` is the scroller
(`overflow-y: auto`). The header, tab row and account chip stay pinned, the reader
toolbar is `position: sticky; top: 0` so 返回 / 问 DSH stay reachable, and the toast
uses `position: sticky; bottom` so it stays inside the viewport.

Verified live over CDP: hot list body 642/1363 px (scrollable, scrollTop 0 → 400 with
the header still visible) and a 5-answer reader body 642/1281 px with the toolbar
pinned at its original offset after scrolling.

## Header layout + account sheet (regression note)

The tab row is a flex item of the panel column **and** a scroll container
(`overflow-x: auto`), which zeroes its automatic minimum height: the column
squeezed it to ~15px while the 32px tab buttons overflowed, so the underline cut
through the labels and the header looked broken. `flex: 0 0 auto; min-height: 33px`
pins the row; the header and the account chip are pinned the same way so a narrow
sidebar cannot compress them.

The account chip used to open the sign-in sheet as a replacement body, and a tab
click only changed `view` — the sheet stayed up, so the tabs looked dead. Now the
sheet closes on any tab click, the chip toggles it, and the sheet is an account
card: avatar, name, headline, 登录时间, 可用能力, 打开知乎主页 (from `url_token`),
关闭 and 退出. `/api/login/status` backfills `profileUrl` once for sessions stored
before that field existed.

## Reader restore guard (regression note)

The panel restores its view from the Host snapshot and, for `reader`, immediately
fetches that question. A snapshot holding an id Zhihu does not serve (a deleted
question, or a placeholder that leaked out of a test) therefore restored the whole
panel into "加载失败" with nothing but a retry — and, because the Host replayed the
snapshot on every SSE connect, it did so on every mount.

Three layers now prevent it:

1. `store.loadPanel()` refuses a snapshot the panel could not render: a `reader`
   without an id of at least 8 digits, a `search` without a query, or an unknown
   view degrade to `hot`.
2. The SSE opening frame replays `reader` only when this process served that
   question recently (`questionCache`); otherwise it re-syncs to `hot`.
3. The client treats `not-found` specially: a question opened without a click
   (restore, replayed command, refresh) falls back to the hot list with a toast,
   and a clicked one shows "这个问题不存在或已被删除" with 返回热榜.

`tools/smoke-host.mjs` asserts layer 1 (placeholder snapshot → `hot`), and the
panel behaviour was verified live over CDP: mount → hot, real question → reader ok,
nonexistent id → hot + toast, no console errors.

The harness also sets `ZHIHU_MINI_DATA_DIR`; the data directory is resolved on
every use, so a test can never reset the real `data/` and sign the user out.

## Deviation log (against CONTRACT.md)

| Area | Contract | Delivered | Why |
|---|---|---|---|
| install step | run `plugin_manager install_bundle` | Installed through the same `pluginManager/installBundle` RPC the Electron app uses, invoked by the Team Lead over the authenticated bridge `POST /api/<ns>/<method>`; result `{stage:"enable", target:"dsh-zhihu-mini", enabled:true, application:"applied"}` | `plugin_manager` is not exposed in this session's tool list (call resolves to `tools.plugin_manager is not a function`), for the Lead as well. No profile file was hand-written by packaging. Details in `tools/e2e-report.md` §1. |
| bundle row | "insert row id zhihu-mini name dsh-zhihu-mini with config" | `id: zhihu-mini`, `name: 'dsh-zhihu-mini'`, `config: { feedSize: 20, cacheTtlMs: 60000 }` | Matches the task text, the panel id and the Host `Config` keys. |
| LICENSE / NOTES.md | contract assigns `plugin/NOTES.md` to packaging; no explicit LICENSE owner | both written by packaging | `package.json` declares MIT and lists LICENSE in `files`. |
| icon | original artwork, Zhihu blue | original SVG: gradient tile + speech bubble + three dots | No third-party artwork; literal colors are allowed for icon artwork only. |

(Update this table if the install or verification outcome changes.)