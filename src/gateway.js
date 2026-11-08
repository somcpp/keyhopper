import { PRESETS, ENV_ALIASES } from './providers.js';
import { loadEnvFile } from './env.js';

// ---------------------------------------------------------------- helpers

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error('Aborted'));
      },
      { once: true },
    );
  });

/** Turn "a,b c\nd" / ["a", "b,c"] / undefined into a clean, de-duplicated list. */
export function toList(value) {
  const out = [];
  const walk = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) return v.forEach(walk);
    for (const part of String(v).split(/[\s,]+/)) if (part) out.push(part);
  };
  walk(value);
  return [...new Set(out)];
}

export function maskKey(key) {
  return key.length > 10 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '****';
}

/** Parse "30", "1.5s", "500ms", "2m59.56s", "1h2m", or an HTTP date into ms. */
export function parseDuration(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/g)) {
    matched = true;
    const n = parseFloat(m[1]);
    total += { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2]] * n;
  }
  if (matched) return Math.round(total);
  const date = Date.parse(s);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

/** Work out how long a provider wants us to back off, from headers or error text. */
function retryAfterFrom(headers, text) {
  const header = headers?.get?.('retry-after');
  const fromHeader = parseDuration(header);
  if (fromHeader != null) return fromHeader;
  // Gemini: "retryDelay": "30s"
  const gem = /"retryDelay"\s*:\s*"([^"]+)"/.exec(text || '');
  if (gem) return parseDuration(gem[1]);
  // Groq / OpenAI style: "Please try again in 7.66s" / "in 1h2m3s" / "in 500ms"
  const msg = /try again in\s+([\d.hms\s]+)/i.exec(text || '');
  if (msg) return parseDuration(msg[1]);
  return null;
}

export class ProviderError extends Error {
  constructor(message, { status, body, retryAfterMs } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs ?? null;
  }

  static async fromResponse(res) {
    const text = await res.text().catch(() => '');
    let message = text.slice(0, 500) || res.statusText;
    try {
      let json = JSON.parse(text);
      if (Array.isArray(json)) json = json[0];
      message = json?.error?.message ?? json?.message ?? json?.detail ?? message;
      if (typeof message !== 'string') message = JSON.stringify(message);
    } catch {}
    return new ProviderError(message, {
      status: res.status,
      body: text,
      retryAfterMs: retryAfterFrom(res.headers, text),
    });
  }

  static fromPayload(error) {
    const text = JSON.stringify(error);
    const status = Number(error?.code ?? error?.status) || 500;
    return new ProviderError(error?.message ?? text, {
      status: status >= 400 && status < 600 ? status : 500,
      body: text,
      retryAfterMs: retryAfterFrom(null, text),
    });
  }
}

export class GatewayError extends Error {
  constructor(attempts, reason) {
    const lines = attempts.map(
      (a) => `  - ${a.provider}/${a.model} [key ${a.key}]: ${a.kind}${a.status ? ` ${a.status}` : ''} — ${a.message}`,
    );
    super(`${reason}${lines.length ? `\n${lines.join('\n')}` : ''}`);
    this.name = 'GatewayError';
    this.attempts = attempts;
    const kinds = new Set(attempts.map((a) => a.kind));
    const last = attempts[attempts.length - 1];
    if (!attempts.length || (kinds.size === 1 && kinds.has('rate_limited'))) this.status = 429;
    else if (last?.kind === 'bad_request') this.status = last.status;
    else this.status = 502;
  }
}

const GATEWAY_OPTION_KEYS = ['signal', 'timeoutMs', 'maxWaitMs', 'maxAttempts', 'providers', 'system'];

// ---------------------------------------------------------------- gateway

export class Gateway {
  /**
   * @param {import('../index').GatewayConfig} config
   */
  constructor(config = {}) {
    const {
      providers,
      strategy = envValue('KEYHOPPER_STRATEGY') || 'priority',
      timeoutMs = 60_000,
      maxWaitMs = 10_000,
      maxAttempts,
      rateLimitCooldownMs = 60_000,
      errorCooldownMs = 15_000,
      onEvent,
      debug,
      logs = debug ?? isTruthy(envValue('KEYHOPPER_LOG')),
      historySize = 100,
      fetch: fetchImpl,
    } = config;

    if (!['priority', 'round-robin'].includes(strategy)) {
      throw new Error(`Unknown strategy "${strategy}" (use "priority" or "round-robin")`);
    }
    this.strategy = strategy;
    this.timeoutMs = timeoutMs;
    this.maxWaitMs = maxWaitMs;
    this.rateLimitCooldownMs = rateLimitCooldownMs;
    this.errorCooldownMs = errorCooldownMs;
    this.onEvent = onEvent;
    // logs: false | true (console) | (line: string) => void (your own logger)
    this.logger = typeof logs === 'function' ? logs : logs ? (line) => console.log(line) : null;
    this.historySize = historySize;
    this._history = [];
    this.fetch = fetchImpl ?? globalThis.fetch;
    if (!this.fetch) throw new Error('No fetch available — use Node 18+ or pass config.fetch');

    const list = providers ?? providersFromEnv();
    this.providers = list.map((p, i) => this._normalize(p, i)).filter((p) => p.keys.length);
    this.providerNames = new Set(this.providers.map((p) => p.name));

    this.groups = [];
    this.slots = [];
    for (const provider of this.providers) {
      for (const model of provider.models) {
        const group = { provider, model, cursor: 0, slots: [] };
        for (const key of provider.keys) {
          const slot = {
            provider,
            model,
            key,
            keyId: maskKey(key),
            group,
            cooldownUntil: 0,
            strikes: 0,
            ok: 0,
            failed: 0,
            rateLimited: 0,
            lastError: null,
            lastUsed: 0,
            limits: null, // from x-ratelimit-* headers, when the provider sends them
          };
          group.slots.push(slot);
          this.slots.push(slot);
        }
        this.groups.push(group);
      }
    }
    if (!this.slots.length) {
      throw new Error(
        'keyhopper: no API keys configured. Run `npx keyhopper init`, or pass `providers`, or set env vars like GROQ_API_KEYS=key1,key2',
      );
    }
    this.cursor = 0;
    this.deadKeys = new Map(); // "provider:key" -> reason
    this.maxAttempts = maxAttempts ?? this.slots.length + 3;
  }

  _normalize(p, i) {
    if (typeof p === 'string') p = { name: p };
    const name = p.name ?? p.preset ?? `provider${i + 1}`;
    const preset = PRESETS[p.preset ?? name] ?? {};
    const baseURL = (p.baseURL ?? preset.baseURL)?.replace(/\/+$/, '');
    if (!baseURL) throw new Error(`Provider "${name}" is not a built-in preset — pass a baseURL`);
    const models = toList(p.models ?? p.model ?? preset.models);
    if (!models.length) throw new Error(`Provider "${name}" needs at least one model`);
    return {
      name,
      baseURL,
      keys: toList(p.keys ?? p.key ?? p.apiKeys ?? p.apiKey),
      models,
      headers: { ...preset.headers, ...p.headers },
      body: { ...p.body },
    };
  }

  _emit(event) {
    event.time = Date.now();
    if (this.logger) {
      try {
        this.logger(formatEvent(event));
      } catch {}
    }
    try {
      this.onEvent?.(event);
    } catch {}
  }

  _remember(entry) {
    this._history.push(entry);
    if (this._history.length > this.historySize) this._history.shift();
  }

  _isDead(slot) {
    return this.deadKeys.has(`${slot.provider.name}:${slot.key}`);
  }

  /** Figure out which slots a request may use, from body.model and opts.providers. */
  _context(body, opts) {
    let only = opts.providers ? new Set(toList(opts.providers)) : null;
    let groups = null;
    let model = null;
    const m = body.model;
    if (m && m !== 'auto') {
      const slash = String(m).indexOf('/');
      const head = slash > 0 ? m.slice(0, slash) : null;
      if (this.providerNames.has(m)) {
        only = new Set([m]); // "groq" -> any groq model
      } else if (head && this.providerNames.has(head)) {
        // "groq/some-model" -> groq keys, that exact model
        only = new Set([head]);
        model = m.slice(slash + 1);
        const configured = this.groups.filter((g) => g.provider.name === head && g.model === model);
        groups = new Set(configured.length ? configured : [this.groups.find((g) => g.provider.name === head)]);
      } else {
        // a model name that's in the config -> just those groups; anything else is ignored
        const matching = this.groups.filter((g) => g.model === m);
        if (matching.length) groups = new Set(matching);
      }
    }
    const skipGroups = new Set();
    const allowed = (s) =>
      (!only || only.has(s.provider.name)) && (!groups || groups.has(s.group)) && !skipGroups.has(s.group);
    return { tried: new Set(), skipGroups, allowed, model };
  }

  _pick(ctx) {
    const now = Date.now();
    const usable = (s) => !ctx.tried.has(s) && ctx.allowed(s) && !this._isDead(s) && s.cooldownUntil <= now;
    const scan = (list, holder) => {
      const n = list.length;
      for (let i = 0; i < n; i++) {
        const idx = (holder.cursor + i) % n;
        if (usable(list[idx])) {
          holder.cursor = (idx + 1) % n;
          return list[idx];
        }
      }
      return null;
    };
    if (this.strategy === 'round-robin') return scan(this.slots, this);
    // priority: walk providers/models in config order, rotating keys within each
    for (const g of this.groups) {
      const s = scan(g.slots, g);
      if (s) return s;
    }
    return null;
  }

  /** Earliest moment some currently-unusable slot frees up, or null if none ever will. */
  _nextWake(ctx) {
    let earliest = null;
    for (const s of this.slots) {
      if (!ctx.allowed(s) || this._isDead(s)) continue;
      if (earliest == null || s.cooldownUntil < earliest) earliest = s.cooldownUntil;
    }
    return earliest;
  }

  _recordSuccess(slot, ms, failovers) {
    slot.ok++;
    slot.strikes = 0;
    slot.lastError = null;
    slot.lastUsed = Date.now();
    const info = { provider: slot.provider.name, model: slot.model, key: slot.keyId };
    this._remember({ time: Date.now(), ok: true, ...info, ms, failovers });
    this._emit({ type: 'success', ...info, ms, failovers, limits: slot.limits });
  }

  _recordFailure(slot, err, ctx) {
    const status = err?.status;
    const text = `${err?.message ?? ''} ${err?.body ?? ''}`;
    const base = { provider: slot.provider.name, model: slot.model, key: slot.keyId, status, message: err?.message };
    slot.failed++;
    slot.lastUsed = Date.now();
    slot.lastError = `${status ?? err?.name ?? 'error'}: ${err?.message ?? err}`.slice(0, 300);

    let kind;
    if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|invalid api key|pass a valid API key|API key expired/i.test(text)) {
      kind = 'auth';
    } else if (status === 402) {
      kind = 'no_credits';
    } else if (status === 429) {
      kind = 'rate_limited';
    } else if (!status || status === 408 || status >= 500) {
      kind = 'server';
    } else {
      kind = 'bad_request';
    }

    if (kind === 'auth' || kind === 'no_credits') {
      this.deadKeys.set(`${slot.provider.name}:${slot.key}`, kind);
      this._emit({ type: 'key_disabled', reason: kind, ...base });
    } else if (kind === 'rate_limited') {
      slot.rateLimited++;
      const backoff = Math.min(this.rateLimitCooldownMs * 2 ** slot.strikes, 3_600_000);
      const cooldownMs = err.retryAfterMs != null ? Math.max(err.retryAfterMs, 1000) : backoff;
      slot.strikes++;
      slot.cooldownUntil = Date.now() + cooldownMs;
      this._emit({ type: 'rate_limited', cooldownMs, ...base });
    } else if (kind === 'server') {
      slot.cooldownUntil = Date.now() + this.errorCooldownMs;
      this._emit({ type: 'error', cooldownMs: this.errorCooldownMs, ...base });
    } else {
      // The request itself didn't suit this provider/model (bad params, unknown model,
      // too large for its limits…). Don't punish the key; just try elsewhere.
      ctx.skipGroups.add(slot.group);
      this._emit({ type: 'rejected', ...base });
    }
    return { ...base, kind, message: err?.message ?? String(err) };
  }

  /** Core loop: pick a slot, run `exec`, fail over on errors until something works. */
  async _run(body, opts, exec) {
    const ctx = this._context(body, opts);
    const attempts = [];
    const maxAttempts = opts.maxAttempts ?? this.maxAttempts;
    const maxWaitMs = opts.maxWaitMs ?? this.maxWaitMs;
    let waits = 0;

    while (attempts.length < maxAttempts) {
      const slot = this._pick(ctx);
      if (!slot) {
        const wake = this._nextWake(ctx);
        if (wake == null) break;
        const waitMs = Math.max(0, wake - Date.now());
        if (waitMs > maxWaitMs || waits >= 3) {
          throw this._giveUp(
            attempts,
            `All keys are rate-limited or failing (next one frees up in ${formatMs(waitMs)})`,
          );
        }
        waits++;
        this._emit({ type: 'waiting', waitMs });
        await sleep(waitMs + 10, opts.signal);
        ctx.tried.clear();
        continue;
      }

      ctx.tried.add(slot);
      const { model: _ignored, ...rest } = body;
      const reqBody = { ...slot.provider.body, ...rest, model: ctx.model ?? slot.model };
      const started = Date.now();
      try {
        const result = await exec(slot, reqBody);
        this._recordSuccess(slot, Date.now() - started, attempts.length);
        return { result, slot, model: reqBody.model };
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        attempts.push(this._recordFailure(slot, err, ctx));
      }
    }
    throw this._giveUp(attempts, attempts.length ? 'Every provider failed for this request' : 'No usable keys left');
  }

  _giveUp(attempts, reason) {
    const err = new GatewayError(attempts, reason);
    this._remember({ time: Date.now(), ok: false, failovers: attempts.length, error: reason });
    this._emit({ type: 'failed', status: err.status, message: reason });
    return err;
  }

  /** POST to a slot. Returns the open response plus timer controls. */
  async _post(slot, body, opts) {
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    let timer;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const e = new Error(`Timed out after ${timeoutMs}ms`);
        e.name = 'TimeoutError';
        controller.abort(e);
      }, timeoutMs);
    };
    const onAbort = () => controller.abort(opts.signal.reason);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    touch();
    try {
      const res = await this.fetch(`${slot.provider.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${slot.key}`,
          ...slot.provider.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const limits = readLimits(res.headers);
      if (limits) slot.limits = limits;
      if (!res.ok) throw await ProviderError.fromResponse(res);
      return { res, touch, done };
    } catch (err) {
      done();
      throw err;
    }
  }

  async _chatOnce(slot, body, opts) {
    const { res, done } = await this._post(slot, body, opts);
    try {
      const json = await res.json();
      if (json?.error) throw ProviderError.fromPayload(json.error);
      if (!json?.choices) throw new ProviderError('Provider returned no choices', { status: 502 });
      return json;
    } finally {
      done();
    }
  }

  // ------------------------------------------------------------ public API

  /** OpenAI-style chat completion with automatic key/provider failover. */
  async chat(body, opts = {}) {
    const { result, slot, model } = await this._run({ ...body, stream: false }, opts, (s, b) =>
      this._chatOnce(s, b, opts),
    );
    result._gateway = { provider: slot.provider.name, model, key: slot.keyId };
    return result;
  }

  /** Streams OpenAI-style chunks. Fails over only until the first chunk arrives. */
  async *stream(body, opts = {}) {
    const { result, slot, model } = await this._run({ ...body, stream: true }, opts, async (s, b) => {
      const { res, touch, done } = await this._post(s, b, opts);
      const it = parseSSE(res.body);
      try {
        const first = await it.next();
        if (first.done) throw new ProviderError('Provider returned an empty stream', { status: 502 });
        if (first.value?.error) throw ProviderError.fromPayload(first.value.error);
        return { first: first.value, it, touch, done };
      } catch (err) {
        done();
        await it.return?.();
        throw err;
      }
    });
    const { first, it, touch, done } = result;
    const meta = { provider: slot.provider.name, model, key: slot.keyId };
    try {
      first._gateway = meta;
      yield first;
      touch();
      for await (const chunk of it) {
        touch();
        if (chunk?.error) throw ProviderError.fromPayload(chunk.error);
        chunk._gateway = meta;
        yield chunk;
      }
    } finally {
      done();
      await it.return?.();
    }
  }

  /** Simplest form: give a prompt (or messages), get the reply text back. */
  async text(input, options = {}) {
    const { body, opts } = splitOptions(input, options);
    const res = await this.chat(body, opts);
    return res.choices?.[0]?.message?.content ?? '';
  }

  /** Like text() but yields pieces of the reply as they stream in. */
  async *streamText(input, options = {}) {
    const { body, opts } = splitOptions(input, options);
    for await (const chunk of this.stream(body, opts)) {
      const piece = chunk.choices?.[0]?.delta?.content;
      if (piece) yield piece;
    }
  }

  /** Snapshot of every key/model slot — safe to log (keys are masked). */
  status() {
    const now = Date.now();
    return this.slots.map((s) => {
      const dead = this.deadKeys.get(`${s.provider.name}:${s.key}`);
      const cooling = !dead && s.cooldownUntil > now;
      const l = s.limits;
      // Provider-reported quota is a snapshot from the last response; once its window has
      // reset, the quota is back to the full limit.
      const left = (value, limit, resetAt) => (resetAt != null && resetAt <= now && limit != null ? limit : value);
      return {
        provider: s.provider.name,
        model: s.model,
        key: s.keyId,
        state: dead ? 'disabled' : cooling ? 'cooling' : 'ready',
        disabledReason: dead ?? null,
        cooldownMs: cooling ? s.cooldownUntil - now : 0,
        resetsAt: cooling ? new Date(s.cooldownUntil).toISOString() : null,
        requestsLeft: l ? left(l.requestsLeft, l.requestsLimit, l.requestsResetAt) : null,
        requestsLimit: l?.requestsLimit ?? null,
        requestsResetMs: l?.requestsResetAt && l.requestsResetAt > now ? l.requestsResetAt - now : null,
        tokensLeft: l ? left(l.tokensLeft, l.tokensLimit, l.tokensResetAt) : null,
        tokensLimit: l?.tokensLimit ?? null,
        tokensResetMs: l?.tokensResetAt && l.tokensResetAt > now ? l.tokensResetAt - now : null,
        ok: s.ok,
        failed: s.failed,
        rateLimited: s.rateLimited,
        lastUsed: s.lastUsed ? new Date(s.lastUsed).toISOString() : null,
        lastError: s.lastError,
      };
    });
  }

  /** The most recent requests: who handled each one, how long it took, how many failovers. */
  history(limit = this.historySize) {
    return this._history.slice(-limit).map((h) => ({ ...h, time: new Date(h.time).toISOString() }));
  }

  /** Print a readable table of every key: state, reset times, quota left, counts. */
  printStatus(log = console.log) {
    log(formatStatusTable(this.status()));
  }

  /** Models this gateway can route to, as "provider/model" ids. */
  models() {
    return this.groups.map((g) => `${g.provider.name}/${g.model}`);
  }

  /** Sends one tiny request through every key+model to verify they work. Uses a little quota. */
  async check({ timeoutMs = 20_000 } = {}) {
    const results = [];
    for (const slot of this.slots) {
      const started = Date.now();
      try {
        await this._chatOnce(
          slot,
          { model: slot.model, messages: [{ role: 'user', content: 'Reply with: ok' }], max_tokens: 5 },
          { timeoutMs },
        );
        results.push({ provider: slot.provider.name, model: slot.model, key: slot.keyId, ok: true, ms: Date.now() - started });
      } catch (err) {
        results.push({
          provider: slot.provider.name,
          model: slot.model,
          key: slot.keyId,
          ok: false,
          status: err.status,
          error: err.message,
        });
      }
    }
    return results;
  }
}

function splitOptions(input, options) {
  const opts = {};
  const params = {};
  for (const [k, v] of Object.entries(options)) (GATEWAY_OPTION_KEYS.includes(k) ? opts : params)[k] = v;
  let messages;
  if (typeof input === 'string') {
    messages = [...(opts.system ? [{ role: 'system', content: opts.system }] : []), { role: 'user', content: input }];
  } else if (Array.isArray(input)) {
    messages = input;
  } else {
    return { body: { ...input, ...params }, opts };
  }
  return { body: { ...params, messages }, opts };
}

async function* parseSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        if (!data) continue;
        try {
          yield JSON.parse(data);
        } catch {
          // ignore keep-alive / non-JSON lines
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ---------------------------------------------------------------- env config

/**
 * Build provider config from env vars:
 *   GROQ_API_KEYS=key1,key2      (or GROQ_API_KEY)
 *   GROQ_MODELS=llama-3.3-70b-versatile,llama-3.1-8b-instant
 *   KEYHOPPER_PROVIDERS=groq,gemini,myllm   (optional order; custom ones need MYLLM_BASE_URL)
 */
export function providersFromEnv(env = globalThis.process?.env ?? {}) {
  const order = env.KEYHOPPER_PROVIDERS ? toList(env.KEYHOPPER_PROVIDERS) : Object.keys(PRESETS);
  const out = [];
  for (const name of order) {
    const P = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const keys = toList([
      env[`${P}_API_KEYS`],
      env[`${P}_API_KEY`],
      env[`${P}_KEYS`],
      ...(ENV_ALIASES[name] ?? []).map((k) => env[k]),
    ]);
    if (!keys.length) continue;
    const models = toList([env[`${P}_MODELS`], env[`${P}_MODEL`]]);
    out.push({
      name,
      keys,
      models: models.length ? models : undefined,
      baseURL: env[`${P}_BASE_URL`] || undefined,
    });
  }
  return out;
}

/**
 * Create a gateway. With no `providers`, keys are read from the environment,
 * auto-loading .env.local / .env from the current folder if present
 * (variables that are already set are never overwritten).
 */
export function createGateway(config = {}) {
  if (!config.providers && config.loadEnv !== false) {
    loadEnvFile('.env.local');
    loadEnvFile('.env');
  }
  return new Gateway(config);
}

// ---------------------------------------------------------------- logging helpers

function envValue(name) {
  return globalThis.process?.env?.[name];
}

function isTruthy(v) {
  return v != null && /^(1|true|yes|on)$/i.test(String(v).trim());
}

/** Read x-ratelimit-* headers (Groq, OpenAI, OpenRouter, Cerebras…). */
function readLimits(headers) {
  if (!headers?.get) return null;
  const num = (name) => {
    const v = headers.get(name);
    return v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
  };
  const at = (name) => {
    const ms = parseDuration(headers.get(name));
    return ms == null ? null : Date.now() + ms;
  };
  const l = {
    requestsLimit: num('x-ratelimit-limit-requests') ?? num('x-ratelimit-limit-requests-day') ?? num('x-ratelimit-limit'),
    requestsLeft:
      num('x-ratelimit-remaining-requests') ?? num('x-ratelimit-remaining-requests-day') ?? num('x-ratelimit-remaining'),
    requestsResetAt: at('x-ratelimit-reset-requests') ?? at('x-ratelimit-reset-requests-day'),
    tokensLimit: num('x-ratelimit-limit-tokens') ?? num('x-ratelimit-limit-tokens-minute'),
    tokensLeft: num('x-ratelimit-remaining-tokens') ?? num('x-ratelimit-remaining-tokens-minute'),
    tokensResetAt: at('x-ratelimit-reset-tokens') ?? at('x-ratelimit-reset-tokens-minute'),
  };
  return Object.values(l).some((v) => v != null) ? l : null;
}

export function formatMs(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

const clock = (t) => new Date(t).toTimeString().slice(0, 8);

function formatEvent(e) {
  const who = e.provider ? `${e.provider}/${e.model} ${e.key}` : '';
  const head = `[keyhopper] ${clock(e.time)}`;
  switch (e.type) {
    case 'success': {
      const parts = [`${e.ms}ms`];
      if (e.failovers) parts.push(`after ${e.failovers} failover${e.failovers > 1 ? 's' : ''}`);
      const l = e.limits;
      if (l?.requestsLeft != null) {
        const reset = l.requestsResetAt ? `, resets in ${formatMs(l.requestsResetAt - Date.now())}` : '';
        parts.push(`${l.requestsLeft}${l.requestsLimit != null ? `/${l.requestsLimit}` : ''} req left${reset}`);
      }
      return `${head} ✓ ${who}  ${parts.join(' · ')}`;
    }
    case 'rate_limited':
      return `${head} ⏳ ${who}  rate limited → resting ${formatMs(e.cooldownMs)} (back at ${clock(e.time + e.cooldownMs)})`;
    case 'error':
      return `${head} ⚠ ${who}  ${e.status ?? 'network'} ${short(e.message)} → resting ${formatMs(e.cooldownMs)}`;
    case 'rejected':
      return `${head} ↷ ${who}  ${e.status} ${short(e.message)} → trying another provider`;
    case 'key_disabled':
      return `${head} ✗ ${who}  disabled (${e.reason === 'no_credits' ? 'out of credits' : 'invalid key'})`;
    case 'waiting':
      return `${head} … every key is busy, waiting ${formatMs(e.waitMs)} for one to reset`;
    case 'failed':
      return `${head} ✗ request failed: ${short(e.message, 160)}`;
    default:
      return `${head} ${e.type} ${who}`;
  }
}

const short = (s, n = 90) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function formatStatusTable(rows) {
  const icon = { ready: '● ready', cooling: '◐ cooling', disabled: '○ disabled' };
  const data = rows.map((r) => ({
    provider: `${r.provider}/${r.model}`,
    key: r.key,
    state: icon[r.state] ?? r.state,
    'back in': r.state === 'cooling' ? formatMs(r.cooldownMs) : r.state === 'disabled' ? r.disabledReason : '-',
    'req left':
      r.requestsLeft != null
        ? `${r.requestsLeft}${r.requestsLimit != null ? `/${r.requestsLimit}` : ''}${r.requestsResetMs ? ` (reset ${formatMs(r.requestsResetMs)})` : ''}`
        : '-',
    'tokens left': r.tokensLeft != null ? `${r.tokensLeft}${r.tokensLimit != null ? `/${r.tokensLimit}` : ''}` : '-',
    ok: String(r.ok),
    '429s': String(r.rateLimited),
    failed: String(r.failed),
  }));
  if (!data.length) return '(no keys)';
  const cols = Object.keys(data[0]);
  const width = cols.map((c) => Math.max(c.length, ...data.map((d) => d[c].length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(width[i])).join('  ');
  return [line(cols), line(width.map((w) => '─'.repeat(w))), ...data.map((d) => line(cols.map((c) => d[c])))].join('\n');
}
