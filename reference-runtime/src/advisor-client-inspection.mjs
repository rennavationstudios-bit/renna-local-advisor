import path from 'node:path';
import {createAdvisorToolServices} from './advisor-tool-services.mjs';
import {classifyExternalTransferPolicy} from './cerebras-fast.mjs';
import {assertCerebrasWorkspaceAllowed} from './cerebras-workspace-policy.mjs';

// One existing MCP process owns these assignment-scoped services. No daemon,
// credentials, broad MCP proxy or model-authored executable is introduced.
export function createClientInspection(){
 const sessions=new Map(),privacy={};
 const key=directory=>{if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('INSPECTION_DIRECTORY_INVALID');return path.resolve(directory).toLowerCase();};
 const privacyFor=directory=>{key(directory);return privacy;};
 async function discover(args){
  const allowed=['directory','task','capability','sourceFiles','githubRepositories','browserUrls','retrievalSources'];
  if(!args||Object.keys(args).some(k=>!allowed.includes(k))||typeof args.task!=='string'||!args.task.trim()||args.task.length>16000)throw Error('INSPECTION_SCOPE_INVALID');
  const {directory,task,capability,sourceFiles=[],githubRepositories=[],browserUrls=[],retrievalSources=[]}=args;
  if(!Array.isArray(sourceFiles)||sourceFiles.length>64||sourceFiles.some(p=>typeof p!=='string'))throw Error('INSPECTION_SCOPE_INVALID');
  const k=key(directory),state=privacyFor(directory),classification=classifyExternalTransferPolicy({task});
  let external=!classification.transferDenied&&!classification.restrictedProjectData;
  if(external)try{await assertCerebrasWorkspaceAllowed({workspaceRoot:directory});}catch{external=false;}
  if(!external)state.externalDenied=true;
  const options={git:true,retrieval:true,lazy:true,githubRepositories:external?githubRepositories:[],browserUrls:external?browserUrls:browserUrls.filter(u=>['localhost','SETUP_REQUIRED_ADDRESS_1','[::1]'].includes(new URL(u).hostname)),retrievalSources,lifetimeMs:5400000};
  const scope=JSON.stringify({sourceFiles,options});let entry=sessions.get(k);
  // Changing scope requires a fresh MCP session, never silently widening an active assignment.
  if(entry&&entry.scope!==scope)throw Error('INSPECTION_SCOPE_CHANGED_USE_FRESH_SESSION');
  if(!entry){if(sessions.size>=16)throw Error('INSPECTION_SESSION_LIMIT');entry={scope,service:await createAdvisorToolServices({workspaceRoot:directory,sourceFiles,privacyState:state,options})};sessions.set(k,entry);}
  return entry.service.execute('tool_discover',{capability});
 }
 async function call(args){if(!args||Object.keys(args).some(k=>!['directory','name','arguments'].includes(k)))throw Error('INSPECTION_ARGUMENT_INVALID');const entry=sessions.get(key(args.directory));if(!entry)throw Object.assign(Error('INSPECTION_DISCOVERY_REQUIRED'),{code:'INSPECTION_DISCOVERY_REQUIRED'});return entry.service.execute('tool_call',{name:args.name,arguments:args.arguments});}
 async function close(){await Promise.allSettled([...sessions.values()].map(e=>e.service.close()));sessions.clear();}
 function constrainRequest(request){
  if(!request?.directory)return request;
  const state=privacyFor(request.directory);if(!state.externalDenied&&!state.privateEvidence)return request;
  const s=request.toolServices??{};
  return {...request,...(request.execution==='tools'?{toolServices:{...s,externalDisclosure:false,docs:false,research:false,web:false,githubRepositories:[],docsQueries:[],webQueries:[],webUrls:[],browserUrls:(s.browserUrls??[]).filter(u=>['localhost','SETUP_REQUIRED_ADDRESS_1','[::1]'].includes(new URL(u).hostname))}}:{})};
 }
 return {discover,call,privacyFor,constrainRequest,close};
}
export const clientInspectionDefinitions=[
 {name:'inspection_discover',description:'Discover task-scoped Git, GitHub, local knowledge or browser diagnostics. Include actual task/privacy instructions and authorized file/repository/URL scope; repeat the same scope for this session. No operation runs. Private retrieval stays local.',inputSchema:{type:'object',additionalProperties:false,required:['directory','task','capability'],properties:{directory:{type:'string'},task:{type:'string',maxLength:16000},capability:{type:'string',enum:['git','github','retrieval','browser']},sourceFiles:{type:'array',maxItems:64,items:{type:'string'}},githubRepositories:{type:'array',maxItems:16,items:{type:'string'}},browserUrls:{type:'array',maxItems:16,items:{type:'string'}},retrievalSources:{type:'array',maxItems:16,items:{type:'string'}}}}},
 {name:'inspection_call',description:'Execute an inspection tool returned by inspection_discover. Supply its exact name and JSON arguments; credentials and permissions stay with the host. No shell, Git writes or browser interaction.',inputSchema:{type:'object',additionalProperties:false,required:['directory','name','arguments'],properties:{directory:{type:'string'},name:{type:'string',maxLength:80},arguments:{type:'string',maxLength:8000}}}},
];
