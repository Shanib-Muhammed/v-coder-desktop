'use strict';
/** Headless smoke test for the V-Coder agent core. Run: node scripts/smoke.cjs */

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { DEFS, execute } = require('../electron/tools.cjs');
const { Store, defaultSettings, BUILTIN_AGENTS } = require('../electron/store.cjs');
const providers = require('../electron/providers.cjs');
const { buildSystemPrompt, uid } = require('../electron/agent.cjs');

(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vcoder-smoke-'));
  const ctx = { cwd };

  // tools: write -> read -> edit -> grep -> glob -> list -> bash
  let r = await execute(ctx, 'write', { path: 'src/hello.js', content: 'const a = 1;\nconsole.log(a);\n' });
  assert.ok(r.output.includes('Wrote'), r.output);

  r = await execute(ctx, 'read', { path: 'src/hello.js' });
  assert.ok(r.output.includes('console.log'), r.output);

  r = await execute(ctx, 'edit', { path: 'src/hello.js', oldString: 'const a = 1;', newString: 'const a = 2;' });
  assert.ok(r.output.includes('Edited'), r.output);

  r = await execute(ctx, 'grep', { pattern: 'console\\.log', path: '.' });
  assert.ok(r.output.includes('hello.js'), r.output);

  r = await execute(ctx, 'glob', { pattern: '**/*.js' });
  assert.ok(r.output.includes('hello.js'), r.output);

  r = await execute(ctx, 'list', { path: '.', depth: 2 });
  assert.ok(r.output.includes('src/'), r.output);

  r = await execute(ctx, 'bash', { command: 'echo smoke-ok', timeout: 20000 });
  assert.ok(r.output.includes('smoke-ok'), r.output);

  r = await execute(ctx, 'edit', { path: 'src/hello.js', oldString: 'nope', newString: 'x' });
  assert.ok(r.output.includes('not found'), r.output);

  // store
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcoder-store-'));
  const store = new Store(dir, null);
  const settings = await store.init();
  assert.strictEqual(settings.theme, 'system');
  assert.ok(settings.keybinds['command.palette']);

  await store.saveSettings({ theme: 'dark', providers: [providers.makeProvider('openai', { apiKey: 'sk-test' })] });
  const s2 = await store.init();
  assert.strictEqual(s2.theme, 'dark');
  assert.strictEqual(s2.providers.length, 1);

  const session = {
    id: uid('ses'),
    title: 'Smoke',
    cwd,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [{ id: uid('msg'), role: 'user', createdAt: Date.now(), parts: [{ type: 'text', id: uid('part'), text: 'hi' }] }],
    todos: [],
  };
  await store.saveSession(session);
  const got = await store.getSession(session.id);
  assert.strictEqual(got.title, 'Smoke');
  const list = await store.listSessions();
  assert.strictEqual(list.length, 1);
  await store.deleteSession(session.id);
  assert.strictEqual((await store.listSessions()).length, 0);

  // providers
  assert.ok(providers.PRESETS.length >= 15);
  const p = providers.makeProvider('openai', { apiKey: 'sk-1' });
  const headers = providers.authHeaders(p);
  assert.strictEqual(headers.Authorization, 'Bearer sk-1');
  const a = providers.makeProvider('anthropic', { apiKey: 'k' });
  assert.strictEqual(providers.authHeaders(a)['x-api-key'], 'k');
  assert.strictEqual(providers.modelsEndpoint(a), 'https://api.anthropic.com/v1/models');

  // agent prompt
  const prompt = buildSystemPrompt({ cwd, agent: BUILTIN_AGENTS[0], platform: 'win32 x64', model: 'gpt-5' });
  assert.ok(prompt.includes('V-Coder'));
  assert.ok(prompt.includes(cwd));
  assert.ok(DEFS.length >= 9);

  // default settings shape
  const d = defaultSettings();
  assert.ok(d.permissions && d.providers && d.mcp && d.skills && d.keybinds);

  console.log('PASS  tools, store, providers, agent prompt, settings');
  console.log('tool count:', DEFS.length, '| presets:', providers.PRESETS.length);
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
