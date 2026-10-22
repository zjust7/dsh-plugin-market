#!/usr/bin/env node
/**
 * Build `data/reviews.json`, the review snapshot this plugin ships and reads.
 *
 * This is the ONLY place in the project that talks to the review site's API.
 * The plugin itself reads the file this script writes, which means:
 *
 * - the review site sees one scheduled poll a day from one machine, instead of
 *   an API burst per installation;
 * - a reader installs the plugin and sees the verdicts, without anyone needing
 *   a credential the site does not issue;
 * - the snapshot can be inspected, diffed and audited before it is published,
 *   which an API response read at runtime cannot be.
 *
 * Usage:
 *   node tools/reviews-snapshot.mjs                 # writes data/reviews.json
 *   node tools/reviews-snapshot.mjs --out /tmp/x.json
 *
 * Exit codes: 0 written, 1 the site could not be read, 2 the data looked wrong.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const SITE = 'https://review.lingshulab.com'
const PAGE_SIZE = 50
const MAX_PAGES = 20
const CONCURRENCY = 6
/** Ceiling on report reads. A snapshot larger than this is a bug, not a trend. */
const MAX_REPORTS = 400
const TIMEOUT_MS = 20000

const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
const OUT = outIndex >= 0 && argv[outIndex + 1] !== undefined
  ? resolve(argv[outIndex + 1])
  : resolve(ROOT, 'data/reviews.json')

const stamp = () => new Date().toISOString()

/**
 * Keep only the fields this plugin reads.
 *
 * Two reasons, and the second one matters more. It cuts the snapshot by an
 * order of magnitude, and it means what gets republished is a verdict index —
 * id, title, verdict, author, date, link — rather than a copy of the review
 * site's articles. The snapshot is a catalogue of their findings, not a mirror
 * of their site.
 */
const REPORT_FIELDS = [
  'pluginId', 'reviewId', 'title', 'verdict', 'authorNickname',
  'firstPublishedAt', 'publishedAt', 'publicUpdatedAt',
  'pluginVersion', 'dshVersion', 'evidenceRefs',
]

function pickReport(detail) {
  const picked = {}
  for (const field of REPORT_FIELDS) {
    if (detail[field] !== undefined && detail[field] !== null) picked[field] = detail[field]
  }
  // The nested version objects carry far more than the one label the window
  // prints.
  for (const field of ['pluginVersion', 'dshVersion']) {
    if (picked[field] !== undefined && typeof picked[field] === 'object') {
      picked[field] = { value: typeof picked[field].value === 'string' ? picked[field].value : '' }
    }
  }
  if (Array.isArray(picked.evidenceRefs)) picked.evidenceRefs = picked.evidenceRefs.slice(0, 12)
  return picked
}

/** One JSON GET, with the timeouts and headers this site expects. */
async function getJson(path) {
  const response = await fetch(`${SITE}${path}`, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-plugin-market-snapshot' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`)
  return response.json()
}

/** Read every page of one paginated endpoint. */
async function readPages(path) {
  const items = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await getJson(`${path}?page=${page}&page_size=${PAGE_SIZE}`)
    const data = body !== null && typeof body === 'object' ? body.data : null
    const pageItems = data !== null && Array.isArray(data.items) ? data.items : []
    items.push(...pageItems)
    const totalPages = Number(data?.total_pages)
    console.log(`  ${path} page ${page}: +${pageItems.length} (of ${items.length})`)
    if (!Number.isFinite(totalPages) || page >= totalPages) break
    if (pageItems.length === 0) break
  }
  return items
}

async function main() {
  console.log(`Reading ${SITE}`)
  const [plugins, reviews] = await Promise.all([
    readPages('/api/plugins'),
    readPages('/api/reviews'),
  ])
  if (plugins.length === 0) throw new Error('the site returned no plugins')
  console.log(`  ${plugins.length} plugins, ${reviews.length} report stubs`)

  // The list endpoint omits the verdict and the author, and inferring a verdict
  // from a title is exactly the guess this project refuses to make. So every
  // report is read once, with bounded concurrency.
  const queue = reviews.slice(0, MAX_REPORTS)
  const details = []
  const failures = []
  let done = 0
  console.log(`  reading ${queue.length} report bodies (cap ${MAX_REPORTS})`)
  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      if (item === undefined || typeof item.reviewId !== 'string') continue
      try {
        const body = await getJson(`/api/reviews/${item.reviewId}`)
        const detail = body !== null && typeof body === 'object' ? body.data : null
        if (detail !== null && typeof detail === 'object') details.push(pickReport(detail))
        else failures.push(`${item.reviewId}: no data`)
      } catch (error) {
        failures.push(`${item.reviewId}: ${error.message}`)
      }
      done += 1
      if (done % 20 === 0) console.log(`  reports ${done}/${reviews.length}`)
    }
  }
  // `() => worker()` and not `() => worker`: without the call, the map produces
  // six function references, Promise.all resolves on them immediately, and the
  // snapshot comes out with zero reports while reporting zero failures.
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  console.log(`  ${details.length} report bodies, ${failures.length} failed`)

  if (details.length === 0) throw new Error('no report body could be read')

  const document = {
    // Bumping this is a breaking change for the Host's reader.
    schema: 1,
    site: SITE,
    generatedAt: stamp(),
    counts: { plugins: plugins.length, reviews: details.length },
    failures: failures.slice(0, 20),
    plugins,
    reviews: details,
  }

  const json = `${JSON.stringify(document)}\n`
  await mkdir(dirname(OUT), { recursive: true })

  // Refuse to shrink the snapshot by a lot. A half-read site would otherwise
  // silently replace a good file with a thin one, and the plugin would show
  // "no report" for plugins that have one — the one wrong answer this project
  // keeps coming back to. Compared by COUNT, not bytes, because trimming the
  // field list is a legitimate way for the file to get smaller.
  let previous = null
  try {
    previous = JSON.parse(await readFile(OUT, 'utf8'))
  } catch {
    previous = null
  }
  const before = typeof previous?.reviews?.length === 'number' ? previous.reviews.length : 0
  const force = argv.includes('--force')
  if (before > 0 && details.length < before * 0.8 && !force) {
    throw new Error(
      `refusing to write: ${details.length} reports is a large drop from ${before}. `
      + 'Re-run with --force once you have checked the site.',
    )
  }

  await writeFile(OUT, json, 'utf8')
  console.log(`Wrote ${OUT} (${(json.length / 1024).toFixed(0)} KiB)`)
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`FAILED: ${error.message}`)
    process.exit(2)
  },
)
