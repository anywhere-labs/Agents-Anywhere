import { describe, expect, it } from 'vitest'

import type { ConfigOption } from '../../src/application/ports/runtime-session.js'
import { acpSelectionId } from '../../src/domain/identity/index.js'
import { selectionsToConfig } from '../../src/runtime/acp/config.js'
import { catalogsFromConfig } from '../../src/runtime/acp/handle.js'

const model = (current: string): ConfigOption => ({
  id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current,
  values: [{ value: 'm1', name: 'M1' }, { value: 'm2', name: 'M2' }],
})
const permission: ConfigOption = {
  id: 'permission', name: 'Permission', category: 'permission', type: 'select', currentValue: 'auto',
  values: [{ value: 'ask', name: 'Ask' }, { value: 'auto', name: 'Auto' }],
}
const effort: ConfigOption = {
  id: 'effort', name: 'Effort', category: 'effort', type: 'select', currentValue: 'high',
  values: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
}

describe('ACP model catalog selection IDs (v2 acp/domain/catalogs.py)', () => {
  it('uses the raw model value when there is no reasoning effort, and the picked ID is accepted back', () => {
    const config = [model('m2'), permission]
    const catalogs = catalogsFromConfig('opencode', config)
    const models = catalogs.models?.models ?? []
    expect(models.map(item => item.selectionId)).toEqual(['m1', 'm2'])
    expect(catalogs.selections).toEqual({ model: 'm2', permission: 'auto' })
    // What the model picker sends back must be a valid selection.
    expect(selectionsToConfig(config, { model: String(models[0]?.selectionId) })).toEqual([{ optionId: 'model', value: 'm1' }])
  })

  it('encodes model and effort together only for reasoning items and the current selection', () => {
    const catalogs = catalogsFromConfig('opencode', [model('m1'), effort])
    const first = (catalogs.models?.models ?? [])[0]
    expect(first?.selectionId).toBe('m1')
    expect(first?.reasoningItems?.map(item => item.selectionId)).toEqual([acpSelectionId('m1', 'low'), acpSelectionId('m1', 'high')])
    expect(catalogs.selections).toEqual({ model: acpSelectionId('m1', 'high'), effort: 'high' })
  })
})
