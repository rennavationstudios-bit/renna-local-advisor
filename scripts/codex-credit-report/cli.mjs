#!/usr/bin/env node
import { readFile, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildReport, renderMarkdown } from './report.mjs';

const help = `Offline Codex-credit closing report (Node.js 22+)\nnode cli.mjs --input input.json --json report.json --md report.md\nUses bundled rates.json. Explicit input only; outputs must be new files.\nExit 0: reports written. Exit 1: invalid input or I/O failure.\n`;
function parse(args) {
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (!['--input', '--json', '--md'].includes(flag) || Object.hasOwn(options, flag)) {
      throw new Error('Unknown or repeated option: ' + flag);
    }
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error('Missing value: ' + flag);
    options[flag] = path.resolve(value);
  }
  for (const flag of ['--input', '--json', '--md']) if (!options[flag]) throw new Error('Required ' + flag);
  const keys = Object.values(options).map(p => p.normalize('NFC').toLowerCase());
  if (new Set(keys).size !== keys.length) throw new Error('Input and output paths must be distinct');
  return options;
}
async function assertNew(file) {
  try { await lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Output already exists: ' + file);
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(help); return; }
  const options = parse(args);
  const input = JSON.parse(await readFile(options['--input'], 'utf8'));
  const rates = JSON.parse(await readFile(new URL('./rates.json', import.meta.url), 'utf8'));
  const report = buildReport(input, rates);
  const json = JSON.stringify(report, null, 2) + '\n';
  const markdown = renderMarkdown(report);
  await assertNew(options['--json']);
  await assertNew(options['--md']);
  await writeFile(options['--json'], json, { encoding: 'utf8', flag: 'wx' });
  await writeFile(options['--md'], markdown, { encoding: 'utf8', flag: 'wx' });
}
main().catch(error => { process.stderr.write('Error: ' + error.message + '\n'); process.exitCode = 1; });
