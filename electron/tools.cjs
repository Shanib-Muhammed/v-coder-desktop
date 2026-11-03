'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.venv', 'venv', '__pycache__',
  'target', '.idea', '.vscode', '.cache', 'vendor', 'Pods', '.gradle', '.mvn', 'coverage', '.turbo',
  '.DS_Store', 'obj', 'bin',
]);

const MAX_OUTPUT = 60000;

function clip(text, max = MAX_OUTPUT) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n… truncated ${s.length - max} characters`;
}

function resolvePath(cwd, p) {
  const raw = String(p || '.').trim();
  const expanded = raw.startsWith('~') ? path.join(process.env.USERPROFILE || process.env.HOME || '.', raw.slice(1)) : raw;
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd || '.', expanded);
}

function rel(cwd, abs) {
  const r = path.relative(cwd, abs);
  return r && !r.startsWith('..') ? r.split(path.sep).join('/') : abs;
}

const DEFS = [
  {
    name: 'read',
    description:
      'Read a file from the workspace. Returns numbered lines. Use offset/limit for large files. Always read a file before editing it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to the workspace root.' },
        offset: { type: 'integer', description: '1-based line to start from.' },
        limit: { type: 'integer', description: 'Maximum number of lines to return (default 2000).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'write',
    description: 'Create or overwrite a file with the given content. Parent directories are created automatically.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'Full file content to write.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit',
    description:
      'Replace exact text in a file. `oldString` must appear exactly once unless `replaceAll` is true. Include surrounding context to make it unique.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldString: { type: 'string', description: 'Exact text to find.' },
        newString: { type: 'string', description: 'Replacement text.' },
        replaceAll: { type: 'boolean' },
      },
      required: ['path', 'oldString', 'newString'],
      additionalProperties: false,
    },
  },
  {
    name: 'list',
    description: 'List files and directories. Use this to explore the project structure.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to the workspace root. Defaults to the root.' },
        depth: { type: 'integer', description: 'How many levels to recurse (default 2, max 4).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'glob',
    description: 'Find files by glob pattern, e.g. "src/**/*.ts" or "**/*.json".',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'Directory to search from. Defaults to the workspace root.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'grep',
    description: 'Search file contents with a regular expression. Returns matching lines with file and line number.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression.' },
        include: { type: 'string', description: 'Glob filter for files, e.g. "*.ts" or "src/**/*.py".' },
        path: { type: 'string' },
        maxResults: { type: 'integer', description: 'Default 120.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'bash',
    description:
      'Run a shell command in the workspace. Use for builds, tests, git, package managers and anything else the terminal can do. Returns stdout, stderr and exit code.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'integer', description: 'Milliseconds, default 120000, max 600000.' },
        cwd: { type: 'string', description: 'Directory relative to the workspace root.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'webfetch',
    description: 'Fetch a URL and return its text content. Use for documentation and API references.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        format: { type: 'string', enum: ['markdown', 'text'] },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'todo',
    description: 'Replace the session todo list. Use it to plan multi-step work and keep it current.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
  },
];

function globToRegExp(glob) {
  let g = String(glob).replace(/\\/g, '/');
  let out = '^';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('+.^$()|{}[]'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp(out + '$', 'i');
}

async function walk(dir, relBase, depth, maxDepth, out) {
  if (depth > maxDepth || out.length > 4000) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length > 4000) return;
    if (e.name.startsWith('.') && e.name !== '.env.example' && e.name !== '.github') {
      if (IGNORE_DIRS.has(e.name) || e.name === '.git') continue;
    }
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const r = relBase ? relBase + '/' + e.name : e.name;
    out.push(r + (e.isDirectory() ? '/' : ''));
    if (e.isDirectory()) await walk(full, r, depth + 1, maxDepth, out);
  }
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pickShell(custom) {
  const isWin = process.platform === 'win32';
  const shell = String(custom || '').trim();
  const name = shell.toLowerCase();
  if (shell) {
    if (name.includes('pwsh') || name.includes('powershell')) return { file: shell, args: (c) => ['-NoProfile', '-Command', c] };
    if (name.includes('bash')) return { file: shell, args: (c) => ['-lc', c] };
    if (name.includes('cmd')) return { file: shell, args: (c) => ['/d', '/s', '/c', c] };
    if (!isWin) return { file: shell, args: (c) => ['-lc', c] };
  }
  if (isWin) return { file: process.env.ComSpec || 'cmd.exe', args: (c) => ['/d', '/s', '/c', c] };
  return { file: process.env.SHELL || '/bin/bash', args: (c) => ['-lc', c] };
}

function runShell(command, cwd, timeout, onData, customShell) {
  return new Promise((resolve) => {
    const { file, args } = pickShell(customShell);
    let child;
    try {
      child = spawn(file, args(command), { cwd, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, windowsHide: true });
    } catch (e) {
      resolve({ output: 'Failed to start shell: ' + e.message, code: -1 });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }, Math.min(Math.max(timeout || 120000, 1000), 600000));
    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      if (out.length < 400000 && onData) onData(s);
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ output: 'Shell error: ' + e.message, code: -1 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let text = '';
      if (out.trim()) text += out;
      if (err.trim()) text += (text ? '\n\n' : '') + '[stderr]\n' + err;
      if (!text.trim()) text = '(no output)';
      text += `\n\n[exit code ${code}]`;
      resolve({ output: clip(text), code });
    });
  });
}

function diffSnippet(before, after) {
  if (before.length > 200000 || after.length > 200000) return null;
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    let dropped = 0;
    while (i < a.length && dropped < 3 && a[i] !== b[j] && a[i] !== b[j + 1] && a[i + 1] !== b[j]) {
      out.push('- ' + a[i]);
      i++;
      dropped++;
    }
    let added = 0;
    while (j < b.length && added < 3 && a[i] !== b[j] && a[i + 1] !== b[j] && a[i] !== b[j + 1]) {
      out.push('+ ' + b[j]);
      j++;
      added++;
    }
    if (!dropped && !added) {
      i++;
      j++;
      if (out.length > 60) break;
    }
    if (out.length > 60) break;
  }
  return out.slice(0, 60).join('\n');
}

async function execute(ctx, name, args) {
  const cwd = ctx.cwd;
  const call = (a) => (a === undefined ? '' : String(a));

  if (name === 'read') {
    const abs = resolvePath(cwd, args.path);
    const stat = await fsp.stat(abs).catch(() => null);
    if (!stat) return { output: `File not found: ${args.path}` };
    if (stat.isDirectory()) return { output: `${args.path} is a directory. Use list.` };
    if (stat.size > 4 * 1024 * 1024) return { output: `File is too large (${Math.round(stat.size / 1024)} KB). Read a slice with offset/limit, or use grep.` };
    const buf = await fsp.readFile(abs);
    if (buf.includes(0)) return { output: `Binary file: ${args.path} (${buf.length} bytes).` };
    const lines = buf.toString('utf8').split(/\r?\n/);
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.min(Math.max(Number(args.limit) || 2000, 1), 5000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const width = String(offset + slice.length - 1).length;
    const body = slice.map((l, i) => String(offset + i).padStart(width, ' ') + '  ' + l).join('\n');
    const more = offset - 1 + slice.length < lines.length ? `\n… ${lines.length - (offset - 1 + slice.length)} more lines` : '';
    return { output: clip(`${rel(cwd, abs)} (${lines.length} lines)\n${body}${more}`), path: rel(cwd, abs) };
  }

  if (name === 'write') {
    const abs = resolvePath(cwd, args.path);
    const before = await fsp.readFile(abs, 'utf8').catch(() => '');
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, String(args.content ?? ''), 'utf8');
    return {
      output: `Wrote ${Buffer.byteLength(String(args.content ?? ''))} bytes to ${rel(cwd, abs)}`,
      path: rel(cwd, abs),
      diff: before ? diffSnippet(before, String(args.content ?? '')) : null,
    };
  }

  if (name === 'edit') {
    const abs = resolvePath(cwd, args.path);
    const before = await fsp.readFile(abs, 'utf8').catch(() => null);
    if (before === null) return { output: `File not found: ${args.path}` };
    const oldS = String(args.oldString ?? '');
    const newS = String(args.newString ?? '');
    if (!oldS) return { output: 'oldString must not be empty.' };
    const count = before.split(oldS).length - 1;
    if (count === 0) return { output: `oldString was not found in ${args.path}. Read the file and copy the exact text, including indentation.` };
    if (count > 1 && !args.replaceAll) return { output: `oldString appears ${count} times in ${args.path}. Add more context to make it unique, or set replaceAll.` };
    const after = args.replaceAll ? before.split(oldS).join(newS) : before.replace(oldS, newS);
    await fsp.writeFile(abs, after, 'utf8');
    return { output: `Edited ${rel(cwd, abs)} (${count} replacement${count > 1 ? 's' : ''})`, path: rel(cwd, abs), diff: diffSnippet(before, after) };
  }

  if (name === 'list') {
    const abs = resolvePath(cwd, args.path || '.');
    const depth = Math.min(Math.max(Number(args.depth) || 2, 1), 4);
    const out = [];
    await walk(abs, '', 1, depth, out);
    return { output: clip(`${rel(cwd, abs) || '.'}/\n` + (out.join('\n') || '(empty)')) };
  }

  if (name === 'glob') {
    const root = resolvePath(cwd, args.path || '.');
    const re = globToRegExp(args.pattern);
    const files = [];
    await walk(root, '', 1, 12, files);
    const matches = files.filter((f) => !f.endsWith('/') && (re.test(f) || re.test('/' + f)));
    return { output: clip(matches.length ? matches.slice(0, 400).join('\n') : 'No files matched.') };
  }

  if (name === 'grep') {
    const root = resolvePath(cwd, args.path || '.');
    let re;
    try {
      re = new RegExp(String(args.pattern), 'i');
    } catch (e) {
      return { output: 'Invalid regular expression: ' + e.message };
    }
    const inc = args.include ? globToRegExp(args.include) : null;
    const max = Math.min(Math.max(Number(args.maxResults) || 120, 1), 500);
    const files = [];
    await walk(root, '', 1, 12, files);
    const hits = [];
    for (const f of files) {
      if (hits.length >= max) break;
      if (f.endsWith('/') || f.split('/').some((p) => IGNORE_DIRS.has(p))) continue;
      if (inc && !inc.test(f)) continue;
      const abs = path.join(root, f);
      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch {
        continue;
      }
      if (stat.size > 1.5 * 1024 * 1024) continue;
      let text;
      try {
        text = await fsp.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        if (re.test(lines[i])) hits.push(`${f}:${i + 1}: ${lines[i].slice(0, 300)}`);
      }
    }
    return { output: clip(hits.length ? hits.join('\n') : 'No matches found.') };
  }

  if (name === 'bash') {
    const dir = resolvePath(cwd, args.cwd || '.');
    const res = await runShell(String(args.command), dir, Number(args.timeout) || 120000, ctx.onStream, ctx.shell);
    return { output: res.output, exitCode: res.code };
  }

  if (name === 'webfetch') {
    const url = String(args.url || '');
    if (!/^https?:\/\//i.test(url)) return { output: 'Only http(s) URLs are supported.' };
    const res = await fetch(url, {
      headers: { 'User-Agent': 'V-Coder/1.0', Accept: 'text/html,application/json,text/plain' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return { output: `HTTP ${res.status} ${res.statusText}` };
    const ct = res.headers.get('content-type') || '';
    const raw = await res.text();
    const text = ct.includes('html') ? htmlToText(raw) : raw;
    return { output: clip(text) };
  }

  if (name === 'todo') {
    const todos = Array.isArray(args.todos) ? args.todos : [];
    if (ctx.onTodo) ctx.onTodo(todos);
    return { output: `Todo list updated (${todos.length} items).` };
  }

  return { output: `Unknown tool: ${name}` };
}

module.exports = { DEFS, execute, resolvePath, rel, globToRegExp, IGNORE_DIRS, pickShell };
