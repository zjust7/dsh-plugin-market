/**
 * Behavioural self-test for the Host half of dsh-plugin-market.
 *
 * Developer tooling, not part of the plugin runtime: the loader only reads
 * `index.js`, `client.js`, `cordis.patch.yml` and `locale/`.
 *
 *     node verify-host.mjs
 *     DSH_MARKET_OFFLINE=1 node verify-host.mjs   # skip the upstream sections
 *
 * `connection` and `pluginManager` are stubbed through a fake `ctx`, but the
 * catalog build, the GitHub repository search, the live-stats refresh and the
 * detail lookup run against the real upstreams, so this exercises the actual
 * contract written down in `docs/API.md` (v2). Route-shape rules are
 * transcribed from the installed `dsh-client-connection` registry
 * (`endpointFromPath`, `ENDPOINT_SEGMENT_PATTERN`).
 *
 * The anonymous GitHub allowance is 60 core requests an hour and 10 searches a
 * minute, so the network sections are batched: one catalog build, one stats
 * search, one repository search, one detail lookup. `DSH_MARKET_OFFLINE=1`
 * skips exactly those sections and keeps the rest runnable on a spent quota.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUNDLE = new URL('./index.js', import.meta.url);
const PREFIX = '/api/local-plugin-market';
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
const OFFLINE = process.env.DSH_MARKET_OFFLINE === '1';

let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail).slice(0, 500)}`}`);
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A fake Cordis context: the two injected services, the settings/credentials
 * lookups the Host performs through `ctx.get`, and an event bus so the
 * install-progress path can be driven through `ctx.emit`.
 */
function harness(options = {}) {
  const bundles = options.bundles ?? [];
  const calls = { install: [], remove: [], toggle: [], credential: [], cancel: [] };
  /** Mutable credential store: `credentials.set`/`unset` write here. */
  const store = new Map();
  if (typeof options.token === 'string' && options.token !== '') store.set('GITHUB_TOKEN', options.token);
  const routes = new Map();
  const disposers = [];
  /** Event name to listener set; the Host subscribes to install events here. */
  const listeners = new Map();
  const ctx = {
    get(name) {
      // Mirrors `settings.prepareDocument()`: the profile patch path, from which
      // the plugin derives the profile directory when the launcher exported no
      // `DSH_PROFILE_DIR` (a desktop shortcut starts with a bare environment).
      if (name === 'settings' && typeof options.profileDir === 'string') {
        return { prepareDocument: async () => join(options.profileDir, 'cordis.patch.yml') };
      }
      if (name !== 'credentials') return undefined;
      return {
        resolve: async (ref) => (store.has(ref) ? { value: store.get(ref), source: 'verification' } : undefined),
        describe: async (ref) => ({
          configured: store.has(ref),
          source: store.has(ref) ? 'verification' : undefined,
          writable: options.credentialWritable !== false,
        }),
        set: async (ref, value) => {
          if (options.credentialWritable === false) throw new Error('the store is read-only');
          calls.credential.push({ action: 'set', ref, value });
          store.set(ref, value);
        },
        unset: async (ref) => {
          if (options.credentialWritable === false) throw new Error('the store is read-only');
          calls.credential.push({ action: 'unset', ref });
          store.delete(ref);
        },
      };
    },
    logger: { warn: () => {} },
    effect(callback) {
      const dispose = callback();
      disposers.push(dispose);
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler);
      listeners.set(event, set);
      return () => set.delete(handler);
    },
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
    connection: {
      fetch: {
        register: (route) => {
          routes.set(route.path, route);
          return () => {
            routes.delete(route.path);
          };
        },
      },
    },
    pluginManager: {
      inspect: async (spec) => (options.refuseInspect === true
        ? { status: 'refused', problem: 'not-found', reason: 'no such package' }
        : {
          status: 'accepted',
          kind: 'registry',
          name: spec,
          version: options.latestVersion ?? '9.9.9',
          description: undefined,
          bundle: options.bundle ?? null,
          registry: null,
          host: 'registry.npmjs.org',
        }),
      installBundle: async (spec, installOptions) => {
        calls.install.push({ spec, options: installOptions });
        const requestId = typeof installOptions?.requestId === 'string' ? installOptions.requestId : '';
        // The manager reports progress through the same events the real one
        // uses; the Host is expected to subscribe via `ctx.on`.
        const emitState = (phase, attempt) => ctx.emit('plugin-manager/install-state', {
          requestId,
          phase,
          ...(attempt === undefined ? {} : { attempt }),
        });
        const emitLog = (text, stream = 'stdout') => ctx.emit('plugin-manager/install-log', { requestId, stream, text });
        if (typeof options.installScript === 'function') {
          return options.installScript({ spec, requestId, emitState, emitLog });
        }
        return {
          changed: true,
          application: options.installApplication ?? 'applied',
          stage: 'install',
          target: spec,
          enabled: true,
          bundle: 'demo-bundle',
          packageResult: { exitCode: 0, output: 'added 1 package\n done', truncated: false, logPath: 'C:/tmp/pnpm.log' },
          ...(options.pendingBuilds === undefined ? {} : { pendingBuilds: options.pendingBuilds }),
        };
      },
      cancelInstall: async (requestId) => {
        calls.cancel.push(requestId);
        return { status: options.cancelStatus ?? 'not-running' };
      },
      removeBundle: async (name) => {
        calls.remove.push({ name });
        return { changed: true, application: 'applied', stage: 'remove', target: name };
      },
      setBundleEnabled: async (name, enabled) => {
        calls.toggle.push({ name, enabled });
        return { changed: true, application: 'applied', stage: 'enable', target: name, enabled };
      },
      listBundles: async () => bundles,
      // Live Loader phases: `{ entryId: fiberPhase }`. A bundle only counts as
      // running when at least one of its rows is active here.
      listPlugins: async () => Object.entries(options.phases ?? {}).map(([entryId, fiberPhase]) => ({
        entryId,
        moduleName: entryId,
        fiberPhase,
        enabled: true,
      })),
    },
  };
  return { ctx, routes, disposers, calls, listeners, bundles, store };
}

/** The `dsh-client-connection` registry rules for one Fetch route path. */
function assertRouteShape(path) {
  if (!path.startsWith('/api/')) throw new Error(`path ${path} is not under /api/`);
  for (const segment of path.slice('/api/'.length).split('/')) {
    if (segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment)) {
      throw new Error(`segment ${JSON.stringify(segment)} is rejected by the registry`);
    }
  }
}

const get = (route, path, params) => {
  const url = new URL(`http://127.0.0.1:1${path}`);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
  return route.fetch(new Request(url, { method: 'GET' }));
};
const post = (route, path, body) =>
  route.fetch(new Request(`http://127.0.0.1:1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }));
const routeOf = (h, name) => h.routes.get(`${PREFIX}/${name}`);

/**
 * Check that a numeric field descends, with `null` (unknown) rows last.
 * @returns null when the order is valid, otherwise a description of the break.
 */
function numericDescending(entries, field) {
  let seenNull = false;
  let previous = null;
  for (const entry of entries) {
    const value = entry[field];
    if (value === null) {
      seenNull = true;
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${field} is not a number: ${JSON.stringify(value)}`;
    if (seenNull) return `a numbered ${field} follows an unknown one`;
    if (previous !== null && previous < value) return `${field} rose from ${previous} to ${value}`;
    previous = value;
  }
  return null;
}

/** Check that version rows are ordered newest first by their `at` stamp. */
function versionTimesDescending(versions) {
  for (let index = 1; index < versions.length; index += 1) {
    const previous = String(versions[index - 1]?.at ?? '');
    const current = String(versions[index]?.at ?? '');
    if (previous < current) {
      return `version ${versions[index]?.version} (${current}) is newer than ${versions[index - 1]?.version} (${previous})`;
    }
  }
  return null;
}

/** Parse the numeric core of a version string, or null when it has none. */
function versionNumbers(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''));
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

const host = await import(BUNDLE.href);

// A crafted profile manifest lets the test drive the registry/local split and
// the reported install directory without ever reading the real profile.
const FAKE_PROFILE = mkdtempSync(join(tmpdir(), 'dsh-market-verify-'));
writeFileSync(join(FAKE_PROFILE, 'package.json'), JSON.stringify({
  name: 'verify-profile',
  private: true,
  dependencies: {
    'demo-bundle': '^1.2.3',
    'linked-thing': 'link:C:/somewhere/linked-thing',
    // A git dependency: it tracks a commit, so it has no version to compare.
    'git-thing': 'github:demo/git-thing',
    // Installed, but never selected as a bundle: it must still be reported.
    'orphan-bundle': '^2.0.0',
  },
}));
const realProfileDir = process.env.DSH_PROFILE_DIR;
process.env.DSH_PROFILE_DIR = FAKE_PROFILE;

console.log('\n[1] exports and declarations');
check('exports apply()', typeof host.apply === 'function');
check('inject = [connection, pluginManager]', JSON.stringify(host.inject) === JSON.stringify(['connection', 'pluginManager']), host.inject);
check('name', host.name === 'plugin-market', host.name);

console.log('\n[2] apply() registers the exact Fetch routes');
const a = harness();
host.apply(a.ctx, {});
const expectedRoutes = ['version', 'catalog', 'find', 'github', 'detail', 'stats', 'review-source', 'review', 'installed', 'toggle', 'updates', 'account', 'inspect', 'install', 'install-progress', 'install-cancel', 'remove'];
const registered = [...a.routes.keys()].map((path) => path.slice(PREFIX.length + 1)).sort();
check(`registered ${expectedRoutes.length} routes`, a.routes.size === expectedRoutes.length, [...a.routes.keys()]);
check('the route set is the documented set', JSON.stringify(registered) === JSON.stringify([...expectedRoutes].sort()), registered);
check('every route sits under the market prefix', [...a.routes.keys()].every((path) => path.startsWith(`${PREFIX}/`)), [...a.routes.keys()]);
let shapeError = null;
for (const path of a.routes.keys()) {
  try {
    assertRouteShape(path);
  } catch (error) {
    shapeError = `${path}: ${error.message}`;
  }
}
check('every route passes the registry segment rules', shapeError === null, shapeError);
check('every route declares a method', [...a.routes.values()].every((route) => Array.isArray(route.methods) && route.methods.length > 0), [...a.routes.values()].map((route) => route.methods));
check('every route is buffered', [...a.routes.values()].every((route) => route.requestBody === 'buffered'), [...a.routes.values()].map((route) => route.requestBody));

// The network sections below spend real upstream requests. Everything else
// stays runnable with DSH_MARKET_OFFLINE=1 on a spent GitHub allowance.
let catalog = null;
let page1 = null;
let npmRow = null;
if (OFFLINE) {
  console.log('\n[3]-[7] SKIP  DSH_MARKET_OFFLINE=1: catalog, find, stats, detail and GitHub search skipped');
} else {
  console.log('\n[3] the curated catalog builds from the published index');
  const catalogResponse = await get(routeOf(a, 'catalog'), `${PREFIX}/catalog`);
  catalog = await catalogResponse.json();
  check('status 200', catalogResponse.status === 200, catalogResponse.status);
  check('ok', catalog.ok === true, catalog);
  check('more than 3000 plugins', catalog.total > 3000, catalog.total);
  check('the catalog reports its build time', typeof catalog.fetchedAt === 'number', catalog.fetchedAt);
  check('categories are built', Array.isArray(catalog.categories) && catalog.categories.length > 5, catalog.categories?.length);
  check('Chinese categories are built', Array.isArray(catalog.categoriesZh) && catalog.categoriesZh.length > 5, catalog.categoriesZh?.length);
  check('Chinese categories are actually Chinese', catalog.categoriesZh?.some((facet) => /[\u4e00-\u9fff]/.test(facet.category)), catalog.categoriesZh?.slice(0, 2));
  check('the build names the curated upstream it read', Array.isArray(catalog.sources) && catalog.sources.some((source) => source.ok === true), catalog.sources);
  check('the build reports its transport', typeof catalog.transport?.kind === 'string' && typeof catalog.transport?.authenticated === 'boolean', catalog.transport);
  check('an anonymous build does not claim to be authenticated', catalog.transport?.authenticated === false, catalog.transport);
  check('anonymous by default', catalog.token === false, catalog.token);
  check('the catalog reports its data timestamps', typeof catalog.statsAt === 'string' && catalog.statsAt !== '' && typeof catalog.downloadsAt === 'string' && catalog.downloadsAt !== '', { statsAt: catalog.statsAt, downloadsAt: catalog.downloadsAt });
  check('the catalog reports a version count', typeof catalog.versionCount === 'number' && catalog.versionCount > 0, catalog.versionCount);
  check('the catalog lists its display languages', Array.isArray(catalog.languages) && catalog.languages.includes('zh') && catalog.languages.includes('en') && catalog.defaultLanguage === 'zh', { languages: catalog.languages, defaultLanguage: catalog.defaultLanguage });
  console.log(`        catalog: ${catalog.total} plugins, top category ${catalog.categories?.[0]?.category} (${catalog.categories?.[0]?.count}) / ${catalog.categoriesZh?.[0]?.category} (${catalog.categoriesZh?.[0]?.count})`);
  console.log(`        transport: ${catalog.transport?.kind} / ${catalog.transport?.name}; data ${catalog.statsAt} / ${catalog.downloadsAt}`);

  console.log('\n[4] /find paging, sorting, filtering and language');
  const find = (params) => get(routeOf(a, 'find'), `${PREFIX}/find`, params);
  page1 = await (await find({ sort: 'stars', lang: 'zh' })).json();
  check('page 1 ok', page1.ok === true, page1);
  check('the page is the requested page', page1.page === 1, page1.page);
  check('the page size is inside the documented range', page1.pageSize >= 12 && page1.pageSize <= 96, page1.pageSize);
  check('the page honours its own page size', page1.entries.length === Math.min(page1.pageSize, page1.total), { got: page1.entries.length, pageSize: page1.pageSize, total: page1.total });
  check('totalPages is computed by the Host', page1.totalPages === Math.max(1, Math.ceil(page1.total / page1.pageSize)), { totalPages: page1.totalPages, total: page1.total, pageSize: page1.pageSize });
  check('totalPages is at least 1', page1.totalPages >= 1, page1.totalPages);
  check('the default language is Chinese', page1.language === 'zh', page1.language);
  const first = page1.entries[0];
  // The contract is explicit: `spec` is already the easiest install form, and it
  // must be the form `dsh plugin add` itself accepts — a bare package name for
  // a registry package (`InstallSpecKind` has no `npm:` scheme), a bare URL for
  // a published tarball, and `github:<owner>/<repo>` only for a real repository.
  check('entry carries a canonical install spec', typeof first?.spec === 'string' && /^(github:[\w.-]+\/[\w.-]+|https?:\/\/\S+|[^\s:]+\/[^\s:]+(@\S+)?|[^\s:@]+(@\S+)?)$/.test(first.spec), first?.spec);
  check('no spec invents an npm:/tarball: scheme', !/^(npm|tarball):/i.test(first?.spec ?? ''), first?.spec);
  check('an npm-backed row spells its spec as the bare package name', typeof first?.npm !== 'string' || first.npm === '' || first.spec === first.npm, { npm: first?.npm, spec: first?.spec });
  check('entry carries a repo identity', typeof first?.repo === 'string' && first.repo.includes('/'), first?.repo);
  check('entry carries the documented fields', ['description', 'category', 'categoryId', 'version', 'capabilities', 'redLines', 'scanned', 'installed', 'inCatalog', 'author'].every((key) => first !== undefined && key in first), Object.keys(first ?? {}));
  check('entry carries trust data', typeof first?.scanned === 'boolean' && Array.isArray(first?.capabilities) && Array.isArray(first?.redLines), Object.keys(first ?? {}));
  check('stars are descending (unknown last)', numericDescending(page1.entries, 'stars') === null, numericDescending(page1.entries, 'stars'));
  check('Chinese rows are marked translated', page1.entries.some((entry) => entry.translated === true), page1.entries.slice(0, 3).map((entry) => [entry.repo, entry.translated]));
  console.log(`        first: ${first?.repo} (${first?.spec}) stars=${first?.stars} · ${first?.category} · ${String(first?.description).slice(0, 50)}`);

  const page2 = await (await find({ sort: 'stars', lang: 'zh', page: 2 })).json();
  check('page 2 differs from page 1', page2.entries[0]?.repo !== first?.repo, [first?.repo, page2.entries[0]?.repo]);
  check('page 2 keeps the same total', page2.total === page1.total, { page1: page1.total, page2: page2.total });

  const far = await (await find({ sort: 'stars', lang: 'zh', page: page1.totalPages + 10 })).json();
  check('an out-of-range page is empty', Array.isArray(far.entries) && far.entries.length === 0, far.entries?.length);
  check('an out-of-range page keeps a sane total', far.total === page1.total && far.totalPages === page1.totalPages, { total: far.total, totalPages: far.totalPages });
  check('an out-of-range page echoes the requested page', far.page === page1.totalPages + 10, far.page);
  const pageZero = await (await find({ sort: 'stars', lang: 'zh', page: 0 })).json();
  check('page 0 is clamped to page 1', pageZero.page === 1, pageZero.page);

  const downloadsPage = await (await find({ sort: 'downloads', lang: 'zh', pageSize: 96 })).json();
  check('downloads sort is descending (unknown last)', numericDescending(downloadsPage.entries, 'downloads') === null, numericDescending(downloadsPage.entries, 'downloads'));

  const byCategory = await (await find({ cat: catalog.categories[0].category, sort: 'downloads', lang: 'en', pageSize: 96 })).json();
  check('the English category filter applies', byCategory.entries.every((entry) => entry.category === catalog.categories[0].category), byCategory.entries.slice(0, 3).map((entry) => entry.category));
  check('the category total matches its facet count', byCategory.total === catalog.categories[0].count, { total: byCategory.total, facet: catalog.categories[0].count });
  check('the category page is sorted by downloads', numericDescending(byCategory.entries, 'downloads') === null, numericDescending(byCategory.entries, 'downloads'));

  const zhCategory = await (await find({ cat: catalog.categoriesZh[0].category, sort: 'stars', lang: 'zh', pageSize: 96 })).json();
  check('the Chinese category filter applies', zhCategory.entries.every((entry) => entry.category === catalog.categoriesZh[0].category), zhCategory.entries.slice(0, 2).map((entry) => entry.category));
  check('the Chinese category total matches its facet count', zhCategory.total === catalog.categoriesZh[0].count, { total: zhCategory.total, facet: catalog.categoriesZh[0].count });

  // Same query, both languages: the row order and identity must not move.
  const zhPage = await (await find({ q: 'memory', sort: 'stars', lang: 'zh' })).json();
  const english = await (await find({ q: 'memory', sort: 'stars', lang: 'en' })).json();
  check('the English projection switches language', english.language === 'en', english.language);
  check('both projections describe the same repositories', english.entries.slice(0, 5).map((entry) => entry.repo).join(',') === zhPage.entries.slice(0, 5).map((entry) => entry.repo).join(','), { zh: zhPage.entries.slice(0, 2).map((entry) => entry.repo), en: english.entries.slice(0, 2).map((entry) => entry.repo) });
  const differing = zhPage.entries.filter((entry) => {
    const other = english.entries.find((candidate) => candidate.repo === entry.repo);
    return other !== undefined && (other.description !== entry.description || other.category !== entry.category);
  });
  check('the two languages carry different authored text', differing.length > 0, differing.slice(0, 2).map((entry) => entry.repo));

  // A Chinese term must find a row whose Chinese blurb carries it, even though
  // the repository names are ASCII.
  const chineseRow = page1.entries.find((entry) => entry.translated === true && /[\u4e00-\u9fff]{2,}/.test(entry.description));
  if (chineseRow === undefined) {
    console.log('  SKIP  the first page carries no Chinese blurb to search for');
  } else {
    const term = /[\u4e00-\u9fff]{2,}/.exec(chineseRow.description)[0].slice(0, 2);
    const chineseQuery = await (await find({ q: term, lang: 'zh' })).json();
    check('a Chinese query matches the Chinese text', chineseQuery.ok === true && chineseQuery.total > 0, { term, total: chineseQuery.total });
    const exact = await (await find({ q: chineseRow.repo, lang: 'zh' })).json();
    check('a full repo query narrows to one row', exact.total === 1 && exact.entries[0]?.repo === chineseRow.repo, { total: exact.total, repo: exact.entries[0]?.repo });
    console.log(`        zh query "${term}" -> ${chineseQuery.total} hits`);
  }

  const sized = await (await find({ sort: 'stars', pageSize: 12 })).json();
  check('pageSize=12 is honoured', sized.pageSize === 12 && sized.entries.length === 12, { pageSize: sized.pageSize, entries: sized.entries.length });
  const wide = await (await find({ sort: 'stars', pageSize: 96 })).json();
  check('pageSize=96 is honoured', wide.pageSize === 96 && wide.entries.length === 96, { pageSize: wide.pageSize, entries: wide.entries.length });
  const clamped = await (await find({ sort: 'stars', pageSize: 9999 })).json();
  check('an oversized pageSize stays inside the documented range', clamped.pageSize >= 12 && clamped.pageSize <= 96 && clamped.entries.length === clamped.pageSize, { pageSize: clamped.pageSize, entries: clamped.entries.length });

  console.log('\n[4b] counts are honest: unknown is null, never 0');
  // The catalog index is re-read here only to know which rows genuinely have no
  // upstream star count, and which one carries a specific number. One request,
  // no GitHub quota.
  try {
    const indexResponse = await fetch('https://awesome-dsh-plugin.com/plugins.json', {
      headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-market-verify' },
      signal: AbortSignal.timeout(30000),
    });
    const index = JSON.parse(await indexResponse.text());
    const plugins = Array.isArray(index.plugins) ? index.plugins : [];
    const repoOf = (plugin) => {
      const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/.exec(String(plugin?.url ?? ''));
      return match === null ? null : `${match[1]}/${match[2]}`;
    };
    const skipped = new Set(['deepseek-ai', 'awesome-dsh-plugin', 'dsh-market']);
    const candidates = plugins
      .map((plugin) => ({ plugin, repo: repoOf(plugin) }))
      .filter((candidate) => candidate.repo !== null && !skipped.has(candidate.repo.split('/')[0]));
    const unknown = candidates.filter((candidate) => candidate.plugin.stars === undefined || candidate.plugin.stars === null || candidate.plugin.stars === '');
    const known = candidates.filter((candidate) => typeof candidate.plugin.stars === 'number').sort((left, right) => right.plugin.stars - left.plugin.stars);
    // The two spec derivations the contract names explicitly: an npm package
    // installs from its bare package name, and a published tarball from its
    // bare URL.
    const npmBacked = candidates.filter((candidate) => typeof candidate.plugin.npm === 'string' && candidate.plugin.npm !== '');
    const tarballBacked = candidates.filter((candidate) => typeof candidate.plugin.tarball === 'string' && candidate.plugin.tarball !== '' && (typeof candidate.plugin.npm !== 'string' || candidate.plugin.npm === ''));
    const fromIndex = Array.isArray(catalog.sources) && catalog.sources.some((source) => source.name === 'plugins' && source.ok === true);
    if (!fromIndex) {
      console.log('  SKIP  the build fell back to the repository files, so the published index is not its source');
    } else if (unknown.length === 0 || known.length === 0) {
      console.log('  SKIP  the published index no longer carries both kinds of row');
    } else {
      const lookup = async (repo) => {
        const body = await (await find({ q: repo, lang: 'en', pageSize: 96 })).json();
        return (body.entries ?? []).find((entry) => entry.repo === repo) ?? null;
      };
      for (const candidate of unknown.slice(0, 3)) {
        const row = await lookup(candidate.repo);
        if (row === null) {
          check(`a row with no upstream star count is still listed (${candidate.repo})`, false, 'not found');
          continue;
        }
        check(`a row with no upstream star count reports null (${candidate.repo})`, row.stars === null, { stars: row.stars });
      }
      for (const candidate of known.slice(0, 2)) {
        const row = await lookup(candidate.repo);
        if (row === null) {
          check(`a row with an upstream star count is still listed (${candidate.repo})`, false, 'not found');
          continue;
        }
        check(`a row with an upstream star count reports it (${candidate.repo})`, row.stars === candidate.plugin.stars, { catalog: row.stars, upstream: candidate.plugin.stars });
      }
      console.log(`        ${unknown.length} rows without upstream stars, ${known.length} with; checked a sample of each`);

      // Spot-check the two spec forms the contract spells out.
      for (const candidate of npmBacked.slice(0, 2)) {
        const row = await lookup(candidate.repo);
        check(`an npm-backed row spells its spec as the bare package name (${candidate.repo})`, row?.spec === candidate.plugin.npm, { spec: row?.spec, npm: candidate.plugin.npm });
      }
      for (const candidate of tarballBacked.slice(0, 2)) {
        const row = await lookup(candidate.repo);
        check(`a tarball-backed row spells its spec as the bare tarball URL (${candidate.repo})`, row?.spec === candidate.plugin.tarball, { spec: row?.spec, tarball: candidate.plugin.tarball });
      }
      console.log(`        ${npmBacked.length} npm-backed rows, ${tarballBacked.length} tarball-only rows; spot-checked both`);
    }
  } catch (error) {
    console.log(`  SKIP  the published index could not be re-read for the honesty cross-check (${error.message})`);
  }

  console.log('\n[5] live stats refresh (POST /stats)');
  const statRepos = page1.entries.filter((entry) => typeof entry.stars === 'number').slice(0, 2).map((entry) => entry.repo);
  const BOGUS_REPO = 'dsh-market-verify/definitely-not-a-real-repository-zzz';
  const statsResponse = await post(routeOf(a, 'stats'), `${PREFIX}/stats`, { repos: [...statRepos, BOGUS_REPO] });
  const statsBody = await statsResponse.json();
  check('status 200', statsResponse.status === 200, statsResponse.status);
  check('ok', statsBody.ok === true, statsBody);
  // The anonymous search allowance is 10/minute for the whole machine, and the
  // sections above spend from it. When it is spent the Host reports the repos
  // as `failed` with `remaining: 0` — the honest answer — so this positive
  // assertion is skipped rather than turned into a false failure. The
  // "no fabricated 0" assertions below still run either way.
  const statsExhausted = statsBody.remaining === 0
    && statRepos.every((repo) => statsBody.stats?.[repo] === undefined);
  if (statsExhausted) {
    console.log('  SKIP  the anonymous search allowance is spent; the positive live-stats path was not exercised');
  } else {
    check('a batch of real repositories gets live stars', statRepos.length > 0 && statRepos.every((repo) => typeof statsBody.stats?.[repo]?.stars === 'number'), { stats: statsBody.stats, failed: statsBody.failed, remaining: statsBody.remaining });
  }
  check('failed is an array', Array.isArray(statsBody.failed), statsBody.failed);
  check('a bogus repository lands in failed', statsBody.failed.includes(BOGUS_REPO), statsBody.failed);
  check('a bogus repository gets no fabricated 0', statsBody.stats?.[BOGUS_REPO] === undefined, statsBody.stats?.[BOGUS_REPO]);
  check('the stats response reports whether a token was used', typeof statsBody.authenticated === 'boolean', statsBody.authenticated);
  console.log(`        ${statRepos.map((repo) => `${repo}=${statsBody.stats?.[repo]?.stars ?? '?'}`).join(', ')}; failed=${statsBody.failed.length}`);

  console.log('\n[6] detail: version history, author and problems (POST /detail)');
  npmRow = page1.entries.find((entry) => typeof entry.npm === 'string' && entry.npm !== '' && typeof entry.version === 'string' && entry.version !== '');
  if (npmRow === undefined) {
    console.log('  SKIP  the first page carries no npm-backed row');
  } else {
    const detailResponse = await post(routeOf(a, 'detail'), `${PREFIX}/detail`, { repo: npmRow.repo, npm: npmRow.npm, spec: npmRow.spec });
    const detail = await detailResponse.json();
    check('status 200', detailResponse.status === 200, detailResponse.status);
    check('ok', detail.ok === true, detail);
    check('the repository is echoed', detail.repo === npmRow.repo, { want: npmRow.repo, got: detail.repo });
    check('the npm package is echoed', detail.npm === npmRow.npm, { want: npmRow.npm, got: detail.npm });
    check('latestVersion is present', typeof detail.latestVersion === 'string' && detail.latestVersion !== '', detail.latestVersion);
    check('versions is a non-empty array', Array.isArray(detail.versions) && detail.versions.length > 0, detail.versions?.length);
    check('at most 30 versions are returned', detail.versions.length <= 30, detail.versions.length);
    check('versions are sorted newest first', versionTimesDescending(detail.versions) === null, versionTimesDescending(detail.versions));
    const newest = detail.versions[0];
    check('the newest version carries version/at/source', typeof newest?.version === 'string' && newest.version !== '' && typeof newest?.at === 'string' && newest.at !== '' && typeof newest?.source === 'string' && newest.source !== '', newest);
    check('every version names its source', detail.versions.every((version) => typeof version.version === 'string' && version.version !== '' && typeof version.source === 'string' && version.source !== ''), detail.versions.slice(0, 2));
    check('the author carries a non-empty avatar URL', typeof detail.author?.login === 'string' && detail.author.login !== '' && /^https:\/\/.+/.test(String(detail.author?.avatar)), detail.author);
    check('problems is an array', Array.isArray(detail.problems), detail.problems);
    check('stats are attached with their source', detail.stats !== null && typeof detail.stats === 'object' && typeof detail.stats.source === 'string', detail.stats);
    console.log(`        ${detail.repo}: latest=${detail.latestVersion}, ${detail.versions.length} versions, author=${detail.author?.login}, problems=${detail.problems.length}`);
    const badDetail = await post(routeOf(a, 'detail'), `${PREFIX}/detail`, {});
    check('detail with no identity at all -> 400', badDetail.status === 400, badDetail.status);
    // A malformed repo is not an identity, but it is also not a crash: the Host
    // treats it as absent and falls back to the package name it was given. Only
    // a request with no usable identity is refused.
    const badRepo = await post(routeOf(a, 'detail'), `${PREFIX}/detail`, { repo: 'not a repo' });
    check('detail with only a malformed repo -> 400', badRepo.status === 400, badRepo.status);
    // 0.06: an installed `link:` bundle knows only its package name, so a
    // name-only request must answer rather than being refused.
    const byName = await post(routeOf(a, 'detail'), `${PREFIX}/detail`, { name: npmRow.name, npm: npmRow.npm });
    const byNameBody = await byName.json();
    check('detail with only a package name is accepted', byName.status === 200 && byNameBody.ok === true, byNameBody);
    check('a name-only detail resolves the repository', typeof byNameBody.repo === 'string' && byNameBody.repo.includes('/'), byNameBody.repo);
    check('a name-only detail agrees with the repo query on latestVersion', byNameBody.latestVersion === detail.latestVersion, { name: byNameBody.latestVersion, repo: detail.latestVersion });
    // The review block must arrive here too: the drawer is shared, so a detail
    // request that skipped the review index would silently lose a whole section.
    check('detail carries the review block (shared drawer contract)', byNameBody.review === null || typeof byNameBody.review === 'object', byNameBody.review);
    check('detail reports whether the review index loaded', typeof byNameBody.reviewLoaded === 'boolean', byNameBody.reviewLoaded);
    console.log(`        name-only: ${byNameBody.repo} latest=${byNameBody.latestVersion} review=${byNameBody.review?.verdict ?? 'none'}`);
  }

  console.log('\n[6b] installed version and staleness on a catalog row');
  // The same harness keeps the catalog it already built, so this costs no
  // second upstream read.
  const versioned = page1.entries.find((entry) => {
    const numbers = versionNumbers(entry.version);
    return typeof entry.npm === 'string' && entry.npm !== '' && numbers !== null && (numbers[0] > 0 || numbers[1] > 0 || numbers[2] > 1);
  });
  if (versioned === undefined) {
    console.log('  SKIP  no versioned npm row on the first page');
  } else {
    a.bundles.push({ name: versioned.npm, version: '0.0.1', description: 'Verification', enabled: true, installed: true, removable: true, rows: [] });
    await get(routeOf(a, 'installed'), `${PREFIX}/installed`);
    const page = await (await find({ q: versioned.repo, lang: 'zh', pageSize: 96 })).json();
    const row = (page.entries ?? []).find((entry) => entry.repo === versioned.repo);
    check('the installed version is attached to the row', row?.installedVersion === '0.0.1', { repo: row?.repo, installedVersion: row?.installedVersion });
    check('a newer catalog version is flagged as stale', row?.outdated === true, { catalog: row?.version, installed: row?.installedVersion });
    // The wide category page still carries the uninstalled rows around it.
    const mixed = await (await find({ sort: 'stars', lang: 'zh', pageSize: 96 })).json();
    check('an uninstalled row reports an empty installed version', mixed.entries.some((entry) => entry.installed !== true && entry.installedVersion === ''), mixed.entries.slice(0, 3).map((entry) => [entry.repo, entry.installedVersion]));
    check('the installed row is the only one marked installed', mixed.entries.filter((entry) => entry.installed === true).map((entry) => entry.repo).join(',') === versioned.repo, mixed.entries.filter((entry) => entry.installed === true).map((entry) => entry.repo));
    console.log(`        ${versioned.repo}: catalog v${versioned.version} vs installed v0.0.1 -> outdated=${row?.outdated}`);
  }

  console.log('\n[7] GitHub repository search (GET /github)');
  const gh = await (await get(routeOf(a, 'github'), `${PREFIX}/github`, { q: 'dsh-plugin in:name,description' })).json();
  if (gh.ok !== true && gh.code === 'rate-limited') {
    // Real GitHub behaviour: the unauthenticated search allowance is 10/min.
    // The route must report that as data, not as a thrown failure.
    check('a rate limit is reported as data', gh.authenticated === false && Number.isFinite(gh.reset), gh);
    console.log(`  SKIP  GitHub search is rate-limited until epoch ${gh.reset}; the positive path was not exercised`);
  } else {
    check('search succeeded', gh.ok === true, gh);
    check('returned repositories', Array.isArray(gh.entries) && gh.entries.length > 0, gh.entries?.length);
    check('repository carries a github spec', String(gh.entries?.[0]?.spec).startsWith('github:'), gh.entries?.[0]?.spec);
    check('paging metadata is reported', gh.page === 1 && gh.pageSize === 30 && gh.totalPages >= 1, { page: gh.page, pageSize: gh.pageSize, totalPages: gh.totalPages });
    check('reports whether a token was used', typeof gh.authenticated === 'boolean', gh.authenticated);
    const inCatalog = gh.entries?.filter((entry) => entry.inCatalog === true) ?? [];
    const searchOnly = gh.entries?.filter((entry) => entry.inCatalog !== true) ?? [];
    check('scan data only comes from the catalog', gh.entries?.every((entry) => entry.scanned !== true || entry.inCatalog === true), gh.entries?.map((entry) => [entry.repo, entry.inCatalog, entry.scanned]));
    check('catalog hits keep a canonical install spec', inCatalog.every((entry) => /^(github:[\w.-]+\/[\w.-]+|https?:\/\/\S+|[^\s:]+\/[^\s:]+(@\S+)?|[^\s:@]+(@\S+)?)$/.test(entry.spec)), inCatalog.map((entry) => entry.spec));
    check('no catalog hit invents an npm:/tarball: scheme', inCatalog.every((entry) => !/^(npm|tarball):/i.test(entry.spec)), inCatalog.map((entry) => entry.spec));
    check('search-only rows are flagged unscanned', searchOnly.every((entry) => entry.scanned === false && entry.capabilities.length === 0), searchOnly.map((entry) => [entry.repo, entry.scanned]));
    console.log(`        github: ${gh.entries?.length} repos, ${inCatalog.length} enriched from the catalog, rate left ${gh.remaining}`);
  }
}

// GitHub search refuses an empty query without spending a request.
const emptyQuery = await get(routeOf(a, 'github'), `${PREFIX}/github`, {});
check('an empty GitHub query is refused -> 400', emptyQuery.status === 400, emptyQuery.status);

console.log('\n[8] installed bundles, their kind and their directory');
const b = harness({
  phases: { 'e-a': 'active', 'e-b': 'failed', 'e-g': 'active' },
  bundles: [
    // Two rows, one active and one failed: still in service.
    { name: 'demo-bundle', version: '1.2.3', description: 'Demo', enabled: true, installed: true, removable: true, rows: [{ rowId: 'r-a', entryId: 'e-a' }, { rowId: 'r-b', entryId: 'e-b' }] },
    // Switched off on purpose.
    { name: 'linked-thing', version: '1.0.0', description: 'Linked', enabled: false, installed: true, removable: true, rows: [{ rowId: 'r-c', entryId: 'e-c' }] },
    // Switched on, but nothing of it runs: the "force majeure" case.
    { name: 'silent-bundle', version: '3.0.0', description: 'On but absent', enabled: true, installed: true, removable: true, rows: [{ rowId: 'r-d', entryId: 'e-d' }] },
    // Installed from a repository rather than a registry.
    { name: 'git-thing', version: '0.0.0-git', description: 'From a repo', enabled: true, installed: true, removable: true, rows: [{ rowId: 'r-g', entryId: 'e-g' }] },
    { name: 'not-installed', enabled: false, installed: false, removable: false, rows: [] },
  ],
});
host.apply(b.ctx, {});
const installedResponse = await get(routeOf(b, 'installed'), `${PREFIX}/installed`);
check('responses are JSON', String(installedResponse.headers.get('content-type')).includes('application/json'), installedResponse.headers.get('content-type'));
check('responses are never cached', String(installedResponse.headers.get('cache-control')).includes('no-store'), installedResponse.headers.get('cache-control'));
const installed = await installedResponse.json();
check('status 200', installed.ok === true, installed);
check('installed bundles plus an unselected dependency are listed', installed.bundles.length === 5, installed.bundles.map((row) => row.name));
const registryRow = installed.bundles.find((row) => row.name === 'demo-bundle');
const localRow = installed.bundles.find((row) => row.name === 'linked-thing');
const silentRow = installed.bundles.find((row) => row.name === 'silent-bundle');
const gitRow = installed.bundles.find((row) => row.name === 'git-thing');
const orphanRow = installed.bundles.find((row) => row.name === 'orphan-bundle');
check('row count is carried', registryRow?.rows === 2, registryRow);
check('a registry dependency is classified as registry', registryRow?.kind === 'registry', registryRow);
check('a link: dependency is classified as local source', localRow?.kind === 'local', localRow);
check('a github: dependency is classified as git', gitRow?.kind === 'git', gitRow);
check('enabled state is reported per bundle', registryRow?.enabled === true && localRow?.enabled === false, [registryRow?.enabled, localRow?.enabled]);

console.log('\n[8b] installed-but-not-in-service detection');
check('one live row makes a bundle count as running', registryRow?.running === true && registryRow?.reason === null, registryRow);
check('a partially failing bundle is reported as partial', registryRow?.partial === true && registryRow?.failedRows === 1, registryRow);
check('disabled bundles are reported as disabled', localRow?.running === false && localRow?.reason === 'disabled', localRow);
check('enabled bundles with no live row are reported as not running', silentRow?.running === false && silentRow?.reason === 'not-running' && silentRow.liveRows === 0 && silentRow.rows === 1, silentRow);
check('a dependency that was never selected is reported', orphanRow?.running === false && orphanRow?.reason === 'not-selected', orphanRow);
check('an unselected dependency is not offered for removal', orphanRow?.removable === false, orphanRow?.removable);
check('running bundles are the ones the window groups as enabled', installed.bundles.filter((row) => row.running === true).map((row) => row.name).sort().join(',') === 'demo-bundle,git-thing');

// A bundle whose every row failed must be diagnosed as a load failure.
const broken = harness({
  phases: { 'e-x': 'failed' },
  bundles: [{ name: 'broken-bundle', version: '1.0.0', enabled: true, installed: true, removable: true, rows: [{ rowId: 'r-x', entryId: 'e-x' }] }],
});
host.apply(broken.ctx, {});
const brokenRows = await (await get(routeOf(broken, 'installed'), `${PREFIX}/installed`)).json();
check('a failed activation is diagnosed as failed', brokenRows.bundles[0]?.reason === 'failed' && brokenRows.bundles[0]?.running === false, brokenRows.bundles[0]);

// An enabled bundle that declares no rows can never appear in the UI.
const empty = harness({
  bundles: [{ name: 'empty-bundle', version: '1.0.0', enabled: true, installed: true, removable: true, rows: [] }],
});
host.apply(empty.ctx, {});
const emptyRows = await (await get(routeOf(empty, 'installed'), `${PREFIX}/installed`)).json();
check('an enabled bundle with no rows is diagnosed as no-rows', emptyRows.bundles[0]?.reason === 'no-rows', emptyRows.bundles[0]);
console.log(`        not-in-service: ${installed.bundles.filter((row) => row.running !== true).map((row) => `${row.name}=${row.reason}`).join(', ')}`);

// Profile installations must report where they actually live, because that is
// never the hand-made source folder a user keeps plugins in.
const dir = registryRow?.dir;
check('install directory is reported', typeof dir === 'string' && dir.startsWith(FAKE_PROFILE) && dir.endsWith(`node_modules${process.platform === 'win32' ? '\\' : '/'}demo-bundle`), dir);
console.log(`        installed dir: ${dir}`);

console.log('\n[8c] resolving the profile manifest without DSH_PROFILE_DIR');
// A desktop shortcut starts with a bare environment, so the launcher variable
// may be missing; the settings service must stand in for it.
const savedProfileDir = process.env.DSH_PROFILE_DIR;
delete process.env.DSH_PROFILE_DIR;
const viaSettings = harness({
  profileDir: FAKE_PROFILE,
  bundles: [{ name: 'demo-bundle', version: '1.2.3', enabled: true, installed: true, removable: true, rows: [] }],
});
host.apply(viaSettings.ctx, {});
const viaSettingsBody = await (await get(routeOf(viaSettings, 'installed'), `${PREFIX}/installed`)).json();
check('the profile directory is recovered from the settings service', viaSettingsBody.specResolved === true, viaSettingsBody.specResolved);
check('the manifest still yields the declared spec and kind', viaSettingsBody.bundles[0]?.spec === '^1.2.3' && viaSettingsBody.bundles[0]?.kind === 'registry', viaSettingsBody.bundles[0]);

const blind = harness({ bundles: [{ name: 'demo-bundle', version: '1.2.3', enabled: true, installed: true, removable: true, rows: [] }] });
host.apply(blind.ctx, {});
const blindBody = await (await get(routeOf(blind, 'installed'), `${PREFIX}/installed`)).json();
// With neither source the window must be told, so it can say why no version is
// known instead of showing "cannot check" for every row.
check('an unreadable manifest is reported to the window', blindBody.specResolved === false, blindBody.specResolved);
check('an unreadable manifest leaves the spec empty', blindBody.bundles[0]?.spec === '', blindBody.bundles[0]?.spec);
process.env.DSH_PROFILE_DIR = savedProfileDir;

console.log('\n[9] inspect / install / remove drive pluginManager');
const c = harness({ bundle: true, pendingBuilds: ['esbuild'] });
host.apply(c.ctx, {});
const inspectResponse = await post(routeOf(c, 'inspect'), `${PREFIX}/inspect`, { spec: 'github:demo/plugin' });
const inspection = await inspectResponse.json();
check('inspect returns the inspection', inspectResponse.status === 200 && inspection.inspection?.status === 'accepted', inspection);
check('inspect reports bundle state', inspection.inspection?.bundle === true, inspection.inspection);

const installResponse = await post(routeOf(c, 'install'), `${PREFIX}/install`, { spec: 'github:demo/plugin' });
const installedResult = await installResponse.json();
check('install succeeded', installResponse.status === 200 && installedResult.result?.application === 'applied', installedResult);
check('install echoes the spec and a requestId', installedResult.spec === 'github:demo/plugin' && typeof installedResult.requestId === 'string' && installedResult.requestId !== '', { spec: installedResult.spec, requestId: installedResult.requestId });
check('install enables the bundle', c.calls.install[0]?.options?.enabled === true, c.calls.install[0]?.options);
check('install passes no build approval by default', c.calls.install[0]?.options?.approvedBuilds === undefined, c.calls.install[0]?.options);
check('pending builds are surfaced', JSON.stringify(installedResult.result?.pendingBuilds) === JSON.stringify(['esbuild']), installedResult.result?.pendingBuilds);
check('package output is trimmed but kept', typeof installedResult.result?.packageResult?.output === 'string' && installedResult.result.packageResult.output.length > 0);

await post(routeOf(c, 'install'), `${PREFIX}/install`, { spec: 'github:demo/plugin', approvedBuilds: ['esbuild'] });
check('approved builds reach pluginManager', JSON.stringify(c.calls.install[1]?.options?.approvedBuilds) === JSON.stringify(['esbuild']), c.calls.install[1]?.options);

const removeResponse = await post(routeOf(c, 'remove'), `${PREFIX}/remove`, { name: 'demo-bundle' });
const removed = await removeResponse.json();
check('remove succeeded', removeResponse.status === 200 && removed.result?.application === 'applied', removed);
check('remove names the bundle', c.calls.remove[0]?.name === 'demo-bundle', c.calls.remove[0]);

console.log('\n[10] install progress stream (POST /install + GET /install-progress)');
const progressHarness = harness({
  installScript: async ({ spec, requestId, emitState, emitLog }) => {
    // The same event names the real manager emits, carrying the requestId the
    // Host handed it.
    emitState('installing', { registry: 'https://registry.npmjs.org/', index: 1, total: 1 });
    emitLog('Progress: resolved 1, reused 1, downloaded 0\n');
    await delay(50);
    emitLog('Progress: resolved 2, reused 2, downloaded 0\n');
    emitState('applying');
    await delay(50);
    return {
      changed: true,
      application: 'applied',
      stage: 'install',
      target: spec,
      enabled: true,
      bundle: 'demo-bundle',
      packageResult: { exitCode: 0, output: 'added 1 package', truncated: false, logPath: 'C:/tmp/pnpm.log' },
    };
  },
});
host.apply(progressHarness.ctx, {});
const REQUEST_ID = 'pm-verify-progress-1';
const installPromise = post(routeOf(progressHarness, 'install'), `${PREFIX}/install`, { spec: 'npm:demo-progress', requestId: REQUEST_ID });

const polls = [];
let cursor = 0;
const pollDeadline = Date.now() + 8000;
while (Date.now() < pollDeadline) {
  const requestedFrom = cursor;
  const body = await (await get(routeOf(progressHarness, 'install-progress'), `${PREFIX}/install-progress`, { requestId: REQUEST_ID, from: requestedFrom })).json();
  polls.push({ from: requestedFrom, body });
  if (body.found === true) {
    cursor = body.nextSeq;
    if (body.phase === 'done' && body.result !== null) break;
  }
  await delay(10);
}
const installBody = await (await installPromise).json();
const progressPolls = polls.filter((poll) => poll.body.found === true);
const phases = progressPolls.map((poll) => poll.body.phase);
const delivered = progressPolls.flatMap((poll) => poll.body.lines ?? []);
const deliveredSeqs = delivered.map((line) => line.seq);
const finalView = progressPolls.at(-1)?.body;

check('the install response succeeded', installBody.ok === true && installBody.result?.application === 'applied', installBody);
check('the install response carries the requestId', installBody.requestId === REQUEST_ID, installBody.requestId);
check('the requestId reaches pluginManager', progressHarness.calls.install[0]?.options?.requestId === REQUEST_ID, progressHarness.calls.install[0]?.options);
check('the progress record exists while the install runs', progressPolls.length > 0, polls.map((poll) => poll.body));
check('a running phase is reported', phases.includes('installing') || phases.includes('applying'), phases);
check('the phase transitions reach done', finalView?.phase === 'done', phases);
check('the registry attempt is reported', progressPolls.some((poll) => typeof poll.body.attempt?.index === 'number' && typeof poll.body.attempt?.total === 'number'), progressPolls.map((poll) => poll.body.attempt));
check('log lines are delivered', delivered.length === 2, delivered);
check('every line carries seq/stream/text', delivered.every((line) => Number.isInteger(line.seq) && typeof line.stream === 'string' && typeof line.text === 'string'), delivered);
check('lines are delivered incrementally via from', progressPolls.every((poll) => (poll.body.lines ?? []).every((line) => line.seq >= poll.from)), progressPolls.map((poll) => ({ from: poll.from, seqs: (poll.body.lines ?? []).map((line) => line.seq) })));
check('no line is delivered twice', new Set(deliveredSeqs).size === deliveredSeqs.length, deliveredSeqs);
check('nextSeq advances past the last line', finalView?.nextSeq > Math.max(...deliveredSeqs), { nextSeq: finalView?.nextSeq, last: Math.max(...deliveredSeqs) });
check('the final result is attached to the progress view', finalView?.result !== null && finalView?.result?.application === 'applied', finalView?.result);
check('the progress view reports its timing', typeof finalView?.startedAt === 'number' && typeof finalView?.elapsedMs === 'number', { startedAt: finalView?.startedAt, elapsedMs: finalView?.elapsedMs });

const tailFrom = deliveredSeqs.length >= 2 ? deliveredSeqs[1] : finalView?.nextSeq;
const tail = await (await get(routeOf(progressHarness, 'install-progress'), `${PREFIX}/install-progress`, { requestId: REQUEST_ID, from: tailFrom })).json();
check('from selects the unseen tail', (tail.lines ?? []).length === 0 || tail.lines[0].seq === tailFrom, { from: tailFrom, lines: tail.lines });
const replay = await (await get(routeOf(progressHarness, 'install-progress'), `${PREFIX}/install-progress`, { requestId: REQUEST_ID, from: finalView?.nextSeq })).json();
check('polling from nextSeq returns no already-seen lines', (replay.lines ?? []).length === 0, replay.lines);
console.log(`        phases: ${phases.join(' -> ')}; lines: ${deliveredSeqs.join(',')}`);

// The requestId is optional: without one the Host mints it and reports it back.
const generatedInstall = await (await post(routeOf(progressHarness, 'install'), `${PREFIX}/install`, { spec: 'npm:demo-generated' })).json();
check('the Host generates a requestId when none is given', typeof generatedInstall.requestId === 'string' && generatedInstall.requestId.startsWith('pm-'), generatedInstall.requestId);
check('the generated requestId reaches pluginManager', progressHarness.calls.install.at(-1)?.options?.requestId === generatedInstall.requestId, progressHarness.calls.install.at(-1)?.options);
const generatedProgress = await (await get(routeOf(progressHarness, 'install-progress'), `${PREFIX}/install-progress`, { requestId: generatedInstall.requestId, from: 0 })).json();
check('progress is readable for the generated requestId', generatedProgress.found === true && generatedProgress.phase === 'done', generatedProgress);

const unknownProgress = await (await get(routeOf(progressHarness, 'install-progress'), `${PREFIX}/install-progress`, { requestId: 'pm-never-existed', from: 0 })).json();
check('an unknown requestId reports found:false', unknownProgress.found === false, unknownProgress);
const noRequestId = await get(routeOf(progressHarness, 'install-progress'), `${PREFIX}/install-progress`, {});
check('progress without a requestId -> 400', noRequestId.status === 400, noRequestId.status);

// A failed install is not an HTTP failure; it reaches the failed phase.
const failedInstall = harness({ installApplication: 'failed' });
host.apply(failedInstall.ctx, {});
const failedResponse = await post(routeOf(failedInstall, 'install'), `${PREFIX}/install`, { spec: 'npm:demo-broken', requestId: 'pm-verify-failed' });
const failedBody = await failedResponse.json();
check('a failed install is still HTTP 200', failedResponse.status === 200 && failedBody.ok === true, { status: failedResponse.status, body: failedBody });
check('a failed install reports its result', failedBody.result?.application === 'failed', failedBody.result);
const failedProgress = await (await get(routeOf(failedInstall, 'install-progress'), `${PREFIX}/install-progress`, { requestId: 'pm-verify-failed', from: 0 })).json();
check('a failed install reaches the failed phase', failedProgress.phase === 'failed', failedProgress.phase);

const cancelledInstall = harness({ installApplication: 'cancelled' });
host.apply(cancelledInstall.ctx, {});
await post(routeOf(cancelledInstall, 'install'), `${PREFIX}/install`, { spec: 'npm:demo-cancelled', requestId: 'pm-verify-cancelled' });
const cancelledProgress = await (await get(routeOf(cancelledInstall, 'install-progress'), `${PREFIX}/install-progress`, { requestId: 'pm-verify-cancelled', from: 0 })).json();
check('a cancelled install reaches the cancelled phase', cancelledProgress.phase === 'cancelled', cancelledProgress.phase);

console.log('\n[10b] cancelling an install (POST /install-cancel)');
const cancelHarness = harness({ cancelStatus: 'cancelled' });
host.apply(cancelHarness.ctx, {});
const cancelResponse = await post(routeOf(cancelHarness, 'install-cancel'), `${PREFIX}/install-cancel`, { requestId: 'pm-cancel-1' });
const cancelBody = await cancelResponse.json();
check('cancel succeeded', cancelResponse.status === 200 && cancelBody.ok === true, cancelBody);
check('cancel forwards the requestId to pluginManager', JSON.stringify(cancelHarness.calls.cancel) === JSON.stringify(['pm-cancel-1']), cancelHarness.calls.cancel);
check('cancel returns the manager status', cancelBody.status === 'cancelled', cancelBody.status);
const tooLate = await post(routeOf(progressHarness, 'install-cancel'), `${PREFIX}/install-cancel`, { requestId: REQUEST_ID });
check('a status the manager reports is passed through', (await tooLate.json()).status === 'not-running' && progressHarness.calls.cancel.includes(REQUEST_ID), progressHarness.calls.cancel);
const badCancel = await post(routeOf(progressHarness, 'install-cancel'), `${PREFIX}/install-cancel`, {});
check('cancel without a requestId -> 400', badCancel.status === 400, badCancel.status);

console.log('\n[11] toggling and update checking');
const toggleResponse = await post(routeOf(b, 'toggle'), `${PREFIX}/toggle`, { name: 'demo-bundle', enabled: false });
const toggled = await toggleResponse.json();
check('toggle succeeded', toggleResponse.status === 200 && toggled.result?.application === 'applied', toggled);
check('toggle passes name and state', b.calls.toggle[0]?.name === 'demo-bundle' && b.calls.toggle[0]?.enabled === false, b.calls.toggle[0]);
const badToggle = await post(routeOf(b, 'toggle'), `${PREFIX}/toggle`, { name: 'demo-bundle' });
check('toggle without enabled -> 400', badToggle.status === 400, badToggle.status);

const updates = await (await get(routeOf(b, 'updates'), `${PREFIX}/updates`)).json();
check('update check succeeded', updates.ok === true, updates);
const registryCheck = updates.checks.find((row) => row.name === 'demo-bundle');
const localCheck = updates.checks.find((row) => row.name === 'linked-thing');
check('a registry package is checked against its latest release', registryCheck?.checked === true && registryCheck.installed === '1.2.3' && registryCheck.latest === '9.9.9', registryCheck);
check('an outdated registry package is flagged', registryCheck?.outdated === true, registryCheck);
check('a link: package is not version-checked', localCheck?.checked === false && localCheck.kind === 'local', localCheck);

// A refused inspection means "no version could be read", which must never be
// rendered as "up to date".
const refused = harness({
  refuseInspect: true,
  bundles: [{ name: 'demo-bundle', version: '1.2.3', enabled: true, installed: true, removable: true, rows: [] }],
});
host.apply(refused.ctx, {});
const refusedBody = await (await get(routeOf(refused, 'updates'), `${PREFIX}/updates`)).json();
check('a refused inspection is not reported as up to date', refusedBody.checks[0]?.checked === false, refusedBody.checks[0]);
check('a refused inspection carries its reason', refusedBody.checks[0]?.reason === 'not-found', refusedBody.checks[0]?.reason);
const gitCheck = updates.checks.find((row) => row.name === 'git-thing');
// A git dependency tracks a commit: comparing it to a registry `latest` would
// be meaningless, so the Host must not even ask.
check('a git package is not version-checked', gitCheck?.checked === false && gitCheck.kind === 'git', gitCheck);
// `demo-bundle` and the unselected `orphan-bundle` are the only declared
// registry specs; `silent-bundle` has no manifest entry at all, so its kind is
// `unknown` and it is skipped too.
check('only registry packages reached the registry lookup', updates.checks.filter((row) => row.checked === true).map((row) => row.name).sort().join(',') === 'demo-bundle,orphan-bundle', updates.checks.filter((row) => row.checked === true).map((row) => row.name));
console.log(`        updates: ${registryCheck?.name} ${registryCheck?.installed} -> ${registryCheck?.latest} (outdated ${registryCheck?.outdated}); git skipped`);

const fresh = harness({ latestVersion: '1.2.3', bundles: [{ name: 'demo-bundle', version: '1.2.3', enabled: true, installed: true, removable: true, rows: [] }] });
host.apply(fresh.ctx, {});
const freshChecks = await (await get(routeOf(fresh, 'updates'), `${PREFIX}/updates`)).json();
check('an up-to-date package is not flagged', freshChecks.checks[0]?.outdated === false, freshChecks.checks[0]);

console.log('\n[12] anonymous and signed-in modes');
const anon = harness();
host.apply(anon.ctx, {});
const anonAccount = await (await get(routeOf(anon, 'account'), `${PREFIX}/account`)).json();
check('an anonymised profile reports no account', anonAccount.ok === true && anonAccount.supported === true && anonAccount.configured === false, anonAccount);
check('the credential store is reported writable', anonAccount.writable === true, anonAccount.writable);
check('the account view reports a transport', typeof anonAccount.transport?.kind === 'string', anonAccount.transport);

const badAction = await post(routeOf(anon, 'account'), `${PREFIX}/account`, { action: 'nope' });
check('an unknown account action -> 400', badAction.status === 400, badAction.status);
const noToken = await post(routeOf(anon, 'account'), `${PREFIX}/account`, { action: 'login', token: '   ' });
check('login without a token -> 400', noToken.status === 400, noToken.status);
const loggedOut = await post(routeOf(anon, 'account'), `${PREFIX}/account`, { action: 'logout' });
check('logout succeeds even with nothing stored', loggedOut.status === 200, loggedOut.status);

const readonly = harness({ credentialWritable: false });
host.apply(readonly.ctx, {});
const readonlyAccount = await (await get(routeOf(readonly, 'account'), `${PREFIX}/account`)).json();
check('a read-only credential store is reported', readonlyAccount.writable === false, readonlyAccount.writable);

if (OFFLINE) {
  console.log('  SKIP  DSH_MARKET_OFFLINE=1: token verification and signed-in account view skipped');
} else {
  // Snapshot the store first: the logout above already recorded an `unset`.
  const credentialWrites = anon.calls.credential.length;
  const rejected = await post(routeOf(anon, 'account'), `${PREFIX}/account`, { action: 'login', token: 'ghp_verificationdefinitelyinvalid' });
  const rejectedBody = await rejected.json();
  check('a rejected token is refused by GitHub', rejected.status === 401 && rejectedBody.code === 'invalid-token', rejectedBody);
  check('a rejected token is never written to the store', anon.calls.credential.slice(credentialWrites).every((call) => call.action !== 'set'), anon.calls.credential.slice(credentialWrites));

  // A store that already holds a token reports it as configured.
  const signedIn = harness({ token: 'ghp_pretend' });
  host.apply(signedIn.ctx, {});
  const signedView = await (await get(routeOf(signedIn, 'account'), `${PREFIX}/account`)).json();
  check('a stored token is reported as configured', signedView.configured === true, signedView.configured);
}

console.log('\n[13] request hygiene');
const badInstall = await post(routeOf(c, 'install'), `${PREFIX}/install`, {});
check('install without a spec -> 400', badInstall.status === 400, badInstall.status);
const badInspect = await post(routeOf(c, 'inspect'), `${PREFIX}/inspect`, { spec: '   ' });
check('inspect with a blank spec -> 400', badInspect.status === 400, badInspect.status);
const badBody = await routeOf(c, 'install').fetch(new Request(`http://127.0.0.1:1${PREFIX}/install`, { method: 'POST', body: 'not json' }));
check('non-JSON body -> 400', badBody.status === 400, badBody.status);
const wrongMethod = await get(routeOf(c, 'install'), `${PREFIX}/install`);
check('GET on a POST route -> 405', wrongMethod.status === 405, wrongMethod.status);
const wrongMethodCatalog = await post(routeOf(c, 'catalog'), `${PREFIX}/catalog`, {});
check('POST on a GET route -> 405', wrongMethodCatalog.status === 405, wrongMethodCatalog.status);
const badRemove = await post(routeOf(c, 'remove'), `${PREFIX}/remove`, {});
check('remove without a name -> 400', badRemove.status === 400, badRemove.status);
const validRemove = await post(routeOf(c, 'remove'), `${PREFIX}/remove`, { name: 'x' });
check('a valid remove reaches the stub', validRemove.status === 200, validRemove.status);

console.log('\n[14] teardown');
const before = a.routes.size;
for (const dispose of a.disposers) if (typeof dispose === 'function') dispose();
check('disposers remove every route', a.routes.size === 0, { before, after: a.routes.size });
check('disposers unsubscribe the install listeners', a.listeners.size === 0 || [...a.listeners.values()].every((set) => set.size === 0), [...a.listeners.entries()].map(([event, set]) => [event, set.size]));
for (const dispose of progressHarness.disposers) if (typeof dispose === 'function') dispose();
check('disposers unsubscribe the progress listeners', [...progressHarness.listeners.values()].every((set) => set.size === 0), [...progressHarness.listeners.entries()].map(([event, set]) => [event, set.size]));

if (realProfileDir === undefined) delete process.env.DSH_PROFILE_DIR;
else process.env.DSH_PROFILE_DIR = realProfileDir;
rmSync(FAKE_PROFILE, { recursive: true, force: true });

console.log(`\nRESULT: ${passed} passed, ${failed} failed${OFFLINE ? ' (DSH_MARKET_OFFLINE=1)' : ''}\n`);
process.exit(failed === 0 ? 0 : 1);
