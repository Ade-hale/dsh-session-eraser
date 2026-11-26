<p align="center"><img src="./icon.svg" width="72" alt="dsh-session-eraser icon: a red trash can" /></p>

# dsh-session-eraser

**Delete should mean delete — and a misclick shouldn't mean disaster.**

删除应该是真的删除，但误删不该变成事故。

A DeepSeek Harness plugin · Web GUI · requires DSH ≥ 0.2.2-rc.5 · MIT

[简体中文](./README.md) · **English**

DeepSeek Harness (DSH) sessions can be forked and archived, but never deleted: they pile up, and there is no way to actually remove one. This plugin adds the missing **Delete session** action to the session context menu. The session directory leaves the disk, its workspace, pin, and archive references are cleared in the same pass, and the sidebar updates immediately — but the directory is not unlinked. It is moved into a trash directory, and a trash panel you can open, restore from, and that expires old entries keeps the safety net usable.

> Right-click a session in the sidebar → choose the red **Delete session** → click it once more to confirm
>
> The session disappears from the list at once, with a "Session deleted" toast. To get one back: **Trash** in the same menu.

**It deletes thoroughly, but keeps one safety net: the trash.**

> **Current version: v0.2.0** — two halves: a host half (`index.js`) registering the delete and trash routes, and a client half (`client.js`) registering the context-menu actions and the trash panel. Deleting is two-step (the first click only arms the action and auto-cancels after four seconds); a session that is still running is refused. Web GUI only.

## Features & Current Status

| Step | What it does | Status |
| --- | --- | --- |
| **Menu entry** | Adds a red, separator-prefixed **Delete session** entry to the session context menu, after Archive | On a running session the entry is disabled and reads "This session is running and cannot be deleted" |
| **Two-step confirm** | The first click only arms the action and the menu reads "Click Delete session again to confirm"; it reverts after four seconds | No dialog interrupting the flow, but a single stray click deletes nothing |
| **Move to trash** | Moves the session directory into `$DSH_HOME/session-delete-trash/` instead of unlinking it | The trashed name keeps a timestamp, the workspace key, and the original directory name, so restores are easy to match |
| **Trash panel** | **Trash** in the same menu opens a panel: session directory, source workspace, deletion time, size | Restore one entry to its original workspace, delete one forever, or empty the whole trash after a second click |
| **Retention** | Entries past the retention window (30 days by default, tunable with `DSH_SESSION_DELETE_RETENTION_DAYS`) are purged permanently | Purged whenever the trash is listed or a delete runs; nothing runs in the background |
| **Batch deletes** | `POST /session-delete/delete` accepts `sessionIds` (up to 50) as well as a single `sessionId` | Per-entry results: `200` when all succeed, `409` when all are busy, `207` on a partial |
| **Clear references** | Drops the projection cache entry, the workspace `sessionIds` membership, and the pin / archive references (through the durable workspace registry) | Each cleanup step is independent; one failing never undoes the delete, it only logs |
| **Instant refresh** | Broadcasts the official `api-session/removed` event | Sidebar and workspace view update immediately, no page reload |
| **Running protection** | A running session's log file is held open, so the delete answers `409` and tells you to stop it first | If any move fails, already-moved directories are rolled back on a best-effort basis — never a half delete |
| **Same-origin guard** | Every route checks `Origin`/`Host` and `Sec-Fetch-Site`, and rejects non-JSON writes with no Origin | A page on another site cannot delete your sessions with a cross-site request |
| **Restore never overwrites** | If the target directory already exists, restore answers `409` instead of replacing it | Two logs never contaminate each other |
| **Deleting the open session** | Deleting the session currently shown in the main view reloads the page | You land on a fresh blank session instead of a dead view |

### What happens on delete

1. The client sends the `sessionId` (or a `sessionIds` array) to the host route `POST /session-delete/delete`; the host checks the request origin, then the id format.
2. The host locates the session's on-disk directory across every workspace key — trying the raw id, with and without the `session-` prefix, and the path-encoded spelling, so id format differences don't hide it.
3. Found directories are moved into the trash one by one; if any move fails, the ones already moved are rolled back and the route answers `409`, with no side effects.
4. The projection cache is dropped, and the workspace registry unpins, unarchives, and detaches the session from every workspace.
5. Finally, `api-session/removed` is broadcast and every client drops the session from its list immediately.

### What the trash exposes

| Route | Method | Purpose |
| --- | --- | --- |
| `/session-delete/trash` | GET | List entries (directory, workspace, deletion time, size), retention days, and how many expired this run |
| `/session-delete/trash/restore` | POST | Move an entry back to `sessions/<workspace-key>/<original-directory-name>`; `409` if the target exists |
| `/session-delete/trash/purge` | POST | Delete one entry permanently |
| `/session-delete/trash/empty` | POST | Empty the trash (requires `{ "confirm": true }`) |

An entry name looks like `<stamp>--<workspace-key>--<original-directory-name>`; the workspace key itself contains `--`, so the parser is greedy in the middle and anchors on the trailing directory name. Every entry name is validated as a direct child of the trash root before it is used.

## Install

```sh
dsh plugin --profile <name> add dsh-session-eraser
```

Or install the local directory / a git URL. After install, refresh the web GUI (Ctrl+R) so the client bundle loads.

## Use

1. Right-click a session in the sidebar (or open its “…” menu).
2. Choose **Delete session**; the menu then reads "Click Delete session again to confirm" — click it again within four seconds to delete.
3. The session disappears from the list, with a toast.
4. To restore: choose **Trash** in the same menu and press **Restore**; the session returns to its original workspace.

### Restoring without the GUI

The trash name is `<stamp>--<workspace-key>--<original-directory-name>`, so moving the directory back also works:

```sh
mv "$DSH_HOME/session-delete-trash/<stamp>--<workspace-key>--<name>" \
   "$DSH_HOME/sessions/<workspace-key>/<name>"
```

Refresh the GUI afterwards and the session reappears in the list.

## Limitations

- **Two-step, not a dialog.** The first click arms the action and it cancels itself after four seconds: no interruption, but a single misclick destroys nothing.
- **A running session cannot be deleted.** While its log file is held open the route answers `409`; stop it first. This is especially visible on Windows.
- **Sub-agent child sessions are not cascaded.** The session log is a compressed append-only file, and neither it nor the projection cache records parent → child links, so children must be deleted individually from their own list.
- **Only its own scope is cleaned.** The disk log, workspace membership, pin/archive references and projection cache are cleared; indexes kept by third-party plugins (context insight, memory systems) may retain their own references and must be cleaned there.
- **Files the session produced are untouched.** Only the session log directory moves to the trash.
- **Web GUI only.** The client relies on the Web context menu, slots and layout services; other surfaces are not covered.

## Next steps

Ideas, not scheduled — discuss priorities in an issue:

| Direction | Notes |
| --- | --- |
| **Cascade the sub-agent tree** | Once the log or projection exposes usable parent/child pointers, deleting a parent can clean up its sub-agent sessions too |
| **Produced-file listing** | Before deleting, list the files the session wrote inside the workspace and let the user choose whether to clean them too |
| **Undo window** | A short undo after deleting that moves the entry back out of the trash |
| **Search and preview** | Search the trash by title and preview a conversation before restoring or purging |
| **Agent tool** | Expose a tool so an agent can list and clean the trash itself |

## Development

```sh
npm test   # mounts apply() with a stub ctx and exercises every route against a temp $DSH_HOME
```

Issues and pull requests about delete boundaries, the restore flow, or id compatibility across session sources are welcome — see [Issues](https://github.com/Ade-hale/dsh-session-eraser/issues). When reporting a problem, include the DSH version, your OS, and whether the session was running or stopped; the delete path differs a lot between those cases.

## License

[MIT License](./LICENSE).
