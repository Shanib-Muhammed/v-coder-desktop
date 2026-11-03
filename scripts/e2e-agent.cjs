'use strict';
/**
 * End-to-end agent test with a mock OpenAI-compatible server.
 * Verifies: streaming text, streamed tool-call assembly, tool execution,
 * multi-step loop, and the second turn seeing the tool result.
 *
 * Run: node scripts/e2e-agent.cjs
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { runAgent } = require('../electron/agent.cjs');
const { makeProvider } = require('../electron/providers.cjs');
const { defaultSettings } = require('../electron/store.cjs');

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const turns = (parsed.messages || []).filter((m) => m.role === 'assistant').length;

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });

    if (turns === 0) {
      // First turn: stream a tool call to `write`, split across chunks.
      res.write(sseChunk({ choices: [{ delta: { role: 'assistant' } }] }));
      res.write(sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write', arguments: '' } }] } }] }));
      res.write(sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"mock.txt","content":"hello ' } }] } }] }));
      res.write(sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'from the mock server"}' } }] } }] }));
      res.write(sseChunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
    } else {
      // Second turn: the tool result must be present in the history.
      const toolMsg = (parsed.messages || []).find((m) => m.role === 'tool');
      assert.ok(toolMsg, 'tool result was not sent back to the model');
      assert.ok(/Wrote|mock\.txt/.test(String(toolMsg.content)), 'unexpected tool result: ' + toolMsg.content);
      res.write(sseChunk({ choices: [{ delta: { content: 'All done. ' } }] }));
      res.write(sseChunk({ choices: [{ delta: { content: 'Created mock.txt.' } }] }));
      res.write(sseChunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 } }));
    }

    res.write('data: [DONE]\n\n');
    res.end();
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vcoder-e2e-'));

  const provider = makeProvider('custom', {
    id: 'mock',
    name: 'Mock',
    type: 'openai',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'test-key',
    models: ['mock-1'],
  });

  const session = {
    id: 'ses_test',
    title: 'E2E',
    cwd,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [{ id: 'msg_1', role: 'user', createdAt: Date.now(), parts: [{ type: 'text', id: 'p1', text: 'Create mock.txt' }] }],
    todos: [],
  };

  const events = [];
  const settings = { ...defaultSettings(), permissions: { write: 'allow', read: 'allow', edit: 'allow', bash: 'deny' }, maxSteps: 5 };

  const result = await runAgent({
    session,
    provider,
    model: 'mock-1',
    agentConfig: { id: 'build', name: 'Build', tools: 'all' },
    settings,
    emit: (e) => events.push(e),
    askPermission: async () => true,
    signal: new AbortController().signal,
  });

  const text = (result.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
  const toolParts = (result.parts || []).filter((p) => p.type === 'tool');

  assert.ok(!result.error, 'agent error: ' + result.error);
  assert.strictEqual(toolParts.length, 1, 'expected one tool call');
  assert.strictEqual(toolParts[0].name, 'write');
  assert.strictEqual(toolParts[0].state, 'done');
  assert.ok(text.includes('All done'), 'final text missing: ' + text);

  const written = fs.readFileSync(path.join(cwd, 'mock.txt'), 'utf8');
  assert.strictEqual(written, 'hello from the mock server');

  assert.ok(events.some((e) => e.t === 'text'), 'no streamed text events');
  assert.ok(events.some((e) => e.t === 'done'), 'no done event');
  assert.strictEqual(session.messages.length, 2, 'expected one user message and one assistant message');
  assert.ok(session.messages[1].parts.some((p) => p.type === 'tool' && p.callId === 'call_1'));

  console.log('PASS  agent loop: stream -> tool call -> write -> final answer');
  console.log('events:', events.length, '| parts:', result.parts.length);

  server.close();
  fs.rmSync(cwd, { recursive: true, force: true });
})().catch((e) => {
  console.error('FAIL', e);
  server.close();
  process.exit(1);
});
