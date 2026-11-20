/**
 * Build-14 host check: drag-drop reparenting endpoints (move-workspace and
 * move-session). Runs against a throwaway HOME so nothing real is touched.
 */
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, sep } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsf8-'))
process.env.USERPROFILE = HOME
process.env.HOME = HOME

const PLUGIN = new URL('../index.js', import.meta.url).href
const mod = await import(PLUGIN)

const root = join(HOME, 'workspace')
const a = join(root, 'A')
const aChild = join(a, '子')
const b = join(root, 'B')
const c = join(root, 'C')
const d = join(root, 'D')
for (const folder of [root, a, aChild, b, c, d]) mkdirSync(folder, { recursive: true })

// Session folders for the move-session test.
const sessionCFolder = join(c, '对话C')
mkdirSync(sessionCFolder, { recursive: true })

// Pre-populate the persisted index so `folderOf` finds the session's folder.
const indexPath = join(HOME, '.dsh', 'session-folders.json')
mkdirSync(dirname(indexPath), { recursive: true })
writeFileSync(indexPath, JSON.stringify({
  'session-c': { folder: sessionCFolder, workspacePath: c, at: Date.now() },
}, null, 2), 'utf8')

const sessionPaths = new Map()
const host = {
  rememberSessionPath: (id, path) => sessionPaths.set(id, path),
  candidateMatches: (id, path) => sessionPaths.get(id) === path,
}

function makeWorkspace(id, path, sessionIds) {
  const record = { path, title: id, sessionIds: [...sessionIds], createdAt: '', updatedAt: '' }
  return {
    id,
    get path() { return record.path },
    get title() { return record.title },
    get record() { return record },
    get sessionIds() { return record.sessionIds },
    async mutate(fn) {
      const changed = fn(record)
      const filtered = changed.sessionIds.filter((sid) => host.candidateMatches(sid, changed.path))
      Object.assign(record, changed, { sessionIds: filtered, updatedAt: new Date().toISOString() })
    },
    async detachSession(sid) {
      record.sessionIds = record.sessionIds.filter((id) => id !== sid)
    },
    async insertSessionBefore(sid, beforeSid) {
      if (!record.sessionIds.includes(sid)) throw new Error(`session '${sid}' is not accounted`)
      const without = record.sessionIds.filter((id) => id !== sid)
      const at = beforeSid === undefined ? without.length : without.indexOf(beforeSid)
      without.splice(at, 0, sid)
      record.sessionIds = without
    },
  }
}

const wsRoot = makeWorkspace('ws-root', root, [])
const wsA = makeWorkspace('ws-a', a, [])
const wsAChild = makeWorkspace('ws-a-child', aChild, [])
const wsB = makeWorkspace('ws-b', b, [])
const wsC = makeWorkspace('ws-c', c, ['session-c'])
const wsD = makeWorkspace('ws-d', d, [])
const workspaces = [wsRoot, wsA, wsAChild, wsB, wsC, wsD]

const registry = {
  host,
  list: () => workspaces,
  get: (id) => workspaces.find((w) => w.id === id),
  delete: async () => true,
  insertBefore: async () => {},
}

const routes = new Map()
const services = {
  workspaceRegistry: registry,
  webServer: {
    register: ({ path, handler }) => {
      routes.set(path, handler)
      return () => routes.delete(path)
    },
  },
}

const ctx = {
  get: (name) => services[name],
  on: () => {},
  effect: () => {},
}

mod.apply(ctx, { enabled: true, debug: false })

function makeRequest({ method, url, headers = {}, body }) {
  const listeners = {}
  const req = {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    on: (name, fn) => {
      listeners[name] = listeners[name] ?? []
      listeners[name].push(fn)
      return req
    },
  }
  setImmediate(() => {
    if (body !== undefined) for (const fn of listeners.data ?? []) fn(Buffer.from(JSON.stringify(body)))
    for (const fn of listeners.end ?? []) fn()
  })
  return req
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: undefined,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

async function call(method, path, { headers = { 'x-session-folders': '1', host: '127.0.0.1:14679' }, body } = {}) {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error(`route ${path} is not registered`)
  const req = makeRequest({ method, url: path, headers, body })
  const res = makeResponse()
  await handler(req, res)
  return { status: res.statusCode, data: res.body === '' ? null : JSON.parse(res.body) }
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  -> ${detail}`}`)
}

const MOVE_WORKSPACE = '/api/dsh-session-folders/move-workspace'
const MOVE_SESSION = '/api/dsh-session-folders/move-session'

// ── move-workspace ──────────────────────────────────────────────────

// 1. move ws-a into ws-b (its child workspace relocates too)
let res = await call('POST', MOVE_WORKSPACE, { body: { workspaceId: 'ws-a', targetParentId: 'ws-b' } })
const movedA = join(b, 'A')
const movedChild = join(b, 'A', '子')
check('move-workspace returns success', res.status === 200 && res.data?.moved === true && res.data?.affected === 2, JSON.stringify(res.data))
check('source folder moved', existsSync(movedA) && !existsSync(a), movedA)
check('descendant folder moved too', existsSync(movedChild) && !existsSync(aChild), movedChild)
check('ws-a path updated', wsA.path === movedA, wsA.path)
check('ws-a-child path updated', wsAChild.path === movedChild, wsAChild.path)

// 2. moving a workspace into its own descendant is refused
res = await call('POST', MOVE_WORKSPACE, { body: { workspaceId: 'ws-b', targetParentId: 'ws-a-child' } })
check('self/descendant refused', res.status === 500 && /子工作区/.test(res.data?.error ?? ''), JSON.stringify(res.data))

// 3. unknown target is refused
res = await call('POST', MOVE_WORKSPACE, { body: { workspaceId: 'ws-a', targetParentId: 'ws-nope' } })
check('unknown target refused', res.status === 500 && res.data?.ok === false, JSON.stringify(res.data))

// 4. missing fields refused
res = await call('POST', MOVE_WORKSPACE, { body: { workspaceId: 'ws-a' } })
check('missing targetParentId refused', res.status === 400, String(res.status))

// ── move-session ────────────────────────────────────────────────────

// 5. move session-c from ws-c into ws-d
res = await call('POST', MOVE_SESSION, { body: { sessionId: 'session-c', targetWorkspaceId: 'ws-d' } })
const movedSessionFolder = join(d, '对话C')
check('move-session returns success', res.status === 200 && res.data?.moved === true, JSON.stringify(res.data))
check('session folder moved', existsSync(movedSessionFolder) && !existsSync(sessionCFolder), movedSessionFolder)
check('detached from old workspace', !wsC.record.sessionIds.includes('session-c'), JSON.stringify(wsC.record.sessionIds))
check('attached to target workspace', wsD.record.sessionIds.includes('session-c'), JSON.stringify(wsD.record.sessionIds))
check('session path re-pointed', sessionPaths.get('session-c') === d, sessionPaths.get('session-c'))
check('index re-pointed', (JSON.parse(readFileSync(indexPath, 'utf8'))['session-c']?.workspacePath) === d)

// 6. moving a session into the workspace that already owns it only reorders (no folder move)
res = await call('POST', MOVE_SESSION, { body: { sessionId: 'session-c', targetWorkspaceId: 'ws-d', beforeSessionId: undefined } })
check('same-owner move is a no-op success', res.status === 200 && res.data?.moved === true && res.data?.folder === movedSessionFolder, JSON.stringify(res.data))

// 7. unknown target workspace refused
res = await call('POST', MOVE_SESSION, { body: { sessionId: 'session-c', targetWorkspaceId: 'ws-nope' } })
check('unknown target refused', res.status === 500 && res.data?.ok === false, JSON.stringify(res.data))

// 8. session without a folder refused
res = await call('POST', MOVE_SESSION, { body: { sessionId: 'session-missing', targetWorkspaceId: 'ws-d' } })
check('folderless session refused', res.status === 500 && /找不到对话的文件夹/.test(res.data?.error ?? ''), JSON.stringify(res.data))

// 9. wrong method refused
res = await call('GET', MOVE_WORKSPACE)
check('move-workspace rejects GET', res.status === 405, String(res.status))
res = await call('GET', MOVE_SESSION)
check('move-session rejects GET', res.status === 405, String(res.status))

// 10. untrusted request refused
res = await call('POST', MOVE_WORKSPACE, { headers: {}, body: { workspaceId: 'ws-a', targetParentId: 'ws-b' } })
check('move-workspace untrusted refused', res.status === 403, String(res.status))
res = await call('POST', MOVE_SESSION, { headers: {}, body: { sessionId: 'session-c', targetWorkspaceId: 'ws-d' } })
check('move-session untrusted refused', res.status === 403, String(res.status))

await rm(HOME, { recursive: true, force: true })

const failed = checks.filter((entry) => entry.ok !== true)
console.log(`\n${failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} CHECK(S) FAILED`}`)
process.exit(failed.length === 0 ? 0 : 1)
