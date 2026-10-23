import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { readStableRegularFile } from './bounded-local-file.mjs';
import { assertNoSecretValues, sha256 } from './util.mjs';
import {
  normalizeBlastSourcePaths, normalizeBlastTestCommands,
  prepareBlastControllerRun, prepareBlastWorktreeBaseline, createBlastCandidateWorktree,
  runBlastTests,
} from './cerebras-blast-worktree.mjs';
import { writerSandboxExecutable } from './writer-sandbox.mjs';

const MAX_FILE = 180_000;
const MAX_TOTAL = 768_000;
const MAX_OUTPUT = 16_000;
const ROLES = new Set(['halo_coordinator','halo_scout', 'halo_reviewer', 'r9700_builder', 'r9700_tester', 'r9700b_builder', 'r9700b_tester', 'rtx3090_scout', 'rtx3090_reviewer', 'rtx3090_builder', 'rtx3090_tester']);
const readOnlyRole=role=>/_(?:scout|reviewer)$/.test(role);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const errorCode = e => /^[A-Z][A-Z0-9_]{0,79}$/.test(e?.code ?? '') ? e.code : 'ADVISOR_WORKSPACE_FAILED';
const comparable = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const contains = (a, b) => { const r = path.relative(a, b); return !r || (r !== '..' && !r.startsWith(`..${path.sep}`) && !path.isAbsolute(r)); };
function exact(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(value, k))) fail('ADVISOR_TOOL_ARGUMENT_INVALID');
}
function text(value, maximum, nonempty = false) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum || value.includes('\0') || (nonempty && !value.length)) fail('ADVISOR_TOOL_ARGUMENT_INVALID');
  assertNoSecretValues(value, 'advisor-tool-text');
  return value;
}
function exactPaths(values) {
  if (!Array.isArray(values) || values.some(p => typeof p !== 'string' || p.length > 512 || p.split('/').length > 20)) fail('ADVISOR_SCOPE_INVALID');
  const normalized = normalizeBlastSourcePaths(values);
  assertNoSecretValues(normalized, 'advisor-source-paths');
  if (normalized.length !== values.length || values.some(p => !normalized.includes(p))) fail('ADVISOR_SCOPE_INVALID');
  return normalized;
}
export function validateAdvisorCommands(commands = [], role) {
  if (!ROLES.has(role)) fail('ADVISOR_ROLE_INVALID');
  if (!Array.isArray(commands) || commands.length > 12) fail('ADVISOR_COMMAND_INVALID');
  if (readOnlyRole(role) && commands.length) fail('SCOUT_REVIEWER_READ_ONLY');
  const ids = new Set();
  return commands.map((c, commandIndex) => {
    exact(c, ['id', 'argv', 'timeoutMs'], ['id', 'argv']);
    assertNoSecretValues(c, 'advisor-command');
    if (typeof c.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(c.id) || ids.has(c.id)) fail('ADVISOR_COMMAND_INVALID');
    ids.add(c.id);
    if (c.timeoutMs !== undefined && (!Number.isInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 600_000)) fail('ADVISOR_COMMAND_INVALID');
    if (Array.isArray(c.argv) && typeof c.argv[0] === 'string' && ['node','node.exe'].includes(c.argv[0].toLowerCase()) &&
        c.argv.slice(1).some(arg => ['-e','--eval','-p','--print'].includes(arg))) {
      throw Object.assign(new Error('ADVISOR_INLINE_COMMAND_DENIED'), {
        code:'ADVISOR_INLINE_COMMAND_DENIED', packetDetails:{commandIndex},
      });
    }
    let normalized;
    try { normalized = normalizeBlastTestCommands([{ argv: c.argv, timeoutMs: c.timeoutMs ?? 120_000 }])[0]; }
    catch(error) { error.packetDetails={commandIndex}; throw error; }
    return { id: c.id, ...normalized };
  });
}
function definition(name, description, properties, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}
const stringSchema = { type: 'string' };
async function canonicalDirectory(directory, create = false) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('ADVISOR_ROOT_INVALID');
  const absolute = path.resolve(directory);
  let cursor = path.parse(absolute).root;
  for (const part of path.relative(cursor, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = await fs.lstat(cursor); }
    catch (e) {
      if (e.code !== 'ENOENT' || !create) throw e;
      await fs.mkdir(cursor);
      stat = await fs.lstat(cursor);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || comparable(await fs.realpath(cursor)) !== comparable(cursor)) fail('ADVISOR_PATH_UNSAFE');
  }
  return absolute;
}
async function safeTarget(root, relative, { makeParents = false } = {}) {
  const target = path.resolve(root, relative);
  if (!contains(root, target) || target === root) fail('ADVISOR_PATH_UNSAFE');
  await canonicalDirectory(root);
  let cursor = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    let stat;
    try { stat = await fs.lstat(cursor); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (i < parts.length - 1 && makeParents) { await fs.mkdir(cursor); stat = await fs.lstat(cursor); }
      else continue;
    }
    if (stat.isSymbolicLink() || comparable(await fs.realpath(cursor)) !== comparable(cursor) ||
        (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail('ADVISOR_PATH_UNSAFE');
  }
  return target;
}
async function readContent(root, relative) {
  const target = await safeTarget(root, relative);
  try { await fs.lstat(target); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const stable = await readStableRegularFile(target, { maximumBytes: MAX_FILE, requireSingleLink: true });
  if (comparable(stable.realPath) !== comparable(target)) fail('ADVISOR_PATH_UNSAFE');
  const content = stable.bytes.toString('utf8');
  if (!Buffer.from(content).equals(stable.bytes)) fail('ADVISOR_CONTENT_INVALID');
  text(content, MAX_FILE);
  return content;
}

/** Constructor-only sandboxRunner is a deterministic-test seam; never derive it from request or inference. */
export async function createAdvisorToolWorkspace({ request, snapshot, id = crypto.randomUUID(),
  stateRoot = '/SETUP_REQUIRED/path-17', executionRoot = '/SETUP_REQUIRED/path-18', signal,
  sandboxRunner,
} = {}) {
  try {
    if (!request || !ROLES.has(request.role)) fail('ADVISOR_ROLE_INVALID');
    const sourceFiles = exactPaths(request.sourceFiles ?? []);
    const allowedFiles = exactPaths(request.allowedFiles ?? []);
    if (readOnlyRole(request.role) && allowedFiles.length) fail('SCOUT_REVIEWER_READ_ONLY');
    if (request.role.endsWith('_builder') && !allowedFiles.length) fail('BUILDER_OWNERSHIP_REQUIRED');
    const declared = [...new Set([...sourceFiles, ...allowedFiles])];
    if (declared.length > 64 || new Set(declared.map(p => p.toLowerCase())).size !== declared.length) fail('ADVISOR_SCOPE_INVALID');
    const commandList = validateAdvisorCommands(request.commands ?? [], request.role);
    const repository = await canonicalDirectory(request.directory);
    if (!snapshot || !Array.isArray(snapshot.files) || snapshot.files.length !== declared.length) fail('ADVISOR_SNAPSHOT_INVALID');
    const files = snapshot.files.map(file => {
      exact(file, ['path', 'content', 'sha256', 'writable']);
      if (!declared.includes(file.path) || typeof file.writable !== 'boolean' || file.writable !== allowedFiles.includes(file.path)) fail('ADVISOR_SNAPSHOT_INVALID');
      if (file.content !== null) text(file.content, MAX_FILE);
      else if (!file.writable) fail('ADVISOR_SNAPSHOT_INVALID');
      const hash = file.content === null ? 'ABSENT' : sha256(file.content);
      if (file.sha256 !== hash) fail('ADVISOR_SNAPSHOT_INVALID');
      return { ...file };
    });
    if (new Set(files.map(f => f.path)).size !== files.length) fail('ADVISOR_SNAPSHOT_INVALID');
    const total = files.reduce((sum, f) => sum + Buffer.byteLength(f.content ?? ''), 0);
    if (total > MAX_TOTAL || !Number.isSafeInteger(snapshot.bytes) || snapshot.bytes !== total) fail('ADVISOR_SNAPSHOT_INVALID');
    // Verify original source binding before materialization, and again at finish.
    async function verifySource() {
      for (const file of files) {
        const content = await readContent(repository, file.path);
        if ((content === null ? 'ABSENT' : sha256(content)) !== file.sha256) fail('ADVISOR_SOURCE_CHANGED');
      }
    }
    await verifySource();
    if (signal?.aborted) fail('ADVISOR_TOOL_CANCELLED');
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,80}$/.test(id)) fail('ADVISOR_ID_INVALID');
    for (const root of [stateRoot, executionRoot]) {
      if (typeof root !== 'string' || !path.isAbsolute(root) || contains(repository, path.resolve(root)) || contains(path.resolve(root), repository)) fail('ADVISOR_ROOT_OVERLAP');
    }
    if (contains(path.resolve(stateRoot), path.resolve(executionRoot)) || contains(path.resolve(executionRoot), path.resolve(stateRoot))) fail('ADVISOR_ROOT_OVERLAP');
    await canonicalDirectory(stateRoot, true);
    await canonicalDirectory(executionRoot, true);
    const run = await prepareBlastControllerRun({ stateRoot, executionRoot, workspaceRoot: repository, blastId: `advisor-${id}`, workerIds: ['attempt'] });
    const converted = { repositoryRoot: repository, totalBytes: total, files: files.map(f => ({ path: f.path, exists: f.content !== null,
      bytes: Buffer.from(f.content ?? ''), text: f.content ?? '', sha256: f.sha256 })) };
    const baseline = await prepareBlastWorktreeBaseline({ repositoryRoot: repository, baselineRoot: path.join(run.executionRunRoot, 'baseline'), controllerRoot: run.executionRunRoot, snapshot: converted, sourceDirectoryOnly: true });
    const candidate = await createBlastCandidateWorktree({ repositoryRoot: repository, worktreeRoot: run.worktreesRoot, controllerRoot: run.executionRunRoot, workerId: 'attempt', snapshot: converted, preparedBaseline: baseline, sourceDirectoryOnly: true });
    const worktree = candidate.worktree;
    const rootIdentity = await fs.lstat(worktree);
    const gitMarker = await readContent(worktree, '.git');
    const names = new Set(declared);
    const writable = new Set(allowedFiles);
    const directories = new Set();
    for (const p of declared) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/')); }
    let closed = false, finished = false, poisoned = false, isolatedWrites = 0, tail = Promise.resolve();
    const commands = [], toolEvents = [];
    const sourceManifest = files.map(({ content, ...rest }) => rest);
    assertNoSecretValues(sourceManifest, 'advisor-source-manifest');
    async function preserveEvidence() {
      await run.artifactWriter.json('advisor-tool-evidence.json', { sourceManifest, worktree, commands, toolEvents, sourceWrites: 0, isolatedWrites, closed, finished, integrityFailed: poisoned });
    }
    async function integrity() {
      await canonicalDirectory(worktree);
      if (!sameIdentity(rootIdentity, await fs.lstat(worktree))) fail('ADVISOR_PATH_UNSAFE');
      const contents = new Map();
      let size = 0, entries = 0, markerSeen = false;
      async function walk(directory, prefix = '') {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (++entries > 2048) fail('ADVISOR_SCOPE_CHANGED');
          const p = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) { if (!directories.has(p)) fail('ADVISOR_SCOPE_CHANGED'); await canonicalDirectory(path.join(worktree, p)); await walk(path.join(worktree, p), p); }
          else {
            if (p !== '.git' && !names.has(p)) fail('ADVISOR_SCOPE_CHANGED');
            const content = await readContent(worktree, p);
            if (content === null) fail('ADVISOR_SCOPE_CHANGED');
            if (p === '.git') { markerSeen = true; if (content !== gitMarker) fail('ADVISOR_SCOPE_CHANGED'); }
            else { size += Buffer.byteLength(content); contents.set(p, content); }
          }
        }
      }
      await walk(worktree);
      if (!markerSeen) fail('ADVISOR_SCOPE_CHANGED');
      if (!contents.size && files.some(f => f.content !== null)) fail('ADVISOR_SCOPE_CHANGED');
      if (size > MAX_TOTAL) fail('ADVISOR_CONTENT_LIMIT');
      for (const f of files) {
        const current = contents.get(f.path) ?? null;
        if (!writable.has(f.path) && current !== f.content) fail('ADVISOR_READONLY_CHANGED');
        if (f.content !== null && current === null) fail('ADVISOR_SCOPE_CHANGED');
      }
      return contents;
    }
    await integrity();
    async function checkIntegrity() {
      try { return await integrity(); } catch (e) { poisoned = true; throw e; }
    }
    await preserveEvidence();
    const readPages = new Map();
    let canCommand = false;
    if (commandList.length) {
      if (sandboxRunner !== undefined) { if (typeof sandboxRunner !== 'function') fail('ADVISOR_SANDBOX_INVALID'); canCommand = true; }
      else if (process.platform === 'win32') { try { await fs.access(writerSandboxExecutable()); canCommand = true; } catch {} }
    }
    const definitions = [
      definition('list_files', 'List only declared source files; optional literal path substring.', { query: { type: 'string', maxLength: 256 } }),
      definition('read_file', 'Read declared text once. Omit offset to continue the next unread page automatically. Explicit offset is a zero-based line; column continues a long line. Follow nextRead until complete. Unchanged repeated ranges return a reference to the earlier read, not duplicate text.', { path: stringSchema, offset: { type: 'integer', minimum: 0, maximum: 100000 }, column: { type: 'integer', minimum: 0, maximum: MAX_FILE }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['path']),
      definition('search_files', 'Search declared files for a literal substring; at most 50 bounded matching lines.', { query: { type: 'string', minLength: 1, maxLength: 256 } }, ['query']),
    ];
    if (allowedFiles.length) definitions.push(
      definition('write_file', 'Write complete text to an exact allowed file in the isolated worktree.', { path: stringSchema, content: stringSchema }, ['path', 'content']),
      definition('edit_file', 'Replace exactly one occurrence of oldText in an exact allowed file. Identical replacements are rejected as ADVISOR_EDIT_NO_CHANGE; provide an actual change.', { path: stringSchema, oldText: stringSchema, newText: stringSchema }, ['path', 'oldText', 'newText']),
    );
    if (canCommand) definitions.push(definition('run_command', 'Run a parent-declared command by ID, offline with a read-only snapshot. No command text is accepted.', { id: { type: 'string', enum: commandList.map(c => c.id) } }, ['id']));
    const enabled = new Set(definitions.map(d => d.function.name));
    function serial(operation) { const result = tail.then(operation); tail = result.catch(() => {}); return result; }
    async function execute(name, args) {
      return serial(async () => {
        let executionStarted = false;
        try {
          if (closed || finished) fail('ADVISOR_WORKSPACE_CLOSED');
          if (poisoned) fail('ADVISOR_WORKSPACE_INTEGRITY_FAILED');
          if (signal?.aborted) fail('ADVISOR_TOOL_CANCELLED');
          if (typeof name !== 'string' || !enabled.has(name)) fail('ADVISOR_TOOL_UNAVAILABLE');
          if (toolEvents.length >= 256) fail('ADVISOR_TOOL_LIMIT');
          const schema = definitions.find(d => d.function.name === name).function.parameters;
          exact(args, Object.keys(schema.properties), schema.required);
          for (const [key, value] of Object.entries(args)) {
            const prop = schema.properties[key];
            if (prop.type === 'string') text(value, key === 'content' || key === 'oldText' || key === 'newText' ? MAX_FILE : 512, prop.minLength > 0);
            if (prop.type === 'integer' && (!Number.isInteger(value) || value < prop.minimum || value > prop.maximum)) fail('ADVISOR_TOOL_ARGUMENT_INVALID');
            if (prop.maxLength !== undefined && value.length > prop.maxLength) fail('ADVISOR_TOOL_ARGUMENT_INVALID');
          }
          const before = await checkIntegrity();
          let result;
          if (name === 'list_files') {
            const query = args.query === undefined ? '' : text(args.query, 256);
            const selected = sourceManifest.filter(f => f.path.includes(query)).map(f => ({ ...f, exists: before.has(f.path) }));
            const bounded = [];
            for (const f of selected) { if (JSON.stringify([...bounded, f]).length > MAX_OUTPUT - 100) break; bounded.push(f); }
            result = { files: bounded, truncated: bounded.length !== selected.length };
          } else if (name === 'search_files') {
            const query = text(args.query, 256, true), matches = []; let truncated = false;
            for (const [p, content] of before) {
              const lines = content.split('\n');
              for (let i = 0; i < lines.length; i++) if (lines[i].includes(query)) {
                if (matches.length >= 50) { truncated = true; break; }
                const match = { path: p, line: i + 1, text: lines[i].slice(0, 200) };
                if (JSON.stringify([...matches, match]).length > MAX_OUTPUT - 100) { truncated = true; break; }
                matches.push(match);
              }
            }
            result = { matches, truncated };
          } else if (name === 'run_command') {
            const command = commandList.find(c => c.id === args.id);
            if (typeof args.id !== 'string' || !command) fail('ADVISOR_COMMAND_UNDECLARED');
            executionStarted = true;
            const testResult = await runBlastTests({ worktree, commands: [command], signal, sandboxRoot: path.join(run.sandboxWorkerRoots.attempt, `run-${commands.length + 1}`), allowedFiles: [], ...(sandboxRunner ? { sandboxRunner } : {}) });
            const observed = testResult.commands[0];
            if (observed) commands.push({ id: command.id, ...observed, stdout: String(observed.stdout ?? '').slice(0, MAX_OUTPUT / 2), stderr: String(observed.stderr ?? '').slice(0, MAX_OUTPUT / 2), stdoutTruncated: observed.stdoutTruncated || String(observed.stdout ?? '').length > MAX_OUTPUT / 2, stderrTruncated: observed.stderrTruncated || String(observed.stderr ?? '').length > MAX_OUTPUT / 2 });
            if (!observed || JSON.stringify(observed.argv) !== JSON.stringify(command.argv) || comparable(observed.cwd) !== comparable(worktree) ||
                !(observed.exitCode === null || Number.isInteger(observed.exitCode)) || typeof observed.timedOut !== 'boolean' || typeof observed.canceled !== 'boolean' ||
                observed.sandboxAttestation?.networkIsolationMode !== 'offline' ||
                ['jobKillOnClose','jobAssigned','jobDrained','childIsAppContainer','childTokenRestricted','sterileEnvironment','workingDirectoryInsideWorktree','reparseChecksPassed','hardlinkChecksPassed','aclsRestored'].some(k => observed.sandboxAttestation?.[k] !== true)) fail('ADVISOR_SANDBOX_ATTESTATION_FAILED');
            const after = await checkIntegrity();
            if (JSON.stringify([...before]) !== JSON.stringify([...after])) fail('ADVISOR_COMMAND_WRITES');
            result = commands.at(-1);
          } else {
            if (typeof args.path !== 'string' || !names.has(args.path)) fail('ADVISOR_FILE_UNDECLARED');
            if (name === 'read_file') {
              const file = before.get(args.path);
              if (file === undefined) fail('ADVISOR_FILE_ABSENT');
              const digest = sha256(file);
              let state = readPages.get(args.path);
              if (!state || state.sha256 !== digest) { state = { sha256: digest, next: { offset: 0, column: 0 }, pages: new Map() }; readPages.set(args.path, state); }
              if (args.column !== undefined && args.offset === undefined) fail('ADVISOR_TOOL_ARGUMENT_INVALID');
              const offset = args.offset ?? state.next.offset, column = args.offset === undefined ? state.next.column : (args.column ?? 0), limit = args.limit ?? 200;
              if ((args.offset !== undefined && typeof args.offset !== 'number') || (args.limit !== undefined && typeof args.limit !== 'number') || !Number.isInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 200) fail('ADVISOR_TOOL_ARGUMENT_INVALID');
              const lines = file.split('\n');
              if (offset > lines.length || offset === lines.length && state.next.offset < lines.length) fail('ADVISOR_TOOL_ARGUMENT_INVALID');
              if (column > (lines[offset]?.length ?? 0)) fail('ADVISOR_TOOL_ARGUMENT_INVALID');
              const key = `${offset}:${column}:${limit}`, previous = state.pages.get(key);
              if (previous || offset >= lines.length) {
                result = { path: args.path, sha256: digest, alreadyRead: true, previousReadId: previous?.readId, complete: state.next.offset >= lines.length, nextRead: state.next.offset < lines.length ? { path: args.path, ...state.next } : null, instruction: 'Use the earlier content already in this conversation. Read nextRead only if needed; otherwise edit, test, delegate or finish.' };
              } else {
                const selected = lines.slice(offset, offset + limit).join('\n').slice(column);
                let content = selected.slice(0, 8000);
                while (Buffer.byteLength(JSON.stringify(content)) > 11000) content = content.slice(0, Math.floor(content.length / 2));
                const parts = content.split('\n');
                let next = { offset: offset + parts.length - 1, column: (parts.length === 1 ? column : 0) + parts.at(-1).length };
                if (next.column === lines[next.offset]?.length) next = { offset: next.offset + 1, column: 0 };
                const readId = `read-${toolEvents.length + 1}`;
                state.pages.set(key, { readId, start: { offset, column }, end: next });
                // Advance only across contiguous observed ranges. Reading the end
                // first must not mark an unseen prefix as read.
                const compare = (a,b) => a.offset-b.offset || a.column-b.column;
                let advanced;
                do { advanced=false; for(const page of state.pages.values())if(compare(page.start,state.next)<=0&&compare(page.end,state.next)>0){state.next=page.end;advanced=true;} } while(advanced);
                const complete = state.next.offset >= lines.length;
                result = { path: args.path, sha256: digest, readId, content, offset, column, totalLines: lines.length, complete, truncated: !complete, nextRead: complete ? null : { path: args.path, ...state.next } };
              }
            } else {
              if (!writable.has(args.path)) fail('ADVISOR_FILE_READONLY');
              let content;
              if (name === 'write_file') content = text(args.content, MAX_FILE);
              else {
                const oldText = text(args.oldText, MAX_FILE, true), newText = text(args.newText, MAX_FILE);
                const current = before.get(args.path);
                if (current === undefined) fail('ADVISOR_FILE_ABSENT');
                const first = current.indexOf(oldText);
                if (first < 0 || current.indexOf(oldText, first + 1) >= 0) fail('ADVISOR_EDIT_NOT_UNIQUE');
                content = text(current.slice(0, first) + newText + current.slice(first + oldText.length), MAX_FILE);
              }
              if (before.get(args.path) === content) fail('ADVISOR_EDIT_NO_CHANGE');
              if ([...before].reduce((n, [p,c]) => n + (p === args.path ? 0 : Buffer.byteLength(c)), Buffer.byteLength(content)) > MAX_TOTAL) fail('ADVISOR_CONTENT_LIMIT');
              const target = await safeTarget(worktree, args.path, { makeParents: true });
              executionStarted = true;
              const flags = constants.O_WRONLY | constants.O_CREAT | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
              const handle = await fs.open(target, flags, 0o600);
              try {
                const opened = await handle.stat();
                const bound = await fs.lstat(target);
                if (!opened.isFile() || opened.nlink !== 1 || bound.isSymbolicLink() || !sameIdentity(opened, bound)) fail('ADVISOR_PATH_UNSAFE');
                await safeTarget(worktree, args.path);
                await handle.writeFile(content, 'utf8');
                await handle.truncate(Buffer.byteLength(content));
              } finally { await handle.close(); }
              isolatedWrites++;
              await checkIntegrity();
              result = { path: args.path, sha256: sha256(content), bytes: Buffer.byteLength(content), isolated: true };
            }
          }
          toolEvents.push({ name, status: 'SUCCEEDED', ...(args.path ? { path: args.path } : {}), ...(name === 'read_file' ? { offset: result.offset, column: result.column, sha256: result.sha256, alreadyRead: result.alreadyRead === true, nextRead: result.nextRead } : {}), ...(name === 'run_command' ? { id: args.id } : {}) });
          await preserveEvidence();
          return { ok: true, ...result };
        } catch (e) {
          const code = errorCode(e);
          if (executionStarted || /SCOPE_CHANGED|READONLY_CHANGED|COMMAND_WRITES|PATH_UNSAFE|ATTESTATION_FAILED|CONTENT_CHANGED|PATH_CHANGED|LINK_INVALID/.test(code)) poisoned = true;
          if (toolEvents.length < 256) toolEvents.push({ name: enabled.has(name) ? name : 'unknown', status: 'FAILED', code });
          try { await preserveEvidence(); } catch { poisoned = true; }
          return { ok: false, error: { code } };
        }
      });
    }
    return { definitions, execute, worktree, commandEvidence:()=>commands.map(c=>({id:c.id,exitCode:c.exitCode,timedOut:c.timedOut,canceled:c.canceled,stdout:c.stdout?.slice(-2000),stderr:c.stderr?.slice(-2000)})),
      finish: () => serial(async () => {
        try {
          if (closed || finished) fail('ADVISOR_WORKSPACE_CLOSED');
          if (poisoned) fail('ADVISOR_WORKSPACE_INTEGRITY_FAILED');
          if (signal?.aborted) fail('ADVISOR_TOOL_CANCELLED');
          const current = await checkIntegrity(); await verifySource();
          const changed = files.filter(f => writable.has(f.path) && (current.get(f.path) ?? null) !== f.content).map(f => ({ path: f.path, content: current.get(f.path) }));
          finished = true;
          await preserveEvidence();
          return { files: changed, sourceManifest, worktree, commands, toolEvents, sourceWrites: 0, isolatedWrites };
        } catch (e) { poisoned = true; try { await preserveEvidence(); } catch {} fail(errorCode(e)); }
      }),
      close: () => serial(async () => { closed = true; try { await preserveEvidence(); } catch (e) { fail(errorCode(e)); } /* Preserve worktree and failed evidence; never clean caller files. */ }),
    };
  } catch (e) { fail(errorCode(e)); }
}
