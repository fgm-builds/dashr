import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setupRuntime } from './helpers.ts'

const snapshotDirs: string[] = []

afterEach(() => {
  for (const dir of snapshotDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

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

describe('IPythonCodeRuntime — lifecycle as effects', () => {
  it('disposes the kernel subprocess on fiber dispose (pid goes away)', async () => {
    const { fiber, runtime } = await setupRuntime()
    const result = await runtime.run({ program: 'x = 40 + 2\nprint(x)', bindings: [] })
    expect(result.logs).toContain('42')
    const pid = runtime.kernelPid
    expect(pid).toBeTypeOf('number')
    expect(isAlive(pid)).toBe(true)

    await fiber.dispose()
    // The kernel gets a shutdown_request plus a grace period; allow the reaper
    // a moment before asserting the pid is gone.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(isAlive(pid)).toBe(false)
    await expect(runtime.run({ program: 'print("zombie")', bindings: [] })).rejects.toThrow(/after disposal/)
  }, 30_000)

  it('aborts an in-flight run on dispose and rejects later runs', async () => {
    const { fiber, runtime } = await setupRuntime()
    await runtime.run({ program: 'print("warm")', bindings: [] })
    const inflight = runtime.run({ program: 'import time\ntime.sleep(30)\nreturn 1', bindings: [] })
    await new Promise(resolve => setTimeout(resolve, 500))
    await fiber.dispose()
    const result = await inflight
    // Dispose settles the run without awaiting a full cell timeout.
    expect(['abort', 'timeout', 'worker-exit']).toContain(result.error?.kind)
    await expect(runtime.run({ program: 'return 1', bindings: [] })).rejects.toThrow(/after disposal/)
  }, 30_000)

  it('writes a namespace snapshot on dispose when snapshotDir is configured', async () => {
    const snapshotDir = mkdtempSync(join(tmpdir(), 'dashr-snapshot-'))
    snapshotDirs.push(snapshotDir)
    const { fiber, runtime } = await setupRuntime({ snapshotDir })
    await runtime.run({ program: 'x = 40 + 2\npayload = {"kept": True}', bindings: [] })
    await fiber.dispose()

    // M3-A: snapshots are per-session — one subdirectory per kernel key
    // (this test's runs carry no principal, so the agentless default key).
    const keyDir = join(snapshotDir, '(agentless)')
    const manifestPath = join(keyDir, 'manifest.json')
    expect(existsSync(join(keyDir, 'state.dill'))).toBe(true)
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { names: string[], pythonVersion: string }
    expect(manifest.names).toContain('x')
    expect(manifest.names).toContain('payload')
    expect(manifest.names).not.toContain('__dashr_program__')
    // IPython's own session plumbing (whose object graph is unpicklable) and
    // the shim names stay out of the snapshot — user state only.
    expect(manifest.names).not.toContain('get_ipython')
    expect(manifest.names).not.toContain('exit')
    expect(manifest.pythonVersion).toMatch(/^\d+\.\d+\.\d+$/)
  }, 30_000)

  it('times out a runaway cell and keeps the kernel usable', async () => {
    const { fiber, runtime } = await setupRuntime({ runTimeoutMs: 3_000, interruptGraceMs: 2_000 })
    const hot = await runtime.run({ program: 'while True:\n    pass', bindings: [] })
    expect(hot.error?.kind).toBe('timeout')
    // The interrupt freed the kernel: a later run still works.
    const after = await runtime.run({ program: 'print("recovered")', bindings: [] })
    expect(after.error).toBeUndefined()
    expect(after.logs).toContain('recovered')
    await fiber.dispose()
  }, 30_000)
})
