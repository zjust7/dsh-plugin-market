/**
 * Browser half of the plugin market window.
 *
 * Two registrations in one module:
 *   - `shell.overlay`         the popup itself, closed until the user opens it;
 *   - `sidebar.footer.action` the button beside Settings that opens it.
 *
 * Nothing here opens or closes on its own: the popup appears on a click and
 * disappears on the ✕, on Escape, or on a click outside the panel.
 *
 * Every network call goes to the Host half, which owns the GitHub token, the
 * catalog cache and the profile's `pluginManager`. The window itself makes no
 * decision about what may be installed: it shows the trust data the catalog
 * carries and requires an explicit confirmation before importing.
 *
 * The v2 contract (docs/API.md) adds four things this file has to honour:
 *   - `totalPages` from /find and /github, rendered as a real pager;
 *   - an `author` on every row, rendered with a letter-tile fallback;
 *   - lazy `POST /detail` per opened drawer, with the version history;
 *   - requestId-based installs: `POST /install` + `GET /install-progress`
 *     polling + `POST /install-cancel`, with human-readable failures.
 */
window.__ModuleLoader__.load({
	id: 'dsh-plugin-market',
	factory(require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const React = require('react');
		const h = React.createElement;
		const Fragment = React.Fragment;
		const useState = React.useState;
		const useEffect = React.useEffect;
		const useRef = React.useRef;

		/** Locale namespace registered with `ctx.locale`. */
		const NS = 'local-plugin-market';
		/** Host half's route prefix. */
		const API = '/api/local-plugin-market';
		/** Catalog page size, mirrored from the Host for the pager. */
		const PAGE_SIZE = 24;
		/**
		 * Page sizes the settings picker offers.
		 *
		 * The Host clamps `/find` to 12–96; these are the three worth putting in
		 * front of a reader, and the list doubles as the validation set for a
		 * hand-edited localStorage entry.
		 */
		const PAGE_SIZES = [24, 36, 48];
		/** Longest note a row will show. One line of the reader's own words. */
		const NOTE_LIMIT = 240;
		/** GitHub caps search at 30 rows per page. */
		const GITHUB_PAGE_SIZE = 30;
		/** How often the install progress endpoint is polled while an install runs. */
		const INSTALL_POLL_MS = 600;
		/** Polling gives up after this long; the POST still owns the final result. */
		const INSTALL_POLL_LIMIT_MS = 10 * 60 * 1000;
		/** The Host caches /detail for 30 minutes; the window keeps its own copy for the session. */
		const DETAIL_TTL_MS = 30 * 60 * 1000;
		/** Ready-made GitHub queries offered as chips. */
		const GITHUB_PRESETS = [
			'dsh-plugin in:name,description',
			'"deepseek harness" plugin',
			'topic:dsh-plugin',
			'dsh-ui in:name',
		];
		/** The install phases, in the order the progress bar fills them. */
		const INSTALL_PHASES = ['starting', 'checking', 'installing', 'applying'];
		/** Rough share of the bar each phase owns; terminal phases are full. */
		const PHASE_PERCENT = { starting: 8, checking: 20, installing: 55, applying: 88, done: 100, failed: 100, cancelled: 100 };

		/** Simplified Chinese window text. */
		const zh = {
			title: '插件市场',
			'tab.catalog': '精选目录',
			'tab.github': 'GitHub 搜索',
			'tab.installed': '已安装',
			'tab.history': '搜索历史',
			'tab.settings': '设置',
			// 0.10: batch operations on the installed list.
			'batch.select': '批量操作',
			'batch.selectAll': '全选',
			'batch.clear': '取消选择',
			'batch.n': '已选 {n} 个',
			'batch.enable': '启用所选',
			'batch.disable': '停用所选',
			'batch.delete': '删除所选',
			'batch.confirmDelete': '确认删除选中的 {n} 个插件？此操作不可撤销。',
			'batch.empty': '还没有勾选插件。',
			'batch.enabledDone': '已启用 {n} 个插件。',
			'batch.disabledDone': '已停用 {n} 个插件。',
			'batch.removedDone': '已删除 {n} 个插件。',
			'batch.partialDone': '完成 {ok}/{n} 个，其余失败。',
			// 0.10: one-click update all.
			'updates.all': '一键更新全部',
			'updates.allHint': '更新所有可更新、未被忽略、且未被独立测评判为有害的插件。',
			'updates.allNone': '没有可更新的插件。',
			'updates.allSkippedHarmful': '有 {n} 个被独立测评判为「帮倒忙」，需逐个手动确认，已跳过。',
			'updates.changelog': '更新内容',
			// 0.10: export / import installed manifest.
			'settings.export': '导出已安装清单',
			'settings.exportHint': '把已安装插件导出为 JSON，换机器时用它恢复。',
			'settings.import': '导入清单',
			'settings.importHint': '从 JSON 清单批量恢复已安装插件。',
			// 0.10: where the profile installs plugins, and how to move it.
			'settings.installDir': '插件安装位置',
			'settings.installDirHint': '插件装在 profile 的 node_modules 下；位置由 DSH 的 profile 决定，可在启动时用 --profile 或环境变量 DSH_PROFILE_DIR 修改。',
			'settings.installDirUnknown': '读不到 profile 目录。',
			'settings.copyPath': '复制路径',
			'settings.copied': '已复制',
			'export.done': '已导出 {n} 个插件。',
			'export.empty': '没有可导出的插件。',
			'import.invalid': '清单无法解析。',
			'import.ready': '识别到 {n} 个插件，开始逐个安装。',
			// 0.10: labs placeholders.
			'settings.labs': '实验室',
			'settings.labsHint': '正在开发的功能，先占位。',
			'labs.dependency': '依赖关系图',
			'labs.dependencyHint': '查看插件之间的依赖与冲突（未开放）',
			'labs.compare': '插件对比',
			'labs.compareHint': '选中 2–3 个插件并排比较（未开放）',
			'labs.comingSoon': '未开放',
			// 0.10: search history placeholder.
			'history.title': '搜索历史',
			'history.hint': '这里会记录你搜过的关键词，方便回到之前看过的插件。',
			'history.empty': '还没有搜索记录。',
			'history.comingSoon': '搜索历史即将开放 · 当前为占位',
			'settings.theme': '主题',
			'settings.themeHint': '只影响这个市场窗口。如果按钮文字看不清，在这里换一种。',
			'settings.theme.auto': '跟随 DSH',
			'settings.theme.dark': '深色',
			'settings.theme.light': '浅色',
			'settings.themeActive': '当前生效：{theme}',
			'settings.preview': '预览',
			'settings.previewHint': '上面三个就是之前看不清的控件，可以直接对比。',
			'settings.language': '语言',
			'settings.lang.zh': '中文',
			'settings.lang.en': 'English',
			'settings.open': '设置',
			'settings.density': '列表信息量',
			'settings.densityHint': '精简每行只留判定和档位，能力清单、红线原文都在详情里。',
			'settings.density.compact': '精简',
			'settings.density.full': '完整',
			'settings.pageSize': '每页条数',
			'settings.pageSizeHint': '只影响精选目录；GitHub 搜索由它自己的接口限制，固定每页 30 条。',
			'settings.startTab': '打开时停在',
			'settings.startTabHint': '下次打开插件市场时生效。',
			// The review source. Every string here has to make the same point: the
			// plugin has no access of its own, and the empty review panels are a
			// missing permission rather than a missing review.
			// The review snapshot. It is a FILE, not an API, so there is nothing to
			// connect: this block says where the data came from, how old it is, and
			// offers a manual refresh.
			'reviewSource.title': '测评数据源',
			'reviewSource.hint': '测评数据来自第三方站点。本插件读的是一份定时重建的公开快照，不直接访问对方接口。',
			'reviewSource.ok': '已加载 · {reviews} 篇报告 / {plugins} 个插件',
			'reviewSource.missing': '快照还没读到',
			'reviewSource.collected': '采集于 {when}',
			'reviewSource.checked': '本次读取于 {when}',
			'reviewSource.refresh': '立即刷新',
			'reviewSource.refreshing': '刷新中…',
			'reviewSource.note': '',
			'reviewSource.problem': '读取失败：{message}',
			// Bookmarks (0.10). Distinct from GitHub stars, which every row already
			// prints: this is the reader's own shortlist.
			'fav.add': '加入收藏',
			'fav.remove': '取消收藏',
			'fav.chip': '收藏 {n}',
			'fav.chipHint': '只看自己收藏的插件。收藏存在本机，不会同步。',
			// Notes (0.10). The other half of a shortlist: a bookmark says "again",
			// a note says why. Also local, also never uploaded.
			'note.label': '我的备注',
			'note.placeholder': '为什么留着它？例如「等它修完 28 万 token 的问题再装」',
			'note.hint': '只存在本机，会显示在列表这一行上。',
			'search.placeholder': '搜索插件名、简介、分类或能力…',
			'search.githubPlaceholder': '搜索 GitHub 仓库，例如 dsh-plugin in:name',
			'search.action': '搜索',
			'sort.label': '排序',
			'sort.stars': '按星标',
			'sort.downloads': '按下载',
			'sort.name': '按名称',
			'sort.updated': '按更新',
			'cat.all': '全部',
			'action.open': '市场',
			'action.close': '关闭',
			'action.refresh': '重新拉取目录',
			'action.install': '安装',
			'action.import': '导入',
			'action.remove': '卸载',
			'action.delete': '删除',
			'action.enable': '启用',
			'action.disable': '停用',
			'action.update': '更新',
			'action.checkUpdates': '检查更新',
			'action.skip': '忽略此更新',
			'action.unskip': '取消忽略',
			'action.cancel': '取消',
			'action.confirm': '确认导入',
			'action.retry': '重试',
			'action.prev': '上一页',
			'action.next': '下一页',
			'action.approveBuilds': '允许这些脚本并重试',
			'action.openRepo': '打开仓库',
			// Version labels (0.07). Kept in their own row so a long harness version
			// never squeezes the title or wraps the tab strip.
			'version.market': '市场 v{version}',
			'version.marketShort': '市场',
			'version.harness': 'DSH v{version}',
			'version.harnessShort': 'DSH',
			'version.unknown': '未知',
			'version.marketHint': '插件市场版本',
			'version.harnessHint': 'DeepSeek Harness 版本（桌面版 runtime.json）',
			'version.harnessUnknownHint': '读不到运行中的 DSH 版本；不会猜测',
			'toggle.title': '打开插件市场',
			'label.installed': '已安装',
			'label.scanned': '已安全扫描',
			'label.catalogUnscanned': '目录收录 · 未扫描',
			'label.unscanned': '未扫描',
			'label.original': '原文',
			// Compact rows show a count instead of the red-line sentences, which are
			// too long to sit on a card. The tooltip carries the words.
			'label.redLineCount': '{n} 条红线',
			// Community review badges (0.04). The wording follows the review site's
			// own five-state spec: it never says "safe", only what was measured.
			'review.helpful': '已测评 · 真有用',
			'review.harmful': '已测评 · 帮倒忙',
			'review.no-difference': '已测评 · 没啥差别',
			'review.undetermined': '已测评 · 还说不准',
			'review.untestable': '已测评 · 没法测',
			'review.untestableHint': '环境不支持或任务不适用，所以没测出结论',
			'review.unknownVerdict': '已测评',
			'review.security': '已做安全专项',
			'review.noSecurity': '未做安全专项',
			'review.title': '社区测评',
			'review.none': '这个插件还没有公开测评报告。',
			'review.unavailable': '测评数据没拉到，所以这里不显示结论（不代表没测评）。',
			'review.latest': '最新一篇',
			'review.more': '还有 {n} 篇',
			'review.less': '收起',
			'review.open': '打开测评报告',
			'review.reviewer': '测评者',
			'review.publishedAt': '报告时间',
			'review.evidence': '{n} 条证据',
			'review.count': '{n} 篇测评',
			'review.chip': '插件评测 {n}',
			'review.chipAll': '插件评测',
			'review.chipHint': '只看有公开测评报告的插件（插件评测）',
			'review.tier.deep': '深度审计',
			'review.tier.standard': '标准测评',
			'review.tier.quick': '体验快测',
			'review.tier.self': '作者自测',
			'review.tier.unstated': '未标注档位',
			'review.tierHint.deep': '深度审计：标准测评 + 安全六威胁全项',
			'review.tierHint.standard': '标准测评：配对对照 + 统计判定',
			'review.tierHint.quick': '体验快测：装一遍、用一遍，不出五状态',
			'review.tierHint.self': '作者自测：作者自己的声明，不是站方成绩',
			'review.tierHint.unstated': '这篇报告的标题没写档位，站方也没有结构化字段',
			'review.reviewedAt': '测评资料时间',
			'review.repoUpdatedAt': '仓库更新时间',
			'review.stale': '报告早于仓库当前提交，结论可能已经过时',
			'review.harmfulWarning': '有 {n} 篇报告判定为「帮倒忙」，装之前先看报告。',
			'label.inCatalog': '在精选目录中',
			'label.stars': '星标',
			'label.downloads': '下载',
			'label.forks': 'Fork',
			'label.rows': '插件行',
			'label.disabled': '已停用',
			'label.enabled': '已启用',
			'label.local': '本地源码',
			'label.upToDate': '已是最新',
			'label.outdated': '有新版本 {version}',
			'label.updateUnknown': '无法检查',
			'label.notChecked': '未检查',
			'label.gitSource': 'Git 来源 · 无版本可比',
			'label.reinstall': '重新拉取最新提交',
			'label.unknownSource': '来源未知',
			'label.checkReason': '原因：{reason}',
			'reason.gitNoRepo': '这是从 Git 仓库安装的，未能定位到具体仓库，无法比较版本。',
			'reason.noReleases': '该仓库没有发布过任何版本，无最新版可比较。',
			'reason.localSource': '本地目录安装，不经过发布渠道，无版本可查。',
			'reason.gitSource': 'Git 安装直连仓库，更新走重装（拉取最新提交）。',
			'label.author': '作者',
			'label.authorUnknown': '作者未知',
			'installed.manifestMissing': '读不到 profile 的 package.json，所以「来源」和「版本状态」都判断不了。这通常意味着 Host 找不到 profile 目录；重启 DSH 后再看，若仍如此请把这个提示告诉我。',
			'installed.latest': '最新 {version}',
			'ver.available': '可安装 {version}',
			'ver.installed': '已装 {version}',
			'ver.fresh': '已是最新',
			'ver.stale': '有新版 {version}',
			'ver.unknown': '版本未知',
			'drawer.title': '插件详情',
			'drawer.close': '关闭详情',
			'drawer.about': '介绍',
			'drawer.capabilities': '功能',
			'drawer.redLines': '安全红线',
			'drawer.repo': 'GitHub 地址',
			'drawer.spec': '安装源',
			'drawer.stats': '数据',
			'drawer.latest': '最新版本',
			'drawer.versions': '版本历史',
			// Host compatibility (0.10): the DSH requirement the newest version
			// declares, checked against the running harness.
			'drawer.engines': '兼容要求',
			'drawer.enginesDsh': '要求 DSH {range}',
			'drawer.enginesOk': '与当前 DSH 兼容',
			'drawer.enginesBad': '当前 DSH 可能不满足此要求',
			// Ask the author (0.08). GitHub gives every repository an issue
			// tracker and optionally a Discussions board.
			'drawer.community': '向作者提问',
			'drawer.screenshotN': '第 {n} 张截图',
			'drawer.screenshotZoomHint': '点击任意处关闭',
			// Provenance block (0.09): where this plugin actually comes from.
			'prov.title': '来源溯源',
			'prov.installFrom': '安装来源',
			'prov.repo': '仓库地址',
			'prov.publisher': '发布者',
			'prov.channel': '分发渠道',
			'prov.channelRegistry': 'npm 注册表',
			'prov.channelGit': 'Git 仓库',
			'prov.npm': 'npm 包名',
			'prov.repoUpdated': '仓库更新',
			'prov.reviewedAt': '测评资料更新',
			'prov.statsAt': '星标数据时间',
			'prov.downloadsAt': '下载量时间',
			'prov.listed': '收录方式',
			'prov.listedCatalog': '精选目录收录',
			'prov.listedGithub': 'GitHub 搜索发现（未收录）',
			'community.issue': '提交 Issue',
			'community.issueHint': '在这里报 bug 或提功能请求，作者会收到通知',
			'community.discussions': '讨论区',
			'community.discussionsHint': '作者开启了 Discussions，适合提问与交流',
			'community.openIssues': '{n} 个未关闭的 Issue',
			'community.archived': '仓库已归档，作者可能不再回复',
			'community.noChannel': '作者关闭了这个仓库的 Issue，也没有开 Discussions，只能通过仓库主页联系',
			'community.unknown': '还没读到这个仓库的反馈渠道，点上面的仓库地址可以直接去问',
			'community.repoOnly': '打开仓库',
			'drawer.noDescription': '（该插件没有提供介绍）',
			'drawer.original': '该条目暂无中文译文，显示的是英文原文。',
			'drawer.translateHint': '右下角的「中 / EN」可以切换这里介绍的语言。',
			'lang.title': '切换列表语言（中 / 英）',
			'lang.zh': '中',
			'lang.en': 'EN',
			'account.title': 'GitHub 账号',
			'account.anon': '匿名模式',
			'account.signed': '已登录',
			'account.anonHint': '目录走 CDN 镜像，不消耗 GitHub API 额度；GitHub 搜索限 10 次/分钟。',
			'account.loginHint': '粘贴一个 GitHub token。建议用 classic token 且不勾选任何 scope（只需要读公开数据）。',
			'account.tokenPlaceholder': 'ghp_… 或 github_pat_…',
			'account.login': '登录',
			'account.logout': '退出登录',
			'account.createToken': '去 GitHub 生成 token →',
			'account.stored': 'token 会保存在 ~/.dsh/.credentials.yaml，和模型 API Key 同一个位置；退出登录即删除。',
			'account.rate': '额度 剩余 {remaining}/{limit}',
			'account.invalid': '这个 token 已失效，请退出后重新登录。',
			'account.busy': '正在向 GitHub 验证…',
			'account.notWritable': '凭据库是只读的，存不进 token（可能被同名环境变量占用）。',
			'account.transportMirror': '目录传输：CDN 镜像（{name}），不占 GitHub 额度',
			'account.transportApi': '目录传输：GitHub API（已认证，5000 次/小时）',
			'account.transportApiAnon': '目录传输：GitHub API（匿名，60 次/小时）',
			'account.expand': 'GitHub 账号 / 登录',
			'account.tokenRequired': '请先粘贴一个 token。',
			'account.unsupported': '当前 Harness 进程还没有账号接口（这个面板是本轮新加的），重启一次 DSH 后即可使用。',
			'group.enabled': '已启用',
			'group.disabled': '未启用',
			'reason.disabled': '已停用：包还在，但插件行被关掉了',
			'reason.failed': '加载失败：插件行报错，没能跑起来',
			'reason.noRows': '已开启但没声明任何插件行，所以不会出现',
			'reason.notRunning': '已开启但未运行：{live}/{total} 行激活',
			'reason.notSelected': '已安装但没加入 bundles，所以从未生效',
			'reason.partial': '部分插件行加载失败（{failed} 行），其余在正常运行',
			'updates.none': '点「检查更新」看看有没有新版本。',
			'updates.allFresh': '全部都是最新版本。',
			'updates.checked': '检查完成，{n} 个可更新。',
			// The automatic pass never gates; it skips and reports. Without this line
			// a harmful package would just silently stop updating and nobody would
			// know why.
			'updates.skippedHarmful': '自动更新跳过了 {n} 个：它们被独立测评判为「帮倒忙」，需要你手动确认。',
			'updates.auto': '自动更新',
			'updates.autoHint': '开启后每次打开 Harness 都会自动检查并按设定间隔更新（{hours} 小时一次）。',
			'updates.autoOff': '自动更新已关闭，只能手动点「更新」。',
			'updates.autoOffShort': '自动更新已关闭',
			'updates.autoOn': '自动更新：每 {hours} 小时',
			'updates.autoSkips': '被独立测评判为「帮倒忙」的插件不会被自动更新，会留给你手动确认。',
			'updates.interval': '间隔',
			'updates.hours': '{n} 小时',
			'confirm.title': '确认导入',
			// The bar is no longer install-only: an update that hits the gate opens
			// it too, and calling that "导入" would misdescribe the action.
			'confirm.titleUpdate': '确认更新',
			'confirm.titleReinstall': '确认重新安装',
			'confirm.spec': '安装源',
			'confirm.bundle': '这是一个 DSH bundle，导入后会作为插件行生效。',
			'confirm.notBundle': '警告：该包没有声明 bundle，导入不会新增插件行。',
			'confirm.unknownBundle': '该来源无法预检是否为 bundle，导入后可能不会生效。',
			'confirm.capabilities': '该插件声明需要：',
			'confirm.redline': '安全扫描红线：',
			'confirm.unscanned': '该仓库不在精选目录的扫描范围内，请自行确认来源可信。',
			// Shown whenever the review source is not connected: the harmless-gate
			// cannot fire without a verdict, and silently installing is exactly the
			// "looks checked when it was not" failure this plugin avoids elsewhere.
			'confirm.reviewSkipped': '测评快照没读到，本次安装没有经过独立测评校验。',
			// Pre-install gate for a plugin independently judged harmful (0.09).
			'gate.badge': '独立测评判定：帮倒忙',
			'gate.count': '共 {n} 篇报告判为帮倒忙',
			'gate.read': '阅读完整报告',
			'gate.confirm': '我已阅读该报告，仍要安装',
			'gate.locked': '先勾选下方确认，才能安装',
			'busy.catalog': '正在拉取精选目录…',
			'busy.install': '正在安装，请稍候…',
			'busy.remove': '正在卸载…',
			'busy.inspect': '正在预检…',
			'busy.checking': '检查中…',
			'empty.catalog': '没有匹配的插件。换个关键词，或切到 GitHub 搜索。',
			'empty.github': '没有结果。试试上面的推荐关键词。',
			'empty.installed': '这个 profile 还没有安装任何 bundle。',
			'installed.dir': '安装目录',
			'installed.source': '来源',
			'installed.versionState': '版本状态',
			'installed.rowsCount': '插件行',
			'installed.state': '运行状态',
			'empty.loading': '加载中…',
			'outcome.applied': '已生效',
			'outcome.restart': '需要重启 DSH 才生效',
			'outcome.overridden': '被更高优先级的配置覆盖',
			'outcome.cancelled': '已取消',
			'outcome.failed': '失败',
			'outcome.removed': '已卸载',
			'outcome.bundle': 'bundle',
			'outcome.error': '错误码',
			'foot.total': '共 {n} 条',
			'foot.page': '第 {p} 页',
			'foot.pageOf': '第 {page} / {total} 页',
			'foot.catalog': '目录 {n} 个插件',
			'foot.dataTime': '数据时间 {time}',
			'foot.noToken': '未配置 GITHUB_TOKEN，GitHub 搜索限速 10 次/分钟',
			'foot.token': '已使用 GITHUB_TOKEN',
			'foot.rate': '剩余 {n} 次',
			'error.catalog': '精选目录拉取失败',
			'error.generic': '操作失败',
			'crash.title': '界面出错了',
			'crash.hint': '这是一个显示错误，不影响已安装的插件。可以重置后重试；如果反复出现，请把它连同控制台里的错误一起反馈。',
			'crash.retry': '重置并重试',
			'error.codeUnknown': '错误码 {code}',
			'error.incompatible': '不兼容的版本：{versions}',
			'error.detailsShow': '显示详情',
			'error.detailsHide': '隐藏详情',
			'error.logPath': '日志：{path}',
			'error.suggestion': '建议：{hint}',
			'err.hint.network': '检查网络或代理后重试。',
			'pager.label': '分页',
			'pager.summary': '第 {page} / {total} 页',
			'stats.dataTime': '数据时间 {time}',
			'stats.downloadsAt': '下载数据 {time}',
			'stats.updated': '最后推送 {time}',
			'progress.title.install': '正在安装',
			'progress.title.update': '正在更新',
			'progress.title.reinstall': '正在重新拉取',
			'progress.phase.starting': '准备',
			'progress.phase.checking': '检查来源',
			'progress.phase.installing': '下载安装',
			'progress.phase.applying': '写入并启用',
			'progress.phase.done': '完成',
			'progress.phase.failed': '失败',
			'progress.phase.cancelled': '已取消',
			'progress.elapsed': '已用 {seconds} 秒',
			'progress.cancel': '取消安装',
			'progress.cancelling': '正在取消…',
			'progress.tooLate': '已经进入写入阶段，停不下来了；让它跑完更安全。',
			'progress.cancelFailed': '取消请求没成功，安装还在继续。',
			'progress.logsShow': '显示日志',
			'progress.logsHide': '隐藏日志',
			'progress.logPath': '日志文件：{path}',
			'progress.attempt': '第 {index}/{total} 个源：{registry}',
			'progress.noLines': '（还没有输出）',
			'progress.runningHint': '安装在 Host 里继续，关掉这个窗口不会中断，但就看不到进度了。',
			'progress.busyOne': '已经有一个安装在跑，等它结束再开始。',
			'versions.loading': '正在读取版本…',
			'versions.empty': '没有版本记录。',
			'versions.error': '版本列表读取失败',
			'versions.problems': '部分来源没读到：',
			'versions.newest': '最新',
			'versions.installed': '已安装',
			'versions.installedAt': '已安装 v{version}',
			'versions.install': '点这一行安装这个版本',
			'versions.source.npm': 'npm',
			'versions.source.release': 'Release',
			'versions.source.catalog': '目录',
			'versions.source.unknown': '未知',
			'versions.checkedAt': '检查于 {time}',
			'err.code.unknown-plugin': '找不到这个插件：Host 不认识这个安装源。',
			'err.hint.unknown-plugin': '刷新目录后重试；仍然失败就打开日志看具体输出。',
			'err.code.invalid-spec': '安装源写法不对，Host 解析不了。',
			'err.hint.invalid-spec': 'npm 包直接写包名（可带 @版本），GitHub 仓库写成 github:<owner>/<repo>。',
			'err.code.already-installed': '这个插件已经装过了。',
			'err.hint.already-installed': '到「已安装」里点更新，或者先卸载再装。',
			'err.code.ambiguous-install': '这个名字对应多个包，Host 不知道装哪个。',
			'err.hint.ambiguous-install': '换成完整包名（可带 @版本）或 github:<owner>/<repo> 再试。',
			'err.code.not-bundle': '这个包不是 DSH bundle，装上也不会出现插件行。',
			'err.hint.not-bundle': '确认它真的提供插件行，否则换一个包。',
			'err.code.not-removable': '这个插件不能由市场卸载（可能是本地链接或受保护）。',
			'err.hint.not-removable': '到 profile 目录手动处理。',
			'err.code.stop-profile': '卸载或停用会弄坏当前 profile，Host 拒绝执行。',
			'err.hint.stop-profile': '先停用相关插件，或换一个 profile 再操作。',
			'err.code.bundle-in-use': '这个 bundle 正在使用中，现在动不了。',
			'err.hint.bundle-in-use': '重启 DSH 后再试。',
			'err.code.stale-approval': '这次脚本批准已经过期（安装流程重启过）。',
			'err.hint.stale-approval': '重新点安装，再批准一次脚本。',
			'err.code.incompatible-version': '版本不兼容：这个包要求的 DSH 版本和当前不同。',
			'err.hint.incompatible-version': '换一个兼容版本，或先升级 DSH。',
			'err.code.operation-error': '安装 / 卸载过程中出错了。',
			'err.hint.operation-error': '打开日志看具体输出。',
			'err.code.bad-request': '请求缺少必要参数。',
			'err.hint.bad-request': '刷新窗口后重试。',
			'err.code.catalog-unreachable': '拉不到精选目录：镜像和 GitHub API 都没成功。',
			'err.hint.catalog-unreachable': '检查网络后点右上角的刷新。',
			'err.code.rate-limited': 'GitHub API 额度用完了。',
			'err.hint.rate-limited': '等一会儿，或在账号面板登录 token。',
			'err.code.inspect-failed': '预检失败，没法确认这个源是什么。',
			'err.hint.inspect-failed': '仍然可以点「确认导入」硬装，但风险自负。',
			'err.code.not-writable': '凭据库是只读的，存不进 token。',
			'err.hint.not-writable': '检查 ~/.dsh/.credentials.yaml 的权限。',
			'err.code.github-unreachable': '连不上 GitHub。',
			'err.hint.github-unreachable': '检查网络或代理。',
			'err.code.github-error': 'GitHub 搜索返回了错误。',
			'err.hint.github-error': '稍后重试，或在账号面板登录 token 提高额度。',
			'err.code.empty-query': 'GitHub 搜索需要先输入关键词。',
			'err.hint.empty-query': '输入关键词或点一个推荐标签。',
			'err.code.detail-failed': '读不到这个插件的版本详情。',
			'err.hint.detail-failed': '稍后重试；插件本身仍然可以安装。',
			'err.code.stats-failed': '拿不到实时星标数据，现在显示的是目录里的旧值。',
			'err.hint.stats-failed': '稍后重试，或配置 token 提高额度。',
			'err.code.installed-failed': '读不到已安装列表。',
			'err.hint.installed-failed': '重启 DSH 后再看。',
			'err.code.toggle-failed': '切换启用状态失败了。',
			'err.hint.toggle-failed': '打开日志看具体输出。',
			'err.code.install-failed': '安装过程抛错了。',
			'err.hint.install-failed': '打开日志看具体输出。',
			'err.code.remove-failed': '卸载过程抛错了。',
			'err.hint.remove-failed': '打开日志看具体输出。',
			'err.code.internal': 'Host 内部出错了。',
			'err.hint.internal': '打开日志看具体输出，必要时重启 DSH。',
			'err.code.invalid-token': '这个 GitHub token 无效。',
			'err.hint.invalid-token': '重新生成一个 token 再登录。',
			'err.code.no-credentials': '还没有保存过 token。',
			'err.hint.no-credentials': '在账号面板粘贴一个 token。',
			'err.code.account-failed': 'GitHub 账号操作失败了。',
			'err.hint.account-failed': '稍后重试。',
			'err.code.logout-failed': '退出登录失败。',
			'err.hint.logout-failed': '手动删除 ~/.dsh/.credentials.yaml 里的 GITHUB_TOKEN。',
			'err.code.cancel-failed': '取消安装的请求失败了。',
			'err.hint.cancel-failed': '等它自己跑完。',
			'err.code.method': '请求方式不对（客户端 bug）。',
			'err.hint.method': '重启 DSH 后重试。',
			'err.code.network': '请求没发出去：网络断了或 Host 没响应。',
			'err.hint.network': '检查网络或代理后重试。',
			'err.kind.pnpm-missing': '这台机器没有可用的 pnpm，装不了 npm 包。',
			'err.hint.kind.pnpm-missing': '先装 pnpm（npm i -g pnpm），再重试。',
			'err.kind.timeout': '安装超时，包可能太大或网络太慢。',
			'err.hint.kind.timeout': '重试一次，或换网络 / 镜像后再试。',
			'err.kind.not-found': 'registry 上找不到这个包（名字或版本不存在）。',
			'err.hint.kind.not-found': '检查包名和版本号。',
			'err.kind.no-matching-version': '没有满足要求的版本。',
			'err.hint.kind.no-matching-version': '去掉版本限制，或换一个版本。',
			'err.kind.network': '网络不通，连不上 registry / GitHub。',
			'err.hint.kind.network': '检查代理或稍后重试。',
			'err.kind.disk-full': '磁盘满了，写不进去。',
			'err.hint.kind.disk-full': '清理磁盘空间后重试。',
			'err.kind.permission': '没有写权限（profile 目录或缓存目录）。',
			'err.hint.kind.permission': '检查目录权限，或用有权限的账号运行 DSH。',
			'err.kind.build-blocked': '这个包的安装脚本被拦下了，需要你批准。',
			'err.hint.kind.build-blocked': '点「允许这些脚本并重试」。',
			'err.kind.integrity': '下载到的包校验失败（可能被篡改或缓存损坏）。',
			'err.hint.kind.integrity': '清掉 pnpm 缓存后重试。',
			'err.kind.unknown': '包管理器失败了，原因不明。',
			'err.hint.kind.unknown': '打开日志看具体输出。',
		};

		/** English window text. */
		const en = {
			title: 'Plugin market',
			'tab.catalog': 'Curated',
			'tab.github': 'GitHub search',
			'tab.installed': 'Installed',
			'tab.history': 'History',
			'tab.settings': 'Settings',
			'batch.select': 'Batch',
			'batch.selectAll': 'Select all',
			'batch.clear': 'Clear selection',
			'batch.n': '{n} selected',
			'batch.enable': 'Enable selected',
			'batch.disable': 'Disable selected',
			'batch.delete': 'Delete selected',
			'batch.confirmDelete': 'Delete the {n} selected plugins? This cannot be undone.',
			'batch.empty': 'No plugins selected.',
			'batch.enabledDone': 'Enabled {n} plugins.',
			'batch.disabledDone': 'Disabled {n} plugins.',
			'batch.removedDone': 'Removed {n} plugins.',
			'batch.partialDone': 'Done {ok}/{n}; the rest failed.',
			'updates.all': 'Update all',
			'updates.allHint': 'Update every plugin that is outdated, not ignored, and not judged harmful by an independent review.',
			'updates.allNone': 'Nothing to update.',
			'updates.allSkippedHarmful': '{n} were judged harmful by an independent review and need manual confirmation; they were skipped.',
			'updates.changelog': 'What changed',
			'settings.export': 'Export installed list',
			'settings.exportHint': 'Export installed plugins as JSON to restore them on another machine.',
			'settings.import': 'Import list',
			'settings.importHint': 'Restore installed plugins from a JSON list.',
			'settings.installDir': 'Install location',
			'settings.installDirHint': 'Plugins install under the profile node_modules. The location is set by the DSH profile; change it at launch with --profile or the DSH_PROFILE_DIR environment variable.',
			'settings.installDirUnknown': 'The profile directory could not be read.',
			'settings.copyPath': 'Copy path',
			'settings.copied': 'Copied',
			'export.done': 'Exported {n} plugins.',
			'export.empty': 'Nothing to export.',
			'import.invalid': 'The list could not be parsed.',
			'import.ready': 'Found {n} plugins; installing them one by one.',
			'settings.labs': 'Labs',
			'settings.labsHint': 'Features under development.',
			'labs.dependency': 'Dependency graph',
			'labs.dependencyHint': 'Show dependencies and conflicts between plugins (not open)',
			'labs.compare': 'Compare plugins',
			'labs.compareHint': 'Pick 2–3 plugins and compare them side by side (not open)',
			'labs.comingSoon': 'Not open',
			'history.title': 'Search history',
			'history.hint': 'Your recent search keywords, to get back to plugins you looked at before.',
			'history.empty': 'No search history yet.',
			'history.comingSoon': 'Search history is coming soon · placeholder',
			'settings.theme': 'Theme',
			'settings.themeHint': 'Affects this market window only. Switch it here if a button label is hard to read.',
			'settings.theme.auto': 'Follow DSH',
			'settings.theme.dark': 'Dark',
			'settings.theme.light': 'Light',
			'settings.themeActive': 'In effect: {theme}',
			'settings.preview': 'Preview',
			'settings.previewHint': 'These are the controls whose labels were unreadable before — compare them directly.',
			'settings.language': 'Language',
			'settings.lang.zh': '中文',
			'settings.lang.en': 'English',
			'settings.open': 'Settings',
			'settings.density': 'Row detail',
			'settings.densityHint': 'Compact keeps the verdict and the tier on the row; capabilities and red-line wording live in the drawer.',
			'settings.density.compact': 'Compact',
			'settings.density.full': 'Full',
			'settings.pageSize': 'Rows per page',
			'settings.pageSizeHint': 'Curated catalog only — GitHub search caps its own results at 30.',
			'settings.startTab': 'Opens on',
			'settings.startTabHint': 'Takes effect the next time the market opens.',
			'reviewSource.title': 'Review source',
			'reviewSource.hint': 'Review data comes from a third-party site. This plugin reads a periodically rebuilt public snapshot rather than calling their API.',
			'reviewSource.ok': 'Loaded · {reviews} reports across {plugins} plugins',
			'reviewSource.missing': 'No snapshot read yet',
			'reviewSource.collected': 'Collected {when}',
			'reviewSource.checked': 'Read {when}',
			'reviewSource.refresh': 'Refresh now',
			'reviewSource.refreshing': 'Refreshing…',
			'reviewSource.note': '',
			'reviewSource.problem': 'Read failed: {message}',
			'fav.add': 'Bookmark',
			'fav.remove': 'Remove bookmark',
			'fav.chip': 'Bookmarked {n}',
			'fav.chipHint': 'Only the plugins you bookmarked. Bookmarks live on this machine and are never uploaded.',
			'note.label': 'My note',
			'note.placeholder': 'Why are you keeping this one? e.g. “revisit once the 280k-token recall is fixed”',
			'note.hint': 'Stored on this machine only, and shown on this row in the list.',
			'search.placeholder': 'Search name, description, category, or capability…',
			'search.githubPlaceholder': 'Search GitHub repositories, e.g. dsh-plugin in:name',
			'search.action': 'Search',
			'sort.label': 'Sort',
			'sort.stars': 'Stars',
			'sort.downloads': 'Downloads',
			'sort.name': 'Name',
			'sort.updated': 'Updated',
			'cat.all': 'All',
			'action.open': 'Market',
			'action.close': 'Close',
			'action.refresh': 'Reload the catalog',
			'action.install': 'Install',
			'action.import': 'Import',
			'action.remove': 'Remove',
			'action.delete': 'Delete',
			'action.enable': 'Enable',
			'action.disable': 'Disable',
			'action.update': 'Update',
			'action.checkUpdates': 'Check updates',
			'action.skip': 'Ignore this update',
			'action.unskip': 'Stop ignoring',
			'action.cancel': 'Cancel',
			'action.confirm': 'Confirm import',
			'action.retry': 'Retry',
			'action.prev': 'Previous',
			'action.next': 'Next',
			'action.approveBuilds': 'Allow these scripts and retry',
			'action.openRepo': 'Open repository',
			'version.market': 'Market v{version}',
			'version.marketShort': 'Market',
			'version.harness': 'DSH v{version}',
			'version.harnessShort': 'DSH',
			'version.unknown': 'unknown',
			'version.marketHint': 'Plugin market version',
			'version.harnessHint': 'DeepSeek Harness version (desktop runtime.json)',
			'version.harnessUnknownHint': 'The running DSH version could not be read; it is not guessed',
			'toggle.title': 'Open the plugin market',
			'label.installed': 'Installed',
			'label.scanned': 'Scanned',
			'label.catalogUnscanned': 'Curated · unscanned',
			'label.unscanned': 'Unscanned',
			'label.original': 'original',
			'label.redLineCount': '{n} red line(s)',
			// Community review badges (0.04).
			'review.helpful': 'Reviewed · helpful',
			'review.harmful': 'Reviewed · harmful',
			'review.no-difference': 'Reviewed · no difference',
			'review.undetermined': 'Reviewed · inconclusive',
			'review.untestable': 'Reviewed · not testable',
			'review.untestableHint': 'The environment did not support it, or the task did not apply',
			'review.unknownVerdict': 'Reviewed',
			'review.security': 'Security sweep done',
			'review.noSecurity': 'No security sweep',
			'review.count': '{n} reports',
			'review.title': 'Community reviews',
			'review.none': 'This plugin has no public review report yet.',
			'review.unavailable': 'The review data could not be loaded, so no verdict is shown (this does not mean it is unreviewed).',
			'review.latest': 'Latest',
			'review.more': '{n} more',
			'review.less': 'Collapse',
			'review.open': 'Open the report',
			'review.reviewer': 'Reviewer',
			'review.publishedAt': 'Published',
			'review.evidence': '{n} evidence links',
			'review.count': '{n} reports',
			'review.chip': 'Plugin reviews {n}',
			'review.chipAll': 'Plugin reviews',
			'review.chipHint': 'Only plugins with a public review report',
			'review.tier.deep': 'Deep audit',
			'review.tier.standard': 'Standard review',
			'review.tier.quick': 'Experience quick test',
			'review.tier.self': 'Author self-test',
			'review.tier.unstated': 'Tier not stated',
			'review.tierHint.deep': 'Deep audit: standard review plus the full six-threat security sweep',
			'review.tierHint.standard': 'Standard review: paired A/B comparison with statistics',
			'review.tierHint.quick': 'Quick test: install and try it once; no five-state verdict',
			'review.tierHint.self': 'Author self-test: the author claim, not a site result',
			'review.tierHint.unstated': 'This report title states no tier, and the site publishes no structured field',
			'review.reviewedAt': 'Review record updated',
			'review.repoUpdatedAt': 'Repository updated',
			'review.stale': 'The report predates the current commit; its conclusion may be out of date',
			'review.harmfulWarning': '{n} report(s) judged this plugin harmful — read them before installing.',
			'label.inCatalog': 'In the curated catalog',
			'label.stars': 'stars',
			'label.downloads': 'downloads',
			'label.forks': 'Forks',
			'label.rows': 'plugin rows',
			'label.disabled': 'Disabled',
			'label.enabled': 'Enabled',
			'label.local': 'Local source',
			'label.upToDate': 'Up to date',
			'label.outdated': 'New version {version}',
			'label.updateUnknown': 'Cannot check',
			'label.notChecked': 'Not checked',
			'label.gitSource': 'Git source · no version to compare',
			'label.reinstall': 'Pull the latest commit',
			'label.unknownSource': 'Unknown source',
			'label.checkReason': 'Reason: {reason}',
			'reason.gitNoRepo': 'Installed from a Git repository that could not be located, so there is no version to compare.',
			'reason.noReleases': 'That repository has never published a release, so there is no latest version to compare.',
			'reason.localSource': 'Installed from a local directory; it bypasses publishing, so there is no version to check.',
			'reason.gitSource': 'A Git install tracks the repository directly; updating means reinstalling the latest commit.',
			'label.author': 'Author',
			'label.authorUnknown': 'Unknown author',
			'installed.manifestMissing': 'The profile package.json could not be read, so neither the source nor the version state can be determined. That usually means the Host could not locate the profile directory; restart DSH and report this line if it persists.',
			'installed.latest': 'latest {version}',
			'ver.available': 'Installable {version}',
			'ver.installed': 'Installed {version}',
			'ver.fresh': 'Up to date',
			'ver.stale': 'New version {version}',
			'ver.unknown': 'Version unknown',
			'drawer.title': 'Plugin details',
			'drawer.close': 'Close details',
			'drawer.about': 'About',
			'drawer.capabilities': 'Capabilities',
			'drawer.redLines': 'Scanner red lines',
			'drawer.repo': 'GitHub address',
			'drawer.spec': 'Install spec',
			'drawer.stats': 'Stats',
			'drawer.latest': 'Latest version',
			'drawer.versions': 'Version history',
			'drawer.engines': 'Compatibility',
			'drawer.enginesDsh': 'Requires DSH {range}',
			'drawer.enginesOk': 'Compatible with this DSH',
			'drawer.enginesBad': 'This DSH may not meet the requirement',
			'drawer.community': 'Ask the author',
			'drawer.screenshotN': 'Screenshot {n}',
			'drawer.screenshotZoomHint': 'Click anywhere to close',
			'prov.title': 'Provenance',
			'prov.installFrom': 'Installs from',
			'prov.repo': 'Repository',
			'prov.publisher': 'Publisher',
			'prov.channel': 'Channel',
			'prov.channelRegistry': 'npm registry',
			'prov.channelGit': 'Git repository',
			'prov.npm': 'npm package',
			'prov.repoUpdated': 'Repository updated',
			'prov.reviewedAt': 'Review record updated',
			'prov.statsAt': 'Star data from',
			'prov.downloadsAt': 'Download data from',
			'prov.listed': 'Listed via',
			'prov.listedCatalog': 'Curated catalog',
			'prov.listedGithub': 'GitHub search (not curated)',
			'community.issue': 'Open an issue',
			'community.issueHint': 'Report a bug or request a feature; the author gets notified',
			'community.discussions': 'Discussions',
			'community.discussionsHint': 'The author enabled Discussions — good for questions',
			'community.openIssues': '{n} open issue(s)',
			'community.archived': 'This repository is archived; the author may no longer reply',
			'community.noChannel': 'Issues are disabled and Discussions are off, so the only way to reach the author is the repository page',
			'community.unknown': 'The feedback channels have not been read yet; the repository link above still reaches the author',
			'community.repoOnly': 'Open the repository',
			'drawer.noDescription': '(this plugin ships no description)',
			'drawer.original': 'This entry has no translation yet; the English original is shown.',
			'drawer.translateHint': 'The 中 / EN control in the bottom-right switches this description.',
			'lang.title': 'Switch the list language (Chinese / English)',
			'lang.zh': '中',
			'lang.en': 'EN',
			'account.title': 'GitHub account',
			'account.anon': 'Anonymous',
			'account.signed': 'Signed in',
			'account.anonHint': 'The catalog travels over CDN mirrors and spends no GitHub API quota; GitHub search is limited to 10/min.',
			'account.loginHint': 'Paste a GitHub token. A classic token with no scopes is enough — it only reads public data.',
			'account.tokenPlaceholder': 'ghp_… or github_pat_…',
			'account.login': 'Sign in',
			'account.logout': 'Sign out',
			'account.createToken': 'Create a token on GitHub →',
			'account.stored': 'The token is stored in ~/.dsh/.credentials.yaml beside the model API keys, and removed when you sign out.',
			'account.rate': 'Quota {remaining}/{limit} left',
			'account.invalid': 'This token is no longer valid; sign out and sign in again.',
			'account.busy': 'Checking with GitHub…',
			'account.notWritable': 'The credential store is read-only, so the token cannot be saved (an environment variable may shadow it).',
			'account.transportMirror': 'Catalog transport: CDN mirror ({name}), no GitHub quota spent',
			'account.transportApi': 'Catalog transport: GitHub API (authenticated, 5000/h)',
			'account.transportApiAnon': 'Catalog transport: GitHub API (anonymous, 60/h)',
			'account.expand': 'GitHub account / sign in',
			'account.tokenRequired': 'Paste a token first.',
			'account.unsupported': 'The running Harness process does not serve the account route yet (this panel is new); restart DSH once.',
			'group.enabled': 'Enabled',
			'group.disabled': 'Not enabled',
			'reason.disabled': 'Disabled: the package is present but its rows are switched off',
			'reason.failed': 'Load failed: its rows errored and never started',
			'reason.noRows': 'Switched on but declares no plugin row, so nothing appears',
			'reason.notRunning': 'Switched on but not running: {live}/{total} rows active',
			'reason.notSelected': 'Installed but never added to bundles, so it never took effect',
			'reason.partial': 'Some rows failed to load ({failed}); the rest runs normally',
			'updates.none': 'Press “Check updates” to see whether newer versions exist.',
			'updates.allFresh': 'Everything is on the latest version.',
			'updates.checked': 'Checked; {n} update(s) available.',
			'updates.skippedHarmful': 'The automatic pass skipped {n}: an independent review judged them harmful, so they need your confirmation first.',
			'updates.auto': 'Auto update',
			'updates.autoHint': 'While on, every Harness start checks and updates at the chosen interval ({hours} h).',
			'updates.autoOff': 'Auto update is off; updates only happen when you press “Update”.',
			'updates.autoOffShort': 'Auto update off',
			'updates.autoOn': 'Auto update: every {hours}h',
			'updates.autoSkips': 'Plugins an independent review judged harmful are never updated automatically — they wait for your confirmation.',
			'updates.interval': 'Every',
			'updates.hours': '{n} h',
			'confirm.title': 'Confirm import',
			'confirm.titleUpdate': 'Confirm update',
			'confirm.titleReinstall': 'Confirm reinstall',
			'confirm.spec': 'Install spec',
			'confirm.bundle': 'This is a DSH bundle; importing it adds plugin rows.',
			'confirm.notBundle': 'Warning: this package declares no bundle; importing it adds no plugin row.',
			'confirm.unknownBundle': 'The source cannot be pre-checked for a bundle, so importing may have no effect.',
			'confirm.capabilities': 'This plugin declares it needs:',
			'confirm.redline': 'Scanner red lines:',
			'confirm.unscanned': 'This repository is outside the curated scan; satisfy yourself that the source is trustworthy.',
			'confirm.reviewSkipped': 'No review snapshot could be read, so this install was not checked against an independent review.',
			'gate.badge': 'Independent review verdict: harmful',
			'gate.count': '{n} report(s) judged this plugin harmful',
			'gate.read': 'Read the full report',
			'gate.confirm': 'I read the report and still want to install',
			'gate.locked': 'Tick the confirmation below to install',
			'busy.catalog': 'Loading the curated catalog…',
			'busy.install': 'Installing, please wait…',
			'busy.remove': 'Removing…',
			'busy.inspect': 'Pre-checking…',
			'busy.checking': 'Checking…',
			'empty.catalog': 'No matching plugin. Try another term, or switch to GitHub search.',
			'empty.github': 'No results. Try one of the suggested queries above.',
			'empty.installed': 'This profile has no installed bundle yet.',
			'installed.dir': 'Install directory',
			'installed.source': 'Source',
			'installed.versionState': 'Version state',
			'installed.rowsCount': 'Plugin rows',
			'installed.state': 'Service state',
			'empty.loading': 'Loading…',
			'outcome.applied': 'Applied',
			'outcome.restart': 'Restart DSH to take effect',
			'outcome.overridden': 'Overridden by a higher-priority layer',
			'outcome.cancelled': 'Cancelled',
			'outcome.failed': 'Failed',
			'outcome.removed': 'Removed',
			'outcome.bundle': 'bundle',
			'outcome.error': 'error',
			'foot.total': '{n} results',
			'foot.page': 'page {p}',
			'foot.pageOf': 'Page {page} / {total}',
			'foot.catalog': 'catalog: {n} plugins',
			'foot.dataTime': 'Data as of {time}',
			'foot.noToken': 'No GITHUB_TOKEN; GitHub search is limited to 10/min',
			'foot.token': 'Using GITHUB_TOKEN',
			'foot.rate': '{n} left',
			'error.catalog': 'Reading the curated catalog failed',
			'error.generic': 'The operation failed',
			'crash.title': 'The window hit an error',
			'crash.hint': 'This is a display error; installed plugins are unaffected. Reset and retry, and if it keeps happening please report it with the console error.',
			'crash.retry': 'Reset and retry',
			'error.codeUnknown': 'Error code {code}',
			'error.incompatible': 'Incompatible versions: {versions}',
			'error.detailsShow': 'Show details',
			'error.detailsHide': 'Hide details',
			'error.logPath': 'Log: {path}',
			'error.suggestion': 'Try: {hint}',
			'err.hint.network': 'Check the network or the proxy, then retry.',
			'pager.label': 'Pagination',
			'pager.summary': 'Page {page} / {total}',
			'stats.dataTime': 'Data as of {time}',
			'stats.downloadsAt': 'Download data {time}',
			'stats.updated': 'Last push {time}',
			'progress.title.install': 'Installing',
			'progress.title.update': 'Updating',
			'progress.title.reinstall': 'Re-fetching',
			'progress.phase.starting': 'Preparing',
			'progress.phase.checking': 'Checking source',
			'progress.phase.installing': 'Downloading',
			'progress.phase.applying': 'Applying',
			'progress.phase.done': 'Done',
			'progress.phase.failed': 'Failed',
			'progress.phase.cancelled': 'Cancelled',
			'progress.elapsed': '{seconds}s elapsed',
			'progress.cancel': 'Cancel install',
			'progress.cancelling': 'Cancelling…',
			'progress.tooLate': 'It already reached the apply step and cannot stop; letting it finish is safer.',
			'progress.cancelFailed': 'The cancel request failed; the install continues.',
			'progress.logsShow': 'Show log',
			'progress.logsHide': 'Hide log',
			'progress.logPath': 'Log file: {path}',
			'progress.attempt': 'Source {index}/{total}: {registry}',
			'progress.noLines': '(no output yet)',
			'progress.runningHint': 'The install continues in the Host; closing this window will not interrupt it, but the progress is lost.',
			'progress.busyOne': 'Another install is still running; wait for it to finish.',
			'versions.loading': 'Loading versions…',
			'versions.empty': 'No version records available.',
			'versions.error': 'Reading the version list failed',
			'versions.problems': 'Some sources failed: ',
			'versions.newest': 'latest',
			'versions.installed': 'installed',
			'versions.installedAt': 'installed v{version}',
			'versions.install': 'Click this row to install this version',
			'versions.source.npm': 'npm',
			'versions.source.release': 'Release',
			'versions.source.catalog': 'catalog',
			'versions.source.unknown': 'unknown',
			'versions.checkedAt': 'checked {time}',
			'err.code.unknown-plugin': 'This plugin cannot be found: the Host does not recognise the install source.',
			'err.hint.unknown-plugin': 'Reload the catalog and retry; if it still fails, open the log for the raw output.',
			'err.code.invalid-spec': 'The install spec is malformed and the Host cannot parse it.',
			'err.hint.invalid-spec': 'Write the package name as-is (optionally name@version); use github:<owner>/<repo> for repositories.',
			'err.code.already-installed': 'This plugin is already installed.',
			'err.hint.already-installed': 'Update it from the Installed tab, or remove it and install again.',
			'err.code.ambiguous-install': 'That name matches several packages, so the Host cannot pick one.',
			'err.hint.ambiguous-install': 'Retry with a full package name (optionally name@version) or a github:<owner>/<repo> spec.',
			'err.code.not-bundle': 'This package is not a DSH bundle; installing it adds no plugin row.',
			'err.hint.not-bundle': 'Check that it really ships plugin rows, or pick another package.',
			'err.code.not-removable': 'The market cannot remove this plugin (a local link or a protected package).',
			'err.hint.not-removable': 'Handle it manually in the profile directory.',
			'err.code.stop-profile': 'Removing or disabling it would break the current profile, so the Host refused.',
			'err.hint.stop-profile': 'Disable the dependent plugins first, or use another profile.',
			'err.code.bundle-in-use': 'This bundle is in use and cannot be changed right now.',
			'err.hint.bundle-in-use': 'Restart DSH and try again.',
			'err.code.stale-approval': 'That script approval has expired (the install flow restarted).',
			'err.hint.stale-approval': 'Press install again and approve the scripts once more.',
			'err.code.incompatible-version': 'Version mismatch: this package requires a different DSH version.',
			'err.hint.incompatible-version': 'Pick a compatible version, or upgrade DSH first.',
			'err.code.operation-error': 'The install / removal step errored.',
			'err.hint.operation-error': 'Open the log for the raw output.',
			'err.code.bad-request': 'The request is missing a required field.',
			'err.hint.bad-request': 'Refresh the window and try again.',
			'err.code.catalog-unreachable': 'The curated catalog could not be read: mirrors and the GitHub API both failed.',
			'err.hint.catalog-unreachable': 'Check the network, then press refresh in the top-right.',
			'err.code.rate-limited': 'The GitHub API quota is exhausted.',
			'err.hint.rate-limited': 'Wait a while, or sign in with a token in the account panel.',
			'err.code.inspect-failed': 'The pre-check failed, so the source cannot be classified.',
			'err.hint.inspect-failed': 'You can still press “Confirm import”, but at your own risk.',
			'err.code.not-writable': 'The credential store is read-only, so the token cannot be saved.',
			'err.hint.not-writable': 'Check the permissions of ~/.dsh/.credentials.yaml.',
			'err.code.github-unreachable': 'GitHub cannot be reached.',
			'err.hint.github-unreachable': 'Check the network or the proxy.',
			'err.code.github-error': 'The GitHub search returned an error.',
			'err.hint.github-error': 'Retry later, or sign in with a token to raise the quota.',
			'err.code.empty-query': 'GitHub search needs a query first.',
			'err.hint.empty-query': 'Type a query, or pick one of the suggested chips.',
			'err.code.detail-failed': 'The version details of this plugin could not be read.',
			'err.hint.detail-failed': 'Retry later; the plugin itself can still be installed.',
			'err.code.stats-failed': 'Live star data is unavailable, so the catalog value is shown.',
			'err.hint.stats-failed': 'Retry later, or configure a token to raise the quota.',
			'err.code.installed-failed': 'The installed list could not be read.',
			'err.hint.installed-failed': 'Restart DSH and look again.',
			'err.code.toggle-failed': 'Switching the enable state failed.',
			'err.hint.toggle-failed': 'Open the log for the raw output.',
			'err.code.install-failed': 'The install step threw.',
			'err.hint.install-failed': 'Open the log for the raw output.',
			'err.code.remove-failed': 'The removal step threw.',
			'err.hint.remove-failed': 'Open the log for the raw output.',
			'err.code.internal': 'The Host hit an internal error.',
			'err.hint.internal': 'Open the log for the raw output; restart DSH if it persists.',
			'err.code.invalid-token': 'This GitHub token is invalid.',
			'err.hint.invalid-token': 'Generate a new token and sign in again.',
			'err.code.no-credentials': 'No token has been saved yet.',
			'err.hint.no-credentials': 'Paste a token in the account panel.',
			'err.code.account-failed': 'The GitHub account operation failed.',
			'err.hint.account-failed': 'Retry later.',
			'err.code.logout-failed': 'Signing out failed.',
			'err.hint.logout-failed': 'Remove GITHUB_TOKEN from ~/.dsh/.credentials.yaml by hand.',
			'err.code.cancel-failed': 'The cancel request failed.',
			'err.hint.cancel-failed': 'Let the install run to completion.',
			'err.code.method': 'Wrong request method (a client bug).',
			'err.hint.method': 'Restart DSH and retry.',
			'err.code.network': 'The request never arrived: the network dropped or the Host did not answer.',
			'err.hint.network': 'Check the network or the proxy, then retry.',
			'err.kind.pnpm-missing': 'This machine has no usable pnpm, so npm packages cannot be installed.',
			'err.hint.kind.pnpm-missing': 'Install pnpm (npm i -g pnpm), then retry.',
			'err.kind.timeout': 'The install timed out; the package may be large or the network slow.',
			'err.hint.kind.timeout': 'Retry once, or switch network / registry mirror.',
			'err.kind.not-found': 'The registry has no such package (name or version missing).',
			'err.hint.kind.not-found': 'Check the package name and version.',
			'err.kind.no-matching-version': 'No version satisfies the requirement.',
			'err.hint.kind.no-matching-version': 'Drop the version range, or pick another version.',
			'err.kind.network': 'The network is down; the registry / GitHub is unreachable.',
			'err.hint.kind.network': 'Check the proxy, or retry later.',
			'err.kind.disk-full': 'The disk is full; nothing could be written.',
			'err.hint.kind.disk-full': 'Free some space and retry.',
			'err.kind.permission': 'No write permission (profile directory or cache directory).',
			'err.hint.kind.permission': 'Check the directory permissions, or run DSH with an account that may write there.',
			'err.kind.build-blocked': 'This package’s install scripts were blocked and need your approval.',
			'err.hint.kind.build-blocked': 'Press “Allow these scripts and retry”.',
			'err.kind.integrity': 'The downloaded package failed verification (tampered or a corrupt cache).',
			'err.hint.kind.integrity': 'Clear the pnpm cache and retry.',
			'err.kind.unknown': 'The package manager failed for an unknown reason.',
			'err.hint.kind.unknown': 'Open the log for the raw output.',
		};

		/** Window styling — theme tokens only. */
		const CSS = [
			// Two local variables replace the assumption that a single Harness token can
			// serve as both a fill and as text on that fill. The accent is always a
			// saturated colour; the text ON it is decided here, per panel theme, so it
			// can never inherit the surrounding label colour and vanish.
			// One solid colour for every selected or committing control: black with white
			// text. A single theme token cannot serve as both a fill and as the text on
			// that fill — in a dark theme it is light, so white-on-it disappears — so the
			// fill and its text are declared here as a pair and never mixed with a token.
			'.dpm-panel{--dpm-solid:#17181c;--dpm-solid-hover:#2a2c33;--dpm-on-solid:#ffffff;}',
			// On a dark panel a pure black button loses its edge, so it is lifted just
			// enough to still read as a button while remaining black with white text.
			'.dpm-panel[data-theme="dark"]{--dpm-solid:#2b2d34;--dpm-solid-hover:#3a3d45;--dpm-on-solid:#ffffff;}',
			// The hairline that separates list rows. Declared as a pair, because a
			// black line on a dark panel is no line at all: light theme gets a
			// near-black line, dark theme the same weight in white.
			//
			// 15% was too faint to do the job. At that value a page of similarly
			// named rows still read as one block, and the eye could not tell which
			// install button belonged to which plugin — which is the only reason
			// this line exists. Raised until the row boundary is unambiguous; the
			// two numbers below are the whole dial if it ever reads too heavy.
			'.dpm-panel{--dpm-hairline:rgba(15,17,20,.5);}',
			'.dpm-panel[data-theme="dark"]{--dpm-hairline:rgba(255,255,255,.32);}',
			'.dpm-backdrop{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;',
			'padding:24px;background:rgba(0,0,0,.45);pointer-events:auto;}',
			'.dpm-panel{position:relative;display:flex;flex-direction:column;width:min(880px,100%);max-height:min(84vh,760px);',
			'border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-overlay);',
			'color:var(--dsw-alias-label-primary);box-shadow:0 24px 64px rgba(0,0,0,.38);overflow:hidden;font-size:13px;line-height:1.45;}',
			// Every non-scrolling row keeps its natural height. Without this the
			// category chip row was squeezed to nothing by the list below it.
			'.dpm-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
			'.dpm-title{font-size:14px;font-weight:600;white-space:nowrap;}',
			// Version pills beside the title (0.08). Inline text, not chips: they must
			// sit in one horizontal row with the title and read as part of the header,
			// with no border or box of their own.
			'.dpm-versions{display:flex;flex-direction:row;align-items:center;gap:8px;min-width:0;',
			'overflow:hidden;flex:0 1 auto;white-space:nowrap;}',
			'.dpm-version-pill{font-size:11px;line-height:1;padding:0;border:0;border-radius:0;background:transparent;',
			'white-space:nowrap;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:0 0 auto;}',
			'.dpm-version-pill[data-kind="plugin"]{border:0;background:transparent;}',
			'.dpm-version-pill[data-unknown="true"]{border:0;opacity:.6;}',
			'.dpm-tabs{display:flex;gap:2px;}',
			'.dpm-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:4px 10px;',
			'border-radius:7px;font:inherit;cursor:pointer;white-space:nowrap;}',
			'.dpm-tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
			'.dpm-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;}',
			'.dpm-spacer{flex:1 1 auto;}',
			'.dpm-icon{width:24px;height:24px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;',
			'border:0;padding:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;}',
			'.dpm-icon:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
			// Bookmarks the row. Smaller than a toolbar icon because it sits inside a
			// text line, and centred rather than baseline-aligned for the same reason.
			'.dpm-fav{width:18px;height:18px;align-self:center;}',
			'.dpm-fav[data-active="true"]{color:var(--dsw-alias-brand-primary);}',
			'.dpm-search{flex:0 0 auto;display:flex;gap:8px;padding:12px 14px 8px;align-items:center;}',
			'.dpm-input{flex:1 1 auto;min-width:0;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);',
			'color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 10px;font:inherit;}',
			'.dpm-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}',
			'.dpm-select{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);',
			'color:var(--dsw-alias-label-primary);border-radius:8px;padding:7px 8px;font:inherit;}',
			// Every button is solid black with white text — one shape, one colour. It
			// needs no theme token, so it is legible whatever the surrounding theme is;
			// a dark panel lifts the fill slightly so the button keeps a visible edge.
			'.dpm-button{border:1px solid var(--dpm-solid);background:var(--dpm-solid);',
			'color:var(--dpm-on-solid);border-radius:8px;padding:6px 12px;font:inherit;cursor:pointer;white-space:nowrap;',
			'transition:background .12s ease,border-color .12s ease;}',
			'.dpm-button:hover:enabled{background:var(--dpm-solid-hover);border-color:var(--dpm-solid-hover);}',
			'.dpm-button:disabled{opacity:.5;cursor:default;}',
			// The committing action on a bar is the same black as everything else; it is
			// set apart by weight, not by a second colour.
			'.dpm-button[data-kind="primary"]{font-weight:600;}',
			// Destructive stays black-on-white; only its edge turns red, so the warning
			// reads without introducing a conflicting fill.
			'.dpm-button[data-kind="danger"]{border-color:var(--dsw-alias-state-error-primary);}',
			// The action cell never shrinks: a squeezed cell is what clipped the
			// install label before.
			'.dpm-actions{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:6px;}',
			'.dpm-chips{flex:0 0 auto;display:flex;gap:6px;overflow-x:auto;padding:2px 14px 9px;',
			'border-bottom:1px solid var(--dsw-alias-border-l1);scrollbar-width:thin;}',
			'.dpm-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);',
			'border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;}',
			'.dpm-chip:hover{color:var(--dsw-alias-label-primary);}',
			// A selected chip is the only thing on this row telling the reader
			// which filter is in force, so it gets the same solid fill as the
			// active page number and the segmented control. An accent border on a
			// 12px pill is one hairline and reads as "not selected at all" — the
			// fill, the white text and the weight all change together.
			'.dpm-chip[data-active="true"]{border-color:var(--dpm-solid);background:var(--dpm-solid);',
			'color:var(--dpm-on-solid);font-weight:600;}',
			// Keeps the label white while the pointer is over a selected chip;
			// the plain :hover rule above would otherwise repaint it dark.
			'.dpm-chip[data-active="true"]:hover{color:var(--dpm-on-solid);}',
			'.dpm-body{flex:1 1 auto;overflow-y:auto;padding:2px 6px 8px;min-height:180px;min-width:0;}',
			// Every row is outlined. Before this the only cue that a row had ended was
			// the hover background, so a page of similar names read as one block and
			// the eye lost track of which install button belonged to which plugin.
			'.dpm-card{display:flex;gap:12px;align-items:flex-start;padding:10px 9px;border-radius:10px;',
			'border:1px solid var(--dpm-hairline);}',
			// A gap between consecutive cards only: group headers and hints sit between
			// them in the installed tab and must not push their own margins around.
			'.dpm-card + .dpm-card{margin-top:6px;}',
			// Hover lifts the surface, not the edge: with a real hairline in place,
			// swapping it for the lighter `border-l2` made the row under the pointer
			// look less defined than its neighbours.
			'.dpm-card:hover{background:var(--dsw-alias-bg-layer-1);}',
			'.dpm-main{flex:1 1 auto;min-width:0;}',
			'.dpm-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}',
			'.dpm-repo{font-weight:600;word-break:break-all;}',
			'.dpm-meta{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap;}',
			'.dpm-desc{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:3px;',
			'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
			// The reader's own note. Full label colour, not the muted description
			// colour — this is the line they wrote, and it should not look like more
			// catalog metadata. The left rule marks the change of author.
			'.dpm-note{font-size:12px;line-height:1.5;margin-top:5px;padding:1px 0 1px 8px;',
			'border-left:2px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);',
			'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word;}',
			// The drawer's note field spans its column; `.dpm-input` is sized for a
			// search row, where growing sideways is the right behaviour.
			'.dpm-note-input{width:100%;box-sizing:border-box;}',
			'.dpm-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px;}',
			'.dpm-tag{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);',
			'color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
			'.dpm-tag[data-risk="true"]{background:transparent;border:1px solid var(--dsw-alias-state-warn-primary);',
			'color:var(--dsw-alias-state-warn-primary);}',
			'.dpm-tag[data-trust="true"]{background:transparent;border:1px solid var(--dsw-alias-state-success-primary);',
			'color:var(--dsw-alias-state-success-primary);}',
			// Community review badges (0.04). Each verdict gets its own colour so a
			// harmful report can never be mistaken for a clean one at a glance.
			'.dpm-review-tags{margin-top:5px;}',
			'.dpm-review{font-weight:600;}',
			'.dpm-review[data-verdict="helpful"]{background:transparent;border:1px solid var(--dsw-alias-state-success-primary);',
			'color:var(--dsw-alias-state-success-primary);}',
			'.dpm-review[data-verdict="harmful"]{background:transparent;border:1px solid var(--dsw-alias-state-error-primary);',
			'color:var(--dsw-alias-state-error-primary);}',
			'.dpm-review[data-verdict="no-difference"]{background:transparent;border:1px solid var(--dsw-alias-border-l2);',
			'color:var(--dsw-alias-label-secondary);}',
			'.dpm-review[data-verdict="undetermined"]{background:transparent;border:1px solid var(--dsw-alias-state-warn-primary);',
			'color:var(--dsw-alias-state-warn-primary);}',
			'.dpm-review[data-verdict="unknown"]{background:transparent;border:1px solid var(--dsw-alias-border-l2);',
			'color:var(--dsw-alias-label-secondary);}',
			'.dpm-review-tier{background:transparent;border:1px dashed var(--dsw-alias-border-l2);',
			'color:var(--dsw-alias-label-secondary);}',
			'.dpm-review-security{background:transparent;border:1px solid var(--dsw-alias-brand-primary);',
			'color:var(--dsw-alias-brand-primary);}',
			// The reviewed filter chip: visually distinct from a category, because
			// it selects on review coverage rather than on a curated bucket. The
			// green identity lives in the idle state only — a selected chip always
			// looks selected, the same way everywhere in the window. Filling with
			// success-primary was rejected: that token is theme-dependent and a
			// white label on a light green is unreadable in a dark theme.
			'.dpm-chip-review{border-color:var(--dsw-alias-state-success-primary);',
			'color:var(--dsw-alias-state-success-primary);font-weight:600;}',
			'.dpm-chip-review[data-active="true"]{border-color:var(--dpm-solid);background:var(--dpm-solid);',
			'color:var(--dpm-on-solid);font-weight:600;}',
			'.dpm-chip-review[data-active="true"]:hover{color:var(--dpm-on-solid);}',
			'.dpm-review-harmful{background:transparent;border:1px solid var(--dsw-alias-state-error-primary);',
			'color:var(--dsw-alias-state-error-primary);font-weight:700;}',
			// Review section inside the detail drawer.
			'.dpm-review-card{display:flex;flex-direction:column;gap:6px;padding:9px 10px;border-radius:8px;',
			'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}',
			'.dpm-review-card[data-verdict="harmful"]{border-color:var(--dsw-alias-state-error-primary);}',
			'.dpm-review-card[data-verdict="undetermined"]{border-color:var(--dsw-alias-state-warn-primary);}',
			'.dpm-review-card-title{font-size:12px;font-weight:600;line-height:1.45;word-break:break-word;}',
			'.dpm-review-card-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;',
			'color:var(--dsw-alias-label-secondary);font-size:11px;}',
			'.dpm-review-times{display:flex;flex-direction:column;gap:2px;font-size:11px;',
			'color:var(--dsw-alias-label-secondary);}',
			'.dpm-foot{flex:0 0 auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 14px;',
			'border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;}',
			'.dpm-bar{flex:0 0 auto;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);',
			'display:flex;flex-direction:column;gap:6px;}',
			'.dpm-bar-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
			'.dpm-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;',
			'background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 6px;word-break:break-all;}',
			'.dpm-empty{padding:34px 14px;text-align:center;color:var(--dsw-alias-label-secondary);}',
			'.dpm-hint{padding:8px 10px;margin:4px 2px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);',
			'color:var(--dsw-alias-label-secondary);font-size:12px;}',
			'.dpm-path{margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;',
			'color:var(--dsw-alias-label-secondary);word-break:break-all;}',
			'.dpm-group{display:flex;align-items:center;gap:8px;padding:10px 10px 4px;',
			'color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;}',
			'.dpm-group-line{flex:1 1 auto;height:1px;background:var(--dsw-alias-border-l1);}',
			'.dpm-lang{position:absolute;z-index:8;right:16px;bottom:14px;display:flex;align-items:center;gap:4px;',
			'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:999px;',
			'padding:3px;box-shadow:0 6px 18px rgba(0,0,0,.24);}',
			'.dpm-lang button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;',
			'padding:3px 9px;font:inherit;font-size:12px;cursor:pointer;}',
			// Same rule as the primary button: white on the brand colour, because the
			// "on-brand" token does not exist and an unset colour inherits dark text.
			'.dpm-lang button[data-active="true"]{background:var(--dpm-solid);',
			'color:var(--dpm-on-solid);font-weight:600;}',
			'.dpm-lang-note{color:var(--dsw-alias-label-secondary);font-size:11px;padding:0 4px;}',
			// Per-row version availability in the curated list.
			'.dpm-ver{font-size:11px;padding:1px 7px;border-radius:999px;white-space:nowrap;',
			'border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);}',
			'.dpm-ver[data-state="fresh"]{border-color:var(--dsw-alias-state-success-primary);',
			'color:var(--dsw-alias-state-success-primary);}',
			'.dpm-ver[data-state="stale"]{border-color:var(--dsw-alias-state-warn-primary);',
			'color:var(--dsw-alias-state-warn-primary);}',
			'.dpm-ver[data-state="available"]{border-color:var(--dsw-alias-brand-primary);',
			'color:var(--dsw-alias-brand-primary);}',
			'.dpm-card[data-clickable="true"]{cursor:pointer;}',
			// The selected row recolours its own border instead of drawing an outline
			// on top of it — with a visible hairline, the inset outline sat one pixel
			// inside the border and read as a double line.
			'.dpm-card[data-selected="true"]{background:var(--dsw-alias-bg-layer-2);',
			'border-color:var(--dsw-alias-brand-primary);}',
			// Author chip: avatar plus login, with a letter tile as the fallback.
			'.dpm-author{display:inline-flex;align-items:center;gap:4px;max-width:190px;min-width:0;',
			'color:var(--dsw-alias-label-secondary);font-size:12px;text-decoration:none;}',
			'.dpm-author:hover{color:var(--dsw-alias-label-primary);}',
			'.dpm-author-login{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
			'.dpm-avatar{width:16px;height:16px;border-radius:50%;object-fit:cover;flex:0 0 auto;',
			'background:var(--dsw-alias-bg-layer-2);}',
			'.dpm-avatar-letter{display:inline-flex;align-items:center;justify-content:center;',
			'color:var(--dsw-alias-label-secondary);font-weight:600;text-transform:uppercase;}',
			// Pager in the footer: prev / numbered pages / next.
			'.dpm-pager{display:flex;align-items:center;gap:4px;flex-wrap:wrap;}',
			'.dpm-pager-btn{min-width:26px;height:26px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);',
			'border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;}',
			'.dpm-pager-btn:hover:enabled{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);}',
			'.dpm-pager-btn:disabled{opacity:.4;cursor:default;}',
			'.dpm-pager-btn[data-active="true"]{background:var(--dpm-solid);',
			'border-color:var(--dpm-solid);color:var(--dpm-on-solid);font-weight:600;}',
			'.dpm-pager-gap{color:var(--dsw-alias-label-secondary);padding:0 2px;}',
			// Detail drawer on the right edge of the popup.
			'.dpm-drawer{position:absolute;top:0;right:0;bottom:0;z-index:5;display:flex;flex-direction:column;',
			'width:min(380px,54%);background:var(--dsw-alias-bg-overlay);border-left:1px solid var(--dsw-alias-border-l2);',
			'box-shadow:-18px 0 40px rgba(0,0,0,.28);}',
			'.dpm-drawer-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:12px 14px;',
			'border-bottom:1px solid var(--dsw-alias-border-l1);}',
			'.dpm-drawer-body{flex:1 1 auto;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:12px;}',
			'.dpm-drawer-title{font-size:15px;font-weight:600;word-break:break-all;}',
			'.dpm-drawer-desc{font-size:13px;line-height:1.55;}',
			'.dpm-drawer-foot{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:10px 120px 10px 14px;',
			'border-top:1px solid var(--dsw-alias-border-l1);}',
			'.dpm-field{display:flex;flex-direction:column;gap:3px;min-width:0;}',
			'.dpm-field-label{font-size:11px;letter-spacing:.04em;text-transform:uppercase;',
			'color:var(--dsw-alias-label-secondary);}',
			'.dpm-repolink{color:var(--dsw-alias-brand-primary);text-decoration:none;font-size:12px;word-break:break-all;}',
			'.dpm-repolink:hover{text-decoration:underline;}',
			'.dpm-link{border:0;background:transparent;padding:0;font:inherit;font-size:11px;',
			'color:var(--dsw-alias-brand-primary);cursor:pointer;}',
			'.dpm-link:hover{text-decoration:underline;}',
			// "Ask the author" links (0.08): plain inline links, not buttons, so
			// they read as part of the drawer's field list.
			'.dpm-community{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}',
			'.dpm-community-link{color:var(--dsw-alias-brand-primary);text-decoration:none;font-size:12px;',
			'white-space:nowrap;}',
			'.dpm-community-link:hover{text-decoration:underline;}',
			// Screenshot strip (0.09). Images are external GitHub URLs; a failed
			// load collapses instead of showing a broken-image icon.
			'.dpm-shots{display:flex;flex-direction:column;gap:6px;}',
			'.dpm-shots-main{display:flex;align-items:center;justify-content:center;',
			'border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;',
			'background:var(--dsw-alias-bg-base);min-height:0;}',
			'.dpm-shot-big{display:block;max-width:100%;max-height:240px;width:auto;height:auto;object-fit:contain;cursor:zoom-in;}',
			'.dpm-shots-thumbs{display:flex;gap:6px;overflow-x:auto;scrollbar-width:thin;}',
			'.dpm-shot-thumb{flex:0 0 auto;width:64px;height:40px;padding:0;border-radius:6px;cursor:pointer;',
			'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);overflow:hidden;}',
			'.dpm-shot-thumb img{display:block;width:100%;height:100%;object-fit:cover;}',
			'.dpm-shot-thumb[data-active="true"]{border-color:var(--dsw-alias-brand-primary);',
			'box-shadow:0 0 0 1px var(--dsw-alias-brand-primary);}',
			'.dpm-lightbox{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.84);',
			'display:flex;align-items:center;justify-content:center;padding:28px;cursor:zoom-out;}',
			'.dpm-lightbox img{max-width:100%;max-height:100%;object-fit:contain;',
			'box-shadow:0 10px 48px rgba(0,0,0,.55);border-radius:4px;}',
			'.dpm-lightbox-hint{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);',
			'color:rgba(255,255,255,.75);font-size:12px;pointer-events:none;}',
			// Version history list inside the drawer. Its own class, NOT `.dpm-versions`:
			// that name belongs to the header's version pills, and reusing it here made
			// the later rule (this one) turn the pills into a vertical column inside a
			// bordered box.
			'.dpm-version-list{display:flex;flex-direction:column;gap:2px;max-height:210px;overflow-y:auto;',
			'border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:4px;background:var(--dsw-alias-bg-base);}',
			'.dpm-version{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;border:0;',
			'background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;',
			'padding:4px 6px;border-radius:6px;cursor:default;}',
			'.dpm-version[data-installable="true"]{cursor:pointer;}',
			'.dpm-version[data-installable="true"]:hover{background:var(--dsw-alias-bg-layer-2);}',
			'.dpm-version[data-installed="true"]{outline:1px solid var(--dsw-alias-state-success-primary);outline-offset:-1px;}',
			'.dpm-version-ver{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:600;white-space:nowrap;}',
			'.dpm-version-date{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;}',
			'.dpm-version-badge{font-size:10px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);',
			'color:var(--dsw-alias-label-secondary);white-space:nowrap;}',
			'.dpm-version-badge[data-source="npm"]{color:var(--dsw-alias-brand-primary);}',
			'.dpm-version-badge[data-source="release"]{color:var(--dsw-alias-state-success-primary);}',
			// GitHub account panel: anonymous vs signed in.
			'.dpm-account{flex:0 0 auto;display:flex;flex-direction:column;gap:7px;padding:10px 14px;',
			'border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}',
			'.dpm-account-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap;}',
			'.dpm-account-input{flex:1 1 220px;min-width:150px;border:1px solid var(--dsw-alias-border-l1);',
			'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:8px;',
			'padding:6px 9px;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;}',
			'.dpm-account-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}',
			'.dpm-account-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;}',
			'.dpm-account-avatar{width:22px;height:22px;border-radius:50%;object-fit:cover;flex:0 0 auto;}',
			'.dpm-account-link{color:var(--dsw-alias-brand-primary);font-size:11px;text-decoration:none;white-space:nowrap;}',
			'.dpm-account-link:hover{text-decoration:underline;}',
			'.dpm-updatebar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 10px;margin:0 2px 8px;',
			'border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;',
			'color:var(--dsw-alias-label-secondary);}',
			'.dpm-check{width:15px;height:15px;margin:0;flex:0 0 auto;accent-color:var(--dpm-solid);cursor:pointer;}',
			'.dpm-batchbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;margin:0 2px 8px;',
			'border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;',
			'color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-state-warn-primary);}',
			'.dpm-switch{position:relative;width:28px;height:16px;flex:0 0 auto;border:0;padding:0;border-radius:8px;',
			'background:var(--dsw-alias-state-idle-primary);cursor:pointer;}',
			'.dpm-switch[data-on="true"]{background:var(--dpm-solid);}',
			'.dpm-switch i{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;',
			'background:var(--dsw-alias-bg-base);transition:transform .15s ease;}',
			'.dpm-switch[data-on="true"] i{transform:translateX(12px);}',
			'.dpm-error{color:var(--dsw-alias-state-error-primary);}',
			// Pre-install gate (0.09). Deliberately loud: this block only appears when
			// an independent reviewer judged the plugin harmful.
			'.dpm-gate{display:flex;flex-direction:column;gap:6px;margin-top:6px;padding:9px 10px;',
			'border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);',
			'background:var(--dsw-alias-bg-layer-2);}',
			'.dpm-gate-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
			'.dpm-gate-badge{font-size:11px;font-weight:700;color:var(--dsw-alias-state-error-primary);}',
			'.dpm-gate-count{font-size:11px;color:var(--dsw-alias-label-secondary);}',
			'.dpm-gate-title{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);word-break:break-word;}',
			'.dpm-gate-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;',
			'font-size:11px;color:var(--dsw-alias-label-secondary);}',
			'.dpm-gate-check{display:flex;align-items:center;gap:7px;font-size:12px;',
			'color:var(--dsw-alias-label-primary);cursor:pointer;}',
			'.dpm-gate-check input{margin:0;cursor:pointer;}',
			// Provenance rows (0.09): a compact two-column fact table.
			'.dpm-prov{display:flex;flex-direction:column;gap:4px;}',
			'.dpm-prov-row{display:flex;align-items:baseline;gap:10px;min-width:0;}',
			'.dpm-prov-key{flex:0 0 auto;min-width:78px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
			'.dpm-prov-val{flex:1 1 auto;min-width:0;font-size:12px;color:var(--dsw-alias-label-primary);',
			'word-break:break-word;}',
			// Settings tab (0.10). One column of labelled blocks; the segmented
			// control is the only interactive shape, kept identical to the existing
			// language pill so there is one selection idiom in the whole window.
			'.dpm-settings{display:flex;flex-direction:column;gap:18px;padding:16px;max-width:560px;}',
			'.dpm-settings-block{display:flex;flex-direction:column;gap:7px;}',
			'.dpm-settings-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}',
			'.dpm-settings-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);}',
			'.dpm-settings-meta{font-size:11px;color:var(--dsw-alias-label-secondary);}',
			'.dpm-settings-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
			// A settings block that holds several rows: the stack owns the spacing,
			// the rows keep their own alignment.
			'.dpm-settings-stack{display:flex;flex-direction:column;gap:7px;}',
			'.dpm-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;',
			'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);align-self:flex-start;}',
			'.dpm-seg-inline{align-self:auto;}',
			'.dpm-seg-btn{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;',
			'padding:4px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;}',
			'.dpm-seg-btn:disabled{cursor:default;}',
			'.dpm-seg-btn[data-active="true"]{background:var(--dpm-solid);color:var(--dpm-on-solid);font-weight:600;}',
			'.dpm-pager-inline{display:inline-flex;}',
			'.dpm-warn{color:var(--dsw-alias-state-warn-primary);}',
			'.dpm-ok{color:var(--dsw-alias-state-success-primary);}',
			'.dpm-pre{white-space:pre-wrap;word-break:break-word;font-size:12px;color:var(--dsw-alias-label-secondary);',
			'max-height:120px;overflow:auto;margin:0;}',
			'.dpm-action{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;border:0;padding:6px 8px;',
			'border-radius:8px;background:transparent;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;text-align:left;}',
			'.dpm-action:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
			'.dpm-action[data-wide="false"]{justify-content:center;padding:6px 0;}',
			'.dpm-label{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
			// Phased install progress.
			'.dpm-progress{flex:0 0 auto;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l2);',
			'background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:7px;}',
			'.dpm-progress-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
			'.dpm-phases{display:flex;gap:4px;}',
			'.dpm-phase{flex:1 1 0;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}',
			'.dpm-phase i{display:block;height:100%;width:0;background:var(--dsw-alias-brand-primary);transition:width .2s ease;}',
			'.dpm-phase[data-state="active"] i{width:55%;}',
			'.dpm-phase[data-state="done"] i{width:100%;}',
			'.dpm-phase[data-state="failed"] i{width:100%;background:var(--dsw-alias-state-error-primary);}',
			'.dpm-phase[data-state="cancelled"] i{width:100%;background:var(--dsw-alias-state-warn-primary);}',
			'.dpm-phase-labels{display:flex;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary);}',
			'.dpm-phase-labels span{flex:1 1 0;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
			'.dpm-phase-labels span[data-active="true"]{color:var(--dsw-alias-label-primary);font-weight:600;}',
			'.dpm-log{white-space:pre-wrap;word-break:break-word;font-size:11px;margin:0;',
			'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-height:120px;overflow:auto;',
			'background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;',
			'padding:6px 8px;color:var(--dsw-alias-label-secondary);}',
			'.dpm-error-hint{color:var(--dsw-alias-label-secondary);font-size:12px;}',
		].join('');

		// ------------------------------------------------------------------ store

		/** Remembered preferences; localStorage is the only store this window owns. */
		const PREF_KEY = 'dsh.plugin-market.prefs';

		/**
		 * Which theme the panel should paint itself with.
		 *
		 * `auto` follows the Harness theme by reading the documented token, so the
		 * panel blends in by default. `light` / `dark` are an escape hatch: when the
		 * surrounding theme makes a control unreadable, the reader can pin this panel
		 * to the other scheme without touching the rest of the app.
		 * @param pref - the stored preference.
		 * @returns `light` or `dark`.
		 */
		function resolveTheme(pref) {
			if (pref === 'light' || pref === 'dark') return pref;
			// Auto: read the computed background of the host document. A dark base
			// means a dark theme. If it cannot be read, fall back to dark, which is
			// the default Harness appearance.
			try {
				const probe = window.getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim();
				if (probe !== '') {
					const hex = probe.replace('#', '');
					if (/^[0-9a-f]{6}$/i.test(hex)) {
						const r = parseInt(hex.slice(0, 2), 16);
						const g = parseInt(hex.slice(2, 4), 16);
						const b = parseInt(hex.slice(4, 6), 16);
						// Perceived luminance: below mid-grey is a dark surface.
						return (0.299 * r + 0.587 * g + 0.114 * b) < 128 ? 'dark' : 'light';
					}
				}
			} catch {
				/* unreadable: use the default */
			}
			return 'dark';
		}

		/** Read the persisted preferences, tolerating denied storage. */
		function readPrefs() {
			const fallback = {
				lang: 'zh', autoUpdate: false, intervalHours: 6, ignored: [], lastCheck: 0, theme: 'auto',
				// Compact is the default list layout: two badges and a description.
				density: 'compact', pageSize: PAGE_SIZE, startTab: 'catalog',
				// Rows the reader bookmarked. Stored as `owner/name`, which is the one
				// identity every surface can agree on: it survives a reinstall, a version
				// change and a different install spec.
				favorites: [],
				// Free-text notes, keyed by the same `owner/name`.
				notes: {},
			};
			let raw = null;
			try {
				raw = window.localStorage.getItem(PREF_KEY);
			} catch {
				return fallback;
			}
			if (raw === null) return fallback;
			try {
				const parsed = JSON.parse(raw);
				return {
					lang: parsed?.lang === 'en' ? 'en' : 'zh',
					autoUpdate: parsed?.autoUpdate === true,
					intervalHours: Number.isFinite(parsed?.intervalHours) && parsed.intervalHours >= 1 ? Math.min(168, Math.trunc(parsed.intervalHours)) : 6,
					ignored: Array.isArray(parsed?.ignored) ? parsed.ignored.filter((name) => typeof name === 'string') : [],
					lastCheck: Number.isFinite(parsed?.lastCheck) ? parsed.lastCheck : 0,
					// `auto` follows the Harness theme; `dark`/`light` pin this panel.
					theme: parsed?.theme === 'dark' || parsed?.theme === 'light' ? parsed.theme : 'auto',
					// Only the values the picker offers are accepted, so a hand-edited
					// localStorage entry cannot ask the Host for a page size it rejects.
					density: parsed?.density === 'full' ? 'full' : 'compact',
					pageSize: PAGE_SIZES.includes(parsed?.pageSize) ? parsed.pageSize : PAGE_SIZE,
					startTab: ['catalog', 'github', 'installed'].includes(parsed?.startTab) ? parsed.startTab : 'catalog',
					// Validated as `owner/name`: anything else would never match a row and
					// would sit in the list forever as an invisible favourite.
					favorites: Array.isArray(parsed?.favorites)
						? parsed.favorites.filter((repo) => typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo))
						: [],
					// Same key rule as the bookmarks, plus a length cap: a corrupt or
					// hand-edited entry must not turn a list row into a wall of text.
					notes: parsed !== null && typeof parsed?.notes === 'object' && parsed.notes !== null && !Array.isArray(parsed.notes)
						? Object.fromEntries(Object.entries(parsed.notes)
							.filter(([repo, text]) => /^[\w.-]+\/[\w.-]+$/.test(repo) && typeof text === 'string' && text.trim() !== '')
							.map(([repo, text]) => [repo, text.trim().slice(0, NOTE_LIMIT)]))
						: {},
				};
			} catch {
				return fallback;
			}
		}

		/** Persist the preferences that survive a restart. */
		function writePrefs() {
			try {
				window.localStorage.setItem(PREF_KEY, JSON.stringify(store.prefs));
			} catch {
				/* storage is a convenience here, never a requirement */
			}
		}

		const listeners = new Set();
		// Read once: the opening tab and the page size both come from here, so a
		// reader who pinned them does not see the window snap back on every launch.
		const initialPrefs = readPrefs();
		const store = {
			open: false,
			tab: initialPrefs.startTab,
			query: '',
			category: '',
			/** When true, only plugins with a public review report are listed. */
			reviewedOnly: false,
			/** When true, only the rows the reader bookmarked are listed. */
			favoritesOnly: false,
			sort: 'stars',
			page: 1,
			/** Pager data, straight from /find or /github. */
			totalPages: 1,
			pageSize: initialPrefs.pageSize,
			/**
			 * Which flow is currently reading, or null.
			 *
			 * This used to be a single `loading` boolean shared by the catalog
			 * build, the installed list and the list pager. Whichever finished
			 * last cleared it, so a slow catalog build could be un-marked by a
			 * fast installed read, and a failed search left another flow's
			 * spinner stuck. Naming the flow makes "is this list loading" and
			 * "is the catalog still building" separate questions.
			 */
			busyFlow: null,
			entries: [],
			total: 0,
			/** Live GitHub observation time from the last /stats call. */
			statsCheckedAt: 0,
			catalog: {
				ready: false, error: null, total: 0, categories: [], categoriesZh: [], sources: [], token: false,
				statsAt: '', downloadsAt: '', versionCount: 0, languages: [], defaultLanguage: 'zh', reviewedTotal: 0,
				// When the review snapshot was collected, so a row's badge can be
				// read against the data's age rather than an unstated "current".
				reviewDataAt: '',
			},
			/**
			 * The review snapshot, as the Host sees it.
			 *
			 * `available:false` means the snapshot file could not be read — not
			 * that nobody reviewed anything. The window keeps those two apart
			 * everywhere it mentions reviews.
			 */
			reviewSource: {
				loaded: false, available: false, site: '', snapshotUrl: '',
				dataAt: '', plugins: 0, reviews: 0, checkedAt: 0, problem: '', busy: false,
			},
			/**
			 * The two version labels beside the title.
			 *
			 * `plugin` comes from the Host's own manifest, `harness` from the runtime
			 * file the launcher writes. Both may be empty, and an empty value is
			 * rendered as "unknown" — never filled in with a guess.
			 */
			versions: { plugin: '', harness: '', loaded: false, error: null },
			installed: [],
			installedError: null,
			/** Whether the Host could read the profile manifest at all. */
			specResolved: true,
			/** 0.10: where the profile installs plugins (`{profile}/node_modules`). */
			profileDir: '',
			rate: null,
			pending: null,
			/**
			 * Whether the reader has ticked "I read the harmful report" for the
			 * plugin currently in the confirmation bar (0.09). The gate only ever
			 * unlocks by an explicit tick, never by opening and closing the bar.
			 */
			acknowledgedHarmful: false,
			busy: null,
			outcome: null,
			/** Whether the raw output behind the current outcome is expanded. */
			outcomeOpen: false,
			/** The running install's progress, or the terminal state of the last one. */
			progress: null,
			prefs: initialPrefs,
			updates: null,
			/** 0.10: bundle names selected for batch operations on the installed list. */
			selectedNames: [],
			/** The catalog row whose detail drawer is open, or null. */
			selected: null,
			/** Lazy `POST /detail` state for the open drawer. */
			detail: null,
			/** Whether the drawer's older review reports are unfolded. */
			reviewExpanded: false,
			/** GitHub identity panel state. */
			accountOpen: false,
			accountBusy: false,
			accountError: null,
			accountDraft: '',
			account: { loaded: false, supported: true, configured: false, writable: true, source: '', login: '', avatar: '', valid: false, rate: null, transport: null },
		};

		/** /detail responses, cached per repo for the session. */
		const detailCache = new Map();

		/** Notify every mounted surface after a store change. */
		function emit() {
			for (const listener of Array.from(listeners)) {
				try {
					listener();
				} catch (error) {
					console.error('[plugin-market] a window surface failed to update', error);
				}
			}
		}

		/** Merge one store patch and publish it. */
		function patch(next) {
			Object.assign(store, next);
			emit();
		}

		/** Subscribe one surface to store changes. */
		function subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}

		/** Re-render the calling component on every store change. */
		function useStore() {
			const [, bump] = useState(0);
			useEffect(() => subscribe(() => bump((value) => value + 1)), []);
			// `loading` stays available as a derived flag so the render code that
			// disables the pager and the search button keeps working; the flows
			// themselves now track which one is actually busy.
			if (store.busyFlow !== null && store.loading !== true) store.loading = true;
			else if (store.busyFlow === null && store.loading === true) store.loading = false;
			return store;
		}

		/** Resolve one key against the current UI language, for store-level code. */
		function tt(key, params) {
			const dict = store.prefs.lang === 'en' ? en : zh;
			let text = Object.prototype.hasOwnProperty.call(dict, key)
				? dict[key]
				: Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key;
			if (params !== undefined) {
				for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
			}
			return text;
		}

		// ------------------------------------------------------------------ fetch

		/** One error message out of an unknown thrown value. */
		function messageOf(error) {
			return error instanceof Error && error.message !== '' ? error.message : String(error);
		}

		/** Wait for `ms`, used between install-progress polls. */
		function sleep(ms) {
			return new Promise((resolve) => window.setTimeout(resolve, ms));
		}

		/** GET one Host endpoint. */
		async function apiGet(path, params) {
			const url = new URL(API + path, window.location.origin);
			for (const [key, value] of Object.entries(params ?? {})) {
				if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
			}
			const response = await fetch(url.pathname + url.search, {
				method: 'GET',
				headers: { accept: 'application/json' },
				cache: 'no-store',
			});
			const payload = await response.json().catch(() => null);
			if (payload === null) throw new Error(`HTTP ${response.status}`);
			return payload;
		}

		/** POST one Host endpoint. */
		async function apiPost(path, body) {
			const response = await fetch(API + path, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify(body ?? {}),
			});
			const payload = await response.json().catch(() => null);
			if (payload === null) throw new Error(`HTTP ${response.status}`);
			return payload;
		}

		// ---------------------------------------------------------- install progress

		/** The request id that ties POST /install to GET /install-progress. */
		function newRequestId() {
			return `pm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		}

		/** Whether one install phase is finished. */
		function isTerminalPhase(phase) {
			return phase === 'done' || phase === 'failed' || phase === 'cancelled';
		}

		/** The terminal phase implied by one ChangeResult. */
		function phaseOfResult(result) {
			const application = result !== null && typeof result === 'object' ? result.application : '';
			if (application === 'failed') return 'failed';
			if (application === 'cancelled') return 'cancelled';
			if (application === 'applied' || application === 'restart-required' || application === 'overridden') return 'done';
			return 'done';
		}

		/**
		 * Poll `GET /install-progress` until the install ends, appending the
		 * incremental log lines to the store as they arrive.
		 * @param post - shared `{ settled, payload }` for the POST that owns the run.
		 * A settled POST is authoritative: the contract says it resolves only after
		 * the install ended, so a progress route that lags behind must not keep the
		 * window waiting.
		 * @returns the final `{ result, phase, message, logPath }`, or an empty
		 * object when the route is missing (an older Host) or the run was replaced.
		 */
		async function pollInstallProgress(requestId, startedAt, post) {
			let from = 0;
			const lines = [];
			const deadline = startedAt + INSTALL_POLL_LIMIT_MS;
			let misses = 0;
			for (;;) {
				const current = store.progress;
				if (current === null || current.requestId !== requestId) return { abandoned: true };
				let payload = null;
				try {
					payload = await apiGet('/install-progress', { requestId, from });
				} catch {
					// A Host that predates the progress route answers 404. The POST's own
					// result is the fallback, so stop polling instead of failing.
					return { unavailable: true };
				}
				if (payload !== null && payload.ok === true && payload.found === false) {
					// The Host may register the request a beat after the POST is sent;
					// retry briefly before falling back to the POST's own result.
					misses += 1;
					if (misses <= 10 && Date.now() - startedAt < 8000) {
						await sleep(INSTALL_POLL_MS);
						continue;
					}
				}
				if (payload === null || payload.ok !== true || payload.found !== true) {
					return { unavailable: true, result: payload !== null && payload.ok === true ? (payload.result ?? null) : null };
				}
				if (Array.isArray(payload.lines)) {
					for (const line of payload.lines) {
						if (line !== null && typeof line === 'object' && typeof line.text === 'string') lines.push(line);
					}
				}
				if (Number.isFinite(payload.nextSeq)) from = payload.nextSeq;
				const phase = typeof payload.phase === 'string' ? payload.phase : 'installing';
				const latest = store.progress;
				if (latest === null || latest.requestId !== requestId) return { abandoned: true };
				patch({
					progress: {
						...latest,
						phase,
						// Remember how far the bar got, so a failed run still shows where it stopped.
						reached: Math.max(Number.isFinite(latest.reached) ? latest.reached : 0, Math.max(0, INSTALL_PHASES.indexOf(phase))),
						// Keep the tail only: the panel shows the last few lines and the
						// full output is still behind the outcome's 显示详情 toggle.
						lines: lines.slice(-120),
						nextSeq: from,
						attempt: payload.attempt ?? latest.attempt,
						message: typeof payload.message === 'string' ? payload.message : latest.message,
						logPath: typeof payload.logPath === 'string' ? payload.logPath : latest.logPath,
						elapsedMs: Number.isFinite(payload.elapsedMs) ? payload.elapsedMs : Date.now() - startedAt,
						result: payload.result ?? latest.result,
						running: isTerminalPhase(phase) !== true,
					},
				});
				if (isTerminalPhase(phase)) {
					return { result: payload.result ?? null, phase, message: payload.message ?? null, logPath: payload.logPath ?? '' };
				}
				if (Date.now() > deadline) {
					return { result: null, timedOut: true, phase, message: payload.message ?? null, logPath: payload.logPath ?? '' };
				}
				await sleep(INSTALL_POLL_MS);
				// The POST has already returned a final ChangeResult: stop polling even
				// if this Host never publishes a terminal phase.
				if (post !== undefined && post.settled === true) {
					const final = post.payload !== null && post.payload.ok === true ? (post.payload.result ?? null) : null;
					return { result: final, phase: phaseOfResult(final), message: payload.message ?? null, logPath: payload.logPath ?? '', fromPost: true };
				}
			}
		}

		/**
		 * Install / update / reinstall one spec with live progress.
		 * The POST owns the final ChangeResult; the progress poll drives the UI and
		 * supplies a result as soon as the Host reports a terminal phase.
		 * @param spec - the install spec, e.g. `npm:@scope/pkg`.
		 * @param options - `{ acknowledged, approvedBuilds, label, pending }`.
		 */
		async function runInstall(spec, options) {
			const opts = options ?? {};
			if (typeof spec !== 'string' || spec.trim() === '') return;
			const target = spec.trim();
			if (store.progress !== null && store.progress.running === true) {
				setOutcome({ kind: 'warn', text: tt('progress.busyOne') });
				return;
			}
			// The harmful gate lives HERE, not in the confirmation bar.
			//
			// It used to be rendered inside the bar, which meant it only existed on
			// the one path that builds the bar: the catalog's install button. An
			// update from the installed list, a reinstall, the catalog's own
			// "new version available" button and the automatic pass all called this
			// function directly and installed a plugin an independent reviewer had
			// judged harmful without ever showing the verdict.
			//
			// Every one of those paths funnels through this function, so the check
			// belongs here: open the bar with the gate instead of installing, and let
			// the acknowledgement come back as `options.acknowledged`.
			if (opts.acknowledged !== true) {
				const review = await reviewOfTarget(target);
				if (isHarmfulReview(review)) {
					await startImport({ ...syntheticEntry(target), review }, opts.label);
					return;
				}
			}
			const requestId = newRequestId();
			const startedAt = Date.now();
			const label = opts.label === 'update' ? 'update' : opts.label === 'reinstall' ? 'reinstall' : 'install';
			const approvedBuilds = Array.isArray(opts.approvedBuilds) ? opts.approvedBuilds.filter((name) => typeof name === 'string' && name !== '') : [];
			patch({
				busy: 'install',
				outcome: null,
				outcomeOpen: false,
				progress: {
					requestId, spec: target, label, phase: 'starting', lines: [], nextSeq: 0,
					startedAt, elapsedMs: 0, running: true, result: null, message: null, logPath: '',
					attempt: null, cancelling: false, tooLate: false, cancelError: null, logsOpen: false, reached: 0,
					approvedBuilds,
				},
			});
			const body = { spec: target, requestId };
			if (approvedBuilds.length > 0) body.approvedBuilds = approvedBuilds;
			// An update / reinstall must drop the recorded manifest entry first:
			// pnpm treats an existing `github:owner/repo` or a satisfied range as
			// "already done" and never re-resolves it, which is why updating used
			// to require removing the plugin by hand.
			if (opts.force === true) body.force = true;
			const post = { settled: false, payload: null };
			const postPromise = apiPost('/install', body)
				.then((payload) => {
					post.settled = true;
					post.payload = payload;
					return payload;
				})
				.catch((error) => {
					post.settled = true;
					post.payload = { ok: false, code: 'network', message: messageOf(error) };
					return post.payload;
				});
			const [polled, posted] = await Promise.all([pollInstallProgress(requestId, startedAt, post), postPromise]);
			// A newer install (or a tab switch that cleared progress) took over.
			if (store.progress === null || store.progress.requestId !== requestId) return;

			let result = polled !== null && polled.result !== null && polled.result !== undefined ? polled.result : null;
			let payloadError = posted !== null && posted.ok !== true ? posted : null;
			if (result === null && posted !== null && posted.ok === true) result = posted.result ?? null;

			if (result === null) {
				const described = payloadError !== null
					? describePayload(tt, payloadError)
					: { text: tt('outcome.failed'), hint: tt('err.hint.operation-error'), detail: polled?.message ?? '' };
				patch({ busy: null, progress: null });
				setOutcome({ kind: 'error', text: described.text, hint: described.hint, detail: described.detail, retrySpec: target });
				return;
			}

			const application = typeof result.application === 'string' ? result.application : '';
			const failed = application === 'failed';
			const cancelled = application === 'cancelled';
			const pendingBuilds = Array.isArray(result.pendingBuilds) ? result.pendingBuilds : [];
			const kind = failed ? 'error' : cancelled ? 'warn' : application === 'applied' ? 'ok' : 'warn';
			const outcome = { kind, result };
			if (failed) {
				const described = describeFailure(tt, result);
				outcome.text = described.text;
				outcome.hint = described.hint;
				outcome.detail = described.detail;
				outcome.logPath = described.logPath;
				outcome.incompatible = described.incompatible;
				outcome.retrySpec = target;
			}
			patch({
				busy: null,
				// Keep the terminal progress panel so the phase bar and the streamed
				// log stay readable after the run ends.
				progress: { ...store.progress, running: false, reached: INSTALL_PHASES.length - 1, phase: polled?.phase ?? (failed ? 'failed' : cancelled ? 'cancelled' : 'done'), result },
				outcome,
				outcomeOpen: false,
				pending: pendingBuilds.length > 0
					? (opts.pending ?? (store.pending !== null && store.pending.spec === target ? store.pending : { spec: target, entry: syntheticEntry(target), inspection: null, inspectError: null }))
					: null,
			});
			await loadInstalledQuiet();
			if (store.tab === 'installed') await loadInstalled();
			else await runSearch(store.page);
			if (pendingBuilds.length === 0) void loadUpdates({ silent: true });
		}

		/** Ask the Host to stop the running install. */
		async function cancelInstall() {
			const progress = store.progress;
			if (progress === null || progress.running !== true || progress.cancelling === true) return;
			patch({ progress: { ...progress, cancelling: true, cancelError: null } });
			try {
				const payload = await apiPost('/install-cancel', { requestId: progress.requestId });
				const current = store.progress;
				if (current === null || current.requestId !== progress.requestId) return;
				if (payload.ok !== true) {
					patch({ progress: { ...current, cancelling: false, cancelError: tt('progress.cancelFailed') } });
					return;
				}
				if (payload.status === 'too-late') patch({ progress: { ...current, cancelling: false, tooLate: true } });
				else if (payload.status === 'not-running') patch({ progress: { ...current, cancelling: false } });
				// `cancelled` needs no patch: the next poll flips the phase.
			} catch {
				const current = store.progress;
				if (current === null || current.requestId !== progress.requestId) return;
				patch({ progress: { ...current, cancelling: false, cancelError: tt('progress.cancelFailed') } });
			}
		}

		// ---------------------------------------------------------------- actions

		/** Set the outcome banner and collapse its raw details. */
		function setOutcome(outcome) {
			patch({ outcome, outcomeOpen: false });
		}

		/** Read the GitHub identity and quota behind the catalog. */
		async function loadAccount() {
			patch({ accountBusy: true, accountError: null });
			try {
				const payload = await apiGet('/account');
				patch({
					accountBusy: false,
					account: payload.ok === true ? payload : { ...store.account, supported: false },
					accountError: payload.ok === true ? null : (payload.message ?? 'account failed'),
				});
			} catch (error) {
				const message = messageOf(error);
				// A Host that predates this panel answers 404 on the account route;
				// say so plainly instead of showing a bare HTTP error.
				if (/\b404\b/.test(message)) {
					patch({ accountBusy: false, accountError: null, account: { ...store.account, supported: false } });
					return;
				}
				patch({ accountBusy: false, accountError: message });
			}
		}

		/**
		 * Turn a `/review-source` answer into window state.
		 *
		 * A plain function so the first read and the manual refresh cannot drift
		 * apart — they answer exactly the same shape.
		 * @param payload - the route's answer.
		 * @returns the `reviewSource` slice of the store.
		 */
		function readReviewSource(payload) {
			const ok = payload !== null && typeof payload === 'object' && payload.ok === true;
			return {
				loaded: true,
				available: ok && payload.available === true,
				site: ok && typeof payload.site === 'string' ? payload.site : '',
				snapshotUrl: ok && typeof payload.snapshotUrl === 'string' ? payload.snapshotUrl : '',
				dataAt: ok && typeof payload.dataAt === 'string' ? payload.dataAt : '',
				plugins: ok && Number.isFinite(payload.plugins) ? payload.plugins : 0,
				reviews: ok && Number.isFinite(payload.reviews) ? payload.reviews : 0,
				checkedAt: ok && Number.isFinite(payload.checkedAt) ? payload.checkedAt : 0,
				problem: ok
					? (typeof payload.problem === 'string' ? payload.problem : '')
					: describePayload(tt, payload).text,
				busy: false,
			};
		}

		/**
		 * Read the review snapshot's status.
		 *
		 * A read, not a sign-in: the data is a file, so there is nothing to
		 * authorize. What this reports is where it came from, how many reports it
		 * holds and when it was collected — the last one matters, because "this
		 * plugin has no report" and "the snapshot is stale" look identical on a row
		 * and mean different things.
		 */
		async function loadReviewSource() {
			try {
				patch({ reviewSource: readReviewSource(await apiGet('/review-source')) });
			} catch (error) {
				patch({
					reviewSource: { ...store.reviewSource, loaded: true, available: false, busy: false, problem: messageOf(error) },
				});
			}
		}

		/**
		 * Force the Host to re-read the snapshot, then reload what depends on it.
		 *
		 * The file is rebuilt daily, so a reader who just read about a corrected
		 * verdict should not have to wait six hours for the window to agree.
		 */
		async function refreshReviewSource() {
			if (store.reviewSource.busy === true) return;
			patch({ reviewSource: { ...store.reviewSource, busy: true } });
			try {
				patch({ reviewSource: readReviewSource(await apiPost('/review-source', { action: 'refresh' })) });
				await loadCatalog(false).catch(() => undefined);
			} catch (error) {
				patch({ reviewSource: { ...store.reviewSource, busy: false, problem: messageOf(error) } });
			} finally {
				patch({ reviewSource: { ...store.reviewSource, busy: false } });
			}
		}

		/** Store a GitHub token and switch the catalog to the authenticated path. */
		async function loginWithToken(token) {
			if (typeof token !== 'string' || token.trim() === '') {
				patch({ accountError: tt('account.tokenRequired') });
				return;
			}
			patch({ accountBusy: true, accountError: null });
			try {
				const payload = await apiPost('/account', { action: 'login', token: token.trim() });
				if (payload.ok !== true) {
					patch({ accountBusy: false, accountError: payload.message ?? 'login failed' });
					return;
				}
				patch({ accountBusy: false, account: payload, accountOpen: true });
				// The Host dropped its cached catalog, so rebuild it authenticated.
				await loadCatalog(true);
			} catch (error) {
				patch({ accountBusy: false, accountError: messageOf(error) });
			}
		}

		/** Forget the stored token and go back to anonymous CDN reads. */
		async function signOut() {
			patch({ accountBusy: true, accountError: null });
			try {
				const payload = await apiPost('/account', { action: 'logout' });
				if (payload.ok !== true) {
					patch({ accountBusy: false, accountError: payload.message ?? 'logout failed' });
					return;
				}
				patch({ accountBusy: false, account: payload });
				await loadCatalog(true);
			} catch (error) {
				patch({ accountBusy: false, accountError: messageOf(error) });
			}
		}

		/**
		 * Read the two version labels beside the title.
		 *
		 * This is a separate, tiny request on purpose: the labels must be correct
		 * even when the catalog build fails (that is often when a user checks which
		 * build they are on), and a failed read must not blank the labels — it
		 * leaves them empty, which renders as "unknown".
		 */
		async function loadVersions() {
			try {
				const payload = await apiGet('/version');
				if (payload.ok !== true) {
					patch({ versions: { ...store.versions, loaded: true, error: payload.message ?? 'version failed' } });
					return;
				}
				patch({
					versions: {
						plugin: typeof payload.plugin?.version === 'string' ? payload.plugin.version : '',
						harness: typeof payload.harness?.version === 'string' ? payload.harness.version : '',
						loaded: true,
						error: null,
					},
				});
			} catch (error) {
				// A Host that predates this route answers 404; the labels stay
				// "unknown" instead of disappearing.
				patch({ versions: { ...store.versions, loaded: true, error: messageOf(error) } });
			}
		}

		/** Build or reuse the curated catalog, then refresh the current list. */
		async function loadCatalog(refresh) {
			patch({ busyFlow: 'catalog' });
			try {
				const payload = await apiGet('/catalog', refresh === true ? { refresh: '1' } : {});
				if (payload.ok !== true) {
					const described = describePayload(tt, payload);
					patch({
						busyFlow: null,
						catalog: { ...store.catalog, ready: false, error: described.text },
					});
					return;
				}
				patch({
					busyFlow: null,
					catalog: {
						ready: true,
						error: null,
						total: payload.total ?? 0,
						categories: Array.isArray(payload.categories) ? payload.categories : [],
						categoriesZh: Array.isArray(payload.categoriesZh) ? payload.categoriesZh : [],
						sources: Array.isArray(payload.sources) ? payload.sources : [],
						token: payload.token === true,
						// Observation times of the catalog's own data, shown as 数据时间.
						statsAt: typeof payload.statsAt === 'string' ? payload.statsAt : '',
						downloadsAt: typeof payload.downloadsAt === 'string' ? payload.downloadsAt : '',
						versionCount: Number.isFinite(payload.versionCount) ? payload.versionCount : 0,
						languages: Array.isArray(payload.languages) ? payload.languages : [],
						defaultLanguage: typeof payload.defaultLanguage === 'string' ? payload.defaultLanguage : 'zh',
						// How many catalog plugins have a public report; drives the chip.
						reviewedTotal: Number.isFinite(payload.reviewedTotal) ? payload.reviewedTotal : 0,
						reviewDataAt: typeof payload.reviewDataAt === 'string' ? payload.reviewDataAt : '',
					},
					// The build reports the transport it actually used, which is what
					// the account panel prints; no second round trip needed.
					...(payload.transport === undefined ? {} : { account: { ...store.account, transport: payload.transport } }),
				});
				await loadInstalledQuiet();
				if (store.tab === 'catalog') await runSearch(1);
			} catch (error) {
				patch({
					busyFlow: null,
					catalog: { ...store.catalog, ready: false, error: messageOf(error) },
				});
			}
		}

		/**
		 * Read the installed bundles without touching the loading indicator.
		 * The market calls this on open so the Host's installed snapshot exists
		 * before the first catalog page is asked for, and so version badges can
		 * fall back to the client's own copy of that list.
		 */
		async function loadInstalledQuiet() {
			try {
				const payload = await apiGet('/installed');
				const installed = payload.ok === true && Array.isArray(payload.bundles) ? payload.bundles : [];
				patch({
					installed,
					specResolved: payload.specResolved !== false,
					profileDir: typeof payload.profileDir === 'string' ? payload.profileDir : '',
					// An open installed drawer is rebound to the refreshed bundle so its
					// version and running state do not go stale after an action.
					selected: store.selected === null || store.selected.bundle === undefined
						? store.selected
						: (() => {
							const live = installed.find((row) => row.name === store.selected.bundle.name);
							return live === undefined ? null : entryFromBundle(live);
						})(),
					installedError: payload.ok === true ? null : (payload.message ?? 'failed'),
				});
			} catch (error) {
				patch({ installedError: messageOf(error) });
			}
		}

		/** Read the profile's installed bundles. */
		async function loadInstalled() {
			patch({ busyFlow: 'installed' });
			try {
				const payload = await apiGet('/installed');
				const installed = payload.ok === true && Array.isArray(payload.bundles) ? payload.bundles : [];
				patch({
					busyFlow: null,
					installed,
					specResolved: payload.specResolved !== false,
					profileDir: typeof payload.profileDir === 'string' ? payload.profileDir : '',
					// Keep an open detail drawer bound to the refreshed row so its
					// version and running state do not go stale after an action.
					// An open installed drawer is rebound to the refreshed bundle so its
					// version and running state do not go stale after an action.
					selected: store.selected === null || store.selected.bundle === undefined
						? store.selected
						: (() => {
							const live = installed.find((row) => row.name === store.selected.bundle.name);
							return live === undefined ? null : entryFromBundle(live);
						})(),
					installedError: payload.ok === true ? null : (payload.message ?? 'failed'),
				});
			} catch (error) {
				patch({ busyFlow: null, installed: [], installedError: messageOf(error) });
			}
		}

		/** Persist one preference change. */
		function setPrefs(next) {
			patch({ prefs: { ...store.prefs, ...next } });
			writePrefs();
		}

		/** Whether one row is bookmarked. */
		function isFavorite(repo) {
			return typeof repo === 'string' && repo !== '' && store.prefs.favorites.includes(repo);
		}

		/**
		 * Add or remove one row from the bookmarks.
		 *
		 * Bookmarks are the one piece of state in this window the reader creates
		 * themselves, and they exist for the browsing that happens before a
		 * decision: mark the ones worth a second look, close the window, come back
		 * and compare only those. That is why they filter the list instead of just
		 * decorating it.
		 * @param repo - `owner/name`.
		 */
		function toggleFavorite(repo) {
			if (typeof repo !== 'string' || repo === '') return;
			const saved = store.prefs.favorites.includes(repo);
			const favorites = saved
				? store.prefs.favorites.filter((each) => each !== repo)
				: [...store.prefs.favorites, repo];
			setPrefs({ favorites });
			// Un-saving the last row while the filter is on would leave the reader
			// looking at an empty list with no obvious way back, so the filter turns
			// itself off. Either way the visible set changed and is re-read.
			if (store.favoritesOnly === true) {
				if (favorites.length === 0) patch({ favoritesOnly: false, page: 1 });
				void runSearch(1);
			}
		}

		/**
		 * The reader's own note for one repository.
		 *
		 * Bookmarks answer "which ones do I want to look at again". A note answers
		 * the question that survives longer: "why did I keep this one". The catalog
		 * and the review site both describe the plugin; neither can say what the
		 * reader was waiting for, or which of forty similar memory plugins they
		 * already ruled out.
		 * @param repo - `owner/name`.
		 * @returns the note, or an empty string.
		 */
		function noteOf(repo) {
			if (typeof repo !== 'string' || repo === '') return '';
			const saved = store.prefs.notes[repo];
			return typeof saved === 'string' ? saved : '';
		}

		/**
		 * Store or clear one note.
		 *
		 * Trimmed and capped here rather than at the input, so a pasted wall of text
		 * cannot bloat localStorage or blow out a list row. An empty note deletes the
		 * key instead of leaving `"": ""` behind.
		 * @param repo - `owner/name`.
		 * @param text - the note.
		 */
		function setNote(repo, text) {
			if (typeof repo !== 'string' || repo === '') return;
			const value = (typeof text === 'string' ? text : '').trim().slice(0, NOTE_LIMIT);
			const notes = { ...store.prefs.notes };
			if (value === store.prefs.notes[repo]) return;
			if (value === '') delete notes[repo];
			else notes[repo] = value;
			setPrefs({ notes });
		}

		/**
		 * Switch the catalog page size.
		 *
		 * Only the curated list honours this: GitHub search is capped at 30 rows
		 * per page by its own API, so re-reading that tab here would look like the
		 * setting did nothing.
		 * @param size - one of `PAGE_SIZES`.
		 */
		function setPageSize(size) {
			const value = PAGE_SIZES.includes(size) ? size : PAGE_SIZE;
			if (store.prefs.pageSize === value) return;
			setPrefs({ pageSize: value });
			if (store.tab === 'catalog') void runSearch(1);
		}

		/** Switch the catalog rows between the compact and the full layout. */
		function setDensity(density) {
			setPrefs({ density: density === 'full' ? 'full' : 'compact' });
		}

		/**
		 * Choose the tab the window opens on.
		 *
		 * Deliberately does not switch tabs now: the label says "opens on", and
		 * jumping the reader away from the screen they are configuring is the kind
		 * of helpfulness that feels like a hijack.
		 * @param tab - `catalog`, `github` or `installed`.
		 */
		function setStartTab(tab) {
			setPrefs({ startTab: ['catalog', 'github', 'installed'].includes(tab) ? tab : 'catalog' });
		}

		/** Switch the display language of every list this window renders. */
		function setLanguage(lang) {
			if (store.prefs.lang === lang) return;
			setPrefs({ lang });
			patch({ category: '', page: 1 });
			// Settings is a local screen; it never triggers a catalog or GitHub read.
			if (store.tab !== 'installed' && store.tab !== 'settings') void runSearch(1);
		}

		/**
		 * Change this panel's own theme.
		 *
		 * Stored alongside the other preferences so the choice survives a restart.
		 * No refetch: painting is driven by `data-theme` on the panel element.
		 */
		function setTheme(theme) {
			const next = theme === 'dark' || theme === 'light' ? theme : 'auto';
			if (store.prefs.theme === next) return;
			setPrefs({ theme: next });
		}

		/** Run whichever query the active tab asks for. */
		async function runSearch(page) {
			if (store.tab === 'installed') {
				await loadInstalled();
				return;
			}
			// Settings is local-only: a fetch here would blank the screen on reload.
			if (store.tab === 'settings') return;
			const tab = store.tab;
			const target = Math.max(1, page ?? store.page);
			const lang = store.prefs.lang;
			patch({ busyFlow: tab === 'github' ? 'github' : 'catalogList', page: target });
			try {
				const payload = tab === 'github'
					? await apiGet('/github', { q: store.query, page: target, sort: store.sort === 'updated' ? 'updated' : 'stars', lang })
					// The preference, not the constant: the settings picker owns the page
					// size, and `store.pageSize` is only the value the answer reported back
					// (which differs on the GitHub tab, capped at 30).
					//
					// `favs` carries the bookmarks to the Host, which owns the catalog and
					// is therefore the only side that can filter the whole 6000-row list.
					// Sent as a comma-separated list because it is usually a handful of
					// repos; an empty list never reaches here — the chip is hidden at zero.
					: await apiGet('/find', {
						q: store.query,
						cat: store.category,
						sort: store.sort,
						page: target,
						lang,
						pageSize: store.prefs.pageSize,
						reviewed: store.reviewedOnly === true ? '1' : '',
						favs: store.favoritesOnly === true ? store.prefs.favorites.join(',') : '',
					});
				if (payload.ok !== true) {
					const described = describePayload(tt, payload);
					patch({ busyFlow: null, entries: [], total: 0, totalPages: 1 });
					setOutcome({
						kind: 'error',
						text: `${tt(tab === 'github' ? 'error.generic' : 'error.catalog')}：${described.text}`,
						hint: described.hint,
						detail: described.detail,
					});
					return;
				}
				const entries = Array.isArray(payload.entries) ? payload.entries : [];
				const total = Number.isFinite(payload.total) ? payload.total : 0;
				const pageSize = Number.isFinite(payload.pageSize) ? payload.pageSize : (tab === 'github' ? GITHUB_PAGE_SIZE : PAGE_SIZE);
				const totalPages = Math.max(1, Number.isFinite(payload.totalPages) ? payload.totalPages : Math.ceil(total / Math.max(1, pageSize)));
				// The Host reports a sane total even for an out-of-range page; land on
				// the last real page instead of showing an empty list.
				if (entries.length === 0 && total > 0 && target > totalPages) {
					patch({ busyFlow: null, total, totalPages, pageSize, page: totalPages });
					void runSearch(totalPages);
					return;
				}
				// Keep the detail drawer bound to the refreshed row, so a language
				// switch re-renders its description instead of closing it.
				const selected = store.selected === null
					? null
					: entries.find((entry) => entry.repo === store.selected.repo) ?? null;
				patch({
					busyFlow: null,
					entries,
					total,
					totalPages,
					pageSize,
					selected,
					...(selected === null ? { detail: null } : {}),
					// The Host counts the review-filtered total on every page; keep it so
					// the chip can show a real number even when the catalog summary was
					// served by a Host that predates the field.
					...(Number.isFinite(payload.reviewedTotal) && tab === 'catalog'
						? { catalog: { ...store.catalog, reviewedTotal: payload.reviewedTotal } }
						: {}),
					rate: payload.remaining === undefined && payload.authenticated === undefined
						? store.rate
						: { remaining: payload.remaining ?? null, authenticated: payload.authenticated === true },
				});
				// Live stars / forks for the visible catalog page. A failure leaves the
				// catalog's own values untouched.
				if (tab === 'catalog') void refreshVisibleStats(entries);
			} catch (error) {
				patch({ busyFlow: null, entries: [], total: 0, totalPages: 1 });
				setOutcome({ kind: 'error', text: messageOf(error), hint: tt('err.hint.network') });
			}
		}

		/**
		 * Refresh stars / forks / push time for the visible page via POST /stats.
		 * A null from the live source never overwrites a known catalog value.
		 */
		async function refreshVisibleStats(entries) {
			const repos = entries.map((entry) => entry.repo).filter((repo) => typeof repo === 'string' && repo !== '').slice(0, 60);
			if (repos.length === 0) return;
			let payload = null;
			try {
				payload = await apiPost('/stats', { repos });
			} catch {
				return;
			}
			if (payload === null || payload.ok !== true) return;
			const stats = payload.stats !== null && typeof payload.stats === 'object' ? payload.stats : {};
			// A newer page replaced the list while this request was in flight.
			if (store.entries !== entries) return;
			const merged = entries.map((entry) => {
				const live = stats[entry.repo];
				if (live === null || typeof live !== 'object') return entry;
				return {
					...entry,
					stars: live.stars === null || live.stars === undefined ? entry.stars : live.stars,
					forks: live.forks === null || live.forks === undefined ? entry.forks : live.forks,
					language: typeof live.language === 'string' && live.language !== '' ? live.language : entry.language,
					license: typeof live.license === 'string' && live.license !== '' ? live.license : entry.license,
					updatedAt: typeof live.pushedAt === 'string' && live.pushedAt !== '' ? live.pushedAt : entry.updatedAt,
				};
			});
			const selected = store.selected === null
				? null
				: merged.find((entry) => entry.repo === store.selected.repo) ?? store.selected;
			patch({ entries: merged, selected, statsCheckedAt: Number.isFinite(payload.checkedAt) ? payload.checkedAt : Date.now() });
		}

		/**
		 * Read the detail of one row, lazily, and cache it for the session.
		 *
		 * The same call serves all three surfaces (curated catalog, GitHub search,
		 * installed list), which is the point: one detail pipeline, so a field added
		 * for one surface cannot silently be missing from another. A row with no
		 * repository identity (an installed `link:` bundle) is looked up by package
		 * name instead.
		 */
		async function loadDetail(entry) {
			const repo = typeof entry.repo === 'string' ? entry.repo : '';
			const npm = typeof entry.npm === 'string' && entry.npm !== '' ? entry.npm : '';
			const name = typeof entry.name === 'string' ? entry.name : '';
			const key = repo !== '' ? repo : `pkg:${npm}:${name}`;
			if (repo === '' && npm === '' && name === '') return;
			const cached = detailCache.get(key);
			if (cached !== undefined && Date.now() - cached.at < DETAIL_TTL_MS) {
				if (store.detail !== null && store.detail.repo === key) {
					patch({ detail: { repo: key, busyFlow: null, payload: cached.payload, error: null, at: cached.at } });
				}
				return;
			}
			try {
				const payload = await apiPost('/detail', {
					repo,
					npm,
					spec: typeof entry.spec === 'string' ? entry.spec : '',
					name,
				});
				if (payload.ok !== true) {
					const described = describePayload(tt, payload);
					if (store.detail !== null && store.detail.repo === key) {
						patch({ detail: { ...store.detail, busyFlow: null, error: described.text, errorHint: described.hint } });
					}
					return;
				}
				detailCache.set(key, { at: Date.now(), payload });
				if (store.detail !== null && store.detail.repo === key) {
					patch({ detail: { repo: key, busyFlow: null, payload, error: null, errorHint: null, at: Date.now() } });
				}
			} catch (error) {
				if (store.detail !== null && store.detail.repo === key) {
					patch({ detail: { ...store.detail, busyFlow: null, error: messageOf(error), errorHint: tt('err.hint.network') } });
				}
			}
		}

		/**
		 * The cache key one drawer row is looked up under.
		 * @param entry - a catalog row or an installed bundle adapted to one.
		 * @returns the key `loadDetail` and `selectEntry` share.
		 */
		function detailKeyOf(entry) {
			const repo = typeof entry.repo === 'string' && entry.repo !== '' ? entry.repo : '';
			if (repo !== '') return repo;
			return `pkg:${typeof entry.npm === 'string' ? entry.npm : ''}:${typeof entry.name === 'string' ? entry.name : ''}`;
		}

		/** Open the drawer for one row and start its lazy detail read. */
		function selectEntry(entry) {
			if (entry === null) {
				patch({ selected: null, detail: null });
				return;
			}
			const key = detailKeyOf(entry);
			const cached = detailCache.get(key);
			const fresh = cached !== undefined && Date.now() - cached.at < DETAIL_TTL_MS;
			patch({
				selected: entry,
				detail: fresh
					? { repo: key, busyFlow: null, payload: cached.payload, error: null, at: cached.at }
					: { repo: key, loading: true, payload: null, error: null, at: 0 },
			});
			if (fresh !== true) void loadDetail(entry);
		}

		/** Enable or disable one bundle without removing it. */
		async function toggleBundle(name, enabled) {
			patch({ busy: `toggle:${name}`, outcome: null, progress: null });
			try {
				const payload = await apiPost('/toggle', { name, enabled });
				if (payload.ok !== true) {
					const described = describePayload(tt, payload);
					patch({ busy: null });
					setOutcome({ kind: 'error', text: described.text, hint: described.hint, detail: described.detail });
					return;
				}
				const result = payload.result ?? {};
				patch({ busy: null });
				if (result.application === 'failed') {
					const described = describeFailure(tt, result);
					setOutcome({ kind: 'error', result, text: described.text, hint: described.hint, detail: described.detail, logPath: described.logPath, incompatible: described.incompatible });
				} else {
					setOutcome({ kind: 'ok', result, toggled: `${name} · ${enabled ? 'on' : 'off'}` });
				}
				await loadInstalled();
			} catch (error) {
				patch({ busy: null });
				setOutcome({ kind: 'error', text: messageOf(error), hint: tt('err.hint.network') });
			}
		}

		/**
		 * Ask the Host which registry-backed bundles have a newer release.
		 * @param options - `silent` suppresses the outcome banner for the
		 * automatic pass, which reports through the update list instead.
		 * @returns the checks, so an automatic pass can act on them.
		 */
		async function loadUpdates(options) {
			const silent = options?.silent === true;
			if (silent !== true) patch({ busy: 'updates', outcome: null });
			try {
				const payload = await apiGet('/updates');
				if (payload.ok !== true) {
					if (silent !== true) {
						const described = describePayload(tt, payload);
						patch({ busy: null });
						setOutcome({ kind: 'error', text: described.text, hint: described.hint, detail: described.detail });
					}
					return [];
				}
				const checks = Array.isArray(payload.checks) ? payload.checks : [];
				patch({ busy: silent === true ? store.busy : null, updates: { checkedAt: payload.checkedAt ?? Date.now(), checks } });
				setPrefs({ lastCheck: Date.now() });
				const outdated = checks.filter((check) => check.outdated === true);
				if (silent !== true) {
					setOutcome({
						kind: 'ok',
						text: outdated.length === 0 ? tt('updates.allFresh') : tt('updates.checked', { n: outdated.length }),
					});
				}
				return checks;
			} catch (error) {
				if (silent !== true) {
					patch({ busy: null });
					setOutcome({ kind: 'error', text: messageOf(error), hint: tt('err.hint.network') });
				}
				return [];
			}
		}

		/**
		 * Install the newest release of one already-installed package.
		 *
		 * No gate check here: `runInstall` owns it. Anything that reaches the
		 * package manager goes through that one function, which is what stops an
		 * update from being a quieter path than an install.
		 */
		/**
		 * The spec to hand the package manager when updating, minus a commit pin.
		 *
		 * A `github:owner/repo#dev` install names the *line* the user chose, and
		 * the fragment also carries `path:/packages/foo` for a monorepo
		 * subdirectory. Dropping either and reinstalling from the default branch
		 * is a silent source change wearing the word "update".
		 *
		 * Every selector is kept except a full 40-char commit, which is a
		 * deliberate pin and the one thing an update is meant to move past. A
		 * short hex string is indistinguishable from a branch of that name, and
		 * keeping a pin by mistake only makes the update a no-op, while dropping
		 * a branch by mistake installs different code.
		 * @param spec - the recorded install spec.
		 * @returns the spec to update from.
		 */
		function updateTargetOf(spec) {
			const hashAt = spec.indexOf('#');
			if (hashAt === -1) return spec;
			const repo = spec.slice(0, hashAt);
			let subpath = null;
			let ref = null;
			for (const selector of spec.slice(hashAt + 1).split('&')) {
				if (selector.startsWith('path:/')) {
					const candidate = selector.slice('path:/'.length);
					// An ambiguous or traversal-shaped selector is never forwarded:
					// fall back to the bare repository rather than guessing.
					const valid = /^[A-Za-z0-9_./-]+$/.test(candidate)
						&& candidate.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
					if (subpath !== null || !valid) return repo;
					subpath = candidate;
					continue;
				}
				// A 40-char commit is a pin worth discarding; `semver:<range>` and
				// a branch are both release-line selectors and are preserved.
				const isCommitPin = /^[0-9a-f]{40}$/i.test(selector);
				if (selector !== '' && !isCommitPin) {
					// Two refs in one fragment is not a shape pnpm produces; refuse
					// to guess which one the user meant.
					if (ref !== null) return repo;
					ref = selector;
				}
			}
			const kept = [...(ref === null ? [] : [ref]), ...(subpath === null ? [] : [`path:/${subpath}`])];
			return kept.length === 0 ? repo : `${repo}#${kept.join('&')}`;
		}

		async function updateBundle(specOrName, label) {
			if (typeof specOrName !== 'string' || specOrName.trim() === '') return;
			let target = specOrName.trim();
			// An update that sends a bare package name reaches pnpm as `add <name>`,
			// which keeps whatever range the profile manifest already records — so
			// the update "succeeds" but the version never moves, and the only escape
			// was to uninstall and reinstall. Pinning `@latest` forces pnpm past the
			// recorded range. `@scope/name` still matches (`@` only at the front),
			// while a spec that already carries a version or a `github:`/`git:`
			// scheme is left untouched.
			if (label === 'update' && !target.includes(':') && /^@?[^@]+$/.test(target)) {
				target = `${target}@latest`;
			} else if (target.includes('#')) {
				// Keep the branch / tag and the monorepo subdirectory; only a
				// deliberate commit pin is dropped so the update can move.
				target = updateTargetOf(target);
			}
			// A `github:` spec carries no ref, so pnpm sees the recorded
			// `github:owner/repo` as already satisfied and never re-resolves the
			// branch — the reason a git plugin could only be updated by removing it
			// first. Asking the Host to drop the manifest entry before adding it
			// back forces a fresh resolution, which is what "update" means.
			const needsFreshResolve = label === 'update' || label === 'reinstall';
			await runInstall(target, {
				label: label === 'reinstall' ? 'reinstall' : 'update',
				force: needsFreshResolve === true,
			});
		}

		/**
		 * Automatic pass: on a Harness start, update every outdated registry
		 * package the user has not ignored, at most once per configured interval.
		 *
		 * A harmful verdict means SKIP, never gate. A background job must not pull
		 * new code from a package an independent reviewer judged harmful, and it
		 * must not raise a dialog at startup to say so either. An unknown verdict
		 * (the Host could not read the review index) is skipped for the same
		 * reason: acting on data we could not verify is the failure being fixed.
		 */
		async function runAutoUpdate() {
			if (store.prefs.autoUpdate !== true) return;
			const due = Date.now() - store.prefs.lastCheck >= store.prefs.intervalHours * 3600 * 1000;
			if (due !== true) return;
			// Warm the review index before asking for the checks. `/updates` reads
			// each package's harmful verdict straight out of that index and reports
			// null when it is absent — and this pass runs at startup, when nothing
			// has built it yet. Without the warm-up every check would come back
			// unknown and the pass would skip everything it was asked to update.
			await apiGet('/review').catch(() => undefined);
			const checks = await loadUpdates({ silent: true });
			const ignored = new Set(store.prefs.ignored);
			const blocked = [];
			const unknown = [];
			for (const check of checks) {
				if (check.outdated !== true || ignored.has(check.name)) continue;
				if (check.harmful === true) {
					blocked.push(check.name);
					continue;
				}
				if (check.harmful !== false) {
					// The field is missing, which means the running Host predates it.
					// Reported to the console rather than the window: telling the reader
					// "skipped, judged harmful" for a package nobody judged would be a
					// false accusation.
					unknown.push(check.name);
					continue;
				}
				await updateBundle(check.name, 'update');
			}
			if (blocked.length > 0) {
				setOutcome({
					kind: 'warn',
					text: tt('updates.skippedHarmful', { n: blocked.length }),
					hint: blocked.join(' · '),
				});
			}
			if (unknown.length > 0) {
				console.warn('[plugin-market] the automatic pass skipped these packages because this Host does not report a review verdict', unknown);
			}
		}

		/**
		 * Open the confirmation bar for one row and pre-check its spec.
		 * @param entry - a catalog row, or a stand-in carrying only the review.
		 * @param label - `install` / `update` / `reinstall`, so the bar and the
		 * progress panel say what is actually about to happen.
		 */
		async function startImport(entry, label) {
			const mode = label === 'update' ? 'update' : label === 'reinstall' ? 'reinstall' : 'install';
			patch({
				pending: { spec: entry.spec, entry, label: mode, inspection: null, inspectError: null },
				outcome: null,
				progress: null,
				busy: 'inspect',
				acknowledgedHarmful: false,
			});
			try {
				const payload = await apiPost('/inspect', { spec: entry.spec });
				if (store.pending === null || store.pending.spec !== entry.spec) return;
				patch({
					pending: {
						...store.pending,
						inspection: payload.ok === true ? payload.inspection : null,
						inspectError: payload.ok === true ? null : describePayload(tt, payload).text,
					},
				});
			} catch (error) {
				if (store.pending !== null && store.pending.spec === entry.spec) {
					patch({ pending: { ...store.pending, inspectError: messageOf(error) } });
				}
			} finally {
				patch({ busy: null });
			}
		}

		/** Install the spec the confirmation bar names. */
		async function confirmImport(approvedBuilds) {
			const pending = store.pending;
			if (pending === null) return;
			const review = pending.entry === undefined ? null : pending.entry.review;
			await runInstall(pending.spec, {
				label: pending.label ?? 'install',
				...(approvedBuilds === undefined ? {} : { approvedBuilds }),
				pending,
				// Reaching this function means the bar was shown: either it carried no
				// gate at all, or the reader ticked one — the confirm button is
				// disabled until they do, so an unticked gate cannot arrive here.
				// Written as a real condition rather than a hard-coded `true` so a
				// future change that un-disables that button fails closed.
				acknowledged: isHarmfulReview(review) !== true || store.acknowledgedHarmful === true,
			});
		}

		/** Remove one installed bundle. */
		async function removeBundle(name) {
			patch({ busy: `remove:${name}`, outcome: null, progress: null });
			try {
				const payload = await apiPost('/remove', { name });
				if (payload.ok !== true) {
					const described = describePayload(tt, payload);
					patch({ busy: null });
					setOutcome({ kind: 'error', text: described.text, hint: described.hint, detail: described.detail });
					return;
				}
				const result = payload.result ?? {};
				const updates = store.updates === null
					? null
					: { ...store.updates, checks: store.updates.checks.filter((check) => check.name !== name) };
				patch({ busy: null, pending: null, updates });
				if (result.application === 'failed') {
					const described = describeFailure(tt, result);
					setOutcome({ kind: 'error', result, text: described.text, hint: described.hint, detail: described.detail, logPath: described.logPath, incompatible: described.incompatible });
				} else {
					setOutcome({ kind: 'ok', result, removed: name });
				}
				await loadInstalled();
				if (store.tab !== 'installed') await runSearch(store.page);
			} catch (error) {
				patch({ busy: null });
				setOutcome({ kind: 'error', text: messageOf(error), hint: tt('err.hint.network') });
			}
		}

		/**
		 * 0.10: toggle the enabled state of every selected bundle.
		 *
		 * A loop over the single-bundle route keeps the server surface unchanged
		 * and lets each row fail on its own; a profile only holds a handful of
		 * plugins, so the N requests are never a concern.
		 */
		async function bulkToggle(enabled) {
			const names = store.selectedNames;
			if (names.length === 0) {
				setOutcome({ kind: 'warn', text: tt('batch.empty') });
				return;
			}
			patch({ busy: 'bulk', outcome: null });
			let failed = 0;
			for (const name of names) {
				const payload = await apiPost('/toggle', { name, enabled }).catch(() => null);
				if (payload === null || payload.ok !== true) failed += 1;
			}
			await loadInstalled();
			patch({ busy: null, selectedNames: [] });
			setOutcome({ kind: failed === 0 ? 'ok' : 'warn', text: failed === 0
				? tt(enabled ? 'batch.enabledDone' : 'batch.disabledDone', { n: names.length })
				: tt('batch.partialDone', { ok: names.length - failed, n: names.length }) });
		}

		/** 0.10: remove every selected bundle, after an explicit confirmation. */
		async function bulkRemove() {
			const names = store.selectedNames;
			if (names.length === 0) {
				setOutcome({ kind: 'warn', text: tt('batch.empty') });
				return;
			}
			if (window.confirm(tt('batch.confirmDelete', { n: names.length })) !== true) return;
			patch({ busy: 'bulk', outcome: null });
			let failed = 0;
			for (const name of names) {
				const payload = await apiPost('/remove', { name }).catch(() => null);
				if (payload === null || payload.ok !== true) failed += 1;
			}
			await loadInstalled();
			patch({ busy: null, selectedNames: [] });
			setOutcome({ kind: failed === 0 ? 'ok' : 'warn', text: failed === 0
				? tt('batch.removedDone', { n: names.length })
				: tt('batch.partialDone', { ok: names.length - failed, n: names.length }) });
		}

		/**
		 * 0.10: update every outdated, un-ignored package at once.
		 *
		 * Harmful packages are skipped: `runInstall` would open the confirmation
		 * gate for each one, and looping would clobber that bar with the next
		 * package. They keep their own per-row update button instead.
		 */
		async function updateAll() {
			const checks = store.updates === null ? [] : store.updates.checks;
			const ignored = new Set(store.prefs.ignored);
			const targets = checks.filter((check) => check.outdated === true && !ignored.has(check.name));
			if (targets.length === 0) {
				setOutcome({ kind: 'warn', text: tt('updates.allNone') });
				return;
			}
			const harmfulSkipped = targets.filter((check) => check.harmful === true).length;
			for (const check of targets) {
				if (check.harmful === true) continue;
				await updateBundle(check.name, 'update');
			}
			await loadUpdates();
			await loadInstalled();
			if (harmfulSkipped > 0) {
				setOutcome({ kind: 'warn', text: tt('updates.allSkippedHarmful', { n: harmfulSkipped }) });
			}
		}

		/** 0.10: download the installed manifest as JSON. */
		function exportInstalled() {
			const rows = store.installed.map((bundle) => ({
				name: bundle.name,
				version: bundle.version ?? '',
				spec: bundle.spec ?? '',
				kind: kindOf(bundle),
				source: sourceUrlFor(bundle),
			}));
			if (rows.length === 0) {
				setOutcome({ kind: 'warn', text: tt('export.empty') });
				return;
			}
			const payload = { format: 'dsh-plugin-market', schema: 1, exportedAt: new Date().toISOString(), plugins: rows };
			const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = 'dsh-plugin-market-installed.json';
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(url);
			setOutcome({ kind: 'ok', text: tt('export.done', { n: rows.length }) });
		}

		/** 0.10: read a manifest file and install each spec it names. */
		function importInstalled() {
			const input = document.createElement('input');
			input.type = 'file';
			input.accept = 'application/json,.json';
			input.addEventListener('change', async () => {
				const file = input.files && input.files[0];
				if (file === undefined || file === null) return;
				try {
					const text = await file.text();
					const data = JSON.parse(text);
					const plugins = Array.isArray(data.plugins) ? data.plugins : [];
					const specs = plugins
						.map((plugin) => (plugin !== null && typeof plugin === 'object' && typeof plugin.spec === 'string' && plugin.spec !== ''
							? plugin.spec
							: (plugin !== null && typeof plugin === 'object' && typeof plugin.name === 'string' && plugin.name !== '' ? plugin.name : '')))
						.filter((spec) => spec !== '');
					if (specs.length === 0) {
						setOutcome({ kind: 'error', text: tt('import.invalid') });
						return;
					}
					for (const spec of specs) {
						if (store.progress !== null && store.progress.running === true) break;
						await runInstall(spec, { label: 'install' });
					}
				} catch (error) {
					setOutcome({ kind: 'error', text: tt('import.invalid'), detail: messageOf(error) });
				}
			});
			input.click();
		}

		/** Remember or forget one package for the automatic update pass. */
		function setIgnored(name, ignore) {
			const ignored = store.prefs.ignored.filter((entry) => entry !== name);
			if (ignore === true) ignored.push(name);
			setPrefs({ ignored });
		}

		/** Switch tab and load whatever that tab needs. */
		function selectTab(tab) {
			if (store.tab === tab) return;
			patch({
				tab, pending: null, outcome: null, outcomeOpen: false,
				entries: [], total: 0, totalPages: 1, page: 1, selected: null, detail: null, selectedNames: [],
				// Both filters only exist on the curated tab; leaving one armed while
				// switching away would silently narrow the list the reader comes back to.
				...(tab === 'catalog' ? {} : { reviewedOnly: false, favoritesOnly: false }),
			});
			if (tab === 'installed') {
				void loadInstalled();
				// Read the version state on first view so rows never sit at
				// "not checked" until the user hunts for the button.
				if (store.updates === null) void loadUpdates();
			} else if (tab === 'history') {
				// 0.10 placeholder: search history has no data source yet.
			} else if (tab === 'settings') {
				// Nothing to load: the screen is entirely local state — except the
				// review credential, which lives in the profile and decides whether
				// this window may talk to the review site at all.
				if (store.reviewSource.loaded !== true) void loadReviewSource();
			} else if (tab === 'catalog' && store.catalog.ready !== true) void loadCatalog(false);
			else void runSearch(1);
		}

		/** Open the popup, loading the catalog the first time. */
		function openMarket() {
			patch({ open: true });
			if (store.versions.loaded !== true) void loadVersions();
			if (store.account.loaded !== true) void loadAccount();
			if (store.reviewSource.loaded !== true) void loadReviewSource();
			if (store.catalog.ready !== true && store.loading !== true) void loadCatalog(false);
			if (store.tab === 'installed') {
				void loadInstalled();
				if (store.updates === null) void loadUpdates();
			}
		}

		/** Close the popup. A running install keeps going in the Host. */
		function closeMarket() {
			patch({ open: false, pending: null, accountOpen: false });
		}

		// ------------------------------------------------------------ formatting

		/** Resolve one bare message key against the built-in Chinese dictionary. */
		function t0(key) {
			return Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key;
		}

		/** Resolve one message key, falling back to the built-in Chinese text. */
		function translator(props) {
			const bound = props !== null && typeof props === 'object' && typeof props.t === 'function' ? props.t : null;
			return (key, params) => {
				let text = null;
				if (bound !== null) {
					try {
						const value = bound(key);
						if (typeof value === 'string' && value !== '' && value !== key) text = value;
					} catch {
						/* a broken dictionary must not blank the window */
					}
				}
				if (text === null) text = t0(key);
				if (params !== undefined) {
					for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
				}
				return text;
			};
		}

		/**
		 * Compact a large number for one metadata chip.
		 * `null` means "unknown" per the v2 contract and must never read as 0.
		 */
		function compact(value) {
			if (value === null || value === undefined) return '—';
			const number = Number(value);
			if (!Number.isFinite(number) || number < 0) return '—';
			if (number === 0) return '0';
			if (number < 1000) return String(number);
			if (number < 1000000) return `${(number / 1000).toFixed(number < 10000 ? 1 : 0)}k`;
			return `${(number / 1000000).toFixed(1)}M`;
		}

		/** `YYYY-MM-DD HH:mm` in the local time zone. */
		function formatStamp(ms) {
			const date = new Date(ms);
			const pad = (value) => String(value).padStart(2, '0');
			return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}

		/** Human date out of an ISO string or an epoch number. */
		function formatWhen(value) {
			if (typeof value === 'number' && Number.isFinite(value)) return formatStamp(value);
			if (typeof value !== 'string' || value === '') return '';
			// The catalog's observation times are date-only; keep them verbatim
			// instead of inventing a midnight time in the reader's zone.
			if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return value;
			return formatStamp(date.getTime());
		}

		/** Best-effort package name for one install spec.
		 *
		 * A bare name (with or without an `@version` tail) IS the registry spec —
		 * `InstallSpecKind` has no `npm:` scheme — while `github:` carries the
		 * repository and a bare URL carries neither.
		 */
		function packageNameOfSpec(spec) {
			if (typeof spec !== 'string' || spec === '') return '';
			if (spec.startsWith('github:') || spec.startsWith('git:')) {
				const parts = spec.slice(spec.indexOf(':') + 1).split('#')[0].split('/');
				return parts.length >= 2 ? parts[1] : parts[0];
			}
			if (/^https?:\/\//i.test(spec)) return '';
			const rest = spec.startsWith('npm:') ? spec.slice(4) : spec;
			// `@scope/name@1.2.3` must split on the LAST `@`, not the scope marker.
			const at = rest.lastIndexOf('@');
			return at > 0 ? rest.slice(0, at) : rest;
		}

		/** Compare two dotted version strings; 1 when left is newer. */
		function compareVersionStrings(left, right) {
			const parse = (value) => String(value).trim().replace(/^[v^~=]+/, '').split(/[.+-]/).slice(0, 3)
				.map((part) => {
					const parsed = Number.parseInt(part, 10);
					return Number.isFinite(parsed) ? parsed : 0;
				});
			const a = parse(left);
			const b = parse(right);
			for (let index = 0; index < 3; index += 1) {
				const delta = (a[index] ?? 0) - (b[index] ?? 0);
				if (delta !== 0) return delta > 0 ? 1 : -1;
			}
			return 0;
		}

		/**
		 * Classify how a bundle was installed.
		 *
		 * Derived from the declared spec the Host already sends, so the labels
		 * are right even against a Host that predates the `git` kind.
		 * @param bundle - one installed row.
		 * @returns `local`, `git`, `registry`, or `unknown`.
		 */
		function kindOf(bundle) {
			const spec = typeof bundle.spec === 'string' ? bundle.spec : '';
			if (spec.startsWith('link:') || spec.startsWith('file:')) return 'local';
			if (/^(github|git|git\+)/i.test(spec) || /\.git(#|$)/i.test(spec)) return 'git';
			if (spec !== '') return 'registry';
			// No declared spec: the Host could not read the profile manifest. Only
			// trust a kind that could not have come from that read.
			if (bundle.kind === 'local' || bundle.kind === 'git') return bundle.kind;
			return 'unknown';
		}

		/**
		 * The public page a bundle came from, when one can be derived.
		 * @param bundle - one installed row.
		 * @returns a URL, or an empty string for a hand-made local source.
		 */
		function sourceUrlFor(bundle) {
			const spec = typeof bundle.spec === 'string' ? bundle.spec : '';
			if (spec.startsWith('link:') || spec.startsWith('file:')) return '';
			if (spec.startsWith('github:')) return `https://github.com/${spec.slice(7).split('#')[0]}`;
			if (kindOf(bundle) === 'registry' && typeof bundle.name === 'string' && bundle.name !== '') {
				return `https://www.npmjs.com/package/${bundle.name}`;
			}
			return '';
		}

		/** A valid `author` object, or null. */
		function authorOf(value) {
			if (value === null || typeof value !== 'object') return null;
			if (typeof value.login !== 'string' || value.login === '') return null;
			return {
				login: value.login,
				name: typeof value.name === 'string' ? value.name : '',
				avatar: typeof value.avatar === 'string' ? value.avatar : '',
				url: typeof value.url === 'string' && value.url !== '' ? value.url : `https://github.com/${value.login}`,
			};
		}

		/** A stand-in catalog row for a spec that did not come from a list row. */
		function syntheticEntry(spec) {
			const name = packageNameOfSpec(spec);
			return { spec, repo: name !== '' ? name : spec, name, capabilities: [], redLines: [], scanned: true };
		}

		/**
		 * Review verdicts already read for a gate check, keyed by install spec.
		 *
		 * One read per target per session: an install attempt, an update and a
		 * reinstall of the same spec all share the answer, and the Host caches
		 * `/detail` for half an hour on top of that.
		 */
		const gateReviews = new Map();

		/** The repository a `github:` spec names, or an empty string. */
		function repoOfSpec(spec) {
			if (typeof spec !== 'string') return '';
			const match = /^github:([\w.-]+\/[\w.-]+)/.exec(spec.trim());
			return match !== null ? match[1] : '';
		}

		/**
		 * Whether a review block means an independent report judged the plugin
		 * harmful.
		 *
		 * An unreadable block is NOT harmful. The gate exists to make a reader see
		 * a verdict, not to punish them for the review site being down, so an
		 * unknown verdict never blocks an install. The automatic pass is the one
		 * place that treats unknown differently — see `runAutoUpdate`.
		 * @param review - a `ReviewSummary` from the Host, or null.
		 * @returns whether the gate should appear.
		 */
		function isHarmfulReview(review) {
			if (review === null || review === undefined) return false;
			const count = Number.isFinite(review.harmfulCount) ? review.harmfulCount : 0;
			return count > 0 || (review.worstHarmful !== null && review.worstHarmful !== undefined);
		}

		/**
		 * The review block for one install target.
		 *
		 * This is what lets the gate live in `runInstall` rather than in the
		 * confirmation bar: any path that reaches the package manager can ask what
		 * the plugin's public reports say, without first building the bar.
		 * @param spec - the install spec.
		 * @returns the review summary, or null when nothing could be read.
		 */
		async function reviewOfTarget(spec) {
			const key = spec.trim();
			if (gateReviews.has(key)) return gateReviews.get(key);
			const repo = repoOfSpec(key);
			const npm = repo === '' ? packageNameOfSpec(key) : '';
			// A bare `github:` spec and a tarball URL have no package identity the
			// catalog can match on, so those stay unknown instead of guessing.
			const identity = repo !== ''
				? { repo }
				: (npm === '' ? null : (npm === key ? { name: npm } : { npm }));
			if (identity === null) {
				gateReviews.set(key, null);
				return null;
			}
			try {
				const payload = await apiPost('/detail', identity);
				const review = payload !== null && payload.ok === true && typeof payload.review === 'object'
					? payload.review
					: null;
				gateReviews.set(key, review);
				return review;
			} catch {
				// Unreadable is not harmful; see `isHarmfulReview`.
				gateReviews.set(key, null);
				return null;
			}
		}

		/**
		 * Adapt one installed bundle to the catalog-row shape the shared drawer reads.
		 *
		 * There used to be a second, hand-written drawer for the installed list, and
		 * it drifted: it never gained the review section, the version history or the
		 * screenshots that the catalog drawer has. Adapting the bundle once here is
		 * what lets all three surfaces render through the same component.
		 * @param bundle - one row from `GET /installed`.
		 * @returns a row shaped like a catalog entry, carrying the bundle itself.
		 */
		function entryFromBundle(bundle) {
			const spec = typeof bundle.spec === 'string' ? bundle.spec : '';
			// A `github:` spec carries the repository; a registry or `link:` spec
			// carries only the package, which the Host resolves from the catalog.
			const repoFromSpec = /^github:([\w.-]+\/[\w.-]+)/.exec(spec);
			const repo = repoFromSpec !== null ? repoFromSpec[1] : '';
			const name = typeof bundle.name === 'string' ? bundle.name : '';
			const author = authorOf(bundle.author);
			return {
				// An empty repo is legitimate here: the Host falls back to the package
				// name, and the drawer shows the package name as its title.
				repo,
				name,
				npm: repo === '' ? name : '',
				spec,
				url: sourceUrlFor(bundle),
				description: typeof bundle.description === 'string' ? bundle.description : '',
				category: '',
				categoryId: '',
				translated: true,
				version: typeof bundle.version === 'string' ? bundle.version : '',
				installed: true,
				installedVersion: typeof bundle.version === 'string' ? bundle.version : '',
				outdated: false,
				inCatalog: false,
				stars: null,
				downloads: null,
				capabilities: [],
				redLines: [],
				scanned: false,
				screenshots: [],
				review: null,
				author: author === null ? undefined : { login: author.login, name: author.name, avatar: author.avatar, url: author.url },
				// The installed-specific facts the shared drawer renders in its own
				// section, instead of a second drawer having to know about them.
				bundle,
			};
		}

		/**
		 * Turn one failed ChangeResult into a plain-language sentence plus a next
		 * step. A bare machine code is never the only thing shown.
		 * @returns `{ text, hint, code, kind, detail, logPath, incompatible }`.
		 */
		function describeFailure(t, result) {
			const safe = result !== null && typeof result === 'object' ? result : {};
			const error = safe.error !== null && typeof safe.error === 'object' ? safe.error : null;
			const code = error !== null && typeof error.code === 'string' ? error.code : '';
			const packageResult = safe.packageResult !== null && typeof safe.packageResult === 'object' ? safe.packageResult : null;
			const kind = packageResult !== null && typeof packageResult.kind === 'string' ? packageResult.kind : '';
			const kindKnown = kind !== '' && Object.prototype.hasOwnProperty.call(zh, `err.kind.${kind}`);
			const codeKnown = code !== '' && Object.prototype.hasOwnProperty.call(zh, `err.code.${code}`);
			// `operation-error` only says "something went wrong", while the
			// package-manager kind names the actual cause (no pnpm, no network…).
			const genericCode = code === 'operation-error' || code === 'install-failed' || code === 'remove-failed';
			let text = '';
			let hint = '';
			if (kindKnown && (codeKnown !== true || genericCode)) {
				text = t(`err.kind.${kind}`);
				hint = t(`err.hint.kind.${kind}`);
			} else if (codeKnown) {
				text = t(`err.code.${code}`);
				hint = t(`err.hint.${code}`);
			} else if (code !== '') {
				const diagnostic = error !== null && typeof error.diagnostic === 'string' && error.diagnostic !== '' ? `：${error.diagnostic}` : '';
				text = `${t('error.codeUnknown', { code })}${diagnostic}`;
				hint = t('err.hint.operation-error');
			} else {
				text = t('outcome.failed');
				hint = t('err.hint.operation-error');
			}
			const incompatible = error !== null && Array.isArray(error.incompatible)
				? error.incompatible.map((item) => typeof item === 'string' ? item : JSON.stringify(item))
				: [];
			const output = packageResult !== null && typeof packageResult.output === 'string' ? packageResult.output.trim() : '';
			const diagnostic = error !== null && typeof error.diagnostic === 'string' ? error.diagnostic.trim() : '';
			// The raw machine codes stay available, but only behind 显示详情.
			const rawCodes = [code !== '' ? `code: ${code}` : '', kind !== '' ? `kind: ${kind}` : ''].filter((part) => part !== '').join('  ');
			const raw = [rawCodes, output !== '' ? output : diagnostic].filter((part) => part !== '').join('\n\n');
			return {
				text,
				hint,
				code,
				kind,
				detail: raw,
				logPath: packageResult !== null && typeof packageResult.logPath === 'string' ? packageResult.logPath : '',
				incompatible,
			};
		}

		/** Human text for one API-level failure payload (`{ ok:false, code, message }`). */
		function describePayload(t, payload) {
			const safe = payload !== null && typeof payload === 'object' ? payload : {};
			const code = typeof safe.code === 'string' ? safe.code : '';
			const message = typeof safe.message === 'string' ? safe.message : '';
			if (code !== '' && Object.prototype.hasOwnProperty.call(zh, `err.code.${code}`)) {
				return { text: t(`err.code.${code}`), hint: t(`err.hint.${code}`), detail: message, code };
			}
			if (code !== '') {
				return {
					text: `${t('error.codeUnknown', { code })}${message !== '' ? `：${message}` : ''}`,
					hint: t('err.hint.operation-error'),
					detail: message,
					code,
				};
			}
			return { text: message !== '' ? message : t('error.generic'), hint: '', detail: message, code: '' };
		}

		/** Human text for one `ChangeResult`. */
		function describeChange(t, result) {
			const parts = [];
			const application = result.application;
			if (application === 'applied') parts.push(t('outcome.applied'));
			else if (application === 'restart-required') parts.push(t('outcome.restart'));
			else if (application === 'overridden') parts.push(t('outcome.overridden'));
			else if (application === 'cancelled') parts.push(t('outcome.cancelled'));
			else if (application === 'failed') parts.push(t('outcome.failed'));
			if (typeof result.bundle === 'string' && result.bundle !== '') parts.push(`${t('outcome.bundle')} ${result.bundle}`);
			if (result.error !== null && typeof result.error === 'object' && typeof result.error.code === 'string') {
				parts.push(`${t('outcome.error')} ${result.error.code}`);
			}
			return parts.join(' · ');
		}

		/** Package-manager output of one change, when the Host returned any. */
		function changeOutput(result) {
			const output = result === null || result === undefined ? undefined : result.packageResult?.output;
			return typeof output === 'string' && output.trim() !== '' ? output.trim() : null;
		}

		/** Page numbers to render: 1, last, and a window around the current page. */
		function pageNumbers(page, totalPages) {
			const wanted = new Set([1, totalPages, page - 2, page - 1, page, page + 1, page + 2]);
			const list = Array.from(wanted).filter((value) => value >= 1 && value <= totalPages).sort((a, b) => a - b);
			const out = [];
			let previous = 0;
			for (const value of list) {
				if (previous !== 0 && value - previous > 1) out.push('gap');
				out.push(value);
				previous = value;
			}
			return out;
		}

		// ---------------------------------------------------------------- glyphs

		/** Storefront glyph. */
		function ShopGlyph(props) {
			return h('svg', {
				viewBox: '0 0 24 24',
				width: props.size ?? 16,
				height: props.size ?? 16,
				'aria-hidden': true,
				style: { display: 'block', flex: '0 0 auto' },
			},
				h('path', {
					d: 'M4 4h16l1.2 5.2A3 3 0 0 1 18.3 13H5.7a3 3 0 0 1-2.9-3.8L4 4Z',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.6,
					strokeLinejoin: 'round',
				}),
				h('path', { d: 'M5.5 13V20h13v-7', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
				h('path', { d: 'M10 20v-4h4v4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
			);
		}

		/** Circular-arrow refresh glyph. */
		function RefreshGlyph() {
			return h('svg', { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': true, style: { display: 'block' } },
				h('path', {
					d: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z',
					fill: 'currentColor',
				}));
		}

		/** Cross glyph. */
		function CloseGlyph() {
			return h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true, style: { display: 'block' } },
				h('path', { d: 'M4 4 12 12M12 4 4 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }));
		}

		/** Person glyph for the account toggle. */
		function UserGlyph() {
			return h('svg', { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': true, style: { display: 'block' } },
				h('circle', { cx: 12, cy: 8.2, r: 3.6, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7 }),
				h('path', { d: 'M4.6 20.2a7.4 7.4 0 0 1 14.8 0', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }));
		}

		/**
		 * Bookmark glyph for the favourites toggle.
		 *
		 * Deliberately not a star: a star already means "GitHub stars" on every row,
		 * and two different stars two centimetres apart would be read as one thing.
		 * @param props - `filled` when the row is already saved.
		 */
		function BookmarkGlyph(props) {
			const filled = props !== null && typeof props === 'object' && props.filled === true;
			return h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true, style: { display: 'block' } },
				h('path', {
					d: 'M4 2.6h8v10.8l-4-3-4 3z',
					fill: filled ? 'currentColor' : 'none',
					stroke: 'currentColor',
					strokeWidth: 1.6,
					strokeLinejoin: 'round',
				}));
		}

		/**
		 * The GitHub identity panel: anonymous mode, or the signed-in account
		 * with its live quota. Signing in stores a personal access token in the
		 * profile credential store, which the Host half reads on every request.
		 * @param t - translator.
		 * @param state - the window store.
		 * @param actions - window actions.
		 * @returns the panel element, or null when collapsed.
		 */
		function AccountPanel(t, state, actions) {
			const account = state.account;
			const signedIn = account.configured === true;
			const rows = [];
			// A Host process that predates the account route cannot log in at all.
			if (account.supported === false) {
				return h('div', { className: 'dpm-account', key: 'account' },
					h('div', { className: 'dpm-account-row' },
						h('span', { className: 'dpm-tag' }, t('account.anon')),
					),
					h('div', { className: 'dpm-account-hint dpm-warn' }, t('account.unsupported')),
				);
			}

			rows.push(h('div', { className: 'dpm-account-row', key: 'head' },
				h('span', { className: 'dpm-tag', 'data-trust': signedIn ? 'true' : 'false' },
					signedIn ? t('account.signed') : t('account.anon')),
				signedIn && account.login !== ''
					? h('span', { className: 'dpm-repo' }, `@${account.login}`)
					: null,
				account.avatar !== ''
					? h('img', { className: 'dpm-account-avatar', src: account.avatar, alt: '', referrerPolicy: 'no-referrer' })
					: null,
				account.rate !== null && Number.isFinite(account.rate?.remaining)
					? h('span', { className: 'dpm-meta' }, t('account.rate', { remaining: account.rate.remaining, limit: account.rate.limit ?? '?' }))
					: null,
				h('span', { className: 'dpm-spacer' }),
				signedIn
					? h(Button, {
						kind: 'default',
						disabled: state.accountBusy,
						onClick: () => actions.onSignOut(),
					}, state.accountBusy ? t('account.busy') : t('account.logout'))
					: null,
			));

			if (signedIn !== true) {
				rows.push(h('div', { className: 'dpm-account-row', key: 'input' },
					h('input', {
						className: 'dpm-account-input',
						type: 'password',
						value: state.accountDraft,
						placeholder: t('account.tokenPlaceholder'),
						'aria-label': t('account.tokenPlaceholder'),
						autoComplete: 'off',
						spellCheck: false,
						onChange: (event) => patch({ accountDraft: event.target.value }),
						onKeyDown: (event) => {
							if (event.key === 'Enter') {
								event.preventDefault();
								actions.onLogin(state.accountDraft);
							}
						},
					}),
					h(Button, {
						kind: 'primary',
						disabled: state.accountBusy,
						onClick: () => actions.onLogin(state.accountDraft),
					}, state.accountBusy ? t('account.busy') : t('account.login')),
					h('a', {
						className: 'dpm-account-link',
						href: 'https://github.com/settings/tokens/new?description=DSH%20Plugin%20Market',
						target: '_blank',
						rel: 'noreferrer noopener',
					}, t('account.createToken')),
				));
			}

			rows.push(h('div', { className: 'dpm-account-hint', key: 'hint1' },
				signedIn ? t('account.stored') : t('account.anonHint')));
			if (signedIn !== true) rows.push(h('div', { className: 'dpm-account-hint', key: 'hint2' }, t('account.loginHint')));
			// What the next catalog build will actually use.
			const transport = account.transport;
			if (transport !== null && typeof transport === 'object' && transport.kind === 'mirror') {
				rows.push(h('div', { className: 'dpm-account-hint', key: 'transport' }, t('account.transportMirror', { name: transport.name ?? '' })));
			} else if (transport !== null && typeof transport === 'object' && transport.kind === 'api') {
				rows.push(h('div', { className: 'dpm-account-hint', key: 'transport' }, transport.authenticated === true ? t('account.transportApi') : t('account.transportApiAnon')));
			}
			if (account.configured === true && account.valid === false && account.rate !== null) {
				rows.push(h('div', { className: 'dpm-account-hint dpm-error', key: 'invalid' }, t('account.invalid')));
			}
			if (account.supported === true && account.writable === false) {
				rows.push(h('div', { className: 'dpm-account-hint dpm-warn', key: 'readonly' }, t('account.notWritable')));
			}
			if (state.accountError !== null) {
				rows.push(h('div', { className: 'dpm-account-hint dpm-error', key: 'error' }, state.accountError));
			}
			return h('div', { className: 'dpm-account', key: 'account' }, ...rows);
		}

		/** The window's stylesheet, rendered so unmounting removes it. */
		function Styles() {
			return h('style', { key: 'dpm-styles' }, CSS);
		}

		// ------------------------------------------------------------------ atoms

		/**
		 * The one button in this window.
		 *
		 * Every action button used to spell out `type`, `className`, `disabled` and
		 * `onClick` by hand at each call site — which is exactly how the primary
		 * colour ended up defined in three separate rules and legible in one of
		 * them. Shape, colour and disabled handling now live here once.
		 *
		 * Variants are named by intent, not by colour:
		 *   primary  — the one committing action on a bar (install, confirm)
		 *   danger   — destructive (delete)
		 *   icon     — a square glyph button in the header
		 *   segment  — one option inside a segmented control
		 *   pager    — a page number
		 *   chip     — a filter pill
		 *   plain    — an inline text action
		 * @returns the button element.
		 */
		/** Maps a variant name to the class the stylesheet uses for it. */
		const BUTTON_CLASS = {
			icon: 'dpm-icon',
			tab: 'dpm-tab',
			segment: 'dpm-seg-btn',
			pager: 'dpm-pager-btn',
			chip: 'dpm-chip',
			plain: 'dpm-link',
			switch: 'dpm-switch',
			thumb: 'dpm-shot-thumb',
			version: 'dpm-version',
			action: 'dpm-action',
			// A language option is styled through its container, so it owns no class.
			lang: '',
		};

		function Button(props) {
			const kind = typeof props.kind === 'string' ? props.kind : 'default';
			const variant = Object.prototype.hasOwnProperty.call(BUTTON_CLASS, kind)
				? BUTTON_CLASS[kind]
				: 'dpm-button';
			const className = props.className === undefined
				? variant
				: (variant === '' ? props.className : variant + ' ' + props.className);
			const attrs = {
				type: 'button',
				className: className === '' ? undefined : className,
				onClick: props.onClick,
			};
			// Only the variants the stylesheet keys on carry data-kind.
			if (kind === 'primary' || kind === 'danger') attrs['data-kind'] = kind;
			// `active` reaches this component as the string 'true' / 'false' from
			// every one of the 12 call sites, but a boolean is equally natural for
			// a new caller, so both are accepted. Comparing strictly against `true`
			// turned every selection into data-active="false", and all eight CSS
			// rules key on [data-active="true"]: no tab, category chip, review
			// chip, pager page, screenshot thumbnail, segmented option or language
			// option ever highlighted. The install phase labels were the only
			// survivor, because they set the attribute directly.
			if (props.active !== undefined) {
				attrs['data-active'] = props.active === true || props.active === 'true' ? 'true' : 'false';
			}
			if (props.disabled !== undefined) attrs.disabled = props.disabled === true;
			if (props.title !== undefined) attrs.title = props.title;
			if (props.ariaLabel !== undefined) {
				attrs['aria-label'] = props.ariaLabel;
				if (props.title === undefined) attrs.title = props.ariaLabel;
			}
			if (props.role !== undefined) attrs.role = props.role;
			// Anything else a call site needs (aria-current, aria-checked, data-on, …)
			// goes through one explicit bag, so this component stays a single place
			// to read rather than growing a prop per attribute.
			if (props.extra !== undefined) Object.assign(attrs, props.extra);
			return h('button', attrs, props.children);
		}



		/**
		 * One author avatar, falling back to a letter tile when the image cannot
		 * load (GitHub avatars are the only network image this window shows).
		 */
		function AuthorAvatar(props) {
			const [failed, setFailed] = useState(false);
			const size = Number.isFinite(props.size) ? props.size : 16;
			const style = { width: `${size}px`, height: `${size}px` };
			const login = typeof props.login === 'string' ? props.login : '';
			if (failed === true || props.avatar === '' || props.avatar === undefined) {
				return h('span', {
					className: 'dpm-avatar dpm-avatar-letter',
					style,
					'aria-hidden': true,
					title: login,
				}, (login !== '' ? login[0] : '?').toUpperCase());
			}
			return h('img', {
				className: 'dpm-avatar',
				style,
				src: props.avatar,
				alt: '',
				referrerPolicy: 'no-referrer',
				loading: 'lazy',
				onError: () => setFailed(true),
			});
		}

		/** Author avatar plus login, linked to the GitHub profile. */
		function AuthorChip(t, author, size) {
			if (author === null) return null;
			return h('a', {
				className: 'dpm-author',
				href: author.url,
				target: '_blank',
				rel: 'noreferrer noopener',
				title: `${t('label.author')} · ${author.name !== '' ? `${author.name} (@${author.login})` : `@${author.login}`}`,
				onClick: (event) => event.stopPropagation(),
			},
				h(AuthorAvatar, { login: author.login, avatar: author.avatar, size: size ?? 16 }),
				h('span', { className: 'dpm-author-login' }, author.login));
		}

		/**
		 * The footer pager: previous, a window of numbered pages with ellipses,
		 * and next. Hidden entirely when there is nothing to page through.
		 */
		function Pager(t, state, actions) {
			if (state.total === 0) return null;
			const totalPages = Math.max(1, state.totalPages);
			const page = Math.min(Math.max(1, state.page), totalPages);
			const parts = [];
			parts.push(h(Button, {
				kind: 'pager',
				key: 'prev',
				title: t('action.prev'),
				ariaLabel: t('action.prev'),
				disabled: page <= 1 || state.loading,
				onClick: () => actions.onPage(page - 1),
				extra: {
				'type': 'button',
				},
			}, '‹'));
			for (const item of pageNumbers(page, totalPages)) {
				if (item === 'gap') {
					parts.push(h('span', { className: 'dpm-pager-gap', key: `gap-${parts.length}` }, '…'));
					continue;
				}
				parts.push(h(Button, {
					kind: 'pager',
					active: item === page ? 'true' : 'false',
					key: `page-${item}`,
					disabled: state.loading,
					onClick: () => actions.onPage(item),
					extra: {
					'type': 'button',
					'aria-current': item === page ? 'page' : undefined,
					},
				}, String(item)));
			}
			parts.push(h(Button, {
				kind: 'pager',
				key: 'next',
				title: t('action.next'),
				ariaLabel: t('action.next'),
				disabled: page >= totalPages || state.loading,
				onClick: () => actions.onPage(page + 1),
				extra: {
				'type': 'button',
				},
			}, '›'));
			return h('div', { className: 'dpm-pager', role: 'navigation', 'aria-label': t('pager.label') }, ...parts);
		}

		/** Phase states for the segmented bar. */
		function phaseStates(phase, reached) {
			const count = INSTALL_PHASES.length;
			const clamped = Math.max(0, Math.min(count - 1, Number.isFinite(reached) ? reached : 0));
			if (phase === 'done') return INSTALL_PHASES.map(() => 'done');
			if (phase === 'failed' || phase === 'cancelled') {
				const terminal = phase;
				return INSTALL_PHASES.map((name, index) => index < clamped ? 'done' : index === clamped ? terminal : 'idle');
			}
			const current = Math.max(0, INSTALL_PHASES.indexOf(phase));
			return INSTALL_PHASES.map((name, index) => index < current ? 'done' : index === current ? 'active' : 'idle');
		}

		/**
		 * The live install panel: segmented phase bar, elapsed time, cancel, and
		 * the last streamed log lines behind a toggle.
		 */
		function ProgressPanel(t, state, actions) {
			const progress = state.progress;
			if (progress === null) return null;
			const phase = typeof progress.phase === 'string' ? progress.phase : 'starting';
			const states = phaseStates(phase, progress.reached);
			const running = progress.running === true;
			const title = t(`progress.title.${progress.label === 'update' ? 'update' : progress.label === 'reinstall' ? 'reinstall' : 'install'}`);
			const elapsedSeconds = Math.max(0, Math.round(((Number.isFinite(progress.elapsedMs) ? progress.elapsedMs : 0) || (running ? Date.now() - progress.startedAt : 0)) / 1000));
			const rows = [];
			rows.push(h('div', { className: 'dpm-progress-head', key: 'head' },
				h('strong', null, title),
				h('span', { className: phase === 'failed' ? 'dpm-error' : phase === 'cancelled' ? 'dpm-warn' : 'dpm-meta' },
					t(`progress.phase.${phase}`)),
				h('code', { className: 'dpm-code' }, progress.spec),
				h('span', { className: 'dpm-meta' }, t('progress.elapsed', { seconds: elapsedSeconds })),
				h('span', { className: 'dpm-spacer' }),
				running
					? h(Button, {
						kind: 'default',
						disabled: progress.cancelling === true,
						onClick: () => actions.onCancelInstall(),
					}, progress.cancelling === true ? t('progress.cancelling') : t('progress.cancel'))
					: h(Button, {
						kind: 'default',
						onClick: () => actions.onDismissProgress(),
					}, t('action.close')),
			));
			rows.push(h('div', {
				className: 'dpm-phases',
				key: 'phases',
				role: 'progressbar',
				'aria-valuemin': 0,
				'aria-valuemax': 100,
				'aria-valuenow': PHASE_PERCENT[phase] ?? 0,
				'aria-label': t(`progress.phase.${phase}`),
			}, INSTALL_PHASES.map((name, index) => h('div', {
				className: 'dpm-phase',
				key: name,
				'data-state': states[index],
			}, h('i', null)))));
			rows.push(h('div', { className: 'dpm-phase-labels', key: 'labels' },
				INSTALL_PHASES.map((name) => h('span', {
					key: name,
					'data-active': phase === name ? 'true' : 'false',
				}, t(`progress.phase.${name}`)))));
			if (progress.attempt !== null && typeof progress.attempt === 'object') {
				rows.push(h('div', { className: 'dpm-meta', key: 'attempt' }, t('progress.attempt', {
					index: progress.attempt.index ?? '?',
					total: progress.attempt.total ?? '?',
					registry: progress.attempt.registry ?? '?',
				})));
			}
			if (typeof progress.message === 'string' && progress.message !== '') {
				rows.push(h('div', { className: phase === 'failed' ? 'dpm-error' : 'dpm-meta', key: 'message' }, progress.message));
			}
			if (progress.tooLate === true) rows.push(h('div', { className: 'dpm-warn', key: 'late' }, t('progress.tooLate')));
			if (typeof progress.cancelError === 'string' && progress.cancelError !== '') {
				rows.push(h('div', { className: 'dpm-warn', key: 'cancel-error' }, progress.cancelError));
			}
			const lines = Array.isArray(progress.lines) ? progress.lines.slice(-14) : [];
			const logText = lines.map((line) => typeof line.text === 'string' ? line.text : '').join('').trim();
			rows.push(h('div', { className: 'dpm-bar-row', key: 'logs-head' },
				h(Button, {
					kind: 'plain',
					onClick: () => actions.onToggleProgressLogs(),
				}, progress.logsOpen === true ? t('progress.logsHide') : t('progress.logsShow')),
				progress.logPath !== ''
					? h('span', { className: 'dpm-meta', title: progress.logPath }, t('progress.logPath', { path: progress.logPath }))
					: null,
				running ? h('span', { className: 'dpm-meta' }, t('progress.runningHint')) : null,
			));
			if (progress.logsOpen === true) {
				rows.push(h('pre', { className: 'dpm-log', key: 'logs' }, logText !== '' ? logText : t('progress.noLines')));
				// The machine phase is useful when reporting a failure, but only in
				// the expanded log, never as the primary sentence.
				rows.push(h('div', { className: 'dpm-meta', key: 'raw-phase' }, `phase: ${phase}`));
			}
			return h('div', { className: 'dpm-progress' }, ...rows);
		}

		/**
		 * The result banner under the list: one plain sentence, an optional next
		 * step, and the raw output behind a 显示详情 toggle.
		 */
		/**
		 * The pre-install gate for a plugin judged "harmful" (0.09).
		 *
		 * A red badge on a list row is read at the wrong moment: by the time the
		 * confirmation bar is open, the reader has already decided. This puts the
		 * report where the decision is actually made and requires one deliberate
		 * tick before the install button unlocks. It never blocks the install —
		 * the reader keeps the final say; the gate only makes sure they saw why.
		 * @returns the gate element, or null when the plugin has no harmful report.
		 */
		function HarmfulGate(t, entry, state, actions) {
			const review = entry === null || entry === undefined ? null : entry.review;
			if (review === null || review === undefined) return null;
			const harmful = review.worstHarmful ?? null;
			const count = Number.isFinite(review.harmfulCount) ? review.harmfulCount : 0;
			if (harmful === null && count === 0) return null;
			const acknowledged = state.acknowledgedHarmful === true;
			return h('div', { className: 'dpm-gate', key: 'gate' },
				h('div', { className: 'dpm-gate-head' },
					h('span', { className: 'dpm-gate-badge' }, t('gate.badge')),
					h('span', { className: 'dpm-gate-count' }, t('gate.count', { n: count }))),
				harmful !== null
					? h('div', { className: 'dpm-gate-title' }, harmful.title)
					: null,
				harmful !== null
					? h('div', { className: 'dpm-gate-meta' },
						harmful.author !== '' ? h('span', null, `${t('review.reviewer')} ${harmful.author}`) : null,
						harmful.publishedAt !== '' ? h('span', null, formatWhen(harmful.publishedAt)) : null,
						typeof harmful.url === 'string' && harmful.url !== ''
							? h('a', { className: 'dpm-repolink', href: harmful.url, target: '_blank', rel: 'noreferrer noopener' }, t('gate.read'))
							: null)
					: null,
				h('label', { className: 'dpm-gate-check' },
					h('input', {
						type: 'checkbox',
						checked: acknowledged,
						onChange: (event) => patch({ acknowledgedHarmful: event.target.checked }),
					}),
					h('span', null, t('gate.confirm'))),
			);
		}

		function OutcomeBar(t, state, actions) {
			const outcome = state.outcome;
			if (outcome === null) return null;
			const result = outcome.result ?? null;
			const output = outcome.detail !== undefined && outcome.detail !== '' ? outcome.detail : changeOutput(result);
			const pendingBuilds = result !== null && Array.isArray(result.pendingBuilds) ? result.pendingBuilds : [];
			const text = outcome.text !== undefined && outcome.text !== ''
				? outcome.text
				: outcome.removed !== undefined
					? `${t('outcome.removed')} · ${outcome.removed} · ${describeChange(t, result ?? {})}`
					: describeChange(t, result ?? {});
			const rows = [];
			rows.push(h('div', { className: 'dpm-bar-row', key: 'main' },
				h('span', { className: outcome.kind === 'error' ? 'dpm-error' : outcome.kind === 'ok' ? 'dpm-ok' : 'dpm-warn' }, text),
				outcome.kind === 'error'
					? h(Button, {
						kind: 'default',
						disabled: state.busy !== null,
						onClick: () => actions.onRetry(),
					}, t('action.retry'))
					: null,
				(output !== null && output !== undefined) || outcome.logPath !== undefined
					? h(Button, {
						kind: 'plain',
						onClick: () => actions.onToggleOutcome(),
					}, state.outcomeOpen === true ? t('error.detailsHide') : t('error.detailsShow'))
					: null,
			));
			if (typeof outcome.hint === 'string' && outcome.hint !== '') {
				rows.push(h('div', { className: 'dpm-error-hint', key: 'hint' }, t('error.suggestion', { hint: outcome.hint })));
			}
			if (Array.isArray(outcome.incompatible) && outcome.incompatible.length > 0) {
				rows.push(h('div', { className: 'dpm-error-hint', key: 'incompat' }, t('error.incompatible', { versions: outcome.incompatible.join(', ') })));
			}
			if (state.outcomeOpen === true && output !== null && output !== undefined && output !== '') {
				rows.push(h('pre', { className: 'dpm-pre', key: 'output' }, output));
			}
			if (state.outcomeOpen === true && typeof outcome.logPath === 'string' && outcome.logPath !== '') {
				rows.push(h('div', { className: 'dpm-meta', key: 'log' }, t('error.logPath', { path: outcome.logPath })));
			}
			if (pendingBuilds.length > 0) {
				rows.push(h('div', { className: 'dpm-bar-row', key: 'builds' },
					h('span', { className: 'dpm-warn' }, `${t('action.approveBuilds')}：${pendingBuilds.join(', ')}`),
					h(Button, {
						kind: 'default',
						disabled: state.busy !== null,
						onClick: () => actions.onApproveBuilds(pendingBuilds),
					}, t('action.approveBuilds')),
				));
			}
			return h('div', { className: 'dpm-bar' }, ...rows);
		}

		// ------------------------------------------------------------------ cards

		/**
		 * The community review badge for one row (0.05).
		 *
		 * One verdict badge followed by exactly one tier badge — the two used to be
		 * three separate chips (verdict + tier + "security sweep done"), which read
		 * as three unrelated claims. The tier already encodes how deep the review
		 * went, so the security chip is gone from both the list and the drawer.
		 *
		 * The tier shown is the STRONGEST any report reached, not just the newest:
		 * a plugin with a deep audit keeps that label even if a later standard
		 * report is the one displayed above it.
		 * @returns the badge row, or null when the plugin has no public report.
		 */
		function ReviewBadges(t, entry, actions) {
			const review = entry.review;
			if (review === null || review === undefined) return null;
			const verdict = typeof review.verdict === 'string' && review.verdict !== '' ? review.verdict : '';
			const tier = typeof review.bestTier === 'string' && review.bestTier !== ''
				? review.bestTier
				: (typeof review.tier === 'string' ? review.tier : '');
			const tags = [h('span', {
				key: 'review-verdict',
				className: 'dpm-tag dpm-review',
				'data-verdict': verdict === '' ? 'unknown' : verdict,
				title: verdict === 'untestable' ? t('review.untestableHint') : t('review.count', { n: review.count ?? 0 }),
			}, verdictLabel(t, verdict))];
			// The tier is never omitted: an unstated tier is itself information.
			tags.push(h('span', {
				key: 'review-tier',
				className: 'dpm-tag dpm-review-tier',
				'data-tier': tier === '' ? 'unstated' : tier,
				title: t(`review.tierHint.${tier === '' ? 'unstated' : tier}`),
			}, t(`review.tier.${tier === '' ? 'unstated' : tier}`)));
			if ((review.harmfulCount ?? 0) > 0) {
				tags.push(h('span', {
					key: 'review-harmful',
					className: 'dpm-tag dpm-review-harmful',
					title: t('review.harmfulWarning', { n: review.harmfulCount }),
				}, '⚠'));
			}
			return h('div', { className: 'dpm-tags dpm-review-tags' }, ...tags);
		}

		/**
		 * Translate one review verdict, with a fallback that never shows a raw key.
		 *
		 * The site adds verdict values as its method evolves — `untestable` appeared
		 * after this plugin shipped its first version. A missing dictionary entry
		 * used to surface as the literal string `review.untestable` in the badge, so
		 * an unknown value now degrades to the neutral "reviewed" label instead.
		 * @param t - translator.
		 * @param verdict - the raw value from the site.
		 * @returns a human label.
		 */
		function verdictLabel(t, verdict) {
			if (verdict === '') return t('review.unknownVerdict');
			if (Object.prototype.hasOwnProperty.call(zh, `review.${verdict}`)) return t(`review.${verdict}`);
			return t('review.unknownVerdict');
		}

		/**
		 * The Settings tab: appearance plus the preferences that already existed.
		 *
		 * The theme control is the point of this screen. It was added because a
		 * panel that inherits every colour from the surrounding theme can end up
		 * with a control whose text is unreadable, and the reader had no way to
		 * correct it from inside the plugin. Pinning the panel's own theme fixes
		 * that without asking the user to change the whole app.
		 * @returns the settings panel body.
		 */
		function SettingsPanel(t, state, actions) {
			const theme = state.prefs.theme;
			const resolved = resolveTheme(theme);
			const density = state.prefs.density === 'full' ? 'full' : 'compact';
			const startTab = state.prefs.startTab;
			const blocks = [];

			/**
			 * One segmented radio group.
			 *
			 * The whole screen uses this one shape for every choice, which is why it
			 * is a helper: five hand-written copies had already started to drift in
			 * ARIA attributes and label spacing.
			 */
			const segment = (label, values, current, choose, render) => h('div', {
				className: 'dpm-seg',
				role: 'radiogroup',
				'aria-label': label,
			}, values.map((value) => h(Button, {
				kind: 'segment',
				active: current === value ? 'true' : 'false',
				key: String(value),
				onClick: () => choose(value),
				extra: {
					'type': 'button',
					'role': 'radio',
					'aria-checked': current === value,
				},
			}, render(value))));

			const block = (key, title, hint, body, meta) => h('div', { className: 'dpm-settings-block', key },
				h('div', { className: 'dpm-settings-title' }, title),
				h('div', { className: 'dpm-settings-hint' }, hint),
				body,
				meta === null || meta === undefined ? null : h('div', { className: 'dpm-settings-meta' }, meta));

			// Where the verdicts on every row come from, and how old they are.
			//
			// Nothing to connect: the data is a published file, which is exactly
			// how every reader sees the same verdicts without anyone holding a
			// credential the review site does not issue.
			blocks.push(block('review-source', t('reviewSource.title'), t('reviewSource.hint'),
				h('div', { className: 'dpm-settings-stack' },
					h('div', { className: 'dpm-settings-row' },
						h('span', { className: state.reviewSource.available === true ? 'dpm-ok' : 'dpm-warn' },
							state.reviewSource.available === true
								? t('reviewSource.ok', { reviews: state.reviewSource.reviews, plugins: state.reviewSource.plugins })
								: t('reviewSource.missing')),
						h('span', { className: 'dpm-spacer' }),
						h(Button, {
							kind: 'default',
							disabled: state.reviewSource.busy === true,
							onClick: () => void refreshReviewSource(),
						}, state.reviewSource.busy === true ? t('reviewSource.refreshing') : t('reviewSource.refresh'))),
					// The two times are separate facts. `collected` is how current the
					// verdicts are; `checked` is only when this window last looked.
					state.reviewSource.dataAt === ''
						? null
						: h('div', { className: 'dpm-settings-meta' }, t('reviewSource.collected', { when: formatWhen(state.reviewSource.dataAt) })),
					state.reviewSource.checkedAt === 0
						? null
						: h('div', { className: 'dpm-settings-meta' }, t('reviewSource.checked', { when: formatWhen(new Date(state.reviewSource.checkedAt).toISOString()) })),
					state.reviewSource.problem === ''
						? null
						// The raw reason stays in the Host log. A reader needs to know the
						// verdicts may be stale, not which URL or exception failed.
						: h('div', { className: 'dpm-error' }, t('reviewSource.problem'))),
				t('reviewSource.note')));

			blocks.push(block('theme', t('settings.theme'), t('settings.themeHint'),
				segment(t('settings.theme'), ['auto', 'dark', 'light'], theme, (option) => actions.onSetTheme(option), (option) => t(`settings.theme.${option}`)),
				t('settings.themeActive', { theme: t(`settings.theme.${resolved}`) })));

			// A live preview: the exact controls whose text was unreadable before, so
			// a reader can confirm the choice actually fixed it without leaving the
			// screen.
			blocks.push(h('div', { className: 'dpm-settings-block', key: 'preview' },
				h('div', { className: 'dpm-settings-title' }, t('settings.preview')),
				h('div', { className: 'dpm-settings-row' },
					h(Button, { kind: 'primary', disabled: true }, t('action.install')),
					h('span', { className: 'dpm-seg dpm-seg-inline' },
						h(Button, { kind: 'segment', active: 'true', disabled: true }, '中'),
						h(Button, { kind: 'segment', disabled: true }, 'EN')),
					h('span', { className: 'dpm-pager dpm-pager-inline' },
						h(Button, { kind: 'pager', active: 'true', disabled: true }, '1'),
						h(Button, { kind: 'pager', disabled: true }, '2'))),
				h('div', { className: 'dpm-settings-hint' }, t('settings.previewHint')),
			));

			// How much each row says. Compact is the default and is what the list
			// was designed around; full is the escape hatch for comparing two
			// plugins' capability lists side by side.
			blocks.push(block('density', t('settings.density'), t('settings.densityHint'),
				segment(t('settings.density'), ['compact', 'full'], density, (option) => actions.onSetDensity(option), (option) => t(`settings.density.${option}`)),
				null));

			blocks.push(block('pageSize', t('settings.pageSize'), t('settings.pageSizeHint'),
				segment(t('settings.pageSize'), PAGE_SIZES, state.prefs.pageSize, (size) => actions.onSetPageSize(size), (size) => String(size)),
				null));

			blocks.push(block('startTab', t('settings.startTab'), t('settings.startTabHint'),
				segment(t('settings.startTab'), ['catalog', 'github', 'installed'], startTab, (tab) => actions.onSetStartTab(tab), (tab) => t(`tab.${tab}`)),
				null));

			// Language lives here too: it is an appearance choice, and the floating
			// pill in the corner could not be found by a first-time reader.
			blocks.push(block('lang', t('settings.language'), null,
				segment(t('settings.language'), ['zh', 'en'], state.prefs.lang, (lang) => actions.onSetLanguage(lang), (lang) => (lang === 'zh' ? t('settings.lang.zh') : t('settings.lang.en'))),
				null));

			// The update policy moved here from the installed tab: it is the only
			// preference in this window that changes something by itself, and it was
			// sitting in a toolbar where nobody looked for a setting.
			blocks.push(block('auto', t('updates.auto'), t('updates.autoHint', { hours: state.prefs.intervalHours }),
				h('div', { className: 'dpm-settings-row' },
					h(Button, {
						kind: 'switch',
						role: 'switch',
						disabled: false,
						extra: {
							'data-on': state.prefs.autoUpdate ? 'true' : 'false',
							'aria-checked': state.prefs.autoUpdate,
						},
						ariaLabel: t('updates.auto'),
						onClick: () => actions.onSetAutoUpdate(state.prefs.autoUpdate !== true),
					}, h('i', null)),
					state.prefs.autoUpdate === true
						? h('select', {
							className: 'dpm-select',
							value: String(state.prefs.intervalHours),
							'aria-label': t('updates.interval'),
							onChange: (event) => actions.onSetInterval(Number(event.target.value)),
						}, [1, 3, 6, 12, 24, 72].map((hours) => h('option', { key: hours, value: String(hours) }, t('updates.hours', { n: hours }))))
						: h('span', { className: 'dpm-settings-meta' }, t('updates.autoOff')),
				),
				t('updates.autoSkips')));

			// 0.10: move the installed list between machines.
			blocks.push(block('io', t('settings.export'), t('settings.exportHint'),
				h('div', { className: 'dpm-settings-row' },
					h(Button, { kind: 'default', onClick: actions.onExportInstalled }, t('settings.export')),
					h(Button, { kind: 'default', onClick: actions.onImportInstalled }, t('settings.import'))),
				null));

			// 0.10: show where the profile installs plugins, and how to move it.
			const installDir = state.profileDir === '' ? '' : `${state.profileDir}/node_modules`;
			blocks.push(block('installDir', t('settings.installDir'), t('settings.installDirHint'),
				h('div', { className: 'dpm-settings-row' },
					h('code', { className: 'dpm-code' }, installDir === '' ? t('settings.installDirUnknown') : installDir),
					h('span', { className: 'dpm-spacer' }),
					installDir === '' ? null : h(Button, { kind: 'default', onClick: actions.onCopyProfileDir }, t('settings.copyPath'))),
				null));


			// 0.10 labs: features that are designed but not wired up yet. They sit
			// here so the reader knows they are planned without promising a date.
			blocks.push(block('labs', t('settings.labs'), t('settings.labsHint'),
				h('div', { className: 'dpm-settings-stack' },
					h('div', { className: 'dpm-settings-row' },
						h('span', null, t('labs.dependency')),
						h('span', { className: 'dpm-spacer' }),
						h('span', { className: 'dpm-meta' }, t('labs.comingSoon'))),
					h('div', { className: 'dpm-settings-meta' }, t('labs.dependencyHint')),
					h('div', { className: 'dpm-settings-row' },
						h('span', null, t('labs.compare')),
						h('span', { className: 'dpm-spacer' }),
						h('span', { className: 'dpm-meta' }, t('labs.comingSoon'))),
					h('div', { className: 'dpm-settings-meta' }, t('labs.compareHint'))),
				null));

			return h('div', { className: 'dpm-settings', key: 'settings' }, ...blocks);
		}

		/**
		 * Scanner tags for one row, at the density the reader asked for.
		 *
		 * Compact (the default) keeps only the signals that can change the
		 * decision, both of them negative: "nobody scanned this" and "the scanner
		 * flagged n red lines". Everything else the scanner found — the capability
		 * list, the category, the language, the version — is one click away in the
		 * drawer, and printing it here made every row a wall of chips where one
		 * verdict, four capabilities and a category all carried the same weight.
		 *
		 * The full layout is still available as a preference, because the capability
		 * list is genuinely useful when comparing two plugins side by side.
		 * @param t - translator.
		 * @param entry - one catalog row.
		 * @param density - `compact` or `full`.
		 * @returns the tag row, or null when there is nothing worth saying.
		 */
		function Tags(t, entry, density) {
			const redLines = Array.isArray(entry.redLines) ? entry.redLines : [];
			const unscannedKey = entry.inCatalog === true ? 'label.catalogUnscanned' : 'label.unscanned';

			if (density !== 'full') {
				const tags = [];
				if (entry.scanned !== true) {
					tags.push(h('span', { key: 'unscanned', className: 'dpm-tag', 'data-risk': 'true' }, t(unscannedKey)));
				}
				// A count, not the text: a red line is a sentence, and two of them
				// pushed the description off the row. The tooltip carries the words.
				if (redLines.length > 0) {
					tags.push(h('span', {
						key: 'red',
						className: 'dpm-tag',
						'data-risk': 'true',
						title: redLines.join('；'),
					}, t('label.redLineCount', { n: redLines.length })));
				}
				return tags.length === 0 ? null : h('div', { className: 'dpm-tags' }, tags);
			}

			const tags = [];
			if (entry.scanned === true) tags.push(h('span', { key: 'scanned', className: 'dpm-tag', 'data-trust': 'true' }, t('label.scanned')));
			else tags.push(h('span', { key: 'unscanned', className: 'dpm-tag', 'data-risk': 'true' }, t(unscannedKey)));
			if (entry.installed === true) tags.push(h('span', { key: 'installed', className: 'dpm-tag', 'data-trust': 'true' }, t('label.installed')));
			if (entry.category !== '') tags.push(h('span', { key: 'category', className: 'dpm-tag' }, entry.category));
			for (const capability of (entry.capabilities ?? []).slice(0, 6)) {
				tags.push(h('span', { key: `cap:${capability}`, className: 'dpm-tag', 'data-risk': capability === 'shell' || capability === 'credentials' ? 'true' : 'false' }, capability));
			}
			for (const redLine of redLines.slice(0, 2)) {
				tags.push(h('span', { key: `red:${redLine}`, className: 'dpm-tag', 'data-risk': 'true', title: redLine }, redLine));
			}
			return tags.length === 0 ? null : h('div', { className: 'dpm-tags' }, tags);
		}

		/**
		 * The version badge for one catalog row: installable, up to date, or
		 * superseded by the version the catalog scanned.
		 * @returns a badge element, or null when no version is known.
		 */
		function VersionBadge(t, entry, busy, actions) {
			const info = actions.versionOf(entry);
			const installedVersion = info.installedVersion;
			const catalogVersion = info.catalogVersion;
			if (entry.installed === true) {
				if (info.outdated === true && catalogVersion !== '') {
					return h('div', { className: 'dpm-actions' },
						h('span', { className: 'dpm-ver', 'data-state': 'stale', title: t('ver.stale', { version: catalogVersion }) },
							t('ver.stale', { version: catalogVersion })),
						h('span', { className: 'dpm-meta' }, t('ver.installed', { version: installedVersion || '?' })),
						h(Button, {
							kind: 'primary',
							disabled: busy,
							onClick: (event) => {
								event.stopPropagation();
								actions.onUpdateCatalog(entry);
							},
						}, t('action.update')),
					);
				}
				return h('span', { className: 'dpm-ver', 'data-state': 'fresh' },
					installedVersion === '' ? t('label.installed') : t('ver.installed', { version: installedVersion }));
			}
			if (catalogVersion === '') return null;
			return h('span', { className: 'dpm-ver', 'data-state': 'available' }, t('ver.available', { version: catalogVersion }));
		}

		/** One catalog or GitHub row. */
		function EntryCard(t, entry, index, actions) {
			const busy = actions.busy !== null || actions.installing === true;
			const selected = actions.selected === entry.repo;
			const stars = compact(entry.stars);
			const downloads = compact(entry.downloads);
			const full = actions.density === 'full';
			const favorited = isFavorite(entry.repo);
			const note = actions.noteOf(entry.repo);
			// `starsAt` / `downloadsAt` explain where the number came from; the
			// contract wants them as a tooltip, never as a second row of noise.
			const starsAt = typeof entry.starsAt === 'string' ? entry.starsAt : '';
			const downloadsAt = typeof entry.downloadsAt === 'string' ? entry.downloadsAt : '';
			// The title line answers "what is it, who made it, is anyone using it".
			// The language and the version used to sit here too, but the version is
			// already a badge in the action column and the language is a property of
			// the code, not of the decision — both are in the drawer.
			const meta = [
				h('span', { key: 'stars', className: 'dpm-meta', title: starsAt !== '' ? t('stats.dataTime', { time: starsAt }) : undefined }, `★ ${stars}`),
				h('span', { key: 'downloads', className: 'dpm-meta', title: downloadsAt !== '' ? t('stats.dataTime', { time: downloadsAt }) : undefined }, `↓ ${downloads}`),
				full && entry.version !== '' && entry.installed !== true ? h('span', { key: 'version', className: 'dpm-meta' }, `v${entry.version}`) : null,
				full && entry.language !== undefined && entry.language !== '' ? h('span', { key: 'lang', className: 'dpm-meta' }, entry.language) : null,
			];
			const author = authorOf(entry.author);
			const installed = entry.installed === true;
			return h('div', {
				className: 'dpm-card',
				key: `${entry.repo}-${index}`,
				'data-clickable': 'true',
				'data-selected': selected ? 'true' : 'false',
				onClick: () => actions.onSelect(entry),
				title: t('drawer.title'),
			},
				h('div', { className: 'dpm-main' },
					h('div', { className: 'dpm-row' },
						h('span', { className: 'dpm-repo' }, entry.repo),
						author !== null ? AuthorChip(t, author, 16) : null,
						...meta,
						entry.translated === false
							? h('span', { key: 'original', className: 'dpm-tag' }, t('label.original'))
							: null,
						// Bookmark toggle, last in the title row so it never pushes the
						// name around. An installed `link:` row has no repository, and a
						// bookmark is keyed by `owner/name`, so those rows have no toggle.
						entry.repo.includes('/')
							? h(Button, {
								kind: 'icon',
								className: 'dpm-fav',
								key: 'fav',
								active: favorited ? 'true' : 'false',
								ariaLabel: favorited ? t('fav.remove') : t('fav.add'),
								title: favorited ? t('fav.remove') : t('fav.add'),
								onClick: (event) => {
									event.stopPropagation();
									actions.onToggleFavorite(entry.repo);
								},
							}, h(BookmarkGlyph, { filled: favorited }))
							: null,
					),
					entry.description !== '' ? h('div', { className: 'dpm-desc', title: entry.description }, entry.description) : null,
					// The reader's own note, in place of nothing: it is the only line
					// on the row that the catalog did not write, so it gets a left rule
					// to mark it as theirs rather than italic or a different font size,
					// both of which read as "less important".
					note !== '' ? h('div', { className: 'dpm-note', key: 'note', title: note }, note) : null,
					// The review badges sit above the trust tags: what an independent
					// reviewer measured outranks the scanner's capability list.
					ReviewBadges(t, entry, actions),
					Tags(t, entry, actions.density),
				),
				h('div', { className: 'dpm-actions' },
					VersionBadge(t, entry, busy, actions),
					installed
						? h(Button, {
							kind: 'danger',
							disabled: busy,
							onClick: (event) => {
								event.stopPropagation();
								actions.onRemove(entry);
							},
						}, t('action.remove'))
						: h(Button, {
							kind: 'primary',
							disabled: busy,
							onClick: (event) => {
								event.stopPropagation();
								actions.onImport(entry);
							},
						}, t('action.install')),
				),
			);
		}

		/** One version row inside the drawer's history list. */
		function VersionRow(t, item, entry, detail, actions) {
			const version = typeof item.version === 'string' ? item.version : '';
			if (version === '') return null;
			const source = item.source === 'npm' || item.source === 'release' || item.source === 'catalog' ? item.source : 'unknown';
			const newest = detail.latestVersion === version;
			const installedVersion = actions.versionOf(entry).installedVersion;
			const installed = installedVersion !== '' && installedVersion === version;
			// npm versions install exactly that version; release / catalog rows can
			// only fall back to the catalog spec the Host already derived.
			const npm = typeof detail.npm === 'string' && detail.npm !== '' ? detail.npm : (entry.npm ?? '');
			const installable = actions.busy === null && actions.installing !== true && (source === 'npm' ? npm !== '' : entry.spec !== '');
			// A bare `name@version` is the registry form; npm rows carry no scheme.
			const spec = source === 'npm' && npm !== '' ? `${npm}@${version}` : entry.spec;
			const date = formatWhen(item.at);
			return h(Button, {
				kind: 'version',
				key: `${source}-${version}`,
				extra: {
					'data-installable': installable ? 'true' : 'false',
					'data-installed': installed ? 'true' : 'false',
					'aria-disabled': installable ? 'false' : 'true',
				},
				title: installable ? t('versions.install') : '',
				onClick: installable ? () => actions.onInstallVersion(spec, version) : undefined,
			},
				h('span', { className: 'dpm-version-ver' }, version),
				date !== '' ? h('span', { className: 'dpm-version-date' }, date) : null,
				h('span', { className: 'dpm-version-badge', 'data-source': source }, t(`versions.source.${source}`)),
				newest ? h('span', { className: 'dpm-version-badge', 'data-source': 'release' }, t('versions.newest')) : null,
				installed ? h('span', { className: 'dpm-version-badge', 'data-source': 'release' }, t('versions.installedAt', { version })) : null,
			);
		}

		/**
		 * The "ask the author" block between the install spec and the version
		 * history (0.08).
		 *
		 * GitHub gives every repository an issue tracker, and optionally a
		 * Discussions board. Which ones exist comes from the Host's live stats
		 * read, so this renders the trackers that are actually there instead of
		 * a link that might 404. When the flags were never read it falls back to
		 * the repository page and says so, rather than pretending.
		 * @returns the field element, or null when there is no repository.
		 */
		function CommunityLinks(t, state, entry, actions) {
			const detail = state.detail;
			const payload = detail === null || detail.payload === null || detail.payload === undefined ? null : detail.payload;
			// The detail answer is authoritative; the row is a usable stand-in
			// while the request is still in flight.
			const community = (payload !== null && payload.community !== undefined)
				? payload.community
				: (entry.community !== undefined ? entry.community : null);
			const repo = community !== null && typeof community.repo === 'string' && community.repo !== ''
				? community.repo
				: (typeof entry.repo === 'string' && entry.repo.includes('/') ? entry.repo : '');
			if (repo === '') return null;

			const base = `https://github.com/${repo}`;
			const issues = community !== null && typeof community.newIssue === 'string' ? community.newIssue : null;
			const discussions = community !== null && typeof community.discussions === 'string' ? community.discussions : null;
			const known = community !== null && community.known === true;
			const archived = community !== null && community.archived === true;
			const openIssues = community !== null && Number.isFinite(community.openIssues) ? community.openIssues : null;

			const rows = [];
			if (issues !== null) {
				rows.push(h('a', {
					key: 'issue',
					className: 'dpm-community-link',
					href: issues,
					target: '_blank',
					rel: 'noreferrer noopener',
					title: t('community.issueHint'),
				}, t('community.issue')));
			}
			if (discussions !== null) {
				rows.push(h('a', {
					key: 'discussions',
					className: 'dpm-community-link',
					href: discussions,
					target: '_blank',
					rel: 'noreferrer noopener',
					title: t('community.discussionsHint'),
				}, t('community.discussions')));
			}
			// No tracker at all: the repository page is the only route left.
			if (issues === null && discussions === null) {
				rows.push(h('a', {
					key: 'repo',
					className: 'dpm-community-link',
					href: base,
					target: '_blank',
					rel: 'noreferrer noopener',
				}, t('community.repoOnly')));
			}

			const notes = [];
			if (archived) notes.push(h('span', { key: 'archived', className: 'dpm-warn' }, t('community.archived')));
			if (!known) {
				notes.push(h('span', { key: 'unknown', className: 'dpm-meta' }, t('community.unknown')));
			} else if (issues === null && discussions === null) {
				notes.push(h('span', { key: 'none', className: 'dpm-meta' }, t('community.noChannel')));
			} else if (openIssues !== null) {
				notes.push(h('span', { key: 'count', className: 'dpm-meta' }, t('community.openIssues', { n: openIssues })));
			}

			return h('div', { className: 'dpm-field', key: 'community' },
				h('span', { className: 'dpm-field-label' }, t('drawer.community')),
				h('div', { className: 'dpm-community' }, ...rows),
				...notes);
		}

		/**
		 * Latest version plus the scrollable version history for the open drawer.
		 * The data comes from the lazy `POST /detail`; a missing route or a failed
		 * read is explained, never rendered as "no versions".
		 */
		function VersionHistory(t, state, entry, actions) {
			const detail = state.detail;
			// Compare on the same key `loadDetail` stored the answer under. A catalog
			// row keys on its repo, but an installed bundle without a repository keys
			// on its package name, and comparing that against `entry.repo` (empty)
			// made this section claim there were no versions at all.
			const key = detailKeyOf(entry);
			const mine = detail !== null && detail.repo === key ? detail : null;
			const payload = mine === null ? null : mine.payload;
			const loading = mine !== null && mine.loading === true;
			const error = mine === null ? null : mine.error;
			const errorHint = mine === null ? null : mine.errorHint;
			const fields = [];
			if (loading) {
				fields.push(h('div', { className: 'dpm-field', key: 'versions' },
					h('span', { className: 'dpm-field-label' }, t('drawer.versions')),
					h('span', { className: 'dpm-meta' }, t('versions.loading'))));
				return fields;
			}
			if (payload === null) {
				fields.push(h('div', { className: 'dpm-field', key: 'versions' },
					h('span', { className: 'dpm-field-label' }, t('drawer.versions')),
					h('span', { className: 'dpm-error' }, error !== null ? `${t('versions.error')}：${error}` : t('versions.empty')),
					errorHint !== null && errorHint !== undefined && errorHint !== '' ? h('span', { className: 'dpm-meta' }, t('error.suggestion', { hint: errorHint })) : null));
				return fields;
			}
			const latest = typeof payload.latestVersion === 'string' && payload.latestVersion !== ''
				? payload.latestVersion
				: (Array.isArray(payload.versions) && payload.versions.length > 0 ? payload.versions[0].version : '');
			if (latest !== '') {
				fields.push(h('div', { className: 'dpm-field', key: 'latest' },
					h('span', { className: 'dpm-field-label' }, t('drawer.latest')),
					h('span', { className: 'dpm-version-ver' }, latest),
					payload.checkedAt !== undefined ? h('span', { className: 'dpm-meta' }, t('versions.checkedAt', { time: formatWhen(payload.checkedAt) })) : null));
			}
			const versions = Array.isArray(payload.versions) ? payload.versions : [];
			fields.push(h('div', { className: 'dpm-field', key: 'versions' },
				h('span', { className: 'dpm-field-label' }, t('drawer.versions')),
				versions.length === 0
					? h('span', { className: 'dpm-meta' }, t('versions.empty'))
					: h('div', { className: 'dpm-version-list' }, versions.map((item) => VersionRow(t, item, entry, payload, actions))),
				Array.isArray(payload.problems) && payload.problems.length > 0
					? h('span', { className: 'dpm-warn' }, `${t('versions.problems')}${payload.problems.map((problem) => `${problem?.kind ?? '?'} ${problem?.message ?? ''}`.trim()).join('；')}`)
					: null));
			return fields;
		}

		/**
		 * The community review block inside the detail drawer (0.04).
		 *
		 * Shows the newest report in full (verdict, reviewer, publish time, report
		 * link, evidence count) and folds the older ones behind a count, so a plugin
		 * whose early "harmful" was later fixed does not carry the old label at the
		 * top. The two timestamps are the point of the whole section: a report can
		 * be older than the commit the reader is about to install.
		 * @returns the review section, or null when there is nothing to show.
		 */
		function ReviewSection(t, entry, state, actions) {
			const detail = state.detail;
			const payload = detail === null || detail.payload === null || detail.payload === undefined ? null : detail.payload;
			const review = payload !== null && payload.review !== undefined ? payload.review : entry.review;
			const loading = detail !== null && detail.loading === true;
			const unavailable = payload !== null && payload.reviewLoaded === false;

			if (review === null || review === undefined) {
				if (loading) return h('div', { className: 'dpm-field', key: 'review' },
					h('span', { className: 'dpm-field-label' }, t('review.title')),
					h('span', { className: 'dpm-meta' }, t('empty.loading')));
				if (unavailable) return h('div', { className: 'dpm-field', key: 'review' },
					h('span', { className: 'dpm-field-label' }, t('review.title')),
					h('span', { className: 'dpm-meta dpm-warn' }, t('review.unavailable')));
				return h('div', { className: 'dpm-field', key: 'review' },
					h('span', { className: 'dpm-field-label' }, t('review.title')),
					h('span', { className: 'dpm-meta' }, t('review.none')));
			}

			const latest = review.latest ?? {};
			const verdict = typeof latest.verdict === 'string' && latest.verdict !== '' ? latest.verdict : 'unknown';
			// The strongest tier any report reached; see ReviewBadges.
			const bestTier = typeof review.bestTier === 'string' && review.bestTier !== ''
				? review.bestTier
				: (typeof review.tier === 'string' ? review.tier : '');
			const others = Array.isArray(review.reviews) ? review.reviews.filter((item) => item.reviewId !== latest.reviewId) : [];
			const expanded = actions.reviewExpanded === true;

			const rows = [];
			rows.push(h('div', {
				className: 'dpm-review-card',
				key: 'latest',
				'data-verdict': verdict,
			},
				h('div', { className: 'dpm-review-card-meta' },
					h('span', { className: 'dpm-tag dpm-review', 'data-verdict': verdict },
						t(verdictLabel(t, verdict === 'unknown' ? '' : verdict))),
					// Exactly one tier chip: it already says how deep the review went,
					// so a separate "security sweep done" chip would repeat it.
					h('span', {
						className: 'dpm-tag dpm-review-tier',
						'data-tier': bestTier === '' ? 'unstated' : bestTier,
						title: t(`review.tierHint.${bestTier === '' ? 'unstated' : bestTier}`),
					}, t(`review.tier.${bestTier === '' ? 'unstated' : bestTier}`)),
				),
				h('div', { className: 'dpm-review-card-title' }, latest.title ?? ''),
				h('div', { className: 'dpm-review-card-meta' },
					h('span', null, `${t('review.reviewer')} ${latest.author !== '' ? latest.author : '—'}`),
					h('span', null, `${t('review.publishedAt')} ${formatWhen(latest.publishedAt)}`),
					latest.evidenceCount > 0 ? h('span', null, t('review.evidence', { n: latest.evidenceCount })) : null,
				),
				typeof latest.url === 'string' && latest.url !== ''
					? h('a', {
						className: 'dpm-repolink',
						href: latest.url,
						target: '_blank',
						rel: 'noreferrer noopener',
					}, t('review.open'))
					: null,
			));

			if ((review.harmfulCount ?? 0) > 0) {
				rows.push(h('div', { className: 'dpm-warn', key: 'harm' }, t('review.harmfulWarning', { n: review.harmfulCount })));
			}

			if (others.length > 0) {
				rows.push(h(Button, {
					kind: 'plain',
					key: 'more',
					onClick: () => actions.onToggleReviewHistory(),
				}, expanded ? t('review.less') : t('review.more', { n: others.length })));
				if (expanded) {
					for (const item of others) {
						const itemVerdict = typeof item.verdict === 'string' && item.verdict !== '' ? item.verdict : 'unknown';
						rows.push(h('div', { className: 'dpm-review-card', key: item.reviewId, 'data-verdict': itemVerdict },
							h('div', { className: 'dpm-review-card-meta' },
								h('span', { className: 'dpm-tag dpm-review', 'data-verdict': itemVerdict },
									t(verdictLabel(t, itemVerdict === 'unknown' ? '' : itemVerdict))),
								item.tier !== '' && item.tier !== undefined
									? h('span', { className: 'dpm-tag dpm-review-tier', 'data-tier': item.tier }, t(`review.tier.${item.tier}`))
									: null,
								item.author !== '' ? h('span', null, `${t('review.reviewer')} ${item.author}`) : null,
								h('span', null, formatWhen(item.publishedAt)),
							),
							h('div', { className: 'dpm-review-card-title' }, item.title ?? ''),
							typeof item.url === 'string' && item.url !== ''
								? h('a', { className: 'dpm-repolink', href: item.url, target: '_blank', rel: 'noreferrer noopener' }, t('review.open'))
								: null,
						));
					}
				}
			}

			const reviewedAt = payload !== null && payload.reviewedAt !== undefined ? payload.reviewedAt : entry.reviewedAt;
			const repoUpdatedAt = payload !== null && payload.repoUpdatedAt !== undefined ? payload.repoUpdatedAt : entry.repoUpdatedAt;
			const stale = typeof reviewedAt === 'number' && typeof repoUpdatedAt === 'number' && repoUpdatedAt > reviewedAt;
			rows.push(h('div', { className: 'dpm-review-times', key: 'times' },
				reviewedAt !== undefined ? h('span', null, `${t('review.reviewedAt')} ${formatWhen(reviewedAt)}`) : null,
				repoUpdatedAt !== undefined ? h('span', null, `${t('review.repoUpdatedAt')} ${formatWhen(repoUpdatedAt)}`) : null,
				stale ? h('span', { className: 'dpm-warn' }, t('review.stale')) : null,
			));

			return h('div', { className: 'dpm-field', key: 'review' },
				h('span', { className: 'dpm-field-label' }, t('review.title')),
				...rows);
		}

		/**
		 * The screenshot strip at the top of the detail drawer (0.09).
		 *
		 * 1328 of the 6084 catalog entries publish screenshots, and a market without
		 * them asks the reader to install blind — this is the cheapest trust signal
		 * available. The images are external GitHub URLs, so every failure mode is
		 * contained: a broken image hides itself, and one successful image failing
		 * does not take the strip down.
		 * @returns the strip element, or null when the entry has no screenshots.
		 */
		function ScreenshotStrip(props) {
			const t = props.t;
			const entry = props.entry;
			const shots = Array.isArray(entry.screenshots)
				? entry.screenshots.filter((url) => typeof url === 'string' && /^https?:\/\//.test(url)).slice(0, 6)
				: [];
			// The hook must run before any early return. Calling it after the
			// `shots.length === 0` guard changed the hook count when the reader
			// switched between a plugin that has screenshots and one that does
			// not, and React aborts the whole overlay when that happens.
			const [active, setActive] = useState(0);
			// 0.10: lightbox (click the big image) and auto-advance (multiple shots).
			const [zoomed, setZoomed] = useState(null);
			const [paused, setPaused] = useState(false);
			useEffect(() => {
				if (shots.length <= 1 || paused === true || zoomed !== null) return undefined;
				const timer = window.setInterval(() => setActive((index) => (index + 1) % shots.length), 4000);
				return () => window.clearInterval(timer);
			}, [shots.length, paused, zoomed]);
			// No screenshots is the common case (78% of the catalog); render nothing
			// rather than an empty placeholder that would imply missing data.
			if (shots.length === 0) return null;
			const current = shots[Math.min(active, shots.length - 1)];
			const strip = h('div', { className: 'dpm-shots', key: 'shots' },
				h('div', { className: 'dpm-shots-main' },
					h('img', {
						key: current,
						className: 'dpm-shot-big',
						src: current,
						alt: '',
						loading: 'lazy',
						referrerPolicy: 'no-referrer',
						onClick: () => setZoomed(current),
						// A dead external link should collapse, never show a broken icon.
						onError: (event) => { event.currentTarget.style.display = 'none'; },
					}),
				),
				shots.length > 1
					? h('div', {
						className: 'dpm-shots-thumbs',
						onMouseEnter: () => setPaused(true),
						onMouseLeave: () => setPaused(false),
					},
						shots.map((url, index) => h(Button, {
							kind: 'thumb',
							key: url,
							active: index === active ? 'true' : 'false',
							'aria-label': t('drawer.screenshotN', { n: index + 1 }),
							onClick: () => setActive(index),
						}, h('img', {
							src: url,
							alt: '',
							loading: 'lazy',
							referrerPolicy: 'no-referrer',
							onError: (event) => { event.currentTarget.style.display = 'none'; },
						}))))
					: null,
			);
			if (zoomed === null) return strip;
			return h(Fragment, { key: 'shots-zoom' },
				strip,
				h('div', { className: 'dpm-lightbox', onClick: () => setZoomed(null) },
					h('img', { src: zoomed, alt: '', referrerPolicy: 'no-referrer' }),
					h('div', { className: 'dpm-lightbox-hint' }, t('drawer.screenshotZoomHint')),
				),
			);
		}

		/**
		 * The provenance block: everything needed to judge where this plugin came
		 * from, in one place (0.09).
		 *
		 * The drawer previously scattered these facts — repository link in one
		 * field, spec in another, author in a third, update times in a fourth — so a
		 * reader had to assemble the picture themselves. This groups them by the
		 * questions people actually ask, and every value is already in the payload:
		 * no extra request, and nothing is inferred.
		 * @returns a single field element.
		 */
		function Provenance(t, state, entry) {
			const detail = state.detail;
			const payload = detail === null || detail.payload === null || detail.payload === undefined ? null : detail.payload;
			const rows = [];

			/** One label/value row inside the block. */
			const row = (key, label, value) => {
				if (value === null || value === undefined) return
				rows.push(h('div', { className: 'dpm-prov-row', key },
					h('span', { className: 'dpm-prov-key' }, label),
					h('span', { className: 'dpm-prov-val' }, value)))
			}

			// Where the code actually comes from. `spec` is what pluginManager will
			// hand to pnpm, so it is the single most load-bearing line here.
			if (typeof entry.spec === 'string' && entry.spec !== '') {
				rows.push(h('div', { className: 'dpm-prov-row', key: 'spec' },
					h('span', { className: 'dpm-prov-key' }, t('prov.installFrom')),
					h('code', { className: 'dpm-code' }, entry.spec)))
			}

			const repo = typeof entry.repo === 'string' && entry.repo !== '' ? entry.repo : ''
			if (repo !== '') {
				rows.push(h('div', { className: 'dpm-prov-row', key: 'repo' },
					h('span', { className: 'dpm-prov-key' }, t('prov.repo')),
					h('a', {
						className: 'dpm-repolink',
						href: typeof entry.url === 'string' && entry.url !== '' ? entry.url : `https://github.com/${repo}`,
						target: '_blank',
						rel: 'noreferrer noopener',
					}, `github.com/${repo}`)))
			}

			// Who publishes it. A registry name and a GitHub account are different
			// identities and are shown as such rather than merged into "author".
			const author = authorOf(entry.author)
			if (author !== null) {
				rows.push(h('div', { className: 'dpm-prov-row', key: 'author' },
					h('span', { className: 'dpm-prov-key' }, t('prov.publisher')),
					h('a', {
						className: 'dpm-repolink',
						href: author.url,
						target: '_blank',
						rel: 'noreferrer noopener',
					}, author.name !== '' ? `${author.login} (${author.name})` : author.login)))
			}

			// Which channel the install actually uses — a registry package and a git
			// package have completely different update semantics.
			const kind = entry.installed === true ? null : (typeof entry.npm === 'string' && entry.npm !== '' ? 'registry' : 'git')
			if (kind !== null) row('channel', t('prov.channel'), t(kind === 'registry' ? 'prov.channelRegistry' : 'prov.channelGit'))

			const npmName = typeof entry.npm === 'string' && entry.npm !== '' ? entry.npm : (payload !== null && typeof payload.npm === 'string' ? payload.npm : '')
			if (npmName !== '') {
				rows.push(h('div', { className: 'dpm-prov-row', key: 'npm' },
					h('span', { className: 'dpm-prov-key' }, t('prov.npm')),
					h('a', {
						className: 'dpm-repolink',
						href: `https://www.npmjs.com/package/${npmName}`,
						target: '_blank',
						rel: 'noreferrer noopener',
					}, npmName)))
			}

			// When each side last moved. A spec that says "latest" is only as fresh
			// as the last publish, which is why both dates are shown.
			const repoUpdatedAt = payload !== null && payload.repoUpdatedAt !== undefined ? payload.repoUpdatedAt : entry.repoUpdatedAt
			const reviewedAt = payload !== null && payload.reviewedAt !== undefined ? payload.reviewedAt : entry.reviewedAt
			if (repoUpdatedAt !== undefined) row('repoAt', t('prov.repoUpdated'), formatWhen(repoUpdatedAt))
			if (reviewedAt !== undefined) row('reviewedAt', t('prov.reviewedAt'), formatWhen(reviewedAt))

			// The catalogue's own observation times: how fresh are the stars and
			// download counts this drawer is showing.
			const statsAt = payload !== null && payload.stats !== null && payload.stats !== undefined ? payload.stats.starsAt : entry.starsAt
			const downloadsAt = payload !== null && payload.stats !== null && payload.stats !== undefined ? payload.stats.downloadsAt : entry.downloadsAt
			if (statsAt !== undefined) row('statsAt', t('prov.statsAt'), formatWhen(statsAt))
			if (downloadsAt !== undefined) row('downloadsAt', t('prov.downloadsAt'), formatWhen(downloadsAt))

			// Where the listing itself came from, so the reader can weigh it.
			if (entry.inCatalog === true) row('catalog', t('prov.listed'), t('prov.listedCatalog'))
			else row('catalog', t('prov.listed'), t('prov.listedGithub'))

			if (rows.length === 0) return null
			return h('div', { className: 'dpm-field', key: 'provenance' },
				h('span', { className: 'dpm-field-label' }, t('prov.title')),
				h('div', { className: 'dpm-prov' }, ...rows))
		}

		/**
		 * The right-hand detail drawer for one catalog row.
		 * @param t - translator.
		 * @param entry - the selected catalog row (already in the active language).
		 * @param state - the window store.
		 * @param actions - window actions.
		 * @returns the drawer element.
		 */
		function DetailDrawer(t, entry, state, actions) {
			const fields = [];
			// Provenance replaces the three separate author / repo / spec fields: those
			// facts only mean something together, and the drawer is where a reader
			// decides whether to trust the thing at all.
			const provenance = Provenance(t, state, entry);
			if (provenance !== null) fields.push(provenance);
			// Sits between the install spec and the version history, where a
			// reader who has just decided the spec is acceptable looks next for
			// "who do I ask about this".
			const communityField = CommunityLinks(t, state, entry, actions);
			if (communityField !== null) fields.push(communityField);
			// Version history is lazy: only the drawer that is actually open asks
			// the Host for it, and the answer is cached per repo for the session.
			fields.push(...VersionHistory(t, state, entry, actions));

			const stats = [];
			if (entry.category !== '') stats.push(entry.category);
			stats.push(`★ ${compact(entry.stars)}`);
			stats.push(`↓ ${compact(entry.downloads)}`);
			if (entry.forks !== undefined) stats.push(`${t('label.forks')} ${compact(entry.forks)}`);
			if (entry.version !== '') stats.push(`v${entry.version}`);
			if (entry.license !== undefined && entry.license !== '') stats.push(entry.license);
			const detailPayload = state.detail !== null && state.detail.repo === detailKeyOf(entry) ? state.detail.payload : null;
			const dataAt = detailPayload?.stats?.starsAt ?? entry.starsAt ?? state.catalog.statsAt;
			const downloadsAt = detailPayload?.stats?.downloadsAt ?? entry.downloadsAt ?? state.catalog.downloadsAt;
			fields.push(h('div', { className: 'dpm-field', key: 'stats' },
				h('span', { className: 'dpm-field-label' }, t('drawer.stats')),
				h('span', { className: 'dpm-meta' }, stats.join(' · ')),
				typeof entry.updatedAt === 'string' && entry.updatedAt !== ''
					? h('span', { className: 'dpm-meta' }, t('stats.updated', { time: formatWhen(entry.updatedAt) }))
					: null,
				typeof dataAt === 'string' && dataAt !== '' ? h('span', { className: 'dpm-meta' }, t('stats.dataTime', { time: formatWhen(dataAt) })) : null,
				typeof downloadsAt === 'string' && downloadsAt !== '' ? h('span', { className: 'dpm-meta' }, t('stats.downloadsAt', { time: formatWhen(downloadsAt) })) : null));

			// Host compatibility (0.10): the `engines.dsh` the newest version declares.
			const engines = detailPayload !== null && typeof detailPayload.engines === 'object' ? detailPayload.engines : null;
			const compat = dshCompatibility(state.versions.harness, engines);
			if (compat.state !== 'none') {
				fields.push(h('div', { className: 'dpm-field', key: 'engines' },
					h('span', { className: 'dpm-field-label' }, t('drawer.engines')),
					h('span', { className: compat.state === 'bad' ? 'dpm-warn' : 'dpm-meta' }, t('drawer.enginesDsh', { range: compat.range })),
					compat.state === 'bad'
						? h('span', { className: 'dpm-warn' }, t('drawer.enginesBad'))
						: compat.state === 'ok' ? h('span', { className: 'dpm-meta dpm-ok' }, t('drawer.enginesOk')) : null));
			}

			const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : [];
			if (capabilities.length > 0) {
				fields.push(h('div', { className: 'dpm-field', key: 'caps' },
					h('span', { className: 'dpm-field-label' }, t('drawer.capabilities')),
					h('div', { className: 'dpm-tags' }, capabilities.map((capability) => h('span', {
						key: capability,
						className: 'dpm-tag',
						'data-risk': capability === 'shell' || capability === 'credentials' ? 'true' : 'false',
					}, capability)))));
			}
			const redLines = Array.isArray(entry.redLines) ? entry.redLines : [];
			if (redLines.length > 0) {
				fields.push(h('div', { className: 'dpm-field', key: 'red' },
					h('span', { className: 'dpm-field-label' }, t('drawer.redLines')),
					h('div', { className: 'dpm-tags' }, redLines.map((line) => h('span', {
						key: line,
						className: 'dpm-tag',
						'data-risk': 'true',
					}, line)))));
			}

			const versionInfo = actions.versionOf(entry);
			const installedVersion = versionInfo.installedVersion;
			const busy = actions.busy !== null || actions.installing !== true;
			// A note is keyed by `owner/name`. Catalog and GitHub rows always carry
			// one; an installed registry package only learns it once `/detail` has
			// resolved the row, so the editor appears after that answer arrives
			// rather than guessing a key that would never match a list row again.
			const noteRepo = typeof entry.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(entry.repo)
				? entry.repo
				: (detailPayload !== null && typeof detailPayload.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(detailPayload.repo)
					? detailPayload.repo
					: '');
			return h('aside', { className: 'dpm-drawer', key: 'drawer', role: 'complementary', 'aria-label': t('drawer.title') },
				h('header', { className: 'dpm-drawer-head' },
					h('span', { className: 'dpm-title' }, t('drawer.title')),
					h('span', { className: 'dpm-spacer' }),
					h(Button, {
						kind: 'icon',
						title: t('drawer.close'),
						'aria-label': t('drawer.close'),
						onClick: () => actions.onSelect(null),
					}, h(CloseGlyph, null)),
				),
				h('div', { className: 'dpm-drawer-body' },
					h('div', { className: 'dpm-drawer-title' }, entry.repo),
					// Screenshots first: seeing the thing is the fastest way to decide
					// whether the rest of this drawer is worth reading. Rendered with
					// h() because it owns state — calling it as a plain function put its
					// useState on the drawer's own hook list.
					h(ScreenshotStrip, { key: 'shots', t, entry }),
					h('div', { className: 'dpm-field' },
						h('span', { className: 'dpm-field-label' }, t('drawer.about')),
						h('div', { className: 'dpm-drawer-desc' }, entry.description !== '' ? entry.description : t('drawer.noDescription')),
					),
					entry.translated === false && state.prefs.lang === 'zh'
						? h('div', { className: 'dpm-warn', key: 'orig' }, t('drawer.original'))
						: null,
					h('div', { className: 'dpm-meta', key: 'hint' }, t('drawer.translateHint')),
					// The reader's own note: editable here, shown on the row. A
					// bookmark says "look at this again", a note says why — and only
					// the reader can write that line. Saved on blur rather than per
					// keystroke, so typing is one localStorage write, not two hundred.
					noteRepo === '' ? null : h('div', { className: 'dpm-field', key: 'note' },
						h('span', { className: 'dpm-field-label' }, t('note.label')),
						h('input', {
							className: 'dpm-input dpm-note-input',
							// Remounted per repository, which is what makes an
							// uncontrolled input correct: the field shows the note of the
							// row currently open, not the one before it.
							key: `note-${noteRepo}`,
							type: 'text',
							defaultValue: actions.noteOf(noteRepo),
							maxLength: NOTE_LIMIT,
							placeholder: t('note.placeholder'),
							'aria-label': t('note.label'),
							onBlur: (event) => actions.onSetNote(noteRepo, event.target.value),
							onKeyDown: (event) => {
								if (event.key === 'Enter') event.currentTarget.blur();
							},
						}),
						actions.noteOf(noteRepo) === '' ? h('span', { className: 'dpm-settings-meta' }, t('note.hint')) : null,
					),
					// The community review section sits before the raw fields: an
					// independent verdict is the first thing worth knowing.
					ReviewSection(t, entry, state, actions),
					// An installed row carries its bundle, so the same drawer renders the
					// install location, source and service state instead of a second
					// implementation existing for that case.
					entry.bundle === undefined ? null : InstalledSection(t, entry.bundle, state, actions),
					...fields,
				),
				h('footer', { className: 'dpm-drawer-foot' },
					entry.installed === true
						? h(Button, {
							kind: 'danger',
							disabled: busy,
							onClick: () => actions.onRemove(entry),
						}, t('action.remove'))
						: h(Button, {
							kind: 'primary',
							disabled: busy,
							onClick: () => actions.onImport(entry),
						}, t('action.install')),
					versionInfo.outdated === true
						? h(Button, {
							kind: 'primary',
							disabled: busy,
							onClick: () => actions.onUpdateCatalog(entry),
						}, t('action.update'))
						: null,
					entry.installed === true && installedVersion !== ''
						? h('span', { className: 'dpm-meta' }, t('ver.installed', { version: installedVersion }))
						: null,
				),
			);
		}

		/**
		 * How the running DSH measures against the `engines.dsh` range the newest
		 * version declares. The range is usually a lower bound (`>=x`, `^x`, `x`),
		 * so the first concrete version in it is the floor to compare against.
		 * @returns `{ state, range }` where state is `none` (no declaration),
		 * `unknown` (could not compare), `ok`, or `bad`.
		 */
		function dshCompatibility(harnessVersion, engines) {
			if (engines === null || typeof engines !== 'object') return { state: 'none', range: '' };
			const range = typeof engines.dsh === 'string' ? engines.dsh.trim() : '';
			if (range === '' || range === '*') return { state: 'none', range };
			const read = (value) => {
				const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(value));
				return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
			};
			const min = read(range);
			const current = read(harnessVersion);
			if (min === null || current === null) return { state: 'unknown', range };
			for (let index = 0; index < 3; index += 1) {
				if (current[index] !== min[index]) return { state: current[index] > min[index] ? 'ok' : 'bad', range };
			}
			return { state: 'ok', range };
		}

		/**
		 * What can honestly be said about one bundle's version.
		 *
		 * The three source kinds differ: a hand-written `link:` folder has no
		 * releases, a git dependency follows a commit and has nothing to compare,
		 * and only a registry package has a `latest`. "Not checked yet" is its own
		 * state and must not read as "cannot check".
		 * @returns `{ text, tone, action }` where action is null, `update`, or `reinstall`.
		 */
		function versionStateOf(t, bundle, actions) {
			const kind = kindOf(bundle);
			if (kind === 'local') return { text: t('label.local'), tone: 'meta', action: null, note: null };
			// Git installs CAN be checked now — the Host reads GitHub Releases for
			// them — so consult the check before falling back to "reinstall". A
			// newer release turns this into an ordinary update row.
			if (kind === 'git') {
				const check = actions.updateFor(bundle.name);
				if (check !== undefined && check.checked === true) {
					if (check.outdated === true) {
						return { text: t('label.outdated', { version: check.latest }), tone: 'warn', action: 'update', note: null };
					}
					return { text: t('label.upToDate'), tone: 'ok', action: null, note: null };
				}
				return { text: t('label.gitSource'), tone: 'meta', action: 'reinstall', note: null };
			}
			// Without a declared spec nothing about the source can be judged, and
			// saying "cannot check" would hide the real cause.
			if (kind === 'unknown') return { text: t('label.unknownSource'), tone: 'warn', action: null, note: null };
			const check = actions.updateFor(bundle.name);
			if (check === undefined) return { text: t('label.notChecked'), tone: 'meta', action: null, note: null };
			if (check.checked !== true) {
				// The Host names what happened; the three known reasons are
				// translated, anything unexpected falls back to the raw word so
				// a new Host reason is never silently swallowed.
				const reason = typeof check.reason === 'string' && check.reason !== '' ? check.reason : '';
				const known = {
					'git-no-repo': t('reason.gitNoRepo'),
					'no-releases': t('reason.noReleases'),
					local: t('reason.localSource'),
					git: t('reason.gitSource'),
				}[reason];
				return {
					text: t('label.updateUnknown'),
					tone: 'warn',
					action: null,
					note: known !== undefined ? known : (reason !== '' ? t('label.checkReason', { reason }) : null),
				};
			}
			if (check.outdated === true) return { text: t('label.outdated', { version: check.latest }), tone: 'warn', action: 'update', note: null };
			return { text: t('label.upToDate'), tone: 'ok', action: null, note: null };
		}

		/** Update status line plus its actions for one installed bundle. */
		function UpdateCell(t, bundle, actions) {
			const state = versionStateOf(t, bundle, actions);
			if (state.action !== 'update') {
				const tone = state.tone === 'ok' ? 'dpm-meta dpm-ok' : state.tone === 'warn' ? 'dpm-meta dpm-warn' : 'dpm-meta';
				return h('div', { className: 'dpm-actions' },
					h('span', { className: tone }, state.text),
					state.note !== null ? h('span', { className: 'dpm-meta' }, state.note) : null,
					state.action === 'reinstall'
						? h(Button, {
							kind: 'default',
							disabled: actions.busy !== null,
							onClick: (event) => {
								event.stopPropagation();
								actions.onReinstall(bundle);
							},
						}, t('label.reinstall'))
						: null,
				);
			}
			const ignored = actions.isIgnored(bundle.name);
			const check = actions.updateFor(bundle.name);
			const repo = check !== undefined && typeof check.repo === 'string' && check.repo !== '' ? check.repo : '';
			return h('div', { className: 'dpm-actions' },
				h('span', { className: 'dpm-meta dpm-warn' }, state.text),
				h(Button, {
					kind: 'primary',
					disabled: actions.busy !== null,
					onClick: (event) => {
						event.stopPropagation();
						actions.onUpdate(bundle.name);
					},
				}, t('action.update')),
				repo !== ''
					? h('a', {
						className: 'dpm-repolink',
						href: `https://github.com/${repo}/releases`,
						target: '_blank',
						rel: 'noreferrer noopener',
						onClick: (event) => event.stopPropagation(),
					}, t('updates.changelog'))
					: null,
				h(Button, {
					kind: 'plain',
					onClick: (event) => {
						event.stopPropagation();
						actions.onIgnore(bundle.name, ignored !== true);
					},
				}, ignored === true ? t('action.unskip') : t('action.skip')),
			);
		}

		/**
		 * Whether a bundle is genuinely in service: switched on *and* at least
		 * one of its rows actually active. An older Host reports no `running`,
		 * so fall back to its enable flag.
		 */
		function isRunning(bundle) {
			return bundle.running === undefined ? bundle.enabled === true : bundle.running === true;
		}

		/** The diagnostic line for a bundle that is installed but not in service. */
		function reasonLine(t, bundle) {
			switch (bundle.reason) {
				case 'disabled': return t('reason.disabled');
				case 'failed': return t('reason.failed');
				case 'no-rows': return t('reason.noRows');
				case 'not-running': return t('reason.notRunning', { live: bundle.liveRows ?? 0, total: bundle.rows ?? 0 });
				case 'not-selected': return t('reason.notSelected');
				default: return null;
			}
		}

		/** One installed bundle row. */
		function InstalledCard(t, bundle, index, actions) {
			const running = isRunning(bundle);
			const reason = running ? null : reasonLine(t, bundle);
			const partial = running && bundle.partial === true ? t('reason.partial', { failed: bundle.failedRows ?? 0 }) : null;
			// One selection slot for all three surfaces: the installed card marks
			// itself selected when the shared drawer is showing this bundle.
			const selected = actions.selectedBundle === bundle.name;
			const batchSelected = actions.isSelected(bundle.name);
			const author = authorOf(bundle.author);
			// The Host reports the verdict alongside the update check, so the warning
			// is visible before the update button is pressed — not only after it
			// opens the gate.
			const check = actions.updateFor(bundle.name);
			const harmful = check !== undefined && check.harmful === true;
			// The newest releasable version lives on the update check, not on the
			// installed row — the Host never writes `latestVersion` into `/installed`
			// (that field only exists on `/detail`). Reading it from the row left
			// every registry plugin without a "latest" line.
			const latest = check !== undefined && typeof check.latest === 'string' && check.latest !== ''
				? check.latest
				: (typeof bundle.latestVersion === 'string' ? bundle.latestVersion : '');
			return h('div', {
				className: 'dpm-card',
				key: `${bundle.name}-${index}`,
				'data-clickable': 'true',
				'data-selected': selected ? 'true' : 'false',
				onClick: () => actions.onSelect(entryFromBundle(bundle)),
				title: t('drawer.title'),
			},
				h('div', { className: 'dpm-main' },
					h('div', { className: 'dpm-row' },
						h('input', {
							type: 'checkbox',
							className: 'dpm-check',
							checked: batchSelected,
							'aria-label': t('batch.select'),
							onChange: () => actions.onToggleSelect(bundle.name),
							onClick: (event) => event.stopPropagation(),
						}),
						h('span', { className: 'dpm-repo' }, bundle.name),
						author !== null ? AuthorChip(t, author, 16) : null,
						bundle.version !== '' ? h('span', { className: 'dpm-meta' }, `v${bundle.version}`) : null,
						h('span', { className: 'dpm-meta' }, `${bundle.rows} ${t('label.rows')}`),
						h('span', { className: 'dpm-tag', 'data-trust': running ? 'true' : 'false', 'data-risk': running ? 'false' : 'true' },
							running ? t('label.enabled') : t('label.disabled')),
						harmful
							? h('span', { className: 'dpm-tag', 'data-risk': 'true', title: t('gate.badge') }, t('review.harmful'))
							: null,
					),
					bundle.description !== '' ? h('div', { className: 'dpm-desc' }, bundle.description) : null,
					reason !== null ? h('div', { className: 'dpm-desc dpm-warn', title: reason }, reason) : null,
					partial !== null ? h('div', { className: 'dpm-desc dpm-warn' }, partial) : null,
					bundle.error !== null ? h('div', { className: 'dpm-desc dpm-error' }, bundle.error) : null,
					bundle.dir !== undefined && bundle.dir !== ''
						? h('div', { className: 'dpm-path', title: bundle.dir }, bundle.dir)
						: null,
				),
				h('div', { className: 'dpm-actions' },
					latest !== '' && kindOf(bundle) === 'registry'
						? h('span', { className: 'dpm-meta' }, t('installed.latest', { version: latest }))
						: null,
					// A package that was installed without ever being selected has
					// no live rows to compare versions against; "enable" is the fix.
					bundle.reason === 'not-selected'
						? h('span', { className: 'dpm-meta dpm-warn' }, t('reason.notSelected'))
						: actions.checking === true && kindOf(bundle) === 'registry'
							? h('span', { className: 'dpm-meta' }, t('busy.checking'))
							: UpdateCell(t, bundle, actions),
					h(Button, {
						kind: 'default',
						disabled: actions.busy !== null,
						onClick: (event) => {
							event.stopPropagation();
							actions.onToggle(bundle.name, bundle.enabled !== true);
						},
					}, bundle.enabled === true ? t('action.disable') : t('action.enable')),
					bundle.removable === true
						? h(Button, {
							kind: 'danger',
							disabled: actions.busy !== null,
							onClick: (event) => {
								event.stopPropagation();
								actions.onRemove({ name: bundle.name, installed: true });
							},
						}, t('action.delete'))
						: null,
				),
			);
		}

		/**
		 * The installed-only facts the shared drawer renders.
		 *
		 * This is a section, not a drawer: the installed list used to own a whole
		 * second drawer implementation, which is exactly how it fell behind the
		 * catalog one. Everything it knows now goes through the same
		 * `DetailDrawer` the catalog and GitHub search use.
		 * @returns the section element.
		 */
		function InstalledSection(t, bundle, state, actions) {
			const running = isRunning(bundle);
			const busy = actions.busy !== null;
			const fields = [];

			if (bundle.dir !== undefined && bundle.dir !== '') {
				fields.push(h('div', { className: 'dpm-field', key: 'dir' },
					h('span', { className: 'dpm-field-label' }, t('installed.dir')),
					h('code', { className: 'dpm-code' }, bundle.dir)));
			}
			if (bundle.spec !== undefined && bundle.spec !== '') {
				fields.push(h('div', { className: 'dpm-field', key: 'spec' },
					h('span', { className: 'dpm-field-label' }, t('drawer.spec')),
					h('code', { className: 'dpm-code' }, bundle.spec)));
			}
			const source = sourceUrlFor(bundle);
			if (source !== '') {
				fields.push(h('div', { className: 'dpm-field', key: 'source' },
					h('span', { className: 'dpm-field-label' }, t('installed.source')),
					h('a', { className: 'dpm-repolink', href: source, target: '_blank', rel: 'noreferrer noopener' }, source)));
			}

			const versionInfo = versionStateOf(t, bundle, actions);
			const check = actions.updateFor(bundle.name);
			const latest = check !== undefined && typeof check.latest === 'string' && check.latest !== ''
				? check.latest
				: (typeof bundle.latestVersion === 'string' ? bundle.latestVersion : '');
			fields.push(h('div', { className: 'dpm-field', key: 'version' },
				h('span', { className: 'dpm-field-label' }, t('installed.versionState')),
				h('span', { className: versionInfo.tone === 'warn' ? 'dpm-warn' : versionInfo.tone === 'ok' ? 'dpm-meta dpm-ok' : 'dpm-meta' }, versionInfo.text),
				latest !== '' ? h('span', { className: 'dpm-meta' }, t('installed.latest', { version: latest })) : null,
				versionInfo.note !== null ? h('span', { className: 'dpm-meta' }, versionInfo.note) : null,
				versionInfo.action === 'reinstall'
					? h(Button, {
						kind: 'default',
						disabled: busy,
						onClick: () => actions.onReinstall(bundle),
					}, t('label.reinstall'))
					: versionInfo.action === 'update'
						? h(Button, {
							kind: 'primary',
							disabled: busy,
							onClick: () => actions.onUpdate(bundle.name),
						}, t('action.update'))
						: null));
			fields.push(h('div', { className: 'dpm-field', key: 'rows' },
				h('span', { className: 'dpm-field-label' }, t('installed.rowsCount')),
				h('span', { className: 'dpm-meta' }, `${bundle.rows} · ${running ? t('label.enabled') : t('label.disabled')}`)));

			const reason = running ? null : reasonLine(t, bundle);
			const partial = running && bundle.partial === true ? t('reason.partial', { failed: bundle.failedRows ?? 0 }) : null;
			fields.push(h('div', { className: 'dpm-field', key: 'installed-actions' },
				h('span', { className: 'dpm-field-label' }, t('installed.state')),
				h('div', { className: 'dpm-tags' },
					h('span', { className: 'dpm-tag', 'data-trust': running ? 'true' : 'false', 'data-risk': running ? 'false' : 'true' },
						running ? t('label.enabled') : t('label.disabled')),
					h('span', { className: 'dpm-tag' }, kindOf(bundle) === 'local' ? t('label.local') : kindOf(bundle))),
				reason !== null ? h('span', { className: 'dpm-warn' }, reason) : null,
				partial !== null ? h('span', { className: 'dpm-warn' }, partial) : null,
				bundle.error !== null && bundle.error !== undefined ? h('span', { className: 'dpm-error' }, bundle.error) : null));

			return h(Fragment, { key: 'installed' }, ...fields);
		}

		/** A titled group inside the installed list. */
		function Group(title, count, children) {
			return h(Fragment, { key: `group-${title}` },
				h('div', { className: 'dpm-group' },
					h('span', null, `${title} · ${count}`),
					h('span', { className: 'dpm-group-line' }),
				),
				...children,
			);
		}

		/** Update policy and the manual check, above the installed list. */
		function UpdateBar(t, state, actions) {
			const outdated = state.updates === null
				? 0
				: state.updates.checks.filter((check) => check.outdated === true).length;
			const status = state.busy === 'updates'
				? t('busy.checking')
				: state.specResolved === false
					? t('installed.manifestMissing')
					: state.updates === null
						? t('updates.none')
						: outdated === 0 ? t('updates.allFresh') : t('updates.checked', { n: outdated });
			return h('div', { className: 'dpm-updatebar', key: 'updatebar' },
				h(Button, {
					kind: 'default',
					disabled: state.busy !== null,
					onClick: () => void loadUpdates(),
				}, t('action.checkUpdates')),
				h(Button, {
					kind: 'primary',
					disabled: state.busy !== null || outdated === 0,
					title: t('updates.allHint'),
					onClick: () => actions.onUpdateAll(),
				}, t('updates.all')),
				h('span', { className: outdated > 0 || state.specResolved === false ? 'dpm-warn' : undefined }, status),
				h('span', { className: 'dpm-spacer' }),
				// The switch itself moved to Settings: a policy that acts on its own
				// belongs with the other preferences, not in a status toolbar. The
				// current state stays visible here because this is where an update
				// decision is actually made.
				h('span', { className: 'dpm-meta' }, state.prefs.autoUpdate === true
					? t('updates.autoOn', { hours: state.prefs.intervalHours })
					: t('updates.autoOffShort')),
				h(Button, {
					kind: 'plain',
					onClick: () => actions.onSelectTab('settings'),
				}, `${t('settings.open')} ›`),
			);
		}

		/** 0.10: the action bar that appears once at least one row is selected. */
		function BatchBar(t, state, actions) {
			const n = state.selectedNames.length;
			return h('div', { className: 'dpm-batchbar', key: 'batchbar' },
				h('span', null, t('batch.n', { n })),
				h(Button, { kind: 'default', onClick: actions.onSelectAll }, t('batch.selectAll')),
				h(Button, { kind: 'plain', onClick: actions.onClearSelection }, t('batch.clear')),
				h('span', { className: 'dpm-spacer' }),
				h(Button, { kind: 'default', disabled: state.busy !== null, onClick: actions.onBulkEnable }, t('batch.enable')),
				h(Button, { kind: 'default', disabled: state.busy !== null, onClick: actions.onBulkDisable }, t('batch.disable')),
				h(Button, { kind: 'danger', disabled: state.busy !== null, onClick: actions.onBulkDelete }, t('batch.delete')),
			);
		}

		/** The bottom-right language switch for every list this window shows. */
		function LanguagePill(t, state) {
			return h('div', { className: 'dpm-lang', key: 'lang', role: 'group', 'aria-label': t('lang.title') },
				h('span', { className: 'dpm-lang-note' }, '译'),
				...['zh', 'en'].map((lang) => h(Button, {
					kind: 'lang',
					active: state.prefs.lang === lang ? 'true' : 'false',
					key: lang,
					title: t('lang.title'),
					onClick: () => setLanguage(lang),
					extra: {
					'aria-pressed': state.prefs.lang === lang,
					},
				}, t(`lang.${lang}`))),
			);
		}

		// --------------------------------------------------------------- surfaces

		/** The sidebar-foot button that opens the popup. */
		function MarketAction(props) {
			useStore();
			const t = translator(props);
			const wide = props === null || typeof props !== 'object' || props.wide !== false;
			return h(Fragment, null,
				h(Styles, { key: 'styles' }),
				h(Button, {
					kind: 'action',
					key: 'action',
					extra: {
						'data-wide': wide ? 'true' : 'false',
					},
					title: t('toggle.title'),
					'aria-label': t('toggle.title'),
					onClick: () => openMarket(),
				},
					h(ShopGlyph, { key: 'glyph', size: 16 }),
					wide ? h('span', { key: 'label', className: 'dpm-label' }, t('action.open')) : null,
				),
			);
		}

		/**
		 * Catch a render failure so the window degrades instead of vanishing.
		 *
		 * Without this, one thrown error anywhere in the tree unmounted the whole
		 * overlay with no message — the user saw the panel disappear ("闪退") and
		 * had nothing to report. The boundary keeps the shell on screen, names the
		 * error, and offers a way back to a clean state.
		 */
		class Boundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}

			static getDerivedStateFromError(error) {
				return { error };
			}

			componentDidCatch(error, info) {
				// The console keeps the full stack for a bug report; the panel shows
				// only the message so a long trace cannot push the buttons offscreen.
				console.error('[plugin-market] render failed', error, info?.componentStack);
			}

			render() {
				const error = this.state.error;
				if (error === null) return this.props.children;
				const t = this.props.t ?? ((key) => (Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key));
				return h('div', { className: 'dpm-backdrop', key: 'crash' },
					h('section', { className: 'dpm-panel', role: 'alertdialog', 'aria-label': t('crash.title') },
						h('header', { className: 'dpm-head' },
							h(ShopGlyph, { key: 'glyph', size: 18 }),
							h('span', { className: 'dpm-title' }, t('crash.title')),
							h('span', { className: 'dpm-spacer' }),
							h(Button, {
								kind: 'icon',
								title: t('action.close'),
								'aria-label': t('action.close'),
								onClick: () => closeMarket(),
							}, h(CloseGlyph, null)),
						),
						h('div', { className: 'dpm-body' },
							h('div', { className: 'dpm-hint' }, t('crash.hint')),
							h('pre', { className: 'dpm-pre' }, String(error?.message ?? error)),
							h('div', { className: 'dpm-bar-row' },
								h(Button, {
									kind: 'primary',
									onClick: () => {
										// Reset every transient bit so the retry starts from a
										// known state instead of replaying the failure.
										patch({ selected: null, detail: null, pending: null, progress: null, outcome: null });
										this.setState({ error: null });
									},
								}, t('crash.retry')),
							),
						),
					),
				);
			}
		}

		/** The popup itself, wrapped so one bad render cannot blank the overlay. */
		function MarketModal(props) {
			const state = useStore();
			const t = translator(props);
			// Keyed by the open flag so every fresh open mounts a clean boundary.
			// Without this an error caught once kept the crash panel on screen the
			// next time the market was opened, which looks like the bug persisted.
			const key = state.open === true ? 'boundary-open' : 'boundary-closed';
			return h(Boundary, { t, key }, h(MarketModalInner, { ...props, key: 'inner' }));
		}

		function MarketModalInner(props) {
			const state = useStore();
			const t = translator(props);
			const [draft, setDraft] = useState('');
			const inputRef = useRef(null);
			const panelRef = useRef(null);
			const bodyRef = useRef(null);

			useEffect(() => {
				if (state.open !== true) return undefined;
				const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
				const onKey = (event) => {
					if (event.key === 'Escape') {
						event.preventDefault();
						closeMarket();
					}
				};
				document.addEventListener('keydown', onKey, true);
				return () => {
					window.clearTimeout(timer);
					document.removeEventListener('keydown', onKey, true);
				};
			}, [state.open]);

			if (state.open !== true) return null;

			/** Scroll the list back to the top after a page change. */
			const scrollBodyTop = () => {
				const node = bodyRef.current;
				if (node !== null) node.scrollTop = 0;
			};

			const actions = {
				busy: state.busy,
				installing: state.progress !== null && state.progress.running === true,
				checking: state.busy === 'updates',
				selected: state.selected === null ? null : state.selected.repo,
				selectedBundle: state.selected !== null && state.selected.bundle !== undefined ? state.selected.bundle.name : null,
				onSelect: (entry) => selectEntry(entry),
				onToggleFavorite: (repo) => toggleFavorite(repo),
				noteOf: (repo) => noteOf(repo),
				onSetNote: (repo, text) => setNote(repo, text),
				onSetTheme: (theme) => setTheme(theme),
				onSetLanguage: (lang) => setLanguage(lang),
				// List layout and paging, both owned by the settings screen.
				density: state.prefs.density === 'full' ? 'full' : 'compact',
				onSetDensity: (density) => setDensity(density),
				onSetPageSize: (size) => setPageSize(size),
				onSetStartTab: (tab) => setStartTab(tab),
				onSetAutoUpdate: (on) => setPrefs({ autoUpdate: on === true }),
				onSetInterval: (hours) => setPrefs({ intervalHours: Number.isFinite(hours) ? Math.min(168, Math.max(1, Math.trunc(hours))) : 6 }),
				onSelectTab: (tab) => selectTab(tab),
				onToggleReviewHistory: () => patch({ reviewExpanded: store.reviewExpanded !== true }),
				onPage: (page) => {
					if (page < 1 || page > Math.max(1, state.totalPages) || page === state.page) return;
					void runSearch(page);
					scrollBodyTop();
				},
				onLogin: (token) => void loginWithToken(token),
				onSignOut: () => void signOut(),
				onImport: (entry) => void startImport(entry),
				onRemove: (entry) => void removeBundle(entry.name),
				onToggle: (name, enabled) => void toggleBundle(name, enabled),
				onUpdate: (name) => void updateBundle(name, 'update'),
				// A git dependency has no version to compare, so "update" means
				// re-resolving its declared spec and pulling the current commit.
				onReinstall: (bundle) => void updateBundle(bundle.spec !== '' && bundle.spec !== undefined ? bundle.spec : bundle.name, 'reinstall'),
				onUpdateCatalog: (entry) => void updateBundle(entry.spec, 'update'),
				onInstallVersion: (spec) => void runInstall(spec, { label: 'install' }),
				onIgnore: (name, ignore) => setIgnored(name, ignore),
				// 0.10: batch selection + actions, one-click update, and manifest I/O.
				isSelected: (name) => state.selectedNames.includes(name),
				onToggleSelect: (name) => {
					const names = state.selectedNames.includes(name)
						? state.selectedNames.filter((entry) => entry !== name)
						: [...state.selectedNames, name];
					patch({ selectedNames: names });
				},
				onSelectAll: () => patch({ selectedNames: state.installed.map((bundle) => bundle.name) }),
				onClearSelection: () => patch({ selectedNames: [] }),
				onBulkEnable: () => void bulkToggle(true),
				onBulkDisable: () => void bulkToggle(false),
				onBulkDelete: () => void bulkRemove(),
				onUpdateAll: () => void updateAll(),
				onExportInstalled: () => exportInstalled(),
				onImportInstalled: () => importInstalled(),
				onCopyProfileDir: () => {
					const dir = state.profileDir;
					if (dir === '' || typeof navigator === 'undefined' || navigator.clipboard === undefined) return;
					navigator.clipboard.writeText(dir)
						.then(() => setOutcome({ kind: 'ok', text: tt('settings.copied') }))
						.catch(() => undefined);
				},
				onCancelInstall: () => void cancelInstall(),
				onDismissProgress: () => patch({ progress: null }),
				onToggleProgressLogs: () => {
					if (state.progress === null) return;
					patch({ progress: { ...state.progress, logsOpen: state.progress.logsOpen !== true } });
				},
				onToggleOutcome: () => patch({ outcomeOpen: state.outcomeOpen !== true }),
				onApproveBuilds: (builds) => void confirmImport(builds),
				onRetry: () => {
					const spec = state.outcome !== null && typeof state.outcome.retrySpec === 'string' ? state.outcome.retrySpec : '';
					if (spec !== '') void runInstall(spec, { label: 'install' });
					else void runSearch(state.page);
				},
				isIgnored: (name) => state.prefs.ignored.includes(name),
				// The Host reports the comparison directly; fall back to the
				// client's own copy of the installed list so the badge still
				// works against an older Host (for example before a restart).
				versionOf: (entry) => {
					const catalogVersion = typeof entry.version === 'string' ? entry.version : '';
					let installedVersion = typeof entry.installedVersion === 'string' ? entry.installedVersion : '';
					if (installedVersion === '' && entry.installed === true) {
						for (const candidate of [packageNameOfSpec(entry.spec), entry.name]) {
							if (candidate === '') continue;
							const bundle = state.installed.find((row) => row.name === candidate);
							if (bundle !== undefined && typeof bundle.version === 'string' && bundle.version !== '') {
								installedVersion = bundle.version;
								break;
							}
						}
					}
					const outdated = entry.outdated === true
						|| (installedVersion !== '' && catalogVersion !== '' && compareVersionStrings(catalogVersion, installedVersion) > 0);
					return { installedVersion, outdated, catalogVersion };
				},
				updateFor: (name) => {
					const updates = state.updates;
					if (updates === null) return undefined;
					return updates.checks.find((check) => check.name === name);
				},
			};

			/** The curated chips follow the display language. */
			const facets = state.prefs.lang === 'zh' ? state.catalog.categoriesZh : state.catalog.categories;

			const submit = () => {
				patch({ query: draft.trim(), category: '', page: 1 });
				void runSearch(1);
				scrollBodyTop();
			};

			const trapFocus = (event) => {
				if (event.key !== 'Tab') return;
				const panel = panelRef.current;
				if (panel === null) return;
				const focusables = panel.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href]');
				if (focusables.length === 0) return;
				const first = focusables[0];
				const last = focusables[focusables.length - 1];
				const active = document.activeElement;
				if (event.shiftKey && (active === first || !panel.contains(active))) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && active === last) {
					event.preventDefault();
					first.focus();
				}
			};

			const catalogChips = [];
			if (state.tab === 'catalog' && state.catalog.ready === true) {
				catalogChips.push(h(Button, {
					kind: 'chip',
					active: state.category === '' && state.reviewedOnly !== true && state.favoritesOnly !== true ? 'true' : 'false',
					key: 'all',
					onClick: () => {
						// "All" means all: leaving a membership filter armed would show a
						// chip that reads as "no category" while the list is still filtered.
						patch({ category: '', reviewedOnly: false, favoritesOnly: false, page: 1 });
						void runSearch(1);
						scrollBodyTop();
					},
					extra: {
					'type': 'button',
					},
				}, t('cat.all')));
				// The review filter sits right after "all": it is a membership test
				// over the whole catalog, not a curated category, so it must not be
				// buried among the facets that come and go with the catalog build.
				//
				// It is always shown, even with an unknown count: hiding it when the
				// review index was slow or the running Host predates the field made
				// the control simply disappear, which reads as a missing feature
				// rather than as missing data.
				const reviewedTotal = Number.isFinite(state.catalog.reviewedTotal) ? state.catalog.reviewedTotal : null;
				catalogChips.push(h(Button, {
					kind: 'chip',
					// The class was declared in the stylesheet but no call site ever
					// applied it, so the membership filter looked exactly like a
					// category facet despite the comment saying it must not.
					className: 'dpm-chip-review',
					active: state.reviewedOnly === true ? 'true' : 'false',
					key: 'reviewed',
					title: t('review.chipHint'),
					onClick: () => {
						patch({ reviewedOnly: state.reviewedOnly !== true, category: '', page: 1 });
						void runSearch(1);
						scrollBodyTop();
					},
					extra: {
					'type': 'button',
					'aria-pressed': state.reviewedOnly === true,
					},
				}, reviewedTotal === null || reviewedTotal <= 0
					? t('review.chipAll')
					: t('review.chip', { n: reviewedTotal })));
				// Bookmarks, next to the review filter for the same reason: it is a
				// membership test over the whole catalog, not a facet.
				//
				// Hidden at zero, unlike the review chip. "0 bookmarks" is not missing
				// data, it is a feature the reader has not used yet, and an always-empty
				// chip would be the only control in this row that can never do anything.
				const favoriteCount = state.prefs.favorites.length;
				if (favoriteCount > 0) {
					catalogChips.push(h(Button, {
						kind: 'chip',
						active: state.favoritesOnly === true ? 'true' : 'false',
						key: 'favorites',
						title: t('fav.chipHint'),
						onClick: () => {
							// Clears the category for the same reason the review chip does —
							// this selects "all of my bookmarks", not "my bookmarks in this
							// category" — but leaves the review filter alone, because
							// "bookmarked and independently reviewed" is a real question.
							patch({
								favoritesOnly: state.favoritesOnly !== true,
								category: '',
								page: 1,
							});
							void runSearch(1);
							scrollBodyTop();
						},
						extra: {
							'type': 'button',
							'aria-pressed': state.favoritesOnly === true,
						},
					}, t('fav.chip', { n: favoriteCount })));
				}
				for (const facet of facets) {
					catalogChips.push(h(Button, {
						kind: 'chip',
						active: state.category === facet.category ? 'true' : 'false',
						key: facet.category,
						onClick: () => {
							patch({ category: facet.category, page: 1 });
							void runSearch(1);
							scrollBodyTop();
						},
						extra: {
						'type': 'button',
						},
					}, `${facet.category} ${facet.count}`));
				}
			}
			const githubChips = state.tab === 'github'
				? GITHUB_PRESETS.map((preset) => h(Button, {
					kind: 'chip',
					active: state.query === preset ? 'true' : 'false',
					key: preset,
					onClick: () => {
						setDraft(preset);
						patch({ query: preset, page: 1 });
						void runSearch(1);
						scrollBodyTop();
					},
					extra: {
					'type': 'button',
					},
				}, preset))
				: [];

			const body = [];
			if (state.tab === 'settings') {
				// Settings never shows a loading state: it is local state only.
				body.push(SettingsPanel(t, state, actions));
			} else if (state.tab === 'history') {
				body.push(h('div', { className: 'dpm-hint', key: 'hint' }, t('history.hint')));
				body.push(h('div', { className: 'dpm-empty', key: 'empty' }, t('history.comingSoon')));
			} else if (state.loading) {
				body.push(h('div', { className: 'dpm-empty', key: 'loading' },
					state.tab === 'catalog' && state.catalog.ready !== true ? t('busy.catalog') : t('empty.loading')));
			} else if (state.tab === 'installed') {
				if (state.installedError !== null) body.push(h('div', { className: 'dpm-empty dpm-error', key: 'err' }, state.installedError));
				else if (state.installed.length === 0) body.push(h('div', { className: 'dpm-empty', key: 'empty' }, t('empty.installed')));
				else {
					// Grouping follows actual service, not the switch: a package that
					// is on but contributes no live row belongs under "not enabled".
					const running = state.installed.filter((bundle) => isRunning(bundle));
					const idle = state.installed.filter((bundle) => isRunning(bundle) !== true);
					body.push(UpdateBar(t, state, actions));
					if (state.selectedNames.length > 0) body.push(BatchBar(t, state, actions));
					if (running.length > 0) body.push(Group(t('group.enabled'), running.length, running.map((bundle, index) => InstalledCard(t, bundle, index, actions))));
					if (idle.length > 0) body.push(Group(t('group.disabled'), idle.length, idle.map((bundle, index) => InstalledCard(t, bundle, running.length + index, actions))));
				}
			} else if (state.entries.length === 0) {
				const key = state.tab === 'github' ? 'empty.github' : 'empty.catalog';
				body.push(h('div', { className: 'dpm-empty', key: 'empty' }, t(key)));
			} else {
				body.push(...state.entries.map((entry, index) => EntryCard(t, entry, index, actions)));
			}

			const pending = state.pending;
			const inspection = pending === null ? null : pending.inspection;
			const bundleState = inspection === null || typeof inspection !== 'object'
				? 'unknown'
				: inspection.bundle === true ? 'yes' : inspection.bundle === false ? 'no' : 'unknown';
			// The gate only applies to a plugin an independent reviewer judged
			// harmful; everything else confirms exactly as before.
			const pendingReview = pending === null || pending.entry === undefined ? null : pending.entry.review;
			const pendingHarmful = pendingReview !== null && pendingReview !== undefined
				&& ((pendingReview.harmfulCount ?? 0) > 0 || pendingReview.worstHarmful !== null && pendingReview.worstHarmful !== undefined);
			const gateLocked = pendingHarmful && state.acknowledgedHarmful !== true;

			const footBits = [];
			if (state.tab === 'catalog') {
				if (state.catalog.ready === true) footBits.push(t('foot.catalog', { n: state.catalog.total }));
				if (state.catalog.error !== null) footBits.push(h('span', { key: 'cerr', className: 'dpm-error' }, `${t('error.catalog')}：${state.catalog.error}`));
			}
			const listTab = state.tab === 'catalog' || state.tab === 'github';
			if (listTab) footBits.push(t('foot.total', { n: state.total }));
			if (listTab) footBits.push(Pager(t, state, actions));
			if (listTab && state.total > 0) {
				footBits.push(t('pager.summary', { page: state.page, total: Math.max(1, state.totalPages) }));
			}
			// Observation time: the live /stats pass first, then the catalog's own.
			const dataAt = state.statsCheckedAt > 0
				? formatStamp(state.statsCheckedAt)
				: state.catalog.statsAt !== '' ? formatWhen(state.catalog.statsAt) : '';
			if (listTab && dataAt !== '') footBits.push(t('foot.dataTime', { time: dataAt }));
			if (state.tab === 'github') {
				const rate = state.rate;
				if (rate !== null && rate.authenticated === true) footBits.push(t('foot.token'));
				else footBits.push(t('foot.noToken'));
				if (rate !== null && Number.isFinite(rate.remaining)) footBits.push(t('foot.rate', { n: rate.remaining }));
			}

			const clickBackdrop = (event) => {
				if (event.target === event.currentTarget) closeMarket();
			};

			return h(Fragment, null,
				h(Styles, { key: 'styles' }),
				h('div', { className: 'dpm-backdrop', key: 'backdrop', onMouseDown: clickBackdrop },
					h('section', {
						className: 'dpm-panel',
						ref: panelRef,
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': t('title'),
						// Drives the accent / on-accent pair above. Pinning a local theme here
						// keeps this panel readable regardless of the surrounding scheme.
						'data-theme': resolveTheme(state.prefs.theme),
						onKeyDown: trapFocus,
					},
						h('header', { className: 'dpm-head' },
							h(ShopGlyph, { key: 'glyph', size: 18 }),
							h('span', { className: 'dpm-title', key: 'title' }, t('title')),
							// The two versions sit immediately after the title as compact pills.
							// They are informational, not interactive, and never push the tab
							// strip: the row is allowed to shrink them instead.
							h('span', { className: 'dpm-versions', key: 'versions' },
								h('span', {
									className: 'dpm-version-pill',
									'data-kind': 'plugin',
									title: t('version.marketHint'),
								}, state.versions.plugin !== ''
									? t('version.market', { version: state.versions.plugin })
									: `${t('version.marketShort')} ${t('version.unknown')}`),
								h('span', {
									className: 'dpm-version-pill',
									'data-kind': 'harness',
									'data-unknown': state.versions.harness === '' ? 'true' : 'false',
									title: state.versions.harness === ''
										? t('version.harnessUnknownHint')
										: t('version.harnessHint'),
								}, state.versions.harness !== ''
									? t('version.harness', { version: state.versions.harness })
									: `${t('version.harnessShort')} ${t('version.unknown')}`),
							),
							h('span', { className: 'dpm-spacer' }),
							h('div', { className: 'dpm-tabs' },
								['catalog', 'github', 'installed', 'history', 'settings'].map((tab) => h(Button, {
									kind: 'tab',
									active: state.tab === tab ? 'true' : 'false',
									key: tab,
									onClick: () => selectTab(tab),
									extra: {
									'type': 'button',
									},
								}, t(`tab.${tab}`))),
							),
							h(Button, {
								kind: 'icon',
								'data-signed': state.account.configured === true ? 'true' : 'false',
								title: t('account.expand'),
								'aria-label': t('account.expand'),
								'aria-pressed': state.accountOpen,
								onClick: () => patch({ accountOpen: state.accountOpen !== true }),
							}, h(UserGlyph, null)),
							h(Button, {
								kind: 'icon',
								title: t('action.refresh'),
								'aria-label': t('action.refresh'),
								disabled: state.loading,
								onClick: () => void loadCatalog(true),
							}, h(RefreshGlyph, null)),
							h(Button, {
								kind: 'icon',
								title: t('action.close'),
								'aria-label': t('action.close'),
								onClick: () => closeMarket(),
							}, h(CloseGlyph, null)),
						),
						state.accountOpen === true ? AccountPanel(t, state, actions) : null,
						state.tab === 'installed' || state.tab === 'history'
							? null
							: h('div', { className: 'dpm-search' },
								h('input', {
									className: 'dpm-input',
									ref: inputRef,
									type: 'search',
									value: draft,
									placeholder: state.tab === 'github' ? t('search.githubPlaceholder') : t('search.placeholder'),
									'aria-label': t('search.placeholder'),
									onChange: (event) => setDraft(event.target.value),
									onKeyDown: (event) => {
										if (event.key === 'Enter') {
											event.preventDefault();
											submit();
										}
									},
								}),
								h('select', {
									className: 'dpm-select',
									value: state.sort,
									'aria-label': t('sort.label'),
									onChange: (event) => {
										patch({ sort: event.target.value, page: 1 });
										void runSearch(1);
										scrollBodyTop();
									},
								},
									['stars', 'downloads', 'name', 'updated'].map((key) => h('option', { key, value: key }, t(`sort.${key}`))),
								),
								h(Button, { kind: 'default', disabled: state.loading, onClick: submit }, t('search.action')),
							),
						(catalogChips.length > 0 || githubChips.length > 0)
							? h('div', { className: 'dpm-chips' }, ...(catalogChips.length > 0 ? catalogChips : githubChips))
							: null,
						h('div', { className: 'dpm-body', ref: bodyRef }, ...body),
						footBits.length > 0 ? h('footer', { className: 'dpm-foot' }, ...footBits) : null,
						OutcomeBar(t, state, actions),
						ProgressPanel(t, state, actions),
						pending !== null
							? h('div', { className: 'dpm-bar' },
								h('div', { className: 'dpm-bar-row' },
									h('strong', null, t(
										pending.label === 'update' ? 'confirm.titleUpdate'
											: pending.label === 'reinstall' ? 'confirm.titleReinstall'
												: 'confirm.title',
									)),
									h('span', { className: 'dpm-meta' }, t('confirm.spec')),
									h('code', { className: 'dpm-code' }, pending.spec),
									h('span', { className: 'dpm-spacer' }),
									h(Button, { kind: 'default', disabled: state.busy !== null, onClick: () => patch({ pending: null }) }, t('action.cancel')),
									h(Button, {
										kind: 'primary',
										// A harmful verdict locks the button until the reader ticks the
										// gate below. Not disabled silently: the gate is right there to
										// explain why.
										disabled: state.busy !== null || gateLocked,
										title: gateLocked ? t('gate.locked') : undefined,
										onClick: () => void confirmImport(undefined),
									}, state.busy === 'install'
										? t('busy.install')
										: (pending.label === 'install' ? t('action.confirm') : t('action.update'))),
								),
								HarmfulGate(t, pending.entry, state, actions),
								h('div', { className: bundleState === 'no' ? 'dpm-error' : bundleState === 'yes' ? 'dpm-ok' : 'dpm-warn' },
									state.busy === 'inspect'
										? t('busy.inspect')
										: bundleState === 'yes' ? t('confirm.bundle') : bundleState === 'no' ? t('confirm.notBundle') : t('confirm.unknownBundle')),
								pending.inspectError !== null && pending.inspectError !== undefined
									? h('div', { className: 'dpm-warn' }, pending.inspectError)
									: null,
								(pending.entry.capabilities ?? []).length > 0
									? h('div', { className: 'dpm-warn' }, `${t('confirm.capabilities')} ${pending.entry.capabilities.join(', ')}`)
									: null,
								(pending.entry.redLines ?? []).length > 0
									? h('div', { className: 'dpm-error' }, `${t('confirm.redline')} ${pending.entry.redLines.join('；')}`)
									: null,
								pending.entry.scanned !== true
									? h('div', { className: 'dpm-warn' }, t('confirm.unscanned'))
									: null,
								// Without a readable snapshot there is no verdict to gate on,
								// so the confirmation has to say the check did not run.
								// Only claimed once the Host has actually answered: before
								// that we do not know, and a wrong warning is its own kind
								// of dishonesty.
								state.reviewSource.loaded === true && state.reviewSource.available !== true
									? h('div', { className: 'dpm-warn' }, t('confirm.reviewSkipped'))
									: null,
							)
							: null,
						state.selected !== null
							? DetailDrawer(t, state.selected, state, actions)
							: null,
						LanguagePill(t, state),
					),
				),
			);
		}

		/** Client services this plugin needs before it may activate. */
		const inject = ['slots', 'locale'];

		/** Mount the popup and its sidebar opener. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-market: locale dictionary');
			ctx.slots.inject('shell.overlay', () => ctx.slots.register({
				name: 'shell.overlay',
				id: 'plugin-market',
				order: 22,
				locale: NS,
			}, MarketModal));
			ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
				name: 'sidebar.footer.action',
				id: 'plugin-market',
				order: 21,
				locale: NS,
			}, MarketAction));
			// An automatic pass runs on every Harness start, throttled by the
			// saved interval; without the preference nothing is ever installed
			// by itself.
			ctx.effect(() => {
				const timer = window.setTimeout(() => void runAutoUpdate(), 8000);
				return () => window.clearTimeout(timer);
			}, 'plugin-market: automatic update pass');
		}


		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
