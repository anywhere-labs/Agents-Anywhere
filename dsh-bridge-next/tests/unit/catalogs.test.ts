import assert from 'node:assert/strict'
import test from 'node:test'
import { labelModels, type ModelItem } from '../../src/host/dsh-runtime/catalogs.js'

test('model labels include the provider for uniquely named models', () => {
  const models: ModelItem[] = [{
    id: 'provider/model',
    title: 'Model',
    selectionId: 'provider/model',
    enabled: true,
    reasoningItems: [],
    metadata: {
      provider: 'provider',
      providerName: 'Provider',
      model: 'model',
      modelName: 'Model',
      reasoningEffort: null,
    },
  }]

  labelModels(models)

  assert.equal(models[0]?.title, 'Model（Provider）')
})
