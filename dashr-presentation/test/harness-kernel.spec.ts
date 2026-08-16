import { describe, expect, it, onTestFinished } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { runCell, setupKernel } from './helpers.ts'
import type { Config } from '../src/index.ts'

/**
 * M4-B end-to-end on the REAL kernel: `refine` and `compact` as bare callable
 * globals inside an actual cell (the `_dashr_make_callable` path), with the
 * LLM and compaction seams stubbed host-side. Mirrors the rlm() e2e tier in
 * preset.spec: the kernel is real, the host services are fakes.
 */

/** Mount a stub `ctx.llm` answering a fixed ops array. */
async function stubLlm(ctx: import('@deepseek-ai/cordis').Context, text: string): Promise<void> {
  const fiber = await ctx.plugin({ name: 'stub-llm', apply(c) {
    c.provide('llm', {
      async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
  } })
  onTestFinished(() => fiber.dispose())
}

describe('refine() / compact() on a real kernel', () => {
  it('awaits refine(instruction) inside a cell, and the next assembly carries the new entry', async () => {
    const { ctx, agent } = await setupKernel({ refineModel: 'zai/glm-5.2' } satisfies Config)
    await stubLlm(ctx, '[{"op":"add","kind":"memory","title":"Kernel fact","content":"The kernel answers refine() calls."}]')
    const result = await runCell(ctx, `import json\nres = await refine('remember how the kernel answers')\nprint(json.dumps(res['applied']))\nreturn res`, { agent: agent.agent, description: 'Refine the harness from a real cell' })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    const value = result.value as { logs: string[], result?: { refined?: boolean, applied?: unknown[] } }
    expect(value.result?.refined).toBe(true)
    expect(value.logs.join('\n')).toContain('"op": "add"')
    const assembly = await ctx.systemPrompt.assemble({ agent: agent.agent, scope: agent.agent })
    expect(assembly.sections.find(section => section.name === 'dasher:harness')?.text).toContain('Kernel fact')
  })

  it('awaits compact() inside a cell and returns the structured ladder result', async () => {
    const { ctx, agent } = await setupKernel({})
    const fiber = await ctx.plugin({ name: 'stub-compaction', apply(c) {
      c.provide('compaction', {
        async compactNow() {
          const error = new Error('manual compaction requires an idle agent') as Error & { code: string }
          error.code = 'busy'
          throw error
        },
        async compactIfNeeded() {
          return { compactionId: 'cmp-9', summarySeq: 7, shadowedSeqs: [1], shadowedTokenCount: 50 }
        },
      })
    } })
    onTestFinished(() => fiber.dispose())
    const result = await runCell(ctx, `res = await compact()\nreturn res`, { agent: agent.agent, description: 'Compact from a real cell' })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    const value = result.value as { result?: { status?: string, path?: string } }
    expect(value.result).toMatchObject({ status: 'compacted', path: 'pressure', shadowed_tokens: 50 })
  })
})
