# dsh-session-eraser

Add a **Delete session** action to the DeepSeek Harness (DSH) web GUI session context menu. DSH ships only fork and archive for sessions; this plugin adds the missing delete so a session can actually be removed.

## Features

- Adds a red, separator-prefixed **Delete session** entry to the right-click menu of a session, after **Archive session**.
- Deleting moves the session directory into `$DSH_HOME/session-delete-trash/` instead of unlinking it, so a mistaken click is recoverable from disk.
- Clears derived state in one pass: the projection cache entry, the workspace `sessionIds` membership, and the pin / archive references (through the durable workspace registry).
- Broadcasts the official `api-session/removed` event so the sidebar and workspace view update immediately, without a page reload.
- A session that is still running is refused (`409`) and reported, since its log file is held open.
- Deleting the session currently open in the main view returns the app to a fresh blank session.
- No confirmation dialog — click to delete, recover from the trash directory if needed.

## Install

```sh
dsh plugin --profile <name> add dsh-session-eraser
```

Or install the local directory / a git URL. After install, refresh the web GUI (Ctrl+R) so the client bundle loads.

## Use

1. Right-click a session in the sidebar (or open its “…” menu).
2. Choose **Delete session**.
3. The session disappears from the list; a toast confirms it.

Recover a deleted session by moving its directory from `$DSH_HOME/session-delete-trash/` back to `$DSH_HOME/sessions/<workspace-key>/<session-id>/`.

## How it works

- **Host half** (`index.js`) registers `POST /session-delete/delete { sessionId }`. It locates the session directory across every workspace key (trying the raw, `session-`-prefixed, and path-encoded spellings of the id), moves it into the trash, drops the projection cache, detaches the session from its workspace, unpins and unarchives it, and emits `api-session/removed`.
- **Client half** (`client.js`) registers a `session.delete` action on the shared `session` context menu and calls the route; it disables the entry while the session is running.

## Limitations

- Only the disk log, workspace membership and pin/archive references are cleaned. Indexes kept by third-party plugins (e.g. context insight or memory systems) may retain their own references and must be cleaned in those plugins.
- A running session cannot be deleted until its work stops.

## License

MIT
