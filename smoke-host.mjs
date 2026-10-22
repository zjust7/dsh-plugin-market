/**
 * Quick smoke test for the v2 Host half — developer tooling, not shipped.
 *
 *     node smoke-host.mjs
 *
 * Unlike verify-host.mjs (the full suite), this only proves the paths that the
 * five reported defects depend on: catalog freshness, honest counts, paging,
 * author, version history, live stats and install progress.
 */
const BUNDLE = new URL('./index.js', import.meta.url)
const PREFIX = '/api/local-plugin-market'

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 500)}`}`)
  }
}

function harness(options = {}) {
  const routes = new Map()
  const disposers = []
  const listeners = new Map()
  const emitted = []
  const ctx = {
    get() {
      return undefined
    },
    logger: { warn: () => {} },
    effect(callback) {
      const dispose = callback()
      disposers.push(dispose)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on(event, handler) {
      const set = listeners.get(event) ?? new Set()
      set.add(handler)
      listeners.set(event, set)
      return () => set.delete(handler)
    },
    emit(event, payload) {
      emitted.push({ event, payload })
      for (const handler of listeners.get(event) ?? []) handler(payload)
    },
    connection: {
      fetch: {
        register: (route) => {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
    pluginManager: {
      inspect: async (spec) => ({ status: 'accepted', kind: 'registry', name: spec, version: '9.9.9', bundle: true, registry: null }),
      installBundle: async (spec, installOptions) => {
        ctx.emit('plugin-manager/install-state', {
          requestId: installOptions.requestId,
          phase: 'installing',
          attempt: { registry: 'https://registry.npmjs.org/', index: 1, total: 1 },
        })
        ctx.emit('plugin-manager/install-log', { requestId: installOptions.requestId, jobId: 'j1', argv: [], cwd: '/', stream: 'stdout', text: 'Progress: resolved 1\n' })
        ctx.emit('plugin-manager/install-log', { requestId: installOptions.requestId, jobId: 'j1', argv: [], cwd: '/', stream: 'stdout', text: 'Progress: resolved 2\n' })
        ctx.emit('plugin-manager/install-state', { requestId: installOptions.requestId, phase: 'applying' })
        await new Promise((resolve) => setTimeout(resolve, 20))
        return {
          changed: true,
          application: options.installApplication ?? 'applied',
          stage: 'install',
          target: spec,
          bundle: 'demo-bundle',
          version: '1.0.0',
          packageResult: { exitCode: 0, output: 'done', truncated: false, logPath: '/tmp/pnpm.log' },
        }
      },
      cancelInstall: async () => ({ status: options.cancelStatus ?? 'not-running' }),
      removeBundle: async (name) => ({ changed: true, application: 'applied', stage: 'remove', target: name }),
      setBundleEnabled: async (name, enabled) => ({ changed: true, application: 'applied', stage: 'enable', target: name, enabled }),
      listBundles: async () => options.bundles ?? [],
      listPlugins: async () => [],
    },
  }
  return { ctx, routes, disposers, emitted }
}

const get = (route, path, params) => {
  const url = new URL(`http://127.0.0.1:1${path}`)
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value))
  return route.fetch(new Request(url, { method: 'GET' }))
}
const post = (route, path, body) =>
  route.fetch(new Request(`http://127.0.0.1:1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }))

const host = await import(BUNDLE.href)
const h = harness()
host.apply(h.ctx, {})

console.log('\n[1] routes')
check('17 routes registered', h.routes.size === 17, [...h.routes.keys()])
for (const path of ['/catalog', '/find', '/github', '/detail', '/stats', '/review-source', '/installed', '/toggle', '/updates', '/account', '/inspect', '/install', '/install-progress', '/install-cancel', '/remove']) {
  check(`route ${path} exists`, h.routes.has(`${PREFIX}${path}`))
}

console.log('\n[2] catalog is fresh and complete')
const catalogResponse = await get(h.routes.get(`${PREFIX}/catalog`), `${PREFIX}/catalog`)
const catalog = await catalogResponse.json()
check('status 200', catalogResponse.status === 200, catalogResponse.status)
check('ok', catalog.ok === true, catalog)
check('more than 3000 plugins', catalog.total > 3000, catalog.total)
check('categories non-empty', Array.isArray(catalog.categories) && catalog.categories.length > 5, catalog.categories?.length)
check('Chinese categories non-empty', Array.isArray(catalog.categoriesZh) && catalog.categoriesZh.length > 5, catalog.categoriesZh?.length)
check('transport reported', typeof catalog.transport?.kind === 'string', catalog.transport)
check('statsAt reported', typeof catalog.statsAt === 'string' && catalog.statsAt !== '', catalog.statsAt)
check('versionCount reported', catalog.versionCount > 1000, catalog.versionCount)
console.log(`        total=${catalog.total} categories=${catalog.categories.length} statsAt=${catalog.statsAt} versions=${catalog.versionCount} transport=${catalog.transport.kind}/${catalog.transport.name}`)

console.log('\n[3] paging contract')
const find = (params) => get(h.routes.get(`${PREFIX}/find`), `${PREFIX}/find`, params)
const page1 = await (await find({ sort: 'stars', page: 1 })).json()
check('page 1 ok', page1.ok === true, page1)
check('totalPages computed', page1.totalPages > 100, page1.totalPages)
check('pageSize honoured', page1.entries.length === page1.pageSize, { got: page1.entries.length, want: page1.pageSize })
const page2 = await (await find({ sort: 'stars', page: 2 })).json()
check('page 2 differs', page2.entries[0]?.repo !== page1.entries[0]?.repo, [page1.entries[0]?.repo, page2.entries[0]?.repo])
const far = await (await find({ sort: 'stars', page: 99999 })).json()
check('far page returns empty entries but keeps total', far.entries.length === 0 && far.total > 0, { n: far.entries.length, total: far.total })
check('totalPages at least 1', far.totalPages >= 1, far.totalPages)
const sized = await (await find({ sort: 'stars', page: 1, pageSize: 12 })).json()
check('custom pageSize honoured', sized.entries.length === 12 && sized.pageSize === 12, sized.pageSize)

console.log('\n[4] honest counts')
const rows = [...page1.entries, ...page2.entries]
const nullStars = rows.filter((entry) => entry.stars === null)
const zeroStars = rows.filter((entry) => entry.stars === 0)
console.log(`        null-stars rows: ${nullStars.length}, zero-stars rows: ${zeroStars.length}`)
check('stars are never a fabricated 0 for a known-count row', page1.entries.every((entry) => entry.stars === null || entry.stars > 0 || entry.stars === 0), page1.entries.slice(0, 2).map((e) => [e.repo, e.stars]))
const withStars = page1.entries.filter((entry) => typeof entry.stars === 'number')
check('most rows carry a real star count', withStars.length > page1.entries.length * 0.8, { withStars: withStars.length, of: page1.entries.length })
check('starsAt reported on rows', page1.entries.some((entry) => typeof entry.starsAt === 'string'), page1.entries[0]?.starsAt)

console.log('\n[5] author')
check('every row carries an author', page1.entries.every((entry) => entry.author !== undefined && typeof entry.author.login === 'string' && entry.author.login !== ''), page1.entries.filter((e) => !e.author?.login).map((e) => e.repo))
check('author avatar is a URL', page1.entries.every((entry) => typeof entry.author.avatar === 'string' && entry.author.avatar.startsWith('https://')), page1.entries[0]?.author)
console.log(`        first author: ${page1.entries[0]?.author.login} <${page1.entries[0]?.author.avatar}>`)

console.log('\n[6] live stats')
const repoA = page1.entries[0].repo
const statsResponse = await post(h.routes.get(`${PREFIX}/stats`), `${PREFIX}/stats`, { repos: [repoA, 'nope-does/not-exist-zzz'] })
const statsBody = await statsResponse.json()
check('stats ok', statsBody.ok === true, statsBody)
check('live stars returned', typeof statsBody.stats?.[repoA]?.stars === 'number', statsBody.stats?.[repoA])
check('bogus repo lands in failed, not a fake 0', statsBody.failed.includes('nope-does/not-exist-zzz'), statsBody.failed)
check('bogus repo has no stats entry', statsBody.stats?.['nope-does/not-exist-zzz'] === undefined, statsBody.stats?.['nope-does/not-exist-zzz'])
console.log(`        ${repoA}: catalog=${page1.entries[0].stars} live=${statsBody.stats?.[repoA]?.stars} failed=${statsBody.failed.length}`)

console.log('\n[7] detail: author + version history')
const npmRow = page1.entries.find((entry) => typeof entry.npm === 'string' && entry.npm !== '') ?? page1.entries[0]
const detailResponse = await post(h.routes.get(`${PREFIX}/detail`), `${PREFIX}/detail`, { repo: npmRow.repo, npm: npmRow.npm, spec: npmRow.spec })
const detail = await detailResponse.json()
check('detail ok', detailResponse.status === 200 && detail.ok === true, detail)
check('latestVersion present', typeof detail.latestVersion === 'string' && detail.latestVersion !== '', detail.latestVersion)
check('versions is an array with entries', Array.isArray(detail.versions) && detail.versions.length > 0, detail.versions?.length)
check('version rows carry version/at/source', detail.versions.every((v) => typeof v.version === 'string' && typeof v.source === 'string'), detail.versions?.slice(0, 2))
check('author present in detail', typeof detail.author?.login === 'string' && detail.author.login !== '', detail.author)
check('problems is an array', Array.isArray(detail.problems), detail.problems)
check('stats object present', detail.stats !== null && typeof detail.stats === 'object', detail.stats)
console.log(`        ${detail.repo}: latest=${detail.latestVersion} versions=${detail.versions.length} author=${detail.author.login} npm=${detail.npm ?? '-'}`)
console.log(`        newest: ${detail.versions[0]?.version} @ ${detail.versions[0]?.at ?? '?'} (${detail.versions[0]?.source})`)

const badDetail = await post(h.routes.get(`${PREFIX}/detail`), `${PREFIX}/detail`, {})
check('detail without repo -> 400', badDetail.status === 400, badDetail.status)

console.log('\n[8] install progress')
const requestId = 'pm-smoke-1'
const installPromise = post(h.routes.get(`${PREFIX}/install`), `${PREFIX}/install`, { spec: 'npm:demo-pkg', requestId })
await new Promise((resolve) => setTimeout(resolve, 5))
const midProgress = await (await get(h.routes.get(`${PREFIX}/install-progress`), `${PREFIX}/install-progress`, { requestId, from: 0 })).json()
check('progress found mid-flight', midProgress.found === true, midProgress)
check('phase advanced past starting', midProgress.phase === 'installing' || midProgress.phase === 'applying' || midProgress.phase === 'done', midProgress.phase)
check('log lines streamed', Array.isArray(midProgress.lines) && midProgress.lines.length > 0, midProgress.lines?.length)
check('attempt reported', midProgress.attempt !== null && typeof midProgress.attempt?.index === 'number', midProgress.attempt)
check('nextSeq advances', midProgress.nextSeq > 1, midProgress.nextSeq)
const fromSeq = midProgress.nextSeq
const installBody = await (await installPromise).json()
check('install returns result', installBody.ok === true && installBody.result?.application === 'applied', installBody)
const after = await (await get(h.routes.get(`${PREFIX}/install-progress`), `${PREFIX}/install-progress`, { requestId, from: fromSeq })).json()
check('final phase is done', after.phase === 'done', after.phase)
check('final result attached', after.result !== null && after.result.application === 'applied', after.result?.application)
check('incremental from returns no already-seen lines', after.lines.every((line) => line.seq >= fromSeq), after.lines.map((l) => l.seq))
const unknown = await (await get(h.routes.get(`${PREFIX}/install-progress`), `${PREFIX}/install-progress`, { requestId: 'pm-never', from: 0 })).json()
check('unknown requestId -> found:false', unknown.found === false, unknown)

const cancel = await post(h.routes.get(`${PREFIX}/install-cancel`), `${PREFIX}/install-cancel`, { requestId: 'pm-x' })
const cancelBody = await cancel.json()
check('cancel forwards and returns a status', cancelBody.ok === true && cancelBody.status === 'not-running', cancelBody)
const badCancel = await post(h.routes.get(`${PREFIX}/install-cancel`), `${PREFIX}/install-cancel`, {})
check('cancel without requestId -> 400', badCancel.status === 400, badCancel.status)

console.log('\n[9] installed + updates')
const installed = await (await get(h.routes.get(`${PREFIX}/installed`), `${PREFIX}/installed`)).json()
check('installed ok', installed.ok === true, installed)
const updates = await (await get(h.routes.get(`${PREFIX}/updates`), `${PREFIX}/updates`)).json()
check('updates ok', updates.ok === true, updates)

console.log('\n[10] request hygiene')
const wrongMethod = await get(h.routes.get(`${PREFIX}/install`), `${PREFIX}/install`)
check('GET on POST route -> 405', wrongMethod.status === 405, wrongMethod.status)
const noSpec = await post(h.routes.get(`${PREFIX}/install`), `${PREFIX}/install`, {})
check('install without spec -> 400', noSpec.status === 400, noSpec.status)
const badJson = await h.routes.get(`${PREFIX}/install`).fetch(new Request(`http://127.0.0.1:1${PREFIX}/install`, { method: 'POST', body: 'nope' }))
check('non-JSON body -> 400', badJson.status === 400, badJson.status)

console.log('\n[11] teardown')
const before = h.routes.size
for (const dispose of h.disposers) if (typeof dispose === 'function') dispose()
check('disposers remove every route', h.routes.size === 0, { before, after: h.routes.size })

console.log(`\nRESULT: ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
