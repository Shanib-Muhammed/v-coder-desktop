'use strict';

const fs = require('fs');
const path = require('path');
const { streamChat } = require('./llm.cjs');
const tools = require('./tools.cjs');

const MAX_STEPS = 40;

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
}

function toolTitle(name, args) {
  if (!args || typeof args !== 'object') return name;
  switch (name) {
    case 'read':
    case 'write':
    case 'edit':
      return `${name === 'read' ? 'Read' : name === 'write' ? 'Write' : 'Edit'} ${args.path || ''}`.trim();
    case 'list':
      return `List ${args.path || '.'}`;
    case 'glob':
      return `Find ${args.pattern || ''}`;
    case 'grep':
      return `Search ${args.pattern || ''}`;
    case 'bash':
      return `Run ${String(args.command || '').slice(0, 80)}`;
    case 'webfetch':
      return `Fetch ${String(args.url || '').slice(0, 70)}`;
    case 'todo':
      return 'Update todos';
    default:
      return name;
  }
}

function buildSystemPrompt({ cwd, agent, platform, model }) {
  const parts = [];
  parts.push(
    [
      'You are V-Coder, an expert AI software engineer working inside a desktop coding app.',
      'You help the user build, debug, refactor and ship real software in their workspace.',
      '',
      `Platform: ${platform}`,
      `Workspace root: ${cwd}`,
      `Date: ${new Date().toISOString().slice(0, 10)}`,
      model ? `Active model: ${model}` : '',
      '',
      '# How you work',
      '- Be direct and concrete. Answer questions, then do the work.',
      '- Use the tools to inspect the real workspace instead of guessing about its contents.',
      '- Read a file before you edit it. Match the existing style, naming and structure.',
      '- Make the smallest change that fully solves the problem. Do not leave placeholders or TODOs.',
      '- When you add or change behaviour, verify it: run the build, tests or the command that proves it works.',
      '- For multi-step work, keep the todo list current so the user can follow along.',
      '- Never run destructive commands (rm -rf, format, force push, dropping databases) without clear user intent.',
      '- Never print, log or commit secrets. If a key is missing, ask for it instead of inventing one.',
      '- When you finish, summarise what changed and how it was verified in one or two short sentences.',
      '',
      '# Output',
      '- Use GitHub-flavoured Markdown. Use fenced code blocks with a language tag.',
      '- Keep prose tight. Prefer short paragraphs and lists over essays.',
      '- File references look like `path/to/file.ts:42`.',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  if (agent && agent.prompt) {
    parts.push(`# Agent instructions (${agent.name})\n${agent.prompt}`);
  }

  for (const name of ['AGENTS.md', 'V-CODER.md', '.vcoder/AGENTS.md', '.github/copilot-instructions.md']) {
    try {
      const p = path.join(cwd, name);
      const stat = fs.statSync(p);
      if (stat.isFile() && stat.size < 60000) {
        parts.push(`# Project instructions (${name})\n${fs.readFileSync(p, 'utf8')}`);
      }
    } catch {
      /* not present */
    }
  }

  return parts.join('\n\n');
}

/** Turn stored UI messages into provider-agnostic chat messages. */
function toChatMessages(session, systemPrompt) {
  const out = [];
  const messages = session.messages || [];
  for (const m of messages) {
    if (m.role === 'user') {
      const text = (m.parts || [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      if (text.trim()) out.push({ role: 'user', content: text });
      for (const p of m.parts || []) {
        if (p.type === 'file' && p.path) out.push({ role: 'user', content: `[attached file: ${p.path}]\n${p.text || ''}` });
      }
    } else if (m.role === 'assistant') {
      const text = (m.parts || [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
      const calls = (m.parts || [])
        .filter((p) => p.type === 'tool' && p.callId && p.state !== 'denied')
        .map((p) => ({ id: p.callId, name: p.name, args: p.args && typeof p.args === 'object' ? p.args : safeObj(p.args) }));
      if (!text.trim() && !calls.length) continue;
      out.push({ role: 'assistant', content: text, toolCalls: calls });
      for (const p of m.parts || []) {
        if (p.type === 'tool' && p.callId) {
          out.push({
            role: 'tool',
            toolCallId: p.callId,
            name: p.name,
            content: p.state === 'denied' ? 'Permission denied by the user.' : String(p.output ?? ''),
          });
        }
      }
    }
  }
  return { system: systemPrompt, messages: out };
}

function safeObj(s) {
  if (s && typeof s === 'object') return s;
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function trimHistory(chatMessages, maxChars = 260000) {
  let total = 0;
  const list = chatMessages.messages;
  const keep = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    const size = String(m.content || '').length + JSON.stringify(m.toolCalls || []).length;
    if (total + size > maxChars && keep.length > 6) break;
    total += size;
    keep.unshift(m);
  }
  // Keep tool results adjacent to their assistant call.
  while (keep.length && keep[0].role === 'tool') keep.shift();
  chatMessages.messages = keep;
  return chatMessages;
}

function emitTodos(ctx, todos) {
  ctx.emit({ t: 'todos', todos });
}

async function runAgent(ctx) {
  const { session, provider, model, agentConfig, settings, emit, signal } = ctx;
  const cwd = session.cwd || process.cwd();
  const platform = `${process.platform} ${process.arch}`;

  const systemPrompt = buildSystemPrompt({ cwd, agent: agentConfig, platform, model });

  const assistant = {
    id: uid('msg'),
    role: 'assistant',
    createdAt: Date.now(),
    parts: [],
  };
  session.messages.push(assistant);
  emit({ t: 'message-start', message: assistant });

  let textPart = null;
  let reasoningPart = null;
  let steps = 0;
  let aborted = false;

  signal.addEventListener('abort', () => {
    aborted = true;
  });

  const maxSteps = Math.min(Math.max(Number(settings.maxSteps) || MAX_STEPS, 1), 100);

  try {
    while (steps++ < maxSteps && !aborted) {
      const chat = trimHistory(toChatMessages(session, systemPrompt));

      // Reset accumulators for this step.
      textPart = null;
      reasoningPart = null;

      emit({ t: 'status', status: 'thinking' });

      const calls = new Map();
      let sawText = false;

      const iterator = streamChat({
        provider,
        model,
        system: chat.system,
        messages: chat.messages,
        tools: agentConfig?.tools === 'none' ? [] : tools.DEFS,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        signal,
      });

      for await (const ev of iterator) {
        if (aborted) break;
        if (ev.type === 'usage') {
          assistant.usage = { input: ev.input ?? assistant.usage?.input, output: ev.output ?? assistant.usage?.output };
          emit({ t: 'usage', messageId: assistant.id, usage: assistant.usage });
        } else if (ev.type === 'text') {
          if (!textPart) {
            textPart = { type: 'text', id: uid('part'), text: '' };
            assistant.parts.push(textPart);
            emit({ t: 'part', messageId: assistant.id, part: textPart });
          }
          textPart.text += ev.text;
          sawText = true;
          emit({ t: 'status', status: 'streaming' });
          emit({ t: 'text', messageId: assistant.id, partId: textPart.id, delta: ev.text });
        } else if (ev.type === 'reasoning') {
          if (!reasoningPart) {
            reasoningPart = { type: 'reasoning', id: uid('part'), text: '' };
            assistant.parts.push(reasoningPart);
            emit({ t: 'part', messageId: assistant.id, part: reasoningPart });
          }
          reasoningPart.text += ev.text;
          emit({ t: 'reasoning', messageId: assistant.id, partId: reasoningPart.id, delta: ev.text });
        } else if (ev.type === 'tool_start') {
          const cur = calls.get(ev.index) || { id: ev.id, name: '', raw: '' };
          cur.id = ev.id || cur.id;
          if (ev.name) cur.name = ev.name;
          calls.set(ev.index, cur);
        } else if (ev.type === 'tool_args') {
          const cur = calls.get(ev.index) || { id: `call_${ev.index}`, name: '', raw: '' };
          cur.raw += ev.delta;
          calls.set(ev.index, cur);
        } else if (ev.type === 'tool_end') {
          const cur = calls.get(ev.index) || {};
          calls.set(ev.index, {
            id: ev.id || cur.id || `call_${ev.index}`,
            name: ev.name || cur.name || 'tool',
            raw: ev.args !== undefined ? String(ev.args) : cur.raw || '{}',
          });
        }
      }

      if (aborted) break;

      // Nothing to run? We are done.
      const pending = [...calls.values()].filter((c) => c.name);
      if (!pending.length) break;

      emit({ t: 'status', status: 'tool' });

      const results = [];
      for (const call of pending) {
        const args = parseArgs(call.raw);
        const part = {
          type: 'tool',
          id: uid('part'),
          callId: call.id,
          name: call.name,
          input: call.raw,
          args,
          title: toolTitle(call.name, args),
          state: 'running',
          startedAt: Date.now(),
        };
        assistant.parts.push(part);
        emit({ t: 'part', messageId: assistant.id, part });

        if (!tools.DEFS.some((d) => d.name === call.name)) {
          part.state = 'error';
          part.output = `Unknown tool: ${call.name}`;
          part.endedAt = Date.now();
          emit({ t: 'part', messageId: assistant.id, part });
          results.push({ call, output: part.output });
          continue;
        }

        const rule = (settings.permissions || {})[call.name] || 'ask';
        let allowed = rule === 'allow';
        if (rule === 'deny') allowed = false;
        else if (rule === 'ask') {
          emit({ t: 'permission-request', messageId: assistant.id, partId: part.id, name: call.name, args, title: part.title });
          allowed = await ctx.askPermission({ sessionId: session.id, partId: part.id, name: call.name, args, title: part.title });
        }

        if (!allowed) {
          part.state = 'denied';
          part.output = 'Permission denied by the user.';
          part.endedAt = Date.now();
          emit({ t: 'part', messageId: assistant.id, part });
          results.push({ call, output: part.output });
          continue;
        }

        try {
          const res = await tools.execute(
            {
              cwd,
              shell: settings.shell || '',
              onStream: (chunk) => emit({ t: 'tool-output', messageId: assistant.id, partId: part.id, delta: chunk }),
              onTodo: (todos) => {
                session.todos = todos;
                emitTodos(ctx, todos);
              },
            },
            call.name,
            args,
          );
          part.state = res.exitCode && res.exitCode !== 0 ? 'error' : 'done';
          part.output = res.output;
          part.diff = res.diff || null;
          part.endedAt = Date.now();
          if (call.name === 'write' || call.name === 'edit') {
            emit({ t: 'file-changed', path: res.path });
          }
        } catch (e) {
          part.state = 'error';
          part.output = 'Tool failed: ' + (e && e.message ? e.message : String(e));
          part.endedAt = Date.now();
        }
        emit({ t: 'part', messageId: assistant.id, part });
        results.push({ call, output: part.output });
      }

      emit({ t: 'status', status: 'thinking' });
      // Continue the loop so the model can react to the tool output.
    }

    emit({ t: 'status', status: 'idle' });
    emit({ t: 'done', messageId: assistant.id });
    return assistant;
  } catch (e) {
    const message = e && e.name === 'AbortError' ? 'Stopped by user.' : e && e.message ? e.message : String(e);
    assistant.error = message;
    emit({ t: 'error', messageId: assistant.id, message });
    emit({ t: 'status', status: 'idle' });
    return assistant;
  }
}

async function compactSession(ctx) {
  const { session, provider, model, signal } = ctx;
  const system = 'You compress chat transcripts. Reply with the summary only.';
  const transcript = (session.messages || [])
    .map((m) => {
      const text = (m.parts || [])
        .map((p) => (p.type === 'text' ? p.text : p.type === 'tool' ? `[tool:${p.name}] ${String(p.output || '').slice(0, 600)}` : ''))
        .join('\n');
      return `${m.role.toUpperCase()}: ${text}`;
    })
    .join('\n\n')
    .slice(-90000);

  let summary = '';
  const stream = streamChat({
    provider,
    model,
    system,
    messages: [
      {
        role: 'user',
        content:
          'Summarise this coding session so work can continue with less context. Keep: goals, decisions, files touched, open tasks, and any commands that matter. Be dense.\n\n' +
          transcript,
      },
    ],
    tools: [],
    signal,
  });
  for await (const ev of stream) if (ev.type === 'text') summary += ev.text;
  return summary.trim();
}

module.exports = { runAgent, compactSession, buildSystemPrompt, uid };
