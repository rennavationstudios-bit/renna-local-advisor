import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {assertNoSecretValues} from './util.mjs';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const GIT='/SETUP_REQUIRED/path-13',GH='/SETUP_REQUIRED/path-14';
function environment(github=false){
 const env={};for(const k of ['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'])if(process.env[k])env[k]=process.env[k];
 return {...env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'NUL',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_PAGER:'cat',GIT_LITERAL_PATHSPECS:'1',...(github?{GH_HOST:'github.com',GH_PROMPT_DISABLED:'1',GH_PAGER:'cat',GH_NO_UPDATE_NOTIFIER:'1'}:{})};
}
async function command(executable,args,{signal,cwd,github=false}={}){
 signal?.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{cwd,env:environment(github),windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  let output='',bytes=0,done=false;const timer=setTimeout(()=>stop('INSPECTION_TIMEOUT'),20000);
  const abort=()=>stop('INSPECTION_ABORTED');
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(Object.assign(new Error(error),{code:error})):resolve(value);};
  const stop=code=>{child.kill();finish(code);};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  child.stdout.on('data',b=>{bytes+=b.length;if(bytes>48000)stop('INSPECTION_OUTPUT_TOO_LARGE');else output+=b.toString('utf8');});
  child.stderr.on('data',()=>{});child.on('error',()=>finish('INSPECTION_PROCESS_FAILED'));
  child.on('close',code=>{if(code!==0)finish('INSPECTION_COMMAND_FAILED');else{try{assertNoSecretValues(output,'inspection-output');finish(null,output);}catch{finish('INSPECTION_OUTPUT_WITHHELD');}}});
 });
}
const gitArgs=['--no-pager','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=NUL','-c','core.attributesFile=NUL','-c','diff.external=','-c','core.pager=cat'];
async function root(directory){
 if(typeof directory!=='string'||!path.isAbsolute(directory))fail('GIT_SCOPE_INVALID');
 const actual=await fs.realpath(directory);if(path.resolve(actual).toLowerCase()!==path.resolve(directory).toLowerCase())fail('GIT_SCOPE_INVALID');
 return actual;
}
function scopedPaths(files){
 if(!Array.isArray(files)||files.length>64||files.some(p=>typeof p!=='string'||p.length>512||!p||p.includes('\\')||p.split('/').some(v=>!v||v==='.'||v==='..'||v.toLowerCase()==='.git')||/[\0\r\n:*?\[\]]/.test(p)||path.isAbsolute(p)))fail('GIT_SCOPE_INVALID');
 return [...new Set(files)];
}
export async function inspectGit({workspaceRoot,sourceFiles=[],operation,ref='',signal}){
 if(!['status','diff','log','branches','commit'].includes(operation))fail('GIT_OPERATION_DENIED');
 const cwd=await root(workspaceRoot),files=scopedPaths(sourceFiles);
 const git=args=>command(GIT,[...gitArgs,'-C',cwd,...args],{cwd,signal});
 const top=(await git(['rev-parse','--show-toplevel'])).trim();if(path.resolve(top).toLowerCase()!==cwd.toLowerCase())fail('GIT_SCOPE_INVALID');
 if(operation!=='branches'&&!files.length)fail('GIT_FILE_SCOPE_REQUIRED');
 // Never dereference a worktree symlink outside the assigned repository.
 for(const file of files){let cursor=cwd;for(const segment of file.split('/')){cursor=path.join(cursor,segment);try{const s=await fs.lstat(cursor);if(s.isSymbolicLink()||(!s.isDirectory()&&s.nlink!==1))fail('GIT_SCOPE_INVALID');}catch(e){if(e.code!=='ENOENT')throw e;}}}
 if(typeof ref!=='string'||ref.length>160||(ref&&!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref))||ref.includes('..')||ref.includes('//')||ref.endsWith('.lock'))fail('GIT_REF_INVALID');
 let revision='HEAD';if(ref)revision=(await git(['rev-parse','--verify','--end-of-options',`${ref}^{commit}`])).trim();
 if(ref&&!/^[a-f0-9]{40,64}$/i.test(revision))fail('GIT_REF_INVALID');
 const args={status:['status','--porcelain=v1','--untracked-files=normal','--',...files],diff:['diff','--no-ext-diff','--no-textconv','--no-renames','--unified=3',revision,'--',...files],log:['log','-8','--format=%H %ad %s','--date=iso-strict',revision,'--',...files],branches:['for-each-ref','--count=40','--format=%(refname:short) %(objectname)','refs/heads','refs/remotes'],commit:['show','--format=fuller','--no-ext-diff','--no-textconv','--no-renames','--unified=3',revision,'--',...files]}[operation];
 return {operation,repository:cwd,sourceFiles:files,ref:revision,output:await git(args),readOnly:true};
}
export function validateGithubRepository(value){if(typeof value!=='string'||!/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/.test(value)||value.includes('..'))fail('GITHUB_REPOSITORY_INVALID');return value;}
export async function inspectGithub({repository,operation,number=0,signal}){
 validateGithubRepository(repository);if(!['issues','issue','prs','pr'].includes(operation)||!Number.isSafeInteger(number)||number<0||number>10000000||(['issue','pr'].includes(operation)&&number===0))fail('GITHUB_OPERATION_DENIED');
 const collection=operation.startsWith('pr')?'pulls':'issues';const list=operation==='issues'||operation==='prs';
 const endpoint=`repos/${repository}/${collection}${list?'?state=all&per_page=5':`/${number}`}`;
 const raw=await command(GH,['api','--hostname','github.com','--method','GET',endpoint,'--jq',list?'map({number,title,state,url:.html_url,body:(.body // "" | .[0:4000])})':'{number,title,state,url:.html_url,body:(.body // "" | .[0:12000])}'],{signal,github:true});
 return {repository,operation,readOnly:true,transport:'host-managed GitHub CLI',data:JSON.parse(raw)};
}
