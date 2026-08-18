import { Context } from '@deepseek-ai/cordis'
import { internals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, MULTICA_STARTUP_SERVICE, type MulticaStartupValues } from '../src/startup.ts'

afterEach(() => {
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

function parse(args: string[]): { value: MulticaStartupValues | undefined; exits: number[]; output: string } {
  const ctx = new Context()
  const exits: number[] = []
  let output = ''
  const sink = { write: (chunk: string) => { output += chunk; return true } }
  internals.stdout = sink
  internals.stderr = sink
  provideCmdline(ctx, { args, exit: code => void exits.push(code) })
  apply(ctx)
  return {
    value: ctx.get(MULTICA_STARTUP_SERVICE) as MulticaStartupValues | undefined,
    exits,
    output,
  }
}

describe('Multica command-line provider', () => {
  it.each([
    { args: ['--probe'], mode: 'probe' },
    { args: ['--list-models'], mode: 'list-models' },
    { args: ['--stdio'], mode: 'stdio' },
  ] as const)('provides $mode', ({ args, mode }) => {
    expect(parse([...args])).toEqual({ value: { mode }, exits: [], output: '' })
  })

  it('requires exactly one operation', () => {
    expect(parse([])).toMatchObject({ value: undefined, exits: [1] })
    expect(parse(['--probe', '--stdio'])).toMatchObject({ value: undefined, exits: [1] })
  })

  it('prints profile-specific help without providing a mode', () => {
    const result = parse(['--help'])
    expect(result.value).toBeUndefined()
    expect(result.exits).toEqual([0])
    expect(result.output).toContain('dsh --profile multica')
  })
})
