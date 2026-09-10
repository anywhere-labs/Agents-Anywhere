import { chmod, mkdtemp, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { AnySchema } from 'ajv'
import { beforeEach, describe, expect, it } from 'vitest'
import { MetadataStore } from '../src/persistence/metadata.js'
import { modelSelectionId } from '../src/projection/identity.js'
import { CatalogManager } from '../src/runtime/catalogs.js'

const require = createRequire(import.meta.url)
const addFormats = require('ajv-formats') as (ajv: Ajv2020) => void
const contractRoot = fileURLToPath(new URL('../../contracts/dsh-bridge/1.0/schemas/', import.meta.url))

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aa-dsh-catalog-'))
  if (process.platform !== 'win32') await chmod(root, 0o700)
})

describe('current DSH Host catalogs', () => {
  it('nests reasoning selections and conforms to both shared catalog schemas', async () => {
    const ctx = {
      llm: {
        listProviders: () => [{ id: 'provider', name: 'Provider' }],
        listModels: async () => [{ provider: 'provider', id: 'model', name: 'Model' }],
        resolveModelInfo: async () => ({
          provider: 'provider',
          id: 'model',
          name: 'Model',
          inputModalities: ['text'],
          context: { contextWindow: 64_000 },
          reasoning: {
            defaultEffort: ReasoningEffortId('medium'),
            efforts: [
              { id: ReasoningEffortId('medium'), name: 'Medium' },
              { id: ReasoningEffortId('high'), name: 'High', description: 'More reasoning' },
            ],
          },
        }),
      },
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'provider', model: 'model' }),
      },
      permissionPresets: {
        names: ['workspace-write'],
        optionOf: (name: string) => ({ name, description: `${name} description` }),
        current: () => 'workspace-write',
      },
    } as unknown as Context
    const metadata = new MetadataStore(root)
    await metadata.initialize()
    const catalogs = new CatalogManager(ctx, metadata)
    const snapshot = await catalogs.refresh()
    expect(snapshot.models).toHaveLength(1)
    expect(snapshot.models[0]?.reasoningItems).toHaveLength(2)
    expect(snapshot.models[0]?.selectionId).toBe(modelSelectionId({ provider: 'provider', model: 'model' }))
    await expect(catalogs.resolveModel(snapshot.models[0]?.reasoningItems[1]?.selectionId ?? ''))
      .resolves.toMatchObject({ reasoningEffort: 'high' })
    expect(snapshot.permissions.find(item => item.id === 'custom')).toMatchObject({ enabled: false })

    const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false })
    addFormats(ajv)
    const modelSchema = JSON.parse(await readFile(join(contractRoot, 'model-catalog.schema.json'), 'utf8')) as AnySchema
    const permissionSchema = JSON.parse(await readFile(join(contractRoot, 'permission-catalog.schema.json'), 'utf8')) as AnySchema
    const validateModels = ajv.compile(modelSchema)
    const validatePermissions = ajv.compile(permissionSchema)
    expect(validateModels({ runtime: 'dsh', revision: snapshot.revision, models: snapshot.models }),
      JSON.stringify(validateModels.errors)).toBe(true)
    expect(validatePermissions({ runtime: 'dsh', revision: snapshot.revision, permissions: snapshot.permissions }),
      JSON.stringify(validatePermissions.errors)).toBe(true)
  })
})
