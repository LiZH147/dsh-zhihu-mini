<div align="center">

<img src="./icon.svg" width="96" height="96" alt="ZhihuMini icon" />

# 知乎迷你 · ZhihuMini

**为 DeepSeek Harness 打造的知乎侧边栏**

热榜 · 推荐 · 搜索 · 问答阅读 · 面板状态 · Agent 工具 · 面板跳转 · 0 Token

</div>

不离开工作台，也能刷知乎。

> **非官方项目**：本项目是第三方插件，与知乎（北京智者天下科技有限公司）、DeepSeek、DSH 官方均无关联。
> 它只调用知乎公开的 Web 接口，不绕过登录、付费或风控，也不提供任何内容下载或破解能力。

---

## 一眼看懂

```text
┌─ 知乎迷你 ───────────────────────────────────────────┐
│  热榜  |  推荐  |  搜索  |  阅读         [刷新] [登录] │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐                   │
│  │ 标题          │  │ 标题          │                   │
│  │ 热度 · 回答数  │  │ 热度 · 回答数  │                   │
│  └──────────────┘  └──────────────┘                   │
│                                                      │
│  点卡片 → 阅读视图（问题 + 高赞回答）                   │
└──────────────────────────────────────────────────────┘
        ▲ SSE 面板状态 / 打开指令
        │
   DSH Agent（zhihu_panel / zhihu_hot / zhihu_read / zhihu_open …）
```

ZhihuMini 把知乎热榜、推荐流、搜索和问答阅读塞进 DSH 的侧边栏；
同时它把“你此刻在看什么”通过面板状态快照和 SSE 暴露给 DSH，
因此你可以直接对 DSH 说“总结一下我面板上这篇回答”，或者“帮我打开这个问题”。

## 简介

ZhihuMini 是一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的第三方侧边栏插件。
它注册在 DSH 的 `sidebar.panellist` 槽位，打开即可浏览热榜与推荐；点击卡片进入阅读视图，
渲染由 Host 侧白名单清洗过的回答正文。插件同时向同一份 Host 注册六个 Agent 工具，
让 DSH 能读取热榜、推荐、搜索、问题详情**以及当前面板状态**，并能通过 SSE 让面板跳转到指定视图。

整个插件运行在本地 DSH Host 中：登录 Cookie 只保存在本机，前端永远拿不到 Cookie 原文。
插件本身不调用任何 LLM API，浏览与阅读不消耗 DSH Token——只有当你**主动**让 DSH 讨论面板内容时，
才会消耗正常的对话 Token。

## 功能

| | 功能 | 说明 |
|---|---|---|
| 🔥 | 热榜 | 知乎热榜，卡片显示标题、热度、回答数 |
| ✨ | 推荐 | 推荐流，登录后为个性化推荐 |
| 🔍 | 搜索 | 关键词搜索问题/回答（需要登录） |
| 📖 | 阅读 | 问题详情 + 高赞回答，正文由 Host 清洗后渲染 |
| 🧠 | 面板状态 | 每次切换视图都会把当前状态（视图 / 问题 / 关键词 / 选中文本）上报给 Host |
| 🛠️ | Agent 工具 | 六个工具：`zhihu_panel` `zhihu_hot` `zhihu_feed` `zhihu_search` `zhihu_read` `zhihu_open` |
| 🧭 | 面板跳转 | `zhihu_open` 通过 SSE 让已打开的面板切到指定视图/问题 |
| 🔐 | 扫码登录 | 面板内直接出二维码，用知乎 App 扫一扫即可登录；也可粘贴 Cookie（整行 Cookie / 名称=值 / cURL 均可），凭据只存本机 |
| 💬 | 问 DSH | 阅读页一键把当前问题整理成提示词（复制到剪贴板或交给客户端机制） |
| 🌗 | 主题一致 | 只使用 `--dsw-alias-*` 主题变量，自动跟随明暗主题 |

## 安装

### 从 npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-zhihu-mini
```

**桌面版**由 Electron 管理 `desktop` profile，npm CLI 会拒绝它的插件管理请求，
请在 **插件（Plugins）→ 已安装 → 添加插件** 里输入包名 `dsh-zhihu-mini`；
DSH 0.2.2 起也可以先添加插件索引源，再到 **插件 → 发现** 里搜索安装。
安装后刷新页面（宿主代码变更需要完整重启一次），然后在侧边栏找到 **知乎迷你**。

### 从源码 / 本地目录安装（开发）

1. 确认 Node.js 20+（DSH 通常自带）；
2. 在 DSH 会话中让 Agent 用 `plugin_manager` 的 `install_bundle` 安装本仓库的 `plugin` 目录：

```text
plugin_manager({ action: "install_bundle", target: "<repo>/plugin" })
```

3. 读取返回的 `application` / `warnings`：`applied` 表示已生效；`restart-required` 表示需要完整重启 DSH；
4. 刷新页面后在侧边栏找到 **知乎迷你**。

> 本包没有构建脚本、没有原生依赖、没有 `postinstall`；如果包管理器询问 `allowBuilds`，无需授权。

### 首次使用

热榜和推荐**无需登录**即可浏览。搜索与回答正文需要知乎登录：点面板右上角 **登录**，
用知乎 App 扫码，或粘贴浏览器里的 Cookie（详见下文）。

### 环境要求

- DSH 桌面版或 Web 版；
- Node.js 20+；
- 无需安装 npm 依赖，无需构建步骤；
- 能访问 `api.zhihu.com`（部分地区或网络环境可能不可达）。

## 使用

1. 在 DSH 侧边栏打开 **知乎迷你**；
2. **热榜** / **推荐** 直接浏览；点卡片进入 **阅读**；
3. 阅读视图顶部可看到问题标题、回答数、关注数；正文渲染清洗后的高赞回答；
4. 需要搜索时切到 **搜索** 标签，输入关键词回车（未登录会提示登录）；
5. 点 **登录** → 优先点「用知乎 App 扫码登录」，用知乎 App 扫码确认；或按「或粘贴 Cookie」粘贴浏览器 Cookie（必须含 `z_c0`；`SESSIONID` 每个访客都有，不能证明已登录）。获取方法：浏览器登录 zhihu.com → F12 → Network → 任意 `api.zhihu.com` 请求 → Request Headers 里整行 Cookie，或右键 Copy as cURL；
6. 点 **退出** 删除本地 Cookie；
7. 阅读页的 **问 DSH** 会把当前问题整理成一段提示词：如果客户端提供了可用的用户消息入口就用它，否则复制到剪贴板并提示。

### 让 DSH 讨论面板内容

在对话里直接说：

- “我面板上现在是什么？” → DSH 调 `zhihu_panel`
- “总结一下我正在看的这个回答” → `zhihu_panel` 拿到 `selectionText` / `questionId`，再 `zhihu_read`
- “给我看看今天热榜前五” → `zhihu_hot`
- “打开热榜” / “打开问题 123456” → `zhihu_open`，面板收到 SSE 指令后跳转

### Agent 工具一览

| 工具 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `zhihu_panel` | — | `{ view, questionId?, title?, query?, selectionText?, visibleItems?, loggedIn, updatedAt, hint }` | 用户此刻在面板上看到的内容 |
| `zhihu_hot` | `{ limit? }` | 热榜条目（标题 + 热度 + 回答数 + 链接） | 不需要登录 |
| `zhihu_feed` | `{ limit? }` | 推荐条目 | 登录后为个性化 |
| `zhihu_search` | `{ query, limit? }` | 搜索结果 | 需要登录 |
| `zhihu_read` | `{ questionId, answerLimit? }` | 问题元信息 + 高赞回答文本摘要 | |
| `zhihu_open` | `{ view, query?, questionId? }` | `{ delivered, view }` | 通过 SSE 驱动面板；没有面板连接时 `delivered:false` |

工具在面板关闭时也能用：它们读取 Host 缓存或现取。

## 数据与隐私

| 项目 | 实现 |
|---|---|
| Cookie 位置 | 仅本机插件数据目录（`$DSH_HOME/zhihu-mini/credentials.json`，通常是 `~/.dsh/zhihu-mini/`），不写前端 localStorage/sessionStorage |
| 前端可见性 | 前端只拿 `loggedIn` / 昵称 / 头像；永远拿不到 `z_c0` 等 Cookie 原文 |
| 权限 | POSIX 下数据目录 0700、Cookie 文件 0600（best-effort）；Windows 交给用户目录 ACL |
| 网络范围 | 带 Cookie 的请求只发往 `*.zhihu.com` |
| 路由信任 | 所有 `/zhihu-mini` 路由校验回环 Host、拒绝跨站 `Sec-Fetch-Site`、校验同源 Origin/Referer |
| 会话校验 | 用到已保存登录态的接口（信息流 / 搜索 / 回答 / 登录 / 退出 / 扫码）额外校验 **DSH 会话**，无会话返回 401 `session-required`；热榜与面板状态只过信任栅栏 |
| HTML 清洗 | 回答正文在 Host 侧白名单清洗（保留 p/br/strong/em/a/h1-h6/ul/ol/li/blockquote/code/pre/img/figure/figcaption/hr/table 等），去掉 script/style/on* |
| 日志 | 错误信息脱敏；不打印 Cookie |
| 退出登录 | 删除本地 Cookie 文件并清空缓存 |
| 遥测 | 无 |

> 路由信任栅栏只回答“请求是否来自本机页面”，不是身份认证。插件没有远程中转服务器，
> 所有请求只在本机 DSH Host 与知乎之间发生。

**发布前请确认凭据不在发布内容里**：`package.json` 的 `files` 白名单已排除数据目录，`npm pack` 里不会出现 `credentials.json`。

本地数据文件（`$DSH_HOME/zhihu-mini/`，按需创建；旧版的 `plugin/data/` 会在首次启动时自动迁移）：

| 文件 | 内容 |
|---|---|
| `credentials.json` | Cookie 原文 + 解析后的 Cookie 映射 + 缓存的用户资料；**唯一保存 Cookie 的文件**，Best-effort 0600，任何路由都不会返回它 |
| `panel.json` | 最近一次面板快照（无密钥） |
| `cache.json` | 各缓存桶的最近响应（无密钥） |

状态放在 `$DSH_HOME` 而不是包目录，是因为插件安装后位于 `node_modules`，升级会替换整个目录——
放在里面等于每次更新都要重新登录。也可以用 `ZHIHU_MINI_DATA_DIR` 环境变量改到别处。

## 为什么是 0 Token

ZhihuMini 的浏览、刷新、搜索、阅读全部由本地 Host 直接请求知乎公开接口，不经过大模型：

- 不调用 LLM；
- 不需要 API Key；
- 不把阅读内容发送给任何模型服务；
- 只有你让 DSH 讨论面板内容时，才会像普通对话一样消耗上下文 Token。

## 面板状态与 SSE 协议

面板每次切换视图（300ms 防抖）都会 `POST /zhihu-mini/api/panel` 上报：

```ts
type PanelState = {
  view: 'hot' | 'feed' | 'search' | 'reader'
  query?: string
  questionId?: string
  title?: string
  visibleItems?: { id: string, title: string }[]
  selectionText?: string
  answerId?: string
  updatedAt: number
  loggedIn?: boolean
}
```

Agent 工具 `zhihu_open` 通过 `GET /zhihu-mini/api/events`（SSE，`data: <json>`）下发：

```json
{ "type": "open", "view": "reader", "questionId": "123456" }
```

服务端每 25 秒发送 `{"type":"ping"}` 保活；最多 8 个并发订阅。

## 主要路由

所有路由都挂在 `/zhihu-mini` 前缀下：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/hot?limit=30&refresh=1` | 热榜 |
| GET | `/api/feed?limit=12&refresh=1` | 推荐 |
| GET | `/api/search?q=&offset=0&limit=20` | 搜索（需登录） |
| GET | `/api/question?id=&answerLimit=5` | 问题 + 回答 |
| GET | `/api/login/status` | 登录状态 |
| POST | `/api/login/cookie` | 保存并校验 Cookie |
| DELETE | `/api/login` | 退出 |
| GET | `/api/panel` | 读取面板状态 |
| POST | `/api/panel` | 上报面板状态 |
| GET | `/api/events` | SSE 指令流 |

登录相关接口在未登录时不返回 500，而是 HTTP 200 + `{ ok: false, code: 'login-required' }`，面板据此显示登录卡片。

## 已知限制

- 知乎接口、风控与 Cookie 有效期随时可能变化；失效时热榜/搜索会返回错误，需要重新登录；
- 搜索、个性化推荐与部分问题需要登录；匿名热榜通常可用；
- 正文以纯文本 + 白名单 HTML 呈现，不还原知乎的复杂组件（视频、公式、付费墙等不可见）；
- 回答图片来自知乎 CDN，需要网络可访问；
- 面板状态是最近一次上报的快照，不是实时 DOM 镜像；
- 本插件不提供内容下载、去广告、DRM 或付费内容绕过。

## 项目结构

```text
plugin/
├── index.js          Host 入口：路由、SSE、Agent 工具注册
├── zhihu.js          知乎接口封装（匿名 / Cookie 认证、x-zse-96 签名）
├── sanitize.js       白名单 HTML 清洗 + 纯文本投影
├── store.js          本地原子 JSON 持久化（登录、面板状态、缓存）
├── trust.js          回环信任栅栏
├── client.js         浏览器端 React 面板（ModuleLoader 工厂）
├── locale/zh.json    中文界面文案 + meta
├── locale/en.json    英文界面文案 + meta
├── icon.svg          图标（原创）
├── cordis.patch.yml  bundle 补丁
├── package.json      bundle 清单
├── NOTES.md          实现说明与偏差记录
└── LICENSE           MIT
```

## 开发与验证

```bash
# 语法检查
npm run check --prefix plugin

# 静态 + 在线冒烟（在线部分需要 DSH 已启动并安装本插件）
bash tools/e2e.sh
bash tools/e2e.sh --static     # 只做静态检查
```

## 致谢与许可

- 信任栅栏语义参考 [dsh-bili-mini](https://github.com/tuanzhanghao/dsh-bili-mini)（MIT，Copyright (c) tuanzhanghao）；
- 图标为原创 SVG，无第三方素材；
- 本项目以 MIT 许可证发布，见 [LICENSE](./LICENSE)。

> 本项目不是知乎官方产品。使用前请阅读并遵守知乎的服务条款；抓取频率保持在人类浏览量级，不要用于批量采集。