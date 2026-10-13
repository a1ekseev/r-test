#!/usr/bin/env node
// Crash dump cleanup probe (Windows, WebView2). The webview's crash handler cannot be switched off,
// so the app deletes its dumps itself: at start and at exit (PROBE_CLEAN_CRASHPAD=1, with a data
// directory of its own, an incognito window and form suggestions off). This script shows, without
// any WebDriver, what that does:
//   control  - no cleanup: the renderer crashes, the app leaves on request; the dump must stay
//   graceful - cleanup on: crash, leave on request; the dump must be gone
//   killed   - cleanup on: crash, the whole process tree is killed (the dump stays), the app starts
//              again (the dump must be gone and the app must work), crashes again (the handler must
//              still write a dump), leaves on request (gone again)
// usage: node scripts/crashpad-probe.mjs <app binary> <server binary>   (output: $CRASHPAD_OUT)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [appBin, serverBin] = process.argv.slice(2);
if (!appBin || !serverBin) {
  console.error('usage: crashpad-probe.mjs <app binary> <server binary>');
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.env.CRASHPAD_OUT ?? join(here, '../ui/e2e/artifacts/crashpad'));
const data = join(os.tmpdir(), 'probe-crashpad-data');
const crashpad = join(data, 'EBWebView', 'Crashpad');
const report = ['### Crash dump cleanup (WebView2)', '', `App binary: \`${relative(resolve(here, '..'), resolve(appBin))}\`.`, ''];
const failures = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Every file under the crash handler's directory as "relative path (bytes)". */
function tree(dir = crashpad) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return [`${relative(crashpad, path)}\\`, ...tree(path)];
    return [`${relative(crashpad, path)} (${fs.statSync(path).size})`];
  });
}

const dumps = () => tree().filter((line) => /^(reports|attachments)\\.+\(\d+\)$/.test(line));

function check(what, ok) {
  report.push(`- ${ok ? 'ok' : 'FAILED'}: ${what}`);
  if (!ok) failures.push(what);
}

function note(label) {
  const found = dumps();
  report.push(`- ${label}: ${found.length} dump file(s)${found.length > 0 ? ` - ${found.join(', ')}` : ''}`);
  return found.length;
}

const server = spawn(serverBin, ['--listen', '127.0.0.1:0', '--exit-on-stdin-eof'], { stdio: ['pipe', 'pipe', 'inherit'] });
const url = await new Promise((done, fail) => {
  let text = '';
  server.stdout.on('data', (chunk) => {
    text += chunk;
    const match = /^LISTENING (\S+)$/m.exec(text);
    if (match) done(match[1]);
  });
  setTimeout(() => fail(new Error('the server did not start')), 30_000);
});

function environment(clean) {
  return {
    ...process.env,
    PROBE_SERVER_URL: url,
    PROBE_SECRET_STORE: 'memory',
    PROBE_INCOGNITO: '1',
    PROBE_AUTOFILL: '0',
    PROBE_DATA_DIR: data,
    PROBE_CLEAN_CRASHPAD: clean ? '1' : '0',
  };
}

/** Starts the app and waits until its frontend answered over IPC. */
async function start(clean) {
  const app = { child: spawn(appBin, [], { env: environment(clean), stdio: ['ignore', 'pipe', 'pipe'] }), output: '' };
  app.exited = new Promise((done) => app.child.once('exit', (code) => done(code)));
  for (const stream of [app.child.stdout, app.child.stderr]) stream.on('data', (chunk) => (app.output += chunk));
  for (let waited = 0; waited < 120_000 && !/^PROBE_READY/m.test(app.output); waited += 500) await sleep(500);
  const ready = /^PROBE_READY problems=(\d+)$/m.exec(app.output);
  check(`the app started and its frontend answered without problems (${ready?.[0] ?? 'no PROBE_READY within 120 s'})`, ready?.[1] === '0');
  await sleep(3000);
  return app;
}

/** Raises an unhandled exception in the renderer; waits for the handler to finish writing. */
function crash() {
  const result = spawnSync(process.execPath, [join(here, 'disk-probe.mjs'), 'crash', 'break'], { encoding: 'utf8' });
  const outcome = `${result.stdout}${result.stderr}`.trim();
  check(`the renderer crashed (${outcome})`, /ended with exit code/.test(outcome));
}

/** A second launch asks the running instance to leave; true if it left on its own. */
async function leave(app, clean) {
  spawn(appBin, ['--quit'], { env: environment(clean), stdio: 'ignore' });
  const code = await Promise.race([app.exited, sleep(30_000).then(() => 'timeout')]);
  if (code === 'timeout') spawnSync('taskkill', ['/pid', String(app.child.pid), '/T', '/F']);
  check(`the app left on request (exit code ${code})`, code === 0);
  await sleep(5000); // the webview's own processes end a little later
}

const cleanupLines = (app) => (app.output.match(/^PROBE_CRASHPAD .*$/gm) ?? []).join('; ') || 'none';
const section = (title) => report.push('', `**${title}**`, '');
const listing = (title) => report.push('', `${title}:`, '', '```', ...tree(), '```');

fs.rmSync(data, { recursive: true, force: true });

section('control: no cleanup');
let app = await start(false);
crash();
check('a dump exists after the crash (incognito window, own data directory)', note('after the crash') > 0);
await leave(app, false);
check('without the cleanup the dump is still there after the app left', note('after the app left') > 0);
fs.rmSync(data, { recursive: true, force: true });

section('graceful: cleanup at exit');
app = await start(true);
crash();
check('a dump exists after the crash', note('after the crash') > 0);
await leave(app, true);
check('the dump is gone after the app left', note('after the app left') === 0);
report.push(`- cleanup reported by the app: ${cleanupLines(app)}`);
check('the cleanup at exit deleted something and nothing failed', /when=exit removed=[1-9]\d* failed=0/.test(app.output));
listing('Left in the crash handler directory');

section('killed: cleanup at the next start');
app = await start(true);
crash();
check('a dump exists after the crash', note('after the crash') > 0);
spawnSync('taskkill', ['/pid', String(app.child.pid), '/T', '/F']);
await app.exited;
await sleep(5000);
check('the dump is still there after the process tree was killed', note('after the kill') > 0);
app = await start(true);
check('the dump is gone after the next start', note('after the next start') === 0);
check('the cleanup at start deleted something and nothing failed', /when=start removed=[1-9]\d* failed=0/.test(app.output));
crash();
check('the crash handler still writes a dump after its reports were deleted', note('after a second crash') > 0);
await leave(app, true);
check('the dump is gone after the app left', note('after the app left') === 0);
report.push(`- cleanup reported by the app: ${cleanupLines(app)}`);
listing('Left in the crash handler directory');

server.stdin.end();
report.push('', failures.length > 0 ? `**Checks failed: ${failures.join('; ')}**` : 'All checks passed.', '');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(join(out, 'summary.md'), `${report.join('\n')}\n`);
console.log(report.join('\n'));
process.exit(failures.length > 0 ? 1 : 0);
