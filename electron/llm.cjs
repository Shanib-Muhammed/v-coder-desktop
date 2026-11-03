'use strict';

const { authHeaders, modelsEndpoint } = require('./providers.cjs');

/** Split a web ReadableStream into SSE `data:` payloads. */
async function* sse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        yield payload;
      }
    }
    const rest = buffer.trim();
    if (rest.startsWith('data:')) {
      const payload = rest.slice(5).trim();
      if (payload && payload !== '[DONE]') yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}

async function readError(res) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* ignore */
  }
  let detail = text;
  try {
    const j = JSON.parse(text);
    detail = j.error?.message || j.error?.status || j.message || text;
  } catch {
    /* keep raw */
  }
  return `HTTP ${res.status} ${res.statusText}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`;
}

function trimBase(url) {
  return String(url || '').replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ OpenAI */

function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || null };
      if (m.toolCalls && m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: typeof t.args === 'string' ? t.args : JSON.stringify(t.args || {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: String(m.content ?? '') });
    }
  }
  return out;
}

async function* openaiStream(req) {
  const { provider, model, system, messages, tools, temperature, maxTokens, signal } = req;
  const base = trimBase(provider.baseUrl);
  const url = provider.type === 'azure' ? `${base}/chat/completions?api-version=2024-10-21` : `${base}/chat/completions`;

  const body = {
    model,
    stream: true,
    messages: toOpenAIMessages(system, messages),
  };
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = 'auto';
  }
  if (typeof temperature === 'number') body.temperature = temperature;
  if (maxTokens) body.max_tokens = maxTokens;
  if (provider.type === 'openai') body.stream_options = { include_usage: true };

  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(provider),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));

  const calls = new Map();
  for await (const payload of sse(res)) {
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    if (json.usage) yield { type: 'usage', input: json.usage.prompt_tokens, output: json.usage.completion_tokens };
    const choice = (json.choices || [])[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    const reasoning = delta.reasoning_content || delta.reasoning;
    if (reasoning) yield { type: 'reasoning', text: reasoning };
    if (delta.content) yield { type: 'text', text: delta.content };
    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      let cur = calls.get(idx);
      if (!cur) {
        cur = { id: tc.id || `call_${idx}_${Date.now()}`, name: '', args: '' };
        calls.set(idx, cur);
        if (tc.id) yield { type: 'tool_start', index: idx, id: cur.id, name: '' };
      }
      if (tc.id && !cur.idSent) {
        cur.idSent = true;
      }
      if (tc.function?.name) {
        cur.name += tc.function.name;
        yield { type: 'tool_start', index: idx, id: cur.id, name: cur.name };
      }
      if (tc.function?.arguments) {
        cur.args += tc.function.arguments;
        yield { type: 'tool_args', index: idx, delta: tc.function.arguments };
      }
    }
    if (choice.finish_reason === 'tool_calls') {
      for (const [idx, c] of calls) yield { type: 'tool_end', index: idx, id: c.id, name: c.name, args: c.args };
      calls.clear();
    }
  }
  for (const [idx, c] of calls) yield { type: 'tool_end', index: idx, id: c.id, name: c.name, args: c.args };
}

/* --------------------------------------------------------------- Anthropic */

function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content || '' }] });
    } else if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const t of m.toolCalls || []) {
        content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.args && typeof t.args === 'object' ? t.args : safeParse(t.args) });
      }
      if (!content.length) content.push({ type: 'text', text: '' });
      out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content ?? '') };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.toolOnly) last.content.push(block);
      else out.push({ role: 'user', content: [block], toolOnly: true });
    }
  }
  return out.map(({ role, content }) => ({ role, content }));
}

function safeParse(s) {
  if (s && typeof s === 'object') return s;
  try {
    const v = JSON.parse(s || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

async function* anthropicStream(req) {
  const { provider, model, system, messages, tools, temperature, maxTokens, signal } = req;
  const base = trimBase(provider.baseUrl);
  const url = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;

  const body = {
    model,
    max_tokens: maxTokens || 8192,
    stream: true,
    messages: toAnthropicMessages(messages),
  };
  if (system) body.system = system;
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  if (typeof temperature === 'number') body.temperature = temperature;

  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(provider),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));

  const blocks = new Map();
  for await (const payload of sse(res)) {
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    if (json.type === 'error') throw new Error(json.error?.message || JSON.stringify(json.error));
    if (json.type === 'message_start' && json.message?.usage) {
      yield { type: 'usage', input: json.message.usage.input_tokens };
    }
    if (json.type === 'content_block_start') {
      const b = json.content_block || {};
      if (b.type === 'tool_use') {
        blocks.set(json.index, { id: b.id, name: b.name, args: '' });
        yield { type: 'tool_start', index: json.index, id: b.id, name: b.name };
      } else {
        blocks.set(json.index, { text: '' });
      }
    }
    if (json.type === 'content_block_delta') {
      const d = json.delta || {};
      if (d.type === 'text_delta' && d.text) yield { type: 'text', text: d.text };
      if (d.type === 'thinking_delta' && d.thinking) yield { type: 'reasoning', text: d.thinking };
      if (d.type === 'input_json_delta' && d.partial_json) {
        const cur = blocks.get(json.index);
        if (cur) cur.args += d.partial_json;
        yield { type: 'tool_args', index: json.index, delta: d.partial_json };
      }
    }
    if (json.type === 'content_block_stop') {
      const cur = blocks.get(json.index);
      if (cur && cur.name) {
        yield { type: 'tool_end', index: json.index, id: cur.id, name: cur.name, args: cur.args };
      }
    }
    if (json.type === 'message_delta' && json.usage) {
      yield { type: 'usage', output: json.usage.output_tokens };
    }
  }
}

/* ------------------------------------------------------------------ Google */

function toGeminiContents(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: m.content || '' }] });
    } else if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const t of m.toolCalls || []) {
        parts.push({ functionCall: { name: t.name, args: t.args && typeof t.args === 'object' ? t.args : safeParse(t.args) } });
      }
      if (!parts.length) parts.push({ text: '' });
      out.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      const part = { functionResponse: { name: m.name || 'tool', response: { result: String(m.content ?? '') } } };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && last.fnOnly) last.parts.push(part);
      else out.push({ role: 'user', parts: [part], fnOnly: true });
    }
  }
  return out.map(({ role, parts }) => ({ role, parts }));
}

async function* googleStream(req) {
  const { provider, model, system, messages, tools, temperature, maxTokens, signal } = req;
  const base = trimBase(provider.baseUrl);
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const body = { contents: toGeminiContents(messages) };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools && tools.length) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }
  const gen = {};
  if (typeof temperature === 'number') gen.temperature = temperature;
  if (maxTokens) gen.maxOutputTokens = maxTokens;
  if (Object.keys(gen).length) body.generationConfig = gen;

  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(provider),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));

  let n = 0;
  for await (const payload of sse(res)) {
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    if (json.usageMetadata) {
      yield { type: 'usage', input: json.usageMetadata.promptTokenCount, output: json.usageMetadata.candidatesTokenCount };
    }
    const cand = (json.candidates || [])[0];
    if (!cand) continue;
    for (const part of cand.content?.parts || []) {
      if (typeof part.text === 'string' && part.text) yield { type: 'text', text: part.text };
      if (part.functionCall) {
        const idx = n++;
        const id = `gcall_${idx}_${Date.now()}`;
        yield { type: 'tool_start', index: idx, id, name: part.functionCall.name };
        yield { type: 'tool_end', index: idx, id, name: part.functionCall.name, args: JSON.stringify(part.functionCall.args || {}) };
      }
    }
  }
}

/* ------------------------------------------------------------------ Ollama */

async function* ollamaStream(req) {
  const { provider, model, messages, system, tools, temperature, signal } = req;
  const base = trimBase(provider.baseUrl).replace(/\/v1$/, '');
  const url = `${base}/api/chat`;
  const list = [];
  if (system) list.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'tool') list.push({ role: 'tool', content: String(m.content ?? '') });
    else list.push({ role: m.role, content: m.content || '' });
  }
  const body = { model, messages: list, stream: true };
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }
  if (typeof temperature === 'number') body.options = { temperature };

  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(await readError(res));

  const decoder = new TextDecoder();
  let buffer = '';
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let json;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      if (json.error) throw new Error(json.error);
      const msg = json.message || {};
      if (msg.content) yield { type: 'text', text: msg.content };
      for (const [idx, tc] of (msg.tool_calls || []).entries()) {
        const id = `ocall_${idx}_${Date.now()}`;
        yield { type: 'tool_start', index: idx, id, name: tc.function?.name || 'tool' };
        yield { type: 'tool_end', index: idx, id, name: tc.function?.name || 'tool', args: JSON.stringify(tc.function?.arguments || {}) };
      }
    }
  }
}

function streamChat(req) {
  const type = req.provider.type;
  if (type === 'anthropic') return anthropicStream(req);
  if (type === 'google') return googleStream(req);
  if (type === 'ollama') return ollamaStream(req);
  return openaiStream(req);
}

module.exports = { streamChat, modelsEndpoint };
