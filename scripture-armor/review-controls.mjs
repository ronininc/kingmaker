// Original browser-only controls. All untrusted content is assigned with textContent.
export const REVIEW_INTAKE_MARKUP = `<section class="sandbox-intake" aria-label="Isolated sandbox review"><h3>SCAN IN SANDBOX</h3><div class="review-inputs"><div id="reviewDropzone" tabindex="0" role="group" aria-label="Drop a file or public link for review"><span class="review-drop-icon" aria-hidden="true">↥</span><strong>Drag and drop a file here</strong><span class="review-drop-choice">or <button id="reviewUpload" class="review-choose" type="button">Choose a file</button><a id="nativeReviewFile" class="review-choose" href="scripture-armor://review-file" hidden>Choose a file</a></span><small>One file at a time · Up to 16 MiB · Reviewed in isolation</small><input id="reviewFile" class="review-file-input" type="file" aria-label="File for sandbox review"></div><div class="review-link-bar"><span aria-hidden="true">↗</span><input id="reviewLink" type="url" aria-label="Link for sandbox review" placeholder="Paste links here" autocomplete="off" spellcheck="false"><button id="reviewOpenLink" type="button">SCAN</button></div><p class="review-link-hint">Webpage or repository link</p></div><section id="repositoryProgress" hidden><h4 id="repositoryTitle"></h4><p id="repositoryStatus" role="status"></p><p id="repositoryCurrent"></p><button id="repositoryPause">PAUSE</button><button id="repositoryResume">RESUME</button><button id="repositoryReport">DOWNLOAD NAMED REPORT</button><ol id="repositoryFindings"></ol></section><p id="reviewResult" role="status" aria-live="assertive"></p><p id="reviewScope"></p><section id="findingReportPanel" hidden><h4 id="findingReportTitle"></h4><ol id="findingList"></ol><button id="downloadFindingReport">DOWNLOAD FINDINGS REPORT</button></section><section id="retainPanel" hidden><h4>KEEP USEFUL TEXT?</h4><p id="retainNotice"></p><textarea id="retainText" aria-label="Useful portions to retain" rows="6" style="width:100%"></textarea><button id="retainSelected" type="button">SCAN & SAVE SELECTED TEXT</button><p id="retainScope"></p></section><button id="ejectOriginal" hidden>PERMANENTLY REMOVE REVIEWED ORIGINAL</button><section id="reviewPreviewPanel" hidden><h4>INERT PREVIEW</h4><p id="reviewPreviewNotice"></p><pre id="reviewPreview"></pre></section><details><summary>Review limits and technical details</summary><p>Preview is inert text. Public HTTPS links are fetched without browser cookies or account credentials. Linked responses are limited to 16 MiB; oversized text pages receive an explicitly partial review. Private pages, unsupported formats and incomplete repository coverage are reported. Ejection destroys the review workspace. Removing the original requires native review and confirmation.</p><pre id="reviewDetails"></pre></details></section>`;
export function attachReviewControls({q,call,feedback,refresh,document,window,location}) {

let reviewBusy=false,originalEjectionId=null,findingReport=null;
const native=new URLSearchParams(location.search).get('native')==='1';q('#nativeReviewFile').hidden=!native;q('#reviewUpload').hidden=native;
// Only drop-box geometry crosses this channel; paths and commands never do.
if(native&&window.webkit?.messageHandlers?.armorDropGeometry&&q('#reviewDropzone').getBoundingClientRect){
 let pending=false;
 const geometry=()=>{if(pending)return;pending=true;window.requestAnimationFrame(()=>{pending=false;const r=q('#reviewDropzone').getBoundingClientRect();window.webkit.messageHandlers.armorDropGeometry.postMessage({x:r.x,y:r.y,width:r.width,height:r.height});});};
 window.addEventListener('resize',geometry);document.addEventListener('scroll',geometry,true);
 if(window.ResizeObserver)new window.ResizeObserver(geometry).observe(document.body);
 geometry();
}
let repositoryId=null;
window.showRepositoryProgress=job=>{
 q('#repositoryProgress').hidden=!job;if(!job)return;repositoryId=job.id;
 q('#repositoryTitle').textContent=job.title;
 q('#repositoryStatus').textContent=job.state+' · '+job.scanned+' / '+job.totalFiles+' files · '+job.codeLines+' code lines inspected · '+job.findings+' findings · '+job.deferred+' coverage gaps · '+(job.estimateSeconds===null?'Time estimate calculating during inventory.':'Estimated '+job.estimateSeconds+' seconds remaining.');
 q('#repositoryCurrent').textContent=job.currentFile||'Pinning revision and enumerating files…';
 const root=q('#repositoryFindings');if(root.replaceChildren){root.replaceChildren();for(const f of job.recentFindings){const row=document.createElement('li');row.textContent=f.severity.toUpperCase()+' — '+(f.title||f.rule)+' — '+f.file+' — '+(f.detail||'Static risk pattern; not proof of a breach.');root.append(row);}}
};
q('#repositoryPause').onclick=()=>call('/api/review/repository-control',{method:'POST',body:JSON.stringify({action:'pause'})});
q('#repositoryResume').onclick=()=>call('/api/review/repository-control',{method:'POST',body:JSON.stringify({action:'resume'})});
q('#repositoryReport').onclick=()=>{if(repositoryId)window.webkit?.messageHandlers?.armorSaveReport?.postMessage({id:repositoryId,title:q('#repositoryTitle').textContent});};
window.renderDeviceFindings=items=>{
 const root=q('#deviceFindings');if(!root?.replaceChildren)return;root.replaceChildren();
 for(const item of items.slice(0,256)){
  const row=document.createElement('p'),label=document.createElement('span'),button=document.createElement('button');
  label.textContent=item.name+' — review required. ';button.textContent='REVIEW & REMOVE';
  button.disabled=!native;button.onclick=()=>window.webkit?.messageHandlers?.armorDeviceReview?.postMessage({id:item.id});
  row.append(label,button);root.append(row);
 }
};
q('#ejectOriginal').onclick=()=>{if(originalEjectionId&&window.webkit?.messageHandlers?.armorFileEjection)window.webkit.messageHandlers.armorFileEjection.postMessage({id:originalEjectionId});};
function showEjection(result){originalEjectionId=null;q('#ejectOriginal').hidden=true;q('#reviewResult').textContent=result.ejection?.announcement||result.error||'No removal receipt was returned.';q('#reviewPreviewPanel').hidden=true;}
q('#retainSelected').onclick=()=>{const text=q('#retainText').value;if(native&&text&&text.length<=32768)window.webkit?.messageHandlers?.armorRetainText?.postMessage({text});};
q('#downloadFindingReport').onclick=()=>{if(findingReport)window.webkit?.messageHandlers?.armorSaveFindingReport?.postMessage({title:findingReport.title,text:JSON.stringify(findingReport,null,2)});};
function showReview(result){
 const r=result.review;q('#retainScope').textContent=result.sourceEjectionId?'Skip retention if you want to remove the reviewed original without keeping notes. Removal still requires native confirmation.':'This review has no authorized local-original removal receipt. It does not remove a remote webpage or repository.';
 const title=(result.source?.repository||result.source?.host||r.format||'File')+' — Security Findings Report';
 findingReport={schema:'scripture-armor.review-report/1',title,createdAt:new Date().toISOString(),basis:'Static evidence; not proof of a breach or infection.',source:result.source||null,review:r};
 q('#findingReportPanel').hidden=false;q('#findingReportTitle').textContent=title;
 const list=q('#findingList');if(list.replaceChildren){list.replaceChildren();for(const f of (r.findings||[]).filter(f=>f.severity!=='info')){const row=document.createElement('li');row.textContent=f.severity.toUpperCase()+' — '+(f.title||f.rule)+' — '+(f.location||'Location unavailable')+' — '+(f.detail||'Potential risk pattern; not proof of execution.')+(f.excerpt?' Evidence: '+f.excerpt:'');list.append(row);}}
q('#retainPanel').hidden=!r.retention||!native;q('#retainText').value=r.retention?.text||'';q('#retainNotice').textContent=r.retention?.notice||'';originalEjectionId=result.sourceEjectionId||null;q('#ejectOriginal').hidden=!originalEjectionId;
 q('#reviewResult').textContent=r.announcement||'Review finished with limitations. See the details.';
 q('#reviewResult').style.color=r.disposition==='ejected'?'#ff9b8b':'#f7d878';
 q('#reviewDetails').textContent=JSON.stringify({review:r,source:result.source||null},null,2);
 q('#reviewPreviewPanel').hidden=!r.preview;
 q('#reviewPreview').textContent=r.preview?.text||'';
 q('#reviewPreviewNotice').textContent=r.preview?(r.preview.notice+(r.preview.truncated?' Preview truncated.':'')):'';
 const source=result.source;
 q('#reviewScope').textContent=source?source.scope+(source.commit?' Revision: '+source.commit+'.':'')+(source.files?' '+source.files.length+' inventory entries shown.':''):'';
}
async function reviewIntake(file,url){
 if(reviewBusy){feedback('One review is already running. Please wait.',true);return;}
 if(file&&(!file.size||file.size>16*1024*1024)){feedback('Choose a nonempty file up to 16 MiB.',true);return;}
 if(!file&&(!url||url.length>4096||!/^https:\/\//i.test(url))){feedback('Drop a file or paste one public HTTPS link.',true);return;}
 originalEjectionId=null;q('#ejectOriginal').hidden=true;reviewBusy=true;q('#reviewUpload').disabled=true;q('#reviewOpenLink').disabled=true;
 q('#reviewPreviewPanel').hidden=true;q('#reviewPreview').textContent='';q('#reviewScope').textContent='';
 q('#reviewResult').textContent='Preparing a fresh isolated review workspace…';
 try{
  const result=file?await call('/api/review/upload',{method:'POST',headers:{'content-type':'application/octet-stream','x-armor-filename':encodeURIComponent(file.name)},body:file}):await call('/api/review/link',{method:'POST',body:JSON.stringify({url})});
  if(result.repositoryJob){window.showRepositoryProgress(result.repositoryJob);q('#reviewResult').textContent='Whole-repository inspection started. Findings are advisory; the device admin decides what to admit or remove.';}else showReview(result);q('#reviewFile').value='';q('#reviewLink').value='';await refresh();
 }catch(error){q('#reviewResult').textContent=error.message;}
 finally{reviewBusy=false;q('#reviewUpload').disabled=false;q('#reviewOpenLink').disabled=false;}
}
q('#reviewUpload').onclick=()=>q('#reviewFile').click();
q('#reviewFile').onchange=()=>{const file=q('#reviewFile').files?.[0];if(file)return reviewIntake(file);};
q('#reviewOpenLink').onclick=()=>reviewIntake(null,q('#reviewLink').value.trim());
q('#reviewLink').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();reviewIntake(null,q('#reviewLink').value.trim());}};
document.addEventListener('dragover',event=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='copy';});
document.addEventListener('drop',event=>{
 event.preventDefault();event.stopPropagation();
 const data=event.dataTransfer;if(!data)return;
 const files=[...data.files];
 if(files.length){if(files.length!==1){feedback('Drop one file at a time.',true);return;}return reviewIntake(files[0]);}
 const uri=data.getData('text/uri-list').split(/\r?\n/).find(line=>line.trim()&&!line.startsWith('#'))||data.getData('text/plain').trim();
 return reviewIntake(null,uri?.trim());
});

window.showReview=showReview;window.showEjection=showEjection;
return {reviewIntake,showReview,showEjection};
}
export const REVIEW_INTAKE_SCRIPT='('+attachReviewControls.toString()+')({q,call,feedback,refresh,document,window,location});';
