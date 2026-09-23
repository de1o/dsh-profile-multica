/** Partial model discovery when one provider is unavailable. */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, internals } from '../src/index.ts'

const original = { ...internals }
beforeEach(() => { internals.armForcedExit = () => {} })
afterEach(() => { Object.assign(internals, original) })

describe('Multica model discovery', () => {
  it('reports a broken provider and keeps models from healthy providers', async () => {
    const ctx = new Context()
    let output = ''
    let stderr = ''
    ctx.provide('agents', {} as never)
    ctx.provide('sessions', {} as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'healthy', model: 'model-a' }),
    } as never)
    ctx.provide('llm', {
      listProviders: () => [
        { id: 'broken', name: 'Broken provider' },
        { id: 'healthy', name: 'Healthy provider' },
      ],
      listModels: async (provider: string) => {
        if (provider === 'broken') throw new Error('provider offline')
        return [{ provider, id: 'model-a', name: 'Model A' }]
      },
      resolveModelInfo: async (provider: string, id: string) => ({ provider, id, name: 'Model A' }),
    } as never)
    internals.stdout = { write: (chunk: string) => { output += chunk; return true } }
    internals.stderr = { write: (chunk: string) => { stderr += chunk; return true } }
    const exited = new Promise<number>((resolve) => { ctx.provide('appExit', resolve) })

    apply(ctx, { mode: 'list-models' })

    expect(await exited).toBe(0)
    expect(stderr).toContain('could not list provider broken')
    expect(JSON.parse(output)).toEqual({
      v: 2,
      type: 'models',
      models: [{
        id: 'healthy/model-a',
        label: 'Model A',
        provider: 'Healthy provider',
        default: true,
      }],
    })
    await ctx.fiber.dispose()
  })
})
