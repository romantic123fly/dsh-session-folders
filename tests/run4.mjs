// Behaviour simulation for dsh-session-folders build 7: a conversation is
// isolated when its log does not hold a reply yet, no matter how old its header
// says it is (the app keeps createdAt when a conversation is cleared), and
// `isolateSessions` retrofits a conversation that already has content.
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Tests run against a throwaway HOME so the real folder index is never touched.
const testHome = await mkdtemp(join(tmpdir(), 'sf-home-'))
process.env.USERPROFILE = testHome
process.env.HOME = testHome

const PLUGIN = new URL('../index.js', import.meta.url).href
const mod = await import(PLUGIN)

const now = new Date()
const DATE = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`

const workspace = await mkdtemp(join(tmpdir(), 'sf7-ws-'))
const outside = await mkdtemp(join(tmpdir(), 'sf7-out-'))

const services = {
  workspaceRegistry: { list: () => [{ id: 'w1', path: workspace, sessionIds: [] }] },
  workingDirectory: { defaultDirectory: join(outside, 'default'), get: (s) => s.__dir },
  sessionTitle: { get: (s) => (s.__title ? { title: s.__title } : undefined) },
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

const handlers = new Map()
const ctx = {
  on(name, fn) {
    handlers.set(name, fn)
    return () => handlers.delete(name)
  },
  get(name) {
    return services[name]
  },
  effect() {},
  logger: { info() {}, warn() {} },
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
  if (extra.messages !== undefined) session.deriveMessages = () => extra.messages
  return session
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const entries = async () => (await readdir(workspace, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()

const A_ID = 'session-aaa11111-0000-0000-0000-00000000000a'
const B_ID = 'session-bbb22222-0000-0000-0000-00000000000b'
const C_ID = 'session-ccc33333-0000-0000-0000-00000000000c'
const D_ID = 'session-ddd44444-0000-0000-0000-00000000000d'

// Only C is listed for a retrofit.
mod.apply(ctx, { isolateSessions: [C_ID] })

// --- A. cleared conversation: empty log, header.createdAt six days old ------
const a = makeSession(A_ID, workspace, {
  header: { createdAt: Date.now() - 6 * 24 * 60 * 60 * 1000 },
  messages: [],
})
handlers.get('session/created')(a)
await sleep(40)
check('A old createdAt with an empty log is isolated',
  a.events.length === 1 && a.events[0].data.cwd === join(workspace, 'aaa11111'),
  JSON.stringify(a.events))

// The title that lands afterwards renames the folder.
a.__title = '每日工作总结'
handlers.get('session/event')(a, { type: 'session/title' })
await sleep(700)
check('A folder renamed to title only', (await entries()).includes(`每日工作总结`), await entries())
check('A cwd follows the rename',
  a.events.length === 2 && a.events[1].data.cwd === join(workspace, `每日工作总结`),
  JSON.stringify(a.events.map((e) => e.data)))

// --- B. restored conversation that already ran: untouched -------------------
const b = makeSession(B_ID, workspace, {
  seq: 1416,
  messages: [{ role: 'user' }, { role: 'assistant' }],
})
handlers.get('session/created')(b)
await sleep(40)
check('B conversation with a reply is untouched', b.events.length === 0, JSON.stringify(b.events))

// --- C. listed in isolateSessions: retrofitted with the known title ---------
const c = makeSession(C_ID, workspace, {
  seq: 108,
  title: '每日工作总结',
  messages: [{ role: 'user' }, { role: 'assistant' }],
})
handlers.get('session/created')(c)
await sleep(40)
check('C listed Session is isolated despite its history',
  c.events.length === 1 && c.events[0].data.cwd === join(workspace, `每日工作总结-2`),
  JSON.stringify(c.events.map((e) => e.data)))

// --- D. no deriveMessages: a long log is treated as history -----------------
const d = makeSession(D_ID, workspace, { seq: 1416 })
handlers.get('session/created')(d)
await sleep(40)
check('D long log without a message projection is untouched', d.events.length === 0, JSON.stringify(d.events))

// --- E. second announce of an isolated Session does nothing -----------------
const before = a.events.length
handlers.get('session/created')(a)
await sleep(40)
check('E re-announce does not move an isolated Session again', a.events.length === before,
  JSON.stringify(a.events.map((e) => e.data)))

// --- F. derived Sessions still inherit --------------------------------------
const f = makeSession('session-fff66666-0000-0000-0000-00000000000f', workspace, {
  messages: [],
  header: { parentSession: 'session-parent' },
})
handlers.get('session/created')(f)
await sleep(40)
check('F sub-agent Session inherits', f.events.length === 0, JSON.stringify(f.events))

// --- G. the folder listing is what the run should leave behind --------------
check('G workspace holds A and C folders',
  JSON.stringify(await entries()) === JSON.stringify([`每日工作总结`, `每日工作总结-2`].sort()),
  await entries())

console.log('')
if (failures === 0) console.log('ALL CHECKS PASSED')
else {
  console.log(`${failures} CHECK(S) FAILED`)
  process.exitCode = 1
}
