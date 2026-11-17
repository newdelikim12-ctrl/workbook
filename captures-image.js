/* Local retained image editor. Originals stay separate from editable objects. */
(function(){
  'use strict';
  const MAX_PIXELS=16000000,MAX_SIDE=8192,MAX_HISTORY=500,MAX_POINTS=4096,MAX_TEXT=2000;
  const MAX_IMAGE_PIXELS=2000000,MAX_ASSET_PIXELS=8000000,MAX_IMAGES=20;
  const identity=()=>[1,0,0,1,0,0];
  const finite=value=>Number.isFinite(Number(value));
  const rotation=value=>((Math.round((Number(value)||0)/90)*90)%360+360)%360;
  const clone=value=>JSON.parse(JSON.stringify(value));
  function multiply(a,b){return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];}
  function inverse(m){const d=m[0]*m[3]-m[1]*m[2];return Math.abs(d)<1e-15?null:[m[3]/d,-m[1]/d,-m[2]/d,m[0]/d,(m[2]*m[5]-m[3]*m[4])/d,(m[1]*m[4]-m[0]*m[5])/d];}
  function transformRect(rect,m){
    const points=[[rect.x,rect.y],[rect.x+rect.width,rect.y],[rect.x,rect.y+rect.height],[rect.x+rect.width,rect.y+rect.height]].map(([x,y])=>[m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]]);
    const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]),x=Math.min(...xs),y=Math.min(...ys);
    return {x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y};
  }
  function intersection(a,b){const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),right=Math.min(a.x+a.width,b.x+b.width),bottom=Math.min(a.y+a.height,b.y+b.height);return right>x&&bottom>y?{x,y,width:right-x,height:bottom-y}:null;}
  function oriented(width,height,degrees){
    if(degrees===90)return {width:height,height:width,matrix:[0,1,-1,0,height,0]};
    if(degrees===180)return {width,height,matrix:[-1,0,0,-1,width,height]};
    if(degrees===270)return {width:height,height:width,matrix:[0,-1,1,0,0,width]};
    return {width,height,matrix:identity()};
  }
  function canvas(width,height,language){const result=document.createElement('canvas');if(language)result.lang=language;result.width=width;result.height=height;return result;}
  function release(image){if(!image)return;if(typeof image.close==='function'){try{image.close();}catch(error){}}else if(image.tagName==='CANVAS'){image.width=0;image.height=0;}else if(image.tagName==='IMG')image.src='';}
  async function decode(blob,pixelBudget){
    if(!(blob instanceof Blob)||!blob.size)throw Error('편집할 이미지 파일이 없습니다.');
    let image=null,url=null;
    try{
      if(typeof createImageBitmap==='function'){try{image=await createImageBitmap(blob,{imageOrientation:'from-image'});}catch(error){}}
      if(!image){image=new Image();image.decoding='async';url=URL.createObjectURL(blob);await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('이 이미지를 읽지 못했어요. PNG나 JPG 파일을 확인해 주세요.'));image.src=url;});}
      const sourceWidth=image.naturalWidth||image.width,sourceHeight=image.naturalHeight||image.height;
      if(!sourceWidth||!sourceHeight)throw Error('이미지 크기를 읽지 못했습니다.');
      const scale=Math.min(1,Math.sqrt(pixelBudget/(sourceWidth*sourceHeight)),MAX_SIDE/sourceWidth,MAX_SIDE/sourceHeight);
      const width=Math.max(1,Math.floor(sourceWidth*scale)),height=Math.max(1,Math.floor(sourceHeight*scale));
      if(width!==sourceWidth||height!==sourceHeight){
        let resized=null;if(typeof createImageBitmap==='function'){try{resized=await createImageBitmap(image,{resizeWidth:width,resizeHeight:height,resizeQuality:'high'});}catch(error){}}
        if(!resized){resized=canvas(width,height);resized.getContext('2d').drawImage(image,0,0,width,height);}release(image);image=resized;
      }
      return {image,width,height,sourceWidth,sourceHeight,scaled:width!==sourceWidth||height!==sourceHeight};
    }catch(error){release(image);throw error;}finally{if(url)URL.revokeObjectURL(url);}
  }
  async function png(target){return new Promise((resolve,reject)=>{try{target.toBlob(blob=>blob?resolve(blob):reject(Error('편집한 이미지를 저장 파일로 만들지 못했습니다.')),'image/png');}catch(error){reject(error);}});}
  function color(value){const candidate=typeof value==='string'?value.trim():'';return candidate&&candidate.length<=128&&!/\b(?:var|url)\s*\(/iu.test(candidate)&&typeof CSS!=='undefined'&&CSS.supports('color',candidate)?candidate:'#e5484d';}
  function opaqueColor(value){const candidate=typeof value==='string'?value.trim():'';return /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(candidate)?candidate:'#000000';}
  function validateProject(document,assets){
    const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v),number=v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e7;
    const keys=(value,allowed)=>record(value)&&Object.keys(value).every(key=>allowed.includes(key));
    const dense=(value,check)=>Array.isArray(value)&&Array.from({length:value.length},(_,index)=>index).every(index=>Object.prototype.hasOwnProperty.call(value,index)&&check(value[index]));
    const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(v),positive=v=>number(v)&&v>0;
    const rect=v=>record(v)&&['x','y','width','height'].every(k=>number(v[k]))&&v.width>0&&v.height>0;
    const tint=v=>typeof v==='string'&&!!v&&v.length<=128&&!/\b(?:var|url)\s*\(/iu.test(v)&&typeof CSS!=='undefined'&&CSS.supports('color',v);
    if(!keys(document,['version','width','height','objects'])||document.version!==1||!Number.isSafeInteger(document.width)||!Number.isSafeInteger(document.height)||document.width<1||document.height<1||Math.max(document.width,document.height)>MAX_SIDE||document.width*document.height>MAX_PIXELS||!dense(document.objects,record)||document.objects.length>MAX_HISTORY)return false;
    const ids=new Set(),used=new Set();let images=0,area=0;
    for(let index=0;index<document.objects.length;index++){
      const object=document.objects[index];if(!keys(object,['id','kind','matrix','clip','data','label'])||!id(object.id)||ids.has(object.id)||!Array.isArray(object.matrix)||object.matrix.length!==6||!dense(object.matrix,number)||!inverse(object.matrix)||!keys(object.clip,['x','y','width','height'])||!rect(object.clip)||!record(object.data)||(object.label!==undefined&&(typeof object.label!=='string'||object.label.length>80)))return false;ids.add(object.id);
      const data=object.data;
      if(object.kind==='image'){
        if(!keys(data,['assetId','width','height','eraseAssetId','legacy'])||++images>MAX_IMAGES||!id(data.assetId)||!Number.isSafeInteger(data.width)||!Number.isSafeInteger(data.height)||data.width<1||data.height<1||Math.max(data.width,data.height)>MAX_SIDE)return false;
        const pixels=data.width*data.height;
        if(data.legacy!==undefined&&data.legacy!==true)return false;
        if(data.legacy){if(index!==0||pixels>MAX_PIXELS||object.label!=='이전 주석')return false;}
        else{area+=pixels;if(pixels>MAX_IMAGE_PIXELS||area>MAX_ASSET_PIXELS||data.eraseAssetId!==undefined)return false;}
        used.add(data.assetId);if(data.eraseAssetId!==undefined){if(!id(data.eraseAssetId)||data.eraseAssetId===data.assetId)return false;used.add(data.eraseAssetId);}
      }else if(object.kind==='mask'){
        if(!keys(data,['x','y','width','height','color'])||!rect(data)||!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(data.color))return false;
      }else if(object.kind==='line'||object.kind==='stroke'){
        if(!keys(data,['points','color','width'])||!Array.isArray(data.points)||data.points.length<2||data.points.length>MAX_POINTS*2||data.points.length%2||!dense(data.points,number)||!positive(data.width)||data.width<.5||data.width>MAX_SIDE||!tint(data.color))return false;
      }else if(object.kind==='text'){
        if(!keys(data,['x','y','text','color','size'])||!number(data.x)||!number(data.y)||typeof data.text!=='string'||!data.text.length||data.text.length>MAX_TEXT||!positive(data.size)||data.size>MAX_SIDE*2||!tint(data.color))return false;
      }else return false;
    }
    if(assets!==undefined){
      if(!Array.isArray(assets)||assets.length>MAX_IMAGES+1||assets.length!==used.size)return false;
      const found=new Set();for(const asset of assets){if(!keys(asset,['id','blob'])||!id(asset.id)||found.has(asset.id)||!used.has(asset.id)||!(asset.blob instanceof Blob)||!asset.blob.size||asset.blob.type!=='image/png')return false;found.add(asset.id);}
    }
    return true;
  }
  async function create(blob,options={}){
    const language=document.documentElement.lang||navigator.language||'ko';
    const project=options.project||null;
    if(project&&(!validateProject(project,options.assets)||!(options.baseBlob instanceof Blob)))throw Error('사진의 편집 정보를 읽지 못했어요. 원본은 그대로 유지됩니다.');
    const currentBlob=project?options.baseBlob:blob,originalBlob=options.originalBlob instanceof Blob?options.originalBlob:blob,cleanBlob=options.cleanBlob instanceof Blob?options.cleanBlob:currentBlob;
    const sourceBlobs=[...new Set([currentBlob,originalBlob,cleanBlob])],sources=new Map(),assetMap=new Map(),preview=new Map();
    const budget=MAX_PIXELS/sourceBlobs.length;
    let currentSource,originalSource,cleanSource,destroyed=false,cursor=0,lastObjectId=null,cached=null,legacyFlattened=false;
    const history=[];let initialObjects=[];
    let sequence=0;const prefix='o_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8)+'_';
    const newId=()=>prefix+(++sequence).toString(36);
    function alive(){if(destroyed)throw Error('이미지 편집기가 닫혔습니다.');}
    async function assetFromCanvas(target){const assetBlob=await png(target),decoded=await decode(assetBlob,MAX_PIXELS);const id=newId();return {id,blob:assetBlob,...decoded};}
    try{
      for(const value of sourceBlobs)sources.set(value,await decode(value,budget));
      currentSource=sources.get(currentBlob);originalSource=sources.get(originalBlob);cleanSource=sources.get(cleanBlob);
      if(currentSource.sourceWidth!==cleanSource.sourceWidth||currentSource.sourceHeight!==cleanSource.sourceHeight)throw Error('필기를 숨길 이미지의 크기가 편집본과 달라요. 저장한 사진을 다시 확인해 주세요.');
      if(project){
        legacyFlattened=cleanSource!==currentSource;
        if(project.width!==currentSource.sourceWidth||project.height!==currentSource.sourceHeight)throw Error('사진 배경과 편집 정보의 크기가 달라요.');
        let assetArea=0;
        for(const asset of options.assets){const decoded=await decode(asset.blob,MAX_PIXELS);assetMap.set(asset.id,{id:asset.id,blob:asset.blob,...decoded});assetArea+=decoded.width*decoded.height;if(assetArea>MAX_ASSET_PIXELS)throw Error('삽입 사진 용량이 많아 편집 정보를 열지 못했습니다.');}
        for(const object of project.objects)if(object.kind==='image'){
          for(const id of [object.data.assetId,object.data.eraseAssetId].filter(Boolean)){const asset=assetMap.get(id);if(asset.width!==object.data.width||asset.height!==object.data.height)throw Error('삽입한 사진과 편집 정보의 크기가 달라요.');}
        }
        const scale=[currentSource.width/project.width,0,0,currentSource.height/project.height,0,0];
        initialObjects=clone(project.objects).map(object=>({...object,matrix:multiply(scale,object.matrix)}));
      }else if(cleanSource!==currentSource){
        // Preserve old flattened marks as one editable layer. The eraser mask
        // makes replacement exact even when either source has transparent pixels.
        const old=canvas(currentSource.width,currentSource.height,language),clean=canvas(old.width,old.height,language);
        try{
          old.getContext('2d').drawImage(currentSource.image,0,0);clean.getContext('2d').drawImage(cleanSource.image,0,0);
          const before=clean.getContext('2d').getImageData(0,0,old.width,old.height).data,after=old.getContext('2d').getImageData(0,0,old.width,old.height).data;
          let left=old.width,top=old.height,right=0,bottom=0,needsErase=false;
          for(let y=0;y<old.height;y++)for(let x=0;x<old.width;x++){const p=(y*old.width+x)*4;if(after[p]!==before[p]||after[p+1]!==before[p+1]||after[p+2]!==before[p+2]||after[p+3]!==before[p+3]){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);if(after[p+3]!==255)needsErase=true;}}
          if(right>left&&bottom>top){
            const w=right-left,h=bottom-top;
            if(w*h*(needsErase?2:1)<=MAX_ASSET_PIXELS){
              const paint=canvas(w,h,language),erase=needsErase?canvas(w,h,language):null;
              try{
                const paintCtx=paint.getContext('2d'),paintData=paintCtx.createImageData(w,h),eraseCtx=erase&&erase.getContext('2d'),eraseData=eraseCtx&&eraseCtx.createImageData(w,h);
                for(let y=0;y<h;y++)for(let x=0;x<w;x++){const p=((top+y)*old.width+left+x)*4,q=(y*w+x)*4;if(after[p]!==before[p]||after[p+1]!==before[p+1]||after[p+2]!==before[p+2]||after[p+3]!==before[p+3]){paintData.data.set(after.subarray(p,p+4),q);if(eraseData)eraseData.data[q+3]=255;}}
                paintCtx.putImageData(paintData,0,0);const asset=await assetFromCanvas(paint);assetMap.set(asset.id,asset);
                const data={assetId:asset.id,width:w,height:h,legacy:true};
                if(erase){eraseCtx.putImageData(eraseData,0,0);const eraser=await assetFromCanvas(erase);assetMap.set(eraser.id,eraser);data.eraseAssetId=eraser.id;}
                initialObjects=[{id:newId(),kind:'image',label:'이전 주석',matrix:[1,0,0,1,left,top],clip:{x:0,y:0,width:w,height:h},data}];currentSource=cleanSource;
              }finally{paint.width=0;paint.height=0;if(erase){erase.width=0;erase.height=0;}}
            }else legacyFlattened=true;
          }else currentSource=cleanSource;
        }finally{old.width=0;old.height=0;clean.width=0;clean.height=0;}
      }
    }catch(error){for(const value of sources.values())release(value.image);for(const asset of assetMap.values())release(asset.image);throw error;}
    const initialRotation=project?0:rotation(options.rotation),initial=oriented(currentSource.width,currentSource.height,initialRotation);
    if(!project&&initialRotation)initialObjects=initialObjects.map(object=>({...object,matrix:multiply(initial.matrix,object.matrix)}));
    function scene(){
      if(cached)return cached;
      let state={width:initial.width,height:initial.height,base:currentSource,clean:cleanSource,matrix:initial.matrix.slice(),objects:clone(initialObjects),original:currentSource===originalSource&&initialRotation===0&&!initialObjects.length};
      for(let i=0;i<cursor;i++){
        const command=history[i];state.original=false;
        if(command.kind==='reset'){state={width:originalSource.width,height:originalSource.height,base:originalSource,clean:originalSource,matrix:identity(),objects:[],original:true};continue;}
        if(command.kind==='add'){state.objects.push(clone(command.object));continue;}
        if(command.kind==='delete'){state.objects=state.objects.filter(object=>object.id!==command.id);continue;}
        if(command.kind==='update'){const object=state.objects.find(value=>value.id===command.id);if(object)object.matrix=command.matrix.slice();continue;}
        let transform;
        if(command.kind==='crop'){
          const view={x:command.x,y:command.y,width:command.width,height:command.height};
          state.objects=state.objects.filter(object=>{const inv=inverse(object.matrix),clip=inv&&intersection(object.clip,transformRect(view,inv));if(!clip)return false;object.clip=clip;return true;});
          transform=[1,0,0,1,-command.x,-command.y];state.width=command.width;state.height=command.height;
        }else if(command.kind==='rotate'){transform=[0,1,-1,0,state.height,0];const old=state.width;state.width=state.height;state.height=old;}
        if(transform){state.matrix=multiply(transform,state.matrix);for(const object of state.objects)object.matrix=multiply(transform,object.matrix);}
      }
      cached=state;return state;
    }
    function usedAssets(commands){
      const used=new Set(),collect=object=>{if(object.kind==='image'){used.add(object.data.assetId);if(object.data.eraseAssetId)used.add(object.data.eraseAssetId);}};
      initialObjects.forEach(collect);for(const command of commands)if(command.kind==='add')collect(command.object);return used;
    }
    function prospectiveAssetArea(){const used=usedAssets(history.slice(0,cursor));return [...assetMap.values()].reduce((sum,asset)=>sum+(used.has(asset.id)?asset.width*asset.height:0),0);}
    function commit(command){
      alive();if(cursor>=MAX_HISTORY)throw Error('편집 기록이 많아요. 저장한 뒤 다시 편집해 주세요.');history.splice(cursor);history.push(command);cursor++;cached=null;preview.clear();
      const used=usedAssets(history);for(const[id,asset]of assetMap)if(!used.has(id)){release(asset.image);assetMap.delete(id);}return true;
    }
    function bounds(object,matrix=object.matrix){return transformRect(object.clip,matrix);}
    function publicObject(object){return {id:object.id,kind:object.kind,...bounds(object,preview.get(object.id)||object.matrix),...(object.label?{label:object.label}:{})};}
    function point(x,y){if(!finite(x)||!finite(y))return null;const state=scene(),limit=Math.max(state.width,state.height)*4+1024;return {x:Math.max(-limit,Math.min(limit,Number(x))),y:Math.max(-limit,Math.min(limit,Number(y)))};}
    function pen(value){const state=scene();return Math.max(.5,Math.min(Math.max(state.width,state.height)/2,Number(value)||4));}
    function rectangle(rect){const state=scene();if(![rect.x,rect.y,rect.width,rect.height].every(finite)||Number(rect.width)===0||Number(rect.height)===0)return null;const x=Number(rect.x),y=Number(rect.y),xx=x+Number(rect.width),yy=y+Number(rect.height),left=Math.max(0,Math.floor(Math.min(x,xx))),top=Math.max(0,Math.floor(Math.min(y,yy))),right=Math.min(state.width,Math.ceil(Math.max(x,xx))),bottom=Math.min(state.height,Math.ceil(Math.max(y,yy)));return right>left&&bottom>top?{x:left,y:top,width:right-left,height:bottom-top}:null;}
    function addObject(kind,data,clip,matrix=identity(),label){if(scene().objects.length>=MAX_HISTORY)throw Error('편집 요소가 많아요. 새 사진으로 나누어 주세요.');const object={id:newId(),kind,matrix,clip,data,...(label?{label}:{})};commit({kind:'add',object});lastObjectId=object.id;return true;}
    function draw(ctx,object,usePreview=true){
      const data=object.data;ctx.save();ctx.setTransform(...(usePreview&&preview.get(object.id)||object.matrix));ctx.beginPath();ctx.rect(object.clip.x,object.clip.y,object.clip.width,object.clip.height);ctx.clip();ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;
      if(object.kind==='image'){
        if(data.eraseAssetId){ctx.globalCompositeOperation='destination-out';ctx.drawImage(assetMap.get(data.eraseAssetId).image,0,0,data.width,data.height);ctx.globalCompositeOperation='source-over';}
        ctx.drawImage(assetMap.get(data.assetId).image,0,0,data.width,data.height);
      }else if(object.kind==='mask'){ctx.fillStyle=data.color;ctx.fillRect(data.x,data.y,data.width,data.height);}
      else if(object.kind==='text'){ctx.fillStyle=data.color;ctx.font=data.size+'px sans-serif';ctx.textAlign='left';ctx.textBaseline='top';for(const [index,line]of data.text.split('\n').entries())ctx.fillText(line,data.x,data.y+index*data.size*1.3);}
      else{ctx.strokeStyle=data.color;ctx.fillStyle=data.color;ctx.lineWidth=data.width;ctx.lineCap='round';ctx.lineJoin='round';if(data.points.length===2){ctx.beginPath();ctx.arc(data.points[0],data.points[1],data.width/2,0,Math.PI*2);ctx.fill();}else{ctx.beginPath();ctx.moveTo(data.points[0],data.points[1]);for(let i=2;i<data.points.length;i+=2)ctx.lineTo(data.points[i],data.points[i+1]);ctx.stroke();}}
      ctx.restore();
    }
    function render(target,renderOptions={}){
      alive();if(!target||typeof target.getContext!=='function')throw Error('이미지를 표시할 캔버스가 없습니다.');
      const state=scene();target.lang=language;target.width=state.width;target.height=state.height;const ctx=target.getContext('2d',{alpha:true});if(!ctx)throw Error('이미지 편집 기능을 시작하지 못했습니다.');
      const source=renderOptions&&renderOptions.annotations===false&&!renderOptions.baseOnly?state.clean:state.base;
      ctx.setTransform(...state.matrix);ctx.drawImage(source.image,0,0,source.width,source.height);ctx.setTransform(1,0,0,1,0,0);
      if(!renderOptions||renderOptions.annotations!==false)for(const object of state.objects)draw(ctx,object,!renderOptions||renderOptions.preview!==false);
      return target;
    }
    function updateMatrix(object,rect){
      if(!rect||!['x','y','width','height'].every(key=>finite(rect[key])))return null;
      const desired={x:Number(rect.x),y:Number(rect.y),width:Number(rect.width),height:Number(rect.height)},before=bounds(object);
      if(desired.width<=0||desired.height<=0||Math.max(desired.width,desired.height)>MAX_SIDE*8||Math.abs(desired.x)>1e7||Math.abs(desired.y)>1e7||before.width<=0||before.height<=0)return null;
      const sx=desired.width/before.width,sy=desired.height/before.height;return multiply([sx,0,0,sy,desired.x-before.x*sx,desired.y-before.y*sy],object.matrix);
    }
    const engine={
      get width(){return scene().width;},get height(){return scene().height;},get language(){return language;},get canUndo(){return !destroyed&&cursor>0;},get canRedo(){return !destroyed&&cursor<history.length;},get isOriginal(){return !destroyed&&scene().original;},
      get scaled(){return [...sources.values()].some(source=>source.scaled);},get sourceWidth(){return currentSource.sourceWidth;},get sourceHeight(){return currentSource.sourceHeight;},get originalWidth(){return originalSource.sourceWidth;},get originalHeight(){return originalSource.sourceHeight;},get historyLimit(){return MAX_HISTORY;},get maxTextLength(){return MAX_TEXT;},get lastObjectId(){return lastObjectId;},get legacyFlattened(){return legacyFlattened;},
      render,
      getObjects(){alive();return scene().objects.map(publicObject);},
      getObject(id){alive();const object=scene().objects.find(value=>value.id===id);return object?publicObject(object):null;},
      hitTest(x,y){alive();if(!finite(x)||!finite(y))return null;const objects=scene().objects;for(let i=objects.length-1;i>=0;i--){const rect=publicObject(objects[i]);if(x>=rect.x&&y>=rect.y&&x<=rect.x+rect.width&&y<=rect.y+rect.height)return rect.id;}return null;},
      updateObject(id,rect){alive();const object=scene().objects.find(value=>value.id===id),matrix=object&&updateMatrix(object,rect);preview.delete(id);if(!matrix||matrix.every((value,index)=>Math.abs(value-object.matrix[index])<1e-10))return false;return commit({kind:'update',id,matrix});},
      previewObject(id,rect){alive();if(rect===null||rect===undefined)return preview.delete(id);const object=scene().objects.find(value=>value.id===id),matrix=object&&updateMatrix(object,rect);if(!matrix)return false;preview.set(id,matrix);return true;},
      deleteObject(id){alive();if(!scene().objects.some(value=>value.id===id))return false;return commit({kind:'delete',id});},
      rotate(){return commit({kind:'rotate'});},
      crop(rect={}){alive();const value=rectangle(rect),state=scene();return !value||value.x===0&&value.y===0&&value.width===state.width&&value.height===state.height?false:commit({kind:'crop',...value});},
      mask(rect={}){alive();const value=rectangle(rect);return value?addObject('mask',{...value,color:opaqueColor(rect.color)},value):false;},
      line(args={}){alive();const a=point(args.x1,args.y1),b=point(args.x2,args.y2);if(!a||!b)return false;const width=pen(args.width),clip={x:Math.min(a.x,b.x)-width/2,y:Math.min(a.y,b.y)-width/2,width:Math.abs(a.x-b.x)+width,height:Math.abs(a.y-b.y)+width};return addObject('line',{points:[a.x,a.y,b.x,b.y],color:color(args.color),width},clip);},
      stroke(args={}){alive();if(!Array.isArray(args.points)||!args.points.length)return false;const valid=args.points.map(p=>p&&point(p.x,p.y)).filter(Boolean);if(!valid.length)return false;const count=Math.min(valid.length,MAX_POINTS),points=[];for(let i=0;i<count;i++){const p=valid[count===1?0:Math.round(i*(valid.length-1)/(count-1))];points.push(p.x,p.y);}const xs=[],ys=[];for(let i=0;i<points.length;i+=2){xs.push(points[i]);ys.push(points[i+1]);}const width=pen(args.width),x=Math.min(...xs)-width/2,y=Math.min(...ys)-width/2;return addObject('stroke',{points,color:color(args.color),width},{x,y,width:Math.max(...xs)-x+width/2,height:Math.max(...ys)-y+width/2});},
      text(args={}){
        alive();const position=point(args.x,args.y),value=String(args.text??'').replace(/\r\n?/g,'\n');if(!position||!value.trim())return false;if(value.length>MAX_TEXT)throw Error('글자가 너무 많아요. 2,000자 이하로 나누어 넣어 주세요.');
        const state=scene(),size=Math.max(1,Math.min(Math.max(state.width,state.height)*2,Number(args.size)||32)),measure=canvas(1,1,language),ctx=measure.getContext('2d');ctx.font=size+'px sans-serif';ctx.textBaseline='top';let left=position.x,top=position.y,right=left,bottom=top;
        for(const[index,line]of value.split('\n').entries()){const box=ctx.measureText(line),y=position.y+index*size*1.3;left=Math.min(left,position.x-box.actualBoundingBoxLeft);right=Math.max(right,position.x+Math.max(box.width,box.actualBoundingBoxRight));top=Math.min(top,y-box.actualBoundingBoxAscent);bottom=Math.max(bottom,y+Math.max(size,box.actualBoundingBoxDescent));}measure.width=0;measure.height=0;
        return addObject('text',{x:position.x,y:position.y,text:value,color:color(args.color),size},{x:left-1,y:top-1,width:Math.max(1,right-left+2),height:Math.max(1,bottom-top+2)});
      },
      async addImage(imageBlob,rect){
        alive();if(scene().objects.filter(object=>object.kind==='image').length>=MAX_IMAGES)throw Error('삽입 사진은 한 장에 20개까지 넣을 수 있어요.');
        let decoded=null,canonical=null,asset=null;
        try{
          decoded=await decode(imageBlob,MAX_IMAGE_PIXELS);alive();const used=prospectiveAssetArea();if(used+decoded.width*decoded.height>MAX_ASSET_PIXELS)throw Error('삽입 사진 용량이 많아요. 사진 크기를 줄이거나 새 캡처로 나누어 주세요.');
          canonical=canvas(decoded.width,decoded.height,language);canonical.getContext('2d').drawImage(decoded.image,0,0);const canonicalBlob=await png(canonical);asset={id:newId(),blob:canonicalBlob,...await decode(canonicalBlob,MAX_IMAGE_PIXELS)};alive();
          const state=scene(),fit=Math.min(1,state.width*.65/asset.width,state.height*.65/asset.height),defaultWidth=asset.width*fit,defaultHeight=asset.height*fit;
          const desired=rect||{x:(state.width-defaultWidth)/2,y:(state.height-defaultHeight)/2,width:defaultWidth,height:defaultHeight};
          if(!['x','y','width','height'].every(key=>finite(desired[key]))||Number(desired.width)<=0||Number(desired.height)<=0)throw Error('삽입 사진의 크기를 확인해 주세요.');
          if(scene().objects.filter(object=>object.kind==='image').length>=MAX_IMAGES||prospectiveAssetArea()+asset.width*asset.height>MAX_ASSET_PIXELS)throw Error('삽입 사진 용량이 많아요. 새 캡처로 나누어 주세요.');
          assetMap.set(asset.id,asset);const matrix=[Number(desired.width)/asset.width,0,0,Number(desired.height)/asset.height,Number(desired.x),Number(desired.y)];
          try{addObject('image',{assetId:asset.id,width:asset.width,height:asset.height},{x:0,y:0,width:asset.width,height:asset.height},matrix);return lastObjectId;}catch(error){assetMap.delete(asset.id);throw error;}
        }catch(error){if(asset&&!assetMap.has(asset.id))release(asset.image);throw error;}finally{if(decoded)release(decoded.image);if(canonical){canonical.width=0;canonical.height=0;}}
      },
      undo(){alive();if(!cursor)return false;cursor--;cached=null;preview.clear();return true;},redo(){alive();if(cursor>=history.length)return false;cursor++;cached=null;preview.clear();return true;},
      reset(){alive();return scene().original?false:commit({kind:'reset'});},
      async toBlob(renderOptions={}){alive();const output=canvas(scene().width,scene().height,language);try{render(output,{...renderOptions,preview:false});return await png(output);}finally{output.width=0;output.height=0;}},
      async exportProject(){
        alive();const state=scene(),objects=clone(state.objects),document={version:1,width:state.width,height:state.height,objects},used=new Set();for(const object of objects)if(object.kind==='image'){used.add(object.data.assetId);if(object.data.eraseAssetId)used.add(object.data.eraseAssetId);}
        const assets=[...used].map(id=>({id,blob:assetMap.get(id).blob})),base=canvas(state.width,state.height,language),clean=state.base===state.clean?null:canvas(state.width,state.height,language);
        try{render(base,{annotations:false,baseOnly:true});if(clean)render(clean,{annotations:false});const [baseBlob,cleanPNG]=await Promise.all([png(base),clean?png(clean):Promise.resolve(null)]),cleanBlob=cleanPNG||baseBlob;if(!validateProject(document,assets))throw Error('편집 요소를 저장 형식으로 만들지 못했습니다.');return {document,baseBlob,cleanBlob,assets};}finally{base.width=0;base.height=0;if(clean){clean.width=0;clean.height=0;}}
      },
      destroy(){if(destroyed)return;destroyed=true;history.length=0;cursor=0;cached=null;initialObjects=[];preview.clear();for(const source of sources.values())release(source.image);for(const asset of assetMap.values())release(asset.image);assetMap.clear();}
    };
    return Object.freeze(engine);
  }
  window.CaptureImage=Object.freeze({create,validateProject});
})();
