/**
 * dsh-session-eraser — Client half.
 *
 * Registers a `session.delete` action on the shared session context menu
 * (`target: 'session'`). The action is disabled for the session that is
 * currently open in the main view, since deleting the log underneath a live
 * view would leave the UI pointing at nothing. Clicking Delete POSTs to the
 * Host route and then refreshes the session list.
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-eraser',
  factory(require) {
    const NS = 'dsh-session-eraser'

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

    return {
      inject: ['contextMenus', 'sessions', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: {
            'menu.delete': '删除会话',
            'menu.running': '该会话正在运行，无法删除',
            'error.busy': '该会话正在运行，请先停止再删除',
            'error.generic': '删除失败，请重试',
            'deleted': '会话已删除',
          },
          en: {
            'menu.delete': 'Delete session',
            'menu.running': 'This session is running and cannot be deleted',
            'error.busy': 'This session is running; stop it before deleting',
            'error.generic': 'Delete failed, please retry',
            'deleted': 'Session deleted',
          },
        }), 'session-delete: locale dictionary')

        const t = ctx.locale.bind(NS)

        async function remove(sessionId, isCurrent) {
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
          if (isCurrent) {
            // The deleted session was the one in the main view: reload so DSH
            // lands back on a fresh blank session instead of a dead view.
            window.location.reload()
            return
          }
          try {
            await ctx.sessions.refresh()
          } catch (error) {
            console.warn('[session-delete] session list refresh failed', error)
          }
          toast(t('deleted'))
        }

        ctx.effect(() => ctx.contextMenus.register({
          id: 'session.delete',
          target: 'session',
          order: 700,
          resolve: (target) => {
            const snapshot = ctx.sessions.list.getSnapshot()
            const rows = snapshot.byId ?? {}
            let currentId = null
            for (const row of Object.values(rows)) {
              if (((row?.retainedBy?.mainView) ?? 0) > 0) {
                currentId = row.id ?? row.sessionId ?? null
                break
              }
            }
            const row = rows[target.sessionId]
            const running = row?.running === true
            const isCurrent = currentId !== null && target.sessionId === currentId
            return [{
              id: 'delete',
              label: running ? t('menu.running') : t('menu.delete'),
              danger: true,
              separatorBefore: true,
              disabled: running,
              run: () => {
                if (!running) void remove(target.sessionId, isCurrent)
              },
            }]
          },
        }), 'session-delete: session menu action')
      },
    }
  },
})
