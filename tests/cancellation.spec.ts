/** Cancellation behavior across the JSONL process and Agent lifecycle. */

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

describe('Multica cancellation', () => {
  it('cancels the active Agent and emits one cancelled terminal result', async () => {
    const ctx = new Context()
    const agentCtx = new Context()
    const input = new PassThrough()
    const idle = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<void>()
    const session = { id: 'session-cancel' }
    let output = ''
    let cancelled = 0
    let flushed = 0

    const agent = {
      id: session.id,
      session,
      ctx: agentCtx,
      followup: () => {},
      whenIdle: () => idle.promise,
      cancel: () => {
        cancelled += 1
        agentCtx.emit('session/event', session as never, {
          type: 'turn/end', seq: 0, time: 1,
          data: { turn: 1, reason: { kind: 'aborted' } },
        } as never)
        idle.resolve()
      },
    }

    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'provider/a', model: 'model/b' }),
    } as never)
    ctx.provide('llm', { listProviders: () => [] } as never)
    ctx.provide('sessions', {
      flush: async () => { flushed += 1; return true },
    } as never)
    ctx.provide('agents', {
      create: async () => {
        setTimeout(() => ready.resolve(), 0)
        return { agent, dispose: () => agentCtx.fiber.dispose() }
      },
    } as never)
    internals.stdin = input
    internals.stdout = { write: (chunk: string) => { output += chunk; return true } }
    internals.stderr = { write: () => true }
    const exited = new Promise<number>((resolve) => { ctx.provide('appExit', resolve) })

    apply(ctx, { mode: 'stdio' })
    await new Promise(resolve => setTimeout(resolve, 0))
    input.write(`${JSON.stringify({
      v: 2, type: 'execute', request_id: 'request-cancel', cwd: '/work', prompt: 'wait',
    })}\n`)
    await ready.promise
    input.write(`${JSON.stringify({ v: 2, type: 'cancel', request_id: 'request-cancel' })}\n`)

    expect(await exited).toBe(0)
    expect(cancelled).toBe(1)
    expect(flushed).toBe(1)
    const parsed = frames(output)
    expect(parsed.map(frame => frame.type)).toEqual(['ready', 'session', 'result'])
    expect(parsed.at(-1)).toMatchObject({
      type: 'result', request_id: 'request-cancel', status: 'cancelled',
      stop_reason: 'cancelled', session_id: session.id,
    })
    await ctx.fiber.dispose()
  })
})
