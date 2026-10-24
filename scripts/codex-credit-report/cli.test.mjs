import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const example = JSON.parse(await readFile(new URL('./example.json', import.meta.url), 'utf8'));
async function fixture(t) {
  const scratch = path.resolve(os.tmpdir());
  const dir = await mkdtemp(path.join(scratch, 'codex-credit-test-'));
  t.after(async () => { assert.ok(dir.startsWith(scratch + path.sep)); await rm(dir, { recursive: true, force: true }); });
  const input = path.join(dir, 'input.json'), json = path.join(dir, 'report.json'), md = path.join(dir, 'report.md');
  await writeFile(input, JSON.stringify(example));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
  return { dir, input, json, md, run, args: ['--input', input, '--json', json, '--md', md] };
}
test('CLI writes explicit JSON and Markdown; preserves input and refuses existing output', async t => {
  const f = await fixture(t), before = await readFile(f.input);
  const result = f.run(...f.args); assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await readFile(f.json, 'utf8'));
  assert.equal(report.basis, 'codex_credits'); assert.equal(report.counts.accepted, 1);
  assert.match(await readFile(f.md, 'utf8'), /credit/i);
  const prior = await readFile(f.json);
  assert.equal(f.run(...f.args).status, 1); assert.deepEqual(await readFile(f.json), prior); assert.deepEqual(await readFile(f.input), before);
});
test('invalid input creates neither output', async t => {
  const f = await fixture(t); await writeFile(f.input, JSON.stringify({ ...example, receipts: [example.receipts[0], example.receipts[0]] }));
  assert.equal(f.run(...f.args).status, 1);
  await assert.rejects(stat(f.json), { code: 'ENOENT' }); await assert.rejects(stat(f.md), { code: 'ENOENT' });
});
test('second pre-existing output prevents first creation, input aliases and repeated args rejected', async t => {
  const f = await fixture(t); await writeFile(f.md, 'preserve');
  assert.equal(f.run(...f.args).status, 1); await assert.rejects(stat(f.json), { code: 'ENOENT' }); assert.equal(await readFile(f.md, 'utf8'), 'preserve');
  assert.equal(f.run('--input', f.input, '--json', f.input, '--md', f.md).status, 1);
  assert.equal(f.run(...f.args, '--input', f.input).status, 1); assert.equal(f.run('--help').status, 0); assert.equal(f.run('--wat').status, 1);
});
