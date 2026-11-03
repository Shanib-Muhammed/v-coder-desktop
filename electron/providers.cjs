'use strict';

/**
 * Provider catalog and wire-format helpers.
 * Every provider is user-configurable: base URL, key, and models are editable.
 */

const PRESETS = [
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    docs: 'https://platform.openai.com/api-keys',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    keyEnv: 'ANTHROPIC_API_KEY',
    docs: 'https://console.anthropic.com/settings/keys',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    type: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com',
    keyEnv: 'GEMINI_API_KEY',
    docs: 'https://aistudio.google.com/apikey',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    docs: 'https://openrouter.ai/keys',
    models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat'],
  },
  {
    id: 'groq',
    name: 'Groq',
    type: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    docs: 'https://console.groq.com/keys',
    models: ['llama-3.3-70b-versatile', 'qwen/qwen3-32b', 'moonshotai/kimi-k2-instruct'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    keyEnv: 'DEEPSEEK_API_KEY',
    docs: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'xai',
    name: 'xAI',
    type: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    keyEnv: 'XAI_API_KEY',
    docs: 'https://console.x.ai',
    models: ['grok-4', 'grok-3', 'grok-code-fast-1'],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    type: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: 'MISTRAL_API_KEY',
    docs: 'https://console.mistral.ai/api-keys',
    models: ['mistral-large-latest', 'codestral-latest', 'devstral-medium-latest'],
  },
  {
    id: 'together',
    name: 'Together AI',
    type: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    keyEnv: 'TOGETHER_API_KEY',
    docs: 'https://api.together.ai/settings/api-keys',
    models: ['Qwen/Qwen3-Coder-480B-A35B-Instruct', 'deepseek-ai/DeepSeek-V3'],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    type: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyEnv: 'CEREBRAS_API_KEY',
    docs: 'https://cloud.cerebras.ai',
    models: ['qwen-3-coder-480b', 'llama-3.3-70b'],
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    type: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    keyEnv: 'FIREWORKS_API_KEY',
    docs: 'https://fireworks.ai/account/api-keys',
    models: ['accounts/fireworks/models/deepseek-v3', 'accounts/fireworks/models/qwen3-coder-480b-a35b-instruct'],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    type: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyEnv: 'NVIDIA_API_KEY',
    docs: 'https://build.nvidia.com',
    models: ['deepseek-ai/deepseek-v3.1', 'qwen/qwen3-coder-480b-a35b-instruct', 'moonshotai/kimi-k2-instruct'],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    type: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyEnv: '',
    docs: 'https://ollama.com',
    models: ['qwen2.5-coder:14b', 'llama3.2', 'deepseek-coder-v2'],
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    type: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    keyEnv: '',
    docs: 'https://lmstudio.ai',
    models: [],
  },
  {
    id: 'vllm',
    name: 'vLLM / Local',
    type: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1',
    keyEnv: '',
    docs: '',
    models: [],
  },
  {
    id: 'azure',
    name: 'Azure OpenAI',
    type: 'azure',
    baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT',
    keyEnv: 'AZURE_OPENAI_API_KEY',
    docs: 'https://portal.azure.com',
    models: [],
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    type: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1',
    keyEnv: '',
    docs: '',
    models: [],
  },
];

const byId = new Map(PRESETS.map((p) => [p.id, p]));

function preset(id) {
  return byId.get(id) || null;
}

function makeProvider(presetId, patch = {}) {
  const p = preset(presetId) || preset('custom');
  return {
    id: patch.id || (p.id === 'custom' ? 'custom-' + Math.random().toString(36).slice(2, 8) : p.id),
    preset: p.id,
    name: patch.name || p.name,
    type: patch.type || p.type,
    baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : p.baseUrl,
    apiKey: patch.apiKey || '',
    keyEncrypted: false,
    models: patch.models || [...p.models],
    headers: patch.headers || {},
    enabled: patch.enabled !== false,
    createdAt: Date.now(),
  };
}

function modelsEndpoint(provider) {
  const base = String(provider.baseUrl || '').replace(/\/+$/, '');
  if (provider.type === 'anthropic') return base + '/v1/models';
  if (provider.type === 'google') return base + '/v1beta/models';
  if (provider.type === 'azure') return base + '/models?api-version=2024-10-21';
  return base + '/models';
}

function authHeaders(provider) {
  const key = String(provider.apiKey || '').trim();
  const headers = { 'Content-Type': 'application/json' };
  if (provider.type === 'anthropic') {
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider.type === 'google') {
    if (key) headers['x-goog-api-key'] = key;
  } else if (provider.type === 'azure') {
    if (key) headers['api-key'] = key;
  } else if (key) {
    headers['Authorization'] = 'Bearer ' + key;
  }
  if (provider.headers && typeof provider.headers === 'object') {
    for (const [k, v] of Object.entries(provider.headers)) if (k && v) headers[k] = String(v);
  }
  return headers;
}

async function listModels(provider, fetchImpl = fetch) {
  const url = modelsEndpoint(provider);
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: authHeaders(provider),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ' — ' + text.slice(0, 240) : ''}`);
  }
  const data = await res.json();
  let ids = [];
  if (provider.type === 'google') {
    ids = (data.models || []).map((m) => String(m.name || '').replace(/^models\//, '')).filter(Boolean);
  } else if (provider.type === 'anthropic') {
    ids = (data.data || []).map((m) => m.id).filter(Boolean);
  } else {
    ids = (data.data || data.models || []).map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  }
  ids.sort((a, b) => a.localeCompare(b));
  return ids;
}

module.exports = { PRESETS, preset, makeProvider, authHeaders, listModels, modelsEndpoint };
