import { describe, expect, it } from 'vitest'
import type { CodeRunResult } from '../src/vendored/rlm-runtime.ts'
import { setupRuntime } from './helpers.ts'

/**
 * Integration suite over a REAL ipykernel subprocess (no mocks — kernels are
 * local and cheap once booted, per dsh's real-over-mock policy). Each test
 * builds a fresh context and shares nothing with the others.
 */
describe('IPythonCodeRuntime — programs on a persistent kernel', () => {
  it('registers with the seam descriptors', async () => {
    const { runtime } = await setupRuntime()
    expect(runtime.language).toBe('python')
    expect(runtime.isolation).toBe('process')
  })

  it('is stateful: variables from one run survive into the next', async () => {
    const { runtime } = await setupRuntime()
    const first = await runtime.run({ program: 'x = 40 + 2', bindings: [] })
    expect(first.error).toBeUndefined()

    const second = await runtime.run({ program: 'print(x)', bindings: [] })
    expect(second.error).toBeUndefined()
    expect(second.logs).toContain('42')
  })

  it('is stateful for mutated containers, not just scalars', async () => {
    const { runtime } = await setupRuntime()
    await runtime.run({ program: 'ledger = {"entries": []}\nledger["entries"].append("first")', bindings: [] })
    const result = await runtime.run({ program: 'ledger["entries"].append("second")\nprint(len(ledger["entries"]))', bindings: [] })
    expect(result.error).toBeUndefined()
    expect(result.logs).toContain('2')
  })

  it('preserves multi-line string literals byte-for-byte', async () => {
    const { runtime } = await setupRuntime()
    const program = [
      'template = """SELECT',
      '  id,',
      '  name',
      'FROM users"""',
      'return template',
    ].join('\n')
    const result = await runtime.run({ program, bindings: [] })
    expect(result.error).toBeUndefined()
    // Interior lines of the literal must not gain the scaffold's indentation.
    expect(result.value).toBe('SELECT\n  id,\n  name\nFROM users')
  })

  it('keeps function docstrings intact when the program is re-indented', async () => {
    const { runtime } = await setupRuntime()
    const program = [
      'def helper():',
      '    """First summary line.',
      '    Details follow."""',
      '    return 1',
      'return helper.__doc__',
    ].join('\n')
    const result = await runtime.run({ program, bindings: [] })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('First summary line.\n    Details follow.')
  })

  it('preserves an explicit null completion and omits value for no-return', async () => {
    const { runtime } = await setupRuntime()
    const explicit = await runtime.run({ program: 'return None', bindings: [] })
    expect(explicit.error).toBeUndefined()
    expect(explicit.value).toBeNull()
    const absent = await runtime.run({ program: 'pass', bindings: [] })
    expect(absent.error).toBeUndefined()
    expect(absent.value).toBeUndefined()
  })

  it('captures logs in order and returns the completion value', async () => {
    const { runtime } = await setupRuntime()
    const result = await runtime.run({ program: 'print("hello")\nprint("world")\nreturn {"sum": 40 + 2}', bindings: [] })
    expect(result.error).toBeUndefined()
    expect(result.logs).toEqual(['hello', 'world'])
    expect(result.value).toEqual({ sum: 42 })
  })

  it('supports top-level await inside the function-body contract', async () => {
    const { runtime } = await setupRuntime()
    const result = await runtime.run({
      program: 'import asyncio\nvalue = await asyncio.sleep(0, 7)\nreturn value',
      bindings: [],
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toBe(7)
  })

  it('reports a program exception as a result field with the traceback', async () => {
    const { runtime } = await setupRuntime()
    const result = await runtime.run({ program: 'print("before")\n1 / 0', bindings: [] })
    expect(result.error?.kind).toBe('exception')
    expect(result.error?.message).toContain('ZeroDivisionError')
    expect(result.logs).toEqual(['before'])
    expect(result.value).toBeUndefined()
  })

  it('reports a non-JSON completion as invalid-output', async () => {
    const { runtime } = await setupRuntime()
    const result = await runtime.run({ program: 'return object()', bindings: [] })
    expect(result.error?.kind).toBe('invalid-output')
    expect(result.value).toBeUndefined()
  })

  it('flushes state even when the program raises', async () => {
    const { runtime } = await setupRuntime()
    await runtime.run({ program: 'partial = "kept"\nraise ValueError("boom")', bindings: [] })
    const result = await runtime.run({ program: 'print(partial)', bindings: [] })
    expect(result.error).toBeUndefined()
    expect(result.logs).toContain('kept')
  })

  it('drops binding namespaces absent from the current run', async () => {
    const { runtime } = await setupRuntime()
    await runtime.run({
      program: 'pass',
      bindings: [{ global: 'tools', functions: { ping: async () => 'pong' } }],
    })
    const result: CodeRunResult = await runtime.run({ program: 'print("tools" in globals())', bindings: [] })
    expect(result.error).toBeUndefined()
    expect(result.logs).toContain('False')
  })

  it('resolves an already-aborted signal without touching the kernel', async () => {
    const { runtime } = await setupRuntime()
    const controller = new AbortController()
    controller.abort('nope')
    const result = await runtime.run({ program: 'print("never")', bindings: [], signal: controller.signal })
    expect(result.error?.kind).toBe('abort')
    expect(result.logs).toEqual([])
    // The kernel never spawned for this run.
    expect(runtime.kernelPid).toBeUndefined()
  })
})
