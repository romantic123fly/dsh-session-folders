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
import { execFile } from 'node:child_process'
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
/** Browser-facing endpoints used by sub-workspace creation. */
const WORKSPACES_ROUTE = '/api/dsh-session-folders/workspaces'
const CREATE_SUB_ROUTE = '/api/dsh-session-folders/create-sub-workspace'
const WORKSPACE_INSPECT_ROUTE = '/api/dsh-session-folders/inspect-workspace'
const DELETE_WORKSPACE_ROUTE = '/api/dsh-session-folders/delete-workspace'
const REVEAL_ROUTE = '/api/dsh-session-folders/reveal'
/** Browser-facing endpoints used by drag-drop reparenting. */
const MOVE_WORKSPACE_ROUTE = '/api/dsh-session-folders/move-workspace'
const MOVE_SESSION_ROUTE = '/api/dsh-session-folders/move-session'
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
/** Last-observed workspace title per id, so a `domain/changed` title change is told apart from a session attach. */
const KNOWN_TITLES = new Map()
/** Sessions explicitly forgotten this process (disposed); the index fallback must not resurrect them. */
const FORGOTTEN = new Set()

// One line per process start, so a missing `apply` line can be told apart from
// a module that was never imported at all.
try {
  appendFileSync(TRACE_PATH, `${new Date().toISOString()} [${process.pid}] module loaded (build 14)\n`)
} catch {}

/**
 * Register the plugin.
 * @param ctx - the plugin context.
 * @param config - the bundle configuration row.
 */
export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  trace(options, `apply build=14 enabled=${options.enabled} folderName=${JSON.stringify(options.folderName)} derived=${options.includeDerivedSessions} forced=${JSON.stringify(options.isolateSessions ?? [])}`)
  if (options.enabled === false) return

  // The delete confirmation runs in the browser: the sidebar asks the Host how
  // the Session's folder looks, then tells it whether to remove the folder too.
  installFolderApi(ctx, options)

  // Sub-workspaces: the sidebar asks the Host to create a folder inside an
  // existing workspace and register it as a Workspace of its own.
  installSubWorkspaceApi(ctx, options)

  // Workspace deletion: the sidebar asks the Host how a workspace's folder
  // looks, then tells it whether to remove the folder (and its files) too.
  installWorkspaceDeleteApi(ctx, options)

  // "Reveal in file manager": open a folder in the OS explorer (Windows
  // Explorer / macOS Finder / Linux file manager) without touching the tree.
  installRevealApi(ctx, options)

  // Drag-drop reparenting: move a workspace (or conversation) into another
  // workspace's folder, relocating the folder and its contents, then re-point
  // the registry and the session-folder index at the new path.
  installMoveApi(ctx, options)

  // Keep workspace folders in sync with workspace titles: when a workspace's
  // display title changes, rename its folder on disk to match.
  {
    const registry = workspaceRegistryOf(ctx)
    if (registry !== undefined && typeof registry.list === 'function') {
      try {
        for (const workspace of registry.list()) KNOWN_TITLES.set(String(workspace.id), workspace.title)
      } catch {}
    }
    ctx.on('domain/changed', (change) => {
      try {
        if (change?.domain !== 'workspace') return
        if (change?.table !== 'workspaces') return
        if (change?.operation !== 'put') return
        const record = change?.value
        if (record === null || typeof record !== 'object' || typeof record.title !== 'string') return
        const id = String(change?.key)
        const previous = KNOWN_TITLES.get(id)
        if (previous === record.title) return
        KNOWN_TITLES.set(id, record.title)
        if (previous === undefined) return
        renameWorkspaceFolder(ctx, id, record.title, options).catch((error) => {
          trace(options, `error: workspace folder rename failed (${String(error)})`)
        })
      } catch (error) {
        trace(options, `error: domain/changed handler failed (${String(error)})`)
      }
    })
  }

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
  if (!ISOLATED.has(sessionId)) {
    // After a bundle reload the in-memory ISOLATED map resets to empty; rebuild
    // the entry from the persisted index so a rename still finds the folder.
    // A session explicitly disposed this process stays forgotten.
    if (FORGOTTEN.has(sessionId)) return
    const persisted = folderEntry(sessionId)
    if (persisted === undefined) return
    ISOLATED.set(sessionId, {
      workspacePath: persisted.workspacePath,
      folder: persisted.folder,
      title: undefined,
    })
  }

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
  let entry = ISOLATED.get(sessionId)
  if (entry === undefined) {
    const persisted = folderEntry(sessionId)
    if (persisted === undefined) return
    entry = { workspacePath: persisted.workspacePath, folder: persisted.folder, title: undefined }
    ISOLATED.set(sessionId, entry)
  }

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
  FORGOTTEN.add(sessionId)
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

/**
 * Register the sub-workspace endpoints: list the registered workspaces (for the
 * parent picker) and create a sub-workspace as a folder inside one of them.
 *
 * Recursion needs nothing special here: a sub-workspace is just another
 * registered workspace, so it becomes an equally valid parent the next time.
 */
function installSubWorkspaceApi(ctx, options) {
  const server = webServerOf(ctx)
  if (server === undefined || typeof server.register !== 'function') {
    warn(ctx, 'web server unavailable; sub-workspace creation is disabled')
    trace(options, 'error: web server unavailable (sub-workspace)')
    return
  }

  const disposers = []

  try {
    disposers.push(server.register({
      kind: 'exact',
      path: WORKSPACES_ROUTE,
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
        const workspaces = listWorkspaces(ctx)
        sendJson(response, 200, { ok: true, workspaces })
      },
    }))
  } catch (error) {
    warn(ctx, `cannot register the workspaces route: ${String(error)}`)
    trace(options, `error: workspaces route failed (${String(error)})`)
  }

  try {
    disposers.push(server.register({
      kind: 'exact',
      path: CREATE_SUB_ROUTE,
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
        const parentWorkspaceId = typeof body?.parentWorkspaceId === 'string' ? body.parentWorkspaceId.trim() : ''
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        if (parentWorkspaceId.length === 0 || name.length === 0) {
          sendJson(response, 400, { ok: false, error: '缺少父工作区或名称' })
          return
        }

        try {
          const result = await createSubWorkspace(ctx, options, parentWorkspaceId, name)
          trace(options, `sub-workspace created id=${result.workspace.id} path=${result.workspace.path} parent=${parentWorkspaceId}`)
          sendJson(response, 200, { ok: true, ...result })
        } catch (error) {
          warn(ctx, `cannot create sub-workspace: ${String(error)}`)
          trace(options, `error: sub-workspace failed (${String(error)})`)
          sendJson(response, 500, { ok: false, error: String(error) })
        }
      },
    }))
  } catch (error) {
    warn(ctx, `cannot register the create-sub-workspace route: ${String(error)}`)
    trace(options, `error: create-sub-workspace route failed (${String(error)})`)
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

/**
 * Register the workspace-deletion endpoints: inspect a workspace's folder and
 * delete the workspace (optionally removing its folder and files with it).
 */
function installWorkspaceDeleteApi(ctx, options) {
  const server = webServerOf(ctx)
  if (server === undefined || typeof server.register !== 'function') {
    warn(ctx, 'web server unavailable; workspace deletion is disabled')
    trace(options, 'error: web server unavailable (workspace delete)')
    return
  }

  const disposers = []

  try {
    disposers.push(server.register({
      kind: 'exact',
      path: WORKSPACE_INSPECT_ROUTE,
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
          query = new URL(String(request.url ?? ''), 'http://localhost').searchParams.get('workspaceId') ?? ''
        } catch {}
        const workspaceId = query.trim()
        if (workspaceId.length === 0) {
          sendJson(response, 400, { ok: false, error: '缺少 workspaceId' })
          return
        }

        const state = await inspectWorkspaceFolder(ctx, workspaceId)
        trace(options, `workspace-inspect id=${workspaceId} exists=${state.exists} content=${state.hasContent} count=${state.entryCount}`)
        sendJson(response, 200, { ok: true, workspaceId, ...state })
      },
    }))
  } catch (error) {
    warn(ctx, `cannot register the workspace-inspect route: ${String(error)}`)
    trace(options, `error: workspace-inspect route failed (${String(error)})`)
  }

  try {
    disposers.push(server.register({
      kind: 'exact',
      path: DELETE_WORKSPACE_ROUTE,
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
        const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId.trim() : ''
        if (workspaceId.length === 0) {
          sendJson(response, 400, { ok: false, error: '缺少 workspaceId' })
          return
        }

        try {
          const result = await removeWorkspace(ctx, options, workspaceId, body?.deleteFolder === true)
          trace(options, `workspace-delete id=${workspaceId} folder=${result.folderDeleted} deleted=${result.deleted}`)
          sendJson(response, 200, { ok: true, workspaceId, ...result })
        } catch (error) {
          warn(ctx, `cannot delete Workspace ${workspaceId}: ${String(error)}`)
          trace(options, `error: workspace-delete failed id=${workspaceId} (${String(error)})`)
          sendJson(response, 500, { ok: false, error: String(error) })
        }
      },
    }))
  } catch (error) {
    warn(ctx, `cannot register the workspace-delete route: ${String(error)}`)
    trace(options, `error: workspace-delete route failed (${String(error)})`)
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

/**
 * Open a path in the OS file manager. A directory opens as-is; a file path
 * opens its parent directory. The file-manager process is fire-and-forget:
 * we only verify the path exists, then hand it to explorer/finder/xdg-open.
 */
async function revealInFileManager(ctx, options, targetPath) {
  const resolved = String(targetPath ?? '').trim()
  if (resolved.length === 0) throw new Error('路径为空')

  let stats
  try {
    stats = await stat(resolved)
  } catch {
    throw new Error('路径不存在: ' + resolved)
  }

  const folder = stats.isDirectory() ? resolved : dirname(resolved)
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  const command = isWin ? 'explorer.exe' : isMac ? 'open' : 'xdg-open'

  trace(options, `reveal command=${command} path=${folder}`)
  execFile(command, [folder], (error) => {
    if (error) {
      warn(ctx, `cannot reveal ${folder}: ${String(error)}`)
      trace(options, `error: reveal failed (${String(error)})`)
    }
  })
}

/** Host route: reveal a folder in the OS file manager. */
function installRevealApi(ctx, options) {
  const server = webServerOf(ctx)
  if (server === undefined || typeof server.register !== 'function') {
    warn(ctx, 'web server unavailable; reveal is disabled')
    trace(options, 'error: web server unavailable (reveal)')
    return
  }

  const disposers = []

  try {
    disposers.push(server.register({
      kind: 'exact',
      path: REVEAL_ROUTE,
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
        const targetPath = typeof body?.path === 'string' ? body.path : ''
        if (targetPath.trim().length === 0) {
          sendJson(response, 400, { ok: false, error: '缺少 path' })
          return
        }

        try {
          await revealInFileManager(ctx, options, targetPath)
          sendJson(response, 200, { ok: true })
        } catch (error) {
          warn(ctx, `cannot reveal ${targetPath}: ${String(error)}`)
          trace(options, `error: reveal failed (${String(error)})`)
          sendJson(response, 500, { ok: false, error: String(error) })
        }
      },
    }))
  } catch (error) {
    warn(ctx, `cannot register the reveal route: ${String(error)}`)
    trace(options, `error: reveal route failed (${String(error)})`)
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

/** The registry's workspaces, flattened for the browser and sorted by path. */
function listWorkspaces(ctx) {
  const registry = workspaceRegistryOf(ctx)
  let workspaces
  try {
    workspaces = registry?.list?.() ?? []
  } catch {
    workspaces = []
  }
  return workspaces
    .filter((workspace) => typeof workspace?.path === 'string')
    .map((workspace) => ({
      id: String(workspace.id),
      path: workspace.path,
      title: typeof workspace.title === 'string' && workspace.title.length > 0 ? workspace.title : basename(workspace.path),
      sessionCount: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Create a sub-workspace: a folder inside an existing workspace's directory,
 * registered as a Workspace of its own. The folder name is sanitized exactly
 * like a conversation folder name, and a name collision gets a numeric suffix.
 */
async function createSubWorkspace(ctx, options, parentWorkspaceId, name) {
  const registry = workspaceRegistryOf(ctx)
  if (registry === undefined) throw new Error('工作区注册表不可用')

  const parent = findWorkspace(registry, parentWorkspaceId)
  if (parent === undefined) throw new Error('找不到父工作区')

  const safeName = sanitize(name)
  if (safeName.length === 0) throw new Error('子工作区名称无效')

  const folder = await createFolder(parent.path, safeName)
  const title = basename(folder)

  let workspace
  try {
    workspace = await registry.create(folder, title)
  } catch (error) {
    // Registration failed: leave no orphan folder behind.
    try {
      await rm(folder, { recursive: true, force: true })
    } catch {}
    throw error
  }

  log(ctx, `created sub-workspace ${title} under ${parent.path}`)
  return {
    created: true,
    parent: { id: String(parent.id), path: parent.path },
    workspace: {
      id: String(workspace.id),
      path: typeof workspace.path === 'string' ? workspace.path : folder,
      title: typeof workspace.title === 'string' && workspace.title.length > 0 ? workspace.title : title,
    },
  }
}

/** Find the workspace whose durable `sessionIds` account currently lists `sessionId`. */
function workspaceOwningSession(registry, sessionId) {
  for (const workspace of registry.list?.() ?? []) {
    const ids = Array.isArray(workspace.record?.sessionIds) ? workspace.record.sessionIds : (Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [])
    if (ids.includes(sessionId)) return workspace
  }
  return undefined
}

/**
 * Move a workspace (and every descendant workspace whose folder sits under it)
 * into another workspace's directory, then re-point every affected record, the
 * session-path index, and the session-folder index at the new locations. The
 * filesystem move and the registry writes are sequenced with a rollback.
 */
async function moveWorkspace(ctx, options, workspaceId, targetParentId) {
  const registry = workspaceRegistryOf(ctx)
  if (registry === undefined) throw new Error('工作区注册表不可用')
  const source = findWorkspace(registry, workspaceId)
  if (source === undefined) throw new Error('找不到源工作区')
  const target = findWorkspace(registry, targetParentId)
  if (target === undefined) throw new Error('找不到目标工作区')

  const oldPath = typeof source.path === 'string' ? source.path : ''
  const targetPath = typeof target.path === 'string' ? target.path : ''
  if (oldPath.length === 0 || targetPath.length === 0) throw new Error('工作区路径为空')

  const oldNorm = normalizePath(oldPath)
  const targetNorm = normalizePath(targetPath)
  // Never move a workspace into itself or into one of its own descendants.
  if (targetNorm === oldNorm || targetNorm.startsWith(oldNorm + sep)) {
    throw new Error('不能移动到自身或自己的子工作区')
  }

  const newParent = join(targetPath, basename(oldPath))
  if (normalizePath(newParent) === oldNorm) return { moved: false, workspaceId, path: oldPath }
  if (await folderExists(newParent)) throw new Error('目标位置已存在同名文件夹: ' + newParent)

  // Every workspace whose folder sits under `oldPath` relocates together.
  const affected = (registry.list?.() ?? []).filter((workspace) => {
    const path = normalizePath(typeof workspace.path === 'string' ? workspace.path : '')
    return path === oldNorm || path.startsWith(oldNorm + sep)
  })

  trace(options, `workspace move ${oldPath} -> ${newParent} (${affected.length} workspace(s))`)
  try {
    await rename(oldPath, newParent)
  } catch (error) {
    throw new Error('移动文件夹失败: ' + String(error))
  }

  try {
    for (const workspace of affected) {
      const wp = typeof workspace.path === 'string' ? workspace.path : ''
      const relative = wp.slice(oldPath.length)
      const newPath = newParent + relative
      const sessionIds = Array.isArray(workspace.record?.sessionIds) ? workspace.record.sessionIds : []
      for (const sessionId of sessionIds) {
        if (typeof registry.host?.rememberSessionPath === 'function') {
          registry.host.rememberSessionPath(sessionId, newPath)
        }
      }
      if (typeof workspace.mutate !== 'function') throw new Error('工作区实体没有 mutate')
      await workspace.mutate((record) => ({ ...record, path: newPath }))
    }
  } catch (error) {
    try { await rename(newParent, oldPath) } catch {}
    throw new Error('注册表更新失败，已回滚: ' + String(error))
  }

  rewriteIndexPrefix(oldPath, newParent)
  trace(options, `workspace moved: ${oldPath} -> ${newParent}`)
  return { moved: true, workspaceId, oldPath, newPath: newParent, affected: affected.length }
}

/**
 * Move one conversation's folder into a target workspace's directory, re-point
 * the session-folder index and the registry membership (detach from the old
 * workspace, attach to the target), and optionally reorder within the target.
 * `attachSession` cannot be used here because it validates the Session's cwd
 * resolves to exactly the workspace root; a relocated folder is validated via
 * `rememberSessionPath` + `mutate` instead.
 */
async function moveSessionFolder(ctx, options, sessionId, targetWorkspaceId, beforeSessionId) {
  const registry = workspaceRegistryOf(ctx)
  if (registry === undefined) throw new Error('工作区注册表不可用')
  const target = findWorkspace(registry, targetWorkspaceId)
  if (target === undefined) throw new Error('找不到目标工作区')
  const targetPath = typeof target.path === 'string' ? target.path : ''
  if (targetPath.length === 0) throw new Error('目标工作区路径为空')

  const currentFolder = folderOf(ctx, sessionId)
  if (currentFolder === undefined) throw new Error('找不到对话的文件夹')

  const oldNorm = normalizePath(currentFolder)
  // The session is "already there" only when the target actually owns it —
  // a folder sitting under the target's path could equally belong to one of
  // the target's sub-workspaces, in which case the move must still run.
  const owner = workspaceOwningSession(registry, sessionId)
  const alreadyOwned = owner !== undefined && String(owner.id) === String(target.id)

  let movedPath = currentFolder
  if (!alreadyOwned) {
    const newFolder = join(targetPath, basename(currentFolder))
    if (normalizePath(newFolder) === oldNorm) {
      movedPath = newFolder
    } else if (await folderExists(newFolder)) {
      throw new Error('目标位置已存在同名文件夹: ' + newFolder)
    } else {
      trace(options, `session move ${currentFolder} -> ${newFolder}`)
      try {
        await rename(currentFolder, newFolder)
      } catch (error) {
        throw new Error('移动文件夹失败: ' + String(error))
      }
      movedPath = newFolder

      rememberFolder(sessionId, targetPath, newFolder)
      const live = ISOLATED.get(sessionId)
      if (live !== undefined && typeof live === 'object') {
        live.folder = newFolder
        live.workspacePath = targetPath
      }

      // Re-point membership so the target workspace's `candidateMatches` filter
      // (which checks the session-path index) admits the session, then detach
      // from the old workspace and attach to the target via `mutate`.
      if (typeof registry.host?.rememberSessionPath === 'function') {
        registry.host.rememberSessionPath(sessionId, targetPath)
      }
      const oldWorkspace = workspaceOwningSession(registry, sessionId)
      try {
        if (oldWorkspace !== undefined && String(oldWorkspace.id) !== String(target.id) && typeof oldWorkspace.detachSession === 'function') {
          await oldWorkspace.detachSession(sessionId)
        }
        if (typeof target.mutate === 'function') {
          await target.mutate((record) => (record.sessionIds.includes(sessionId) ? record : { ...record, sessionIds: [sessionId, ...record.sessionIds] }))
        }
      } catch (error) {
        try { await rename(newFolder, currentFolder) } catch {}
        throw new Error('注册表更新失败，已回滚: ' + String(error))
      }
    }
  }

  // Reorder within the target when an anchor session was given.
  if (beforeSessionId !== undefined && beforeSessionId !== null && beforeSessionId !== '') {
    try {
      if (typeof target.insertSessionBefore === 'function') {
        await target.insertSessionBefore(sessionId, beforeSessionId)
      }
    } catch (error) {
      trace(options, `error: session reorder failed (${String(error)})`)
    }
  }

  return { moved: true, sessionId, workspaceId: String(target.id), folder: movedPath }
}

/** Host routes: drag-drop reparenting for workspaces and conversations. */
function installMoveApi(ctx, options) {
  const server = webServerOf(ctx)
  if (server === undefined || typeof server.register !== 'function') {
    warn(ctx, 'web server unavailable; drag-drop moving is disabled')
    trace(options, 'error: web server unavailable (move)')
    return
  }

  const disposers = []

  try {
    disposers.push(server.register({
      kind: 'exact',
      path: MOVE_WORKSPACE_ROUTE,
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
        const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId.trim() : ''
        const targetParentId = typeof body?.targetParentId === 'string' ? body.targetParentId.trim() : ''
        if (workspaceId.length === 0 || targetParentId.length === 0) {
          sendJson(response, 400, { ok: false, error: '缺少 workspaceId 或 targetParentId' })
          return
        }

        try {
          const result = await moveWorkspace(ctx, options, workspaceId, targetParentId)
          trace(options, `workspace-move id=${workspaceId} target=${targetParentId} moved=${result.moved}`)
          sendJson(response, 200, { ok: true, workspaceId, ...result })
        } catch (error) {
          warn(ctx, `cannot move Workspace ${workspaceId}: ${String(error)}`)
          trace(options, `error: workspace-move failed id=${workspaceId} (${String(error)})`)
          sendJson(response, 500, { ok: false, error: String(error) })
        }
      },
    }))
  } catch (error) {
    warn(ctx, `cannot register the move-workspace route: ${String(error)}`)
    trace(options, `error: move-workspace route failed (${String(error)})`)
  }

  try {
    disposers.push(server.register({
      kind: 'exact',
      path: MOVE_SESSION_ROUTE,
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
        const targetWorkspaceId = typeof body?.targetWorkspaceId === 'string' ? body.targetWorkspaceId.trim() : ''
        const beforeSessionId = typeof body?.beforeSessionId === 'string' ? body.beforeSessionId.trim() : ''
        if (sessionId.length === 0 || targetWorkspaceId.length === 0) {
          sendJson(response, 400, { ok: false, error: '缺少 sessionId 或 targetWorkspaceId' })
          return
        }

        try {
          const result = await moveSessionFolder(ctx, options, sessionId, targetWorkspaceId, beforeSessionId || undefined)
          trace(options, `session-move id=${sessionId} target=${targetWorkspaceId} folder=${result.folder}`)
          sendJson(response, 200, { ok: true, sessionId, ...result })
        } catch (error) {
          warn(ctx, `cannot move Session ${sessionId}: ${String(error)}`)
          trace(options, `error: session-move failed id=${sessionId} (${String(error)})`)
          sendJson(response, 500, { ok: false, error: String(error) })
        }
      },
    }))
  } catch (error) {
    warn(ctx, `cannot register the move-session route: ${String(error)}`)
    trace(options, `error: move-session route failed (${String(error)})`)
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

/** Find one workspace by id, through `get` with a list fallback. */
function findWorkspace(registry, workspaceId) {
  try {
    const byId = registry.get(workspaceId)
    if (byId !== undefined) return byId
  } catch {}
  const list = registry.list?.() ?? []
  return list.find((workspace) => String(workspace.id) === workspaceId)
}

/**
 * Rename a workspace's folder on disk to match its new title, then re-point
 * the registry record and the session-folder index at the new path. The folder
 * move and the registry write are sequenced with a rollback so a half-applied
 * rename never leaves the workspace pointing at a missing directory.
 */
async function renameWorkspaceFolder(ctx, workspaceId, newTitle, options) {
  const registry = workspaceRegistryOf(ctx)
  if (registry === undefined) return
  const entity = findWorkspace(registry, workspaceId)
  if (entity === undefined) return
  const oldPath = typeof entity.path === 'string' ? entity.path : ''
  if (oldPath.length === 0) return
  const safeTitle = sanitize(newTitle)
  if (safeTitle.length === 0) return
  const parentDir = dirname(oldPath)
  const newPath = join(parentDir, safeTitle)
  if (normalizePath(oldPath) === normalizePath(newPath)) return
  // Never rename a drive root or its immediate parent into itself.
  if (DRIVE_ROOT.test(safeTitle)) return

  trace(options, `workspace rename ${oldPath} -> ${newPath}`)

  try {
    await rename(oldPath, newPath)
  } catch (error) {
    trace(options, `error: workspace rename fs failed (${String(error)})`)
    return
  }

  try {
    const sessionIds = Array.isArray(entity.record?.sessionIds) ? entity.record.sessionIds : []
    for (const sessionId of sessionIds) {
      if (typeof registry.host?.rememberSessionPath === 'function') {
        registry.host.rememberSessionPath(sessionId, newPath)
      }
    }
    if (typeof entity.mutate !== 'function') throw new Error('workspace entity has no mutate')
    await entity.mutate((record) => ({ ...record, path: newPath }))
  } catch (error) {
    try { await rename(newPath, oldPath) } catch {}
    trace(options, `error: workspace rename registry failed, rolled back (${String(error)})`)
    return
  }

  rewriteIndexPrefix(oldPath, newPath)
  trace(options, `workspace renamed: ${oldPath} -> ${newPath}`)
}

/**
 * Rewrite every folder/workspacePath recorded in the session-folder index that
 * sits under `oldPath` so it points under `newPath` instead.
 */
function rewriteIndexPrefix(oldPath, newPath) {
  try {
    const entries = readIndex()
    const oldNorm = normalizePath(oldPath)
    let changed = false
    for (const key of Object.keys(entries)) {
      const entry = entries[key]
      if (entry === null || typeof entry !== 'object') continue
      for (const field of ['folder', 'workspacePath']) {
        const value = entry[field]
        if (typeof value !== 'string') continue
        const norm = normalizePath(value)
        if (norm === oldNorm || norm.startsWith(oldNorm + sep)) {
          entry[field] = newPath + value.slice(oldPath.length)
          changed = true
        }
      }
    }
    if (changed) writeIndex(entries)
  } catch {}
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

/** Describe a Workspace's folder without changing anything. */
async function inspectWorkspaceFolder(ctx, workspaceId) {
  const registry = workspaceRegistryOf(ctx)
  const workspace = findWorkspace(registry, workspaceId)
  if (workspace === undefined) return { managed: false, folderPath: null, exists: false, hasContent: false, entryCount: 0 }

  const folder = typeof workspace.path === 'string' ? workspace.path : ''
  if (folder.length === 0) return { managed: false, folderPath: null, exists: false, hasContent: false, entryCount: 0 }

  let names
  try {
    names = await readdir(folder)
  } catch {
    return { managed: true, folderPath: folder, exists: false, hasContent: false, entryCount: 0 }
  }
  return { managed: true, folderPath: folder, exists: true, hasContent: names.length > 0, entryCount: names.length }
}

/** Drop every index entry whose folder/workspacePath sits under `removedPath`. */
function removeIndexPrefix(removedPath) {
  try {
    const entries = readIndex()
    const removedNorm = normalizePath(removedPath)
    let changed = false
    for (const key of Object.keys(entries)) {
      const entry = entries[key]
      if (entry === null || typeof entry !== 'object') continue
      for (const field of ['folder', 'workspacePath']) {
        const value = entry[field]
        if (typeof value !== 'string') continue
        const norm = normalizePath(value)
        if (norm === removedNorm || norm.startsWith(removedNorm + sep)) {
          delete entries[key]
          changed = true
          break
        }
      }
    }
    if (changed) writeIndex(entries)
  } catch {}
}

/** Unregister a Workspace; when asked, remove its folder and files first. */
async function removeWorkspace(ctx, options, workspaceId, deleteFolder) {
  const registry = workspaceRegistryOf(ctx)
  const workspace = findWorkspace(registry, workspaceId)
  if (workspace === undefined) return { deleted: false, folderDeleted: false, folderPath: null, entryCount: 0, reason: '找不到工作区' }

  const state = await inspectWorkspaceFolder(ctx, workspaceId)
  const folderPath = typeof state.folderPath === 'string' ? state.folderPath : null

  let folderDeleted = false
  if (deleteFolder && folderPath !== null && state.exists) {
    const norm = normalizePath(folderPath)
    if (DRIVE_ROOT.test(norm) || norm.length === 0) {
      warn(ctx, `refusing to remove workspace folder ${folderPath}: drive root`)
      trace(options, `refused workspace folder delete drive-root ${folderPath}`)
    } else {
      try {
        await rm(folderPath, { recursive: true, force: true })
        folderDeleted = true
        log(ctx, `removed workspace folder ${folderPath}`)
      } catch (error) {
        warn(ctx, `cannot remove workspace folder ${folderPath}: ${String(error)}`)
        trace(options, `workspace folder delete failed ${folderPath} (${String(error)})`)
      }
    }
  }

  let deleted = false
  let reason
  try {
    if (registry !== undefined && typeof registry.delete === 'function') {
      deleted = (await registry.delete(workspaceId)) === true
      if (!deleted) reason = 'registry.delete 返回 false'
    } else {
      reason = 'workspaceRegistry.delete 不可用'
    }
  } catch (error) {
    reason = String(error)
    warn(ctx, `cannot unregister workspace ${workspaceId}: ${String(error)}`)
    trace(options, `workspace unregister failed ${workspaceId} (${String(error)})`)
  }

  if (folderDeleted && folderPath !== null) removeIndexPrefix(folderPath)

  return {
    deleted,
    folderDeleted,
    folderPath,
    entryCount: state.entryCount ?? 0,
    reason,
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
