import path from 'node:path';
import { advisorRequestError, validateRequest } from './advisor-local.mjs';
import {throwIfAdvisorCancelled} from './advisor-cancellation.mjs';

const PARALLEL_WORKERS = ['r9700', 'r9700b', 'rtx3090'];

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function validateParallelRequests(requests) {
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > PARALLEL_WORKERS.length) fail('PARALLEL_REQUEST_COUNT_INVALID');

  const validated = requests.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_FIELDS');
    if (!Object.hasOwn(raw, 'worker') || !Object.hasOwn(raw, 'mode')) fail('EXPLICIT_WORKER_ONLY_REQUIRED');
    if (!Object.hasOwn(raw, 'execution') || !['tools', 'inference'].includes(raw.execution)) fail('EXPLICIT_EXECUTION_REQUIRED');
    const { engine = 'direct', ...advisorRequest } = raw;
    if (engine !== 'direct') fail('PARALLEL_ENGINE_UNSUPPORTED');
    const request = validateRequest(advisorRequest);
    // Preserve omission until the live profile is known in service.run().
    if(advisorRequest.maxOutputTokens===undefined)delete request.maxOutputTokens;
    if (!PARALLEL_WORKERS.includes(request.worker)) fail('PARALLEL_WORKER_INVALID');
    if (request.mode !== `${request.worker}-only`) fail('EXPLICIT_WORKER_ONLY_REQUIRED');
    const rolePrefix = request.worker === 'rtx3090' ? 'rtx3090_' : `${request.worker}_`;
    if (!request.role.startsWith(rolePrefix)) fail('WORKER_ROLE_MISMATCH');
    return request;
  });

  const workers = validated.map((request) => request.worker);
  if (new Set(workers).size !== workers.length) {
    fail('PARALLEL_WORKERS_MUST_BE_DISTINCT');
  }

  const writeOwners = new Map();
  for (const request of validated) {
    for (const file of request.allowedFiles) {
      const absolute = path.resolve(request.directory, file).toLowerCase();
      const owner = writeOwners.get(absolute);
      if (owner) fail('PARALLEL_WRITE_SCOPE_OVERLAP');
      writeOwners.set(absolute, request.worker);
    }
  }
  return validated;
}

/**
 * Run one to three unique R9700A, R9700B and/or RTX3090 Advisor requests after all
 * pass schema validation and source preflight. The AdvisorLocal instance owns
 * all health, lease, containment, runtime and receipt behavior.
 */
export async function delegateParallelWorkers({ service, requests,signal }) {
  throwIfAdvisorCancelled(signal);
  if (!service || typeof service.preflight !== 'function' || typeof service.run !== 'function') {
    fail('PARALLEL_SERVICE_REQUIRED');
  }

  const validated = validateParallelRequests(requests);
  const preflights = await Promise.allSettled(validated.map((request) => service.preflight(request,{signal})));
  throwIfAdvisorCancelled(signal);
  const preflightByWorker = {};
  let preflightFailed = false;
  for (let index = 0; index < validated.length; index += 1) {
    const worker = validated[index].worker;
    const outcome = preflights[index];
    const result = outcome.status === 'fulfilled'
      ? outcome.value
      : advisorRequestError(outcome.reason);
    preflightByWorker[worker] = {
      status: result?.status ?? 'ERROR',
      ...(Number.isSafeInteger(result?.bytes) ? { bytes: result.bytes } : {}),
      ...(Number.isSafeInteger(result?.limitBytes) ? { limitBytes: result.limitBytes } : {}),
      ...(typeof result?.reason === 'string' ? { reason: result.reason } : {}),
      ...(typeof result?.next === 'string' ? { next: result.next } : {}),
      ...(result?.details ? { details: result.details } : {}),
    };
    if (result?.status !== 'READY') preflightFailed = true;
  }

  if (preflightFailed) {
    return {
      status: 'PREFLIGHT_FAILED',
      workers: preflightByWorker,
      inferenceStarted: false,
      dispatchStarted: false,
      integrationAuthorized: false,
    };
  }

  // Rendezvous the explicit independent workers; an early failure releases peers.
  let ready=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const beforeInference=async()=>{throwIfAdvisorCancelled(signal);if(++ready===validated.length)release();await gate;throwIfAdvisorCancelled(signal);};
  const onAbort=()=>release();signal?.addEventListener('abort',onAbort,{once:true});
  if(signal?.aborted)release();
  let settled;
  try {settled=await Promise.allSettled(validated.map(async request=>{try{return await service.run(request,{signal,beforeInference});}finally{release();}}));}
  finally {signal?.removeEventListener('abort',onAbort);}
  const workerResults = {};
  let delivered = 0, complete = 0;
  for (let index = 0; index < validated.length; index += 1) {
    const worker = validated[index].worker;
    const outcome = settled[index];
    if (outcome.status === 'fulfilled') {
      const receipt = outcome.value;
      workerResults[worker] = {
        status: receipt?.status ?? 'ERROR',
        ...(typeof receipt?.model === 'string' ? { model: receipt.model } : {}),
        receipt,
      };
      if (receipt?.status === 'DELIVERED') {delivered += 1;if(!receipt.completion||receipt.completion.outcome==='complete')complete += 1;}
    } else {
      workerResults[worker] = {
        ...advisorRequestError(outcome.reason),
        status: 'ERROR',
      };
    }
  }

  return {
    status: signal?.aborted ? 'CANCELLED' : complete === validated.length ? 'COMPLETE' : delivered > 0 ? 'PARTIAL' : 'FAILED',
    workers: workerResults,
    dispatchStarted: true,
    integrationAuthorized: false,
  };
}
