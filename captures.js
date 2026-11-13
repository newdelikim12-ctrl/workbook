/* Capture notebook: UI only; files and notes stay in CaptureStore. */
(function(){
'use strict';
const root=document.getElementById('captureView');
if(!root) return;
const state={mounted:false,visible:false,groups:[],items:[],groupId:null,mode:'feed',query:'',loadSeq:0,renderSeq:0,handles:new Set(),observer:null,busy:0,uploadTarget:null,viewerHandle:null,viewerSeq:0,viewerItem:null,zoom:1,editorBusy:false};
let ui={};
const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const action=(label,name,cls='cn-button',id)=>{const b=node('button',cls,label);b.type='button';b.dataset.action=name;if(id)b.dataset.id=id;return b;};
const pref={get(key,fallback){try{return localStorage.getItem('captureNotebook.'+key)||fallback;}catch(e){return fallback;}},set(key,value){try{localStorage.setItem('captureNotebook.'+key,value);}catch(e){}}};
state.mode=pref.get('mode','feed')==='list'?'list':'feed';state.groupId=pref.get('group','');
function errorText(err){if(err&&(/quota/i.test(err.name||'')||/quota/i.test(err.message||'')))return '저장 공간이 부족해요. 캡처를 백업한 뒤 필요 없는 자료를 정리해 주세요.';return err&&/[가-힣]/.test(err.message||'')?err.message:'처리하지 못했어요. 잠시 후 다시 시도해 주세요.';}
function status(text,isError=false){ui.status.textContent=text||'';ui.status.classList.toggle('cn-status-error',isError);}
function hasOpenDialog(){return !!(ui.editor?.open||ui.viewer?.open);}
function disposeMedia(){state.renderSeq++;state.observer?.disconnect();state.observer=null;for(const h of state.handles){try{h.destroy();}catch(e){}}state.handles.clear();}
function lock(){root.classList.toggle('cn-busy',state.busy>0);root.setAttribute('aria-busy',String(state.busy>0));root.querySelectorAll('[data-cn-lock]').forEach(b=>{b.disabled=state.busy>0||!state.groups.length;});if(ui.deleteGroup)ui.deleteGroup.disabled=state.busy>0||state.groups.length<=1;}
async function busy(fn,success){state.busy++;lock();try{const out=await fn();if(success)status(success);return out;}catch(err){status(errorText(err),true);throw err;}finally{state.busy--;lock();}}
function emptyMessage(title,detail){const box=node('div','cn-empty');box.append(node('div','cn-empty-symbol','▧'),node('strong','',title),node('p','',detail));return box;}
function mount(){
 if(state.mounted)return;state.mounted=true;
 root.classList.add('cn-root');
 const head=node('header','cn-header'),intro=node('div','cn-heading');intro.append(node('span','cn-eyebrow','MY STUDY COLLECTION'),node('h2','','캡처노트'),node('p','','캡처한 화면과 PDF를 모아 나만의 공부 흐름으로 정리해요.'));
 const backup=node('div','cn-backup-actions');const exp=action('백업','export','cn-button cn-quiet');exp.dataset.cnLock='';const imp=action('복원','restore','cn-button cn-quiet');imp.dataset.cnLock='';backup.append(exp,imp);head.append(intro,backup);
 const groups=node('div','cn-groups-area');const groupRow=node('div','cn-groups-row');ui.groups=node('div','cn-group-chips');ui.groups.id='cnGroupChips';ui.groups.setAttribute('aria-label','캡처 목록');const newGroup=action('＋ 목록','new-group','cn-button cn-outline');newGroup.dataset.cnLock='';groupRow.append(ui.groups,newGroup);groups.append(groupRow);
 const groupInfo=node('div','cn-group-info');ui.groupTitle=node('span','cn-group-title');ui.count=node('span','cn-count');const groupTools=node('div','cn-group-tools');const ren=action('이름 변경','rename-group','cn-text-button');ren.dataset.cnLock='';ui.deleteGroup=action('목록 삭제','delete-group','cn-text-button');ui.deleteGroup.dataset.cnLock='';groupTools.append(ren,ui.deleteGroup);groupInfo.append(ui.groupTitle,ui.count,groupTools);groups.append(groupInfo);
 ui.drop=node('div','cn-dropzone');ui.drop.id='cnDropzone';const upload=action('＋ 이미지·PDF 추가','upload','cn-button cn-primary');upload.dataset.cnLock='';const addNote=action('✎ 메모 추가','new-note','cn-button cn-outline');addNote.dataset.cnLock='';const uploadButtons=node('div','cn-upload-buttons');uploadButtons.append(upload,addNote);ui.drop.append(uploadButtons,node('p','','여러 파일을 한 번에 선택하거나 여기로 끌어오세요. 캡처 붙여넣기도 가능해요.'));
 const tools=node('div','cn-toolbar');const searchBox=node('div','cn-search');ui.search=node('input');ui.search.id='cnSearch';ui.search.type='search';ui.search.placeholder='제목·메모에서 찾기';ui.search.setAttribute('aria-label','캡처 제목과 메모 검색');searchBox.append(node('span','cn-search-symbol','⌕'),ui.search);
 const modes=node('div','cn-view-modes');modes.setAttribute('role','group');modes.setAttribute('aria-label','캡처 보기 방식');ui.feed=action('이어 보기','mode-feed','cn-button');ui.list=action('목록','mode-list','cn-button');modes.append(ui.feed,ui.list);tools.append(searchBox,modes);
 ui.status=node('p','cn-status');ui.status.id='cnStatus';ui.status.setAttribute('role','status');ui.status.setAttribute('aria-live','polite');ui.items=node('div','cn-items');ui.items.id='cnItems';
 const local=node('p','cn-local-note','자료는 이 브라우저에 저장돼요. 기기를 바꾸거나 브라우저 데이터를 지우기 전에 캡처 백업을 저장해 주세요.');
 ui.file=node('input');ui.file.id='cnFileInput';ui.file.type='file';ui.file.multiple=true;ui.file.accept='image/*,application/pdf,.pdf';ui.file.hidden=true;
 ui.restore=node('input');ui.restore.id='cnRestoreInput';ui.restore.type='file';ui.restore.accept='application/json,.json';ui.restore.hidden=true;
 ui.editor=node('dialog','cn-dialog');ui.editor.id='cnEditor';ui.editor.setAttribute('aria-labelledby','cnEditorTitle');ui.editor.addEventListener('cancel',e=>{if(state.editorBusy)e.preventDefault();});ui.editor.addEventListener('close',()=>{if(!ui.editor.open&&!state.editorBusy)ui.editor.replaceChildren();});
 ui.viewer=node('dialog','cn-viewer');ui.viewer.id='cnViewer';ui.viewer.setAttribute('aria-labelledby','cnViewerTitle');ui.viewer.addEventListener('close',()=>{if(!ui.viewer.open)disposeViewer();});
 root.append(head,groups,ui.drop,tools,ui.status,ui.items,local,ui.file,ui.restore,ui.editor,ui.viewer);
 root.addEventListener('click',onClick);
 root.addEventListener('keydown',e=>{const typing=e.target.matches?.('input,textarea,select')||e.target.isContentEditable;if(e.shiftKey&&!e.altKey&&!e.ctrlKey&&!e.metaKey&&(e.key==='ArrowLeft'||e.key==='ArrowRight')&&!typing&&!hasOpenDialog())return;e.stopPropagation();});
 ui.search.addEventListener('input',()=>{state.query=ui.search.value.trim().toLowerCase();renderItems();});
 ui.file.addEventListener('change',()=>{const files=[...ui.file.files];ui.file.value='';const target=state.uploadTarget||{groupId:state.groupId,afterId:null};state.uploadTarget=null;if(files.length)uploadFiles(files,target).catch(()=>{});});
 ui.file.addEventListener('cancel',()=>{state.uploadTarget=null;});
 ui.restore.addEventListener('change',()=>{const file=ui.restore.files[0];ui.restore.value='';if(file)restoreArchive(file);});
 let dragDepth=0;ui.drop.addEventListener('dragenter',e=>{e.preventDefault();dragDepth++;ui.drop.classList.add('cn-dragging');});ui.drop.addEventListener('dragover',e=>{e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='copy';});ui.drop.addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;ui.drop.classList.remove('cn-dragging');}});ui.drop.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;ui.drop.classList.remove('cn-dragging');if(e.dataTransfer?.files.length)uploadFiles([...e.dataTransfer.files],{groupId:state.groupId,afterId:null}).catch(()=>{});});
 document.addEventListener('paste',e=>{if(!state.visible||hasOpenDialog()||e.target.matches?.('input,textarea,select')||e.target.isContentEditable)return;const files=[...(e.clipboardData?.files||[])];if(files.length){e.preventDefault();uploadFiles(files,{groupId:state.groupId,afterId:null}).catch(()=>{});}});
}
async function open(){mount();state.visible=true;await refresh();}
function close(){state.visible=false;state.loadSeq++;disposeMedia();if(ui.viewer?.open)ui.viewer.close();}
async function refresh(){
 const seq=++state.loadSeq;status('자료를 불러오는 중…');
 try{
  await window.CaptureStore.ready();const groups=await window.CaptureStore.listGroups();if(seq!==state.loadSeq)return;
  state.groups=groups;if(!groups.some(g=>g.id===state.groupId))state.groupId=groups[0]?.id||null;
  const items=state.groupId?await window.CaptureStore.listItems(state.groupId):[];if(seq!==state.loadSeq)return;
  state.items=items;pref.set('group',state.groupId||'');renderGroups();renderItems();status('');
 }catch(err){if(seq!==state.loadSeq)return;status(errorText(err),true);disposeMedia();ui.items.replaceChildren(emptyMessage('자료를 열지 못했어요','저장 공간 사용이 가능한 브라우저에서 다시 시도해 주세요.'));}
}
function renderGroups(){
 ui.groups.replaceChildren();for(const group of state.groups){const b=action(group.name,'group','cn-group-chip',group.id);b.setAttribute('aria-pressed',String(group.id===state.groupId));ui.groups.append(b);}
 const group=state.groups.find(g=>g.id===state.groupId);ui.groupTitle.textContent=group?.name||'내 캡처';ui.count.textContent=state.items.length+'개';lock();
}
function itemMatches(item){if(!state.query)return true;return [item.title,item.caption,item.text,item.fileName].some(v=>String(v||'').toLowerCase().includes(state.query));}
function renderItems(){
 disposeMedia();const seq=state.renderSeq;ui.items.replaceChildren();ui.items.dataset.mode=state.mode;ui.feed.setAttribute('aria-pressed',String(state.mode==='feed'));ui.list.setAttribute('aria-pressed',String(state.mode==='list'));pref.set('mode',state.mode);
 const items=state.items.filter(itemMatches);if(!items.length){ui.items.append(emptyMessage(state.query?'검색 결과가 없어요':'첫 캡처를 모아 보세요',state.query?'다른 제목이나 메모로 검색해 보세요.':'이미지와 PDF를 넣고, 자료 사이에 메모를 추가할 수 있어요.'));return;}
 const pending=[];
 items.forEach((item,index)=>{
  const card=node('article','cn-item'+(item.kind==='note'?' cn-note-card':''));card.dataset.itemId=item.id;
  const head=node('div','cn-item-head');const info=node('div','cn-item-info');info.append(node('span','cn-item-type',item.kind==='pdf'?'PDF':item.kind==='image'?'IMAGE':'MEMO'),node('h3','cn-item-title',item.title||(item.kind==='note'?'내 메모':item.fileName||'학습 자료')));
  const menu=node('details','cn-item-menu');const summary=node('summary','cn-menu-trigger','⋯');summary.setAttribute('aria-label',(item.title||'자료')+' 관리');const menuPanel=node('div','cn-menu-panel');
  for(const [label,name] of [['아래에 파일 삽입','insert-files'],['아래에 메모 삽입','insert-note'],['위로 이동','up'],['아래로 이동','down'],['다른 목록으로 이동','move']]){const b=action(label,name,'cn-menu-button',item.id);if(name==='up')b.disabled=state.items[0]?.id===item.id;if(name==='down')b.disabled=state.items[state.items.length-1]?.id===item.id;if(name==='move')b.disabled=state.groups.length<2;menuPanel.append(b);}
  if(item.kind!=='note')menuPanel.append(action('원본 저장','download','cn-menu-button',item.id));menuPanel.append(action('삭제','delete-item','cn-menu-button cn-danger',item.id));menu.append(summary,menuPanel);head.append(info,menu);card.append(head);
  if(item.kind==='note')card.append(node('div','cn-note-text',item.text||''));
  else{const media=node('div','cn-media-host');media.dataset.mediaId=item.id;media.setAttribute('role','button');media.tabIndex=0;media.setAttribute('aria-label',(item.title||'자료')+' 확대 보기');media.addEventListener('click',e=>{if(e.target.closest('a,button'))return;openViewer(item);});media.addEventListener('keydown',e=>{if(e.target===media&&(e.key==='Enter'||e.key===' ')){e.preventDefault();openViewer(item);}});media.append(node('div','cn-media-loading',item.kind==='pdf'?'PDF를 준비하는 중…':'이미지를 준비하는 중…'));card.append(media);pending.push([media,item]);if(item.caption)card.append(node('p','cn-caption',item.caption));}
  const foot=node('div','cn-item-foot');const detail=node('span','cn-item-detail',item.kind==='note'?'텍스트 메모':formatSize(item.size));const buttons=node('div','cn-item-actions');buttons.append(action(item.kind==='note'?'메모 편집':'제목·메모','edit-item','cn-button cn-small cn-quiet',item.id));if(item.kind!=='note')buttons.append(action('확대 ↗','zoom','cn-button cn-small cn-outline',item.id));foot.append(detail,buttons);card.append(foot);ui.items.append(card);
 });
 if('IntersectionObserver' in window){state.observer=new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting)continue;state.observer?.unobserve(entry.target);const item=state.items.find(i=>i.id===entry.target.dataset.mediaId);if(item)mountMedia(entry.target,item,seq);}}, {rootMargin:'700px 0px'});pending.forEach(([host])=>state.observer.observe(host));}
 else pending.forEach(([host,item])=>mountMedia(host,item,seq));
}
async function mountMedia(host,item,seq){
 try{const blob=await window.CaptureStore.getFile(item.fileId);if(seq!==state.renderSeq||!host.isConnected)return;host.replaceChildren();const handle=await window.CaptureMedia.mount(host,item,blob,{thumbnail:state.mode==='list',zoom:1});if(seq!==state.renderSeq||!host.isConnected){handle?.destroy();return;}if(handle)state.handles.add(handle);}
 catch(err){if(seq!==state.renderSeq||!host.isConnected)return;host.replaceChildren(node('div','cn-media-error','미리보기를 열지 못했어요. 메뉴에서 원본을 저장할 수 있어요.'));}
}
function formatSize(size){if(!size)return '';return size>=1048576?(size/1048576).toFixed(1)+' MB':Math.max(1,Math.round(size/1024))+' KB';}
function getItem(id){return state.items.find(i=>i.id===id);}
function selectFiles(afterId=null){state.uploadTarget={groupId:state.groupId,afterId};ui.file.click();}
async function uploadFiles(files,target){if(state.busy)return;await busy(async()=>{status(files.length+'개 파일을 저장하는 중…');await window.CaptureStore.addFiles(target.groupId,files,target.afterId);await refresh();},files.length+'개 자료를 추가했어요.');}
async function onClick(e){
 for(const menu of root.querySelectorAll('.cn-item-menu[open]'))if(!menu.contains(e.target))menu.open=false;
 const b=e.target.closest('button[data-action]');if(!b||b.disabled)return;const name=b.dataset.action,id=b.dataset.id,item=id?getItem(id):null;
 if(b.closest('.cn-item-menu'))b.closest('.cn-item-menu').open=false;
 try{
  if(name==='group'){if(state.groupId!==id){state.groupId=id;await refresh();}return;}
  if(name==='mode-feed'||name==='mode-list'){state.mode=name==='mode-feed'?'feed':'list';renderItems();return;}
  if(name==='upload'){selectFiles();return;}if(name==='insert-files'){selectFiles(id);return;}
  if(name==='new-group'){groupDialog();return;}if(name==='rename-group'){groupDialog(state.groups.find(g=>g.id===state.groupId));return;}if(name==='delete-group'){deleteGroupDialog();return;}
  if(name==='new-note'||name==='insert-note'){noteDialog(null,name==='insert-note'?id:null);return;}
  if(name==='edit-item'&&item){if(item.kind==='note')noteDialog(item);else fileDialog(item);return;}
  if(name==='zoom'&&item){openViewer(item);return;}
  if((name==='up'||name==='down')&&item){await busy(async()=>{await window.CaptureStore.reorderItem(item.id,name==='up'?-1:1);await refresh();});return;}
  if(name==='move'&&item){moveDialog(item);return;}if(name==='delete-item'&&item){deleteItemDialog(item);return;}if(name==='download'&&item){await downloadItem(item);return;}
  if(name==='export'){await busy(async()=>{status('캡처 백업을 만드는 중…');const blob=await window.CaptureStore.exportArchive();downloadBlob(blob,'캡처노트-백업-'+new Date().toISOString().slice(0,10)+'.json');},'캡처 백업 파일을 저장했어요.');return;}
  if(name==='restore'){ui.restore.click();return;}
 }catch(err){/* busy() has already shown the recoverable failure. */}
}
function makeField(spec){const wrap=node('label','cn-field');wrap.append(node('span','cn-field-label',spec.label));const input=node(spec.type==='textarea'?'textarea':spec.type==='select'?'select':'input');input.name=spec.name;input.id='cnField-'+spec.name;if(spec.type==='textarea'){input.rows=spec.rows||5;input.enterKeyHint='enter';}else if(spec.type!=='select')input.type='text';if(spec.required)input.required=true;if(spec.maxLength)input.maxLength=spec.maxLength;if(spec.options)for(const option of spec.options){const o=node('option','',option.label);o.value=option.value;input.append(o);}input.value=spec.value||'';if(spec.placeholder)input.placeholder=spec.placeholder;wrap.append(input);return wrap;}
function showDialog(config){
 if(ui.editor.open)return;ui.editor.replaceChildren();const form=node('form','cn-editor-form');form.method='dialog';const title=node('h3','cn-dialog-title',config.title);title.id='cnEditorTitle';form.append(title);if(config.description)form.append(node('p','cn-dialog-description',config.description));for(const field of config.fields||[])form.append(makeField(field));const error=node('p','cn-dialog-error');error.setAttribute('role','alert');const actions=node('div','cn-dialog-actions');const cancel=node('button','cn-button cn-outline','취소');cancel.type='button';const submit=node('button','cn-button '+(config.danger?'cn-danger-solid':'cn-primary'),config.submitLabel||'저장');submit.type='submit';actions.append(cancel,submit);form.append(error,actions);ui.editor.append(form);
 cancel.addEventListener('click',()=>ui.editor.close());form.addEventListener('submit',async e=>{e.preventDefault();if(state.editorBusy||!form.reportValidity())return;error.textContent='';state.editorBusy=true;submit.disabled=true;cancel.disabled=true;try{const values=Object.fromEntries(new FormData(form));await config.onSubmit(values);ui.editor.close();await refresh();if(config.success)status(config.success);}catch(err){error.textContent=errorText(err);}finally{state.editorBusy=false;submit.disabled=false;cancel.disabled=false;if(!ui.editor.open)ui.editor.replaceChildren();}});
 form.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)&&!e.isComposing&&e.keyCode!==229){e.preventDefault();form.requestSubmit();}});ui.editor.showModal();setTimeout(()=>form.querySelector('input,textarea,select,button')?.focus(),0);
}
function groupDialog(group){showDialog({title:group?'목록 이름 변경':'새 목록 만들기',fields:[{name:'name',label:'목록 이름',required:true,maxLength:100,value:group?.name||'',placeholder:'예: 영어 독해, 시험 오답 모음'}],submitLabel:group?'변경':'만들기',success:group?'목록 이름을 변경했어요.':'새 목록을 만들었어요.',onSubmit:async v=>{if(group)await window.CaptureStore.renameGroup(group.id,v.name);else{const added=await window.CaptureStore.createGroup(v.name);state.groupId=added.id;}}});}
function noteDialog(item,afterId=null){const groupId=state.groupId;showDialog({title:item?'메모 편집':'메모 삽입',fields:[{name:'text',label:'메모',type:'textarea',required:true,rows:7,value:item?.text||'',placeholder:'공부하며 떠오른 생각이나 헷갈리는 내용을 적어 두세요. Enter로 줄바꿈할 수 있어요.'}],success:item?'메모를 수정했어요.':'메모를 추가했어요.',onSubmit:async v=>{if(item)await window.CaptureStore.updateItem(item.id,{text:v.text});else await window.CaptureStore.addNote(groupId,v.text,afterId);}});}
function fileDialog(item){showDialog({title:'자료 제목·메모',fields:[{name:'title',label:'제목',required:true,maxLength:200,value:item.title||item.fileName||''},{name:'caption',label:'이 자료의 메모',type:'textarea',rows:5,value:item.caption||'',placeholder:'핵심 내용이나 다시 볼 부분을 기록해 보세요.'}],success:'제목과 메모를 저장했어요.',onSubmit:v=>window.CaptureStore.updateItem(item.id,{title:v.title,caption:v.caption})});}
function deleteItemDialog(item){showDialog({title:'이 자료를 삭제할까요?',description:'“'+(item.title||'내 메모')+'” 자료와 연결된 메모가 삭제됩니다.',danger:true,submitLabel:'삭제',success:'자료를 삭제했어요.',onSubmit:()=>window.CaptureStore.removeItem(item.id)});}
function deleteGroupDialog(){const group=state.groups.find(g=>g.id===state.groupId);if(!group)return;showDialog({title:'이 목록을 삭제할까요?',description:'“'+group.name+'” 목록의 자료와 메모 '+state.items.length+'개가 함께 삭제됩니다. 필요하면 먼저 캡처 백업을 저장해 주세요.',danger:true,submitLabel:'목록과 자료 삭제',success:'목록을 삭제했어요.',onSubmit:()=>window.CaptureStore.deleteGroup(group.id)});}
function moveDialog(item){showDialog({title:'다른 목록으로 이동',fields:[{name:'groupId',label:'이동할 목록',type:'select',required:true,options:state.groups.filter(g=>g.id!==item.groupId).map(g=>({value:g.id,label:g.name}))}],submitLabel:'이동',success:'다른 목록으로 옮겼어요.',onSubmit:v=>window.CaptureStore.moveItem(item.id,v.groupId)});}
function restoreArchive(file){const known=new Set(state.groups.map(g=>g.id));showDialog({title:'캡처 백업을 복원할까요?',description:'현재 자료는 그대로 유지하고 백업의 목록과 자료를 추가합니다.',submitLabel:'추가해서 복원',success:'백업의 자료를 추가했어요.',onSubmit:async()=>{const result=await window.CaptureStore.importArchive(file);const restored=result.groups.find(g=>!known.has(g.id));if(restored)state.groupId=restored.id;}});}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=node('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
async function downloadItem(item){try{downloadBlob(await window.CaptureStore.getFile(item.fileId),item.fileName||item.title||'학습자료');}catch(err){status(errorText(err),true);}}
function disposeViewer(){state.viewerSeq++;try{state.viewerHandle?.destroy();}catch(e){}state.viewerHandle=null;state.viewerItem=null;}
async function openViewer(item){
 if(ui.viewer.open)return;disposeViewer();state.viewerItem=item;state.zoom=1;const seq=state.viewerSeq;ui.viewer.replaceChildren();const bar=node('div','cn-viewer-bar');const title=node('strong','cn-viewer-title',item.title||item.fileName||'자료 보기');title.id='cnViewerTitle';const controls=node('div','cn-viewer-controls');const minus=node('button','cn-button cn-icon','−');minus.type='button';minus.setAttribute('aria-label','축소');const plus=node('button','cn-button cn-icon','＋');plus.type='button';plus.setAttribute('aria-label','확대');const fit=node('button','cn-button cn-quiet','화면에 맞춤');fit.type='button';const rotation=node('button','cn-button cn-icon','↻');rotation.type='button';rotation.setAttribute('aria-label','오른쪽으로 회전');const closeButton=node('button','cn-button cn-icon','✕');closeButton.type='button';closeButton.setAttribute('aria-label','확대 보기 닫기');const level=node('span','cn-zoom-level','100%');level.setAttribute('aria-live','polite');controls.append(minus,level,plus,fit,rotation,closeButton);bar.append(title,controls);const scroll=node('div','cn-viewer-scroll');const host=node('div','cn-viewer-host');scroll.append(host);ui.viewer.append(bar,scroll);host.append(node('div','cn-media-loading','자료를 여는 중…'));
 let angle=item.rotation||0;function setZoom(value){state.zoom=Math.max(.5,Math.min(3,value));level.textContent=Math.round(state.zoom*100)+'%';minus.disabled=state.zoom<=.5;plus.disabled=state.zoom>=3;state.viewerHandle?.setZoom(state.zoom);}minus.addEventListener('click',()=>setZoom(state.zoom-.25));plus.addEventListener('click',()=>setZoom(state.zoom+.25));fit.addEventListener('click',()=>{setZoom(1);scroll.scrollTo({top:0,left:0});});rotation.addEventListener('click',()=>{angle=(angle+90)%360;state.viewerHandle?.rotate(angle);});closeButton.addEventListener('click',()=>ui.viewer.close());ui.viewer.showModal();closeButton.focus();
 try{const blob=await window.CaptureStore.getFile(item.fileId);if(seq!==state.viewerSeq||!ui.viewer.open)return;host.replaceChildren();const handle=await window.CaptureMedia.mount(host,item,blob,{thumbnail:false,zoom:state.zoom});if(seq!==state.viewerSeq||!ui.viewer.open){handle?.destroy();return;}state.viewerHandle=handle;if(angle!==(item.rotation||0))handle?.rotate(angle);if(state.zoom!==1)handle?.setZoom(state.zoom);}
 catch(err){if(seq!==state.viewerSeq||!ui.viewer.open)return;host.replaceChildren(node('div','cn-media-error','자료를 열지 못했어요. 닫은 뒤 메뉴에서 원본을 저장해 주세요.'));}
}
window.CaptureNotebook={open,close,hasOpenDialog};
mount();lock();if(root.style.display!=='none')open();
})();
