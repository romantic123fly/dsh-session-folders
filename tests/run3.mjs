// Behaviour simulation for dsh-session-folders build 6: folder per conversation,
// renamed to `{title}{date}` once the title is folded into the Session log.
import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Tests run against a throwaway HOME so the real folder index is never touched.
const testHome = await mkdtemp(join(tmpdir(), 'sf-home-'))
process.env.USERPROFILE = testHome
process.env.HOME = testHome

const PLUGIN = new URL('../index.js', import.meta.url).href
const mod = await import(PLUGIN)

const workspace = await mkdtemp(join(tmpdir(), 'sf-ws-'))
const outside = await mkdtemp(join(tmpdir(), 'sf-out-'))

const now = new Date()
const DATE = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`

const handlers = new Map()
const services = {
  workspaceRegistry: { list: () => [{ id: 'w1', path: workspace, sessionIds: [] }] },
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
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    failures += 1
    console.log(`FAIL ${label} :: ${detail ?? ''}`)
  }
}

function makeSession(id, cwd, extra = {}) {
  const session = {
    id,
    seq: 0,
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const tick = () => new Promise((resolve) => setImmediate(resolve))
const entries = async () => (await readdir(workspace, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()

mod.apply(ctx, {})
check('apply registers session/created', handlers.has('session/created'))
check('apply registers session/event', handlers.has('session/event'))
check('apply registers agent/turn-stopping', handlers.has('agent/turn-stopping'))

// --- 1. new conversation: provisional id folder, then title only ---------
const s1 = makeSession('session-aaaa1111-0000-0000-0000-000000000001', workspace)
handlers.get('session/created')(s1)
await tick()
await tick()
check('1 provisional folder is the short id', JSON.stringify(await entries()) === JSON.stringify(['aaaa1111']), await entries())
check('1 provisional cwd committed', s1.events.length === 1 && s1.events[0].data.cwd === join(workspace, 'aaaa1111'), JSON.stringify(s1.events))

s1.__title = '体检报告分析与健康趋势'
handlers.get('session/event')(s1, { type: 'session/title' })
await sleep(700)
const final1 = `体检报告分析与健康趋势`
check('1 folder renamed to title only', JSON.stringify(await entries()) === JSON.stringify([final1]), await entries())
check('1 cwd follows the rename', s1.events.length === 2 && s1.events[1].data.cwd === join(workspace, final1), JSON.stringify(s1.events.map((e) => e.data)))
check('1 old folder is gone', !(await stat(join(workspace, 'aaaa1111')).then(() => true, () => false)))

// --- 2. two title events in a burst collapse into one rename ----------------
const s2 = makeSession('session-bbbb2222-0000-0000-0000-000000000002', workspace)
handlers.get('session/created')(s2)
await tick()
await tick()
s2.__title = '临时'
handlers.get('session/event')(s2, { type: 'session/title' })
s2.__title = '正式标题'
handlers.get('session/event')(s2, { type: 'session/title' })
await sleep(700)
check('2 debounce keeps only the last title', (await entries()).includes(`正式标题`), await entries())
check('2 exactly two commits', s2.events.length === 2, JSON.stringify(s2.events.map((e) => e.data)))

// --- 3. illegal characters are sanitized ------------------------------------
const s3 = makeSession('session-cccc3333-0000-0000-0000-000000000003', workspace)
handlers.get('session/created')(s3)
await tick()
await tick()
s3.__title = 'a/b:c*"d<e>|f?'
handlers.get('session/event')(s3, { type: 'session/title' })
await sleep(700)
check('3 sanitized name', (await entries()).includes(`a b c d e f`), await entries())

// --- 4. duplicate name gets a numeric suffix --------------------------------
const s4 = makeSession('session-dddd4444-0000-0000-0000-000000000004', workspace)
handlers.get('session/created')(s4)
await tick()
await tick()
s4.__title = '体检报告分析与健康趋势'
handlers.get('session/event')(s4, { type: 'session/title' })
await sleep(700)
check('4 duplicate gets -2', (await entries()).includes(`${final1}-2`), await entries())

// --- 5. a title known before creation is used right away --------------------
const s5 = makeSession('session-eeee5555-0000-0000-0000-000000000005', workspace, { title: '早到标题' })
handlers.get('session/created')(s5)
await tick()
await tick()
await sleep(80)
check('5 created with title directly', (await entries()).includes(`早到标题`), await entries())
check('5 single commit', s5.events.length === 1, JSON.stringify(s5.events.map((e) => e.data)))

// --- 6. untouched cases -----------------------------------------------------
const before = await entries()

const outsideSession = makeSession('session-ffff6666-0000-0000-0000-000000000006', outside)
handlers.get('session/created')(outsideSession)
const derived = makeSession('session-77777777-0000-0000-0000-000000000007', workspace, { header: { parentSession: 'session-aaaa1111-0000-0000-0000-000000000001' } })
handlers.get('session/created')(derived)
const noCwd = makeSession('session-88888888-0000-0000-0000-000000000008', undefined)
handlers.get('session/created')(noCwd)
const restored = makeSession('session-99999999-0000-0000-0000-000000000009', workspace, { seq: 1416, header: { createdAt: Date.now() - 60 * 60 * 1000 } })
restored.deriveMessages = () => [{ role: 'user' }, { role: 'assistant' }]
handlers.get('session/created')(restored)
await sleep(50)
check('6 untouched sessions create nothing', JSON.stringify(await entries()) === JSON.stringify(before), await entries())
check('6 untouched sessions get no events', [outsideSession, derived, noCwd, restored].every((s) => s.events.length === 0))

// --- 7. a later user rename moves the folder again --------------------------
s1.__title = '重命名后的对话'
handlers.get('session/event')(s1, { type: 'session/title' })
await sleep(700)
check('7 user rename moves folder', (await entries()).includes(`重命名后的对话`), await entries())
check('7 cwd follows again', s1.events.at(-1).data.cwd === join(workspace, `重命名后的对话`), JSON.stringify(s1.events.map((e) => e.data)))

// --- 8. session disposal forgets the session ------------------------------
handlers.get('session/disposed')(s1)
s1.__title = '不应该再动'
handlers.get('session/event')(s1, { type: 'session/title' })
await sleep(700)
check('8 disposed session is ignored', (await entries()).includes(`重命名后的对话`), await entries())

console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
