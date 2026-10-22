import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadProjectBinding } from '../dist/adapters/project/binding.js';
import { lifecycleEvents } from '../dist/adapters/storage/sqlite/lifecycle.js';
import { regularPath } from './local-installation.mjs';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function setupCodexHooks({ project, db, output }) {
  if (![project, db, output].every(value => typeof value === 'string' && isAbsolute(value) && !/[\0\r\n]/.test(value))) {
    throw new Error('Use absolute project, DB and new output directory paths.');
  }
  const root = realpathSync(project), destination = resolve(output);
  regularPath(root, true); regularPath(dirname(db), true); regularPath(dirname(destination), true);
  loadProjectBinding(root);
  try { lstatSync(destination); throw new Error('Output already exists; no files changed.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const runtime = fileURLToPath(new URL('../dist/runtime/local/main.js', import.meta.url));
  regularPath(runtime); regularPath(process.execPath);
  const command = [process.execPath, runtime, 'codex-hook', '--project', root, '--db', db].map(quote).join(' ');
  const hooks = Object.fromEntries(lifecycleEvents.map(event => [event, [{
    ...(event === 'PostToolUse' ? { matcher: '^Bash$|^apply_patch$' } : {}),
    hooks: [{ type: 'command', command, timeout: event === 'Interrupt' || event === 'SessionEnd' ? 3 : 5 }],
  }]]));
  // Candidate only: never read, merge or overwrite existing host settings or trust.
  mkdirSync(join(destination, '.codex'), { recursive: true, mode: 0o700 });
  writeFileSync(join(destination, '.codex/hooks.json'), JSON.stringify({ description: 'Skilly local lifecycle metadata; no command or transcript content.', hooks }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { status: 'candidate_created', path: join(destination, '.codex/hooks.json'), candidate_applied: false,
    hook_loading_verified: false, trust_changed: false, existing_project_settings_changed: false,
    observation_store: `${db}.events.sqlite`, events: lifecycleEvents,
    next_steps: ['Review and merge only these hooks through the host setup, preserving existing hooks.',
      'The user must trust the exact hook definitions in Codex before they can run. Never bypass trust.',
      'Set SKILLY_RECORDING=off for the hook process or disable these hooks before a recording opt-out session.',
      'After changing folders generate a new candidate for that root; old-root observations are not new-root proof.'] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { project: { type: 'string' }, db: { type: 'string' }, output: { type: 'string' } } });
    process.stdout.write(JSON.stringify(setupCodexHooks(values), null, 2) + '\n');
  } catch { process.stderr.write('Hook candidate was not completed. Preserve existing settings and inspect the explicit paths; no trust was granted.\n'); process.exitCode = 1; }
}
