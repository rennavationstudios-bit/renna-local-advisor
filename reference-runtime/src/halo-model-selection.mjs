import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import http from 'node:http';
import {haloHeaders} from './halo-auth.mjs';
const exec=promisify(execFile);
export const HALO_FLASH=Object.freeze({id:'halo-flash-next',alias:'local-halo-flash-next',model:'qwen3.8-flash-next-udiq4xs',base:'https://worker-6.invalid/v1',hardware:'Ryzen AI Max+ 395 / Radeon 8060S / 128 GB UMA'});
export const HALO_ALTERNATE=Object.freeze({id:'halo-superqwen',alias:'local-halo-superqwen',model:'superqwen3.8-27b-abliterated-q4km',base:'https://worker-2.invalid/v1',hardware:HALO_FLASH.hardware});
const helper='/SETUP_REQUIRED/path-22';
export function haloPin(selection='flash'){if(selection==='flash')return HALO_FLASH;if(selection==='superqwen')return HALO_ALTERNATE;throw new Error('INVALID_HALO_SELECTION');}
export async function acquireHaloSelection(advisor,pin,packet,signal,ttlMs){
  if(![HALO_FLASH.model,HALO_ALTERNATE.model].includes(pin.model))throw new Error('INVALID_HALO_SELECTION');
  // Both model identities share the existing physical Halo lease, including old clients.
  const resource=await advisor.worker('halo',HALO_ALTERNATE);let claim;
  while(!claim){
    signal.throwIfAborted();
    try{claim=await advisor.leases.acquireExecutionClaim(resource,packet,['halo-selection',pin.model,packet.id],{ttlMs});}
    catch(e){if(!/BUSY/.test(e.code??''))throw e;await new Promise(r=>setTimeout(r,500));}
  }
  try{
    const {stdout}=await exec('python',['-I',helper,'--timeout','540','--','/usr/bin/python3','/usr/local/libexec/halo-model-control',pin.model===HALO_FLASH.model?'heavy':'fast'],{windowsHide:true,timeout:550000,maxBuffer:8192,signal});
    const result=JSON.parse(stdout.trim());
    if(result.model!==pin.model||result.context!==262144)throw new Error('HALO_SELECTION_IDENTITY_MISMATCH');
    return claim;
  }catch(e){await advisor.leases.releaseExecutionClaim(claim);throw e;}
}
export async function postHalo(pin,body,signal,requestImpl=http.request){
  if(![HALO_FLASH.base,HALO_ALTERNATE.base].includes(pin.base))throw new Error('INVALID_HALO_SELECTION');
  // Buffered local inference can legitimately exceed fetch/Undici's implicit
  // five-minute header deadline. Keep the existing caller cancellation and a
  // hard 90-minute ceiling, without introducing an independent idle deadline.
  const ceiling=AbortSignal.timeout(5400000),bounded=signal?AbortSignal.any([signal,ceiling]):ceiling;
  bounded.throwIfAborted();
  const payload=JSON.stringify({...body,model:pin.model});
  const auth=await haloHeaders(pin);
  return new Promise((resolve,reject)=>{
    const req=requestImpl(pin.base+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),...auth},signal:bounded},res=>{
      let size=0;const chunks=[];
      res.on('error',reject);
      res.on('aborted',()=>reject(new Error('INCOMPLETE_RESPONSE')));
      res.on('data',chunk=>{
        size+=chunk.length;
        if(size>1000000){const error=new Error('RESPONSE_TOO_LARGE');reject(error);res.destroy(error);req.destroy(error);return;}
        chunks.push(chunk);
      });
      res.on('end',()=>resolve({ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode,raw:Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error',reject);
    req.end(payload);
  });
}
