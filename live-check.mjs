/**
 * One-off live check: run a real CodeBuddy chat-completions stream through the
 * adapter (credentials read from the local desktop login). Run with
 * `node live-check.mjs` from the package root.
 */
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as plugin from './lib/index.js'

const ctx = new Context()
const llm = new LlmRuntime(ctx)
plugin.apply(ctx, { model: 'glm-5.2' })

const options = {
  provider: 'codebuddy',
  model: 'deepseek-v4-flash',
  system: 'You are a terse assistant.',
  messages: [
    {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'Reply with exactly: pong' }],
      source: { kind: 'user' },
    },
  ],
}

let text = ''
let finished = false
try {
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish') {
      finished = true
      console.log('finish:', JSON.stringify(chunk.reason))
    }
  }
  console.log('model output:', JSON.stringify(text))
  console.log('finished:', finished)
  console.log(text.length > 0 ? 'LIVE OK' : 'LIVE EMPTY')
  process.exit(text.length > 0 ? 0 : 2)
} catch (error) {
  console.error('LIVE FAILED:', error)
  process.exit(1)
}
