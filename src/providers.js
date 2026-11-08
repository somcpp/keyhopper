// Built-in presets. Every one of these exposes an OpenAI-compatible
// /chat/completions endpoint, so a single client works for all of them.
// Default models are just sensible starting points — override them in config
// or with <PROVIDER>_MODELS env vars, since providers rename models often.
export const PRESETS = {
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile'],
  },
  cerebras: {
    baseURL: 'https://api.cerebras.ai/v1',
    models: ['llama-3.3-70b'],
  },
  gemini: {
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash'],
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
