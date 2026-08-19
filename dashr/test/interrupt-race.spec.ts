import { describe, expect, it } from 'vitest'
import { setupRuntime } from './helpers.ts'

/**
 * M3-A regression suite for the SIGALRM-at-idle double window (blueprint §5,
 * dev/m2a-report.md §5.1): the M1 dual-channel interrupt sent the zmq
 * interrupt_request and SIGALRM in the same tick, so an abort/timeout whose
 * cell had not started (or had already finished) SIGALRM'd an IDLE kernel —
 * its handler raised KeyboardInterrupt at the top level and the process
 * exited cleanly. Measured kill rates pre-fix: same-tick abort 10/10,
 * +1-2ms 8/10, cold-boot 40/40.
 *
 * The fix is two-layered and every scenario below exercises both: the host
 * escalates to SIGALRM only after a confirm window in which the zmq interrupt
 * alone settles any yielding cell, and the kernel-side busy guard swallows a
 * SIGALRM that still lands outside cell execution. The hard-abort contract —
 * "stops the program hard, even mid-loop" — is pinned by the busy-loop case:
 * `while True: pass` must break inside the grace, not ride it out.
 *
 * Kill-class scenarios repeat ≥10× per the M2A methodology: a race that was
 * deterministic must stay deterministically fixed. Survival is asserted on
 * the PID (unchanged across the abort), so a silent death-and-respawn cannot
 * mask a regression.
 */

/** Fast budgets so the confirm/grace ladder is measurable in wall time. */
const RACE_CONFIG = { interruptConfirmMs: 120, interruptGraceMs: 1_500 }

describe('DashrRuntime — interrupt race windows (M3-A)', () => {
  it('survives abort fired on the same tick as run() — 10/10, pid stable', async () => {
    const { runtime } = await setupRuntime(RACE_CONFIG)
    for (let trial = 1; trial <= 10; trial++) {
      const controller = new AbortController()
      const pending = runtime.run({ program: `race_marker = ${trial}`, bindings: [], signal: controller.signal })
      // Same tick as run(): the abort lands before the cell starts (and on
      // trial 1, before the kernel even finishes booting).
      controller.abort(`same-tick-${trial}`)
      const result = await pending
      expect(result.error?.kind, `trial ${trial}`).toBe('abort')

      // The kernel survived (same pid, state intact) — and if the aborted
      // cell did run to completion after the force-settle, its side effect
      // is benign; what must NEVER happen is the substrate dying.
      const verify = await runtime.run({ program: `print("alive", race_marker is not None)`, bindings: [] })
      expect(verify.error, `trial ${trial}`).toBeUndefined()
    }
    expect(runtime.kernelPids).toHaveLength(1)
  }, 60_000)

  it('survives abort during cold boot — 10/10 fresh kernels', async () => {
    for (let trial = 1; trial <= 10; trial++) {
      const { runtime } = await setupRuntime(RACE_CONFIG)
      const controller = new AbortController()
      const pending = runtime.run({ program: 'print("boot-race")', bindings: [], signal: controller.signal })
      // Wait for the subprocess to exist, then abort while it is still
      // mid-boot (the 40/40 window): boot takes hundreds of ms, so the pid
      // is observable long before the kernel is ready. Pin the pid FIRST —
      // a silent death-and-respawn (ranCells=false) must not mask a
      // regression.
      const bootDeadline = Date.now() + 5_000
      while (runtime.kernelPids.length === 0 && Date.now() < bootDeadline) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const pid = runtime.kernelPids[0]
      expect(pid, `trial ${trial}`).toBeDefined()
      await new Promise(resolve => setTimeout(resolve, 30))
      controller.abort(`boot-${trial}`)
      const result = await pending
      expect(result.error?.kind, `trial ${trial}`).toBe('abort')

      // Same instance, same pid: the kernel that finished booting is alive.
      const verify = await runtime.run({ program: 'print("alive")', bindings: [] })
      expect(verify.error, `trial ${trial}`).toBeUndefined()
      expect(verify.logs).toContain('alive')
      expect(runtime.kernelPids[0], `trial ${trial}`).toBe(pid)
    }
  }, 120_000)

  it('survives an abort that fires while its run sits queued behind a busy cell (idle-kernel ladder) — 10/10', async () => {
    const { runtime } = await setupRuntime(RACE_CONFIG)
    await runtime.run({ program: 'queued_warm = 1', bindings: [] })
    const pid = runtime.kernelPids[0]
    expect(pid).toBeDefined()
    for (let trial = 1; trial <= 10; trial++) {
      // First cell holds the kernel busy; the second run queues with an
      // already-aborting signal, so its interrupt ladder fires the instant
      // it dequeues — against a kernel that just went idle. Pre-fix this is
      // the deterministic idle-kernel SIGALRM kill.
      const first = runtime.run({ program: 'import time\ntime.sleep(0.25)', bindings: [] })
      const controller = new AbortController()
      const second = runtime.run({ program: 'print("queued")', bindings: [], signal: controller.signal })
      await new Promise(resolve => setTimeout(resolve, 60))
      controller.abort(`queued-${trial}`)
      const [firstResult, secondResult] = await Promise.all([first, second])
      expect(firstResult.error, `trial ${trial}`).toBeUndefined()
      expect(secondResult.error?.kind, `trial ${trial}`).toBe('abort')

      // Idle kernel survived the ladder: same pid, still usable.
      expect(runtime.kernelPids[0]).toBe(pid)
      const verify = await runtime.run({ program: 'print("alive")', bindings: [] })
      expect(verify.error, `trial ${trial}`).toBeUndefined()
    }
  }, 60_000)

  it('still breaks a busy while-True loop on abort, inside the grace — hard-abort contract', async () => {
    const { runtime } = await setupRuntime(RACE_CONFIG)
    await runtime.run({ program: 'busy_warm = 1', bindings: [] })
    const pid = runtime.kernelPids[0]
    for (let trial = 1; trial <= 10; trial++) {
      const controller = new AbortController()
      const pending = runtime.run({ program: 'while True:\n    pass', bindings: [], signal: controller.signal })
      // Let the loop get genuinely busy: the zmq interrupt cannot land (the
      // kernel event loop never runs), so only the SIGALRM escalation can
      // break it.
      await new Promise(resolve => setTimeout(resolve, 150))
      const abortAt = Date.now()
      controller.abort(`busy-${trial}`)
      const result = await pending
      const settleMs = Date.now() - abortAt
      expect(result.error?.kind, `trial ${trial}`).toBe('abort')
      // Broke via the escalation (~interruptConfirmMs), NOT by riding out
      // the force-settle grace (interruptGraceMs): 120ms vs 1500ms budget.
      expect(settleMs, `trial ${trial} settled in ${settleMs}ms`).toBeLessThan(1_000)

      // The kernel that was broken mid-loop is still the same live process.
      expect(runtime.kernelPids[0]).toBe(pid)
      const verify = await runtime.run({ program: 'print("alive")', bindings: [] })
      expect(verify.error, `trial ${trial}`).toBeUndefined()
    }
  }, 60_000)
})
