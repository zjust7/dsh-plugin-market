# 插件市场 Host API（v2 契约）

浏览器半边（`client.js`）与 Host 半边（`index.js`）之间的唯一契约。所有路由都在
`/api/local-plugin-market` 前缀下，走 `ctx.connection.fetch.register`，与 `/api` 共用
同一道浏览器会话 Cookie 校验。

约定：

- 所有响应都是 JSON，`content-type: application/json; charset=utf-8`，`cache-control: no-store`。
- 成功一律 `{ ok: true, ... }`；失败一律 `{ ok: false, code, message, ... }`。
- `code` 是稳定的机器可读字符串（客户端按它出人话），`message` 是给人看的细节。
- **未知数据用 `null`，不要用 `0` 冒充。** 星标/下载量拿不到就是 `null`，窗口显示 `—`。
- 每个 `Entry` 的 `spec` 已经是「最省事的安装方式」，并且**与 `dsh plugin add` 接受的写法一致**：
  npm 包用**裸包名**（`@scope/pkg`，不加 `npm:` 前缀——`InstallSpecKind` 只有
  `registry | path | git | tarball`，裸包名才是 registry spec）、有发布 tarball 时用**裸 URL**、
  只有 GitHub 仓库才用 `github:<owner>/<repo>`。
  以上游目录自己的 `install` 字段为准（`dsh plugin --profile web add @anonyjcy/dsh-j-space`、
  `… add "https://github.com/…/x.tgz"`、`… add github:CAI-MH/dsh-quality-review`）。

## 数据结构

### Entry（目录行 / 搜索结果行）

```ts
interface Entry {
  repo: string            // "owner/name"
  owner: string
  name: string
  spec: string            // "@scope/pkg" | "github:owner/name" | "https://…/x.tgz"
  url: string             // https://github.com/owner/name
  page?: string           // 精选站点详情页（可选）
  npm?: string            // npm 包名（可选）
  tarball?: string

  description: string     // 已按语言投影；可能为空串
  category: string        // 已按语言投影的显示名；可能为空串
  categoryId: string      // 稳定 id（agi / ui / tools …），空串表示无
  translated: boolean     // 该行是否真的有当前语言的原文

  version: string         // 目录已知的最新版本，空串表示未知
  versionAt?: string      // 该版本的发布时间（ISO），可选

  stars: number | null    // null = 未知，客户端显示 —
  downloads: number | null
  starsAt?: string        // 数据观测时间（ISO / 日期）
  downloadsAt?: string
  forks?: number | null
  license?: string
  updatedAt?: string      // 仓库最后推送时间

  capabilities: string[]
  redLines: string[]
  scanned: boolean
  scannedAt?: string
  added?: string          // 收录日期
  screenshots?: string[]

  installed: boolean
  installedVersion: string
  outdated: boolean
  inCatalog: boolean

  author: { login: string; name?: string; avatar: string; url: string }

  // 0.04 社区测评。review 为 null 表示「确实没有公开报告」；
  // 如果索引本身没拉到，字段同样是 null，但响应里的 reviewLoaded 会是 false。
  review: ReviewSummary | null
  reviewedAt?: number          // 测评站最近一次刷新该插件资料的时间（ms）
  repoUpdatedAt?: number       // 仓库最近一次提交时间（ms）
  manifestVersion?: string     // 测评站读到的 manifest 版本
}
```

### ReviewSummary（0.04）

```ts
interface ReviewSummary {
  count: number                 // 公开报告总数
  verdict: 'helpful' | 'harmful' | 'no-difference' | 'undetermined' | ''
  tier: 'deep' | 'standard' | 'quick' | 'self' | ''   // 空串 = 标题未标注档位
  bestTier: string              // 所有报告里最深的一档（同上枚举）
  tiers: string[]               // 出现过的所有档位
  security: boolean             // 是否真的做过安全专项（deep / quick）
  securityCount: number
  harmfulCount: number          // 历史上有几篇判为「帮倒忙」
  // 最新的一篇「帮倒忙」报告，没有则为 null。**驱动安装前的闸门**，
  // 所以它必须与 harmfulCount 同时存在：只有一篇时两者都非空，
  // 全部是旧报告时 harmfulCount > 0 但 verdict 可能已变好，闸门仍然要拦。
  worstHarmful: {
    reviewId: string
    title: string
    verdict: string
    author: string
    publishedAt: string
    url: string
  } | null
  latest: {
    reviewId: string
    title: string
    verdict: string
    tier: string
    author: string              // 测评者昵称
    publishedAt: string         // ISO
    updatedAt: string
    pluginVersion: string
    dshVersion: string
    evidenceCount: number
    url: string                 // https://review.lingshulab.com/reviews/<id>
  }
  reviews: Array<{ reviewId; title; verdict; tier; author; publishedAt; url }>
}
```

**两条硬规则**（实现必须遵守，测试会验）：

1. `verdict` 只能来自站方 API 的 `verdict` 字段。列表接口不返回它，所以每篇报告都要
   单独读一次详情；**不允许从标题推断判定**。
2. `security` 只在报告档位是 `deep`（深度审计）或 `quick`（安全面快测）时为 `true`。
   标准测评只测能力，不得当作安全结论。

**第三条硬规则（0.09 补，关于闸门位置）**：

3. 安装前的 harmful 闸门必须挂在**下发安装的那个函数**上，不能挂在确认栏组件上。
   客户的四条路径（安装 / 更新 / 重新安装 / 自动更新）都必须经过同一道检查。
   把闸门写进确认栏，就等于只有「安装」这条路受它保护——另外三条会直接调
   `installBundle` 把插件装进去，而读者从未看见判定。

   配套的两条语义：
   - 判定**读不到**（`review` 为 null）不算 harmful，不能因此拒绝安装；
     「站点挂了」和「判过帮倒忙」是两件事。
   - 自动更新是唯一例外：它**不弹窗**，`harmful === true` 与 `harmful === null`
     都跳过并报告，因为后台任务不该在无人看管时从未经验证的数据上做决定。

`tier` 是唯一从标题解析的字段（站方没有结构化档位），无法识别时返回空串，**不猜**。

**档位枚举（0.05）**：`deep`（深度审计）/ `standard`（标准测评）/ `quick`（体验快测）/
`self`（作者自测）/ 空串（未标注）。站方规范里的四档就是这四个；`intake` 不是档位，
是「外部申报」的输入通道，已从枚举里移除。

当前真实分布：深度审计 3、标准测评 20、快测 4、作者自测 **0**、**未标注 38**。
所以「未标注档位」必须是一个真实可渲染的值，不能归入四档中的任何一档。

## GET /find 新增参数（0.05）

- `reviewed=1`：只返回有公开测评报告的插件。
- 响应额外带 `reviewedTotal`（整个目录里有报告的条数，不随分页变化）。

## GET /catalog 新增字段（0.05）

`reviewedTotal`：有公开报告的目录条数，给分类栏的「已测评 N」筛选标签用。
该路由会等待测评索引（最多 12 秒）；拿不到就返回 0 + `reviewLoaded:false`，
窗口不显示该标签，**不会**把它渲染成「全部未测评」。

`author.avatar` 永远是可用 URL（GitHub 头像地址，`https://github.com/<login>.png?size=80`）；
客户端在图片加载失败时回退到首字母色块。

### ChangeResult（安装 / 卸载 / 启停的结果，来自 pluginManager）

原样透传，只把 `packageResult.output` 截到最后 4000 字符：

```ts
interface ChangeResult {
  changed: boolean
  application: 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'
  restartReason?: 'no-hmr' | 'package-moved' | 'host-module' | 'unmanaged-plugin' | 'module-comparison'
  stage: 'install' | 'enable' | 'remove'
  target: string
  enabled?: boolean
  error?: { code: string; diagnostic?: string; incompatible?: unknown[] }
  warnings?: string[]
  packageResult?: {
    exitCode: number
    output: string
    truncated: boolean
    logPath: string
    kind?: 'pnpm-missing' | 'timeout' | 'not-found' | 'no-matching-version'
         | 'network' | 'disk-full' | 'permission' | 'build-blocked' | 'integrity' | 'unknown'
    timedOut?: boolean
  }
  bundle?: string
  version?: string
  pendingBuilds?: string[]
  approvedBuilds?: string[]
  failedAt?: 'registry' | 'spec-host'
}
```

---

## GET /version（0.07）

给标题旁的两个版本标签用。**不依赖目录、不依赖测评站**：目录拉不到时用户更需要知道
自己跑的是哪个版本。

```json
{
  "ok": true,
  "plugin": { "name": "dsh-plugin-market", "version": "0.0.9" },
  "harness": { "version": "0.2.1-rc.2", "source": "C:\\Users\\…\\runtime.json" }
}
```

- `plugin.version` 读自本插件自己的 `package.json`，**不是硬编码常量**，升级版本时不会跟丢。
- `harness.version` 读自桌面启动器写的 `runtime.json` 的 `desktopVersion`。候选路径：
  `DSH_RUNTIME_JSON` 环境变量 → `~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json`。

**诚实规则**：读不到时 `harness.version` 是**空字符串**，窗口渲染成「未知」，
**绝不猜一个看起来合理的版本号**。某个候选文件坏掉或缺字段时继续试下一个，
只有全部失败才是空串。

## GET /catalog

构建（或复用）精选目录。`refresh=1` 丢弃缓存重建。

```json
{
  "ok": true,
  "fetchedAt": 1760000000000,
  "total": 5945,
  "categories":   [{ "category": "UI Enhancements", "count": 1078 }],
  "categoriesZh": [{ "category": "界面增强", "count": 1078 }],
  "languages": ["zh", "en"],
  "defaultLanguage": "zh",
  "sources": [{ "name": "plugins", "ok": true, "bytes": 1763065, "ms": 1523 }],
  "transport": { "kind": "mirror", "name": "jsdelivr", "authenticated": false },
  "token": false,
  "statsAt": "2026-10-19T03:48:14.097Z",
  "downloadsAt": "2026-10-19",
  "versionCount": 3056
}
```

失败：`502 { ok:false, code:'catalog-unreachable', message, sources? }`。

`statsAt` / `downloadsAt` 是目录自带数据的观测时间，客户端用它显示「数据时间」并决定
是否要拉一次 `/stats` 实时刷新。

## GET /find

`q`（空格分词，全部命中）、`cat`（精确分类，用当前语言的名字）、
`sort`=`stars|downloads|name|updated`、`page`（1 起）、`lang`=`zh|en`、`pageSize`=`12..96`。

**收藏筛选（0.10）**：`favs` = 逗号分隔的 `owner/name`。

- 收藏存在浏览器 localStorage 里，Host 不知道谁是收藏，所以由窗口把这份名单上送，
  由 Host 在整份目录上过滤——只有它能跨 6000 行筛选。
- 非法条目（不是 `owner/name`）被**丢弃**，不当作"空名单"：否则一个拼错的名字会
  静默匹配 0 条，看起来像"你没有收藏"。
- 与 `reviewed=1` **可以叠加**：`favs` 只负责成员判定，`reviewed` 负责测评覆盖度判定。

```json
{
  "ok": true, "total": 5945, "page": 1, "pageSize": 24, "totalPages": 248,
  "language": "zh",
  "entries": [Entry]
}
```

`totalPages` 由 Host 算好，客户端不再自己猜。`totalPages` 至少为 1。

## GET /github

`q` 必填；`page`、`sort`=`stars|updated`、`lang`。每页 30 条（GitHub 上限）。

```json
{
  "ok": true, "total": 1234, "page": 1, "pageSize": 30, "totalPages": 42,
  "entries": [Entry], "authenticated": false, "remaining": 9, "reset": 1760000000
}
```

限流：`429 { ok:false, code:'rate-limited', message, authenticated, remaining, reset }`。

## POST /detail

**三处共用的唯一详情接口**（0.06）：精选目录、GitHub 搜索、已安装列表都走它，
避免出现「改了一个详情，其他没改」。

详情抽屉按需拉取，**只对真正打开的那一行**发请求。结果按 repo / 包名缓存 30 分钟
（测评索引本身缓存 6 小时，见 `/review`）。

请求只需给出可识别身份的任意字段：

```json
{ "repo": "owner/name", "npm": "@scope/pkg", "name": "已装包名", "spec": "…" }
```

- `repo` 合法时优先用它。
- 只有包名也能调：Host 从目录反查仓库与 npm 名，**不会**因此报错。已装的 `link:`
  依赖常常既不知道仓库也不知道 npm 名，这是它唯一的可用身份。
- 三个都为空 → `400`。

> 0.06 修掉的真实缺陷：`/detail` 之前不会主动加载测评索引，只有目录列表先把索引
> 暖起来时详情才有 `review`。结果已安装和 GitHub 搜索的抽屉会默默少一整节。
> 现在详情自己会等索引（最多 12 秒），三个入口拿到的东西完全一致。

```json
{
  "ok": true,
  "repo": "owner/name",
  "checkedAt": 1760000000000,
  "npm": "@scope/pkg",
  "latestVersion": "1.9.13",
  "versions": [
    { "version": "1.9.13", "at": "2026-10-19T11:09:09.555Z", "source": "npm", "url": "https://www.npmjs.com/package/…/v/1.9.13", "prerelease": false }
  ],
  "stats": {
    "stars": 463, "downloads": 105573, "forks": 42,
    "pushedAt": "2026-10-19T12:53:47Z", "starsAt": "2026-10-19", "downloadsAt": "2026-10-19",
    "source": "catalog+live"
  },
  "author": { "login": "Han-1413141", "name": "smallsun", "avatar": "https://github.com/Han-1413141.png?size=80", "url": "https://github.com/Han-1413141" },
  "screenshots": ["https://…"],
  "problems": [{ "kind": "github", "message": "HTTP 403" }]
}
```

`versions` 按版本从新到旧排序，最多 30 条；来源优先级 npm → GitHub Release → 目录记录。
`problems` 只用于解释「某个来源没读到」，不是整体失败。

失败：`400 { ok:false, code:'bad-request' }`。

## POST /stats

对**当前可见的那一页**做实时刷新（GitHub 星标 / fork / 推送时间）。Host 把 repo 列表
按 ~8 个一批拼成 `search/repositories?q=repo:a/b+repo:c/d…`，一次搜索覆盖多条；
结果进内存缓存（默认 10 分钟），不会每翻一页就重新打 GitHub。

请求：`{ "repos": ["owner/name", …] }`（最多 60 条，超出截断）

```json
{
  "ok": true,
  "checkedAt": 1760000000000,
  "authenticated": false,
  "remaining": 9,
  "stats": {
    "owner/name": { "stars": 2174, "forks": 224, "pushedAt": "2026-10-18T18:07:47Z",
                    "archived": false, "license": "MIT", "language": "TypeScript",
                    "updatedAt": "2026-10-18T18:07:47Z", "source": "github" }
  },
  "failed": ["other/repo"]
}
```

拿不到的 repo 进 `failed`，客户端保持目录里的值，绝不写 0。

## GET /review-source · POST /review-source（0.10 重写）

测评数据的来源与年龄。**这里没有「连接」这一步**——数据是一份公开快照文件，
不是需要授权的接口。

```json
{ "ok": true,
  "site": "https://review.lingshulab.com",
  "snapshotUrl": "https://raw.githubusercontent.com/zjust7/dsh-plugin-market/main/data/reviews.json",
  "available": true,
  "dataAt": "2026-10-22T04:17:03.000Z",
  "plugins": 132, "reviews": 170,
  "checkedAt": 1761081600000,
  "problem": "" }
```

POST 体：`{ "action": "refresh" }`——忽略缓存，重新读一次快照文件。没有别的动作。

- `available:false` 表示**快照没读到**，不是「没人测评过」。两者在界面上一律分开呈现。
- `dataAt` 是快照自己的 `generatedAt`（采集时间），**不是**本次下载时间。
  一个读者需要知道判定有多新，下载时间说明不了这件事。
- `problem` 是失败原因的原话，直接显示在设置页。
- GET 在冷启动时会自己做一次读取（单次请求 + 6 小时缓存），否则设置页会把
  「还没读」误报成「读不到」。
- 快照 URL 可用插件配置 `reviewSnapshotUrl` 覆盖，**只接受 https**：
  这个 URL 决定判定从哪里来，明文 http 意味着路径上任何人都能改写判定，
  包括那个拦安装的判定。

### 为什么是快照而不是接口

站方没有凭据机制，而他们的授权对象是本项目的作者，不是每一个装了市场的人。
所以两条路都堵着：让用户填凭据（不存在这个机制）、或者让每个安装去读接口
（把一个人的许可变成对别人服务器的分布式压力）。

快照把这件事反过来：站方承担**一份文件的流量**，插件每天读一次。
`tools/reviews-snapshot.mjs` 是唯一访问站方接口的代码，它只保留判定索引
（`reviewId` / 标题 / 判定 / 作者 / 时间 / 链接 / 版本），**不转发报告正文**。

## GET /review（0.04）

返回整个测评索引的紧凑视图，用于画徽章而不用每行发一次请求。

0.10 起数据来自快照文件（单次请求），**不再逐篇读详情**；`refresh=1` 强制重读快照。
快照读不到时返回 **502 `review-unreachable`**，`message` 是失败原因。

```json
{
  "ok": true,
  "fetchedAt": 1760000000000,
  "loaded": true,
  "totalPlugins": 84,
  "reviewedPlugins": 53,
  "sources": [{ "name": "review-plugins", "ok": true }],
  "plugins": [
    {
      "repo": "FuRongJun-1999/dsh-memory",
      "path": ".",
      "pluginId": "01a15224-…",
      "displayName": "@furongjun1999/dsh-memory",
      "manifestVersion": "0.9.6",
      "reviewCount": 1,
      "reviewedAt": 1792415440749,
      "repoUpdatedAt": 1792415227000,
      "url": "https://review.lingshulab.com/plugins/01a15224-…",
      "review": ReviewSummary
    }
  ]
}
```

失败：`502 { ok:false, code:'review-unreachable', loaded }`。**索引拉不到时保留上一份成功
数据**，绝不清空——把「站点挂了」渲染成「未测评」是错误信息。

## GET /catalog · GET /find（新增字段）

两者都额外返回 `reviewLoaded`（索引是否成功加载过）与 `reviewCheckedAt`（索引时间）。
`/find` 的每个 entry 带 `review` / `reviewedAt` / `repoUpdatedAt` / `manifestVersion`。

## POST /detail（新增字段）

在原有字段上增加 `review`（同上）、`reviewedAt`、`repoUpdatedAt`、`reviewLoaded`，
以及可能由 Host 反查得到的 `repo`（反查不到时为 `""`）。
抽屉打开一次就能拿到全部测评信息，不需要额外请求。

### `community`（0.08 向作者提问）

```ts
interface Community {
  repo: string              // "owner/name"
  url: string               // https://github.com/owner/name
  issues: string | null     // 问题列表页
  newIssue: string | null   // 直接打开新建 Issue 表单
  discussions: string | null // 作者开了 Discussions 才有，否则 null
  openIssues: number | null
  known: boolean            // 渠道信息是否真的读到过
  archived: boolean
  homepage: string | null
}
```

- 没有仓库可指（例如反查不到仓库的本地包）时为 `null`，窗口不渲染这一节，
  **绝不给出一个会 404 的链接**。
- `known: false` 表示渠道信息还没读到；此时窗口仍会给「打开仓库」，并注明未读。
- 数据来自 `/stats` 已有的 `search/repositories` 批量请求，**不增加请求数**。

`/stats` 的每条 `stats[repo]` 也新增 `hasIssues` / `hasDiscussions` / `openIssues`。

```json
{ "ok": true, "specResolved": true, "bundles": [Bundle] }
```

```ts
interface Bundle {
  name: string
  version: string
  description: string
  enabled: boolean
  removable: boolean
  rows: number
  error: string | null
  kind: 'local' | 'git' | 'registry' | 'unknown'
  spec: string
  dir: string
  running: boolean
  reason: null | 'disabled' | 'failed' | 'no-rows' | 'not-running' | 'not-selected'
  partial: boolean
  liveRows: number
  failedRows: number
  author?: { login: string; name?: string; avatar: string; url: string }   // 新增
  latestVersion?: string          // 新增：registry 包的最新版本（没有就不给）
}
```

## POST /toggle

请求 `{ "name": "…", "enabled": true }` → `{ ok:true, name, result: ChangeResult }`。

## GET /updates

```json
{ "ok": true, "checkedAt": 1760000000000, "reviewLoaded": true,
  "checks": [{ "name": "…", "checked": true, "kind": "registry", "installed": "1.2.3", "latest": "1.9.0", "outdated": true, "harmful": false }] }
```

检查失败的行：`{ checked:false, kind, reason }`——**不能**渲染成「已是最新」。

### `harmful`（0.09 补）

每个 check 都带 `harmful`：

| 值 | 含义 | 客户端必须怎么用 |
|---|---|---|
| `true` | 至少一篇公开报告判为「帮倒忙」 | 自动更新**必须跳过**，并告诉用户跳过了几个 |
| `false` | 有测评记录，且没有判为帮倒忙 | 可以自动更新 |
| `null` | 测评索引没加载，无法判断 | 自动更新**必须跳过**（不要当作 `false`） |

- 这个字段从 Host 内存里的目录行与测评索引直接读出，**不产生额外请求**。
- 本路由**不会**为了等测评索引而阻塞：`/updates` 是「已安装」页打开时调用的，
  让它等一次冷启动的索引构建，会把点击到出列表的时间拉到 8 秒。
- 需要 `harmful` 一定可用的调用方（自动更新）应当先 `GET /review` 预热索引，再调本路由。

## POST /remove

请求 `{ "name": "…" }` → `{ ok:true, name, result: ChangeResult }`。

## GET /account · POST /account

GET：`{ ok, supported, configured, writable, source, login, avatar, valid, rate, transport }`。
POST：`{ action:'login', token }` 或 `{ action:'logout' }`；token 先验证再落盘。

---

## 安装进度（新增）

安装不再是「一个长 POST 等结果」，而是「带 requestId 的 POST + 轮询进度」。

### POST /install

请求：`{ "spec": "@scope/pkg", "requestId": "pm-1760000000000-ab12", "approvedBuilds": ["esbuild"] }`

`requestId` 可选；不给时 Host 自己生成并回传。Host 把同一个 `requestId` 交给
`pluginManager.installBundle(spec, { requestId, enabled: true, approvedBuilds })`，
这样 pnpm 的进度事件能对上号。

响应（安装结束后才返回）：

```json
{ "ok": true, "spec": "@scope/pkg", "requestId": "pm-…", "result": ChangeResult }
```

失败不是 HTTP 失败：`result.application === 'failed'` 时仍是 `200`，由客户端按
`error.code` / `packageResult.kind` 出人话。

### GET /install-progress?requestId=…&from=0

轮询用，客户端每 400–800ms 拉一次。`from` 是已收到的 `nextSeq`，只回增量日志。

```json
{
  "ok": true,
  "requestId": "pm-…",
  "found": true,
  "phase": "installing",
  "attempt": { "registry": "https://registry.npmjs.org/", "index": 1, "total": 1 },
  "lines": [{ "seq": 12, "stream": "stdout", "text": "Progress: resolved 120, reused 118\n" }],
  "nextSeq": 13,
  "startedAt": 1760000000000,
  "elapsedMs": 4321,
  "result": null,
  "message": null,
  "logPath": "C:/Users/…/.dsh/logs/…"
}
```

- `phase`：`starting` | `checking`（GitHub 连接检查 / registry 试探）| `installing`（pnpm 正在跑）
  | `applying`（写 package.json、启用 bundle）| `done` | `failed` | `cancelled`。
- `found:false` 表示这个 requestId 已经过期或从未存在（客户端应停轮询并回落到
  `POST /install` 的返回值）。
- 结束时 `result` 带上 `ChangeResult`，`message` 是 Host 给的一句话总结。

### POST /install-cancel

请求 `{ "requestId": "pm-…" }` →
`{ ok:true, status: "cancelled" | "too-late" | "not-running" }`。
底层调 `pluginManager.cancelInstall(requestId)`；`too-late` 表示已经在应用阶段，停不下来。

---

## 客户端必须遵守的约定

1. **分页**：用 `totalPages` 渲染页码；`total === 0` 时整条分页栏隐藏。
2. **未知值**：`stars`/`downloads` 为 `null` 显示 `—`，不要显示 `0`。
3. **安装**：先 `POST /install`（不等结果，带 requestId）→ 立刻轮询
   `GET /install-progress` → 完成后用返回的 `result` 走同一套结果渲染。
   进度条按 `phase` 分段推进，`lines` 折叠显示，失败时给「重试 / 打开日志」。
4. **错误人话**：`error.code` 与 `packageResult.kind` 各有一张表，逐条翻成人话；
   `pendingBuilds` 非空时给「允许这些脚本并重试」。
5. **数据时间**：目录行的 `starsAt`/`downloadsAt` 显示在 tooltip；页面打开时对可见页
   调一次 `/stats`，失败就保持目录值。
