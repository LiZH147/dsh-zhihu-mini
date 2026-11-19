<div align="center">

<img src="./plugin/icon.svg" width="96" height="96" alt="ZhihuMini" />

# 知乎迷你 · ZhihuMini

**为 DeepSeek Harness（DSH）打造的知乎侧边栏**

热榜 · 推荐 · 搜索 · 问答阅读 · 扫码登录 · Agent 工具 · 0 Token

</div>

> **非官方项目**：第三方插件，与知乎（北京智者天下科技有限公司）、DeepSeek、DSH 官方均无关联。
> 只调用知乎公开的 Web 接口，不绕过登录、付费或风控，不提供内容下载或破解能力。

---

## 这是什么

不离开工作台，也能刷知乎。ZhihuMini 把知乎热榜、推荐流、搜索和问答阅读塞进 DSH 的侧边栏；
更重要的是，它把「你此刻在看什么」通过面板状态快照和 SSE 暴露给 DSH，
于是你可以直接对 DSH 说「总结一下我面板上这篇回答」，或者「帮我打开这个问题」。

```text
┌─ 知乎迷你 ───────────────────────────────────────────┐
│  热榜  |  推荐  |  搜索  |  阅读         [刷新] [登录] │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐                  │
│  │ 标题          │  │ 标题          │                  │
│  │ 热度 · 回答数  │  │ 热度 · 回答数  │                  │
│  └──────────────┘  └──────────────┘                  │
│                                                      │
│  点卡片 → 阅读视图（问题 + 高赞回答）                   │
└──────────────────────────────────────────────────────┘
        ▲ SSE 面板状态 / 打开指令
        │
   DSH Agent（zhihu_panel / zhihu_hot / zhihu_read / zhihu_open …）
```

## 功能

| | 功能 | 说明 |
|---|---|---|
| 🔥 | 热榜 | 知乎热榜，卡片显示标题、热度、回答数 |
| ✨ | 推荐 | 推荐流，登录后为个性化推荐 |
| 🔍 | 搜索 | 关键词搜索问题/回答（需要登录） |
| 📖 | 阅读 | 问题详情 + 高赞回答，正文由 Host 侧白名单清洗后渲染 |
| 🔐 | 扫码登录 | 面板内直接出二维码，知乎 App 扫一扫即可；也支持粘贴 Cookie |
| 🧠 | 面板状态 | 切换视图即上报当前状态（视图 / 问题 / 关键词 / 选中文本） |
| 🛠️ | Agent 工具 | `zhihu_panel` `zhihu_hot` `zhihu_feed` `zhihu_search` `zhihu_read` `zhihu_open` |
| 🧭 | 面板跳转 | `zhihu_open` 通过 SSE 让已打开的面板切到指定视图/问题 |
| 💬 | 问 DSH | 阅读页一键把当前问题整理成提示词 |
| 🌗 | 主题一致 | 只用 `--dsw-alias-*` 主题变量，自动跟随明暗主题 |

## 安装

### 从 npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-zhihu-mini
# 桌面版：在「插件 → 添加插件」里输入包名 dsh-zhihu-mini
```

安装后刷新页面（宿主代码变更需完整重启一次），侧边栏会出现 **知乎迷你**。

### 从源码安装

```bash
git clone https://github.com/LiZH147/dsh-zhihu-mini.git
cd dsh-zhihu-mini
dsh plugin --profile web add "$PWD/plugin"
```

本包零依赖、零构建、无 `postinstall`，不需要授权 `allowBuilds`。

### 首次使用

热榜与推荐**无需登录**即可浏览。搜索和回答正文需要知乎登录：点面板右上角 **登录**，
用知乎 App 扫码；或粘贴浏览器 Cookie（必须含 `z_c0`——`SESSIONID` 每个访客都有，不能证明已登录）。

## 和 DSH 对话

```text
「我面板上现在是什么？」        → zhihu_panel
「总结一下我正在看的这个回答」  → zhihu_panel（拿 selectionText/questionId）→ zhihu_read
「今天热榜前五是什么？」        → zhihu_hot
「打开热榜」/「打开问题 123」   → zhihu_open（SSE 驱动面板跳转）
```

浏览、翻页、点「问 DSH」都不经过模型，**0 Token**；只有你真正发消息给 DSH 时才消耗对话 Token。

## 工作原理

- **客户端**：`plugin/client.js` 通过 DSH 的 `ModuleLoader` 注册 React 面板，挂在 `sidebar.panellist` 槽位，
  并订阅 `/zhihu-mini/api/events` 的 SSE 指令流。
- **宿主**：`plugin/index.js` 用 `ctx.webServer.register` 暴露 `/zhihu-mini/api/*` 路由，
  用 `ctx.tools.register` 注册六个 Agent 工具，所有请求经回环信任栅栏校验。
- **知乎侧**：`plugin/zhihu.js` 封装 `api.zhihu.com`，处理 `x-zse-93`/`x-zse-96` 签名、
  19 位问题 ID 的原样透传，以及扫码登录的二维码会话。

## 仓库结构

```text
.
├── plugin/                # 可发布的 DSH bundle（npm: dsh-zhihu-mini）
│   ├── index.js           # Host 入口：路由、SSE、Agent 工具
│   ├── client.js          # 浏览器端 React 面板
│   ├── zhihu.js           # 知乎接口封装（签名 / 登录 / 数据归一化）
│   ├── store.js           # 本地原子 JSON 持久化
│   ├── sanitize.js        # 白名单 HTML 清洗
│   ├── trust.js           # 回环信任栅栏
│   ├── qr.js + vendor/    # 二维码渲染（MIT，内置）
│   └── README.md          # 完整文档（功能 / 路由 / 工具 / 隐私）
├── tools/                 # 冒烟与 e2e 测试脚本
├── CONTRACT.md            # 路由、工具与数据形状契约
├── USAGE.md               # 使用与协作说明
├── PUBLISH.md             # 发布指南
└── LICENSE                # MIT
```

## 开发与验证

```bash
npm run check --prefix plugin   # 全部 JS 语法检查
node tools/smoke-host.mjs       # 宿主冒烟测试（隔离的数据目录）
bash tools/e2e.sh               # 端到端（需 DSH 已启动并安装本插件）
```

## 数据与隐私

- Cookie 只存在本机 `$DSH_HOME/zhihu-mini/credentials.json`（通常 `~/.dsh/zhihu-mini/`），
  前端永远拿不到 `z_c0` 原文；不写 localStorage，无遥测，无远程中转。
- 带 Cookie 的请求只发往 `*.zhihu.com`；回答正文在 Host 侧按白名单清洗后再进前端。
- 所有本地路由校验回环 Host、拒绝跨站请求与跨源 Origin。
- 发布产物里不含凭据：`files` 白名单已排除数据目录。

## 已知限制

- 知乎接口与风控可能变化；Cookie 失效需重新登录；
- 视频、公式、付费墙等复杂组件不在正文中还原；
- 面板状态是最近一次上报的快照，不是实时 DOM 镜像。

## 文档

| 文档 | 内容 |
|---|---|
| [plugin/README.md](./plugin/README.md) | 完整功能、路由、工具、隐私说明 |
| [USAGE.md](./USAGE.md) | 登录方式与「怎么和 DSH 互动」 |
| [CONTRACT.md](./CONTRACT.md) | 路由 / 工具 / 数据形状契约 |
| [PUBLISH.md](./PUBLISH.md) | 发布与 npm 2FA 排查 |
| [plugin/NOTES.md](./plugin/NOTES.md) | 实现说明与偏差记录 |

## 致谢与许可

- 信任栅栏语义参考 [dsh-bili-mini](https://github.com/tuanzhanghao/dsh-bili-mini)（MIT）；
- 二维码编码器 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT，`plugin/vendor/`）；
- 图标为原创 SVG。

本项目以 [MIT](./plugin/LICENSE) 许可发布。
