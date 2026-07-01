/**
 * Start wrangler dev in LOCAL_DEV mode (auth disabled via wrangler.toml [env.dev]).
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '../..');
const wranglerBin = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const env = { ...process.env };
delete env.API_KEY;

const extraArgs = process.argv.slice(2);

const child = spawn(process.execPath, [wranglerBin, 'dev', '--env', 'dev', ...extraArgs], {
  cwd: root,
  env,
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 0));
