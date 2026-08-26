/**
 * One-off verification: compose our plugin against a real Cordis context with
 * the real `llm` runtime, and confirm the `codebuddy` provider and its models
 * register. Run with `node verify.mjs` from the package root.
 */
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as plugin from './lib/index.js'

const ctx = new Context()
const llm = new LlmRuntime(ctx)

plugin.apply(ctx, {})

const providers = llm.listProviders()
const configurable = llm.listConfigurableProviders()
const models = await llm.listModels('codebuddy')

console.log('providers:', JSON.stringify(providers))
console.log('configurable:', JSON.stringify(configurable))
console.log('codebuddy models:', models.map((m) => m.id).join(', '))
console.log('count:', models.length)

const ok =
  providers.some((p) => p.id === 'codebuddy') &&
  configurable.some((c) => c.provider === 'codebuddy') &&
  models.length > 0
console.log(ok ? 'VERIFY OK' : 'VERIFY FAILED')
process.exit(ok ? 0 : 1)
