'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DEFAULT_KEYBINDS = {
  'command.palette': 'mod+k',
  'command.palette.commands': 'mod+shift+p',
  'session.new': 'mod+n',
  'session.new.tab': 'mod+t',
  'session.close.tab': 'mod+w',
  'session.search': 'mod+shift+f',
  'session.compact': 'mod+shift+c',
  'session.export': 'mod+shift+e',
  'session.rename': 'f2',
  'model.choose': 'mod+m',
  'agent.cycle': 'tab',
  'sidebar.toggle': 'mod+b',
  'panel.files': 'mod+1',
  'panel.editor': 'mod+2',
  'panel.terminal': 'mod+3',
  'panel.close': 'mod+j',
  'settings.open': 'mod+,',
  'message.copy': 'mod+shift+c',
  'prompt.focus': 'mod+l',
  'editor.save': 'mod+s',
};

function defaultSettings() {
  return {
    version: 1,
    theme: 'system', // system | light | dark
    accent: 'blue',
    language: 'en',
    interfaceMode: 'side', // side | top
    sidebarOpen: true,
    sidebarWidth: 276,
    panelOpen: false,
    panelTab: 'files',
    panelWidth: 460,
    uiFont: '',
    codeFont: '',
    terminalFont: '',
    monoFontSize: 13,
    fontSize: 14,
    zoom: 1,
    spellcheck: true,
    wrapCode: false,
    autosave: true,
    temperature: undefined,
    maxTokens: undefined,
    maxSteps: 40,
    shell: '',
    defaultModel: null, // { provider, model }
    defaultAgent: 'build',
    favorites: [],
    hiddenModels: [],
    recentModels: [],
    providers: [],
    agents: [],
    mcp: [],
    skills: { enabled: true, extraDirs: [] },
    permissions: {
      read: 'allow',
      list: 'allow',
      glob: 'allow',
      grep: 'allow',
      edit: 'ask',
      write: 'ask',
      bash: 'ask',
      webfetch: 'allow',
      todo: 'allow',
    },
    notifications: { agent: true, permissions: true, errors: true },
    sounds: { agent: false, permissions: false, errors: false },
    autoTitle: true,
    showReasoning: true,
    compactAt: 0,
    keybinds: { ...DEFAULT_KEYBINDS },
    recentProjects: [],
    onboardingDone: false,
    lastSessionId: null,
    openSessions: [],
  };
}

const BUILTIN_AGENTS = [
  {
    id: 'build',
    name: 'Build',
    description: 'Full access. Edits files and runs tools.',
    builtin: true,
    tools: 'all',
    prompt: '',
  },
  {
    id: 'plan',
    name: 'Plan',
    description: 'Read-only analysis. Proposes changes without writing them.',
    builtin: true,
    tools: 'readonly',
    prompt:
      'You are in planning mode. Inspect the codebase and produce a precise implementation plan. Do not modify files and do not run commands that change the workspace.',
  },
];

class Store {
  constructor(dir, cipher) {
    this.dir = dir;
    this.cipher = cipher || null;
    this.settingsPath = path.join(dir, 'settings.json');
    this.sessionsDir = path.join(dir, 'sessions');
    this.settings = defaultSettings();
    this.cache = new Map();
  }

  async init() {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    try {
      const raw = JSON.parse(await fsp.readFile(this.settingsPath, 'utf8'));
      this.settings = { ...this.settings, ...raw, permissions: { ...this.settings.permissions, ...(raw.permissions || {}) }, keybinds: { ...this.settings.keybinds, ...(raw.keybinds || {}) } };
      if (Array.isArray(raw.providers)) this.settings.providers = await Promise.all(raw.providers.map((p) => this.decryptProvider(p)));
    } catch {
      /* first run */
    }
    return this.settings;
  }

  async encryptProvider(p) {
    const out = { ...p };
    if (this.cipher && p.apiKey && !p.apiKeyEnc) {
      try {
        out.apiKeyEnc = await this.cipher.encrypt(p.apiKey);
        out.apiKey = '';
      } catch {
        /* keep plaintext if encryption is unavailable */
      }
    }
    return out;
  }

  async decryptProvider(p) {
    const out = { ...p };
    if (this.cipher && p.apiKeyEnc && !p.apiKey) {
      try {
        out.apiKey = await this.cipher.decrypt(p.apiKeyEnc);
      } catch {
        out.apiKey = '';
      }
    }
    return out;
  }

  getSettings() {
    return this.settings;
  }

  async saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    const providers = await Promise.all((this.settings.providers || []).map((p) => this.encryptProvider(p)));
    const disk = { ...this.settings, providers };
    await fsp.writeFile(this.settingsPath, JSON.stringify(disk, null, 2), 'utf8');
    return this.settings;
  }

  sessionPath(id) {
    return path.join(this.sessionsDir, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
  }

  async listSessions() {
    let names = [];
    try {
      names = await fsp.readdir(this.sessionsDir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const s = JSON.parse(await fsp.readFile(path.join(this.sessionsDir, name), 'utf8'));
        out.push({
          id: s.id,
          title: s.title,
          cwd: s.cwd,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          model: s.model,
          agentId: s.agentId,
          messageCount: (s.messages || []).length,
          archived: !!s.archived,
        });
      } catch {
        /* skip corrupt */
      }
    }
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return out;
  }

  async getSession(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    try {
      const s = JSON.parse(await fsp.readFile(this.sessionPath(id), 'utf8'));
      this.cache.set(id, s);
      return s;
    } catch {
      return null;
    }
  }

  async saveSession(session) {
    session.updatedAt = Date.now();
    this.cache.set(session.id, session);
    const file = this.sessionPath(session.id);
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(session), 'utf8');
    await fsp.rename(tmp, file).catch(async () => {
      await fsp.writeFile(file, JSON.stringify(session), 'utf8');
      await fsp.unlink(tmp).catch(() => {});
    });
    return session;
  }

  async deleteSession(id) {
    this.cache.delete(id);
    await fsp.unlink(this.sessionPath(id)).catch(() => {});
  }

  async listSkills(projectCwd) {
    const dirs = [
      path.join(process.env.USERPROFILE || process.env.HOME || '', '.agents', 'skills'),
      path.join(process.env.USERPROFILE || process.env.HOME || '', '.config', 'v-coder', 'skills'),
      projectCwd ? path.join(projectCwd, '.v-coder', 'skills') : null,
      projectCwd ? path.join(projectCwd, '.agents', 'skills') : null,
      ...(this.settings.skills?.extraDirs || []),
    ].filter(Boolean);
    const out = [];
    for (const dir of dirs) {
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const skillPath = path.join(dir, e.name, 'SKILL.md');
        try {
          const text = await fsp.readFile(skillPath, 'utf8');
          const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          const meta = {};
          if (fm) {
            for (const line of fm[1].split(/\r?\n/)) {
              const m = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
              if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '');
            }
          }
          out.push({
            id: e.name,
            name: meta.name || e.name,
            description: meta.description || '',
            dir,
            path: skillPath,
            scope: dir.startsWith(projectCwd || '\u0000') ? 'project' : 'global',
          });
        } catch {
          /* not a skill */
        }
      }
    }
    return out;
  }
}

module.exports = { Store, defaultSettings, DEFAULT_KEYBINDS, BUILTIN_AGENTS };
