import fs from 'node:fs/promises';
import path from 'node:path';
import {applyControllerEdits} from './controller-edit-applier.mjs';
import {readStableRegularFile} from './bounded-local-file.mjs';
import {sha256,normalizeRelativePath} from './util.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const missingFile=e=>e?.code==='ENOENT'||(e?.code==='BOUNDED_LOCAL_FILE_UNREADABLE'&&e?.details?.causeCode==='ENOENT');
export async function applyAdvisorResult({receiptId,directory,reviewedPartial=false},service){
  if(!/^[0-9a-f-]{36}$/.test(receiptId??'')||typeof directory!=='string')throw new Error('INVALID_RECEIPT');
  const stable=await readStableRegularFile(path.join(service.stateRoot,'results',receiptId+'.json'),{maximumBytes:2000000,requireSingleLink:true});
  const r=JSON.parse(stable.bytes.toString('utf8'));
  if(r.id!==receiptId||r.status!=='DELIVERED'||r.execution!=='tools'||!r.directory||path.resolve(r.directory).toLowerCase()!==path.resolve(directory).toLowerCase())throw new Error('RECEIPT_SCOPE_MISMATCH');
  if(r.completion&&r.completion.outcome!=='complete'&&reviewedPartial!==true)fail('PARTIAL_REVIEW_REQUIRED');
  const root=await fs.realpath(directory);if(root.toLowerCase()!==path.resolve(directory).toLowerCase())throw new Error('WORKSPACE_ALIAS');
  const edits=r.files??[];
  if(!edits.length)return {status:'NO_CHANGES',receiptId};
  const hashes={};
  for(const f of r.sourceManifest){
    if(normalizeRelativePath(f.path)!==f.path)throw new Error('INVALID_RECEIPT_PATH');
    let content;
    try{content=(await readStableRegularFile(path.join(root,f.path),{maximumBytes:180000,requireSingleLink:true})).bytes;}catch(e){if(!missingFile(e))throw e;}
    if((content?sha256(content):'ABSENT')!==f.sha256)fail('SOURCE_CHANGED');
    if(f.writable)hashes[f.path]=f.sha256;
  }
  if(edits.some(f=>!Object.hasOwn(hashes,f.path)||typeof f.content!=='string'))throw new Error('EDIT_SCOPE_MISMATCH');
  const result=await applyControllerEdits({packet:{baselineHashes:hashes,budgets:{timeoutMs:30000}},worktree:root,edits,sandboxRoot:'/SETUP_REQUIRED/path-15',timeoutMs:30000});
  return {status:'APPLIED',receiptId,changedFiles:result.changedFiles,attestation:result.attestation};
}
