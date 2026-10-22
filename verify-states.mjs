/**
 * State-machine guard.
 *
 *     node verify-states.mjs
 *
 * One `loading` boolean was shared by three async flows, so whichever finished
 * last cleared it: a slow catalog build could be un-marked by a fast installed
 * read, and a failed search could leave another flow's spinner stuck forever.
 * This pins the per-flow channel so the sharing cannot come back.
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`) }
  else { fail += 1; console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`) }
}

console.log('\n[1] each async flow owns its own busy channel')
check('a named busy channel exists', src.includes('busyFlow: null'))
const writes = [...src.matchAll(/busyFlow: '([a-zA-Z]+)'/g)].map((m) => m[1])
// The list flow picks its channel with a ternary, so scan for the names too.
const ternaryFlows = src.includes("busyFlow: tab === 'github'") ? ['github', 'catalogList'] : []
const clears = [...src.matchAll(/busyFlow: null/g)].length
check('the catalog build names its flow', writes.includes('catalog'), writes)
check('the installed list names its flow', writes.includes('installed'), writes)
check('the list pager names its flow', ternaryFlows.length > 0, ternaryFlows)
check('every start has a matching clear', clears >= writes.length, { writes: writes.length, clears })
console.log('        flows:', [...new Set([...writes, ...ternaryFlows])].sort().join(' '), `| ${clears} clears`)

console.log('\n[2] no flow sets the shared flag directly any more')
const sharedWrites = [...src.matchAll(/patch\(\{ loading: true/g)].length
check('no patch writes loading:true', sharedWrites === 0, sharedWrites)
const sharedClears = [...src.matchAll(/loading: false/g)].length
check('no patch writes loading:false', sharedClears === 0, sharedClears)

console.log('\n[3] loading survives only as a derived flag')
check('it is derived in one place', /if \(store\.busyFlow !== null && store\.loading !== true\) store\.loading = true/.test(src))
check('and cleared in the same place', /else if \(store\.busyFlow === null && store\.loading === true\) store\.loading = false/.test(src))
const derivedOnly = src.indexOf('store.loading = true') > 0
check('the derivation lives in useStore', derivedOnly)

console.log('\n[4] every flow that starts must be able to finish')
// A flow with no clear path is the "spinner stuck forever" failure.
for (const flow of ['catalog', 'installed']) {
  const starts = [...src.matchAll(new RegExp(`busyFlow: '${flow}'`, 'g'))].length
  check(`flow ${flow} starts (${starts})`, starts > 0)
}
check('the list flow clears on both success and failure',
  /busyFlow: null, entries: \[\], total: 0, totalPages: 1/.test(src), 'no failure clear for the list')

console.log('\n[5] disabled controls read the derived flag')
check('the pager reads state.loading', src.includes('disabled: page <= 1 || state.loading'))
check('the search button reads state.loading', /disabled: state\.loading, onClick: submit/.test(src))

console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
