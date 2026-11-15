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
  canvas.getContext('2d').fillStyle='#3070b0';canvas.getContext('2d').fillRect(1,1,3,2);
  const edited=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  const updated=await s.saveImage(item.id,edited,{expectedFileId:item.fileId});
  const bytes=async blob=>Array.from(new Uint8Array(await blob.arrayBuffer()));
  if(updated.fileId!==item.fileId||updated.mime!==item.mime||updated.fileName!==item.fileName||updated.size!==item.size)throw Error('Original metadata changed');
  if(updated.rotation!==0||updated.title!=='제목 유지'||updated.caption!=='설명 첫 줄\n둘째 줄'||updated.text!=='추가 내용'||updated.groupId!==item.groupId||updated.order!==item.order)throw Error('Item metadata changed');
  return {item:updated,original:await bytes(original),edited:await bytes(edited)};
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
  checks.push('original and edited bytes/metadata persist independently across reload');

  const replacement=await png('#20c080'),oldEdited=item.editedFileId;
  await s.updateItem(item.id,{caption:'다른 창의 최신 설명',rotation:270});
  const preceding=await s.addNote(item.groupId,'앞으로 옮긴 메모');await s.reorderItem(preceding.id,-1);
  item=await s.saveImage(item.id,replacement,{expectedFileId:oldEdited});
  assert(item.caption==='다른 창의 최신 설명'&&item.rotation===0&&item.order===1,'fresh metadata and order preserved');
  assert(item.fileId===seed.item.fileId&&equal(await bytes(item.fileId),seed.original),'replacement preserves original');
  await rejects(()=>s.getFile(oldEdited),'superseded edited file removed');
  const stable=await state();
  await rejects(()=>s.saveImage(item.id,replacement,{expectedFileId:oldEdited}),'stale edit rejected');
  await rejects(()=>s.saveImage(item.id,null,{expectedFileId:oldEdited}),'stale reset rejected');
  for(const [blob,options] of [[replacement,{}],[new Blob([],{type:'image/png'}),{expectedFileId:item.editedFileId}],
    [new Blob(['bad'],{type:'image/jpeg'}),{expectedFileId:item.editedFileId}],[{}, {expectedFileId:item.editedFileId}]]){
    await rejects(()=>s.saveImage(item.id,blob,options),'invalid edit rejected');
  }
  assert(equal(await state(),stable),'rejected edits write nothing');
  checks.push('replacement cleanup, fresh metadata and stale/invalid-operation guards');

  for(const mode of ['edited-item-put','edited-group-put','edited-file-delete','reset-item-put']){
    const before=await state(),method=mode==='edited-file-delete'?'delete':'put',original=IDBObjectStore.prototype[method];
    const target=mode==='edited-group-put'?'groups':mode==='edited-file-delete'?'files':'items';
    IDBObjectStore.prototype[method]=function(...args){if(this.name===target)throw new DOMException('quota','QuotaExceededError');return original.apply(this,args);};
    let failed=false;
    try{await s.saveImage(item.id,mode==='reset-item-put'?null:replacement,{expectedFileId:item.editedFileId});}catch(error){failed=error.name==='QuotaExceededError';}finally{IDBObjectStore.prototype[method]=original;}
    assert(failed&&equal(await state(),before),'quota rollback across item, files and group: '+mode);
  }
  const beforeReset=item.editedFileId;
  item=await s.saveImage(item.id,null,{expectedFileId:beforeReset});
  assert(!Object.hasOwn(item,'editedFileId')&&item.rotation===0,'reset removes optional field');
  await rejects(()=>s.getFile(beforeReset),'reset removes edited bytes');
  assert(equal(await bytes(item.fileId),seed.original),'reset keeps original bytes');
  const concurrent=await Promise.allSettled([s.saveImage(item.id,replacement,{expectedFileId:item.fileId}),s.saveImage(item.id,await png('#eeee22'),{expectedFileId:item.fileId})]);
  assert(concurrent.filter(value=>value.status==='fulfilled').length===1&&concurrent.filter(value=>value.status==='rejected').length===1,'one concurrent edit wins');
  item=(await s.listItems()).find(value=>value.id===item.id);
  checks.push('quota rollback, original reset and concurrent edits');

  const [pdf]=await s.addFiles(item.groupId,[new File(['%PDF-1.7'],'lesson.pdf',{type:'application/pdf'})]);
  const note=await s.addNote(item.groupId,'메모');
  for(const other of [pdf,note])await rejects(()=>s.saveImage(other.id,replacement,{expectedFileId:other.fileId||'not-image'}),'non-image cannot be edited');
  const raw=await state(),beforeImport=await s.ready();
  assert(raw.files.length===3,'original image, edited image and PDF all accounted');
  const imported=await s.importArchive(JSON.stringify(raw));
  assert(imported.items.length===beforeImport.items.length*2,'new backup appends items');
  const restored=imported.items.find(value=>!beforeImport.items.some(old=>old.id===value.id)&&value.kind==='image');
  assert(restored.fileId!==item.fileId&&restored.editedFileId!==item.editedFileId,'both file IDs remapped');
  assert(restored.fileName==='original.jpg'&&restored.mime==='image/jpeg'&&restored.size===item.size,'restored original metadata');
  assert(equal(await bytes(restored.fileId),seed.original)&&equal(await bytes(restored.editedFileId),await bytes(item.editedFileId)),'both restored blobs match');
  const legacy=structuredClone(raw),editedIds=new Set(legacy.items.map(value=>value.editedFileId).filter(Boolean));
  legacy.items.forEach(value=>delete value.editedFileId);legacy.files=legacy.files.filter(file=>!editedIds.has(file.id));
  const legacyBefore=await s.ready(),legacyResult=await s.importArchive(JSON.stringify(legacy));
  assert(legacyResult.items.filter(value=>!legacyBefore.items.some(old=>old.id===value.id)&&value.kind==='image').every(value=>!Object.hasOwn(value,'editedFileId')),'old backup remains compatible');
  checks.push('edited and original backup roundtrip with ID remapping and legacy compatibility');

  const beforeBad=await state();
  const variants=[bad=>{bad.items.find(value=>value.kind==='image').editedFileId='missing';},
    bad=>{const image=bad.items.find(value=>value.kind==='image');image.editedFileId=image.fileId;},
    bad=>{bad.files.find(file=>file.id===item.editedFileId).type='image/jpeg';},
    bad=>{bad.items.find(value=>value.kind==='pdf').editedFileId=item.editedFileId;},
    bad=>{bad.items.find(value=>value.kind==='note').editedFileId=item.editedFileId;},
    bad=>{const original=bad.items.find(value=>value.kind==='image');bad.files.push({...bad.files.find(file=>file.id===original.fileId),id:'second-original'});bad.items.push({...original,id:'second-image',fileId:'second-original'});},
    bad=>{bad.items.find(value=>value.kind==='image').editedFileId=null;},
    bad=>{bad.files.push({...bad.files[0],id:'orphan'});},
    bad=>{bad.files.find(file=>file.id===item.editedFileId).size++;}];
  for(const alter of variants){const bad=structuredClone(raw);alter(bad);await rejects(()=>s.importArchive(JSON.stringify(bad)),'malformed edited backup rejected');assert(equal(await state(),beforeBad),'bad archive changes nothing');}
  const add=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(...args){if(this.name==='items')throw new DOMException('quota','QuotaExceededError');return add.apply(this,args);};
  try{await rejects(()=>s.importArchive(JSON.stringify(raw)),'import quota surfaced');}finally{IDBObjectStore.prototype.add=add;}
  assert(equal(await state(),beforeBad),'import quota rolls back appended groups and both files');
  checks.push('strict edited-reference validation and atomic backup-import quota rollback');

  const temp=await s.createGroup('삭제할 분류'),[temporary]=await s.addFiles(temp.id,[new File(['original'],'temp.png',{type:'image/png'})]);
  const temporaryEdit=await s.saveImage(temporary.id,replacement,{expectedFileId:temporary.fileId});
  await s.deleteGroup(temp.id);
  for(const fileId of [temporary.fileId,temporaryEdit.editedFileId])await rejects(()=>s.getFile(fileId),'group deletion removes both files');
  await s.removeItem(restored.id);
  for(const fileId of [restored.fileId,restored.editedFileId])await rejects(()=>s.getFile(fileId),'item deletion removes both files');
  assert(localStorage.getItem('decks')==='image-editor-must-not-touch-vocabulary','vocabulary storage unchanged');
  checks.push('dual-file item/group cleanup and vocabulary isolation');
  return {passed:true,checks,item,files:(await state()).files.length};
}'''


AUDIT_CHECKS = r'''async()=>{
  const s=CaptureStore,assert=(v,m)=>{if(!v)throw Error(m);},equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const snapshot=async()=>{const data=JSON.parse(await(await s.exportArchive()).text());delete data.exportedAt;return data;};
  const rejects=async(fn,label)=>{let rejected=false;try{await fn();}catch(_error){rejected=true;}assert(rejected,label);};
  const group=await s.createGroup('Append optimization regression');
  const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('workbook-captures',1);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
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
            assert not errors, errors
            print(json.dumps(report, ensure_ascii=False, indent=2))
            context.close()
            browser.close()
    finally:
        server.shutdown()


if __name__ == '__main__':
    run()
