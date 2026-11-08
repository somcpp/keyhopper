#!/usr/bin/env node
import { createGateway, createServer, loadEnvFile, formatStatusTable } from '../src/index.js';
import { init } from '../src/init.js';

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'help';
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const HELP = `keyhopper — paste many LLM API keys, never hit a rate limit wall

Usage:
  npx keyhopper init [--env .env]       add a commented keyhopper section to your .env
  npx keyhopper check                   test every key once (uses a tiny bit of quota)
  npx keyhopper ask "your prompt"       one-off question, shows which key answered
  npx keyhopper serve [--port 8787]     OpenAI-compatible server + live dashboard
  npx keyhopper status [--url URL]      key table from a running server

Keys come from env vars / .env, e.g.
  GROQ_API_KEYS=gsk_aaa,gsk_bbb
  GEMINI_API_KEYS=AIza...,AIza...
Docs: https://github.com/somcpp/keyhopper`;

if (command === 'help' || args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

if (command === 'init') {
  const report = init({ envFile: flag('env', '.env') });
  console.log('keyhopper init\n' + report.join('\n'));
  console.log('\nNext: paste your keys, then run `npx keyhopper check`.');
  process.exit(0);
}

if (command === 'status') {
  const base = flag('url', `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/+$/, '');
  loadEnvFile(flag('env', '.env'));
  const token = process.env.KEYHOPPER_TOKEN;
  try {
    const res = await fetch(`${base}/status`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message ?? res.statusText);
    console.log(formatStatusTable(data.keys));
    const last = data.recent.slice(0, 10);
    if (last.length) {
      console.log('\nRecent requests:');
      for (const r of last) {
        const t = new Date(r.time).toTimeString().slice(0, 8);
        console.log(
          r.ok
            ? `  ${t}  ✓ ${r.provider}/${r.model} ${r.key}  ${r.ms}ms${r.failovers ? `  (${r.failovers} failover${r.failovers > 1 ? 's' : ''})` : ''}`
            : `  ${t}  ✗ ${r.error}`,
        );
      }
    }
  } catch (err) {
    console.error(`Could not reach a keyhopper server at ${base} (${err.cause?.code ?? err.message}). Is \`keyhopper serve\` running?`);
    process.exitCode = 1;
  }
} else {
  const envPath = flag('env', '.env');
  loadEnvFile(envPath);
  let gateway;
  try {
    gateway = createGateway({ logs: command === 'serve' || command === 'ask' || undefined });
  } catch (err) {
    console.error(err.message);
    console.error(`(looked for keys in the environment and ${envPath})`);
    process.exit(1);
  }

  const summary = () => {
    for (const p of gateway.providers) console.log(`  ${p.name.padEnd(11)} ${p.keys.length} key(s) × [${p.models.join(', ')}]`);
  };

  if (command === 'serve') {
    const port = Number(flag('port', process.env.PORT || 8787));
    const host = flag('host', process.env.HOST || '127.0.0.1');
    const token = process.env.KEYHOPPER_TOKEN;
    createServer(gateway, { token }).listen(port, host, () => {
      const base = `http://${host}:${port}`;
      console.log(`keyhopper listening on ${base}/v1  (strategy: ${gateway.strategy})`);
      console.log(`  dashboard: ${base}/${token ? '?token=<KEYHOPPER_TOKEN>' : ''}`);
      summary();
      if (!token) console.log('  (no KEYHOPPER_TOKEN set — anyone who can reach this port can use your keys)');
      console.log('');
    });
  } else if (command === 'check') {
    summary();
    console.log('\nChecking every key…');
    const results = await gateway.check();
    for (const r of results) {
      const label = `${r.provider}/${r.model} [${r.key}]`;
      console.log(r.ok ? `  ✓ ${label}  ${r.ms}ms` : `  ✗ ${label}  ${r.status ?? ''} ${r.error}`);
    }
    const badModels = new Map();
    for (const r of results) {
      if (!r.ok && (r.status === 404 || r.status === 400) && /model/i.test(r.error ?? '')) {
        badModels.set(`${r.provider}/${r.model}`, `${r.provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MODELS`);
      }
    }
    for (const [m, envName] of badModels) {
      console.log(`\n  → "${m}" isn't available. Change ${envName} in your .env (see the provider's model list).`);
    }
    if (results.some((r) => !r.ok && r.status === 401)) {
      console.log('\n  → A key was rejected (401). Check it was copied fully, or create a new one.');
    }
    console.log('');
    gateway.printStatus();
    process.exitCode = results.every((r) => r.ok) ? 0 : 1;
  } else if (command === 'ask') {
    const prompt = args.filter((a) => !a.startsWith('--')).join(' ');
    if (!prompt) {
      console.error('Usage: keyhopper ask "your prompt"');
      process.exit(1);
    }
    try {
      let out = '';
      for await (const piece of gateway.streamText(prompt)) out += piece;
      console.log(`\n${out}`);
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  } else {
    console.error(`Unknown command "${command}".\n\n${HELP}`);
    process.exitCode = 1;
  }
}
