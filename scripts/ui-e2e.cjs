'use strict';
/**
 * End-to-end UI test. Boots the real Electron window against a mock
 * OpenAI-compatible server, types into the composer, clicks Send, and checks
 * that streamed text and a tool call reach the transcript and the filesystem.
 *
 * Run: npx electron scripts/ui-e2e.cjs
 */

const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vcoder-ui-profile-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vcoder-ui-project-'));
app.setPath('userData', profile);

function log(obj) {
  console.log('UIE2E ' + JSON.stringify(obj));
}

function chunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    const turns = (parsed.messages || []).filter((m) => m.role === 'assistant').length;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

    if (turns === 0) {
      res.write(chunk({ choices: [{ delta: { content: 'Working on it. ' } }] }));
      res.write(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_ui', type: 'function', function: { name: 'write', arguments: '' } }] } }] }));
      res.write(chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"ui-mock.txt","content":"written by the ui test"}' } }] } }] }));
      res.write(chunk({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }));
    } else {
      const toolMsg = (parsed.messages || []).find((m) => m.role === 'tool');
      const ok = toolMsg && /Wrote|ui-mock\.txt/.test(String(toolMsg.content));
      res.write(chunk({ choices: [{ delta: { content: ok ? 'All done. The file is ready.' : 'Tool result missing.' } }] }));
      res.write(chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for ' + label);
    await sleep(250);
  }
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  fs.writeFileSync(
    path.join(profile, 'settings.json'),
    JSON.stringify(
      {
        version: 1,
        theme: 'dark',
        accent: 'blue',
        recentProjects: [project],
        defaultModel: { provider: 'mock', model: 'mock-1' },
        defaultAgent: 'build',
        autoTitle: true,
        maxSteps: 5,
        providers: [
          {
            id: 'mock',
            preset: 'custom',
            name: 'Mock',
            type: 'openai',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: 'test-key',
            models: ['mock-1'],
            headers: {},
            enabled: true,
          },
        ],
        permissions: {
          read: 'allow',
          list: 'allow',
          glob: 'allow',
          grep: 'allow',
          edit: 'allow',
          write: 'allow',
          bash: 'deny',
          webfetch: 'allow',
          todo: 'allow',
        },
      },
      null,
      2,
    ),
  );

  // Boot the real app: registers IPC, store, window.
  require('../electron/main.cjs');
  await app.whenReady();

  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 20000, 'browser window');
  const wc = win.webContents;

  wc.on('console-message', (...args) => {
    const ev = args[0] || {};
    if (ev.level === 'error' || ev.level === 3) log({ consoleError: String(ev.message ?? args[2] ?? '') });
  });
  wc.on('did-fail-load', (_e, code, desc) => log({ didFailLoad: code + ' ' + desc }));

  await waitFor(
    () => wc.executeJavaScript(`!!document.querySelector('[data-act="new-session"]')`).catch(() => false),
    25000,
    'sidebar',
  );

  await wc.executeJavaScript(`document.querySelector('[data-act="new-session"]').click()`);

  await waitFor(
    () => wc.executeJavaScript(`!!document.querySelector('#prompt') && !!document.querySelector('#send-btn')`).catch(() => false),
    25000,
    'composer',
  );

  await wc.executeJavaScript(`(() => {
    const ta = document.querySelector('#prompt');
    ta.value = 'Create ui-mock.txt';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#send-btn').click();
    return true;
  })()`);

  const transcript = await waitFor(
    () => wc.executeJavaScript(`(() => {
      const text = document.body.innerText || '';
      return text.includes('All done. The file is ready.') ? text : '';
    })()`).catch(() => ''),
    45000,
    'assistant reply',
  );

  const filePath = path.join(project, 'ui-mock.txt');
  const fileOk = fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === 'written by the ui test';
  const toolOk = /Write|write/.test(await wc.executeJavaScript('document.body.innerText'));

  log({
    streamedText: transcript.includes('All done'),
    toolPart: toolOk,
    fileWritten: fileOk,
    sessions: await wc.executeJavaScript('window.vcoder.sessions.list().then((s) => s.length)'),
  });

  if (!transcript.includes('All done') || !fileOk) throw new Error('UI flow did not complete');

  console.log('PASS  UI: composer -> IPC -> agent -> stream -> tool -> transcript');
  server.close();
  app.exit(0);
})().catch((e) => {
  console.error('FAIL', e && e.message ? e.message : e);
  log({ error: String(e && e.message ? e.message : e) });
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    win.webContents
      .executeJavaScript('({ url: location.href, body: (document.body.innerText || "").slice(0, 400), html: document.body.innerHTML.slice(0, 300) })')
      .then((d) => log({ page: d }))
      .catch((err) => log({ pageError: String(err && err.message) }));
  }
  server.close();
  setTimeout(() => app.exit(1), 800);
});
