/**
 * dsh-session-folders — 浏览器半侧
 *
 * 在会话右键菜单里加一条「删除对话（含工作区文件）」，点击后先向宿主询问
 * 该会话的文件夹里有没有内容：
 *
 *   - 没有文件夹 / 文件夹是空的 → 直接删除文件夹和对话，不打扰用户；
 *   - 文件夹里有内容 → 弹窗问「是否删除对应工作区文件」，
 *     是 = 连文件夹带文件一起删掉，否 = 只删对话，文件夹留着；
 *   - 取消 = 什么都不做。
 *
 * 这里只做界面和判定，真正的删除由宿主端 index.js 完成（浏览器没有删目录的能力）。
 *
 * 另外，用层级工作区浏览器替换内置的扁平工作区列表：每个工作区行上有
 * 「对话」和「子区」按钮，分别新建对话和新建子工作区；子工作区按其文件夹
 * 路径自动嵌套在父工作区下面（可递归）。
 */

;(function () {
  const loader = window.__ModuleLoader__
  if (loader === undefined || loader === null || typeof loader.load !== 'function') return

  loader.load({
    id: 'dsh-session-folders',
    factory: (require) => {
      const React = require('react')

      const h = React.createElement
      const INSPECT_PATH = '/api/dsh-session-folders/inspect'
      const DELETE_PATH = '/api/dsh-session-folders/delete'
      const MENU_SLOT = 'sidebar.workspaces.session.menu.item'
      const OVERLAY_SLOT = 'shell.overlay'
      const MENU_ID = 'session-folders.delete'
      const OVERLAY_ID = 'session-folders.confirm'
      const MENU_LABEL = '删除对话（含工作区文件）'
      const WORKSPACES_PATH = '/api/dsh-session-folders/workspaces'
      const CREATE_SUB_PATH = '/api/dsh-session-folders/create-sub-workspace'
      const SUB_OVERLAY_ID = 'session-folders.sub-workspace'
      const FOOTER_LABEL = '新建子工作区'
      const WORKSPACES_SLOT = 'sidebar.workspaces'
      const RENAME_OVERLAY_ID = 'session-folders.workspace-rename-dialog'
      const DELETE_WORKSPACE_OVERLAY_ID = 'session-folders.workspace-delete-dialog'
      const INSPECT_WORKSPACE_PATH = '/api/dsh-session-folders/inspect-workspace'
      const DELETE_WORKSPACE_PATH = '/api/dsh-session-folders/delete-workspace'
      const REVEAL_PATH = '/api/dsh-session-folders/reveal'
      const MOVE_WORKSPACE_PATH = '/api/dsh-session-folders/move-workspace'
      const MOVE_SESSION_PATH = '/api/dsh-session-folders/move-session'

      /* ── 弹窗状态 ───────────────────────────────────────────────────── */

      const listeners = new Set()
      let dialog = null

      function notify() {
        for (const listener of listeners) {
          try {
            listener()
          } catch {}
        }
      }

      function setDialog(next) {
        dialog = next
        notify()
      }

      function subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }

      function snapshot() {
        return dialog
      }

      /* ── 子工作区弹窗状态 ───────────────────────────────────────────── */

      const subListeners = new Set()
      let subDialog = null

      function notifySub() {
        for (const listener of subListeners) {
          try {
            listener()
          } catch {}
        }
      }

      function setSubDialog(next) {
        subDialog = next
        notifySub()
      }

      function subscribeSub(listener) {
        subListeners.add(listener)
        return () => subListeners.delete(listener)
      }

      function subSnapshot() {
        return subDialog
      }

      /* ── 工作区重命名弹窗状态 ───────────────────────────────────────── */

      const renameListeners = new Set()
      let renameDialog = null

      function notifyRename() {
        for (const listener of renameListeners) {
          try {
            listener()
          } catch {}
        }
      }

      function setRenameDialog(next) {
        renameDialog = next
        notifyRename()
      }

      function subscribeRename(listener) {
        renameListeners.add(listener)
        return () => renameListeners.delete(listener)
      }

      function renameSnapshot() {
        return renameDialog
      }

      /* ── 删除工作区弹窗状态 ─────────────────────────────────────────── */

      const deleteWorkspaceListeners = new Set()
      let deleteWorkspaceDialog = null

      function notifyDeleteWorkspace() {
        for (const listener of deleteWorkspaceListeners) {
          try {
            listener()
          } catch {}
        }
      }

      function setDeleteWorkspaceDialog(next) {
        deleteWorkspaceDialog = next
        notifyDeleteWorkspace()
      }

      function subscribeDeleteWorkspace(listener) {
        deleteWorkspaceListeners.add(listener)
        return () => deleteWorkspaceListeners.delete(listener)
      }

      function deleteWorkspaceSnapshot() {
        return deleteWorkspaceDialog
      }

      /* ── 和宿主通信 ─────────────────────────────────────────────────── */

      function apiUrl(path) {
        try {
          const raw = document.baseURI
          if (typeof raw !== 'string' || raw.length === 0) return path
          const url = new URL(raw)
          const slash = url.pathname.lastIndexOf('/')
          const last = url.pathname.slice(slash + 1)
          if (/\.(html?|php|aspx?|jsp)$/i.test(last)) url.pathname = url.pathname.slice(0, slash + 1)
          else if (!url.pathname.endsWith('/')) url.pathname += '/'
          return new URL(path.replace(/^\//, ''), url.href).href
        } catch {
          return path
        }
      }

      async function callHost(method, path, payload) {
        const options = {
          method,
          credentials: 'same-origin',
          headers: { 'x-session-folders': '1' },
        }
        let target = apiUrl(path)

        if (method === 'GET') {
          const query = new URLSearchParams()
          if (payload?.sessionId !== undefined) query.set('sessionId', String(payload.sessionId))
          const text = query.toString()
          if (text.length > 0) target += (target.includes('?') ? '&' : '?') + text
        } else {
          options.headers['content-type'] = 'application/json'
          options.body = JSON.stringify(payload ?? {})
        }

        const response = await fetch(target, options)
        let data = null
        try {
          data = await response.json()
        } catch {}

        if (data === null || typeof data !== 'object') throw new Error(`宿主没有响应（HTTP ${response.status}）`)
        if (data.ok !== true) throw new Error(typeof data.error === 'string' ? data.error : '删除失败')
        return data
      }

      async function revealFolder(targetPath) {
        if (typeof targetPath !== 'string' || targetPath.length === 0) return
        try {
          await callHost('POST', REVEAL_PATH, { path: targetPath })
        } catch (error) {
          console.warn('dsh-session-folders: 打开文件夹失败', error)
        }
      }

      async function moveWorkspaceFolder(workspaceId, targetParentId) {
        try {
          await callHost('POST', MOVE_WORKSPACE_PATH, { workspaceId, targetParentId })
        } catch (error) {
          console.warn('dsh-session-folders: 移动工作区失败', error)
        }
      }

      async function moveSessionFolder(sessionId, targetWorkspaceId, beforeSessionId) {
        try {
          await callHost('POST', MOVE_SESSION_PATH, { sessionId, targetWorkspaceId, beforeSessionId })
        } catch (error) {
          console.warn('dsh-session-folders: 移动对话失败', error)
        }
      }

      /* ── 运行中的转圈指示器 ─────────────────────────────────────────── */

      let spinStyleInjected = false
      function ensureSpinStyle() {
        if (spinStyleInjected) return
        spinStyleInjected = true
        try {
          const style = document.createElement('style')
          style.textContent = '@keyframes dsf-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'
          document.head.appendChild(style)
        } catch {}
      }

      function runningSpinner() {
        ensureSpinStyle()
        return h('svg', {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          role: 'status',
          'aria-label': '进行中',
          style: {
            flex: 'none',
            marginLeft: 2,
            marginRight: 3,
            display: 'inline-block',
            animation: 'dsf-spin 0.9s linear infinite',
          },
        },
        h('circle', {
          cx: 12,
          cy: 12,
          r: 9,
          fill: 'none',
          stroke: 'rgba(34, 197, 94, 0.22)',
          strokeWidth: 3,
        }),
        h('circle', {
          cx: 12,
          cy: 12,
          r: 9,
          fill: 'none',
          stroke: '#22c55e',
          strokeWidth: 3,
          strokeLinecap: 'round',
          strokeDasharray: '42',
          strokeDashoffset: '16',
        }),
        )
      }

      /* ── 菜单项 ─────────────────────────────────────────────────────── */

      function noopHook() {
        return undefined
      }

      function dismissMenu(closer) {
        try {
          if (typeof closer === 'function') closer()
          else if (Array.isArray(closer) && typeof closer[1] === 'function') closer[1]()
          else if (closer !== null && typeof closer === 'object' && typeof closer.close === 'function') closer.close()
        } catch {}
      }

      async function beginDelete(sessionId, title) {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return

        try {
          const info = await callHost('GET', INSPECT_PATH, { sessionId })

          // 没有文件夹，或者文件夹是空的：直接连文件夹一起删掉，不需要确认。
          if (info.hasContent !== true) {
            await callHost('POST', DELETE_PATH, { sessionId, deleteFolder: true })
            return
          }

          setDialog({
            sessionId,
            title: typeof title === 'string' ? title : '',
            folderPath: typeof info.folderPath === 'string' ? info.folderPath : '',
            entryCount: Number(info.entryCount) || 0,
            busy: false,
            error: null,
            blocked: false,
          })
        } catch (error) {
          setDialog({
            sessionId,
            title: typeof title === 'string' ? title : '',
            folderPath: '',
            entryCount: 0,
            busy: false,
            error: String(error?.message ?? error),
            blocked: true,
          })
        }
      }

      function DeleteMenuItem(props) {
        const useMenuOpenState = typeof props?.useMenuOpenState === 'function' ? props.useMenuOpenState : noopHook
        const menuState = useMenuOpenState()
        const sessionId = props?.sessionId

        return h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: 'dsf_sessionMenuItem',
            style: {
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              gap: 8,
              padding: '7px 10px',
              border: 'none',
              borderRadius: 8,
              background: 'transparent',
              color: 'var(--dsw-alias-state-error-primary, #ef4444)',
              font: 'inherit',
              fontSize: 13,
              lineHeight: '18px',
              textAlign: 'left',
              cursor: 'pointer',
            },
            onMouseEnter: (event) => {
              event.currentTarget.style.background = 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.12))'
            },
            onMouseLeave: (event) => {
              event.currentTarget.style.background = 'transparent'
            },
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              dismissMenu(menuState)
              void beginDelete(sessionId, props?.displayTitle)
            },
          },
          MENU_LABEL,
        )
      }

      /* ── 确认弹窗 ───────────────────────────────────────────────────── */

      function useDialogState() {
        if (typeof React.useSyncExternalStore === 'function') {
          return React.useSyncExternalStore(subscribe, snapshot, snapshot)
        }
        const [value, setValue] = React.useState(snapshot)
        React.useEffect(() => subscribe(() => setValue(snapshot())), [])
        return value
      }

      function buttonStyle(kind, disabled) {
        const base = {
          minWidth: 84,
          height: 32,
          padding: '0 14px',
          borderRadius: 8,
          font: 'inherit',
          fontSize: 13,
          lineHeight: '18px',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.6 : 1,
        }
        if (kind === 'danger') {
          return {
            ...base,
            border: '1px solid var(--dsw-alias-state-error-primary, #ef4444)',
            background: 'var(--dsw-alias-state-error-primary, #ef4444)',
            color: '#fff',
          }
        }
        if (kind === 'primary') {
          return {
            ...base,
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
            background: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.12))',
            color: 'var(--dsw-alias-label-primary, inherit)',
          }
        }
        return {
          ...base,
          border: '1px solid transparent',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary, inherit)',
        }
      }

      function ConfirmDialog() {
        const current = useDialogState()

        React.useEffect(() => {
          if (current === null) return undefined
          const onKeyDown = (event) => {
            if (event.key === 'Escape' && current.busy !== true) setDialog(null)
          }
          window.addEventListener('keydown', onKeyDown)
          return () => window.removeEventListener('keydown', onKeyDown)
        }, [current === null, current?.busy])

        if (current === null) return null

        const run = async (deleteFolder) => {
          const target = dialog
          if (target === null || target.busy === true) return
          setDialog({ ...target, busy: true, error: null })
          try {
            await callHost('POST', DELETE_PATH, { sessionId: target.sessionId, deleteFolder })
            setDialog(null)
          } catch (error) {
            setDialog({ ...target, busy: false, error: String(error?.message ?? error) })
          }
        }

        const busy = current.busy === true
        const count = current.entryCount > 0 ? `${current.entryCount} 个文件/文件夹` : '文件'

        return h(
          'div',
          {
            role: 'presentation',
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 2147482000,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
              background: 'rgba(0,0,0,0.36)',
            },
            onMouseDown: (event) => {
              if (event.target === event.currentTarget && busy !== true) setDialog(null)
            },
          },
          h(
            'div',
            {
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': '是否删除对应工作区文件',
              style: {
                width: 'min(460px, 100%)',
                boxSizing: 'border-box',
                padding: 20,
                borderRadius: 14,
                border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))',
                background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #ffffff))',
                color: 'var(--dsw-alias-label-primary, inherit)',
                boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
                font: 'inherit',
                fontSize: 13,
                lineHeight: '20px',
              },
            },
            h(
              'div',
              { style: { fontSize: 15, fontWeight: 600, lineHeight: '22px', marginBottom: 10 } },
              current.blocked === true ? '无法删除这个对话' : '是否删除对应工作区文件？',
            ),
            current.blocked === true
              ? h('div', { style: { color: 'var(--dsw-alias-label-secondary, inherit)' } }, current.error)
              : h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { style: { color: 'var(--dsw-alias-label-secondary, inherit)', marginBottom: 8 } },
                    `「${current.title || '这个对话'}」的文件夹里有 ${count}：`,
                  ),
                  h(
                    'div',
                    {
                      style: {
                        marginBottom: 12,
                        padding: '8px 10px',
                        borderRadius: 8,
                        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08))',
                        color: 'var(--dsw-alias-label-secondary, inherit)',
                        fontFamily: 'ui-monospace, Consolas, monospace',
                        fontSize: 12,
                        lineHeight: '18px',
                        wordBreak: 'break-all',
                      },
                    },
                    current.folderPath,
                  ),
                  h(
                    'div',
                    { style: { color: 'var(--dsw-alias-label-secondary, inherit)', marginBottom: 6 } },
                    '选「是」会连文件夹和里面的文件一起删掉；选「否」只删这个对话，文件留在工作区里。',
                  ),
                ),
            current.error !== null && current.blocked !== true
              ? h(
                  'div',
                  { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary, #ef4444)', marginTop: 8 } },
                  current.error,
                )
              : null,
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 } },
              current.blocked === true
                ? h(
                    React.Fragment,
                    null,
                    h(
                      'button',
                      { type: 'button', style: buttonStyle('ghost', busy), disabled: busy, onClick: () => setDialog(null) },
                      '关闭',
                    ),
                    h(
                      'button',
                      { type: 'button', style: buttonStyle('danger', busy), disabled: busy, onClick: () => void run(false) },
                      '仅删除对话',
                    ),
                  )
                : h(
                    React.Fragment,
                    null,
                    h(
                      'button',
                      { type: 'button', style: buttonStyle('ghost', busy), disabled: busy, onClick: () => setDialog(null) },
                      '取消',
                    ),
                    h(
                      'button',
                      { type: 'button', style: buttonStyle('primary', busy), disabled: busy, onClick: () => void run(false) },
                      '否（只删对话）',
                    ),
                    h(
                      'button',
                      { type: 'button', style: buttonStyle('danger', busy), disabled: busy, onClick: () => void run(true) },
                      '是（连文件一起删）',
                    ),
                  ),
            ),
          ),
        )
      }

      /* ── 新建子工作区 ───────────────────────────────────────────────── */

      function useSubDialogState() {
        if (typeof React.useSyncExternalStore === 'function') {
          return React.useSyncExternalStore(subscribeSub, subSnapshot, subSnapshot)
        }
        const [value, setValue] = React.useState(subSnapshot)
        React.useEffect(() => subscribeSub(() => setValue(subSnapshot())), [])
        return value
      }

      async function openSubWorkspaceDialog(presetParentId) {
        const parentWorkspaceId = typeof presetParentId === 'string' ? presetParentId : ''
        setSubDialog({ busy: true, error: null, workspaces: [], parentWorkspaceId, name: '' })
        try {
          const data = await callHost('GET', WORKSPACES_PATH, {})
          const workspaces = Array.isArray(data?.workspaces) ? data.workspaces : []
          setSubDialog({ busy: false, error: null, workspaces, parentWorkspaceId, name: '' })
        } catch (error) {
          setSubDialog({ busy: false, error: String(error?.message ?? error), workspaces: [], parentWorkspaceId, name: '' })
        }
      }

      function useRenameDialogState() {
        if (typeof React.useSyncExternalStore === 'function') {
          return React.useSyncExternalStore(subscribeRename, renameSnapshot, renameSnapshot)
        }
        const [value, setValue] = React.useState(renameSnapshot)
        React.useEffect(() => subscribeRename(() => setValue(renameSnapshot())), [])
        return value
      }

      function openRenameWorkspaceDialog(workspaceId, title) {
        setRenameDialog({
          busy: false,
          error: null,
          workspaceId,
          title: typeof title === 'string' ? title : '',
          name: typeof title === 'string' ? title : '',
        })
      }

      function useDeleteWorkspaceDialogState() {
        if (typeof React.useSyncExternalStore === 'function') {
          return React.useSyncExternalStore(
            subscribeDeleteWorkspace,
            deleteWorkspaceSnapshot,
            deleteWorkspaceSnapshot,
          )
        }
        const [value, setValue] = React.useState(deleteWorkspaceSnapshot)
        React.useEffect(() => subscribeDeleteWorkspace(() => setValue(deleteWorkspaceSnapshot())), [])
        return value
      }

      function openDeleteWorkspaceDialog(workspaceId, displayTitle) {
        setDeleteWorkspaceDialog({
          busy: true,
          error: null,
          workspaceId,
          displayTitle: typeof displayTitle === 'string' ? displayTitle : '',
          folderPath: null,
          exists: false,
          hasContent: false,
          entryCount: 0,
          deleteFolder: false,
          loaded: false,
        })
        inspectWorkspaceFolder(workspaceId)
      }

      async function inspectWorkspaceFolder(workspaceId) {
        const target = deleteWorkspaceDialog
        if (target === null || target.workspaceId !== workspaceId) return
        try {
          const result = await callHost('GET', INSPECT_WORKSPACE_PATH + '?workspaceId=' + encodeURIComponent(workspaceId))
          setDeleteWorkspaceDialog({
            ...deleteWorkspaceDialog,
            busy: false,
            loaded: true,
            folderPath: result?.folderPath ?? null,
            exists: result?.exists === true,
            hasContent: result?.hasContent === true,
            entryCount: typeof result?.entryCount === 'number' ? result.entryCount : 0,
            deleteFolder: result?.hasContent === true,
          })
        } catch (error) {
          setDeleteWorkspaceDialog({
            ...deleteWorkspaceDialog,
            busy: false,
            loaded: true,
            error: String(error?.message ?? error),
          })
        }
      }

      function folderKey(path) {
        if (typeof path !== 'string' || path.length === 0) return ''
        return path.replaceAll('\\', '/').replace(/\/+$/, '')
      }

      function owningParentFolder(path, paths) {
        const child = folderKey(path)
        let owner
        let length = -1
        for (const candidate of paths) {
          const root = folderKey(candidate)
          if (root.length > length && child.length > root.length && child.startsWith(root + '/')) {
            owner = candidate
            length = root.length
          }
        }
        return owner
      }

      let browserServices = null

      function WorkspaceBrowser(props) {
        const services = browserServices
        const uiWorkspace = services?.uiWorkspace
        const contextMenus = services?.contextMenus
        const useWorkspaces = typeof props?.useWorkspaces === 'function' ? props.useWorkspaces : null
        const useSessions = typeof props?.useSessions === 'function' ? props.useSessions : null
        const renderSlot = typeof props?.renderSlot === 'function' ? props.renderSlot : null

        const items = useWorkspaces === null ? [] : (useWorkspaces((state) => state?.items) ?? [])
        const byId = useSessions === null ? {} : (useSessions((state) => state?.byId) ?? {})
        const usePanelInfo = typeof props?.usePanelInfo === 'function' ? props.usePanelInfo : null
        const panelActive = usePanelInfo === null ? false : usePanelInfo((info) => info?.activePanelId !== null) === true
        const currentId = panelActive
          ? undefined
          : Object.values(byId).find((session) => (session?.retainedBy?.mainView ?? 0) > 0)?.id

        const [collapsed, setCollapsed] = React.useState(() => new Set())
        const workspaces = services?.workspaces
        const [viewMode, setViewMode] = React.useState('workspace-tree')
        const [searchQuery, setSearchQuery] = React.useState('')
        const [searchExpanded, setSearchExpanded] = React.useState(false)
        const [viewMenuOpen, setViewMenuOpen] = React.useState(false)
        const [workspaceMenu, setWorkspaceMenu] = React.useState(null)
        const [drag, setDrag] = React.useState(null)

        const workspaceRunning = (ws) => {
          const ids = Array.isArray(ws?.sessionIds) ? ws.sessionIds : []
          return ids.some((id) => byId[id]?.running === true)
        }

        const workspaceOfSession = (sessionId) => {
          for (const ws of items) {
            if (Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId)) return ws
          }
          return undefined
        }

        const beginDrag = React.useCallback((event, kind, id) => {
          try {
            event.dataTransfer.setData('text/plain', `${kind}:${id}`)
            event.dataTransfer.effectAllowed = 'move'
          } catch {}
          setDrag({ kind, id })
        }, [])

        const endDrag = React.useCallback(() => setDrag(null), [])

        // Drop a workspace onto another workspace: reparent (cross-parent move) or
        // reorder (siblings). Parentage is recomputed here from `items` (module-level
        // `owningParentFolder`) so this closure does not depend on the later `parents` memo.
        const dropWorkspaceOntoWorkspace = React.useCallback(
          (draggedId, targetId) => {
            if (draggedId === targetId) return
            const paths = []
            const pathToId = new Map()
            for (const ws of items) {
              if (ws == null || typeof ws.path !== 'string') continue
              paths.push(ws.path)
              pathToId.set(ws.path, ws.workspaceId)
            }
            const parentOf = (id) => {
              const ws = items.find((entry) => entry != null && entry.workspaceId === id)
              if (ws == null || typeof ws.path !== 'string') return undefined
              const ownerPath = owningParentFolder(ws.path, paths)
              return ownerPath === undefined ? undefined : pathToId.get(ownerPath)
            }
            const draggedParent = parentOf(draggedId)
            const targetParent = parentOf(targetId)
            if (draggedParent === targetParent && draggedParent !== undefined && typeof workspaces?.insertBefore === 'function') {
              try {
                workspaces.insertBefore(draggedId, targetId)
              } catch (error) {
                console.warn('dsh-session-folders: 排序工作区失败', error)
              }
            } else {
              moveWorkspaceFolder(draggedId, targetId)
            }
          },
          [items, workspaces],
        )

        const dropSessionOntoWorkspace = React.useCallback((sessionId, workspaceId) => {
          moveSessionFolder(sessionId, workspaceId, undefined)
        }, [])

        const dropSessionOntoSession = React.useCallback(
          (draggedId, anchorId) => {
            if (draggedId === anchorId) return
            const anchorWs = workspaceOfSession(anchorId)
            const draggedWs = workspaceOfSession(draggedId)
            if (anchorWs === undefined) return
            if (draggedWs !== undefined && draggedWs.workspaceId === anchorWs.workspaceId) {
              // Same workspace: just reorder.
              if (typeof workspaces?.insertSessionBefore === 'function') {
                try {
                  workspaces.insertSessionBefore(anchorWs.workspaceId, draggedId, anchorId)
                } catch (error) {
                  console.warn('dsh-session-folders: 排序对话失败', error)
                }
              }
            } else {
              // Cross-workspace: move the folder then reorder before the anchor.
              moveSessionFolder(draggedId, anchorWs.workspaceId, anchorId)
            }
          },
          [items, workspaces],
        )

        const openSession = React.useCallback(
          (sessionId) => {
            if (typeof sessionId !== 'string' || sessionId.length === 0) return
            if (typeof uiWorkspace?.openSession !== 'function') return
            try {
              uiWorkspace.openSession(sessionId)
            } catch (error) {
              console.warn('dsh-session-folders: 打开会话失败', error)
            }
          },
          [uiWorkspace],
        )

        const newConversation = React.useCallback(
          (workspaceId) => {
            if (typeof uiWorkspace?.startSession !== 'function') return
            try {
              uiWorkspace.startSession(workspaceId)
            } catch (error) {
              console.warn('dsh-session-folders: 新建对话失败', error)
            }
          },
          [uiWorkspace],
        )

        const openSessionMenu = React.useCallback(
          (sessionId, displayTitle, point) => {
            if (contextMenus == null) return
            try {
              contextMenus.open({ kind: 'session', value: { sessionId, displayTitle } }, point)
            } catch (error) {
              console.warn('dsh-session-folders: 打开会话菜单失败', error)
            }
          },
          [contextMenus],
        )

        const openWorkspaceMenu = React.useCallback(
          (workspaceId, path, displayTitle, point) => {
            if (contextMenus == null) return
            try {
              contextMenus.open({ kind: 'workspace', value: { workspaceId, path, displayTitle } }, point)
            } catch (error) {
              console.warn('dsh-session-folders: 打开工作区菜单失败', error)
            }
          },
          [contextMenus],
        )

        const parents = React.useMemo(() => {
          const paths = []
          const pathToId = new Map()
          for (const ws of items) {
            if (ws == null || typeof ws.path !== 'string') continue
            paths.push(ws.path)
            pathToId.set(ws.path, ws.workspaceId)
          }
          const map = new Map()
          for (const ws of items) {
            if (ws == null) continue
            const ownerPath = typeof ws.path === 'string' ? owningParentFolder(ws.path, paths) : undefined
            map.set(ws.workspaceId, ownerPath === undefined ? undefined : pathToId.get(ownerPath))
          }
          return map
        }, [items])

        const childrenByParent = React.useMemo(() => {
          const map = new Map()
          for (const ws of items) {
            if (ws == null) continue
            const parent = parents.get(ws.workspaceId)
            const list = map.get(parent) ?? []
            list.push(ws)
            map.set(parent, list)
          }
          return map
        }, [items, parents])

        const toggle = React.useCallback((id) => {
          setCollapsed((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }, [])

        const sessionTitle = (session) => {
          if (session == null) return ''
          if (session.blank === true) return '新会话'
          let title = session.title
          if (typeof title !== 'string') title = session.projectionValues?.title
          title = typeof title === 'string' ? title.trim() : ''
          return title.length > 0 ? title : '未命名会话'
        }

        const renderSession = (session, depth) => {
          const title = sessionTitle(session)
          const selected = currentId !== undefined && session.id === currentId
          const isRunning = session.running === true
          const isDragging = drag?.kind === 'session' && drag?.id === session.id
          return h(
            'div',
            {
              key: session.id,
              className: selected ? 'dsf_sessionRow dsf_selected' : 'dsf_sessionRow',
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                paddingLeft: 10 + depth * 14,
                paddingRight: 4,
                minHeight: 30,
                borderRadius: 6,
                cursor: 'pointer',
                background: selected ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.15))' : 'transparent',
                opacity: isDragging ? 0.45 : 1,
              },
              draggable: !isRunning,
              onClick: () => openSession(session.id),
              onDragStart: (event) => {
                if (isRunning) {
                  event.preventDefault()
                  return
                }
                beginDrag(event, 'session', session.id)
              },
              onDragEnd: endDrag,
              onDragOver: (event) => {
                if (drag?.kind === 'session') event.preventDefault()
              },
              onDrop: (event) => {
                event.preventDefault()
                if (drag?.kind === 'session') dropSessionOntoSession(drag.id, session.id)
              },
            },
            isRunning
              ? runningSpinner()
              : h(
                'span',
                {
                  'aria-hidden': true,
                  style: { fontSize: 13, lineHeight: '20px', flex: 'none', opacity: 0.85 },
                },
                '💬',
              ),
            h(
              'span',
              {
                style: {
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 13,
                  lineHeight: '20px',
                },
              },
              title,
            ),
            renderSlot !== null
              ? h('span', { onClick: (event) => event.stopPropagation() }, renderSlot('sidebar.workspaces.session.row.action', { sessionId: session.id, displayTitle: title }))
              : null,
            h(
              'button',
              {
                type: 'button',
                title: '会话菜单',
                'aria-label': '会话菜单',
                className: 'dsf_sessionMenu',
                style: {
                  width: 24,
                  height: 24,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: 'none',
                  borderRadius: 6,
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary, inherit)',
                  font: 'inherit',
                  fontSize: 16,
                  cursor: 'pointer',
                  opacity: 0.55,
                },
                onClick: (event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  const rect = event.currentTarget.getBoundingClientRect()
                  openSessionMenu(session.id, title, { x: rect.left, y: rect.bottom })
                },
              },
              '⋯',
            ),
          )
        }

        const renderWorkspace = (ws, depth, nested = true) => {
          const children = nested ? (childrenByParent.get(ws.workspaceId) ?? []) : []
          const sessionIds = Array.isArray(ws.sessionIds) ? ws.sessionIds : []
          const sessionsOf = sessionIds.map((id) => byId[id]).filter((session) => session != null)
          const isCollapsed = collapsed.has(ws.workspaceId)
          const title = typeof ws.title === 'string' && ws.title.length > 0 ? ws.title : typeof ws.path === 'string' ? ws.path : '工作区'
          const wsRunning = workspaceRunning(ws)
          const isDragging = drag?.kind === 'workspace' && drag?.id === ws.workspaceId

          return h(
            'div',
            { key: ws.workspaceId, className: 'dsf_workspace' },
            h(
              'div',
              {
                className: 'dsf_workspaceRow',
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 2,
                  paddingLeft: 6 + depth * 14,
                  minHeight: 30,
                  borderRadius: 6,
                  opacity: isDragging ? 0.45 : 1,
                },
                draggable: !wsRunning,
                onDragStart: (event) => {
                  if (wsRunning) {
                    event.preventDefault()
                    return
                  }
                  beginDrag(event, 'workspace', ws.workspaceId)
                },
                onDragEnd: endDrag,
                onDragOver: (event) => {
                  if (drag?.kind === 'workspace' || drag?.kind === 'session') event.preventDefault()
                },
                onDrop: (event) => {
                  event.preventDefault()
                  if (drag?.kind === 'workspace') dropWorkspaceOntoWorkspace(drag.id, ws.workspaceId)
                  else if (drag?.kind === 'session') dropSessionOntoWorkspace(drag.id, ws.workspaceId)
                },
              },
              h(
                'button',
                {
                  type: 'button',
                  title: isCollapsed ? '展开' : '折叠',
                  'aria-label': isCollapsed ? '展开' : '折叠',
                  style: {
                    width: 20,
                    height: 24,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: 'none',
                    borderRadius: 4,
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary, inherit)',
                    font: 'inherit',
                    fontSize: 12,
                    cursor: 'pointer',
                    opacity: 0.55,
                  },
                  onClick: () => toggle(ws.workspaceId),
                },
                isCollapsed ? '▸' : '▾',
              ),
              h(
                'span',
                {
                  'aria-hidden': true,
                  style: { fontSize: 13, lineHeight: '20px', flex: 'none', opacity: 0.9 },
                },
                '📁',
              ),
              h(
                'span',
                {
                  title: typeof ws.path === 'string' ? ws.path : undefined,
                  onClick: () => toggle(ws.workspaceId),
                  style: {
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 13,
                    fontWeight: 600,
                    lineHeight: '20px',
                    cursor: 'pointer',
                  },
                },
                title,
              ),
              h(
                'button',
                {
                  type: 'button',
                  title: '工作区菜单',
                  'aria-label': '工作区菜单',
                  'aria-haspopup': 'menu',
                  className: 'dsf_workspaceMenu',
                  style: {
                    width: 24,
                    height: 24,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: 'none',
                    borderRadius: 6,
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary, inherit)',
                    font: 'inherit',
                    fontSize: 16,
                    cursor: 'pointer',
                    opacity: 0.55,
                  },
                  onClick: (event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    const rect = event.currentTarget.getBoundingClientRect()
                    setWorkspaceMenu({
                      workspaceId: ws.workspaceId,
                      displayTitle: title,
                      path: typeof ws.path === 'string' ? ws.path : '',
                      x: rect.right - 6,
                      y: rect.bottom + 4,
                    })
                  },
                },
                '⋯',
              ),
            ),
            isCollapsed
              ? null
              : h(
                  'div',
                  null,
                  sessionsOf.map((session) => renderSession(session, depth + 1)),
                  children.map((child) => renderWorkspace(child, depth + 1)),
                ),
          )
        }

        const roots = childrenByParent.get(undefined) ?? []

        const addWorkspace = async () => {
          try {
            if (typeof uiWorkspace?.pickDirectory !== 'function') return
            const path = await uiWorkspace.pickDirectory()
            if (typeof path !== 'string' || path.length === 0) return
            if (typeof workspaces?.create !== 'function') return
            await workspaces.create({ path })
          } catch (error) {
            console.warn('dsh-session-folders: 添加工作区失败', error)
          }
        }

        const normalizedQuery = String(searchQuery ?? '').trim()
        const searching = normalizedQuery.length > 0

        const allSessions = []
        for (const id of Object.keys(byId)) {
          const session = byId[id]
          if (session != null) allSessions.push(session)
        }

        const searchResults = searching
          ? allSessions.filter((session) => sessionTitle(session).toLowerCase().includes(normalizedQuery.toLowerCase()))
          : []

        const iconButtonStyle = {
          width: 26,
          height: 26,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: 'none',
          borderRadius: 6,
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary, inherit)',
          font: 'inherit',
          fontSize: 15,
          lineHeight: 1,
          cursor: 'pointer',
          opacity: 0.8,
        }

        const emptyHint = h(
          'div',
          { style: { padding: '8px 10px', fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' } },
          '还没有工作区，请先在左侧创建一个工作区。',
        )

        const viewOptions = [
          ['workspace-tree', '按工作区树'],
          ['workspace', '按工作区'],
          ['flat', '单列表'],
        ]

        let body
        if (searching) {
          body = searchResults.length === 0
            ? h('div', { style: { padding: '8px 10px', fontSize: 12, color: 'var(--dsw-alias-label-secondary, inherit)' } }, '没有匹配的对话。')
            : searchResults.map((session) => renderSession(session, 0))
        } else if (viewMode === 'flat') {
          body = allSessions.length === 0 ? emptyHint : allSessions.map((session) => renderSession(session, 0))
        } else if (viewMode === 'workspace') {
          body = items.length === 0 ? emptyHint : items.map((ws) => renderWorkspace(ws, 0, false))
        } else {
          body = roots.length === 0 ? emptyHint : roots.map((ws) => renderWorkspace(ws, 0))
        }

        return h(
          'div',
          {
            className: 'dsf_browser',
            style: {
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              minHeight: 0,
              height: '100%',
              padding: '4px 2px',
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            },
          },
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                padding: '2px 4px 6px',
                flex: 'none',
                position: 'relative',
              },
            },
            searchExpanded
              ? null
              : h(
                  'span',
                  {
                    style: {
                      flex: 1,
                      minWidth: 0,
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--dsw-alias-label-secondary, inherit)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    },
                  },
                  viewMode === 'flat' ? '会话' : '工作区',
                ),
            searchExpanded
              ? h('input', {
                  type: 'text',
                  value: searchQuery,
                  placeholder: '搜索对话…',
                  autoFocus: true,
                  style: {
                    flex: 1,
                    minWidth: 0,
                    height: 26,
                    padding: '0 8px',
                    borderRadius: 6,
                    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-primary, inherit)',
                    font: 'inherit',
                    fontSize: 12,
                    outline: 'none',
                    boxSizing: 'border-box',
                  },
                  onChange: (event) => setSearchQuery(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Escape') {
                      setSearchQuery('')
                      setSearchExpanded(false)
                    }
                  },
                })
              : null,
            h(
              'button',
              {
                type: 'button',
                title: '搜索',
                'aria-label': '搜索',
                style: iconButtonStyle,
                onClick: () => {
                  if (searchExpanded) {
                    setSearchQuery('')
                    setSearchExpanded(false)
                  } else {
                    setSearchExpanded(true)
                  }
                },
              },
              h(
                'svg',
                {
                  width: 14,
                  height: 14,
                  viewBox: '0 0 16 16',
                  fill: 'none',
                  stroke: 'currentColor',
                  strokeWidth: 1.6,
                  strokeLinecap: 'round',
                  'aria-hidden': true,
                  style: { display: 'block' },
                },
                h('circle', { cx: 7, cy: 7, r: 4.5 }),
                h('line', { x1: 10.5, y1: 10.5, x2: 14, y2: 14 }),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                title: '视图选项',
                'aria-label': '视图选项',
                style: iconButtonStyle,
                onClick: () => setViewMenuOpen((v) => !v),
              },
              '☰',
            ),
            viewMenuOpen
              ? h(
                  'div',
                  {
                    style: {
                      position: 'absolute',
                      top: '100%',
                      right: 2,
                      zIndex: 20,
                      minWidth: 150,
                      padding: 4,
                      borderRadius: 8,
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
                      background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #ffffff))',
                      color: 'var(--dsw-alias-label-primary, inherit)',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.22)',
                      font: 'inherit',
                    },
                  },
                  viewOptions.map((entry) =>
                    h(
                      'button',
                      {
                        key: entry[0],
                        type: 'button',
                        style: {
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '6px 10px',
                          border: 'none',
                          borderRadius: 6,
                          background: viewMode === entry[0] ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.15))' : 'transparent',
                          color: 'inherit',
                          font: 'inherit',
                          fontSize: 13,
                          lineHeight: '18px',
                          cursor: 'pointer',
                        },
                        onClick: () => {
                          setViewMode(entry[0])
                          setViewMenuOpen(false)
                        },
                      },
                      entry[1],
                    ),
                  ),
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                title: '添加工作区',
                'aria-label': '添加工作区',
                style: iconButtonStyle,
                onClick: () => void addWorkspace(),
              },
              '＋',
            ),
          ),
          h(
            'div',
            {
              style: {
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                paddingBottom: 8,
              },
            },
            body,
          ),
          workspaceMenu !== null
            ? h(
                'div',
                {
                  key: 'dsf_workspaceMenuBackdrop',
                  style: { position: 'fixed', inset: 0, zIndex: 2147482004 },
                  onMouseDown: (event) => {
                    if (event.target === event.currentTarget) setWorkspaceMenu(null)
                  },
                },
                h(
                  'div',
                  {
                    style: {
                      position: 'fixed',
                      left: workspaceMenu.x,
                      top: workspaceMenu.y,
                      zIndex: 2147482004,
                      minWidth: 168,
                      padding: 4,
                      borderRadius: 8,
                      border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
                      background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #ffffff))',
                      color: 'var(--dsw-alias-label-primary, inherit)',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.22)',
                      font: 'inherit',
                    },
                    onMouseDown: (event) => event.stopPropagation(),
                  },
                  [
                    ['新建对话', () => newConversation(workspaceMenu.workspaceId), false],
                    ['新建子工作区', () => openSubWorkspaceDialog(workspaceMenu.workspaceId), false],
                    ['在文件夹中显示', () => revealFolder(workspaceMenu.path), false],
                    ['重命名', () => openRenameWorkspaceDialog(workspaceMenu.workspaceId, workspaceMenu.displayTitle), false],
                    ['删除工作区', () => openDeleteWorkspaceDialog(workspaceMenu.workspaceId, workspaceMenu.displayTitle), true],
                  ].map(([label, run, danger]) =>
                    h(
                      'button',
                      {
                        key: label,
                        type: 'button',
                        style: {
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '7px 10px',
                          border: 'none',
                          borderRadius: 6,
                          background: 'transparent',
                          color: danger ? 'var(--dsw-alias-label-danger, #d54f4f)' : 'inherit',
                          font: 'inherit',
                          fontSize: 13,
                          lineHeight: '18px',
                          cursor: 'pointer',
                        },
                        onClick: () => {
                          setWorkspaceMenu(null)
                          run()
                        },
                      },
                      label,
                    ),
                  ),
                ),
              )
            : null,
        )
      }

      function SubWorkspaceDialog() {
        const current = useSubDialogState()

        React.useEffect(() => {
          if (current === null) return undefined
          const onKeyDown = (event) => {
            if (event.key === 'Escape' && current.busy !== true) setSubDialog(null)
          }
          window.addEventListener('keydown', onKeyDown)
          return () => window.removeEventListener('keydown', onKeyDown)
        }, [current === null, current?.busy])

        if (current === null) return null

        const busy = current.busy === true
        const workspaces = Array.isArray(current.workspaces) ? current.workspaces : []
        const canCreate = !busy && current.parentWorkspaceId.length > 0 && String(current.name ?? '').trim().length > 0

        const create = async () => {
          const target = subDialog
          if (target === null || target.busy === true) return
          if (typeof target.parentWorkspaceId !== 'string' || target.parentWorkspaceId.length === 0) return
          const name = String(target.name ?? '').trim()
          if (name.length === 0) return
          setSubDialog({ ...target, busy: true, error: null })
          try {
            await callHost('POST', CREATE_SUB_PATH, { parentWorkspaceId: target.parentWorkspaceId, name })
            setSubDialog(null)
          } catch (error) {
            setSubDialog({ ...target, busy: false, error: String(error?.message ?? error) })
          }
        }

        const fieldStyle = {
          width: '100%',
          boxSizing: 'border-box',
          height: 34,
          padding: '0 10px',
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
          background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
          color: 'var(--dsw-alias-label-primary, inherit)',
          font: 'inherit',
          fontSize: 13,
          outline: 'none',
        }
        const labelStyle = { display: 'block', marginBottom: 4, color: 'var(--dsw-alias-label-secondary, inherit)' }
        const hintStyle = { color: 'var(--dsw-alias-label-secondary, inherit)' }

        return h(
          'div',
          {
            role: 'presentation',
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 2147482001,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
              background: 'rgba(0,0,0,0.36)',
            },
            onMouseDown: (event) => {
              if (event.target === event.currentTarget && busy !== true) setSubDialog(null)
            },
          },
          h(
            'div',
            {
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': FOOTER_LABEL,
              style: {
                width: 'min(520px, 100%)',
                boxSizing: 'border-box',
                padding: 20,
                borderRadius: 14,
                border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))',
                background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #ffffff))',
                color: 'var(--dsw-alias-label-primary, inherit)',
                boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
                font: 'inherit',
                fontSize: 13,
                lineHeight: '20px',
              },
            },
            h(
              'div',
              { style: { fontSize: 15, fontWeight: 600, lineHeight: '22px', marginBottom: 12 } },
              FOOTER_LABEL,
            ),
            busy === true && workspaces.length === 0
              ? h('div', { style: hintStyle }, '正在读取工作区…')
              : workspaces.length === 0
                ? h('div', { style: hintStyle }, '还没有工作区，请先在左侧创建一个工作区。')
                : h(
                    React.Fragment,
                    null,
                    h('label', { style: labelStyle }, '父工作区'),
                    h(
                      'select',
                      {
                        value: current.parentWorkspaceId,
                        disabled: busy,
                        style: fieldStyle,
                        onChange: (event) => {
                          const target = subDialog
                          if (target !== null) setSubDialog({ ...target, parentWorkspaceId: event.target.value })
                        },
                      },
                      h('option', { value: '', disabled: true }, '选择一个工作区…'),
                      workspaces.map((ws) =>
                        h('option', { key: ws.id, value: ws.id }, ws.path ? `${ws.title} — ${ws.path}` : ws.title),
                      ),
                    ),
                    h(
                      'label',
                      { style: { ...labelStyle, marginTop: 12 } },
                      '子工作区名称',
                    ),
                    h('input', {
                      type: 'text',
                      value: current.name ?? '',
                      disabled: busy,
                      placeholder: '例如：项目A',
                      autoFocus: true,
                      style: fieldStyle,
                      onChange: (event) => {
                        const target = subDialog
                        if (target !== null) setSubDialog({ ...target, name: event.target.value })
                      },
                      onKeyDown: (event) => {
                        if (event.key === 'Enter' && canCreate) void create()
                      },
                    }),
                    h(
                      'div',
                      { style: { ...hintStyle, marginTop: 8, fontSize: 12 } },
                      '会在父工作区文件夹里新建一个同名子文件夹，并把它注册成子工作区。',
                    ),
                  ),
            current.error !== null
              ? h(
                  'div',
                  { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary, #ef4444)', marginTop: 10 } },
                  current.error,
                )
              : null,
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 } },
              h(
                'button',
                { type: 'button', style: buttonStyle('ghost', busy), disabled: busy, onClick: () => setSubDialog(null) },
                '取消',
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: buttonStyle('primary', busy || !canCreate),
                  disabled: busy || !canCreate,
                  onClick: () => void create(),
                },
                '创建子工作区',
              ),
            ),
          ),
        )
      }

      function RenameWorkspaceDialog() {
        const current = useRenameDialogState()

        React.useEffect(() => {
          if (current === null) return undefined
          const onKeyDown = (event) => {
            if (event.key === 'Escape' && current.busy !== true) setRenameDialog(null)
          }
          window.addEventListener('keydown', onKeyDown)
          return () => window.removeEventListener('keydown', onKeyDown)
        }, [current === null, current?.busy])

        if (current === null) return null

        const busy = current.busy === true
        const name = String(current.name ?? '').trim()
        const canSubmit = !busy && name.length > 0

        const submit = async () => {
          const target = renameDialog
          if (target === null || target.busy === true) return
          const nextName = String(target.name ?? '').trim()
          if (nextName.length === 0) return
          const service = browserServices === null ? null : browserServices.workspaces
          if (service === undefined || service === null || typeof service.rename !== 'function') {
            setRenameDialog({ ...target, busy: false, error: '工作区服务不可用，请刷新页面后重试' })
            return
          }
          setRenameDialog({ ...target, busy: true, error: null })
          try {
            await service.rename(target.workspaceId, nextName)
            setRenameDialog(null)
          } catch (error) {
            setRenameDialog({ ...target, busy: false, error: String(error?.message ?? error) })
          }
        }

        const fieldStyle = {
          width: '100%',
          boxSizing: 'border-box',
          height: 34,
          padding: '0 10px',
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3))',
          background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
          color: 'var(--dsw-alias-label-primary, inherit)',
          font: 'inherit',
          fontSize: 13,
          outline: 'none',
        }
        const labelStyle = { display: 'block', marginBottom: 4, color: 'var(--dsw-alias-label-secondary, inherit)' }
        const hintStyle = { color: 'var(--dsw-alias-label-secondary, inherit)' }

        return h(
          'div',
          {
            role: 'presentation',
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 2147482002,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
              background: 'rgba(0,0,0,0.36)',
            },
            onMouseDown: (event) => {
              if (event.target === event.currentTarget && busy !== true) setRenameDialog(null)
            },
          },
          h(
            'div',
            {
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': '重命名工作区',
              style: {
                width: 'min(460px, 100%)',
                boxSizing: 'border-box',
                padding: 20,
                borderRadius: 14,
                border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))',
                background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #ffffff))',
                color: 'var(--dsw-alias-label-primary, inherit)',
                boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
                font: 'inherit',
                fontSize: 13,
                lineHeight: '20px',
              },
            },
            h('div', { style: { fontSize: 15, fontWeight: 600, lineHeight: '22px', marginBottom: 12 } }, '重命名工作区'),
            h('label', { style: labelStyle }, '新名称'),
            h('input', {
              type: 'text',
              value: current.name ?? '',
              disabled: busy,
              autoFocus: true,
              style: fieldStyle,
              onChange: (event) => {
                const target = renameDialog
                if (target !== null) setRenameDialog({ ...target, name: event.target.value })
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter' && canSubmit) void submit()
              },
            }),
            h(
              'div',
              { style: { ...hintStyle, marginTop: 8, fontSize: 12 } },
              '工作区文件夹及其中的对话文件夹会跟着一起改名。',
            ),
            current.error !== null
              ? h(
                  'div',
                  { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary, #ef4444)', marginTop: 10 } },
                  current.error,
                )
              : null,
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 } },
              h(
                'button',
                { type: 'button', style: buttonStyle('ghost', busy), disabled: busy, onClick: () => setRenameDialog(null) },
                '取消',
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: buttonStyle('primary', busy || !canSubmit),
                  disabled: busy || !canSubmit,
                  onClick: () => void submit(),
                },
                '重命名',
              ),
            ),
          ),
        )
      }

      function DeleteWorkspaceDialog() {
        const current = useDeleteWorkspaceDialogState()

        React.useEffect(() => {
          if (current === null) return undefined
          const onKeyDown = (event) => {
            if (event.key === 'Escape' && current.busy !== true) setDeleteWorkspaceDialog(null)
          }
          window.addEventListener('keydown', onKeyDown)
          return () => window.removeEventListener('keydown', onKeyDown)
        }, [current === null, current?.busy])

        if (current === null) return null

        const busy = current.busy === true
        const loaded = current.loaded === true
        const hasContent = current.hasContent === true
        const entryCount = typeof current.entryCount === 'number' ? current.entryCount : 0
        const deleteFolder = current.deleteFolder === true

        const submit = async () => {
          const target = deleteWorkspaceDialog
          if (target === null || target.busy === true) return
          setDeleteWorkspaceDialog({ ...target, busy: true, error: null })
          try {
            await callHost('POST', DELETE_WORKSPACE_PATH, {
              workspaceId: target.workspaceId,
              deleteFolder: target.deleteFolder === true,
            })
            setDeleteWorkspaceDialog(null)
          } catch (error) {
            setDeleteWorkspaceDialog({ ...target, busy: false, error: String(error?.message ?? error) })
          }
        }

        const labelStyle = { display: 'block', marginBottom: 4, color: 'var(--dsw-alias-label-secondary, inherit)' }
        const hintStyle = { color: 'var(--dsw-alias-label-secondary, inherit)' }
        const dangerStyle = { color: 'var(--dsw-alias-state-error-primary, #ef4444)' }

        return h(
          'div',
          {
            role: 'presentation',
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 2147482003,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
              background: 'rgba(0,0,0,0.36)',
            },
            onMouseDown: (event) => {
              if (event.target === event.currentTarget && busy !== true) setDeleteWorkspaceDialog(null)
            },
          },
          h(
            'div',
            {
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': '删除工作区',
              style: {
                width: 'min(480px, 100%)',
                boxSizing: 'border-box',
                padding: 20,
                borderRadius: 14,
                border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))',
                background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #ffffff))',
                color: 'var(--dsw-alias-label-primary, inherit)',
                boxShadow: '0 18px 48px rgba(0,0,0,0.28)',
                font: 'inherit',
                fontSize: 13,
                lineHeight: '20px',
              },
            },
            h('div', { style: { fontSize: 15, fontWeight: 600, lineHeight: '22px', marginBottom: 12 } }, '删除工作区'),
            h(
              'div',
              { style: { marginBottom: 10 } },
              '删除工作区「',
              h('b', null, String(current.displayTitle ?? '')),
              '」只会取消注册，不会自动删除磁盘上的文件夹。',
            ),
            !loaded
              ? h('div', { style: hintStyle }, '正在检查工作区文件夹…')
              : h(
                  'div',
                  null,
                  hasContent
                    ? h('div', { style: { marginBottom: 8 } }, '该工作区文件夹内还有 ', h('b', null, String(entryCount)), ' 个项目。')
                    : h('div', { style: { marginBottom: 8 } }, '该工作区文件夹是空的。'),
                  hasContent
                    ? h(
                        'label',
                        {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            marginBottom: 4,
                            cursor: 'pointer',
                            userSelect: 'none',
                          },
                        },
                        h('input', {
                          type: 'checkbox',
                          checked: deleteFolder,
                          disabled: busy,
                          onChange: (event) => {
                            const target = deleteWorkspaceDialog
                            if (target !== null) setDeleteWorkspaceDialog({ ...target, deleteFolder: event.target.checked })
                          },
                        }),
                        h('span', null, '同时删除对应的文件夹及其中的所有文件（不可恢复）'),
                      )
                    : null,
                ),
            current.error !== null
              ? h('div', { role: 'alert', style: { ...dangerStyle, marginTop: 10 } }, current.error)
              : null,
            h(
              'div',
              { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 } },
              h(
                'button',
                { type: 'button', style: buttonStyle('ghost', busy), disabled: busy, onClick: () => setDeleteWorkspaceDialog(null) },
                '取消',
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: buttonStyle('danger', busy || !loaded),
                  disabled: busy || !loaded,
                  onClick: () => void submit(),
                },
                deleteFolder ? '删除工作区及文件' : '删除工作区',
              ),
            ),
          ),
        )
      }

      /* ── 插件 ───────────────────────────────────────────────────────── */

      function apply(ctx) {
        let uiWorkspaceService = ctx.uiWorkspace
        if (uiWorkspaceService === undefined || uiWorkspaceService === null) {
          try {
            uiWorkspaceService = ctx.get('uiWorkspace')
          } catch (error) {
            console.warn('dsh-session-folders: uiWorkspace 服务不可用', error)
          }
        }
        let workspacesService
        try {
          workspacesService = ctx.get('workspaces')
        } catch (error) {
          console.warn('dsh-session-folders: workspaces 服务不可用', error)
        }
        browserServices = {
          contextMenus: ctx.get('contextMenus'),
          uiWorkspace: uiWorkspaceService,
          workspaces: workspacesService,
        }
        // 隐藏 DSH 自带的「重命名 / 删除工作区」菜单项：它们的弹窗画在已被本插件
        // 替换掉的工作区列表组件内部，点击无效。这两个自带项在 ctx.effect 里注册，
        // 而 effect 阶段晚于本 apply 执行，所以这里同步包装 register 即可拦截。
        try {
          const nativeMenuService = browserServices.contextMenus
          if (
            nativeMenuService != null &&
            typeof nativeMenuService.register === 'function' &&
            !nativeMenuService.register.__sessionFoldersFiltered
          ) {
            const originalRegister = nativeMenuService.register
            const filteredRegister = (input) => {
              if (
                input != null &&
                input.target === 'workspace' &&
                (input.id === 'workspace.rename' || input.id === 'workspace.delete')
              ) {
                return () => {}
              }
              return originalRegister(input)
            }
            filteredRegister.__sessionFoldersFiltered = true
            nativeMenuService.register = filteredRegister
          }
        } catch (error) {
          console.warn('dsh-session-folders: 隐藏自带工作区菜单项失败', error)
        }
        ctx.slots.inject(WORKSPACES_SLOT, () =>
          ctx.slots.register({ name: WORKSPACES_SLOT, priority: -1 }, WorkspaceBrowser),
        )
        ctx.slots.inject(MENU_SLOT, () =>
          ctx.slots.register({ name: MENU_SLOT, id: MENU_ID, order: 9998, label: MENU_LABEL }, DeleteMenuItem),
        )
        ctx.slots.inject(OVERLAY_SLOT, () =>
          ctx.slots.register({ name: OVERLAY_SLOT, id: OVERLAY_ID }, ConfirmDialog),
        )
        ctx.slots.inject(OVERLAY_SLOT, () =>
          ctx.slots.register({ name: OVERLAY_SLOT, id: SUB_OVERLAY_ID }, SubWorkspaceDialog),
        )
        ctx.slots.inject(OVERLAY_SLOT, () =>
          ctx.slots.register({ name: OVERLAY_SLOT, id: RENAME_OVERLAY_ID }, RenameWorkspaceDialog),
        )
        ctx.slots.inject(OVERLAY_SLOT, () =>
          ctx.slots.register({ name: OVERLAY_SLOT, id: DELETE_WORKSPACE_OVERLAY_ID }, DeleteWorkspaceDialog),
        )
        const contextMenusService = browserServices.contextMenus
        if (
          contextMenusService !== undefined &&
          contextMenusService !== null &&
          typeof contextMenusService.register === 'function'
        ) {
          try {
            contextMenusService.register({
              id: 'session-folders.workspace-rename',
              target: 'workspace',
              order: 90,
              resolve: ({ workspaceId, displayTitle }) => [
                {
                  id: 'rename',
                  label: '重命名',
                  run: () => openRenameWorkspaceDialog(workspaceId, displayTitle),
                },
              ],
            })
          } catch (error) {
            console.warn('dsh-session-folders: 注册工作区重命名菜单失败', error)
          }
          try {
            contextMenusService.register({
              id: 'session-folders.workspace-delete',
              target: 'workspace',
              order: 100,
              resolve: ({ workspaceId, displayTitle }) => [
                {
                  id: 'delete',
                  label: '删除工作区',
                  run: () => openDeleteWorkspaceDialog(workspaceId, displayTitle),
                },
              ],
            })
          } catch (error) {
            console.warn('dsh-session-folders: 注册工作区删除菜单失败', error)
          }
        }
      }

      return { inject: ['slots', 'contextMenus', 'workspaces', 'uiWorkspace'], apply }
    },
  })
})()
