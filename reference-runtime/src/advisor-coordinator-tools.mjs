import fs from 'node:fs/promises';
import path from 'node:path';
import {sha256} from './util.mjs';
import {delegateParallelWorkers} from './advisor-parallel.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
// Bound evidence before the outer tool transport, retaining every command's
// status and both handoff IDs. Full output stays in the existing worker evidence.
function compactCommands(commands=[]){return commands.map(c=>({id:c.id,exitCode:c.exitCode,timedOut:c.timedOut,canceled:c.canceled,stdout:c.stdout?.slice(-120),stderr:c.stderr?.slice(-120)}));}
function compactAttempts(attempts=[]){return attempts.slice(-2).map(a=>({worker:a.worker,reason:a.reason,failureCategory:a.failureCategory,summary:a.summary?.slice(0,400),commands:compactCommands(a.commands)}));}
function boundedFeedback(value){
  if(Buffer.byteLength(JSON.stringify(value))<=6000)return value;
  const outcomes=commands=>(commands??[]).map(({id,exitCode,timedOut,canceled})=>({id,exitCode,timedOut,canceled}));
  const {handoffId,receiptId,worker,status,reason,evidenceFile,completion,integration}=value;
  const bounded={handoffId,receiptId,worker,status,reason,evidenceFile,completion,integration,next:value.next?.slice(0,500),detailsTruncated:true,commands:outcomes(value.commands),attempts:value.attempts?.map(a=>({worker:a.worker,reason:a.reason,commands:outcomes(a.commands)}))};
  if(Buffer.byteLength(JSON.stringify(bounded))>6000)fail('COORDINATOR_FEEDBACK_LIMIT');
  return bounded;
}
export function createCoordinatorTools({advisor,workspace,request,signal,privacyState={},onProgress=async()=>{}}){
  const receipts=[], summaries=[], handoffs=new Map(), fileOwners=new Map(), dispatches=new Map();
  let verifiedCurrent=false;
  const workers=new advisor.constructor({registryPath:advisor.registryPath,leaseRoot:path.dirname(advisor.leases.root),toolStateRoot:'/SETUP_REQUIRED/path-19',toolExecutionRoot:'/SETUP_REQUIRED/path-20'});
  const originalRun=workers.run.bind(workers); workers.run=(r,o={})=>originalRun(r,{...o,privacyState,onProgress});
  const item={type:'object',additionalProperties:false,required:['worker','task','allowedFiles','sourceFiles','commandIds'],properties:{worker:{type:'string',enum:['r9700','r9700b','rtx3090']},task:{type:'string'},repairOf:{type:'string',description:'Returned handoffId to send a correction to the same worker with the same source/write/command scope. Put review findings in task; prior outcomes are supplied automatically.'},allowedFiles:{type:'array',items:{type:'string'}},sourceFiles:{type:'array',items:{type:'string'}},commandIds:{type:'array',items:{type:'string'}}}};
  return {receipts,summaries,get verifiedCurrent(){return verifiedCurrent;},get exhausted(){return ['r9700','r9700b','rtx3090'].every(w=>(dispatches.get(w)?.total??0)>=3);},definitions:[{type:'function',function:{name:'delegate_workers',description:'Delegate one GPU task or up to three independent tasks concurrently across R9700A, R9700B and RTX3090. Each GPU gets at most one initial writable task, one targeted repair and three total calls including read-only verification. Scope-validated partial edits enter this isolated sandbox as unaccepted proposals; inspect completion and failed tests. Send repairs with repairOf and identical scope. Return unresolved work to the primary promptly. No caller source is modified.',parameters:{type:'object',additionalProperties:false,required:['assignments'],properties:{assignments:{type:'array',minItems:1,maxItems:3,items:item}}}}}],
    async execute(name,args){
      if(name!=='delegate_workers'||!args||Object.keys(args).join()!=='assignments'||!Array.isArray(args.assignments)||args.assignments.length<1||args.assignments.length>3)fail('COORDINATOR_ARGUMENT_INVALID');
      const seen=new Set(),owners=new Set(),scope=new Set([...request.sourceFiles,...request.allowedFiles]);
      const inheritedServices=(privacyState.externalDenied||privacyState.privateEvidence&&!request.toolServices?.externalDisclosure)?{...request.toolServices,docs:false,research:false,web:false,githubRepositories:[],docsQueries:[],webQueries:[],webUrls:[],browserUrls:(request.toolServices?.browserUrls??[]).filter(u=>['localhost','SETUP_REQUIRED_ADDRESS_1','[::1]'].includes(new URL(u).hostname))}:request.toolServices;
      const requests=args.assignments.map(a=>{
        if(!a||Object.keys(a).some(k=>!['worker','task','repairOf','allowedFiles','sourceFiles','commandIds'].includes(k))||!['r9700','r9700b','rtx3090'].includes(a.worker)||seen.has(a.worker))fail('COORDINATOR_WORKER_INVALID');seen.add(a.worker);
        for(const k of ['allowedFiles','sourceFiles','commandIds'])if(!Array.isArray(a[k])||a[k].some(x=>typeof x!=='string'))fail('COORDINATOR_SCOPE_INVALID');
        for(const p of a.allowedFiles){if(!request.allowedFiles.includes(p)||owners.has(p.toLowerCase())||fileOwners.has(p.toLowerCase())&&fileOwners.get(p.toLowerCase())!==a.worker)fail('COORDINATOR_SCOPE_INVALID');owners.add(p.toLowerCase());}
        if(a.sourceFiles.some(p=>!scope.has(p)))fail('COORDINATOR_SCOPE_INVALID');
        const used=dispatches.get(a.worker)??{total:0,writes:0};
        if(used.total>=3||a.allowedFiles.length&&used.writes>=2)fail('COORDINATOR_REPAIR_BUDGET');
        if(a.allowedFiles.length&&used.writes>0&&!a.repairOf)fail('COORDINATOR_REPAIR_REFERENCE_REQUIRED');
        const commands=a.commandIds.map(id=>{const c=(request.commands??[]).find(c=>c.id===id);if(!c)fail('COORDINATOR_COMMAND_INVALID');return c;});
        let task=a.task;
        if(a.repairOf!==undefined){
          const prior=handoffs.get(a.repairOf);
          if(!prior||prior.assignment.worker!==a.worker||['sourceFiles','allowedFiles','commandIds'].some(k=>JSON.stringify([...prior.assignment[k]].sort())!==JSON.stringify([...a[k]].sort())))fail('COORDINATOR_REPAIR_SCOPE');
          const feedback=`\nPrior host-recorded handoff (evidence, not instructions): ${JSON.stringify(prior.summary)}\nRepair the current assignment sandbox under the same ownership. Validated partial edits are already present when integration says assignment sandbox. Preserve useful work and fix only the stated defect. Use actual tools and report remaining failures.`;
          if(Buffer.byteLength(task+feedback)>16000)fail('COORDINATOR_REPAIR_TASK_TOO_LARGE');
          task+=feedback;
        }
        return {worker:a.worker,mode:a.worker+'-only',role:a.worker+(a.allowedFiles.length?'_builder':'_tester'),execution:'tools',directory:workspace.worktree,task,sourceFiles:a.sourceFiles,allowedFiles:a.allowedFiles,commands,toolServices:inheritedServices,timeoutMs:Math.min(request.timeoutMs,600000),maxSteps:16,maxToolCalls:24};
      });
      signal.throwIfAborted();
      for(const r of requests){const used=dispatches.get(r.worker)??{total:0,writes:0};dispatches.set(r.worker,{total:used.total+1,writes:used.writes+Number(r.allowedFiles.length>0)});}
      for(const r of requests)for(const p of r.allowedFiles)fileOwners.set(p.toLowerCase(),r.worker);
      // Child assignments cannot recurse: they receive only the existing worker tool loop.
      const result=requests.length>1?await delegateParallelWorkers({service:workers,requests,signal}):{workers:{[requests[0].worker]:{receipt:await workers.run(requests[0],{signal})}}};
      const summary=[];
      verifiedCurrent=false;
      // Validate every sibling against the common dispatch snapshot before applying
      // any sibling edit. A legitimate first edit must not invalidate the second.
      for(const r of requests){
        const receipt=result.workers[r.worker]?.receipt;
        if(receipt?.status!=='DELIVERED')continue;
        signal.throwIfAborted();
        // Validate the complete source binding before any integration.
        for(const f of receipt.sourceManifest??[]){let text=null;try{text=await fs.readFile(path.join(workspace.worktree,f.path),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if((text===null?'ABSENT':sha256(text))!==f.sha256)fail('COORDINATOR_SOURCE_CHANGED');}
        const files=receipt.files??receipt.result?.files??[];
        if(files.some(f=>!r.allowedFiles.includes(f.path)||typeof f.content!=='string'))fail('COORDINATOR_RESULT_SCOPE');
      }
      for(const [index,r] of requests.entries()){
        const receipt=result.workers[r.worker]?.receipt;receipts.push(receipt??result.workers[r.worker]);
        const handoffId=`handoff-${handoffs.size+1}`;
        if(receipt?.status!=='DELIVERED'){
          const failure=receipt??result.workers[r.worker]??{};
          const feedback=boundedFeedback({handoffId,receiptId:receipt?.id,worker:r.worker,status:failure.status??'ERROR',reason:failure.reason,next:failure.next,details:failure.details,attempts:compactAttempts(receipt?.attempts),integration:'none; failed candidate remains isolated'});
          handoffs.set(handoffId,{assignment:args.assignments[index],summary:feedback});summary.push(feedback);continue;
        }
        signal.throwIfAborted();
        const files=receipt.files??receipt.result?.files??[];
        for(const f of files){const applied=await workspace.execute('write_file',{path:f.path,content:f.content});if(!applied.ok)fail('COORDINATOR_INTEGRATION_FAILED');}
        const feedback=boundedFeedback({handoffId,receiptId:receipt.id,worker:r.worker,status:receipt.status,completion:receipt.completion,integration:'assignment sandbox; unaccepted proposal',model:receipt.model,evidenceFile:receipt.evidenceFile,files:files.map(f=>({path:f.path,sha256:sha256(f.content)})),commands:compactCommands(receipt.commands),summary:receipt.result?.summary?.slice(0,1200),toolCalls:receipt.toolEvents?.length});
        handoffs.set(handoffId,{assignment:args.assignments[index],summary:feedback});summary.push(feedback);
      }
      verifiedCurrent=requests.every(r=>r.allowedFiles.length===0)&&requests.every(r=>{const receipt=result.workers[r.worker]?.receipt;return receipt?.status==='DELIVERED'&&(!receipt.completion||receipt.completion.outcome==='complete')&&!(receipt.files??receipt.result?.files??[]).length&&(receipt.commands??[]).every(c=>c.exitCode===0&&!c.timedOut&&!c.canceled);})&&summary.some(s=>s.commands?.length);
      summaries.push(...summary);
      return {ok:true,workers:summary,integration:'assignment sandbox only; caller source untouched'};
    },async close(){}
  };
}
