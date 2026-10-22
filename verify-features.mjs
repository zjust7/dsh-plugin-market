/**
 * 0.10 feature guard.
 *
 *     node verify-0x11.mjs
 *
 * Pins the 0.10 additions so they cannot silently regress: the installed list
 * reads the newest version from the update check (not the never-populated
 * `bundle.latestVersion`), the history tab sits between installed and settings,
 * and the batch / update-all / manifest I/O controls are all wired.
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`) }
  else { fail += 1; console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`) }
}

console.log('\n[1] version state reads the newest release from the update check')
check('latest falls back to the check', /check !== undefined && typeof check\.latest === 'string'/.test(src))
const latestFromCheck = (src.match(/const latest = check !== undefined && typeof check\.latest/g) || []).length
check('both installed card and section derive latest from the check', latestFromCheck >= 2, latestFromCheck)

console.log('\n[2] search history is a placeholder tab between installed and settings')
check('history sits between installed and settings', /'installed', 'history', 'settings'/.test(src))
check('history has a tab label', src.includes("'tab.history'"))
check('history body renders a placeholder', /state\.tab === 'history'/.test(src))
check('history needs no data source', /tab === 'history'\) \{/.test(src))

console.log('\n[3] batch operations on the installed list')
check('selection state exists', src.includes('selectedNames: []'))
check('per-row checkbox exists', src.includes("type: 'checkbox'"))
check('batch bar renders when selected', src.includes('BatchBar(t, state, actions)'))
check('bulk toggle loops the single route', src.includes('async function bulkToggle'))
check('bulk remove confirms first', src.includes("window.confirm(tt('batch.confirmDelete'"))
check('selection clears on tab switch', /detail: null, selectedNames: \[\]/.test(src))

console.log('\n[4] one-click update all')
check('updateAll function exists', src.includes('async function updateAll'))
check('the bar has an update-all button', src.includes("t('updates.all')"))
check('harmful packages are skipped', /check\.harmful === true\) continue/.test(src))

console.log('\n[5] export / import manifest')
check('exportInstalled exists', src.includes('function exportInstalled'))
check('importInstalled exists', src.includes('function importInstalled'))
check('export writes a JSON blob', src.includes('new Blob([JSON.stringify(payload'))
check('import reads a file input', src.includes("input.accept = 'application/json,.json'"))

console.log('\n[6] labs placeholders')
check('labs section exists', src.includes("t('settings.labs')"))
check('dependency graph is a placeholder', src.includes("t('labs.dependency')"))
check('plugin compare is a placeholder', src.includes("t('labs.compare')"))

console.log('\n[7] installed-page update pins @latest (bug fix)')
check('update pins @latest for bare names', /label === 'update' && !target\.includes\(':'\)/.test(src))
check('the meaningless installed.hint is gone', !src.includes('installed.hint'))

console.log('\n[8] host compatibility (engines.dsh)')
check('host reads engines off the newest version', host.includes('engines: npmHistory.engines'))
check('client has the compatibility helper', src.includes('function dshCompatibility'))
check('drawer renders the compatibility field', src.includes("t('drawer.engines')"))

console.log('\n[9] update changelog link')
check('update check carries the repo', host.includes('repo: repoByNpm === null'))
check('changelog link renders', src.includes("t('updates.changelog')"))

console.log('\n[10] screenshot carousel + lightbox')
check('auto-advance timer exists', src.includes('setInterval(() => setActive'))
check('lightbox opens on click', src.includes("className: 'dpm-lightbox'"))

console.log('\n[11] feedback goes through the repository, not an embedded widget')
// An inline comment box hosted on the market's own repository turns it into a
// support forum that needs moderating. Feedback routes to the plugin author's
// issue tracker instead — the party who can actually act on it.
check('no embedded giscus widget', !src.includes('giscus.app/client.js'))
check('no giscus configuration', !src.includes('giscusRepoId') && !src.includes('giscusCategoryId'))
check('the author issue links remain', src.includes('function CommunityLinks'))

console.log('\n[12] install location')
check('host returns the profile dir', host.includes("profileDir: profileDir ?? ''"))
check('client stores the profile dir', src.includes("typeof payload.profileDir === 'string'"))
check('install-dir block renders', src.includes("t('settings.installDir')"))

console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
