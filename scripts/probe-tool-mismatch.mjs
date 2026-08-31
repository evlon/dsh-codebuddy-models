/**
 * Reproduce the "tool calls and tool results do not match" backend error:
 * send a conversation whose assistant message declares a tool call but the
 * following user message carries a tool-result with an UNKNOWN id (simulating
 * the orphaned history dsh-matrix-agent warns about). Prints the exact
 * CodeBuddy response so we can confirm the failure wording and HTTP status.
 * Run with `node scripts/probe-tool-mismatch.mjs`.
 */
import { CredentialManager, findAuthFile } from '../lib/credentials.js'

const file = findAuthFile()
if (file === undefined) {
  console.error('no CodeBuddy auth file')
  process.exit(1)
}
const manager = new CredentialManager(file)
const headers = await manager.getHeaders()
const url = 'https://copilot.tencent.com/v2/chat/completions'

const bodies = {
  // Case 1: assistant tool_calls with NO following tool result
  missingResult: {
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: 'You are terse.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '{"path":"C:/tmp/a.txt"}' } },
        ],
      },
      { role: 'user', content: 'please continue' },
    ],
    tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }],
    stream: true,
  },
  // Case 2: tool result with unknown id (mismatch)
  unknownId: {
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: 'You are terse.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '{"path":"C:/tmp/a.txt"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_XYZ', content: 'file contents' },
      { role: 'user', content: 'please continue' },
    ],
    tools: [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } }],
    stream: true,
  },
}

for (const [name, body] of Object.entries(bodies)) {
  console.log(`\n===== ${name} =====`)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    const raw = await response.text()
    console.log('HTTP', response.status)
    console.log('body:', raw.slice(0, 1200))
  } catch (error) {
    console.log('request failed:', error?.name ?? error, error?.message ?? '')
  }
}
