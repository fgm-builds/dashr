import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { runCell, setupKernel } from './helpers.ts'
import type { Harness } from './helpers.ts'
import type { Config } from '../src/index.ts'

/**
 * M4-A N1 (the M3-B acceptance leftover): the snapshot/restore chain on the
 * PRESENTATION path. `dashr`'s own snapshot-revive suite runs the provider
 * with `bindings: []`; this row always installs the `tools` holder, the bare
 * `rlm`/`rlm_await` callables, and the `ToolCallError` class into the kernel
 * namespace BEFORE the turn-end snapshot fires — dill must capture them, the
 * shim/hidden exclusion must still hold around them, and a same-principal
 * restore must revive the USER state as pure values while the binding
 * surface answers from the CURRENT host (each run reinstalling its bindings
 * over whatever the snapshot brought back). Real kernels throughout; the
 * provider fibers are disposed by the helper's onTestFinished hooks, and the
 * orphan gate (`pgrep ipykernel_launcher`) runs after the suite.
 */

const snapshotDirs: string[] = []

afterEach(() => {
  for (const dir of snapshotDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Mount a stub `ctx.subagents` service whose runs answer as the given id. */
async function stubSubagents(ctx: Harness['ctx'], runId: string): Promise<void> {
  await ctx.plugin({ name: `stub-subagents-${runId}`, apply(c) {
    c.provide('subagents', {
      async start(_name: string, request: { prompt: ContentBlock[], parent: Agent, signal: AbortSignal }) {
        return {
          id: runId,
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        }
      },
    })
  } })
}

interface ManifestShape {
  turn: number
  names: string[]
  skipped: boolean
}

describe('run_cell snapshot path with live bindings (M4-A N1)', () => {
  it('snapshots through run_cell with tools/rlm proxies in the namespace and restores pure user state for the same principal', async () => {
    const snapshotDir = mkdtempSync(join(tmpdir(), 'dashr-presentation-snap-'))
    snapshotDirs.push(snapshotDir)
    const presentation: Config = {}

    // First composition: one cell that leaves user state AND exercises a
    // binding, so the tools/rlm/rlm_await proxies are live in the namespace
    // when the turn-end snapshot cell runs right after it.
    const first = await setupKernel(presentation, { snapshotDir })
    await stubSubagents(first.ctx, 'stub-first-session')
    const warm = await runCell(first.ctx, [
      'kept = 41',
      'import math',
      'handle = await rlm("task", label="worker")',
      'return handle["run_id"]',
    ].join('\n'), { agent: first.agent.agent })
    expect(warm.isError).toBe(false)

    const manifestPath = join(snapshotDir, 'dasher-agent', 'manifest.json')
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ManifestShape
    expect(manifest.skipped).toBe(false)
    expect(manifest.turn).toBe(1)
    // USER state is captured...
    for (const name of ['kept', 'math', 'handle']) expect(manifest.names).toContain(name)
    // ...alongside the binding surface itself (dill captures the holder and
    // callable proxies and the error class — they are plain non-shim globals).
    for (const name of ['tools', 'rlm', 'rlm_await', 'ToolCallError']) expect(manifest.names).toContain(name)
    // The exclusion semantics still hold around them: no dashr shim name
    // (the `_dashr`/`__dashr` prefix rule, any case) and none of IPython's
    // own session plumbing (`user_ns_hidden` members like exit/quit/In/Out)
    // ever enters the payload.
    expect(manifest.names.filter(name => name.toLowerCase().startsWith('_dashr') || name.toLowerCase().startsWith('__dashr'))).toEqual([])
    for (const hidden of ['exit', 'quit', 'get_ipython', 'In', 'Out']) expect(manifest.names).not.toContain(hidden)

    // Second composition, same snapshotDir + same principal (the harness's
    // fixed 'dasher-agent' session id): first boot restores before any code.
    const second = await setupKernel(presentation, { snapshotDir })
    await stubSubagents(second.ctx, 'stub-second-session')
    const resumed = await runCell(second.ctx, [
      'kind = type(kept).__name__',
      'again = await rlm("after restore")',
      'return [kind, kept, math.floor(2.5), again["run_id"]]',
    ].join('\n'), { agent: second.agent.agent })
    expect(resumed.isError).toBe(false)
    if (resumed.isError) throw new Error('restored cell failed')
    // Restored USER state is pure values, not proxy wrappers.
    expect(resumed.value).toEqual({ logs: expect.arrayContaining([expect.stringContaining('namespace restored from the turn-1 snapshot')]), result: ['int', 41, 2, 'stub-second-session'] })
    // The binding surface answers from the CURRENT host: the post-restore
    // rlm() call went to THIS composition's stub, proving the reinstall each
    // run performs over whatever the snapshot restored is effective — a
    // dangling pre-snapshot proxy could never produce this run id.
  }, 60_000)
})
