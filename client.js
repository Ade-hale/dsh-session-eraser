/**
 * dsh-session-eraser — Client half.
 *
 * Adds two entries to the shared session context menu (`target: 'session'`):
 *   session.delete — two-step delete, so a single stray click cannot destroy a
 *                    whole conversation. The first click arms the action for a
 *                    few seconds and the menu asks again; the second click
 *                    deletes. A running session stays disabled.
 *   session.trash  — opens the Trash panel (registered on the keyed `main`
 *                    slot) where deleted sessions can be restored, purged, or
 *                    the whole trash emptied.
 *
 * After a delete or restore the session list is refreshed; deleting the session
 * that is open in the main view reloads the page, because the log underneath it
 * is gone.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-eraser',
  factory(require) {
    const React = require('react')
    const NS = 'dsh-session-eraser'
    const TRASH_PANEL = 'session-eraser.trash'
    const ARMED_MS = 4000

    function toast(text) {
      if (typeof document === 'undefined') return
      const el = document.createElement('div')
      el.textContent = text
      el.setAttribute('role', 'status')
      Object.assign(el.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        zIndex: '2147483000',
        maxWidth: '360px',
        padding: '8px 14px',
        borderRadius: '8px',
        fontSize: '13px',
        lineHeight: '1.5',
        background: 'rgba(20, 24, 32, 0.92)',
        color: '#f5f6f8',
        boxShadow: '0 6px 24px rgba(0,0,0,0.24)',
        pointerEvents: 'none',
        opacity: '0',
        transition: 'opacity 140ms ease',
      })
      document.body.appendChild(el)
      requestAnimationFrame(() => {
        el.style.opacity = '1'
      })
      setTimeout(() => {
        el.style.opacity = '0'
        setTimeout(() => el.remove(), 200)
      }, 3200)
    }

    function formatSize(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    async function callRoute(path, options) {
      const res = await fetch(path, options)
      const payload = await res.json().catch(() => null)
      return { res, payload }
    }

    return {
      inject: ['contextMenus', 'sessions', 'locale', 'slots', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: {
            'menu.delete': '删除会话',
            'menu.running': '该会话正在运行，无法删除',
            'confirm.again': '再点一次「删除会话」确认删除',
            'error.busy': '该会话正在运行，请先停止再删除',
            'error.generic': '删除失败，请重试',
            'deleted': '会话已删除',
            'menu.trash': '回收站',
            'trash.title': '会话回收站',
            'trash.retention': '超过保留期的条目会被永久清除',
            'trash.refresh': '刷新',
            'trash.empty': '清空回收站',
            'trash.emptyConfirm': '再点一次确认清空回收站',
            'trash.emptyDone': '回收站已清空',
            'trash.restore': '还原',
            'trash.purge': '彻底删除',
            'trash.none': '回收站是空的',
            'trash.loading': '加载中…',
            'trash.failed': '操作失败，请重试',
            'trash.restored': '会话已还原',
            'trash.purged': '已彻底删除',
            'trash.col.session': '会话目录',
            'trash.col.workspace': '工作区',
            'trash.col.deleted': '删除时间',
            'trash.col.size': '大小',
            'trash.col.actions': '操作',
          },
          en: {
            'menu.delete': 'Delete session',
            'menu.running': 'This session is running and cannot be deleted',
            'confirm.again': 'Click Delete session again to confirm',
            'error.busy': 'This session is running; stop it before deleting',
            'error.generic': 'Delete failed, please retry',
            'deleted': 'Session deleted',
            'menu.trash': 'Trash',
            'trash.title': 'Session trash',
            'trash.retention': 'Entries past the retention window are purged permanently',
            'trash.refresh': 'Refresh',
            'trash.empty': 'Empty trash',
            'trash.emptyConfirm': 'Click Empty trash again to confirm',
            'trash.emptyDone': 'Trash emptied',
            'trash.restore': 'Restore',
            'trash.purge': 'Delete forever',
            'trash.none': 'The trash is empty',
            'trash.loading': 'Loading…',
            'trash.failed': 'Action failed, please retry',
            'trash.restored': 'Session restored',
            'trash.purged': 'Deleted forever',
            'trash.col.session': 'Session directory',
            'trash.col.workspace': 'Workspace',
            'trash.col.deleted': 'Deleted',
            'trash.col.size': 'Size',
            'trash.col.actions': 'Actions',
          },
        }), 'session-delete: locale dictionary')

        const t = ctx.locale.bind(NS)

        /**
         * Ask the session service whether a session is running.
         * `ctx.sessions` only exposes `binding(id)` for a retained generation, so
         * this can legitimately answer "unknown" — the Host still refuses a
         * running session with 409, and that refusal is shown to the user.
         */
        function isRunning(sessionId) {
          try {
            const snapshot = ctx.sessions.binding(sessionId)?.session?.getSnapshot?.()
            if (snapshot && typeof snapshot.running === 'boolean') return snapshot.running
          } catch (error) {
            console.warn('[session-delete] cannot read session state', error)
          }
          return null
        }

        async function remove(sessionId) {
          let res
          try {
            res = await fetch('/session-delete/delete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            })
          } catch (error) {
            toast(`${t('error.generic')} (${error?.message || error})`)
            return
          }
          if (!res.ok) {
            const payload = await res.json().catch(() => ({}))
            if (payload.error === 'session-busy') {
              toast(t('error.busy'))
            } else {
              toast(`${t('error.generic')} [${res.status} ${payload.error || ''}]`)
            }
            return
          }
          // The Host broadcasts the official `api-session/removed` event, so the
          // sidebar and workspace views drop the row on their own. Only a view
          // that still points at the deleted session needs a reload.
          try {
            if (window.location.href.includes(sessionId)) window.location.reload()
          } catch (error) {
            console.warn('[session-delete] reload check failed', error)
          }
          toast(t('deleted'))
        }

        // One confirmation is armed at a time: reopening the menu within the
        // window shows the confirming label instead of silently deleting.
        let armedId = null
        let armedTimer = null
        function arm(sessionId) {
          armedId = sessionId
          if (armedTimer) clearTimeout(armedTimer)
          armedTimer = setTimeout(() => {
            armedId = null
            armedTimer = null
          }, ARMED_MS)
        }
        function disarm() {
          armedId = null
          if (armedTimer) clearTimeout(armedTimer)
          armedTimer = null
        }

        // ---------------------------------------------------------------- trash
        function TrashPanel() {
          const [entries, setEntries] = React.useState([])
          const [loading, setLoading] = React.useState(true)
          const [error, setError] = React.useState(null)
          const [retention, setRetention] = React.useState(null)
          const [armedEmpty, setArmedEmpty] = React.useState(false)

          const load = React.useCallback(async () => {
            setLoading(true)
            setError(null)
            try {
              const { res, payload } = await callRoute('/session-delete/trash', { method: 'GET' })
              if (!res.ok || !payload?.ok) {
                setError(t('trash.failed'))
              } else {
                setEntries(payload.entries ?? [])
                setRetention(payload.retentionDays ?? null)
              }
            } catch {
              setError(t('trash.failed'))
            } finally {
              setLoading(false)
            }
          }, [])

          React.useEffect(() => {
            void load()
          }, [load])

          React.useEffect(() => {
            if (!armedEmpty) return
            const timer = setTimeout(() => setArmedEmpty(false), ARMED_MS)
            return () => clearTimeout(timer)
          }, [armedEmpty])

          const restore = async (name) => {
            const { res, payload } = await callRoute('/session-delete/trash/restore', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            }).catch(() => ({ res: null, payload: null }))
            if (!res || !res.ok || !payload?.ok) {
              toast(payload?.error === 'already-exists' ? t('error.generic') : t('trash.failed'))
              return
            }
            toast(t('trash.restored'))
            await load()
          }

          const purge = async (name) => {
            const { res, payload } = await callRoute('/session-delete/trash/purge', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            }).catch(() => ({ res: null, payload: null }))
            if (!res || !res.ok || !payload?.ok) {
              toast(t('trash.failed'))
              return
            }
            toast(t('trash.purged'))
            await load()
          }

          const empty = async () => {
            if (!armedEmpty) {
              setArmedEmpty(true)
              toast(t('trash.emptyConfirm'))
              return
            }
            setArmedEmpty(false)
            const { res, payload } = await callRoute('/session-delete/trash/empty', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ confirm: true }),
            }).catch(() => ({ res: null, payload: null }))
            if (!res || !res.ok || !payload?.ok) {
              toast(t('trash.failed'))
              return
            }
            toast(t('trash.emptyDone'))
            await load()
          }

          const cell = {
            padding: '7px 10px',
            fontSize: '13px',
            textAlign: 'left',
            borderBottom: '1px solid rgba(127,127,127,0.18)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }
          const button = (label, onClick, danger) => React.createElement('button', {
            type: 'button',
            onClick,
            style: {
              marginRight: '8px',
              padding: '3px 10px',
              fontSize: '12px',
              borderRadius: '6px',
              border: '1px solid currentColor',
              background: 'transparent',
              color: danger ? '#d9534f' : 'inherit',
              cursor: 'pointer',
            },
          }, label)

          const rows = entries.map((entry) => React.createElement('tr', { key: entry.name }, [
            React.createElement('td', { key: 's', style: cell, title: entry.sessionDir }, entry.sessionDir),
            React.createElement('td', { key: 'w', style: cell, title: entry.workspaceKey }, entry.workspaceKey),
            React.createElement('td', { key: 'd', style: cell }, new Date(entry.deletedAt).toLocaleString()),
            React.createElement('td', { key: 'z', style: cell }, formatSize(entry.size)),
            React.createElement('td', { key: 'a', style: cell }, [
              button(t('trash.restore'), () => void restore(entry.name), false),
              button(t('trash.purge'), () => void purge(entry.name), true),
            ]),
          ]))

          const header = retention === null ? null : React.createElement('div', {
            style: { fontSize: '12px', opacity: 0.7, marginBottom: '10px' },
          }, `${t('trash.retention')} (${retention}d)`)

          return React.createElement('div', { style: { padding: '20px 24px' } }, [
            React.createElement('div', {
              key: 'head',
              style: { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' },
            }, [
              React.createElement('h2', { key: 't', style: { fontSize: '16px', margin: 0, flex: 1 } }, t('trash.title')),
              button(t('trash.refresh'), () => void load(), false),
              button(armedEmpty ? t('trash.emptyConfirm') : t('trash.empty'), () => void empty(), true),
            ]),
            header,
            error ? React.createElement('div', { key: 'err', style: { fontSize: '13px', color: '#d9534f' } }, error) : null,
            loading
              ? React.createElement('div', { key: 'load', style: { fontSize: '13px', opacity: 0.7 } }, t('trash.loading'))
              : entries.length === 0
                ? React.createElement('div', { key: 'none', style: { fontSize: '13px', opacity: 0.7 } }, t('trash.none'))
                : React.createElement('table', {
                  key: 'table',
                  style: { width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' },
                }, [
                  React.createElement('thead', { key: 'h' }, React.createElement('tr', null, [
                    React.createElement('th', { key: 's', style: { ...cell, width: '34%' } }, t('trash.col.session')),
                    React.createElement('th', { key: 'w', style: { ...cell, width: '22%' } }, t('trash.col.workspace')),
                    React.createElement('th', { key: 'd', style: { ...cell, width: '18%' } }, t('trash.col.deleted')),
                    React.createElement('th', { key: 'z', style: { ...cell, width: '10%' } }, t('trash.col.size')),
                    React.createElement('th', { key: 'a', style: { ...cell, width: '16%' } }, t('trash.col.actions')),
                  ])),
                  React.createElement('tbody', { key: 'b' }, rows),
                ]),
          ])
        }

        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: TRASH_PANEL,
          order: 20,
        }, TrashPanel)), 'session-delete: trash panel')

        ctx.effect(() => ctx.contextMenus.register({
          id: 'session.trash',
          target: 'session',
          order: 710,
          resolve: () => [{
            id: 'trash',
            label: t('menu.trash'),
            run: () => {
              try {
                ctx.layout.selectPanel(TRASH_PANEL)
              } catch (error) {
                console.warn('[session-delete] cannot open trash panel', error)
              }
            },
          }],
        }), 'session-delete: trash menu action')

        ctx.effect(() => ctx.contextMenus.register({
          id: 'session.delete',
          target: 'session',
          order: 700,
          resolve: (target) => {
            const running = isRunning(target.sessionId) === true
            const confirming = armedId === target.sessionId
            return [{
              id: 'delete',
              label: running ? t('menu.running') : confirming ? t('confirm.again') : t('menu.delete'),
              danger: true,
              separatorBefore: true,
              disabled: running,
              run: () => {
                if (running) return
                if (armedId !== target.sessionId) {
                  arm(target.sessionId)
                  toast(t('confirm.again'))
                  return
                }
                disarm()
                void remove(target.sessionId)
              },
            }]
          },
        }), 'session-delete: session menu action')
      },
    }
  },
})
