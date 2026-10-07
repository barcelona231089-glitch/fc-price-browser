import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserExecutablePath } from '../artifacts/api-server/src/lib/traffic-analyzer.ts';
try {
  browserExecutablePath();
  console.log('Analyse-Browser vorhanden.');
} catch {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const installer = path.join(root, 'artifacts/api-server/node_modules/playwright/cli.js');
  const child = spawn(process.execPath, [installer, 'install', 'chromium'], { stdio: 'inherit' });
  child.once('exit', code => { process.exitCode = code ?? 1; });
  child.once('error', () => { console.error('Browser-Installation konnte nicht gestartet werden.'); process.exitCode = 1; });
}
