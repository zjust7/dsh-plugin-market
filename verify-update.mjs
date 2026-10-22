/**
 * Update-path guard.
 *
 *     node verify-update.mjs
 *
 * "I have to delete the plugin to update it" had two causes, both pinned here:
 *   1. an update sent a spec pnpm already considered satisfied;
 *   2. the installed tab read "latest" from a different source than the catalog,
 *      so the two could disagree and the row never offered an update.
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

console.log('\n[1] an update asks the Host to re-resolve the source')
check('updateBundle sends force', /const needsFreshResolve = label === 'update' \|\| label === 'reinstall'/.test(client))
check('runInstall forwards it', /force: needsFreshResolve === true/.test(client))
check('the request body carries it', /if \(opts\.force === true\) body\.force = true/.test(client))

console.log('\n[2] the Host drops the stale manifest entry before re-adding')
check('install honours force', /if \(body\.force === true\) \{/.test(host))
check('it finds the installed bundle', /bundles\.find\(\(bundle\) => bundle\.spec === spec \|\| bundle\.name === spec\)/.test(host))
check('it removes before installing', host.indexOf('await ctx.pluginManager.removeBundle(installedName)') > 0)
const removeAt = host.indexOf('await ctx.pluginManager.removeBundle(installedName)')
const installAt = host.indexOf('await ctx.pluginManager.installBundle(spec,')
check('remove happens before install', removeAt > 0 && installAt > removeAt, { removeAt, installAt })
check('a failed removal is reported, not swallowed', /code: 'update-failed'/.test(host))

console.log('\n[3] installed and catalog read "latest" from the same source')
check('the registry branch reads npm history', /const npmHistory = await readNpmHistory\(bundle\.name\)/.test(host))
check('it prefers the published latest', /npmHistory\.latest !== ''\s*\n?\s*\? npmHistory\.latest/.test(host) || /typeof npmHistory\.latest === 'string' && npmHistory\.latest !== ''/.test(host))
check('detail uses the same reader', /readNpmHistory\(/.test(host) && host.includes('latestVersion: npmHistory.latest'))

console.log('\n[4] git installs are checked instead of skipped')
check('a provided repo is used', /repoOfGitSpec/.test(host))
check('a missing repo names its reason', /'git-no-repo'/.test(host))
check('no releases is a state, not "up to date"', /'no-releases'/.test(host))

console.log('\n[5] the inline comment widget is gone, the issue links remain')
check('no giscus constant', !/GISCUS_REPO/.test(client))
check('no comment component', !/function CommentSection/.test(client))
check('no comment settings block', !/settings\.giscus/.test(client))
check('issue / discussion links still exist', /function CommunityLinks/.test(client))

console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
