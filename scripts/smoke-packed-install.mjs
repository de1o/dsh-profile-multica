/** Verify the packed bundle through a clean official DSH profile. */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-profile-multica-smoke-'))
const artifacts = join(temporaryRoot, 'artifacts')
const dshHome = join(temporaryRoot, 'dsh-home')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function run(args, env = process.env) {
  const result = spawnSync(pnpm, args, {
    cwd: root,
    env,
    encoding: 'utf8',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error([
      `pnpm ${args.join(' ')} exited with ${result.status ?? 'no status'}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  return result
}

try {
  mkdirSync(artifacts)
  run(['pack', '--pack-destination', artifacts])
  const tarballs = readdirSync(artifacts).filter(name => name.endsWith('.tgz'))
  assert.equal(tarballs.length, 1, `expected one tarball, found ${tarballs.length}`)
  const tarball = join(artifacts, tarballs[0])
  const isolatedEnv = { ...process.env, DSH_HOME: dshHome }

  run([
    'dlx', '@deepseek-ai/dsh@0.1.0-rc.7',
    'plugin', '--profile', 'multica', 'add', tarball,
  ], isolatedEnv)
  const probe = run([
    'dlx', '@deepseek-ai/dsh@0.1.0-rc.7',
    '--profile', 'multica', '--probe',
  ], isolatedEnv)
  assert.deepEqual(JSON.parse(probe.stdout.trim()), {
    v: 2,
    type: 'probe',
    runtime: 'dsh',
    plugin_version: '0.2.1',
    protocol_version: 2,
  })
  process.stdout.write('packed install and probe verified\n')
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
