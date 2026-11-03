'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, safeStorage, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');

const { Store, defaultSettings, BUILTIN_AGENTS } = require('./store.cjs');
const providers = require('./providers.cjs');
const { runAgent, compactSession, buildSystemPrompt, uid } = require('./agent.cjs');
const tools = require('./tools.cjs');

const isDev = process.argv.includes('--dev');
const isMac = process.platform === 'darwin';
const isSmoke = process.argv.includes('--smoke');

if (isSmoke) {
  app.disableHardwareAcceleration();
  app.setPath('userData', path.join(require('os').tmpdir(), 'vcoder-smoke-profile-' + Date.now()));
}

let win = null;
let store = null;
const runs = new Map(); // sessionId -> AbortController
const pendingPermissions = new Map(); // requestId -> resolve
const terminals = new Map(); // runId -> child

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

/* ------------------------------------------------------------------ helpers */

function publicSettings() {
  const s = store.getSettings();
  return {
    ...s,
    providers: (s.providers || []).map((p) => ({
      ...p,
      apiKey: '',
      hasKey: Boolean(p.apiKey || p.apiKeyEnc),
      keySource: p.apiKey || p.apiKeyEnc ? 'stored' : 'none',
    })),
  };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function findProvider(id) {
  return (store.getSettings().providers || []).find((p) => p.id === id) || null;
}

function resolveModel(session) {
  const s = store.getSettings();
  const wanted = session.model || s.defaultModel;
  if (!wanted || !wanted.provider) throw new Error('No model selected. Open Settings → Providers and connect a provider.');
  const provider = findProvider(wanted.provider) || envProvider(wanted.provider);
  if (!provider) throw new Error(`Provider "${wanted.provider}" is not configured.`);
  if (!provider.apiKey && !isLocalProvider(provider)) {
    throw new Error(`Add an API key for ${provider.name} in Settings → Providers.`);
  }
  return { provider, model: wanted.model };
}

function isLocalProvider(p) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)/i.test(p.baseUrl || '');
}

function envProvider(id) {
  const preset = providers.preset(id);
  if (!preset || !preset.keyEnv) return null;
  const key = process.env[preset.keyEnv];
  if (!key) return null;
  return {
    id: preset.id,
    preset: preset.id,
    name: preset.name,
    type: preset.type,
    baseUrl: preset.baseUrl,
    apiKey: key,
    models: preset.models,
    enabled: true,
    source: 'environment',
  };
}

function availableProviders() {
  const configured = store.getSettings().providers || [];
  const ids = new Set(configured.map((p) => p.id));
  const extra = [];
  for (const preset of providers.PRESETS) {
    if (ids.has(preset.id)) continue;
    const env = envProvider(preset.id);
    if (env) extra.push(env);
  }
  return [...configured, ...extra];
}

function buildAgentConfig(agentId) {
  const s = store.getSettings();
  if (agentId === 'plan') return { ...BUILTIN_AGENTS[1], tools: 'readonly' };
  const custom = (s.agents || []).find((a) => a.id === agentId);
  if (custom) return { tools: 'all', ...custom };
  return { ...BUILTIN_AGENTS[0] };
}

function readJsonBody(body) {
  return body;
}

/* ------------------------------------------------------------------- window */

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 880,
    minHeight: 620,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#080808' : '#fafafa',
    frame: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 14, y: 14 } : undefined,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      webviewTag: false,
    },
  });

  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media' || permission === 'geolocation') callback(false);
    else callback(true);
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));

  if (isSmoke) {
    const errors = [];
    win.webContents.on('console-message', (...args) => {
      const ev = args[0] || {};
      const level = ev.level !== undefined ? ev.level : args[1];
      const message = ev.message !== undefined ? ev.message : args[2];
      if (level === 'error' || level === 3) errors.push(String(message));
    });
    win.webContents.on('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 2500));
      try {
        const result = await win.webContents.executeJavaScript(`(() => {
          const q = (s) => !!document.querySelector(s);
          const click = (s) => { const el = document.querySelector(s); if (el) el.click(); return !!el; };
          const out = {
            title: document.title,
            theme: document.documentElement.dataset.theme,
            sidebar: q('.sidebar'),
            main: q('.main-wrap'),
            titlebar: q('.titlebar'),
            statusbar: q('.statusbar'),
            home: q('.home'),
            brand: q('.brand'),
            sidebarItems: document.querySelectorAll('.sb-item').length,
            heading: (document.querySelector('.home h1')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90),
          };
          click('[data-act="open-palette"]');
          out.palette = q('.palette');
          out.paletteItems = document.querySelectorAll('.palette .menu-row').length;
          document.querySelector('.overlay')?.click();
          document.querySelector('[data-act="open-settings"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          out.settings = q('.sheet-nav');
          out.settingsSections = document.querySelectorAll('.sheet-nav .nav-item').length;
          return out;
        })()`);
        console.log('SMOKE ' + JSON.stringify({ result, errors }));
        const ok = !errors.length && result.sidebar && result.main && result.home && result.palette && result.settings;
        app.exit(ok ? 0 : 1);
      } catch (e) {
        console.log('SMOKE ' + JSON.stringify({ error: String(e && e.message), errors }));
        app.exit(1);
      }
    });
  }

  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('maximize', () => send('win:state', { maximized: true }));
  win.on('unmaximize', () => send('win:state', { maximized: false }));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });
}

// Uses the OS keychain to encrypt API keys at rest. Returns null when no
// backend is available (e.g. bare Linux without a secret service) so the app
// still works, just without encryption.
async function makeCipher() {
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return null;
    return {
      encrypt: async (value) => (await safeStorage.encryptStringAsync(String(value))).toString('base64'),
      decrypt: async (value) => {
        const once = await safeStorage.decryptStringAsync(Buffer.from(String(value), 'base64'));
        if (!once.shouldReEncrypt) return once.result;
        const again = await safeStorage.decryptStringAsync(Buffer.from(String(value), 'base64'));
        return again.result;
      },
    };
  } catch {
    return null;
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId('ai.vcoder.desktop');

  const cipher = await makeCipher();

  store = new Store(app.getPath('userData'), cipher);
  await store.init();

  Menu.setApplicationMenu(
    isMac
      ? Menu.buildFromTemplate([
          { role: 'appMenu' },
          { role: 'editMenu' },
          {
            label: 'View',
            submenu: [
              { role: 'reload' },
              { role: 'toggleDevTools' },
              { type: 'separator' },
              { role: 'resetZoom' },
              { role: 'zoomIn' },
              { role: 'zoomOut' },
              { type: 'separator' },
              { role: 'togglefullscreen' },
            ],
          },
          { role: 'windowMenu' },
        ])
      : null,
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

/* ---------------------------------------------------------------- IPC: app */

ipcMain.handle('app:info', async () => ({
  version: app.getVersion(),
  name: 'V-Coder',
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  userData: app.getPath('userData'),
  home: app.getPath('home'),
  dark: nativeTheme.shouldUseDarkColors,
  cpus: require('os').cpus().length,
  totalMem: Math.round(require('os').totalmem() / 1024 / 1024 / 1024),
}));

ipcMain.handle('app:openExternal', async (_e, url) => {
  if (/^https?:\/\//i.test(String(url))) await shell.openExternal(url);
  return true;
});

ipcMain.handle('app:copy', (_e, text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});

ipcMain.handle('app:openPath', async (_e, p) => {
  await shell.openPath(p);
  return true;
});

ipcMain.handle('win:minimize', () => win?.minimize());
ipcMain.handle('win:maximize', () => {
  if (!win) return false;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
  return win.isMaximized();
});
ipcMain.handle('win:close', () => win?.close());
ipcMain.handle('win:state', () => ({ maximized: Boolean(win?.isMaximized()), fullscreen: Boolean(win?.isFullScreen()) }));
ipcMain.handle('win:toggleFullscreen', () => {
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return win.isFullScreen();
});

/* ----------------------------------------------------------- IPC: settings */

ipcMain.handle('settings:get', () => publicSettings());

ipcMain.handle('settings:set', async (_e, patch) => {
  const clean = { ...patch };
  delete clean.providers;
  await store.saveSettings(clean);
  if (clean.theme) nativeTheme.themeSource = clean.theme;
  return publicSettings();
});

/* ---------------------------------------------------------- IPC: providers */

ipcMain.handle('providers:presets', () => {
  const configured = new Set((store.getSettings().providers || []).map((p) => p.id));
  return providers.PRESETS.map((p) => ({
    ...p,
    connected: configured.has(p.id),
    hasEnv: Boolean(p.keyEnv && process.env[p.keyEnv]),
  }));
});

ipcMain.handle('providers:list', () => publicSettings().providers);

ipcMain.handle('providers:add', async (_e, { presetId, patch }) => {
  const s = store.getSettings();
  const existing = (s.providers || []).find((p) => p.id === (patch?.id || presetId));
  if (existing) return publicSettings();
  const next = providers.makeProvider(presetId, patch || {});
  const list = [...(s.providers || []), next];
  await store.saveSettings({ providers: list });
  return publicSettings();
});

ipcMain.handle('providers:update', async (_e, { id, patch }) => {
  const s = store.getSettings();
  const list = (s.providers || []).map((p) => {
    if (p.id !== id) return p;
    const merged = { ...p, ...patch };
    if (patch && patch.apiKey === '') merged.apiKey = p.apiKey;
    if (patch && patch.apiKey) delete merged.apiKeyEnc;
    return merged;
  });
  await store.saveSettings({ providers: list });
  return publicSettings();
});

ipcMain.handle('providers:remove', async (_e, id) => {
  const s = store.getSettings();
  await store.saveSettings({ providers: (s.providers || []).filter((p) => p.id !== id) });
  return publicSettings();
});

ipcMain.handle('providers:models', async (_e, id) => {
  const p = findProvider(id) || envProvider(id);
  if (!p) throw new Error('Provider not found.');
  const models = await providers.listModels(p);
  const s = store.getSettings();
  if (findProvider(id)) {
    await store.saveSettings({ providers: (s.providers || []).map((x) => (x.id === id ? { ...x, models } : x)) });
  }
  return models;
});

ipcMain.handle('providers:test', async (_e, id) => {
  const p = findProvider(id) || envProvider(id);
  if (!p) throw new Error('Provider not found.');
  const started = Date.now();
  const models = await providers.listModels(p);
  return { ok: true, count: models.length, ms: Date.now() - started, models: models.slice(0, 300) };
});

/* ----------------------------------------------------------- IPC: sessions */

ipcMain.handle('sessions:list', () => store.listSessions());

ipcMain.handle('sessions:get', async (_e, id) => {
  const s = await store.getSession(id);
  return s;
});

ipcMain.handle('sessions:create', async (_e, opts = {}) => {
  const s = store.getSettings();
  const session = {
    id: uid('ses'),
    title: opts.title || 'New session',
    cwd: opts.cwd || s.recentProjects?.[0] || app.getPath('home'),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model: opts.model || s.defaultModel || null,
    agentId: opts.agentId || s.defaultAgent || 'build',
    messages: [],
    todos: [],
  };
  await store.saveSession(session);
  return session;
});

ipcMain.handle('sessions:save', async (_e, session) => {
  await store.saveSession(session);
  return true;
});

ipcMain.handle('sessions:delete', async (_e, id) => {
  await store.deleteSession(id);
  return true;
});

ipcMain.handle('sessions:rename', async (_e, { id, title }) => {
  const s = await store.getSession(id);
  if (!s) return false;
  s.title = title;
  await store.saveSession(s);
  return true;
});

ipcMain.handle('sessions:export', async (_e, id) => {
  const s = await store.getSession(id);
  if (!s) throw new Error('Session not found');
  const res = await dialog.showSaveDialog(win, {
    title: 'Export session',
    defaultPath: `${(s.title || 'session').replace(/[^\w\- ]+/g, '')}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fsp.writeFile(res.filePath, JSON.stringify(s, null, 2), 'utf8');
  return res.filePath;
});

/* --------------------------------------------------------------- IPC: chat */

ipcMain.handle('chat:send', async (_e, payload) => {
  const { sessionId, text, attachments } = payload;
  const session = await store.getSession(sessionId);
  if (!session) throw new Error('Session not found.');
  if (runs.has(sessionId)) throw new Error('A response is already running.');

  if (text && text.trim()) {
    session.messages.push({
      id: uid('msg'),
      role: 'user',
      createdAt: Date.now(),
      parts: [{ type: 'text', id: uid('part'), text: text.trim() }],
    });
  }
  if (Array.isArray(attachments)) {
    for (const a of attachments) {
      const last = session.messages[session.messages.length - 1];
      const part = { type: 'file', id: uid('part'), path: a.path, text: a.text || '' };
      if (last && last.role === 'user') last.parts.push(part);
      else session.messages.push({ id: uid('msg'), role: 'user', createdAt: Date.now(), parts: [part] });
    }
  }
  if (payload.model) session.model = payload.model;
  if (payload.agentId) session.agentId = payload.agentId;

  if (session.title === 'New session' || !session.title) {
    const auto = store.getSettings().autoTitle !== false;
    if (auto && text) session.title = text.replace(/\s+/g, ' ').slice(0, 60);
  }

  await store.saveSession(session);
  send('chat:event', { sessionId, event: { t: 'session', session } });

  const controller = new AbortController();
  runs.set(sessionId, controller);

  const emit = (event) => send('chat:event', { sessionId, event });

  (async () => {
    try {
      const { provider, model } = resolveModel(session);
      await runAgent({
        session,
        provider,
        model,
        agentConfig: buildAgentConfig(session.agentId),
        settings: store.getSettings(),
        emit,
        signal: controller.signal,
        askPermission: (req) =>
          new Promise((resolve) => {
            const requestId = uid('perm');
            pendingPermissions.set(requestId, resolve);
            emit({ t: 'permission', requestId, ...req });
          }),
      });
    } catch (e) {
      emit({ t: 'error', message: e && e.message ? e.message : String(e) });
      emit({ t: 'status', status: 'idle' });
    } finally {
      runs.delete(sessionId);
      await store.saveSession(session).catch(() => {});
      send('sessions:changed', null);
      emit({ t: 'saved' });
    }
  })();

  return { ok: true };
});

ipcMain.handle('chat:abort', async (_e, sessionId) => {
  const c = runs.get(sessionId);
  if (c) c.abort();
  return true;
});

ipcMain.handle('chat:permission', (_e, { requestId, allowed, always }) => {
  const resolve = pendingPermissions.get(requestId);
  if (!resolve) return false;
  pendingPermissions.delete(requestId);
  resolve(Boolean(allowed));
  if (always) {
    // Caller persists the new rule via settings:set; nothing else to do here.
  }
  return true;
});

ipcMain.handle('chat:compact', async (_e, sessionId) => {
  const session = await store.getSession(sessionId);
  if (!session) throw new Error('Session not found.');
  const { provider, model } = resolveModel(session);
  const controller = new AbortController();
  runs.set(sessionId, controller);
  try {
    const summary = await compactSession({ session, provider, model, signal: controller.signal });
    session.messages = [
      {
        id: uid('msg'),
        role: 'assistant',
        createdAt: Date.now(),
        compacted: true,
        parts: [{ type: 'text', id: uid('part'), text: `## Session summary\n\n${summary}` }],
      },
    ];
    await store.saveSession(session);
    return { ok: true, summary };
  } finally {
    runs.delete(sessionId);
  }
});

/* ------------------------------------------------------------ IPC: filesystem */

const TREE_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__', 'target', '.idea', '.cache', 'coverage', '.DS_Store']);

async function tree(dir, depth, maxDepth) {
  if (depth > maxDepth) return [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (TREE_IGNORE.has(e.name)) continue;
    if (e.name === '.git') continue;
    const full = path.join(dir, e.name);
    const node = { name: e.name, path: full, dir: e.isDirectory() };
    if (e.isDirectory() && depth < maxDepth) node.children = await tree(full, depth + 1, maxDepth);
    out.push(node);
    if (out.length > 1200) break;
  }
  return out;
}

ipcMain.handle('fs:tree', async (_e, { cwd, depth = 3 }) => {
  const root = String(cwd || '');
  if (!root) return { children: [] };
  return { path: root, children: await tree(root, 1, Math.min(Math.max(depth, 1), 6)) };
});

ipcMain.handle('fs:read', async (_e, p) => {
  const abs = String(p);
  const stat = await fsp.stat(abs);
  if (stat.size > 5 * 1024 * 1024) throw new Error('File is larger than 5 MB.');
  const buf = await fsp.readFile(abs);
  if (buf.includes(0)) throw new Error('Binary file.');
  return { path: abs, text: buf.toString('utf8'), mtime: stat.mtimeMs, size: stat.size };
});

ipcMain.handle('fs:write', async (_e, { path: p, text }) => {
  await fsp.mkdir(path.dirname(String(p)), { recursive: true });
  await fsp.writeFile(String(p), String(text ?? ''), 'utf8');
  const stat = await fsp.stat(String(p));
  return { mtime: stat.mtimeMs };
});

ipcMain.handle('fs:create', async (_e, { parent, name, dir }) => {
  const target = path.join(String(parent), String(name));
  if (dir) await fsp.mkdir(target, { recursive: true });
  else await fsp.writeFile(target, '', 'utf8');
  return { path: target };
});

ipcMain.handle('fs:delete', async (_e, p) => {
  await fsp.rm(String(p), { recursive: true, force: true });
  return true;
});

ipcMain.handle('fs:rename', async (_e, { from, to }) => {
  await fsp.rename(String(from), String(to));
  return true;
});

ipcMain.handle('fs:reveal', async (_e, p) => {
  shell.showItemInFolder(String(p));
  return true;
});

/* --------------------------------------------------------------- IPC: shell */

ipcMain.handle('term:run', async (_e, { cwd, command, runId }) => {
  const id = runId || uid('term');
  const { file, args } = tools.pickShell(store.getSettings().shell || '');
  const child = spawn(file, args(String(command)), { cwd: String(cwd || process.cwd()), env: { ...process.env, FORCE_COLOR: '0' }, windowsHide: true });
  terminals.set(id, child);
  send('term:event', { runId: id, type: 'start', command });
  child.stdout.on('data', (d) => send('term:event', { runId: id, type: 'data', stream: 'stdout', data: d.toString() }));
  child.stderr.on('data', (d) => send('term:event', { runId: id, type: 'data', stream: 'stderr', data: d.toString() }));
  child.on('close', (code) => {
    terminals.delete(id);
    send('term:event', { runId: id, type: 'exit', code });
  });
  child.on('error', (err) => {
    terminals.delete(id);
    send('term:event', { runId: id, type: 'data', stream: 'stderr', data: String(err.message) + '\n' });
    send('term:event', { runId: id, type: 'exit', code: -1 });
  });
  return { runId: id };
});

ipcMain.handle('term:kill', (_e, runId) => {
  const child = terminals.get(runId);
  if (child) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    terminals.delete(runId);
  }
  return true;
});

/* -------------------------------------------------------------- IPC: dialog */

ipcMain.handle('dialog:folder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

ipcMain.handle('dialog:files', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  if (res.canceled) return [];
  const out = [];
  for (const f of res.filePaths) {
    try {
      const stat = await fsp.stat(f);
      if (stat.size > 400 * 1024) {
        out.push({ path: f, text: '', skipped: 'too large' });
        continue;
      }
      out.push({ path: f, text: await fsp.readFile(f, 'utf8') });
    } catch {
      out.push({ path: f, text: '' });
    }
  }
  return out;
});

/* ------------------------------------------------------- IPC: agents/skills */

ipcMain.handle('agents:list', () => [...BUILTIN_AGENTS, ...(store.getSettings().agents || [])]);

ipcMain.handle('skills:list', async (_e, cwd) => store.listSkills(cwd));

ipcMain.handle('skills:read', async (_e, p) => fsp.readFile(String(p), 'utf8'));

/* ---------------------------------------------------------------- IPC: mcp */

ipcMain.handle('mcp:list', () => store.getSettings().mcp || []);

ipcMain.handle('mcp:save', async (_e, server) => {
  const s = store.getSettings();
  const list = [...(s.mcp || [])];
  const idx = list.findIndex((m) => m.id === server.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...server };
  else list.push({ ...server, id: server.id || uid('mcp') });
  await store.saveSettings({ mcp: list });
  return list;
});

ipcMain.handle('mcp:remove', async (_e, id) => {
  const s = store.getSettings();
  const list = (s.mcp || []).filter((m) => m.id !== id);
  await store.saveSettings({ mcp: list });
  return list;
});

/* ------------------------------------------------------------- IPC: system */

ipcMain.handle('system:permissions', () => store.getSettings().permissions || {});

ipcMain.handle('system:check', async () => {
  const out = { tools: {}, shell: process.env.ComSpec || process.env.SHELL || 'sh' };
  for (const cmd of ['node', 'npm', 'git', 'python', 'rg']) {
    out.tools[cmd] = await new Promise((resolve) => {
      const child = spawn(process.platform === 'win32' ? 'where' : 'which', [cmd], { windowsHide: true });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  }
  return out;
});

ipcMain.handle('theme:changed', () => nativeTheme.shouldUseDarkColors);
nativeTheme.on('updated', () => send('theme:system', { dark: nativeTheme.shouldUseDarkColors }));
