// Grab node:fs lazily so importing keyhopper never breaks in runtimes without it.
function getFs() {
  try {
    return globalThis.process?.getBuiltinModule?.('node:fs') ?? null;
  } catch {
    return null;
  }
}

/** Parse KEY=VALUE lines (dotenv style). */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]] = value;
  }
  return out;
}

/**
 * Minimal .env loader (no dependency). Variables that are already set win,
 * so this never fights with dotenv, Next.js, Vite, etc.
 * Returns true if the file was found.
 */
export function loadEnvFile(path = '.env', env = globalThis.process?.env) {
  const fs = getFs();
  if (!fs || !env) return false;
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (env[k] === undefined || env[k] === '') env[k] = v;
  }
  return true;
}
