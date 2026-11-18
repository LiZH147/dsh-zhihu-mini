# dsh-zhihu-mini — final QA review

Reviewer: packaging (task-5). Inputs: `CONTRACT.md`, `.ref/skill/SKILL.md`,
`.ref/skill/references/{host-plugin,ui-plugin,verification,practices}.md`, the shipped
`.ref/package/` reference, and the live instance at http://127.0.0.1:62154.

Severity: **S1** blocking (contract violation / broken behaviour), **S2** should fix,
**S3** cosmetic or documentation. No S1 issue blocks activation: the plugin is installed,
`application: applied`, and every route and tool answers.

## Verdict

**PASS.** 26/26 static checks, **38/38** e2e checks (static + live), **56/56** host fixture checks (grew 46 → 52 → 55 → 56 as regressions were pinned), six tools exercised through the real harness, trust fence rejects cross-site and
non-loopback requests, and the panel renders in light and dark (screenshots, §5 of
`tools/e2e-report.md`).

## Findings

| # | Sev | Where | Finding | Fix |
|---|---|---|---|---|
| 1 | ~~S2~~ FIXED | `plugin/zhihu.js:547,581`; callers `plugin/index.js:101-131` | **(FIXED, re-verified)** `limit` was forwarded upstream but never applied locally. `api.zhihu.com/topstory/{hot-list,recommend}` ignore `?limit=` and return a fixed payload. Live: `/api/hot?limit=3` → 30 items, `/api/hot?limit=99` → 30, `/api/feed?limit=2` → 6, `zhihu_hot({limit:3})` → 30. CONTRACT.md documents `limit` on both routes and the tool schemas advertise 1-50. | Fixed by host-core: slice after normalisation in `fetchHot`/`fetchFeed` + per-size cache keys. Live re-check: `hot?limit=3` → 3, `feed?limit=2` → 2, `zhihu_hot({limit:3})` → 3. e2e now asserts it. |
| 2 | ~~S2~~ FIXED | `plugin/zhihu.js:229-303, 788-796` (`parseZhihuJson`, `normalizeId`) | **(FIXED, re-verified)** 19-digit hot-list ids arrived as JSON numbers, so `JSON.parse` rounded them and `normalizeId` rejected the result: clicking a hot row never resolved the question and `/api/question?id=<19-digit>` answered `bad-input`. | Fixed by `parseZhihuJson()` (re-quotes ≥16-digit integer literals in the raw body) + string-based `normalizeId`. Live: ids come back byte-exact (`2103784826771862921`), the same id now answers `login-required`, and `?id=abc` still answers `bad-input`; e2e asserts id precision. |
| 3 | ~~S2~~ FIXED | `plugin/zhihu.js:805-813` (`clampInt`) | **(FIXED, re-verified)** A missing querystring param arrived as `null`; `Number(null) === 0` is finite so the fallback was skipped and `min` (1) won — every route that omitted its limit returned one item instead of the documented default. | Fixed by returning the fallback for `null`/`undefined`/`''` before coercion. Live: `/api/hot` → 30, `/api/feed` → 6, while explicit limits stay exact; e2e asserts the documented defaults. |

| 4 | S3 (documented) | `plugin/package.json` `files[]` | `files` omits `.gitignore`. Local directory installs link the checkout so nothing breaks; a packed tarball would lose it. | Add `".gitignore"` or drop the file from the repo — either is fine, just keep them consistent. |
| 5 | S3 | `plugin/package.json` | No `author`/`repository`/`homepage`; the MIT LICENSE holds a generic holder string. Acceptable for an unpublished local bundle. | Fill in if this is ever published. |
| 6 | S3 (deviation, documented) | `plugin/index.js:319-334` | `GET /api/question` is login-gated (returns `code:'login-required'`), while CONTRACT.md marks only `/api/search` as login-only. Upstream Zhihu does return `40353 need_login` for anonymous answers, so the gate matches reality, and the panel shows the login card instead of an error. | Either mark `/api/question` login-required in the contract, or add an anonymous fallback (question meta only, empty answers). Document the choice. |
| 7 | S3 (note) | `plugin/client.js:949` | `dangerouslySetInnerHTML` on `answer.contentHtml`. Safe **only because** the host sanitises with the allowlist and emits a `contentText` projection; the code comment says so. Keep the ordering guarantee (never move sanitisation to the client). No change requested. |
| 8 | S3 (documented) | `plugin/client.js:1837-1845` | **First panel snapshot is deferred until the login probe settles.** While `account.status === 'checking'` the reporting effect returns early, so right after a reload `zhihu_panel` answers `{updatedAt:0, hint:"…panel has not reported state yet"}` even though a panel is connected. Deliberate (never claim "signed out" while unknown) and short-lived, and the hint is honest. | Optional polish: `PanelState.loggedIn` is optional in CONTRACT.md, so POST immediately with `loggedIn` omitted and update once the probe resolves — closes the window without lying. |

## Checklist against the guide and the contract

| Requirement | Evidence | Status |
|---|---|---|
| Panel is a real React component in harness slots, never an iframe / served HTML | `client.js:2789-2801` registers `main` (key `zhihu-mini`) and `sidebar.panellist` (id, order 61, locale label); grep finds zero `iframe`/`srcdoc`/portal/body-append; only `require('react')` | PASS |
| No imports of DSH client packages | one `require` call in the whole client (`react`); no `@deepseek-ai/*` reference | PASS |
| Only `--dsw-alias-*` theme tokens | 104 token references, 0 colour literals (the only "white" hits are `white-space`) | PASS |
| Everything registered inside `apply` with cleanup | host: `ctx.effect(() => () => {...})` disposes tools, SSE clients and the route (`index.js:813-828`); client: `apply` returns a disposer closing EventSource, slots and locale (`client.js:2811-2826`) | PASS |
| Loopback trust fence on every route | fence is the first statement in the handler (`index.js:213`); live negatives: cross-site Origin → 403, non-loopback Host → 403; smoke-host asserts the fence on every route | PASS |
| No secret logging | three `ctx.logger` sites, all redacted through `redact()` (`index.js:1063-1069` masks SESSDATA/z_c0/d_c0, truncates at 300); no `console.*` in the host | PASS |
| Sanitizer applied to every `contentHtml` | single producer: `sanitizeHtml(answer.contentHtml)` at `index.js:155`, `contentText` derived from the sanitized HTML; allowlist matches CONTRACT.md tags/attrs (sanitize.js:22-74) | PASS |
| Cookie never reaches the client | `publicLogin()` returns `{loggedIn,user,savedAt}`; `/api/panel` and tools expose no cookie; client has no localStorage/sessionStorage/cookie access | PASS |
| Store permissions | dir 0700, file 0600, atomic temp+rename with chmod best-effort (`store.js:40,75-79`) | PASS |
| JSON-Schema params, `timeoutMs`, `isConcurrencySafe`, `output.schema`, `output.render`, `presentCall` on every tool | six definitions at `index.js:535/572/601/630/665/742`; smoke-host asserts all facets | PASS |
| Tools work with the panel closed | live: `zhihu_hot`/`zhihu_feed` fetch live data without a page; `zhihu_open` reports `delivered:false` when no subscriber | PASS |
| `zhihu_open` delivers over SSE | live: `delivered:true`, and `zhihu_panel` then returned a refreshed `visibleItems` snapshot | PASS |
| Login-only routes answer 200 + `login-required`, never 500 | live search/question anonymous → 200 `{ok:false,code:"login-required",needsLogin:true}` | PASS |
| Locale complete in zh and en | 70 UI keys each, identical key sets, plus `meta.title`/`meta.description` in both | PASS |
| Icon original, ≤ 256 KiB, correct format | `icon.svg` 681 B, `viewBox="0 0 96 96"`, `#0084ff`; no third-party artwork; `package.json` `icon` + `./icon` export | PASS |
| Manifest ships what it claims | every `files` entry exists; `exports` resolve; `dsh.bundle.patch` + `dsh.client{platform:web,immediately:true}` present; zero dependencies | PASS (see S3-2) |
| `node --check` clean | all six JS files | PASS |
| README documents install/usage/0-token/security/unofficial attribution | `plugin/README.md` | PASS |

## Residual risks (not defects)

1. Upstream fragility: anonymous hot list works today; search/reader need a real cookie, so the
   logged-in path is only fixture-tested (`tools/smoke-host.mjs`) — live login was never performed in
   this run and no cookie was written to `plugin/data/`.
2. `api.zhihu.com` signatures (x-zse-96) can change; the signing helper is isolated in `zhihu.js` and
   only used when `d_c0` exists, so a break degrades rather than crashes.
3. Visual claims come from the Team Lead's headless-Chrome screenshots; the packaging member has no
   browser-control tool and this model cannot read images.