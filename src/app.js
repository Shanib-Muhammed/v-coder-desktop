import { icon } from './icons.js';
import { renderMarkdown, esc } from './markdown.js';
import { CodeEditor, langOf } from './editor.js';

const api = window.vcoder;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const S = {
  info: null,
  settings: null,
  presets: [],
  providers: [],
  sessions: [],
  agents: [],
  skills: [],
  tabs: [],
  activeId: null,
  session: null,
  running: new Set(),
  status: 'idle',
  panel: null,
  browserUrl: 'https://www.google.com',
  browserHistory: ['https://www.google.com'],
  browserHistIndex: 0,
  tree: null,
  expanded: new Set(),
  editorTabs: [],
  activeEditor: null,
  attachments: [],
  term: [],
  termRunId: null,
  settingsOpen: false,
  settingsSection: 'general',
  paletteOpen: false,
  perm: null,
  usage: null,
  search: '',
  sidebarOpen: true,
};

let editor = null;
let mdTimers = new Map();
let streamingMsg = null;

/* --------------------------------------------------------------- utilities */

const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

function toast(message, kind = '') {
  const root = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = `${icon(kind === 'err' ? 'alert' : kind === 'ok' ? 'check' : 'sparkles', 14)}<span>${esc(message)}</span>`;
  const close = document.createElement('button');
  close.innerHTML = icon('x', 12);
  close.onclick = () => el.remove();
  el.appendChild(close);
  root.appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'now';
  if (d < 3600000) return Math.floor(d / 60000) + 'm';
  if (d < 86400000) return Math.floor(d / 3600000) + 'h';
  if (d < 604800000) return Math.floor(d / 86400000) + 'd';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dayBucket(ts) {
  const now = new Date();
  const d = new Date(ts);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= start) return 'Today';
  if (ts >= start - 86400000) return 'Yesterday';
  if (ts >= start - 7 * 86400000) return 'Previous 7 days';
  if (ts >= start - 30 * 86400000) return 'Previous 30 days';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function baseName(p) {
  return String(p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';
}

function currentModel() {
  const m = S.session?.model || S.settings?.defaultModel;
  if (!m || !m.model) return null;
  const prov = S.providers.find((p) => p.id === m.provider);
  return { ...m, name: prov?.name || m.provider };
}

function modelLabel() {
  const m = currentModel();
  return m ? m.model : 'Select model';
}

function currentAgent() {
  const id = S.session?.agentId || S.settings?.defaultAgent || 'build';
  return S.agents.find((a) => a.id === id) || S.agents[0];
}

/* ------------------------------------------------------------------- theme */

function applyTheme() {
  const s = S.settings || {};
  const scheme = s.theme || 'system';
  const dark = scheme === 'dark' || (scheme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.accent = s.accent || 'blue';
  if (s.codeFont) root.style.setProperty('--font-mono', `"${s.codeFont}", ui-monospace, Consolas, monospace`);
  else root.style.removeProperty('--font-mono');
  if (s.uiFont) root.style.setProperty('--font-sans', `"${s.uiFont}", "Segoe UI", system-ui, sans-serif`);
  else root.style.removeProperty('--font-sans');
  root.style.setProperty('--editor-fs', `${Number(s.monoFontSize) || 13}px`);
  localStorage.setItem('vcoder.ui', JSON.stringify({ theme: scheme, accent: s.accent || 'blue' }));
}

function saveSettings(patch) {
  S.settings = { ...S.settings, ...patch };
  applyTheme();
  api.settings.set(patch).catch((e) => toast(e.message, 'err'));
}

/* ------------------------------------------------------------------- shell */

function renderShell() {
  const mac = S.info.platform === 'darwin';
  $('#app').innerHTML = `
    <div class="titlebar">
      <div class="tb-left">
        <button class="icon-btn" data-act="toggle-sidebar" title="Toggle sidebar">
          ${icon('panel-left', 15)}
        </button>
        <div class="brand-mini">
          <div class="mark">V</div>
          <div class="name">V-Coder <span>desktop</span></div>
        </div>
      </div>
      <div class="tb-center"></div>
      <div class="tb-right">
        <button class="icon-btn" data-act="open-palette" title="Command palette">
          ${icon('search', 15)}
        </button>
        <button class="icon-btn" data-act="toggle-panel" data-panel="files" title="Files panel">
          ${icon('panel-right', 15)}
        </button>
        <button class="icon-btn" data-act="toggle-panel" data-panel="browser" title="Browser">
          ${icon('globe', 15)}
        </button>
        ${
          mac
            ? ''
            : `<div class="win-controls">
                <button data-act="win-min" title="Minimize">${icon('minimize', 13)}</button>
                <button data-act="win-max" title="Maximize">${icon('maximize', 12)}</button>
                <button class="close" data-act="win-close" title="Close">${icon('x', 13)}</button>
              </div>`
        }
      </div>
    </div>
    <div class="body">
      <aside class="sidebar" id="sidebar"></aside>
      <div class="main-wrap">
        <div class="tabstrip" id="tabstrip"></div>
        <main class="main" id="main"></main>
      </div>
      <aside class="dock hidden" id="dock"></aside>
    </div>
    <div class="statusbar" id="statusbar"></div>
    <div class="composer-wrap" id="composer-wrap" style="display:none"></div>
  `;
}

function renderTitlebarState() {
  const sb = $('#sidebar');
  if (sb) sb.classList.toggle('collapsed', !S.sidebarOpen);
  const dock = $('#dock');
  if (dock) dock.classList.toggle('hidden', !S.panel);
}

/* ---------------------------------------------------------------- sidebar */

function renderSidebar() {
  const el = $('#sidebar');
  if (!el) return;
  el.classList.toggle('collapsed', !S.sidebarOpen);

  const groups = new Map();
  for (const s of S.sessions) {
    const b = dayBucket(s.updatedAt || s.createdAt);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(s);
  }

  const items = [...groups.entries()]
    .map(
      ([label, list]) => `
      <div class="sb-group">${label}<span class="count">${list.length}</span></div>
      ${list
        .map(
          (s) => `
        <button class="sb-item ${s.id === S.activeId ? 'active' : ''} ${S.running.has(s.id) ? 'running' : ''}" data-act="open-session" data-id="${s.id}">
          ${icon('message', 13)}
          <span class="label">${esc(s.title || 'New session')}</span>
          <span class="meta row-act">${timeAgo(s.updatedAt || s.createdAt)}</span>
          <span class="row-act" data-act="session-menu" data-id="${s.id}" title="More">${icon('more-horizontal', 13)}</span>
        </button>`,
        )
        .join('')}`,
    )
    .join('');

  const cwd = S.settings?.recentProjects?.[0] || S.info.home;

  el.innerHTML = `
    <div class="sb-top">
      <div class="brand">
        <div class="logo">V</div>
        <div class="wordmark"><b>V-Coder</b><small>coding studio</small></div>
      </div>
      <button class="sb-project" data-act="pick-project" title="${esc(cwd)}">
        ${icon('folder', 14)}<span class="path">${esc(cwd)}</span>${icon('chevron-down', 12)}
      </button>
      <button class="btn-new" data-act="new-session">
        ${icon('plus', 15)}<span>New session</span>
        <span class="kbd-hint"><span class="kbd">${mod()}</span><span class="kbd">N</span></span>
      </button>
      <div class="search-field">
        ${icon('search', 13)}
        <input id="session-search" placeholder="Search sessions" value="${esc(S.search)}" />
        <span class="kbd">${mod()}</span><span class="kbd">K</span>
      </div>
    </div>
    <div class="sb-scroll">
      ${items || `<div class="sb-empty">No sessions yet. Start one and it will appear here.</div>`}
    </div>
    <div class="sb-footer">
      <button class="sb-item" data-act="open-settings">${icon('settings', 14)}<span class="label">Settings</span></button>
      <button class="sb-item" data-act="toggle-theme">${icon(S.info.dark ? 'sun' : 'moon', 14)}<span class="label">Switch theme</span></button>
      <button class="sb-item" data-act="open-external" data-url="https://github.com/Shanib-Muhammed/v-coder-REA-desktop">${icon('external-link', 14)}<span class="label">Documentation</span></button>
    </div>
  `;

  const input = $('#session-search');
  if (input) {
    input.addEventListener('input', (e) => {
      S.search = e.target.value;
      renderSidebar();
      const again = $('#session-search');
      if (again) {
        again.focus();
        again.setSelectionRange(again.value.length, again.value.length);
      }
    });
  }
}

function mod() {
  return S.info?.platform === 'darwin' ? '⌘' : 'Ctrl';
}

/* ------------------------------------------------------------------- tabs */

function renderTabs() {
  const el = $('#tabstrip');
  if (!el) return;
  el.innerHTML =
    S.tabs
      .map(
        (t) => `
      <button class="tab ${t.id === S.activeId ? 'active' : ''}" data-act="open-session" data-id="${t.id}">
        ${S.running.has(t.id) ? '<span class="dot"></span>' : icon('message', 12)}
        <span class="tab-title">${esc(t.title || 'New session')}</span>
        <span class="tab-close" data-act="close-tab" data-id="${t.id}">${icon('x', 11)}</span>
      </button>`,
      )
      .join('') +
    `<button class="tab" data-act="new-session" title="New session">${icon('plus', 13)}</button>`;
}

/* ------------------------------------------------------------------- home */

function renderHome() {
  const main = $('#main');
  $('#composer-wrap').style.display = 'none';
  const connected = S.providers.filter((p) => p.hasKey || p.source === 'environment');
  const recent = S.sessions.slice(0, 4);

  main.innerHTML = `
    <div class="home">
      <div class="home-inner">
        <div class="home-eyebrow">${icon('zap', 13)} V-Coder ${S.info.version} · ${S.info.platform === 'win32' ? 'Windows' : S.info.platform === 'darwin' ? 'macOS' : 'Linux'}</div>
        <h1>Build real software<br />with an agent that <span class="accent">runs on your machine.</span></h1>
        <p class="lede">
          Connect any model provider — OpenAI, Anthropic, Google, OpenRouter, or a local model.
          V-Coder reads your files, writes code, runs commands and verifies the result.
        </p>

        <div class="quick-grid">
          <button class="quick-card" data-act="new-session">
            <span class="qi">${icon('plus', 15)}</span>
            <span><b>New session</b><span>Start working in the current project</span></span>
          </button>
          <button class="quick-card" data-act="pick-project">
            <span class="qi">${icon('folder', 15)}</span>
            <span><b>Open a project</b><span>Choose a folder to work in</span></span>
          </button>
          <button class="quick-card" data-act="open-settings" data-section="providers">
            <span class="qi">${icon('plug', 15)}</span>
            <span><b>Connect a provider</b><span>${connected.length ? connected.length + ' connected' : 'Add your first API key'}</span></span>
          </button>
          <button class="quick-card" data-act="open-palette">
            <span class="qi">${icon('command', 15)}</span>
            <span><b>Command palette</b><span>Every action, one keystroke away</span></span>
          </button>
        </div>

        ${
          recent.length
            ? `<div class="home-section">
                <header><h3>Recent sessions</h3><button class="btn ghost sm" data-act="open-palette">View all</button></header>
                ${recent
                  .map(
                    (s) => `<button class="recent-row" data-act="open-session" data-id="${s.id}">
                      ${icon('message', 14)}
                      <span class="title">${esc(s.title || 'New session')}</span>
                      <span class="when">${timeAgo(s.updatedAt || s.createdAt)}</span>
                    </button>`,
                  )
                  .join('')}
              </div>`
            : ''
        }

        ${
          connected.length
            ? ''
            : `<div class="tip-card">
                <span class="ti">${icon('sparkles', 15)}</span>
                <span><b>No provider connected yet.</b> Open Settings → Providers and paste an API key, or point V-Coder at a local model on <code>localhost</code>. Your keys stay on this machine, encrypted by the OS keychain.</span>
              </div>`
        }
      </div>
    </div>`;
}

/* ---------------------------------------------------------------- session */

function renderSession() {
  const main = $('#main');
  const wrap = $('#composer-wrap');
  wrap.style.display = '';
  const s = S.session;
  const model = currentModel();
  const agent = currentAgent();

  main.innerHTML = `
    <div class="session">
      <div class="session-head">
        <span class="title">${esc(s.title || 'New session')}</span>
        <span class="sep"></span>
        <button class="chip mono" data-act="pick-project" title="${esc(s.cwd)}">${icon('folder', 11)}${esc(baseName(s.cwd))}</button>
        <div class="spacer"></div>
        <button class="chip" data-act="agent-picker" title="Change agent">${icon('brain', 12)}${esc(agent?.name || 'Build')}</button>
        <button class="chip" data-act="compact-session" title="Compact conversation">${icon('layers', 12)}Compact</button>
        <button class="chip" data-act="export-session" title="Export transcript">${icon('download', 12)}</button>
        <button class="chip" data-act="session-menu" data-id="${s.id}" title="More">${icon('more-horizontal', 12)}</button>
      </div>
      <div class="timeline" id="timeline"><div class="timeline-inner" id="timeline-inner"></div></div>
    </div>`;

  renderTimeline();
  renderComposer();
  if (model) updateModelPill();
}

function renderComposer() {
  const wrap = $('#composer-wrap');
  const agent = currentAgent();
  const model = currentModel();
  wrap.innerHTML = `
    <div class="composer" id="composer">
      <div class="attach-row" id="attach-row"></div>
      <div style="position:relative">
        <div id="composer-menu"></div>
        <textarea id="prompt" rows="1" spellcheck="${S.settings.spellcheck === false ? 'false' : 'true'}" placeholder="Ask V-Coder to build, fix or explain…  ( / for commands, @ for files )"></textarea>
      </div>
      <div class="composer-bar">
        <button class="pill-btn" data-act="agent-picker" title="Switch agent">${icon('brain', 13)}<span id="agent-label">${esc(agent?.name || 'Build')}</span></button>
        <button class="pill-btn mono" data-act="model-picker" title="Switch model">
          ${icon('cpu', 13)}<span id="model-label">${esc(modelLabel())}</span>${icon('chevron-down', 11)}
        </button>
        <button class="pill-btn" data-act="attach" title="Attach files">${icon('paperclip', 13)}</button>
        <div class="spacer"></div>
        <span id="send-hint" style="font-size:var(--fs-micro);color:var(--text-faint);margin-right:6px">${S.status === 'idle' ? '' : S.status}</span>
        <button class="send-btn" id="send-btn" data-act="send" title="Send">
          ${S.running.has(S.activeId) ? icon('stop', 14) : icon('send', 15)}
        </button>
      </div>
    </div>
    <div class="composer-hint">
      <span>Enter to send · Shift+Enter for a new line</span>
      <span id="token-hint">${S.usage ? `${S.usage.input || 0} in / ${S.usage.output || 0} out` : ''}</span>
    </div>`;

  const ta = $('#prompt');
  ta.value = S.draft || '';
  ta.addEventListener('input', () => {
    S.draft = ta.value;
    autosize(ta);
    handleComposerInput();
  });
  ta.addEventListener('keydown', onPromptKey);
  autosize(ta);
  renderAttachments();
  setTimeout(() => ta.focus(), 30);
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 260) + 'px';
}

function updateModelPill() {
  const el = $('#model-label');
  if (el) el.textContent = modelLabel();
}

function renderAttachments() {
  const row = $('#attach-row');
  if (!row) return;
  row.innerHTML = S.attachments
    .map(
      (a, i) => `<span class="attach-chip">${icon('file', 11)}<span class="fn">${esc(baseName(a.path))}</span>
      <button data-act="remove-attach" data-i="${i}">${icon('x', 11)}</button></span>`,
    )
    .join('');
}

/* --------------------------------------------------------------- timeline */

function renderTimeline() {
  const inner = $('#timeline-inner');
  if (!inner || !S.session) return;
  const msgs = S.session.messages || [];
  if (!msgs.length) {
    inner.innerHTML = `
      <div style="padding:34px 0 10px;text-align:center;color:var(--text-faint);font-size:var(--fs-sm);line-height:1.7">
        <div style="width:44px;height:44px;border-radius:13px;background:var(--bg-layer-1);display:grid;place-items:center;margin:0 auto 12px;color:var(--text-muted)">${icon('sparkles', 20)}</div>
        <b style="display:block;color:var(--text-base);font-size:var(--fs-md);margin-bottom:3px">${esc(S.session.title || 'New session')}</b>
        Working in <span class="chip mono" style="display:inline-flex">${esc(S.session.cwd)}</span><br />
        Ask for a feature, a fix, or an explanation. V-Coder can read and edit files and run commands.
      </div>`;
    return;
  }
  inner.innerHTML = msgs.map(renderMessage).join('');
  scrollTimeline(true);
}

function renderMessage(m) {
  if (m.role === 'user') {
    const parts = m.parts || [];
    return `<div class="msg user" data-msg="${m.id}">
      ${parts
        .map((p) => {
          if (p.type === 'file')
            return `<div class="bubble attachment">${icon('file', 12)}${esc(baseName(p.path))}</div>`;
          return `<div class="bubble" data-part="${p.id}">${esc(p.text || '')}</div>`;
        })
        .join('')}
      <div class="msg-meta">
        <span>${new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <div class="msg-actions">
          <button data-act="copy-msg" data-id="${m.id}" title="Copy">${icon('copy', 11)}</button>
          <button data-act="delete-msg" data-id="${m.id}" title="Remove">${icon('trash', 11)}</button>
        </div>
      </div>
    </div>`;
  }

  const parts = (m.parts || []).map(renderPart).join('');
  return `<div class="msg assistant" data-msg="${m.id}">
    <div class="assistant-head">
      <span class="who">V-Coder</span>
      ${m.model ? `<span>· ${esc(m.model)}</span>` : ''}
      ${m.error ? `<span style="color:var(--danger)">· error</span>` : ''}
    </div>
    <div class="body md" data-body>${parts}</div>
    ${m.error ? `<div class="error-card">${icon('alert', 14)}<span>${esc(m.error)}</span></div>` : ''}
    <div class="msg-meta">
      <span>${new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      <div class="msg-actions">
        <button data-act="copy-msg" data-id="${m.id}" title="Copy">${icon('copy', 11)}</button>
        <button data-act="retry-msg" data-id="${m.id}" title="Retry">${icon('rotate-ccw', 11)}</button>
        <button data-act="fork-msg" data-id="${m.id}" title="Fork from here">${icon('git-branch', 11)}</button>
      </div>
    </div>
  </div>`;
}

function renderPart(p) {
  if (p.type === 'text') {
    return `<div class="md-part" data-part="${p.id}">${renderMarkdown(p.text || '')}</div>`;
  }
  if (p.type === 'reasoning') {
    if (S.settings.showReasoning === false) return '';
    return `<details class="reasoning" data-part="${p.id}"><summary>${icon('brain', 11)} Thinking</summary><div class="r-body">${esc(p.text || '')}</div></details>`;
  }
  if (p.type === 'tool') {
    return renderTool(p);
  }
  return '';
}

function renderTool(p) {
  const stateLabel =
    p.state === 'running'
      ? `<span class="status running">${icon('loader', 11, 'spinner')} running</span>`
      : p.state === 'error'
        ? `<span class="status error">${icon('alert', 11)} failed</span>`
        : p.state === 'denied'
          ? `<span class="status denied">${icon('lock', 11)} denied</span>`
          : `<span class="status done">${icon('check', 11)}</span>`;

  const arg =
    p.name === 'bash'
      ? String(p.args?.command || '')
      : p.args?.path || p.args?.pattern || p.args?.url || '';

  const body =
    p.diff && p.state !== 'running'
      ? `<div class="tool-body">${p.diff
          .split('\n')
          .map((l) =>
            l.startsWith('+ ')
              ? `<span class="diff-line add">${esc(l)}</span>`
              : l.startsWith('- ')
                ? `<span class="diff-line del">${esc(l)}</span>`
                : `<span class="diff-line">${esc(l)}</span>`,
          )
          .join('')}</div>`
      : p.output
        ? `<div class="tool-body"><pre>${esc(p.output)}</pre></div>`
        : '';

  return `<div class="tool-card" data-part="${p.id}">
    <button class="tool-head" data-act="toggle-tool" data-id="${p.id}">
      <span class="ti">${icon(toolIcon(p.name), 13)}</span>
      <span class="name">${esc(p.name)}</span>
      <span class="arg">${esc(String(arg).slice(0, 160))}</span>
      ${stateLabel}
    </button>
    ${body}
  </div>`;
}

function toolIcon(name) {
  return (
    {
      read: 'file',
      write: 'file-plus',
      edit: 'edit',
      list: 'files',
      glob: 'search',
      grep: 'search',
      bash: 'terminal',
      webfetch: 'globe',
      todo: 'layers',
    }[name] || 'code'
  );
}

function scrollTimeline(force) {
  const tl = $('#timeline');
  if (!tl) return;
  const nearBottom = tl.scrollHeight - tl.scrollTop - tl.clientHeight < 160;
  if (force || nearBottom) tl.scrollTop = tl.scrollHeight;
}

/* --------------------------------------------------------------- chat flow */

async function handleChatEvent({ sessionId, event }) {
  if (event.t === 'saved') {
    refreshSessions();
    return;
  }
  if (sessionId !== S.activeId) {
    if (event.t === 'done' || event.t === 'error') {
      S.running.delete(sessionId);
      refreshSessions();
      renderSidebar();
    }
    return;
  }

  const s = S.session;
  if (!s) return;

  switch (event.t) {
    case 'session':
      S.session = event.session;
      S.session.messages = event.session.messages || [];
      renderTimeline();
      renderSidebar();
      break;
    case 'message-start': {
      S.session.messages.push(event.message);
      const inner = $('#timeline-inner');
      if (inner) {
        if (inner.querySelector('.msg')) {
          inner.insertAdjacentHTML('beforeend', renderMessage(event.message));
        } else renderTimeline();
        scrollTimeline(true);
      }
      streamingMsg = event.message.id;
      break;
    }
    case 'part': {
      const msg = findMsg(event.messageId);
      if (!msg) break;
      const idx = msg.parts.findIndex((p) => p.id === event.part.id);
      if (idx >= 0) msg.parts[idx] = event.part;
      else msg.parts.push(event.part);
      patchPart(event.messageId, event.part);
      break;
    }
    case 'text': {
      const msg = findMsg(event.messageId);
      const part = msg?.parts.find((p) => p.id === event.partId);
      if (!part) break;
      part.text = (part.text || '') + event.delta;
      scheduleMarkdown(event.messageId, event.partId, part.text);
      break;
    }
    case 'reasoning': {
      const msg = findMsg(event.messageId);
      const part = msg?.parts.find((p) => p.id === event.partId);
      if (!part) break;
      part.text = (part.text || '') + event.delta;
      const node = $(`[data-part="${event.partId}"] .r-body`);
      if (node) node.textContent = part.text;
      break;
    }
    case 'status':
      S.status = event.status;
      renderStatusIndicator();
      break;
    case 'usage':
      S.usage = event.usage;
      const th = $('#token-hint');
      if (th) th.textContent = `${event.usage.input || 0} in / ${event.usage.output || 0} out`;
      break;
    case 'todo':
    case 'todos':
      renderTodos(event.todos || []);
      break;
    case 'permission':
      showPermission(event);
      break;
    case 'error': {
      const msg = findMsg(event.messageId);
      if (msg) {
        msg.error = event.message;
        const node = $(`.msg[data-msg="${msg.id}"]`);
        if (node) node.outerHTML = renderMessage(msg);
      } else {
        toast(event.message, 'err');
      }
      S.running.delete(S.activeId);
      renderComposer();
      break;
    }
    case 'done':
      S.running.delete(S.activeId);
      S.status = 'idle';
      streamingMsg = null;
      renderStatusIndicator();
      renderTabs();
      renderSidebar();
      renderComposer();
      saveActiveSession();
      break;
    case 'file-changed':
      if (S.panel === 'files') refreshTree();
      break;
  }
}

function findMsg(id) {
  return (S.session?.messages || []).find((m) => m.id === id);
}

function patchPart(messageId, part) {
  const node = $(`.msg[data-msg="${messageId}"] [data-part="${part.id}"]`);
  if (!node) {
    const body = $(`.msg[data-msg="${messageId}"] [data-body]`);
    if (body) body.insertAdjacentHTML('beforeend', renderPart(part));
    scrollTimeline();
    return;
  }
  if (part.type === 'tool') {
    node.outerHTML = renderTool(part);
  } else if (part.type === 'text') {
    node.innerHTML = renderMarkdown(part.text || '');
  }
  scrollTimeline();
}

function scheduleMarkdown(messageId, partId, text) {
  const key = messageId + partId;
  if (mdTimers.has(key)) return;
  const t = setTimeout(() => {
    mdTimers.delete(key);
    const node = $(`[data-part="${partId}"]`);
    if (node) node.innerHTML = renderMarkdown(text);
    scrollTimeline();
  }, 55);
  mdTimers.set(key, t);
}

function renderStatusIndicator() {
  const hint = $('#send-hint');
  if (!hint) return;
  const map = {
    thinking: 'thinking…',
    streaming: '',
    tool: 'running tool…',
    idle: '',
  };
  hint.textContent = map[S.status] || '';
}

function renderTodos(todos) {
  if (!todos.length) return;
  let node = $('#todo-dock');
  if (!node) {
    node = document.createElement('div');
    node.id = 'todo-dock';
    node.className = 'todo-card';
    node.style.margin = '0 24px 8px';
    const tl = $('#timeline-inner');
    if (!tl) return;
    tl.appendChild(node);
  }
  node.innerHTML = `<header>Plan</header>${todos
    .map(
      (t) => `<div class="todo-row ${t.status}">
        <span class="box">${t.status === 'completed' ? icon('check', 9) : ''}</span>
        <span>${esc(t.content)}</span>
      </div>`,
    )
    .join('')}`;
}

function showPermission(ev) {
  S.perm = ev;
  const tl = $('#timeline-inner');
  if (!tl) return;
  const existing = $('#perm-card');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'perm-card';
  el.className = 'permission-card';
  el.innerHTML = `
    <div class="pc-head">${icon('lock', 14)} Allow <b>${esc(ev.name)}</b>?</div>
    <div class="pc-args">${esc(JSON.stringify(ev.args, null, 2)).slice(0, 2000)}</div>
    <div class="pc-actions">
      <button class="btn primary sm" data-act="perm" data-allow="1">Allow once</button>
      <button class="btn sm" data-act="perm" data-allow="1" data-always="1">Always allow</button>
      <button class="btn danger sm" data-act="perm" data-allow="0">Deny</button>
    </div>`;
  tl.appendChild(el);
  scrollTimeline(true);
}

async function sendMessage() {
  const ta = $('#prompt');
  if (!ta) return;
  if (S.running.has(S.activeId)) {
    await api.chat.abort(S.activeId);
    return;
  }
  let text = ta.value.trim();
  if (!text && !S.attachments.length) return;

  if (text.startsWith('/')) {
    const handled = await runSlashCommand(text);
    if (handled) {
      ta.value = '';
      S.draft = '';
      return;
    }
  }

  if (!S.session) {
    await newSession();
  }

  const attachments = S.attachments.map((a) => ({ path: a.path, text: a.text }));
  S.attachments = [];
  S.draft = '';
  ta.value = '';
  autosize(ta);
  renderAttachments();

  S.running.add(S.activeId);
  S.status = 'thinking';
  renderComposer();
  renderTabs();
  renderSidebar();

  try {
    await api.chat.send({
      sessionId: S.activeId,
      text,
      attachments,
      model: currentModel() ? { provider: currentModel().provider, model: currentModel().model } : undefined,
      agentId: currentAgent()?.id,
    });
  } catch (e) {
    S.running.delete(S.activeId);
    toast(e.message || String(e), 'err');
    renderComposer();
  }
}

function onPromptKey(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
  if (e.key === 'Escape') closeComposerMenu();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const menu = $('#composer-menu .menu-row');
    if (menu) {
      e.preventDefault();
      moveMenu(e.key === 'ArrowDown' ? 1 : -1);
    }
  }
}

/* ------------------------------------------------------------ composer menu */

let menuIndex = 0;
let menuMode = null;

function handleComposerInput() {
  const ta = $('#prompt');
  const val = ta.value;
  if (val.startsWith('/') && !val.includes('\n') && val.length < 24) {
    openSlashMenu(val.slice(1));
  } else {
    const m = val.match(/(?:^|\s)@([^\s]*)$/);
    if (m) openMentionMenu(m[1]);
    else closeComposerMenu();
  }
}

const SLASH = [
  { cmd: '/new', desc: 'Start a new session' },
  { cmd: '/compact', desc: 'Summarise the conversation' },
  { cmd: '/model', desc: 'Choose a model' },
  { cmd: '/agent', desc: 'Switch agent' },
  { cmd: '/init', desc: 'Write project instructions' },
  { cmd: '/export', desc: 'Export this transcript' },
  { cmd: '/settings', desc: 'Open settings' },
  { cmd: '/undo', desc: 'Remove the last exchange' },
  { cmd: '/help', desc: 'Open the command palette' },
];

function openSlashMenu(query) {
  menuMode = 'slash';
  menuIndex = 0;
  const list = SLASH.filter((c) => c.cmd.slice(1).startsWith(query.toLowerCase()));
  const el = $('#composer-menu');
  el.innerHTML = `<div class="slash-menu">${
    list.length
      ? list
          .map(
            (c, i) => `<button class="menu-row ${i === 0 ? 'active' : ''}" data-act="slash" data-cmd="${c.cmd}">
              <span class="cmd">${c.cmd}</span><span>${c.desc}</span></button>`,
          )
          .join('')
      : '<div class="menu-empty">No commands</div>'
  }</div>`;
}

async function openMentionMenu(query) {
  menuMode = 'mention';
  menuIndex = 0;
  const el = $('#composer-menu');
  if (!S.tree) {
    el.innerHTML = '';
    return;
  }
  const q = query.toLowerCase();
  const flat = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.dir) walk(n.children);
      else if (!q || n.path.toLowerCase().includes(q)) flat.push(n);
      if (flat.length > 40) return;
    }
  };
  walk(S.tree.children);
  el.innerHTML = `<div class="slash-menu">${
    flat.length
      ? flat
          .slice(0, 20)
          .map(
            (f, i) => `<button class="menu-row ${i === 0 ? 'active' : ''}" data-act="mention" data-path="${esc(f.path)}">
            ${icon('file', 12)}<span>${esc(f.name)}</span><span class="desc">${esc(f.path.replace(S.tree.path, '').slice(1))}</span></button>`,
          )
          .join('')
      : '<div class="menu-empty">No files</div>'
  }</div>`;
}

function closeComposerMenu() {
  menuMode = null;
  const el = $('#composer-menu');
  if (el) el.innerHTML = '';
}

function moveMenu(delta) {
  const rows = $$('#composer-menu .menu-row');
  if (!rows.length) return;
  menuIndex = (menuIndex + delta + rows.length) % rows.length;
  rows.forEach((r, i) => r.classList.toggle('active', i === menuIndex));
  rows[menuIndex].scrollIntoView({ block: 'nearest' });
}

async function runSlashCommand(text) {
  const cmd = text.split(/\s+/)[0].toLowerCase();
  const rest = text.slice(cmd.length).trim();
  const clear = () => {
    const ta = $('#prompt');
    if (ta) {
      ta.value = '';
      S.draft = '';
      autosize(ta);
    }
    closeComposerMenu();
  };
  switch (cmd) {
    case '/new':
      clear();
      await newSession();
      return true;
    case '/compact':
      clear();
      await compactSession();
      return true;
    case '/model':
      clear();
      openModelPicker();
      return true;
    case '/agent':
      clear();
      openAgentPicker();
      return true;
    case '/settings':
      clear();
      openSettings('general');
      return true;
    case '/export':
      clear();
      exportSession();
      return true;
    case '/undo':
      clear();
      undoLast();
      return true;
    case '/help':
      clear();
      openPalette();
      return true;
    case '/init':
      clear();
      {
        const ta = $('#prompt');
        if (ta) {
          ta.value =
            'Analyse this project and write a V-CODER.md file at the root. Include the stack, how to build and run it, the folder layout, coding conventions, and anything an agent must know before editing.';
          S.draft = ta.value;
          autosize(ta);
        }
      }
      return true;
    case '/clear':
      clear();
      S.session.messages = [];
      renderTimeline();
      saveActiveSession();
      return true;
    default:
      if (rest) return false;
      return false;
  }
}

/* ------------------------------------------------------------------ actions */

async function newSession(opts = {}) {
  const cwd = opts.cwd || S.settings?.recentProjects?.[0] || S.info.home;
  const session = await api.sessions.create({
    cwd,
    model: S.settings.defaultModel,
    agentId: S.settings.defaultAgent,
  });
  S.tabs.push({ id: session.id, title: session.title });
  S.activeId = session.id;
  S.session = session;
  S.usage = null;
  await refreshSessions();
  persistTabs();
  renderAll();
  const ta = $('#prompt');
  if (ta) ta.focus();
}

async function openSession(id) {
  if (S.activeId === id && S.session) return;
  const session = await api.sessions.get(id);
  if (!session) {
    toast('Session not found', 'err');
    return;
  }
  S.session = session;
  S.activeId = id;
  S.usage = null;
  S.status = 'idle';
  if (!S.tabs.find((t) => t.id === id)) S.tabs.push({ id, title: session.title });
  persistTabs();
  renderAll();
  if (S.settings.lastSessionId !== id) saveSettings({ lastSessionId: id });
}

async function closeTab(id) {
  S.tabs = S.tabs.filter((t) => t.id !== id);
  if (S.activeId === id) {
    const next = S.tabs[S.tabs.length - 1];
    S.activeId = next ? next.id : null;
    S.session = next ? await api.sessions.get(next.id) : null;
  }
  persistTabs();
  renderAll();
}

function persistTabs() {
  api.settings.set({ openSessions: S.tabs.map((t) => t.id), lastSessionId: S.activeId }).catch(() => {});
}

async function saveActiveSession() {
  if (!S.session) return;
  try {
    await api.sessions.save(S.session);
  } catch {
    /* ignore */
  }
}

async function refreshSessions() {
  S.sessions = await api.sessions.list();
  for (const t of S.tabs) {
    const meta = S.sessions.find((s) => s.id === t.id);
    if (meta) t.title = meta.title;
    if (meta && S.session?.id === t.id) S.session.title = meta.title;
  }
  renderSidebar();
  renderTabs();
}

async function compactSession() {
  if (!S.session) return;
  if (!confirm('Compact this conversation into a summary?')) return;
  try {
    toast('Compacting…');
    await api.chat.compact(S.activeId);
    S.session = await api.sessions.get(S.activeId);
    renderTimeline();
    toast('Conversation compacted', 'ok');
  } catch (e) {
    toast(e.message || String(e), 'err');
  }
}

async function exportSession() {
  if (!S.session) return;
  try {
    const p = await api.sessions.export(S.activeId);
    if (p) toast('Exported to ' + p, 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function undoLast() {
  if (!S.session?.messages?.length) return;
  S.session.messages.pop();
  if (S.session.messages[S.session.messages.length - 1]?.role === 'user') S.session.messages.pop();
  await saveActiveSession();
  renderTimeline();
}

async function deleteSession(id) {
  if (!confirm('Delete this session permanently?')) return;
  await api.sessions.delete(id);
  S.tabs = S.tabs.filter((t) => t.id !== id);
  if (S.activeId === id) {
    S.activeId = S.tabs.length ? S.tabs[S.tabs.length - 1].id : null;
    S.session = S.activeId ? await api.sessions.get(S.activeId) : null;
  }
  persistTabs();
  await refreshSessions();
  renderAll();
}

/* ---------------------------------------------------------------- popovers */

function closePopover() {
  $('#popover-root').innerHTML = '';
  document.removeEventListener('mousedown', outsideClose, true);
}

function outsideClose(e) {
  if (!e.target.closest('.popover') && !e.target.closest('[data-act="model-picker"]') && !e.target.closest('[data-act="agent-picker"]')) {
    closePopover();
  }
}

function placePopover(el, anchor, align = 'left') {
  const root = $('#popover-root');
  root.innerHTML = '';
  root.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  let left = align === 'right' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  let top = r.top - el.offsetHeight - 8;
  if (top < 8) top = r.bottom + 8;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
  setTimeout(() => document.addEventListener('mousedown', outsideClose, true), 0);
}

function openModelPicker() {
  const anchor = $('[data-act="model-picker"]') || $('.chip');
  if (!anchor) return;
  closePopover();
  const el = document.createElement('div');
  el.className = 'popover';
  el.style.width = '340px';

  const providers = S.providers.filter((p) => p.hasKey || p.source === 'environment');
  const active = currentModel();
  const rows = [];
  const favorites = S.settings.favorites || [];

  for (const p of providers) {
    const models = (p.models || []).filter((m) => !(S.settings.hiddenModels || []).includes(`${p.id}/${m}`));
    if (!models.length) continue;
    rows.push(`<div class="menu-label">${esc(p.name)}</div>`);
    for (const m of models) {
      const fav = favorites.includes(`${p.id}/${m}`);
      const isActive = active && active.provider === p.id && active.model === m;
      rows.push(`<button class="pop-row" data-act="pick-model" data-provider="${p.id}" data-model="${esc(m)}">
        ${icon('cpu', 13)}
        <span>${esc(m)}</span>
        <span class="right">${fav ? `<span style="color:#e7af36">★</span>` : ''}${isActive ? `<span class="check">${icon('check', 13)}</span>` : ''}</span>
      </button>`);
    }
  }

  el.innerHTML = `
    <div class="popover-head"><div class="popover-search">${icon('search', 12)}<input placeholder="Search models" id="mp-search" /></div></div>
    <div class="popover-list" id="mp-list">${
      providers.length ? rows.join('') : '<div class="menu-empty">No providers connected. Open Settings → Providers.</div>'
    }</div>
    <div class="pop-sep"></div>
    <button class="pop-row" data-act="open-settings" data-section="providers">${icon('plus', 13)}<span>Manage providers</span></button>`;

  placePopover(el, anchor, 'left');
  const input = $('#mp-search');
  input?.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    $$('#mp-list .pop-row').forEach((r) => {
      r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  input?.focus();
}

function openAgentPicker() {
  const anchor = $('[data-act="agent-picker"]');
  if (!anchor) return;
  closePopover();
  const el = document.createElement('div');
  el.className = 'popover';
  el.style.width = '280px';
  const active = currentAgent();
  el.innerHTML = `
    <div class="menu-label">Agents</div>
    ${S.agents
      .map(
        (a) => `<button class="pop-row" data-act="pick-agent" data-id="${a.id}">
        ${icon('brain', 13)}
        <span style="display:flex;flex-direction:column">
          <span>${esc(a.name)}</span>
          <span class="sub">${esc(a.description || '')}</span>
        </span>
        <span class="right">${active?.id === a.id ? `<span class="check">${icon('check', 13)}</span>` : ''}</span>
      </button>`,
      )
      .join('')}
    <div class="pop-sep"></div>
    <button class="pop-row" data-act="open-settings" data-section="agents">${icon('plus', 13)}<span>Create agent</span></button>`;
  placePopover(el, anchor, 'left');
}

/* ---------------------------------------------------------------- settings */

function openSettings(section = 'general') {
  S.settingsOpen = true;
  S.settingsSection = section;
  renderSettings();
}

function closeSettings() {
  S.settingsOpen = false;
  $('#overlay-root').innerHTML = '';
}

const SECTIONS = [
  { id: 'general', name: 'General', icon: 'settings' },
  { id: 'appearance', name: 'Appearance', icon: 'sun' },
  { id: 'providers', name: 'Providers', icon: 'plug' },
  { id: 'models', name: 'Models', icon: 'cpu' },
  { id: 'agents', name: 'Agents', icon: 'brain' },
  { id: 'mcp', name: 'MCP servers', icon: 'server' },
  { id: 'skills', name: 'Skills', icon: 'sparkles' },
  { id: 'permissions', name: 'Permissions', icon: 'lock' },
  { id: 'shortcuts', name: 'Shortcuts', icon: 'command' },
  { id: 'about', name: 'About', icon: 'message' },
];

function renderSettings() {
  const root = $('#overlay-root');
  if (!S.settingsOpen) {
    root.innerHTML = '';
    return;
  }
  const s = S.settings;
  root.innerHTML = `
    <div class="overlay" data-act="close-settings-bg">
      <div class="sheet">
        <div class="sheet-nav">
          <div class="nav-title">Settings</div>
          ${SECTIONS.map(
            (x) => `<button class="nav-item ${S.settingsSection === x.id ? 'active' : ''}" data-act="settings-section" data-section="${x.id}">
              ${icon(x.icon, 14)}<span>${x.name}</span></button>`,
          ).join('')}
          <div style="flex:1"></div>
          <button class="nav-item" data-act="close-settings">${icon('arrow-left', 14)}<span>Back to app</span></button>
        </div>
        <div class="sheet-body">
          <div class="sheet-head">
            <div style="flex:1"><h2>${esc(SECTIONS.find((x) => x.id === S.settingsSection)?.name || 'Settings')}</h2>
            <p>${esc(sectionDescription(S.settingsSection))}</p></div>
            <button class="btn ghost" data-act="close-settings">${icon('x', 15)}</button>
          </div>
          <div class="sheet-content" id="sheet-content">${settingsContent(S.settingsSection)}</div>
        </div>
      </div>
    </div>`;
}

function sectionDescription(id) {
  return (
    {
      general: 'Preferences, defaults and how V-Coder behaves.',
      appearance: 'Theme, accent and fonts.',
      providers: 'Connect model providers with your own API keys.',
      models: 'Choose which models appear in the picker.',
      agents: 'Agents are reusable instructions with their own prompt.',
      mcp: 'Model Context Protocol servers expose extra tools.',
      skills: 'Skills are markdown playbooks the agent can load.',
      permissions: 'Decide what the agent may do without asking.',
      shortcuts: 'Keyboard shortcuts.',
      about: 'Version and credits.',
    }[id] || ''
  );
}

function settingsContent(id) {
  const s = S.settings;
  switch (id) {
    case 'general':
      return `
        <div class="set-section">
          <h3>Interface</h3>
          ${row('Spellcheck', 'Underline misspelled words while typing.', toggle('spellcheck', s.spellcheck))}
          ${row('Show reasoning', 'Display the model’s thinking when a provider exposes it.', toggle('showReasoning', s.showReasoning))}
          ${row('Auto title', 'Name sessions from your first message.', toggle('autoTitle', s.autoTitle))}
        </div>
        <div class="set-section">
          <h3>Agent</h3>
          ${row('Default agent', 'Used for every new session.', select('defaultAgent', S.agents.map((a) => [a.id, a.name]), s.defaultAgent))}
          ${row('Max steps', 'Maximum tool round-trips per message.', numberInput('maxSteps', s.maxSteps, 1, 100))}
        </div>
        <div class="set-section">
          <h3>Terminal</h3>
          ${row('Shell', 'Used by the terminal panel and the bash tool.', `<input class="input wide mono" data-setting-text="shell" value="${esc(s.shell || '')}" placeholder="auto" />`)}
        </div>`;
    case 'appearance':
      return `
        <div class="set-section">
          <h3>Theme</h3>
          ${row('Color scheme', 'Follow the system or force light/dark.', seg('theme', [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]))}
          ${row('Accent', 'Used for buttons, focus rings and highlights.', swatches())}
        </div>
        <div class="set-section">
          <h3>Type</h3>
          ${row('Code font', 'Font family for code blocks and the editor.', `<input class="input wide mono" data-setting-text="codeFont" value="${esc(s.codeFont || '')}" placeholder="IBM Plex Mono" />`)}
          ${row('UI font', 'Font family for the interface.', `<input class="input wide" data-setting-text="uiFont" value="${esc(s.uiFont || '')}" placeholder="Inter" />`)}
          ${row('Editor font size', 'Pixels.', numberInput('monoFontSize', s.monoFontSize || 13, 10, 22))}
        </div>
        <div class="set-section">
          <h3>Preview</h3>
          <div class="provider-card" style="display:block;padding:16px">
            <div class="md" style="font-size:14px">
              <p style="margin:0 0 8px"><b>The quick brown fox</b> jumps over the <em>lazy dog</em>. <code class="inline-code">npm run build</code></p>
              <div class="code-block"><div class="code-head"><span class="code-lang">ts</span><button class="code-copy">Copy</button></div><pre><code><span class="tok-kw">const</span> answer = <span class="tok-num">42</span> <span class="tok-com">// the meaning</span></code></pre></div>
            </div>
          </div>
        </div>`;
    case 'providers':
      return providersContent();
    case 'models':
      return modelsContent();
    case 'agents':
      return agentsContent();
    case 'mcp':
      return mcpContent();
    case 'skills':
      return skillsContent();
    case 'permissions':
      return permissionsContent();
    case 'shortcuts':
      return shortcutsContent();
    case 'about':
      return `<div class="set-section">
          <div style="display:flex;gap:14px;align-items:center;margin-bottom:16px">
            <div class="brand"><div class="logo" style="width:44px;height:44px;border-radius:12px;font-size:19px">V</div></div>
            <div><h2 style="margin:0;font-size:20px;letter-spacing:-.03em">V-Coder</h2>
            <div style="color:var(--text-faint);font-size:12px">Version ${S.info.version} · Electron ${S.info.electron}</div></div>
          </div>
          <p style="color:var(--text-muted);font-size:13px;line-height:1.7;max-width:58ch">
            An open desktop AI coding studio. Bring your own model provider, open a project, and let the agent read,
            write and run code on your machine. No account required.
          </p>
          <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
            <button class="btn" data-act="open-external" data-url="https://github.com/Shanib-Muhammed/v-coder-REA-desktop">${icon('external-link', 13)} GitHub</button>
            <button class="btn" data-act="open-folder" data-path="${esc(S.info.userData)}">${icon('folder', 13)} Data folder</button>
          </div>
          <div class="set-row" style="margin-top:18px"><div class="info"><b>MIT License</b><span>Free to use, modify and distribute.</span></div></div>
          <div class="set-row"><div class="info"><b>Design</b><span>Interface inspired by the OpenCode desktop app (MIT).</span></div></div>
          <div class="set-row"><div class="info"><b>Runtime</b><span>Node ${S.info.node} · Chromium ${S.info.chrome} · ${S.info.platform} ${S.info.arch}</span></div></div>
        </div>`;
    default:
      return '';
  }
}

function row(title, desc, control) {
  return `<div class="set-row"><div class="info"><b>${esc(title)}</b><span>${esc(desc)}</span></div><div class="control">${control}</div></div>`;
}

function toggle(key, on) {
  return `<button class="switch ${on ? 'on' : ''}" data-act="toggle-setting" data-key="${key}"></button>`;
}

function seg(key, options) {
  const cur = S.settings[key];
  return `<div class="seg" data-seg="${key}">${options
    .map(([v, label]) => `<button class="${cur === v ? 'active' : ''}" data-act="set-seg" data-key="${key}" data-value="${v}">${esc(label)}</button>`)
    .join('')}</div>`;
}

function select(key, options, cur) {
  return `<select class="select" data-setting-select="${key}">${options
    .map(([v, label]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${esc(label)}</option>`)
    .join('')}</select>`;
}

function numberInput(key, value, min, max) {
  return `<input class="input" type="number" style="width:86px" data-setting-number="${key}" value="${value ?? ''}" min="${min}" max="${max}" />`;
}

function swatches() {
  const colors = [
    ['blue', '#3b5cf6'],
    ['violet', '#7152f4'],
    ['emerald', '#2eaf5a'],
    ['amber', '#ee7330'],
    ['rose', '#e4429e'],
    ['cyan', '#0096b8'],
    ['mono', '#3a3a3a'],
  ];
  return `<div style="display:flex;gap:6px">${colors
    .map(
      ([id, hex]) => `<button data-act="set-accent" data-value="${id}" title="${id}"
      style="width:22px;height:22px;border-radius:7px;background:${hex};box-shadow:${S.settings.accent === id ? '0 0 0 2px var(--bg-base), 0 0 0 3.5px ' + hex : 'inset 0 0 0 1px rgba(0,0,0,.15)'}"></button>`,
    )
    .join('')}</div>`;
}

function providersContent() {
  const connected = S.providers;
  const connectedIds = new Set(connected.map((p) => p.id));
  const popular = S.presets.filter((p) => !connectedIds.has(p.id) && p.id !== 'custom');
  return `
    <div class="set-section">
      <h3>Connected providers</h3>
      ${
        connected.length
          ? connected
              .map(
                (p) => `<div class="provider-card">
                  <div class="pi">${esc((p.name || '?').slice(0, 2).toUpperCase())}</div>
                  <div class="pinfo"><b>${esc(p.name)}</b><span>${esc(p.baseUrl)}</span></div>
                  ${p.source === 'environment' ? '<span class="tag">Environment</span>' : p.hasKey ? '<span class="tag ok">Key saved</span>' : '<span class="tag warn">No key</span>'}
                  <span class="tag">${(p.models || []).length} models</span>
                  <button class="btn sm" data-act="edit-provider" data-id="${p.id}">Edit</button>
                  <button class="btn sm ghost danger" data-act="remove-provider" data-id="${p.id}">${icon('trash', 12)}</button>
                </div>`,
              )
              .join('')
          : `<div class="empty-state"><div class="ei">${icon('plug', 20)}</div><div>No providers yet. Pick one below and paste your API key.<br />Everything stays local.</div></div>`
      }
    </div>
    <div class="set-section">
      <h3>Popular providers</h3>
      ${popular
        .map(
          (p) => `<div class="provider-card">
            <div class="pi">${esc(p.name.slice(0, 2).toUpperCase())}</div>
            <div class="pinfo"><b>${esc(p.name)}</b><span>${esc(p.type === 'google' ? 'Gemini API' : p.type === 'anthropic' ? 'Anthropic Messages API' : 'OpenAI-compatible')}</span></div>
            ${p.hasEnv ? `<span class="tag ok">Env found</span>` : ''}
            <button class="btn sm primary" data-act="add-provider" data-id="${p.id}">Connect</button>
          </div>`,
        )
        .join('')}
      <div class="provider-card">
        <div class="pi">+</div>
        <div class="pinfo"><b>Custom provider</b><span>Any OpenAI-compatible endpoint, local or hosted.</span></div>
        <button class="btn sm" data-act="add-provider" data-id="custom">Add</button>
      </div>
    </div>`;
}

function modelsContent() {
  const rows = [];
  for (const p of S.providers) {
    for (const m of p.models || []) {
      const key = `${p.id}/${m}`;
      const hidden = (S.settings.hiddenModels || []).includes(key);
      const fav = (S.settings.favorites || []).includes(key);
      rows.push(`<div class="model-row">
        ${icon('cpu', 12)}
        <span class="mn">${esc(m)}</span>
        <span class="sub" style="color:var(--text-faint);font-size:11px">${esc(p.name)}</span>
        <button class="star ${fav ? 'on' : ''}" data-act="fav-model" data-key="${esc(key)}" title="Favourite">${icon('star', 13)}</button>
        <button class="btn sm ghost" data-act="hide-model" data-key="${esc(key)}">${hidden ? 'Show' : 'Hide'}</button>
      </div>`);
    }
  }
  return `<div class="set-section">
    <h3>Models</h3>
    ${rows.length ? rows.join('') : '<div class="empty-state">Connect a provider first.</div>'}
    <p style="color:var(--text-faint);font-size:12px;margin-top:12px">Favourite models appear first in the picker. Hidden models stay out of the way.</p>
  </div>`;
}

function agentsContent() {
  const custom = S.settings.agents || [];
  return `
    <div class="set-section">
      <h3>Built-in</h3>
      ${S.agents
        .filter((a) => a.builtin)
        .map((a) => `<div class="provider-card"><div class="pi">${esc(a.name.slice(0, 2).toUpperCase())}</div>
        <div class="pinfo"><b>${esc(a.name)}</b><span>${esc(a.description)}</span></div>
        <span class="tag">${a.tools === 'readonly' ? 'read-only' : 'all tools'}</span></div>`)
        .join('')}
    </div>
    <div class="set-section">
      <h3>Custom agents</h3>
      ${
        custom.length
          ? custom
              .map(
                (a) => `<div class="provider-card"><div class="pi">${esc(a.name.slice(0, 2).toUpperCase())}</div>
                <div class="pinfo"><b>${esc(a.name)}</b><span>${esc(a.description || a.prompt?.slice(0, 90) || '')}</span></div>
                <button class="btn sm" data-act="edit-agent" data-id="${a.id}">Edit</button>
                <button class="btn sm ghost danger" data-act="remove-agent" data-id="${a.id}">${icon('trash', 12)}</button></div>`,
              )
              .join('')
          : '<div class="empty-state">No custom agents yet.</div>'
      }
      <button class="btn" style="margin-top:8px" data-act="edit-agent" data-id="new">${icon('plus', 13)} Create agent</button>
    </div>`;
}

function agentEditor(id) {
  const isNew = id === 'new';
  const a = isNew ? { id: '', name: '', description: '', prompt: '', model: null } : (S.settings.agents || []).find((x) => x.id === id);
  if (!a) return;
  openEditorSheet(
    isNew ? 'New agent' : 'Edit agent',
    `
      <div class="set-section">
        ${row('Name', '', `<input class="input wide" id="ag-name" value="${esc(a.name)}" placeholder="Reviewer" />`)}
        ${row('Description', '', `<input class="input wide" id="ag-desc" value="${esc(a.description || '')}" placeholder="Reviews code for bugs" />`)}
        <div style="padding:10px 0"><b style="font-size:12.5px">System instructions</b>
          <textarea class="input full" id="ag-prompt" style="margin-top:6px;min-height:180px">${esc(a.prompt || '')}</textarea>
        </div>
      </div>
      <button class="btn primary" data-act="save-agent" data-id="${esc(id)}">Save agent</button>`,
  );
}

function mcpContent() {
  const list = S.settings.mcp || [];
  return `<div class="set-section">
    <h3>Servers</h3>
    ${
      list.length
        ? list
            .map(
              (m) => `<div class="provider-card"><div class="pi">${icon('server', 15)}</div>
              <div class="pinfo"><b>${esc(m.name)}</b><span>${esc(m.command)} ${esc((m.args || []).join(' '))}</span></div>
              <span class="tag ${m.enabled === false ? '' : 'ok'}">${m.enabled === false ? 'disabled' : 'enabled'}</span>
              <button class="btn sm ghost danger" data-act="remove-mcp" data-id="${m.id}">${icon('trash', 12)}</button></div>`,
            )
            .join('')
        : '<div class="empty-state">No MCP servers configured.</div>'
    }
    <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
      <input class="input full" id="mcp-name" placeholder="Name (e.g. filesystem)" />
      <input class="input full mono" id="mcp-cmd" placeholder="Command (e.g. npx -y @modelcontextprotocol/server-filesystem .)" />
      <input class="input full mono" id="mcp-env" placeholder='Env JSON (optional): {"TOKEN":"..."}' />
      <button class="btn" data-act="add-mcp">${icon('plus', 13)} Add server</button>
    </div>
    <p style="color:var(--text-faint);font-size:12px;margin-top:12px">MCP servers are stored with the app and can be launched by the agent runtime.</p>
  </div>`;
}

function skillsContent() {
  return `<div class="set-section">
    <h3>Installed skills</h3>
    ${
      S.skills.length
        ? S.skills
            .map(
              (s) => `<div class="provider-card"><div class="pi">${icon('sparkles', 15)}</div>
              <div class="pinfo"><b>${esc(s.name)}</b><span>${esc(s.description || s.path)}</span></div>
              <span class="tag">${s.scope}</span>
              <button class="btn sm" data-act="open-skill" data-path="${esc(s.path)}">View</button></div>`,
            )
            .join('')
        : `<div class="empty-state"><div class="ei">${icon('sparkles', 20)}</div><div>No skills found. Add a folder with a SKILL.md to<br /><code>~/.agents/skills</code> or <code>.v-coder/skills</code>.</div></div>`
    }
    <button class="btn" style="margin-top:8px" data-act="refresh-skills">${icon('refresh', 13)} Rescan</button>
  </div>`;
}

function permissionsContent() {
  const p = S.settings.permissions || {};
  const tools = [
    ['read', 'Read files', 'Open and inspect file contents.'],
    ['list', 'List folders', 'Enumerate directory entries.'],
    ['glob', 'Find files', 'Match paths by glob pattern.'],
    ['grep', 'Search contents', 'Regex search across the project.'],
    ['edit', 'Edit files', 'Modify existing files.'],
    ['write', 'Create files', 'Write new files and overwrite content.'],
    ['bash', 'Run commands', 'Execute shell commands in the workspace.'],
    ['webfetch', 'Fetch URLs', 'Download documentation pages.'],
    ['todo', 'Update plan', 'Maintain the session todo list.'],
  ];
  return `<div class="set-section">
    <h3>Tool permissions</h3>
    ${tools
      .map(
        ([key, name, desc]) => `<div class="set-row"><div class="info"><b>${name}</b><span>${desc}</span></div>
        <div class="control">${seg(`permissions.${key}`, [['allow', 'Allow'], ['ask', 'Ask'], ['deny', 'Deny']])}</div></div>`,
      )
      .join('')}
  </div>
  <p style="color:var(--text-faint);font-size:12px">“Ask” shows an inline approval card before the tool runs. Destructive commands always deserve a look.</p>`;
}

function shortcutsContent() {
  const kb = S.settings.keybinds || {};
  return `<div class="set-section">
    <h3>Keyboard</h3>
    ${Object.entries(kb)
      .map(
        ([id, key]) => `<div class="set-row"><div class="info"><b>${esc(id.replace(/\./g, ' · '))}</b></div>
        <div class="control"><input class="input mono" style="width:140px;text-align:center" data-keybind="${esc(id)}" value="${esc(key)}" /></div></div>`,
      )
      .join('')}
  </div>`;
}

function openEditorSheet(title, body) {
  const root = $('#overlay-root');
  root.innerHTML = `<div class="overlay" data-act="close-editor-sheet">
    <div class="sheet" style="width:min(620px,100%);height:auto;max-height:80vh">
      <div class="sheet-body">
        <div class="sheet-head"><h2>${esc(title)}</h2><div style="flex:1"></div><button class="btn ghost" data-act="close-editor-sheet">${icon('x', 15)}</button></div>
        <div class="sheet-content">${body}</div>
      </div>
    </div></div>`;
}

function providerEditor(id) {
  const p = S.providers.find((x) => x.id === id);
  if (!p) return;
  openEditorSheet(
    p.name,
    `
    <div class="set-section">
      ${row('Display name', '', `<input class="input wide" id="pv-name" value="${esc(p.name)}" />`)}
      ${row('Wire format', 'How requests are shaped.', select('pv-type', [['openai', 'OpenAI-compatible'], ['anthropic', 'Anthropic'], ['google', 'Google Gemini'], ['ollama', 'Ollama']], p.type).replace('data-setting-select', 'id="pv-type" data-pv') )}
      ${row('Base URL', 'No trailing slash.', `<input class="input wide mono" id="pv-url" value="${esc(p.baseUrl)}" />`)}
      ${row('API key', p.hasKey ? 'A key is stored. Leave blank to keep it.' : 'Stored encrypted with your OS keychain.', `<input class="input wide mono" id="pv-key" type="password" placeholder="${p.hasKey ? '••••••••' : 'sk-...'}" />`)}
    </div>
    <div class="set-section">
      <h3>Models</h3>
      <textarea class="input full" id="pv-models" style="min-height:120px">${esc((p.models || []).join('\n'))}</textarea>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn sm" data-act="fetch-models" data-id="${p.id}">${icon('refresh', 12)} Fetch from provider</button>
        <button class="btn sm" data-act="test-provider" data-id="${p.id}">${icon('play', 12)} Test</button>
        <div style="flex:1"></div>
        <button class="btn sm ghost danger" data-act="remove-provider" data-id="${p.id}">Remove</button>
      </div>
      <div id="pv-status" style="margin-top:8px;font-size:12px;color:var(--text-faint)"></div>
    </div>
    <button class="btn primary" data-act="save-provider" data-id="${p.id}">Save provider</button>`,
  );
}

/* ---------------------------------------------------------------- palette */

const COMMANDS = () => [
  { id: 'new-session', title: 'New session', cat: 'Session', icon: 'plus', run: () => newSession() },
  { id: 'settings', title: 'Open settings', cat: 'Settings', icon: 'settings', run: () => openSettings('general') },
  { id: 'providers', title: 'Connect a provider', cat: 'Settings', icon: 'plug', run: () => openSettings('providers') },
  { id: 'theme', title: 'Toggle theme', cat: 'Appearance', icon: 'sun', run: () => toggleTheme() },
  { id: 'panel-files', title: 'Toggle file panel', cat: 'View', icon: 'files', run: () => togglePanel('files') },
  { id: 'panel-terminal', title: 'Toggle terminal', cat: 'View', icon: 'terminal', run: () => togglePanel('terminal') },
  { id: 'compact', title: 'Compact session', cat: 'Session', icon: 'layers', run: () => compactSession() },
  { id: 'export', title: 'Export transcript', cat: 'Session', icon: 'download', run: () => exportSession() },
  { id: 'pick-project', title: 'Open project folder', cat: 'Project', icon: 'folder', run: () => pickProject() },
  { id: 'skills', title: 'Browse skills', cat: 'Skills', icon: 'sparkles', run: () => openSettings('skills') },
  ...S.sessions.slice(0, 8).map((s) => ({
    id: 's-' + s.id,
    title: s.title,
    cat: 'Recent session',
    icon: 'message',
    run: () => openSession(s.id),
  })),
  ...S.providers.flatMap((p) =>
    (p.models || []).slice(0, 6).map((m) => ({
      id: `m-${p.id}-${m}`,
      title: m,
      cat: 'Model · ' + p.name,
      icon: 'cpu',
      run: () => pickModel(p.id, m),
    })),
  ),
];

function openPalette() {
  S.paletteOpen = true;
  const root = $('#overlay-root');
  root.innerHTML = `<div class="overlay" data-act="close-palette" style="align-items:flex-start;padding-top:12vh">
    <div class="palette">
      <div class="palette-input">${icon('search', 16)}<input id="pal-input" placeholder="Search commands, sessions and models…" /></div>
      <div class="palette-list" id="pal-list"></div>
    </div></div>`;
  const input = $('#pal-input');
  const render = () => {
    const q = input.value.toLowerCase();
    const list = COMMANDS().filter((c) => (c.title + ' ' + c.cat).toLowerCase().includes(q));
    const groups = new Map();
    for (const c of list) {
      if (!groups.has(c.cat)) groups.set(c.cat, []);
      groups.get(c.cat).push(c);
    }
    $('#pal-list').innerHTML = list.length
      ? [...groups.entries()]
          .map(
            ([cat, items]) => `<div class="palette-cat">${esc(cat)}</div>${items
              .map(
                (c) => `<button class="menu-row" data-act="palette-run" data-id="${esc(c.id)}">
                ${icon(c.icon, 13)}<span>${esc(c.title)}</span></button>`,
              )
              .join('')}`,
          )
          .join('')
      : '<div class="menu-empty">No results</div>';
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('#pal-list .menu-row');
      if (first) first.click();
    }
  });
  render();
  input.focus();
}

function closePalette() {
  S.paletteOpen = false;
  if (!S.settingsOpen) $('#overlay-root').innerHTML = '';
}

/* ------------------------------------------------------------------- dock */

function togglePanel(tab) {
  if (S.panel === tab) S.panel = null;
  else {
    S.panel = tab;
    if (tab === 'files' || tab === 'editor') refreshTree();
    if (tab === 'editor' && !S.activeEditor && S.editorTabs.length) openEditorTab(S.editorTabs[0].path);
    if (tab === 'browser') renderBrowserPane();
  }
  renderDock();
  renderTitlebarState();
}

function renderDock() {
  const dock = $('#dock');
  if (!dock) return;
  dock.classList.toggle('hidden', !S.panel);
  if (!S.panel) {
    dock.innerHTML = '';
    return;
  }
  dock.innerHTML = `
    <div class="dock-head">
      <button class="dock-tab ${S.panel === 'files' ? 'active' : ''}" data-act="dock-tab" data-tab="files">${icon('files', 13)} Files</button>
      <button class="dock-tab ${S.panel === 'editor' ? 'active' : ''}" data-act="dock-tab" data-tab="editor">${icon('code', 13)} Editor</button>
      <button class="dock-tab ${S.panel === 'terminal' ? 'active' : ''}" data-act="dock-tab" data-tab="terminal">${icon('terminal', 13)} Terminal</button>
      <button class="dock-tab ${S.panel === 'browser' ? 'active' : ''}" data-act="dock-tab" data-tab="browser">${icon('globe', 13)} Browser</button>
      <div style="flex:1"></div>
      <button class="icon-btn" data-act="close-panel" title="Close">${icon('x', 14)}</button>
    </div>
    <div class="dock-body">
      <div class="dock-pane ${S.panel === 'files' ? '' : 'hidden'}" id="pane-files"></div>
      <div class="dock-pane ${S.panel === 'editor' ? '' : 'hidden'}" id="pane-editor"></div>
      <div class="dock-pane ${S.panel === 'terminal' ? '' : 'hidden'}" id="pane-terminal"></div>
      <div class="dock-pane ${S.panel === 'browser' ? '' : 'hidden'}" id="pane-browser"></div>
    </div>`;

  if (S.panel === 'files') renderFilesPane();
  if (S.panel === 'editor') renderEditorPane();
  if (S.panel === 'terminal') renderTerminalPane();
  if (S.panel === 'browser') renderBrowserPane();
}

async function refreshTree() {
  const cwd = S.session?.cwd || S.settings?.recentProjects?.[0] || S.info.home;
  try {
    S.tree = await api.fs.tree(cwd, 3);
    if (S.panel === 'files') renderFilesPane();
  } catch (e) {
    S.tree = { path: cwd, children: [] };
  }
}

function renderFilesPane() {
  const pane = $('#pane-files');
  if (!pane) return;
  const root = S.tree || { path: S.session?.cwd || '', children: [] };
  pane.innerHTML = `
    <div class="tree-head">
      <span class="path">${esc(baseName(root.path) || root.path)}</span>
      <button class="icon-btn" data-act="new-file" title="New file">${icon('file-plus', 13)}</button>
      <button class="icon-btn" data-act="refresh-tree" title="Refresh">${icon('refresh', 13)}</button>
      <button class="icon-btn" data-act="reveal-cwd" title="Reveal in file manager">${icon('folder-open', 13)}</button>
    </div>
    <div class="tree">${renderTree(root.children || [], 0)}</div>`;
}

function renderTree(nodes, depth) {
  return nodes
    .map((n) => {
      const open = S.expanded.has(n.path);
      if (n.dir) {
        return `<button class="tree-row" data-act="toggle-dir" data-path="${esc(n.path)}" style="padding-left:${6 + depth * 11}px">
          <span class="caret ${open ? 'open' : ''}">${icon('chevron-right', 10)}</span>
          ${icon(open ? 'folder-open' : 'folder', 13, 'fi')}
          <span class="nm">${esc(n.name)}</span>
        </button>${
          open ? `<div class="tree-children">${renderTree(n.children || [], depth + 1)}</div>` : ''
        }`;
      }
      const activeFile = S.activeEditor === n.path;
      return `<button class="tree-row ${activeFile ? 'active' : ''}" data-act="open-file" data-path="${esc(n.path)}" style="padding-left:${6 + depth * 11 + 17}px">
        ${icon('file', 12, 'fi')}<span class="nm">${esc(n.name)}</span>
      </button>`;
    })
    .join('');
}

function renderEditorPane() {
  const pane = $('#pane-editor');
  if (!pane) return;
  if (!S.editorTabs.length) {
    pane.innerHTML = `<div class="editor-empty">${icon('code', 22)}<div style="margin-top:10px">No file open.<br />Pick one in the Files panel.</div></div>`;
    return;
  }
  pane.innerHTML = `
    <div class="editor-tabs">
      ${S.editorTabs
        .map(
          (t) => `<div class="editor-tab ${S.activeEditor === t.path ? 'active' : ''}" data-act="switch-file" data-path="${esc(t.path)}">
            <span class="dirty" style="display:${t.dirty ? '' : 'none'}"></span>
            <span class="fn">${esc(baseName(t.path))}</span>
            <span class="x" data-act="close-file" data-path="${esc(t.path)}">${icon('x', 10)}</span>
          </div>`,
        )
        .join('')}
      <div style="flex:1"></div>
      <button class="icon-btn" data-act="save-file" title="Save">${icon('download', 13)}</button>
    </div>
    <div class="editor-host" id="editor-host"></div>`;

  const host = $('#editor-host');
  editor = new CodeEditor(host, {
    onChange: (v) => {
      const t = S.editorTabs.find((x) => x.path === S.activeEditor);
      if (t) {
        t.text = v;
        t.dirty = true;
        renderEditorTabsOnly();
      }
    },
    onSave: () => saveFile(),
  });
  const tab = S.editorTabs.find((x) => x.path === S.activeEditor);
  if (tab) editor.open(tab.path, tab.text);
}

function renderEditorTabsOnly() {
  const tabs = $('.editor-tabs');
  if (!tabs) return;
  $$('.editor-tab', tabs).forEach((el) => {
    const t = S.editorTabs.find((x) => x.path === el.dataset.path);
    const dot = el.querySelector('.dirty');
    if (t && dot) dot.style.display = t.dirty ? '' : 'none';
    el.classList.toggle('active', t && t.path === S.activeEditor);
  });
}

async function openEditorTab(path) {
  const existing = S.editorTabs.find((t) => t.path === path);
  if (!existing) {
    try {
      const res = await api.fs.read(path);
      S.editorTabs.push({ path, text: res.text, dirty: false });
    } catch (e) {
      toast(e.message || String(e), 'err');
      return;
    }
  }
  S.activeEditor = path;
  S.panel = 'editor';
  renderDock();
  renderTitlebarState();
}

async function saveFile() {
  if (!editor || !S.activeEditor) return;
  const text = editor.getValue();
  try {
    await api.fs.write(S.activeEditor, text);
    const t = S.editorTabs.find((x) => x.path === S.activeEditor);
    if (t) {
      t.text = text;
      t.dirty = false;
    }
    toast('Saved ' + baseName(S.activeEditor), 'ok');
    renderEditorPane();
  } catch (e) {
    toast(e.message || String(e), 'err');
  }
}

function renderTerminalPane() {
  const pane = $('#pane-terminal');
  if (!pane) return;
  pane.innerHTML = `
    <div class="term" id="term-out">${S.term
      .map((l) => (l.type === 'cmd' ? `<span class="cmd">$ ${esc(l.text)}</span>` : l.type === 'err' ? `<span class="err">${esc(l.text)}</span>` : l.type === 'exit' ? `<span class="exit">${esc(l.text)}</span>` : esc(l.text)))
      .join('')}</div>
    <div class="term-input-row">
      <span class="prompt">$</span>
      <input id="term-input" placeholder="Run a command in ${esc(baseName(S.session?.cwd) || 'workspace')}…" autocomplete="off" spellcheck="false" />
    </div>`;
  const input = $('#term-input');
  const out = $('#term-out');
  if (out) out.scrollTop = out.scrollHeight;
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      const cmd = input.value.trim();
      input.value = '';
      S.term.push({ type: 'cmd', text: cmd });
      renderTerminalPane();
      $('#term-input')?.focus();
      const res = await api.term.run(S.session?.cwd || S.settings?.recentProjects?.[0], cmd);
      S.termRunId = res.runId;
    }
  });
  input.focus();
}

function renderBrowserPane() {
  const pane = $('#pane-browser');
  if (!pane) return;
  const url = S.browserUrl || 'https://www.google.com';
  pane.innerHTML = `
    <div class="browser-bar">
      <button class="icon-btn" data-act="browser-back" title="Back">${icon('chevron-left', 13)}</button>
      <button class="icon-btn" data-act="browser-forward" title="Forward">${icon('chevron-right', 13)}</button>
      <button class="icon-btn" data-act="browser-refresh" title="Reload">${icon('refresh', 13)}</button>
      <div class="browser-url">
        ${icon('lock', 11)}
        <input id="browser-input" value="${esc(url)}" spellcheck="false" />
      </div>
      <button class="icon-btn" data-act="browser-go" title="Go">${icon('arrow-right', 13)}</button>
      <button class="icon-btn" data-act="browser-open-external" title="Open in system browser">${icon('external-link', 13)}</button>
    </div>
    <div class="browser-frame-wrap">
      <webview id="browser-webview" src="${esc(url)}" style="width:100%;height:100%" allowpopups></webview>
    </div>`;
  const input = $('#browser-input');
  const wv = $('#browser-webview');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      let u = input.value.trim();
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      S.browserUrl = u;
      if (S.browserHistory[S.browserHistIndex] !== u) {
        S.browserHistory = S.browserHistory.slice(0, S.browserHistIndex + 1);
        S.browserHistory.push(u);
        S.browserHistIndex = S.browserHistory.length - 1;
      }
      if (wv) wv.src = u;
    }
  });
  if (wv) {
    wv.addEventListener('did-navigate', (e) => {
      S.browserUrl = e.url;
      const inp = $('#browser-input');
      if (inp) inp.value = e.url;
    });
    wv.addEventListener('did-navigate-in-page', (e) => {
      S.browserUrl = e.url;
      const inp = $('#browser-input');
      if (inp) inp.value = e.url;
    });
  }
}

/* ---------------------------------------------------------------- statusbar */

function renderStatusbar() {
  const el = $('#statusbar');
  if (!el) return;
  const cwd = S.session?.cwd || S.settings?.recentProjects?.[0] || S.info.home;
  const m = currentModel();
  el.innerHTML = `
    <button class="sb-item" data-act="pick-project">${icon('folder', 11)}${esc(baseName(cwd))}</button>
    <span class="sb-item">${icon('git-branch', 11)} main</span>
    <div class="spacer"></div>
    ${S.usage ? `<span class="sb-item">${icon('zap', 11)}${(S.usage.input || 0) + (S.usage.output || 0)} tok</span>` : ''}
    <button class="sb-item" data-act="model-picker">${icon('cpu', 11)}${esc(m ? m.model : 'No model')}</button>
    <span class="sb-item"><span class="dot-ok"></span>${esc(S.info.platform)}</span>
    <span class="sb-item">v${S.info.version}</span>`;
}

/* ---------------------------------------------------------------- renderAll */

function renderAll() {
  renderSidebar();
  renderTabs();
  if (S.session) renderSession();
  else renderHome();
  renderStatusbar();
  renderDock();
  renderTitlebarState();
}

/* ------------------------------------------------------------------ events */

async function pickProject() {
  const folder = await api.dialog.folder();
  if (!folder) return;
  const recent = [folder, ...(S.settings.recentProjects || []).filter((p) => p !== folder)].slice(0, 12);
  saveSettings({ recentProjects: recent });
  if (S.session) {
    S.session.cwd = folder;
    await saveActiveSession();
    refreshTree();
    renderSession();
    renderStatusbar();
  } else {
    await newSession({ cwd: folder });
  }
  toast('Workspace: ' + folder, 'ok');
}

async function pickModel(providerId, model) {
  if (!S.session) await newSession();
  S.session.model = { provider: providerId, model };
  await saveActiveSession();
  const recent = [providerId + '/' + model, ...(S.settings.recentModels || []).filter((x) => x !== providerId + '/' + model)].slice(0, 8);
  saveSettings({ recentModels: recent });
  closePopover();
  updateModelPill();
  renderStatusbar();
  renderSession();
}

async function pickAgent(id) {
  if (!S.session) await newSession();
  S.session.agentId = id;
  await saveActiveSession();
  closePopover();
  renderSession();
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme;
  saveSettings({ theme: cur === 'dark' ? 'light' : 'dark' });
  renderSidebar();
}

async function toggleSetting(key) {
  if (key.includes('.')) {
    const [group, sub] = key.split('.');
    const next = { ...(S.settings[group] || {}) };
    next[sub] = !next[sub];
    saveSettings({ [group]: next });
  } else {
    saveSettings({ [key]: !S.settings[key] });
  }
  renderSettings();
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act;
  if (act === 'toggle-dir') {
    const p = t.dataset.path;
    if (S.expanded.has(p)) S.expanded.delete(p);
    else S.expanded.add(p);
    renderFilesPane();
    return;
  }
  const handlers = {
    'toggle-sidebar': () => {
      S.sidebarOpen = !S.sidebarOpen;
      saveSettings({ sidebarOpen: S.sidebarOpen });
      renderTitlebarState();
    },
    'new-session': () => newSession(),
    'open-session': () => openSession(t.dataset.id),
    'close-tab': () => closeTab(t.dataset.id),
    'pick-project': () => pickProject(),
    'open-settings': () => openSettings(t.dataset.section || 'general'),
    'settings-section': () => {
      S.settingsSection = t.dataset.section;
      renderSettings();
    },
    'close-settings': () => closeSettings(),
    'close-settings-bg': (ev) => {
      if (ev.target === t) closeSettings();
    },
    'close-editor-sheet': (ev) => {
      if (ev.target === t) {
        if (S.settingsOpen) renderSettings();
        else $('#overlay-root').innerHTML = '';
      }
    },
    'open-palette': () => openPalette(),
    'close-palette': (ev) => {
      if (ev.target === t) closePalette();
    },
    'palette-run': () => {
      const c = COMMANDS().find((x) => x.id === t.dataset.id);
      closePalette();
      if (!S.settingsOpen) $('#overlay-root').innerHTML = '';
      c?.run();
    },
    'toggle-theme': () => toggleTheme(),
    'toggle-panel': () => togglePanel(t.dataset.panel || 'files'),
    'dock-tab': () => {
      S.panel = t.dataset.tab;
      renderDock();
    },
    'close-panel': () => togglePanel(S.panel),
    'browser-back': () => {
      const wv = document.querySelector('#browser-webview');
      if (wv && wv.canGoBack) wv.goBack();
    },
    'browser-forward': () => {
      const wv = document.querySelector('#browser-webview');
      if (wv && wv.canGoForward) wv.goForward();
    },
    'browser-refresh': () => {
      const wv = document.querySelector('#browser-webview');
      if (wv) wv.reload();
    },
    'browser-go': () => {
      const input = document.querySelector('#browser-input');
      if (!input) return;
      let u = input.value.trim();
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      S.browserUrl = u;
      if (S.browserHistory[S.browserHistIndex] !== u) {
        S.browserHistory = S.browserHistory.slice(0, S.browserHistIndex + 1);
        S.browserHistory.push(u);
        S.browserHistIndex = S.browserHistory.length - 1;
      }
      const wv = document.querySelector('#browser-webview');
      if (wv) wv.src = u;
    },
    'browser-open-external': () => {
      if (S.browserUrl && api) api.openExternal(S.browserUrl);
    },
    'open-external': () => api.openExternal(t.dataset.url),
    'send': () => sendMessage(),
    'attach': async () => {
      const files = await api.dialog.files();
      S.attachments.push(...files);
      renderAttachments();
    },
    'remove-attach': () => {
      S.attachments.splice(Number(t.dataset.i), 1);
      renderAttachments();
    },
    'model-picker': () => openModelPicker(),
    'agent-picker': () => openAgentPicker(),
    'pick-model': () => pickModel(t.dataset.provider, t.dataset.model),
    'pick-agent': () => pickAgent(t.dataset.id),
    'perm': async () => {
      if (!S.perm) return;
      const allowed = t.dataset.allow === '1';
      await api.chat.permission({ requestId: S.perm.requestId, allowed });
      if (t.dataset.always && allowed) {
        const name = S.perm.name;
        const next = { ...(S.settings.permissions || {}), [name]: 'allow' };
        saveSettings({ permissions: next });
      }
      $('#perm-card')?.remove();
      S.perm = null;
    },
    'toggle-tool': () => {
      const card = t.closest('.tool-card');
      card?.querySelector('.tool-body')?.classList.toggle('hidden');
      if (!card) return;
      const body = card.querySelector('.tool-body');
      if (body) body.style.display = body.style.display === 'none' ? '' : 'none';
    },
    'copy-msg': () => {
      const m = findMsg(t.dataset.id);
      const text = (m?.parts || []).map((p) => (p.type === 'text' ? p.text : '')).join('\n');
      api.copy(text);
      toast('Copied', 'ok');
    },
    'delete-msg': async () => {
      S.session.messages = S.session.messages.filter((m) => m.id !== t.dataset.id);
      await saveActiveSession();
      renderTimeline();
    },
    'retry-msg': async () => {
      const m = findMsg(t.dataset.id);
      if (!m) return;
      const idx = S.session.messages.indexOf(m);
      S.session.messages = S.session.messages.slice(0, idx);
      await saveActiveSession();
      renderTimeline();
      const lastUser = [...S.session.messages].reverse().find((x) => x.role === 'user');
      if (lastUser) {
        const text = (lastUser.parts || []).map((p) => p.text || '').join('\n');
        S.session.messages = S.session.messages.slice(0, S.session.messages.indexOf(lastUser));
        await saveActiveSession();
        const ta = $('#prompt');
        if (ta) ta.value = text;
        await sendMessage();
      }
    },
    'fork-msg': async () => {
      const m = findMsg(t.dataset.id);
      if (!m) return;
      const idx = S.session.messages.indexOf(m);
      const fork = { ...S.session, id: undefined, messages: S.session.messages.slice(0, idx + 1) };
      const created = await api.sessions.create({ cwd: S.session.cwd, model: S.session.model, agentId: S.session.agentId, title: (S.session.title || 'Session') + ' (fork)' });
      created.messages = fork.messages;
      await api.sessions.save(created);
      await openSession(created.id);
      toast('Forked session', 'ok');
    },
    'compact-session': () => compactSession(),
    'export-session': () => exportSession(),
    'session-menu': () => openSessionMenu(t.dataset.id, t),
    'refresh-tree': () => refreshTree(),
    'reveal-cwd': () => api.openPath(S.session?.cwd || S.tree?.path || ''),
    'toggle-dir-action': () => {},
    'open-file': () => {
      openEditorTab(t.dataset.path);
      if (!S.expanded.size) return;
    },
    'switch-file': () => {
      S.activeEditor = t.dataset.path;
      renderEditorPane();
    },
    'close-file': () => {
      S.editorTabs = S.editorTabs.filter((x) => x.path !== t.dataset.path);
      if (S.activeEditor === t.dataset.path) S.activeEditor = S.editorTabs[0]?.path || null;
      renderEditorPane();
    },
    'save-file': () => saveFile(),
    'new-file': () => newFile(),
    'set-accent': () => {
      saveSettings({ accent: t.dataset.value });
      renderSettings();
    },
    'set-seg': () => {
      const key = t.dataset.key;
      const value = t.dataset.value;
      if (key.startsWith('permissions.')) {
        const tool = key.split('.')[1];
        saveSettings({ permissions: { ...(S.settings.permissions || {}), [tool]: value } });
      } else {
        saveSettings({ [key]: value });
      }
      renderSettings();
    },
    'toggle-setting': () => toggleSetting(t.dataset.key),
    'add-provider': () => addProvider(t.dataset.id),
    'edit-provider': () => providerEditor(t.dataset.id),
    'save-provider': () => saveProvider(t.dataset.id),
    'remove-provider': async () => {
      if (!confirm('Remove this provider?')) return;
      S.settings = await api.providers.remove(t.dataset.id);
      S.providers = S.settings.providers;
      toast('Provider removed');
      renderSettings();
      renderSession();
    },
    'fetch-models': () => fetchModels(t.dataset.id),
    'test-provider': () => testProvider(t.dataset.id),
    'fav-model': () => {
      const key = t.dataset.key;
      const favs = S.settings.favorites || [];
      saveSettings({ favorites: favs.includes(key) ? favs.filter((x) => x !== key) : [...favs, key] });
      renderSettings();
    },
    'hide-model': () => {
      const key = t.dataset.key;
      const hidden = S.settings.hiddenModels || [];
      saveSettings({ hiddenModels: hidden.includes(key) ? hidden.filter((x) => x !== key) : [...hidden, key] });
      renderSettings();
    },
    'edit-agent': () => agentEditor(t.dataset.id),
    'save-agent': () => saveAgent(t.dataset.id),
    'remove-agent': async () => {
      const list = (S.settings.agents || []).filter((a) => a.id !== t.dataset.id);
      saveSettings({ agents: list });
      S.agents = await api.agents.list();
      renderSettings();
    },
    'add-mcp': async () => {
      const name = $('#mcp-name')?.value.trim();
      const cmd = $('#mcp-cmd')?.value.trim();
      if (!name || !cmd) return toast('Name and command are required', 'err');
      const parts = cmd.split(/\s+/);
      let env = {};
      try {
        const raw = $('#mcp-env')?.value.trim();
        if (raw) env = JSON.parse(raw);
      } catch {
        return toast('Env must be valid JSON', 'err');
      }
      await api.mcp.save({ id: 'mcp_' + Date.now().toString(36), name, command: parts[0], args: parts.slice(1), env, enabled: true });
      S.settings = await api.settings.get();
      renderSettings();
    },
    'remove-mcp': async () => {
      await api.mcp.remove(t.dataset.id);
      S.settings = await api.settings.get();
      renderSettings();
    },
    'refresh-skills': async () => {
      S.skills = await api.skills.list(S.session?.cwd);
      renderSettings();
    },
    'open-skill': async () => {
      const text = await api.skills.read(t.dataset.path);
      openEditorSheet(baseName(t.dataset.path), `<pre style="white-space:pre-wrap;font-family:var(--font-mono);font-size:12px;line-height:1.6;color:var(--text-muted)">${esc(text)}</pre>`);
    },
    'slash': () => {
      const ta = $('#prompt');
      if (ta) {
        ta.value = t.dataset.cmd + ' ';
        ta.focus();
        S.draft = ta.value;
      }
      closeComposerMenu();
    },
    'mention': () => {
      const ta = $('#prompt');
      if (ta) {
        ta.value = ta.value.replace(/@[^\s]*$/, '@' + t.dataset.path.replace(S.tree.path + '/', '').replace(/\\/g, '/') + ' ');
        ta.focus();
      }
      closeComposerMenu();
    },
    'win-min': () => api.win.minimize(),
    'win-max': () => api.win.maximize(),
    'win-close': () => api.win.close(),
    'open-folder': () => api.openPath(t.dataset.path),
  };
  const fn = handlers[act];
  if (fn) {
    e.preventDefault();
    try {
      await fn(e);
    } catch (err) {
      toast(err.message || String(err), 'err');
    }
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.settingSelect) saveSettings({ [el.dataset.settingSelect]: el.value });
  if (el.dataset.settingNumber !== undefined) saveSettings({ [el.dataset.settingNumber]: Number(el.value) });
  if (el.dataset.settingText !== undefined) saveSettings({ [el.dataset.settingText]: el.value });
  if (el.dataset.keybind) saveSettings({ keybinds: { ...(S.settings.keybinds || {}), [el.dataset.keybind]: el.value } });
  if (el.id === 'pv-type') {
    /* handled on save */
  }
});

document.addEventListener('keydown', (e) => {
  const meta = e.ctrlKey || e.metaKey;
  if (meta && e.key.toLowerCase() === 'k' && !e.shiftKey) {
    e.preventDefault();
    openPalette();
    return;
  }
  if (meta && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newSession();
    return;
  }
  if (meta && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    S.sidebarOpen = !S.sidebarOpen;
    saveSettings({ sidebarOpen: S.sidebarOpen });
    renderTitlebarState();
    return;
  }
  if (meta && e.key === ',') {
    e.preventDefault();
    openSettings('general');
    return;
  }
  if (meta && e.key.toLowerCase() === 'j') {
    e.preventDefault();
    togglePanel(S.panel || 'files');
    return;
  }
  if (meta && e.key.toLowerCase() === 's') {
    if (S.panel === 'editor') {
      e.preventDefault();
      saveFile();
    }
  }
  if (e.key === 'Escape') {
    if (S.paletteOpen) closePalette();
    else if (S.settingsOpen) closeSettings();
    else closePopover();
  }
});

/* ------------------------------------------------------------------- setup */

async function addProvider(presetId) {
  const preset = S.presets.find((p) => p.id === presetId);
  S.settings = await api.providers.add(presetId, {});
  S.providers = S.settings.providers;
  const created = S.providers[S.providers.length - 1];
  toast('Added ' + (preset?.name || presetId));
  renderSettings();
  if (created) providerEditor(created.id);
}

async function saveProvider(id) {
  const name = $('#pv-name')?.value.trim();
  const type = $('#pv-type')?.value;
  const baseUrl = $('#pv-url')?.value.trim();
  const apiKey = $('#pv-key')?.value;
  const models = ($('#pv-models')?.value || '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  S.settings = await api.providers.update(id, { name, type, baseUrl, apiKey, models });
  S.providers = S.settings.providers;
  toast('Provider saved', 'ok');
  renderSettings();
  renderSession();
  renderStatusbar();
}

async function fetchModels(id) {
  const status = $('#pv-status');
  if (status) status.textContent = 'Fetching models…';
  try {
    const models = await api.providers.models(id);
    const ta = $('#pv-models');
    if (ta) ta.value = models.join('\n');
    if (status) status.textContent = `Found ${models.length} models. Save to keep them.`;
    toast(`Found ${models.length} models`, 'ok');
  } catch (e) {
    if (status) status.textContent = 'Failed: ' + (e.message || e);
    toast(e.message || String(e), 'err');
  }
}

async function testProvider(id) {
  const status = $('#pv-status');
  if (status) status.textContent = 'Testing…';
  try {
    const res = await api.providers.test(id);
    if (status) status.textContent = `Connected in ${res.ms}ms · ${res.count} models available.`;
    toast('Connection OK', 'ok');
  } catch (e) {
    if (status) status.textContent = 'Failed: ' + (e.message || e);
    toast('Connection failed', 'err');
  }
}

async function saveAgent(id) {
  const name = $('#ag-name')?.value.trim();
  if (!name) return toast('Name is required', 'err');
  const description = $('#ag-desc')?.value.trim();
  const prompt = $('#ag-prompt')?.value;
  const list = [...(S.settings.agents || [])];
  if (id === 'new') list.push({ id: 'agent_' + Date.now().toString(36), name, description, prompt, tools: 'all' });
  else {
    const idx = list.findIndex((a) => a.id === id);
    if (idx >= 0) list[idx] = { ...list[idx], name, description, prompt };
  }
  saveSettings({ agents: list });
  S.agents = await api.agents.list();
  toast('Agent saved', 'ok');
  renderSettings();
  renderSession();
}

async function newFile() {
  const cwd = S.session?.cwd || S.settings?.recentProjects?.[0];
  const name = prompt('New file name (relative to the project root):');
  if (!name) return;
  const full = cwd.replace(/[\\/]$/, '') + '/' + name.replace(/^[\\/]+/, '');
  try {
    await api.fs.write(full, '');
    await refreshTree();
    openEditorTab(full);
  } catch (e) {
    toast(e.message || String(e), 'err');
  }
}

async function openSessionMenu(id, anchor) {
  closePopover();
  const el = document.createElement('div');
  el.className = 'popover';
  el.style.minWidth = '200px';
  el.innerHTML = `
    <button class="pop-row" data-act="rename-session" data-id="${id}">${icon('edit', 13)}<span>Rename</span></button>
    <button class="pop-row" data-act="export-session">${icon('download', 13)}<span>Export transcript</span></button>
    <div class="pop-sep"></div>
    <button class="pop-row" data-act="delete-session" data-id="${id}" style="color:var(--danger)">${icon('trash', 13)}<span>Delete</span></button>`;
  placePopover(el, anchor, 'right');
}

async function renameSession(id) {
  const s = S.sessions.find((x) => x.id === id);
  const title = prompt('Session name', s?.title || '');
  if (!title) return;
  await api.sessions.rename(id, title);
  if (id === S.activeId) S.session.title = title;
  await refreshSessions();
  renderAll();
}

/* extra delegated actions that need args */
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  if (t.dataset.act === 'rename-session') renameSession(t.dataset.id);
  if (t.dataset.act === 'delete-session') deleteSession(t.dataset.id);
});

/* -------------------------------------------------------------------- boot */

async function boot() {
  if (!api) {
    document.body.innerHTML =
      '<div style="display:grid;place-items:center;height:100vh;font-family:system-ui;color:#888">V-Coder must run inside the desktop app.</div>';
    return;
  }
  S.info = await api.info();
  document.body.classList.add('platform-' + S.info.platform);

  S.settings = await api.settings.get();
  S.providers = S.settings.providers || [];
  S.sidebarOpen = S.settings.sidebarOpen !== false;
  applyTheme();

  S.presets = await api.providers.presets();
  S.agents = await api.agents.list();
  S.skills = await api.skills.list(S.settings.recentProjects?.[0]).catch(() => []);

  renderShell();

  const openIds = S.settings.openSessions || [];
  S.tabs = openIds.map((id) => ({ id, title: 'Session' }));
  S.activeId = S.settings.lastSessionId || openIds[0] || null;
  if (S.activeId) {
    S.session = await api.sessions.get(S.activeId).catch(() => null);
    if (!S.session) S.activeId = null;
  }
  await refreshSessions();

  renderAll();
  if (S.session) {
    if (!S.panel) refreshTree();
  }

  api.chat.onEvent(handleChatEvent);
  api.sessions.onChanged(() => refreshSessions());
  api.system.onTheme(() => applyTheme());
  api.win.onState(() => {});

  api.term.onEvent(({ runId, type, data, stream, code }) => {
    if (runId !== S.termRunId) return;
    if (type === 'data') S.term.push({ type: stream === 'stderr' ? 'err' : 'out', text: data });
    if (type === 'exit') S.term.push({ type: 'exit', text: `[exit ${code}]` });
    const out = $('#term-out');
    if (out) {
      if (type === 'data') {
        const span = document.createElement('span');
        span.className = stream === 'stderr' ? 'err' : '';
        span.textContent = data;
        out.appendChild(span);
      } else if (type === 'exit') {
        const span = document.createElement('span');
        span.className = 'exit';
        span.textContent = `[exit ${code}]\n`;
        out.appendChild(span);
      }
      out.scrollTop = out.scrollHeight;
    }
  });

  setInterval(async () => {
    await refreshSessions();
    renderStatusbar();
  }, 8000);
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="padding:24px;color:#f87171;font-family:monospace;white-space:pre-wrap">Failed to start: ${esc(e.stack || e.message || e)}</pre>`;
});
