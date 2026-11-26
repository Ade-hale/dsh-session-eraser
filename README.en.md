<p align="center"><img src="./icon.svg" width="72" alt="dsh-session-eraser icon: a red trash can" /></p>

# dsh-session-eraser

**Delete should mean delete — and a misclick shouldn't mean disaster.**

删除应该是真的删除，但误删不该变成事故。

DeepSeek Harness plugin · Web GUI · Requires DSH ≥ 0.2.2-rc.5 · MIT

[简体中文](./README.md) · **English**

DeepSeek Harness (DSH) sessions can be forked and archived, but never deleted: they pile up, and there is no way to actually remove one. This plugin adds the missing **Delete session** action to the session context menu. The session directory leaves the disk, its workspace, pin, and archive references are cleared in the same pass, and the sidebar updates immediately — but the directory is not unlinked. It is moved into a trash directory, so a mistaken click is recoverable from disk.

> Right-click a session in the sidebar → choose the red **Delete session**
>
> The session disappears from the list at once, with a "Session deleted" toast.

**It deletes thoroughly, but keeps one safety net: the trash directory.**

> **Current version: v0.1.0** — two halves: a host half (`index.js`) registering the delete route, and a client half (`client.js`) registering the context-menu action. There is no confirmation dialog; a session that is still running is refused. Web GUI only.

## Features & Current Status

| Step | What it does | Status |
| --- | --- | --- |
| **Menu entry** | Adds a red, separator-prefixed **Delete session** entry to the session context menu, after Archive | On a running session the entry is disabled and reads "This session is running and cannot be deleted" |
| **Move to trash** | Moves the session directory into `$DSH_HOME/session-delete-trash/` instead of unlinking it | The trashed name keeps a timestamp, the workspace key, and the original directory name, so restores are easy to match |
| **Clear references** | Drops the projection cache entry, the workspace `sessionIds` membership, and the pin / archive references (through the durable workspace registry) | Each cleanup step is independent; one failing never undoes the delete, it only logs |
| **Instant refresh** | Broadcasts the official `api-session/removed` event | Sidebar and workspace view update immediately, no page reload |
| **Running protection** | A running session's log file is held open, so the delete answers `409` and tells you to stop it first | If any move fails, already-moved directories are rolled back on a best-effort basis — never a half delete |
| **Deleting the open session** | Deleting the session currently shown in the main view reloads the page | You land on a fresh blank session instead of a dead view |

### What happens on delete

1. The client sends the `sessionId` to the host route `POST /session-delete/delete`; the host validates the id format first.
2. The host locates the session's on-disk directory across every workspace key — trying the raw id, with and without the `session-` prefix, and the path-encoded spelling, so id format differences don't hide it.
3. Found directories are moved into the trash one by one; if any move fails, the ones already moved are rolled back and the route answers `409`, with no side effects.
4. The projection cache is dropped, and the workspace registry unpins, unarchives, and detaches the session from every workspace.
5. Finally, `api-session/removed` is broadcast and every client drops the session from its list immediately.

## Installation

```sh
dsh plugin --profile <name> add dsh-session-eraser
```

You can also install from a local directory or a git URL. After installing, refresh the web GUI (Ctrl+R) so the client bundle loads.

## Usage

1. Right-click a session in the sidebar (or open its "…" menu).
2. Choose **Delete session**.
3. The session disappears from the list and a confirmation toast appears.

### Recovering a deleted session

Deleting is not erasing: the session directory sits in the trash under a name like `<timestamp>--<workspace-key>--<original-directory-name>`. Move the whole directory back to restore it:

```sh
mv "$DSH_HOME/session-delete-trash/<timestamp>--<workspace-key>--<original-directory-name>" \
   "$DSH_HOME/sessions/<workspace-key>/<original-directory-name>"
```

Refresh the GUI afterwards and the session reappears in the list. The trash directory is never cleaned automatically; delete its contents yourself once you are sure they are no longer needed.

## Boundaries & Limitations

- **No confirmation dialog.** A deliberate trade-off: safety comes from the trash directory, not from an interrupting prompt. If you are worried about misclicks, learn where the trash directory is first.
- **Running sessions cannot be deleted.** While the log file is held open the delete is refused (`409`) — stop the session first. This is especially visible on Windows.
- **Only its own scope is cleaned.** The disk log, workspace membership, and pin/archive references are covered. Indexes kept by third-party plugins (e.g. context insight or memory systems) may retain their own references and must be cleaned in those plugins.
- **Web GUI only.** The client relies on the web context menu and session controller; other platforms are not covered.
- **The trash only fills up.** The plugin never expires or empties the trash directory automatically — clean it by hand from time to time.

## What's Next

Ideas only — not scheduled yet. Priority feedback in issues is welcome:

| Direction | Notes |
| --- | --- |
| **Trash management UI** | List deleted sessions in the GUI, restore with one click, bulk-clean by age |
| **Optional confirmation** | A switch for users who want a dialog; direct delete stays the default |
| **Bulk delete** | Select several sessions and clean them up in one pass |

## Contributing

Issues and pull requests about delete boundaries, the recovery flow, and session-id compatibility across session sources are welcome via [Issues](https://github.com/Ade-hale/dsh-session-eraser/issues). When reporting a problem, please include your DSH version, your OS, and whether the session was running or stopped — delete behaviour differs a lot between those cases.

## License

Released under the [MIT License](./LICENSE).
