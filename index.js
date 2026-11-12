/**
 * dsh-session-folders
 *
 * Every newly created conversation that starts inside a registered workspace
 * gets a folder of its own below that workspace, and the conversation's
 * effective working directory becomes that folder. The Session header keeps the
 * original project directory, so the Session stays grouped under its workspace
 * in the sidebar; only the directory the tools and the shell operate in changes.
 *
 * The folder is created as soon as the Session exists --the title does not exist
 * yet at that moment --and is renamed in place to `{title}{date}` once a title
 * has been folded into the Session log.
 *
 * Conversations that already carry a reply are left where they are; the plugin
 * runs in every registered workspace, and `isolateSessions` names Sessions that
 * should be retrofitted anyway.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'

/** Shortest plausible drive root, e.g. "C:". */
const DRIVE_ROOT = /^[a-zA-Z]:$/
/** Windows devices that cannot be used as a plain folder name. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const TOKENS = /\{(title|date|time|id|session)\}/g
/** Diagnostics land here when the config enables `debug`. */
const TRACE_PATH = join(homedir(), '.dsh', 'session-folders.log')
/** Session id to folder map, so a Session that left the store still finds its folder. */
const INDEX_PATH = join(homedir(), '.dsh', 'session-folders.json')
/** Browser-facing endpoints used by the delete confirmation. */
const INSPECT_ROUTE = '/api/dsh-session-folders/inspect'
const DELETE_ROUTE = '/api/dsh-session-folders/delete'
/** Longest slice of a conversation title kept in a folder name. */
const TITLE_LIMIT = 60
/** A folder name may exceed this only after sanitizing has run. */
const NAME_LIMIT = 100
/** Errors that mean "the directory is in use right now", not "wrong request". */
const BLOCKED = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EEXIST'])

const DEFAULTS = {
  /** Turn the whole behaviour off without unloading the plugin. */
  enabled: true,
  /** Template for the per-conversation folder name. */
  folderName: '{title}',
  /** Also isolate forks and sub-agent Sessions; by default they inherit. */
  includeDerivedSessions: false,
  /** Session ids to move into a folder even though they already have content. */
  isolateSessions: [],
  /** Append one diagnostic line per decision to TRACE_PATH. */
  debug: false,
}

/** Workspace records drive every decision, so wait for the registry. */
export const inject = ['workspaceRegistry', 'webServer']

/** A log longer than this belongs to a conversation that already ran. */
const SEQ_HISTORY = 40

/** Sessions this process moved into a folder, keyed by Session id. */
const ISOLATED = new Map()
/** Pending rename timers keyed by Session id, so bursts collapse into one move. */
const RENAME_TIMERS = new Map()

// One line per process start, so a missing `apply` line can be told apart from
// a module that was never imported at all.
try {
  appendFileSync(TRACE_PATH, `${new Date().toISOString()} [${process.pid}] module loaded (build 12)\n`)
} catch {}

/**
 * Register the plugin.
 * @param ctx - the plugin context.
 * @param config - the bundle configuration row.
 */
export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  trace(options, `apply build=12 enabled=${options.enabled} folderName=${JSON.stringify(options.folderName)} derived=${options.includeDerivedSessions} forced=${JSON.stringify(options.isolateSessions ?? [])}`)
  if (options.enabled === false) return

  // The delete confirmation runs in the browser: the sidebar asks the Host how
  // the Session's folder looks, then tells it whether to remove the folder too.
  installFolderApi(ctx, options)

  ctx.on('session/created', (session) => {
    plan(ctx, session, options)
  })

  // Safety net: whatever the creation announcement did or missed, the folder is
  // in place before the first step's tools can touch the workspace.
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      await ensureIsolated(ctx, payload?.agent, options)
    } catch (error) {
      trace(options, `error: pre-step ensure failed (${String(error)})`)
    }
    return next()
  })

  // A conversation title is folded into the log after the Session exists, so
  // the folder takes its final name here rather than at creation time.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'session/title') return
    scheduleRename(ctx, session, options, 400)
  })

  // Renaming a directory a running tool still holds open can fail; the end of a
  // turn is the first quiet moment, so any remaining move is retried there.
  ctx.on('agent/turn-stopping', (payload) => {
    const session = payload?.agent?.session
    if (session === undefined) return
    if (!ISOLATED.has(String(session.id))) return
    scheduleRename(ctx, session, options, 0)
  })

  ctx.on('session/disposed', (session) => {
    forget(session)
  })

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const handle of RENAME_TIMERS.values()) clearTimeout(handle)
      RENAME_TIMERS.clear()
      ISOLATED.clear()
    })
  }
}

/**
 * Synchronous guard pass: reject Sessions that must not be isolated and defer
 * the filesystem work until the creation announcement has finished, because
 * the Session log refuses appends while its synchronous listeners run.
 */
function plan(ctx, session, options) {
  if (session === undefined || session === null) {
    trace(options, 'skip: no session payload')
    return
  }

  let header
  let seq
  try {
    header = session.header
    seq = Number(session.seq)
  } catch (error) {
    trace(options, `skip: unreadable Session (${String(error)})`)
    return
  }
  if (header === undefined || header === null) {
    trace(options, 'skip: no header')
    return
  }

  if (typeof header.cwd !== 'string' || header.cwd.length === 0) {
    trace(options, `skip: header.cwd is ${JSON.stringify(header.cwd)} id=${String(session.id)}`)
    return
  }

  // `session/created` also announces Sessions the app restores on start, and
  // Sessions whose log was reset by "new conversation" keep an old createdAt.
  // What tells them apart is the log itself: a conversation that already holds
  // a reply is left alone, an empty log is a conversation starting now.
  const sessionId = String(session.id)
  const forced = forcedIsolation(options, sessionId)
  if (!forced && hasConversation(session)) {
    trace(options, `skip: Session already holds a conversation seq=${seq} id=${sessionId}`)
    return
  }

  // A conversation that already moved into its folder must not move again.
  const settled = committedDirectoryOf(ctx, session)
  if (settled !== undefined && normalizePath(settled) !== normalizePath(header.cwd)) {
    trace(options, `skip: already isolated to ${settled} id=${sessionId}`)
    return
  }

  const derived = header.parentSession !== undefined || header.origin === 'subagent'
  trace(options, `created id=${sessionId} seq=${seq} cwd=${header.cwd} derived=${derived} forced=${forced}`)
  if (derived && options.includeDerivedSessions !== true) return

  const projectDirectory = header.cwd
  queueMicrotask(() => {
    isolate(ctx, session, sessionId, projectDirectory, options).catch((error) => {
      warn(ctx, `could not isolate Session ${sessionId}: ${String(error)}`)
      trace(options, `error id=${sessionId} ${String(error)}`)
    })
  })
}

/** Whether the log already holds a conversation of its own. */
function hasConversation(session) {
  // A long log means the conversation ran, whatever the message projection says.
  if (Number(session?.seq) > SEQ_HISTORY) return true
  try {
    if (typeof session.deriveMessages === 'function') {
      const messages = session.deriveMessages()
      if (Array.isArray(messages)) {
        // A reply proves the conversation ran; a lone opening prompt does not,
        // because the prompt can be spliced before the Session is announced.
        return messages.some((message) => message?.role === 'assistant')
      }
    }
  } catch {}
  return false
}

/** Whether the config lists this Session for a retrofit. */
function forcedIsolation(options, sessionId) {
  const listed = options.isolateSessions
  if (!Array.isArray(listed)) return false
  return listed.some((entry) => String(entry).trim() === sessionId)
}

/**
 * Last-chance isolation, awaited by `agent/pre-step`.
 *
 * The creation announcement is the main trigger, but a Session can also be
 * created before the workspace registry is ready, or restored from a log whose
 * directory was removed. Running the same guard pass here means the first
 * step's tools always see the per-conversation folder, and a failure at
 * creation time is repaired instead of leaving the conversation unisolated.
 */
async function ensureIsolated(ctx, agent, options) {
  const session = agent?.session
  if (session === undefined || session === null) return

  const sessionId = String(session.id)
  if (ISOLATED.has(sessionId)) return

  let header
  try {
    header = session.header
  } catch {
    return
  }
  if (typeof header?.cwd !== 'string' || header.cwd.length === 0) return

  const settled = committedDirectoryOf(ctx, session)
  if (settled !== undefined && normalizePath(settled) !== normalizePath(header.cwd)) return

  if (!forcedIsolation(options, sessionId) && hasConversation(session)) return
  if ((header.parentSession !== undefined || header.origin === 'subagent') && options.includeDerivedSessions !== true) return

  trace(options, `pre-step ensure id=${sessionId} seq=${Number(session.seq)} cwd=${header.cwd}`)
  await isolate(ctx, session, sessionId, header.cwd, options)
}

/** Create the folder and point the Session at it. */
async function isolate(ctx, session, sessionId, projectDirectory, options) {
  const registry = workspaceRegistryOf(ctx)
  if (registry === undefined) {
    warn(ctx, 'workspace registry unavailable; keeping the workspace directory')
    trace(options, 'error: workspace registry unavailable')
    return
  }

  let workspaces
  try {
    workspaces = registry.list()
  } catch (error) {
    warn(ctx, `cannot list workspaces: ${String(error)}`)
    trace(options, `error: workspace list failed (${String(error)})`)
    return
  }

  const workspace = matchWorkspace(workspaces, projectDirectory, options)
  if (workspace === undefined) {
    trace(options, `skip: ${projectDirectory} is not a registered workspace`)
    return
  }

  const title = titleOf(ctx, session)
  const name = folderName(options.folderName, sessionId, title)
  if (name.length === 0) {
    warn(ctx, 'folderName produced an empty name; keeping the workspace directory')
    trace(options, 'error: empty folderName after sanitizing')
    return
  }

  const folder = await createFolder(workspace.path, name)
  trace(options, `folder=${folder}`)
  await commitDirectory(ctx, session, folder, options)
  ISOLATED.set(sessionId, { workspacePath: workspace.path, folder, title })
  rememberFolder(sessionId, workspace.path, folder)
  keepMembership(ctx, workspace, sessionId, options)
  log(ctx, `Session ${sessionId} works in ${folder}`)
  trace(options, `committed id=${sessionId} folder=${folder} title=${JSON.stringify(title ?? '')}`)

  // A title can already be folded by the time the microtask runs.
  if (title === undefined) scheduleRename(ctx, session, options, 0)
}

/**
 * Commit the folder as the Session's effective working directory.
 *
 * The `working-directory/change` event is the same durable event the core
 * working-directory service writes; appending it directly keeps the change off
 * the transcript, unlike the service's optional model-visible notice.
 */
async function commitDirectory(ctx, session, folder, options) {
  try {
    session.append('working-directory/change', { cwd: folder })
    return
  } catch (error) {
    // The creation announcement may still own the log for a tick.
    warn(ctx, `first directory commit was refused (${String(error)}); retrying`)
    trace(options, `append refused: ${String(error)}`)
  }

  await delay(200)
  session.append('working-directory/change', { cwd: folder })
}

/** Collapse a burst of title updates into one pending move. */
function scheduleRename(ctx, session, options, waitMs) {
  const sessionId = String(session?.id)
  if (!ISOLATED.has(sessionId)) return

  const pending = RENAME_TIMERS.get(sessionId)
  if (pending !== undefined) clearTimeout(pending)

  const run = () => {
    RENAME_TIMERS.delete(sessionId)
    renameSessionFolder(ctx, session, options).catch((error) => {
      trace(options, `rename error id=${sessionId} ${String(error)}`)
    })
  }

  if (waitMs <= 0) {
    run()
    return
  }

  const handle = setTimeout(run, waitMs)
  handle.unref?.()
  RENAME_TIMERS.set(sessionId, handle)
}

/**
 * Rename the Session's folder to the current `{title}{date}` name.
 *
 * Nothing happens while the title equals the name the folder already has, when
 * the user pointed the Session somewhere else in the meantime, or when the
 * directory is still in use --the next title event or the end of the turn
 * retries the move.
 */
async function renameSessionFolder(ctx, session, options) {
  const sessionId = String(session?.id)
  const entry = ISOLATED.get(sessionId)
  if (entry === undefined) return

  const title = titleOf(ctx, session)
  if (title === undefined) return
  if (title === entry.title) return

  const current = entry.folder
  const effective = committedDirectoryOf(ctx, session)
  if (effective !== undefined && normalizePath(effective) !== normalizePath(current)) {
    trace(options, `rename skipped: Session moved to ${effective}`)
    ISOLATED.delete(sessionId)
    return
  }

  const name = folderName(options.folderName, sessionId, title)
  if (name.length === 0) return

  let moved
  try {
    moved = await moveFolder(entry.workspacePath, current, name)
  } catch (error) {
    trace(options, `rename deferred id=${sessionId} ${String(error)}`)
    return
  }

  if (normalizePath(moved) === normalizePath(current)) {
    entry.title = title
    return
  }

  entry.folder = moved
  entry.title = title
  rememberFolder(sessionId, entry.workspacePath, moved)
  try {
    await commitDirectory(ctx, session, moved, options)
  } catch (error) {
    // The log is the source of truth: put the folder back rather than leave the
    // Session pointing at a directory that no longer exists.
    try {
      await rename(moved, current)
      entry.folder = current
      entry.title = undefined
    } catch {}
    trace(options, `rename reverted id=${sessionId} ${String(error)}`)
    return
  }

  log(ctx, `Session ${sessionId} folder renamed to ${basename(moved)}`)
  trace(options, `renamed id=${sessionId} from=${current} to=${moved}`)
}

/** Move `current` to `workspace/base`, suffixing the name when it is taken. */
async function moveFolder(workspacePath, current, base) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let candidate = join(workspacePath, base)
    for (let suffix = 2; suffix < 100; suffix += 1) {
      if (normalizePath(candidate) === normalizePath(current)) return current
      if (await folderExists(candidate)) {
        candidate = join(workspacePath, `${base}-${suffix}`)
        continue
      }
      try {
        await rename(current, candidate)
        return candidate
      } catch (error) {
        if (!BLOCKED.has(error?.code)) throw error
        break
      }
    }
    await delay(200 * (attempt + 1))
  }
  throw new Error(`folder ${current} is in use`)
}

/** Drop every trace of a Session that left the store. */
function forget(session) {
  const sessionId = String(session?.id)
  const pending = RENAME_TIMERS.get(sessionId)
  if (pending !== undefined) clearTimeout(pending)
  RENAME_TIMERS.delete(sessionId)
  ISOLATED.delete(sessionId)
}

/**
 * Re-assert Workspace membership after the directory change.
 *
 * The Session header (the Workspace's membership key) is untouched, so this is
 * normally a no-op; it only matters if the registry re-indexed the Session while
 * its effective directory moved.
 */
function keepMembership(ctx, workspace, sessionId, options) {
  try {
    const settled = workspace.attachSession(sessionId)
    if (settled && typeof settled.catch === 'function') {
      settled.catch((error) => trace(options, `attachSession refused: ${String(error)}`))
    }
  } catch (error) {
    trace(options, `attachSession failed: ${String(error)}`)
  }
}

/** The Workspace whose canonical directory is exactly the Session's project. */
function matchWorkspace(workspaces, projectDirectory, options) {
  const target = normalizePath(projectDirectory)
  const seen = []
  for (const workspace of workspaces ?? []) {
    if (typeof workspace?.path !== 'string') continue
    seen.push(workspace.path)
    if (normalizePath(workspace.path) === target) return workspace
  }
  trace(options, `workspaces=${JSON.stringify(seen)}`)
  return undefined
}

/** Create `workspace/base`, adding a numeric suffix when that name is taken. */
async function createFolder(workspacePath, base) {
  let candidate = join(workspacePath, base)
  for (let attempt = 2; attempt < 100; attempt += 1) {
    try {
      await mkdir(candidate)
      return candidate
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    candidate = join(workspacePath, `${base}-${attempt}`)
  }
  throw new Error(`every candidate folder name starting with ${JSON.stringify(base)} is taken`)
}

/**
 * Render the configured template into a portable folder name.
 *
 * Without a title the `{title}` token renders empty, so a `{title}` template
 * starts out as the Session id and is renamed once the title lands.
 */
function folderName(template, sessionId, title, now = new Date()) {
  const values = {
    // Sanitized on its own so stripped characters do not leave a dangling
    // space between the title and the date.
    title: sanitize(trimTitle(title)),
    date: `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`,
    time: `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`,
    id: sessionId.replace(/^session-/, '').slice(0, 8),
    session: sessionId,
  }
  const rendered = String(template ?? '').replace(TOKENS, (_, token) => values[token] ?? '')
  const name = sanitize(rendered)
  if (name.length > 0) return name
  // A template made only of `{title}` collapses until a title exists.
  return sanitize(values.id)
}

function trimTitle(title) {
  if (typeof title !== 'string') return ''
  const text = title.replace(/\s+/g, ' ').trim()
  return text.length > TITLE_LIMIT ? text.slice(0, TITLE_LIMIT).trim() : text
}

function sanitize(value) {
  let name = String(value)
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  if (name.length > NAME_LIMIT) name = name.slice(0, NAME_LIMIT).replace(/[. ]+$/, '')
  if (name.length === 0) return ''
  if (RESERVED.test(name)) return `_${name}`
  return name
}

/** Compare directories the way the platform does: case-insensitive on Windows. */
function normalizePath(value) {
  let path = String(value).replace(/[\\/]+/g, sep)
  if (path.length > 1 && path.endsWith(sep)) {
    const trimmed = path.slice(0, -1)
    if (!DRIVE_ROOT.test(trimmed)) path = trimmed
  }
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function folderExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The folded conversation title, when the title service is present. */
function titleOf(ctx, session) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : undefined
    if (service === undefined || typeof service.get !== 'function') return undefined
    const snapshot = service.get(session)
    const title = snapshot?.title
    return typeof title === 'string' && title.length > 0 ? title : undefined
  } catch {
    return undefined
  }
}

/**
 * Read a service without requiring it in `inject`; cordis refuses plain
 * property access to services a plugin does not declare.
 */
function workspaceRegistryOf(ctx) {
  try {
    if (typeof ctx.get === 'function') {
      const registry = ctx.get('workspaceRegistry')
      if (registry !== undefined) return registry
    }
  } catch {}
  try {
    return ctx.workspaceRegistry
  } catch {
    return undefined
  }
}

/**
 * The Session's recorded working directory, or undefined when the projection
 * has not been recorded yet (the service then reports its launch fallback).
 */
function committedDirectoryOf(ctx, session) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (service === undefined || typeof service.get !== 'function') return undefined
    const current = service.get(session)
    if (typeof current !== 'string' || current.length === 0) return undefined
    const fallback = typeof service.defaultDirectory === 'string' ? service.defaultDirectory : undefined
    if (fallback !== undefined && normalizePath(current) === normalizePath(fallback)) return undefined
    return current
  } catch {
    return undefined
  }
}

/** Diagnostics: one line per decision, only while `debug` is on. */
function trace(options, message) {
  if (options.debug !== true) return
  try {
    appendFileSync(TRACE_PATH, `${new Date().toISOString()} [${process.pid}] ${message}\n`)
  } catch {}
}

/** Log without letting a missing or misbehaving logger break the Session. */
function log(ctx, message) {
  for (const logger of loggersOf(ctx)) {
    try {
      logger?.info?.(`session-folders: ${message}`)
      return
    } catch {}
  }
}

function warn(ctx, message) {
  for (const logger of loggersOf(ctx)) {
    try {
      logger?.warn?.(`session-folders: ${message}`)
      return
    } catch {}
  }
}

function loggersOf(ctx) {
  const found = []
  try {
    if (typeof ctx.get === 'function') found.push(ctx.get('logger'))
  } catch {}
  try {
    found.push(ctx.logger)
  } catch {}
  return found
}

/*
 * browser-facing folder API
 *
 * The sidebar confirmation lives in the browser, so it needs two Host calls:
 * one that describes the Session's folder and one that performs the removal.
 * They are plain HTTP routes registered on the Host web server, which is also
 * how other bundles in this profile talk to their Host half.
 */

/** Register the inspect and delete endpoints; failures never break the rest. */
function installFolderApi(ctx, options) {
  const server = webServerOf(ctx)
  if (server === undefined || typeof server.register !== 'function') {
    warn(ctx, 'web server unavailable; the folder delete confirmation is disabled')
    trace(options, 'error: web server unavailable')
    return
  }

  const disposers = []

  try {
    disposers.push(server.register({
      kind: 'exact',
      path: INSPECT_ROUTE,
      handler: async (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { allow: 'GET, HEAD' })
          response.end()
          return
        }
        if (!trustedRequest(request)) {
          sendJson(response, 403, { ok: false, error: '仅允许本机同源请求' })
          return
        }

        let query = ''
        try {
          query = new URL(String(request.url ?? ''), 'http://localhost').searchParams.get('sessionId') ?? ''
        } catch {}
        const sessionId = query.trim()
        if (sessionId.length === 0) {
          sendJson(response, 400, { ok: false, error: '缺少 sessionId' })
          return
        }

        const state = await inspectFolder(ctx, sessionId)
        trace(options, `inspect id=${sessionId} managed=${state.managed} content=${state.hasContent} count=${state.entryCount}`)
        sendJson(response, 200, { ok: true, sessionId, ...state })
      },
    }))
  } catch (error) {
    warn(ctx, `cannot register the inspect route: ${String(error)}`)
    trace(options, `error: inspect route failed (${String(error)})`)
  }

  try {
    disposers.push(server.register({
      kind: 'exact',
      path: DELETE_ROUTE,
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST' })
          response.end()
          return
        }
        if (!trustedRequest(request)) {
          sendJson(response, 403, { ok: false, error: '仅允许本机同源请求' })
          return
        }

        const body = await readJsonBody(request)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
        if (sessionId.length === 0) {
          sendJson(response, 400, { ok: false, error: '缺少 sessionId' })
          return
        }

        try {
          const result = await removeSession(ctx, options, sessionId, body?.deleteFolder === true)
          trace(options, `delete id=${sessionId} folder=${result.folderDeleted} via=${result.via} deleted=${result.deleted}`)
          sendJson(response, 200, { ok: true, sessionId, ...result })
        } catch (error) {
          warn(ctx, `cannot delete Session ${sessionId}: ${String(error)}`)
          trace(options, `error: delete failed id=${sessionId} (${String(error)})`)
          sendJson(response, 500, { ok: false, error: String(error) })
        }
      },
    }))
  } catch (error) {
    warn(ctx, `cannot register the delete route: ${String(error)}`)
    trace(options, `error: delete route failed (${String(error)})`)
  }

  if (disposers.length === 0) return
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {}
    }
  })
}

/** Describe the Session's folder without changing anything. */
async function inspectFolder(ctx, sessionId) {
  const folder = folderOf(ctx, sessionId)
  if (folder === undefined) return { managed: false, folderPath: null, exists: false, hasContent: false, entryCount: 0 }

  let names
  try {
    names = await readdir(folder)
  } catch {
    return { managed: true, folderPath: folder, exists: false, hasContent: false, entryCount: 0 }
  }
  return { managed: true, folderPath: folder, exists: true, hasContent: names.length > 0, entryCount: names.length }
}

/** Remove the folder (when asked) and then the Session itself. */
async function removeSession(ctx, options, sessionId, deleteFolder) {
  const state = await inspectFolder(ctx, sessionId)

  let folderDeleted = false
  if (deleteFolder && typeof state.folderPath === 'string') {
    folderDeleted = await deleteManagedFolder(ctx, options, state.folderPath)
  }

  let deletion
  try {
    deletion = await deleteConversation(ctx, options, sessionId)
  } catch (error) {
    trace(options, `delete error id=${sessionId} (${String(error)})`)
    deletion = { deleted: false, via: 'none', reason: String(error) }
  }

  if (folderDeleted) forgetFolder(sessionId)
  forget({ id: sessionId })

  return {
    deleted: deletion.deleted === true,
    folderDeleted,
    folderPath: state.folderPath ?? null,
    entryCount: state.entryCount ?? 0,
    via: deletion.via,
    reason: deletion.reason,
  }
}

/** Refuse to remove anything that is not a folder inside a registered workspace. */
async function deleteManagedFolder(ctx, options, folder) {
  const workspace = insideSomeWorkspace(ctx, folder)
  if (workspace === undefined) {
    warn(ctx, `refusing to delete ${folder}: not inside a registered workspace`)
    trace(options, `refused folder delete not-inside-workspace ${folder}`)
    return false
  }

  try {
    await rm(folder, { recursive: true, force: true })
    log(ctx, `removed folder ${folder}`)
    return true
  } catch (error) {
    warn(ctx, `cannot remove ${folder}: ${String(error)}`)
    trace(options, `folder delete failed ${folder} (${String(error)})`)
    return false
  }
}

/**
 * Delete the Session itself.
 *
 * The archive-manager bundle overlays `workspaceRegistry` with a permanent
 * `deleteSession`; when it is absent the store entries are removed directly and
 * the Workspace membership is dropped.
 */
async function deleteConversation(ctx, options, sessionId) {
  const registry = workspaceRegistryOf(ctx)

  if (registry !== undefined && typeof registry.deleteSession === 'function') {
    try {
      await registry.deleteSession(sessionId)
      return { deleted: true, via: 'workspaceRegistry.deleteSession' }
    } catch (error) {
      trace(options, `deleteSession refused id=${sessionId} (${String(error)})`)
    }
  }

  const removed = await removeSessionStore(sessionId)
  await detachFromWorkspace(ctx, sessionId)
  return { deleted: removed > 0, via: 'session-store', files: removed, reason: removed > 0 ? undefined : 'no stored files matched' }
}

/** Remove the on-disk Session store and its projection cache. */
async function removeSessionStore(sessionId) {
  const root = join(homedir(), '.dsh', 'sessions')
  let removed = 0

  let containers = []
  try {
    containers = await readdir(root, { withFileTypes: true })
  } catch {
    containers = []
  }

  for (const container of containers) {
    if (container.isDirectory() !== true) continue
    const store = join(root, container.name, `session-${sessionId}`)
    try {
      await rm(store, { recursive: true, force: true })
      removed += 1
    } catch {}
  }

  try {
    await rm(join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', `session-${sessionId}.json`), { force: true })
    removed += 1
  } catch {}

  return removed
}

/** Drop the Session from every Workspace that still lists it. */
async function detachFromWorkspace(ctx, sessionId) {
  const registry = workspaceRegistryOf(ctx)
  let workspaces
  try {
    workspaces = registry?.list?.() ?? []
  } catch {
    return
  }

  for (const workspace of workspaces) {
    const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
    if (!ids.some((id) => String(id) === sessionId)) continue
    try {
      await workspace.detachSession(sessionId)
    } catch {}
  }
}

/** The folder this process moved the Session into, from memory or from the index. */
function folderOf(ctx, sessionId) {
  const live = ISOLATED.get(sessionId)
  if (live !== undefined && typeof live.folder === 'string') return live.folder

  const entry = folderEntry(sessionId)
  if (entry !== undefined) return entry.folder

  // A Session isolated by an earlier process has no index entry yet: its last
  // committed working directory is still recorded in the projection cache.
  const cached = cachedFolder(sessionId)
  if (cached === undefined) return undefined

  const workspace = insideSomeWorkspace(ctx, cached)
  if (workspace === undefined) return undefined

  rememberFolder(sessionId, workspace.path, cached)
  return cached
}

/** The projection cache's last committed working directory, when it is readable. */
function cachedFolder(sessionId) {
  try {
    const file = join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', `session-${sessionId}.json`)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const rows = parsed?.record?.rows ?? parsed?.rows ?? {}
    const value = rows?.workingDirectory?.val
    return typeof value === 'string' && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/** The Workspace that strictly contains `folder`, never a Workspace root itself. */
function insideSomeWorkspace(ctx, folder) {
  const registry = workspaceRegistryOf(ctx)
  let workspaces
  try {
    workspaces = registry?.list?.() ?? []
  } catch {
    return undefined
  }

  const target = normalizePath(folder)
  for (const workspace of workspaces) {
    if (typeof workspace?.path !== 'string') continue
    const root = normalizePath(workspace.path)
    if (target !== root && target.startsWith(root + sep)) return workspace
  }
  return undefined
}

/** Read the Host-to-browser bridge without requiring a hard dependency. */
function webServerOf(ctx) {
  try {
    const server = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (server !== undefined) return server
  } catch {}
  try {
    return ctx.webServer
  } catch {
    return undefined
  }
}

/** Accept only loopback, same-origin requests carrying our own header. */
function trustedRequest(request) {
  const header = (name) => {
    const value = request?.headers?.[name]
    return Array.isArray(value) ? value[0] : value
  }

  if (header('x-session-folders') !== '1') return false
  if (!isLoopback(header('host') === undefined ? undefined : hostOf(`http://${header('host')}`))) return false
  if (!isLoopback(String(request?.socket?.remoteAddress ?? ''))) return false

  const site = header('sec-fetch-site')
  if (site !== undefined && site !== 'same-origin') return false

  const origin = header('origin')
  if (origin === undefined || origin === '') return true
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopback(url.hostname) && url.host === header('host')
  } catch {
    return false
  }
}

function hostOf(value) {
  try {
    return new URL(value).hostname
  } catch {
    return undefined
  }
}

function isLoopback(value) {
  const host = String(value ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === 'localhost.' || host === '::1'
    || host.startsWith('127.') || host.startsWith('::ffff:127.')
}

function sendJson(response, statusCode, value) {
  try {
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(value))
  } catch {}
}

/** Read a small JSON body; anything unparsable reads as `undefined`. */
function readJsonBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    let bytes = 0
    request.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > 64 * 1024) return
      chunks.push(buffer)
    })
    request.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : undefined)
      } catch {
        resolve(undefined)
      }
    })
    request.on('error', () => resolve(undefined))
  })
}

/* ---- Session id -> folder index ------------------------------------ */

function readIndex() {
  try {
    const parsed = JSON.parse(readFileSync(INDEX_PATH, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeIndex(entries) {
  try {
    mkdirSync(dirname(INDEX_PATH), { recursive: true })
    writeFileSync(INDEX_PATH, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  } catch {}
}

function rememberFolder(sessionId, workspacePath, folder) {
  try {
    const entries = readIndex()
    entries[sessionId] = { folder, workspacePath, at: Date.now() }
    writeIndex(entries)
  } catch {}
}

function forgetFolder(sessionId) {
  try {
    const entries = readIndex()
    if (entries[sessionId] === undefined) return
    delete entries[sessionId]
    writeIndex(entries)
  } catch {}
}

function folderEntry(sessionId) {
  const entry = readIndex()[sessionId]
  if (entry === null || typeof entry !== 'object') return undefined
  if (typeof entry.folder !== 'string' || entry.folder.length === 0) return undefined
  return entry
}
