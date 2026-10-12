#!/usr/bin/env node
// Launch check without any WebDriver: starts the demo server and the app binary, then reads the
// PROBE_* marker lines the app prints.
//   PROBE_READY problems=N  - the window exists, the frontend rendered and its IPC call arrived
//   PROBE_PROBLEM ...       - a CSP violation or uncaught error seen by the frontend
//   PROBE_SECOND_INSTANCE   - the single-instance callback fired in the running app
// usage: node scripts/launch-check.mjs <app binary> <server binary>
import { spawn } from 'node:child_process';

const [appBin, serverBin] = process.argv.slice(2);
if (!appBin || !serverBin) {
  console.error('usage: launch-check.mjs <app binary> <server binary>');
  process.exit(2);
}

const children = [];
let output = '';
const waiters = new Set();

function fail(message) {
  console.error(`FAIL: ${message}`);
  for (const child of children) child.kill();
  process.exit(1);
}

/** Resolves with the first match of `pattern` in everything the watched processes printed. */
function seen(pattern, what, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => fail(`timed out after ${timeoutMs} ms waiting for ${what}`), timeoutMs);
    const check = () => {
      const match = pattern.exec(output);
      if (!match) return false;
      clearTimeout(timer);
      waiters.delete(check);
      resolve(match);
      return true;
    };
    if (!check()) waiters.add(check);
  });
}

function watch(child, name) {
  children.push(child);
  child.once('error', (e) => fail(`${name}: ${e.message}`));
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (chunk) => {
      process.stdout.write(chunk);
      output += chunk;
      for (const check of [...waiters]) check();
    });
  }
  return child;
}

const server = watch(spawn(serverBin, ['--listen', '127.0.0.1:0', '--exit-on-stdin-eof'], { stdio: 'pipe' }), 'server');
const url = (await seen(/^LISTENING (\S+)$/m, 'the server', 30_000))[1];
const env = { ...process.env, PROBE_SERVER_URL: url, PROBE_SECRET_STORE: 'memory' };

const app = watch(spawn(appBin, [], { env, stdio: ['ignore', 'pipe', 'pipe'] }), 'app');
app.once('exit', (code, signal) => fail(`the app exited on its own (code ${code}, signal ${signal})`));
const ready = await seen(/^PROBE_READY problems=(\d+)$/m, 'PROBE_READY from the app', 120_000);
console.log('ok: the app started, created its window and answered over IPC');

const second = watch(spawn(appBin, [], { env, stdio: ['ignore', 'pipe', 'pipe'] }), 'second app');
const secondExit = new Promise((resolve) => second.once('exit', resolve));
await seen(/^PROBE_SECOND_INSTANCE$/m, 'PROBE_SECOND_INSTANCE from the first app', 60_000);
const timer = setTimeout(() => fail('the second instance did not exit'), 60_000);
const code = await secondExit;
clearTimeout(timer);
if (code !== 0) fail(`the second instance exited with code ${code}`);
console.log('ok: the second launch exited and the first instance was notified');

const problems = output.split('\n').filter((line) => line.startsWith('PROBE_PROBLEM'));
if (ready[1] !== '0' || problems.length > 0) fail(`the frontend reported problems:\n${problems.join('\n')}`);
console.log('ok: no CSP violations or uncaught errors');

app.removeAllListeners('exit');
app.kill();
server.stdin.end();
process.exit(0);
