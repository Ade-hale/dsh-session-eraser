/**
 * dsh-session-eraser — Host half.
 *
 * DSH keeps a session as an append-only event log on disk:
 *   $DSH_HOME/sessions/<workspace-key>/<session-id>/session.v4.jsonl.zstd
 * The shipped GUI only offers fork and archive; this plugin adds the missing
 * delete route so the session context menu can remove a session for real.
 *
 * Routes (same DSH origin, same-origin guard applied to every one):
 *   POST /session-delete/delete          { sessionId } | { sessionIds: [] }
 *   GET  /session-delete/trash                        -> { entries }
 *   POST /session-delete/trash/restore   { name }
 *   POST /session-delete/trash/purge     { name }
 *   POST /session-delete/trash/empty     { confirm: true }
 *
 * Deletion moves the session directory into $DSH_HOME/session-delete-trash/
 * instead of unlinking it, so a mistaken click is recoverable from disk while
 * the session disappears from the GUI. The projection cache entry is dropped,
 * and the workspace pin/archive references are cleared through the durable
 * workspace registry (unpin/unarchive are idempotent and go through the normal
 * storage pipeline, so they are not overwritten by the storage service).
 *
 * Trash entries are named `<stamp>--<workspace-key>--<dir-name>`; the workspace
 * key itself may contain dashes, so the parser is greedy in the middle and
 * anchors on the trailing directory name. Entries older than the retention
 * window (30 days by default, `DSH_SESSION_DELETE_RETENTION_DAYS`) are purged
 * permanently whenever the trash is listed or a delete runs.
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
const TRASH_NAME = /^(\d{4}-\d{2}-\d{2}T[0-9A-Za-z-]+Z)--(.+)--([^/\\]+)$/
const MAX_BATCH = 50

function retentionDays() {
  const raw = Number(process.env.DSH_SESSION_DELETE_RETENTION_DAYS)
  if (Number.isFinite(raw) && raw >= 0) return raw
  return 30
}

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

function directorySize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else {
        try {
          total += fs.statSync(full).size
        } catch {
          // unreadable file: skip it
        }
      }
    }
  }
  return total
}

/** Parse one trash directory name; returns null when it is not one of ours. */
function parseTrashName(name) {
  const match = TRASH_NAME.exec(name)
  if (!match) return null
  const [, stamp, workspaceKey, dirName] = match
  return { stamp, workspaceKey, dirName }
}

/**
 * Recover the deletion instant from the name stamp
 * (`2026-11-26T09-02-09-500Z`, produced by toISOString with `:`/`.` -> `-`).
 * The stamp is authoritative for the retention window: mtime changes when the
 * directory is copied or restored.
 */
function stampTime(stamp) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp)
  if (!match) return null
  const [, y, mo, d, h, mi, s, ms] = match
  const time = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms)
  return Number.isFinite(time) ? time : null
}

function listTrash(home) {
  const root = path.join(home, TRASH_DIR)
  let names
  try {
    names = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of names) {
    if (!entry.isDirectory()) continue
    const parsed = parseTrashName(entry.name)
    if (!parsed) continue
    const full = path.join(root, entry.name)
    let stat
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    out.push({
      name: entry.name,
      sessionDir: parsed.dirName,
      workspaceKey: parsed.workspaceKey,
      deletedAt: new Date(stampTime(parsed.stamp) ?? stat.mtime.getTime()).toISOString(),
      size: directorySize(full),
    })
  }
  out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1))
  return out
}

/**
 * Resolve a trash entry name to its directory, refusing anything that is not a
 * direct child of the trash root (a forged name must never reach rm/rename).
 */
function trashPath(home, name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('/') || name.includes('\\')) return null
  const parsed = parseTrashName(name)
  if (!parsed) return null
  const root = path.join(home, TRASH_DIR)
  const full = path.join(root, name)
  try {
    if (path.dirname(fs.realpathSync(full)) !== fs.realpathSync(root)) return null
  } catch {
    return null
  }
  return { full, ...parsed }
}

/** Permanently remove trash entries past the retention window. */
function purgeExpired(home, log) {
  const days = retentionDays()
  if (days <= 0) return 0
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  let purged = 0
  for (const entry of listTrash(home)) {
    if (Date.parse(entry.deletedAt) > cutoff) continue
    const resolved = trashPath(home, entry.name)
    if (!resolved) continue
    try {
      fs.rmSync(resolved.full, { recursive: true, force: true })
      purged++
    } catch (error) {
      log?.(`session-delete: cannot expire ${entry.name}: ${error}`)
    }
  }
  return purged
}

/**
 * Reject cross-origin calls. The route is served on the DSH origin, so a page
 * on another site can otherwise POST here and delete sessions. `Origin` is the
 * authority; `Sec-Fetch-Site` catches the browsers that omit it.
 */
function guard(req) {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return 'cross-site'
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    let host
    try {
      host = new URL(origin).host
    } catch {
      return 'bad-origin'
    }
    if (!req.headers.host || host !== req.headers.host) return 'origin-mismatch'
  } else if (req.method !== 'GET' && req.method !== 'HEAD') {
    // No Origin on a mutating call: require a JSON content type, so a plain
    // form / image / link navigation cannot reach it.
    const type = String(req.headers['content-type'] || '')
    if (!type.toLowerCase().startsWith('application/json')) return 'no-origin'
  }
  return null
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

/** Move one session id into the trash and clear its references. */
async function deleteOne(ctx, registry, home, sessionId, log) {
  const dirs = findSessionDirs(home, sessionId)
  const trashRoot = path.join(home, TRASH_DIR)
  const moved = []
  if (dirs.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    try {
      fs.mkdirSync(trashRoot, { recursive: true })
    } catch (error) {
      log(`session-delete: cannot create trash dir: ${error}`)
    }
    for (const dir of dirs) {
      const workspaceKey = path.basename(path.dirname(dir))
      // Keep the real on-disk directory name in the trash so a restore lands
      // back on the original name (the raw id may drop or add the leading
      // "session-" prefix).
      const target = path.join(trashRoot, `${stamp}--${workspaceKey}--${path.basename(dir)}`)
      try {
        fs.renameSync(dir, target)
        moved.push({ from: dir, to: target })
      } catch {
        for (let i = moved.length - 1; i >= 0; i--) {
          try {
            fs.renameSync(moved[i].to, moved[i].from)
          } catch {
            // best effort rollback
          }
        }
        return { ok: false, error: 'session-busy' }
      }
    }
  }

  dropProjectionCache(home, sessionId)

  // Clear pin/archive/workspace references through the durable registry. All
  // of these are idempotent; a failure never undoes the delete.
  try {
    await registry.unpinSession(sessionId)
  } catch (error) {
    log(`session-delete: unpin failed: ${error}`)
  }
  try {
    await registry.unarchiveSession(sessionId)
  } catch (error) {
    log(`session-delete: unarchive failed: ${error}`)
  }
  for (const workspace of registry.list()) {
    try {
      await workspace.detachSession(sessionId)
    } catch (error) {
      log(`session-delete: detach failed: ${error}`)
    }
  }

  // Tell every client to drop the session from its list immediately. The
  // official session controller broadcasts this remote event when a session is
  // disposed; emitting it here makes the sidebar update without a page reload.
  try {
    ctx.emit('api-session/removed', sessionId)
  } catch (error) {
    log(`session-delete: removed broadcast failed: ${error}`)
  }

  return { ok: true, moved: moved.length }
}

export function apply(ctx) {
  ctx.inject(['webServer', 'workspaceRegistry'], (scoped) => {
    const server = scoped.webServer
    const registry = scoped.workspaceRegistry
    const log = (message) => ctx.logger?.warn?.(message)

    scoped.effect(() => server.register({
      kind: 'exact',
      path: `${ROUTE}/delete`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'method' })
          return
        }
        const blocked = guard(req)
        if (blocked) {
          send(res, 403, { ok: false, error: blocked })
          return
        }
        const body = await readBody(req)
        const single = body?.sessionId
        const many = body?.sessionIds
        const ids = typeof single === 'string' ? [single] : Array.isArray(many) ? many.slice(0, MAX_BATCH) : null
        if (!ids || ids.length === 0 || ids.some((id) => typeof id !== 'string' || !SESSION_ID.test(id))) {
          send(res, 400, { ok: false, error: 'invalid-session-id' })
          return
        }

        const home = dshHome()
        purgeExpired(home, log)

        const results = []
        for (const sessionId of ids) {
          results.push({ sessionId, ...(await deleteOne(ctx, registry, home, sessionId, log)) })
        }
        const moved = results.reduce((sum, result) => sum + (result.moved ?? 0), 0)
        const failed = results.filter((result) => !result.ok)
        if (failed.length === 0) {
          send(res, 200, { ok: true, moved, trash: path.join(home, TRASH_DIR), results })
          return
        }
        if (failed.length === results.length && failed[0].error === 'session-busy') {
          send(res, 409, { ok: false, error: 'session-busy', results })
          return
        }
        send(res, 207, { ok: false, error: 'partial', moved, results })
      },
    }), 'session-delete: delete route')

    scoped.effect(() => server.register({
      kind: 'exact',
      path: `${ROUTE}/trash`,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          send(res, 405, { ok: false, error: 'method' })
          return
        }
        const blocked = guard(req)
        if (blocked) {
          send(res, 403, { ok: false, error: blocked })
          return
        }
        const home = dshHome()
        const purged = purgeExpired(home, log)
        send(res, 200, {
          ok: true,
          entries: listTrash(home),
          retentionDays: retentionDays(),
          purged,
          trash: path.join(home, TRASH_DIR),
        })
      },
    }), 'session-delete: trash list route')

    scoped.effect(() => server.register({
      kind: 'exact',
      path: `${ROUTE}/trash/restore`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'method' })
          return
        }
        const blocked = guard(req)
        if (blocked) {
          send(res, 403, { ok: false, error: blocked })
          return
        }
        const body = await readBody(req)
        const home = dshHome()
        const target = trashPath(home, body?.name)
        if (!target) {
          send(res, 400, { ok: false, error: 'invalid-entry' })
          return
        }
        const destination = path.join(home, 'sessions', target.workspaceKey, target.dirName)
        if (fs.existsSync(destination)) {
          // Never overwrite a live session directory with a restored copy.
          send(res, 409, { ok: false, error: 'already-exists' })
          return
        }
        try {
          fs.mkdirSync(path.dirname(destination), { recursive: true })
          fs.renameSync(target.full, destination)
        } catch (error) {
          send(res, 500, { ok: false, error: 'restore-failed', detail: String(error) })
          return
        }
        try {
          ctx.emit('api-session/added', target.dirName)
        } catch {
          // the client refreshes the list anyway
        }
        send(res, 200, { ok: true, restored: target.dirName, workspaceKey: target.workspaceKey })
      },
    }), 'session-delete: trash restore route')

    scoped.effect(() => server.register({
      kind: 'exact',
      path: `${ROUTE}/trash/purge`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'method' })
          return
        }
        const blocked = guard(req)
        if (blocked) {
          send(res, 403, { ok: false, error: blocked })
          return
        }
        const body = await readBody(req)
        const home = dshHome()
        const target = trashPath(home, body?.name)
        if (!target) {
          send(res, 400, { ok: false, error: 'invalid-entry' })
          return
        }
        try {
          fs.rmSync(target.full, { recursive: true, force: true })
        } catch (error) {
          send(res, 500, { ok: false, error: 'purge-failed', detail: String(error) })
          return
        }
        send(res, 200, { ok: true, purged: target.dirName })
      },
    }), 'session-delete: trash purge route')

    scoped.effect(() => server.register({
      kind: 'exact',
      path: `${ROUTE}/trash/empty`,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'method' })
          return
        }
        const blocked = guard(req)
        if (blocked) {
          send(res, 403, { ok: false, error: blocked })
          return
        }
        const body = await readBody(req)
        if (body?.confirm !== true) {
          send(res, 400, { ok: false, error: 'confirm-required' })
          return
        }
        const home = dshHome()
        let purged = 0
        for (const entry of listTrash(home)) {
          const resolved = trashPath(home, entry.name)
          if (!resolved) continue
          try {
            fs.rmSync(resolved.full, { recursive: true, force: true })
            purged++
          } catch (error) {
            log(`session-delete: cannot purge ${entry.name}: ${error}`)
          }
        }
        send(res, 200, { ok: true, purged })
      },
    }), 'session-delete: trash empty route')
  })
}
