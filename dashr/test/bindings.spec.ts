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

describe('DashrRuntime — host bindings over the comm bridge', () => {
  it('carries a kernel-side call to the host fn and its resolution back', async () => {
    const { runtime } = await setupRuntime()
    const received: unknown[] = []
    const result = await runtime.run({
      program: 'reply = await tools.echo({"n": 41})\nprint(reply["n"] + 1)\nreply',
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
    const second = await runtime.run({ program: 'count = count + await tools.note({"text": "two"})\ncount', bindings })
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
        'caught',
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
        'message',
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
        'message',
      ].join('\n'),
      bindings: tools({
        lossy: async () => new Set([1, 2]) as unknown as never,
      }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toContain('lossless JSON')
  })
})

describe('DashrRuntime — flat callable namespaces with one shared error class', () => {
  /** The v0.1.5 flat shape: one callable global per tool, all sharing ToolCallError. */
  function flat(names: string[], fn: (name: string) => CodeBindingFunction): CodeBindingNamespace[] {
    return names.map(name => ({
      global: name,
      functions: { __call__: fn(name) },
      callable: true as const,
      errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' },
    }))
  }

  it('materializes ONE ToolCallError for many namespaces; failures from every global raise it with the global as toolName', async () => {
    const { runtime } = await setupRuntime()
    const result = await runtime.run({
      program: [
        'caught = {}',
        'try:',
        '    await alpha({})',
        'except ToolCallError as error:',
        '    caught["alpha"] = {"toolName": error.toolName, "cls": type(error).__name__}',
        'try:',
        '    await beta({})',
        'except ToolCallError as error:',
        '    caught["beta"] = {"toolName": error.toolName, "same": type(error) is ToolCallError}',
        'caught',
      ].join('\n'),
      bindings: flat(['alpha', 'beta'], name => async () => { throw new Error(`${name} exploded`) }),
    })
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({
      alpha: { toolName: 'alpha', cls: 'ToolCallError' },
      beta: { toolName: 'beta', same: true },
    })
  })

  it('keeps the shared class working across runs on the same kernel', async () => {
    const { runtime } = await setupRuntime()
    const bindings = flat(['alpha', 'beta'], name => async () => { throw new Error(`${name} failed again`) })
    const first = await runtime.run({
      program: [
        'try:',
        '    await alpha({})',
        'except ToolCallError as error:',
        '    message = error.toolName',
        'message',
      ].join('\n'),
      bindings,
    })
    expect(first.error).toBeUndefined()
    expect(first.value).toBe('alpha')
    const second = await runtime.run({
      program: [
        'try:',
        '    await beta({})',
        'except ToolCallError as error:',
        '    message = error.toolName',
        'message',
      ].join('\n'),
      bindings,
    })
    expect(second.error).toBeUndefined()
    expect(second.value).toBe('beta')
  })
})
