/**
 * Build-13 host check: the sub-workspace endpoints used by the browser half.
 * Runs against a throwaway HOME so nothing real is touched.
 */
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsf7-'))
process.env.USERPROFILE = HOME
process.env.HOME = HOME

const PLUGIN = new URL('../index.js', import.meta.url).href
const mod = await import(PLUGIN)

const workspace = join(HOME, 'workspace')
mkdirSync(workspace, { recursive: true })

const created = []
const registry = {
  list: () => [
    { id: 'ws-root', path: workspace, title: '根工作区', sessionIds: [] },
  ],
  get: (id) => (id === 'ws-root' ? { id: 'ws-root', path: workspace, title: '根工作区', sessionIds: [] } : undefined),
  create: async (path, title) => {
    created.push({ path, title })
    return { id: `ws-${created.length}`, path, title, sessionIds: [] }
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

const WORKSPACES = '/api/dsh-session-folders/workspaces'
const CREATE_SUB = '/api/dsh-session-folders/create-sub-workspace'

// 1. list the registered workspaces
let res = await call('GET', WORKSPACES)
check('lists workspaces', res.status === 200 && res.data?.ok === true && Array.isArray(res.data.workspaces) && res.data.workspaces.length === 1, JSON.stringify(res.data))
check(
  'maps id/path/title/sessionCount',
  res.data?.workspaces?.[0]?.id === 'ws-root' &&
    res.data?.workspaces?.[0]?.path === workspace &&
    res.data?.workspaces?.[0]?.title === '根工作区' &&
    res.data?.workspaces?.[0]?.sessionCount === 0,
  JSON.stringify(res.data?.workspaces?.[0]),
)

// 2. create a sub-workspace under the root
res = await call('POST', CREATE_SUB, { body: { parentWorkspaceId: 'ws-root', name: '子项目' } })
const subFolder = join(workspace, '子项目')
check('create returns success', res.status === 200 && res.data?.created === true, JSON.stringify(res.data))
check('returns the new workspace', res.data?.workspace?.id === 'ws-1' && res.data?.workspace?.title === '子项目', JSON.stringify(res.data?.workspace))
check('echoes the parent', res.data?.parent?.id === 'ws-root' && res.data?.parent?.path === workspace, JSON.stringify(res.data?.parent))
check('folder created on disk', existsSync(subFolder), subFolder)
check('registry.create called once', created.length === 1 && created[0].path === subFolder && created[0].title === '子项目', JSON.stringify(created))

// 3. the name is sanitized (illegal chars become spaces)
res = await call('POST', CREATE_SUB, { body: { parentWorkspaceId: 'ws-root', name: '非法/名:字' } })
check('sanitized name used', res.status === 200 && existsSync(join(workspace, '非法 名 字')), JSON.stringify(res.data))

// 4. an empty name is refused
res = await call('POST', CREATE_SUB, { body: { parentWorkspaceId: 'ws-root', name: '   ' } })
check('empty name refused', res.status === 400, String(res.status))

// 5. an unknown parent is refused
res = await call('POST', CREATE_SUB, { body: { parentWorkspaceId: 'ws-nope', name: 'x' } })
check('unknown parent refused', res.status === 500 && res.data?.ok === false, JSON.stringify(res.data))

// 6. a registration failure rolls back the just-created folder
registry.create = async (path, title) => {
  created.push({ path, title })
  throw new Error('boom')
}
res = await call('POST', CREATE_SUB, { body: { parentWorkspaceId: 'ws-root', name: '回滚测试' } })
check('failed create returns 500', res.status === 500, String(res.status))
check('failed create leaves no folder', !existsSync(join(workspace, '回滚测试')), JSON.stringify(res.data))

// 7. wrong method is refused
res = await call('POST', WORKSPACES, { body: {} })
check('workspaces rejects POST', res.status === 405, String(res.status))
res = await call('GET', CREATE_SUB)
check('create-sub rejects GET', res.status === 405, String(res.status))

// 8. an untrusted request is refused
res = await call('GET', WORKSPACES, { headers: {} })
check('workspaces untrusted refused', res.status === 403, String(res.status))
res = await call('POST', CREATE_SUB, { headers: {}, body: { parentWorkspaceId: 'ws-root', name: 'x' } })
check('create-sub untrusted refused', res.status === 403, String(res.status))

await rm(HOME, { recursive: true, force: true })

const failed = checks.filter((entry) => entry.ok !== true)
console.log(`\n${failed.length === 0 ? 'ALL CHECKS PASSED' : `${failed.length} CHECK(S) FAILED`}`)
process.exit(failed.length === 0 ? 0 : 1)
