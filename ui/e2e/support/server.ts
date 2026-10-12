import { type ChildProcess, spawn } from 'node:child_process';

export interface Server {
  url: string;
  stop(): Promise<void>;
}

/** Starts the demo server on an OS-chosen port; ready when it prints its LISTENING line. */
export function startServer(bin: string): Promise<Server> {
  const child: ChildProcess = spawn(bin, ['--listen', '127.0.0.1:0', '--exit-on-stdin-eof'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    let out = '';
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`server exited before it was ready: ${code}`)));
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const url = /^LISTENING (\S+)$/m.exec(out)?.[1];
      if (url) {
        resolve({
          url,
          stop: () =>
            new Promise<void>((done) => {
              child.once('exit', () => done());
              child.stdin?.end(); // EOF is the regular way to stop it
            }),
        });
      }
    });
  });
}

/** Reads the one-time code the server "sent" to this email. */
export async function sentCode(serverUrl: string, email: string): Promise<string> {
  const res = await fetch(`${serverUrl}/debug/code?email=${encodeURIComponent(email)}`);
  if (!res.ok) throw new Error(`/debug/code: ${res.status}`);
  return ((await res.json()) as { code: string }).code;
}
