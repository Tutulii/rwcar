import { createServer } from 'node:http';
import { AgentExecutor } from './executor.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const executor = new AgentExecutor(config);
let ready = true;

const health = createServer((request, response) => {
  if (request.url !== '/health') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ status: ready ? 'ok' : 'stopping', workerId: config.EXECUTOR_WORKER_ID }));
});

await new Promise<void>((resolve) => health.listen(config.PORT, '0.0.0.0', resolve));

const shutdown = async () => {
  if (!ready) return;
  ready = false;
  executor.stop();
  await new Promise<void>((resolve) => health.close(() => resolve()));
};

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
await executor.run();
