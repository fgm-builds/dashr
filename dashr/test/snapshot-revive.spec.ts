import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setupRuntime } from './helpers.ts'

/**
 * M3-B namespace persistence (blueprint §8): turn-end size-capped snapshots,
 * restore-on-first-boot, and the death→revive chain that respawns onto the
 * nearest replayable snapshot. Real kernels throughout; every provider is
 * disposed through the helper's onTestFinished hook, and the orphan gate
 * (`pgrep ipykernel_launcher`) runs after the suite.
 */

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
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitFor(predicate: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return predicate()
}

describe('DashrRuntime — snapshot, restore, revive', () => {
  it('restores the last turn-end snapshot for the same principal on a fresh provider', async () => {
    const snapshotDir = mkdtempSync(join(tmpdir(), 'dashr-snapshot-'))
    snapshotDirs.push(snapshotDir)

    const first = await setupRuntime({ snapshotDir })
    await first.runtime.run({ program: 'kept = 40 + 1', bindings: [], principal: 'sess-resume' })
    await first.fiber.dispose()
    const manifestPath = join(snapshotDir, 'sess-resume', 'manifest.json')
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { turn: number, pythonVersion: string, venvPath: string, skills: string[], sizeBytes: number, skipped: boolean }
    expect(manifest.turn).toBe(1)
    expect(manifest.pythonVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(manifest.venvPath).toBeTypeOf('string')
    expect(manifest.skills).toEqual([])
    expect(manifest.skipped).toBe(false)

    // A NEW provider (a resumed session) restores before running user code.
    const second = await setupRuntime({ snapshotDir })
    const resumed = await second.runtime.run({ program: 'print(kept)', bindings: [], principal: 'sess-resume' })
    expect(resumed.error).toBeUndefined()
    expect(resumed.logs).toContain('41')
    expect(resumed.logs.some(line => line.includes('namespace restored from the turn-1 snapshot'))).toBe(true)
    await second.fiber.dispose()
  }, 30_000)

  it('degrades to an empty namespace and tells the model when the manifest is not replayable', async () => {
    const snapshotDir = mkdtempSync(join(tmpdir(), 'dashr-snapshot-'))
    snapshotDirs.push(snapshotDir)

    const first = await setupRuntime({ snapshotDir })
    await first.runtime.run({ program: 'doomed = "state"', bindings: [], principal: 'sess-mismatch' })
    await first.fiber.dispose()

    // Corrupt the manifest's python version: replayability check must reject it.
    const manifestPath = join(snapshotDir, 'sess-mismatch', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest['pythonVersion'] = '0.0.0'
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const second = await setupRuntime({ snapshotDir })
    const degraded = await second.runtime.run({ program: 'print("doomed" in globals())', bindings: [], principal: 'sess-mismatch' })
    expect(degraded.error).toBeUndefined()
    expect(degraded.logs).toContain('False')
    expect(degraded.logs.some(line => line.includes('snapshot not replayable'))).toBe(true)
    expect(degraded.logs.some(line => line.includes('EMPTY namespace'))).toBe(true)
    await second.fiber.dispose()
  }, 30_000)

  it('revives a dead kernel onto its nearest snapshot and names the lost rounds', async () => {
    const snapshotDir = mkdtempSync(join(tmpdir(), 'dashr-snapshot-'))
    snapshotDirs.push(snapshotDir)
    const { runtime } = await setupRuntime({ snapshotDir })
    await runtime.run({ program: 'a = 1', bindings: [], principal: 'sess-revive' })
    await runtime.run({ program: 'b = 2', bindings: [], principal: 'sess-revive' })
    const deadPid = runtime.kernelPids[0] as number
    expect(isAlive(deadPid)).toBe(true)

    process.kill(deadPid, 'SIGKILL')
    expect(await waitFor(() => !isAlive(deadPid), 5_000)).toBe(true)

    // The death-observing run does NOT execute: it respawns onto the turn-2
    // snapshot and reports the one lost round (turn 3 - turn 2).
    const observed = await runtime.run({ program: 'print("never")', bindings: [], principal: 'sess-revive' })
    expect(observed.error?.kind).toBe('worker-exit')
    expect(observed.error?.message).toContain('restored from the turn-2 snapshot')
    expect(observed.error?.message).toContain('1 round')

    // The next run executes on the restored namespace: both a and b survive.
    const revived = await runtime.run({ program: 'print(a + b)', bindings: [], principal: 'sess-revive' })
    expect(revived.error).toBeUndefined()
    expect(revived.logs).toContain('3')
    expect(runtime.kernelPids[0]).not.toBe(deadPid)
  }, 30_000)

  it('skips an over-cap turn-end snapshot and warns the model exactly once', async () => {
    const snapshotDir = mkdtempSync(join(tmpdir(), 'dashr-snapshot-'))
    snapshotDirs.push(snapshotDir)
    const { runtime } = await setupRuntime({ snapshotDir, snapshotSizeCapBytes: 10_000 })

    // ~50KB of string is estimated over the 10KB cap before any dill IO.
    const first = await runtime.run({ program: 'big = "x" * 50000', bindings: [] })
    expect(first.error).toBeUndefined()
    expect(first.logs.some(line => line.includes('namespace snapshot skipped'))).toBe(true)
    // Skipped snapshots never replace a previous good one — there was none.
    expect(existsSync(join(snapshotDir, '(agentless)', 'manifest.json'))).toBe(false)
    expect(existsSync(join(snapshotDir, '(agentless)', 'state.dill'))).toBe(false)

    // The warning is one-time: a second over-cap run skips silently.
    const second = await runtime.run({ program: 'big2 = "y" * 50000', bindings: [] })
    expect(second.error).toBeUndefined()
    expect(second.logs.some(line => line.includes('namespace snapshot skipped'))).toBe(false)
  }, 30_000)
})
