import { rmSync } from 'node:fs';
if (!process.env.npm_config_user_agent?.startsWith('pnpm/')) {
  console.error('Bitte pnpm verwenden: pnpm install');
  process.exit(1);
}
for (const file of ['package-lock.json', 'yarn.lock']) rmSync(file, { force: true });
