/**
 * Smoke test for dsh-auto-context-compress.
 *
 * There is no test framework here on purpose: the plugin is plain ESM with zero
 * dependencies, so a fake host context is enough to exercise every decision path
 * that matters — confirm, decline, timeout, missing channel, missing service,
 * and the id-addressed per-conversation behaviour.
 *
 * Run: node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { apply, inject, name, resolveConfig } from '../lib/index.js'

const CONFIRM_LABEL = '确认裁剪'
const SKIP_LABEL = '跳过本次'
const BIG_TEXT = 'A'.repeat(20000)

// ── module surface ──────────────────────────────────────────────────────────
assert.equal(name, 'auto-context-compress')
assert.deepEqual(
  inject,
  ['webServer', 'sessions'],
  'the web carrier MUST be a real dependency, or apply() runs before it exists and the route is never created',
)
assert.equal(typeof apply, 'function')

// ── config validation ───────────────────────────────────────────────────────
const defaults = resolveConfig({})
assert.equal(defaults.enabled, true)
assert.equal(defaults.confirm, true)
assert.equal(defaults.softRatio, 0.5)
assert.equal(defaults.escalate, false)
assert.equal(Object.isFrozen(defaults), true)

// hard thresholds may not fall below soft ones; they are clamped, not rejected.
const clamped = resolveConfig({ softRatio: 0.6, hardRatio: 0.5, escalateRatio: 0.4 })
assert.equal(clamped.hardRatio, 0.6)
assert.equal(clamped.escalateRatio, 0.6)

assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key "nope"/)
assert.throws(() => resolveConfig({ softRatio: 2 }), /softRatio must be a number in/)
assert.throws(() => resolveConfig({ confirm: 'yes' }), /confirm must be a boolean/)
assert.throws(() => resolveConfig({ maxDetailCandidates: 0 }), /must be an integer >= 1/)

// ── a fake host context good enough to drive apply() ────────────────────────
/** A tool/result big enough to prune, at a per-session seq. */
function bigResult(seq, callId, tool) {
  return {
    type: 'tool/result',
    seq,
    data: { message: { callId, name: tool, content: [{ type: 'text', text: BIG_TEXT }] } },
  }
}

/** The harness whose fiber effects are still installed; torn down before the next mount. */
let liveHarness = null

function buildHarness(options = {}) {
  // The plugin keeps a process-global single-instance guard (mountOnce) that only
  // a fiber disposal releases, so each scenario must really unmount the previous
  // mount — otherwise every scenario after the first would silently no-op.
  if (liveHarness !== null) liveHarness.unmount()

  const sessionIds = options.sessionIds ?? ['session-1']
  const live = new Map()
  for (const id of sessionIds) {
    live.set(id, { id, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) })
  }

  const state = {
    asked: 0,
    questions: [],
    pruned: new Map(),
    listener: null,
    listenerRegistrations: 0,
    nextCalls: 0,
    route: null,
    disposers: [],
  }

  let measureCount = 0
  const pressureFirst = options.pressure ?? 150000
  const pressureAfter = options.pressureAfter ?? 120000

  const pruner = {
    measureContent: (blocks) =>
      Array.isArray(blocks) && blocks[0] && typeof blocks[0].text === 'string' ? blocks[0].text.length : 0,
    pruneContent: (blocks) => {
      const size = blocks[0].text.length
      if (size <= 8192) return null
      return [{ type: 'text', text: `${blocks[0].text.slice(0, 4096)}\n...\n${blocks[0].text.slice(size - 1024)}` }]
    },
    pruneSession: (session) => {
      state.pruned.set(session.id, (state.pruned.get(session.id) ?? 0) + 1)
      return {
        pruned: [{ originalSeq: 5, replacementSeq: 9, callId: 'call-1', charsBefore: 20000, charsAfter: 5145 }],
        charsRemoved: 14855,
      }
    },
  }

  const ctx = {
    tokenMeter: {
      measure: () => {
        measureCount += 1
        return { totalTokens: measureCount === 1 ? pressureFirst : pressureAfter, logRevision: measureCount }
      },
    },
    timeout: options.timeout ?? (() => new Promise(() => {})),
    logger: { info: () => {}, warn: () => {} },
    effect: (callback) => {
      const disposer = callback()
      state.disposers.push(disposer)
      return () => {}
    },
    on: (event, listener) => {
      if (event === 'agent/pre-step') {
        state.listener = listener
        state.listenerRegistrations += 1
      }
      return () => {}
    },
    get: (key) => {
      if (key === 'tokenMeter') return ctx.tokenMeter
      if (key === 'timer') return { timeout: options.timeout ?? (() => new Promise(() => {})) }
      if (key === 'agentPresets') {
        return {
          serviceFor: (_agent, serviceName) =>
            serviceName === 'toolResultPruner' && options.pruner !== false ? pruner : undefined,
        }
      }
      if (key === 'sessions') {
        if (options.sessionsService === false) return undefined
        return {
          list: () => [...live.values()],
          get: (id) => live.get(id),
        }
      }
      if (key === 'webServer') {
        if (options.webServer === false) return undefined
        return {
          register: (route) => {
            state.route = route
            return () => {}
          },
        }
      }
      if (key === 'sessionProjections') {
        if (options.projections === false) return undefined
        return {
          snapshot: () => ({
            values: {
              contextPressure: { pressureTokens: 90000, projectedTokens: 100000, contextWindow: 200000 },
              contextBreakdown: { systemTokens: 5000, toolsTokens: 20000, messageTokens: 75000 },
            },
          }),
        }
      }
      if (key === 'sessionQuery') {
        if (options.query === false) return undefined
        return {
          readSurface: async (sessionId) => ({
            events: [
              { type: 'user/message', seq: 1, data: {} },
              bigResult(sessionId === 'session-2' ? 55 : 5, `call-${sessionId}`, sessionId === 'session-2' ? 'grep' : 'read'),
              { type: 'tool/result', seq: 7, data: { message: { callId: 'small', name: 'ls', content: [{ type: 'text', text: 'tiny' }] } } },
            ],
          }),
        }
      }
      if (key === 'userQuestions') {
        if (options.questions === false) return undefined
        return {
          ask: async (request) => {
            state.asked += 1
            state.questions.push(request.questions[0])
            if (options.onAsk) return options.onAsk(request)
            const label = options.answer ?? CONFIRM_LABEL
            return {
              answers: [{ id: request.questions[0].id, selected: label.length > 0 ? [label] : [], custom: options.custom }],
            }
          },
        }
      }
      return undefined
    },
  }

  const harness = {
    ctx,
    state,
    /** Release every fiber effect this mount installed, including the mount guard. */
    unmount() {
      for (const dispose of state.disposers.splice(0)) {
        try {
          dispose()
        } catch {
          /* disposal is best-effort */
        }
      }
    },
    async dispatch(sessionId = sessionIds[0], turn = 1) {
      const session = live.get(sessionId)
      const payload = { agent: { id: sessionId, session }, turn, step: 1, signal: { aborted: false } }
      return state.listener(payload, () => {
        state.nextCalls += 1
        return 'next-result'
      })
    },
    async callRoute(url, headers = {}) {
      const req = {
        url,
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: '127.0.0.1:3080', ...headers },
      }
      const res = {
        statusCode: 0,
        headers: {},
        body: undefined,
        writeHead(status, extra) {
          this.statusCode = status
          Object.assign(this.headers, extra ?? {})
        },
        end(text) {
          this.body = JSON.parse(text)
        },
      }
      await state.route.handler(req, res)
      return res
    },
  }
  liveHarness = harness
  return harness
}

// ── 1. confirmed: asks first, then prunes ───────────────────────────────────
{
  const h = buildHarness()
  apply(h.ctx, {})
  assert.equal(typeof h.state.listener, 'function', 'must register an agent/pre-step listener')

  const result = await h.dispatch()
  assert.equal(result, 'next-result', 'the waterfall must continue')
  assert.equal(h.state.nextCalls, 1)
  assert.equal(h.state.asked, 1, 'the human must be asked before any rewrite')
  assert.equal(h.state.pruned.get('session-1'), 1, 'a confirmed answer performs the rewrite')

  const question = h.state.questions[0]
  assert.equal(question.options[0].label, CONFIRM_LABEL)
  assert.match(question.detail, /seq 5/)
  assert.match(question.detail, /工具 `read`/)
  assert.match(question.detail, /callId call-session-1/)
  assert.match(question.detail, /将被替换为省略标记/, 'the preview must show what gets omitted')
  assert.match(question.detail, /原始事件完整保留在会话日志中/)
  assert.doesNotMatch(question.detail, /工具 `ls`/, 'a small result is not a candidate')
  assert.match(question.question, /1 条工具输出/)
}

// ── 2. declined: asks, then leaves the session untouched ────────────────────
{
  const h = buildHarness({ answer: SKIP_LABEL })
  apply(h.ctx, {})
  await h.dispatch()
  assert.equal(h.state.asked, 1)
  assert.equal(h.state.pruned.size, 0, 'a declined answer must not rewrite anything')
}

// ── 3. one turn never asks twice ────────────────────────────────────────────
{
  const h = buildHarness({ answer: SKIP_LABEL })
  apply(h.ctx, {})
  await h.dispatch('session-1', 1)
  await h.dispatch('session-1', 1)
  assert.equal(h.state.asked, 1, 'the same turn must not re-ask')
  await h.dispatch('session-1', 2)
  assert.equal(h.state.asked, 2, 'the next turn may ask again')
}

// ── 4. timeout is fail-closed ───────────────────────────────────────────────
{
  const h = buildHarness({
    timeout: () => Promise.resolve(),
    onAsk: (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  })
  apply(h.ctx, {})
  await h.dispatch()
  assert.equal(h.state.asked, 1)
  assert.equal(h.state.pruned.size, 0, 'a withdrawn confirmation must not prune')
}

// ── 5. no question channel: refuse rather than act silently ─────────────────
{
  const h = buildHarness({ questions: false })
  apply(h.ctx, {})
  await h.dispatch()
  assert.equal(h.state.asked, 0)
  assert.equal(h.state.pruned.size, 0, 'without a channel there is no consent, so no rewrite')
}

// ── 6. a preset that mounts no pruner is simply skipped ─────────────────────
{
  const h = buildHarness({ pruner: false })
  apply(h.ctx, {})
  await h.dispatch()
  assert.equal(h.state.pruned.size, 0)
  assert.equal(h.state.asked, 0)
}

// ── 7. confirm:false is the explicit opt-out of the confirmation ────────────
{
  const h = buildHarness()
  apply(h.ctx, { confirm: false })
  await h.dispatch()
  assert.equal(h.state.asked, 0, 'confirm:false must not ask')
  assert.equal(h.state.pruned.get('session-1'), 1, 'confirm:false prunes without asking')
}

// ── 8. below the soft threshold nothing happens at all ──────────────────────
{
  const h = buildHarness({ pressure: 1000, pressureAfter: 1000 })
  apply(h.ctx, { softRatio: 0.99 })
  await h.dispatch()
  assert.equal(h.state.asked, 0)
  assert.equal(h.state.pruned.size, 0)
}

// ── 9. every existing conversation is seeded at mount ───────────────────────
{
  const h = buildHarness({ sessionIds: ['session-1', 'session-2', 'session-3'] })
  apply(h.ctx, {})
  const res = await h.callRoute('/api/auto-context-compress?session=session-3')
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.sessionId, 'session-3')
  assert.equal(res.body.exists, true)
  assert.equal(res.body.tracked, 3, 'all seeded conversations are addressable before any step')
}

// ── 10. no id lists EVERY conversation; an id addresses exactly one ─────────
{
  const h = buildHarness({ sessionIds: ['session-1', 'session-2'] })
  apply(h.ctx, {})
  const all = await h.callRoute('/api/auto-context-compress')
  assert.equal(all.statusCode, 200)
  assert.deepEqual(all.body.sessions.map((s) => s.sessionId), ['session-1', 'session-2'])
  const other = await h.callRoute('/api/auto-context-compress?session=session-2')
  assert.equal(other.body.sessionId, 'session-2')
  assert.equal(other.body.exists, true)
  assert.equal(other.body.live, true)
}

// ── 11. force is per conversation, and only that conversation is touched ────
{
  const h = buildHarness({ sessionIds: ['session-1', 'session-2'] })
  apply(h.ctx, {})
  const armed = await h.callRoute('/api/auto-context-compress?session=session-2&force=prune')
  assert.equal(armed.body.armed, true, 'the armed flag is reported back for that conversation')

  await h.dispatch('session-2', 1)
  await h.dispatch('session-1', 1)

  assert.equal(h.state.pruned.get('session-2'), 1)
  assert.equal(h.state.pruned.get('session-1'), 1)
  const askedFor = h.state.questions.map((q) => q.detail)
  assert.match(askedFor[0], /callId call-session-2/, 'session-2 was offered its OWN content')
  assert.match(askedFor[1], /callId call-session-1/, 'session-1 was offered its own content')
}

// ── 12. a forced request arms only its own conversation ─────────────────────
{
  const h = buildHarness({
    sessionIds: ['session-1', 'session-2'],
    pressure: 1000,
    pressureAfter: 1000,
  })
  apply(h.ctx, { softRatio: 1 })
  // session-2 never takes a step, so its arming must stay pending and inert.
  await h.callRoute('/api/auto-context-compress?session=session-2&force=prune')
  const state = await h.callRoute('/api/auto-context-compress?session=session-2')
  assert.equal(state.body.armed, true)
  await h.dispatch('session-1', 1)
  assert.equal(h.state.pruned.size, 0, 'session-1 was not armed and is below threshold')
  const still = await h.callRoute('/api/auto-context-compress?session=session-2')
  assert.equal(still.body.armed, true, "session-2's arming survives another conversation's step")
}

// ── 13. capacity usage is detected per conversation from the projection ─────
{
  const h = buildHarness({ sessionIds: ['session-1', 'session-2'] })
  apply(h.ctx, {})
  const all = await h.callRoute('/api/auto-context-compress')
  assert.equal(all.body.sessions.length, 2)
  for (const entry of all.body.sessions) {
    const cap = entry.capacity
    assert.equal(cap.usedTokens, 100000, 'usedTokens prefers projectedTokens over pressureTokens')
    assert.equal(cap.pressureTokens, 90000)
    assert.equal(cap.contextWindow, 200000)
    assert.equal(cap.ratio, 0.5)
    assert.equal(cap.level, 'soft', 'the reading is classified against this row own thresholds')
    assert.deepEqual(cap.breakdown, { systemTokens: 5000, toolsTokens: 20000, messageTokens: 75000 })
  }
  const one = await h.callRoute('/api/auto-context-compress?session=session-2')
  assert.equal(one.body.capacity.level, 'soft')
  assert.equal(one.body.exists, true)
}

// ── 14. a conversation with no live session reports no capacity, not a guess ─
{
  const h = buildHarness({ sessionIds: ['session-1'] })
  apply(h.ctx, {})
  const cold = await h.callRoute('/api/auto-context-compress?session=not-live')
  assert.equal(cold.statusCode, 200)
  assert.equal(cold.body.exists, false)
  assert.equal(cold.body.live, false)
  assert.equal(cold.body.capacity, null, 'no projection to read means no invented reading')
}

// ── 15. without the projection service the reading degrades to null ─────────
{
  const h = buildHarness({ sessionIds: ['session-1'], projections: false })
  apply(h.ctx, {})
  const one = await h.callRoute('/api/auto-context-compress?session=session-1')
  assert.equal(one.body.exists, true)
  assert.equal(one.body.capacity, null)
  assert.equal(one.body.contextWindow, 0, 'the trigger falls back to the absolute token budget')
}

// ── 16. the route fence refuses anything but a same-origin loopback caller ──
{
  const h = buildHarness({ sessionIds: ['session-1'] })
  apply(h.ctx, {})

  const crossSite = await h.callRoute('/api/auto-context-compress?session=session-1&force=prune', {
    'sec-fetch-site': 'cross-site',
    origin: 'http://evil.example',
  })
  assert.equal(crossSite.statusCode, 403, 'a cross-site fetch must be refused')

  const foreignHost = await h.callRoute('/api/auto-context-compress?session=session-1', {
    host: 'attacker.example',
  })
  assert.equal(foreignHost.statusCode, 403, 'a non-loopback Host must be refused (DNS rebinding)')

  const originMismatch = await h.callRoute('/api/auto-context-compress?session=session-1', {
    origin: 'http://other.example',
  })
  assert.equal(originMismatch.statusCode, 403, 'an Origin that is not the Host must be refused')

  const legit = await h.callRoute('/api/auto-context-compress?session=session-1')
  assert.equal(legit.statusCode, 200, 'a same-origin loopback caller is allowed')
  assert.equal(legit.body.capabilities.route, true)
  assert.equal(legit.body.capabilities.meter, true)
}

// ── 17. a second mount of the same package is a no-op ───────────────────────
{
  const h = buildHarness({ sessionIds: ['session-1'] })
  apply(h.ctx, {})
  apply(h.ctx, {})
  assert.equal(h.state.listenerRegistrations, 1, 'a duplicate mount must not add a second pre-step listener')

  await h.dispatch('session-1', 1)
  assert.equal(h.state.asked, 1, 'and therefore must not produce a second confirmation card')
}

console.log('smoke: all 17 scenarios passed')
