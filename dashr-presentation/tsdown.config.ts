import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/py-sdk.ts'],
  // Pin the output beside the package.json `main`/`types` declarations (the
  // default dist/ would leave the exports map dangling).
  outDir: 'lib',
  // Do NOT bundle dependency types into the declaration (the same call the
  // sibling provider package makes). With `resolve: true` the emitted d.ts
  // inlined schemastery's generics (273.9 kB) under renamed type parameters
  // (`S$1`/`T$1`/`K$1`) that orphan for a consumer — verified: importing the
  // published entry with strict tsconfig and NO `skipLibCheck` fails with
  // six TS2304s — and inlined copies create duplicate type identities in a
  // composed program. External imports (273.9 kB → 9.5 kB) resolve from each
  // consumer's own tree onto the already-declared peers. The M2A-era
  // `resolver: 'tsc'` constraint is gone: nothing imports the sibling's
  // `./src/*` subpath any more (the presentation depends on the seam
  // structurally — see `src/runtime-surface.ts` — and the tests import the
  // sibling through its published root), so the default oxc resolver suffices.
  dts: { resolve: false },
  platform: 'node',
  format: 'esm',
  outputOptions: { exports: 'named' },
})