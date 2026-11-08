import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway, createServer, parseDuration, providersFromEnv, GatewayError } from '../src/index.js';

// A fake OpenAI-compatible provider. The API key decides what it does:
//   ok-*   -> 200      429-*  -> rate limit      401-*  -> bad key
//   500-*  -> server error     400-*  -> bad request
const hits = [];
let mock;
let base;

before(async () => {
  mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const key = (req.headers.authorization ?? '').replace('Bearer ', '');
      const body = JSON.parse(raw || '{}');
      const provider = req.url.split('/')[1];
      hits.push({ provider, key, model: body.model });
      const fail = (status, payload, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };
      if (key.startsWith('429')) return fail(429, { error: { message: 'Rate limit reached. Please try again in 7.5s' } });
      if (key.startsWith('401')) return fail(401, { error: { message: 'Invalid API Key' } });
      if (key.startsWith('500')) return fail(500, { error: { message: 'boom' } });
      if (key.startsWith('400')) return fail(400, { error: { message: 'unsupported param' } });
      if (key.startsWith('404m')) return fail(404, { error: { message: `The model '${body.model}' does not exist or you do not have access to it.` } });
      if (key.startsWith('empty')) return fail(200, { choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }] });
      const content = `hi from ${provider}:${key}:${body.model}`;
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const word of content.split(':')) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: word + '|' } }] })}\n\n`);
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      res.setHeader('x-ratelimit-limit-requests', '30');
      res.setHeader('x-ratelimit-remaining-requests', '29');
      res.setHeader('x-ratelimit-reset-requests', '2m0s');
      fail(200, { id: 'x', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${mock.address().port}`;
});

after(() => mock.close());

const provider = (name, keys, models = ['m1']) => ({ name, baseURL: `${base}/${name}/v1`, keys, models });
const msg = { messages: [{ role: 'user', content: 'hello' }] };

test('rate-limited key is skipped and put on cooldown using the provider hint', async () => {
  const gw = createGateway({ providers: [provider('a', ['429-one-xxxxxx', 'ok-two-xxxxxxx'])] });
  const res = await gw.chat(msg);
  assert.equal(res.choices[0].message.content, 'hi from a:ok-two-xxxxxxx:m1');
  assert.equal(res._gateway.provider, 'a');
  const limited = gw.status().find((s) => s.key.startsWith('429-'));
  assert.equal(limited.state, 'cooling');
  assert.ok(limited.cooldownMs > 6000 && limited.cooldownMs <= 7500, `cooldown was ${limited.cooldownMs}`);

  // next call must not touch the cooling key
  hits.length = 0;
  await gw.chat(msg);
  assert.deepEqual(hits.map((h) => h.key), ['ok-two-xxxxxxx']);
});

test('fails over to the next provider on 5xx and disables bad keys', async () => {
  const events = [];
  const gw = createGateway({
    providers: [provider('a', ['401-bad-xxxxxx', '500-down-xxxxx']), provider('b', ['ok-b-xxxxxxxxx'])],
    onEvent: (e) => events.push(e.type),
  });
  const text = await gw.text('hello');
  assert.equal(text, 'hi from b:ok-b-xxxxxxxxx:m1');
  assert.ok(events.includes('key_disabled'));
  assert.ok(events.includes('error'));
  const bad = gw.status().find((s) => s.key.startsWith('401-'));
  assert.equal(bad.state, 'disabled');
});

test('multiple models per provider each get their own slot', async () => {
  const gw = createGateway({ providers: [provider('a', ['429-x-xxxxxxxx'], ['big']), provider('a2', ['ok-x-xxxxxxxx'], ['small'])] });
  assert.equal(await gw.text('hi'), 'hi from a2:ok-x-xxxxxxxx:small');
  const gw2 = createGateway({ providers: [provider('g', ['ok-k-xxxxxxxx'], ['big', 'small'])] });
  assert.deepEqual(gw2.models(), ['g/big', 'g/small']);
  assert.equal(gw2.status().length, 2);
});

test('bad request skips that provider without punishing the key', async () => {
  const gw = createGateway({ providers: [provider('a', ['400-x-xxxxxxxx']), provider('b', ['ok-y-xxxxxxxx'])] });
  assert.equal(await gw.text('hi'), 'hi from b:ok-y-xxxxxxxx:m1');
  assert.equal(gw.status()[0].state, 'ready');
});

test('throws GatewayError with status 429 when everything is rate-limited', async () => {
  const gw = createGateway({ providers: [provider('a', ['429-a-xxxxxxxx', '429-b-xxxxxxxx'])], maxWaitMs: 0 });
  await assert.rejects(gw.chat(msg), (err) => {
    assert.ok(err instanceof GatewayError);
    assert.equal(err.status, 429);
    assert.equal(err.attempts.length, 2);
    return true;
  });
});

test('round-robin spreads requests across keys', async () => {
  const gw = createGateway({
    strategy: 'round-robin',
    providers: [provider('a', ['ok-1-xxxxxxxx', 'ok-2-xxxxxxxx']), provider('b', ['ok-3-xxxxxxxx'])],
  });
  hits.length = 0;
  for (let i = 0; i < 3; i++) await gw.chat(msg);
  assert.deepEqual(hits.map((h) => h.key), ['ok-1-xxxxxxxx', 'ok-2-xxxxxxxx', 'ok-3-xxxxxxxx']);
});

test('priority mode rotates keys within the first provider', async () => {
  const gw = createGateway({ providers: [provider('a', ['ok-1-xxxxxxxx', 'ok-2-xxxxxxxx']), provider('b', ['ok-3-xxxxxxxx'])] });
  hits.length = 0;
  for (let i = 0; i < 3; i++) await gw.chat(msg);
  assert.deepEqual(hits.map((h) => h.key), ['ok-1-xxxxxxxx', 'ok-2-xxxxxxxx', 'ok-1-xxxxxxxx']);
});

test('model routing: "provider" and "provider/model"', async () => {
  const gw = createGateway({ providers: [provider('a', ['ok-1-xxxxxxxx']), provider('b', ['ok-2-xxxxxxxx'])] });
  assert.equal((await gw.chat({ ...msg, model: 'b' }))._gateway.provider, 'b');
  const r = await gw.chat({ ...msg, model: 'b/custom-model' });
  assert.equal(r.choices[0].message.content, 'hi from b:ok-2-xxxxxxxx:custom-model');
  assert.equal((await gw.chat({ ...msg, model: 'gpt-4o' }))._gateway.provider, 'a'); // unknown -> ignored
});

test('streaming fails over before the first chunk', async () => {
  const gw = createGateway({ providers: [provider('a', ['429-s-xxxxxxxx']), provider('b', ['ok-s-xxxxxxxx'])] });
  let out = '';
  for await (const piece of gw.streamText('hi')) out += piece;
  assert.equal(out, 'hi from b|ok-s-xxxxxxxx|m1|');
});

test('timeouts count as errors and fail over', async () => {
  const slow = http.createServer(() => {}); // never responds
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  try {
    const gw = createGateway({
      timeoutMs: 200,
      providers: [
        { name: 'slow', baseURL: `http://127.0.0.1:${slow.address().port}/v1`, keys: ['ok-z-xxxxxxxx'], models: ['m'] },
        provider('b', ['ok-q-xxxxxxxx']),
      ],
    });
    assert.equal(await gw.text('hi'), 'hi from b:ok-q-xxxxxxxx:m1');
    assert.equal(gw.status()[0].state, 'cooling');
  } finally {
    slow.closeAllConnections();
    slow.close();
  }
});

test('OpenAI-compatible server: json, stream, auth, and errors', async () => {
  const gw = createGateway({ providers: [provider('a', ['429-v-xxxxxxxx', 'ok-v-xxxxxxxx'])], maxWaitMs: 0 });
  const server = createServer(gw, { token: 'secret' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'content-type': 'application/json', authorization: 'Bearer secret' };
  try {
    const unauth = await fetch(`${url}/v1/models`);
    assert.equal(unauth.status, 401);

    const r = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: 'auto', ...msg }) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).choices[0].message.content, 'hi from a:ok-v-xxxxxxxx:m1');

    const s = await fetch(`${url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ ...msg, stream: true }) });
    const sse = await s.text();
    assert.match(sse, /data: \[DONE\]/);
    assert.match(sse, /ok-v-xxxxxxxx/);

    const gwDead = createGateway({ providers: [provider('a', ['429-only-xxxxx'])], maxWaitMs: 0 });
    const server2 = createServer(gwDead);
    await new Promise((res2) => server2.listen(0, '127.0.0.1', res2));
    const e = await fetch(`http://127.0.0.1:${server2.address().port}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ ...msg, stream: true }),
    });
    assert.equal(e.status, 429);
    server2.close();
  } finally {
    server.close();
  }
});

test('parseDuration handles provider formats', () => {
  assert.equal(parseDuration('30'), 30000);
  assert.equal(parseDuration('7.5s'), 7500);
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('2m59.5s'), 179500);
  assert.equal(parseDuration('1h2m'), 3720000);
  assert.equal(parseDuration(''), null);
});

test('providersFromEnv reads comma-separated keys and custom providers', () => {
  const list = providersFromEnv({
    GROQ_API_KEYS: 'g1, g2\ng3',
    GEMINI_API_KEY: 'gem1',
    NVIDIA_API_KEYS: '',
  });
  assert.deepEqual(list.map((p) => [p.name, p.keys]), [['groq', ['g1', 'g2', 'g3']], ['gemini', ['gem1']]]);

  const custom = providersFromEnv({ KEYHOPPER_PROVIDERS: 'myllm', MYLLM_BASE_URL: 'http://x/v1', MYLLM_API_KEYS: 'k', MYLLM_MODELS: 'a,b' });
  assert.deepEqual(custom, [{ name: 'myllm', keys: ['k'], models: ['a', 'b'], baseURL: 'http://x/v1' }]);
});

test('constructor explains missing keys', () => {
  assert.throws(() => createGateway({ providers: [] }), /no API keys configured/);
});

test('logs say who answered, failovers, and when limited keys come back', async () => {
  const lines = [];
  const gw = createGateway({ logs: (l) => lines.push(l), providers: [provider('a', ['429-l-xxxxxxxx']), provider('b', ['ok-l-xxxxxxxx'])] });
  await gw.text('hi');
  assert.match(lines[0], /\[keyhopper\] .*⏳ a\/m1 429-…xxxx +rate limited → resting 8s \(back at \d\d:\d\d:\d\d\)/);
  assert.match(lines[1], /✓ b\/m1 ok-l…xxxx +\d+ms · after 1 failover · 29\/30 req left, resets in 2m/);

  const [h] = gw.history();
  assert.equal(h.ok, true);
  assert.equal(h.provider, 'b');
  assert.equal(h.failovers, 1);

  const b = gw.status().find((s) => s.provider === 'b');
  assert.equal(b.requestsLeft, 29);
  assert.equal(b.requestsLimit, 30);
  assert.ok(b.requestsResetMs > 100_000);
  const a = gw.status().find((s) => s.provider === 'a');
  assert.ok(a.resetsAt);

  let table = '';
  gw.printStatus((t) => (table = t));
  assert.match(table, /◐ cooling/);
  assert.match(table, /29\/30 \(reset 2m\)/);
});

test('init adds a keyhopper block to an existing .env without touching the rest', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { init } = await import('../src/init.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyhopper-'));
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=postgres://x\nGROQ_API_KEYS=gsk_existing\n');
  init({ cwd: dir });
  const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  assert.ok(env.startsWith('DATABASE_URL=postgres://x\nGROQ_API_KEYS=gsk_existing\n'));
  assert.match(env, /# GROQ_API_KEYS=   \(already set above\)/);
  assert.match(env, /^# GEMINI_API_KEYS=$/m);
  assert.match(env, /Found keys already in this file, used automatically: GROQ_API_KEYS/);
  assert.ok(fs.existsSync(path.join(dir, '.env.keyhopper.example')));
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\.env$/m);

  // running it twice changes nothing
  init({ cwd: dir });
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), env);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wrong model name: warns once with the fix, disables that model, still answers', async () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const gw = createGateway({ providers: [provider('groq', ['404m-a-xxxxxxx'], ['old-model']), provider('b', ['ok-m-xxxxxxxx'])] });
    assert.equal(await gw.text('hi'), 'hi from b:ok-m-xxxxxxxx:m1');
    await gw.text('hi again');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Model "old-model" is not available on groq.*Change GROQ_MODELS in your \.env/);
    const s = gw.status().find((x) => x.provider === 'groq');
    assert.equal(s.state, 'disabled');
    assert.equal(s.disabledReason, 'model_not_found');
    assert.equal(s.failed, 1); // not retried on the second request
  } finally {
    console.warn = orig;
  }
});

test('repeated server errors back off longer each time', async () => {
  const gw = createGateway({ errorCooldownMs: 1000, maxWaitMs: 0, providers: [provider('a', ['500-x-xxxxxxxx']), provider('b', ['ok-x-xxxxxxxx'])] });
  await gw.text('1');
  const first = gw.status()[0].cooldownMs;
  gw.slots[0].cooldownUntil = 0; // pretend the cooldown passed
  await gw.text('2');
  const second = gw.status()[0].cooldownMs;
  assert.ok(first <= 1000 && second > 1500, `first ${first}, second ${second}`);
});

test('empty reply cut off by max_tokens prints a hint', async () => {
  const warnings = [];
  const gw = createGateway({ warnings: false, onEvent: (e) => e.type === 'warning' && warnings.push(e.message), providers: [provider('a', ['empty-xxxxxxxx'])] });
  assert.equal(await gw.text('hi', { max_tokens: 5 }), '');
  assert.match(warnings[0], /used up max_tokens before answering.*Raise max_tokens/);
});

test('KEYHOPPER_PROVIDERS sets who goes first without dropping other providers', () => {
  const list = providersFromEnv({ KEYHOPPER_PROVIDERS: 'gemini', GROQ_API_KEYS: 'g', GEMINI_API_KEYS: 'm', NVIDIA_API_KEYS: 'n' });
  assert.deepEqual(list.map((p) => p.name), ['gemini', 'groq', 'nvidia']);
});

test('built-in defaults are the verified models', async () => {
  const { PRESETS } = await import('../src/index.js');
  assert.deepEqual(PRESETS.groq.models, ['openai/gpt-oss-120b']);
  assert.deepEqual(PRESETS.gemini.models, ['gemini-2.5-flash']);
});
