import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { IPythonCodeRuntime } from '../src/index.ts'
import { KERNEL_PYTHON, setupRuntime } from './helpers.ts'

/**
 * M3-A session keying (blueprint §6 "kernel per-session 键控"): one service
 * instance holds one kernel per run principal, keyed the way dsh plugins key
 * state by Session/Agent. The seam's new optional `principal` is the only
 * contract surface — runs without one keep sharing the provider's default
 * key (M1 semantics), and a session's kernel dies with its session via the
 * `agent/disposed` event the provider listens for.
 */

/** True when the pid names a live process we can signal. */
function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: exists but not signalable — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Poll until the predicate holds or the budget runs out (kernel teardown is async). */
async function waitFor(predicate: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return predicate()
}

const snapshotDirs: string[] = []

afterEach(() => {
  for (const dir of snapshotDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('IPythonCodeRuntime — per-session kernel keying', () => {
  it('isolates namespaces between principals on one shared service instance', async () => {
    const { runtime } = await setupRuntime()
    await runtime.run({ program: 'secret_a = "only-a"', bindings: [], principal: 'sess-a' })

    // Session B's kernel has its own namespace: reading A's variable is a
    // NameError, not a leaked value.
    const leaked = await runtime.run({ program: 'print(secret_a)', bindings: [], principal: 'sess-b' })
    expect(leaked.error?.kind).toBe('exception')
    expect(leaked.error?.message).toContain("NameError: name 'secret_a' is not defined")

    // Two principals that ran code → two kernels, one subprocess each.
    expect(runtime.kernelPids).toHaveLength(2)

    // Each session's own kernel still works and keeps its own state.
    const own = await runtime.run({ program: 'print(secret_a)', bindings: [], principal: 'sess-a' })
    expect(own.error).toBeUndefined()
    expect(own.logs).toContain('only-a')
  }, 30_000)

  it('shares state between runs of the same principal', async () => {
    const { runtime } = await setupRuntime()
    await runtime.run({ program: 'shared = 40', bindings: [], principal: 'sess-a' })
    const result = await runtime.run({ program: 'print(shared + 2)', bindings: [], principal: 'sess-a' })
    expect(result.error).toBeUndefined()
    expect(result.logs).toContain('42')
    expect(runtime.kernelPids).toHaveLength(1)
  }, 30_000)

  it('keeps the M1 agentless default: runs without a principal share one kernel', async () => {
    const { runtime } = await setupRuntime()
    await runtime.run({ program: 'legacy = "kept"', bindings: [] })
    // An explicit empty principal normalizes onto the same default key.
    const result = await runtime.run({ program: 'print(legacy)', bindings: [], principal: '' })
    expect(result.error).toBeUndefined()
    expect(result.logs).toContain('kept')
    expect(runtime.kernelPids).toHaveLength(1)
  }, 30_000)

  it('spawns nothing for a principal until its first run (lazy per key)', async () => {
    const { runtime } = await setupRuntime()
    await runtime.run({ program: 'x = 1', bindings: [], principal: 'sess-warm' })
    // Only the principal that ran holds a subprocess — the subagent fan-out
    // guarantee: composed-but-silent sessions cost nothing.
    expect(runtime.kernelPids).toHaveLength(1)
  }, 30_000)

  it('runs different principals concurrently on their own kernels', async () => {
    const { runtime } = await setupRuntime()
    // Warm both kernels first so the measured window is pure execution.
    await runtime.run({ program: 'pass', bindings: [], principal: 'conc-a' })
    await runtime.run({ program: 'pass', bindings: [], principal: 'conc-b' })

    const slowStarted = Date.now()
    const slow = runtime.run({ program: 'import time\ntime.sleep(0.6)\nslow_done = True', bindings: [], principal: 'conc-a' })
    const fast = runtime.run({ program: 'fast_done = True\nprint("fast")', bindings: [], principal: 'conc-b' })
    const fastResult = await fast
    // The fast cell finished while the slow one was still holding ITS
    // kernel busy — per-key serialization, cross-key parallelism.
    expect(fastResult.error).toBeUndefined()
    expect(Date.now() - slowStarted).toBeLessThan(500)
    const slowResult = await slow
    expect(slowResult.error).toBeUndefined()
  }, 30_000)

  it('destroys exactly the disposed session kernel on agent/disposed', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(IPythonCodeRuntime, { python: KERNEL_PYTHON })
    const runtime = ctx.rlmRuntime as IPythonCodeRuntime
    try {
      const setupA = await runtime.run({ program: 'a = 1', bindings: [], principal: 'sess-end-a' })
      const setupB = await runtime.run({ program: 'b = 1', bindings: [], principal: 'sess-end-b' })
      expect(setupA.error).toBeUndefined()
      expect(setupB.error).toBeUndefined()
      const [pidA, pidB] = runtime.kernelPids as [number, number]
      expect(isAlive(pidA) && isAlive(pidB)).toBe(true)

      // The dsh agent registry's session-end signal, fired the way dsh-agent
      // does (untyped payload { agent: { id } }); the provider keys teardown
      // by the id its runs carried as principal.
      ctx.events.emit('agent/disposed', { agent: { id: 'sess-end-a' } })
      expect(await waitFor(() => !isAlive(pidA), 5_000)).toBe(true)
      // The other session's kernel is untouched and still works.
      expect(isAlive(pidB)).toBe(true)
      const survivor = await runtime.run({ program: 'print(b)', bindings: [], principal: 'sess-end-b' })
      expect(survivor.error).toBeUndefined()
      expect(survivor.logs).toContain('1')
      // A disposal for a key that never ran through this instance is a no-op.
      ctx.events.emit('agent/disposed', { agent: { id: 'sess-never-here' } })
      expect(runtime.kernelPids).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  }, 30_000)

  it('respawns a SIGKILLed kernel fresh on the next run, with an explicit namespace-lost error first', async () => {
    const { runtime } = await setupRuntime()
    await runtime.run({ program: 'lost = "state"', bindings: [], principal: 'sess-dead' })
    const deadPid = runtime.kernelPids[0] as number
    expect(isAlive(deadPid)).toBe(true)
    process.kill(deadPid, 'SIGKILL')
    expect(await waitFor(() => !isAlive(deadPid), 5_000)).toBe(true)

    // The first run to observe the death gets the substrate truth, not a
    // misleading NameError from executing against a vanished namespace.
    const observed = await runtime.run({ program: 'print("never")', bindings: [], principal: 'sess-dead' })
    expect(observed.error?.kind).toBe('worker-exit')
    expect(observed.error?.message).toContain('EMPTY namespace')

    // The next run boots a fresh kernel (lazy respawn) with empty state.
    const revived = await runtime.run({ program: 'print("fresh", "lost" in globals())', bindings: [], principal: 'sess-dead' })
    expect(revived.error).toBeUndefined()
    expect(revived.logs).toContain('fresh False')
    expect(runtime.kernelPids[0]).not.toBe(deadPid)
  }, 30_000)

  it('snapshots each principal into its own subdirectory on dispose', async () => {
    const snapshotDir = mkdtempSync(join(tmpdir(), 'dashr-snapshot-'))
    snapshotDirs.push(snapshotDir)
    const { fiber, runtime } = await setupRuntime({ snapshotDir })
    await runtime.run({ program: 'x = "a"', bindings: [], principal: 'sess-snap-a' })
    await runtime.run({ program: 'y = "b"', bindings: [], principal: 'sess-snap-b' })
    // Dispose deterministically (the onTestFinished disposer is idempotent)
    // so the per-key artifacts exist when this test reads them.
    await fiber.dispose()

    for (const [key, marker] of [['sess-snap-a', 'x'], ['sess-snap-b', 'y']] as const) {
      const dir = join(snapshotDir, key)
      expect(existsSync(join(dir, 'state.dill'))).toBe(true)
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { names: string[] }
      expect(manifest.names).toContain(marker)
    }
  }, 30_000)
})

describe('IPythonCodeRuntime — per-session kernel cwd', () => {
  it('spawns the kernel in the request cwd (session workspace), never the host process cwd', async () => {
    const ctx = new Context()
    const workspace = mkdtempSync(join(tmpdir(), 'dashr-cwd-'))
    snapshotDirs.push(workspace)
    const fiber = await ctx.plugin(IPythonCodeRuntime, { python: KERNEL_PYTHON, runTimeoutMs: 30_000 })
    onTestFinished(() => fiber.dispose())
    const runtime = ctx.rlmRuntime as IPythonCodeRuntime

    // The presentation layer threads `agent.session.header.cwd` down as
    // `request.cwd`; the runtime must spawn the kernel THERE, not inherit
    // the host process cwd (the pre-fix leak).
    const inside = await runtime.run({ program: 'import os; print(os.getcwd())', bindings: [], principal: 'sess-ws', cwd: workspace })
    expect(inside.error).toBeUndefined()
    expect(inside.logs.join('')).toContain(workspace)

    // Agentless / no-cwd runs have no session workspace — cwd stays the
    // spawn-time inherit.
    const agentless = await runtime.run({ program: 'import os; print(os.getcwd())', bindings: [] })
    expect(agentless.error).toBeUndefined()
    expect(agentless.logs.join('')).toContain(process.cwd())
  }, 60_000)
})
