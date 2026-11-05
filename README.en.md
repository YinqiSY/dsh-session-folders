# Sidebar Session Folders

[简体中文](README.md) | English

Adds a folder layer to the DeepSeek Harness sidebar: conversations move into folders, folders fold
and reorder by dragging, and drag-in / drag-out changes membership. The **shipped session list is
never replaced** — this only decorates the official tree.

## What you get

```
会话                                  +
DSAI                    全选  ▣+  ⋯          ← new-folder button, inside the workspace row
  ⌄ MC                    4             ⋯     ← folder: folds, reorders by drag
      对话 A
  ⌄ 插件                  1             ⋯
      对话 B
  ⌄ 未分类                                    ← drop here to unfile
```

- **Workspace row**: every shipped control stays; this plugin inserts one folder-with-plus button
  right after the batch-select control. It opens an inline name field under the row.
- **Folder header**: click folds/unfolds, `⋯` renames or deletes (delete needs a second click);
  drop a conversation on it to file it; drop one folder header on another to reorder.
- **Uncategorized header**: folds like a folder and is the drop target that takes a conversation
  out of its folder.
- **Conversation rows** are untouched official rows: click, `⋯` menu, pin, archive, drag-reorder and
  other plugins' row decorations all keep working.

## How it works

No official node is ever moved:

1. each workspace group becomes a flex column, and folder headers are inserted as their own nodes;
2. official rows get a CSS `order` that places them inside their folder's band;
3. folding only sets `display:none` on the rows it owns;
4. row identity comes from the `data-row-key` the browser already stamps on each row
   (`workspace:<id>` / `session:<id>`), so no React internals are involved.

The shipped "expand the remaining N conversations" truncation is hidden and clicked once, so every
conversation is expanded by default and folders always see the full list.

One rAF-throttled reconciliation pass, driven by a `MutationObserver` scoped to the tree region,
does the work. Each pass is wrapped in try/catch: if the shipped markup ever changes shape, the
plugin does nothing and the sidebar stays exactly as shipped.

## Compatible with `deepseek-harness-zh_pro`

Verified against v0.11.1: official rows and slots stay in place, so its **archive view, batch
selection and session-deletion row cleanup** keep working.

| Surface | zh_pro | this plugin |
|---|---|---|
| Slot registrations | `conversation.input.left`, `sidebar.right.pane.tab`, `settings.section` | none |
| Locale namespaces | its own | `session-categories` |
| Patch row ids | `dsh-zh` | `session-categories` |
| CSS | hashed `*_module` classes | `dsh-scf-*`, theme tokens only |
| DOM | reads/writes official rows | inserts `[data-dsh-scf]` nodes, sets `order` / `display` |

Folder bands start at `order: 1000` rather than `0`, so a foreign node injected with the default
`order: 0` (zh_pro's archive section, for example) lands between the workspace row and the folders
instead of wedging itself between two folders.

## Where the data lives

```
<DSH_PROFILE_DIR>/data/session-categories/state.json
```

The plugin never creates, moves, renames or deletes anything inside a workspace directory, and it
never touches session logs. Deleting a folder only drops the assignments; conversations return to
未分类.

## Install

```sh
dsh plugin --profile web add github:YinqiSY/dsh-session-folders
```

Or install it as a local directory through the plugin manager (the usual development path).

## Agent access

The same operations are exposed as the `session_categories` tool (`list`, `create`, `rename`,
`delete`, `assign`, `unassign`), backed by the identical Host functions the UI calls.

## Guardrails

On the desktop build, one profile entry that fails to activate fails the whole web boot, so:

- the Host entry activates synchronously and defers only its registrations (`whenService`);
- the Client `apply` never throws, and the DOM layer reports every row-count change (including a
  drop to zero) plus any failure to `<data dir>/client.log`, which is cleared past 256 KB.

## License

MIT
