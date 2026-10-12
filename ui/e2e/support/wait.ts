import { createServer } from 'node:net';

/** A free loopback port chosen by the OS. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

/** Waits until a WebDriver server answers GET /status. The only polling loop in the E2E code. */
export async function waitForWebDriver(port: number, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/status`)).ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`no WebDriver on port ${port} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
