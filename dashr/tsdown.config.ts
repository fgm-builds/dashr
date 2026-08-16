import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/py-sdk.ts'],
  // Pin the output beside the package.json `main`/`types` declarations (the
  // default dist/ would leave the exports map dangling on a published tarball).
  outDir: 'lib',
  // Do NOT bundle dependency types into the declaration: inlined copies
  // create duplicate type identities in a consumer's program (schemastery's
  // generics appear twice and stop unifying). External imports resolve from
  // each consumer's own tree — one identity per package there.
  dts: { resolve: false },
  platform: 'node',
  format: 'esm',
  outputOptions: { exports: 'named' },
})
