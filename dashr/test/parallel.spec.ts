import { describe, expect, it } from 'vitest'
import { setupRuntime } from './helpers.ts'

/**
 * Concurrent-run discipline (blueprint §6 M1 补遗, delivered in M2): the
 * kernel is ONE serial executor — `IpyKernelBridge.executeCell` awaits the
 * previous cell before sending the next `execute_request` — so two racing
 * `runtime.run()` calls must serialize on the enqueue path, never interleave
 * on the kernel, and never exchange results. A regression here would corrupt
 * the state-codification contract (channel ②): interleaved cells would make
 * "variables survive across runs" meaningless.
 */
/** Narrow a JSON completion value to the array the test cells return. */
function asTuple(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(`expected an array completion value, got ${String(value)}`)
  return value
}

describe('DashrRuntime — concurrent runs on one kernel', () => {
  it('serializes two concurrent runs and attributes each result to its own cell', async () => {
    const { runtime } = await setupRuntime()
    // Warm the kernel first so both timed cells enter executeCell with the
    // process already up: the assertion below isolates queue serialization
    // from kernel-boot latency.
    const boot = await runtime.run({ program: 'pass', bindings: [] })
    expect(boot.error).toBeUndefined()

    // The slow cell starts the clock, sleeps, then plants its marker; the
    // fast cell (submitted immediately after, WITHOUT awaiting the first)
    // must not execute until the slow cell has fully settled — which the
    // marker observation proves without relying on wall-clock margins alone.
    const slow = runtime.run({
      program: [
        'import time',
        'gate = time.monotonic()',
        'time.sleep(0.8)',
        'slow_marker = "slow-settled"',
        '("slow", gate)',
      ].join('\n'),
      bindings: [],
    })
    const fast = runtime.run({
      program: [
        'import time',
        '("fast", time.monotonic(), slow_marker, gate)',
      ].join('\n'),
      bindings: [],
    })
    const [slowResult, fastResult] = await Promise.all([slow, fast])

    // Both cells completed successfully.
    expect(slowResult.error).toBeUndefined()
    expect(fastResult.error).toBeUndefined()

    // Result attribution: each result carries its own completion value, not
    // the sibling cell's (logs stay per-run too — the slow cell printed
    // nothing, the fast cell printed nothing, and neither value crossed).
    const slowTuple = asTuple(slowResult.value)
    const fastTuple = asTuple(fastResult.value)
    expect(slowTuple[0]).toBe('slow')
    expect(fastTuple[0]).toBe('fast')

    // Serialization, part one (state): the fast cell observed the slow
    // cell's finished state, so it executed strictly afterwards.
    expect(fastTuple[2]).toBe('slow-settled')

    // Serialization, part two (time): the fast cell's own clock reading is
    // not earlier than the slow cell's start plus its sleep. A parallel
    // kernel execution would run the fast cell ~0ms after submission.
    const slowStart = slowTuple[1]
    const fastEnd = fastTuple[1]
    if (typeof slowStart !== 'number' || typeof fastEnd !== 'number') throw new Error('missing timing values')
    expect(fastEnd).toBeGreaterThanOrEqual(slowStart + 0.75)
  })

  it('keeps per-run logs separate when both concurrent cells print', async () => {
    const { runtime } = await setupRuntime()
    const boot = await runtime.run({ program: 'pass', bindings: [] })
    expect(boot.error).toBeUndefined()

    const first = runtime.run({ program: 'print("alpha-1")\nprint("alpha-2")', bindings: [] })
    const second = runtime.run({ program: 'print("beta-1")', bindings: [] })
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult.error).toBeUndefined()
    expect(secondResult.error).toBeUndefined()
    // Each capture belongs to exactly one cell — no interleaving, no
    // cross-attribution of stream output.
    expect(firstResult.logs).toEqual(['alpha-1', 'alpha-2'])
    expect(secondResult.logs).toEqual(['beta-1'])
  })
})
