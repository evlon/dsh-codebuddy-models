/**
 * One-off diagnostic: bisect which field on a real harness-style request the
 * CodeBuddy chat backend rejects for model `auto`. Each case layers one
 * feature on top of the minimal streaming request that already succeeded.
 * Run with `node scripts/probe-models.mjs` from the package root.
 */
import { findAuthFile, CredentialManager } from '../lib/credentials.js'
import { PUBLIC_BASE_URL } from '../lib/index.js'

const file = findAuthFile()
if (file === undefined) {
  console.error('no CodeBuddy auth file found — login to the desktop client first')
  process.exit(1)
}
const manager = new CredentialManager(file)
const headers = await manager.getHeaders()
const url = `${PUBLIC_BASE_URL}/v2/chat/completions`

const TOOLS = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file from disk', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search_content', description: 'Regex search across the workspace', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
]
const SYSTEM = 'You are an AI coding assistant. You are pair programming with a USER to solve their coding task.'
const STOP = ['\n\n']

const cases = [
  { label: 'tools', tools: TOOLS },
  { label: 'system', system: SYSTEM },
  { label: 'effort=max', reasoningEffort: 'max' },
  { label: 'temperature', temperature: 0.2 },
  { label: 'stop', stop: STOP },
  { label: 'tools+system+effort high', tools: TOOLS, system: SYSTEM, reasoningEffort: 'high' },
  { label: 'tool-result history', tools: TOOLS, history: true },
]

for (const { label, tools, system, reasoningEffort, temperature, stop, history } of cases) {
  const messages = [
    ...(system === undefined ? [] : [{ role: 'system', content: system }]),
    { role: 'user', content: 'hi' },
    ...(history === true
      ? [
          { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: '"// file"' },
        ]
      : []),
  ]
  const body = {
    model: 'auto',
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 8,
    ...(tools === undefined ? {} : { tools }),
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(stop === undefined ? {} : { stop }),
  }
  let response
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch (error) {
    console.log(`${label}: transport error ${error.message}`)
    continue
  }
  const raw = (await response.text()).slice(0, 300).replace(/\n/g, ' ')
  console.log(`${label}: HTTP ${response.status} ${raw}`)
}
