# 🐇 keyhopper

**Paste a pile of free LLM API keys once. Never hit a rate-limit wall again.**

keyhopper sits between your app and the AI providers. When a key gets rate-limited, it **hops** to the next key, then the next model, then the next provider (Groq → Gemini → NVIDIA → …) automatically. Your code doesn't change and your users never see a 429.

[![npm](https://img.shields.io/npm/v/keyhopper.svg)](https://www.npmjs.com/package/keyhopper)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![node](https://img.shields.io/badge/node-%3E%3D20.16-blue)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

```
your app ──► keyhopper ──► groq key 1 ──429──► groq key 2 ──429──► gemini key 1 ✓
                              resting 8s          resting 41s         answered in 1.2s
```

- 🔑 **Key rotation**: spreads requests across all of your keys.
- ⏳ **Rate-limit aware**: reads each provider's own "retry in 7.6s" hint and rests only that key for exactly that long.
- 🔀 **Provider failover**: on errors, timeouts or outages, it moves to the next provider.
- 🧠 **Models multiply quota**: each model has its own limit, so 3 models × 3 keys gives you 9 separate buckets.
- 🚫 **Dead-key detection**: invalid or out-of-credit keys are switched off automatically.
- 🌊 **Streaming**: fails over until the first token arrives.
- 📊 **Logs + live dashboard**: shows who answered, how many hops, and when each key resets.
- 🌍 **Any language**: run it as an OpenAI-compatible server and point the Python or JS OpenAI SDK at it.
- 📦 **Zero dependencies**, with TypeScript types included.

---

## Quick start (60 seconds)

```bash
npm install keyhopper
npx keyhopper init
```

`init` adds a commented **keyhopper section to the end of your existing `.env`**, or creates one. It also writes a shareable `.env.keyhopper.example` and makes sure `.env` is in `.gitignore`. It never changes anything you already have, and if you already have a key like `GROQ_API_KEY` it detects it and uses it.

This is the whole section it adds. Paste your keys and uncomment what you use:

```env
# ===================== keyhopper ===================== https://github.com/somcpp/keyhopper
# Paste your API keys, comma separated. Uncomment more providers to add them.
GROQ_API_KEYS=gsk_aaa,gsk_bbb
GEMINI_API_KEYS=AIza_aaa,AIza_bbb
# NVIDIA_API_KEYS=
# OPENROUTER_API_KEYS=

# Models to use, best first. Each model has its own rate limit, so more models = more free quota.
GROQ_MODELS=openai/gpt-oss-120b
GEMINI_MODELS=gemini-2.5-flash

# Which provider to try first. The others are used when it's rate-limited.
KEYHOPPER_PROVIDERS=groq,gemini

# KEYHOPPER_STRATEGY=round-robin   # spread load over all keys evenly (default: best first)
# KEYHOPPER_LOG=true               # print one line per request: who answered, quota left
# ================== end keyhopper ==================
```

Check that they all work:

```bash
npx keyhopper check
```
```
  ✓ groq/openai/gpt-oss-120b [gsk_…qMWQ]  694ms
  ✓ gemini/gemini-2.5-flash [AIza…7dFs]  1164ms
  ✗ nvidia/meta/llama-3.3-70b-instruct [nvap…x9Qa]  401 Invalid API Key
```

Use it:

```js
import { keyhopper } from 'keyhopper';

const ai = keyhopper();                       // reads keys from .env automatically
const answer = await ai.text('Explain black holes in one line');
```

That's all the setup there is.

---

## Usage

```js
import { keyhopper } from 'keyhopper';
const ai = keyhopper();

// simplest: prompt in, text out
await ai.text('Write a haiku about rate limits');

// system prompt + any OpenAI params
await ai.text('Summarise this…', { system: 'You are concise.', temperature: 0.2, max_tokens: 300 });

// full OpenAI-style request/response (tools, JSON mode, etc. pass straight through)
const res = await ai.chat({ messages: [{ role: 'user', content: 'Hi' }] });
res.choices[0].message.content;
res._gateway;   // → { provider: 'groq', model: 'openai/gpt-oss-120b', key: 'gsk_…qMWQ' }

// streaming
for await (const piece of ai.streamText('Tell me a story')) process.stdout.write(piece);
for await (const chunk of ai.stream({ messages })) { /* raw OpenAI chunks */ }

// pick a provider or model for one call
await ai.chat({ model: 'gemini', messages });                       // any Gemini model
await ai.chat({ model: 'groq/openai/gpt-oss-20b', messages });      // exact model
await ai.text('hi', { providers: ['groq', 'nvidia'] });             // only these

// cancel
await ai.text('long task', { signal: AbortSignal.timeout(5000) });
```

### Configure in code (instead of .env)

```js
const ai = keyhopper({
  providers: [
    { name: 'groq',   keys: ['gsk_1', 'gsk_2'], models: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'] },
    { name: 'gemini', keys: ['AIza_1', 'AIza_2'], models: ['gemini-2.5-flash', 'gemini-flash-lite-latest'] },
    { name: 'nvidia', keys: ['nvapi-1'] },
    // any OpenAI-compatible API (Ollama, LM Studio, vLLM, a company proxy…)
    { name: 'local', baseURL: 'http://localhost:11434/v1', keys: ['ollama'], models: ['llama3.2'] },
  ],
  strategy: 'priority',   // or 'round-robin'
  logs: true,             // print a line per request (see below)
  timeoutMs: 60_000,      // per attempt
  maxWaitMs: 10_000,      // if EVERY key is resting, wait this long for one to free up
});
```

| strategy | behaviour |
|---|---|
| `priority` (default) | Uses providers in the order you list them and rotates keys within each. Your best model is used first, and the rest are fallbacks. |
| `round-robin` | Spreads every request evenly over all keys and providers to get the most total throughput. |

---

## 📊 Seeing what's going on

### Logs: who answered, and when keys come back

Set `KEYHOPPER_LOG=true` in `.env`, or pass `logs: true`:

```
[keyhopper] 12:05:03 ✓ groq/openai/gpt-oss-120b gsk_…qMWQ  1280ms · 959/1000 req left, resets in 59m 2s
[keyhopper] 12:05:04 ⏳ groq/openai/gpt-oss-120b gsk_…qMWQ  rate limited → resting 8s (back at 12:05:12)
[keyhopper] 12:05:05 ✓ gemini/gemini-2.5-flash AIza…7dFs  1775ms · after 1 failover
[keyhopper] 12:05:06 ✗ nvidia/meta/llama-3.3-70b-instruct nvap…x9Qa  disabled (invalid key)
```

You can also send the lines to your own logger with `logs: (line) => myLogger.info(line)`, or get structured events with `onEvent: (e) => …`.

### Status table: every key at a glance

```js
ai.printStatus();
```
```
provider                  key        state       back in  req left                  tokens left  ok  429s  failed
────────────────────────  ─────────  ──────────  ───────  ────────────────────────  ───────────  ──  ────  ──────
groq/openai/gpt-oss-120b  gsk_…qMWQ  ◐ cooling   8s       957/1000 (reset 1h 1m)    2485/8000    32  8     8
gemini/gemini-2.5-flash   AIza…7dFs  ● ready     -        -                         -            4   0     0
nvidia/meta/llama-3.3-…   nvap…x9Qa  ○ disabled  auth     -                         -            0   0     1
```

The same data is available as objects with `ai.status()`, and the last 100 requests with `ai.history()`. "req left" and "tokens left" come from the provider's own headers. Groq, OpenAI, OpenRouter and Cerebras send them; Gemini doesn't.

### Live dashboard (server mode)

`npx keyhopper serve`, then open **http://127.0.0.1:8787/**. It shows every key's state, cooldown countdown, quota left and reset time, plus a live feed of recent requests showing which provider answered, latency and failovers. It refreshes every 2 seconds. You can also run `npx keyhopper status` in another terminal to get the same thing as a table.

---

## 🌍 Server mode: use it from Python or any language

```bash
npx keyhopper serve --port 8787
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="anything")   # or your KEYHOPPER_TOKEN
client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "hi"}])
```

| endpoint | what |
|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible, streaming supported |
| `GET /v1/models` | `auto`, provider names, `provider/model` ids |
| `GET /` | live dashboard |
| `GET /status` | keys + recent requests as JSON |

**Model routing:** `"auto"` uses your configured order, `"groq"` picks any Groq model, and `"groq/<model>"` picks that exact model. Any other value is ignored, so OpenAI SDK defaults like `gpt-4o` still work.

**Security:** the server binds to `127.0.0.1` by default. If you expose it, set `KEYHOPPER_TOKEN`. Clients then send it as their API key, and the dashboard is opened with `/?token=…`.

---

## Providers

| name | env var | free keys at | default model |
|---|---|---|---|
| groq | `GROQ_API_KEYS` | console.groq.com | openai/gpt-oss-120b ✓ |
| gemini | `GEMINI_API_KEYS` (or `GOOGLE_API_KEY`) | aistudio.google.com | gemini-2.5-flash ✓ |
| cerebras | `CEREBRAS_API_KEYS` | cloud.cerebras.ai | llama-3.3-70b |
| nvidia | `NVIDIA_API_KEYS` | build.nvidia.com | meta/llama-3.3-70b-instruct |
| openrouter | `OPENROUTER_API_KEYS` | openrouter.ai | meta-llama/llama-3.3-70b-instruct:free |
| mistral | `MISTRAL_API_KEYS` | console.mistral.ai | mistral-small-latest |
| together | `TOGETHER_API_KEYS` | together.ai | meta-llama/Llama-3.3-70B-Instruct-Turbo |
| deepseek | `DEEPSEEK_API_KEYS` | platform.deepseek.com | deepseek-chat |
| openai | `OPENAI_API_KEYS` | platform.openai.com | gpt-4o-mini |

- `_API_KEY` (singular) works too. Keys can be separated by commas, spaces or newlines.
- Providers rename models often, so set `GROQ_MODELS=…` to whatever is current. List several, best first.
- ✓ = verified working (Nov 2026). Defaults for the other providers may be out of date, so set `<NAME>_MODELS`.
- **If a model name is wrong or retired,** keyhopper prints a one-line warning telling you which `<NAME>_MODELS` to change, stops using that model, and keeps answering with your other models. `npx keyhopper check` shows it too.
- Choose who goes first with `KEYHOPPER_PROVIDERS=gemini,groq`. Providers you don't list still follow, as backups.
- **Custom provider:** add its name to `KEYHOPPER_PROVIDERS`, then set `MYLLM_BASE_URL`, `MYLLM_API_KEYS` and `MYLLM_MODELS`.

### All env vars

| var | default | |
|---|---|---|
| `<PROVIDER>_API_KEYS` | – | keys, comma separated |
| `<PROVIDER>_MODELS` | preset | models, best first |
| `<PROVIDER>_BASE_URL` | preset | for custom providers |
| `KEYHOPPER_PROVIDERS` | groq, gemini, … | providers to try first (unlisted ones still follow) |
| `KEYHOPPER_STRATEGY` | `priority` | or `round-robin` |
| `KEYHOPPER_LOG` | off | `true` prints a line per request |
| `KEYHOPPER_TOKEN` | – | server mode auth |

---

## How failover decides

| provider says | keyhopper does |
|---|---|
| `429` rate limited | rests that key+model for the time the provider asks (`retry-after`, "try again in 7.6s", Gemini `retryDelay`), or 60s doubling on repeats; tries the next |
| `401` / `403` / invalid key | disables that key for this process |
| `402` out of credits | disables that key |
| `5xx`, timeout, network error | rests the key 15s, tries the next |
| `400` / `404` / `413` (bad params, unknown model, too big) | skips that provider/model for this request only; the key isn't punished |

**Good to know:**
- Cooldowns live in memory per process. After a restart, keyhopper relearns them from the next 429.
- A stream can only fail over before its first token. If a provider dies mid-stream, you get an error.
- Different models answer differently. Pin one with `model: 'groq/…'` if you need consistent output.
- **Reasoning models** (gpt-oss, qwen3, Gemini 2.5+) "think" before answering, and the thinking counts toward `max_tokens`. A low limit can give an **empty reply**. keyhopper warns when that happens, so leave `max_tokens` out or keep it generous (1000+).
- A model that keeps erroring or hanging is rested longer each time (15s, 30s, 1m … up to 10m), so it stops slowing you down.
- Respect each provider's terms of service. Some don't allow multiple free accounts per person.

---

## CLI

```bash
npx keyhopper init            # add keyhopper section to .env (+ .gitignore, example file)
npx keyhopper check           # test every key once
npx keyhopper ask "hello"     # one question; logs which key answered
npx keyhopper serve           # OpenAI-compatible server + dashboard on :8787
npx keyhopper status          # table of a running server's keys + recent requests
```

## Development

```bash
git clone https://github.com/somcpp/keyhopper && cd keyhopper
npm test        # 21 tests against mock providers, no keys needed
```

## License

MIT
