import type { Server } from 'node:http';

export type PresetName =
  | 'groq'
  | 'cerebras'
  | 'gemini'
  | 'nvidia'
  | 'openrouter'
  | 'mistral'
  | 'together'
  | 'deepseek'
  | 'openai';

export interface ProviderConfig {
  /** Preset name ("groq", "gemini", …) or any label for a custom provider. */
  name?: PresetName | (string & {});
  /** Use a preset's URL/models under a different name. */
  preset?: PresetName;
  /** API keys — array, or a comma/newline separated string. */
  keys?: string[] | string;
  key?: string;
  /** Models to use, in order of preference. Each model gets its own rate-limit tracking. */
  models?: string[] | string;
  model?: string;
  /** Needed for custom providers: any OpenAI-compatible base URL (…/v1). */
  baseURL?: string;
  /** Extra headers on every request to this provider. */
  headers?: Record<string, string>;
  /** Default body params for this provider (request params override them). */
  body?: Record<string, unknown>;
}

export interface GatewayEvent {
  type: 'success' | 'rate_limited' | 'error' | 'rejected' | 'key_disabled' | 'waiting' | 'failed' | 'warning';
  /** Epoch ms when the event happened. */
  time: number;
  /** For 'success': how many keys failed before this one answered. */
  failovers?: number;
  /** For 'success': quota the provider reported (Groq/OpenAI-style headers). */
  limits?: { requestsLeft: number | null; requestsLimit: number | null; requestsResetAt: number | null; tokensLeft: number | null; tokensLimit: number | null; tokensResetAt: number | null } | null;
  provider?: string;
  model?: string;
  /** Masked key, e.g. "gsk_…a1b2". */
  key?: string;
  status?: number;
  message?: string;
  cooldownMs?: number;
  waitMs?: number;
  ms?: number;
  reason?: 'auth' | 'no_credits';
}

export interface GatewayConfig {
  /** Providers in priority order. If omitted, read from env vars (GROQ_API_KEYS, GEMINI_API_KEYS, …), auto-loading .env / .env.local. */
  providers?: Array<ProviderConfig | PresetName>;
  /** Skip auto-loading .env / .env.local when providers come from env. Default true. */
  loadEnv?: boolean;
  /** "priority" (default, or KEYHOPPER_STRATEGY): use the first provider until it's limited. "round-robin": spread over everything. */
  strategy?: 'priority' | 'round-robin';
  /** Per-attempt timeout (and idle timeout while streaming). Default 60000. */
  timeoutMs?: number;
  /** If every key is cooling down, wait at most this long for one to free up. Default 10000. */
  maxWaitMs?: number;
  /** Max attempts per request. Default: number of key×model slots + 3. */
  maxAttempts?: number;
  /** Cooldown after a 429 when the provider doesn't say how long. Doubles on repeats. Default 60000. */
  rateLimitCooldownMs?: number;
  /** Cooldown after a 5xx / network error / timeout. Default 15000. */
  errorCooldownMs?: number;
  onEvent?: (event: GatewayEvent) => void;
  /** One log line per event (who answered, failovers, cooldowns, reset times). true = console, or pass your own logger. Default: KEYHOPPER_LOG env. */
  logs?: boolean | ((line: string) => void);
  /** Print config problems (wrong model name, empty replies) once to the console. Default true. */
  warnings?: boolean;
  /** @deprecated use logs */
  debug?: boolean;
  /** How many recent requests history() keeps. Default 100. */
  historySize?: number;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxWaitMs?: number;
  maxAttempts?: number;
  /** Only use these providers for this request. */
  providers?: string[] | string;
}

export interface TextOptions extends RequestOptions {
  system?: string;
  temperature?: number;
  max_tokens?: number;
  [param: string]: unknown;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | (string & {});
  content: any;
  [key: string]: unknown;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /**
   * Optional routing: omit or "auto" = use config order; "groq" = only Groq;
   * "groq/llama-3.1-8b-instant" = that provider + model; a configured model name = that model.
   * Anything else is ignored.
   */
  model?: string;
  [param: string]: unknown;
}

export interface GatewayMeta {
  provider: string;
  model: string;
  key: string;
}

export interface ChatResponse {
  id?: string;
  choices: Array<{ index: number; message: { role: string; content: string | null; [k: string]: unknown }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  _gateway: GatewayMeta;
  [key: string]: unknown;
}

export interface ChatChunk {
  choices: Array<{ index: number; delta: { content?: string | null; [k: string]: unknown }; finish_reason?: string | null }>;
  _gateway: GatewayMeta;
  [key: string]: unknown;
}

export interface SlotStatus {
  provider: string;
  model: string;
  key: string;
  state: 'ready' | 'cooling' | 'disabled';
  disabledReason: 'auth' | 'no_credits' | 'model_not_found' | null;
  cooldownMs: number;
  /** ISO time a cooling key becomes usable again. */
  resetsAt: string | null;
  /** Provider-reported quota from the last response (Groq, OpenAI, OpenRouter, Cerebras send these; Gemini doesn't). */
  requestsLeft: number | null;
  requestsLimit: number | null;
  requestsResetMs: number | null;
  tokensLeft: number | null;
  tokensLimit: number | null;
  tokensResetMs: number | null;
  lastUsed: string | null;
  ok: number;
  failed: number;
  rateLimited: number;
  lastError: string | null;
}

export declare class Gateway {
  constructor(config?: GatewayConfig);
  readonly strategy: 'priority' | 'round-robin';
  readonly providers: Array<{ name: string; baseURL: string; keys: string[]; models: string[] }>;
  chat(body: ChatRequest, opts?: RequestOptions): Promise<ChatResponse>;
  stream(body: ChatRequest, opts?: RequestOptions): AsyncGenerator<ChatChunk>;
  text(input: string | ChatMessage[] | ChatRequest, options?: TextOptions): Promise<string>;
  streamText(input: string | ChatMessage[] | ChatRequest, options?: TextOptions): AsyncGenerator<string>;
  status(): SlotStatus[];
  /** Recent requests, oldest first: who answered, latency, failovers. */
  history(limit?: number): HistoryEntry[];
  /** Print a readable table of every key (state, back-in time, quota left, counts). */
  printStatus(log?: (text: string) => void): void;
  models(): string[];
  check(opts?: { timeoutMs?: number }): Promise<Array<{ provider: string; model: string; key: string; ok: boolean; ms?: number; status?: number; error?: string }>>;
}

export interface HistoryEntry {
  time: string;
  ok: boolean;
  provider?: string;
  model?: string;
  key?: string;
  ms?: number;
  failovers: number;
  error?: string;
}

export { Gateway as Keyhopper, createGateway as keyhopper };

export declare class GatewayError extends Error {
  status: number;
  attempts: Array<{ provider: string; model: string; key: string; kind: string; status?: number; message: string }>;
}

export declare class ProviderError extends Error {
  status?: number;
  body?: string;
  retryAfterMs: number | null;
}

export declare function createGateway(config?: GatewayConfig): Gateway;
export declare function providersFromEnv(env?: Record<string, string | undefined>): ProviderConfig[];
export declare function parseDuration(value: string | null | undefined): number | null;
export declare function createServer(gateway: Gateway, opts?: { token?: string }): Server;
export declare function formatMs(ms: number | null | undefined): string;
export declare function formatStatusTable(rows: SlotStatus[]): string;
export declare function parseEnv(text: string): Record<string, string>;
export declare function loadEnvFile(path?: string, env?: Record<string, string | undefined>): boolean;
export declare const PRESETS: Record<PresetName, { baseURL: string; models: string[] }>;
