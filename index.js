/**
 * Host half of the plugin market window.
 *
 * It contributes an authenticated JSON API on the composed web server under
 * `/api/local-plugin-market/*`, which the browser half calls. The API does
 * five things:
 *
 *   1. builds a searchable, paged catalog of DeepSeek Harness plugins,
 *   2. proxies GitHub repository search,
 *   3. refreshes stars / forks for the page the window is showing,
 *   4. answers one detail request with the author and the version history,
 *   5. drives the profile's own `pluginManager` for inspect / install / remove,
 *      including the install progress stream.
 *
 * Catalog source
 * --------------
 * `https://awesome-dsh-plugin.com/plugins.json` is the generated index of the
 * curated list: 5900+ entries carrying the npm package, the exact version, the
 * current star and download counts, the owner, the category and the scanner's
 * capability list. It is one request and it is *current*, which is why it is
 * preferred over re-deriving the same catalog from five separate repository
 * files — that older path read a star snapshot months out of date, so the
 * window showed numbers that matched nothing on GitHub.
 *
 * The repository files remain as a fallback for the case where the site is
 * unreachable (it is GitHub Pages, and it has been slow before).
 *
 * Honesty rules the browser half relies on:
 *   - a count nobody could read is `null`, never `0`;
 *   - `/stats` refreshes what the window is actually looking at;
 *   - a failed version lookup is reported as a problem, not as "up to date".
 *
 * Nothing is installed without an explicit click in the window: this plugin
 * registers no agent tool, so no model turn can import code. Every install
 * goes through `ctx.pluginManager`, the same service behind `dsh plugin add`.
 */

import { readFileSync, existsSync, writeFileSync, renameSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Stable Cordis plugin name. */
export const name = 'plugin-market'

/** `connection` owns the Fetch-route registry; `pluginManager` owns installs. */
export const inject = ['connection', 'pluginManager']

/** Exact route prefix the browser half calls. */
const ROUTE_PREFIX = '/api/local-plugin-market'

/** The published catalog index, and the repository behind it. */
const MARKET_SITE = 'https://awesome-dsh-plugin.com'

/**
 * This plugin's own version, read from the manifest beside this file.
 *
 * It is read at load time rather than hard-coded: the window prints it so a
 * user can tell which build they are running, and a constant would silently
 * drift from package.json the first time the version was bumped.
 */
const PLUGIN_VERSION = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : ''
  } catch {
    return ''
  }
})()

/**
 * Where the Desktop build records its own version.
 *
 * The launcher writes `runtime.json` into the runtime directory it boots from,
 * and `desktopVersion` in it is the version the user is actually running — the
 * one the updater compares against. These are tried in order because the file
 * location has moved between builds; a miss falls through to the next rather
 * than guessing a version, and the window says "unknown" if all of them miss.
 */
const RUNTIME_VERSION_PATHS = [
  process.env.DSH_RUNTIME_JSON,
  join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json'),
]

/**
 * Read the DeepSeek Harness version this process runs on.
 *
 * Every source is a file the launcher itself writes; nothing is inferred from
 * a path name or a package range, because a wrong version label is worse than
 * an honest "unknown".
 * @returns `{ version, source }`, both empty/`'unknown'` when unreadable.
 */
function readHarnessVersion() {
  for (const candidate of RUNTIME_VERSION_PATHS) {
    if (typeof candidate !== 'string' || candidate === '') continue
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
      const version = typeof parsed?.desktopVersion === 'string' ? parsed.desktopVersion : ''
      if (version !== '') return { version, source: candidate }
    } catch {
      /* try the next location */
    }
  }
  return { version: '', source: '' }
}
const CATALOG_REPO = 'awesome-dsh-plugin/awesome-dsh-plugin'

/** Repository files used only when the published index cannot be read. */
const CATALOG_FILES = {
  capabilities: 'data/capabilities.json',
  stars: 'data/stars.json',
  downloads: 'data/downloads.json',
  readme: 'README.md',
  readmeZh: 'README.zh.md',
}

/** Display languages the catalog carries; each one has its own authored text. */
const LANGUAGES = ['zh', 'en']
const DEFAULT_LANGUAGE = 'zh'

/**
 * CDN mirrors that serve the repository files without spending the GitHub API
 * quota. Tried in order; the first healthy one carries the fallback build.
 */
const CATALOG_MIRRORS = [
  ['jsdelivr', (path) => `https://cdn.jsdelivr.net/gh/${CATALOG_REPO}@main/${path}`],
  ['gh-proxy', (path) => `https://gh-proxy.com/https://raw.githubusercontent.com/${CATALOG_REPO}/main/${path}`],
  ['ghproxy', (path) => `https://ghproxy.net/https://raw.githubusercontent.com/${CATALOG_REPO}/main/${path}`],
  ['jsdelivr-fastly', (path) => `https://fastly.jsdelivr.net/gh/${CATALOG_REPO}@main/${path}`],
]
const MIRROR_PROBE_TIMEOUT_MS = 12000

/** Owners that are the ecosystem's own infrastructure, not installable plugins. */
const SKIP_OWNERS = new Set(['deepseek-ai', 'awesome-dsh-plugin', 'dsh-market'])

const DEFAULT_CATALOG_TIMEOUT_MS = 45000
const DEFAULT_SEARCH_TIMEOUT_MS = 15000
const MIN_TIMEOUT_MS = 2000
const MAX_TIMEOUT_MS = 180000

const DEFAULT_PAGE_SIZE = 24
const MIN_PAGE_SIZE = 12
const MAX_PAGE_SIZE = 96
const GITHUB_PAGE_SIZE = 30
const DESCRIPTION_LIMIT = 320
const CAPABILITY_LIMIT = 8
const RED_LINE_LIMIT = 3
const OUTPUT_LIMIT = 4000

/** Detail answers are expensive; keep them for half an hour. */
const DETAIL_TTL_MS = 30 * 60 * 1000
/** Live star answers are cached this long so paging does not re-hit GitHub. */
const LIVE_STATS_TTL_MS = 10 * 60 * 1000
/** How long a finished install keeps its progress record readable. */
const PROGRESS_TTL_MS = 10 * 60 * 1000
/** Install log lines kept per request, and their individual size cap. */
const PROGRESS_LINE_LIMIT = 500
const PROGRESS_TEXT_LIMIT = 4000
/** Repos per GitHub search query, bounded by the API's 256-character limit. */
const STATS_CHUNK_REPOS = 8
const STATS_QUERY_LIMIT = 240
const STATS_MAX_REPOS = 60
const VERSION_LIMIT = 30

/**
 * The community review site (0.04 link-up).
 *
 * It publishes a plain JSON API next to its pages, so the market reads the
 * same data the site shows instead of scraping HTML. Two things it does NOT
 * publish, and which this plugin must not invent:
 *
 *   - a structured "review depth"; the tier only appears in the report title
 *     (`【深度审计】`, `【安全面快测】`, `标准测评`), so it is parsed from there and
 *     an unrecognised title yields no depth rather than a guessed one;
 *   - a "manually reviewed" flag of any kind. There is no such field, so no
 *     code here may claim one.
 */
const REVIEW_SITE = 'https://review.lingshulab.com'
/**
 * Where the published review snapshot lives.
 *
 * A static file, produced by `tools/reviews-snapshot.mjs` and refreshed by a
 * scheduled workflow. **This plugin reads that file and never the live API.**
 *
 * The reason is the shape of the permission: the review site authorized this
 * project's author, and they have no credential mechanism to hand anyone else.
 * Reading their API on behalf of every installation would turn one person's
 * permission into distributed load on their server. A snapshot flips that
 * around — they serve one file from a CDN, and one scheduled poll a day keeps
 * it current. Everyone still sees the verdicts, which is the whole point of the
 * feature.
 *
 * If the review site starts publishing a snapshot of its own, point the
 * `reviewSnapshotUrl` config at it: freshness would then be theirs to control.
 */
const REVIEW_SNAPSHOT_URL = 'https://raw.githubusercontent.com/zjust7/dsh-plugin-market/main/data/reviews.json'
/**
 * How long a read snapshot is reused.
 *
 * Six hours, and the read is a single conditional GET. The site's own records
 * move on the order of days, so a shorter window bought freshness nobody could
 * see.
 */
const REVIEW_TTL_MS = 6 * 60 * 60 * 1000

/**
 * The five capability verdicts the site's spec defines.
 *
 * `untestable` is the fifth and was missing here: the site publishes reports
 * judged "cannot be tested" (unsupported environment, or a task the plugin does
 * not apply to), and without this value the window asked for a translation that
 * did not exist and rendered the raw key `review.untestable` instead of a label.
 */
const VERDICTS = ['helpful', 'harmful', 'no-difference', 'undetermined', 'untestable']

/**
 * Report tiers, most thorough first.
 *
 * The site's own four-tier vocabulary, plus the empty string for a report whose
 * title carries no tier at all. That is not a guess: 38 of the 67 reports the
 * site currently publishes never state a tier, so "unstated" has to be a real
 * value rather than silently coerced into one of the four. `self` is kept
 * because the site defines it even though no report uses it yet.
 */
const REVIEW_TIERS = ['deep', 'standard', 'quick', 'self']
/** Tiers whose report actually covers the six-threat security sweep. */
const SECURITY_TIERS = new Set(['deep', 'quick'])

/** One README list entry: `- [label](repo url[/tree/...]) - description`. */
const README_ENTRY = /^\s*[-*]\s+\[([^\]]+)\]\(https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)([^)]*)\)\s*(?:[-–—]\s*(.*))?$/

/** One `<entry>` of a GitHub releases/tags Atom feed. */
const ATOM_ENTRY = /<entry>([\s\S]*?)<\/entry>/g
const ATOM_TITLE = /<title>([\s\S]*?)<\/title>/
const ATOM_UPDATED = /<updated>([\s\S]*?)<\/updated>/
const ATOM_LINK = /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/

/**
 * Read the requested display language off one request.
 * @param url - the parsed request URL.
 * @returns `zh` or `en`.
 */
function readLanguage(url) {
  const requested = url.searchParams.get('lang')
  return requested === 'en' ? 'en' : DEFAULT_LANGUAGE
}

/**
 * Read one human-readable message out of an unknown thrown value.
 * @param error - whatever was thrown.
 * @returns a non-empty message.
 */
function messageOf(error) {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  return String(error)
}

/**
 * Clamp one configured timeout.
 * @param value - raw config value.
 * @param fallback - value used when the config is absent or unusable.
 * @returns milliseconds within the accepted range.
 */
function readTimeout(value, fallback) {
  const requested = Number(value)
  if (!Number.isFinite(requested)) return fallback
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.trunc(requested)))
}

/**
 * Merge the row's raw `config` over the documented defaults.
 * @param config - the Loader row's `config` value, if any.
 * @returns the resolved upstream timeouts.
 */
function readOptions(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  return {
    catalogTimeoutMs: readTimeout(raw.catalogTimeoutMs, DEFAULT_CATALOG_TIMEOUT_MS),
    searchTimeoutMs: readTimeout(raw.searchTimeoutMs, DEFAULT_SEARCH_TIMEOUT_MS),
    // Where the review snapshot is read from. Left undefined to use the built-in
    // URL, so a fork or the review site itself can point this at its own file
    // without editing code.
    reviewSnapshotUrl: readSnapshotUrl(raw.reviewSnapshotUrl),
  }
}

/**
 * A snapshot URL from config.
 *
 * https only. This URL decides where review data comes from, and a plain-http
 * source would let anyone on the path rewrite a verdict — including the one
 * verdict that gates an install.
 * @param value - the configured value.
 * @returns an https URL string, or undefined for the default.
 */
function readSnapshotUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

/**
 * Build one JSON response for the browser half.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable envelope.
 * @returns the response handed back to the Fetch bridge.
 */
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}

/**
 * Reduce a GitHub URL to its `owner/repo` identity.
 * @param url - repository URL possibly carrying a `/tree/<branch>/<path>` tail.
 * @returns the identity, or null when the URL is not a repository root.
 */
function repoKeyOf(url) {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/.exec(url)
  return match === null ? null : `${match[1]}/${match[2]}`
}

/**
 * Classify how one profile dependency was declared.
 *
 * The three kinds need different version handling: a `link:`/`file:` folder has
 * no releases at all, a git dependency tracks a commit and has no version to
 * compare, and only a registry package can be checked against its `latest`.
 * @param declared - the raw dependency spec from the profile manifest.
 * @returns `local`, `git`, `registry`, or `unknown`.
 */
function classifySpec(declared) {
  if (typeof declared !== 'string' || declared === '') return 'unknown'
  if (declared.startsWith('link:') || declared.startsWith('file:')) return 'local'
  if (/^(github|git|git\+)/i.test(declared) || /\.git(#|$)/i.test(declared)) return 'git'
  return 'registry'
}

/**
 * Best-effort package name for one install spec, used to line a catalog row up
 * with the bundle this profile actually installed.
 * @param spec - `name@version`, `npm:name@version`, `github:owner/repo`, or else.
 * @returns the candidate package name, or an empty string.
 */
function packageNameOf(spec) {
  if (typeof spec !== 'string' || spec === '') return ''
  if (spec.startsWith('github:') || spec.startsWith('git:')) {
    const parts = spec.slice(spec.indexOf(':') + 1).split('#')[0].split('/')
    return parts.length >= 2 ? parts[1] : parts[0]
  }
  if (/^https?:\/\//i.test(spec)) return ''
  const rest = spec.startsWith('npm:') ? spec.slice('npm:'.length) : spec
  // `@scope/name@1.2.3` must split on the LAST `@`, not the scope marker.
  const at = rest.lastIndexOf('@')
  return at > 0 ? rest.slice(0, at) : rest
}

/**
 * Compare two dotted version strings numerically.
 * @param left - a version such as `1.2.3`.
 * @param right - the version to compare against.
 * @returns 1 when left is newer, -1 when older, 0 when equal.
 */
function compareVersions(left, right) {
  const parse = (value) => String(value).trim().replace(/^[v^~=]+/, '').split(/[.+-]/).slice(0, 3)
    .map((part) => {
      const parsed = Number.parseInt(part, 10)
      return Number.isFinite(parsed) ? parsed : 0
    })
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta !== 0) return delta > 0 ? 1 : -1
  }
  return 0
}

/**
 * Strip the markdown that a curated blurb carries and cap its length.
 * @param text - raw blurb.
 * @returns plain single-line text.
 */
function cleanDescription(text) {
  const value = typeof text === 'string' ? text : ''
  const plain = value
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > DESCRIPTION_LIMIT ? `${plain.slice(0, DESCRIPTION_LIMIT - 1)}…` : plain
}

/**
 * Read one count, keeping "unknown" distinct from "zero".
 *
 * This is the fix for the numbers the window used to show: the old build wrote
 * `0` whenever a count was missing, so a plugin with 2174 stars could render as
 * `★ 0` and look like a lie. A missing count is `null` and the window prints
 * an em dash.
 * @param value - raw upstream value.
 * @returns a non-negative integer, or null when nothing was read.
 */
function readCount(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null
}

/**
 * Pick the requested language out of a `{ en, zh }` pair.
 * @param value - authored text, a plain string, or nothing.
 * @param language - `zh` or `en`.
 * @returns the text in that language, falling back to the other one.
 */
function localized(value, language) {
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return ''
  const wanted = language === 'zh' ? value.zh : value.en
  if (typeof wanted === 'string' && wanted !== '') return wanted
  const other = language === 'zh' ? value.en : value.zh
  return typeof other === 'string' ? other : ''
}

/**
 * Whether an authored pair actually carries the requested language.
 * @param value - the `{ en, zh }` pair.
 * @param language - `zh` or `en`.
 * @returns true only when that language has text.
 */
function authoredIn(value, language) {
  if (value === null || typeof value !== 'object') return false
  const wanted = language === 'zh' ? value.zh : value.en
  return typeof wanted === 'string' && wanted.trim() !== ''
}

/**
 * The author view the window renders.
 * @param login - GitHub login or npm maintainer name.
 * @param name - optional display name (npm maintainer name).
 * @returns the author object; always has a usable avatar URL.
 */
function authorOf(login, name) {
  const handle = typeof login === 'string' ? login.trim() : ''
  if (handle === '') {
    return { login: '', name: typeof name === 'string' ? name : '', avatar: '', url: '' }
  }
  return {
    login: handle,
    name: typeof name === 'string' && name !== '' ? name : undefined,
    avatar: `https://github.com/${encodeURIComponent(handle)}.png?size=80`,
    url: `https://github.com/${encodeURIComponent(handle)}`,
  }
}

/**
 * Fields the browser half receives for one catalog row.
 * @param entry - the catalog row.
 * @param extras - fields to merge over the projection.
 * @param language - which authored language to project.
 * @returns the row the window renders.
 */
function slimEntry(entry, extras, language) {
  return {
    repo: entry.repo,
    owner: entry.owner,
    name: entry.name,
    spec: entry.spec,
    url: entry.url ?? `https://github.com/${entry.repo}`,
    page: entry.page,
    npm: entry.npm,
    tarball: entry.tarball,
    description: entry.descriptionOf === undefined ? '' : entry.descriptionOf(language),
    category: entry.categoryOf === undefined ? '' : entry.categoryOf(language),
    categoryId: entry.categoryId ?? '',
    translated: entry.authoredIn === undefined ? false : entry.authoredIn(language),
    version: entry.version ?? '',
    versionAt: entry.versionAt,
    stars: entry.stars ?? null,
    downloads: entry.downloads ?? null,
    starsAt: entry.starsAt,
    downloadsAt: entry.downloadsAt,
    forks: entry.forks ?? null,
    license: entry.license,
    updatedAt: entry.updatedAt,
    capabilities: entry.capabilities ?? [],
    redLines: entry.redLines ?? [],
    scanned: entry.scanned === true,
    scannedAt: entry.scannedAt,
    added: entry.added,
    screenshots: entry.screenshots ?? [],
    installed: entry.installed === true,
    installedVersion: entry.installedVersion ?? '',
    outdated: entry.outdated === true,
    inCatalog: entry.inCatalog !== false,
    author: entry.author ?? authorOf(entry.owner, undefined),
    // The community review block (0.04). `null` means the plugin has no public
    // report; it is never a stand-in for "could not load".
    review: entry.review ?? null,
    // Filled per row by `withCommunity`, so the drawer can offer the feedback
    // links before its own `/detail` answer arrives.
    community: entry.community ?? null,
    reviewedAt: entry.reviewedAt,
    repoUpdatedAt: entry.repoUpdatedAt,
    manifestVersion: entry.manifestVersion,
    ...extras,
  }
}

/**
 * Fetch one upstream URL as text with a bounded wait.
 * @param url - absolute URL.
 * @param options - token, limit, and accepted media type.
 * @returns the response body.
 * @throws when the upstream refuses or the wait expires.
 */
async function fetchUpstream(url, options) {
  const headers = {
    accept: options.accept ?? 'application/json',
    'user-agent': 'dsh-plugin-market',
  }
  if (/^https:\/\/api\.github\.com\//.test(url)) headers['x-github-api-version'] = '2022-11-28'
  if (typeof options.token === 'string' && options.token !== '') {
    headers.authorization = `Bearer ${options.token}`
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(options.timeoutMs) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.text()
}

/**
 * Fetch one upstream URL as parsed JSON.
 * @param url - absolute URL.
 * @param options - token and limit.
 * @returns the parsed body.
 */
async function fetchJson(url, options) {
  const text = await fetchUpstream(url, { ...options, accept: 'application/json' })
  return JSON.parse(text)
}

/**
 * Resolve one catalog mirror that is actually reachable.
 *
 * Anonymous access to `api.github.com` is 60 requests an hour for the whole
 * machine, so the fallback build reads through a CDN whenever it can. A CDN
 * read costs the GitHub API quota nothing at all.
 * @param timeoutMs - per-attempt limit.
 * @returns the chosen mirror plus the file it already fetched, or null.
 */
async function resolveMirror(timeoutMs) {
  const probePath = CATALOG_FILES.stars
  for (const [mirrorName, make] of CATALOG_MIRRORS) {
    try {
      const text = await fetchUpstream(make(probePath), {
        token: null,
        timeoutMs: Math.min(timeoutMs, MIRROR_PROBE_TIMEOUT_MS),
        accept: '*/*',
      })
      return { name: mirrorName, make, warm: { [probePath]: text } }
    } catch {
      /* try the next mirror */
    }
  }
  return null
}

/**
 * Normalize a GitHub URL to `owner/repo` in lower case.
 *
 * Case matters for matching: the catalog writes `FuRongJun-1999/dsh-memory`
 * while the review site may write `furongjun1999/dsh-memory`, and GitHub treats
 * those as the same repository. Comparing raw strings would silently lose
 * reviews.
 * @param url - any GitHub URL, with or without a `/tree/...` tail.
 * @returns the normalized identity, or null.
 */
function normalizedRepo(url) {
  const key = repoKeyOf(typeof url === 'string' ? url : '')
  return key === null ? null : key.toLowerCase()
}

/**
 * Read the subdirectory out of a GitHub `/tree/<branch>/<path>` URL.
 * @param url - repository URL, possibly carrying a tree tail.
 * @returns the path without leading or trailing slashes; `.` for the root.
 */
function subdirectoryOf(url) {
  const match = /\/tree\/[^/]+\/(.+)$/.exec(typeof url === 'string' ? url : '')
  return match === null ? '.' : match[1].replace(/^\/+|\/+$/g, '')
}

/**
 * Which tier one report belongs to, from its title.
 *
 * The site publishes no structured tier, so this reads the convention the
 * authors actually use. An unrecognised title returns an empty string, which
 * the window renders as "未标注档位": a report whose depth is unknown must not
 * be counted as security work, and must not be guessed into a tier either.
 * @param title - the report title.
 * @returns `deep`, `standard`, `quick`, `self`, or an empty string.
 */
function tierOfTitle(title) {
  const text = typeof title === 'string' ? title : ''
  if (/深度审计/.test(text)) return 'deep'
  // `快测` alone also matches `体验快测`, which is the same tier.
  if (/快测/.test(text)) return 'quick'
  if (/标准测/.test(text)) return 'standard'
  if (/作者自测|自测/.test(text)) return 'self'
  return ''
}

/**
 * Merge every report about one plugin into the summary the window renders.
 *
 * A plugin accumulates reports over time, and an early "harmful" that a later
 * release fixed must not keep labelling the plugin forever. The summary is
 * therefore built from the newest report, while `count` and `harmful` keep the
 * history visible so the window can warn without lying about the current state.
 * @param reviews - that plugin's reports, any order.
 * @returns the summary, or null when there are none.
 */
function summarizeReviews(reviews) {
  if (!Array.isArray(reviews) || reviews.length === 0) return null
  const sorted = [...reviews].sort((left, right) => {
    const a = left.firstPublishedAt ?? ''
    const b = right.firstPublishedAt ?? ''
    return b.localeCompare(a)
  })
  const latest = sorted[0]
  const tier = tierOfTitle(latest.title)
  const harmfulCount = sorted.filter((review) => review.verdict === 'harmful').length
  const securityCount = sorted.filter((review) => SECURITY_TIERS.has(tierOfTitle(review.title))).length
  // The gate before installing needs the newest report that judged the plugin
  // "harmful", which is not always the newest report overall — a plugin can
  // have an old harmful finding and a newer inconclusive one.
  const worstHarmful = sorted.find((review) => review.verdict === 'harmful')
  // Every tier any report ever reached, so a plugin with one deep audit keeps
  // that fact even when a later standard report is the newest one.
  const tiers = [...new Set(sorted.map((review) => tierOfTitle(review.title)).filter((value) => value !== ''))]
  // The strongest tier present, in the site's own order of thoroughness.
  const bestTier = REVIEW_TIERS.find((candidate) => tiers.includes(candidate)) ?? ''
  return {
    count: sorted.length,
    verdict: typeof latest.verdict === 'string' ? latest.verdict : '',
    tier,
    bestTier,
    tiers,
    // Only a deep audit or a security-focused quick test actually sweeps the
    // six threat classes; a standard capability report does not.
    security: securityCount > 0,
    securityCount,
    harmfulCount,
    /** The newest "harmful" report, or null; drives the pre-install gate. */
    worstHarmful: worstHarmful === undefined ? null : {
      reviewId: worstHarmful.reviewId,
      title: worstHarmful.title,
      verdict: worstHarmful.verdict,
      author: worstHarmful.authorNickname ?? '',
      publishedAt: worstHarmful.firstPublishedAt ?? worstHarmful.publishedAt ?? '',
      url: `${REVIEW_SITE}/reviews/${worstHarmful.reviewId}`,
    },
    latest: {
      reviewId: latest.reviewId,
      title: latest.title,
      verdict: latest.verdict,
      tier,
      author: latest.authorNickname ?? '',
      publishedAt: latest.firstPublishedAt ?? latest.publishedAt ?? '',
      updatedAt: latest.publicUpdatedAt ?? '',
      pluginVersion: latest.pluginVersion?.value ?? '',
      dshVersion: latest.dshVersion?.value ?? '',
      evidenceCount: Array.isArray(latest.evidenceRefs) ? latest.evidenceRefs.length : 0,
      url: `${REVIEW_SITE}/reviews/${latest.reviewId}`,
    },
    // The window shows the newest report and folds the rest behind a count.
    reviews: sorted.map((review) => ({
      reviewId: review.reviewId,
      title: review.title,
      verdict: review.verdict,
      tier: tierOfTitle(review.title),
      author: review.authorNickname ?? '',
      publishedAt: review.firstPublishedAt ?? review.publishedAt ?? '',
      url: `${REVIEW_SITE}/reviews/${review.reviewId}`,
    })),
  }
}

/**
 * Group a snapshot's two arrays into the index the rest of this plugin reads.
 *
 * Pure on purpose: no network, no clock, no cache. That is what makes the
 * snapshot approach auditable — the only thing that talks to the review site is
 * `tools/reviews-snapshot.mjs`, and this function can be exercised against a
 * fixed file.
 * @param plugins - the site's plugin rows.
 * @param details - the site's report bodies, which carry the verdict.
 * @returns repository key to the plugins published from it.
 */
function reviewIndexFrom(plugins, details) {
  const byPluginId = new Map()
  for (const detail of Array.isArray(details) ? details : []) {
    if (detail === null || typeof detail !== 'object') continue
    if (typeof detail.pluginId !== 'string') continue
    const list = byPluginId.get(detail.pluginId) ?? []
    list.push(detail)
    byPluginId.set(detail.pluginId, list)
  }
  // Keyed by normalized repo and by subdirectory, so one repository that
  // publishes several plugins still matches the right catalog row.
  const pluginsByRepo = new Map()
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    if (plugin === null || typeof plugin !== 'object') continue
    const repo = normalizedRepo(plugin.repositoryHtmlUrl)
    if (repo === null) continue
    const path = typeof plugin.pluginPath === 'string' && plugin.pluginPath !== ''
      ? plugin.pluginPath.replace(/^\/+|\/+$/g, '')
      : '.'
    const list = pluginsByRepo.get(repo) ?? []
    list.push({ plugin, path, reviews: byPluginId.get(plugin.pluginId) ?? [] })
    pluginsByRepo.set(repo, list)
  }
  return pluginsByRepo
}

/**
 * Read the published review snapshot.
 *
 * One request, to one static file. That is the entire point of the snapshot: the
 * review site pays for one file behind a CDN no matter how many people install
 * this plugin, instead of paying for an API burst per installation.
 *
 * The site has no credential mechanism, so a per-reader token was never an
 * available design; and reading their API on behalf of anonymous installations
 * is exactly the load that one person's permission does not cover. A snapshot
 * refreshed on a schedule costs them one poll a day from one machine.
 * @param url - the snapshot's URL.
 * @param timeoutMs - per-request limit.
 * @returns the index, plus what the window needs to describe the data's age.
 */
function parseReviewSnapshot(body) {
  if (body === null || typeof body !== 'object') throw new Error('the review snapshot is not an object')
  if (body.schema !== 1) throw new Error(`unsupported review snapshot schema: ${String(body.schema)}`)
  const plugins = Array.isArray(body.plugins) ? body.plugins : []
  const details = Array.isArray(body.reviews) ? body.reviews : []
  if (plugins.length === 0) throw new Error('the review snapshot lists no plugins')
  return {
    index: { pluginsByRepo: reviewIndexFrom(plugins, details) },
    // The snapshot carries its own timestamp. "When this was collected" is the
    // fact a reader needs; the moment it was downloaded says nothing about how
    // current the verdicts are.
    dataAt: typeof body.generatedAt === 'string' ? body.generatedAt : '',
    site: typeof body.site === 'string' && body.site !== '' ? body.site : REVIEW_SITE,
    counts: { plugins: plugins.length, reviews: details.length },
  }
}

/**
 * Read the review snapshot from the first source that answers.
 *
 * The snapshot is the right design — the review site authorizes one operator, not
 * every downloader — but a single hard-coded URL is a single point of failure. If
 * that file is missing or unreachable (a moved repository, an outage, a reader on
 * a blocked network) the window silently shows no verdicts at all, which looks
 * exactly like "this plugin has no reviews".
 *
 * So the sources are tried in order and the first good answer wins:
 *   1. a configured `reviewSnapshotUrl`;
 *   2. the published snapshot;
 *   3. the copy shipped inside this package (`data/reviews.json`), which is
 *      pruned by `tools/reviews-snapshot.mjs` on every release.
 * Every source is a static file; none of them touches the review site's API.
 * @param url - the published snapshot URL.
 * @param localPath - the packaged snapshot path, or null.
 * @param timeoutMs - per-request limit.
 * @returns the index, its age, and which source produced it.
 */
async function readReviewSnapshot(url, localPath, timeoutMs) {
  const failures = []
  const sources = []
  if (typeof url === 'string' && url !== '') sources.push({ kind: 'remote', url })
  if (typeof localPath === 'string' && localPath !== '') sources.push({ kind: 'packaged', url: localPath })

  for (const source of sources) {
    try {
      const body = source.kind === 'packaged'
        ? JSON.parse(readFileSync(source.url, 'utf8'))
        : await fetchJson(source.url, { token: null, timeoutMs })
      const parsed = parseReviewSnapshot(body)
      return { ...parsed, source: source.kind }
    } catch (error) {
      failures.push({ source: source.kind, message: messageOf(error) })
    }
  }
  const detail = failures.map((f) => `${f.source}: ${f.message}`).join('; ')
  throw new Error(`no review snapshot could be read${detail === '' ? '' : ` (${detail})`}`)
}

/**
 * Turn the published index (`plugins.json`) into catalog rows.
 *
 * This is the preferred build: one request, current counts, an owner for every
 * entry and a published version for the subset that has an npm package.
 * @param document - the parsed index.
 * @returns rows plus the category facets for both languages.
 */
function catalogFromIndex(document) {
  const categoryNames = document !== null && typeof document.categories === 'object' && document.categories !== null
    ? document.categories
    : {}
  const plugins = Array.isArray(document?.plugins) ? document.plugins : []
  const rows = []
  const counts = { zh: new Map(), en: new Map() }
  const updated = typeof document?.updated === 'string' ? document.updated : undefined

  for (const plugin of plugins) {
    if (plugin === null || typeof plugin !== 'object') continue
    const repo = repoKeyOf(typeof plugin.url === 'string' ? plugin.url : '')
    if (repo === null) continue
    const separator = repo.indexOf('/')
    const owner = repo.slice(0, separator)
    if (SKIP_OWNERS.has(owner)) continue
    const categoryId = typeof plugin.category === 'string' ? plugin.category : ''
    const names = categoryId === '' ? null : categoryNames[categoryId]
    const descriptionPair = plugin.description
    const categoryOf = (language) => {
      if (names === null) return ''
      const text = language === 'zh' ? names.zh : names.en
      return typeof text === 'string' ? text : ''
    }
    const npm = typeof plugin.npm === 'string' && plugin.npm !== '' ? plugin.npm : undefined
    const tarball = typeof plugin.tarball === 'string' && plugin.tarball !== '' ? plugin.tarball : undefined
    // The install spec is chosen once, here: an npm package installs fastest
    // and has versions to pin; a repository installs from git; a published
    // tarball needs neither a registry nor git.
    const spec = npm ?? tarball ?? `github:${repo}`
    const row = {
      repo,
      owner,
      name: typeof plugin.name === 'string' && plugin.name !== '' ? plugin.name : repo.slice(separator + 1),
      url: `https://github.com/${repo}`,
      page: typeof plugin.page === 'string' ? plugin.page : undefined,
      npm,
      tarball,
      spec,
      categoryId,
      categoryOf,
      descriptionOf: (language) => cleanDescription(localized(descriptionPair, language)),
      authoredIn: (language) => authoredIn(descriptionPair, language),
      version: typeof plugin.version === 'string' ? plugin.version : '',
      stars: readCount(plugin.stars),
      downloads: readCount(plugin.downloads),
      starsAt: updated,
      downloadsAt: typeof plugin.downloadsCheckedAt === 'string'
        ? plugin.downloadsCheckedAt
        : (typeof plugin.downloadsEnd === 'string' ? plugin.downloadsEnd : undefined),
      capabilities: Array.isArray(plugin.capabilities)
        ? plugin.capabilities.filter((item) => typeof item === 'string').slice(0, CAPABILITY_LIMIT)
        : [],
      redLines: Array.isArray(plugin.capabilityRedLines)
        ? plugin.capabilityRedLines.filter((item) => typeof item === 'string').slice(0, RED_LINE_LIMIT)
        : [],
      // The scanner stamps `capabilityCheckedAt`; an entry it never reached has
      // no capabilities array at all, and must not claim to be scanned.
      scanned: typeof plugin.capabilityCheckedAt === 'string',
      scannedAt: typeof plugin.capabilityCheckedAt === 'string' ? plugin.capabilityCheckedAt : undefined,
      added: typeof plugin.added === 'string' ? plugin.added : undefined,
      screenshots: Array.isArray(plugin.screenshots)
        ? plugin.screenshots.filter((item) => typeof item === 'string').slice(0, 8)
        : [],
      author: authorOf(owner, undefined),
      inCatalog: true,
    }
    row.haystack = [
      row.repo,
      row.descriptionOf('zh'),
      row.descriptionOf('en'),
      categoryOf('zh'),
      categoryOf('en'),
      row.capabilities.join(' '),
    ].join(' ').toLowerCase()
    rows.push(row)
    for (const language of LANGUAGES) {
      const label = categoryOf(language)
      if (label !== '') counts[language].set(label, (counts[language].get(label) ?? 0) + 1)
    }
  }

  const facetsOf = (map) => [...map.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category))

  return { rows, categories: facetsOf(counts.en), categoriesZh: facetsOf(counts.zh) }
}

/**
 * Build the catalog from the curated repository's separate data files.
 *
 * This is the fallback path, kept for the case where the published index is
 * unreachable. Its star snapshot is whatever the repository last committed, so
 * `/stats` matters more here.
 * @param token - optional GitHub token; null reads anonymously.
 * @param timeoutMs - per-file limit.
 * @returns catalog rows, category facets, and one status line per file.
 */
async function catalogFromRepository(token, timeoutMs) {
  const sources = []
  const mirror = token === null ? await resolveMirror(timeoutMs) : null

  const load = async (key) => {
    const path = CATALOG_FILES[key]
    const attempts = []
    if (mirror !== null) {
      const warm = mirror.warm[path]
      attempts.push(async () => warm ?? fetchUpstream(mirror.make(path), { token: null, timeoutMs, accept: '*/*' }))
    }
    attempts.push(async () => fetchUpstream(
      `https://api.github.com/repos/${CATALOG_REPO}/contents/${path}`,
      { token, timeoutMs, accept: 'application/vnd.github.raw' },
    ))
    if (mirror === null) {
      for (const [, make] of CATALOG_MIRRORS) {
        attempts.push(async () => fetchUpstream(make(path), { token: null, timeoutMs, accept: '*/*' }))
      }
    }
    let lastError = null
    for (const attempt of attempts) {
      const started = Date.now()
      try {
        const text = await attempt()
        sources.push({ name: key, ok: true, bytes: text.length, ms: Date.now() - started })
        return text
      } catch (error) {
        lastError = error
      }
    }
    sources.push({ name: key, ok: false, detail: messageOf(lastError) })
    return null
  }

  const [capabilitiesText, starsText, downloadsText, readmeText, readmeZhText] = await Promise.all([
    load('capabilities'),
    load('stars'),
    load('downloads'),
    load('readme'),
    load('readmeZh'),
  ])
  if (capabilitiesText === null && readmeText === null && readmeZhText === null) {
    throw new Error('the curated catalog could not be read from any transport')
  }

  const entries = new Map()

  /**
   * Merge defined fields into one catalog record, creating it on first sight.
   * @param repo - `owner/repo` identity.
   * @param patch - fields to write; `undefined` values are ignored.
   */
  const upsert = (repo, patch) => {
    const separator = repo.indexOf('/')
    const current = entries.get(repo) ?? {
      repo,
      owner: repo.slice(0, separator),
      name: repo.slice(separator + 1),
    }
    const next = { ...current }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) next[key] = value
    }
    entries.set(repo, next)
  }

  if (capabilitiesText !== null) {
    const parsed = JSON.parse(capabilitiesText)
    if (parsed !== null && typeof parsed === 'object') {
      for (const [url, record] of Object.entries(parsed)) {
        const repo = repoKeyOf(url)
        if (repo === null || record === null || typeof record !== 'object') continue
        upsert(repo, {
          spec: typeof record.spec === 'string' ? record.spec : undefined,
          version: typeof record.version === 'string' ? record.version : undefined,
          capabilities: Array.isArray(record.capabilities)
            ? record.capabilities.filter((item) => typeof item === 'string').slice(0, CAPABILITY_LIMIT)
            : [],
          redLines: Array.isArray(record.redLines)
            ? record.redLines.filter((item) => typeof item === 'string').slice(0, RED_LINE_LIMIT)
            : [],
          scannedAt: typeof record.scannedAt === 'string' ? record.scannedAt : undefined,
          scanned: true,
        })
      }
    }
  }

  /**
   * Fold one curated README into the rows, writing the fields of its language.
   * @param text - README body, or null when that language is unavailable.
   * @param language - `zh` or `en`.
   */
  const mergeReadme = (text, language) => {
    if (text === null) return
    const suffix = language === 'en' ? 'En' : 'Zh'
    let category = ''
    for (const line of text.split('\n')) {
      const heading = /^###\s+(.+?)\s*$/.exec(line)
      if (heading !== null) {
        category = heading[1]
        continue
      }
      const link = README_ENTRY.exec(line)
      if (link === null || SKIP_OWNERS.has(link[2])) continue
      upsert(`${link[2]}/${link[3]}`, {
        [`category${suffix}`]: category,
        [`description${suffix}`]: cleanDescription(link[5]),
      })
    }
  }
  mergeReadme(readmeText, 'en')
  mergeReadme(readmeZhText, 'zh')

  const mergeCounts = (text, field) => {
    if (text === null) return
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return
    for (const [url, record] of Object.entries(parsed)) {
      const repo = repoKeyOf(url)
      if (repo === null || record === null || typeof record !== 'object') continue
      const count = readCount(record[field])
      if (count !== null) upsert(repo, { [field]: count, [`${field}At`]: record.checkedAt })
    }
  }
  mergeCounts(starsText, 'stars')
  mergeCounts(downloadsText, 'downloads')

  const rows = []
  const counts = { zh: new Map(), en: new Map() }
  for (const entry of entries.values()) {
    const categoryOf = (language) => (language === 'zh'
      ? (entry.categoryZh ?? entry.category ?? '')
      : (entry.category ?? entry.categoryZh ?? ''))
    const descriptionOf = (language) => (language === 'zh'
      ? (entry.descriptionZh ?? entry.description ?? '')
      : (entry.description ?? entry.descriptionZh ?? ''))
    const authored = (language) => (language === 'zh'
      ? typeof entry.descriptionZh === 'string' && entry.descriptionZh !== ''
      : typeof entry.description === 'string' && entry.description !== '')
    const row = {
      ...entry,
      url: `https://github.com/${entry.repo}`,
      categoryId: '',
      categoryOf,
      descriptionOf,
      authoredIn: authored,
      spec: typeof entry.spec === 'string' && entry.spec !== '' ? entry.spec : `github:${entry.repo}`,
      stars: entry.stars ?? null,
      downloads: entry.downloads ?? null,
      capabilities: entry.capabilities ?? [],
      redLines: entry.redLines ?? [],
      author: authorOf(entry.owner, undefined),
      screenshots: [],
      inCatalog: true,
    }
    row.haystack = [
      row.repo,
      descriptionOf('zh'),
      descriptionOf('en'),
      categoryOf('zh'),
      categoryOf('en'),
      row.capabilities.join(' '),
    ].join(' ').toLowerCase()
    rows.push(row)
    for (const language of LANGUAGES) {
      const label = categoryOf(language)
      if (label !== '') counts[language].set(label, (counts[language].get(label) ?? 0) + 1)
    }
  }

  const facetsOf = (map) => [...map.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category))

  return { rows, categories: facetsOf(counts.en), categoriesZh: facetsOf(counts.zh), sources }
}

/**
 * Build the whole catalog: the published index first, the repository fallback
 * second.
 * @param token - optional GitHub token; null reads anonymously.
 * @param timeoutMs - per-file limit.
 * @returns rows, category facets, transport, sources, and the data timestamps.
 */
async function buildCatalog(token, timeoutMs) {
  const sources = []
  const transport = token !== null
    ? { kind: 'api', authenticated: true, name: 'api.github.com' }
    : { kind: 'site', authenticated: false, name: 'awesome-dsh-plugin.com' }

  const started = Date.now()
  try {
    const text = await fetchUpstream(`${MARKET_SITE}/plugins.json`, { token: null, timeoutMs, accept: 'application/json' })
    const document = JSON.parse(text)
    if (!Array.isArray(document?.plugins) || document.plugins.length === 0) {
      throw new Error('the index carried no plugins')
    }
    sources.push({ name: 'plugins', ok: true, bytes: text.length, ms: Date.now() - started })
    const built = catalogFromIndex(document)
    return {
      ...built,
      sources,
      transport,
      statsAt: typeof document.updated === 'string' ? document.updated : undefined,
      downloadsAt: typeof document.updated === 'string' ? document.updated : undefined,
      versionCount: built.rows.filter((row) => row.version !== '').length,
    }
  } catch (error) {
    sources.push({ name: 'plugins', ok: false, detail: messageOf(error) })
  }

  const fallback = await catalogFromRepository(token, timeoutMs)
  return {
    ...fallback,
    sources: [...sources, ...fallback.sources],
    transport: token !== null
      ? transport
      : { kind: 'mirror', authenticated: false, name: 'repository files' },
    statsAt: undefined,
    downloadsAt: undefined,
    versionCount: fallback.rows.filter((row) => row.version !== '').length,
  }
}

/**
 * Filter, sort, and page the catalog entirely on the Host.
 * @param rows - the built catalog.
 * @param query - space-separated terms, all of which must appear.
 * @param category - exact category display name, or empty.
 * @param sort - `stars`, `downloads`, `name`, or `updated`.
 * @param page - 1-based page number.
 * @param pageSize - rows per page.
 * @param language - which language the category filter names.
 * @param reviewed - when true, keep only rows with a public review report.
 * @returns the page envelope.
 */
function findInCatalog(rows, query, category, sort, page, pageSize, language, reviewed, favorites) {
  let list = rows
  if (category !== '') {
    list = list.filter((entry) => entry.categoryOf(language) === category)
  }
  // The review filter is a membership test, not a category: it answers "has an
  // independent reviewer looked at this?", which the curated categories cannot.
  if (reviewed === true) {
    list = list.filter((entry) => entry.review !== null && entry.review !== undefined)
  }
  // Bookmarks are the window's own state, but the catalog lives here, so this is
  // the only side that can filter all 6000 rows. Combined with the review filter
  // on purpose: "bookmarked and independently reviewed" is a real question.
  if (Array.isArray(favorites) && favorites.length > 0) {
    const wanted = new Set(favorites)
    list = list.filter((entry) => wanted.has(entry.repo))
  }
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== '')
  if (terms.length > 0) {
    list = list.filter((entry) => terms.every((term) => entry.haystack.includes(term)))
  }
  const compareName = (left, right) => left.repo.localeCompare(right.repo)
  // A null count sorts last: "unknown" must never masquerade as the worst score.
  const descending = (field) => (left, right) => {
    const a = left[field] ?? -1
    const b = right[field] ?? -1
    return b - a || compareName(left, right)
  }
  if (sort === 'name') list = [...list].sort(compareName)
  else if (sort === 'downloads') list = [...list].sort(descending('downloads'))
  else if (sort === 'updated') {
    list = [...list].sort((left, right) => String(right.updatedAt ?? right.added ?? '')
      .localeCompare(String(left.updatedAt ?? left.added ?? '')) || compareName(left, right))
  } else list = [...list].sort(descending('stars'))
  const total = list.length
  const start = (page - 1) * pageSize
  return {
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    entries: list.slice(start, start + pageSize),
  }
}

/**
 * Normalize one GitHub search item into a catalog-shaped row.
 * @param item - raw `search/repositories` item.
 * @param language - requested display language (GitHub has one description).
 * @returns the row the browser half renders.
 */
function gitHubItemToEntry(item) {
  const fullName = typeof item.full_name === 'string' ? item.full_name : ''
  const separator = fullName.indexOf('/')
  const owner = separator < 0 ? fullName : fullName.slice(0, separator)
  const login = typeof item.owner?.login === 'string' ? item.owner.login : owner
  const description = typeof item.description === 'string' ? item.description : ''
  return {
    repo: fullName,
    owner,
    name: separator < 0 ? fullName : fullName.slice(separator + 1),
    spec: `github:${fullName}`,
    url: typeof item.html_url === 'string' ? item.html_url : `https://github.com/${fullName}`,
    description: cleanDescription(description),
    category: '',
    categoryId: '',
    translated: false,
    version: '',
    stars: readCount(item.stargazers_count),
    downloads: null,
    forks: readCount(item.forks_count),
    starsAt: typeof item.pushed_at === 'string' ? item.pushed_at : undefined,
    license: typeof item.license?.spdx_id === 'string' ? item.license.spdx_id : undefined,
    updatedAt: typeof item.pushed_at === 'string' ? item.pushed_at : undefined,
    capabilities: [],
    redLines: [],
    scanned: false,
    inCatalog: false,
    language: typeof item.language === 'string' ? item.language : '',
    archived: item.archived === true,
    screenshots: [],
    installed: false,
    installedVersion: '',
    outdated: false,
    author: authorOf(login, undefined),
  }
}

/**
 * Parse the entries out of one GitHub releases/tags Atom feed.
 * @param text - feed body.
 * @returns `{ version, at, url }` rows, newest first as the feed orders them.
 */
function versionsFromAtom(text) {
  const rows = []
  const body = typeof text === 'string' ? text : ''
  let match
  ATOM_ENTRY.lastIndex = 0
  while ((match = ATOM_ENTRY.exec(body)) !== null) {
    const block = match[1]
    const title = ATOM_TITLE.exec(block)
    const updated = ATOM_UPDATED.exec(block)
    const link = ATOM_LINK.exec(block)
    if (title === null) continue
    const version = title[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim()
    if (version === '') continue
    rows.push({
      version,
      at: updated === null ? undefined : updated[1].trim(),
      source: 'release',
      url: link === null ? undefined : link[1],
    })
  }
  return rows
}

/**
 * Parse the npm registry document into a version history.
 * @param document - the parsed `registry.npmjs.org/<name>` body.
 * @returns `{ version, at, url, prerelease }` rows, newest first.
 */
function versionsFromNpm(document, packageName) {
  const versions = document !== null && typeof document === 'object' && typeof document.versions === 'object'
    ? document.versions
    : {}
  const times = document !== null && typeof document === 'object' && typeof document.time === 'object'
    ? document.time
    : {}
  const rows = []
  for (const version of Object.keys(versions)) {
    if (version === 'created' || version === 'modified') continue
    const at = typeof times[version] === 'string' ? times[version] : undefined
    rows.push({
      version,
      at,
      source: 'npm',
      url: packageName === undefined
        ? undefined
        : `https://www.npmjs.com/package/${packageName}/v/${version}`,
      prerelease: /-/.test(version),
    })
  }
  rows.sort((left, right) => {
    const a = left.at ?? ''
    const b = right.at ?? ''
    if (a !== b) return b.localeCompare(a)
    return compareVersions(right.version, left.version)
  })
  return rows
}

/**
 * Serve the plugin market's endpoints.
 * @param ctx - Host plugin context.
 * @param config - the Loader row's `config`, if any.
 */
export function apply(ctx, config) {
  const options = readOptions(config)

  /**
   * The profile directory this process runs from.
   *
   * The launcher usually exports `DSH_PROFILE_DIR`, but a desktop shortcut
   * starts with a bare environment, so fall back to asking the settings service
   * for the profile patch path. Without this the window cannot tell a `link:`
   * from a `github:` dependency, and every version state degrades.
   */
  let profileDir = typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== ''
    ? process.env.DSH_PROFILE_DIR
    : null

  /** Resolve the profile directory once, from whatever source is available. */
  const resolveProfileDir = async () => {
    if (profileDir !== null) return profileDir
    const settings = ctx.get('settings')
    if (settings !== undefined && typeof settings.prepareDocument === 'function') {
      try {
        const patchPath = await settings.prepareDocument()
        if (typeof patchPath === 'string' && patchPath !== '') profileDir = dirname(patchPath)
      } catch {
        /* unresolved: the window reports that it cannot read the manifest */
      }
    }
    return profileDir
  }

  /**
   * Snapshot of the profile manifest taken before a mutating install.
   *
   * An update removes the manifest entry and then re-adds it, so a failure in
   * between leaves a profile that lists a plugin the tree no longer satisfies —
   * and the only way out of that state was to repair the file by hand. The file
   * is small (a few KiB) and changes rarely, so it is captured verbatim and put
   * back if the add did not apply.
   *
   * `package.json` is captured because it records BOTH `dependencies` and
   * `dsh.profile.bundles`, which the Host writes together. The lockfile is not
   * captured: rewriting it by hand is far riskier than letting the package
   * manager regenerate it, and a lockfile without its manifest entry is
   * harmless — the next install rewrites both.
   */
  const captureManifest = async () => {
    const dir = await resolveProfileDir()
    if (dir === null) return null
    const file = join(dir, 'package.json')
    try {
      const before = readFileSync(file, 'utf8')
      return { dir, file, before }
    } catch {
      // No readable manifest means there is nothing to protect.
      return null
    }
  }

  /**
   * Put a captured manifest back, and say whether it worked.
   *
   * Written through a temporary file and renamed into place, so a crash halfway
   * through the write cannot leave a truncated manifest — the exact failure the
   * snapshot exists to prevent.
   * @param snapshot - the result of `captureManifest`.
   * @returns the outcome, never throws.
   */
  const restoreManifest = (snapshot) => {
    if (snapshot === null) return { ok: false, reason: 'no-snapshot' }
    try {
      const temp = `${snapshot.file}.market-restore`
      writeFileSync(temp, snapshot.before, 'utf8')
      renameSync(temp, snapshot.file)
      return { ok: true, reason: '' }
    } catch (error) {
      return { ok: false, reason: messageOf(error) }
    }
  }

  /** Built catalog, reused until a refresh is asked for. */
  let catalog = null
  let catalogAt = 0
  let building = null

  /** Bundle names currently installed in this profile, refreshed on demand. */
  let installedNames = new Set()
  /** Installed bundle name to the version this profile carries. */
  let installedVersions = new Map()
  /** Whether the installed snapshot has been read at least once. */
  let installedLoaded = false
  /** Specs this window installed, mapped to the bundle they produced. */
  const specBundles = new Map()

  /** Live repository stats, keyed by `owner/repo`. */
  const liveStats = new Map()
  /** Cached `/detail` answers, keyed by `owner/repo`. */
  const detailCache = new Map()
  /** Install progress records, keyed by request id. */
  const installs = new Map()

  /**
   * The community review index, and when it was last read successfully.
   *
   * A failed refresh keeps the previous copy: showing "not reviewed" because
   * the review site was briefly down would be a lie about the plugin.
   */
  let reviewIndex = null
  let reviewAt = 0
  let reviewBuilding = null
  /** Whether a refresh has ever succeeded, so the window can tell "none" from "unknown". */
  let reviewLoaded = false
  /** The snapshot's own collection time, and what it contained. */
  let reviewDataAt = ''
  let reviewCounts = { plugins: 0, reviews: 0 }
  /** The site the snapshot was collected from, for the attribution line. */
  let reviewSite = REVIEW_SITE
  /** Why the last read failed, in the Host's words. Empty after a good read. */
  let reviewProblem = ''

  /** The snapshot URL this profile should read. */
  const reviewSnapshotUrl = () => {
    const configured = typeof options.reviewSnapshotUrl === 'string' ? options.reviewSnapshotUrl.trim() : ''
    return configured !== '' ? configured : REVIEW_SNAPSHOT_URL
  }

  /**
   * The snapshot shipped inside this package.
   *
   * Read directly off disk, so it works with no network at all. It is the last
   * link in the chain: the published file wins when it is reachable, and this
   * copy keeps the verdicts on screen when it is not.
   * @returns the absolute path, or null when the package has no data directory.
   */
  const packagedSnapshotPath = () => {
    try {
      const here = dirname(fileURLToPath(import.meta.url))
      const candidate = join(here, 'data', 'reviews.json')
      return existsSync(candidate) ? candidate : null
    } catch {
      return null
    }
  }

  /** Drop the cached snapshot so the next read goes out to the file again. */
  const invalidateReviews = () => {
    reviewIndex = null
    reviewAt = 0
    reviewLoaded = false
    reviewProblem = ''
    detailCache.clear()
  }

  /**
   * The credential service, when this profile provides one.
   * @returns the service, or undefined.
   */
  const credentialsOf = () => ctx.get('credentials')

  /**
   * Read the optional GitHub token.
   * @returns the token, or null when none is configured.
   */
  const readToken = async () => {
    const credentials = credentialsOf()
    if (credentials === undefined) return null
    try {
      const resolved = await credentials.resolve('GITHUB_TOKEN')
      return resolved !== undefined && typeof resolved.value === 'string' && resolved.value !== ''
        ? resolved.value
        : null
    } catch {
      return null
    }
  }

  /** Drop the cached catalog so the next read uses the new transport. */
  const invalidateCatalog = () => {
    catalog = null
    catalogAt = 0
    liveStats.clear()
    detailCache.clear()
  }

  /**
   * Describe the GitHub identity this window currently uses.
   * @returns the account view the market header renders.
   */
  const describeAccount = async () => {
    const credentials = credentialsOf()
    if (credentials === undefined) {
      return {
        ok: true,
        supported: false,
        configured: false,
        writable: false,
        source: '',
        login: '',
        avatar: '',
        valid: false,
        rate: null,
        transport: catalogNavigation(),
      }
    }
    let info = { configured: false, writable: false, source: '' }
    try {
      info = await credentials.describe('GITHUB_TOKEN')
    } catch {
      /* an unreadable store is reported as not configured */
    }
    const view = {
      ok: true,
      supported: true,
      configured: info.configured === true,
      writable: info.writable === true,
      source: info.source ?? '',
      login: '',
      avatar: '',
      valid: false,
      rate: null,
      transport: catalogNavigation(),
    }
    if (view.configured !== true) return view
    // One authenticated call tells us the login name and the live allowance.
    const token = await readToken()
    if (token === null) return view
    try {
      const response = await fetch('https://api.github.com/user', {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'dsh-plugin-market',
          'x-github-api-version': '2022-11-28',
          authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(options.searchTimeoutMs),
      })
      const limit = Number(response.headers.get('x-ratelimit-limit'))
      const remaining = Number(response.headers.get('x-ratelimit-remaining'))
      const reset = Number(response.headers.get('x-ratelimit-reset'))
      view.rate = {
        limit: Number.isFinite(limit) ? limit : null,
        remaining: Number.isFinite(remaining) ? remaining : null,
        reset: Number.isFinite(reset) ? reset : null,
      }
      if (response.status === 401) {
        view.valid = false
        return view
      }
      view.valid = response.ok
      if (response.ok) {
        const body = await response.json()
        view.login = typeof body.login === 'string' ? body.login : ''
        view.avatar = typeof body.avatar_url === 'string' ? body.avatar_url : ''
      }
    } catch {
      view.valid = false
    }
    return view
  }

  /**
   * How the next catalog build would travel.
   * @returns the transport descriptor shown in the account panel.
   */
  const catalogNavigation = () => (catalog === null || catalog.transport === undefined
    ? { kind: 'unknown', authenticated: false, name: '' }
    : catalog.transport)

  /**
   * Build the catalog once, sharing concurrent builds.
   * @param refresh - when true, ignore the cached copy.
   * @returns the catalog.
   */
  const ensureCatalog = async (refresh) => {
    if (refresh !== true && catalog !== null) return catalog
    if (building !== null) return building
    building = (async () => {
      const token = await readToken()
      const built = await buildCatalog(token, options.catalogTimeoutMs)
      built.token = token !== null
      catalog = built
      catalogAt = Date.now()
      return built
    })()
    try {
      return await building
    } finally {
      building = null
    }
  }

  /**
   * Read how each profile dependency was declared, so a `link:` source folder
   * can be told apart from a registry package that has versions to compare.
   * @param dir - the resolved profile directory, or null.
   * @returns dependency name to raw spec, empty when unreadable.
   */
  const profileDependencies = (dir) => {
    if (dir === null) return {}
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      const dependencies = manifest?.dependencies
      return dependencies !== null && typeof dependencies === 'object' ? dependencies : {}
    } catch {
      return {}
    }
  }

  /**
   * Read the live activation phase of every Loader entry.
   * A bundle can be installed and switched on while none of its rows actually
   * runs — a failed activation, a row that never mounted, or a package that was
   * installed without ever being selected as a bundle.
   * @returns entry id to fiber phase, or an empty map when unreadable.
   */
  const readPhases = async () => {
    try {
      const plugins = await ctx.pluginManager.listPlugins()
      const phases = new Map()
      for (const plugin of Array.isArray(plugins) ? plugins : []) {
        if (typeof plugin.entryId === 'string') phases.set(plugin.entryId, plugin.fiberPhase ?? null)
      }
      return phases
    } catch {
      return new Map()
    }
  }

  /**
   * The author of one installed package, from the catalog when it knows the
   * repository behind the package.
   * @param name - package name.
   * @returns the author object, or undefined when nothing is known.
   */
  const authorForPackage = (name) => {
    if (catalog === null) return undefined
    const row = catalog.rows.find((entry) => entry.npm === name || entry.name === name)
    return row === undefined ? undefined : row.author
  }

  /**
   * Refresh the installed-bundle name set from the profile.
   * @returns the bundle rows the window lists.
   */
  const refreshInstalled = async () => {
    const dir = await resolveProfileDir()
    const [bundles, phases] = await Promise.all([
      ctx.pluginManager.listBundles(),
      readPhases(),
    ])
    const dependencies = profileDependencies(dir)
    const rows = []
    const names = new Set()
    const versions = new Map()
    for (const bundle of bundles) {
      if (bundle.installed === false) continue
      names.add(bundle.name)
      if (typeof bundle.version === 'string' && bundle.version !== '') versions.set(bundle.name, bundle.version)
      const declared = dependencies[bundle.name]
      const entries = Array.isArray(bundle.rows) ? bundle.rows : []
      let liveRows = 0
      let failedRows = 0
      for (const row of entries) {
        if (row === null || typeof row !== 'object' || typeof row.entryId !== 'string') continue
        const phase = phases.get(row.entryId)
        if (phase === 'active') liveRows += 1
        else if (phase === 'failed') failedRows += 1
      }
      const errorCode = bundle.error === undefined ? null : (bundle.error.code ?? 'error')
      // Running means at least one row of this bundle is genuinely active.
      const running = bundle.enabled === true && liveRows > 0
      let reason = null
      if (bundle.enabled !== true) reason = 'disabled'
      else if (entries.length === 0) reason = 'no-rows'
      else if (liveRows === 0) reason = errorCode !== null || failedRows > 0 ? 'failed' : 'not-running'
      const partial = running && (failedRows > 0 || errorCode !== null)
      rows.push({
        name: bundle.name,
        version: bundle.version ?? '',
        description: bundle.description ?? '',
        enabled: bundle.enabled === true,
        removable: bundle.removable === true,
        rows: entries.length,
        error: errorCode,
        // `link:`/`file:` dependencies are hand-made source, not a registry
        // package, so they have no released version to update to.
        kind: classifySpec(declared),
        spec: typeof declared === 'string' ? declared : '',
        dir: dir === null ? '' : join(dir, 'node_modules', bundle.name),
        running,
        reason,
        partial,
        liveRows,
        failedRows,
        author: authorForPackage(bundle.name),
      })
    }
    // A dependency that is installed but was never selected as a bundle does
    // not appear in `listBundles` at all — the classic "I installed it and
    // nothing showed up" case.
    for (const [name, declared] of Object.entries(dependencies)) {
      if (names.has(name)) continue
      names.add(name)
      rows.push({
        name,
        version: '',
        description: '',
        enabled: false,
        removable: false,
        rows: 0,
        error: null,
        kind: classifySpec(declared),
        spec: typeof declared === 'string' ? declared : '',
        dir: dir === null ? '' : join(dir, 'node_modules', name),
        running: false,
        reason: 'not-selected',
        partial: false,
        liveRows: 0,
        failedRows: 0,
        author: authorForPackage(name),
      })
    }
    installedNames = names
    installedVersions = versions
    installedLoaded = true
    return rows
  }

  /**
   * Make sure the installed snapshot exists before a catalog page is marked up.
   * Without it the first popup would render every row as uninstalled, because
   * nothing else on the opening path reads the profile.
   */
  const ensureInstalled = async () => {
    if (installedLoaded) return
    await refreshInstalled().catch(() => undefined)
  }

  /**
   * Mark one row as installed and attach the version comparison the catalog
   * list shows beside it.
   * @param entry - catalog-shaped row about to be sent.
   * @returns the row with its installed state, installed version, and staleness.
   */
  const withInstalledFlag = (entry) => {
    const mapped = specBundles.get(entry.spec)
    const candidates = [mapped, entry.npm, packageNameOf(entry.spec), entry.name]
    let installedVersion = ''
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate === '') continue
      const version = installedVersions.get(candidate)
      if (version !== undefined) {
        installedVersion = version
        break
      }
    }
    const installed = installedVersion !== '' || mapped !== undefined || installedNames.has(entry.name)
    const outdated = installedVersion !== '' && typeof entry.version === 'string' && entry.version !== ''
      ? compareVersions(entry.version, installedVersion) > 0
      : false
    return { ...entry, installed, installedVersion, outdated }
  }

  /**
   * Overlay the live repository stats onto one catalog row.
   *
   * The published index is regenerated daily, so its star counts are already
   * far better than the months-old snapshot the old build used — but "daily"
   * still means yesterday. `/stats` refreshes the page the window is showing,
   * and this overlay keeps later pages consistent with what was learned.
   * @param entry - catalog row.
   * @returns the row with fresher counts where one was read.
   */
  const withLiveStats = (entry) => {
    const live = liveStats.get(entry.repo)
    if (live === undefined) return entry
    return {
      ...entry,
      stars: live.stars ?? entry.stars,
      forks: live.forks ?? entry.forks,
      updatedAt: live.pushedAt ?? entry.updatedAt,
      license: live.license ?? entry.license,
      starsAt: live.at,
    }
  }

  /**
   * Read the review snapshot, reading it once and sharing concurrent reads.
   * @param refresh - when true, ignore the cached copy.
   * @returns the index, or null when no snapshot has ever been readable.
   */
  const ensureReviews = async (refresh) => {
    const fresh = refresh !== true && reviewIndex !== null && Date.now() - reviewAt < REVIEW_TTL_MS
    if (fresh) return reviewIndex
    if (reviewBuilding !== null) return reviewBuilding
    reviewBuilding = (async () => {
      try {
        const read = await readReviewSnapshot(reviewSnapshotUrl(), packagedSnapshotPath(), options.searchTimeoutMs)
        reviewIndex = read.index
        reviewAt = Date.now()
        reviewLoaded = true
        reviewDataAt = read.dataAt
        reviewCounts = read.counts
        reviewSite = read.site
        reviewProblem = ''
        // A newer index invalidates the detail answers that embedded it.
        detailCache.clear()
        return read.index
      } catch (error) {
        // Keep whatever was readable before. A failed refresh is not evidence
        // that a plugin lost its reviews, but the window still gets to know why
        // it failed, so a permanently missing snapshot is diagnosable.
        reviewProblem = messageOf(error)
        return reviewIndex
      } finally {
        reviewBuilding = null
      }
    })()
    return reviewBuilding
  }

  /**
   * The review summary for one catalog row.
   *
   * A repository can hold several packages, so the row's own subdirectory wins
   * over the repository root; only when no subdirectory matches does the root
   * entry apply. When the index has never loaded this returns null, and the
   * window shows nothing rather than claiming the plugin is unreviewed.
   * @param entry - the catalog row.
   * @returns the summary, or null.
   */
  const reviewsFor = (entry) => {
    if (reviewIndex === null) return null
    const repo = normalizedRepo(entry.url ?? `https://github.com/${entry.repo}`)
    if (repo === null) return null
    const candidates = reviewIndex.pluginsByRepo.get(repo)
    if (candidates === undefined || candidates.length === 0) return null
    const path = subdirectoryOf(entry.url ?? '')
    const exact = candidates.find((candidate) => candidate.path === path)
    if (exact !== undefined) return summarizeReviews(exact.reviews)
    // A single package in the repository is unambiguous even when the two
    // sides spell the subdirectory differently.
    if (candidates.length === 1) return summarizeReviews(candidates[0].reviews)
    return null
  }

  /**
   * Attach the review summary and the two timestamps the window prints.
   *
   * `reviewedAt` is when the review site last refreshed its record for this
   * plugin, `repoUpdatedAt` when the repository last moved — the pair is what
   * tells a reader whether a report predates the code they are about to run.
   * @param entry - the catalog row.
   * @returns the row with its review fields.
   */
  const withReview = (entry) => {
    const summary = reviewsFor(entry)
    const repo = normalizedRepo(entry.url ?? `https://github.com/${entry.repo}`)
    const candidates = repo === null || reviewIndex === null
      ? undefined
      : reviewIndex.pluginsByRepo.get(repo)
    const record = candidates === undefined
      ? undefined
      : (candidates.find((candidate) => candidate.path === subdirectoryOf(entry.url ?? '')) ?? candidates[0])
    return {
      ...entry,
      review: summary,
      reviewedAt: record === undefined ? undefined : record.plugin.infoUpdatedAt,
      repoUpdatedAt: record === undefined ? undefined : record.plugin.repoUpdatedAt,
      manifestVersion: record === undefined ? undefined : record.plugin.manifestVersion,
      // The feedback links travel with every row too, so the drawer shows them
      // immediately instead of waiting for its own `/detail` round trip.
      community: communityOf(entry.repo ?? null, liveStats.get(entry.repo ?? ''), undefined),
    }
  }

  /**
   * Whether an installed package carries a report judged harmful.
   *
   * Two things need this verdict without asking for it:
   *
   * - the automatic update pass, which must never pull new code from a package
   *   an independent reviewer judged harmful, and must not raise a dialog at
   *   startup to discover that either;
   * - the installed list, so the warning is visible before the update button is
   *   pressed rather than only in the confirmation bar.
   *
   * Answering from the in-memory indices means no extra request: the same
   * catalog rows and the same review index the list already built.
   * @param name - installed package name, or its repository name.
   * @returns true when at least one public report judged it harmful.
   */
  const harmfulForPackage = (name) => {
    if (catalog === null) return false
    const row = catalog.rows.find((entry) => entry.npm === name || entry.name === name)
    if (row === undefined) return false
    const summary = reviewsFor(row)
    if (summary === null) return false
    const count = Number.isFinite(summary.harmfulCount) ? summary.harmfulCount : 0
    return count > 0 || (summary.worstHarmful !== null && summary.worstHarmful !== undefined)
  }

  /** Trim a package result so one install cannot flood the browser. */
  const trimChangeResult = (result) => {
    if (result === null || typeof result !== 'object') return result
    const trimmed = { ...result }
    if (trimmed.packageResult !== undefined && trimmed.packageResult !== null) {
      const output = String(trimmed.packageResult.output ?? '')
      trimmed.packageResult = {
        ...trimmed.packageResult,
        output: output.length > OUTPUT_LIMIT ? output.slice(-OUTPUT_LIMIT) : output,
      }
    }
    return trimmed
  }

  // ---------------------------------------------------------- install progress

  /**
   * Create the progress record one installation reports through.
   * @param requestId - the id handed to `pluginManager.installBundle`.
   * @param spec - the install spec, for display.
   * @returns the record.
   */
  const startProgress = (requestId, spec) => {
    const record = {
      requestId,
      spec,
      phase: 'starting',
      attempt: null,
      lines: [],
      nextSeq: 1,
      startedAt: Date.now(),
      finishedAt: 0,
      result: null,
      message: null,
      logPath: null,
    }
    installs.set(requestId, record)
    return record
  }

  /** Drop progress records nobody will read again. */
  const pruneProgress = () => {
    const cutoff = Date.now() - PROGRESS_TTL_MS
    for (const [requestId, record] of installs) {
      if (record.finishedAt !== 0 && record.finishedAt < cutoff) installs.delete(requestId)
    }
  }

  /**
   * Append one pnpm output chunk to its record.
   * @param requestId - the run the chunk belongs to.
   * @param chunk - the event payload.
   */
  const appendLog = (requestId, chunk) => {
    const record = installs.get(requestId)
    if (record === undefined) return
    if (typeof chunk?.logPath === 'string' && chunk.logPath !== '') record.logPath = chunk.logPath
    const text = typeof chunk?.text === 'string' ? chunk.text : ''
    if (text === '') return
    record.lines.push({
      seq: record.nextSeq,
      stream: chunk.stream === 'stderr' ? 'stderr' : 'stdout',
      text: text.length > PROGRESS_TEXT_LIMIT ? text.slice(-PROGRESS_TEXT_LIMIT) : text,
    })
    record.nextSeq += 1
    // The window only ever renders the tail; keeping 500 lines is plenty and
    // bounds what one pathological run can pin in memory.
    if (record.lines.length > PROGRESS_LINE_LIMIT) record.lines.splice(0, record.lines.length - PROGRESS_LINE_LIMIT)
  }

  /**
   * Move one record to its next phase.
   * @param requestId - the run.
   * @param phase - the new phase.
   * @param attempt - the registry attempt, when the phase is `installing`.
   */
  const setPhase = (requestId, phase, attempt) => {
    const record = installs.get(requestId)
    if (record === undefined) return
    if (phase === 'installing' && attempt !== undefined) record.attempt = attempt
    // `applying` is terminal-ish: never let a late `installing` event walk back.
    if (record.phase === 'applying' && phase === 'installing') return
    record.phase = phase
  }

  /**
   * The progress view for one request id.
   * @param requestId - the run.
   * @param from - first sequence number the caller has not seen.
   * @returns the envelope, or `found:false`.
   */
  const progressView = (requestId, from) => {
    const record = installs.get(requestId)
    if (record === undefined) return { ok: true, requestId, found: false }
    const lines = record.lines.filter((line) => line.seq >= from)
    return {
      ok: true,
      requestId,
      found: true,
      spec: record.spec,
      phase: record.phase,
      attempt: record.attempt,
      lines,
      nextSeq: record.nextSeq,
      startedAt: record.startedAt,
      elapsedMs: (record.finishedAt === 0 ? Date.now() : record.finishedAt) - record.startedAt,
      result: record.result,
      message: record.message,
      logPath: record.logPath,
    }
  }

  // ------------------------------------------------------------ live stats

  /**
   * Refresh GitHub stats for a batch of repositories.
   *
   * The search endpoint accepts `repo:` qualifiers, so one request covers up to
   * eight repositories — the anonymous search allowance is 10 requests a
   * minute, and a 24-row page must not spend 24 of them.
   * @param repos - `owner/repo` identities.
   * @returns per-repo stats, the repos that failed, and the remaining allowance.
   */
  const refreshStats = async (repos) => {
    const token = await readToken()
    const stats = {}
    const failed = []
    const now = Date.now()
    const pending = []
    for (const repo of repos) {
      const cached = liveStats.get(repo)
      if (cached !== undefined && now - cached.checkedAt < LIVE_STATS_TTL_MS) {
        stats[repo] = {
          stars: cached.stars,
          forks: cached.forks,
          pushedAt: cached.pushedAt,
          archived: cached.archived,
          license: cached.license,
          language: cached.language,
          updatedAt: cached.pushedAt,
          source: 'github',
        }
        continue
      }
      pending.push(repo)
    }
    let remaining = null

    for (let index = 0; index < pending.length;) {
      const chunk = []
      let queryLength = 0
      while (index < pending.length && chunk.length < STATS_CHUNK_REPOS) {
        const candidate = `repo:${pending[index]}`
        if (chunk.length > 0 && queryLength + candidate.length + 1 > STATS_QUERY_LIMIT) break
        chunk.push(pending[index])
        queryLength += candidate.length + 1
        index += 1
      }
      const query = chunk.map((repo) => `repo:${repo}`).join(' ')
      try {
        const params = new URLSearchParams({ q: query, per_page: String(chunk.length) })
        const response = await fetch(`https://api.github.com/search/repositories?${params.toString()}`, {
          headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'dsh-plugin-market',
            'x-github-api-version': '2022-11-28',
            ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          },
          signal: AbortSignal.timeout(options.searchTimeoutMs),
        })
        const remainingHeader = response.headers.get('x-ratelimit-remaining')
        if (remainingHeader !== null && Number.isFinite(Number(remainingHeader))) remaining = Number(remainingHeader)
        if (!response.ok) {
          for (const repo of chunk) failed.push(repo)
          // A spent search allowance will not recover within this request;
          // stop instead of spending the rest of the budget on 403s.
          if (response.status === 403 || response.status === 429) break
          continue
        }
        const body = await response.json()
        const byName = new Map()
        for (const item of Array.isArray(body.items) ? body.items : []) {
          if (typeof item.full_name === 'string') byName.set(item.full_name, item)
        }
        for (const repo of chunk) {
          const item = byName.get(repo)
          if (item === undefined) {
            failed.push(repo)
            continue
          }
          const live = {
            stars: readCount(item.stargazers_count),
            forks: readCount(item.forks_count),
            pushedAt: typeof item.pushed_at === 'string' ? item.pushed_at : null,
            archived: item.archived === true,
            license: typeof item.license?.spdx_id === 'string' ? item.license.spdx_id : null,
            language: typeof item.language === 'string' ? item.language : null,
            // Where a user can ask the author a question. GitHub gives every
            // repository an issue tracker and optionally a Discussions board;
            // both flags arrive in this same search response, so knowing which
            // link is worth offering costs no extra request.
            hasIssues: item.has_issues === true,
            hasDiscussions: item.has_discussions === true,
            openIssues: readCount(item.open_issues_count),
            at: new Date().toISOString(),
            checkedAt: Date.now(),
          }
          liveStats.set(repo, live)
          stats[repo] = {
            stars: live.stars,
            forks: live.forks,
            pushedAt: live.pushedAt,
            archived: live.archived,
            license: live.license,
            language: live.language,
            hasIssues: live.hasIssues,
            hasDiscussions: live.hasDiscussions,
            openIssues: live.openIssues,
            updatedAt: live.pushedAt,
            source: 'github',
          }
        }
      } catch {
        for (const repo of chunk) failed.push(repo)
      }
    }

    return { stats, failed, remaining, authenticated: token !== null }
  }

  // ---------------------------------------------------------------- detail

  /**
   * Read the npm version history for one package.
   * @param packageName - npm package name.
   * @returns `{ versions, latest, maintainers }`, or a problem entry.
   */
  const readNpmHistory = async (packageName) => {
    try {
      const document = await fetchJson(`https://registry.npmjs.org/${packageName.replace('/', '%2F')}`, {
        token: null,
        timeoutMs: options.searchTimeoutMs,
      })
      const versions = versionsFromNpm(document, packageName).slice(0, VERSION_LIMIT)
      const latest = typeof document?.['dist-tags']?.latest === 'string'
        ? document['dist-tags'].latest
        : (versions[0]?.version ?? '')
      const maintainers = Array.isArray(document?.maintainers)
        ? document.maintainers.filter((item) => item !== null && typeof item.name === 'string').map((item) => item.name)
        : []
      // `engines` lives on each published version, not the registry root, so read
      // it off the newest version. This is what lets the window warn when a plugin
      // declares a DSH requirement the running harness cannot meet.
      let engines = null
      const versionDocs = document?.versions
      if (versionDocs !== null && versionDocs !== undefined) {
        const newestDoc = (latest !== '' && versionDocs[latest] !== undefined)
          ? versionDocs[latest]
          : (versions.length > 0 && versionDocs[versions[0].version] !== undefined ? versionDocs[versions[0].version] : undefined)
        if (newestDoc !== undefined && newestDoc.engines !== null && typeof newestDoc.engines === 'object') engines = newestDoc.engines
      }
      return { versions, latest, maintainers, engines }
    } catch (error) {
      return { versions: [], latest: '', maintainers: [], engines: null, problem: { kind: 'npm', message: messageOf(error) } }
    }
  }

  /**
   * Read the GitHub release history for one repository.
   *
   * The Atom feed needs no token and spends no API quota, which matters on an
   * anonymous profile. The JSON API is used when a token exists because it
   * carries structured tags.
   * @param repo - `owner/repo`.
   * @param token - optional GitHub token.
   * @returns version rows, or a problem entry.
   */
  const readGitHubHistory = async (repo, token) => {
    try {
      if (token !== null) {
        const releases = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=${VERSION_LIMIT}`, {
          token,
          timeoutMs: options.searchTimeoutMs,
        })
        const rows = (Array.isArray(releases) ? releases : [])
          .filter((release) => release !== null && typeof release.tag_name === 'string' && release.tag_name !== '')
          .map((release) => ({
            version: release.tag_name,
            at: typeof release.published_at === 'string' ? release.published_at : undefined,
            source: 'release',
            url: typeof release.html_url === 'string' ? release.html_url : undefined,
            prerelease: release.prerelease === true,
          }))
        if (rows.length > 0) return { versions: rows }
      }
      const feed = await fetchUpstream(`https://github.com/${repo}/releases.atom`, {
        token: null,
        timeoutMs: options.searchTimeoutMs,
        accept: 'application/atom+xml',
      })
      return { versions: versionsFromAtom(feed).slice(0, VERSION_LIMIT) }
    } catch (error) {
      return { versions: [], problem: { kind: 'github', message: messageOf(error) } }
    }
  }

  /**
   * Build the detail answer for one repository.
   * @param repo - `owner/repo`, or null when only a package name is known.
   * @param requestedNpm - npm package name supplied by the window, if any.
   * @param requestedName - installed bundle name, used to find the catalog row
   *   when a `link:` dependency carries no repository identity at all.
   * @returns the detail envelope.
   */
  /**
   * Build the "ask the author" links for one repository.
   *
   * GitHub offers two places to ask: the issue tracker every repository has,
   * and a Discussions board the owner may switch on. Both are plain URLs, so
   * nothing here is an API call — the flags come from the stats refresh that
   * already runs for every visible row.
   *
   * When the flags are unknown (the stats refresh has not reached this repo
   * yet) the issue tracker is still a safe default: it exists unless the owner
   * disabled it, and a repository that disabled it is rare enough that hiding
   * the link entirely would help fewer people than showing it.
   * @param repo - `owner/repo`, or null.
   * @param live - the cached live stats for it, if any.
   * @param row - the catalog row, if any.
   * @returns the links, or null when there is no repository to point at.
   */
  const communityOf = (repo, live, row) => {
    if (repo === null || typeof repo !== 'string' || !repo.includes('/')) return null
    // Prefer the catalog's own homepage when it exists; otherwise GitHub.
    const base = `https://github.com/${repo}`
    const hasIssues = live !== undefined && typeof live.hasIssues === 'boolean'
      ? live.hasIssues
      : true
    const hasDiscussions = live !== undefined && live.hasDiscussions === true
    return {
      repo,
      url: base,
      issues: hasIssues ? `${base}/issues` : null,
      // `issues/new` opens the form directly, which is what "ask a question"
      // actually wants; a bare `/issues` list makes the user find the button.
      newIssue: hasIssues ? `${base}/issues/new` : null,
      discussions: hasDiscussions ? `${base}/discussions` : null,
      openIssues: live !== undefined && live.openIssues !== null && live.openIssues !== undefined
        ? live.openIssues
        : null,
      // True only when the flags were actually read, so the window can say
      // "not checked yet" instead of pretending the tracker is confirmed.
      known: live !== undefined && typeof live.hasIssues === 'boolean',
      archived: live !== undefined && live.archived === true,
      homepage: row !== undefined && typeof row.page === 'string' ? row.page : null,
    }
  }

  const buildDetail = async (repo, requestedNpm, requestedName) => {
    const cacheKey = repo ?? `pkg:${requestedNpm ?? ''}:${requestedName ?? ''}`
    const cached = detailCache.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.checkedAt < DETAIL_TTL_MS) return cached

    await ensureCatalog(false).catch(() => undefined)
    // The review block comes from the review index, which is a different
    // source with its own cache. Without this the drawer answered from a cold
    // index and reported "no report" for a plugin that has one — the catalog
    // list happened to warm it first, which is why only the installed and
    // GitHub-search drawers showed a missing review section.
    if (reviewIndex === null) {
      await Promise.race([
        ensureReviews(false).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 12000)),
      ])
    }
    // Resolve a catalog row from whatever the caller could supply. An installed
    // bundle knows its package name; a `link:` dependency may know neither its
    // repository nor its npm name, so the row is matched on either.
    const candidateName = typeof requestedName === 'string' ? requestedName : ''
    const candidateNpm = typeof requestedNpm === 'string' ? requestedNpm : ''
    const row = catalog === null ? undefined : catalog.rows.find((entry) => {
      if (repo !== null && entry.repo === repo) return true
      if (candidateNpm !== '' && entry.npm === candidateNpm) return true
      if (candidateName !== '' && (entry.npm === candidateName || entry.name === candidateName)) return true
      return false
    })
    // A caller that knows only a package still gets a real repository identity
    // from the catalog, which is what the review index and GitHub history key on.
    const resolvedRepo = repo ?? (row === undefined ? null : row.repo)
    const packageName = (row !== undefined && typeof row.npm === 'string' && row.npm !== '')
      ? row.npm
      : (typeof requestedNpm === 'string' && requestedNpm !== '' ? requestedNpm : (row === undefined ? '' : ''))
    const token = await readToken()
    const problems = []

    const [npmHistory, githubHistory] = await Promise.all([
      packageName === '' ? Promise.resolve({ versions: [], latest: '', maintainers: [], engines: null }) : readNpmHistory(packageName),
      resolvedRepo === null
        ? Promise.resolve({ versions: [] })
        : readGitHubHistory(resolvedRepo, token),
    ])
    if (npmHistory.problem !== undefined) problems.push(npmHistory.problem)
    if (githubHistory.problem !== undefined) problems.push(githubHistory.problem)

    // npm first: it is the source that actually gets installed for a registry
    // package. Release tags fill in a repository that is not on npm.
    let versions = npmHistory.versions
    if (versions.length === 0) versions = githubHistory.versions
    versions = [...versions].slice(0, VERSION_LIMIT)

    // The catalog knows the version the list was built from; include it so a
    // repository with neither releases nor npm still shows something real.
    if (versions.length === 0 && row !== undefined && row.version !== '') {
      versions.push({ version: row.version, at: row.versionAt, source: 'catalog', prerelease: false })
    }

    let live = resolvedRepo === null ? undefined : liveStats.get(resolvedRepo)
    if (resolvedRepo !== null && (live === undefined || Date.now() - live.checkedAt >= LIVE_STATS_TTL_MS)) {
      const refreshed = await refreshStats([resolvedRepo]).catch(() => ({ stats: {}, failed: [resolvedRepo] }))
      const value = refreshed.stats[resolvedRepo]
      if (value !== undefined) {
        live = liveStats.get(resolvedRepo)
      } else {
        problems.push({ kind: 'github', message: 'the repository stats could not be refreshed' })
      }
    }

    const ownerFromRepo = resolvedRepo === null ? '' : resolvedRepo.split('/')[0]
    const login = row !== undefined && typeof row.owner === 'string' && row.owner !== '' ? row.owner : ownerFromRepo
    const maintainer = npmHistory.maintainers.length > 0 ? npmHistory.maintainers[0] : undefined
    const detail = {
      ok: true,
      repo: resolvedRepo ?? '',
      checkedAt: Date.now(),
      npm: packageName === '' ? undefined : packageName,
      latestVersion: npmHistory.latest !== '' ? npmHistory.latest : (versions[0]?.version ?? (row?.version ?? '')),
      // The DSH / node requirements the newest version declares, straight from its
      // package.json. `null` means the package declares none, or could not be read.
      engines: npmHistory.engines ?? null,
      versions,
      stats: {
        stars: live?.stars ?? row?.stars ?? null,
        downloads: row?.downloads ?? null,
        forks: live?.forks ?? row?.forks ?? null,
        pushedAt: live?.pushedAt ?? row?.updatedAt ?? null,
        starsAt: live?.at ?? row?.starsAt,
        downloadsAt: row?.downloadsAt,
        license: live?.license ?? row?.license ?? null,
        language: live?.language ?? null,
        source: live === undefined ? 'catalog' : 'catalog+live',
      },
      author: authorOf(login, maintainer),
      // Where to ask the author a question. `null` means "this repository does
      // not say", which the window renders as no feedback link at all.
      community: communityOf(resolvedRepo, live, row),
      screenshots: row?.screenshots ?? [],
      // The review block travels with the detail answer so one drawer opening
      // costs one request, not one per section.
      review: row === undefined ? null : (reviewsFor(row) ?? null),
      reviewedAt: row === undefined ? undefined : withReview(row).reviewedAt,
      repoUpdatedAt: row === undefined ? undefined : withReview(row).repoUpdatedAt,
      reviewLoaded,
      problems,
    }
    detailCache.set(cacheKey, detail)
    return detail
  }

  // ---------------------------------------------------------------- routes

  // Read once at composition time: the version cannot change while this
  // process runs, and every catalog answer carries it.
  const harnessVersion = readHarnessVersion()

  const routes = [
    {
      // Deliberately dependency-free: the window shows these labels even when
      // the catalog is unreachable, which is exactly when a user is most
      // likely to be checking which build they are on.
      path: `${ROUTE_PREFIX}/version`,
      methods: ['GET'],
      handle: async () => jsonResponse(200, {
        ok: true,
        plugin: { name: 'dsh-plugin-market', version: PLUGIN_VERSION },
        harness: { version: harnessVersion.version, source: harnessVersion.source },
      }),
    },
    {
      path: `${ROUTE_PREFIX}/catalog`,
      methods: ['GET'],
      handle: async (request) => {
        const url = new URL(request.url)
        const refresh = url.searchParams.get('refresh') === '1'
        // The reviewed chip needs the review index before any page is fetched,
        // so this route waits for a build already in flight and starts one when
        // none has succeeded yet. A slow or broken review site delays the answer
        // briefly but never fails it: reviewedTotal stays 0 and reviewLoaded
        // stays false, which the window renders as "no filter available".
        if (reviewIndex === null) {
          await Promise.race([
            ensureReviews(false).catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, 12000)),
          ])
        }
        try {
          const built = await ensureCatalog(refresh)
          return jsonResponse(200, {
            ok: true,
            fetchedAt: catalogAt,
            total: built.rows.length,
            categories: built.categories,
            categoriesZh: built.categoriesZh,
            languages: LANGUAGES,
            defaultLanguage: DEFAULT_LANGUAGE,
            sources: built.sources,
            token: built.token === true,
            transport: built.transport,
            statsAt: built.statsAt,
            downloadsAt: built.downloadsAt,
            versionCount: built.versionCount ?? 0,
            reviewLoaded,
            // When the snapshot was collected. The window prints this instead of
            // the download time, because the download says nothing about how
            // current the verdicts are.
            reviewDataAt,
            reviewCheckedAt: reviewAt,
            // The two versions the window prints beside its title.
            pluginVersion: PLUGIN_VERSION,
            harnessVersion: harnessVersion.version,
            // The "reviewed" chip needs a count before any page is fetched, so
            // the catalog route decorates once instead of per page request.
            reviewedTotal: built.rows.reduce(
              (total, entry) => total + (reviewsFor(entry) === null ? 0 : 1),
              0,
            ),
          })
        } catch (error) {
          return jsonResponse(502, {
            ok: false,
            code: 'catalog-unreachable',
            message: messageOf(error),
            sources: catalog === null ? undefined : catalog.sources,
          })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/find`,
      methods: ['GET'],
      handle: async (request) => {
        const url = new URL(request.url)
        const query = url.searchParams.get('q') ?? ''
        const category = url.searchParams.get('cat') ?? ''
        const sort = url.searchParams.get('sort') ?? 'stars'
        const page = Math.max(1, Math.trunc(Number(url.searchParams.get('page') ?? '1')) || 1)
        const requestedSize = Math.trunc(Number(url.searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE)))
        const pageSize = Number.isFinite(requestedSize)
          ? Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, requestedSize))
          : DEFAULT_PAGE_SIZE
        const language = readLanguage(url)
        try {
          await ensureInstalled()
          const built = await ensureCatalog(false)
          // The review index is a separate, slower source: a build in flight is
          // awaited briefly so the first page still gets badges, but a cold or
          // broken review site never delays the catalog itself.
          if (reviewIndex === null) {
            await Promise.race([
              ensureReviews(false).catch(() => undefined),
              new Promise((resolve) => setTimeout(resolve, 8000)),
            ])
          }
          const reviewedOnly = url.searchParams.get('reviewed') === '1'
          // Bookmarks travel up as `owner/name`, comma separated. Anything that
          // does not look like a repository is dropped rather than passed through:
          // a malformed entry would otherwise silently match nothing and read as
          // "you have no bookmarks".
          const favorites = (url.searchParams.get('favs') ?? '')
            .split(',')
            .map((repo) => repo.trim())
            .filter((repo) => /^[\w.-]+\/[\w.-]+$/.test(repo))
          // The review block is attached before filtering, so `reviewed=1`
          // selects on the same data the window will render.
          const decorated = built.rows.map((entry) => withReview(withLiveStats(entry)))
          const reviewedTotal = decorated.filter((entry) => entry.review !== null && entry.review !== undefined).length
          const found = findInCatalog(decorated, query, category, sort, page, pageSize, language, reviewedOnly, favorites)
          return jsonResponse(200, {
            ok: true,
            total: found.total,
            page: found.page,
            pageSize: found.pageSize,
            totalPages: found.totalPages,
            language,
            reviewLoaded,
            reviewDataAt,
            reviewCheckedAt: reviewAt,
            reviewedTotal,
            entries: found.entries.map((entry) => withInstalledFlag(
              slimEntry(entry, undefined, language),
            )),
          })
        } catch (error) {
          return jsonResponse(502, { ok: false, code: 'catalog-unreachable', message: messageOf(error) })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/github`,
      methods: ['GET'],
      handle: async (request) => {
        const url = new URL(request.url)
        const query = (url.searchParams.get('q') ?? '').trim()
        if (query === '') return jsonResponse(400, { ok: false, code: 'empty-query', message: 'q is required' })
        const page = Math.max(1, Math.trunc(Number(url.searchParams.get('page') ?? '1')) || 1)
        const sort = url.searchParams.get('sort') === 'updated' ? 'updated' : 'stars'
        const language = readLanguage(url)
        const token = await readToken()
        const params = new URLSearchParams({
          q: query,
          per_page: String(GITHUB_PAGE_SIZE),
          page: String(page),
          sort,
          order: 'desc',
        })
        let response
        try {
          response = await fetch(`https://api.github.com/search/repositories?${params.toString()}`, {
            headers: {
              accept: 'application/vnd.github+json',
              'user-agent': 'dsh-plugin-market',
              'x-github-api-version': '2022-11-28',
              ...(token === null ? {} : { authorization: `Bearer ${token}` }),
            },
            signal: AbortSignal.timeout(options.searchTimeoutMs),
          })
        } catch (error) {
          return jsonResponse(502, { ok: false, code: 'github-unreachable', message: messageOf(error) })
        }
        const remaining = response.headers.get('x-ratelimit-remaining')
        const reset = response.headers.get('x-ratelimit-reset')
        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          return jsonResponse(response.status === 403 || response.status === 429 ? 429 : 502, {
            ok: false,
            code: response.status === 403 || response.status === 429 ? 'rate-limited' : 'github-error',
            message: `GitHub answered HTTP ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`,
            authenticated: token !== null,
            remaining: remaining === null ? null : Number(remaining),
            reset: reset === null ? null : Number(reset),
          })
        }
        const body = await response.json()
        await ensureInstalled()
        if (catalog === null && building !== null) {
          await Promise.race([
            building.catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, 6000)),
          ])
        }
        const known = catalog === null ? null : new Map(catalog.rows.map((entry) => [entry.repo, entry]))
        const entries = []
        for (const item of Array.isArray(body.items) ? body.items : []) {
          const entry = gitHubItemToEntry(item)
          const catalogRow = known === null ? undefined : known.get(entry.repo)
          if (catalogRow !== undefined) {
            entries.push(withInstalledFlag(slimEntry(withReview(catalogRow), { inCatalog: true }, language)))
          } else {
            // A repository outside the curated catalog can still be reviewed,
            // so the badge follows the GitHub identity rather than the row.
            entries.push(withInstalledFlag(slimEntry(withReview(entry), undefined, language)))
          }
        }
        const total = Number.isFinite(body.total_count) ? body.total_count : entries.length
        return jsonResponse(200, {
          ok: true,
          total,
          page,
          pageSize: GITHUB_PAGE_SIZE,
          totalPages: Math.max(1, Math.ceil(total / GITHUB_PAGE_SIZE)),
          language,
          entries,
          authenticated: token !== null,
          remaining: remaining === null ? null : Number(remaining),
          reset: reset === null ? null : Number(reset),
        })
      },
    },
    {
      path: `${ROUTE_PREFIX}/detail`,
      methods: ['POST'],
      handle: async (request) => {
        const body = await readJsonBody(request)
        const rawRepo = body !== null && typeof body.repo === 'string' ? body.repo.trim() : ''
        const rawNpm = body !== null && typeof body.npm === 'string' ? body.npm.trim() : ''
        const rawName = body !== null && typeof body.name === 'string' ? body.name.trim() : ''
        // The drawer is shared by the curated catalog, GitHub search and the
        // installed list. The first two always know a repository; an installed
        // `link:` bundle may know only its package name, so either identity is
        // enough and the Host resolves the rest from the catalog.
        const repo = /^[\w.-]+\/[\w.-]+$/.test(rawRepo) ? rawRepo : null
        if (repo === null && rawNpm === '' && rawName === '') {
          return jsonResponse(400, { ok: false, code: 'bad-request', message: 'repo, npm or name is required' })
        }
        try {
          return jsonResponse(200, await buildDetail(
            repo,
            rawNpm === '' ? undefined : rawNpm,
            rawName === '' ? undefined : rawName,
          ))
        } catch (error) {
          return jsonResponse(500, { ok: false, code: 'detail-failed', message: messageOf(error) })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/stats`,
      methods: ['POST'],
      handle: async (request) => {
        const body = await readJsonBody(request)
        const requested = body !== null && Array.isArray(body.repos) ? body.repos : []
        const repos = []
        for (const candidate of requested) {
          if (typeof candidate !== 'string') continue
          if (!/^[\w.-]+\/[\w.-]+$/.test(candidate)) continue
          if (!repos.includes(candidate)) repos.push(candidate)
          if (repos.length >= STATS_MAX_REPOS) break
        }
        if (repos.length === 0) {
          return jsonResponse(200, { ok: true, checkedAt: Date.now(), stats: {}, failed: [], authenticated: false, remaining: null })
        }
        try {
          const refreshed = await refreshStats(repos)
          return jsonResponse(200, {
            ok: true,
            checkedAt: Date.now(),
            stats: refreshed.stats,
            failed: refreshed.failed,
            authenticated: refreshed.authenticated,
            remaining: refreshed.remaining,
          })
        } catch (error) {
          return jsonResponse(502, { ok: false, code: 'stats-failed', message: messageOf(error) })
        }
      },
    },
    {
      // Where the review data comes from, and how old it is.
      //
      // Read-only apart from `refresh`: the data is a static snapshot, so there
      // is nothing to connect to, sign in to, or configure. That is the entire
      // point — every reader sees the same verdicts without anyone holding a
      // credential.
      //
      // `refresh` exists because a snapshot can be republished while a window is
      // open, and waiting six hours to see a corrected verdict is silly.
      path: `${ROUTE_PREFIX}/review-source`,
      methods: ['GET', 'POST'],
      handle: async (request) => {
        const describe = () => ({
          ok: true,
          site: reviewSite,
          snapshotUrl: reviewSnapshotUrl(),
          available: reviewLoaded,
          dataAt: reviewDataAt,
          plugins: reviewCounts.plugins,
          reviews: reviewCounts.reviews,
          checkedAt: reviewAt,
          problem: reviewProblem,
        })
        if (request.method === 'GET') {
          // A window that opens settings before anything asked for reviews would
          // otherwise report "unavailable" about a perfectly good snapshot, so
          // this read does the (cached, single-request) read itself.
          if (reviewIndex === null) await ensureReviews(false)
          return jsonResponse(200, describe())
        }
        const body = await readJsonBody(request)
        if (body === null || body.action !== 'refresh') {
          return jsonResponse(400, { ok: false, code: 'bad-request', message: 'action must be refresh' })
        }
        await ensureReviews(true)
        return jsonResponse(200, describe())
      },
    },
    {
      path: `${ROUTE_PREFIX}/review`,
      methods: ['GET'],
      handle: async (request) => {
        const url = new URL(request.url)
        const refresh = url.searchParams.get('refresh') === '1'
        try {
          const index = await ensureReviews(refresh)
          if (index === null) {
            return jsonResponse(502, {
              ok: false,
              code: 'review-unreachable',
              message: reviewProblem === '' ? 'no review snapshot has been readable' : reviewProblem,
              loaded: reviewLoaded,
              snapshotUrl: reviewSnapshotUrl(),
            })
          }
          // A compact view of the whole index: what the window needs to draw
          // badges without one request per row.
          const plugins = []
          for (const candidates of index.pluginsByRepo.values()) {
            for (const candidate of candidates) {
              const summary = summarizeReviews(candidate.reviews)
              plugins.push({
                repo: candidate.plugin.repositoryFullName,
                path: candidate.path,
                pluginId: candidate.plugin.pluginId,
                displayName: candidate.plugin.displayName,
                manifestVersion: candidate.plugin.manifestVersion,
                reviewCount: candidate.plugin.publicReviewCount ?? 0,
                reviewedAt: candidate.plugin.infoUpdatedAt,
                repoUpdatedAt: candidate.plugin.repoUpdatedAt,
                url: `${REVIEW_SITE}/plugins/${candidate.plugin.pluginId}`,
                review: summary,
              })
            }
          }
          return jsonResponse(200, {
            ok: true,
            fetchedAt: reviewAt,
            loaded: reviewLoaded,
            // The snapshot's own collection time, and where it came from.
            dataAt: reviewDataAt,
            site: reviewSite,
            snapshotUrl: reviewSnapshotUrl(),
            totalPlugins: plugins.length,
            reviewedPlugins: plugins.filter((plugin) => plugin.review !== null).length,
            counts: reviewCounts,
            plugins,
          })
        } catch (error) {
          return jsonResponse(502, { ok: false, code: 'review-unreachable', message: messageOf(error) })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/installed`,
      methods: ['GET'],
      handle: async () => {
        try {
          await resolveProfileDir()
          const bundles = await refreshInstalled()
          return jsonResponse(200, { ok: true, bundles, specResolved: profileDir !== null, profileDir: profileDir ?? '' })
        } catch (error) {
          return jsonResponse(500, { ok: false, code: 'installed-failed', message: messageOf(error) })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/toggle`,
      methods: ['POST'],
      handle: async (request) => {
        const body = await readJsonBody(request)
        if (body === null || typeof body.name !== 'string' || body.name.trim() === '' || typeof body.enabled !== 'boolean') {
          return jsonResponse(400, { ok: false, code: 'bad-request', message: 'name and enabled are required' })
        }
        const bundleName = body.name.trim()
        try {
          const result = await ctx.pluginManager.setBundleEnabled(bundleName, body.enabled)
          await refreshInstalled().catch(() => undefined)
          return jsonResponse(200, { ok: true, name: bundleName, result: trimChangeResult(result) })
        } catch (error) {
          return jsonResponse(500, { ok: false, code: 'toggle-failed', message: messageOf(error) })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/updates`,
      methods: ['GET'],
      handle: async () => {
        let installed
        try {
          installed = await refreshInstalled()
        } catch (error) {
          return jsonResponse(500, { ok: false, code: 'installed-failed', message: messageOf(error) })
        }
        // The harmful verdict is read from the review index when it is available,
        // and reported as null (unknown) when it is not. Deliberately NOT awaited
        // here: this route is what the installed tab calls on open, and making it
        // wait for a cold review build would put eight seconds between the click
        // and the list. The automatic pass, which is the only caller that must not
        // act on an unknown verdict, warms the index itself first.
        /** true / false from the index, or null when the index is not loaded. */
        const harmfulOf = (name) => (reviewIndex === null ? null : harmfulForPackage(name))
        // A registry package's changelog lives on its GitHub repository. Look it
        // up from the catalog so the update row can link to release notes instead
        // of leaving the reader to hunt for the repository themselves.
        const repoByNpm = catalog === null
          ? null
          : new Map(catalog.rows
              .filter((entry) => typeof entry.npm === 'string' && entry.npm !== '')
              .map((entry) => [entry.npm, entry.repo]))
        const checks = []
        // A git dependency names the repository it came from, so its newest
        // version can be read from GitHub Releases — the same source the detail
        // drawer already trusts. Skipping these is why "most of my plugins show
        // no version state": in this ecosystem git installs are the majority.
        const repoOfGitSpec = (spec) => {
          if (typeof spec !== 'string' || spec === '') return ''
          const match = /^(?:github:|git\+?https?:\/\/github\.com\/|https?:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[?#].*)?$/.exec(spec)
          return match !== null ? match[1] : ''
        }
        // The token is needed for the API branch of readGitHubHistory; without
        // one it falls back to the releases Atom feed, which costs no quota.
        const gitToken = await readToken()
        for (const bundle of installed) {
          if (bundle.kind === 'git') {
            const repo = repoOfGitSpec(bundle.spec) || (repoByNpm === null ? '' : (repoByNpm.get(bundle.name) ?? ''))
            if (repo === '') {
              checks.push({
                name: bundle.name,
                checked: false,
                kind: 'git',
                reason: 'git-no-repo',
                harmful: harmfulOf(bundle.name),
              })
              continue
            }
            try {
              const history = await readGitHubHistory(repo, gitToken)
              const newest = history.versions[0]
              const latest = newest !== undefined && typeof newest.version === 'string' ? newest.version : ''
              if (latest === '') {
                // A repository with no releases is a real state, not a failed
                // read: reporting "up to date" would invent a version that was
                // never published. Name it so the window can say what happened.
                checks.push({
                  name: bundle.name,
                  checked: false,
                  kind: 'git',
                  reason: 'no-releases',
                  harmful: harmfulOf(bundle.name),
                  repo,
                })
                continue
              }
              checks.push({
                name: bundle.name,
                checked: true,
                kind: 'git',
                installed: bundle.version,
                latest,
                outdated: latest !== '' && bundle.version !== '' && compareVersions(latest, bundle.version) > 0,
                harmful: harmfulOf(bundle.name),
                repo,
              })
            } catch (error) {
              checks.push({
                name: bundle.name,
                checked: false,
                kind: 'git',
                reason: messageOf(error),
                harmful: harmfulOf(bundle.name),
              })
            }
            continue
          }
          if (bundle.kind !== 'registry') {
            checks.push({
              name: bundle.name,
              checked: false,
              kind: bundle.kind,
              reason: bundle.kind,
              harmful: harmfulOf(bundle.name),
            })
            continue
          }
          try {
            // Read the newest published version from the same source the detail
            // drawer uses (`readNpmHistory` → registry `dist-tags.latest`), so
            // the installed tab and the catalog can never disagree about what
            // "latest" means. `inspect` only confirms the package exists and is
            // installed; its `version` field is the *resolved* version, not the
            // newest published one, which is why this row could say "up to date"
            // while the catalog offered a newer release.
            const inspection = await ctx.pluginManager.inspect(bundle.name)
            const accepted = inspection !== null
              && typeof inspection === 'object'
              && inspection.status === 'accepted'
              && inspection.kind === 'registry'
            if (accepted !== true) {
              // A refused inspection is NOT "up to date" — it means no version
              // could be read at all, so the window must say "cannot check".
              const reason = inspection !== null && typeof inspection === 'object'
                ? (inspection.problem ?? inspection.status ?? 'refused')
                : 'refused'
              checks.push({
                name: bundle.name,
                checked: false,
                kind: 'registry',
                reason: String(reason),
                harmful: harmfulOf(bundle.name),
              })
              continue
            }
            const npmHistory = await readNpmHistory(bundle.name)
            const latest = typeof npmHistory.latest === 'string' && npmHistory.latest !== ''
              ? npmHistory.latest
              : (typeof inspection.version === 'string' ? inspection.version : '')
            checks.push({
              name: bundle.name,
              checked: true,
              kind: 'registry',
              installed: bundle.version,
              latest,
              outdated: latest !== '' && bundle.version !== '' && compareVersions(latest, bundle.version) > 0,
              harmful: harmfulOf(bundle.name),
              repo: repoByNpm === null ? '' : (repoByNpm.get(bundle.name) ?? ''),
            })
          } catch (error) {
            checks.push({
              name: bundle.name,
              checked: false,
              kind: 'registry',
              reason: messageOf(error),
              harmful: harmfulOf(bundle.name),
            })
          }
        }
        return jsonResponse(200, { ok: true, checkedAt: Date.now(), checks, reviewLoaded })
      },
    },
    {
      path: `${ROUTE_PREFIX}/account`,
      methods: ['GET', 'POST'],
      handle: async (request) => {
        if (request.method === 'GET') {
          try {
            return jsonResponse(200, await describeAccount())
          } catch (error) {
            return jsonResponse(500, { ok: false, code: 'account-failed', message: messageOf(error) })
          }
        }
        const body = await readJsonBody(request)
        if (body === null || (body.action !== 'login' && body.action !== 'logout')) {
          return jsonResponse(400, { ok: false, code: 'bad-request', message: 'action must be login or logout' })
        }
        const credentials = credentialsOf()
        if (credentials === undefined) {
          return jsonResponse(409, { ok: false, code: 'no-credentials', message: 'this profile has no credential store' })
        }
        if (body.action === 'logout') {
          try {
            await credentials.unset('GITHUB_TOKEN')
            invalidateCatalog()
            return jsonResponse(200, await describeAccount())
          } catch (error) {
            return jsonResponse(500, { ok: false, code: 'logout-failed', message: messageOf(error) })
          }
        }
        if (typeof body.token !== 'string' || body.token.trim() === '') {
          return jsonResponse(400, { ok: false, code: 'bad-request', message: 'token is required' })
        }
        const token = body.token.trim()
        // Verify before storing: a rejected token must not replace a working one.
        let login = ''
        try {
          const response = await fetch('https://api.github.com/user', {
            headers: {
              accept: 'application/vnd.github+json',
              'user-agent': 'dsh-plugin-market',
              'x-github-api-version': '2022-11-28',
              authorization: `Bearer ${token}`,
            },
            signal: AbortSignal.timeout(options.searchTimeoutMs),
          })
          if (response.status === 401) {
            return jsonResponse(401, { ok: false, code: 'invalid-token', message: 'GitHub rejected this token' })
          }
          if (!response.ok) {
            return jsonResponse(502, { ok: false, code: 'github-error', message: `GitHub answered HTTP ${response.status}` })
          }
          const profile = await response.json()
          login = typeof profile.login === 'string' ? profile.login : ''
        } catch (error) {
          return jsonResponse(502, { ok: false, code: 'github-unreachable', message: messageOf(error) })
        }
        try {
          await credentials.set('GITHUB_TOKEN', token)
        } catch (error) {
          return jsonResponse(409, { ok: false, code: 'not-writable', message: messageOf(error) })
        }
        invalidateCatalog()
        const view = await describeAccount()
        return jsonResponse(200, { ...view, login: view.login === '' ? login : view.login })
      },
    },
    {
      path: `${ROUTE_PREFIX}/inspect`,
      methods: ['POST'],
      handle: async (request) => {
        const body = await readJsonBody(request)
        if (body === null || typeof body.spec !== 'string' || body.spec.trim() === '') {
          return jsonResponse(400, { ok: false, code: 'bad-request', message: 'spec is required' })
        }
        const spec = body.spec.trim()
        try {
          const inspection = await ctx.pluginManager.inspect(spec)
          return jsonResponse(200, { ok: true, spec, inspection })
        } catch (error) {
          return jsonResponse(500, { ok: false, code: 'inspect-failed', message: messageOf(error) })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/install`,
      methods: ['POST'],
      handle: async (request) => {
        const body = await readJsonBody(request)
        if (body === null || typeof body.spec !== 'string' || body.spec.trim() === '') {
          return jsonResponse(400, { ok: false, code: 'bad-request', message: 'spec is required' })
        }
        const spec = body.spec.trim()
        const requestId = typeof body.requestId === 'string' && body.requestId.trim() !== ''
          ? body.requestId.trim()
          : `pm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        const approvedBuilds = Array.isArray(body.approvedBuilds)
          ? body.approvedBuilds.filter((name) => typeof name === 'string' && name !== '')
          : undefined
        pruneProgress()
        const record = startProgress(requestId, spec)
        // A GitHub spec spends time on the manager's connection check before
        // pnpm even starts; saying "checking" there is honest and stops the
        // window from looking frozen.
        record.phase = 'checking'
        // `force` means "this is an update / reinstall, re-resolve the source".
        // The profile manifest records whatever spec first installed the plugin —
        // `github:owner/repo` with no ref, a caret range, or an exact version — and
        // the package manager treats every one of those as already satisfied, so
        // `add` was a no-op and the only way to move the version was to remove the
        // plugin first. Dropping the entry before adding it back is what makes an
        // update actually fetch new code.
        // Captured BEFORE the removal: a failure between remove and add would
        // otherwise leave the profile naming a plugin its tree no longer has.
        const manifestSnapshot = body.force === true ? await captureManifest() : null
        if (body.force === true) {
          try {
            const bundles = await refreshInstalled()
            const installedName = bundles.find((bundle) => bundle.spec === spec || bundle.name === spec)?.name
            if (typeof installedName === 'string' && installedName !== '') {
              record.phase = 'preparing'
              await ctx.pluginManager.removeBundle(installedName)
              await refreshInstalled().catch(() => undefined)
            }
          } catch (error) {
            // A removal that fails must not silently fall through to a no-op
            // install: report it, because the update did not happen.
            const rolledBack = restoreManifest(manifestSnapshot)
            record.phase = 'failed'
            record.finishedAt = Date.now()
            record.message = messageOf(error)
            return jsonResponse(500, {
              ok: false,
              code: 'update-failed',
              message: record.message,
              requestId,
              restored: rolledBack.ok,
              restoreProblem: rolledBack.ok ? '' : rolledBack.reason,
            })
          }
        }
        try {
          const result = await ctx.pluginManager.installBundle(spec, {
            enabled: true,
            requestId,
            ...(approvedBuilds === undefined ? {} : { approvedBuilds }),
          })
          // A change the manager reports as anything but applied did not put the
          // plugin back. Restore the manifest so the profile matches its tree,
          // and say so in the answer rather than leaving a silent half-state.
          if (manifestSnapshot !== null && result?.application !== 'applied') {
            const rolledBack = restoreManifest(manifestSnapshot)
            record.restored = rolledBack.ok
            record.restoreProblem = rolledBack.ok ? '' : rolledBack.reason
            await refreshInstalled().catch(() => undefined)
          }
          if (typeof result?.bundle === 'string' && result.bundle !== '') specBundles.set(spec, result.bundle)
          record.result = trimChangeResult(result)
          record.finishedAt = Date.now()
          record.phase = result?.application === 'failed'
            ? 'failed'
            : result?.application === 'cancelled' ? 'cancelled' : 'done'
          record.message = result?.application === 'applied'
            ? 'applied'
            : (result?.application ?? null)
          if (typeof result?.packageResult?.logPath === 'string') record.logPath = result.packageResult.logPath
          await refreshInstalled().catch(() => undefined)
          return jsonResponse(200, {
            ok: true,
            spec,
            requestId,
            result: record.result,
            restored: record.restored === true,
            restoreProblem: record.restoreProblem ?? '',
          })
        } catch (error) {
          // The add threw. For a forced update the entry was already dropped, so
          // the manifest must go back or the profile names a plugin it no longer
          // has — the half-state that forced users to repair the file by hand.
          const rolledBack = restoreManifest(manifestSnapshot)
          await refreshInstalled().catch(() => undefined)
          record.phase = 'failed'
          record.finishedAt = Date.now()
          record.restored = rolledBack.ok
          record.restoreProblem = rolledBack.ok ? '' : rolledBack.reason
          record.message = messageOf(error)
          return jsonResponse(500, {
            ok: false,
            code: 'install-failed',
            message: record.message,
            requestId,
            restored: rolledBack.ok,
            restoreProblem: rolledBack.ok ? '' : rolledBack.reason,
          })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/install-progress`,
      methods: ['GET'],
      handle: async (request) => {
        const url = new URL(request.url)
        const requestId = url.searchParams.get('requestId') ?? ''
        const from = Math.max(0, Math.trunc(Number(url.searchParams.get('from') ?? '0')) || 0)
        if (requestId === '') {
          return jsonResponse(400, { ok: false, code: 'bad-request', message: 'requestId is required' })
        }
        pruneProgress()
        return jsonResponse(200, progressView(requestId, from))
      },
    },
    {
      path: `${ROUTE_PREFIX}/install-cancel`,
      methods: ['POST'],
      handle: async (request) => {
        const body = await readJsonBody(request)
        if (body === null || typeof body.requestId !== 'string' || body.requestId.trim() === '') {
          return jsonResponse(400, { ok: false, code: 'bad-request', message: 'requestId is required' })
        }
        const requestId = body.requestId.trim()
        try {
          const cancellation = await ctx.pluginManager.cancelInstall(requestId)
          const status = cancellation !== null && typeof cancellation === 'object' ? cancellation.status : 'not-running'
          if (status === 'cancelled') {
            const record = installs.get(requestId)
            if (record !== undefined) {
              record.phase = 'cancelled'
              record.finishedAt = Date.now()
              record.message = 'cancelled'
            }
          }
          return jsonResponse(200, { ok: true, requestId, status })
        } catch (error) {
          return jsonResponse(500, { ok: false, code: 'cancel-failed', message: messageOf(error) })
        }
      },
    },
    {
      path: `${ROUTE_PREFIX}/remove`,
      methods: ['POST'],
      handle: async (request) => {
        const body = await readJsonBody(request)
        if (body === null || typeof body.name !== 'string' || body.name.trim() === '') {
          return jsonResponse(400, { ok: false, code: 'bad-request', message: 'name is required' })
        }
        const bundleName = body.name.trim()
        try {
          const result = await ctx.pluginManager.removeBundle(bundleName)
          for (const [spec, name] of specBundles) {
            if (name === bundleName) specBundles.delete(spec)
          }
          await refreshInstalled().catch(() => undefined)
          return jsonResponse(200, { ok: true, name: bundleName, result: trimChangeResult(result) })
        } catch (error) {
          return jsonResponse(500, { ok: false, code: 'remove-failed', message: messageOf(error) })
        }
      },
    },
  ]

  for (const route of routes) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: route.path,
      methods: route.methods,
      requestBody: 'buffered',
      fetch: async (request) => {
        if (!route.methods.includes(request.method)) {
          return jsonResponse(405, { ok: false, code: 'method', message: `${route.methods.join('/')} only` })
        }
        try {
          return await route.handle(request)
        } catch (error) {
          ctx.logger?.warn?.(`[plugin-market] ${route.path}: ${messageOf(error)}`)
          return jsonResponse(500, { ok: false, code: 'internal', message: messageOf(error) })
        }
      },
    }), `plugin-market: ${route.path}`)
  }

  // The manager reports an installation through two events; both carry the
  // request id, so only a run this window started is recorded.
  ctx.effect(() => {
    const onState = (progress) => {
      if (progress === null || typeof progress !== 'object') return
      const requestId = typeof progress.requestId === 'string' ? progress.requestId : ''
      if (requestId === '') return
      setPhase(requestId, progress.phase, progress.attempt)
    }
    const onLog = (chunk) => {
      if (chunk === null || typeof chunk !== 'object') return
      const requestId = typeof chunk.requestId === 'string' ? chunk.requestId : ''
      if (requestId === '') return
      appendLog(requestId, chunk)
    }
    // `ctx.on` returns its own disposer; capturing them keeps this correct on
    // a Cordis build that has no `ctx.off`.
    const disposeState = ctx.on('plugin-manager/install-state', onState)
    const disposeLog = ctx.on('plugin-manager/install-log', onLog)
    return () => {
      if (typeof disposeState === 'function') disposeState()
      if (typeof disposeLog === 'function') disposeLog()
    }
  }, 'plugin-market: install progress events')
}

/**
 * Read a small JSON body from one buffered Fetch route.
 * @param request - the bridged request.
 * @returns the parsed object, or null when the body is not a JSON object.
 */
async function readJsonBody(request) {
  try {
    const parsed = await request.json()
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
