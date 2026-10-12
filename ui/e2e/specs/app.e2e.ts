import { type ChildProcess, spawn } from 'node:child_process';
import { $, browser, expect } from '@wdio/globals';
import { sentCode } from '../support/server.ts';
import { freePort } from '../support/wait.ts';

const EMAIL = 'user@example.com';
const serverUrl = () => process.env['PROBE_SERVER_URL'] ?? '';
let second: ChildProcess | undefined;

describe('Probe app', () => {
  after(() => {
    second?.kill();
  });

  it('starts: the window renders, IPC answers, the demo server is reachable', async () => {
    await expect($('h1')).toHaveText('Probe');
    await expect($('[data-testid="version"]')).toHaveText('0.1.0');
    await expect($('[data-testid="server"]')).toHaveText('up');
  });

  it('login: a wrong code is rejected, the code issued by the server signs in', async () => {
    await $('#email').setValue(EMAIL);
    await $('button[type="submit"]').click();
    await expect($('#code')).toBeDisplayed();
    const code = await sentCode(serverUrl(), EMAIL);

    await $('#code').setValue(code === '000000' ? '111111' : '000000');
    await $('button[type="submit"]').click();
    await expect($('[role="alert"]')).toHaveText('bad_code');
    await expect($('[data-testid="signed-in"]')).not.toBeExisting();

    await $('#code').setValue(code);
    await $('button[type="submit"]').click();
    // E2E_BREAK=1 puts a deliberately wrong expectation here: proof that this suite can fail
    await expect($('[data-testid="signed-in"]')).toHaveText(process.env['E2E_BREAK'] ? 'broken' : 'Signed in');
    await expect($('[data-testid="stored"]')).toHaveText('yes');
    await expect($('[data-testid="pong"]')).toHaveText('7');
  });

  it('widgets: the select switches the language, the modal dialog opens and closes', async () => {
    await $('[data-testid="language"]').click();
    await $('[data-testid="language-de"]').click();
    await expect($('[data-testid="signed-in"]')).toHaveText('Angemeldet');

    await $('[data-testid="about"]').click();
    await expect($('[data-testid="about-dialog"]')).toBeDisplayed();
    await $('[data-testid="about-close"]').click();
    await expect($('[data-testid="about-dialog"]')).not.toBeDisplayed();
  });

  it('single instance: a second launch exits and the running window is notified', async () => {
    await expect($('[data-testid="instances"]')).toHaveText('0');
    const port = String(await freePort());
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      second = spawn(process.env['APP_BIN'] ?? '', [], {
        env: { ...process.env, TAURI_WEBDRIVER_PORT: port },
        stdio: 'ignore',
      });
      second.once('error', reject);
      second.once('exit', resolve);
    });
    expect(exitCode).toBe(0);
    await expect($('[data-testid="instances"]')).toHaveText('1');
  });

  it('CSP: nothing was blocked so far, and a provoked violation is detected', async () => {
    // the list is compared rather than the counter so that a failure names what was blocked
    await expect($('[data-testid="problem-list"]')).toHaveText('');
    await expect($('[data-testid="problems"]')).toHaveText('0');
    // img-src allows only 'self', data: and blob:
    await browser.execute(() => {
      const img = document.createElement('img');
      img.src = 'http://127.0.0.1:9/blocked.png';
      document.body.append(img);
    });
    await expect($('[data-testid="problems"]')).toHaveText('1');
  });
});
