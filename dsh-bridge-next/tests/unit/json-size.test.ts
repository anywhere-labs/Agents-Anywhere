import test from 'node:test'
import assert from 'node:assert/strict'
import { jsonBytes } from '../../src/host/dsh-runtime/json-size.js'

test('JSON byte accounting matches wire bytes without serializing payloads', () => {
  const values = [null, true, false, 123, -0, 1e-7, NaN, Infinity, [], {}, [undefined],
    { omitted: undefined, text: '中文😀\ud800\udc00\ud800x\udc00\n\t"\\', controls: String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)) }]
  for (const value of values) assert.equal(jsonBytes(value), Buffer.byteLength(JSON.stringify(value)))
  const cycle: unknown[] = []; cycle.push(cycle)
  assert.throws(() => jsonBytes(cycle), /Cyclic/)
})
