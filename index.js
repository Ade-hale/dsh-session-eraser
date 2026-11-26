/**
 * dsh-session-eraser — Host half.
 *
 * DSH keeps a session as an append-only event log on disk:
 *   $DSH_HOME/sessions/<workspace-key>/<session-id>/session.v4.jsonl.zstd
 * The shipped GUI only offers fork and archive; this plugin adds the missing
 * delete route so the session context menu can remove a session for real.
 *
 * Routes (same DSH origin):
 *   POST /session-delete/delete   { sessionId } -> { ok, moved, trash }
 *
 * Deletion moves the session directory into $DSH_HOME/session-delete-trash/
 * instead of unlinking it, so a mistaken click is recoverable from disk while
 * the session disappears from the GUI. The projection cache entry is dropped,
 * and the workspace pin/archive references are cleared through the durable
 * workspace registry (unpin/unarchive are idempotent and go through the normal
 * storage pipeline, so they are not overwritten by the storage service).
 *
 * A session whose log file is still open (a running turn) cannot be renamed on
 * Windows, so the route answers 409 and the client reports it instead of
 * deleting a live session.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const name = 'dsh-session-eraser'

const ROUTE = '/session-delete'
const TRASH_DIR = 'session-delete-trash'
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * Mirror of the session persistence backend's path-segment encoder: safe
 * characters pass through, `~` and anything outside [A-Za-z0-9._-] become a
 * `~XXXX` escape. The on-disk session directory is this encoded session id,
 * which differs from the raw id whenever the id carries an unusual prefix or
 * character. The GUI may hand us the raw id, so we try every plausible form.
 */
function encodeSegment(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

function segmentCandidates(sessionId) {
  const candidates = [sessionId, encodeSegment(sessionId)]
  // The GUI and the persistence layer disagree about the leading "session-"
  // prefix across session sources: core sessions store it, some third-party
  // sessions do not. Cover the id with and without the prefix, both raw and
  // encoded, so every spelling resolves to the on-disk directory.
  if (!sessionId.startsWith('session-')) {
    candidates.push('session-' + sessionId)
    candidates.push(encodeSegment('session-' + sessionId))
  } else {
    const stripped = sessionId.slice('session-'.length)
    candidates.push(stripped)
    candidates.push(encodeSegment(stripped))
  }
  return [...new Set(candidates)]
}

function findSessionDirs(home, sessionId) {
  const root = path.join(home, 'sessions')
  const found = []
  if (!fs.existsSync(root)) return found
  const names = segmentCandidates(sessionId)
  for (const key of fs.readdirSync(root)) {
    if (key.startsWith('.')) continue
    for (const name of names) {
      const candidate = path.join(root, key, name)
      try {
        if (fs.statSync(candidate).isDirectory() && !found.includes(candidate)) found.push(candidate)
      } catch {
        // not this workspace / name
      }
    }
  }
  return found
}

function dropProjectionCache(home, sessionId) {
  const file = path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  try {
    fs.rmSync(file, { force: true })
    return true
  } catch {
    return false
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 65536) req.destroy()
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}')
        resolve(parsed !== null && typeof parsed === 'object' ? parsed : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

export function apply(ctx) {
  ctx.inject(['webServer', 'workspaceRegistry'], (scoped) => {
    const server = scoped.webServer
    const registry = scoped.workspaceRegistry

    scoped.effect(() => server.register({
      kind: 'exact',
      path: `${ROUTE}/delete`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'method' })
          return
        }
        const body = await readBody(req)
        const sessionId = body?.sessionId
        if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
          send(res, 400, { ok: false, error: 'invalid-session-id' })
          return
        }
        const home = dshHome()
        const dirs = findSessionDirs(home, sessionId)

        // Move any on-disk session directory into the recoverable trash first,
        // so a busy (still-running) session fails here with no side effects.
        // When no directory exists the session is already gone on disk and we
        // fall through to reference cleanup only, which also clears stale rows.
        const trashRoot = path.join(home, TRASH_DIR)
        const moved = []
        if (dirs.length > 0) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          try {
            fs.mkdirSync(trashRoot, { recursive: true })
          } catch (error) {
            ctx.logger?.warn?.(`session-delete: cannot create trash dir: ${error}`)
          }
          for (const dir of dirs) {
            const workspaceKey = path.basename(path.dirname(dir))
            // Keep the real on-disk directory name in the trash so a restore
            // lands back on the original name (the raw id may drop or add the
            // leading "session-" prefix).
            const target = path.join(trashRoot, `${stamp}--${workspaceKey}--${path.basename(dir)}`)
            try {
              fs.renameSync(dir, target)
              moved.push(target)
            } catch {
              for (let i = 0; i < moved.length; i++) {
                try {
                  fs.renameSync(moved[i], dirs[i])
                } catch {
                  // best effort rollback
                }
              }
              send(res, 409, { ok: false, error: 'session-busy' })
              return
            }
          }
        }

        dropProjectionCache(home, sessionId)

        // Clear pin/archive/workspace references through the durable registry.
        // All of these are idempotent; a failure never undoes the delete.
        try {
          await registry.unpinSession(sessionId)
        } catch (error) {
          ctx.logger?.warn?.(`session-delete: unpin failed: ${error}`)
        }
        try {
          await registry.unarchiveSession(sessionId)
        } catch (error) {
          ctx.logger?.warn?.(`session-delete: unarchive failed: ${error}`)
        }
        for (const workspace of registry.list()) {
          try {
            await workspace.detachSession(sessionId)
          } catch (error) {
            ctx.logger?.warn?.(`session-delete: detach failed: ${error}`)
          }
        }

        // Tell every client to drop the session from its list immediately. The
        // official session controller broadcasts this remote event when a
        // session is disposed; emitting it here makes the sidebar update
        // without a page reload.
        try {
          ctx.emit('api-session/removed', sessionId)
        } catch (error) {
          ctx.logger?.warn?.(`session-delete: removed broadcast failed: ${error}`)
        }

        send(res, 200, { ok: true, moved: moved.length, trash: trashRoot })
      },
    }), 'session-delete: delete route')
  })
}
