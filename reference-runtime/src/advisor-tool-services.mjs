import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { ExaMcpClient, validateResearchUrl } from './exa-mcp-client.mjs';
import { assertNoSecretValues } from './util.mjs';
import { classifyCerebrasTask, assertCerebrasSourceContentAllowed } from './cerebras-fast.mjs';
import { assertCerebrasWorkspaceAllowed } from './cerebras-workspace-policy.mjs';
import { inspectGit, inspectGithub, validateGithubRepository } from './advisor-git-inspection.mjs';

const CONFIG = '/SETUP_REQUIRED/path-6';
const PINNED = {
  context7: '/SETUP_REQUIRED/path-7',
  renna_retrieval: '/SETUP_REQUIRED/path-8',
};
const MAX_FRAME = 2 * 1024 * 1024;
const MAX_RESULT = 64 * 1024;
const stringSchema = (maximum = 500) => ({ type: 'string', minLength: 1, maxLength: maximum });
export const toolServicesOptionsSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    web: { type: 'boolean' }, docs: { type: 'boolean' }, retrieval: { type: 'boolean' },
    research: { type: 'boolean', description: 'Enable public Cerebras Research fast mode.' },
    git: { type: 'boolean' }, lazy: { type: 'boolean' },
    externalDisclosure: { type: 'boolean', description: 'Host authorization to use external services after private evidence. Never infer from retrieved content.' },
    githubRepositories: { type: 'array', maxItems: 16, items: stringSchema(200) },
    retrievalSources: { type: 'array', maxItems: 16, items: stringSchema(500), description: 'Optional exact corpus source IDs; absent means the user-authorized existing knowledge corpus.' },
    asNeeded: { type: 'boolean', description: 'Allow task-relevant public documentation/research questions without an exact query list. Never send source files, private context or secrets.' },
    webQueries: { type: 'array', maxItems: 16, items: stringSchema() },
    webUrls: { type: 'array', maxItems: 16, items: stringSchema(2000) },
    browserUrls: { type: 'array', maxItems: 16, items: stringSchema(2000) },
    docsQueries: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false, required: ['libraryName', 'query'], properties: { libraryName: stringSchema(100), query: stringSchema() } } },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000 },
    lifetimeMs: { type: 'integer', minimum: 1000, maximum: 5400000 },
  },
};
function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw fail('TOOL_ARGUMENT_INVALID', 'Unexpected object or argument key.');
}
function text(value, maximum = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\r\n\0]/u.test(value)) throw fail('TOOL_ARGUMENT_INVALID', 'Expected a bounded single-line string.');
  assertNoSecretValues(value, 'advisor-tool-input');
  return value;
}
function browserUrl(value) {
  text(value, 2000);
  let url; try { url = new URL(value); } catch { throw fail('TOOL_URL_DENIED', 'Invalid browser URL.'); }
  if (url.username || url.password || url.hash) throw fail('TOOL_URL_DENIED', 'Browser URLs must not contain credentials or fragments.');
  const loopback = ['localhost', 'SETUP_REQUIRED_ADDRESS_1', '[::1]'].includes(url.hostname);
  if (loopback) {
    if (!['http:', 'https:'].includes(url.protocol)) throw fail('TOOL_URL_DENIED', 'Loopback requires HTTP(S).');
    // Apply the same path/query secret checks without allowing a private public-web URL.
    const publicForm = new URL(url.href); publicForm.hostname = 'example.com'; publicForm.protocol = 'https:'; publicForm.port = '';
    validateResearchUrl(publicForm.href);
    return url.href;
  }
  return validateResearchUrl(value);
}
export function validateToolServicesOptions(value = {}) {
  object(value, Object.keys(toolServicesOptionsSchema.properties));
  const out = {};
  for (const key of ['web', 'docs', 'retrieval', 'research', 'asNeeded', 'git', 'lazy', 'externalDisclosure']) { if (value[key] !== undefined && typeof value[key] !== 'boolean') throw fail('TOOL_OPTIONS_INVALID', 'Service switches must be booleans.'); out[key] = value[key] ?? false; }
  for(const key of ['githubRepositories','retrievalSources']) {const values=value[key]??[];if(!Array.isArray(values)||values.length>16)throw fail('TOOL_OPTIONS_INVALID','Invalid scope.');out[key]=values.map(v=>key==='githubRepositories'?validateGithubRepository(v):text(v));}
  for (const key of ['webQueries', 'webUrls', 'browserUrls', 'docsQueries']) {
    const list = value[key] ?? [];
    if (!Array.isArray(list) || list.length > 16) throw fail('TOOL_OPTIONS_INVALID', 'Approval capsules must be bounded arrays.');
    out[key] = list.map(item => {
      if (key === 'docsQueries') { object(item, ['libraryName', 'query']); return { libraryName: text(item.libraryName, 100), query: text(item.query) }; }
      if (key === 'browserUrls') return browserUrl(item);
      return key === 'webUrls' ? validateResearchUrl(item) : text(item);
    });
  }
  for (const [key, fallback, maximum] of [['timeoutMs', 60000, 60000], ['lifetimeMs', 120000, 5400000]]) {
    out[key] = value[key] ?? fallback;
    if (!Number.isInteger(out[key]) || out[key] < 1000 || out[key] > maximum) throw fail('TOOL_OPTIONS_INVALID', 'Invalid service time budget.');
  }
  if ((!out.web && (out.webQueries.length || out.webUrls.length)) || (!out.docs && out.docsQueries.length)) throw fail('TOOL_OPTIONS_INVALID', 'Approval capsules require their service switch.');
  return out;
}
function definition(name, description, properties = {}) { return { type: 'function', function: { name, description, parameters: { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) }, strict: true } }; }
function cleanResult(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_RESULT) throw fail('TOOL_RESULT_TOO_LARGE', 'External tool result exceeded its bounded size.');
  // Credential-shaped tool output must not enter model context, even from a trusted launcher.
  assertNoSecretValues(value, 'advisor-tool-result');
  assertNoSecretValues(serialized, 'advisor-tool-result');
  return JSON.parse(serialized);
}
function minimalEnv(declared = {}) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  for (const [key, value] of Object.entries(declared)) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || typeof value !== 'string') throw fail('TOOL_CONFIG_INVALID', 'Invalid declared MCP environment.');
    const match = /^\{env:([A-Z][A-Z0-9_]*)\}$/u.exec(value);
    const resolved = match ? process.env[match[1]] : value;
    if (resolved) env[key] = resolved;
  }
  return env;
}
async function loadLaunch(name) {
  let config; try { config = JSON.parse(await readFile(CONFIG, 'utf8')); } catch { throw fail('TOOL_CONFIG_UNAVAILABLE', 'Trusted OpenCode MCP configuration is unavailable.'); }
  const entry = config.mcp?.[name];
  const normalize = p => String(p).replaceAll('\\', '/').toLowerCase();
  if (entry?.type !== 'local' || entry.enabled === false || !Array.isArray(entry.command) || entry.command.length !== 2 || normalize(entry.command[0]) !== '/SETUP_REQUIRED/path-9' || normalize(entry.command[1]) !== normalize(PINNED[name])) throw fail('TOOL_CONFIG_DENIED', 'MCP launcher differs from the pinned trusted installation.');
  const allowedEnv = name === 'context7' ? ['CONTEXT7_API_KEY'] : ['RENNA_RETRIEVAL_CONFIG'];
  if (Object.keys(entry.environment ?? {}).some(k => !allowedEnv.includes(k))) throw fail('TOOL_CONFIG_DENIED', 'MCP launcher declares an unexpected environment key.');
  return { command: entry.command[0], args: entry.command.slice(1), env: minimalEnv(entry.environment) };
}

// Newline-delimited MCP stdio; no generic executable or tools/call surface is exported.
class StdioClient {
  constructor(launch, spawnImpl = spawn) {
    this.child = spawnImpl(launch.command, launch.args, { env: launch.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map(); this.nextId = 1; this.buffer = Buffer.alloc(0); this.closed = false;
    this.child.stderr.on('data', () => {}); // Never retain credential-bearing server stderr.
    this.child.stdout.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length > MAX_FRAME) { this.close(); return; }
      let newline;
      while ((newline = this.buffer.indexOf(10)) >= 0) {
        const line = this.buffer.subarray(0, newline); this.buffer = this.buffer.subarray(newline + 1);
        if (!line.length) continue;
        let message; try { message = JSON.parse(line.toString('utf8')); } catch { this.close(); return; }
        if (message.jsonrpc !== '2.0') { this.close(); return; }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error || message.result?.isError) pending.reject(fail('TOOL_MCP_FAILED', 'MCP reported a tool failure.'));
        else pending.resolve(message.result);
      }
    });
    this.child.on('error', () => this.close()); this.child.on('exit', () => this.close());
    this.child.stdin.on('error', () => this.close());
  }
  request(method, params = {}) {
    if (this.closed) return Promise.reject(fail('TOOL_MCP_CLOSED', 'MCP service is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  }
  async initialize(required) {
    const result = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'advisor-readonly-tools', version: '1.0.0' } });
    if (!result?.serverInfo?.name || !['2025-06-18', '2024-11-05', '2025-03-26'].includes(result.protocolVersion)) throw fail('TOOL_MCP_INVALID', 'MCP initialization contract mismatch.');
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const listed = await this.request('tools/list');
    if (!required.every(name => listed?.tools?.some(tool => tool.name === name))) throw fail('TOOL_MCP_INVALID', 'Required read-only MCP tools are unavailable.');
  }
  call(name, args) { return this.request('tools/call', { name, arguments: args }); }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(fail('TOOL_MCP_CLOSED', 'MCP service was stopped.'));
    this.pending.clear(); this.child.stdin.destroy(); this.child.kill();
  }
}
function toolText(result) { return (result?.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n'); }
function toolData(result) { if (result?.structuredContent) return result.structuredContent; const value = toolText(result); try { return JSON.parse(value); } catch { return { text: value }; } }

async function pinnedPageFetch(url, signal, budget) {
  const parsed = new URL(browserUrl(url));
  const isLoopback = ['localhost', 'SETUP_REQUIRED_ADDRESS_1', '[::1]'].includes(parsed.hostname);
  const addresses = await lookup(parsed.hostname.replace(/^\[|\]$/gu, ''), { all: true });
  if (!addresses.length || addresses.some(({ address }) => {
    if (isLoopback) return !['SETUP_REQUIRED_ADDRESS_1', '::1'].includes(address);
    try { validateResearchUrl(`https://${address.includes(':') ? `[${address}]` : address}/`); return false; } catch { return true; }
  })) throw fail('TOOL_URL_DENIED', 'Browser DNS resolved outside its permitted address scope.');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const request = (parsed.protocol === 'https:' ? https : http).request(parsed, {
      method: 'GET', signal, headers: { accept: 'text/html,text/css;q=0.9,*/*;q=0.1' },
      lookup: (_host, opts, callback) => callback(null, opts?.all ? [selected] : selected.address, selected.family),
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 || response.headers['content-disposition']?.includes('attachment')) { response.destroy(); reject(fail('TOOL_BROWSER_REDIRECT_DENIED', 'Browser redirects and downloads are disabled.')); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; budget.bytes += chunk.length; if (size > MAX_FRAME || budget.bytes > MAX_FRAME) { response.destroy(); reject(fail('TOOL_RESULT_TOO_LARGE', 'Browser response exceeded its bounded size.')); } else chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode, contentType: response.headers['content-type'] ?? 'text/plain', body: Buffer.concat(chunks) }));
      response.on('error', () => reject(fail('TOOL_BROWSER_FETCH_FAILED', 'Browser resource fetch failed.')));
    });
    request.on('error', () => reject(fail('TOOL_BROWSER_FETCH_FAILED', 'Browser resource fetch failed.'))); request.end();
  });
}
async function staticSnapshot(url, signal, registerClose, dependencies, diagnostic = null) {
  const require = createRequire('/SETUP_REQUIRED/path-10');
  const playwright = dependencies.playwright ?? (await import(pathToFileURL(require.resolve('playwright')).href)).default;
  const server = await playwright.chromium.launchServer({ channel: 'msedge', headless: true, timeout: 10000, env: minimalEnv(), args: ['--disable-background-networking', '--disable-sync', '--disable-extensions'] });
  const stop = async () => { try { await server.kill(); } catch { server.process()?.kill(); } };
  registerClose(stop);
  const onAbort = () => { void stop(); }; signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) throw fail('TOOL_ABORTED', 'Browser snapshot was aborted.');
    const browser = await playwright.chromium.connect(server.wsEndpoint());
    const context = await browser.newContext({ javaScriptEnabled: Boolean(diagnostic), serviceWorkers: 'block', acceptDownloads: false,...(diagnostic?{viewport:{width:diagnostic.viewport==='mobile'?390:1365,height:diagnostic.viewport==='mobile'?844:900}}:{}) });
    if(diagnostic){if(!context.routeWebSocket)throw fail('TOOL_BROWSER_UNSUPPORTED','Installed runtime cannot block WebSockets.');await context.routeWebSocket('**/*',ws=>ws.close());}
    const consoleErrors=[],pageErrors=[],networkFailures=[],blocked=[];
    const safeUrl=u=>{try{const p=new URL(u);return p.origin+p.pathname;}catch{return '[invalid URL]';}};
    const record=(list,item)=>{if(list.length<20)list.push(item);};
    const target = new URL(url); const budget = { bytes: 0, requests: 0 }; let routeFailure;
    await context.route('**/*', async route => {
      try {
        const request = route.request(); const candidate = new URL(request.url());
        const allowedTypes=diagnostic?['document','stylesheet','script','image','font','xhr','fetch']:['document','stylesheet'];
        // JavaScript cannot invent a query-string exfiltration target. API/resource
        // URLs containing query strings need an exact host-approved URL capsule.
        const queryAllowed=!candidate.search||(diagnostic?.allowedUrls??[url]).includes(candidate.href);
        if (++budget.requests > (diagnostic?64:32) || candidate.origin !== target.origin || request.method() !== 'GET' || !queryAllowed || !allowedTypes.includes(request.resourceType()) || (request.isNavigationRequest() && candidate.href !== target.href)) { record(blocked,{url:safeUrl(candidate.href),method:request.method()});await route.abort(); return; }
        const response = await pinnedPageFetch(candidate.href, signal, budget);
        await route.fulfill(response);
      } catch (error) { routeFailure = error; try { await route.abort(); } catch {} }
    });
    const page = await context.newPage();
    page.on('dialog',d=>{void d.dismiss();});
    if(diagnostic){
      page.on('console',m=>{if(['error','warning'].includes(m.type()))record(consoleErrors,{type:m.type(),text:m.text().slice(0,800)});});
      page.on('pageerror',e=>record(pageErrors,String(e.message).slice(0,800)));
      page.on('requestfailed',r=>record(networkFailures,{url:safeUrl(r.url()),failure:r.failure()?.errorText}));
      page.on('response',r=>{if(r.status()>=400)record(networkFailures,{url:safeUrl(r.url()),status:r.status()});});
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (routeFailure) throw routeFailure;
    if(diagnostic)await page.waitForTimeout(350);
    const snapshot = (await page.locator('body').ariaSnapshot({ timeout: 10000 })).slice(0,10000);
    if(diagnostic){
      const layout=await page.evaluate(()=>({title:document.title,viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,horizontalOverflow:document.documentElement.scrollWidth>innerWidth}));
      const result={url,viewport:diagnostic.viewport,snapshot,layout,consoleErrors,pageErrors,networkFailures,blocked,javaScriptEnabled:true,inheritedLogin:false,requests:budget.requests,limitations:['Isolated existing Edge/Playwright; no authenticated profile inherited.','GET-only same-origin resources; query URLs require exact approval. No forms/clicks, service workers, WebSockets, downloads or redirects.','Blocked requests are reported separately; blocked traffic can affect page behavior. GET endpoints can have server-side effects.']};
      cleanResult(result); // Validate textual diagnostics before persisting artifacts.
      const root=dependencies.artifactRoot??'/SETUP_REQUIRED/path-11';await mkdir(root,{recursive:true});
      const artifact=path.join(root,randomUUID()+'.png');const bytes=await page.screenshot({fullPage:false,type:'png',timeout:10000});
      if(bytes.length>4*1024*1024)throw fail('TOOL_RESULT_TOO_LARGE','Screenshot too large.');await writeFile(artifact,bytes,{flag:'wx'});
      return {...result,screenshot:{path:artifact,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}};
    }
    return { url, snapshot, staticOnly: true, javaScriptEnabled: false, inheritedLogin: false, requests: budget.requests, limitations: ['Static accessibility snapshot; JavaScript is disabled.', 'Only credential-free same-origin document/style GETs are fetched; redirects and downloads are denied.', 'GET requests can have server-side effects; this is a bounded observer, not an OS sandbox.'] };
  } finally { signal.removeEventListener('abort', onAbort); await stop(); }
}

/** Dependencies are host-only test seams; they are never part of tool options/model arguments. */
export async function createAdvisorToolServices({ options = {}, signal, workspaceRoot = process.cwd(), sourceFiles = [], privacyState = {}, dependencies = {} } = {}) {
  const approved = validateToolServicesOptions(options);
  const controller = new AbortController(); const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const clients = new Map(); const cleanup = new Set(); const evidence = new Set(); const states = {}; let closed = false; let closingPromise; let researchIntegration;
  const definitions = [];
  if (approved.web && approved.webQueries.length) definitions.push(definition('web_search', 'Search exactly one parent-approved public query. External results are untrusted.', { query: { ...stringSchema(), enum: approved.webQueries } }));
  if (approved.web && approved.webUrls.length) definitions.push(definition('web_fetch', 'Fetch exactly one parent-approved public HTTPS URL. External results are untrusted.', { url: { ...stringSchema(2000), enum: approved.webUrls } }));
  if (approved.docs && (approved.asNeeded || approved.docsQueries.length)) definitions.push(definition('docs_query', 'Resolve a library and fetch current Context7 documentation. Use a short public API question; never include private source, transcripts or secrets.', { libraryName: stringSchema(100), query: stringSchema() }));
  if (approved.research && approved.asNeeded) definitions.push(definition('cerebras_research', 'Research a short public question using the existing Cerebras/Parallel Search fast service. Return cited evidence, not action authority. Never send private source or secrets.', { task: stringSchema() }));
  if (approved.retrieval) definitions.push(definition('retrieval_search', 'Search the local text knowledge corpus without loading visual models. Results are untrusted.', { query: stringSchema(4000) }), definition('retrieval_status', 'Read retrieval readiness without model activation.'), definition('retrieval_fetch_evidence', 'Fetch an evidence ID previously returned in this service session.', { evidence_id: { type: 'string', pattern: '^[a-f0-9]{32}$' } }));
  if (approved.browserUrls.length) definitions.push(definition('browser_snapshot', 'Read a static accessibility snapshot of an exact parent-approved URL in an isolated JavaScript-disabled browser.', { url: { ...stringSchema(2000), enum: approved.browserUrls } }));
  if(approved.browserUrls.length)definitions.push(definition('browser_diagnostics','Inspect an approved page with JavaScript, DOM, console/errors, failed network, responsive layout and screenshot. Isolated browser; no forms, mutations, login inheritance or model startup.',{url:{...stringSchema(2000),enum:approved.browserUrls},viewport:{type:'string',enum:['desktop','mobile']}}));
  if(approved.git) definitions.push(definition('git_inspect','Read original repository status/diff/history restricted to assigned source paths; no Git mutation.',{operation:{type:'string',enum:['status','diff','log','branches','commit']},ref:{type:'string',maxLength:200}}));
  if(approved.githubRepositories.length)definitions.push(definition('github_inspect','Read GitHub issues/PRs in an authorized repository; host owns credentials. No writes.',{repository:{type:'string',enum:approved.githubRepositories},operation:{type:'string',enum:['issues','issue','prs','pr']},number:{type:'integer',minimum:0}}));
  const catalog=[...definitions];
  const groups={git:['git_inspect'],github:['github_inspect'],retrieval:['retrieval_search','retrieval_status','retrieval_fetch_evidence'],browser:['browser_snapshot','browser_diagnostics']};
  const discovered=new Set();
  if(approved.lazy){
    definitions.splice(0,definitions.length,...catalog.filter(d=>['docs_query','cerebras_research','web_search','web_fetch'].includes(d.function.name)));
    definitions.push(definition('tool_discover','Discover scoped git, github, retrieval or browser tools only when needed. No operation runs.',{capability:{type:'string',enum:Object.keys(groups)}}),definition('tool_call','Call a discovered inspection tool with JSON arguments. Scope stays host-controlled.',{name:stringSchema(80),arguments:stringSchema(8000)}));
  }
  const exa = dependencies.exaClient ?? new ExaMcpClient();
  const close = () => {
    if (closed) return closingPromise ?? Promise.resolve();
    closed = true; clearTimeout(lifetime); combined.removeEventListener('abort', onAbort); controller.abort();
    for (const client of clients.values()) client.close();
    closingPromise = Promise.allSettled([...cleanup].map(fn => fn()));
    return closingPromise;
  };
  const onAbort = () => { void close(); };
  const lifetime = setTimeout(onAbort, approved.lifetimeMs); lifetime.unref?.();
  combined.addEventListener('abort', onAbort, { once: true });
  async function mcp(name) {
    if (!clients.has(name)) {
      const launch = await (dependencies.loadLaunch ?? loadLaunch)(name);
      if (combined.aborted || closed) throw fail('TOOL_CLOSED', 'Tool services are closed.');
      const client = new StdioClient(launch, dependencies.spawnImpl); clients.set(name, client);
      await client.initialize(name === 'context7' ? ['resolve-library-id', 'query-docs'] : ['search', 'fetch_evidence', 'status']); states[name] = 'ready';
    }
    return clients.get(name);
  }
  let queue = Promise.resolve();
  const execute = (name, args = {}) => {
    if(approved.lazy&&name==='tool_discover'){
      if(closed||combined.aborted)return Promise.reject(fail('TOOL_CLOSED','Tool services are closed.'));
      object(args,['capability']);if(!Object.hasOwn(groups,args.capability))return Promise.reject(fail('TOOL_ARGUMENT_INVALID','Unknown capability.'));
      const selected=catalog.filter(d=>groups[args.capability].includes(d.function.name));for(const d of selected)discovered.add(d.function.name);
      return Promise.resolve({capability:args.capability,tools:selected.map(d=>d.function),scopeRequired:!selected.length,scopeHint:args.capability==='browser'?'Parent supplies exact browserUrls.':args.capability==='github'?'Parent supplies githubRepositories.':null});
    }
    if(approved.lazy&&name==='tool_call'){
      object(args,['name','arguments']);if(!discovered.has(args.name)||typeof args.arguments!=='string'||args.arguments.length>8000)return Promise.reject(fail('TOOL_DENIED','Discover the scoped tool first.'));
      let parsed;try{parsed=JSON.parse(args.arguments);}catch{return Promise.reject(fail('TOOL_ARGUMENT_INVALID','Invalid tool JSON.'));}
      return execute(args.name,parsed);
    }
    const operation = async () => {
      if (closed || combined.aborted) throw fail('TOOL_CLOSED', 'Tool services are closed.');
      const schema = catalog.find(item => item.function.name === name)?.function.parameters;
      if (!schema) throw fail('TOOL_DENIED', 'This tool is not enabled.');
      object(args, schema.required); for (const key of schema.required) if (!(key in args)) throw fail('TOOL_ARGUMENT_INVALID', 'Required argument missing.');
      // Validate before launching any child or creating a public request.
      if (name === 'web_search' && !approved.webQueries.includes(text(args.query))) throw fail('TOOL_APPROVAL_DENIED', 'Public query was not approved by the parent.');
      if (name === 'web_fetch' && !approved.webUrls.includes(args.url)) throw fail('TOOL_APPROVAL_DENIED', 'Public URL was not approved by the parent.');
      if (name === 'docs_query' && !approved.asNeeded && !approved.docsQueries.some(item => item.libraryName === args.libraryName && item.query === args.query)) throw fail('TOOL_APPROVAL_DENIED', 'Documentation query pair was not approved by the parent.');
      if (name.startsWith('browser_') && !approved.browserUrls.includes(args.url)) throw fail('TOOL_APPROVAL_DENIED', 'Browser URL was not approved by the parent.');
      if(name==='browser_diagnostics'&&!['desktop','mobile'].includes(args.viewport))throw fail('TOOL_ARGUMENT_INVALID','Invalid viewport.');
      if (name === 'retrieval_search') text(args.query, 4000);
      if(name==='github_inspect'&&!approved.githubRepositories.includes(args.repository))throw fail('TOOL_APPROVAL_DENIED','Repository outside assignment scope.');
      const outbound=['web_search','web_fetch','docs_query','cerebras_research','github_inspect'].includes(name)||name.startsWith('browser_')&&!['localhost','SETUP_REQUIRED_ADDRESS_1','[::1]'].includes(new URL(args.url).hostname);
      if(outbound&&(privacyState.externalDenied||(privacyState.privateEvidence&&!approved.externalDisclosure)))throw fail('TOOL_PRIVATE_EVIDENCE_EXTERNAL_DENIED','External disclosure is not authorized for this assignment.');
      if (name === 'retrieval_fetch_evidence' && (!/^[a-f0-9]{32}$/u.test(args.evidence_id) || !evidence.has(args.evidence_id))) throw fail('TOOL_APPROVAL_DENIED', 'Evidence ID was not observed in this service session.');
      if (name === 'docs_query' || name === 'cerebras_research') {
        const question = name === 'docs_query' ? `${text(args.libraryName,100)}: ${text(args.query)}` : text(args.task);
        assertCerebrasSourceContentAllowed(question, 'advisor-public-query');
        const policy = classifyCerebrasTask({task:question});
        if (policy.transferDenied || policy.restrictedProjectData) throw fail('TOOL_APPROVAL_DENIED','Public lookup is forbidden by task policy.');
        await (dependencies.assertWorkspaceAllowed ?? assertCerebrasWorkspaceAllowed)({workspaceRoot});
      }
      const callSignal = AbortSignal.any([combined, AbortSignal.timeout(approved.timeoutMs)]);
      let timer; let abortCall;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { void close(); reject(fail('TOOL_TIMEOUT', 'Tool deadline expired; services were stopped.')); }, approved.timeoutMs); });
      const aborted = new Promise((_, reject) => { abortCall = () => reject(fail('TOOL_ABORTED', 'Tool call was aborted.')); combined.addEventListener('abort', abortCall, { once: true }); });
      const work = async () => {
        let data;
        if (name === 'web_search') data = await exa.search(args.query, { numResults: 3, timeoutMs: approved.timeoutMs, signal: callSignal });
        if (name === 'web_fetch') data = await exa.fetchUrls([args.url], { maxCharacters: 24000, timeoutMs: approved.timeoutMs, signal: callSignal });
        if (name === 'docs_query') {
          const client = await mcp('context7');
          const resolved = toolText(await client.call('resolve-library-id', args));
          const libraryId = /Context7-compatible library ID:\s*(\/[A-Za-z0-9_./-]+)/u.exec(resolved)?.[1];
          if (!libraryId) throw fail('TOOL_DOCS_UNRESOLVED', 'Context7 returned no verified library ID.');
          data = { libraryId, resolution: resolved, documentation: toolText(await client.call('query-docs', { libraryId, query: args.query })) };
        }
        if (name === 'cerebras_research') {
          if (!researchIntegration) {
            const factory = dependencies.researchFactory ?? (await import('file:////SETUP_REQUIRED/path-12')).createInstalledResearch;
            researchIntegration = await factory({directory:workspaceRoot});
            cleanup.add(()=>researchIntegration.close());
            if (closed || combined.aborted) { await researchIntegration.close(); throw fail('TOOL_CLOSED','Research services were closed.'); }
          }
          data = await researchIntegration.run({task:args.task,max_sources:3});
          if (!data?.ok) throw fail('TOOL_RESEARCH_FAILED','Research service returned no usable result.');
        }
        if(name==='git_inspect')data=await (dependencies.inspectGit??inspectGit)({workspaceRoot,sourceFiles,...args,signal:callSignal});
        if(name==='github_inspect')data=await (dependencies.inspectGithub??inspectGithub)({...args,signal:callSignal});
        if (name.startsWith('retrieval_')) {
          const client = await mcp('renna_retrieval');
          if (name === 'retrieval_status') data = toolData(await client.call('status', {}));
          if (name === 'retrieval_search') { data = toolData(await client.call('search', { query: args.query, mode: 'text', scope: 'knowledge', top_k: 3 })); if(approved.retrievalSources.length)data={...data,results:(data.results??[]).filter(x=>approved.retrievalSources.includes(x.source_id))};for (const item of data.results ?? []) if (/^[a-f0-9]{32}$/u.test(item.evidence_id)) evidence.add(item.evidence_id); privacyState.privateEvidence=true; }
          if (name === 'retrieval_fetch_evidence') data = toolData(await client.call('fetch_evidence', args));
        }
        if (name === 'browser_snapshot') data = await staticSnapshot(args.url, callSignal, fn => cleanup.add(fn), dependencies);
        if(name==='browser_diagnostics'&&(privacyState.externalDenied||privacyState.privateEvidence))throw fail('TOOL_BROWSER_PRIVATE_JS_UNAVAILABLE','Use the script-disabled browser_snapshot for private/offline diagnostics.');
        if(name==='browser_diagnostics')data=await staticSnapshot(args.url,callSignal,fn=>cleanup.add(fn),dependencies,{viewport:args.viewport,allowedUrls:approved.browserUrls});
        return cleanResult({ source: name, untrusted: true, data });
      };
      try { return await Promise.race([work(), deadline, aborted]); }
      catch (error) { states[name] = 'failed'; if (name.startsWith('retrieval_') || name === 'docs_query') await close(); throw fail(error.code ?? 'TOOL_SERVICE_FAILED', 'Read-only tool call failed.'); }
      finally { clearTimeout(timer); combined.removeEventListener('abort', abortCall); }
    };
    const next = queue.then(operation, operation); queue = next.then(() => {}, () => {}); return next;
  };
  if (combined.aborted) await close();
  return { definitions, execute, close, status: () => ({ closed, enabled: definitions.map(item => item.function.name), states: { ...states }, lifetimeMs: approved.lifetimeMs, timeoutMs: approved.timeoutMs }) };
}
