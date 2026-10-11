import assert from 'node:assert/strict'
import test from 'node:test'

import { capabilities } from '../../src/host/dsh-runtime/capabilities.js'

const flag = (value: ReturnType<typeof capabilities>, capabilityId: string) =>
  value.capabilities.find(item => item.capabilityId === capabilityId)!

test('the message channel capabilities follow write access', () => {
  const readOnly = capabilities('sess', false)
  assert.equal(flag(readOnly, 'session.send_message').available, false)
  assert.equal(flag(readOnly, 'session.queue').available, false)
  assert.equal(flag(readOnly, 'session.steer').available, false)

  const writable = capabilities('sess', true)
  assert.equal(flag(writable, 'session.send_message').available, true)
  assert.equal(flag(writable, 'session.interrupt').available, true)
  // Queueing accepts a message while a turn is running; steering splices into
  // that turn. Clients gate their composer on these two flags.
  assert.equal(flag(writable, 'session.queue').available, true)
  assert.equal(flag(writable, 'session.queue').allowed, true)
  assert.equal(flag(writable, 'session.steer').available, true)
  assert.equal(flag(writable, 'session.steer').allowed, true)
  assert.equal(writable.metadata.readOnly, false)
})
