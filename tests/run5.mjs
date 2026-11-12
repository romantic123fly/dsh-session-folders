/**
 * Build-9 host check: the inspect/delete routes used by the browser half.
 * Runs against a throwaway HOME so nothing real is touched.
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsf5-'))
process.env.USERPROFILE = HOME
process.env.HOME = HOME

const PLUGIN = new URL('../index.js', import.meta.url).href
const mod = await import(PLUGIN)

const workspace = join(HOME, 'workspace')
mkdirSync(workspace, { recursive: true })

const A = 'session-aaaa1111-0000-0000-0000-000000000001'
const B = 'session-bbbb2222-0000-0000-0000-000000000002'
const C = 'session-cccc3333-0000-0000-0000-000000000003'
const D = 'session-dddd4444-0000-0000-0000-000000000004'

const folderA = join(workspace, '有文件的对话20261110')
const folderB = join(workspace, '空的对话20261110')
mkdirSync(folderA)
mkdirSync(folderB)
writeFileSync(join(folderA, '报告.txt'), 'hello')
mkdirSync(join(folderA, '子目录'))

mkdirSync(join(HOME, '.dsh'), { recursive: true })
writeFileSync(
  join(HOME, '.dsh', 'session-folders.json'),
  JSON.stringify({
    [A]: { folder: folderA, workspacePath: workspace, at: Date.now() },
    [B]: { folder: folderB, workspacePath: workspace, at: Date.now() },
    [D]: { folder: workspace, workspacePath: workspace, at: Date.now() },
  }),
)

const deleted = []
let allowDeleteSession = true

const registry = {
  list: () => [
    {
      path: workspace,
      sessionIds: [A, B, C, D],
      detachSession: async (id) => {
        deleted.push(`detach:${id}`)
      },
    },
  ],
  deleteSession: async (id) => {
    if (!allowDeleteSession) throw new Error('unsupported')
    deleted.push(`delete:${id}`)
  },
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
  const req = makeRequest({ method, url: path + (method === 'GET' ? `?sessionId=${encodeURIComponent(body?.sessionId ?? '')}` : ''), headers, body })
  const res = makeResponse()
  await handler(req, res)
  return { status: res.statusCode, data: res.body === '' ? null : JSON.parse(res.body) }
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  -> ${detail}`}`)
}

const INSPECT = '/api/dsh-session-folders/inspect'
const DELETE = '/api/dsh-session-folders/delete'

// 1. inspect a folder that has content
let res = await call('GET', INSPECT, { body: { sessionId: A } })
check('inspect reports content', res.data?.hasContent === true && res.data?.entryCount === 2, JSON.stringify(res.data))

// 2. inspect a folder that is empty
res = await call('GET', INSPECT, { body: { sessionId: B } })
check('inspect reports an empty folder', res.data?.hasContent === false && res.data?.entryCount === 0, JSON.stringify(res.data))

// 3. inspect a session the plugin never isolated
res = await call('GET', INSPECT, { body: { sessionId: C } })
check('inspect reports an unmanaged session', res.data?.managed === false, JSON.stringify(res.data))

// 4. "no": keep the folder, delete only the conversation
res = await call('POST', DELETE, { body: { sessionId: A, deleteFolder: false } })
check('false keeps the folder', existsSync(folderA) && res.data?.folderDeleted === false, JSON.stringify(res.data))
check('false still deletes the session', deleted.includes(`delete:${A}`), deleted.join(','))

// 5. "yes": drop folder and content
res = await call('POST', DELETE, { body: { sessionId: A, deleteFolder: true } })
check('true removes the folder', !existsSync(folderA) && res.data?.folderDeleted === true, JSON.stringify(res.data))
check('index forgets the session', JSON.parse(readFileSync(join(HOME, '.dsh', 'session-folders.json'), 'utf8'))[A] === undefined)

// 6. empty folder: removed without asking
res = await call('POST', DELETE, { body: { sessionId: B, deleteFolder: true } })
check('empty folder is removed', !existsSync(folderB))

// 7. a workspace root is never deleted, even when the index points at it
res = await call('POST', DELETE, { body: { sessionId: D, deleteFolder: true } })
check('workspace root is protected', existsSync(workspace) && res.data?.folderDeleted === false, JSON.stringify(res.data))

// 8. requests without the header are refused
res = await call('GET', INSPECT, { headers: {}, body: { sessionId: A } })
check('untrusted request refused', res.status === 403, String(res.status))

// 9. wrong method refused
res = await call('POST', INSPECT, { body: { sessionId: A } })
check('inspect rejects POST', res.status === 405, String(res.status))

// 10. fallback deletion without archive-manager: remove store + projcache
allowDeleteSession = false
const storeDir = join(HOME, '.dsh', 'sessions', '--w--', `session-${C}`)
mkdirSync(storeDir, { recursive: true })
writeFileSync(join(storeDir, 'session.v4.jsonl.zstd'), 'x')
const projcacheDir = join(HOME, '.dsh', 'storages', 'session_projcache', 'sessions')
mkdirSync(projcacheDir, { recursive: true })
writeFileSync(join(projcacheDir, `session-${C}.json`), '{}')

res = await call('POST', DELETE, { body: { sessionId: C, deleteFolder: false } })
check('fallback removes the store', !existsSync(storeDir), JSON.stringify(res.data))
check('fallback removes the projection cache', !existsSync(join(projcacheDir, `session-${C}.json`)))
check('fallback detaches the workspace', deleted.includes(`detach:${C}`), deleted.join(','))
check('fallback reports success', res.data?.deleted === true, JSON.stringify(res.data))

await rm(HOME, { recursive: true, force: true })

const failed = checks.filter((entry) => entry.ok !== true)
console.log(`\n${failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} CHECK(S) FAILED`}`)
process.exit(failed.length === 0 ? 0 : 1)
