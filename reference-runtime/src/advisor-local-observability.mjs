import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const ADVISOR_RUNTIME_VERSION='1.6.9';
export function createRuntimeProbe(root, files) {
  const digest=()=>{try {const hash=createHash('sha256');for(const file of files)hash.update(file).update('\0').update(readFileSync(path.join(root,file)));return hash.digest('hex');}catch{return null;}};
  const loadedDigest=digest(),loadedAt=new Date().toISOString();
  return ()=>{const diskDigest=digest();return {version:ADVISOR_RUNTIME_VERSION,loadedAt,loadedDigest,diskDigest,reloadRequired:!loadedDigest||!diskDigest||loadedDigest!==diskDigest};};
}

export function failureCategory(reason) {
  if(reason==='SIMULATED_UNAVAILABLE')return 'simulation';
  if(['WORKER_BUSY','WORKER_LEASE_BUSY','EXECUTION_CLAIM_SCOPE_BUSY','EXECUTION_CLAIM_BUSY','RTX3090_GPU_BUSY','GPU_BUSY','GPU_RESERVATION_BUSY','RTX3090_MEMORY_INSUFFICIENT','RTX3090_EDITING_ACTIVE','HOST_MEMORY_PRESSURE','GPU_MEMORY_PRESSURE'].includes(reason))return 'contention';
  if(['HEALTH_HTTP_429','INFERENCE_HTTP_429'].includes(reason))return 'contention';
  if(['TIMEOUT','COORDINATOR_STALLED','ABORT_ERR','TOOL_STEP_BUDGET_EXCEEDED','TOOL_CALL_BUDGET_EXCEEDED','CONTEXT_CAPACITY_EXCEEDED'].includes(reason))return 'budget';
  if(/^(?:CREDENTIAL_|WORKER_REGISTRY_DRIFT|MODEL_IDENTITY_MISMATCH|UNKNOWN_WORKER)/.test(reason??''))return 'configuration';
  if(/^RTX3090_(?:MANIFEST_|PROFILE_|ROLE_UNQUALIFIED|GPU_IDENTITY_MISMATCH)/.test(reason??''))return 'configuration';
  if(reason==='LOCAL_SENSITIVE_ENDPOINT_DENIED')return 'configuration';
  if(['RTX3090_START_FAILED','RTX3090_RUNTIME_UNAVAILABLE','RTX3090_GPU_PROBE_INVALID','RTX3090_CLEANUP_FAILED'].includes(reason))return 'worker';
  if(['LOCAL_SENSITIVE_TRANSPORT_FAILED','LOCAL_SENSITIVE_RESPONSE_INVALID','LOCAL_SENSITIVE_RESPONSE_TOO_LARGE'].includes(reason))return 'worker';
  if(/^INFERENCE_HTTP_(?:401|403|404)$/.test(reason??''))return 'configuration';
  if(/^(?:HEALTH_HTTP_|INFERENCE_HTTP_5|TOKENIZER_UNAVAILABLE|ECONN|EHOST|ENET|ENOTFOUND|UND_ERR_|CIRCUIT_OPEN)/.test(reason??''))return 'worker';
  return 'task';
}

export function summarizeWorkerEvents(events,worker) {
  const terminal=events.filter(x=>x?.worker===worker&&['DELIVERED','FAILED'].includes(x.status));
  const classified=terminal.map(x=>({...x,failureCategory:x.status==='FAILED'?failureCategory(x.reason):null}));
  const count=category=>classified.filter(x=>x.failureCategory===category).length;
  return {
    successes:classified.filter(x=>x.status==='DELIVERED').length,
    failures:classified.filter(x=>x.status==='FAILED'&&!['simulation','contention'].includes(x.failureCategory)).length,
    simulatedFailures:count('simulation'),busyDeferrals:count('contention'),workerFailures:count('worker'),configurationFailures:count('configuration'),taskFailures:count('task')+count('budget'),
    recent:classified.slice(-5).map(x=>{
      const toolEvents=events.filter(e=>e?.worker===worker&&e.status==='TOOL'&&e.id===`${x.id}-${worker}`);
      const complete=Number.isSafeInteger(x.toolCalls)||Array.isArray(x.toolEvents)||events.some(e=>e?.worker===worker&&e.id===x.id&&e.status==='RUNNING');
      return {id:x.id,role:x.role,status:x.status,profile:x.profile??x.health?.profile,model:x.model,execution:x.execution??'inference',elapsedMs:x.elapsedMs,reason:x.reason,failureCategory:x.failureCategory,usage:x.usage,timings:x.timings,
        toolCalls:Number.isSafeInteger(x.toolCalls)?x.toolCalls:Array.isArray(x.toolEvents)?x.toolEvents.length:toolEvents.length|| (complete||x.execution==='inference'?0:null),
        toolCallsComplete:complete||x.execution==='inference',tools:x.toolCapabilities??x.toolNames??[...new Set(toolEvents.map(e=>e.name))]};
    }),
    currentWorkload:events.filter(x=>x?.worker===worker&&x.status==='RUNNING'&&!terminal.some(y=>y.id===x.id)&&Date.parse(x.startedAt)>Date.now()-330000).map(x=>({id:x.id,role:x.role,startedAt:x.startedAt})),
  };
}
