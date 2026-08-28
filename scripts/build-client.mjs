/**
 * Build the browser half: bundle `src/client-main.js` into a self-contained
 * `lib/client.js`, wrapped in the `window.__ModuleLoader__.load({ id, factory })`
 * form dsh web requires.
 *
 * dsh's client-modules loader requires each client half to register as
 * `window.__ModuleLoader__.load({ id, factory })`: `factory(require)` returns
 * `module.exports`, which must export `apply` (plugin entry) and `inject`
 * (declared service dependencies).
 *
 * Bundling strategy (mirrors `dsh-matrix-agent/scripts/build-client.mjs`):
 * - esbuild bundles to CJS (`format: 'cjs'`, `platform: 'browser'`);
 * - `react` is externalized: it is the shell seed injected by dsh's module
 *   system via `factory(require)`, and inlining it would conflict with the
 *   shell's React instance (hooks break);
 * - banner/footer wrap esbuild's CJS output in the factory closure so the
 *   generated `require("react")` resolves through dsh's injection.
 *
 * A `node --check` syntax gate runs after bundling: a syntax error here would
 * make dsh web report "loaded without registering" and refuse the plugin.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'src', 'client-main.js')
const dest = join(root, 'lib', 'client.js')

const BANNER = `window.__ModuleLoader__.load({
  id: "dsh-codebuddy-models",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`
const FOOTER = `    return module.exports;
  }
});
`

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  external: ['react'],
  write: false,
  minify: false,
  sourcemap: false,
  logLevel: 'error',
})

if (result.outputFiles.length === 0) {
  throw new Error('[build-client] esbuild produced no output')
}
const body = result.outputFiles[0].text

mkdirSync(dirname(dest), { recursive: true })
writeFileSync(dest, BANNER + body + FOOTER, 'utf8')
console.log(`[build-client] ${dest} (${body.length} bytes code)`)

// Syntax gate: fail the build on a malformed bundle.
execFileSync(process.execPath, ['--check', dest], { stdio: 'inherit' })
console.log('[build-client] syntax OK')
