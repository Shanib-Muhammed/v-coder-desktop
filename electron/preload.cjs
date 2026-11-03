'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const handler = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api = {
  info: () => ipcRenderer.invoke('app:info'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  copy: (text) => ipcRenderer.invoke('app:copy', text),
  openPath: (p) => ipcRenderer.invoke('app:openPath', p),

  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    state: () => ipcRenderer.invoke('win:state'),
    toggleFullscreen: () => ipcRenderer.invoke('win:toggleFullscreen'),
    onState: (cb) => subscribe('win:state', cb),
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },

  providers: {
    presets: () => ipcRenderer.invoke('providers:presets'),
    list: () => ipcRenderer.invoke('providers:list'),
    add: (presetId, patch) => ipcRenderer.invoke('providers:add', { presetId, patch }),
    update: (id, patch) => ipcRenderer.invoke('providers:update', { id, patch }),
    remove: (id) => ipcRenderer.invoke('providers:remove', id),
    models: (id) => ipcRenderer.invoke('providers:models', id),
    test: (id) => ipcRenderer.invoke('providers:test', id),
  },

  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    get: (id) => ipcRenderer.invoke('sessions:get', id),
    create: (opts) => ipcRenderer.invoke('sessions:create', opts),
    save: (session) => ipcRenderer.invoke('sessions:save', session),
    delete: (id) => ipcRenderer.invoke('sessions:delete', id),
    rename: (id, title) => ipcRenderer.invoke('sessions:rename', { id, title }),
    export: (id) => ipcRenderer.invoke('sessions:export', id),
    onChanged: (cb) => subscribe('sessions:changed', cb),
  },

  chat: {
    send: (payload) => ipcRenderer.invoke('chat:send', payload),
    abort: (sessionId) => ipcRenderer.invoke('chat:abort', sessionId),
    permission: (payload) => ipcRenderer.invoke('chat:permission', payload),
    compact: (sessionId) => ipcRenderer.invoke('chat:compact', sessionId),
    onEvent: (cb) => subscribe('chat:event', cb),
  },

  fs: {
    tree: (cwd, depth) => ipcRenderer.invoke('fs:tree', { cwd, depth }),
    read: (p) => ipcRenderer.invoke('fs:read', p),
    write: (p, text) => ipcRenderer.invoke('fs:write', { path: p, text }),
    create: (parent, name, dir) => ipcRenderer.invoke('fs:create', { parent, name, dir }),
    remove: (p) => ipcRenderer.invoke('fs:delete', p),
    rename: (from, to) => ipcRenderer.invoke('fs:rename', { from, to }),
    reveal: (p) => ipcRenderer.invoke('fs:reveal', p),
  },

  term: {
    run: (cwd, command, runId) => ipcRenderer.invoke('term:run', { cwd, command, runId }),
    kill: (runId) => ipcRenderer.invoke('term:kill', runId),
    onEvent: (cb) => subscribe('term:event', cb),
  },

  dialog: {
    folder: () => ipcRenderer.invoke('dialog:folder'),
    files: () => ipcRenderer.invoke('dialog:files'),
  },

  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
  },

  skills: {
    list: (cwd) => ipcRenderer.invoke('skills:list', cwd),
    read: (p) => ipcRenderer.invoke('skills:read', p),
  },

  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    save: (server) => ipcRenderer.invoke('mcp:save', server),
    remove: (id) => ipcRenderer.invoke('mcp:remove', id),
  },

  system: {
    permissions: () => ipcRenderer.invoke('system:permissions'),
    check: () => ipcRenderer.invoke('system:check'),
    onTheme: (cb) => subscribe('theme:system', cb),
  },
};

contextBridge.exposeInMainWorld('vcoder', api);
