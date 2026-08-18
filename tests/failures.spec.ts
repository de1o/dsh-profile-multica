/** Terminal result framing for Agent startup and bridge failures. */

import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, internals } from '../src/index.ts'

const original = { ...internals }
beforeEach(() => { internals.armForcedExit = () => {} })
afterEach(() => { Object.assign(internals, original) })

function frames(output: string): Record<string, unknown>[] {
  return output.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

function baseServices(ctx: Context): void {
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'provider/a', model: 'model/b' }),
  } as never)
  ctx.provide('llm', { listProviders: () => [] } as never)
}

async function start(ctx: Context, input: PassThrough, command: Record<string, unknown>): Promise<{
  code: number
  output: string
  stderr: string
}> {
  let output = ''
  let stderr = ''
  internals.stdin = input
  internals.stdout = { write: (chunk: string) => { output += chunk; return true } }
  internals.stderr = { write: (chunk: string) => { stderr += chunk; return true } }
  const exited = new Promise<number>((resolve) => { ctx.provide('appExit', resolve) })
  apply(ctx, { mode: 'stdio' })
  await new Promise(resolve => setTimeout(resolve, 0))
  input.write(`${JSON.stringify(command)}\n`)
  return { code: await exited, output, stderr }
}

describe('Multica failure results', () => {
  it('marks a missing resumed Session as a rejected startup', async () => {
    const ctx = new Context()
    baseServices(ctx)
    ctx.provide('sessions', {} as never)
    ctx.provide('agents', {
      resume: async () => { throw new Error('session not found') },
    } as never)

    const result = await start(ctx, new PassThrough(), {
      v: 1,
      type: 'execute',
      request_id: 'request-resume',
      cwd: '/work',
      prompt: 'continue',
      resume_session_id: 'missing-session',
    })

    expect(result.code).toBe(0)
    expect(frames(result.output).at(-1)).toMatchObject({
      type: 'result',
      request_id: 'request-resume',
      status: 'failed',
      stop_reason: 'startup-error',
      resume_rejected: true,
      error: { code: 'AGENT_START_FAILED', message: 'session not found' },
    })
    await ctx.fiber.dispose()
  })

  it('contains persistence failures as a bridge-error result', async () => {
    const ctx = new Context()
    const agentCtx = new Context()
    const session = { id: 'session-flush-failure' }
    let disposed = false
    baseServices(ctx)
    ctx.provide('sessions', {
      flush: async () => { throw new Error('disk full') },
    } as never)
    ctx.provide('agents', {
      create: async () => ({
        agent: {
          id: session.id,
          session,
          ctx: agentCtx,
          cancel: () => {},
          followup: () => {
            agentCtx.emit('session/event', session as never, {
              type: 'turn/end', seq: 0, time: 1,
              data: { turn: 1, reason: { kind: 'completed' } },
            } as never)
          },
          whenIdle: () => Promise.resolve(),
        },
        dispose: async () => {
          disposed = true
          await agentCtx.fiber.dispose()
        },
      }),
    } as never)

    const result = await start(ctx, new PassThrough(), {
      v: 1, type: 'execute', request_id: 'request-flush', cwd: '/work', prompt: 'persist me',
    })

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('disk full')
    expect(disposed).toBe(true)
    expect(frames(result.output).at(-1)).toMatchObject({
      type: 'result',
      request_id: 'request-flush',
      status: 'failed',
      stop_reason: 'bridge-error',
      session_id: session.id,
      error: { code: 'BRIDGE_ERROR', message: 'disk full' },
    })
    await ctx.fiber.dispose()
  })
})
