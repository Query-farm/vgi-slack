/** Fetch immutable source and run it with the notebook's frozen protocol-runtime overlay.
 * Installation output goes to stderr: stdout belongs to the VGI Arrow protocol.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const [repository, revision, entrypoint, ...workerArgs] = process.argv.slice(2);
if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || !revision || !/^[0-9a-f]{40}$/.test(revision)
    || !entrypoint || isAbsolute(entrypoint) || entrypoint.split('/').includes('..')) {
  throw new Error('Usage: bun run github_worker.ts owner/repo FULL_COMMIT relative/worker.ts');
}
const runtimeRoot = join(dirname(import.meta.path), 'runtime');
const runtimeFiles = ['package.json', 'bun.lock'];
const runtimeHash = new Bun.CryptoHasher('sha256');
for (const name of runtimeFiles) runtimeHash.update(readFileSync(join(runtimeRoot, name)));
const runtimeDigest = runtimeHash.digest('hex');
const cacheRoot = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'vgi-notebook-workers', repository);
mkdirSync(cacheRoot, { recursive: true });
const checkout = join(cacheRoot, `${revision}-bun-${Bun.version}-runtime-${runtimeDigest.slice(0,16)}`);
const ready = join(checkout, '.notebook-worker-ready');
const lock = checkout + '.lock';
const deadline = Date.now() + 180_000;
let ownsLock = false;
while (!existsSync(ready)) {
  try { mkdirSync(lock); ownsLock = true; break; }
  catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for worker cache lock: ${lock}`);
    await Bun.sleep(250);
  }
}
if (ownsLock) {
  let staging: string | undefined;
  try {
    if (!existsSync(ready)) {
      staging = mkdtempSync(join(cacheRoot, '.install-'));
      const run = (command: string, args: string[]) => {
        const result = spawnSync(command, args, { cwd: staging, stdio: ['ignore', 2, 2] });
        if (result.error || result.status !== 0) throw new Error(`Worker setup failed: ${command} ${args.join(' ')}`, { cause: result.error });
      };
      run('git', ['init', '--quiet']);
      run('git', ['remote', 'add', 'origin', `https://github.com/${repository}.git`]);
      run('git', ['fetch', '--quiet', '--depth', '1', 'origin', revision]);
      run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
      const actual = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: staging, encoding: 'utf8' });
      if (actual.status !== 0 || actual.stdout.trim() !== revision) throw new Error('Fetched revision did not match the pinned commit.');
      if (!existsSync(join(staging, 'bun.lock')) && !existsSync(join(staging, 'bun.lockb'))) throw new Error('Pinned worker has no Bun lockfile.');
      for (const name of runtimeFiles) copyFileSync(join(runtimeRoot, name), join(staging, name));
      run(process.execPath, ['install', '--frozen-lockfile']);
      writeFileSync(join(staging, '.notebook-worker-ready'), JSON.stringify({ repository, revision, bun: Bun.version, runtimeDigest }));
      renameSync(staging, checkout);
      staging = undefined;
    }
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}
const marker = JSON.parse(readFileSync(ready, 'utf8'));
if (marker.repository !== repository || marker.revision !== revision || marker.bun !== Bun.version || marker.runtimeDigest !== runtimeDigest) {
  throw new Error(`Worker cache marker does not match this pin: ${checkout}`);
}
if (!existsSync(join(checkout, entrypoint))) throw new Error(`Worker entrypoint is missing: ${entrypoint}`);
const child = Bun.spawn([process.execPath, 'run', join(checkout, entrypoint), ...workerArgs], {
  cwd: checkout, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: process.env,
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal));
process.exit(await child.exited);
