import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { ProcessRunner } = loadDist('engine/process.js');

// node itself is the subject under test: it is guaranteed present, behaves identically on every
// platform, and lets a case emit exactly the bytes it wants to.
const NODE = process.execPath;
const script = (source) => ({ args: ['-e', source], timeoutMs: 15_000 });

test('stdout is captured line by line, with the exit code', async () => {
  const result = await new ProcessRunner().run(NODE, script('console.log("one"); console.log("two")'));

  assert.deepEqual(result.stdout, ['one', 'two']);
  assert.equal(result.code, 0);
});

test('stderr is kept separate from stdout', async () => {
  const result = await new ProcessRunner().run(NODE, script('console.log("out"); console.error("err")'));

  assert.deepEqual(result.stdout, ['out']);
  assert.deepEqual(result.stderr, ['err']);
});

test('a non-zero exit resolves with the code rather than throwing', async () => {
  // The callers inspect `code` and turn it into a message the user sees; a rejection here would
  // lose the output that explains what actually went wrong.
  const result = await new ProcessRunner().run(NODE, script('process.exit(3)'));

  assert.equal(result.code, 3);
});

test('a line split across two writes is reassembled, not emitted as halves', async () => {
  // The failure this guards against is silent: a caller matching on a whole line (say
  // "Failed to load snapshot") simply never matches when the chunk boundary lands mid-word.
  const source = 'process.stdout.write("abc"); setTimeout(() => process.stdout.write("def\\n"), 60)';
  const lines = [];
  const result = await new ProcessRunner().run(NODE, {
    ...script(source),
    onLog: (_stream, line) => lines.push(line),
  });

  assert.deepEqual(result.stdout, ['abcdef']);
  assert.deepEqual(lines, ['abcdef']);
});

test('output with no trailing newline is still delivered', async () => {
  // Regression: the splitter held a partial line waiting for a newline that never came, so the
  // last line was dropped and the caller saw empty output with a successful exit code. `adb shell
  // getprop` answering with a bare value has exactly this shape.
  const lines = [];
  const result = await new ProcessRunner().run(NODE, {
    ...script('process.stdout.write("no newline here")'),
    onLog: (_stream, line) => lines.push(line),
  });

  assert.deepEqual(result.stdout, ['no newline here']);
  assert.deepEqual(lines, ['no newline here']);
});

test('a trailing partial line on stderr survives too', async () => {
  const result = await new ProcessRunner().run(NODE, script('process.stderr.write("dying words")'));

  assert.deepEqual(result.stderr, ['dying words']);
});

test('a command that overruns its timeout rejects and the child is killed', async () => {
  const started = Date.now();
  await assert.rejects(
    () => new ProcessRunner().run(NODE, { args: ['-e', 'setTimeout(() => {}, 30000)'], timeoutMs: 300 }),
    /timed out after 300ms/,
  );
  assert.ok(Date.now() - started < 10_000, 'rejected promptly rather than waiting the child out');
});

test('commands are serialized, because the runtimes share pid and state files', async () => {
  const runner = new ProcessRunner();
  const order = [];

  const slow = runner
    .run(NODE, script('setTimeout(() => console.log("slow"), 250)'))
    .then(() => order.push('slow'));
  const fast = runner.run(NODE, script('console.log("fast")')).then(() => order.push('fast'));

  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['slow', 'fast'], 'the second command waited for the first');
});

test('a failed command does not poison the queue', async () => {
  const runner = new ProcessRunner();

  await assert.rejects(() => runner.run(NODE, { args: ['-e', 'setTimeout(()=>{},9999)'], timeoutMs: 200 }));
  const after = await runner.run(NODE, script('console.log("still works")'));

  assert.deepEqual(after.stdout, ['still works']);
});

test('a missing executable rejects rather than hanging', async () => {
  await assert.rejects(() => new ProcessRunner().run('definitely-not-a-real-binary-xyz', { timeoutMs: 5_000 }));
});

test('an unqueued read answers while a long command holds the queue', async () => {
  const runner = new ProcessRunner();
  const held = runner.run(NODE, script('setTimeout(() => console.log("held"), 400)'));

  const peek = await runner.runUnqueued(NODE, script('console.log("peek")'));
  assert.deepEqual(peek.stdout, ['peek'], 'did not wait behind the queued command');

  await held;
});

test('arguments are passed as argv, so nothing re-splits or re-parses them', async () => {
  // The whole class of bug this removes: under WSL this value crossed bash twice and needed
  // double quoting to survive. As argv it is simply one argument.
  const nasty = 'a b"c\'d $HOME `whoami` ;rm -rf';
  const result = await new ProcessRunner().run(NODE, {
    args: ['-e', 'process.stdout.write(process.argv[1])', '--', nasty],
    timeoutMs: 15_000,
  });

  assert.deepEqual(result.stdout, [nasty]);
});
