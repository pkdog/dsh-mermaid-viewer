/**
 * Host half of the Mermaid viewer bundle.
 *
 * The browser half must not fold the session log itself, so this plugin folds
 * every committed `assistant/message` into one `messageId -> mermaid sources`
 * map and serves it through the `mermaidDiagrams` session projection. The
 * Client reads that already-computed value with the `useProjection` seat, which
 * is why the fold is the only thing this half owns: subscription, per-session
 * caching, replay from a persisted checkpoint, and delivery to every carrier
 * belong to the projection seam.
 *
 * Only messages that actually carry a fenced `mermaid` block appear in the
 * value, so the render action can key its own visibility off presence alone.
 *
 * @module @local/dsh-mermaid-viewer
 */

/** Cordis plugin name. */
export const name = 'dsh-mermaid-viewer'

/** The projection registry is the whole host contribution. */
export const inject = ['sessionProjections']

/** Projection key read by the Client half (a `SessionProjectionMap` entry once the type face is compiled). */
export const PROJECTION_KEY = 'mermaidDiagrams'

/**
 * Bump whenever the serialized state fields or the fold semantics change:
 * persisted projection-cache rows from an older unit are then discarded
 * instead of being forward-applied.
 */
const STATE_VERSION = 1

/**
 * Validate one message-id keyed map of diagram sources. The seam treats a
 * schema rejection as "drop this row and refold": a malformed persisted
 * projection-cache row or wire value fails soft here, so the schemas must
 * reject shapes the fold cannot produce instead of passing them through.
 * @param value - candidate map.
 * @returns the same map once every entry is a string array.
 * @throws {Error} when the value is not an object of string arrays.
 */
function parseDiagramMap(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('mermaidDiagrams value must be a message-id keyed object')
  }
  for (const sources of Object.values(value)) {
    if (!Array.isArray(sources) || sources.some(source => typeof source !== 'string')) {
      throw new Error('mermaidDiagrams entries must be arrays of diagram sources')
    }
  }
  return value
}

/**
 * The unit's two validation boundaries over the shapes this plugin owns: the
 * persisted fold state (`{ diagrams }`, read back from the projection cache)
 * and the published wire value (the diagrams map itself).
 */
const stateSchema = {
  parse(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('mermaidDiagrams state must be an object carrying diagrams')
    }
    parseDiagramMap(value.diagrams)
    return value
  },
}
const viewSchema = { parse: parseDiagramMap }

/** Opening fence: up to three spaces, three or more backticks or tildes, then the info word. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^ `]*)/

/** Closing fence: the same marker with nothing but whitespace after it. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/**
 * Extract the sources of every fenced `mermaid` block in one Markdown text.
 * @param text - one assistant text block.
 * @returns the diagram sources in document order, empty when the text has none.
 */
export function mermaidSources(text) {
  const sources = []
  let marker = null
  let collecting = false
  let body = []
  for (const line of text.split(/\r?\n/)) {
    if (marker === null) {
      const open = FENCE_OPEN.exec(line)
      if (open === null) continue
      marker = open[1]
      collecting = (open[2] ?? '').toLowerCase() === 'mermaid'
      body = []
      continue
    }
    const close = FENCE_CLOSE.exec(line)
    if (close !== null && close[1][0] === marker[0] && close[1].length >= marker.length) {
      if (collecting && body.some(line => line.trim() !== '')) sources.push(body.join('\n').trimEnd())
      marker = null
      collecting = false
      body = []
      continue
    }
    if (collecting) body.push(line)
  }
  return sources
}

/**
 * Collect one assistant event's diagram sources from its text blocks.
 * @param event - one committed session event.
 * @returns the sources of this message, empty for every other event or message.
 */
export function sourcesOf(event) {
  const message = event?.data?.message
  if (message === undefined || !Array.isArray(message.content)) return []
  const sources = []
  for (const block of message.content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    sources.push(...mermaidSources(block.text))
  }
  return sources
}

/**
 * The `mermaidDiagrams` projection unit: a message-id keyed map of the diagram
 * sources carried by each committed assistant message. Unrelated events return
 * the same state reference, so the seam does no downstream work for them.
 */
export const mermaidDiagramsProjection = {
  key: PROJECTION_KEY,
  stateSchema,
  stateVersion: STATE_VERSION,
  init: () => ({ diagrams: {} }),
  apply: (state, event) => {
    if (event.type !== 'assistant/message') return state
    const sources = sourcesOf(event)
    if (sources.length === 0) return state
    const messageId = event.data.message.id
    if (typeof messageId !== 'string' || messageId === '') return state
    return { diagrams: { ...state.diagrams, [messageId]: sources } }
  },
  wire: {
    viewSchema,
    view: state => state.diagrams,
  },
}

/**
 * Register the projection unit on this plugin's fiber, so disabling the row
 * removes the key and the browser half stops receiving it.
 * @param ctx - owning Host context.
 */
export function apply(ctx) {
  ctx.sessionProjections.register(mermaidDiagramsProjection)
}
