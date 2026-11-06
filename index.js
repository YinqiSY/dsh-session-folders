/**
 * Host half of the Session Categories bundle.
 *
 * Owns the only durable copy of the user's conversation categories and exposes it two ways:
 * a small JSON route the Client half reads and writes over the same origin, and one agent tool
 * that runs the identical operations. Nothing here touches the user's workspace directory or
 * the session logs: categories live in this profile's own data directory.
 *
 * @module @local/session-categories
 */
import { appendFile, copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PLUGIN_ID = 'session-categories'
const ROUTE_PREFIX = '/dsh-session-categories'
const STATE_VERSION = 1
const TOOL_NAME = 'session_categories'
const MAX_BODY_BYTES = 512 * 1024
const MAX_LOG_BYTES = 256 * 1024
const MAX_FOLD_KEYS = 400
const TITLE_CACHE_MS = 15000

/**
 * Resolve the plugin's own data directory, never a workspace path.
 *
 * This deliberately does NOT depend on `DSH_PROFILE_DIR`: some desktop builds launch the Host
 * without it, and a per-profile path would then silently switch stores when the launch changes
 * (that is exactly how the categories ended up split across two profiles once). One fixed
 * directory under the user's own DSH home keeps the data where it is, across upgrades and
 * profiles. The data is keyed by Workspace id, so sharing it across profiles is harmless.
 */
function resolveDataDir() {
  return join(homedir(), '.dsh', PLUGIN_ID)
}

const DATA_DIR = resolveDataDir()
const STATE_FILE = join(DATA_DIR, 'state.json')
const LEGACY_PROFILES = join(homedir(), '.dsh', 'profiles')

/**
 * Adopt the newest legacy per-profile state file when this directory has none yet. Older builds
 * wrote to `<profile>/data/session-categories/state.json`; the most recently written one wins.
 */
async function adoptLegacyState() {
  try {
    await stat(STATE_FILE)
    return
  } catch {
    // No state here yet; look for a legacy one.
  }
  let best = null
  try {
    const entries = await readdir(LEGACY_PROFILES, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const candidate = join(LEGACY_PROFILES, entry.name, 'data', PLUGIN_ID, 'state.json')
      try {
        const info = await stat(candidate)
        if (!best || info.mtimeMs > best.mtimeMs) best = { file: candidate, mtimeMs: info.mtimeMs }
      } catch {
        // No state in that profile.
      }
    }
  } catch {
    return
  }
  if (!best) return
  try {
    await mkdir(DATA_DIR, { recursive: true })
    await copyFile(best.file, STATE_FILE)
  } catch {
    // A failed adoption just starts empty; the legacy file is left untouched.
  }
}

// No module-level `inject`: an entry that is still waiting for a service when the desktop web boot
// finishes makes that boot fail. `whenService` defers only the registration instead.

let cache = null
let writeChain = Promise.resolve()

function emptyWorkspaceRecord() {
  return { categories: [], assignments: {} }
}

function normalizeState(raw) {
  const next = { version: STATE_VERSION, workspaces: {}, ui: { expanded: {} } }
  const expanded = raw && typeof raw === 'object' && raw.ui && typeof raw.ui.expanded === 'object'
    ? raw.ui.expanded
    : {}
  for (const [key, value] of Object.entries(expanded)) {
    if (typeof value === 'boolean') next.ui.expanded[key] = value
  }
  const workspaces = raw && typeof raw === 'object' && raw.workspaces && typeof raw.workspaces === 'object'
    ? raw.workspaces
    : {}
  for (const [workspaceId, record] of Object.entries(workspaces)) {
    const categories = Array.isArray(record && record.categories) ? record.categories : []
    const assignments = record && typeof record.assignments === 'object' && record.assignments ? record.assignments : {}
    next.workspaces[workspaceId] = {
      categories: categories
        .filter(entry => entry && typeof entry.id === 'string' && typeof entry.name === 'string')
        .map(entry => ({ id: entry.id, name: entry.name, createdAt: Number(entry.createdAt) || Date.now() })),
      assignments: Object.fromEntries(
        Object.entries(assignments).filter(([, value]) => typeof value === 'string' && value.length > 0),
      ),
    }
  }
  return next
}

async function loadState() {
  if (cache) return cache
  await adoptLegacyState()
  try {
    const raw = await readFile(STATE_FILE, 'utf8')
    cache = normalizeState(JSON.parse(raw))
  } catch {
    cache = normalizeState(undefined)
  }
  return cache
}

async function persist() {
  const payload = JSON.stringify(cache, null, 2)
  const next = writeChain.then(async () => {
    await mkdir(dirname(STATE_FILE), { recursive: true })
    await writeFile(STATE_FILE, payload, 'utf8')
  })
  writeChain = next.catch(() => {})
  return next
}

function workspaceRecord(state, workspaceId) {
  const existing = state.workspaces[workspaceId]
  if (existing) return existing
  const created = emptyWorkspaceRecord()
  state.workspaces[workspaceId] = created
  return created
}

function newCategoryId() {
  return 'cat_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

/** Read an optional service without making the whole plugin depend on it. */
function optionalService(ctx, name) {
  if (typeof ctx.get === 'function') return ctx.get(name)
  return ctx[name]
}

function listWorkspaces(ctx) {
  const registry = optionalService(ctx, 'workspaceRegistry')
  if (!registry || typeof registry.list !== 'function') return []
  try {
    return registry.list() || []
  } catch {
    return []
  }
}

let titleCache = { at: 0, key: '', titles: {} }

async function readTitles(ctx, sessionIds) {
  const key = sessionIds.join(',')
  if (Date.now() - titleCache.at < TITLE_CACHE_MS && titleCache.key === key) return titleCache.titles
  const titles = {}
  const query = optionalService(ctx, 'sessionQuery')
  if (query && typeof query.readTitleSnapshots === 'function' && sessionIds.length > 0) {
    try {
      const results = await query.readTitleSnapshots(sessionIds)
      for (const result of results || []) {
        if (!result || result.status !== 'fulfilled') continue
        const title = result.value && result.value.title && result.value.title.title
        if (typeof title === 'string') titles[result.sessionId] = title
      }
    } catch {
      // A title is decoration only; identifiers remain usable without it.
    }
  }
  titleCache = { at: Date.now(), key, titles }
  return titles
}

/**
 * Drop state nothing can observe any more, so the file cannot grow forever.
 *
 * Removes workspaces the registry no longer knows, assignments to sessions that no longer belong
 * to their workspace, workspace records that became empty, and fold keys whose folder is gone. Fold
 * state is also capped: it is a preference, not a log.
 * @param state - the loaded state, mutated in place.
 * @param workspaces - the live workspace entities.
 * @returns whether anything was removed.
 */
function pruneState(state, workspaces) {
  let changed = false
  const liveWorkspaces = new Map(workspaces.map(workspace => [
    String(workspace.id),
    new Set(Array.from(workspace.sessionIds || [], id => String(id))),
  ]))

  for (const [workspaceId, record] of Object.entries(state.workspaces)) {
    const liveSessions = liveWorkspaces.get(workspaceId)
    if (!liveSessions) {
      delete state.workspaces[workspaceId]
      changed = true
      continue
    }
    for (const sessionId of Object.keys(record.assignments)) {
      if (!liveSessions.has(sessionId)) {
        delete record.assignments[sessionId]
        changed = true
      }
    }
    if (record.categories.length === 0 && Object.keys(record.assignments).length === 0) {
      delete state.workspaces[workspaceId]
      changed = true
    }
  }

  const validKeys = new Set()
  for (const [workspaceId, record] of Object.entries(state.workspaces)) {
    for (const category of record.categories) validKeys.add(category.id)
    validKeys.add('uncategorized:' + workspaceId)
  }
  for (const key of Object.keys(state.ui.expanded)) {
    if (!validKeys.has(key)) {
      delete state.ui.expanded[key]
      changed = true
    }
  }
  const foldKeys = Object.keys(state.ui.expanded)
  if (foldKeys.length > MAX_FOLD_KEYS) {
    for (const key of foldKeys.slice(MAX_FOLD_KEYS)) {
      delete state.ui.expanded[key]
      changed = true
    }
  }
  return changed
}

/** Build the complete Client model: workspaces, their sessions, categories, and assignments. */
async function buildModel(ctx) {
  const state = await loadState()
  const workspaces = listWorkspaces(ctx)
  // Never prune against an empty registry: that would read as "every workspace is gone" and wipe
  // the user's folders during a startup window where the registry has not published yet.
  if (workspaces.length > 0 && pruneState(state, workspaces)) await persist()
  const allSessionIds = []
  const projected = workspaces.map((workspace) => {
    const record = state.workspaces[workspace.id] || emptyWorkspaceRecord()
    const sessionIds = Array.from(workspace.sessionIds || [], id => String(id))
    allSessionIds.push(...sessionIds)
    return {
      id: String(workspace.id),
      title: String(workspace.title || ''),
      path: String(workspace.path || ''),
      sessionIds,
      categories: record.categories.map(entry => ({ id: entry.id, name: entry.name })),
      assignments: { ...record.assignments },
    }
  })
  const titles = await readTitles(ctx, allSessionIds)
  for (const workspace of projected) {
    workspace.sessions = workspace.sessionIds.map(id => ({ id, title: titles[id] || '' }))
    delete workspace.sessionIds
  }
  return {
    version: STATE_VERSION,
    dataFile: STATE_FILE,
    workspaces: projected,
    ui: { expanded: { ...state.ui.expanded } },
  }
}

function requireName(value, fallback) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name.length === 0) return fallback
  return name.slice(0, 120)
}

/**
 * Apply one category operation. Both the UI route and the agent tool call this function, so the
 * two callers cannot drift apart.
 * @param ctx - registrant context supplying the optional registries.
 * @param input - `{ op, workspaceId, categoryId, sessionId, name }`.
 * @returns `{ ok: true, model }` or `{ ok: false, error }`.
 */
async function applyOperation(ctx, input) {
  const op = typeof input.op === 'string' ? input.op : ''

  // Fold state is workspace-independent: the key is either a category id or `uncategorized:<ws>`.
  // It is persisted so the sidebar comes back exactly as it was left.
  if (op === 'expand') {
    const key = typeof input.key === 'string' ? input.key : ''
    if (key.length === 0) return { ok: false, error: 'missing-key' }
    const expandedState = await loadState()
    expandedState.ui.expanded[key] = input.value === true
    await persist()
    return { ok: true }
  }

  const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : ''
  if (workspaceId.length === 0) return { ok: false, error: 'missing-workspace' }
  const known = listWorkspaces(ctx).some(workspace => String(workspace.id) === workspaceId)
  if (!known) return { ok: false, error: 'unknown-workspace' }

  const state = await loadState()
  const record = workspaceRecord(state, workspaceId)

  if (op === 'create') {
    const name = requireName(input.name, '')
    if (name.length === 0) return { ok: false, error: 'missing-name' }
    if (record.categories.some(entry => entry.name === name)) return { ok: false, error: 'duplicate-name' }
    record.categories.push({ id: newCategoryId(), name, createdAt: Date.now() })
  } else if (op === 'rename') {
    const name = requireName(input.name, '')
    if (name.length === 0) return { ok: false, error: 'missing-name' }
    const category = record.categories.find(entry => entry.id === input.categoryId)
    if (!category) return { ok: false, error: 'unknown-category' }
    if (record.categories.some(entry => entry.id !== category.id && entry.name === name)) {
      return { ok: false, error: 'duplicate-name' }
    }
    category.name = name
  } else if (op === 'delete') {
    const index = record.categories.findIndex(entry => entry.id === input.categoryId)
    if (index < 0) return { ok: false, error: 'unknown-category' }
    record.categories.splice(index, 1)
    for (const [sessionId, categoryId] of Object.entries(record.assignments)) {
      if (categoryId === input.categoryId) delete record.assignments[sessionId]
    }
  } else if (op === 'assign' || op === 'unassign') {
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
    if (sessionId.length === 0) return { ok: false, error: 'missing-session' }
    if (op === 'unassign' || !input.categoryId) {
      delete record.assignments[sessionId]
    } else {
      const category = record.categories.find(entry => entry.id === input.categoryId)
      if (!category) return { ok: false, error: 'unknown-category' }
      record.assignments[sessionId] = category.id
    }
  } else if (op === 'move') {
    const from = record.categories.findIndex(entry => entry.id === input.categoryId)
    if (from < 0) return { ok: false, error: 'unknown-category' }
    const [moved] = record.categories.splice(from, 1)
    if (typeof input.beforeId === 'string' && input.beforeId.length > 0) {
      const to = record.categories.findIndex(entry => entry.id === input.beforeId)
      if (to < 0) record.categories.push(moved)
      else record.categories.splice(to, 0, moved)
    } else {
      record.categories.push(moved)
    }
  } else {
    return { ok: false, error: 'unknown-op' }
  }

  await persist()
  return { ok: true, model: await buildModel(ctx) }
}

function normalizePath(value) {
  return String(value || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

function resolveWorkspaceId(ctx, exec, hint) {
  const workspaces = listWorkspaces(ctx)
  if (workspaces.length === 0) return ''
  if (typeof hint === 'string' && hint.trim().length > 0) {
    const wanted = hint.trim()
    const byId = workspaces.find(workspace => String(workspace.id) === wanted)
    if (byId) return String(byId.id)
    const byTitle = workspaces.find(workspace => String(workspace.title || '') === wanted)
    if (byTitle) return String(byTitle.id)
    const byPath = workspaces.find(workspace => normalizePath(workspace.path) === normalizePath(wanted))
    if (byPath) return String(byPath.id)
  }
  const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
    ? exec.agent.session.header.cwd
    : undefined
  if (cwd) {
    const match = workspaces.find(workspace => normalizePath(workspace.path) === normalizePath(cwd))
    if (match) return String(match.id)
  }
  return String(workspaces[0].id)
}

function summarize(model, workspaceId) {
  const workspace = model.workspaces.find(entry => entry.id === workspaceId)
  if (!workspace) return { summary: 'No workspace found.', categories: [] }
  const counts = new Map(workspace.categories.map(category => [category.id, 0]))
  let uncategorized = 0
  for (const session of workspace.sessions) {
    const categoryId = workspace.assignments[session.id]
    if (categoryId && counts.has(categoryId)) counts.set(categoryId, (counts.get(categoryId) || 0) + 1)
    else uncategorized += 1
  }
  const categories = workspace.categories.map(category => ({
    name: category.name,
    count: counts.get(category.id) || 0,
  }))
  const listed = categories.length === 0
    ? 'no categories yet'
    : categories.map(category => `${category.name} (${category.count})`).join(', ')
  return {
    summary: `Workspace "${workspace.title}": ${listed}; ${uncategorized} uncategorized session(s) of ${workspace.sessions.length}.`,
    categories,
  }
}

const TOOL_DESCRIPTION = [
  'Manage the user\'s conversation categories in the Web UI: the folders the user groups Sessions into.',
  'Categories belong to one Workspace and a Session has at most one category.',
  'Use action "list" to read the current folders and counts, "create"/"rename"/"delete" to change folders,',
  'and "assign"/"unassign" to file or unfile a Session.',
  'Prefer naming a Session by the id the user gave you; `session` also accepts the Session id shown in the UI.',
  'This never moves or deletes Session logs.',
].join(' ')

const TOOL_PARAMETERS = {
  action: {
    type: 'string',
    required: true,
    enum: ['list', 'create', 'rename', 'delete', 'assign', 'unassign'],
    description: 'Operation to perform.',
  },
  workspace: {
    type: 'string',
    required: false,
    description: 'Workspace id, title, or directory path. Defaults to the calling Session\'s workspace.',
  },
  name: {
    type: 'string',
    required: false,
    description: 'Category name for create/rename.',
  },
  category: {
    type: 'string',
    required: false,
    description: 'Existing category name or id, for rename/delete/assign.',
  },
  session: {
    type: 'string',
    required: false,
    description: 'Session id to file into or out of a category.',
  },
}

const TOOL_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'summary', 'categories'],
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      categories: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'count'],
          properties: {
            name: { type: 'string' },
            count: { type: 'integer' },
          },
        },
      },
    },
  },
  render: (_args, value) => [{ type: 'text', text: value.summary }],
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('payload-too-large'))
        req.destroy()
        return
      }
      body += chunk.toString('utf8')
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

/**
 * Run `run` once a service exists, without making the plugin entry itself wait.
 *
 * An entry that is still inactive when the desktop's web boot finishes makes that boot fail
 * outright (`1 entry did not activate`). So activation has to succeed immediately, and only the
 * registration may be deferred until its service mounts.
 * @param ctx - registrant context.
 * @param name - service key to wait for.
 * @param run - registration callback; it tolerates a still-missing service.
 */
function whenService(ctx, name, run) {
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject([name], (scoped) => {
        try {
          run(scoped || ctx)
        } catch {
          // Registration is best effort; it must never fail the boot.
        }
      })
      return
    } catch {
      // Fall through to the immediate attempt.
    }
  }
  try {
    run(ctx)
  } catch {
    // Registration is best effort; it must never fail the boot.
  }
}

/**
 * The agent-facing tool definition. Built lazily so the plugin can activate before `tools` mounts.
 * @param ctx - context carrying the optional registries.
 * @returns the tool definition.
 */
function createToolDefinition(ctx) {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: TOOL_OUTPUT,
    async execute(args, exec) {
      const action = typeof args.action === 'string' ? args.action : 'list'
      const workspaceId = resolveWorkspaceId(ctx, exec, args.workspace)
      if (!workspaceId) {
        return { ok: false, summary: 'No workspace is registered, so there is nothing to categorize.', categories: [] }
      }

      if (action === 'list') {
        const model = await buildModel(ctx)
        const result = summarize(model, workspaceId)
        return { ok: true, summary: result.summary, categories: result.categories }
      }

      let categoryId = ''
      if (action === 'rename' || action === 'delete' || action === 'assign') {
        const state = await loadState()
        const record = state.workspaces[workspaceId] || emptyWorkspaceRecord()
        const wanted = typeof args.category === 'string' ? args.category.trim() : ''
        if (wanted.length === 0 && action !== 'delete') {
          return { ok: false, summary: 'A category name or id is required.', categories: [] }
        }
        const found = record.categories.find(entry => entry.id === wanted || entry.name === wanted)
        if (!found) {
          return { ok: false, summary: `Category "${wanted}" does not exist in this workspace.`, categories: [] }
        }
        categoryId = found.id
      }

      const result = await applyOperation(ctx, {
        op: action,
        workspaceId,
        categoryId,
        name: typeof args.name === 'string' ? args.name : '',
        sessionId: typeof args.session === 'string' ? args.session : '',
      })
      if (!result.ok) {
        return { ok: false, summary: `Category operation failed: ${result.error}.`, categories: [] }
      }
      const summary = summarize(result.model, workspaceId)
      const verbs = {
        create: 'Created',
        rename: 'Renamed',
        delete: 'Deleted',
        assign: 'Filed the session into',
        unassign: 'Removed the session from',
      }
      const label = args.name || args.category || ''
      const detail = action === 'unassign'
        ? 'Removed the session from its category.'
        : action === 'delete' ? `Deleted category "${label}".` : `${verbs[action] || 'Updated'} "${label}".`
      return { ok: true, summary: `${detail} ${summary.summary}`, categories: summary.categories }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Session categories',
      kind: 'other',
      rawInput: args,
    }),
  }
}

/** Register the Client-facing JSON route and the agent tool. Never throws. */
export function apply(ctx) {
  whenService(ctx, 'webServer', (scoped) => {
    const service = optionalService(scoped, 'webServer')
    if (!service || typeof service.register !== 'function') return
    const handler = async (req, res) => {
      const send = (status, value) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(value))
      }
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        if (req.method === 'GET' && url.pathname === ROUTE_PREFIX + '/state') {
          send(200, await buildModel(ctx))
          return
        }
        if (req.method === 'POST' && url.pathname === ROUTE_PREFIX + '/log') {
          const raw = await readRequestBody(req)
          let entry = raw
          try {
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed.message === 'string') entry = parsed.message
          } catch {
            // Keep the raw body.
          }
          try {
            await mkdir(dirname(STATE_FILE), { recursive: true })
            const logFile = join(dirname(STATE_FILE), 'client.log')
            let existing = 0
            try {
              existing = (await stat(logFile)).size
            } catch {
              existing = 0
            }
            // One line per page load adds up over months; keep the diagnostic channel bounded.
            if (existing > MAX_LOG_BYTES) await writeFile(logFile, '', 'utf8')
            await appendFile(logFile, `[${new Date().toISOString()}] ${entry}\n`, 'utf8')
          } catch {
            // Diagnostics are best effort.
          }
          send(200, { ok: true })
          return
        }
        if (req.method === 'POST' && url.pathname === ROUTE_PREFIX + '/op') {
          const raw = await readRequestBody(req)
          let payload = {}
          try {
            payload = raw.length > 0 ? JSON.parse(raw) : {}
          } catch {
            send(400, { ok: false, error: 'invalid-json' })
            return
          }
          const result = await applyOperation(ctx, payload)
          send(result.ok ? 200 : 400, result)
          return
        }
        send(404, { ok: false, error: 'not-found' })
      } catch (error) {
        send(500, { ok: false, error: String((error && error.message) || error) })
      }
    }
    try {
      scoped.effect(() => service.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }))
    } catch {
      // A route failure must not take the boot down.
    }
  })

  whenService(ctx, 'tools', (scoped) => {
    const tools = optionalService(scoped, 'tools')
    if (!tools || typeof tools.register !== 'function') return
    try {
      scoped.effect(() => tools.register(createToolDefinition(scoped)))
    } catch {
      // A tool failure must not take the boot down.
    }
  })
}
