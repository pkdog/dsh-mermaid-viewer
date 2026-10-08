/**
 * Local smoke test: load the generated chunk through a stub Client module
 * loader inside jsdom and check the wrapper's contract — one registration under
 * the owner id, a factory that needs no module-table require, and a returned
 * mermaid API object that parses a diagram without touching the global object.
 *
 * Full SVG rendering is not asserted here: mermaid measures laid-out SVG via
 * `getBBox`, which jsdom does not implement. The browser check covers drawing.
 *
 * Usage: node scripts/smoke-mermaid-chunk.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * jsdom comes from the Harness checkout named by DSH_ROOT; there is no
 * machine-independent default.
 */
const harness = process.env.DSH_ROOT
if (harness === undefined || harness === '') {
  throw new Error('Set DSH_ROOT to the DeepSeek Harness checkout that supplies jsdom for this smoke test')
}
const require = createRequire(join(harness, 'index.js'))
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const registrations = []
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
dom.window.__ModuleLoader__ = { load: registration => registrations.push(registration) }

const source = readFileSync(join(PLUGIN_DIR, 'client.mermaid.js'), 'utf8')
// eslint-disable-next-line no-new-func -- the chunk is a classic script in the browser
new Function(source)()

const registration = registrations[0]
if (registration === undefined) throw new Error('chunk did not register a factory')
if (registration.id !== '@local/dsh-mermaid-viewer') throw new Error(`unexpected owner ${registration.id}`)
if (registration.chunk !== 'client.mermaid.js') throw new Error(`unexpected chunk ${registration.chunk}`)

const mermaid = registration.factory(() => { throw new Error('chunk must not require anything') })
for (const name of ['initialize', 'render', 'parse']) {
  if (typeof mermaid?.[name] !== 'function') throw new Error(`mermaid.${name} is missing`)
}

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' })
const parsed = await mermaid.parse('flowchart LR\n  A[Start] --> B{Ready?}\n  B -->|yes| C[Ship]')
if (parsed === false) throw new Error('mermaid.parse rejected a valid flowchart')
if (Object.prototype.hasOwnProperty.call(globalThis, 'mermaid')) throw new Error('the wrapper leaked globalThis.mermaid')

let drawNote = 'render not attempted'
try {
  const { svg } = await mermaid.render('smoke', 'flowchart LR\n  A[Start] --> B[Ship]')
  drawNote = `rendered ${svg.length} bytes of svg`
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  // jsdom has no SVG layout: mermaid's own measuring step is the only thing missing here.
  if (!message.includes('getBBox') && !message.includes('CSSStyleSheet')) throw error
  drawNote = 'render needs a real browser (jsdom has no SVG layout)'
}

console.log(`ok: ${registration.id}/${registration.chunk} parsed a flowchart; ${drawNote}`)
