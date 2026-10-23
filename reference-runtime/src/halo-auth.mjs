import fs from 'node:fs/promises';
// Fixed protected host credential. Never supplied by a worker or returned in telemetry.
const FILE='/SETUP_REQUIRED/path-21';
export async function haloHeaders(pin){
 if(pin?.base!=='https://worker-6.invalid/v1')return {};
 let key;try{key=(await fs.readFile(FILE,'utf8')).trim();}catch(e){if(e.code==='ENOENT')return {};throw Error('HALO_CREDENTIAL_UNAVAILABLE');}
 if(!/^[A-Za-z0-9_-]{43}$/.test(key))throw Error('HALO_CREDENTIAL_INVALID');
 return {Authorization:`Bearer ${key}`};
}
