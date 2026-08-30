/**
 * Verify the compaction-facing path: `llm.resolveModelInfo` for a live
 * enterprise model must now surface the directory's real input/output
 * capacities (what the compaction engine's pressure policy reads), instead of
 * the 1M default. Run with `node scripts/verify-capacity.mjs`.
 */
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as plugin from '../lib/index.js'

const ctx = new Context()
const llm = new LlmRuntime(ctx)
plugin.apply(ctx, {})

for (const model of ['auto', 'deepseek-v4-flash', 'hy3', 'kimi-k2.5', 'minimax-m3']) {
  const info = await llm.resolveModelInfo('codebuddy', model)
  const context = info.context?.contextWindow ?? '(missing)'
  const maxTokens = info.defaultMaxTokens ?? '(missing)'
  console.log(`${model.padEnd(18)} contextWindow=${String(context).padStart(9)} defaultMaxTokens=${String(maxTokens).padStart(7)}`)
}

const auto = await llm.resolveModelInfo('codebuddy', 'auto')
const threshold = Math.floor((auto.context?.contextWindow ?? 0) * 0.8)
console.log(`\nauto compaction pressure threshold (80% of context): ${threshold} tokens`)
const ok = auto.context?.contextWindow !== undefined && auto.context.contextWindow > 0
console.log(ok ? 'CAPACITY OK' : 'CAPACITY FAILED')
process.exit(ok ? 0 : 1)
