#!/usr/bin/env node
// Disk probe: what do the app and its webview leave on disk, with an incognito window and without,
// and does any of it contain application data?
//
// Method. A snapshot is a list of every file under the places a desktop app can write to, with
// type, size and mtime. Per variant: snapshot, run the scenario (ui/e2e/disk/disk.e2e.ts, embedded
// WebDriver, secrets kept in memory), snapshot while the app still runs, end the app, snapshot
// again. The differences are the answer. Every value that travels through the scenario (email,
// one-time code, session token, server message, image name, image bytes, a localStorage value)
// carries a random marker; all new and changed files are searched for it as ASCII and UTF-16LE.
//
// What this cannot see: files created and removed between two snapshots (on Linux the strace
// variants cover that), content that is compressed or encrypted on disk, pixels (a saved window
// snapshot shows the data without containing the text), the Windows registry.
//
// usage:
//   node scripts/disk-probe.mjs selftest         proves that the diff and the search can fail
//   node scripts/disk-probe.mjs run [variant..]  default: every variant of this platform
//   node scripts/disk-probe.mjs hook             called by the scenario while the app is running
// environment: DISK_OUT (output directory), DISK_RESET=1 (between variants delete everything that
// appeared since the baseline; meant for throwaway CI machines), APP_BIN, SERVER_BIN.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const repo = resolve(dirname(self), '..');
const platform = process.platform;
const exe = platform === 'win32' ? '.exe' : '';
const out = resolve(process.env.DISK_OUT ?? join(repo, 'ui/e2e/artifacts/disk'));
const serverBin = process.env.SERVER_BIN ?? join(repo, `target/debug/probe-server${exe}`);
const builtApp = process.env.DISK_BUILT_APP ?? process.env.APP_BIN ?? join(repo, `target/debug/probe-app${exe}`);
// macOS: the same binary inside a minimal bundle, so that it runs under its bundle identifier
const bundle = join(repo, 'target/disk-probe/Probe.app');
const appBin = platform === 'darwin' ? join(bundle, 'Contents/MacOS/probe-app') : builtApp;
const APP_ID = 'dev.probe.demo';
const OWN = /dev\.probe\.demo|probe-app|probe-webview-data|Probe\.app/i;
const DEFAULT_ARGS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection';

// quit: flag for the second launch that ends the app ('' = the harness kills the process)
const VARIANTS = {
  incognito: { incognito: true },
  normal: {},
  // the webview data directory moved to a place the app could wipe; automation keeps working there
  'normal-datadir': { env: { PROBE_DATA_DIR: join(os.tmpdir(), 'probe-webview-data') } },
  // Linux: the app runs under strace, which also sees files that do not live until the end
  'incognito-strace': { incognito: true, strace: true },
  'normal-strace': { strace: true },
  // Linux, macOS: the web content process is aborted (SIGABRT): is a dump or report written, and what is in it
  'normal-abort': { crash: 'abort' },
  // Windows: the renderer is ended from outside (no fault), gets a thread at an invalid address (the
  // system fails it fast), gets a thread that raises a breakpoint exception nobody handles
  'normal-kill': { crash: 'kill' },
  'normal-fault': { crash: 'fault' },
  'normal-break': { crash: 'break' },
  'incognito-break': { incognito: true, crash: 'break' },
  'normal-break-nobreakpad': { crash: 'break', browserArgs: `${DEFAULT_ARGS} --disable-breakpad` },
  'normal-break-nocrashpad': { crash: 'break', browserArgs: `${DEFAULT_ARGS} --disable-crashpad-for-testing` },
  // macOS: saved application state. The default leave is -[NSApplication terminate:] (Cmd+Q).
  'normal-appexit': { quit: '--quit' },
  'normal-sigterm': { quit: '' },
  'normal-sigterm-norestore': { quit: '', env: { PROBE_RESTORABLE: '0' } },
  'normal-keep': { defaults: { NSQuitAlwaysKeepsWindows: 'true' } },
  'normal-keep-norestore': { defaults: { NSQuitAlwaysKeepsWindows: 'true' }, env: { PROBE_RESTORABLE: '0' } },
  'normal-keep-ignorestate': { defaults: { NSQuitAlwaysKeepsWindows: 'true' }, appArgs: '-ApplePersistenceIgnoreState YES' },
  'incognito-keep': { incognito: true, defaults: { NSQuitAlwaysKeepsWindows: 'true' } },
};
const PLAN = {
  linux: ['incognito', 'normal', 'normal-datadir', 'incognito-strace', 'normal-strace', 'normal-abort'],
  darwin: [
    'incognito', 'normal', 'normal-appexit', 'normal-sigterm', 'normal-sigterm-norestore', 'normal-keep',
    'normal-keep-norestore', 'normal-keep-ignorestate', 'incognito-keep', 'normal-abort',
  ],
  win32: [
    'incognito', 'normal', 'normal-datadir', 'normal-kill', 'normal-fault', 'normal-break', 'incognito-break',
    'normal-break-nobreakpad', 'normal-break-nocrashpad',
  ],
};

// ---- snapshots -----------------------------------------------------------------------------

function roots() {
  const home = os.homedir();
  const env = process.env;
  const list = {
    linux: [home, '/tmp', '/var/tmp', '/dev/shm', env.XDG_RUNTIME_DIR, '/var/crash', '/var/lib/systemd/coredump'],
    // dirname(tmpdir) is the per-user /var/folders/xx/yy holding T (temporary) and C (caches)
    darwin: [home, '/tmp', dirname(fs.realpathSync(os.tmpdir())), '/Library/Logs/DiagnosticReports', bundle],
    win32: [home, env.PROGRAMDATA, env.SystemRoot && join(env.SystemRoot, 'Temp')],
  }[platform];
  return [...list, dirname(builtApp)].filter((dir) => dir && fs.existsSync(dir));
}

function excluded() {
  const home = os.homedir();
  const tools = [
    '.cargo', '.rustup', '.nvm', '.dotnet', '.gradle', '.m2', '.android', '.ghcup', '.pyenv', '.rbenv', '.sbt', '.conda',
    'work', 'runners', 'actions-runner', 'hostedtoolcache', 'go', 'Library/Developer', 'Library/Android',
    // macOS asks for consent before a process may list these; no app writes there on its own
    'Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures',
  ].map((name) => join(home, name));
  const build = ['deps', 'build', 'incremental', '.fingerprint', 'examples', 'bundle'].map((name) => join(dirname(builtApp), name));
  const data = ['Package Cache', 'chocolatey', 'Microsoft/VisualStudio', 'Microsoft/Windows Defender', 'docker'].map((name) =>
    join(process.env.PROGRAMDATA ?? '/nonexistent', name),
  );
  return new Set([repo, out, process.env.RUNNER_TEMP, process.env.pnpm_config_store_dir, ...tools, ...build, ...data].filter(Boolean).map((p) => resolve(p)));
}

/** Map of path -> "type size mtime"; type is d, f, or l (anything that is not a plain file or directory). */
function snapshot(from = roots(), skip = excluded()) {
  const files = new Map();
  const errors = [];
  const stack = [...from];
  while (stack.length > 0) {
    const dir = stack.pop();
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      errors.push(`${e.code} ${dir}`);
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (skip.has(path)) continue;
      try {
        const st = fs.lstatSync(path);
        const type = st.isDirectory() ? 'd' : st.isFile() ? 'f' : 'l';
        files.set(path, `${type} ${st.size} ${Math.round(st.mtimeMs)}`);
        if (type === 'd') stack.push(path);
      } catch (e) {
        errors.push(`${e.code} ${path}`);
      }
    }
  }
  return { files, errors };
}

/** Entries are [path, type, size]. A directory whose mtime moved had entries created or removed in it. */
function diff(before, after) {
  const result = { added: [], changed: [], removed: [], touched: [] };
  for (const [path, value] of after.files) {
    const [type, size] = value.split(' ');
    const old = before.files.get(path);
    if (old === undefined) result.added.push([path, type, Number(size)]);
    else if (old !== value) result[type === 'd' ? 'touched' : 'changed'].push([path, type, Number(size)]);
  }
  for (const [path, value] of before.files) {
    if (!after.files.has(path)) result.removed.push([path, value[0], Number(value.split(' ')[1])]);
  }
  return result;
}

// ---- marker search ---------------------------------------------------------------------------

const KINDS = ['email', 'code', 'token', 'message', 'image', 'local'];
const flip = (text) => [...text].reduce((flipped, char) => char + flipped, '');

/** Which marked values occur in the buffer: "<kind>/<encoding>", "bare" being the marker alone. */
function search(buffer, marker) {
  const found = new Set();
  const backwards = flip(marker);
  for (const [encoding, label, width] of [['latin1', 'ascii', 1], ['utf16le', 'utf16', 2]]) {
    const needle = Buffer.from(marker, encoding);
    for (let at = buffer.indexOf(needle); at !== -1; at = buffer.indexOf(needle, at + 1)) {
      const tail = buffer.subarray(at + needle.length, at + needle.length + 10 * width).toString(encoding);
      found.add(`${KINDS.find((kind) => tail.startsWith(`-${kind}`)) ?? 'bare'}/${label}`);
    }
    // the image body ends with its own name backwards
    if (buffer.includes(Buffer.from(backwards, encoding))) found.add(`imagebody/${label}`);
  }
  return [...found].sort();
}

/** path -> list of hits, or ["unreadable:<code>"]; only for files that are new or changed. */
function scan(changes, marker) {
  const hits = {};
  for (const [path, type, size] of [...changes.added, ...changes.changed]) {
    if (type !== 'f') continue;
    try {
      if (size > 2 ** 30) throw Object.assign(new Error('too large'), { code: 'TOO_LARGE' });
      const found = search(fs.readFileSync(path), marker);
      if (found.length > 0) hits[path] = found;
    } catch (e) {
      hits[path] = [`unreadable:${e.code}`];
    }
  }
  return hits;
}

// ---- self-test -------------------------------------------------------------------------------

function selftest() {
  const failures = [];
  const check = (what, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok ? '' : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
    if (!ok) failures.push(what);
  };
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'disk-probe-selftest-'));
  const file = (name) => join(dir, name);
  const marker = 'cnrselftest';
  const noise = Buffer.alloc(300_000, 'x');
  fs.mkdirSync(file('kept'));
  fs.writeFileSync(file('to-change'), 'one');
  fs.writeFileSync(file('to-remove'), 'one');
  fs.writeFileSync(file('untouched'), 'one');
  const before = snapshot([dir], new Set());

  fs.writeFileSync(file('ascii'), Buffer.concat([noise, Buffer.from(`"${marker}-email@example.com"`), noise]));
  fs.writeFileSync(file('utf16'), Buffer.concat([noise, Buffer.from(`${marker}-token-1234`, 'utf16le'), noise]));
  fs.writeFileSync(file('body'), Buffer.concat([noise, Buffer.from(`gnp.eborp-egami-${flip(marker)}`)]));
  fs.writeFileSync(file('two'), `${marker}-code-123456 ${marker}-local ${marker}`);
  fs.writeFileSync(file('clean'), noise);
  fs.writeFileSync(file('nearly'), marker.slice(0, -1));
  fs.appendFileSync(file('to-change'), `two ${marker}-message-welcome`);
  fs.rmSync(file('to-remove'));
  fs.writeFileSync(join(file('kept'), 'transient'), marker);
  fs.rmSync(join(file('kept'), 'transient'));
  const changes = diff(before, snapshot([dir], new Set()));
  const names = (entries) => entries.map(([path]) => path.slice(dir.length + 1)).sort();

  check('new files are reported', names(changes.added), ['ascii', 'body', 'clean', 'nearly', 'two', 'utf16']);
  check('a changed file is reported', names(changes.changed), ['to-change']);
  check('a removed file is reported', names(changes.removed), ['to-remove']);
  // a file that came and went leaves only the mtime of its directory behind
  check('a directory that had a transient file is reported', names(changes.touched), ['kept']);
  const hits = scan(changes, marker);
  check(
    'the search finds every marked value and nothing else',
    Object.fromEntries(Object.entries(hits).map(([path, found]) => [path.slice(dir.length + 1), found]).sort(([a], [b]) => a.localeCompare(b))),
    {
      ascii: ['email/ascii'],
      body: ['imagebody/ascii'],
      'to-change': ['message/ascii'],
      two: ['bare/ascii', 'code/ascii', 'local/ascii'],
      utf16: ['token/utf16'],
    },
  );
  check('another marker finds nothing', scan(changes, 'cnrother'), {});
  fs.rmSync(dir, { recursive: true });
  if (failures.length > 0) {
    console.log(`self-test FAILED: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('self-test passed');
}

// ---- helpers ---------------------------------------------------------------------------------

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sh = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', ...options });
const save = (path, snap) => fs.writeFileSync(path, JSON.stringify({ files: [...snap.files], errors: snap.errors }));
const load = (path) => {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  return { files: new Map(raw.files), errors: raw.errors };
};

function timed(what, action) {
  const start = Date.now();
  const result = action();
  console.log(`${what}: ${result.files.size} entries, ${result.errors.length} unreadable, ${Date.now() - start} ms`);
  return result;
}

/** Processes of the app and its webview, with command lines. */
function processes() {
  const listing = {
    linux: () => sh('ps', ['-eww', '-o', 'pid,ppid,stat,args']),
    darwin: () => sh('ps', ['-axww', '-o', 'pid,ppid,command']),
    win32: () =>
      sh('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }']),
  }[platform]();
  return (listing.stdout ?? '').split(/\r?\n/).filter((line) => /probe-app|webkit|webview2|strace/i.test(line) && !/disk-probe\.mjs/.test(line));
}

// Windows: finds the renderer of the app's webview; "kill" ends it, "fault" starts a thread at an
// invalid address inside it, "break" starts a thread at DebugBreak (system libraries are mapped at
// the same address in every process), which raises an exception that nothing in the renderer handles.
const WINDOWS_CRASH = `
$ErrorActionPreference = 'Stop'
$renderer = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" |
  Where-Object { $_.CommandLine -match '--type=renderer' -and $_.CommandLine -match 'probe-app' } | Select-Object -First 1
if (-not $renderer) { Write-Output 'no renderer process found'; exit 1 }
$target = [int]$renderer.ProcessId
$process = Get-Process -Id $target
$null = $process.Handle
if ($env:DISK_CRASH -eq 'kill') {
  & "$env:SystemRoot\\System32\\taskkill.exe" /F /PID $target | Out-Null
} else {
  Add-Type -Namespace Probe -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
[DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandle(string name);
[DllImport("kernel32.dll", CharSet = CharSet.Ansi)] public static extern IntPtr GetProcAddress(IntPtr module, string name);
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateRemoteThread(IntPtr process, IntPtr attributes, UIntPtr stack, IntPtr start, IntPtr parameter, uint flags, IntPtr id);
'@
  $handle = [Probe.Native]::OpenProcess(0x1F0FFF, $false, [uint32]$target)
  if ($handle -eq [IntPtr]::Zero) { Write-Output "OpenProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }
  $start = [IntPtr]16
  if ($env:DISK_CRASH -eq 'break') { $start = [Probe.Native]::GetProcAddress([Probe.Native]::GetModuleHandle('kernel32.dll'), 'DebugBreak') }
  if ($start -eq [IntPtr]::Zero) { Write-Output 'DebugBreak not found'; exit 1 }
  $thread = [Probe.Native]::CreateRemoteThread($handle, [IntPtr]::Zero, [UIntPtr]::Zero, $start, [IntPtr]::Zero, 0, [IntPtr]::Zero)
  if ($thread -eq [IntPtr]::Zero) { Write-Output "CreateRemoteThread failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }
}
if (-not $process.WaitForExit(30000)) { Write-Output "renderer $target is still running"; exit 1 }
Write-Output ("renderer {0} ended with exit code 0x{1:X8}" -f $target, $process.ExitCode)
`;

/** Ends the web content process the way the variant asks for; returns a description of what happened. */
function crash(how) {
  if (platform === 'win32') {
    const result = sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CRASH], { env: { ...process.env, DISK_CRASH: how } });
    sleep(15_000);
    return `${result.stdout}${result.stderr}`.trim() + (result.status === 0 ? '' : '; still running afterwards: unknown');
  }
  const pattern = platform === 'darwin' ? /com\.apple\.WebKit\.WebContent/ : /WebKitWebProcess/;
  const pids = processes().filter((line) => pattern.test(line)).map((line) => Number(line.trim().split(/\s+/)[0]));
  // SIGABRT, not SIGSEGV: the JavaScript engine installs a SIGSEGV handler that survives a signal sent from outside
  for (const pid of pids) process.kill(pid, 'SIGABRT');
  // a core dump piped to a system service keeps the process around for a while
  const alive = () => processes().filter((line) => pids.some((pid) => line.trim().startsWith(`${pid} `)));
  for (let waited = 0; waited < 120_000 && alive().length > 0; waited += 5000) sleep(5000);
  const left = alive();
  // crash reports are written by a system service after the process is gone
  sleep(platform === 'darwin' ? 30_000 : 10_000);
  return `SIGABRT sent to ${pids.length} web content process(es): ${pids.join(' ')}; still running afterwards: ${left.length}`;
}

/** Runs while the app shows the data: process list, optional crash, snapshot and search. */
function hook() {
  const dir = process.env.DISK_OUT;
  const variant = JSON.parse(process.env.DISK_VARIANT);
  fs.writeFileSync(join(dir, 'processes.txt'), `${processes().join('\n')}\n`);
  if (variant.crash) {
    const outcome = crash(variant.crash);
    console.log(outcome);
    fs.writeFileSync(join(dir, 'crash.txt'), `${outcome}\n`);
    fs.appendFileSync(join(dir, 'processes.txt'), `\nafter the crash:\n${processes().join('\n')}\n`);
    // a crash that did not happen would make "no dump was written" meaningless
    if (!/ended with exit code|process\(es\): \d[\d ]*; still running afterwards: 0$/.test(outcome)) process.exitCode = 1;
  }
  const changes = diff(load(join(dir, 'before.json')), timed('snapshot while running', snapshot));
  fs.writeFileSync(join(dir, 'running.json'), JSON.stringify({ changes, hits: scan(changes, process.env.PROBE_MARKER) }));
}

/** What the traced app tree did to files: path -> { opened, calls, bytes, removed, hits }. */
function straceReport(log, marker) {
  const files = new Map();
  const at = (path) => files.get(path) ?? files.set(path, { opened: 0, calls: 0, bytes: 0, removed: false, hits: new Set() }).get(path);
  const real = (path) => path.startsWith('/') && !/^\/(dev|proc|sys)\//.test(path);
  // strace prints a NUL as \\0, or as \\000 in front of a digit
  const wide = [...marker].join('\\\\0(?:00)?');
  for (const line of fs.readFileSync(log, 'latin1').split('\n')) {
    if (/ = -1 E/.test(line)) continue;
    let m;
    if ((m = /\b(?:open|openat|creat)\((?:AT_FDCWD(?:<[^>]*>)?, )?"([^"]+)", ([A-Z_|]+)/.exec(line))) {
      if (/O_WRONLY|O_RDWR|O_CREAT/.test(m[2]) && real(m[1])) at(m[1]).opened += 1;
    } else if ((m = /\b(write|pwrite64|writev|pwritev)\(\d+<([^>]*)>, (.*)$/.exec(line))) {
      if (!real(m[2])) continue;
      const entry = at(m[2]);
      entry.calls += 1;
      const size = /, (\d+)(?:, \d+)?(?:\)| <unfinished)/.exec(m[3]);
      if (size && (m[1] === 'write' || m[1] === 'pwrite64')) entry.bytes += Number(size[1]);
      for (const hit of m[3].matchAll(new RegExp(`${marker}-(${KINDS.join('|')})|${wide}`, 'g'))) entry.hits.add(hit[1] ?? 'utf16');
    } else if ((m = /\b(?:unlink|unlinkat|rmdir)\((?:AT_FDCWD(?:<[^>]*>)?, )?"([^"]+)"/.exec(line))) {
      if (real(m[1])) at(m[1]).removed = true;
    } else if ((m = /\b(?:mkdir|mkdirat)\((?:AT_FDCWD(?:<[^>]*>)?, )?"([^"]+)"/.exec(line))) {
      if (real(m[1])) at(m[1]).opened += 1;
    }
  }
  return files;
}

/** "~/.cache/x/1a2b3c4d5e6f/y" style: home shortened, random-looking segments starred, depth capped. */
function shape(path) {
  const home = os.homedir();
  const short = path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  const parts = short.split(sep).map((part) => (/^[0-9a-f-]{12,}$|^[0-9A-F-]{12,}$/.test(part) ? '*' : part.replace(/\d+/g, '*')));
  return parts.length > 8 ? `${parts.slice(0, 8).join('/')}/...` : parts.join('/');
}

// ---- run ---------------------------------------------------------------------------------------

function makeBundle() {
  fs.rmSync(bundle, { recursive: true, force: true });
  fs.mkdirSync(dirname(appBin), { recursive: true });
  fs.copyFileSync(builtApp, appBin);
  fs.chmodSync(appBin, 0o755);
  const keys = {
    CFBundleExecutable: 'probe-app', CFBundleIdentifier: APP_ID, CFBundleName: 'Probe', CFBundleDisplayName: 'Probe',
    CFBundlePackageType: 'APPL', CFBundleShortVersionString: '0.1.0', CFBundleVersion: '0.1.0', CFBundleInfoDictionaryVersion: '6.0',
    LSMinimumSystemVersion: '10.13',
  };
  const body = Object.entries(keys).map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`).join('\n');
  fs.writeFileSync(
    join(bundle, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n  <key>NSHighResolutionCapable</key>\n  <true/>\n</dict>\n</plist>\n`,
  );
  const signed = sh('codesign', ['--force', '--sign', '-', bundle]);
  console.log(`bundle ${bundle}: codesign exit ${signed.status} ${signed.stderr.trim()}`);
}

function scenario(name, variant, dir, marker, phase) {
  const wrap = variant.strace ? `strace -f --seccomp-bpf -y -s 65536 -e trace=%file,write,pwrite64,writev,pwritev -o ${join(dir, `strace-${phase}.log`)}` : '';
  const env = {
    ...process.env,
    E2E_DRIVER: 'embedded',
    E2E_SPECS: './disk/disk.e2e.ts',
    E2E_RUN: `-${phase}`,
    E2E_ARTIFACTS: join(dir, 'e2e'),
    APP_BIN: appBin,
    DISK_BUILT_APP: builtApp,
    SERVER_BIN: serverBin,
    APP_WRAP: wrap,
    APP_ARGS: variant.appArgs ?? '',
    APP_QUIT: variant.quit ?? (platform === 'darwin' ? '--terminate' : '--quit'),
    PROBE_MARKER: marker,
    PROBE_SECRET_STORE: 'memory',
    PROBE_INCOGNITO: variant.incognito ? '1' : '0',
    DISK_PHASE: phase,
    DISK_OUT: dir,
    DISK_VARIANT: JSON.stringify(variant),
    DISK_PROBE: self,
    ...(variant.browserArgs ? { PROBE_BROWSER_ARGS: variant.browserArgs } : {}),
    ...variant.env,
  };
  const command = platform === 'linux' ? 'dbus-run-session -- xvfb-run -a pnpm e2e' : 'pnpm e2e';
  console.log(`::group::disk probe ${name}: ${phase}`);
  const status = spawnSync(command, { cwd: join(repo, 'ui'), env, shell: true, stdio: 'inherit' }).status;
  console.log('::endgroup::');
  return status;
}

/** Deletes what appeared since the baseline and returns the snapshot the next variant starts from. */
function reset(baseline, noise) {
  if (platform === 'darwin') {
    sh('defaults', ['delete', APP_ID]);
    sh('killall', ['cfprefsd']);
    sleep(2000);
  }
  const now = snapshot();
  if (process.env.DISK_RESET !== '1') return now;
  // deepest first, so that directories are empty by the time they are reached
  const extra = [...now.files.keys()].filter((path) => !baseline.files.has(path) && !noise.has(path)).sort((a, b) => b.length - a.length);
  let removed = 0;
  for (const path of extra) {
    try {
      fs.rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // still in use: it stays, and shows up as pre-existing in the next variant
    }
  }
  console.log(`reset: removed ${removed} of ${extra.length} entries that appeared since the baseline`);
  return removed > 0 ? snapshot() : now;
}

function run(names) {
  fs.mkdirSync(out, { recursive: true });
  const summary = [];
  const say = (line = '') => summary.push(line);
  const failures = [];
  if (platform === 'darwin') makeBundle();

  const notes = [];
  if (platform === 'linux') {
    notes.push(`core_pattern: ${fs.readFileSync('/proc/sys/kernel/core_pattern', 'utf8').trim()}`, `core size limit: ${sh('sh', ['-c', 'ulimit -c']).stdout.trim()}`);
  } else if (platform === 'darwin') {
    notes.push(`global NSQuitAlwaysKeepsWindows: ${sh('defaults', ['read', '-g', 'NSQuitAlwaysKeepsWindows']).stdout.trim() || 'not set'}`);
  } else {
    const wer = sh('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting', '/s']);
    fs.writeFileSync(join(out, 'windows-error-reporting.txt'), `${wer.stdout}${wer.stderr}`);
    notes.push(`Windows Error Reporting LocalDumps key present: ${/LocalDumps/i.test(wer.stdout)}`);
  }

  console.log(`roots: ${roots().join(', ')}`);
  const first = timed('control snapshot 1', snapshot);
  sleep(30_000);
  const baseline = timed('control snapshot 2', snapshot);
  const control = diff(first, baseline);
  const noise = new Set(Object.values(control).flat().map(([path]) => path));
  fs.writeFileSync(join(out, 'noise.txt'), `${[...noise].sort().join('\n')}\n`);
  fs.writeFileSync(join(out, 'unreadable.txt'), `${baseline.errors.join('\n')}\n`);

  say(`### Disk probe, ${platform} ${os.arch()}`);
  say();
  say(`Roots: ${roots().map((dir) => `\`${dir}\``).join(', ')}. ${baseline.files.size} entries, ${baseline.errors.length} unreadable directories.`);
  say(`Control interval of 30 s without the app: ${noise.size} entries changed on their own (listed in noise.txt).`);
  for (const note of notes) say(`${note}.`);
  say();
  say('| Variant | Scenario | Leave | localStorage after restart | New: own / other / noise | Changed: own / other / noise | Files with marked values |');
  say('|---|---|---|---|---|---|---|');
  const details = [];

  let start = baseline;
  for (const name of names) {
    const variant = VARIANTS[name];
    const marker = `cnr${Math.random().toString(16).slice(2, 10)}`;
    const dir = join(out, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    if (name !== names[0]) start = reset(baseline, noise);
    for (const [key, value] of Object.entries(variant.defaults ?? {})) sh('defaults', ['write', APP_ID, key, '-bool', value]);
    const before = variant.defaults ? snapshot() : start;
    save(join(dir, 'before.json'), before);

    const status = scenario(name, variant, dir, marker, 'scenario');
    sleep(platform === 'darwin' ? 10_000 : 5_000);
    const after = timed(`${name}: snapshot after`, snapshot);
    const changes = diff(before, after);
    const hits = scan(changes, marker);
    const running = fs.existsSync(join(dir, 'running.json')) ? JSON.parse(fs.readFileSync(join(dir, 'running.json'), 'utf8')) : undefined;
    if (platform === 'darwin') fs.writeFileSync(join(dir, 'defaults.txt'), `${sh('defaults', ['read', APP_ID]).stdout}`);
    // the restart shows what the webview kept; a crashed variant has nothing to restart for
    const verified = variant.crash ? undefined : scenario(name, variant, dir, marker, 'verify');
    const persisted = fs.existsSync(join(dir, 'persisted.txt')) ? fs.readFileSync(join(dir, 'persisted.txt'), 'utf8') : 'not read';
    const quitFile = join(dir, 'e2e', 'embedded-run-scenario-quit.txt');
    const quit = fs.existsSync(quitFile) ? fs.readFileSync(quitFile, 'utf8').trim() : 'killed by the harness';
    fs.rmSync(join(dir, 'before.json'));

    // one row per path: state after the app left, plus what was there only while it ran
    const rows = new Map();
    const row = (path) => rows.get(path) ?? rows.set(path, { path, after: '', running: '', type: '', size: 0, hits: [], runningHits: [] }).get(path);
    for (const [state, entries] of Object.entries(changes)) {
      for (const [path, type, size] of entries) Object.assign(row(path), { after: state, type, size, hits: hits[path] ?? [] });
    }
    for (const [state, entries] of Object.entries(running?.changes ?? {})) {
      for (const [path, type, size] of entries) {
        const entry = row(path);
        Object.assign(entry, { running: state, type: entry.type || type, size: entry.size || size, runningHits: running.hits[path] ?? [] });
      }
    }
    const list = [...rows.values()].sort((a, b) => a.path.localeCompare(b.path));
    for (const entry of list) entry.group = noise.has(entry.path) ? 'noise' : OWN.test(entry.path) ? 'own' : 'other';
    const tsv = list.map((e) => [e.group, e.after || '-', e.running || '-', e.type, e.size, [...new Set([...e.hits, ...e.runningHits])].join(',') || '-', e.path].join('\t'));
    fs.writeFileSync(join(dir, 'files.tsv'), `group\tafter\twhile-running\ttype\tsize\tmarked-values\tpath\n${tsv.join('\n')}\n`);

    let traced = '';
    const straceLog = join(dir, 'strace-scenario.log');
    if (variant.strace && fs.existsSync(straceLog)) {
      const files = [...straceReport(straceLog, marker)].sort(([a], [b]) => a.localeCompare(b));
      const lines = files.map(([path, f]) => [f.opened, f.calls, f.bytes, f.removed ? 'removed' : fs.existsSync(path) ? 'present' : 'gone', [...f.hits].join(',') || '-', path].join('\t'));
      fs.writeFileSync(join(dir, 'strace-files.tsv'), `opened-for-writing\twrite-calls\tbytes\tat-the-end\tmarked-values\tpath\n${lines.join('\n')}\n`);
      const marked = files.filter(([, f]) => f.hits.size > 0);
      traced = `strace: ${files.length} paths opened for writing, created or removed by the app tree, ${files.filter(([, f]) => f.calls > 0).length} written to; marked values in writes to ${marked.length}: ${marked.map(([path, f]) => `\`${shape(path)}\` (${[...f.hits].join(', ')})`).join('; ') || 'none'}`;
      // the raw log holds every path the app tree touched; keep only the digest
      for (const phase of ['scenario', 'verify']) fs.rmSync(join(dir, `strace-${phase}.log`), { force: true });
    }

    const count = (state, group) => list.filter((e) => e.after === state && e.group === group && e.type !== 'd').length;
    const marked = list.filter((e) => e.hits.some((hit) => !hit.startsWith('unreadable')));
    const markedRunning = list.filter((e) => e.runningHits.some((hit) => !hit.startsWith('unreadable')) && !marked.includes(e));
    const unreadable = list.filter((e) => [...e.hits, ...e.runningHits].some((hit) => hit.startsWith('unreadable')));
    const localOnDisk = marked.some((e) => e.hits.some((hit) => hit.startsWith('local/')));

    const checks = [['the scenario passed', status === 0]];
    if (!variant.crash) {
      checks.push(['the restarted app could be read', verified === 0]);
      if (variant.quit !== '') checks.push(['the app left on request', quit.startsWith('graceful')]);
      if (variant.incognito) {
        checks.push(['incognito: localStorage is empty after a restart', persisted === 'null']);
        checks.push(['incognito: the localStorage value is in no file', !localOnDisk]);
      } else {
        checks.push(['localStorage survives a restart', persisted === `${marker}-local`]);
        // without this the search would be blind to the webview's own storage format
        checks.push(['the search finds the localStorage value on disk', localOnDisk]);
      }
    }
    const failed = checks.filter(([, ok]) => !ok).map(([what]) => what);
    for (const what of failed) failures.push(`${name}: ${what}`);

    say(`| ${name} | ${status === 0 ? 'pass' : 'FAIL'} | ${variant.quit === '' ? 'process killed' : quit} | ${variant.crash ? 'n/a' : persisted === 'null' ? 'empty' : persisted.endsWith('-local') ? 'kept' : persisted} | ${count('added', 'own')} / ${count('added', 'other')} / ${count('added', 'noise')} | ${count('changed', 'own')} / ${count('changed', 'other')} / ${count('changed', 'noise')} | ${marked.length} after, ${markedRunning.length} more while running |`);

    details.push(`#### ${name}`, '', `Settings: \`${JSON.stringify(variant)}\`.`);
    if (failed.length > 0) details.push(`**Failed checks: ${failed.join('; ')}.**`);
    if (fs.existsSync(join(dir, 'crash.txt'))) details.push(`Crash: ${fs.readFileSync(join(dir, 'crash.txt'), 'utf8').trim().replaceAll('\n', ' / ')}.`);
    if (traced) details.push(`${traced}.`);
    if (unreadable.length > 0) details.push(`Not searched (unreadable): ${unreadable.length} file(s), see files.tsv.`);
    details.push('', '| Marked values | After | While running | Size | Path |', '|---|---|---|---|---|');
    for (const e of [...marked, ...markedRunning]) details.push(`| ${[...new Set([...e.hits, ...e.runningHits])].join(', ')} | ${e.after || '-'} | ${e.running || '-'} | ${e.size} | \`${shape(e.path)}\` |`);
    if (marked.length + markedRunning.length === 0) details.push('| none | | | | |');
    // everything that is not runner noise, folded by path shape
    const shapes = new Map();
    for (const e of list) {
      if (e.group === 'noise' || e.type === 'd') continue;
      const key = `${e.group}\t${e.after || `${e.running} only while running`}\t${shape(dirname(e.path))}`;
      const item = shapes.get(key) ?? shapes.set(key, { files: 0, bytes: 0 }).get(key);
      item.files += 1;
      item.bytes += e.size;
    }
    details.push('', '<details><summary>Files outside the control noise, by directory</summary>', '', '| Group | State | Directory | Files | Bytes |', '|---|---|---|---|---|');
    const folded = [...shapes].sort(([a], [b]) => a.localeCompare(b));
    for (const [key, item] of folded.slice(0, 150)) details.push(`| ${key.split('\t').join(' | ')} | ${item.files} | ${item.bytes} |`);
    if (folded.length > 150) details.push(`| | | ${folded.length - 150} more directories, see files.tsv | | |`);
    details.push('', '</details>', '');
    for (const key of Object.keys(variant.defaults ?? {})) sh('defaults', ['delete', APP_ID, key]);
  }

  say();
  say('"own" paths carry the application identifier or binary name; "noise" paths also changed during the control interval. Marked values: `kind/encoding`, kinds being email, code, token, message, image (name), imagebody, local (localStorage), bare (the marker alone, as in the environment).');
  say();
  summary.push(...details);
  if (failures.length > 0) say(`**Disk probe checks failed: ${failures.join('; ')}**`);
  fs.writeFileSync(join(out, 'summary.md'), `${summary.join('\n')}\n`);
  console.log(failures.length > 0 ? `disk probe: FAILED checks: ${failures.join('; ')}` : `disk probe: all checks passed for ${names.length} variant(s)`);
  process.exit(failures.length > 0 ? 1 : 0);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'selftest') selftest();
else if (command === 'hook') hook();
else if (command === 'run') {
  const unknown = rest.filter((name) => !VARIANTS[name]);
  if (unknown.length > 0) throw new Error(`unknown variant(s): ${unknown.join(', ')}`);
  run(rest.length > 0 ? rest : PLAN[platform]);
} else {
  console.error('usage: disk-probe.mjs <selftest | run [variant..] | hook>');
  process.exit(2);
}
