// Runs the API server (--dev) and the Vite dev server together; `a & b` in npm scripts is sequential on Windows cmd.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const procs = [
  spawn(npm, ['run', 'dev', '-w', 'server'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn(npm, ['run', 'dev', '-w', 'web'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];

const stop = () => {
  for (const p of procs) if (!p.killed) p.kill();
};
for (const p of procs) p.on('exit', (code) => {
  stop();
  process.exitCode = code ?? 0;
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
