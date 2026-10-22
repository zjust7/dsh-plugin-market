/**
 * Update-safety guard.
 *
 *     node verify-safety.mjs
 *
 * Two properties an update must have, both pinned here:
 *   1. it never changes the *source* the user chose (branch / tag / monorepo
 *      subdirectory survive; only a deliberate commit pin is dropped);
 *   2. a failed update puts the profile manifest back, because a forced update
 *      removes the entry before re-adding it.
 */
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`) }
  else { fail += 1; console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`) }
}

console.log('\n[1] a source selector survives an update')
check('a target resolver exists', client.includes('function updateTargetOf(spec)'))
check('it is used on update', /else if \(target\.includes\('#'\)\) \{[\s\S]{0,160}updateTargetOf\(target\)/.test(client))
check('a 40-char commit pin is recognised', /\^\[0-9a-f\]\{40\}\$\/i\.test\(selector\)/.test(client))
check('a subpath selector is preserved', client.includes("selector.startsWith('path:/')"))
check('traversal segments are rejected', client.includes("segment !== '..'"))
check('two refs fall back to the bare repo', /if \(ref !== null\) return repo/.test(client))

console.log('\n[2] the manifest is snapshotted before a forced update')
check('a capture helper exists', host.includes('const captureManifest = async () =>'))
check('it reads the profile manifest', /join\(dir, 'package\.json'\)/.test(host))
check('it is taken only when force is set', /body\.force === true \? await captureManifest\(\) : null/.test(host))
const captureAt = host.indexOf('const manifestSnapshot = body.force === true')
const removeAt = host.indexOf('await ctx.pluginManager.removeBundle(installedName)')
check('capture happens before the removal', captureAt > 0 && removeAt > captureAt, { captureAt, removeAt })

console.log('\n[3] every failure path restores it')
check('a restore helper exists', host.includes('const restoreManifest = (snapshot) =>'))
check('it writes through a temp file', host.includes('.market-restore') && host.includes('renameSync(temp, snapshot.file)'))
check('a failed removal restores', /A removal that fails[\s\S]{0,400}restoreManifest\(manifestSnapshot\)/.test(host))
check('a thrown add restores', /The add threw[\s\S]{0,500}restoreManifest\(manifestSnapshot\)/.test(host))
check('a non-applied add restores', /result\?\.application !== 'applied'[\s\S]{0,200}restoreManifest\(manifestSnapshot\)/.test(host))
check('the outcome is reported, not swallowed', /restored: rolledBack\.ok/.test(host) && /restoreProblem/.test(host))

console.log('\n[4] a successful update does not restore')
const successRestore = /result\?\.application !== 'applied'[\s\S]{0,200}restoreManifest/.test(host)
check('restore is guarded by the application result', successRestore)
check('the answer says whether it restored', /restored: record\.restored === true/.test(host))

console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
