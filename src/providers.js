// Built-in presets. Every one of these exposes an OpenAI-compatible
// /chat/completions endpoint, so a single client works for all of them.
// Default models: groq and gemini were verified working in Nov 2026. Providers rename
// models often — override with <PROVIDER>_MODELS env vars or `models` in config.
// Object order = default provider order.
export const PRESETS = {
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    models: ['openai/gpt-oss-120b'],
  },
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash'],
  },
  cerebras: {
    baseURL: 'https://api.cerebras.ai/v1',
    models: ['llama-3.3-70b'],
  },
  nvidia: {
    baseURL: 'https://integrate.api.nvidia.com/v1',
    models: ['meta/llama-3.3-70b-instruct'],
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    models: ['meta-llama/llama-3.3-70b-instruct:free'],
  },
  mistral: {
    baseURL: 'https://api.mistral.ai/v1',
    models: ['mistral-small-latest'],
  },
  together: {
    baseURL: 'https://api.together.xyz/v1',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
  },
  deepseek: {
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat'],
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini'],
  },
};

// Extra env var names people commonly already have set.
export const ENV_ALIASES = {
  gemini: ['GOOGLE_API_KEY'],
};
