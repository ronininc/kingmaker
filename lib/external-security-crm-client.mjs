import { createHash } from 'node:crypto';

const CRM_ORIGIN='https://www.ronininc.org',MAX_BODY=256*1024,TIMEOUT=15_000,SHA=/^[a-f0-9]{64}$/;
const sha=(s)=>createHash('sha256').update(s).digest('hex');
const canonical=(v)=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
const uuid=(v)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v||''));
export function createFetchExternalSecurityTransport({fetchImpl=globalThis.fetch}={}) {
  return async ({url,method,headers,body}) => {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT);timer.unref?.();
    try {
      const res=await fetchImpl(url,{method,headers,body,signal:controller.signal,redirect:'error'}),declared=Number(res.headers.get('content-length')||0);
      if(declared>MAX_BODY)throw new Error('EXTERNAL_CRM_RESPONSE_TOO_LARGE');
      const reader=res.body?.getReader();let total=0,chunks=[];
      if(reader)for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_BODY){controller.abort();throw new Error('EXTERNAL_CRM_RESPONSE_TOO_LARGE')}chunks.push(value)}
      const bytes=Buffer.concat(chunks.map(x=>Buffer.from(x))),text=bytes.toString('utf8');let json=null;
      try{json=text?JSON.parse(text):null}catch{throw new Error('EXTERNAL_CRM_BAD_JSON')}
      return{status:res.status,json};
    } finally { clearTimeout(timer); }
  };
}

export function createExternalSecurityCrmClient({baseUrl=CRM_ORIGIN,bearer,attemptId,rootAttemptId,previousAttemptId=null,generation,evidenceSigningFingerprint,evidenceSigner,leaseToken,manifestDigest,rulesSnapshotDigest,sourceCommit,transport=createFetchExternalSecurityTransport()}={}){
  let origin;try{origin=new URL(baseUrl).origin}catch{throw new Error('EXTERNAL_CRM_CONFIG')}
  if(origin!==CRM_ORIGIN||baseUrl!==origin||!bearer||bearer.length<16||!uuid(attemptId)||!uuid(rootAttemptId)||previousAttemptId!==null&&!uuid(previousAttemptId)||!Number.isSafeInteger(generation)||generation<1||generation===1&&previousAttemptId!==null||generation>1&&previousAttemptId===null||!SHA.test(String(evidenceSigningFingerprint))||typeof evidenceSigner?.sign!=='function'||evidenceSigner.fingerprint!==evidenceSigningFingerprint||!leaseToken||!SHA.test(String(manifestDigest))||!SHA.test(String(rulesSnapshotDigest))||!/^[a-f0-9]{40}$/.test(String(sourceCommit))||typeof transport!=='function')throw new Error('EXTERNAL_CRM_CONFIG');
  const endpoint=(action)=>`${origin}/api/external-security/attempts/${attemptId}/${action}`;
  const call=async(action,{method='POST',payload,lease=true,extraHeaders={}}={})=>{const headers={...extraHeaders,authorization:`Bearer ${bearer}`,accept:'application/json'};if(lease)headers['x-external-security-lease']=leaseToken;if(payload!==undefined)headers['content-type']='application/json';const result=await transport({url:endpoint(action),method,headers,body:payload===undefined?undefined:JSON.stringify(payload),timeoutMs:TIMEOUT,maxBytes:MAX_BODY});if(!result||!Number.isInteger(result.status)||result.status<200||result.status>=300)throw new Error(`EXTERNAL_CRM_HTTP_${result?.status??'INVALID'}`);return result.json;};
  return{
    async claim(){const b=await call('claim');const r=b?.dispatchReceipt;if(!b?.ok||b.attemptId!==attemptId||b.status!=='leased'||!r||r.attemptId!==attemptId||r.rootAttemptId!==rootAttemptId||(r.previousAttemptId??null)!==previousAttemptId||r.generation!==generation||r.executorEvidenceSigningFingerprint!==evidenceSigningFingerprint||r.manifestDigest!==manifestDigest||r.rulesSnapshotDigest!==rulesSnapshotDigest||r.sourceCommit!==sourceCommit||r.leaseTokenHash!==sha(leaseToken)||!Number.isSafeInteger(r.authorityExpiresAt)||r.authorityExpiresAt<=r.issuedAt||!b.signature?.keyId||!b.signature?.value)throw new Error('EXTERNAL_CRM_CLAIM_BINDING');return{deduplicated:b.deduplicated===true,envelope:{lease_token:leaseToken,receipt:r,signature:b.signature}};},
    async status(){const b=await call('status',{method:'GET',lease:false});if(b?.attemptId!==attemptId||b.manifestDigest!==manifestDigest||!Number.isSafeInteger(b.leaseExpiresAt)||typeof b.status!=='string'||typeof b.jobState!=='string')throw new Error('EXTERNAL_CRM_STATUS_BINDING');return b;},
    async submitEvidence({result,summary,artifacts=[],completedAt}={}){if(!['negative','candidate'].includes(result)||typeof summary!=='string'||summary.length<1||summary.length>8000||!Array.isArray(artifacts)||artifacts.length>50||artifacts.some(x=>!x||typeof x.label!=='string'||x.label.length<1||x.label.length>500||!SHA.test(String(x.sha256)))||!Number.isSafeInteger(completedAt)||completedAt<1)throw new Error('EXTERNAL_CRM_EVIDENCE_INPUT');const evidence={schema:'ronin.external-security-evidence/v1',attemptId,manifestDigest,rulesSnapshotDigest,sourceCommit,result,summary,artifacts,completedAt,executorSigningFingerprint:evidenceSigningFingerprint},canonicalEvidence=canonical(evidence),expectedDigest=sha(canonicalEvidence),signature=await evidenceSigner.sign(Buffer.from(canonicalEvidence));if(!/^[A-Za-z0-9_-]{86}$/.test(String(signature)))throw new Error('EXTERNAL_CRM_EVIDENCE_SIGNATURE');const b=await call('evidence',{payload:evidence,extraHeaders:{'x-external-security-evidence-signature':signature}});if(!b?.ok||b.attemptId!==attemptId||b.evidenceDigest!==expectedDigest||!['evidence_review','accepted','rejected'].includes(String(b.status)))throw new Error('EXTERNAL_CRM_EVIDENCE_BINDING');return{...b,evidence};},
  };
}
