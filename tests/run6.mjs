// Regression simulation for the `agent/pre-step` safety net: a Session whose
// creation announcement could not isolate it must still get its folder before
// the step's tools run.
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Tests run against a throwaway HOME so the real folder index is never touched.
const testHome = await mkdtemp(join(tmpdir(), 'sf-home-'))
process.env.USERPROFILE = testHome
process.env.HOME = testHome

const PLUGIN = new URL('../index.js', import.meta.url).href
const mod = await import(PLUGIN)

const workspace = await mkdtemp(join(tmpdir(), 'sf-pre-ws-'))
const outside = await mkdtemp(join(tmpdir(), 'sf-pre-out-'))

const handlers = new Map()
let registryAvailable = true
const services = {
  get workspaceRegistry() {
    return registryAvailable ? { list: () => [{ id: 'w1', path: workspace, sessionIds: [] }] } : undefined
  },
  workingDirectory: { defaultDirectory: join(outside, 'default'), get: (s) => s.__dir },
  sessionTitle: { get: (s) => (s.__title ? { title: s.__title } : undefined) },
}

const ctx = {
  on(name, fn) {
    handlers.set(name, fn)
    return () => handlers.delete(name)
  },
  get(name) {
    return services[name]
  },
  effect() {},
  get logger() {
    throw new Error('logger service missing')
  },
}

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`PASS ${label}`)
  else {
    failures += 1
    console.log(`FAIL ${label} :: ${detail ?? ''}`)
  }
}

function makeSession(id, cwd, extra = {}) {
  const session = {
    id,
    seq: extra.seq ?? 0,
    events: [],
    header: { cwd, createdAt: Date.now(), isSeeded: false, ...(extra.header ?? {}) },
    append(type, data) {
      this.events.push({ type, data })
      if (type === 'working-directory/change') this.__dir = data.cwd
      this.seq += 1
      return { type, data }
    },
  }
  if (extra.title !== undefined) session.__title = extra.title
  if (extra.dir !== undefined) session.__dir = extra.dir
  return session
}

const entries = async () => (await readdir(workspace, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

mod.apply(ctx, {})

const preStep = handlers.get('agent/pre-step')
const created = handlers.get('session/created')

check('apply registers agent/pre-step', typeof preStep === 'function')

// --- 1. creation could not reach the registry; the pre-step repairs it -------
const late = makeSession('session-1111aaaa-0000-0000-0000-000000000011', workspace)
registryAvailable = false
created(late)
await sleep(60)
check('1 nothing happened without the registry', (await entries()).length === 0, await entries())

registryAvailable = true
let nextCalls = 0
await preStep({ agent: { session: late } }, () => {
  nextCalls += 1
})
check('1 pre-step created the folder', (await entries()).length === 1, await entries())
check('1 pre-step committed the directory',
  late.events.length === 1 && late.events[0].data.cwd === join(workspace, '1111aaaa'),
  JSON.stringify(late.events))
check('1 next() called once', nextCalls === 1, String(nextCalls))

// --- 2. a second step does not move the Session again -----------------------
const before = late.events.length
await preStep({ agent: { session: late } }, () => {})
check('2 second pre-step is a no-op', late.events.length === before, JSON.stringify(late.events))

// --- 3. an isolated Session is left alone ----------------------------------
const renamed = makeSession('session-2222bbbb-0000-0000-0000-000000000022', workspace, {
  title: '已经隔离',
})
created(renamed)
await sleep(80)
await preStep({ agent: { session: renamed } }, () => {})
check('3 isolated Session keeps one commit', renamed.events.length === 1, JSON.stringify(renamed.events))

// --- 4. a real conversation is not retrofitted -----------------------------
const busy = makeSession('session-3333cccc-0000-0000-0000-000000000033', workspace, { seq: 320 })
busy.deriveMessages = () => [{ role: 'user' }, { role: 'assistant' }]
await preStep({ agent: { session: busy } }, () => {})
check('4 conversation is untouched', busy.events.length === 0, JSON.stringify(busy.events))

// --- 5. derived Sessions still inherit -------------------------------------
const child = makeSession('session-4444dddd-0000-0000-0000-000000000044', workspace, {
  header: { parentSession: 'session-1111aaaa-0000-0000-0000-000000000011' },
})
await preStep({ agent: { session: child } }, () => {})
check('5 sub-agent inherits', child.events.length === 0, JSON.stringify(child.events))

// --- 6. a throwing agent does not break the step ---------------------------
let thrownSafe = true
try {
  await preStep({ agent: undefined }, () => {})
} catch {
  thrownSafe = false
}
check('6 payload without an agent is safe', thrownSafe)

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
