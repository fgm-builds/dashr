import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    // One real IPython kernel per suite is expensive to boot; keep suites
    // serial so parallel kernels don't multiply boot latency and port churn.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})
