import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from './env.js';
import { PRESETS, ENV_ALIASES } from './providers.js';

const TEMPLATE = fileURLToPath(new URL('../.env.keyhopper.example', import.meta.url));
const MARKER = /^# =+ keyhopper =+/m; // matches every template version

/**
 * Add keyhopper's commented config block to a project's .env (creating it if needed),
 * write .env.keyhopper.example for teammates, and make sure .env is git-ignored.
 * Never overwrites or removes anything the user already has.
 */
export function init({ cwd = process.cwd(), envFile = '.env' } = {}) {
  const report = [];
  const envPath = path.resolve(cwd, envFile);
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : null;

  if (existing && MARKER.test(existing)) {
    report.push(`• ${envFile} already has a keyhopper section — left it alone`);
  } else {
    const current = existing ? parseEnv(existing) : {};
    // Never redefine a variable the user already has (a later line would override theirs).
    const lines = template.split(/\r?\n/).map((line) => {
      const m = /^([A-Z0-9_]+)=/.exec(line);
      return m && m[1] in current ? `# ${line}   (already set above)` : line;
    });
    const found = detectExistingKeys(current);
    if (found.length) {
      lines.splice(1, 0, `# Found keys already in this file, used automatically: ${found.join(', ')}`);
    }
    const block = lines.join('\n');
    const sep = existing == null ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    fs.writeFileSync(envPath, (existing ?? '') + sep + block);
    report.push(
      existing == null
        ? `• created ${envFile} with a keyhopper section — paste your keys there`
        : `• added a keyhopper section to the end of your ${envFile} (nothing else changed)`,
    );
    if (found.length) report.push(`  found existing keys it will use: ${found.join(', ')}`);
  }

  const examplePath = path.resolve(cwd, '.env.keyhopper.example');
  if (!fs.existsSync(examplePath)) {
    fs.writeFileSync(examplePath, template);
    report.push('• wrote .env.keyhopper.example (safe to commit — no real keys)');
  }

  const gitignore = path.resolve(cwd, '.gitignore');
  const inRepo = fs.existsSync(path.resolve(cwd, '.git'));
  const ignoreText = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : null;
  const base = path.basename(envFile);
  const ignored = ignoreText?.split(/\r?\n/).some((l) => ['.env', '.env*', '.env.*', '*.env', base, `/${base}`].includes(l.trim()));
  if (!ignored && (ignoreText != null || inRepo)) {
    const sep = !ignoreText || ignoreText.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(gitignore, `${ignoreText ?? ''}${sep}${base}\n`);
    report.push(`• added ${base} to .gitignore so your keys never get committed`);
  }
  return report;
}

function detectExistingKeys(vars) {
  const found = [];
  for (const name of Object.keys(PRESETS)) {
    const P = name.toUpperCase();
    const names = [`${P}_API_KEYS`, `${P}_API_KEY`, `${P}_KEYS`, ...(ENV_ALIASES[name] ?? [])];
    const hit = names.find((n) => vars[n]);
    if (hit) found.push(hit);
  }
  return found;
}
