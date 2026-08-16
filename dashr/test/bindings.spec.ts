import { describe, expect, it } from 'vitest'
import type { CodeBindingFunction, CodeBindingNamespace } from '../src/vendored/rlm-runtime.ts'
import { setupRuntime } from './helpers.ts'

/** One namespace `tools` with a typed rejection class, worker-thread test style. */
function tools(functions: Record<string, CodeBindingFunction>): CodeBindingNamespace[] {
  return [{
    global: 'tools',
    functions,
    errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
  }]
}

describe('IPythonCodeRuntime — host bindings over the comm bridge', () => {
  it('carries a kernel-side call to the host fn and its resolution back', async () => {
    const { runtime } = await setupRuntime()
    const received: unknown[] = []
    const result = await runtime.run({
      program: 'reply = await tools.echo({"n": 41})\nprint(reply["n"] + 1)\nreturn reply',
      bindings: tools({
        echo: async (args: unknown) => {
          received.push(args)
          const input = args as { n: number }
          return { n: input.n + 1 }
        },
      }),
    })
    expect(result.error).toBeUndefined()
    expect(received).toEqual([{ n: 41 }])
    expect(result.logs).toContain('43')
    expect(result.value).toEqual({ n: 42 })
  })

  it('keeps host-bound state usable across runs on the same kernel', async () => {
    const { runtime } = await setupRuntime()
    const calls: string[] = []
    const bindings = tools({ note: async (args: unknown) => { calls.push(String((args as { text: string }).text)); return calls.length } })
    const first = await runtime.run({ program: 'count = await tools.note({"text": "one"})', bindings })
    expect(first.error).toBeUndefined()
    const second = await runtime.run({ program: 'count = count + await tools.note({"text": "two"})\nreturn count', bindings })
    expect(second.error).toBeUndefined()
    expect(second.value).toBe(3)
    expect(calls).toEqual(['one', 'two'])
  })

  it('turns a host rejection into the declared typed error class', async () => {
    const { runtime } = await setupRuntime()
    const result = await runtime.run({
      program: [
        'caught = {}',
        'try:',
        '    await tools.fail({})',
        'except ToolCallError as error:',
        '    caught = {"typed": True, "toolName": error.toolName, "message": str(error)}',
        'return caught',
      ].join('\n'),
      bindings: tools({
        fail: async () => { throw new Error('host exploded') },
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ typed: true, toolName: 'fail', message: 'host exploded' })
  })

  it('answers an unknown binding name with a rejection, not a host crash', async () => {
    const { runtime } = await setupRuntime()
    const result = await runtime.run({
      program: [
        'message = "no-error"',
        'try:',
        '    await tools.absent({})',
        'except Exception as error:',
        '    message = str(error)',
        'return message',
      ].join('\n'),
      bindings: tools({ present: async () => 'here' }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toContain('unknown binding')
  })

  it('rejects a lossy host resolution with a descriptive error', async () => {
    const { runtime } = await setupRuntime()
    const result = await runtime.run({
      program: [
        'message = "no-error"',
        'try:',
        '    await tools.lossy({})',
        'except Exception as error:',
        '    message = str(error)',
        'return message',
      ].join('\n'),
      bindings: tools({
        lossy: async () => new Set([1, 2]) as unknown as never,
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toContain('lossless JSON')
  })
})
