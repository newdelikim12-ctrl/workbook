"""Real IndexedDB image-edit regressions in isolated temporary browser storage.
Run: python tests/captures-editor-store.browser.py
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import json
import shutil
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


PREPARE = r'''async()=>{
  const s=CaptureStore;
  localStorage.setItem('decks','image-editor-must-not-touch-vocabulary');
  const group=(await s.ready()).groups[0];
  const canvas=document.createElement('canvas');canvas.width=8;canvas.height=5;
  canvas.getContext('2d').fillStyle='#a02040';canvas.getContext('2d').fillRect(0,0,8,5);
  const original=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg'));
  const [item]=await s.addFiles(group.id,[new File([original],'original.jpg',{type:original.type})]);
  await s.updateItem(item.id,{title:'제목 유지',caption:'설명 첫 줄\n둘째 줄',text:'추가 내용',rotation:90});
  const clean=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  canvas.getContext('2d').fillStyle='#3070b0';canvas.getContext('2d').fillRect(1,1,3,2);
  const edited=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  const updated=await s.saveImage(item.id,edited,{expectedFileId:item.fileId,cleanBlob:clean});
  const bytes=async blob=>Array.from(new Uint8Array(await blob.arrayBuffer()));
  if(updated.fileId!==item.fileId||updated.mime!==item.mime||updated.fileName!==item.fileName||updated.size!==item.size)throw Error('Original metadata changed');
  if(updated.rotation!==0||updated.title!=='제목 유지'||updated.caption!=='설명 첫 줄\n둘째 줄'||updated.text!=='추가 내용'||updated.groupId!==item.groupId||updated.order!==item.order)throw Error('Item metadata changed');
  return {item:updated,original:await bytes(original),edited:await bytes(edited),clean:await bytes(clean)};
}'''


CHECKS = r'''async seed=>{
  const s=CaptureStore,checks=[],assert=(v,m)=>{if(!v)throw Error(m);};
  const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const bytes=async id=>Array.from(new Uint8Array(await(await s.getFile(id)).arrayBuffer()));
  const state=async()=>{const raw=JSON.parse(await(await s.exportArchive()).text());delete raw.exportedAt;return raw;};
  const rejects=async(fn,message)=>{let rejected=false;try{await fn();}catch(_error){rejected=true;}assert(rejected,message);};
  const png=async color=>{const canvas=document.createElement('canvas');canvas.width=6;canvas.height=7;canvas.getContext('2d').fillStyle=color;canvas.getContext('2d').fillRect(0,0,6,7);return new Promise(resolve=>canvas.toBlob(resolve,'image/png'));};
  let item=(await s.listItems()).find(value=>value.id===seed.item.id);
  assert(equal(item,seed.item),'edited item survives reload');
  assert(equal(await bytes(item.fileId),seed.original),'original bytes survive reload');
  assert(equal(await bytes(item.editedFileId),seed.edited),'edited bytes survive reload');
  assert(equal(await bytes(item.cleanFileId),seed.clean),'clean bytes survive reload');
  checks.push('original, edited and clean bytes/metadata persist independently across reload');

  const replacement=await png('#20c080'),replacementClean=await png('#dddddd'),oldEdited=item.editedFileId,oldClean=item.cleanFileId;
  await s.updateItem(item.id,{caption:'다른 창의 최신 설명',rotation:270});
  const preceding=await s.addNote(item.groupId,'앞으로 옮긴 메모');await s.reorderItem(preceding.id,-1);
  item=await s.saveImage(item.id,replacement,{expectedFileId:oldEdited,cleanBlob:replacementClean});
  assert(item.caption==='다른 창의 최신 설명'&&item.rotation===0&&item.order===1,'fresh metadata and order preserved');
  assert(item.fileId===seed.item.fileId&&equal(await bytes(item.fileId),seed.original),'replacement preserves original');
  await rejects(()=>s.getFile(oldEdited),'superseded edited file removed');
  await rejects(()=>s.getFile(oldClean),'superseded clean file removed');
  const droppedClean=item.cleanFileId;
  item=await s.saveImage(item.id,replacement,{expectedFileId:item.editedFileId});
  assert(!Object.hasOwn(item,'cleanFileId'),'old saveImage call does not invent a clean file');
  await rejects(()=>s.getFile(droppedClean),'omitting clean removes old clean bytes');
  item=await s.saveImage(item.id,replacement,{expectedFileId:item.editedFileId,cleanBlob:replacementClean});
  const stable=await state();
  await rejects(()=>s.saveImage(item.id,replacement,{expectedFileId:oldEdited}),'stale edit rejected');
  await rejects(()=>s.saveImage(item.id,null,{expectedFileId:oldEdited}),'stale reset rejected');
  for(const [blob,options] of [[replacement,{}],[new Blob([],{type:'image/png'}),{expectedFileId:item.editedFileId}],
    [new Blob(['bad'],{type:'image/jpeg'}),{expectedFileId:item.editedFileId}],[{}, {expectedFileId:item.editedFileId}]]){
    await rejects(()=>s.saveImage(item.id,blob,options),'invalid edit rejected');
  }
  for(const cleanBlob of [null,{},new Blob([],{type:'image/png'}),new Blob(['bad'],{type:'image/jpeg'})]){
    await rejects(()=>s.saveImage(item.id,replacement,{expectedFileId:item.editedFileId,cleanBlob}),'invalid clean image rejected');
  }
  assert(equal(await state(),stable),'rejected edits write nothing');
  checks.push('replacement cleanup, fresh metadata and stale/invalid-operation guards');

  for(const mode of ['clean-file-add','edited-item-put','edited-group-put','edited-file-delete','reset-item-put']){
    const before=await state(),method=mode==='edited-file-delete'?'delete':mode==='clean-file-add'?'add':'put',original=IDBObjectStore.prototype[method];
    const target=mode==='edited-group-put'?'groups':mode==='edited-file-delete'||mode==='clean-file-add'?'files':'items';let addedFiles=0;
    IDBObjectStore.prototype[method]=function(...args){if(this.name===target&&(mode!=='clean-file-add'||++addedFiles===2))throw new DOMException('quota','QuotaExceededError');return original.apply(this,args);};
    let failed=false;
    try{await s.saveImage(item.id,mode==='reset-item-put'?null:replacement,{expectedFileId:item.editedFileId,...(mode==='reset-item-put'?{}:{cleanBlob:replacementClean})});}catch(error){failed=error.name==='QuotaExceededError';}finally{IDBObjectStore.prototype[method]=original;}
    assert(failed&&equal(await state(),before),'quota rollback across item, files and group: '+mode);
  }
  const beforeReset=item.editedFileId,beforeResetClean=item.cleanFileId;
  item=await s.saveImage(item.id,null,{expectedFileId:beforeReset});
  assert(!Object.hasOwn(item,'editedFileId')&&!Object.hasOwn(item,'cleanFileId')&&item.rotation===0,'reset removes optional fields');
  await rejects(()=>s.getFile(beforeReset),'reset removes edited bytes');
  await rejects(()=>s.getFile(beforeResetClean),'reset removes clean bytes');
  assert(equal(await bytes(item.fileId),seed.original),'reset keeps original bytes');
  const concurrent=await Promise.allSettled([s.saveImage(item.id,replacement,{expectedFileId:item.fileId,cleanBlob:replacementClean}),s.saveImage(item.id,await png('#eeee22'),{expectedFileId:item.fileId,cleanBlob:replacementClean})]);
  assert(concurrent.filter(value=>value.status==='fulfilled').length===1&&concurrent.filter(value=>value.status==='rejected').length===1,'one concurrent edit wins');
  item=(await s.listItems()).find(value=>value.id===item.id);
  checks.push('quota rollback, original reset and concurrent edits');

  const [pdf]=await s.addFiles(item.groupId,[new File(['%PDF-1.7'],'lesson.pdf',{type:'application/pdf'})]);
  const note=await s.addNote(item.groupId,'메모');
  for(const other of [pdf,note])await rejects(()=>s.saveImage(other.id,replacement,{expectedFileId:other.fileId||'not-image'}),'non-image cannot be edited');
  const raw=await state(),beforeImport=await s.ready();
  assert(raw.files.length===4,'original image, edited image, clean image and PDF all accounted');
  const imported=await s.importArchive(JSON.stringify(raw));
  assert(imported.items.length===beforeImport.items.length*2,'new backup appends items');
  const restored=imported.items.find(value=>!beforeImport.items.some(old=>old.id===value.id)&&value.kind==='image');
  assert(restored.fileId!==item.fileId&&restored.editedFileId!==item.editedFileId,'both file IDs remapped');
  assert(restored.cleanFileId!==item.cleanFileId&&restored.cleanFileId!==restored.editedFileId&&restored.cleanFileId!==restored.fileId,'clean ID remapped distinctly');
  assert(restored.fileName==='original.jpg'&&restored.mime==='image/jpeg'&&restored.size===item.size,'restored original metadata');
  assert(equal(await bytes(restored.fileId),seed.original)&&equal(await bytes(restored.editedFileId),await bytes(item.editedFileId)),'both restored blobs match');
  assert(equal(await bytes(restored.cleanFileId),await bytes(item.cleanFileId)),'restored clean bytes match');
  const editedOnly=structuredClone(raw),cleanIds=new Set(editedOnly.items.map(value=>value.cleanFileId).filter(Boolean));
  editedOnly.items.forEach(value=>delete value.cleanFileId);editedOnly.files=editedOnly.files.filter(file=>!cleanIds.has(file.id));
  const editedOnlyBefore=await s.ready(),editedOnlyResult=await s.importArchive(JSON.stringify(editedOnly));
  assert(editedOnlyResult.items.filter(value=>!editedOnlyBefore.items.some(old=>old.id===value.id)&&value.kind==='image').every(value=>value.editedFileId&&!Object.hasOwn(value,'cleanFileId')),'edited-only old backups stay compatible');
  const legacy=structuredClone(raw),editedIds=new Set(legacy.items.flatMap(value=>[value.editedFileId,value.cleanFileId]).filter(Boolean));
  legacy.items.forEach(value=>{delete value.editedFileId;delete value.cleanFileId;});legacy.files=legacy.files.filter(file=>!editedIds.has(file.id));
  const legacyBefore=await s.ready(),legacyResult=await s.importArchive(JSON.stringify(legacy));
  assert(legacyResult.items.filter(value=>!legacyBefore.items.some(old=>old.id===value.id)&&value.kind==='image').every(value=>!Object.hasOwn(value,'editedFileId')),'old backup remains compatible');
  checks.push('original, edited and clean backup roundtrip with ID remapping and both legacy formats');

  const beforeBad=await state();
  const variants=[bad=>{bad.items.find(value=>value.kind==='image').editedFileId='missing';},
    bad=>{const image=bad.items.find(value=>value.kind==='image');image.editedFileId=image.fileId;},
    bad=>{bad.files.find(file=>file.id===item.editedFileId).type='image/jpeg';},
    bad=>{bad.items.find(value=>value.kind==='pdf').editedFileId=item.editedFileId;},
    bad=>{bad.items.find(value=>value.kind==='note').editedFileId=item.editedFileId;},
    bad=>{const original=bad.items.find(value=>value.kind==='image');bad.files.push({...bad.files.find(file=>file.id===original.fileId),id:'second-original'});bad.items.push({...original,id:'second-image',fileId:'second-original'});},
    bad=>{bad.items.find(value=>value.kind==='image').editedFileId=null;},
    bad=>{bad.items.find(value=>value.kind==='image').cleanFileId='missing-clean';},
    bad=>{const image=bad.items.find(value=>value.kind==='image');image.cleanFileId=image.editedFileId;},
    bad=>{const image=bad.items.find(value=>value.kind==='image');image.cleanFileId=image.fileId;},
    bad=>{const image=bad.items.find(value=>value.kind==='image');bad.files.push({...bad.files.find(file=>file.id===image.fileId),id:'clean-share-original'},{...bad.files.find(file=>file.id===image.editedFileId),id:'clean-share-edited'});bad.items.push({...image,id:'clean-share-image',fileId:'clean-share-original',editedFileId:'clean-share-edited'});},
    bad=>{bad.files.find(file=>file.id===item.cleanFileId).type='image/jpeg';},
    bad=>{bad.items.find(value=>value.kind==='pdf').cleanFileId=item.cleanFileId;},
    bad=>{bad.items.find(value=>value.kind==='note').cleanFileId=item.cleanFileId;},
    bad=>{delete bad.items.find(value=>value.kind==='image').editedFileId;},
    bad=>{bad.items.find(value=>value.kind==='image').cleanFileId=null;},
    bad=>{bad.files.push({...bad.files[0],id:'orphan'});},
    bad=>{bad.files.find(file=>file.id===item.editedFileId).size++;}];
  for(const alter of variants){const bad=structuredClone(raw);alter(bad);await rejects(()=>s.importArchive(JSON.stringify(bad)),'malformed edited backup rejected');assert(equal(await state(),beforeBad),'bad archive changes nothing');}
  const add=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(...args){if(this.name==='items')throw new DOMException('quota','QuotaExceededError');return add.apply(this,args);};
  try{await rejects(()=>s.importArchive(JSON.stringify(raw)),'import quota surfaced');}finally{IDBObjectStore.prototype.add=add;}
  assert(equal(await state(),beforeBad),'import quota rolls back appended groups and both files');
  checks.push('strict edited-reference validation and atomic backup-import quota rollback');

  const temp=await s.createGroup('삭제할 분류'),[temporary]=await s.addFiles(temp.id,[new File(['original'],'temp.png',{type:'image/png'})]);
  const temporaryEdit=await s.saveImage(temporary.id,replacement,{expectedFileId:temporary.fileId,cleanBlob:replacementClean});
  await s.deleteGroup(temp.id);
  for(const fileId of [temporary.fileId,temporaryEdit.editedFileId,temporaryEdit.cleanFileId])await rejects(()=>s.getFile(fileId),'group deletion removes all three files');
  await s.removeItem(restored.id);
  for(const fileId of [restored.fileId,restored.editedFileId,restored.cleanFileId])await rejects(()=>s.getFile(fileId),'item deletion removes all three files');
  assert(localStorage.getItem('decks')==='image-editor-must-not-touch-vocabulary','vocabulary storage unchanged');
  checks.push('original/edited/clean item and group cleanup with vocabulary isolation');
  return {passed:true,checks,item,files:(await state()).files.length};
}'''


AUDIT_CHECKS = r'''async()=>{
  const s=CaptureStore,assert=(v,m)=>{if(!v)throw Error(m);},equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const snapshot=async()=>{const data=JSON.parse(await(await s.exportArchive()).text());delete data.exportedAt;return data;};
  const rejects=async(fn,label)=>{let rejected=false;try{await fn();}catch(_error){rejected=true;}assert(rejected,label);};
  const group=await s.createGroup('Append optimization regression');
  const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('workbook-captures');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  await new Promise((resolve,reject)=>{const tx=db.transaction('items','readwrite'),store=tx.objectStore('items');
    for(let n=0;n<500;n++)store.add({id:'audit-fixture-'+n,groupId:group.id,kind:'note',order:n,title:'메모',caption:'',text:'Original note '+n,fileId:null,mime:'',fileName:'',size:0,rotation:0,createdAt:100,updatedAt:100});
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
  const before=await s.listItems(group.id),methods={add:IDBObjectStore.prototype.add,put:IDBObjectStore.prototype.put};
  const count=async fn=>{const writes={add:0,put:0};for(const method of Object.keys(methods))IDBObjectStore.prototype[method]=function(...args){if(this.name==='items')writes[method]++;return methods[method].apply(this,args);};try{await fn();return writes;}finally{Object.assign(IDBObjectStore.prototype,methods);}};
  const appendWrites=await count(()=>s.addNote(group.id,'Appended note'));
  assert(appendWrites.add===1&&appendWrites.put===0,'appending to500 notes writes only1 new item');
  let items=await s.listItems(group.id);assert(equal(items.slice(0,500),before),'append preserves every unchanged order, timestamp and field');
  const insertWrites=await count(()=>s.addNote(group.id,'Inserted note',before[249].id));items=await s.listItems(group.id);
  assert(insertWrites.add===1&&insertWrites.put===251,'insertion writes only shifted rows');
  assert(equal(items.slice(0,250),before.slice(0,250)),'insertion preserves unchanged prefix');
  assert(items.every((item,index)=>item.order===index),'inserted list remains contiguous');
  const sameOrderWrites=await count(()=>s.reorderItems(group.id,items.map(item=>item.id)));
  assert(sameOrderWrites.add===0&&sameOrderWrites.put===0,'unchanged reorder writes no items');
  const adjacentWrites=await count(()=>s.reorderItem(items[250].id,1));
  assert(adjacentWrites.add===0&&adjacentWrites.put===2,'adjacent move changes exactly2 items');
  for(const mode of ['note','file-batch']){
    const stable=await snapshot(),add=IDBObjectStore.prototype.add;let calls=0;
    IDBObjectStore.prototype.add=function(...args){if(this.name==='items'&&++calls===(mode==='note'?1:2))throw new DOMException('quota','QuotaExceededError');return add.apply(this,args);};
    try{await rejects(()=>mode==='note'?s.addNote(group.id,'Never persisted'):s.addFiles(group.id,[new File(['a'],'a.png',{type:'image/png'}),new File(['b'],'b.pdf',{type:'application/pdf'})]),'optimized append quota rejected');}
    finally{IDBObjectStore.prototype.add=add;}
    assert(equal(await snapshot(),stable),'optimized append quota rolls back all items, files and group metadata');
  }
  const mimeGroup=await s.createGroup('Generic MIME files');
  const generic=await s.addFiles(mimeGroup.id,[new File(['%PDF-1.7'],'generic.PDF',{type:'application/octet-stream'}),new File(['png bytes'],'generic.PNG',{type:'application/octet-stream'}),new File(['jpeg bytes'],'empty.jpg',{type:''})]);
  assert(equal(generic.map(item=>[item.kind,item.mime]),[['pdf','application/pdf'],['image','image/png'],['image','image/jpeg']]),'generic and empty MIME use recognized extensions');
  assert((await s.getFile(generic[0].fileId)).type==='application/octet-stream','original blob metadata retained');
  const stableMime=await snapshot();
  for(const file of [new File(['not png'],'wrong.png',{type:'text/plain'}),new File(['zip'],'wrong.pdf',{type:'application/zip'}),new File(['binary'],'unknown.bin',{type:'application/octet-stream'})]){
    await rejects(()=>s.addFiles(mimeGroup.id,[file]),'explicit unsupported type or unknown generic extension rejected');
    assert(equal(await snapshot(),stableMime),'invalid MIME changes nothing');
  }
  let note=(await s.listItems(group.id))[0];
  await s.updateItem(note.id,{text:'Later same-field text'});
  const latest=await snapshot();
  await rejects(()=>s.updateItem(note.id,{text:'Stale replacement'},{expected:{text:note.text}}),'stale note snapshot rejected');
  assert(equal(await snapshot(),latest),'stale snapshot rejection writes nothing');
  const image=generic[1];await s.updateItem(image.id,{caption:'Later unrelated caption'});await s.reorderItem(image.id,-1);
  const guarded=await s.updateItem(image.id,{title:'Guarded title'},{expected:{title:image.title}});
  assert(guarded.title==='Guarded title'&&guarded.caption==='Later unrelated caption'&&guarded.order===0,'field guard preserves unrelated latest caption and position');
  const beforeInvalid=await snapshot();
  for(const options of [null,{expected:{missing:'x'}},{expected:{title:5}},{expected:{caption:''}},{expected:[]}])await rejects(()=>s.updateItem(image.id,{title:'Invalid guard'},options),'invalid expected guard rejected');
  assert(equal(await snapshot(),beforeInvalid),'invalid guards write nothing');
  const freshNote=(await s.listItems(group.id))[0],racing=await Promise.allSettled([s.updateItem(freshNote.id,{text:'First racer'},{expected:{text:freshNote.text}}),s.updateItem(freshNote.id,{text:'Second racer'},{expected:{text:freshNote.text}})]);
  assert(racing.filter(value=>value.status==='fulfilled').length===1&&racing.filter(value=>value.status==='rejected').length===1,'guarded concurrent note update has exactly1 winner');
  const beforeUpdateQuota=await snapshot(),put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='groups')throw new DOMException('quota','QuotaExceededError');return put.apply(this,args);};
  try{await rejects(()=>s.updateItem(guarded.id,{title:'Quota title'},{expected:{title:guarded.title}}),'guarded update quota rejected');}finally{IDBObjectStore.prototype.put=put;}
  assert(equal(await snapshot(),beforeUpdateQuota),'guarded update quota restores exact prior item and group');
  await s.deleteGroup(group.id);await s.deleteGroup(mimeGroup.id);
  return {append500:appendWrites,insertion:insertWrites,unchangedReorder:sameOrderWrites,adjacentMove:adjacentWrites,genericMIME:true,atomicAppendQuota:true,fieldSnapshotGuard:true,concurrentGuard:true};
}'''


MIGRATION_SEED = r'''async()=>{
  const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('workbook-captures',1);
    req.onupgradeneeded=()=>{const db=req.result;db.createObjectStore('groups',{keyPath:'id'});const items=db.createObjectStore('items',{keyPath:'id'});items.createIndex('groupId','groupId');db.createObjectStore('files',{keyPath:'id'});};
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
  const group={id:'legacy',name:'기존 분류',createdAt:1,updatedAt:2},item={id:'legacy-image',groupId:group.id,kind:'image',order:0,title:'기존 제목',caption:'기존 메모',text:'기존 내용',fileId:'legacy-original',mime:'image/jpeg',fileName:'old.jpg',size:8,rotation:90,createdAt:1,updatedAt:2,editedFileId:'legacy-edited',cleanFileId:'legacy-clean'};
  await new Promise((resolve,reject)=>{const tx=db.transaction(['groups','items','files'],'readwrite');tx.objectStore('groups').add(group);tx.objectStore('items').add(item);for(const [id,type,data]of[['legacy-original','image/jpeg','original'],['legacy-edited','image/png','edited'],['legacy-clean','image/png','clean']])tx.objectStore('files').add({id,blob:new Blob([data],{type})});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  window.legacyConnection=db;window.legacyClosed=false;db.onversionchange=()=>{legacyClosed=true;db.close();};
  return {group,item};
}'''


PROJECT_PREPARE = r'''async()=>{
  const s=CaptureStore,group=await s.createGroup('Retained project');
  const png=async(width,height,color,type='image/png')=>{const c=window.document.createElement('canvas');c.width=width;c.height=height;c.getContext('2d').fillStyle=color;c.getContext('2d').fillRect(0,0,width,height);return new Promise(resolve=>c.toBlob(resolve,type));};
  const original=await png(8,5,'#994422','image/jpeg'),baseBlob=await png(8,5,'#994422'),edited=await png(8,5,'#333333');
  const [item]=await s.addFiles(group.id,[new File([original],'project-original.jpg',{type:'image/jpeg'})]);
  const matrix=[1,0,0,1,0,0],clip={x:0,y:0,width:8,height:5};
  const document={version:1,width:8,height:5,objects:[
    {id:'photo-a',kind:'image',matrix,clip:{x:0,y:0,width:2,height:2},data:{assetId:'asset-a',width:2,height:2}},
    {id:'photo-b',kind:'image',matrix:[1,0,0,1,2,1],clip:{x:0,y:0,width:3,height:1},data:{assetId:'asset-b',width:3,height:1}},
    {id:'mask',kind:'mask',matrix,clip,data:{x:0,y:0,width:4,height:2,color:'#111111'}},
    {id:'text',kind:'text',matrix,clip,data:{x:1,y:1,text:'다시 편집',color:'#ff0000',size:12}},
    {id:'line',kind:'line',matrix,clip,data:{points:[0,0,3,3],color:'#0000ff',width:1}},
    {id:'stroke',kind:'stroke',matrix,clip,data:{points:[1,1,2,3,4,4],color:'#00aa00',width:2}}
  ]};
  const assets=[{id:'asset-a',blob:await png(2,2,'#00ff00')},{id:'asset-b',blob:await png(3,1,'#0000ff')}];
  const updated=await s.saveImage(item.id,edited,{expectedFileId:item.fileId,cleanBlob:baseBlob,project:{document,baseBlob,assets}});
  const bytes=async blob=>Array.from(new Uint8Array(await blob.arrayBuffer()));
  return {item:updated,document,original:await bytes(original),base:await bytes(baseBlob),assets:await Promise.all(assets.map(async asset=>({id:asset.id,bytes:await bytes(asset.blob)})))};
}'''


PROJECT_CHECKS = r'''async seed=>{
  const s=CaptureStore,assert=(v,m)=>{if(!v)throw Error(m);},equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const bytes=async blob=>Array.from(new Uint8Array(await blob.arrayBuffer()));
  const snapshot=async()=>{const raw=JSON.parse(await(await s.exportArchive()).text());delete raw.exportedAt;return raw;};
  const rejects=async(fn,label)=>{let caught=false;try{await fn();}catch(_error){caught=true;}assert(caught,label);};
  const owned=item=>[...new Set([item.editedFileId,item.cleanFileId,item.editProject?.baseFileId,...(item.editProject?.assets||[]).map(asset=>asset.fileId)].filter(Boolean))];
  let item=(await s.listItems()).find(value=>value.id===seed.item.id);
  assert(equal(item,seed.item),'retained item survives reload');
  let project=await s.getImageProject(item.id,{expectedFileId:item.editedFileId});
  assert(equal(project.document,seed.document),'all typed objects survive reload');
  assert(equal(await bytes(project.baseBlob),seed.base),'base PNG survives reload');
  for(const asset of project.assets)assert(equal(await bytes(asset.blob),seed.assets.find(value=>value.id===asset.id).bytes),'asset PNG survives reload');
  assert(item.editProject.baseFileId===item.cleanFileId&&owned(item).length===4,'base aliases clean only once');
  assert(equal(await bytes(await s.getFile(item.fileId)),seed.original),'original remains unchanged');
  await rejects(()=>s.getImageProject(item.id,{expectedFileId:item.fileId}),'stale getter rejected');
  const image=await s.getFile(item.editedFileId),baseBlob=project.baseBlob,assets=project.assets,document=project.document;
  const oldFiles=owned(item),distinctBase=new Blob([baseBlob],{type:'image/png'});
  item=await s.saveImage(item.id,image,{expectedFileId:item.editedFileId,cleanBlob:baseBlob,project:{document,baseBlob:distinctBase,assets}});
  assert(item.editProject.baseFileId!==item.cleanFileId&&owned(item).length===5,'distinct legacy base stored separately');
  for(const fileId of oldFiles)await rejects(()=>s.getFile(fileId),'replacement cleans all previous project files');
  const stable=await snapshot();
  await rejects(()=>s.saveImage(item.id,image,{expectedFileId:seed.item.editedFileId,project:{document,baseBlob,assets}}),'stale project save rejected');
  assert(equal(await snapshot(),stable),'stale project changes nothing');
  for(const mode of ['asset-add','item-put','group-put','old-file-delete']){
    const method=mode==='asset-add'?'add':mode==='old-file-delete'?'delete':'put',original=IDBObjectStore.prototype[method];let calls=0;
    const target=mode==='group-put'?'groups':mode==='item-put'?'items':'files';
    IDBObjectStore.prototype[method]=function(...args){if(this.name===target&&(mode!=='asset-add'&&mode!=='old-file-delete'||++calls===(mode==='asset-add'?4:3)))throw new DOMException('quota','QuotaExceededError');return original.apply(this,args);};
    try{await rejects(()=>s.saveImage(item.id,image,{expectedFileId:item.editedFileId,cleanBlob:baseBlob,project:{document,baseBlob,assets}}),'project write quota surfaced');}finally{IDBObjectStore.prototype[method]=original;}
    assert(equal(await snapshot(),stable),'partial multi-asset writes fully roll back: '+mode);
  }
  const noProjectFiles=owned(item);
  item=await s.saveImage(item.id,image,{expectedFileId:item.editedFileId});
  assert(!Object.hasOwn(item,'editProject')&&!Object.hasOwn(item,'cleanFileId')&&await s.getImageProject(item.id)===null,'old save API removes stale project');
  for(const fileId of noProjectFiles)await rejects(()=>s.getFile(fileId),'old API removes prior project files');
  item=await s.saveImage(item.id,image,{expectedFileId:item.editedFileId,cleanBlob:baseBlob,project:{document,baseBlob,assets}});
  const race=await Promise.allSettled([s.saveImage(item.id,image,{expectedFileId:item.editedFileId,cleanBlob:baseBlob,project:{document,baseBlob,assets}}),s.saveImage(item.id,image,{expectedFileId:item.editedFileId,cleanBlob:baseBlob,project:{document,baseBlob,assets}})]);
  assert(race.filter(result=>result.status==='fulfilled').length===1&&race.filter(result=>result.status==='rejected').length===1,'one concurrent project save wins');
  item=race.find(result=>result.status==='fulfilled').value;
  const [second]=await s.addFiles(item.groupId,[new File([await s.getFile(item.fileId)],'second.jpg',{type:'image/jpeg'})]);
  const separate=await s.saveImage(second.id,image,{expectedFileId:second.fileId,cleanBlob:baseBlob,project:{document,baseBlob:distinctBase,assets}});
  const raw=await snapshot(),before=await s.ready(),restored=await s.importArchive(JSON.stringify(raw));
  for(const original of [item,separate]){
    const copy=restored.items.find(value=>!before.items.some(old=>old.id===value.id)&&value.fileName===original.fileName&&value.editProject);
    assert(copy&&copy.fileId!==original.fileId&&copy.editProject.baseFileId!==original.editProject.baseFileId,'all DB project IDs remapped');
    assert((copy.editProject.baseFileId===copy.cleanFileId)===(original.editProject.baseFileId===original.cleanFileId),'base-clean alias preserved');
    const result=await s.getImageProject(copy.id);assert(equal(result.document,document),'backup retains document and local asset IDs');
    for(const asset of result.assets)assert(equal(await bytes(asset.blob),seed.assets.find(value=>value.id===asset.id).bytes),'backup retains PNG assets');
  }
  const beforeBad=await snapshot(),alterations=[
    value=>{value.editProject.document.version=2;},value=>{value.editProject.document.width=8193;},
    value=>{value.editProject.document.objects[0].matrix=[0,0,0,0,0,0];},value=>{value.editProject.document.objects[0].clip.width=-1;},
    value=>{value.editProject.document.objects[0].data.assetId='unknown';},value=>{value.editProject.assets[1].id=value.editProject.assets[0].id;},
    value=>{value.editProject.baseFileId=value.fileId;},value=>{value.editProject.baseFileId=value.editedFileId;},
    value=>{value.editProject.assets[0].fileId=value.editProject.baseFileId;},value=>{value.editProject.document.objects[2].data.color='rgba(0,0,0,.1)';},
    value=>{value.editProject.assets[1].fileId=value.editProject.assets[0].fileId;},
    value=>{value.editProject.baseFileId=separate.cleanFileId;},
    value=>{value.editProject.document.objects[3].data.color='url(https://invalid/)';},value=>{value.editProject.document.objects[3].data.text='';},
    value=>{value.editProject.document.objects[4].data.points=[0,1,2];},value=>{value.editProject.document.objects[0].unknown=true;},
    value=>{value.editProject.document.objects[0].data.legacy=false;},value=>{value.editProject.document.objects[0].data.eraseAssetId='asset-b';},
    value=>{value.editProject.document.objects=Array.from({length:501},(_,index)=>({...value.editProject.document.objects[2],id:'many-'+index}));}
  ];
  for(const alter of alterations){const bad=structuredClone(raw);alter(bad.items.find(value=>value.id===item.id));await rejects(()=>s.importArchive(JSON.stringify(bad)),'invalid project backup rejected');assert(equal(await snapshot(),beforeBad),'invalid project archive is atomic');}
  const badFile=structuredClone(raw),badItem=badFile.items.find(value=>value.id===item.id);badFile.files.find(file=>file.id===badItem.editProject.assets[0].fileId).type='image/jpeg';
  await rejects(()=>s.importArchive(JSON.stringify(badFile)),'non-PNG project asset rejected');assert(equal(await snapshot(),beforeBad),'bad asset leaves all data intact');
  for(const kind of ['note','pdf']){const bad=structuredClone(raw);bad.items.find(value=>value.kind===kind).editProject=structuredClone(item.editProject);await rejects(()=>s.importArchive(JSON.stringify(bad)),'projects are images only');assert(equal(await snapshot(),beforeBad),'invalid item kind changes nothing');}
  const importAdd=IDBObjectStore.prototype.add;let fileAdds=0;
  IDBObjectStore.prototype.add=function(...args){if(this.name==='files'&&++fileAdds===5)throw new DOMException('quota','QuotaExceededError');return importAdd.apply(this,args);};
  try{await rejects(()=>s.importArchive(JSON.stringify(raw)),'multi-file project import quota surfaced');}finally{IDBObjectStore.prototype.add=importAdd;}
  assert(equal(await snapshot(),beforeBad),'partial project backup import rolls back every group/item/file');
  for(const alter of [value=>{value.document.objects[0].matrix[0]=Infinity;},value=>{delete value.document.objects[0].matrix[0];},value=>{delete value.document.objects[0];},value=>{delete value.assets[0];},value=>{value.assets.push({...value.assets[0],id:'orphan'});}]){
    const invalid={document:structuredClone(document),baseBlob,assets:assets.slice()};alter(invalid);
    await rejects(()=>s.saveImage(item.id,image,{expectedFileId:item.editedFileId,project:invalid}),'invalid runtime document rejected');assert(equal(await snapshot(),beforeBad),'invalid runtime project changes nothing');
  }
  const restoreCopy=restored.items.find(value=>!before.items.some(old=>old.id===value.id)&&value.fileName===item.fileName&&value.editProject),removedFiles=[restoreCopy.fileId,...owned(restoreCopy)];
  await s.removeItem(restoreCopy.id);for(const fileId of removedFiles)await rejects(()=>s.getFile(fileId),'removeItem cleans original and all project files');
  const resetFiles=owned(item);item=await s.saveImage(item.id,null,{expectedFileId:item.editedFileId});
  assert(!item.editProject&&!item.editedFileId&&!item.cleanFileId&&await s.getImageProject(item.id)===null,'reset removes complete project');
  for(const fileId of resetFiles)await rejects(()=>s.getFile(fileId),'reset cleans project base/assets');
  assert(equal(await bytes(await s.getFile(item.fileId)),seed.original),'reset still retains original');
  const groupFiles=[item.fileId,separate.fileId,...owned(separate)];await s.deleteGroup(item.groupId);
  for(const fileId of groupFiles)await rejects(()=>s.getFile(fileId),'deleteGroup cleans every project file');
  return {reloaded:true,baseCleanAlias:true,distinctLegacyBase:true,quotaRollback:true,strictDocuments:true,fullBackupRemapping:true,legacySaveAndReset:true,allFileCleanup:true};
}'''


def run():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Quiet, directory=str(ROOT)))
    Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_address[1]}'
    try:
        with sync_playwright() as p:
            options = {'headless': True, 'args': ['--no-sandbox', '--disable-dev-shm-usage']}
            binary = shutil.which('chromium') or shutil.which('google-chrome')
            if binary:
                options['executable_path'] = binary
            browser = p.chromium.launch(**options)
            migration_context = browser.new_context(service_workers='block')
            migration_page = migration_context.new_page()
            migration_page.goto(base + '/manifest.json')
            migration_seed = migration_page.evaluate(MIGRATION_SEED)
            migration_page.add_script_tag(content=(ROOT / 'captures-store.js').read_text().replace('DB_VERSION=2', 'DB_VERSION=1', 1))
            migration_page.evaluate('async()=>{window.oldCaptureStore=CaptureStore;await oldCaptureStore.ready();}')
            migration_page.add_script_tag(url=base + '/captures-store.js')
            migration = migration_page.evaluate("""async seed=>{
              const assert=(value,message)=>{if(!value)throw Error(message);};
              const latest=await CaptureStore.ready();assert(JSON.stringify(latest.groups)===JSON.stringify([seed.group])&&JSON.stringify(latest.items)===JSON.stringify([seed.item]),'v1 metadata preserved exactly');
              for(const [id,value]of[['legacy-original','original'],['legacy-edited','edited'],['legacy-clean','clean']])assert(await(await CaptureStore.getFile(id)).text()===value,'v1 blob preserved');
              assert(legacyClosed,'old raw connection closes on versionchange');let oldWriteRejected=false;
              try{await oldCaptureStore.addNote('legacy','old writer must fail');}catch(error){oldWriteRejected=error.name==='VersionError';}assert(oldWriteRejected,'old version writer blocked');
              const oldOpenRejected=await new Promise(resolve=>{const req=indexedDB.open('workbook-captures',1);req.onerror=()=>resolve(req.error.name==='VersionError');req.onsuccess=()=>{req.result.close();resolve(false);};});assert(oldOpenRejected,'version1 open rejected');
              assert((await CaptureStore.listItems()).length===1,'old writer changes nothing');return {version2Upgrade:true,allMetadataAndBlobsPreserved:true,activeV1ConnectionsClosed:true,oldV1WritersBlocked:true};
            }""", migration_seed)
            migration_context.close()
            context = browser.new_context(service_workers='block')
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(base + '/manifest.json')
            page.add_script_tag(url=base + '/captures-store.js')
            seed = page.evaluate(PREPARE)
            page.reload()
            page.add_script_tag(url=base + '/captures-store.js')
            report = page.evaluate(CHECKS, seed)
            other = context.new_page()
            other.goto(base + '/manifest.json')
            other.add_script_tag(url=base + '/captures-store.js')
            previous = report['item']
            fresh = other.evaluate("""async item=>CaptureStore.saveImage(item.id,new Blob(['other-tab'],{type:'image/png'}),{expectedFileId:item.editedFileId})""", previous)
            assert page.evaluate("""async item=>{try{await CaptureStore.saveImage(item.id,null,{expectedFileId:item.editedFileId});return false;}catch(_error){return true;}}""", previous)
            assert page.evaluate("async id=>(await CaptureStore.listItems()).find(item=>item.id===id)", fresh['id']) == fresh
            assert not errors, errors
            report['checks'].append('cross-tab stale edit/reset protection')
            report['audit'] = page.evaluate(AUDIT_CHECKS)
            report['checks'].append('500-item append write budget, generic MIME, guarded fields and atomic quota rollback')
            stale_title = fresh['title']
            fresh_title = other.evaluate("async item=>CaptureStore.updateItem(item.id,{title:'Other-tab title'},{expected:{title:item.title}})", fresh)
            assert page.evaluate("""async ({item,title})=>{try{await CaptureStore.updateItem(item.id,{title:'Stale title'},{expected:{title}});return false;}catch(_error){return true;}}""", {'item': fresh, 'title': stale_title})
            assert page.evaluate("async id=>(await CaptureStore.listItems()).find(item=>item.id===id)", fresh['id']) == fresh_title
            report['checks'].append('cross-tab stale title edit rejects without overwriting the latest record')
            project_seed = page.evaluate(PROJECT_PREPARE)
            page.reload()
            page.add_script_tag(url=base + '/captures-store.js')
            report['project'] = page.evaluate(PROJECT_CHECKS, project_seed)
            report['migration'] = migration
            report['checks'].append('retained project documents, PNG assets, cleanup, backups and v1-to-v2 migration')
            assert not errors, errors
            print(json.dumps(report, ensure_ascii=False, indent=2))
            context.close()
            browser.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    run()
