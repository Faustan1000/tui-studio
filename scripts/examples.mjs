// Regenerates examples/demo (the demo project and its export for every framework).
import { spawnSync } from 'node:child_process';

const r = spawnSync('npx', ['vitest', 'run', 'tests/generateExamples.test.ts'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, GENERATE_EXAMPLES: '1' },
});
process.exit(r.status ?? 1);
