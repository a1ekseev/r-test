// Collects CSP violations and uncaught errors so that both the UI and the Rust side can report them.
import { frontendReady, reportProblem } from './ipc';

const list: string[] = [];
const listeners = new Set<() => void>();
let ready = false;

export function add(detail: string): void {
  list.push(detail);
  for (const notify of listeners) notify();
  // a failed report must not come back here as an unhandled rejection
  if (ready) reportProblem(detail).catch(() => undefined);
}

export const count = (): number => list.length;
export const all = (): readonly string[] => list;

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function install(): void {
  document.addEventListener('securitypolicyviolation', (e) => add(`csp: ${e.violatedDirective} ${e.blockedURI}`));
  window.addEventListener('error', (e) => add(`error: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => add(`rejection: ${String(e.reason)}`));
}

/** Tells the Rust side that the page rendered and fonts settled, with everything collected so far. */
export async function announceReady(): Promise<void> {
  await document.fonts?.ready;
  ready = true;
  await frontendReady([...list]).catch(() => undefined);
}
