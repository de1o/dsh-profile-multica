import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply as startupApply, MULTICA_STARTUP_SERVICE } from '../src/startup.ts'

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Multica Loader composition', () => {
  it('settles the runner after startup publishes its selected mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-multica-loader-'))
    temporaryDirectories.push(dir)
    const observed: unknown[] = []
    writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'multica-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__multicaStartupApply(ctx)
`)
    writeFileSync(join(dir, 'runner.mjs'), `
export function apply(_ctx, config) { globalThis.__multicaObserved.push(config) }
`)
    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: multica-runner',
      `  name: ${pathToFileURL(join(dir, 'runner.mjs')).href}`,
      `  inject: [${MULTICA_STARTUP_SERVICE}]`,
      '  config:',
      '    mode: !!js ctx.multicaStartup.mode',
      '- id: multica-startup',
      `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
      '',
    ].join('\n'))
    const globals = globalThis as unknown as {
      __multicaStartupApply: typeof startupApply
      __multicaObserved: unknown[]
    }
    globals.__multicaStartupApply = startupApply
    globals.__multicaObserved = observed

    const ctx = new Context()
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    provideCmdline(ctx, { args: ['--stdio'], exit: () => {} })
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(join(dir, 'cordis.yml')).href },
    })
    await ctx.loader.await()
    expect(observed).toEqual([{ mode: 'stdio' }])
    await ctx.fiber.dispose()
  })
})
