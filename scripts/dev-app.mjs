// Starts Vite dev server, then launches Electron pointed at it.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electronPath from 'electron';

const server = await createServer();
await server.listen();
const url = `http://localhost:${server.config.server.port}`;
console.log(`[dev-app] vite at ${url}`);

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
child.on('exit', () => {
  server.close();
  process.exit(0);
});
