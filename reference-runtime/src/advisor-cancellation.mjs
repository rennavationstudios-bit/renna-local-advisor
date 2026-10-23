// Cancellation is owned by this connection and by the exact JSON-RPC ID type.
// Never persist the client-supplied reason, which can contain arbitrary text.
export function throwIfAdvisorCancelled(signal) {
  if (signal?.aborted) throw Object.assign(new Error('ADVISOR_CANCELLED'), {code:'ADVISOR_CANCELLED'});
}

const workerTools=new Set(['delegate_to_halo','delegate_to_r9700','delegate_to_r9700b','delegate_to_rtx3090','delegate_to_local_fleet','delegate_project_to_halo','delegate_parallel_workers','preflight_local_request','local_status']);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const identifier=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))fail('INVALID_HOST_IDENTITY');return value;};
function sameAlias(values){if(!values.length)return null;const checked=values.map(identifier);if(new Set(checked).size!==1)fail('CONFLICTING_HOST_IDENTITY');return checked[0];}
// Only host-owned MCP metadata is consulted. Tool arguments never establish ownership.
export function canonicalHostIdentity(message){
  const params=message.params;
  if(!params||!Object.hasOwn(params,'_meta'))return null;
  const meta=params._meta;if(!meta||typeof meta!=='object'||Array.isArray(meta))fail('INVALID_HOST_METADATA');
  let nested={};
  if(Object.hasOwn(meta,'x-codex-turn-metadata')){
    nested=meta['x-codex-turn-metadata'];
    if(typeof nested==='string'){if(nested.length>16384)fail('INVALID_HOST_METADATA');try{nested=JSON.parse(nested);}catch{fail('INVALID_HOST_METADATA');}}
    if(!nested||typeof nested!=='object'||Array.isArray(nested))fail('INVALID_HOST_METADATA');
  }
  const present=(object,keys)=>keys.filter(key=>Object.hasOwn(object,key)).map(key=>object[key]);
  const threadId=sameAlias([...present(meta,['threadId','sessionId']),...present(nested,['thread_id','session_id'])]);
  const turnId=sameAlias(present(nested,['turn_id']));
  if(turnId&&!threadId)fail('HOST_THREAD_METADATA_REQUIRED');
  return threadId?{threadId,turnId}:null;
}

// Installed Interrupt hooks have a three-second cap, including MCP handlers.
// Leave headroom for transport; request cleanup continues after this observation.
export const TURN_CANCELLATION_DRAIN_MS=2000;
export function createMcpRequestDispatcher({execute,send,cleanupWaitMs=TURN_CANCELLATION_DRAIN_MS}) {
  if(!Number.isInteger(cleanupWaitMs)||cleanupWaitMs<1||cleanupWaitMs>20000)fail('INVALID_CLEANUP_WAIT');
  const active=new Map(); let closed=false;
  return {
    async dispatch(message) {
      if(closed)return;
      if(!message||typeof message!=='object'||Array.isArray(message)){
        send({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}});return;
      }
      if(message.method==='notifications/cancelled'&&!Object.hasOwn(message,'id')) {
        const target=active.get(message.params?.requestId);
        if(target){target.suppressReply=true;target.controller.abort();}
        return;
      }
      if(!Object.hasOwn(message,'id'))return;
      const id=message.id;
      if((typeof id!=='string'&&!(typeof id==='number'&&Number.isFinite(id)))||active.has(id)) {
        send({jsonrpc:'2.0',id,error:{code:-32600,message:'Invalid or duplicate request ID'}});return;
      }
      let identity;
      try{identity=message.method==='tools/call'?canonicalHostIdentity(message):null;}
      catch(error){send({jsonrpc:'2.0',id,error:{code:-32602,message:error.code}});return;}
      const entry={controller:new AbortController(),identity,worker:message.method==='tools/call'&&workerTools.has(message.params?.name),done:null,settled:false,suppressReply:false,turnCancelled:false};
      active.set(id,entry);
      const cancelLocalTurn=async args=>{
        if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length!==3||!['event','sessionId','turnId'].every(key=>Object.hasOwn(args,key))||args.event!=='Interrupt')fail('INVALID_TURN_CANCELLATION');
        const threadId=identifier(args.sessionId),turnId=identifier(args.turnId);
        if(!identity?.threadId||identity.threadId!==threadId)fail('CANCELLATION_THREAD_MISMATCH');
        // Normal model tool calls carry a turn identity too. They may only cancel
        // that turn; the supported hook carries its turn in reviewed templates.
        if(identity.turnId&&identity.turnId!==turnId)fail('CANCELLATION_TURN_MISMATCH');
        const targets=[...active.values()].filter(other=>other!==entry&&other.worker&&!other.settled&&other.identity?.threadId===threadId&&other.identity?.turnId===turnId);
        let signalDelivered=0;
        for(const target of targets){
          target.turnCancelled=true;
          if(!target.controller.signal.aborted){target.controller.abort();signalDelivered++;}
        }
        let timer;
        try{if(targets.length)await Promise.race([Promise.allSettled(targets.map(target=>target.done)),new Promise(resolve=>{timer=setTimeout(resolve,cleanupWaitMs);})]);}
        finally{clearTimeout(timer);}
        const drained=targets.filter(target=>target.settled).length;
        return {status:'CANCELLATION_REQUESTED',signalDelivered,drained,pending:targets.length-drained,integrationAuthorized:false};
      };
      entry.done=(async()=>{
        try {
          let response;
          try{response=await execute(message,{signal:entry.controller.signal,cancelLocalTurn});}
          catch(error){if(!entry.turnCancelled)throw error;}
          // A normal tool cancellation must settle the caller's outstanding RPC.
          // Host cancellation/EOF suppress all replies, including this terminal one.
          if(!closed&&!entry.suppressReply){
            if(entry.turnCancelled){
              const value={status:'CANCELLED',integrationAuthorized:false};
              send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:true}});
            }else if(!entry.controller.signal.aborted)send(response);
          }
        } finally {entry.settled=true;if(active.get(id)===entry)active.delete(id);}
      })();
      return entry.done;
    },
    async close() {
      closed=true;
      const pending=[...active.values()];
      for(const entry of pending){entry.suppressReply=true;entry.controller.abort();}
      await Promise.allSettled(pending.map(entry=>entry.done));
    },
  };
}
