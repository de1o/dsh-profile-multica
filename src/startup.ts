/** Command-line mode provider for the installable Multica bridge. */

import { Command, Option } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'multica-startup'
/** Services required before command-line parsing. */
export const inject = ['cmdlineArgs']
/** Service provided to the protocol runner. */
export const MULTICA_STARTUP_SERVICE = 'multicaStartup'

/** Mutually exclusive bridge operation selected by the caller. */
export type MulticaMode = 'probe' | 'list-models' | 'stdio'

/** Values consumed by the runner row. */
export interface MulticaStartupValues {
  mode: MulticaMode
}

function multicaCommand(): Command {
  return new Command()
    .name('dsh --profile multica')
    .description('Expose dsh to Multica over its versioned JSONL protocol.')
    .helpOption('-h, --help', 'show this help')
    .addOption(new Option('--probe', 'print the Multica discovery frame and exit').conflicts(['listModels', 'stdio']))
    .addOption(new Option('--list-models', 'print the model catalog frame and exit').conflicts(['probe', 'stdio']))
    .addOption(new Option('--stdio', 'serve one task over stdin/stdout JSONL').conflicts(['probe', 'listModels']))
}

/**
 * Parse one required operation and publish it as a Cordis service.
 * @param ctx - plugin context carrying the launcher command-line arguments.
 */
export function apply(ctx: Context): void {
  const program = multicaCommand()
  program.action(() => {
    const options = program.opts<{ probe?: boolean; listModels?: boolean; stdio?: boolean }>()
    const mode: MulticaMode | undefined = options.probe
      ? 'probe'
      : options.listModels
        ? 'list-models'
        : options.stdio
          ? 'stdio'
          : undefined
    if (mode === undefined) {
      program.error('error: one of --probe, --list-models, or --stdio is required')
      return
    }
    ctx.provide(MULTICA_STARTUP_SERVICE, { mode } satisfies MulticaStartupValues)
  })
  parseCmdline(ctx, program)
}
