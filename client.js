/**
 * Client half of the Session Categories bundle 鈥?DOM-bound edition.
 *
 * This plugin no longer occupies `sidebar.workspaces`. The shipped browser stays exactly as it
 * ships: it renders every workspace group and every conversation row, and it keeps owning its own
 * React tree. This module only decorates that tree from the outside:
 *
 *   - each workspace group becomes a flex column, and folder headers are inserted into it;
 *   - official conversation rows are repositioned with CSS `order`, never moved in the DOM, so
 *     React's reconciliation and every other plugin's row selectors keep working;
 *   - collapsing a folder only sets `display:none` on the rows it owns.
 *
 * Every pass is wrapped in try/catch and the layer is purely additive: if the shipped markup ever
 * stops looking like this, the plugin does nothing and the official sidebar is untouched.
 *
 * @module @local/session-categories/client
 */

window.__ModuleLoader__.load({
  id: '@local/session-categories',
  factory(require) {
    const API = '/dsh-session-categories'
    const NS = 'session-categories'
    const OWN = 'data-dsh-scf'

    const EN = {
      uncategorized: 'Uncategorized',
      newFolder: 'New folder',
      renameFolder: 'Rename folder',
      deleteFolder: 'Delete folder',
      confirm: 'Confirm',
      failed: 'Failed:',
      more: 'More actions',
      dragToReorder: 'Drag to reorder folders',
    }

    const ZH = {
      uncategorized: '未分类',
      newFolder: '新建分类',
      renameFolder: '重命名分类',
      deleteFolder: '删除分类',
      confirm: '确认删除',
      failed: '操作失败：',
      more: '更多操作',
      dragToReorder: '拖动可调整分类顺序',
    }

    const CSS = `
.dsh-scf-group { display:flex !important; flex-direction:column; }
.dsh-scf-head { position:relative; box-sizing:border-box; display:flex; align-items:center;
  height:32px; margin-top:2px; padding:0 8px 0 18px; border-radius:var(--dsw-radius-md,8px);
  color:var(--dsw-alias-label-secondary); font-size:13px; line-height:20px; cursor:pointer;
  user-select:none; }
.dsh-scf-head:hover { background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2)); }
.dsh-scf-head[data-drop="true"] { background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));
  box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary); }
.dsh-scf-chevron { display:inline-flex; align-items:center; justify-content:center; width:16px; height:20px;
  margin-right:4px; flex:none; color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary)); }
.dsh-scf-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-scf-count { font-size:12px; color:var(--dsw-alias-label-tertiary); font-variant-numeric:tabular-nums;
  margin-left:6px; flex:none; }
.dsh-scf-actions { display:flex; align-items:center; gap:2px; flex:none; margin-left:auto; opacity:0; }
.dsh-scf-head:hover .dsh-scf-actions { opacity:1; }
.dsh-scf-btn { border:none; background:transparent; color:var(--dsw-alias-label-tertiary); cursor:pointer;
  padding:0; border-radius:var(--dsw-radius-xs,4px); display:inline-flex; align-items:center;
  justify-content:center; width:16px; height:16px; flex:none; }
.dsh-scf-btn:hover { color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2)); }
.dsh-scf-addbtn { display:inline-flex; align-items:center; justify-content:center; flex:none;
  width:16px; height:16px; padding:0; margin:0 2px; border:none; background:transparent;
  color:var(--dsw-alias-label-tertiary); border-radius:var(--dsw-radius-xs,4px); cursor:pointer; }
.dsh-scf-addbtn:hover { color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2)); }
.dsh-scf-create { height:30px; padding-left:30px; }
.dsh-scf-input { box-sizing:border-box; flex:1; min-width:0; height:24px; padding:0 8px; font:inherit;
  font-size:13px; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base);
  border:0.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l1));
  border-radius:var(--dsw-radius-sm,6px); outline:none; }
.dsh-scf-input:focus { border-color:var(--dsw-alias-brand-primary); }
.dsh-scf-pop { position:absolute; top:calc(100% - 2px); right:8px; z-index:40; min-width:150px; padding:4px;
  border-radius:var(--dsw-radius-md,8px); background:var(--dsw-alias-bg-overlay);
  border:0.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l2));
  box-shadow:0 8px 24px rgba(0,0,0,0.18); }
.dsh-scf-pop button { display:block; width:100%; text-align:left; border:none; background:transparent;
  color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; line-height:20px;
  padding:6px 10px; border-radius:var(--dsw-radius-sm,6px); cursor:pointer; }
.dsh-scf-pop button:hover { background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2)); }
.dsh-scf-pop button[data-danger="true"]:hover { color:var(--dsw-alias-state-error-primary); }
.dsh-scf-err { color:var(--dsw-alias-state-error-primary); font-size:12px; padding:4px 8px; }
`

    // ---------------------------------------------------------------------------------------
    // Host channel
    // ---------------------------------------------------------------------------------------

    function createStore(report) {
      let snapshot = { phase: 'loading', workspaces: [] }
      const listeners = new Set()
      let inflight = null

      const publish = (next) => {
        snapshot = { ...snapshot, ...next }
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch {
            // One broken listener must not stop the rest.
          }
        }
      }

      const refresh = () => {
        if (inflight) return inflight
        inflight = (async () => {
          try {
            const response = await fetch(API + '/state', { headers: { accept: 'application/json' } })
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const data = await response.json()
            publish({ phase: 'ready', workspaces: Array.isArray(data.workspaces) ? data.workspaces : [] })
          } catch (error) {
            publish({ phase: 'error', workspaces: [] })
            report('state fetch failed: ' + String((error && error.message) || error))
          } finally {
            inflight = null
          }
        })()
        return inflight
      }

      const operate = async (payload) => {
        const response = await fetch(API + '/op', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        let data = null
        try {
          data = await response.json()
        } catch {
          data = null
        }
        if (!response.ok || !data || data.ok !== true) {
          throw new Error((data && data.error) || ('HTTP ' + response.status))
        }
        if (data.model) {
          publish({ phase: 'ready', workspaces: Array.isArray(data.model.workspaces) ? data.model.workspaces : [] })
        } else {
          await refresh()
        }
      }

      return {
        get: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        refresh,
        operate,
      }
    }

    // ---------------------------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------------------------

    const ICON_ATTRS = {
      viewBox: '0 0 16 16',
      width: '16',
      height: '16',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
    }

    function icon(children, extra) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      for (const [key, value] of Object.entries({ ...ICON_ATTRS, ...(extra || {}) })) {
        svg.setAttribute(key, String(value))
      }
      for (const child of children) {
        const node = document.createElementNS('http://www.w3.org/2000/svg', child.tag)
        for (const [key, value] of Object.entries(child.attrs)) node.setAttribute(key, String(value))
        svg.appendChild(node)
      }
      return svg
    }

    const chevronIcon = (open) => icon(
      [{
        tag: 'path',
        attrs: {
          d: 'M6 3.5 10.5 8 6 12.5',
          stroke: 'currentColor',
          'stroke-width': '1.4',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        },
      }],
      open ? { style: 'transform:rotate(90deg)' } : {},
    )

    const moreIcon = () => icon([
      { tag: 'circle', attrs: { cx: '3.4', cy: '8', r: '1.15', fill: 'currentColor' } },
      { tag: 'circle', attrs: { cx: '8', cy: '8', r: '1.15', fill: 'currentColor' } },
      { tag: 'circle', attrs: { cx: '12.6', cy: '8', r: '1.15', fill: 'currentColor' } },
    ])

    /** Folder with a plus: the "new folder" affordance that sits in the workspace row. */
    const folderPlusIcon = () => icon([
      {
        tag: 'path',
        attrs: {
          d: 'M2 4.6A1.6 1.6 0 0 1 3.6 3h2.9l1.4 1.5h4.5A1.6 1.6 0 0 1 14 6.1v2.4',
          stroke: 'currentColor',
          'stroke-width': '1.3',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        },
      },
      {
        tag: 'path',
        attrs: {
          d: 'M2 4.6v6.8A1.6 1.6 0 0 0 3.6 13h4.6',
          stroke: 'currentColor',
          'stroke-width': '1.3',
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        },
      },
      {
        tag: 'path',
        attrs: {
          d: 'M11.4 9.2v3.6M9.6 11h3.6',
          stroke: 'currentColor',
          'stroke-width': '1.3',
          'stroke-linecap': 'round',
        },
      },
    ])

    // ---------------------------------------------------------------------------------------
    // Official DOM adapters
    // ---------------------------------------------------------------------------------------

    const KEY = 'data-row-key'

    /**
     * Read a row's shipped identifier. The browser stamps `data-row-key` on the row element
     * (`workspace:<id>` or `session:<id>`), which is far more stable than reaching into React state.
     * @param node - one direct child of a workspace group.
     * @returns the key, or an empty string.
     */
    function keyOf(node) {
      if (!node || node.nodeType !== 1) return ''
      const own = node.getAttribute(KEY)
      if (own) return own
      const inner = node.querySelector('[' + KEY + ']')
      return inner ? inner.getAttribute(KEY) || '' : ''
    }

    const idFromKey = (key, prefix) => (key && key.indexOf(prefix) === 0 ? key.slice(prefix.length) : null)

    const treeOf = () => document.querySelector('div[data-slot="sidebar.workspaces"] [role="tree"]')

    const groupsOf = (tree) => Array.from(tree.children).filter(node =>
      node.nodeType === 1
      && !node.hasAttribute(OWN)
      && typeof node.className === 'string'
      && node.className.indexOf('groupSection') >= 0)

    /**
     * Describe one group's conversation rows. The shipped browser wraps each row in a component
     * root span, so the flex items that must be reordered are those wrappers; the identifiers live
     * on the inner row element.
     * @param group - one `div.groupSection`.
     * @returns `{ wrap, sessionId }` entries in DOM order.
     */
    function entriesOf(group) {
      const entries = []
      for (const wrap of Array.from(group.children)) {
        if (wrap.nodeType !== 1 || wrap.hasAttribute(OWN)) continue
        if (wrap.getAttribute('role') === 'group') continue
        const sessionId = idFromKey(keyOf(wrap), 'session:')
        if (sessionId) entries.push({ wrap, sessionId })
      }
      return entries
    }

    /** The Workspace id a group belongs to, read from its project row. */
    function workspaceKeyOf(group) {
      const node = group.querySelector('[data-row-key^="workspace:"]')
      return node ? idFromKey(node.getAttribute(KEY), 'workspace:') : null
    }

    // ---------------------------------------------------------------------------------------
    // The layer
    // ---------------------------------------------------------------------------------------

    /**
     * Install the DOM layer inside one effect scope.
     * @param ctx - client context supplying the effect scope and the locale service.
     * @param report - diagnostic sink.
     */
    function install(ctx, report) {
      const store = createStore(report)
      let t = key => ZH[key] || EN[key] || key
      try {
        const bound = ctx.locale.bind(NS)
        t = (key) => {
          const value = bound(key)
          return typeof value === 'string' && value.length > 0 && value !== key
            ? value
            : (ZH[key] || EN[key] || key)
        }
      } catch {
        // Keep the bundled dictionary.
      }

      const collapsed = new Map()
      const order = new Map()
      const touched = new Set()
      const clickedOverflow = new WeakSet()
      let observer = null
      let scheduled = 0
      let busy = false
      let lastRows = -1
      let dragSessionId = null
      let dragCategoryId = null
      let pressedSessionId = null

      const setOrder = (element, value) => {
        touched.add(element)
        if (order.get(element) === value) return
        element.style.order = String(value)
        order.set(element, value)
      }

      const setHidden = (element, hidden) => {
        touched.add(element)
        const next = hidden ? 'none' : ''
        if (element.style.display !== next) element.style.display = next
      }

      /**
       * Report the layout once per row-count change. A drop to zero is exactly the signal worth
       * keeping: it tells "the group is collapsed" apart from "the layer broke".
       */
      const reportState = (tree, folders, model) => {
        if (!model || model.phase !== 'ready' || !Array.isArray(model.workspaces) || model.workspaces.length === 0) return
        let groups = 0
        let rows = 0
        for (const group of groupsOf(tree)) {
          groups += 1
          rows += entriesOf(group).length
        }
        if (groups === 0 || rows === lastRows) return
        lastRows = rows
        const projectRow = tree.querySelector('[data-row-key^="workspace:"]')
        const expanded = projectRow ? (projectRow.getAttribute('aria-expanded') || 'na') : 'na'
        report('dom pass groups=' + groups + ' rows=' + rows + ' expanded=' + expanded
          + ' folders=' + (folders.join(',') || '-'))
      }

      const schedule = () => {
        if (scheduled) return
        scheduled = window.requestAnimationFrame(() => {
          scheduled = 0
          pass()
        })
      }

      const showError = (error) => {
        try {
          const tree = treeOf()
          if (!tree) return
          const host = tree.parentElement || tree
          let line = host.querySelector('.dsh-scf-err')
          if (!line) {
            line = document.createElement('div')
            line.className = 'dsh-scf-err'
            line.setAttribute(OWN, 'error')
            host.appendChild(line)
          }
          line.textContent = t('failed') + ' ' + String((error && error.message) || error)
          window.setTimeout(() => line.remove(), 6000)
        } catch {
          // Reporting a failure must never throw.
        }
      }

      const createInput = (head, initial, label, commit) => {
        const name = head.querySelector('.dsh-scf-name')
        if (!name || head.querySelector('.dsh-scf-input')) return
        const input = document.createElement('input')
        input.className = 'dsh-scf-input'
        input.value = initial
        input.setAttribute('aria-label', label)
        name.replaceWith(input)
        input.focus()
        input.select()
        let done = false
        const finish = (apply) => {
          if (done) return
          done = true
          const value = input.value.trim()
          input.remove()
          if (!apply || !value || value === initial) {
            schedule()
            return
          }
          commit(value)
        }
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') finish(true)
          if (event.key === 'Escape') finish(false)
        })
        input.addEventListener('blur', () => finish(true))
      }

      const openPopover = (head, workspaceId, category) => {
        const existing = head.querySelector('.dsh-scf-pop')
        if (existing) {
          existing.remove()
          return
        }
        const pop = document.createElement('div')
        pop.className = 'dsh-scf-pop'
        pop.addEventListener('click', event => event.stopPropagation())

        const rename = document.createElement('button')
        rename.type = 'button'
        rename.textContent = t('renameFolder')
        rename.addEventListener('click', () => {
          pop.remove()
          createInput(head, category.name, t('renameFolder'), value => {
            store.operate({ op: 'rename', workspaceId, categoryId: category.id, name: value })
              .then(() => store.refresh())
              .catch(showError)
          })
        })
        pop.appendChild(rename)

        const remove = document.createElement('button')
        remove.type = 'button'
        remove.dataset.danger = 'true'
        remove.textContent = t('deleteFolder')
        remove.addEventListener('click', () => {
          if (remove.dataset.armed !== 'true') {
            remove.dataset.armed = 'true'
            remove.textContent = t('confirm')
            return
          }
          pop.remove()
          store.operate({ op: 'delete', workspaceId, categoryId: category.id })
            .then(() => store.refresh())
            .catch(showError)
        })
        pop.appendChild(remove)

        head.appendChild(pop)
      }

      const buildHead = (workspaceId, category, memberCount, expanded) => {
        const head = document.createElement('div')
        head.className = 'dsh-scf-head'
        head.setAttribute(OWN, category ? category.id : 'uncategorized')
        head.setAttribute('role', 'treeitem')
        head.setAttribute('tabindex', '0')
        head.setAttribute('aria-expanded', String(expanded))
        head.dataset.workspaceId = workspaceId
        if (category) head.dataset.categoryId = category.id

        const chevron = document.createElement('span')
        chevron.className = 'dsh-scf-chevron'
        chevron.appendChild(chevronIcon(expanded))
        head.appendChild(chevron)

        const name = document.createElement('span')
        name.className = 'dsh-scf-name'
        name.textContent = category ? category.name : t('uncategorized')
        head.appendChild(name)

        const count = document.createElement('span')
        count.className = 'dsh-scf-count'
        count.textContent = String(memberCount)
        head.appendChild(count)

        if (category) {
          const actions = document.createElement('span')
          actions.className = 'dsh-scf-actions'
          const more = document.createElement('button')
          more.type = 'button'
          more.className = 'dsh-scf-btn'
          more.setAttribute('aria-label', t('more'))
          more.appendChild(moreIcon())
          more.addEventListener('click', (event) => {
            event.stopPropagation()
            openPopover(head, workspaceId, category)
          })
          actions.appendChild(more)
          head.appendChild(actions)

          head.draggable = true
          head.title = t('dragToReorder')
          head.addEventListener('dragstart', (event) => {
            dragCategoryId = category.id
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', category.id)
            }
          })
          head.addEventListener('dragend', () => {
            dragCategoryId = null
          })
        }

        // Both head kinds fold: a category by its id, the unfiled bucket by workspace.
        head.addEventListener('click', (event) => {
          if (event.target && typeof event.target.closest === 'function' && event.target.closest('.dsh-scf-pop')) return
          const key = category ? category.id : ('uncategorized:' + workspaceId)
          collapsed.set(key, collapsed.get(key) !== true)
          schedule()
        })

        head.addEventListener('dragover', (event) => {
          event.preventDefault()
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
          head.setAttribute('data-drop', 'true')
        })
        head.addEventListener('dragleave', () => head.removeAttribute('data-drop'))
        head.addEventListener('drop', (event) => {
          event.preventDefault()
          event.stopPropagation()
          head.removeAttribute('data-drop')
          const movedCategory = dragCategoryId
          dragCategoryId = null
          if (movedCategory) {
            if (!category || movedCategory === category.id) return
            store.operate({ op: 'move', workspaceId, categoryId: movedCategory, beforeId: category.id })
              .then(() => store.refresh())
              .catch(showError)
            return
          }
          const sessionId = dragSessionId || pressedSessionId
            || (event.dataTransfer ? event.dataTransfer.getData('text/plain') : '')
          if (!sessionId) return
          const request = category
            ? store.operate({ op: 'assign', workspaceId, sessionId, categoryId: category.id })
            : store.operate({ op: 'unassign', workspaceId, sessionId })
          request.then(() => store.refresh()).catch(showError)
        })

        return head
      }

      const headFor = (group, id) => {
        for (const child of Array.from(group.children)) {
          if (child.nodeType === 1 && child.getAttribute(OWN) === id) return child
        }
        return null
      }

      const ensureHead = (group, workspaceId, category, memberCount, expanded) => {
        const id = category ? category.id : 'uncategorized'
        const existing = headFor(group, id)
        if (existing) return existing
        const head = buildHead(workspaceId, category, memberCount, expanded)
        group.appendChild(head)
        return head
      }

      /** Refresh a head's disclosure state and member count without rebuilding it. */
      const paintHead = (head, expanded, count) => {
        const chevron = head.querySelector('.dsh-scf-chevron')
        if (chevron) chevron.replaceChildren(chevronIcon(expanded))
        head.setAttribute('aria-expanded', String(expanded))
        const countNode = head.querySelector('.dsh-scf-count')
        if (countNode) countNode.textContent = String(count)
      }

      /**
       * Put the "new folder" affordance inside the workspace row, next to the batch-select control
       * that another plugin contributes. The button is re-inserted on every pass, so a React
       * re-render of the row cannot drop it.
       */
      const ensureHeaderAdd = (group, workspaceId) => {
        const projectRow = group.querySelector('[data-row-key^="workspace:"]')
        if (!projectRow) return
        if (projectRow.querySelector('[' + OWN + '="add"]')) return

        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'dsh-scf-addbtn'
        button.setAttribute(OWN, 'add')
        button.setAttribute('aria-label', t('newFolder'))
        button.title = t('newFolder')
        button.appendChild(folderPlusIcon())
        button.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          openCreateRow(group, workspaceId)
        })
        button.addEventListener('dblclick', event => event.stopPropagation())

        const buttons = Array.from(projectRow.querySelectorAll('button'))
        const selectAll = buttons.find(node =>
          /全选|Select all/i.test((node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')))
        const rowMenu = buttons.find(node =>
          /操作|actions/i.test(node.getAttribute('aria-label') || ''))

        if (selectAll && selectAll.parentNode) selectAll.after(button)
        else if (rowMenu && rowMenu.parentNode) rowMenu.parentNode.insertBefore(button, rowMenu)
        else projectRow.appendChild(button)
      }

      /** Inline "new folder" input directly under the workspace row. */
      const openCreateRow = (group, workspaceId) => {
        const existing = group.querySelector('[' + OWN + '="create"]')
        if (existing) {
          const input = existing.querySelector('input')
          if (input) input.focus()
          return
        }
        const row = document.createElement('div')
        row.className = 'dsh-scf-head dsh-scf-create'
        row.setAttribute(OWN, 'create')
        row.setAttribute('role', 'treeitem')
        row.style.cursor = 'default'
        setOrder(row, -99900)

        const chevron = document.createElement('span')
        chevron.className = 'dsh-scf-chevron'
        chevron.appendChild(folderPlusIcon())
        row.appendChild(chevron)

        const input = document.createElement('input')
        input.className = 'dsh-scf-input'
        input.setAttribute('aria-label', t('newFolder'))
        input.placeholder = t('newFolder')
        row.appendChild(input)

        group.appendChild(row)
        input.focus()

        let done = false
        const finish = (apply) => {
          if (done) return
          done = true
          const value = input.value.trim()
          row.remove()
          if (!apply || !value) {
            schedule()
            return
          }
          store.operate({ op: 'create', workspaceId, name: value })
            .then(() => store.refresh())
            .catch(showError)
        }
        input.addEventListener('keydown', (event) => {
          event.stopPropagation()
          if (event.key === 'Enter') finish(true)
          if (event.key === 'Escape') finish(false)
        })
        input.addEventListener('click', event => event.stopPropagation())
        input.addEventListener('blur', () => finish(true))
      }

      const firstWorkspaceOf = (entries, model) => {
        for (const entry of entries) {
          for (const workspace of model.workspaces || []) {
            if ((workspace.sessions || []).some(session => session.id === entry.sessionId)) return workspace.id
          }
        }
        return null
      }

      /** One full reconciliation pass over every workspace group. */
      const pass = () => {
        if (busy) return
        busy = true
        try {
          const tree = treeOf()
          if (!tree) return
          const model = store.get()
          const folders = []
          const modelById = new Map((model.workspaces || []).map(entry => [entry.id, entry]))

          for (const group of groupsOf(tree)) {
            if (!group.classList.contains('dsh-scf-group')) group.classList.add('dsh-scf-group')

            // Direct children only: the workspace row itself, never a nested one.
            const projectWrap = Array.from(group.children).find(node =>
              node.nodeType === 1 && keyOf(node).indexOf('workspace:') === 0)
            const projectRow = projectWrap
              ? (projectWrap.hasAttribute(KEY) ? projectWrap : projectWrap.querySelector('[data-row-key^="workspace:"]'))
              : null

            // A collapsed workspace unmounts its conversation rows. Leave the group exactly as the
            // browser renders it — folder heads over an empty group read as "sessions are gone".
            if (projectRow && projectRow.getAttribute('aria-expanded') === 'false') {
              for (const node of Array.from(group.children)) {
                if (node.nodeType === 1 && node.hasAttribute(OWN)) node.remove()
              }
              continue
            }

            const entries = entriesOf(group)
            const workspaceId = workspaceKeyOf(group) || firstWorkspaceOf(entries, model)

            // The shipped browser caps a group at a few visible rows and hides the rest behind an
            // "expand the remaining N" row. Folders need the whole list, so the control is hidden
            // and clicked once; when the expansion lands the row disappears and the guard resets.
            const overflow = Array.from(group.children).find(node =>
              node.nodeType === 1 && keyOf(node).indexOf('overflow:') === 0)
            if (overflow) {
              setHidden(overflow, true)
              // After expanding, the same control turns into "收起其余" — clicking that would cap
              // the group again, so only an expand affordance is ever activated. The guard is keyed
              // by element, so a control rebuilt by a re-render is expanded again.
              const label = String(overflow.textContent || '')
              if (/展开|Expand/i.test(label) && !clickedOverflow.has(overflow)) {
                clickedOverflow.add(overflow)
                try {
                  overflow.click()
                } catch {
                  // A refused expansion just leaves the cap in place.
                }
              }
            }
            const entry = workspaceId ? modelById.get(workspaceId) : null
            const categories = entry ? entry.categories : []
            const assignments = entry ? entry.assignments : {}
            const known = new Set(categories.map(category => category.id))

            const filed = new Map()
            const loose = []
            for (const item of entries) {
              const categoryId = assignments[item.sessionId]
              if (categoryId && known.has(categoryId)) {
                if (!filed.has(categoryId)) filed.set(categoryId, [])
                filed.get(categoryId).push(item)
              } else {
                loose.push(item)
              }
            }

            if (projectWrap) setOrder(projectWrap, -100000)
            for (const nested of Array.from(group.children)) {
              if (nested.nodeType === 1 && nested.getAttribute('role') === 'group') setOrder(nested, -99000)
            }

            let band = 0
            for (const category of categories) {
              const members = filed.get(category.id) || []
              const expanded = collapsed.get(category.id) !== true
              const head = ensureHead(group, workspaceId, category, members.length, expanded)
              setOrder(head, 1000 + band * 10000)
              paintHead(head, expanded, members.length)
              members.forEach((item, index) => {
                setOrder(item.wrap, 1000 + band * 10000 + 100 + index)
                setHidden(item.wrap, !expanded)
              })
              band += 1
              folders.push(category.name + ':' + members.length)
            }

            if (categories.length > 0 || loose.length > 0) {
              const looseKey = 'uncategorized:' + workspaceId
              const looseExpanded = collapsed.get(looseKey) !== true
              const looseHead = ensureHead(group, workspaceId, null, loose.length, looseExpanded)
              setOrder(looseHead, 1000 + band * 10000)
              paintHead(looseHead, looseExpanded, loose.length)
              band += 1
              loose.forEach((item, index) => {
                setOrder(item.wrap, 1000 + band * 10000 + index)
                setHidden(item.wrap, !looseExpanded)
              })
            }

            if (workspaceId) ensureHeaderAdd(group, workspaceId)
          }

          reportState(tree, folders, model)
        } catch (error) {
          report('dom pass failed: ' + String((error && error.message) || error))
        } finally {
          try {
            if (observer) observer.takeRecords()
          } catch {
            // Ignore.
          }
          busy = false
        }
      }

      const onDragStart = (event) => {
        const target = event.target
        if (!target || typeof target.closest !== 'function') return
        const row = target.closest('[data-row-key^="session:"]')
        dragSessionId = row ? idFromKey(row.getAttribute(KEY) || '', 'session:') : null
      }

      // The shipped drag implementation may not put anything on the dataTransfer, so remember the
      // row the gesture started on as well; either source is enough to know what was dragged.
      const onPointerDown = (event) => {
        const target = event.target
        if (!target || typeof target.closest !== 'function') return
        const row = target.closest('[data-row-key^="session:"]')
        pressedSessionId = row ? idFromKey(row.getAttribute(KEY) || '', 'session:') : null
      }

      const cleanup = () => {
        try {
          if (scheduled) window.cancelAnimationFrame(scheduled)
        } catch {
          // Ignore.
        }
        if (observer) observer.disconnect()
        document.removeEventListener('dragstart', onDragStart, true)
        document.removeEventListener('pointerdown', onPointerDown, true)
        // Restore every official node this layer styled. Without this, a hidden or reordered row
        // stays hidden after the plugin reloads or is disabled — it is the one way this layer could
        // make conversations look lost.
        for (const element of touched) {
          try {
            element.style.order = ''
            element.style.display = ''
          } catch {
            // A detached node needs no restoration.
          }
        }
        touched.clear()
        order.clear()
        for (const node of Array.from(document.querySelectorAll('[' + OWN + ']'))) node.remove()
      }

      ctx.effect && typeof ctx.effect === 'function' ? ctx.effect(start) : start()

      /**
       * Start the observer and the first pass. Written as a named function so the effect scope can
       * own it, with a direct call as the fallback for a context without `effect`.
       * @returns cleanup for the effect scope.
       */
      function start() {
        const style = document.createElement('style')
        style.setAttribute(OWN, 'style')
        style.textContent = CSS
        document.head.appendChild(style)

        document.addEventListener('dragstart', onDragStart, true)
        document.addEventListener('pointerdown', onPointerDown, true)

        // Only tree-region mutations matter. Observing body catches the chat stream too, and a
        // pass per token would be pure jank.
        observer = new MutationObserver((records) => {
          if (busy) return
          const tree = treeOf()
          if (!tree) return
          for (const record of records) {
            const target = record.target
            if (target === tree || (target && typeof target.contains === 'function' && target.contains(tree))) {
              schedule()
              return
            }
            if (tree.contains(target)) {
              schedule()
              return
            }
          }
        })
        observer.observe(document.body, { childList: true, subtree: true })

        store.subscribe(() => schedule())
        store.refresh().then(() => schedule()).catch(() => {})
        schedule()

        return cleanup
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const report = (message) => {
          try {
            void fetch(API + '/log', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ message: String(message) }),
            })
          } catch {
            // Diagnostics are best effort.
          }
        }

        const register = (namespace, locale, dict) => {
          try {
            ctx.locale.register(namespace, locale, dict)
          } catch {
            // A composition without that built-in locale keeps the other dictionary.
          }
        }
        register(NS, 'en', EN)
        register(NS, 'zh', ZH)

        try {
          install(ctx, report)
        } catch (error) {
          report('install failed: ' + String((error && error.message) || error))
        }
      },
    }
  },
})
