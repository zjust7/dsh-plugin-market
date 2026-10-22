# 上架 GitHub 准备清单（0.10 施工依据）

本文件是 0.09 的产出之一，0.10 按此执行。现状均已核查，不是推测。

---

## 1. 元数据（已在本次施工中补齐）

| 项 | 现状 | 说明 |
|---|---|---|
| `repository` | ✅ 已填 `github.com/zjust7/dsh-plugin-market` | |
| `author` | ✅ `zjust7` | |
| `keywords` | ✅ `dsh` / `dsh-plugin` / `deepseek-harness` / `cordis` / `plugin-market` | |
| `homepage` / `bugs` | ✅ 已填 | |
| `engines.node` | ✅ `>=20` | 与 Host 要求一致 |
| `scripts.test` | ✅ 指向两个测试脚本 | |
| `LICENSE` 文件 | ✅ 已补 MIT 全文（2026 zjust7） | |
| `.gitignore` | ✅ 已补 | 含 `node_modules/`、`.tmp/`、日志、编辑器与系统文件 |
| `.tmp/` 空目录 | ✅ 实际已不存在 | 原清单这条已过时 |
| `name` | ⚠️ **保留 `@local/dsh-plugin-market`** | 见下 |
| `private` | ⚠️ 保留 `true` | 只上 GitHub，保留可防误发 npm |

### 关于 `name`：故意没改

`@local/` 是占位 scope，看着不像公开发布。但**现在改名会直接打断当前安装**：
profile 的 `package.json` 里是以 `@local/dsh-plugin-market: link:…` 挂进来的，
`link:` 依赖的键名必须与包自己的 `name` 一致，改了 profile 就装不起来，
而市场窗口本身正在被改。

改名应当与「从 `link:` 切到 `github:zjust7/dsh-plugin-market`」同一步做，
两次改动合成一次：改 `name` → 改 profile 依赖 → 重装 → 重启。届时 `private`
是否放开也一起定。

---

## 2. 建议的仓库结构

```
dsh-plugin-market/
├── package.json
├── LICENSE                    # MIT 全文，实体文件
├── README.md                  # 中文（当前 README.md）
├── README.en.md               # 英文（已产出）
├── icon.svg
├── index.js                   # Host 半边
├── client.js                  # 浏览器半边（无构建步骤）
├── cordis.patch.yml           # bundle patch
├── locale/
│   ├── zh.json
│   └── en.json
├── docs/
│   ├── API.md                 # Host ↔ 浏览器契约
│   └── DESIGN-0.09.md         # 设计决策记录
├── test/
│   ├── verify-host.mjs        # 从根目录移入
│   └── smoke-host.mjs
├── .gitignore
└── .github/
    └── workflows/
        └── verify.yml         # CI：跑 verify-host.mjs
```

**理由**：

- `test/` 单独成目录，根目录只留运行必需的文件，新读者一眼能看出哪些是代码、哪些是工具。
- `docs/API.md` 已经存在，是这份代码最有价值的文档之一（解释了为什么 spec 用裸包名、为什么未知用 null），应该保留。
- CI 跑 `verify-host.mjs` 能防止后续改动破坏契约——这个测试已经有 200+ 断言。

### `.gitignore`

```
node_modules/
.tmp/
*.log
.DS_Store
Thumbs.db
```

---

## 3. CI 建议

`.github/workflows/verify.yml`：

```yaml
name: verify
on: [push, pull_request]
jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - run: node test/smoke-host.mjs
      - run: node test/verify-host.mjs
        env:
          DSH_MARKET_OFFLINE: '1'   # CI 里不依赖外部站点
```

**为什么 CI 用 `DSH_MARKET_OFFLINE=1`**：`verify-host.mjs` 会真的访问 GitHub 和精选目录，CI 上跑会遇到限流和不稳定。离线模式仍然校验全部路由结构、契约字段和 UI 约定，足够防回归。需要联网的断言在本地手动跑。

---

## 4. 上架前必须人工确认的三件事

1. **隐私**：`index.js` 只存 `GITHUB_TOKEN`（profile 凭据库）。测评数据不需要凭据，
   也不再有任何 `REVIEW_TOKEN`。两者都不进日志。
2. **第三方数据**：精选目录来自 `awesome-dsh-plugin.com`，测评来自 `review.lingshulab.com`。
   README 已写明来源与「不是我们的数据」。
3. **联系测评站**：流量问题已从架构上解决；**但转载授权还没谈**，见下。

### 测评数据的授权边界（0.10 的核心结论）

**先说结论：快照是"转载"，不只是"读取"。公开仓库前必须得到站方同意。**

0.09 的做法是「没凭据就一次都不请求」。技术上正确，产品上是错的——下载插件的人
看不到判定，这个市场就只剩一个能装东西的列表。而站方**没有凭据机制**，
所以「每个用户自己填凭据」这条路本来就不存在。

0.10 改成**公开快照**：

| | 0.09 | 0.10 |
|---|---|---|
| 谁访问站方接口 | 每个安装者，每次打开约 100 次请求 | `tools/reviews-snapshot.mjs`，每天 1 次 |
| 站方承担 | 每次安装一次 API 爆发 | 一份静态文件，走 CDN |
| 用户看到的判定 | 无（需凭据，而凭据不存在） | 完整 |
| 是否转载对方内容 | — | **是（仅判定索引，不含正文）** |

快照只保留 `reviewId` / 标题 / 判定 / 作者 / 时间 / 链接 / 版本，**不含报告正文**，
体积 286 KiB。它是一份结论目录，不是对方站点的镜像——这一条既是体积考虑，
也是转载范围的最小化。

`verify-review-gate.mjs` 用 `fetch` 探针断言两件事：读快照只有一次请求、
**任何指向 `review.lingshulab.com` 的请求都会让测试失败**。23 条断言。

**上架前要跟站方确认的，只有一句话**：

> 我们每天抓一次你们的公开接口，把**判定结果索引**（不含正文）放进仓库的
> `data/reviews.json`，插件读这个文件。可以吗？

如果对方希望自己发快照，把 `reviewSnapshotUrl` 指向他们的地址即可，插件不用改。
如果对方不同意转载，**唯一正确的做法是把 `data/reviews.json` 和整个测评模块拿掉**，
而不是偷偷留着——那会同时违背他们的意愿和这个项目的原则。

---

## 5. 建议的发布顺序

| 步骤 | 内容 |
|---|---|
| 1 | 补全 package.json 元数据 + LICENSE + .gitignore |
| 2 | 移 `test/` 目录，加 CI |
| 3 | 本地跑一遍联网 `verify-host.mjs` 确认全绿 |
| 4 | 发布 GitHub 仓库（private: false 但先不 publish npm） |
| 5 | 观察 1–2 周 issue 反馈 |
| 6 | 再决定是否发 npm |

**建议先只发 GitHub，不发 npm**。原因：`install_bundle` 支持 `github:owner/repo`，发布到 GitHub 就能被安装；npm 一旦发布就不好撤回，等社区验证过再发更稳。
