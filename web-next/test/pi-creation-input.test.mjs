import assert from 'node:assert/strict'
import test from 'node:test'
import { registerSource } from './helpers/onboarding-source.mjs'
const source = registerSource()
const { creationConfigurationDefaults } = await import('../src/features/dashboard/runtime-forms.ts')
const { attachmentImagesAllowed } = await import('../src/components/session/capabilities.ts')
source.deregister()

test('prepared defaults cannot contradict explicit model, effort and permission selectors', () => {
  assert.deepEqual(creationConfigurationDefaults({ revision: 1, options: [
    { id: 'model', category: 'model', type: 'select', currentValue: 'old-model' },
    { id: 'thinking', category: 'effort', type: 'select', currentValue: 'medium' },
    { id: 'permission', category: 'permission', type: 'select', currentValue: 'ask' },
    { id: 'compact', category: 'model_config', type: 'boolean', currentValue: false },
  ] }), { compact: false })
})

test('image input follows the selected model while legacy runtimes remain compatible', () => {
  const caps = inputs => ({ capabilities: [{ capabilityId: 'runtime.attachment', metadata: { inputModalities: inputs } }] })
  assert.equal(attachmentImagesAllowed(caps(['text'])), false)
  assert.equal(attachmentImagesAllowed(caps(['text', 'image'])), true)
  assert.equal(attachmentImagesAllowed(caps(undefined)), true)
})
