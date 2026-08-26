/**
 * Faithful reproduction of a harness agent-loop stream call through our
 * adapter: a reasoning effort, tool schemas, and text messages. Run with
 * `node live-check.mjs` from the package root.
 */
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import * as plugin from './lib/index.js'

const ctx = new Context()
const llm = new LlmRuntime(ctx)
plugin.apply(ctx, {})

const tools = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file at an absolute path.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path of the file.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
]

const options = {
  provider: 'codebuddy',
  model: 'deepseek-v4-flash',
  system: 'You are a terse file assistant.',
  reasoningEffort: 'high',
  maxTokens: 1000,
  tools,
  messages: [
    {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'Use read_file to read C:/tmp/a.txt, then reply only with the path.' }],
      source: { kind: 'user' },
    },
  ],
}

let text = ''
const toolCalls = []
let finish
try {
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
      toolCalls.push({ name: chunk.block.name, id: chunk.block.id, arguments: chunk.block.arguments })
    }
    if (chunk.type === 'finish') finish = chunk.reason
  }
  console.log('model output:', JSON.stringify(text))
  console.log('tool-call blocks:', JSON.stringify(toolCalls))
  console.log('finish:', JSON.stringify(finish))
  const usable = text.length > 0 || (toolCalls.length > 0 && toolCalls[0].name.length > 0)
  console.log(usable ? 'HARNESS-PATH OK' : 'HARNESS-PATH EMPTY')
  process.exit(usable ? 0 : 2)
} catch (error) {
  console.error('HARNESS-PATH FAILED:', error)
  process.exit(1)
}
