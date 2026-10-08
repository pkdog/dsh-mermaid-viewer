/**
 * Local smoke test for one diagram card: the viewer renders a zoom viewport
 * with its persistent toolbar, the fit scale comes from the measured viewport,
 * stepping and double-click move between fit and fixed scales, the full-screen
 * control calls the element API, and Escape still closes the dialog.
 *
 * jsdom implements neither layout nor SVG geometry, so the test supplies the
 * viewBox and element sizes a browser would report. Drawing itself needs a real
 * browser and is covered by the manual check in the README.
 *
 * Usage: node scripts/smoke-diagram-card.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** React and jsdom come from the Harness checkout this bundle is installed beside. */
const HARNESS = '/Users/chengyunquan/tools/deepseek-harness'
const require = createRequire(join(HARNESS, 'packages/client/ui-primitives/package.json'))
const { JSDOM } = require('jsdom')

const SOURCE = 'flowchart LR\n  A[Start] --> B[Ship]'
/** Drawing size the fake mermaid svg reports. */
const VIEW_BOX = { width: 2000, height: 1000 }
/** Viewport size the fake layout reports. */
const BOX = { width: 900, height: 400 }

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.Element = dom.window.Element
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => BOX.width })
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => BOX.height })
Object.defineProperty(dom.window.SVGElement.prototype, 'viewBox', {
  configurable: true,
  get: () => ({ baseVal: { width: VIEW_BOX.width, height: VIEW_BOX.height } }),
})
dom.window.ResizeObserver = class {
  constructor(callback) { this.callback = callback }
  observe() { this.callback([]) }
  disconnect() {}
}
dom.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
const fullscreenCalls = []
dom.window.Element.prototype.requestFullscreen = function requestFullscreen() {
  fullscreenCalls.push(this)
  return Promise.resolve()
}

const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')

const registrations = []
dom.window.__ModuleLoader__ = { load: registration => registrations.push(registration) }
// eslint-disable-next-line no-new-func -- the bundle is a classic script in the browser
new Function(readFileSync(join(PLUGIN_DIR, 'client.js'), 'utf8'))()

const registration = registrations[0]
if (registration === undefined) throw new Error('the client bundle did not register')
if (registration.id !== '@local/dsh-mermaid-viewer') throw new Error(`unexpected owner ${registration.id}`)

const fakeMermaid = {
  initialize() {},
  async parse() { return true },
  async render(id) {
    return {
      svg: `<svg id="${id}" viewBox="0 0 ${VIEW_BOX.width} ${VIEW_BOX.height}" width="100%"`
        + ` style="max-width:${VIEW_BOX.width}px"><g><rect width="10" height="10"/></g></svg>`,
    }
  },
}
const factoryRequire = specifier => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require ${specifier}`)
}
factoryRequire.async = specifier => {
  if (specifier !== './client.mermaid.js') throw new Error(`unexpected async require ${specifier}`)
  return Promise.resolve(fakeMermaid)
}

const dictionaries = {}
const contributions = {}
const plugin = registration.factory(factoryRequire)
plugin.apply({
  effect: run => { run() },
  locale: { register: (namespace, dicts) => { dictionaries[namespace] = dicts } },
  slots: {
    inject: (name, contribute) => { contributions[name] = contribute() },
    register: (spec, component) => ({ spec, component }),
  },
})

const action = contributions['conversation.chat.assistant-actions']
const overlay = contributions['shell.overlay']
if (action === undefined || overlay === undefined) throw new Error('the bundle did not fill both seats')
if (document.head.querySelector('style[data-plugin="@local/dsh-mermaid-viewer"]') === null) {
  throw new Error('the bundle did not inject its stylesheet')
}

const t = (key, params) => {
  const template = dictionaries['dsh-mermaid-viewer'].zh[key]
  if (template === undefined) throw new Error(`missing Simplified Chinese copy for ${key}`)
  return Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), template)
}
const viewer = overlay.spec.inject()
const useViewer = selector => selector(React.useSyncExternalStore(
  viewer.hooks.viewer.subscribe,
  viewer.hooks.viewer.getSnapshot,
))

const container = document.createElement('div')
document.body.appendChild(container)
const root = createRoot(container)
const render = () => act(async () => {
  root.render(React.createElement(overlay.component, { useViewer, close: viewer.close, t }))
})
const click = element => act(async () => {
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
const doubleClick = element => act(async () => {
  element.dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 100 }))
})
const percent = () => container.querySelector('.dshmm-zoom-value').textContent
const transform = () => container.querySelector('.dshmm-surface').style.transform
const tool = label => {
  const found = [...container.querySelectorAll('.dshmm-tool')]
    .find(button => button.getAttribute('aria-label') === label)
  if (found === undefined) throw new Error(`no toolbar control labelled ${label}`)
  return found
}

await render()
if (container.querySelector('.dshmm-backdrop') !== null) throw new Error('the viewer rendered while closed')

await act(async () => { action.spec.inject().open([SOURCE]) })
const styleText = document.head.querySelector('style[data-plugin="@local/dsh-mermaid-viewer"]').textContent
for (const element of container.querySelectorAll('[class]')) {
  for (const name of element.classList) {
    if (!styleText.includes(`.${name}`)) throw new Error(`the stylesheet has no rule for ${name}`)
  }
}
const toolbar = container.querySelector('.dshmm-toolbar')
if (toolbar === null || toolbar.getAttribute('aria-label') !== '缩放控件') throw new Error('the toolbar is missing')
const viewport = container.querySelector('.dshmm-viewport')
if (viewport === null) throw new Error('the zoom viewport is missing')
if (viewport.style.height !== '450px') throw new Error(`unexpected viewport height ${viewport.style.height}`)
if (percent() !== '45%') throw new Error(`unexpected fit scale ${percent()}`)
if (transform() !== 'translate(0px, 0px) scale(0.45)') throw new Error(`unexpected fit transform ${transform()}`)

await click(tool('放大'))
if (percent() !== '50%') throw new Error(`zoom in produced ${percent()}`)
await click(tool('缩小'))
if (percent() !== '25%') throw new Error(`zoom out produced ${percent()}`)
await click(tool('适应窗口'))
if (percent() !== '45%') throw new Error(`fit produced ${percent()}`)

await doubleClick(viewport)
if (percent() !== '100%') throw new Error(`double click did not zoom to actual size: ${percent()}`)
await doubleClick(viewport)
if (percent() !== '45%') throw new Error(`double click did not return to fit: ${percent()}`)

await click(tool('全屏查看'))
if (fullscreenCalls.length !== 1) throw new Error('the full-screen control did not call the element API')

await act(async () => {
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})
if (container.querySelector('.dshmm-backdrop') !== null) throw new Error('Escape did not close the viewer')

await act(async () => { root.unmount() })
container.remove()
console.log('diagram card smoke test passed')
