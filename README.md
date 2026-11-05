# Session Categories

A DeepSeek Harness plugin that groups conversations into folders **inside the sidebar**, without
taking the sidebar over.

## What you get

The shipped conversation browser keeps rendering everything — it stays the official tree, with its
search, view options, pin, session menus, drag reordering and archive handling intact. This plugin
only decorates it:

```
会话                                  +
DSAI                    全选  ▣+  ⋯          ← new-folder button sits in the workspace row
  ⌄ MC                    4             ⋯     ← folder, collapsible
      对话 A
  ⌄ 插件                  1             ⋯
      对话 B
  ⌄ 未分类                                    ← drop here to unfile
```

- **Workspace row**: the shipped row keeps its own controls; this plugin adds one folder-with-plus
  button right after the batch-select control, which opens an inline name field under the row.
- **Folder header**: our own row, inserted into the workspace group. Click folds/unfolds; `⋯` renames
  or deletes; drag a conversation onto it to file it there; drag one folder header onto another to
  reorder them.
- **未分类 header**: the drop target that takes a conversation out of its folder. It folds like a
  folder does.
- Conversations themselves are untouched official rows: they keep their click behaviour, their `⋯`
  menu, their drag-to-reorder, and every other plugin's row decorations.
- The browser caps each group at a few visible rows and hides the rest behind an "展开其余 N 个会话"
  row. That control is hidden and clicked once per render, so every conversation is expanded by
  default and folders always see the full list.

## How the grouping works

No official node is ever moved. Each workspace group is turned into a flex column, folder headers are
appended to it, and every official row gets a CSS `order` value that places it inside its folder's
band. Collapsing a folder only sets `display:none` on the rows it owns, and unfiling restores them.
Row identity comes from the `data-row-key` the browser already stamps on each row
(`workspace:<id>` / `session:<id>`), so no React internals are involved.

Everything runs through one rAF-throttled reconciliation pass driven by a `MutationObserver` that
only reacts to mutations inside the tree region. Each pass is wrapped in try/catch: if the shipped
markup ever stops looking like this, the plugin does nothing and the sidebar stays exactly as
shipped.

## Compatibility with `deepseek-harness-zh_pro` (v0.11.1)

Because the official rows and slots stay in place, zh_pro keeps every one of its features, including
the three that need the real row markup: **archive view**, **batch selection**, and **session-deletion
row cleanup**. Its row selectors (`div[class*="sessionRow"][role="treeitem"]`,
`div[role="treeitem"][aria-expanded]`) match the official rows exactly as before.

The two plugins stay disjoint where it matters:

| Surface | zh_pro | this plugin |
|---|---|---|
| Slot registrations | `conversation.input.left`, `sidebar.right.pane.tab(.title)`, `settings.section` | none |
| Locale namespaces | its own `SETTINGS_NS` | `session-categories` |
| Patch row ids | `dsh-zh` | `session-categories` |
| CSS | hashed `*_module` classes | `dsh-scf-*`, theme tokens only |
| DOM | reads/praises official rows | inserts `[data-dsh-scf]` nodes, sets `order` / `display` |

One ordering detail is deliberate: folder bands start at `order: 1000` rather than `0`, so a foreign
node injected with the default `order: 0` (zh_pro's archive section, for example) lands between the
workspace row and the folders instead of wedging itself between two folders.

## Where the data lives

```
<DSH_PROFILE_DIR>/data/session-categories/state.json
```

The plugin never creates, moves, renames, or deletes anything inside a workspace directory, and it
never touches Session logs. Deleting a folder only drops the assignments; the conversations stay
where they are and simply reappear under 未分类.

## Agent access

The same operations are exposed as the `session_categories` tool (`list`, `create`, `rename`, `delete`,
`assign`, `unassign`), backed by the identical Host functions the UI calls.

## Guardrails

A broken profile entry fails the desktop's web boot outright, so:

- the Host entry activates synchronously and defers only its registrations (`whenService`);
- the Client `apply` never throws, and the DOM layer reports its first successful pass, plus any
  failure, to `<state dir>/client.log`.
