import {haloHeaders} from './halo-auth.mjs';
// Shared by direct Advisor and the Hermes inference proxy. Never accept a
// caller-selected tokenizer destination or forward gateway credentials here.
const BASES=Object.freeze({'local-halo-superqwen':'https://worker-2.invalid/v1','local-r9700-qwen':'https://worker-3.invalid/v1','local-r9700b-qwen':'https://worker-4.invalid/v1','local-rtx3090-superqwen':'https://worker-5.invalid/v1','local-rtx3090-gemma4-26b':'https://worker-5.invalid/v1','local-rtx3090-gemma4-12b':'https://worker-5.invalid/v1'});
const fail=code=>{throw Object.assign(new Error(code),{code});};
// Per-call allowance, selected only after the host verifies the live profile.
// This never changes model context or truncates inputs; the full guard below
// still checks schemas, conversation, output and reserve before inference.
export function automaticToolOutputBudget(contextTokens){
  if(!Number.isInteger(contextTokens)||contextTokens<8192)fail('CONTEXT_CAPACITY_EXCEEDED');
  return contextTokens>=32768?8192:2048;
}
const HALO_FLASH_BASE='https://worker-6.invalid/v1';
export async function countLocalPromptTokens(pin,body,signal,fetchImpl=fetch){
  if(!pin?.base||(BASES[pin.alias]!==pin.base&&!(pin.alias==='local-halo-flash-next'&&pin.base===HALO_FLASH_BASE)))fail('CONTEXT_CAPACITY_EXCEEDED');
  // A sleeping R9700 takes about 16 seconds to restore its model. Keep this
  // bounded while allowing template/tokenizer requests to complete that wake.
  const deadline=AbortSignal.timeout(30000),boundedSignal=signal?AbortSignal.any([signal,deadline]):deadline;
  boundedSignal.throwIfAborted();
  const auth=await haloHeaders(pin);
  async function rpc(route,payload,{missing=false}={}){
    const response=await fetchImpl(pin.base.replace(/\/v1$/,'')+route,{method:'POST',headers:{'Content-Type':'application/json',...auth},body:JSON.stringify(payload),signal:boundedSignal,redirect:'error'});
    if(missing&&response.status===404)return null;
    if(!response.ok)fail('TOKENIZER_UNAVAILABLE');
    let bytes=0;const chunks=[];
    for await(const part of response.body){bytes+=part.length;if(bytes>4_000_000)fail('TOKENIZER_RESPONSE_TOO_LARGE');chunks.push(part);}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('TOKENIZER_RESPONSE_INVALID');}
  }
  const template=await rpc('/apply-template',{messages:body.messages,...(body.tools?{tools:body.tools}:{}),chat_template_kwargs:body.chat_template_kwargs},{missing:pin.alias==='local-halo-flash-next'});
  if(template===null){
    // Strata exposes the supported Anthropic count API. Convert the same
    // conversation, including reasoning, tool history and images, without
    // adding an inference request or changing the caller's original body.
    const parts=content=>typeof content==='string'||content==null?[{type:'text',text:content??''}]:content.map(p=>{
      if(p.type==='text')return p;
      if(p.type!=='image_url'||typeof p.image_url?.url!=='string')fail('TOKENIZER_RESPONSE_INVALID');
      const u=p.image_url.url,m=/^data:([^;,]+);base64,(.+)$/s.exec(u);
      return {type:'image',source:m?{type:'base64',media_type:m[1],data:m[2]}:{type:'url',url:u}};
    });
    const messages=body.messages.map(m=>{
      if(m.role==='tool')return {role:'user',content:[{type:'tool_result',tool_use_id:m.tool_call_id??'count',content:parts(m.content)}]};
      const content=parts(m.content);
      if(m.reasoning_content)content.unshift({type:'thinking',thinking:m.reasoning_content});
      for(const c of m.tool_calls??[]){
        let input;try{input=typeof c.function.arguments==='string'?JSON.parse(c.function.arguments):c.function.arguments;}catch{fail('TOKENIZER_RESPONSE_INVALID');}
        content.push({type:'tool_use',id:c.id??'count',name:c.function.name,input});
      }
      return {role:m.role==='developer'?'system':m.role,content};
    });
    const kw=body.chat_template_kwargs??{};
    if(Object.keys(kw).some(k=>!['enable_thinking','preserve_thinking','reasoning_effort'].includes(k)))fail('TOKENIZER_RESPONSE_INVALID');
    const effort=kw.reasoning_effort??body.reasoning_effort??body.reasoning?.effort;
    const count=await rpc('/v1/messages/count_tokens',{
      model:body.model,messages,
      ...(body.tools?{tools:body.tools.map(t=>({name:t.function.name,description:t.function.description??'',input_schema:t.function.parameters??{}}))}:{}),
      thinking:{type:kw.enable_thinking===false?'disabled':'enabled'},
      ...(effort!=null?{output_config:{effort}}:{})
    });
    if(!Number.isInteger(count?.input_tokens)||count.input_tokens<0)fail('TOKENIZER_RESPONSE_INVALID');
    return count.input_tokens;
  }
  if(typeof template?.prompt!=='string')fail('TOKENIZER_RESPONSE_INVALID');
  const result=await rpc('/tokenize',{content:template.prompt,add_special:true,parse_special:true,with_pieces:false});
  if(!Array.isArray(result?.tokens)||result.tokens.some(t=>!Number.isInteger(t)||t<0))fail('TOKENIZER_RESPONSE_INVALID');
  return result.tokens.length;
}

export async function assertLocalContextFits({pin,body,contextTokens,maxOutputTokens,signal,countTokens=countLocalPromptTokens,allowTokenizer=true}){
  signal?.throwIfAborted();
  if(!Number.isInteger(contextTokens)||contextTokens<=0||!Number.isInteger(maxOutputTokens)||maxOutputTokens<0)fail('CONTEXT_CAPACITY_EXCEEDED');
  const reserve=maxOutputTokens+2048;
  if(reserve>=contextTokens)fail('CONTEXT_CAPACITY_EXCEEDED');
  // Keep the existing cheap conservative check for small requests. Only use
  // the resident chat template/tokenizer when byte counting would reject it.
  if(Buffer.byteLength(JSON.stringify(body))+reserve<=contextTokens)return;
  if(!allowTokenizer)fail('CONTEXT_CAPACITY_EXCEEDED');
  const tokens=await countTokens(pin,body,signal);
  signal?.throwIfAborted();
  if(!Number.isInteger(tokens)||tokens<0||tokens+reserve>contextTokens)fail('CONTEXT_CAPACITY_EXCEEDED');
}
