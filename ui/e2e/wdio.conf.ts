// E2E: the real built app + the real demo server, driven over plain W3C WebDriver.
// E2E_DRIVER=external - tauri-driver + the OS webview driver (Linux, Windows); the app has no test code in it.
// E2E_DRIVER=embedded - WebDriver server inside the app (cargo feature `e2e`); the only option on macOS.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { browser } from '@wdio/globals';
import { type Server, startServer } from './support/server.ts';
import { freePort, waitForWebDriver } from './support/wait.ts';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`environment variable ${name} is not set`);
  return value;
}

const driver = process.env['E2E_DRIVER'] ?? 'external';
const artifacts = process.env['E2E_ARTIFACTS'] ?? join(import.meta.dirname, 'artifacts');
const tag = `${driver}-run${process.env['E2E_RUN'] ?? '1'}`;
let server: Server | undefined;
let child: ChildProcess | undefined;

function stop(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((done) => {
    proc.once('exit', () => done());
    // On Windows kill() ends only the process itself; the driver's children would survive it.
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
    else proc.kill();
  });
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  hostname: '127.0.0.1',
  specs: ['./specs/**/*.e2e.ts'],
  maxInstances: 1,
  // 'tauri:options' is a tauri-driver extension that the WebdriverIO types do not know
  capabilities: [(driver === 'external' ? { 'tauri:options': { application: env('APP_BIN') } } : {}) as WebdriverIO.Capabilities],
  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryCount: 0,
  specFileRetries: 0,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 90_000, retries: 0, forbidOnly: true },

  // Per spec file: its own server, its own app, its own ports.
  beforeSession: async (cfg) => {
    mkdirSync(artifacts, { recursive: true });
    server = await startServer(env('SERVER_BIN'));
    process.env['PROBE_SERVER_URL'] = server.url;
    process.env['PROBE_SECRET_STORE'] ??= 'memory';
    const port = await freePort();
    const log = openSync(join(artifacts, `${tag}-driver.log`), 'w');
    if (driver === 'external') {
      const args = ['--port', String(port), '--native-port', String(await freePort())];
      const native = process.env['NATIVE_DRIVER'];
      if (native) args.push('--native-driver', native);
      child = spawn('tauri-driver', args, { stdio: ['ignore', log, log] });
    } else {
      child = spawn(env('APP_BIN'), [], {
        env: { ...process.env, TAURI_WEBDRIVER_PORT: String(port) },
        stdio: ['ignore', log, log],
      });
    }
    await waitForWebDriver(port);
    cfg.port = port;
  },

  afterTest: async (test, _context, { passed }) => {
    if (!passed) await browser.saveScreenshot(join(artifacts, `${tag}-${test.title.replace(/\W+/g, '_').slice(0, 60)}.png`));
  },

  afterSession: async () => {
    if (child) await stop(child);
    await server?.stop();
  },
};
