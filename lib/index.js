/**
 * dsh-auto-context-compress — 主动式、零模型开销的上下文压缩，动手之前先问人。
 *
 * 目标宿主：DSH 0.2.x（0.2.1-rc.2 起），Web profile 与桌面端（Electron）共用
 * 同一套 `dsh-web-app` 宿主组合。桌面端渲染器从 `dsh-app://app/` 加载页面，
 * 并把同源的 `api/...` 请求经 IPC 转发到本进程的 loopback webServer，所以本
 * 插件注册的绝对路由 `/api/auto-context-compress` 在两种端上都能到达。
 *
 * 跨对话适配（照 `dsh-token-usage-hud` 的做法）
 * --------------------------------------------
 * 本插件不存在「当前对话」这个概念。它**用会话 id 寻址**：
 *
 *   * 每个会话的状态记在以 `session.id` 为键的 Map 里；
 *   * 挂载时从 `ctx.sessions.list()` 播种，所以本插件装载之前就已存在的对话
 *     也立刻有记录，不需要等它先跑一轮；
 *   * 注册一条 host 路由 `/api/auto-context-compress?session=<id>`，任何读取方都能
 *     按 id 取用某个对话的状态，或用 `&force=prune` 只对那个对话预约一次裁剪。
 *
 * `agent/pre-step` 是 host 平面的监听器，而 dsh-scope 的载体过滤器明确「全局准入未打标签
 * 的监听器」（`if (tag === void 0) return true`），所以这一个监听器收得到**进程内每个
 * 会话**的 pre-step——包括你切换过去的那个对话。压缩资格只看该会话自己的预设是否挂载了
 * 压缩服务，与「哪个对话正被打开」无关。
 *
 * 行为
 * ----
 * 压力越过路由模型上下文窗口的 `softRatio` 之后，枚举当前模型表面，找出
 * `toolResultPruner` 确实能收缩的每一条工具结果，**在改动任何东西之前**把将被替换的
 * 内容呈现给用户并请求确认；只有被确认的回答才会真正改写表面。
 *
 * 为什么必须走 serviceFor
 * ----------------------
 * 预设把 `compaction` / `toolResultPruner` 发布在 `isolate` realm 里，这些 realm 对
 * 声明分组之外——包括对本 host 平面行——不可见。`ctx.agentPresets.serviceFor(agent, name)`
 * 是官方为「已经持有 agent 的调用方」提供的读取寻址，所以这里用它解析每个会话自己的
 * 服务实例。既没挂 pruner 也没挂 compaction 的会话会被跳过，而不是假装在工作。
 *
 * 失败一律保守
 * ------------
 * 任何一步出问题（没有测量服务、没有提问通道、用户超时、回答无法解析）都退化为
 * 「什么都不裁剪」。这个插件永远不会在拿不到确认的情况下改动上下文。
 *
 * @module dsh-auto-context-compress
 */

export const name = 'auto-context-compress'

/**
 * The web carrier and the session registry — declared exactly as the sibling
 * `dsh-token-usage-hud` declares them.
 *
 * These two must be REAL dependencies, and the lesson was learned the hard way.
 * `ctx.get('webServer')` inside `apply` is evaluated the moment this row
 * activates, and without an `inject` declaration Cordis does NOT wait: the row
 * activated before the web carrier had registered, `ctx.get` returned
 * undefined, and the read route was silently never created. The symptom was
 * exactly `/api/auto-context-compress` returning 404 while `dsh --dump-config`
 * showed the row correctly composed and the plugin otherwise working.
 *
 * Everything else stays optional via `ctx.get` with a defined check:
 * `tokenMeter`, `timer`, `sessionQuery`, `sessionProjections`, `llm`,
 * `userQuestions`, `agentPresets`. Those are all consumed long after activation
 * (inside the `agent/pre-step` listener, or per HTTP request), so waiting for
 * them would buy nothing — while a service that never appears would turn this
 * row into a startup failure instead of a merely degraded one.
 *
 * One consequence worth knowing: in a profile with no web carrier this row
 * would never activate, and an enabled-but-inactive row is a startup failure
 * (`assertEntriesActivated` in dsh-app-boot). This bundle targets web profiles;
 * a headless profile should not list it.
 */
export const inject = ['webServer', 'sessions']

const CONFIRM_LABEL = '确认裁剪'
const SKIP_LABEL = '跳过本次'
const DISABLE_LABEL = '关闭自动压缩'

const LOG_LIMIT = 12
const STATE_LIMIT = 64
const API_PATH = '/api/auto-context-compress'

const KNOWN_KEYS = new Set([
  'enabled',
  'confirm',
  'confirmTimeoutMs',
  'softRatio',
  'hardRatio',
  'escalate',
  'escalateRatio',
  'fallbackSoftTokens',
  'fallbackHardTokens',
  'maxDetailCandidates',
  'previewHeadChars',
  'previewTailChars',
  // Browser-half keys. Both halves receive the SAME row config object, so the
  // host must accept these even though it ignores them — otherwise the strict
  // unknown-key check below would reject a config that is valid for the client.
  'pollMs',
  'position',
  'visible',
])

const DEFAULTS = {
  enabled: true,
  confirm: true,
  confirmTimeoutMs: 120000,
  softRatio: 0.5,
  hardRatio: 0.75,
  escalate: false,
  escalateRatio: 0.75,
  fallbackSoftTokens: 64000,
  fallbackHardTokens: 96000,
  maxDetailCandidates: 8,
  previewHeadChars: 220,
  previewTailChars: 120,
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pickBoolean(source, key, fallback) {
  if (source[key] === undefined) return fallback
  if (typeof source[key] !== 'boolean') {
    throw new Error(`auto-context-compress: config.${key} must be a boolean (got ${JSON.stringify(source[key])})`)
  }
  return source[key]
}

function pickRatio(source, key, fallback) {
  if (source[key] === undefined) return fallback
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`auto-context-compress: config.${key} must be a number in (0, 1] (got ${JSON.stringify(value)})`)
  }
  return value
}

function pickInteger(source, key, fallback, min) {
  if (source[key] === undefined) return fallback
  const value = source[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(`auto-context-compress: config.${key} must be an integer >= ${min} (got ${JSON.stringify(value)})`)
  }
  return value
}

/**
 * Validate and detach one row's config. Unknown keys fail loudly rather than
 * being silently ignored, matching the shipped plugins' behaviour.
 *
 * @param raw - the `config` object a composition row supplied.
 * @returns frozen resolved options.
 */
export function resolveConfig(raw) {
  const source = isRecord(raw) ? raw : {}
  for (const key of Object.keys(source)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`auto-context-compress: unknown config key "${key}"`)
    }
  }
  const resolved = {
    enabled: pickBoolean(source, 'enabled', DEFAULTS.enabled),
    confirm: pickBoolean(source, 'confirm', DEFAULTS.confirm),
    confirmTimeoutMs: pickInteger(source, 'confirmTimeoutMs', DEFAULTS.confirmTimeoutMs, 0),
    softRatio: pickRatio(source, 'softRatio', DEFAULTS.softRatio),
    hardRatio: pickRatio(source, 'hardRatio', DEFAULTS.hardRatio),
    escalate: pickBoolean(source, 'escalate', DEFAULTS.escalate),
    escalateRatio: pickRatio(source, 'escalateRatio', DEFAULTS.escalateRatio),
    fallbackSoftTokens: pickInteger(source, 'fallbackSoftTokens', DEFAULTS.fallbackSoftTokens, 1000),
    fallbackHardTokens: pickInteger(source, 'fallbackHardTokens', DEFAULTS.fallbackHardTokens, 1000),
    maxDetailCandidates: pickInteger(source, 'maxDetailCandidates', DEFAULTS.maxDetailCandidates, 1),
    previewHeadChars: pickInteger(source, 'previewHeadChars', DEFAULTS.previewHeadChars, 0),
    previewTailChars: pickInteger(source, 'previewTailChars', DEFAULTS.previewTailChars, 0),
  }
  if (resolved.hardRatio < resolved.softRatio) resolved.hardRatio = resolved.softRatio
  if (resolved.escalateRatio < resolved.softRatio) resolved.escalateRatio = resolved.softRatio
  if (resolved.fallbackHardTokens < resolved.fallbackSoftTokens) {
    resolved.fallbackHardTokens = resolved.fallbackSoftTokens
  }
  return Object.freeze(resolved)
}

/** Render a count as a short human string. */
function formatCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(Math.round(value))
}

/** Extract the concatenated text of content blocks; non-text blocks contribute nothing. */
function blocksText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (isRecord(block) && typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Read one tool-result message's call identity across DSH message generations.
 *
 * DSH 0.2 replaced the flat `message.callId` / `message.name` fields with a
 * `source: { kind: 'tool', callId }` identity plus `toolCallId`. Older releases
 * are still read through the same helper so a profile pinned to 0.1 keeps
 * working instead of showing an empty call id.
 *
 * @param message - a `tool/result` event's message.
 * @returns the call id, or an empty string.
 */
function messageCallId(message) {
  const source = isRecord(message.source) ? message.source : undefined
  if (source !== undefined && typeof source.callId === 'string' && source.callId.length > 0) return source.callId
  if (typeof message.toolCallId === 'string' && message.toolCallId.length > 0) return message.toolCallId
  if (typeof message.callId === 'string' && message.callId.length > 0) return message.callId
  return ''
}

/**
 * Resolve the tool name for one tool result.
 *
 * DSH 0.2 no longer carries the name on the result message; the name lives on
 * the `tool/call` event the result cites in `sourceEventSeqs`. `readEvent` is
 * used only for the handful of candidates the card actually details, so a
 * large history never pays for names it will not print.
 *
 * @param query - sessionQuery service (optional capability).
 * @param sessionId - owner session.
 * @param event - the `tool/result` surface event.
 * @param message - its message.
 * @returns the tool name, or an empty string.
 */
async function toolNameOf(query, sessionId, event, message) {
  if (typeof message.name === 'string' && message.name.length > 0) return message.name
  const source = isRecord(message.source) ? message.source : undefined
  if (source !== undefined && typeof source.name === 'string' && source.name.length > 0) return source.name
  const cited = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
  if (cited.length === 0 || typeof query.readEvent !== 'function') return ''
  try {
    const read = await query.readEvent({ sessionId, seq: cited[0], before: 0, after: 0 })
    const target = isRecord(read) ? read.target : undefined
    const data = isRecord(target) ? target.data : undefined
    if (isRecord(target) && target.type === 'tool/call' && typeof data.name === 'string') return data.name
  } catch {
    /* the name is presentation-only; a read failure must not hide the candidate */
  }
  return ''
}

/** Clip one string to head + tail, naming how much was left out in between. */
function clipText(text, head, tail) {
  if (typeof text !== 'string' || text.length === 0) return '(空)'
  if (text.length <= head + tail) return text
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n…〔中间 ${formatCount(omitted)} 字符将被替换为省略标记〕…\n${text.slice(text.length - tail)}`
}

/** Reduce an error to a one-line message without touching live objects further. */
function describe(error) {
  if (error !== null && error !== undefined && typeof error.message === 'string' && error.message.length > 0) {
    return error.message
  }
  try {
    return String(error)
  } catch {
    return 'unknown error'
  }
}

/**
 * Route fence, copied in spirit from the sibling `dsh-token-usage-hud` (which
 * shares the discipline with `dsh-perf`).
 *
 * The remote address alone is NOT a sufficient gate for a loopback server: any
 * page the user visits can issue a request to 127.0.0.1, and DNS rebinding can
 * make a foreign hostname resolve there. So the `Host` header must itself name a
 * loopback host, cross-site fetches are refused outright, and a present `Origin`
 * must match `Host` exactly. This matters MORE here than in the read-only HUD:
 * this route cannot only read, it can arm a destructive action (`force=prune`).
 */
function isIPv4Loopback(parts) {
  return (
    parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = String(address).toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7).split('.'))
  return isIPv4Loopback(normalized.split('.'))
}

function isLoopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '[::1]' || isIPv4Loopback(hostname.split('.'))
}

function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request?.socket?.remoteAddress)) return false
  const host = request?.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

const MOUNTED = Symbol.for('dsh-auto-context-compress.mounted')

/**
 * Host single-instance guard — the web-ui family pattern the sibling HUD uses.
 *
 * A second mount of the same package becomes a no-op. Without it a duplicated
 * row would register a SECOND `agent/pre-step` listener (two confirmation cards
 * and two prune attempts for one conversation) and a second `webServer.register`
 * on the same path, which throws. The guard is released by a fiber effect, so a
 * stop/restart cycle can mount again.
 */
function mountOnce(packageName, fn) {
  return (...args) => {
    const registry = globalThis
    const mounted = (registry[MOUNTED] ??= new Set())
    if (mounted.has(packageName)) return
    mounted.add(packageName)
    args[0]?.effect?.(() => () => {
      mounted.delete(packageName)
    })
    return fn(...args)
  }
}

/**
 * Register the plugin.
 *
 * @param ctx - host-plane context this row was mounted into.
 * @param rawConfig - the row's `config` object.
 */
export const apply = mountOnce(name, function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  let runtimeEnabled = config.enabled
  /** sessionId -> per-conversation record. Keyed by id, never by object identity. */
  const records = new Map()
  /** sessionId -> the turn we last asked in, so one turn never asks twice. */
  const askedTurn = new Map()
  /** sessionId -> 'prune' | 'both' | 'escalate', armed by the route for ONE conversation. */
  const pendingFor = new Map()
  /** sessionId -> last observed step, used only when a host stops reporting `turn`. */
  const lastStep = new Map()
  let turnEpoch = 0

  function newRecord() {
    return {
      observing: false,
      armed: false,
      enabled: runtimeEnabled,
      capacity: null,
      pressureTokens: 0,
      contextWindow: 0,
      ratio: 0,
      softTokens: 0,
      hardTokens: 0,
      hasPruner: false,
      hasCompaction: false,
      asks: 0,
      confirmed: 0,
      declined: 0,
      prunePasses: 0,
      prunedResults: 0,
      charsRemoved: 0,
      reclaimedTokens: 0,
      summaries: 0,
      lastDetail: '',
      error: '',
      log: [],
    }
  }

  /** Fetch (or create) the record for one conversation id. */
  function recordFor(sessionId) {
    let entry = records.get(sessionId)
    if (entry === undefined) {
      entry = newRecord()
      records.set(sessionId, entry)
      while (records.size > STATE_LIMIT) {
        const oldest = records.keys().next()
        if (oldest.done === true) break
        records.delete(oldest.value)
      }
    }
    return entry
  }

  function note(record, kind, detail) {
    record.log.unshift({ seq: record.log.length === 0 ? 1 : record.log[0].seq + 1, kind, detail })
    while (record.log.length > LOG_LIMIT) record.log.pop()
  }

  /** Session id of one live agent; `agent.id` is the SessionId the registry keys by. */
  function sessionIdOf(agent) {
    if (isRecord(agent) && typeof agent.id === 'string' && agent.id.length > 0) return agent.id
    const session = isRecord(agent) ? agent.session : undefined
    if (isRecord(session) && typeof session.id === 'string') return session.id
    return ''
  }

  /**
   * A per-turn marker for the "ask at most once per turn" rule.
   *
   * DSH 0.2.1's `agent/pre-step` payload carries `turn` (and `step`). A future
   * host that stops reporting it falls back to the step counter: a step that
   * goes backwards starts a new epoch, so a multi-step turn still asks once and
   * the next turn is offered again instead of being suppressed forever.
   */
  function turnKeyOf(sessionId, payload) {
    const turn = isRecord(payload) ? payload.turn : undefined
    if (typeof turn === 'number' && Number.isSafeInteger(turn)) return `turn:${turn}`
    const rawStep = isRecord(payload) ? payload.step : undefined
    const step = typeof rawStep === 'number' && Number.isSafeInteger(rawStep) ? rawStep : 0
    const previous = lastStep.get(sessionId)
    lastStep.set(sessionId, step)
    if (previous === undefined || step < previous) turnEpoch += 1
    return `epoch:${turnEpoch}`
  }

  /**
   * Resolve one service the way THIS agent's preset publishes it.
   *
   * A preset's `isolate` realms are invisible outside the declaring group,
   * including to this host plane, so a plain `ctx.get` finds nothing for
   * `compaction` / `toolResultPruner`. `agentPresets.serviceFor` is the
   * documented read addressing for a caller that already holds the agent.
   */
  function resolveService(agent, serviceName) {
    const presets = ctx.get('agentPresets')
    if (presets !== undefined) {
      try {
        const scoped = presets.serviceFor(agent, serviceName)
        if (scoped !== undefined && scoped !== null) return scoped
      } catch {
        /* fall through to the host plane */
      }
    }
    try {
      const host = ctx.get(serviceName)
      if (host !== undefined && host !== null) return host
    } catch {
      /* absent */
    }
    return undefined
  }

  function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }

  /** Classify one usage ratio against this row's own thresholds. */
  function levelOf(ratio) {
    if (ratio === null || typeof ratio !== 'number' || !Number.isFinite(ratio)) return 'unknown'
    if (ratio >= config.escalateRatio) return 'hard'
    if (ratio >= config.softRatio) return 'soft'
    return 'ok'
  }

  /**
   * Detect ONE conversation's context capacity usage.
   *
   * This reads the `contextPressure` projection through
   * `ctx.sessionProjections.snapshot(session)` — the exact data the composer's
   * occupancy meter renders, so the reading matches what the user already sees
   * for that dialog. `usedTokens` prefers `projectedTokens` (what the NEXT
   * request's prompt would cost) over `pressureTokens` (the last
   * provider-reported sample), the same preference the sibling HUD plugin uses.
   *
   * `contextBreakdown` rides along in the same snapshot and says what the window
   * is made of (system / tools / messages), which is what makes the reading
   * actionable rather than just a number.
   *
   * @param session - live Session object, not an id.
   * @returns a JSON-safe reading, or null when no projection is available.
   */
  function readCapacity(session) {
    const projections = ctx.get('sessionProjections')
    if (projections === undefined || typeof projections.snapshot !== 'function') return null
    let snapshot
    try {
      snapshot = projections.snapshot(session)
    } catch {
      return null
    }
    const values = isRecord(snapshot) ? snapshot.values : undefined
    if (!isRecord(values)) return null
    const pressure = isRecord(values.contextPressure) ? values.contextPressure : undefined
    if (pressure === undefined) return null
    const pressureTokens = numberOrNull(pressure.pressureTokens)
    const projectedTokens = numberOrNull(pressure.projectedTokens)
    const contextWindow = numberOrNull(pressure.contextWindow)
    const usedTokens = projectedTokens ?? pressureTokens
    const raw = isRecord(values.contextBreakdown) ? values.contextBreakdown : undefined
    const breakdown =
      raw === undefined
        ? null
        : {
            systemTokens: numberOrNull(raw.systemTokens) ?? 0,
            toolsTokens: numberOrNull(raw.toolsTokens) ?? 0,
            messageTokens: numberOrNull(raw.messageTokens) ?? 0,
          }
    const ratio = usedTokens !== null && contextWindow !== null && contextWindow > 0 ? usedTokens / contextWindow : null
    return {
      usedTokens,
      pressureTokens,
      projectedTokens,
      contextWindow,
      ratio,
      level: levelOf(ratio),
      breakdown,
    }
  }

  /**
   * Window capacity for the TRIGGER decision: projection first, adapter second.
   *
   * The trigger deliberately keeps using `ctx.tokenMeter.measure().totalTokens`
   * rather than the projection's `projectedTokens`, because that is the same
   * input the session's own compaction backend prices with — so this plugin's
   * threshold and the backend's agree. Both figures are reported side by side by
   * the read route, so any divergence stays visible instead of hidden.
   */
  async function contextWindowOf(session, signal, capacity) {
    if (capacity !== null && capacity.contextWindow !== null && capacity.contextWindow > 0) {
      return Math.floor(capacity.contextWindow)
    }
    const llm = ctx.get('llm')
    if (llm === undefined) return 0
    try {
      const header = session.requestHeader()
      const route = isRecord(header) ? header.config : undefined
      if (!isRecord(route)) return 0
      const provider = typeof route.provider === 'string' ? route.provider : ''
      const model = typeof route.model === 'string' ? route.model : ''
      if (provider.length === 0 || model.length === 0) return 0
      const info = await llm.resolveModelInfo(provider, model, signal)
      const capacityInfo = isRecord(info) ? info.context : undefined
      const size = isRecord(capacityInfo) ? capacityInfo.contextWindow : undefined
      if (typeof size === 'number' && Number.isFinite(size) && size > 0) return Math.floor(size)
    } catch {
      return 0
    }
    return 0
  }

  /**
   * Enumerate every current-surface tool result the pruner would actually
   * shrink. Content comes from `sessionQuery.readSurface`, which returns a
   * CLONED surface — that is why this never touches live session internals.
   *
   * @returns candidate rows, or null when the surface cannot be read at all.
   */
  async function collectCandidates(pruner, sessionId, signal) {
    const query = ctx.get('sessionQuery')
    if (query === undefined) return null
    let snapshot
    try {
      snapshot = await query.readSurface(sessionId)
    } catch {
      return null
    }
    const events = isRecord(snapshot) && Array.isArray(snapshot.events) ? snapshot.events : []
    const candidates = []
    let totalBefore = 0
    let totalAfter = 0
    for (const event of events) {
      if (!isRecord(event) || event.type !== 'tool/result') continue
      const data = isRecord(event.data) ? event.data : undefined
      const message = data !== undefined && isRecord(data.message) ? data.message : undefined
      if (message === undefined || !Array.isArray(message.content)) continue
      const original = message.content
      let pruned = null
      try {
        pruned = pruner.pruneContent(original)
      } catch {
        continue
      }
      if (pruned === null || pruned === undefined) continue
      const before = pruner.measureContent(original)
      const after = pruner.measureContent(pruned)
      if (!(after < before)) continue
      totalBefore += before
      totalAfter += after
      if (signal !== undefined && signal !== null && signal.aborted === true) break
      const tool =
        candidates.length < config.maxDetailCandidates
          ? await toolNameOf(query, sessionId, event, message)
          : ''
      candidates.push({
        seq: typeof event.seq === 'number' ? event.seq : -1,
        callId: messageCallId(message),
        tool,
        blockCount: original.length,
        before,
        after,
        text: blocksText(original),
      })
    }
    return { candidates, totalBefore, totalAfter }
  }

  /** Build the confirmation card: numbers up front, then a preview per candidate. */
  function buildQuestion(report, pressure, ratio, contextWindow) {
    const { candidates, totalBefore, totalAfter } = report
    const omitted = totalBefore - totalAfter
    const shown = candidates.slice(0, config.maxDetailCandidates)
    const lines = []
    lines.push(
      `当前请求压力约 ${formatCount(pressure)} tokens` +
        (contextWindow > 0 ? `（占窗口 ${Math.round(ratio * 100)}%）` : '') +
        '。',
    )
    lines.push('')
    lines.push(
      `可裁剪 ${candidates.length} 条超长工具输出：文本合计 ${formatCount(totalBefore)} → ` +
        `${formatCount(totalAfter)} 字符，省略 ${formatCount(omitted)} 字符。`,
    )
    lines.push('')
    lines.push('裁剪只改写下一次请求实际看到的模型上下文：中间段被换成省略标记，开头与结尾保留。')
    lines.push('原始事件完整保留在会话日志中（append-only），不会丢失，可回放查看。')
    lines.push('')
    for (let index = 0; index < shown.length; index += 1) {
      const candidate = shown[index]
      lines.push(
        `${index + 1}. seq ${candidate.seq}` +
          (candidate.tool.length > 0 ? ` · 工具 \`${candidate.tool}\`` : '') +
          (candidate.callId.length > 0 ? ` · callId ${candidate.callId}` : '') +
          ` · ${formatCount(candidate.before)} → ${formatCount(candidate.after)} 字符` +
          `（-${formatCount(candidate.before - candidate.after)}）`,
      )
      lines.push('```')
      lines.push(clipText(candidate.text, config.previewHeadChars, config.previewTailChars))
      lines.push('```')
    }
    if (candidates.length > shown.length) {
      lines.push(`…以及另外 ${candidates.length - shown.length} 条同类工具输出。`)
    }
    return {
      id: 'auto-context-compress-confirm',
      header: '上下文压缩',
      question:
        `检测到上下文压力，是否裁剪这 ${candidates.length} 条工具输出` +
        `（省略约 ${formatCount(omitted)} 字符）？`,
      detail: lines.join('\n'),
      options: [
        { label: CONFIRM_LABEL, description: '现在裁剪；原文仍保留在会话日志中' },
        { label: SKIP_LABEL, description: '本次不裁剪；下一次压力达标时再询问' },
        { label: DISABLE_LABEL, description: '本次不裁剪，并关闭自动压缩直到进程重启' },
      ],
    }
  }

  const TIMED_OUT = Symbol('auto-context-compress-timeout')

  /**
   * Bound a wait to a wall-clock deadline, reporting expiry through `onExpire`.
   *
   * The Cordis timer service is used when present because it is fiber-owned and
   * disposable; a plain host timer is the fallback, so this row needs no hard
   * dependency and can never fail activation by waiting for a service.
   */
  function withDeadline(ms, onExpire) {
    const timer = ctx.get('timer')
    if (timer !== undefined && timer !== null && typeof timer.timeout === 'function') {
      // Cordis' timer rejects when the owning fiber is disposed. That is the
      // same fail-closed outcome as an expiry, not a reason to propagate.
      return timer.timeout(ms).then(
        () => {
          onExpire()
          return TIMED_OUT
        },
        () => {
          onExpire()
          return TIMED_OUT
        },
      )
    }
    return new Promise((resolve) => {
      const handle = setTimeout(() => {
        onExpire()
        resolve(TIMED_OUT)
      }, ms)
      if (typeof handle.unref === 'function') handle.unref()
    })
  }

  /**
   * Ask the human, with a bounded wait and the turn's own cancellation wired in.
   * Returns TIMED_OUT rather than throwing when nobody answers in time.
   */
  async function askHuman(service, questions, agent, signal) {
    if (config.confirmTimeoutMs <= 0) {
      return await service.ask({ questions, agent, signal })
    }
    const controller = new AbortController()
    const forward = () => {
      try {
        controller.abort()
      } catch {
        /* already aborted */
      }
    }
    if (signal !== undefined && signal !== null) {
      if (signal.aborted === true) forward()
      else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', forward, { once: true })
    }
    const expiry = withDeadline(config.confirmTimeoutMs, forward)
    try {
      return await Promise.race([service.ask({ questions, agent, signal: controller.signal }), expiry])
    } finally {
      if (signal !== undefined && signal !== null && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', forward)
      }
    }
  }

  /** Read the selected label for our question id out of an answer, defensively. */
  function selectionOf(answer, questionId) {
    if (!isRecord(answer) || !Array.isArray(answer.answers)) return { label: '', custom: '' }
    for (const item of answer.answers) {
      if (!isRecord(item) || item.id !== questionId) continue
      const selected = Array.isArray(item.selected) ? item.selected : []
      const label = selected.find((value) => typeof value === 'string') ?? ''
      const custom = typeof item.custom === 'string' ? item.custom : ''
      return { label, custom }
    }
    return { label: '', custom: '' }
  }

  /**
   * One step's work: measure, offer, confirm, prune (and optionally escalate).
   * Every failure path returns without mutating the session.
   */
  async function pass(agent, signal, payload) {
    const session = isRecord(agent) ? agent.session : undefined
    if (!isRecord(session)) return
    const sessionId = sessionIdOf(agent)
    if (sessionId.length === 0) return
    const turn = turnKeyOf(sessionId, payload)

    const record = recordFor(sessionId)
    const forced = pendingFor.has(sessionId) ? pendingFor.get(sessionId) : null
    pendingFor.delete(sessionId)
    record.armed = false
    record.enabled = runtimeEnabled

    if (!runtimeEnabled && forced === null) return

    const pruner = resolveService(agent, 'toolResultPruner')
    const compaction = resolveService(agent, 'compaction')
    const allowed = pruner !== undefined || compaction !== undefined
    record.observing = allowed
    record.hasPruner = pruner !== undefined
    record.hasCompaction = compaction !== undefined
    if (!allowed) return

    record.error = ''

    const meter = ctx.get('tokenMeter')
    if (meter === undefined || meter === null || typeof meter.measure !== 'function') {
      record.error = '未挂载 tokenMeter，无法测量上下文压力'
      return
    }
    let measurement
    try {
      measurement = meter.measure(session)
    } catch (error) {
      record.error = `tokenMeter 测量失败：${describe(error)}`
      return
    }
    let pressure = typeof measurement.totalTokens === 'number' ? measurement.totalTokens : 0

    let capacity = readCapacity(session)
    const contextWindow = await contextWindowOf(session, signal, capacity)
    const soft = contextWindow > 0 ? Math.floor(contextWindow * config.softRatio) : config.fallbackSoftTokens
    const hard = contextWindow > 0 ? Math.floor(contextWindow * config.escalateRatio) : config.fallbackHardTokens

    record.pressureTokens = pressure
    record.contextWindow = contextWindow
    record.ratio = contextWindow > 0 ? pressure / contextWindow : 0
    record.softTokens = soft
    record.hardTokens = hard
    record.capacity = capacity

    const live = signal === undefined || signal === null || signal.aborted !== true

    // ── model-free pruning tier, behind a human confirmation ──────────────────
    if ((pressure >= soft || forced !== null) && pruner !== undefined && live) {
      const alreadyAsked = askedTurn.get(sessionId) === turn
      if (!alreadyAsked) {
        const report = await collectCandidates(pruner, sessionId, signal)
        if (report !== null && report.candidates.length > 0) {
          let confirmed = true
          if (config.confirm) {
            const service = ctx.get('userQuestions')
            if (service === undefined || service === null || typeof service.ask !== 'function') {
              confirmed = false
              record.error = '没有可用的提问通道（userQuestions 未挂载），本次不裁剪'
              note(record, 'blocked', record.error)
            } else {
              askedTurn.set(sessionId, turn)
              record.asks += 1
              const question = buildQuestion(report, pressure, record.ratio, contextWindow)
              let answer
              try {
                answer = await askHuman(service, [question], agent, signal)
              } catch (error) {
                answer = null
                record.error = `提问失败，本次不裁剪：${describe(error)}`
                note(record, 'blocked', record.error)
              }
              if (answer === TIMED_OUT) {
                confirmed = false
                record.error = '等待确认超时，本次不裁剪（下一轮会重新询问）'
                note(record, 'blocked', record.error)
              } else if (answer === null) {
                confirmed = false
              } else {
                const { label, custom } = selectionOf(answer, question.id)
                if (label === CONFIRM_LABEL) {
                  confirmed = true
                } else if (label === DISABLE_LABEL) {
                  confirmed = false
                  runtimeEnabled = false
                  record.enabled = false
                  record.error = ''
                  record.lastDetail = '用户关闭了自动压缩'
                  note(record, 'disabled', record.lastDetail)
                } else {
                  confirmed = false
                  record.declined += 1
                  record.lastDetail = `用户选择跳过本次${custom.length > 0 ? `（${custom}）` : ''}`
                  note(record, 'declined', record.lastDetail)
                }
              }
            }
          }

          if (confirmed) {
            let result = null
            try {
              result = pruner.pruneSession(session)
            } catch (error) {
              record.error = `裁剪被会话拒绝：${describe(error)}`
              note(record, 'error', record.error)
            }
            if (result !== null && result !== undefined) {
              const count = Array.isArray(result.pruned) ? result.pruned.length : 0
              const chars = typeof result.charsRemoved === 'number' ? result.charsRemoved : 0
              if (count > 0) {
                let after = pressure
                try {
                  after = meter.measure(session).totalTokens
                } catch {
                  after = pressure
                }
                if (typeof after !== 'number' || !Number.isFinite(after)) after = pressure
                const saved = pressure > after ? pressure - after : 0
                record.confirmed += 1
                record.prunePasses += 1
                record.prunedResults += count
                record.charsRemoved += chars
                record.reclaimedTokens += saved
                record.pressureTokens = after
                record.ratio = contextWindow > 0 ? after / contextWindow : 0
                record.lastDetail = `裁剪 ${count} 条工具输出，省略 ${formatCount(chars)} 字符，回收约 ${formatCount(saved)} tokens`
                note(record, 'prune', record.lastDetail)
                pressure = after
                capacity = readCapacity(session)
                record.capacity = capacity
              } else {
                record.lastDetail = '确认后没有可落盘的替换'
                note(record, 'noop', record.lastDetail)
              }
            }
          }
        } else if (forced !== null) {
          record.lastDetail = '没有可裁剪的超长工具输出'
          note(record, 'noop', record.lastDetail)
        }
      }
    }

    // ── optional summarization tier, delegated to the session's own backend ───
    const wantEscalate = forced === 'escalate' || forced === 'both' || pressure >= hard
    if (config.escalate && compaction !== undefined && live && wantEscalate) {
      try {
        const result = await compaction.compactIfNeeded(agent, 'pressure', signal)
        if (result !== null && result !== undefined) {
          const shadowed = typeof result.shadowedTokenCount === 'number' ? result.shadowedTokenCount : 0
          record.summaries += 1
          record.lastDetail = `摘要压缩，折叠约 ${formatCount(shadowed)} tokens`
          note(record, 'summarize', record.lastDetail)
        }
      } catch (error) {
        record.error = `摘要压缩失败：${describe(error)}`
        note(record, 'error', record.error)
      }
    }
  }

  /** Resolve one LIVE session by id; a persisted-but-cold session has no projection to read. */
  function liveSessionOf(sessionId) {
    const sessions = ctx.get('sessions')
    if (sessions === undefined || typeof sessions.get !== 'function') return undefined
    try {
      const session = sessions.get(sessionId)
      return isRecord(session) ? session : undefined
    } catch {
      return undefined
    }
  }

  /** Best-effort display title, so a capacity list identifies its conversations. */
  function titleOf(session) {
    const titles = ctx.get('sessionTitle')
    if (titles === undefined || typeof titles.get !== 'function') return ''
    try {
      const snapshot = titles.get(session)
      return isRecord(snapshot) && typeof snapshot.title === 'string' ? snapshot.title : ''
    } catch {
      return ''
    }
  }

  /**
   * Capacity usage for EVERY live conversation — the fleet-wide answer to
   * "which dialog is running out of context right now", without needing any of
   * them to have taken a step since this row mounted.
   */
  function listCapacity() {
    const sessions = ctx.get('sessions')
    if (sessions === undefined || typeof sessions.list !== 'function') return []
    let live = []
    try {
      live = sessions.list()
    } catch {
      return []
    }
    const out = []
    for (const session of live) {
      if (!isRecord(session) || typeof session.id !== 'string' || session.id.length === 0) continue
      const record = records.get(session.id)
      out.push({
        sessionId: session.id,
        title: titleOf(session),
        capacity: readCapacity(session),
        armed: pendingFor.has(session.id),
        observing: record === undefined ? false : record.observing,
        prunedResults: record === undefined ? 0 : record.prunedResults,
        reclaimedTokens: record === undefined ? 0 : Math.round(record.reclaimedTokens),
        lastDetail: record === undefined ? '' : record.lastDetail,
      })
    }
    return out
  }

  /**
   * Which shipped surface this process is: `desktop`, `web`, or another profile.
   *
   * Desktop runs the same `dsh-web-app` composition, so every service this row
   * consumes exists there too; the name is reported rather than branched on,
   * because the only transport difference (the `dsh-app://app` scheme) is
   * already handled by the shell's request forwarding.
   */
  function platformName() {
    try {
      const profile = ctx.get('profileContext')
      if (isRecord(profile) && typeof profile.name === 'string' && profile.name.length > 0) return profile.name
    } catch {
      /* absent on embedders that do not mount profileContext */
    }
    return 'web'
  }

  /**
   * What this row can actually do in the running process.
   *
   * Because the row declares no hard dependency it can never fail activation by
   * waiting for a service — but that also means a missing capability degrades
   * silently. This block is how a reader (or a bug report) tells "the plugin is
   * not running" apart from "the plugin is running but something it needs is
   * absent".
   */
  function capabilities() {
    const meter = ctx.get('tokenMeter')
    const query = ctx.get('sessionQuery')
    const projections = ctx.get('sessionProjections')
    const sessions = ctx.get('sessions')
    const webServer = ctx.get('webServer')
    const questions = ctx.get('userQuestions')
    const presets = ctx.get('agentPresets')
    return {
      platform: platformName(),
      meter: meter !== undefined && meter !== null && typeof meter.measure === 'function',
      candidateDiscovery: query !== undefined && query !== null && typeof query.readSurface === 'function',
      capacityProjection: projections !== undefined && projections !== null && typeof projections.snapshot === 'function',
      sessionRegistry: sessions !== undefined && sessions !== null && typeof sessions.list === 'function',
      confirmation: config.confirm && questions !== undefined && questions !== null && typeof questions.ask === 'function',
      presetServices: presets !== undefined && presets !== null && typeof presets.serviceFor === 'function',
      route: webServer !== undefined && webServer !== null && typeof webServer.register === 'function',
    }
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  // Disposal is collected explicitly and released by one fiber effect, so the
  // listener and the route go away together with the row.
  let disposers = []
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* disposal is best-effort */
      }
    }
    disposers = []
  }, `${name}: host runtime`)

  if (!runtimeEnabled) {
    ctx.logger?.info?.('[auto-context-compress] disabled by config')
    return
  }

  // Seed every conversation that already exists, so the read surface answers for
  // any dialog immediately — not only for one that has taken a step since mount.
  try {
    const sessions = ctx.get('sessions')
    if (sessions !== undefined && typeof sessions.list === 'function') {
      for (const session of sessions.list()) {
        if (isRecord(session) && typeof session.id === 'string' && session.id.length > 0) recordFor(session.id)
      }
    }
  } catch (error) {
    ctx.logger?.warn?.(`[auto-context-compress] session seed failed: ${describe(error)}`)
  }

  disposers.push(
    ctx.on('agent/pre-step', async (payload, next) => {
      try {
        const agent = isRecord(payload) ? payload.agent : undefined
        if (isRecord(agent)) {
          const signal = payload.signal
          if (signal === undefined || signal === null || signal.aborted !== true) {
            await pass(agent, signal, payload)
          }
        }
      } catch (error) {
        // A waterfall listener must never break the turn it observes.
        ctx.logger?.warn?.(`[auto-context-compress] pre-step failed: ${describe(error)}`)
      }
      return next()
    }),
  )

  // One conversation is addressed by its id — this is what makes the plugin work
  // for whichever dialog is in front, instead of for a "current" one.
  const webServer = ctx.get('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    try {
      disposers.push(
        webServer.register({
          kind: 'exact',
          path: API_PATH,
          handler: async (req, res) => {
            if (!isLoopbackRequest(req)) {
              writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
              return
            }
            let params
            try {
              params = new URL(req.url ?? '/', 'http://x').searchParams
            } catch {
              params = undefined
            }
            const sessionId = params === undefined ? '' : params.get('session') ?? ''

            // No id: report EVERY conversation's capacity usage. This is the
            // readout that makes the plugin usable across dialogs without the
            // caller knowing which one is "current".
            if (sessionId.length === 0) {
              writeJson(res, 200, {
                ok: true,
                enabled: runtimeEnabled,
                tracked: records.size,
                sessions: listCapacity(),
                capabilities: capabilities(),
                hint: `GET ${API_PATH}?session=<sessionId>[&force=prune|escalate|both]`,
              })
              return
            }

            // Two control verbs a reader (the floating panel) can send for ONE
            // conversation resolved by id: arm a compression, or flip the global
            // master switch. Both are behind the loopback fence above.
            const enabledParam = params === undefined ? '' : params.get('enabled') ?? ''
            if (enabledParam === '0' || enabledParam === '1') {
              runtimeEnabled = enabledParam === '1'
              const toggled = recordFor(sessionId)
              toggled.enabled = runtimeEnabled
              toggled.lastDetail = runtimeEnabled ? '已开启自动压缩' : '已关闭自动压缩'
              note(toggled, 'config', toggled.lastDetail)
            }

            const force = params === undefined ? '' : params.get('force') ?? ''
            if (force === 'prune' || force === 'escalate' || force === 'both') {
              pendingFor.set(sessionId, force)
              const armedRecord = recordFor(sessionId)
              armedRecord.armed = true
              armedRecord.lastDetail = `已按会话 id 预约 ${force}，将在该对话的下一次模型请求前执行`
              note(armedRecord, 'armed', armedRecord.lastDetail)
            }

            const session = liveSessionOf(sessionId)
            if (session === undefined) {
              // Tracked but not live: a cold or unknown conversation. Report it
              // rather than inventing a capacity reading for a session that has
              // no projection to read.
              const record = records.get(sessionId)
              writeJson(res, 200, {
                ok: true,
                sessionId,
                exists: false,
                live: false,
                title: '',
                armed: pendingFor.has(sessionId),
                enabled: runtimeEnabled,
                tracked: records.size,
                capacity: null,
                record: record ?? null,
                capabilities: capabilities(),
              })
              return
            }

            const record = recordFor(sessionId)
            record.enabled = runtimeEnabled
            const capacity = readCapacity(session)
            if (capacity !== null) record.capacity = capacity
            writeJson(res, 200, {
              ok: true,
              sessionId,
              exists: true,
              live: true,
              title: titleOf(session),
              armed: pendingFor.has(sessionId),
              enabled: runtimeEnabled,
              tracked: records.size,
              ...record,
              capacity,
              capabilities: capabilities(),
            })
          },
        }),
      )
    } catch (error) {
      ctx.logger?.warn?.(`[auto-context-compress] route registration failed: ${describe(error)}`)
    }
  } else {
    ctx.logger?.info?.(`[auto-context-compress] no webServer: ${API_PATH} is unavailable, compression still runs`)
  }

  ctx.logger?.info?.(
    `[auto-context-compress] ready: platform=${platformName()} soft=${config.softRatio} hard=${config.escalateRatio} confirm=${config.confirm} escalate=${config.escalate}`,
  )
})
