// Dev-time verification of the browser half.
//
// The real page is not available here, so this evaluates lib/client.js under the
// __ModuleLoader__ contract inside a vm with a stub DOM and a stub fetch, then
// DRIVES it: renders one route payload, switches the current conversation, clicks
// both buttons, and disposes. That is far stronger than checking the exports —
// it is the only way to catch a broken render path without opening a browser.
//
// Run: node test/client-check.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ── stub DOM ────────────────────────────────────────────────────────────────
function makeElement(tag) {
  const el = {
    tagName: tag,
    children: [],
    dataset: {},
    style: { cssText: '' },
    attributes: {},
    listeners: {},
    textContent: '',
    title: '',
    type: '',
    disabled: false,
    parent: null,
    offsetWidth: 236,
    offsetHeight: 140,
    appendChild(child) {
      child.parent = this
      this.children.push(child)
      return child
    },
    remove() {
      if (this.parent !== null) {
        const index = this.parent.children.indexOf(this)
        if (index >= 0) this.parent.children.splice(index, 1)
        this.parent = null
      }
    },
    setAttribute(key, value) {
      this.attributes[key] = String(value)
    },
    removeAttribute(key) {
      delete this.attributes[key]
    },
    toggleAttribute(key, force) {
      if (force === true) this.attributes[key] = ''
      else delete this.attributes[key]
    },
    addEventListener(type, fn) {
      if (this.listeners[type] === undefined) this.listeners[type] = []
      this.listeners[type].push(fn)
    },
    dispatch(type) {
      for (const fn of this.listeners[type] ?? []) fn({ button: 0, clientX: 0, clientY: 0, pointerId: 1, preventDefault() {} })
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 236, height: 140 }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  }
  return el
}

const head = makeElement('head')
const body = makeElement('body')
const documentStub = {
  head,
  body,
  createElement: (tag) => makeElement(tag),
  querySelector(selector) {
    const match = /data-plugin-css="([^"]+)"/.exec(selector)
    if (match === null) return null
    for (const child of head.children) {
      if (child.tagName === 'style' && child.dataset.pluginCss === match[1]) return child
    }
    return null
  },
}

// ── stub host route + session store ─────────────────────────────────────────
const state = {
  current: 'session-A',
  fetches: [],
  subscribeRef: null,
  unsubscribed: false,
  payload: {
    ok: true,
    sessionId: 'session-A',
    exists: true,
    live: true,
    title: 'demo 对话',
    enabled: true,
    armed: false,
    capacity: {
      usedTokens: 458742,
      pressureTokens: 458334,
      projectedTokens: 458742,
      contextWindow: 1000000,
      ratio: 0.458742,
      level: 'ok',
      breakdown: { systemTokens: 4519, toolsTokens: 10398, messageTokens: 404957 },
    },
    prunedResults: 3,
    reclaimedTokens: 41200,
    summaries: 0,
    lastDetail: '裁剪 3 条工具输出',
    error: '',
  },
}

const fetchStub = async (url) => {
  state.fetches.push(url)
  const sessionId = /[?&]session=([^&]*)/.exec(url)?.[1] ?? ''
  return {
    ok: true,
    async json() {
      return { ...state.payload, sessionId: decodeURIComponent(sessionId) }
    },
  }
}

const localStorageStub = {
  store: new Map(),
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null
  },
  setItem(key, value) {
    this.store.set(key, String(value))
  },
  removeItem(key) {
    this.store.delete(key)
  },
}

let registration = null
let intervalId = 0
const sandbox = {
  window: {},
  console,
  Symbol,
  Object,
  document: documentStub,
  localStorage: localStorageStub,
  fetch: fetchStub,
  setInterval: () => {
    intervalId += 1
    return intervalId
  },
  clearInterval: () => {},
  __ModuleLoader__: {
    load(reg) {
      registration = reg
    },
  },
}
sandbox.window.__ModuleLoader__ = sandbox.__ModuleLoader__
vm.createContext(sandbox)
vm.runInContext(code, sandbox)

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// ── 1. registration + exports ───────────────────────────────────────────────
assert.notEqual(registration, null, 'the bundle must register with __ModuleLoader__')
assert.equal(registration.id, 'dsh-auto-context-compress')

const exportsObj = registration.factory((spec) => {
  throw new Error(`unexpected require: ${spec}`)
})
assert.equal(typeof exportsObj.apply, 'function')
// `Array.from` re-creates the array in THIS realm: the vm's own Array prototype
// is a different one, which deepStrictEqual rejects as non-reference-equal.
assert.deepEqual(Array.from(exportsObj.inject), ['sessions'])

// ── 2. apply renders a box with the current conversation's capacity ─────────
function makeContext(options = {}) {
  const local = {
    currentId: options.currentId ?? 'session-A',
    listSubscriber: null,
    currentSubscriber: null,
    listUnsubscribed: false,
    currentUnsubscribed: false,
    ui: undefined,
  }
  const makeUi = () => ({
    current: {
      getSnapshot: () => ({ key: local.currentId }),
      subscribe: (fn) => {
        local.currentSubscriber = fn
        return () => {
          local.currentUnsubscribed = true
        }
      },
    },
  })
  if (options.uiSession !== false) local.ui = makeUi()
  const sessions = {
    list: {
      // DSH 0.2: { ids, byId, phase }. 0.1 kept a flat `current`; the list rows
      // carry `retainedBy.mainView`, which is what the shipped UI reads.
      getSnapshot: () =>
        options.legacyCurrent !== undefined
          ? { current: options.legacyCurrent }
          : {
              ids: Object.keys(options.byId ?? defaultRows),
              byId: options.byId ?? defaultRows,
              phase: 'ready',
            },
      subscribe: (fn) => {
        local.listSubscriber = fn
        return () => {
          local.listUnsubscribed = true
        }
      },
    },
  }
  local.ctx = {
    effect(fn, label) {
      assert.equal(label, 'dsh-auto-context-compress: overlay')
      local.disposer = fn()
      return local.disposer
    },
    get(name) {
      if (name === 'sessions') return sessions
      if (name === 'uiSession') return local.ui
      return undefined
    },
  }
  local.enableUi = () => {
    local.ui = makeUi()
  }
  return local
}

const defaultRows = {
  'session-A': { id: 'session-A', retainedBy: { mainView: 1 } },
  'session-B': { id: 'session-B', retainedBy: {} },
}

const first = makeContext({ currentId: 'session-A' })
exportsObj.apply(first.ctx, { pollMs: 2000, position: 'top-right', visible: true })
assert.equal(typeof first.disposer, 'function', 'apply must install a disposer through ctx.effect')
assert.equal(body.children.length, 1, 'the overlay box must be appended to document.body')

const box = body.children[0]
assert.equal(box.dataset.acx, 'box')
assert.equal(box.attributes['data-position'], 'top-right')

await tick()
await tick()

assert.equal(box.attributes['data-level'], 'ok', 'the level drives the colour')
assert.equal(state.fetches.length >= 1, true, 'it must poll the host route')
assert.match(
  state.fetches[0],
  /^api\/auto-context-compress\?session=session-A$/,
  'the route is document-relative so path-prefixed Web and dsh-app:// both resolve',
)

const bodyEl = box.children.find((c) => c.dataset.acx === 'body')
assert.match(bodyEl.textContent, /demo 对话/)
assert.match(bodyEl.textContent, /占用 45\.9%/, 'the percentage must be rendered')
assert.match(bodyEl.textContent, /458\.7k \/ 1M/, 'used / window must be rendered')
assert.match(bodyEl.textContent, /级别 ok/)

const gauge = box.children.find((c) => c.dataset.acx === 'gauge')
const fill = gauge.children[0]
assert.equal(fill.style.width, '45.9%', 'the gauge must be sized to the ratio')

const allText = JSON.stringify(box.children.map((c) => c.textContent))
assert.match(allText, /已裁剪 3 条/, 'the prune tally must be rendered')
assert.match(allText, /41\.2k/, 'the reclaimed tokens must be rendered')
assert.match(allText, /系统 4\.5k/)

// ── 3. it follows `uiSession.current` when the conversation switches ────────
assert.equal(typeof first.currentSubscriber, 'function', 'it must subscribe to uiSession.current')
assert.equal(typeof first.listSubscriber, 'function', 'it must also subscribe to the session list')
first.currentId = 'session-B'
first.currentSubscriber()
await tick()
await tick()
assert.match(
  state.fetches[state.fetches.length - 1],
  /session=session-B/,
  'switching dialogs must re-poll the NEW conversation',
)

// ── 4. the two control buttons issue the right verbs ────────────────────────
const actions = box.children.find((c) => c.dataset.acx === 'actions')
const [forceBtn, toggleBtn] = actions.children
assert.equal(forceBtn.textContent, '立即压缩')
assert.equal(toggleBtn.textContent, '自动：开')
assert.equal(toggleBtn.attributes['data-on'], 'true')

toggleBtn.dispatch('click')
await tick()
await tick()
assert.match(state.fetches[state.fetches.length - 1], /enabled=0/, 'the toggle must send enabled=0')

forceBtn.dispatch('click')
await tick()
await tick()
assert.match(state.fetches[state.fetches.length - 1], /force=prune/, 'the button must arm a prune')

// ── 5. dispose removes every node, listener and the stylesheet ──────────────
assert.equal(head.children.length, 1, 'the stylesheet tag must exist while mounted')
first.disposer()
assert.equal(body.children.length, 0, 'dispose must remove the overlay from the page')
assert.equal(head.children.length, 0, 'dispose must remove the stylesheet')
assert.equal(first.listUnsubscribed, true, 'dispose must unsubscribe from the session list')
assert.equal(first.currentUnsubscribed, true, 'dispose must unsubscribe from uiSession.current')

// ── 6. no uiSession yet: the retention count still picks the main dialog ────
{
  const rows = {
    'session-A': { id: 'session-A', retainedBy: {} },
    'session-B': { id: 'session-B', retainedBy: { mainView: 1 } },
  }
  const fallback = makeContext({ uiSession: false, byId: rows })
  const before = state.fetches.length
  exportsObj.apply(fallback.ctx, { visible: true })
  await tick()
  await tick()
  assert.equal(state.fetches.length, before + 1, 'a session must be found without uiSession')
  assert.match(state.fetches[state.fetches.length - 1], /session=session-B$/)
  fallback.disposer()
  assert.equal(body.children.length, 0)
  assert.equal(head.children.length, 0)
}

// ── 7. a late uiSession is adopted on the next refresh ──────────────────────
{
  const late = makeContext({
    uiSession: false,
    byId: { 'session-A': { id: 'session-A', retainedBy: {} } },
  })
  const before = state.fetches.length
  exportsObj.apply(late.ctx, { visible: true })
  await tick()
  await tick()
  assert.equal(state.fetches.length, before, 'no current dialog means no session request')

  late.currentId = 'session-C'
  late.enableUi()
  late.listSubscriber()
  await tick()
  await tick()
  assert.match(state.fetches[state.fetches.length - 1], /session=session-C$/, 'the late service is picked up')
  late.disposer()
  assert.equal(body.children.length, 0)
  assert.equal(head.children.length, 0)
  assert.equal(late.currentUnsubscribed, true, 'the late subscription is released on dispose')
}

// ── 8. the 0.1 flat `current` snapshot is still readable ────────────────────
{
  const legacy = makeContext({ uiSession: false, legacyCurrent: 'session-B' })
  exportsObj.apply(legacy.ctx, { visible: true })
  await tick()
  await tick()
  assert.match(state.fetches[state.fetches.length - 1], /session=session-B$/, 'the legacy shape is a fallback')
  legacy.disposer()
  assert.equal(body.children.length, 0)
  assert.equal(head.children.length, 0)
}

console.log('client-check: all 8 groups passed')
