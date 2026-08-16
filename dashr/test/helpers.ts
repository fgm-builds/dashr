import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { onTestFinished } from 'vitest'
import { IPythonCodeRuntime } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const venvPython = fileURLToPath(new URL('../.venv-kernel/bin/python', import.meta.url))

/** Interpreter for real-kernel tests: explicit override, package venv, then PATH. */
export const KERNEL_PYTHON = process.env.DASHR_TEST_PYTHON ?? (existsSync(venvPython) ? venvPython : 'python3')

/** Boot a fresh context with the ipython provider mounted, worker-thread test style. */
export async function setup(config: Config = {}): Promise<{ fiber: Awaited<ReturnType<Context['plugin']>>, runtime: IPythonCodeRuntime }> {
  const ctx = new Context()
  const fiber = await ctx.plugin(IPythonCodeRuntime, { python: KERNEL_PYTHON, ...config })
  const runtime = ctx.rlmRuntime as IPythonCodeRuntime
  // Dispose even when a spec forgets to: kernel children are not killed with
  // the worker process, so an undisposed fiber leaks an idle ipykernel
  // subprocess forever (208 leaked orphans were found mid-project). Double
  // disposal is safe — the fiber disposer is single-shot.
  onTestFinished(() => fiber.dispose())
  return { fiber, runtime }
}
