// Scenario of the disk probe (scripts/disk-probe.mjs), not part of the regular suite: sign in with
// marker values, show the data, open the dialog, launch a second instance, then hand over to the
// probe while the app is still running. The harness ends the app afterwards.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $, browser, expect } from '@wdio/globals';
import { sentCode } from '../support/server.ts';
import { freePort } from '../support/wait.ts';

const marker = process.env['PROBE_MARKER'] ?? '';
const out = process.env['DISK_OUT'] ?? '.';
const EMAIL = `${marker}-email@example.com`;
let second: ChildProcess | undefined;

describe('Disk probe scenario', () => {
  after(() => {
    second?.kill();
  });

  if (process.env['DISK_PHASE'] === 'verify') {
    it('a restarted app reports what its webview kept', async () => {
      await expect($('h1')).toHaveText('Probe');
      const kept = await browser.execute(() => localStorage.getItem('probe-marker'));
      writeFileSync(join(out, 'persisted.txt'), String(kept));
    });
    return;
  }

  it('signs in with the marker values and shows the data', async () => {
    await expect($('[data-testid="incognito"]')).toHaveText(process.env['PROBE_INCOGNITO'] === '1' ? 'yes' : 'no');
    await $('#email').setValue(EMAIL);
    await $('button[type="submit"]').click();
    await expect($('#code')).toBeDisplayed();
    await $('#code').setValue(await sentCode(process.env['PROBE_SERVER_URL'] ?? '', EMAIL));
    await $('button[type="submit"]').click();
    await expect($('[data-testid="message"]')).toHaveText(`${marker}-message-welcome`);
    for (const id of ['image-direct', 'image-proxied']) {
      await browser.waitUntil(
        () => browser.execute((testid) => (document.querySelector<HTMLImageElement>(`[data-testid="${testid}"]`)?.naturalWidth ?? 0) > 0, id),
        { timeoutMsg: `${id} did not load` },
      );
    }
    // positive control: a value the webview is asked to persist; expected on disk without incognito only
    await browser.execute((value) => localStorage.setItem('probe-marker', value), `${marker}-local`);
  });

  it('opens the dialog and takes a second launch', async () => {
    await $('[data-testid="about"]').click();
    await expect($('[data-testid="about-dialog"]')).toBeDisplayed();
    await $('[data-testid="about-close"]').click();
    const port = String(await freePort());
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      second = spawn(process.env['APP_BIN'] ?? '', [], { env: { ...process.env, TAURI_WEBDRIVER_PORT: port }, stdio: 'ignore' });
      second.once('error', reject);
      second.once('exit', resolve);
    });
    expect(exitCode).toBe(0);
    await expect($('[data-testid="instances"]')).toHaveText('1');
    // a session lasts longer than a test: give the webview time for its delayed writes (caches, storage)
    await browser.pause(8000);
  });

  it('hands over to the probe while the app is running', function () {
    this.timeout(600_000);
    const hook = spawnSync(process.execPath, [process.env['DISK_PROBE'] ?? '', 'hook'], { stdio: 'inherit' });
    expect(hook.status).toBe(0);
  });
});
