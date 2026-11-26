// Route-level harness: mounts index.js's apply() with a stub ctx and exercises
// every route against a throwaway $DSH_HOME, so the host half is verified
// without installing the plugin.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eraser-home-'))
process.env.DSH_HOME = home

const wsKey = '--C-Users-x-default-workspace--'
const sessionDir = 'session-abc-123'
fs.mkdirSync(path.join(home, 'sessions', wsKey, sessionDir), { recursive: true })
fs.writeFileSync(path.join(home, 'sessions', wsKey, sessionDir, 'session.v4.jsonl.zstd'), 'log')
fs.mkdirSync(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
fs.writeFileSync(path.join(home, 'storages', 'session_projcache', 'sessions', 'abc-123.json'), '{}')

// a second, decoy session that must survive
fs.mkdirSync(path.join(home, 'sessions', wsKey, 'session-keep-me'), { recursive: true })
fs.writeFileSync(path.join(home, 'sessions', wsKey, 'session-keep-me', 'session.v4.jsonl.zstd'), 'x')

const routes = new Map()
const events = []
const ctx = {
  logger: { warn: () => {} },
  emit: (name, arg) => events.push([name, arg]),
  inject: (_deps, cb) => cb({
    webServer,
    workspaceRegistry: registry,
    logger: ctx.logger,
    effect: (fn) => { fn(); return () => {} },
  }),
  effect: (fn) => { fn(); return () => {} },
}
const webServer = { register: (route) => { routes.set(route.path, route.handler); return () => {} } }
const calls = []
const registry = {
  unpinSession: async (id) => calls.push(['unpin', id]),
  unarchiveSession: async (id) => calls.push(['unarchive', id]),
  list: () => [{ detachSession: async (id) => calls.push(['detach', id]) }],
}

const { apply } = await import('../index.js')
apply(ctx)

function req(method, headers = {}, body = null) {
  const emitter = new EventEmitter()
  emitter.method = method
  emitter.headers = headers
  if (body !== null) {
    emitter.on('end', () => {})
    process.nextTick(() => { emitter.emit('data', JSON.stringify(body)); emitter.emit('end') })
  } else process.nextTick(() => emitter.emit('end'))
  return emitter
}

function res() {
  const out = { status: 0, body: null }
  return {
    out,
    writeHead: (status) => { out.status = status },
    end: (text) => { out.body = JSON.parse(text) },
  }
}

const same = { host: '127.0.0.1:55330', origin: 'http://127.0.0.1:55330', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
const cross = { host: '127.0.0.1:55330', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }

async function hit(routePath, method, headers, body) {
  const r = res()
  await routes.get(routePath)(req(method, headers, body), r)
  return r.out
}

const fails = []
const check = (label, cond, extra) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  ' + JSON.stringify(extra)}`)
  if (!cond) fails.push(label)
}

// 1. cross-site delete must be refused and must not touch disk
let out = await hit('/session-delete/delete', 'POST', cross, { sessionId: 'abc-123' })
check('cross-origin delete blocked with 403', out.status === 403 && out.body.error === 'cross-site', out)
check('cross-origin delete left the session on disk', fs.existsSync(path.join(home, 'sessions', wsKey, sessionDir)))

// 2. no-origin non-json POST refused
out = await hit('/session-delete/delete', 'POST', { host: '127.0.0.1:55330' }, { sessionId: 'abc-123' })
check('no-origin POST without json content-type blocked', out.status === 403 && out.body.error === 'no-origin', out)

// 3. bad id rejected
out = await hit('/session-delete/delete', 'POST', same, { sessionId: '../etc/passwd' })
check('path-traversal session id rejected', out.status === 400 && out.body.error === 'invalid-session-id', out)

// 4. delete the raw id (with and without the session- prefix both resolve)
out = await hit('/session-delete/delete', 'POST', same, { sessionId: 'abc-123' })
check('delete by bare id returns 200 ok', out.status === 200 && out.body.ok === true && out.body.moved === 1, out)
check('session directory moved out of sessions/', !fs.existsSync(path.join(home, 'sessions', wsKey, sessionDir)))
check('projection cache dropped', !fs.existsSync(path.join(home, 'storages', 'session_projcache', 'sessions', 'abc-123.json')))
check('decoy session untouched', fs.existsSync(path.join(home, 'sessions', wsKey, 'session-keep-me')))
check('registry unpin/unarchive/detach called', calls.length === 3, calls)
check('api-session/removed emitted', events.some(([n]) => n === 'api-session/removed'), events)

// 5. list trash
out = await hit('/session-delete/trash', 'GET', { host: '127.0.0.1:55330', 'sec-fetch-site': 'same-origin' })
check('trash lists one entry with metadata', out.status === 200 && out.body.entries.length === 1 && out.body.retentionDays === 30, out)
check('trash entry keeps workspace key', out.body.entries[0].workspaceKey === wsKey, out.body.entries[0])
check('trash entry keeps original directory name', out.body.entries[0].sessionDir === sessionDir, out.body.entries[0])
const entryName = out.body.entries[0].name

// 6. forged entry names are refused
out = await hit('/session-delete/trash/purge', 'POST', same, { name: '../../sessions' })
check('forged trash name rejected', out.status === 400 && out.body.error === 'invalid-entry', out)

// 7. restore
out = await hit('/session-delete/trash/restore', 'POST', same, { name: entryName })
check('restore returns 200', out.status === 200 && out.body.ok === true, out)
check('session directory back in its workspace', fs.existsSync(path.join(home, 'sessions', wsKey, sessionDir)))
out = await hit('/session-delete/trash', 'GET', { host: '127.0.0.1:55330', 'sec-fetch-site': 'same-origin' })
check('trash empty after restore', out.body.entries.length === 0, out)

// 8. restore refuses to overwrite a live session
out = await hit('/session-delete/delete', 'POST', same, { sessionIds: ['abc-123', 'keep-me'] })
check('batch delete reports per-entry results', out.status === 200 && out.body.moved === 2, out)
const trashAfter = await hit('/session-delete/trash', 'GET', { host: '127.0.0.1:55330', 'sec-fetch-site': 'same-origin' })
const entry2 = trashAfter.body.entries.find((e) => e.sessionDir === sessionDir)
fs.mkdirSync(path.join(home, 'sessions', wsKey, sessionDir), { recursive: true })
out = await hit('/session-delete/trash/restore', 'POST', same, { name: entry2.name })
check('restore over an existing directory refused with 409', out.status === 409 && out.body.error === 'already-exists', out)
fs.rmSync(path.join(home, 'sessions', wsKey, sessionDir), { recursive: true, force: true })

// 9. empty requires confirm:true
out = await hit('/session-delete/trash/empty', 'POST', same, {})
check('empty without confirm rejected', out.status === 400 && out.body.error === 'confirm-required', out)
out = await hit('/session-delete/trash/empty', 'POST', same, { confirm: true })
check('empty with confirm purges entries', out.status === 200 && out.body.purged === 2, out)

// 10. retention purge removes only expired entries
const trashRoot = path.join(home, 'session-delete-trash')
const oldName = '2020-01-01T00-00-00-000Z--' + wsKey + '--session-old'
fs.mkdirSync(path.join(trashRoot, oldName), { recursive: true })
out = await hit('/session-delete/delete', 'POST', same, { sessionId: 'keep-me' })
check('retention purged the 2020 entry', out.status === 200 && !fs.existsSync(path.join(trashRoot, oldName)), out)

// 11. method guards
out = await hit('/session-delete/delete', 'GET', same, null)
check('GET on delete route returns 405', out.status === 405, out)

fs.rmSync(home, { recursive: true, force: true })
console.log(fails.length === 0 ? '\nALL PASS' : `\n${fails.length} FAILED: ${fails.join(', ')}`)
process.exit(fails.length === 0 ? 0 : 1)
