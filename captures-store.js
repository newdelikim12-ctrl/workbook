(function(global){
  'use strict';

  const DB_NAME='workbook-captures', DB_VERSION=2;
  const STORE_NAMES=['groups','items','files'];
  const KINDS=new Set(['image','pdf','note']);
  const ROTATIONS=new Set([0,90,180,270]);
  let opening=null;

  function id(prefix){
    return prefix+'_'+(global.crypto&&typeof global.crypto.randomUUID==='function'
      ?global.crypto.randomUUID():Date.now().toString(36)+'_'+Math.random().toString(36).slice(2));
  }
  function error(message){ return new Error(message); }
  function name(value){
    if(typeof value!=='string'||!value.trim()) throw error('이름을 입력해 주세요.');
    return value.trim();
  }
  function text(value,label){
    if(typeof value!=='string') throw error((label||'내용')+' 형식이 올바르지 않아요.');
    return value;
  }
  function projectDocument(value,assetIds){
    const bad=()=>{throw error('사진 편집 프로젝트가 올바르지 않아요. 기존 자료는 유지됩니다.');};
    const record=v=>v&&typeof v==='object'&&!Array.isArray(v);
    const keys=(v,allowed)=>record(v)&&Object.keys(v).every(key=>allowed.includes(key));
    const dense=(v,check)=>Array.from({length:v.length},(_value,index)=>index).every(index=>Object.prototype.hasOwnProperty.call(v,index)&&check(v[index]));
    const finite=(v,limit=10000000)=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=limit;
    const positive=(v,limit=10000000)=>finite(v,limit)&&v>0;
    const identifier=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
    const dimensions=(width,height,limit)=>Number.isInteger(width)&&Number.isInteger(height)&&width>=1&&height>=1&&width<=8192&&height<=8192&&width*height<=limit;
    const color=v=>typeof v==='string'&&v.length>0&&v.length<=128&&!/\b(?:var|url)\s*\(/iu.test(v)&&global.CSS&&global.CSS.supports('color',v);
    const rect=v=>keys(v,['x','y','width','height'])&&finite(v.x)&&finite(v.y)&&positive(v.width)&&positive(v.height);
    if(!keys(value,['version','width','height','objects'])||value.version!==1||!dimensions(value.width,value.height,16000000)||!Array.isArray(value.objects)||value.objects.length>500||!dense(value.objects,record))bad();
    const used=new Set(),objectIds=new Set(),assetDimensions=new Map();let images=0,pixels=0;
    const objects=value.objects.map((object,index)=>{
      if(!keys(object,['id','kind','matrix','clip','data','label'])||!identifier(object.id)||objectIds.has(object.id)
        ||!['image','mask','line','stroke','text'].includes(object.kind)||!Array.isArray(object.matrix)||object.matrix.length!==6
        ||!dense(object.matrix,v=>finite(v))||Math.abs(object.matrix[0]*object.matrix[3]-object.matrix[1]*object.matrix[2])<1e-12
        ||!rect(object.clip)||(object.label!==undefined&&(typeof object.label!=='string'||object.label.length>80)))bad();
      objectIds.add(object.id);const data=object.data;let normalized;
      if(object.kind==='image'){
        const legacy=data&&data.legacy===true;
        if(!keys(data,['assetId','width','height','eraseAssetId','legacy'])||!identifier(data.assetId)
          ||(data.legacy!==undefined&&data.legacy!==true)||!dimensions(data.width,data.height,legacy?16000000:2000000)
          ||(++images)>20||(legacy&&(index!==0||object.label!=='이전 주석'))
          ||(data.eraseAssetId!==undefined&&(!legacy||!identifier(data.eraseAssetId)||data.eraseAssetId===data.assetId)))bad();
        if(!legacy){pixels+=data.width*data.height;if(pixels>8000000)bad();}
        for(const assetId of [data.assetId,data.eraseAssetId].filter(v=>v!==undefined)){
          if(!assetIds.has(assetId))bad();
          const previous=assetDimensions.get(assetId);
          if(previous&&(previous[0]!==data.width||previous[1]!==data.height))bad();
          assetDimensions.set(assetId,[data.width,data.height]);used.add(assetId);
        }
        normalized={assetId:data.assetId,width:data.width,height:data.height,...(data.eraseAssetId!==undefined?{eraseAssetId:data.eraseAssetId}:{}),...(legacy?{legacy:true}:{})};
      }else if(object.kind==='mask'){
        if(!keys(data,['x','y','width','height','color'])||!rect({x:data.x,y:data.y,width:data.width,height:data.height})||typeof data.color!=='string'||!/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(data.color))bad();
        normalized={x:data.x,y:data.y,width:data.width,height:data.height,color:data.color};
      }else if(object.kind==='text'){
        if(!keys(data,['x','y','text','color','size'])||!finite(data.x)||!finite(data.y)||typeof data.text!=='string'||data.text.length<1||data.text.length>2000||!color(data.color)||!positive(data.size,16384)||data.size<1)bad();
        normalized={x:data.x,y:data.y,text:data.text,color:data.color,size:data.size};
      }else{
        if(!keys(data,['points','color','width'])||!Array.isArray(data.points)||data.points.length<2||data.points.length>8192||data.points.length%2||!dense(data.points,v=>finite(v))||!color(data.color)||!positive(data.width,8192)||data.width<.5)bad();
        normalized={points:data.points.slice(),color:data.color,width:data.width};
      }
      return {id:object.id,kind:object.kind,matrix:object.matrix.slice(),clip:{x:object.clip.x,y:object.clip.y,width:object.clip.width,height:object.clip.height},data:normalized,...(object.label!==undefined?{label:object.label}:{})};
    });
    if(used.size!==assetIds.size)bad();
    return {version:1,width:value.width,height:value.height,objects};
  }
  function projectAssets(value,fileKey){
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['document',fileKey==='blob'?'baseBlob':'baseFileId','assets'].includes(key))||!Array.isArray(value.assets)||value.assets.length>21)throw error('사진 편집 프로젝트가 올바르지 않아요.');
    const ids=new Set();
    const assets=Array.from(value.assets).map(asset=>{
      if(!asset||typeof asset!=='object'||Array.isArray(asset)||Object.keys(asset).some(key=>!['id',fileKey].includes(key))||typeof asset.id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(asset.id)||ids.has(asset.id))throw error('사진 편집 이미지 목록이 올바르지 않아요.');
      ids.add(asset.id);return {id:asset.id,[fileKey]:asset[fileKey]};
    });
    return {document:projectDocument(value.document,ids),assets};
  }
  function editFileIds(item){
    return new Set([item.editedFileId,item.cleanFileId,item.editProject&&item.editProject.baseFileId,
      ...(item.editProject&&Array.isArray(item.editProject.assets)?item.editProject.assets.map(asset=>asset.fileId):[])].filter(fileId=>fileId&&fileId!==item.fileId));
  }
  function request(req){
    return new Promise((resolve,reject)=>{
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error||error('자료를 읽거나 저장하지 못했어요.'));
    });
  }
  function defaultGroup(){
    const now=Date.now();
    return {id:'inbox',name:'내 캡처',createdAt:now,updatedAt:now};
  }
  function openDB(){
    if(opening) return opening;
    if(!global.indexedDB) return Promise.reject(error('이 브라우저에서는 캡처 저장소를 사용할 수 없어요.'));
    opening=new Promise((resolve,reject)=>{
      const req=global.indexedDB.open(DB_NAME,DB_VERSION);
      req.onupgradeneeded=()=>{
        const db=req.result;
        if(!db.objectStoreNames.contains('groups')){
          db.createObjectStore('groups',{keyPath:'id'}).add(defaultGroup());
        }
        if(!db.objectStoreNames.contains('items')){
          const items=db.createObjectStore('items',{keyPath:'id'});
          items.createIndex('groupId','groupId',{unique:false});
        }
        if(!db.objectStoreNames.contains('files')) db.createObjectStore('files',{keyPath:'id'});
      };
      req.onsuccess=()=>{
        const db=req.result;
        db.onversionchange=()=>{ db.close(); opening=null; };
        db.onclose=()=>{ opening=null; };
        resolve(db);
      };
      req.onerror=()=>{
        if(req.error&&req.error.name==='VersionError'){
          const failure=error('저장소가 새 버전으로 업데이트되었어요. 앱을 새로고침한 뒤 다시 시도해 주세요.');failure.name='VersionError';reject(failure);
        }else reject(req.error||error('캡처 저장소를 열지 못했어요.'));
      };
      req.onblocked=()=>reject(error('다른 창의 캡처 페이지를 닫은 뒤 다시 시도해 주세요.'));
    }).catch(reason=>{ opening=null; throw reason; });
    return opening;
  }
  async function transaction(names,mode,operation){
    const db=await openDB();
    return new Promise((resolve,reject)=>{
      let tx;
      try{ tx=db.transaction(names,mode); }catch(reason){ reject(reason); return; }
      const stores={};
      names.forEach(n=>{ stores[n]=tx.objectStore(n); });
      let result,reason;
      tx.oncomplete=()=>resolve(result);
      tx.onabort=()=>reject(reason||tx.error||error('자료를 저장하지 못했어요. 기존 자료는 유지돼요.'));
      // Request failures abort the whole transaction; never report a partial save.
      Promise.resolve().then(()=>operation(stores)).then(value=>{ result=value; },failure=>{
        reason=failure;
        try{ tx.abort(); }catch(_){ reject(failure); }
      });
    });
  }
  function sortGroups(groups){
    return groups.sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id));
  }
  function sortItems(items){
    return items.sort((a,b)=>a.groupId.localeCompare(b.groupId)||a.order-b.order||a.createdAt-b.createdAt||a.id.localeCompare(b.id));
  }
  async function requireGroup(stores,groupId){
    const group=await request(stores.groups.get(groupId));
    if(!group) throw error('분류가 변경되었어요. 다시 선택해 주세요.');
    return group;
  }
  async function requireItem(stores,itemId){
    const item=await request(stores.items.get(itemId));
    if(!item) throw error('자료가 삭제되었거나 변경되었어요. 다시 확인해 주세요.');
    return item;
  }
  async function groupItems(stores,groupId){
    return sortItems(await request(stores.items.index('groupId').getAll(groupId)));
  }
  function writeOrder(stores,items,now,newIds=null){
    return items.map((item,index)=>{
      const updated=item.order===index?item:{...item,order:index,updatedAt:now};
      if(newIds&&newIds.has(item.id)) stores.items.add(updated);
      else if(updated!==item) stores.items.put(updated);
      return updated;
    });
  }
  function insertionIndex(items,afterId){
    if(afterId===null||afterId===undefined) return items.length;
    const index=items.findIndex(item=>item.id===afterId);
    if(index<0) throw error('삽입할 위치가 변경되었어요. 다시 선택해 주세요.');
    return index+1;
  }
  function touchGroup(stores,group,now){ stores.groups.put({...group,updatedAt:now}); }

  async function ready(){
    return transaction(['groups','items'],'readwrite',async stores=>{
      const [groups,items]=await Promise.all([request(stores.groups.getAll()),request(stores.items.getAll())]);
      if(!groups.length){ const group=defaultGroup(); stores.groups.add(group); groups.push(group); }
      return {groups:sortGroups(groups),items:sortItems(items)};
    });
  }
  async function listGroups(){
    return transaction(['groups'],'readonly',async stores=>sortGroups(await request(stores.groups.getAll())));
  }
  async function listItems(groupId=null){
    return transaction(['items'],'readonly',async stores=>sortItems(await request(groupId===null
      ?stores.items.getAll():stores.items.index('groupId').getAll(groupId))));
  }
  async function getFile(fileId){
    return transaction(['files'],'readonly',async stores=>{
      const record=await request(stores.files.get(fileId));
      if(!record||!(record.blob instanceof Blob)) throw error('원본 파일을 찾을 수 없어요. 백업 파일이 있다면 복원해 주세요.');
      return record.blob;
    });
  }
  async function getImageProject(itemId,options){
    const expectedFileId=options&&options.expectedFileId;
    if(options!==undefined&&(typeof expectedFileId!=='string'||!expectedFileId))throw error('편집할 이미지가 변경되었어요. 다시 열어 주세요.');
    return transaction(['items','files'],'readonly',async stores=>{
      const item=await requireItem(stores,itemId);
      if(item.kind!=='image')throw error('이미지 자료만 편집할 수 있어요.');
      if(expectedFileId&&(item.editedFileId||item.fileId)!==expectedFileId)throw error('다른 창에서 이미지가 변경되었어요. 다시 열어 주세요.');
      if(item.editProject===undefined)return null;
      if(!item.editedFileId)throw error('저장된 사진 편집 프로젝트가 올바르지 않아요.');
      const project=projectAssets(item.editProject,'fileId'),cache=new Map();
      const read=fileId=>{
        if(typeof fileId!=='string'||!fileId)throw error('사진 편집 이미지가 올바르지 않아요.');
        if(!cache.has(fileId))cache.set(fileId,request(stores.files.get(fileId)).then(file=>{
          if(!file||!(file.blob instanceof Blob)||!file.blob.size||file.blob.type!=='image/png')throw error('사진 편집 이미지를 읽지 못했어요.');
          return file.blob;
        }));
        return cache.get(fileId);
      };
      const [baseBlob,assets]=await Promise.all([read(item.editProject.baseFileId),Promise.all(project.assets.map(async asset=>({id:asset.id,blob:await read(asset.fileId)})))]);
      return {document:project.document,baseBlob,assets};
    });
  }
  async function createGroup(value){
    const label=name(value),now=Date.now();
    const group={id:id('group'),name:label,createdAt:now,updatedAt:now};
    return transaction(['groups'],'readwrite',stores=>{ stores.groups.add(group); return group; });
  }
  async function renameGroup(groupId,value){
    const label=name(value);
    return transaction(['groups'],'readwrite',async stores=>{
      const group=await requireGroup(stores,groupId),updated={...group,name:label,updatedAt:Date.now()};
      stores.groups.put(updated); return updated;
    });
  }
  async function deleteGroup(groupId){
    return transaction(STORE_NAMES,'readwrite',async stores=>{
      const groups=await request(stores.groups.getAll());
      if(!groups.some(group=>group.id===groupId)) return false;
      if(groups.length<=1) throw error('마지막 분류는 삭제할 수 없어요. 새 분류를 만든 뒤 옮겨 주세요.');
      const items=await groupItems(stores,groupId);
      items.forEach(item=>{
        stores.items.delete(item.id);
        if(item.fileId) stores.files.delete(item.fileId);
        editFileIds(item).forEach(fileId=>stores.files.delete(fileId));
      });
      stores.groups.delete(groupId);
      return true;
    });
  }
  function fileInput(value,index){
    const blob=value instanceof Blob?value:value&&value.blob;
    if(!(blob instanceof Blob)||!blob.size) throw error('비어 있거나 읽을 수 없는 파일이 있어요.');
    let fileName=typeof value.name==='string'?value.name:(value&&typeof value.fileName==='string'?value.fileName:'');
    let mime=(blob.type||value.type||'').toLowerCase().split(';')[0].trim();
    const extension=fileName.toLowerCase().split('.').pop();
    const imageTypes={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',bmp:'image/bmp',avif:'image/avif',heic:'image/heic',heif:'image/heif',svg:'image/svg+xml'};
    if(!mime||mime==='application/octet-stream') mime=extension==='pdf'?'application/pdf':imageTypes[extension]||'';
    const kind=mime==='application/pdf'?'pdf':mime.startsWith('image/')?'image':null;
    if(!kind) throw error('이미지 또는 PDF 파일을 선택해 주세요.');
    if(!fileName) fileName=(kind==='pdf'?'PDF 자료':'캡처 이미지')+' '+(index+1)+(kind==='pdf'?'.pdf':'');
    return {blob,fileName,mime,kind};
  }
  async function addFiles(groupId,files,afterId=null){
    const inputs=Array.from(files||[]).map(fileInput);
    if(!inputs.length) throw error('추가할 파일을 선택해 주세요.');
    return transaction(STORE_NAMES,'readwrite',async stores=>{
      const group=await requireGroup(stores,groupId),items=await groupItems(stores,groupId),now=Date.now();
      const index=insertionIndex(items,afterId);
      const added=inputs.map(file=>({
        id:id('item'),groupId,kind:file.kind,order:0,title:file.fileName,caption:'',text:'',
        fileId:id('file'),mime:file.mime,fileName:file.fileName,size:file.blob.size,rotation:0,createdAt:now,updatedAt:now
      }));
      added.forEach((item,i)=>{ stores.files.add({id:item.fileId,blob:inputs[i].blob}); });
      items.splice(index,0,...added);
      const ids=new Set(added.map(item=>item.id)),ordered=writeOrder(stores,items,now,ids);
      touchGroup(stores,group,now);
      return ordered.filter(item=>ids.has(item.id));
    });
  }
  async function addNote(groupId,value,afterId=null){
    const content=text(value,'메모');
    if(!content.trim()) throw error('메모 내용을 입력해 주세요.');
    return transaction(['groups','items'],'readwrite',async stores=>{
      const group=await requireGroup(stores,groupId),items=await groupItems(stores,groupId),now=Date.now();
      const index=insertionIndex(items,afterId),item={
        id:id('item'),groupId,kind:'note',order:0,title:'메모',caption:'',text:content,
        fileId:null,mime:'',fileName:'',size:0,rotation:0,createdAt:now,updatedAt:now
      };
      items.splice(index,0,item);
      const ordered=writeOrder(stores,items,now,new Set([item.id]));
      touchGroup(stores,group,now);
      return ordered.find(entry=>entry.id===item.id);
    });
  }
  async function updateItem(itemId,patch,options){
    if(!patch||typeof patch!=='object'||Array.isArray(patch)) throw error('수정 내용이 올바르지 않아요.');
    const allowed=new Set(['title','caption','text','rotation']);
    if(Object.keys(patch).some(key=>!allowed.has(key))) throw error('수정할 수 없는 항목이 있어요.');
    const values={};
    for(const key of Object.keys(patch)){
      if(key==='rotation'){
        if(!ROTATIONS.has(patch.rotation)) throw error('회전 값이 올바르지 않아요.');
        values.rotation=patch.rotation;
      }else values[key]=key==='title'?name(patch[key]):text(patch[key],key==='caption'?'메모':'내용');
    }
    const expected={};
    if(options!==undefined){
      if(!options||!options.expected||typeof options.expected!=='object'||Array.isArray(options.expected)) throw error('수정 전 내용이 올바르지 않아요.');
      for(const key of Object.keys(options.expected)){
        const value=options.expected[key];
        if(!Object.prototype.hasOwnProperty.call(values,key)||(key==='rotation'?!ROTATIONS.has(value):typeof value!=='string')) throw error('수정 전 내용이 올바르지 않아요.');
        expected[key]=value;
      }
    }
    return transaction(['groups','items'],'readwrite',async stores=>{
      const item=await requireItem(stores,itemId),group=await requireGroup(stores,item.groupId),now=Date.now();
      if(Object.keys(expected).some(key=>item[key]!==expected[key])) throw error('다른 창에서 내용이 변경되었어요. 입력을 복사한 뒤 다시 확인해 주세요.');
      const updated={...item,...values,updatedAt:now};
      if(updated.kind==='note'&&!updated.text.trim()) throw error('메모 내용을 입력해 주세요.');
      stores.items.put(updated);touchGroup(stores,group,now);
      return updated;
    });
  }
  async function saveImage(itemId,pngBlobOrNull,options){
    if(!options||typeof options.expectedFileId!=='string'||!options.expectedFileId){
      throw error('편집할 이미지가 변경되었어요. 다시 열어 주세요.');
    }
    const expectedFileId=options.expectedFileId,cleanBlob=options.cleanBlob;
    if(pngBlobOrNull!==null&&(!(pngBlobOrNull instanceof Blob)||!pngBlobOrNull.size||pngBlobOrNull.type!=='image/png')){
      throw error('편집한 이미지를 PNG 파일로 저장하지 못했어요. 다시 시도해 주세요.');
    }
    if(cleanBlob!==undefined&&(!(cleanBlob instanceof Blob)||!cleanBlob.size||cleanBlob.type!=='image/png')){
      throw error('가림 없는 이미지를 PNG 파일로 저장하지 못했어요. 다시 시도해 주세요.');
    }
    let project;
    if(options.project!==undefined){
      const value=options.project,validated=projectAssets(value,'blob');
      if(!(value.baseBlob instanceof Blob)||!value.baseBlob.size||value.baseBlob.type!=='image/png'
        ||validated.assets.some(asset=>!(asset.blob instanceof Blob)||!asset.blob.size||asset.blob.type!=='image/png'))throw error('사진 편집 프로젝트의 PNG 이미지가 올바르지 않아요.');
      project={...validated,baseBlob:value.baseBlob};
    }
    return transaction(STORE_NAMES,'readwrite',async stores=>{
      const item=await requireItem(stores,itemId);
      if(item.kind!=='image') throw error('이미지 자료만 편집할 수 있어요.');
      if((item.editedFileId||item.fileId)!==expectedFileId){
        throw error('다른 창에서 이미지가 변경되었어요. 입력을 보관한 뒤 이미지를 다시 열어 주세요.');
      }
      const group=await requireGroup(stores,item.groupId),now=Date.now();
      const updated={...item,rotation:0,updatedAt:now};
      if(pngBlobOrNull!==null){
        updated.editedFileId=id('file');
        stores.files.add({id:updated.editedFileId,blob:pngBlobOrNull});
        if(cleanBlob!==undefined){
          updated.cleanFileId=id('file');
          stores.files.add({id:updated.cleanFileId,blob:cleanBlob});
        }else delete updated.cleanFileId;
        if(project){
          const baseFileId=project.baseBlob===cleanBlob?updated.cleanFileId:id('file');
          if(baseFileId!==updated.cleanFileId)stores.files.add({id:baseFileId,blob:project.baseBlob});
          const assets=project.assets.map(asset=>{
            const fileId=id('file');stores.files.add({id:fileId,blob:asset.blob});return {id:asset.id,fileId};
          });
          updated.editProject={document:project.document,baseFileId,assets};
        }else delete updated.editProject;
      }else{delete updated.editedFileId;delete updated.cleanFileId;delete updated.editProject;}
      editFileIds(item).forEach(fileId=>stores.files.delete(fileId));
      stores.items.put(updated);touchGroup(stores,group,now);
      return updated;
    });
  }
  async function removeItem(itemId){
    return transaction(STORE_NAMES,'readwrite',async stores=>{
      const item=await request(stores.items.get(itemId));
      if(!item) return false;
      const group=await requireGroup(stores,item.groupId),items=await groupItems(stores,item.groupId),now=Date.now();
      stores.items.delete(item.id);if(item.fileId) stores.files.delete(item.fileId);
      editFileIds(item).forEach(fileId=>stores.files.delete(fileId));
      writeOrder(stores,items.filter(entry=>entry.id!==item.id),now);
      touchGroup(stores,group,now);
      return true;
    });
  }
  async function moveItem(itemId,targetGroupId){
    return transaction(['groups','items'],'readwrite',async stores=>{
      const item=await requireItem(stores,itemId),target=await requireGroup(stores,targetGroupId);
      if(item.groupId===targetGroupId) return item;
      const source=await requireGroup(stores,item.groupId);
      const [oldItems,newItems]=await Promise.all([groupItems(stores,item.groupId),groupItems(stores,targetGroupId)]);
      const now=Date.now(),moved={...item,groupId:targetGroupId,order:newItems.length,updatedAt:now};
      writeOrder(stores,oldItems.filter(entry=>entry.id!==item.id),now);
      stores.items.put(moved);touchGroup(stores,source,now);touchGroup(stores,target,now);
      return moved;
    });
  }
  async function reorderItems(groupId,ids){
    if(!Array.isArray(ids)||new Set(ids).size!==ids.length) throw error('자료 순서가 올바르지 않아요.');
    return transaction(['groups','items'],'readwrite',async stores=>{
      const group=await requireGroup(stores,groupId),items=await groupItems(stores,groupId),lookup=new Map(items.map(item=>[item.id,item]));
      if(ids.length!==items.length||ids.some(itemId=>!lookup.has(itemId))) throw error('자료 목록이 변경되었어요. 다시 시도해 주세요.');
      const now=Date.now(),ordered=writeOrder(stores,ids.map(itemId=>lookup.get(itemId)),now);
      touchGroup(stores,group,now);return ordered;
    });
  }
  async function reorderItem(itemId,direction){
    if(direction!==-1&&direction!==1) throw error('이동 방향이 올바르지 않아요.');
    return transaction(['groups','items'],'readwrite',async stores=>{
      const item=await requireItem(stores,itemId),group=await requireGroup(stores,item.groupId),items=await groupItems(stores,item.groupId);
      const from=items.findIndex(entry=>entry.id===itemId),to=from+direction;
      if(to<0||to>=items.length) return items;
      [items[from],items[to]]=[items[to],items[from]];
      const now=Date.now(),ordered=writeOrder(stores,items,now);
      touchGroup(stores,group,now);return ordered;
    });
  }

  function encode(bytes){
    const chunks=[];
    for(let i=0;i<bytes.length;i+=32768) chunks.push(String.fromCharCode.apply(null,bytes.subarray(i,i+32768)));
    return global.btoa(chunks.join(''));
  }
  function decode(value){
    if(typeof value!=='string'||!value.length||value.length%4||/[^A-Za-z0-9+/=]/.test(value)) throw error('백업 파일의 원본 자료가 올바르지 않아요.');
    let binary;
    try{ binary=global.atob(value); }catch(_){ throw error('백업 파일의 원본 자료가 올바르지 않아요.'); }
    const bytes=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
    return bytes;
  }
  async function exportArchive(){
    const snapshot=await transaction(STORE_NAMES,'readonly',async stores=>{
      const [groups,items,files]=await Promise.all(STORE_NAMES.map(key=>request(stores[key].getAll())));
      return {groups:sortGroups(groups),items:sortItems(items),files};
    });
    const files=[];
    for(const file of snapshot.files){
      files.push({id:file.id,type:file.blob.type,size:file.blob.size,data:encode(new Uint8Array(await file.blob.arrayBuffer()))});
    }
    return new Blob([JSON.stringify({format:'workbook-captures',version:1,exportedAt:Date.now(),groups:snapshot.groups,items:snapshot.items,files})],{type:'application/json'});
  }
  function validateArchive(raw){
    const bad=()=>{ throw error('올바른 캡처 백업 파일이 아니에요. 기존 자료는 변경하지 않았어요.'); };
    if(!raw||raw.format!=='workbook-captures'||raw.version!==1||!Array.isArray(raw.groups)||!raw.groups.length||!Array.isArray(raw.items)||!Array.isArray(raw.files)) bad();
    const groups=new Map(),items=new Map(),files=new Map(),usedFiles=new Set();
    const validId=value=>typeof value==='string'&&value.length>0;
    const validTime=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
    for(const group of raw.groups){
      if(!group||!validId(group.id)||groups.has(group.id)||typeof group.name!=='string'||!group.name.trim()||!validTime(group.createdAt)||!validTime(group.updatedAt)) bad();
      groups.set(group.id,{id:group.id,name:group.name.trim(),createdAt:group.createdAt,updatedAt:group.updatedAt});
    }
    for(const file of raw.files){
      if(!file||!validId(file.id)||files.has(file.id)||typeof file.type!=='string'||!Number.isSafeInteger(file.size)||file.size<=0) bad();
      const bytes=decode(file.data);
      if(bytes.length!==file.size) bad();
      files.set(file.id,{id:file.id,blob:new Blob([bytes],{type:file.type})});
    }
    for(const item of raw.items){
      if(!item||!validId(item.id)||items.has(item.id)||!groups.has(item.groupId)||!KINDS.has(item.kind)||!Number.isSafeInteger(item.order)||item.order<0||!ROTATIONS.has(item.rotation)||!validTime(item.createdAt)||!validTime(item.updatedAt)) bad();
      if(['title','caption','text','mime','fileName'].some(key=>typeof item[key]!=='string')) bad();
      const hasEdited=item.editedFileId!==undefined,hasClean=item.cleanFileId!==undefined,hasProject=item.editProject!==undefined;
      if(hasEdited&&item.kind!=='image') bad();
      if(hasClean&&(!hasEdited||item.kind!=='image')) bad();
      if(hasProject&&(!hasEdited||item.kind!=='image'))bad();
      if(item.kind==='note'){
        if(!item.text.trim()||item.fileId!==null||item.size!==0) bad();
      }else{
        if(!item.title.trim()||!validId(item.fileId)||!files.has(item.fileId)||usedFiles.has(item.fileId)) bad();
        if(!Number.isSafeInteger(item.size)||item.size!==files.get(item.fileId).blob.size) bad();
        if(item.kind==='pdf'&&item.mime!=='application/pdf'||item.kind==='image'&&!item.mime.startsWith('image/')) bad();
        usedFiles.add(item.fileId);
      }
      if(hasEdited){
        if(!validId(item.editedFileId)||!files.has(item.editedFileId)||usedFiles.has(item.editedFileId)
          ||files.get(item.editedFileId).blob.type!=='image/png') bad();
        usedFiles.add(item.editedFileId);
      }
      if(hasClean){
        if(!validId(item.cleanFileId)||!files.has(item.cleanFileId)||usedFiles.has(item.cleanFileId)
          ||files.get(item.cleanFileId).blob.type!=='image/png') bad();
        usedFiles.add(item.cleanFileId);
      }
      let editProject;
      if(hasProject){
        const project=projectAssets(item.editProject,'fileId'),baseFileId=item.editProject.baseFileId;
        const claim=fileId=>{
          if(!validId(fileId)||!files.has(fileId)||usedFiles.has(fileId)||files.get(fileId).blob.type!=='image/png')bad();
          usedFiles.add(fileId);
        };
        if(!hasClean||baseFileId!==item.cleanFileId)claim(baseFileId);
        const assets=project.assets.map(asset=>{claim(asset.fileId);return asset;});
        editProject={document:project.document,baseFileId,assets};
      }
      items.set(item.id,{id:item.id,groupId:item.groupId,kind:item.kind,order:item.order,title:item.title,caption:item.caption,text:item.text,fileId:item.fileId,mime:item.mime,fileName:item.fileName,size:item.size,rotation:item.rotation,createdAt:item.createdAt,updatedAt:item.updatedAt,
        ...(hasEdited?{editedFileId:item.editedFileId}:{}),...(hasClean?{cleanFileId:item.cleanFileId}:{}),...(hasProject?{editProject}:{})});
    }
    if(usedFiles.size!==files.size) bad();
    return {groups:[...groups.values()],items:[...items.values()],files:[...files.values()]};
  }
  async function importArchive(value){
    let raw;
    try{ raw=JSON.parse(value instanceof Blob?await value.text():text(value,'백업')); }
    catch(_){ throw error('캡처 백업 파일을 읽지 못했어요. 기존 자료는 변경하지 않았어요.'); }
    const archive=validateArchive(raw);
    // Remap every ID before writing so restoration never replaces current work.
    const groupIds=new Map(archive.groups.map(group=>[group.id,id('group')]));
    const fileIds=new Map(archive.files.map(file=>[file.id,id('file')]));
    await transaction(STORE_NAMES,'readwrite',stores=>{
      archive.groups.forEach(group=>stores.groups.add({...group,id:groupIds.get(group.id)}));
      archive.files.forEach(file=>stores.files.add({id:fileIds.get(file.id),blob:file.blob}));
      const ordered=sortItems(archive.items),positions=new Map();
      ordered.forEach(item=>{
        const groupId=groupIds.get(item.groupId),order=positions.get(groupId)||0;
        positions.set(groupId,order+1);
        stores.items.add({...item,id:id('item'),groupId,order,fileId:item.fileId?fileIds.get(item.fileId):null,
          ...(item.editedFileId?{editedFileId:fileIds.get(item.editedFileId)}:{}),
          ...(item.cleanFileId?{cleanFileId:fileIds.get(item.cleanFileId)}:{}),
          ...(item.editProject?{editProject:{document:item.editProject.document,baseFileId:fileIds.get(item.editProject.baseFileId),assets:item.editProject.assets.map(asset=>({id:asset.id,fileId:fileIds.get(asset.fileId)}))}}:{})});
      });
    });
    return ready();
  }

  global.CaptureStore=Object.freeze({ready,listGroups,listItems,getFile,getImageProject,createGroup,renameGroup,deleteGroup,addFiles,addNote,updateItem,saveImage,moveItem,reorderItem,reorderItems,removeItem,exportArchive,importArchive});
})(window);
