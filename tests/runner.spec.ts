/** Process-facing discovery and stdio framing. */

import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, internals } from '../src/index.ts'

const original = { ...internals }
beforeEach(() => { internals.armForcedExit = () => {} })
afterEach(() => {
  Object.assign(internals, original)
  vi.unstubAllEnvs()
})

function parseFrames(output: string): Record<string, unknown>[] {
  return output.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
}

function services(ctx: Context): void {
  ctx.provide('agents', {} as never)
  ctx.provide('sessions', {} as never)
  ctx.provide('shellEnv', { register: () => () => {} } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'provider/a', model: 'model/b' }),
  } as never)
  ctx.provide('llm', {
    listProviders: () => [{ id: 'provider/a', name: 'Provider A' }],
    listModels: async () => [{ provider: 'provider/a', id: 'model/b', name: 'Model B' }],
    resolveModelInfo: async () => ({
      provider: 'provider/a', id: 'model/b', name: 'Model B',
      reasoning: {
        efforts: [{ id: 'high', name: 'High', description: 'More reasoning' }],
        defaultEffort: 'high',
      },
    }),
  } as never)
}

async function run(mode: 'probe' | 'list-models'): Promise<{ code: number; lines: unknown[]; err: string }> {
  const ctx = new Context()
  services(ctx)
  let out = ''
  let err = ''
  internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
  internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
  const exited = new Promise<number>((resolve) => { ctx.provide('appExit', resolve) })
  apply(ctx, { mode })
  const code = await exited
  await ctx.fiber.dispose()
  return { code, lines: parseFrames(out), err }
}

describe('Multica runner', () => {
  it('validates loader configuration', () => {
    expect(Config({ mode: 'probe' })).toEqual({ mode: 'probe' })
    expect(() => Config({ mode: 'invalid' } as never)).toThrow()
  })

  it('emits the exact discovery identity', async () => {
    expect(await run('probe')).toMatchObject({
      code: 0,
      err: '',
      lines: [{ v: 2, type: 'probe', runtime: 'dsh', plugin_version: '0.2.1', protocol_version: 2 }],
    })
  })

  it('projects model ids, defaults, and reasoning levels', async () => {
    expect(await run('list-models')).toMatchObject({
      code: 0,
      err: '',
      lines: [{
        v: 2,
        type: 'models',
        models: [{
          id: 'provider%2Fa/model%2Fb',
          label: 'Model B',
          provider: 'Provider A',
          default: true,
          thinking: {
            supported_levels: [{ value: 'high', label: 'High', description: 'More reasoning' }],
            default_level: 'high',
          },
        }],
      }],
    })
  })

  it('keeps stdout as JSONL while rejecting invalid stdio input', async () => {
    const ctx = new Context()
    services(ctx)
    const input = new PassThrough()
    let out = ''
    internals.stdin = input
    internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
    internals.stderr = { write: () => true }
    const forced: number[] = []
    internals.armForcedExit = code => void forced.push(code)
    const exited = new Promise<number>((resolve) => { ctx.provide('appExit', resolve) })
    apply(ctx, { mode: 'stdio' })
    await new Promise(resolve => setTimeout(resolve, 0))
    input.write('{\n')
    input.end()
    expect(await exited).toBe(1)
    const lines = parseFrames(out)
    expect(lines[0]).toMatchObject({ v: 2, type: 'ready', runtime: 'dsh' })
    expect(lines[1]).toMatchObject({ v: 2, type: 'protocol_error', code: 'INVALID_JSON' })
    expect(input.isPaused()).toBe(true)
    expect(input.destroyed).toBe(true)
    expect(forced).toEqual([1])
    await ctx.fiber.dispose()
  })

  it('drives one Agent and projects its streamed and durable result frames', async () => {
    vi.stubEnv('MULTICA_TOKEN', 'mat_task-test')
    const ctx = new Context()
    const input = new PassThrough()
    let out = ''
    let flushed = false
    let shellEnvContributor: { resolve(execution: unknown): Record<string, string> } | undefined
    const checkpoints: string[] = []
    const agentCtx = new Context()
    ctx.provide('shellEnv', {
      register: (contributor: typeof shellEnvContributor) => {
        shellEnvContributor = contributor
        return () => {}
      },
    } as never)
    const session = { id: 'session-1' }
    const emit = (event: unknown): void => {
      agentCtx.emit('session/event', session as never, event as never)
    }
    const agent = {
      id: 'session-1',
      session,
      ctx: agentCtx,
      cancel: () => {},
      inbox: {
        append: (_target: string, message: { content: Array<{ text: string }> }) => {
          checkpoints.push(message.content[0]?.text ?? '')
        },
      },
      followup: () => {
        emit({
          type: 'tool/call', seq: 0, time: 1,
          data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' },
        })
        emit({
          type: 'assistant/chunk', seq: 1, time: 2,
          data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hello' } },
        })
        emit({
          type: 'assistant/message', seq: 2, time: 3,
          data: {
            turn: 1,
            step: 1,
            message: createAssistantMessage({
              content: [{ type: 'text', text: 'hello' }],
              source: { provider: 'provider/a', model: 'model/b' },
            }),
            usage: { inputTokens: 3, outputTokens: 2 },
          },
        })
        emit({ type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } })
      },
      whenIdle: () => Promise.resolve(),
    }
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'provider/a', model: 'model/b' }),
    } as never)
    ctx.provide('llm', { listProviders: () => [] } as never)
    ctx.provide('sessions', { flush: async () => { flushed = true; return true } } as never)
    ctx.provide('agents', {
      create: async (options: { setup?: (agentCtx: Context) => Promise<void> | void }) => {
        await options.setup?.(agentCtx)
        return { agent, dispose: () => agentCtx.fiber.dispose() }
      },
    } as never)
    internals.stdin = input
    internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
    internals.stderr = { write: () => true }
    const exited = new Promise<number>((resolve) => { ctx.provide('appExit', resolve) })
    apply(ctx, { mode: 'stdio' })
    await new Promise(resolve => setTimeout(resolve, 0))
    input.write(`${JSON.stringify({
      v: 2,
      type: 'execute',
      request_id: 'request-1',
      cwd: '/work',
      prompt: 'say hello',
      tool_call_budget: { soft_limit: 1, hard_limit: 3 },
    })}\n`)
    expect(await exited).toBe(0)
    expect(flushed).toBe(true)
    const frames = parseFrames(out)
    expect(frames.map(value => value.type)).toEqual(['ready', 'session', 'tool_call', 'text', 'usage', 'result'])
    expect(shellEnvContributor?.resolve({})).toEqual({ DSH_MULTICA_TASK_TOKEN: 'mat_task-test' })
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toContain('Stop broad exploration')
    expect(frames.at(-1)).toMatchObject({
      type: 'result', request_id: 'request-1', status: 'completed', session_id: 'session-1', output: 'hello',
    })
    await ctx.fiber.dispose()
  })

  it('cancels a run that reaches the hard tool-call budget', async () => {
    const ctx = new Context()
    const input = new PassThrough()
    let out = ''
    const agentCtx = new Context()
    const session = { id: 'session-budget' }
    const emit = (event: unknown): void => agentCtx.emit('session/event', session as never, event as never)
    let cancelled = false
    const agent = {
      id: 'session-budget', session, ctx: agentCtx,
      inbox: { append: () => {} },
      cancel: () => {
        cancelled = true
        emit({ type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'aborted' } } })
      },
      followup: () => {
        for (let index = 1; index <= 3; index++) {
          emit({
            type: 'tool/call', seq: index, time: index,
            data: { turn: 1, step: index, callId: `call-${index}`, name: 'bash', arguments: '{}' },
          })
        }
      },
      whenIdle: () => Promise.resolve(),
    }
    ctx.provide('agents', {
      create: async () => ({ agent, dispose: () => agentCtx.fiber.dispose() }),
    } as never)
    ctx.provide('sessions', { flush: async () => true } as never)
    ctx.provide('shellEnv', { register: () => () => {} } as never)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'provider/a', model: 'model/b' }),
    } as never)
    ctx.provide('llm', { listProviders: () => [] } as never)
    internals.stdin = input
    internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
    internals.stderr = { write: () => true }
    const exited = new Promise<number>(resolve => ctx.provide('appExit', resolve))
    apply(ctx, { mode: 'stdio' })
    await new Promise(resolve => setTimeout(resolve, 0))
    input.write(`${JSON.stringify({
      v: 2, type: 'execute', request_id: 'request-budget', cwd: '/work', prompt: 'work',
      tool_call_budget: { soft_limit: 2, hard_limit: 3 },
    })}\n`)
    expect(await exited).toBe(0)
    expect(cancelled).toBe(true)
    expect(parseFrames(out).at(-1)).toMatchObject({
      type: 'result', status: 'failed', stop_reason: 'tool-call-budget',
      error: { code: 'TOOL_CALL_BUDGET_EXCEEDED' },
    })
    await ctx.fiber.dispose()
  })

  it('fails loud without launcher-owned appExit', () => {
    const ctx = new Context()
    services(ctx)
    expect(() => { apply(ctx, { mode: 'probe' }) }).toThrow('must provide ctx.appExit')
  })
})
