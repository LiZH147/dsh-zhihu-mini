# 发布指南（dsh-zhihu-mini）

这份文档是"把插件发出去"的完整步骤。发布前的产物已经准备好：`plugin/` 是一个零依赖、
零构建、可直接 `npm publish` 的 DSH bundle。

## 0. 发布前的现状（已验证）

| 检查 | 结果 |
|---|---|
| npm 包名 `dsh-zhihu-mini` | 在 registry.npmjs.org 上 **未被占用**（404） |
| `npm pack --dry-run` | 17 个文件 / 85.3 kB / 解包 328 kB |
| 包里是否含凭据 | **不含**：`files` 白名单排除了数据目录，tarball 里没有 `credentials.json` |
| 运行时依赖 | 0（QR 编码器已 vendored，见 `vendor/`） |
| 构建步骤 | 无（无 `postinstall`，pnpm 不会询问 `allowBuilds`） |
| 许可证 | MIT（`vendor/` 内附 qrcode-generator 的 MIT 声明） |
| 静态检查 | `npm run check` → 7 个 JS 文件 `node --check` 全通过 |

## 1. 建仓库并推上 GitHub

```bash
cd D:/Private/Project/mini-zhihu
git init -b main
git add .gitignore CONTRACT.md USAGE.md PUBLISH.md plugin tools
git commit -m "feat: dsh-zhihu-mini 0.2.0 — Zhihu sidebar for DSH"
git remote add origin https://github.com/<你的用户名>/dsh-zhihu-mini.git
git push -u origin main
```

> `.gitignore` 已经排除了 `.ref/`（逆向参考与截图）和凭据目录。**不要**把 `.ref/` 或
> `$DSH_HOME/zhihu-mini/credentials.json` 提交上去。
> `package.json` 里的 `repository` / `homepage` / `bugs` 现在是占位符 `lizihan147`，
> 换成你自己的用户名后再发布（npm 页面上的链接就是它）。

## 2. 登录 npm（关键坑）

这台机器当前的 registry 是 **npmmirror（淘宝镜像，只读）**，直接 `npm publish` 会被拒。
本仓库的 `publishConfig.registry` 已经写死 `https://registry.npmjs.org`，但**认证**仍要显式做一次：

```bash
npm login --registry=https://registry.npmjs.org
# 或者用 CI token：
# npm config set //registry.npmjs.org/:_authToken=<token>
```

## 3. 发布

```bash
cd plugin
npm run check          # 静态检查（prepublishOnly 也会跑）
npm publish            # publishConfig 已指定 registry + access: public
```

发布成功后验证：

```bash
npm view dsh-zhihu-mini version --registry=https://registry.npmjs.org
npm view dsh-zhihu-mini dist.tarball --registry=https://registry.npmjs.org
```

## 4. 用"用户视角"验一遍

在**另一个** DSH 实例（或先卸载本地链接版）里：

```bash
dsh plugin --profile web add dsh-zhihu-mini
```
桌面版则在 **插件 → 添加插件** 输入 `dsh-zhihu-mini`（desktop profile 由 Electron 管理，CLI 会拒绝）。

装上后确认：侧边栏出现「知乎迷你」、热榜能出数据、扫码能登录。

## 5. 上架开放插件市场（可选，推荐）

社区索引 [dshopen.org](https://dshopen.org) 的收录要求：**公开源码 + 可安装的 npm 版本 + 明确许可证**
（本插件三条都满足）。提交方式：填收录申请表单 —

```
https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml
```

表单里填：包名 `dsh-zhihu-mini`、仓库地址、许可证 MIT、一句话简介、分类（Integrations / UI）。
通过后会出现在 dshopen.org 的插件页，用户也能在 DSH 的开放市场里搜到。

## 5.1 让插件出现在 DSH 内置的「发现」里

DSH 0.2.2 起，**插件 → 发现** 是一个内置插件市场：它从「插件索引」（一个 JSON 文件）读取条目，
用户可以在 GUI 里搜索、看详情、一键安装。索引格式的规则写在 DSH 的 `dsh-plugin-market-index` 包里，
关键约束：

- 索引是 `format: 1` 的 JSON，`plugins[]` 里每个条目包含 `name` / `title{en,zh}` / `icon` /
  `repository` / `homepage` / `metadata.category` / `versions[]` / `description{en,zh}`；
- **每个 version 必须声明 `engines.dsh`**（例如 `">=0.2.1-0 <0.3.0-0"`）。缺了或不匹配，
  用户在“发现”里看到的 Install 按钮是**禁用**的，提示“没有兼容当前 DSH 的版本”；
- **每个 version 还必须带 `publishTimestamp`**：整数、Unix 秒、范围 `[0, 10^11)`。缺了官方校验器会直接报
  `$.plugins[0].versions[0].publishTimestamp must be an integer number of Unix seconds`——这是实测出来的
  （目录收录时通常由生成器填，但**自建索引必须自己写**）；
- `source` 指 npm：`{ type: "npm", registry: "https://registry.npmjs.org/" }`（也可以指 Git 提交）；
- `icon` 用相对索引地址的路径，或 `data:` 内联（≤32 KiB）。

本仓库已经准备好一份可直接提交的条目：[`market/plugin-entry.json`](./market/plugin-entry.json)
（内联了 SVG 图标、声明 `engines.dsh = ">=0.2.1-0 <0.3.0-0"`）。发布 npm 之后，把它登记到索引即可：

1. 提交收录申请：https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml
2. 或自建索引：把 `format: 1` 的 JSON 放到任意 HTTPS 地址，在 DSH 的「发现 → 管理索引源」里加入该地址。

验证方式：在 **插件 → 发现** 里搜「知乎」，条目应显示版本、作者、仓库与安装按钮（不是禁用状态）。

## 6. 之后每次更新

```bash
cd plugin
npm version patch   # 或 minor / major
npm publish
git push --follow-tags
```

两个坑：

- 包管理器可能因 `minimumReleaseAge` 把刚发布的版本当成"太新"而回退到旧版；用户装不到新版时，
  让他们显式指定版本：`dsh plugin add dsh-zhihu-mini@0.2.1`。
- **宿主代码变更需要重启 DSH**（只刷新页面不够）；链接安装时可以用插件行
  `setPluginEnabled` 关再开触发重新加载。

## 6.5 排查：E403 "Two-factor authentication or granular access token with bypass 2fa enabled is required"

这条报错**不是**权限或包名问题，而是：账号开了 2FA，而命令行用的 token 没有"绕过 2FA"的权利。
当前机器状态（已核对）：npm 11.6.0、官方 registry 已登录为 `iizinan`、`~/.npmrc` 里有一个
`//registry.npmjs.org/:_authToken=...`（普通 token，因此被拒）。

### 方案 A：带一次性验证码发布（最快）

```bash
cd plugin
npm publish --otp=123456      # 123456 换成验证器 App 里的 6 位码
```

### 方案 B：生成"可绕过 2FA"的 Granular Token（推荐，之后不用每次输码）

1. 打开 https://www.npmjs.com/settings/iizinan/tokens → **Generate New Token** → **Granular Access Token**；
2. Permissions: **Read and write**；
3. Packages: 首次发布新包必须选 **All packages**（包还不存在，无法按包名授权；发布成功后可以再收窄）；
4. **勾选 "Bypass two-factor authentication"** ← 这条就是报错要求的；
5. 复制 `npm_...`，然后：

```bash
npm config set //registry.npmjs.org/:_authToken=npm_xxxxxxxx
cd plugin && npm publish
```

> token 只写进 `~/.npmrc`（已在家目录，不在仓库里）。不要把 token 提交到任何文件；
> CI 里用环境变量 `NODE_AUTH_TOKEN`。

### 验证是否真的发出去了

```bash
npm view dsh-zhihu-mini version --registry=https://registry.npmjs.org
npm view dsh-zhihu-mini dist.tarball --registry=https://registry.npmjs.org
```

两条都返回 0.2.0 才算成功。发布失败不会占用版本号，可以原样重试。

## 7. 发布前自检清单

- [ ] `npm run check` 通过
- [ ] `npm pack --dry-run` 里没有 `data/`、没有 `credentials.json`
- [ ] `package.json` 的 `repository` / `homepage` 指向真实仓库
- [ ] `README.md` 的安装命令与实际包名一致
- [ ] 版本号按语义化递增（0.2.0 → 0.2.1）
- [ ] 在干净环境里装一次，确认「扫码登录 → 搜索 → 阅读」可用