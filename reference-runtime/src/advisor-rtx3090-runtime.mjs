import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { DirectoryLease } from './gpu-reservation.mjs';
import { readStableRegularFile } from './bounded-local-file.mjs';
import { assertNoSecretValues } from './util.mjs';
import { availableHostMiB, assertHostHeadroom, startResourceGuard } from './advisor-resource-guard.mjs';

export const RTX3090_GPU_UUID = 'SETUP_REQUIRED_GPU_UUID';
export const RTX3090_ROOT = '/SETUP_REQUIRED/path-23';
export const RTX3090_MANIFEST = `${RTX3090_ROOT}/advisor-profiles.json`;
export const RTX3090_BASE = 'https://worker-5.invalid/v1';
export const RTX3090_PINS = Object.freeze(Object.fromEntries([
  ['large', 'rtx3090-superqwen', 'local-rtx3090-superqwen', 'rtx3090-superqwen3.8-27b-q4km'],
  ['small', 'rtx3090-gemma4-12b', 'local-rtx3090-gemma4-12b', 'rtx3090-gemma4-12b-q4xl'],
].map(([profile,id,alias,model]) => [profile,Object.freeze({id,alias,model,base:RTX3090_BASE,hardware:'NVIDIA RTX 3090 / 24 GB VRAM',profile})])));
const execute = promisify(execFile);
const EDITING_NAMES = Object.freeze(['Resolve.exe','AfterFX.exe','aerender.exe','Adobe Media Encoder.exe']);
const EDITING_PROBE = "$ErrorActionPreference='Stop'; $env:PSModulePath=@([Environment]::GetEnvironmentVariable('PSModulePath','Machine'),[Environment]::GetEnvironmentVariable('PSModulePath','User')) -join ';'; $names=@('Resolve.exe','AfterFX.exe','aerender.exe','Adobe Media Encoder.exe'); $canonical=@{};foreach($n in $names){$canonical[$n.ToLowerInvariant()]=$n}; $items=@(Get-CimInstance Win32_Process | ForEach-Object {$key=([string]$_.Name).ToLowerInvariant();if($canonical.ContainsKey($key)){[pscustomobject]@{name=$canonical[$key];pid=[int]$_.ProcessId}}}); ConvertTo-Json -InputObject $items -Compress";
// Port 12345 is also used by the installed amaran lighting application. Only
// that verified desktop owner is exempt; unknown owners still reserve the GPU.
// This is host-owned discovery, never a model-supplied command or executable.
const AMARAN_PATH = '/SETUP_REQUIRED/path-24';
const AMARAN_SIGNER = 'FB70FD34EE8313627E0D302E297BDDD4C9238BD6';
const NEMOTRON_PORT_PROBE = `
$ErrorActionPreference='Stop'
$env:PSModulePath=@([Environment]::GetEnvironmentVariable('PSModulePath','Machine'),[Environment]::GetEnvironmentVariable('PSModulePath','User')) -join ';'
$owners=@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 12345 | Select-Object -ExpandProperty OwningProcess -Unique | Sort-Object)
$items=@(foreach($ownerPid in $owners) {
  $proc=[Diagnostics.Process]::GetProcessById($ownerPid)
  $created=$proc.StartTime.ToUniversalTime().ToString('o')
  $processName=$proc.ProcessName + '.exe'
  $verifiedPath=''; $signatureStatus=''; $signer=''
  if($processName -ieq 'amaran Desktop.exe') {
    $file=Get-Item -LiteralPath $proc.MainModule.FileName
    $verifiedPath=$file.FullName
    if($verifiedPath -ieq '/SETUP_REQUIRED/path-24') {
      $signature=Get-AuthenticodeSignature -LiteralPath $verifiedPath
      $signatureStatus=[string]$signature.Status
      if($signature.SignerCertificate){$signer=$signature.SignerCertificate.Thumbprint}
    }
  }
  if($proc.HasExited){throw 'Listener owner exited'}
  [pscustomobject]@{pid=[int]$ownerPid;created=$created;name=$processName;path=$verifiedPath;signature=$signatureStatus;signer=$signer}
})
$current=@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 12345 | Select-Object -ExpandProperty OwningProcess -Unique | Sort-Object)
if(($owners -join ',') -ne ($current -join ',')){throw 'Listener owner changed'}
ConvertTo-Json -InputObject $items -Compress
`;
const NEMOTRON_OWNER_IDENTITY_PROBE = `
$ErrorActionPreference='Stop'
$env:PSModulePath=@([Environment]::GetEnvironmentVariable('PSModulePath','Machine'),[Environment]::GetEnvironmentVariable('PSModulePath','User')) -join ';'
$owners=@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 12345 | Select-Object -ExpandProperty OwningProcess -Unique | Sort-Object)
$items=@(foreach($ownerPid in $owners) {
  $proc=[Diagnostics.Process]::GetProcessById($ownerPid)
  [pscustomobject]@{pid=[int]$ownerPid;created=$proc.StartTime.ToUniversalTime().ToString('o')}
})
$current=@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 12345 | Select-Object -ExpandProperty OwningProcess -Unique | Sort-Object)
if(($owners -join ',') -ne ($current -join ',')){throw 'Listener owner changed'}
$editing=@('Resolve','AfterFX','aerender','Adobe Media Encoder' | ForEach-Object {[Diagnostics.Process]::GetProcessesByName($_)} | ForEach-Object {$key=([string]$_.ProcessName+'.exe').ToLowerInvariant();$canonical=@{'resolve.exe'='Resolve.exe';'afterfx.exe'='AfterFX.exe';'aerender.exe'='aerender.exe';'adobe media encoder.exe'='Adobe Media Encoder.exe'};if($canonical.ContainsKey($key)){[pscustomobject]@{name=$canonical[$key];pid=[int]$_.Id}}})
ConvertTo-Json -InputObject ([pscustomobject]@{owners=$items;editingProcesses=$editing}) -Depth 4 -Compress
`;
const fail = code => { throw Object.assign(new Error(code), {code}); };
const comparable = p => process.platform==='win32'?path.resolve(p).toLowerCase():path.resolve(p);
const contains = (root,p) => { const r=path.relative(root,p);return !!r&&!r.startsWith('..')&&!path.isAbsolute(r); };
const same = (a,b) => a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const exact = (o,keys) => { if(!o||typeof o!=='object'||Array.isArray(o)||Object.keys(o).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(o,k)))fail('RTX3090_MANIFEST_INVALID'); };
const roles = ['rtx3090_scout','rtx3090_reviewer','rtx3090_builder','rtx3090_tester'];
export function rtx3090Role(role) {
  const suffix=String(role).split('_').at(-1),mapped=`rtx3090_${suffix}`;
  if(!roles.includes(mapped))fail('RTX3090_ROLE_UNQUALIFIED');
  return mapped;
}

// Constructor dependencies are test seams; requests can never select paths,
// programs, launch arguments, UUIDs, destinations, or lease locations.
export function validateRTX3090Manifest(value,{root=RTX3090_ROOT}={}) {
  exact(value,['version','gpuUuid','profiles']);
  if(value.version!==1||value.gpuUuid!==RTX3090_GPU_UUID)fail('RTX3090_MANIFEST_INVALID');
  exact(value.profiles,['large','small']);
  assertNoSecretValues(value,'rtx3090-profile-manifest');
  for(const [name,p] of Object.entries(value.profiles)) {
    exact(p,['executablePath','executableSha256','runtimeFiles','modelPath','modelSha256','args','minimumFreeMiB','contextTokens','qualifiedRoles',...(name==='large'?['minimumHostMiB','minimumGpuMiB']:[]),...(Object.hasOwn(p,'draftModel')?['draftModel']:[])]);
    if(p.draftModel){
      exact(p.draftModel,['path','sha256']);
      if(name!=='large'||!path.isAbsolute(p.draftModel.path)||!contains(path.resolve(root,'models'),path.resolve(p.draftModel.path))||!p.draftModel.path.endsWith('.gguf'))fail('RTX3090_PROFILE_PATH_INVALID');
      if(typeof p.draftModel.sha256!=='string'||!/^[a-f0-9]{64}$/.test(p.draftModel.sha256))fail('RTX3090_PROFILE_HASH_INVALID');
    } else if(Object.hasOwn(p,'draftModel'))fail('RTX3090_MANIFEST_INVALID');
    if(!path.isAbsolute(p.executablePath)||!path.isAbsolute(p.modelPath)||!contains(path.resolve(root,'runtime'),path.resolve(p.executablePath))||!contains(path.resolve(root,'models'),path.resolve(p.modelPath))||!/^llama-server\.exe$/i.test(path.basename(p.executablePath))||!p.modelPath.endsWith('.gguf'))fail('RTX3090_PROFILE_PATH_INVALID');
    if(![p.executableSha256,p.modelSha256].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)))fail('RTX3090_PROFILE_HASH_INVALID');
    if(!p.runtimeFiles||typeof p.runtimeFiles!=='object'||Array.isArray(p.runtimeFiles)||Object.keys(p.runtimeFiles).length>128||Object.entries(p.runtimeFiles).some(([name,hash])=>!/^[-A-Za-z0-9_.]+\.(?:dll|exe)$/i.test(name)||name.includes('..')||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash))||new Set(Object.keys(p.runtimeFiles).map(x=>x.toLowerCase())).size!==Object.keys(p.runtimeFiles).length)fail('RTX3090_PROFILE_HASH_INVALID');
    for(const required of ['llama-server.exe','llama-server-impl.dll','llama.dll','ggml-cuda.dll'])if(!Object.hasOwn(p.runtimeFiles,required))fail('RTX3090_PROFILE_HASH_INVALID');
    if(p.runtimeFiles[path.basename(p.executablePath)]!==p.executableSha256)fail('RTX3090_PROFILE_HASH_INVALID');
    if(!Number.isInteger(p.minimumFreeMiB)||p.minimumFreeMiB<1000||p.minimumFreeMiB>24576||!Number.isInteger(p.contextTokens)||p.contextTokens<4096||p.contextTokens>65536)fail('RTX3090_MANIFEST_INVALID');
    if(name==='large'&&(!Number.isInteger(p.minimumHostMiB)||p.minimumHostMiB<12288||p.minimumHostMiB>262144||!Number.isInteger(p.minimumGpuMiB)||p.minimumGpuMiB<2304||p.minimumGpuMiB>24576))fail('RTX3090_MANIFEST_INVALID');
    if(!Array.isArray(p.qualifiedRoles)||new Set(p.qualifiedRoles).size!==p.qualifiedRoles.length||p.qualifiedRoles.some(r=>!roles.includes(r)))fail('RTX3090_MANIFEST_INVALID');
    if(!Array.isArray(p.args)||p.args.length>80||p.args.some(a=>typeof a!=='string'||!a||a.length>2048))fail('RTX3090_PROFILE_ARGS_INVALID');
    const flags=new Map(),booleans=new Set(['--jinja','--no-ui','--no-cors-credentials','--no-agent','--no-context-shift']);
    const allowed=new Set(['--model','--host','--port','--alias','--parallel','--ctx-size','--gpu-layers','--flash-attn','--batch-size','--ubatch-size','--cache-type-k','--cache-type-v','--cache-ram','--ctx-checkpoints','--checkpoint-min-step','--sleep-idle-seconds','--reasoning','--reasoning-budget','--fit','--cors-origins','--threads','--threads-batch','--poll','--load-mode','--spec-type','--spec-draft-model','--spec-draft-n-max','--spec-draft-ngl','--spec-draft-type-k','--spec-draft-type-v']);
    for(let i=0;i<p.args.length;i++) {
      const key=p.args[i];if(flags.has(key)||(!allowed.has(key)&&!booleans.has(key)))fail('RTX3090_PROFILE_ARGS_INVALID');
      const val=booleans.has(key)?true:p.args[++i];if(val===undefined||String(val).startsWith('--'))fail('RTX3090_PROFILE_ARGS_INVALID');flags.set(key,val);
    }
    const required={'--model':p.modelPath,'--host':'SETUP_REQUIRED_ADDRESS_1','--port':'12346','--alias':RTX3090_PINS[name].model,'--parallel':'1','--ctx-size':String(p.contextTokens),'--gpu-layers':'all','--jinja':true,'--no-ui':true,'--fit':'off','--cors-origins':'http://advisor.local.invalid','--no-cors-credentials':true,'--no-agent':true};
    for(const [key,val] of Object.entries(required))if(flags.get(key)!==val)fail('RTX3090_PROFILE_ARGS_INVALID');
    const draftFlags={'--spec-type':'draft-mtp','--spec-draft-model':p.draftModel?.path,'--spec-draft-n-max':name==='large'?'2':'3','--spec-draft-ngl':'all','--spec-draft-type-k':'q8_0','--spec-draft-type-v':'q8_0'};
    for(const [key,val] of Object.entries(draftFlags))if(p.draftModel?flags.get(key)!==val:flags.has(key))fail('RTX3090_PROFILE_ARGS_INVALID');
    for(const key of ['--threads','--threads-batch'])if(flags.has(key)&&!['1','2','3','4','5','6','7','8'].includes(flags.get(key)))fail('RTX3090_PROFILE_ARGS_INVALID');
    if(flags.has('--load-mode')&&flags.get('--load-mode')!=='none')fail('RTX3090_PROFILE_ARGS_INVALID');
    if(flags.has('--poll')&&flags.get('--poll')!=='0')fail('RTX3090_PROFILE_ARGS_INVALID');
    const cacheType=name==='large'?'q4_0':'q8_0';
    for(const key of ['--cache-type-k','--cache-type-v'])if(flags.has(key)&&flags.get(key)!==cacheType)fail('RTX3090_PROFILE_ARGS_INVALID');
    if(name==='large') {
      const largeRequired={'--cache-type-k':'q4_0','--cache-type-v':'q4_0','--cache-ram':'0','--ctx-checkpoints':'4','--checkpoint-min-step':'32768','--no-context-shift':true,'--sleep-idle-seconds':'-1'};
      for(const [key,val] of Object.entries(largeRequired))if(flags.get(key)!==val)fail('RTX3090_PROFILE_ARGS_INVALID');
    } else if(['--cache-ram','--ctx-checkpoints','--checkpoint-min-step','--no-context-shift','--sleep-idle-seconds'].some(key=>flags.has(key))) fail('RTX3090_PROFILE_ARGS_INVALID');
    if(flags.has('--flash-attn')&&flags.get('--flash-attn')!=='on')fail('RTX3090_PROFILE_ARGS_INVALID');
    if(flags.has('--reasoning')&&flags.get('--reasoning')!=='off')fail('RTX3090_PROFILE_ARGS_INVALID');
    if(flags.has('--reasoning-budget')&&flags.get('--reasoning-budget')!=='0')fail('RTX3090_PROFILE_ARGS_INVALID');
    for(const key of ['--batch-size','--ubatch-size'])if(flags.has(key)&&(!/^[1-9][0-9]{0,3}$/.test(flags.get(key))||Number(flags.get(key))>2048))fail('RTX3090_PROFILE_ARGS_INVALID');
  }
  if(value.profiles.large.minimumFreeMiB<value.profiles.small.minimumFreeMiB)fail('RTX3090_MANIFEST_INVALID');
  return value;
}

async function canonicalFile(file,root) {
  if(!contains(path.resolve(root),path.resolve(file)))fail('RTX3090_PROFILE_PATH_INVALID');
  let cursor=path.parse(path.resolve(file)).root;
  for(const part of path.relative(cursor,path.resolve(file)).split(path.sep).filter(Boolean)) {
    cursor=path.join(cursor,part);const s=await fs.lstat(cursor);
    if(s.isSymbolicLink()||comparable(await fs.realpath(cursor))!==comparable(cursor))fail('RTX3090_PROFILE_PATH_INVALID');
  }
  const stat=await fs.lstat(file,{bigint:true});
  if(!stat.isFile()||stat.nlink!==1n)fail('RTX3090_PROFILE_PATH_INVALID');
  return stat;
}
async function verifyHash(file,expected,root,signal) {
  const before=await canonicalFile(file,root),handle=await fs.open(file,'r');
  try {
    if(!same(before,await handle.stat({bigint:true})))fail('RTX3090_PROFILE_FILE_CHANGED');
    const hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(4*1024*1024);let position=0;
    for(;;) { signal.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,buffer.length,position);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));position+=bytesRead; }
    if(!same(before,await handle.stat({bigint:true}))||!same(before,await canonicalFile(file,root)))fail('RTX3090_PROFILE_FILE_CHANGED');
    if(hash.digest('hex')!==expected)fail('RTX3090_PROFILE_HASH_MISMATCH');
    return before;
  } finally { await handle.close(); }
}
export async function probeRTX3090({executeImpl=execute,signal}={}) {
  const opts={timeout:4000,maxBuffer:16000,windowsHide:true,...(signal?{signal}:{})};
  const executable='/SETUP_REQUIRED/path-25';
  const [{stdout:gpu},{stdout:apps},{stdout:editing}]=await Promise.all([
    executeImpl(executable,[`--id=${RTX3090_GPU_UUID}`,'--query-gpu=uuid,name,memory.total,memory.free,utilization.gpu','--format=csv,noheader,nounits'],opts),
    executeImpl(executable,['--query-compute-apps=gpu_uuid,pid,process_name','--format=csv,noheader,nounits'],opts),
    executeImpl('/SETUP_REQUIRED/path-26',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',EDITING_PROBE],opts),
  ]);
  const rows=gpu.trim().split(/\r?\n/);if(rows.length!==1)fail('RTX3090_GPU_IDENTITY_MISMATCH');
  const [uuid,name,total,free,util]=rows[0].split(',').map(x=>x.trim());
  if(uuid!==RTX3090_GPU_UUID||!/RTX 3090/.test(name)||![total,free,util].every(x=>/^\d+$/.test(x)))fail('RTX3090_GPU_IDENTITY_MISMATCH');
  const processes=apps.trim().split(/\r?\n/).filter(Boolean).map(row=>row.split(',').map(x=>x.trim())).filter(([id])=>id===uuid);
  if(processes.some(([,pid])=>!/^\d+$/.test(pid)))fail('RTX3090_GPU_PROBE_INVALID');
  const editingProcesses=JSON.parse(editing);
  if(!Array.isArray(editingProcesses)||editingProcesses.some(p=>!p||Object.keys(p).some(k=>!['name','pid'].includes(k))||!EDITING_NAMES.includes(p.name)||!Number.isSafeInteger(p.pid)||p.pid<1))fail('RTX3090_GPU_PROBE_INVALID');
  return {worker:'rtx3090',gpuUuid:uuid,name,totalMiB:Number(total),freeMiB:Number(free),busyPercent:Number(util),computePids:processes.map(([,pid])=>Number(pid)),editingProcesses,checkedAt:new Date().toISOString()};
}
async function portBusy(port=12346) {
  return new Promise(resolve=>{const socket=net.connect({host:'SETUP_REQUIRED_ADDRESS_1',port});let finished=false;const done=busy=>{if(finished)return;finished=true;socket.destroy();resolve(busy);};socket.setTimeout(500,()=>done(true));socket.once('connect',()=>done(true));socket.once('error',e=>done(e.code!=='ECONNREFUSED'));});
}
export async function probeRTX3090NemotronPort({executeImpl=execute,signal}={}) {
  const {stdout}=await executeImpl('/SETUP_REQUIRED/path-26',
    ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',NEMOTRON_PORT_PROBE],
    {timeout:15000,maxBuffer:16000,windowsHide:true,...(signal?{signal}:{})});
  const owners=JSON.parse(stdout);
  if(!Array.isArray(owners)||owners.length>32||owners.some(p=>!p||Object.keys(p).sort().join(',')!=='created,name,path,pid,signature,signer'||!Number.isSafeInteger(p.pid)||p.pid<1||['name','path','signature','signer'].some(k=>typeof p[k]!=='string')||!validCreation(p.created)))fail('RTX3090_PORT_PROBE_INVALID');
  return owners.map(p=>({pid:p.pid,created:p.created,name:p.name,unrelated:
    p.name.toLowerCase()==='amaran desktop.exe'&&p.path.toLowerCase()===AMARAN_PATH.toLowerCase()&&p.signature==='Valid'&&p.signer===AMARAN_SIGNER}));
}
const validCreation=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(value);
const ownerIdentities=owners=>owners.map(({pid,created})=>({pid,created})).sort((a,b)=>a.pid-b.pid);
export async function probeRTX3090NemotronOwners({executeImpl=execute,signal}={}) {
  const {stdout}=await executeImpl('/SETUP_REQUIRED/path-26',
    ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',NEMOTRON_OWNER_IDENTITY_PROBE],
    {timeout:10000,maxBuffer:16000,windowsHide:true,...(signal?{signal}:{})});
  const result=JSON.parse(stdout);
  if(!result||Object.keys(result).sort().join(',')!=='editingProcesses,owners'||!Array.isArray(result.editingProcesses)||result.editingProcesses.some(p=>!p||Object.keys(p).sort().join(',')!=='name,pid'||!EDITING_NAMES.includes(p.name)||!Number.isSafeInteger(p.pid)||p.pid<1))fail('RTX3090_PORT_PROBE_INVALID');
  const owners=result.owners;
  if(!Array.isArray(owners)||owners.length>32||owners.some(p=>!p||Object.keys(p).sort().join(',')!=='created,pid'||!Number.isSafeInteger(p.pid)||p.pid<1||!validCreation(p.created)))fail('RTX3090_PORT_PROBE_INVALID');
  return {owners:ownerIdentities(owners),editingProcesses:result.editingProcesses};
}
export async function probeRTX3090Capacity({executeImpl=execute,signal}={}) {
  const {stdout}=await executeImpl('/SETUP_REQUIRED/path-25',
    [`--id=${RTX3090_GPU_UUID}`,'--query-gpu=uuid,memory.free','--format=csv,noheader,nounits'],
    {timeout:4000,maxBuffer:16000,windowsHide:true,...(signal?{signal}:{})});
  const fields=stdout.trim().split(',').map(s=>s.trim());
  if(fields.length!==2||fields[0]!==RTX3090_GPU_UUID||!/^\d+$/.test(fields[1])||Number(fields[1])>24576)fail('RTX3090_GPU_IDENTITY_MISMATCH');
  return {gpuUuid:fields[0],freeMiB:Number(fields[1])};
}
async function waitBounded(promise,ms) {
  let timer;try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('RTX3090_CLEANUP_FAILED'),{code:'RTX3090_CLEANUP_FAILED'})),ms);})]); }finally{clearTimeout(timer);}
}
export class RTX3090Runtime {
  constructor({root=RTX3090_ROOT,manifestPath=RTX3090_MANIFEST,leaseFactory=()=>new DirectoryLease({directory:'/SETUP_REQUIRED/path-27',ownerKind:'advisor-rtx3090'}),spawnImpl=spawn,gpuProbe=probeRTX3090,gpuCapacityProbe=probeRTX3090Capacity,hostMemoryProbe=availableHostMiB,guardIntervalMs=1000,portProbe=portBusy,portOwnerProbe=probeRTX3090NemotronPort,portOwnerIdentityProbe=probeRTX3090NemotronOwners,fetchImpl=fetch,startupMs=180000,cleanupMs=15000}={}) {
    Object.assign(this,{root,manifestPath,leaseFactory,spawnImpl,gpuProbe,gpuCapacityProbe,hostMemoryProbe,guardIntervalMs,portProbe,portOwnerProbe,portOwnerIdentityProbe,fetch:fetchImpl,startupMs,cleanupMs});
  }
  async manifest() {
    await canonicalFile(this.manifestPath,this.root);
    const stable=await readStableRegularFile(this.manifestPath,{maximumBytes:65536,requireSingleLink:true});
    if(!Buffer.from(stable.bytes.toString('utf8')).equals(stable.bytes))fail('RTX3090_MANIFEST_INVALID');
    const manifest=validateRTX3090Manifest(JSON.parse(stable.bytes.toString('utf8')),{root:this.root});
    return {manifest,manifestSha256:crypto.createHash('sha256').update(stable.bytes).digest('hex')};
  }
  async portState({signal}={}) {
    const [evie,nemotron,advisor]=await Promise.all([8770,12345,12346].map(p=>this.portProbe(p)));
    let nemotronBusy=nemotron,ignoredListeners=[],verifiedOwners=[];
    if(nemotron&&!evie&&!advisor) {
      try {
        const owners=await this.portOwnerProbe({signal});
        if(owners.length&&owners.every(p=>p.unrelated===true)) {
          // Signature/owner discovery takes longer than a socket check. Catch
          // a different GPU service starting during that read-only inspection.
          if((await Promise.all([8770,12346].map(p=>this.portProbe(p)))).some(Boolean))return {portsBusy:true,ignoredListeners:[]};
          nemotronBusy=false;
          verifiedOwners=ownerIdentities(owners);
          ignoredListeners=owners.map(p=>({port:12345,pid:p.pid,name:p.name,reason:'VERIFIED_NON_GPU_APPLICATION'}));
        }
      }catch { signal?.throwIfAborted(); /* Unknown, changing or inaccessible owners remain busy. */ }
    }
    return {portsBusy:evie||nemotronBusy||advisor,ignoredListeners,verifiedOwners};
  }
  async status() {
    try { const [{manifest,manifestSha256},gpu,reservation,ports]=await Promise.all([this.manifest(),this.gpuProbe(),this.leaseFactory().status(),this.portState()]);
      return {worker:'rtx3090',onDemand:true,available:true,healthy:false,launchable:!(gpu.editingProcesses??[]).length&&!reservation&&!ports.portsBusy&&Object.values(manifest.profiles).some(p=>p.qualifiedRoles.length&&gpu.freeMiB>=p.minimumFreeMiB),editingProcesses:gpu.editingProcesses??[],reason:gpu.editingProcesses?.length?'RTX3090_EDITING_ACTIVE':undefined,reservationBusy:!!reservation,portsBusy:ports.portsBusy,ignoredListeners:ports.ignoredListeners,preflightRequired:true,gpu,manifestSha256,profiles:Object.fromEntries(Object.entries(manifest.profiles).map(([p,c])=>[p,{...RTX3090_PINS[p],contextTokens:c.contextTokens,minimumFreeMiB:c.minimumFreeMiB,minimumHostMiB:c.minimumHostMiB,minimumGpuMiB:c.minimumGpuMiB,qualifiedRoles:c.qualifiedRoles}]))};
    }catch(e){return {worker:'rtx3090',onDemand:true,available:false,launchable:false,healthy:false,reason:/^[A-Z0-9_]+$/.test(e.code??'')?e.code:'RTX3090_RUNTIME_UNAVAILABLE'};}
  }
  async acquire({profile='auto',role,id,signal=AbortSignal.timeout(180000),authorizePin=async()=>{}}={}) {
    if(!['auto','large','small'].includes(profile))fail('RTX3090_PROFILE_INVALID');
    const lease=this.leaseFactory();let leased=false,child,closed=false,closePromise,closeOperation,guard;
    const close=()=>closeOperation??=(async()=>{
      try {
        guard?.stop();
        const deadline=Date.now()+this.cleanupMs;
        if(child&&!closed) { child.kill();await waitBounded(closePromise,Math.max(1,deadline-Date.now())); }
        if(child&&!closed)fail('RTX3090_CLEANUP_FAILED');
        if(child)while(await this.portProbe(12346)){if(Date.now()>=deadline)fail('RTX3090_CLEANUP_FAILED');await delay(Math.min(100,Math.max(1,deadline-Date.now())));}
        if(leased) {await lease.release();leased=false;}
      }catch{fail('RTX3090_CLEANUP_FAILED');}
    })();
    try {
      await lease.acquire({assignmentId:id,gpuUuid:RTX3090_GPU_UUID,profile,role:rtx3090Role(role)});leased=true;
      signal.throwIfAborted();
      assertHostHeadroom(await this.hostMemoryProbe());
      const {manifest,manifestSha256}=await this.manifest(),gpu=await this.gpuProbe({signal});
      if(gpu.gpuUuid!==RTX3090_GPU_UUID)fail('RTX3090_GPU_IDENTITY_MISMATCH');
      if((gpu.editingProcesses??[]).length)fail('RTX3090_EDITING_ACTIVE');
      const initialPorts=await this.portState({signal});if(initialPorts.portsBusy)fail('RTX3090_GPU_BUSY');
      const names=profile==='auto'?['large','small']:[profile],mappedRole=rtx3090Role(role);
      const selected=names.find(name=>manifest.profiles[name].qualifiedRoles.includes(mappedRole)&&gpu.freeMiB>=manifest.profiles[name].minimumFreeMiB);
      if(!selected) {if(!names.some(name=>manifest.profiles[name].qualifiedRoles.includes(mappedRole)))fail('RTX3090_ROLE_UNQUALIFIED');fail('RTX3090_MEMORY_INSUFFICIENT');}
      const p=manifest.profiles[selected],pin=RTX3090_PINS[selected];
      assertHostHeadroom(await this.hostMemoryProbe(),selected==='large'?p.minimumHostMiB:8192);
      await authorizePin(pin);
      const runtimeDirectory=path.dirname(p.executablePath),runtimeFiles=(await fs.readdir(runtimeDirectory)).filter(name=>/\.(?:exe|dll)$/i.test(name)).sort();
      if(JSON.stringify(runtimeFiles)!==JSON.stringify(Object.keys(p.runtimeFiles).sort()))fail('RTX3090_RUNTIME_FILES_MISMATCH');
      const runtimeStats=new Map();
      for(const name of runtimeFiles)runtimeStats.set(name,await verifyHash(path.join(runtimeDirectory,name),p.runtimeFiles[name],this.root,signal));
      const modelStat=await verifyHash(p.modelPath,p.modelSha256,this.root,signal);
      const draftStat=p.draftModel?await verifyHash(p.draftModel.path,p.draftModel.sha256,this.root,signal):null;
      signal.throwIfAborted();
      // Recheck path bindings, then editing activity and VRAM before launch.
      if(JSON.stringify((await fs.readdir(runtimeDirectory)).filter(name=>/\.(?:exe|dll)$/i.test(name)).sort())!==JSON.stringify(runtimeFiles))fail('RTX3090_RUNTIME_FILES_MISMATCH');
      for(const [name,stat] of runtimeStats)if(!same(stat,await canonicalFile(path.join(runtimeDirectory,name),this.root)))fail('RTX3090_PROFILE_FILE_CHANGED');
      if(!same(modelStat,await canonicalFile(p.modelPath,this.root)))fail('RTX3090_PROFILE_FILE_CHANGED');
      if(draftStat&&!same(draftStat,await canonicalFile(p.draftModel.path,this.root)))fail('RTX3090_PROFILE_FILE_CHANGED');
      if((await this.manifest()).manifestSha256!==manifestSha256)fail('RTX3090_MANIFEST_CHANGED');
      // Ownership/signature inspection can take seconds. Sample editing and
      // VRAM after it so the launch decision does not reuse older telemetry.
      const finalPorts=await this.portState({signal});if(finalPorts.portsBusy)fail('RTX3090_GPU_BUSY');
      const finalGPU=await this.gpuProbe({signal});
      if(finalGPU.gpuUuid!==RTX3090_GPU_UUID)fail('RTX3090_GPU_IDENTITY_MISMATCH');
      if((finalGPU.editingProcesses??[]).length)fail('RTX3090_EDITING_ACTIVE');
      if(finalGPU.freeMiB<p.minimumFreeMiB)fail('RTX3090_MEMORY_INSUFFICIENT');
      const [evieBusy,nemotronBusy,advisorBusy]=await Promise.all([8770,12345,12346].map(port=>this.portProbe(port)));
      if(evieBusy||advisorBusy)fail('RTX3090_GPU_BUSY');
      if(nemotronBusy) {
        if(!finalPorts.verifiedOwners.length)fail('RTX3090_GPU_BUSY');
        let observed;try { observed=await this.portOwnerIdentityProbe({signal}); }catch { signal.throwIfAborted();fail('RTX3090_GPU_BUSY'); }
        if(JSON.stringify(ownerIdentities(observed.owners))!==JSON.stringify(finalPorts.verifiedOwners))fail('RTX3090_GPU_BUSY');
        if(observed.editingProcesses.length)fail('RTX3090_EDITING_ACTIVE');
        const capacity=await this.gpuCapacityProbe({signal});
        if(capacity.gpuUuid!==RTX3090_GPU_UUID)fail('RTX3090_GPU_IDENTITY_MISMATCH');
        if(capacity.freeMiB<p.minimumFreeMiB)fail('RTX3090_MEMORY_INSUFFICIENT');
        if((await Promise.all([8770,12346].map(port=>this.portProbe(port)))).some(Boolean))fail('RTX3090_GPU_BUSY');
      }
      signal.throwIfAborted();
      const env={CUDA_VISIBLE_DEVICES:RTX3090_GPU_UUID};
      assertHostHeadroom(await this.hostMemoryProbe(),selected==='large'?p.minimumHostMiB:8192);
      for(const key of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
      env.PATH=path.join(process.env.SystemRoot??'/SETUP_REQUIRED/path-28','System32');
      child=this.spawnImpl(p.executablePath,p.args,{cwd:path.dirname(p.executablePath),windowsHide:true,detached:false,stdio:'ignore',shell:false,env});
      let spawnError;
      closePromise=new Promise(resolve=>{child.once('close',()=>{closed=true;resolve();});child.once('error',()=>{spawnError=true;});});
      if(!Number.isInteger(child.pid)||child.pid<1) {await waitBounded(closePromise,this.cleanupMs);fail('RTX3090_START_FAILED');}
      await lease.registerChild(child.pid);
      guard=startResourceGuard({ intervalMs:this.guardIntervalMs, sample:async()=>{
        const available=await this.hostMemoryProbe();assertHostHeadroom(available,selected==='large'?p.minimumHostMiB:8192);
        const capacity=await this.gpuCapacityProbe({signal});
        if(capacity.gpuUuid!==RTX3090_GPU_UUID)fail('RTX3090_GPU_IDENTITY_MISMATCH');
        return {availableHostMiB:available,freeGpuMiB:capacity.freeMiB};
      },minimumHostMiB:selected==='large'?p.minimumHostMiB:8192,minimumGpuMiB:selected==='large'?p.minimumGpuMiB:2048,onPressure:()=>close() });
      const sessionSignal=AbortSignal.any([signal,guard.signal]);
      const startup=AbortSignal.timeout(this.startupMs);
      const readiness=AbortSignal.any([sessionSignal,startup]);
      for(;;) {
        if(sessionSignal.aborted)throw sessionSignal.reason;if(startup.aborted)fail('RTX3090_STARTUP_TIMEOUT');if(closed||spawnError)fail('RTX3090_START_FAILED');
        try {const response=await this.fetch(`${RTX3090_BASE.replace('/v1','')}/health`,{redirect:'error',signal:AbortSignal.any([readiness,AbortSignal.timeout(1000)])});
          if(response.ok) {const reader=response.body.getReader(),chunks=[];let bytes=0;
            try {for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>4096){await reader.cancel();fail('HEALTH_TOO_LARGE');}chunks.push(Buffer.from(value));}}finally{reader.releaseLock();}
            if(JSON.parse(Buffer.concat(chunks).toString('utf8')).status==='ok')break;
          }
        }catch(e){if(sessionSignal.aborted)throw sessionSignal.reason;if(startup.aborted)fail('RTX3090_STARTUP_TIMEOUT');}
        try {await delay(200,undefined,{signal:readiness});} catch(e) {if(sessionSignal.aborted)throw sessionSignal.reason;if(startup.aborted)fail('RTX3090_STARTUP_TIMEOUT');throw e;}
      }
      await guard.check();sessionSignal.throwIfAborted();
      return {pin,profile:selected,contextTokens:p.contextTokens,qualifiedRoles:p.qualifiedRoles,manifestSha256,executableSha256:p.executableSha256,modelSha256:p.modelSha256,gpu:finalGPU,signal:sessionSignal,close};
    }catch(e) { try{await close();}catch(cleanup){throw cleanup;}throw e; }
  }
}
