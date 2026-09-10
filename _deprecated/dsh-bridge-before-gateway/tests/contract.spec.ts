import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { AnySchema } from 'ajv'
import type { FormatsPlugin } from 'ajv-formats'
import { describe, expect, it } from 'vitest'
import { DECLARED_RPC_CODES } from '../src/wire/errors.js'
import { REQUEST_METHODS } from '../src/wire/protocol.js'
import { INBOUND_NOTIFICATION_METHODS, OUTBOUND_NOTIFICATION_METHODS } from '../src/wire/protocol.js'
import {
  initializeResultPayload,
  runtimeCapabilitiesPayload,
} from '../src/service.js'

const contractRoot = fileURLToPath(new URL('../../contracts/dsh-bridge/1.0/', import.meta.url))
const addFormats = createRequire(import.meta.url)('ajv-formats') as FormatsPlugin

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(`${contractRoot}/${path}`, 'utf8')) as unknown
}

async function validator(schemaName: string) {
  // initialize-result currently applies `pattern` without an explicit string
  // type. Keep every other strict check active while the shared contract owns
  // that correction.
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false })
  addFormats(ajv)
  return ajv.compile(await json(`schemas/${schemaName}.schema.json`) as AnySchema)
}

describe('shared DSH bridge contract', () => {
  it('validates repository request fixtures directly from the shared contract', async () => {
    const validate = await validator('request')
    const validNames = await readdir(`${contractRoot}/fixtures/valid`)
    for (const name of validNames) {
      expect(validate(await json(`fixtures/valid/${name}`)), `${name}: ${JSON.stringify(validate.errors)}`).toBe(true)
    }
    const invalidNames = await readdir(`${contractRoot}/fixtures/invalid`)
    for (const name of invalidNames) {
      expect(validate(await json(`fixtures/invalid/${name}`)), name).toBe(false)
    }
  })

  it('keeps request dispatch methods equal to the schema enum', async () => {
    const schema = await json('schemas/request.schema.json') as {
      properties: { method: { enum: string[] } }
    }
    expect([...REQUEST_METHODS]).toEqual(schema.properties.method.enum)
  })

  it('keeps inbound and outbound notification methods equal to the schema enum', async () => {
    const schema = await json('schemas/notification.schema.json') as {
      properties: { method: { enum: string[] } }
    }
    expect([...OUTBOUND_NOTIFICATION_METHODS, ...INBOUND_NOTIFICATION_METHODS]).toEqual(
      schema.properties.method.enum,
    )
  })

  it('implements every numeric error code declared by the response schema', async () => {
    const schema = await json('schemas/response.schema.json') as {
      properties: { error: { properties: { code: { enum: number[] } } } }
    }
    expect(new Set(Object.values(DECLARED_RPC_CODES))).toEqual(
      new Set(schema.properties.error.properties.code.enum),
    )
  })

  it('validates initialize and runtime capability payloads', async () => {
    const initialize = await validator('initialize-result')
    const capabilities = await validator('capability-set')
    expect(initialize(initializeResultPayload()), JSON.stringify(initialize.errors)).toBe(true)
    expect(capabilities(runtimeCapabilitiesPayload()), JSON.stringify(capabilities.errors)).toBe(true)
  })
})
