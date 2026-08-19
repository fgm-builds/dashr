import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerFakeDelegationTools, runCell, setupKernel } from './helpers.ts'
import type { Config } from '../src/index.ts'

/**
 * M4-A N1 (the M3-B acceptance leftover), v0.1.5 form: the snapshot/restore
 * chain on the PRESENTATION path. `dashr`'s own snapshot-revive suite runs
 * the provider with `bindings: []`; this row always installs the FLAT tool
 * binding globals, the bridge tools, and the `ToolCallError` class into
 * the kernel namespace BEFORE the turn-end snapshot fires — dill must
 * capture them, the shim/hidden exclusion must still hold around them, and
 * a same-principal restore must revive the USER state as pure values while
 * the binding surface answers from the CURRENT host (each run reinstalling
 * its bindings over whatever the snapshot brought back). The rlm() side of
 * the exercise now dispatches the (fake) `subagent` TOOL — masking means
 * the binding surface never names it, but the dispatch target is the
 * registry tool all the same. Real kernels throughout; the provider fibers
 * are disposed by the helper's onTestFinished hooks.
 */

const snapshotDirs: string[] = []

afterEach(() => {
  for (const dir of snapshotDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

interface ManifestShape {
  turn: number
  names: string[]
  skipped: boolean
}

describe('ipython snapshot path with live bindings (M4-A N1)', () => {
  it('snapshots through ipython with flat tool/rlm proxies in the namespace and restores pure user state for the same principal', async () => {
    const snapshotDir = mkdtempSync(join(tmpdir(), 'dashr-presentation-snap-'))
    snapshotDirs.push(snapshotDir)
    const presentation: Config = {}

    // First composition: one cell that leaves user state AND exercises
    // bindings, so a flat tool global and the rlm callable are live in the
    // namespace when the turn-end snapshot cell runs right after it.
    const first = await setupKernel(presentation, { snapshotDir })
    const callsFirst = registerFakeDelegationTools(first.ctx)
    const warm = await runCell(first.ctx, [
      'kept = 41',
      'import math',
      "handle = await rlm({'mode': 'spawn', 'prompt': 'task', 'label': 'worker'})",
      'handle["subagentId"]',
    ].join('\n'), { agent: first.agent.agent })
    expect(warm.isError).toBe(false)
    expect((warm.value as { result: unknown }).result).toBe('child-1')
    expect(callsFirst.map(call => call.tool)).toEqual(['subagent'])

    const manifestPath = join(snapshotDir, 'dashr-agent', 'manifest.json')
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestShape
    expect(manifest.skipped).toBe(false)
    expect(manifest.turn).toBe(1)
    // USER state is captured...
    for (const name of ['kept', 'math', 'handle']) expect(manifest.names).toContain(name)
    // ...alongside the flat binding surface itself (dill captures the
    // callable proxies and the error class — plain non-shim globals).
    for (const name of ['rlm', 'agent_message', 'refine', 'compact', 'ToolCallError']) expect(manifest.names).toContain(name)
    // The pre-0.1.5 holder name and the deleted rlm_await are gone.
    for (const name of ['tools', 'rlm_await']) expect(manifest.names).not.toContain(name)
    // Masked names never bind (ADR-0002), even though the tools are
    // registered and were dispatched.
    for (const name of ['subagent', 'send_message', 'workflow']) expect(manifest.names).not.toContain(name)
    // The exclusion semantics still hold around them: no dashr shim name
    // (the `_dashr`/`__dashr` prefix rule, any case) and none of IPython's
    // own session plumbing (`user_ns_hidden` members like exit/quit/In/Out)
    // ever enters the payload.
    expect(manifest.names.filter(name => name.toLowerCase().startsWith('_dashr') || name.toLowerCase().startsWith('__dashr'))).toEqual([])
    for (const hidden of ['exit', 'quit', 'get_ipython', 'In', 'Out']) expect(manifest.names).not.toContain(hidden)

    // Second composition, same snapshotDir + same principal (the harness's
    // fixed 'dashr-agent' session id): first boot restores before any code.
    const second = await setupKernel(presentation, { snapshotDir })
    const callsSecond = registerFakeDelegationTools(second.ctx, {
      subagent: () => ({ kind: 'continuable', subagentId: 'stub-second-session' }),
    })
    const resumed = await runCell(second.ctx, [
      'kind = type(kept).__name__',
      "again = await rlm({'mode': 'spawn', 'prompt': 'after restore'})",
      '[kind, kept, math.floor(2.5), again["subagentId"]]',
    ].join('\n'), { agent: second.agent.agent })
    expect(resumed.isError).toBe(false)
    if (resumed.isError) throw new Error('restored cell failed')
    // Restored USER state is pure values, not proxy wrappers.
    expect(resumed.value).toEqual({ logs: expect.arrayContaining([expect.stringContaining('namespace restored from the turn-1 snapshot')]), result: ['int', 41, 2, 'stub-second-session'] })
    // The binding surface answers from the CURRENT host: the post-restore
    // rlm() dispatch went to THIS composition's registry, proving the
    // reinstall each run performs over whatever the snapshot restored is
    // effective — a dangling pre-snapshot proxy could never reach it.
    expect(callsSecond.map(call => call.tool)).toEqual(['subagent'])
  }, 60_000)
})
