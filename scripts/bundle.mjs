/**
 * Build a single self-contained ESM bundle at `lib/index.js` from
 * `src/index.ts`, inlining every runtime dependency except Node builtins.
 *
 * The DeepSeek Harness Desktop app loads plugins from its `preset-plugins`
 * folder, which carries **no `node_modules`** — so a plugin entry must have
 * zero external imports to be loadable there (this is why the app's own
 * `dsh-tauri*` plugins ship a single bundled file). Bundling keeps the
 * published package working both in the Desktop shell and under a normal
 * `dsh plugin add` install.
 *
 * `lib/index.d.ts` and the per-module type declarations still come from `tsc`
 * (the `test`/`verify` scripts import `lib/*.js` directly and are unaffected).
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(root, 'lib/index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  sourcesContent: false,
  logLevel: 'info',
  // Node builtins stay external; everything else (dsh-llm, dsh-settings,
  // schemastery, eventsource-parser) is inlined so the entry is self-contained.
  external: ['node:*'],
})

console.log('bundled lib/index.js (self-contained)')
