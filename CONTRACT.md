# dsh-zhihu-mini — implementation contract

Reference plugin: dsh-bili-mini (extracted at `.ref/package/`). Official DSH plugin guide: `.ref/skill/`.
Deliverable directory: `plugin/` (package name `dsh-zhihu-mini`, panel id `zhihu-mini`, route prefix `/zhihu-mini`).

## Product goal
A "mini Zhihu" sidebar for DSH: hot list, recommendations, search, question/answer reader — and, crucially,
DSH can *talk about what is on the panel right now* (panel state snapshot + read tools + panel navigation).

## Hard rules (from the official guide)
- Panel is a React component registered in the harness slots. NEVER an iframe / served HTML page.
- Use `window.__ModuleLoader__.load({ id, factory(require) {...} })`; React via `require('react')`; no other DSH client package imports.
- Style with host theme tokens (`--dsw-alias-*` only); no literal colors except the icon artwork.
- Host half: `export const name`, `export const inject`, `export function apply(ctx, config)`; register everything inside `apply` with `ctx.effect`/`ctx.on` or return a disposer.
- Node >= 20, zero npm runtime dependencies, zero build step, plain ESM JavaScript (JSDoc only).
- Every route must pass the loopback trust fence (copy `.ref/package/trust.js` semantics).

## Host routes (all under `/zhihu-mini`, JSON unless noted)
- `GET  /api/hot?limit=30&refresh=1` → `{ ok:true, source:'hot', fetchedAt, items:[HotItem] }`
- `GET  /api/feed?limit=12&refresh=1` → `{ ok:true, source:'feed', fetchedAt, items:[HotItem] }`
- `GET  /api/search?q=<query>&offset=0&limit=20` → `{ ok:true, items:[HotItem] }` (needs login)
- `GET  /api/question?id=<qid>&answerLimit=5` → `{ ok:true, question:Question, answers:[Answer] }` (answer bodies need login, like search: anonymous → `code:'login-required'`; the client keeps the list item's title and shows the login gate)
- `GET  /api/login/status` → `{ ok:true, loggedIn:boolean, user?:{name,headline,avatarUrl}, savedAt?:number }`
- `POST /api/login/cookie` body `{ cookie:"SESSDATA=...; z_c0=..." }` → validate against Zhihu, store locally, `{ ok:true, user }` or `{ ok:false, error }`
- `DELETE /api/login` → `{ ok:true }`
- `GET  /api/panel` → `{ ok:true, panel:PanelState }`
- `POST /api/panel` body PanelState → `{ ok:true }` (panel reports what the user is looking at)
- `GET  /api/events` (text/event-stream) → SSE, each message is `data: <json>\n\n`; event objects `{type:'open', view, questionId?, query?}` and `{type:'ping'}` every 25s
- Missing login on a login-only route → HTTP 200 with `{ ok:false, code:'login-required', error:"..." }` (never a 500; the panel shows the login card).

## Data shapes
```ts
type HotItem = { id:string, kind:'question'|'article'|'zvideo'|'unknown', title:string, excerpt?:string,
  answerCount?:number, heat?:string, imageUrl?:string, url:string, created?:number }
type Question = { id:string, title:string, detailText?:string, answerCount:number, followerCount?:number,
  commentCount?:number, created?:number, url:string, topics?:string[] }
type Answer = { id:string, questionId:string, author:{name:string, headline?:string, url?:string},
  voteupCount:number, commentCount:number, created?:number, updated?:number,
  contentHtml:string, contentText:string, url:string, isCollapsed?:boolean }
type PanelState = { view:'hot'|'feed'|'search'|'reader', query?:string, questionId?:string, title?:string,
  visibleItems?:{id:string,title:string}[], selectionText?:string, answerId?:string, updatedAt:number, loggedIn?:boolean }
```
`contentHtml` is sanitized on the HOST (allowlist tags: p,br,strong,em,b,i,a,h1-h6,ul,ol,li,blockquote,code,pre,img,figure,figcaption,hr,table,thead,tbody,tr,th,td; allow href https? and img https; strip scripts/styles/ons*), and `contentText` is the plain-text projection.

## Agent tools (registered with `ctx.tools.register`)
| tool | params | returns |
|---|---|---|
| `zhihu_panel` | — | `{ view, questionId?, title?, query?, selectionText?, visibleItems?, loggedIn, updatedAt, hint }` — "what the user is looking at right now" |
| `zhihu_hot` | `{ limit?:number }` | hot list (compact, title+heat+answerCount+url) |
| `zhihu_feed` | `{ limit?:number }` | recommended feed |
| `zhihu_search` | `{ query:string, limit?:number }` | search results |
| `zhihu_read` | `{ questionId:string, answerLimit?:number }` | question meta + top answers (text excerpts) |
| `zhihu_open` | `{ view:'hot'|'feed'|'search'|'reader', query?:string, questionId?:string }` | `{ delivered:boolean, view }` — navigates the panel via SSE |
Every tool: JSON-Schema `parameters`, `timeoutMs`, `isConcurrencySafe`, `output.schema`, `output.render` text projection, `presentCall` generic card.
Tools must work when the panel is closed (they read the host cache / fetch fresh); `zhihu_open` reports `delivered:false` when no panel is connected.

## Client panel
- Registers `sidebar.panellist` (id `zhihu-mini`, order 61, label from locale) + `main` slot (key `zhihu-mini`).
- Tabs: 热榜 / 推荐 / 搜索 / 阅读. Card grid for lists, reader for question+answers.
- Every view change POSTs `/api/panel` (debounced 300ms); a `selectionchange`/selection on answer text updates `selectionText`.
- Subscribes `/api/events` (EventSource) and applies `open` commands.
- Login card: paste cookie string (SESSDATA / z_c0 / d_c0) → POST `/api/login/cookie`; shows user name + 退出.
- "问 DSH" button on the reader: if a client-side way to start a user message exists, use it; otherwise copy a prompt to clipboard + toast. Never fake it.
- All visible text via `ctx.locale` (`zh` + `en` dictionaries).

## File ownership (write scopes)
- host-core: `plugin/index.js`, `plugin/zhihu.js`, `plugin/trust.js`, `plugin/sanitize.js`, `plugin/store.js`
- client-ui: `plugin/client.js`, `plugin/locale/zh.json` (ui keys only), `plugin/locale/en.json` (ui keys only)
- packaging: `plugin/package.json`, `plugin/cordis.patch.yml`, `plugin/icon.svg`, `plugin/README.md`, `plugin/locale/*.json` meta keys, install + verification scripts under `tools/`, and `plugin/NOTES.md`
