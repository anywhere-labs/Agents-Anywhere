import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { registerSource } from './helpers/onboarding-source.mjs'
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fixture.example/', pretendToBeVisual: true })
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) Object.defineProperty(globalThis, name, { configurable: true, value: dom.window[name] })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement: h, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const hooks = registerSource()
const { SidebarSwitch } = await import('../src/components/sidebar-switch.tsx')
hooks.deregister()

const track = (container) => container.querySelector('[data-slot="sidebar-track"]')
const layers = (container) => [...container.querySelectorAll('[data-slot="sidebar-layer"]')].map((layer) => ({
  id: layer.textContent,
  state: layer.dataset.state,
  className: layer.className,
  node: layer,
}))
const transitionEnd = (node, propertyName = 'transform') => {
  const event = new window.Event('transitionend', { bubbles: true })
  Object.defineProperty(event, 'propertyName', { value: propertyName })
  return node.dispatchEvent(event)
}

async function mount(t, props) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  const show = async (next) => act(async () => root.render(h(SidebarSwitch, { ...props, ...next }, (id) => h('nav', null, id))))
  await show({})
  t.after(async () => { await act(async () => root.unmount()); container.remove() })
  return { container, show }
}

test('the first sidebar mounts still and a deeper one slides in beside it from the right', async (t) => {
  const { container, show } = await mount(t, { id: 'home', depth: 0 })
  assert.deepEqual(layers(container).map(({ id, state }) => ({ id, state })), [{ id: 'home', state: 'current' }])
  assert.equal(track(container).dataset.state, 'idle')
  assert.equal(track(container).style.transform, '')
  assert.doesNotMatch(track(container).className, /transition-transform/)

  await show({ id: 'admin', depth: 1 })
  const [leaving, entering] = layers(container)
  assert.equal(leaving.id, 'home'); assert.equal(leaving.state, 'leaving')
  assert.match(leaving.className, /pointer-events-none/)
  assert.equal(leaving.node.getAttribute('aria-hidden'), 'true')
  assert.equal(entering.id, 'admin'); assert.equal(entering.state, 'current')
  const rail = track(container)
  assert.equal(rail.dataset.state, 'sliding')
  assert.match(rail.className, /w-\[200%\] .*transition-transform/)
  assert.match(rail.className, /ease-\[cubic-bezier/, 'the slide is not linear')
  assert.equal(rail.style.transform, 'translateX(-50%)', 'the track rests one sidebar width to the left')
  assert.ok(layers(container).every(({ className }) => /w-1\/2/.test(className)), 'both sidebars share the track side by side')

  await act(async () => transitionEnd(rail))
  assert.deepEqual(layers(container).map(({ id }) => id), ['admin'])
  assert.equal(rail.dataset.state, 'idle')
  assert.equal(rail.style.transform, '')
})

test('going back slides the shallower sidebar in from the left', async (t) => {
  const { container, show } = await mount(t, { id: 'admin', depth: 1 })
  await show({ id: 'home', depth: 0 })
  const [entering, leaving] = layers(container)
  assert.equal(entering.id, 'home'); assert.equal(entering.state, 'current')
  assert.equal(leaving.id, 'admin'); assert.equal(leaving.state, 'leaving')
  assert.equal(track(container).style.transform, 'translateX(0%)', 'the track comes back to rest at the start')
  assert.equal(track(container).style.transition, '', 'the transition is handed back to the stylesheet after pinning the start')
  // A child's transition ending must not drop the leaving sidebar early.
  await act(async () => transitionEnd(leaving.node))
  assert.equal(layers(container).length, 2)
  await act(async () => transitionEnd(track(container), 'opacity'))
  assert.equal(layers(container).length, 2)
})

test('a leaving sidebar is dropped by the fallback timer where transition events never fire', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { container, show } = await mount(t, { id: 'home', depth: 0 })
  await show({ id: 'settings', depth: 1 })
  assert.equal(layers(container).length, 2)
  await act(async () => t.mock.timers.tick(500))
  assert.deepEqual(layers(container).map(({ id }) => id), ['settings'])
})

test('reversing midway keeps both sidebars where they are and only changes the target', async (t) => {
  const { container, show } = await mount(t, { id: 'home', depth: 0 })
  await show({ id: 'admin', depth: 1 })
  const [homeBefore, adminBefore] = layers(container)
  await show({ id: 'home', depth: 0 })
  const [homeAfter, adminAfter] = layers(container)
  assert.equal(homeAfter.node, homeBefore.node); assert.equal(homeAfter.state, 'current')
  assert.equal(adminAfter.node, adminBefore.node); assert.equal(adminAfter.state, 'leaving')
  assert.equal(track(container).style.transform, 'translateX(0%)')
})
