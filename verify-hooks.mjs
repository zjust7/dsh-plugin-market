/**
 * Hook-safety guard.
 *
 *     node verify-hooks.mjs
 *
 * Twice now a component that uses hooks was invoked as a plain function
 * (`Foo(t, entry)`) instead of being rendered (`h(Foo, {...})`). Calling it runs
 * its hooks inside the *caller's* hook list, so every open/close of the drawer
 * shifts the caller's hook sequence and React aborts the whole overlay — which
 * is exactly the "crash after a few clicks" report. This pins the boundary.
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const lines = src.split('\n')
let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}`) }
  else { fail += 1; console.log(`  FAIL  ${name}${detail === undefined ? '' : ` -> ${JSON.stringify(detail)}`}`) }
}

// Locate every `function Name(...) { ... }` at the component indentation, then
// keep the ones whose body mentions a hook.
const hooked = []
for (let i = 0; i < lines.length; i += 1) {
  const head = /^\t\tfunction ([A-Z][A-Za-z0-9]*)\(([^)]*)\) \{/.exec(lines[i])
  if (head === null) continue
  let j = i + 1
  while (j < lines.length && !/^\t\t\}/.test(lines[j])) j += 1
  const body = lines.slice(i, j).join('\n')
  if (/\b(useState|useEffect|useRef|useMemo|useCallback)\s*\(/.test(body)) {
    const firstHook = body.search(/\b(useState|useEffect|useRef|useMemo|useCallback)\s*\(/)
    hooked.push({ name: head[1], start: i, end: j, body, firstHook })
  }
}
console.log('\n[1] components that use hooks')
console.log('        ', hooked.map((c) => c.name).join(' '))

console.log('\n[2] every hooked component is rendered, never called')
for (const comp of hooked) {
  // Scan every occurrence of `Name(` outside its own declaration.
  const offenders = []
  lines.forEach((line, index) => {
    if (index === comp.start) return
    if (/^\t\tfunction /.test(line)) return
    let at = line.indexOf(`${comp.name}(`)
    while (at !== -1) {
      const before = line.slice(Math.max(0, at - 3), at)
      const isRendered = before.endsWith('h(') || /h\(\s*$/.test(line.slice(Math.max(0, at - 6), at))
      if (!isRendered) offenders.push(`${index + 1}: ${line.trim().slice(0, 70)}`)
      at = line.indexOf(`${comp.name}(`, at + 1)
    }
  })
  check(`${comp.name} is only used via h()`, offenders.length === 0, offenders.slice(0, 2))
}

console.log('\n[3] the hook count is stable across renders')
for (const comp of hooked) {
  // A hook after a conditional early return changes the hook count between renders.
  let firstReturn = -1
  const bodyLines = comp.body.split('\n')
  for (let k = 0; k < bodyLines.length; k += 1) {
    if (/^\t\t\tif \(.*\) return /.test(bodyLines[k])) { firstReturn = comp.body.indexOf(bodyLines[k]); break }
  }
  const earlyReturn = firstReturn >= 0 && comp.firstHook >= 0 && firstReturn < comp.firstHook
  check(`${comp.name}: no hook after an early return`, !earlyReturn, { firstReturn, firstHook: comp.firstHook })
}

console.log(`\nRESULT: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
