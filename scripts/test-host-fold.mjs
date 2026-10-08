/**
 * Host-fold test: exercise the `mermaidDiagrams` projection's fence extraction
 * and state transitions without a running Harness.
 *
 * Usage: node scripts/test-host-fold.mjs
 */
import assert from 'node:assert/strict'
import { mermaidDiagramsProjection as projection, mermaidSources } from '../index.js'

const event = (id, text, type = 'assistant/message') => ({
  type,
  seq: 1,
  data: { message: { id, content: [{ type: 'text', text }] } },
})

assert.deepEqual(mermaidSources('plain text'), [], 'no fence yields no source')
assert.deepEqual(
  mermaidSources('before\n```mermaid\nflowchart LR\n  A-->B\n```\nafter'),
  ['flowchart LR\n  A-->B'],
  'a fenced mermaid block yields its body',
)
assert.deepEqual(
  mermaidSources('~~~mermaid\ngraph TD\n  A-->B\n~~~'),
  ['graph TD\n  A-->B'],
  'tilde fences work',
)
assert.deepEqual(
  mermaidSources('````mermaid\nflowchart LR\n  A-->B\n````'),
  ['flowchart LR\n  A-->B'],
  'a longer fence works',
)
assert.deepEqual(mermaidSources('```ts\nconst a = 1\n```'), [], 'another language is ignored')
assert.deepEqual(mermaidSources('```mermaid\nflowchart LR\n  A-->B'), [], 'an unterminated fence yields nothing')
assert.deepEqual(
  mermaidSources('```mermaid\n```'),
  [],
  'an empty diagram yields nothing',
)
assert.deepEqual(
  mermaidSources('```mermaid\nflowchart LR\n```\n```mermaid\ngraph TD\n```'),
  ['flowchart LR', 'graph TD'],
  'two fences yield two sources',
)

const initial = projection.init({}, 0)
assert.deepEqual(initial, { diagrams: {} }, 'empty state')

const unrelated = projection.apply(initial, { type: 'tool/result', seq: 2, data: {} })
assert.equal(unrelated, initial, 'an unrelated event keeps the state reference')

const plain = projection.apply(initial, event('m1', 'no diagrams here'))
assert.equal(plain, initial, 'a message without diagrams keeps the state reference')

const withDiagram = projection.apply(initial, event('m1', 'see:\n```mermaid\ngraph TD\n  A-->B\n```'))
assert.deepEqual(withDiagram, { diagrams: { m1: ['graph TD\n  A-->B'] } }, 'a message with a diagram is recorded')
assert.equal(projection.wire.view(withDiagram), withDiagram.diagrams, 'the view publishes the map itself')
assert.equal(
  projection.wire.view(projection.apply(withDiagram, event('m2', 'nothing'))),
  withDiagram.diagrams,
  'an unrelated message keeps the published reference',
)

const second = projection.apply(withDiagram, event('m2', '```mermaid\nflowchart LR\n  C-->D\n```'))
assert.deepEqual(Object.keys(second.diagrams), ['m1', 'm2'], 'later messages extend the map')

console.log('ok: fence extraction and projection transitions')
