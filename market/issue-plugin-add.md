# 开放插件市场收录申请（可直接粘贴）

提交入口：https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml

> 需要浏览器里已登录 GitHub。表单共 4 个字段，下面按顺序给出可粘贴内容。

## 前置条件（已满足）

| 要求 | 状态 |
|---|---|
| 公开源码 | ✅ https://github.com/LiZH147/dsh-zhihu-mini |
| 可安装的 npm 版本 | ✅ `dsh-zhihu-mini@0.2.0` 已发布（https://www.npmjs.com/package/dsh-zhihu-mini） |
| 明确许可证 | ✅ MIT |

## 字段 1 · 插件地址 / Plugin link（必填）

```text
dsh-zhihu-mini
```

（如需同时给仓库，可在补充信息里写 `https://github.com/LiZH147/dsh-zhihu-mini`（bundle 位于 `plugin/` 子目录）。）

## 字段 2 · 简短说明 / Summary（必填）

```text
知乎侧边栏：在 DSH 里刷热榜、推荐、搜索与问答阅读，支持知乎 App 扫码登录；
同时注册 6 个 Agent 工具（zhihu_panel / zhihu_hot / zhihu_feed / zhihu_search / zhihu_read / zhihu_open），
让 DSH 知道你正在看什么，也能驱动面板跳转。浏览与阅读不消耗 Token，Cookie 只留在本机。
```

## 字段 3 · 插件实际效果 / Plugin screenshots（可选，推荐）

把 `market/screenshots/` 下的三张图拖进输入框，并按此写说明：

| 文件 | 建议说明 |
|---|---|
| `01-hot-list.png` | 热榜视图：卡片显示标题、热度与回答数，顶部可切换热榜 / 推荐 / 搜索 / 阅读 |
| `02-reader.png` | 阅读视图：问题详情 + 高赞回答，正文经 Host 侧白名单清洗后渲染 |
| `03-account.png` | 账号卡：登录时间、可用能力、打开知乎主页、关闭 / 退出 |

> 三张图都已按面板区域裁切，并把示例账号昵称与头像替换为「知乎用户」，不含个人信息。

## 字段 4 · 补充信息 / Additional details（可选）

```text
仓库：https://github.com/LiZH147/dsh-zhihu-mini（DSH bundle 位于 plugin/ 子目录）
npm：https://www.npmjs.com/package/dsh-zhihu-mini
许可证：MIT
已验证 DSH 版本：0.2.2-rc.5（桌面版），面板挂载、6 个 Agent 工具、SSE 面板跳转、扫码登录均正常
平台：Windows（桌面版）验证；纯 Web 实现，无原生依赖、无构建步骤、无 postinstall
其他：零运行时依赖；本地自检 smoke 57 项 + e2e 38 项通过；不调用任何 LLM API，浏览 0 Token
```

## 提交后

1. 维护者审核（通常几天内）后，条目会出现在 dshopen.org 和 DSH 的 **插件 → 发现**；
2. 上架前请确认 npm 上的 `latest` 指向你想让用户装的版本（当前 `0.2.0`）；
3. 若之后要改条目信息（版本、描述、图标），用同一表单提交更正即可。

## 小提示：npm 上的 `0.0.0-stage`

`registry.npmjs.org/dsh-zhihu-mini` 里除了 `0.2.0` 还有一个 `0.0.0-stage` —— 那是 npm 在首次发布时
自动创建的占位版本（`dist-tags.latest` 仍指向 `0.2.0`，用户不会装到它）。如果想彻底清掉，
发布后 72 小时内可以：

```bash
npm unpublish dsh-zhihu-mini@0.0.0-stage --registry=https://registry.npmjs.org
```
