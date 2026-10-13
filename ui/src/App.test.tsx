// Component test with the IPC bridge mocked: no Rust side, no server.
import { mockConvertFileSrc, mockIPC } from '@tauri-apps/api/mocks';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { App } from './App';

// No clearMocks(): unmounting unsubscribes from events asynchronously and still needs the mocked bridge.
// Every test installs its own bridge anyway.
afterEach(cleanup);

const STATUS = {
  version: '0.1.0',
  arch: 'test',
  os: 'test',
  hostname: 'h',
  timezone: 'UTC',
  server: true,
  serverUrl: 'http://127.0.0.1:1',
  incognito: false,
};

/** Mocks the bridge; `confirm` decides how `confirm_code` answers. Returns the recorded app command calls. */
function bridge(confirm: () => unknown): unknown[] {
  const calls: unknown[] = [];
  mockConvertFileSrc('linux');
  mockIPC(
    (cmd, args) => {
      if (cmd === 'status') return STATUS;
      calls.push([cmd, args]);
      return cmd === 'confirm_code' ? confirm() : null;
    },
    { shouldMockEvents: true },
  );
  return calls;
}

async function enter(label: string, text: string, button: string) {
  await userEvent.type(await screen.findByLabelText(label), text);
  await userEvent.click(screen.getByRole('button', { name: button }));
}

test('submit is disabled while the field is empty', () => {
  bridge(() => null);
  render(<App />);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Request code' }).disabled).toBe(true);
});

test('email, then code: shows the signed-in state and passes both to the bridge', async () => {
  const calls = bridge(() => ({ stored: true, pong: 7, message: 'welcome', image: 'probe.png' }));
  render(<App />);
  await enter('Email', 'user@example.com', 'Request code');
  await enter('Code', '123456', 'Sign in');
  expect((await screen.findByTestId('signed-in')).textContent).toBe('Signed in');
  expect(screen.getByTestId('pong').textContent).toBe('7');
  expect(screen.getByTestId('stored').textContent).toBe('yes');
  expect(screen.getByTestId('message').textContent).toBe('welcome');
  expect(screen.getByTestId<HTMLImageElement>('image-direct').src).toBe('http://127.0.0.1:1/image/probe.png');
  expect(screen.getByTestId<HTMLImageElement>('image-proxied').src).toContain('probe.png');
  expect((await screen.findByTestId('server')).textContent).toBe('up');
  expect(calls).toEqual([
    ['request_code', { email: 'user@example.com' }],
    ['confirm_code', { email: 'user@example.com', code: '123456' }],
  ]);
});

test('wrong code: shows the error code from the bridge and stays on the code step', async () => {
  bridge(() => {
    throw 'bad_code';
  });
  render(<App />);
  await enter('Email', 'user@example.com', 'Request code');
  await enter('Code', '000000', 'Sign in');
  expect((await screen.findByRole('alert')).textContent).toBe('bad_code');
  expect(screen.getByLabelText('Code')).toBeDefined();
});
