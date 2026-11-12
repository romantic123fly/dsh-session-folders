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

      /* ── 插件 ───────────────────────────────────────────────────────── */

      function apply(ctx) {
        ctx.slots.inject(MENU_SLOT, () =>
          ctx.slots.register({ name: MENU_SLOT, id: MENU_ID, order: 9998, label: MENU_LABEL }, DeleteMenuItem),
        )
        ctx.slots.inject(OVERLAY_SLOT, () =>
          ctx.slots.register({ name: OVERLAY_SLOT, id: OVERLAY_ID }, ConfirmDialog),
        )
      }

      return { inject: ['slots'], apply }
    },
  })
})()
