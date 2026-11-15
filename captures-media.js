(function(){
  'use strict';
  const scriptURL=document.currentScript&&document.currentScript.src||document.baseURI;
  const assetsURL=new URL('vendor/pdfjs/',scriptURL);
  let pdfPromise=null,manifestPromise=null;
  const chunks=new Map();
  const clampZoom=value=>Math.max(.25,Math.min(6,Number(value)||1));
  const angle=value=>((Math.round((Number(value)||0)/90)*90)%360+360)%360;
  function node(tag,className,text){
    const el=document.createElement(tag);
    if(className) el.className=className;
    if(text!==undefined) el.textContent=text;
    return el;
  }
  async function readJSON(name){
    const response=await fetch(new URL(name,assetsURL));
    if(!response.ok) throw Error('PDF 자료를 불러오지 못했습니다.');
    return response.json();
  }
  class PackedBinaryDataFactory{
    async fetch({kind,filename}){
      if(!manifestPromise) manifestPromise=readJSON('font-assets.json').catch(error=>{manifestPromise=null;throw error;});
      const manifest=await manifestPromise,key=kind+':'+filename,part=manifest.files[key];
      if(!part) throw Error('PDF 글꼴 자료가 없습니다: '+filename);
      if(!chunks.has(part)) chunks.set(part,readJSON(part).catch(error=>{chunks.delete(part);throw error;}));
      const data=(await chunks.get(part))[key];
      if(typeof data!=='string') throw Error('PDF 글꼴 자료를 읽지 못했습니다.');
      const raw=atob(data),bytes=new Uint8Array(raw.length);
      for(let i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
      return bytes;
    }
  }
  async function pdfLibrary(){
    if(!pdfPromise){
      pdfPromise=import(new URL('pdf.min.mjs',assetsURL).href).then(pdf=>{
        pdf.GlobalWorkerOptions.workerSrc=new URL('pdf.worker.min.mjs',assetsURL).href;
        return pdf;
      }).catch(error=>{pdfPromise=null;throw error;});
    }
    return pdfPromise;
  }
  async function mount(container,item,blob,options={}){
    if(!container||typeof container.appendChild!=='function') throw Error('자료를 표시할 영역이 없습니다.');
    let destroyed=false,zoom=clampZoom(options.zoom),rotation=angle(item&&item.rotation);
    let image=null,imageWidth=0,imageHeight=0,pdf=null,loadingTask=null,observer=null,resizeObserver=null;
    let lastWidth=0,activeJobs=0,pageCount=0,errorText=null;
    const urls=new Set(),records=[],queue=[];
    const root=node('div','cn-media-surface');
    root.dataset.mediaStatus='loading';
    Object.assign(root.style,{position:'relative',maxWidth:'none',boxSizing:'border-box',margin:'0 auto',width:'100%'});
    container.replaceChildren(root);
    if(options.thumbnail) Object.assign(root.style,{maxHeight:'180px',overflow:'hidden'});
    const status=node('div','cn-media-status','자료를 여는 중…');
    Object.assign(status.style,{padding:'24px 12px',textAlign:'center',fontSize:'13px',color:'var(--muted,#727781)'});
    root.appendChild(status);
    function objectURL(){
      const url=URL.createObjectURL(blob);urls.add(url);return url;
    }
    function width(){
      return Math.max(1,container.clientWidth||container.parentElement?.clientWidth||window.innerWidth-48)*zoom;
    }
    function fail(error){
      if(destroyed) return;
      errorText=error&&error.name==='PasswordException'
        ?'암호가 걸린 PDF예요. 암호를 해제한 파일을 다시 등록해 주세요.'
        :item&&item.kind==='pdf'?'이 PDF를 표시하지 못했어요. 원본 파일을 확인해 주세요.':'이 이미지를 표시하지 못했어요. 원본 파일을 확인해 주세요.';
      root.dataset.mediaStatus='error';
      const message=node('div','cn-media-error',errorText);
      Object.assign(message.style,{padding:'20px 12px',fontSize:'14px',lineHeight:'1.6',textAlign:'center',color:'var(--text-main,#23262b)'});
      if(blob instanceof Blob){
        const link=node('a','cn-media-download',item&&item.editedFileId?'편집본 내려받기':'원본 내려받기');
        link.href=objectURL();link.download=item&&item.editedFileId?(item.fileName||item.title||'자료').replace(/\.[^.]+$/,'')+'-편집.png':item&&item.fileName||item&&item.title||'자료';
        link.style.display='block';link.style.marginTop='10px';link.style.color='var(--link,#41638c)';
        link.addEventListener('click',event=>event.stopPropagation());
        message.appendChild(link);
      }
      root.replaceChildren(message);
    }
    function release(record){
      record.version++;
      record.renderedKey='';
      record.again=false;
      if(record.task){try{record.task.cancel();}catch(e){}}
      record.canvas.width=1;record.canvas.height=1;record.canvas.style.display='none';
      record.canvas.dataset.rendered='false';
      record.placeholder.style.display='flex';
      record.placeholder.textContent='화면에 오면 페이지를 표시해요';
      if(record.page&&!record.running){try{record.page.cleanup();}catch(e){}}
    }
    function layoutRecord(record){
      const base=record.page?record.page.getViewport({scale:1,rotation:angle((record.page.rotate||0)+rotation)}):null;
      const ratio=base?base.height/base.width:(angle(rotation-record.baseRotation)%180===90?1/record.ratio:record.ratio);
      record.box.style.width='100%';record.box.style.height=(width()*ratio)+'px';
      record.desiredKey=[Math.round(width()),rotation,Math.min(window.devicePixelRatio||1,2)].join(':');
    }
    async function renderRecord(record){
      const version=record.version;
      if(destroyed||!record.visible||!root.isConnected) return;
      try{
        const page=record.page||await pdf.getPage(record.number);
        if(destroyed||!record.visible||version!==record.version) return;
        record.page=page;layoutRecord(record);
        const key=record.desiredKey;
        if(record.renderedKey===key) return;
        const base=page.getViewport({scale:1,rotation:angle((page.rotate||0)+rotation)});
        const cssWidth=width(),cssHeight=cssWidth*base.height/base.width;
        const density=Math.min(window.devicePixelRatio||1,2,Math.sqrt(6000000/Math.max(1,cssWidth*cssHeight)));
        const viewport=page.getViewport({scale:cssWidth/base.width*density,rotation:angle((page.rotate||0)+rotation)});
        record.canvas.width=Math.max(1,Math.floor(viewport.width));
        record.canvas.height=Math.max(1,Math.floor(viewport.height));
        Object.assign(record.canvas.style,{display:'block',width:'100%',height:'100%'});
        record.placeholder.textContent='페이지를 표시하는 중…';
        const task=page.render({canvasContext:record.canvas.getContext('2d',{alpha:false}),viewport,background:'#ffffff'});
        record.task=task;
        await task.promise;
        if(destroyed||!record.visible||version!==record.version) return;
        record.renderedKey=key;record.canvas.dataset.rendered='true';record.placeholder.style.display='none';
        root.dataset.mediaStatus='ready';
      }catch(error){
        if(destroyed||error&&error.name==='RenderingCancelledException'||version!==record.version) return;
        record.canvas.style.display='none';
        record.placeholder.textContent='이 페이지를 표시하지 못했어요. 원본 파일을 확인해 주세요.';
      }finally{
        record.task=null;
        // release() cannot clean a page while its render is still running.
        // Complete that cleanup once a scrolled-away render has settled.
        if(!record.visible&&record.page){try{record.page.cleanup();}catch(e){}}
      }
    }
    function pump(){
      if(destroyed) return;
      while(activeJobs<2&&queue.length){
        const record=queue.shift();record.queued=false;
        if(!record.visible) continue;
        activeJobs++;record.running=true;
        renderRecord(record).finally(()=>{
          activeJobs--;record.running=false;
          if(record.again&&record.visible){record.again=false;schedule(record);}
          pump();
        });
      }
    }
    function schedule(record){
      if(destroyed||!record.visible||record.renderedKey===record.desiredKey) return;
      if(record.running){record.again=true;return;}
      if(!record.queued){record.queued=true;queue.push(record);}
      pump();
    }
    function layout(){
      if(destroyed) return;
      const currentWidth=width();lastWidth=currentWidth;
      root.style.width=currentWidth+'px';
      if(image&&imageWidth&&imageHeight){
        const sideways=rotation===90||rotation===270;
        const scale=currentWidth/(sideways?imageHeight:imageWidth);
        root.style.height=((sideways?imageWidth:imageHeight)*scale)+'px';
        Object.assign(image.style,{position:'absolute',left:'50%',top:'50%',width:imageWidth*scale+'px',height:imageHeight*scale+'px',maxWidth:'none',maxHeight:'none',transform:'translate(-50%,-50%) rotate('+rotation+'deg)'});
      }
      for(const record of records){
        const oldKey=record.desiredKey;layoutRecord(record);
        if(oldKey!==record.desiredKey){record.version++;if(record.task){try{record.task.cancel();}catch(e){}}}
        schedule(record);
      }
    }
    const handle={
      destroy(){
        if(destroyed) return;destroyed=true;
        if(observer) observer.disconnect();if(resizeObserver) resizeObserver.disconnect();
        window.removeEventListener('resize',onResize);
        queue.length=0;
        for(const record of records){release(record);record.box.remove();}
        if(loadingTask) Promise.resolve(loadingTask.destroy()).catch(()=>{});
        for(const url of urls) URL.revokeObjectURL(url);urls.clear();
        root.remove();
      },
      setZoom(value){if(destroyed) return;zoom=clampZoom(value);layout();},
      rotate(value){if(destroyed) return;rotation=angle(value);layout();},
      get pageCount(){return pageCount;},
      get error(){return errorText;}
    };
    function onResize(){if(Math.abs(width()-lastWidth)>.5) layout();}
    if(typeof ResizeObserver!=='undefined'){
      resizeObserver=new ResizeObserver(onResize);resizeObserver.observe(container);
    }else window.addEventListener('resize',onResize);
    try{
      if(!(blob instanceof Blob)||!blob.size) throw Error('빈 파일입니다.');
      if(item&&item.kind==='pdf'){
        const library=await pdfLibrary();
        if(destroyed||!root.isConnected){handle.destroy();return handle;}
        loadingTask=library.getDocument({data:new Uint8Array(await blob.arrayBuffer()),
          BinaryDataFactory:PackedBinaryDataFactory,cMapUrl:assetsURL.href,cMapPacked:true,
          standardFontDataUrl:assetsURL.href,wasmUrl:assetsURL.href,useWorkerFetch:false,useWasm:false,
          disableWorkerRendering:true,isOffscreenCanvasSupported:false,isImageDecoderSupported:false,
          enableXfa:false,verbosity:0});
        pdf=await loadingTask.promise;
        if(destroyed||!root.isConnected){handle.destroy();return handle;}
        pageCount=pdf.numPages;root.dataset.pageCount=String(pageCount);
        const first=await pdf.getPage(1),base=first.getViewport({scale:1,rotation:angle((first.rotate||0)+rotation)});
        status.remove();
        const fragment=document.createDocumentFragment(),count=options.thumbnail?1:pageCount;
        for(let number=1;number<=count;number++){
          const figure=node('figure','cn-pdf-page');
          Object.assign(figure.style,{margin:'0 0 12px',padding:'0',width:'100%'});
          const label=node('figcaption','cn-pdf-page-label',number+' / '+pageCount+'쪽');
          Object.assign(label.style,{fontSize:'11px',lineHeight:'1.5',padding:'4px 0',color:'var(--muted,#727781)',textAlign:'center'});
          const box=node('div','cn-pdf-page-box');
          Object.assign(box.style,{position:'relative',background:'#fff',overflow:'hidden',boxShadow:'0 1px 4px rgba(0,0,0,.1)'});
          const canvas=node('canvas','cn-pdf-canvas');canvas.width=1;canvas.height=1;canvas.style.display='none';
          canvas.setAttribute('role','img');canvas.setAttribute('aria-label',(item.title||item.fileName||'PDF')+' '+number+'쪽');
          const placeholder=node('div','cn-pdf-placeholder','화면에 오면 페이지를 표시해요');
          Object.assign(placeholder.style,{position:'absolute',inset:'0',display:'flex',alignItems:'center',justifyContent:'center',padding:'12px',fontSize:'12px',color:'#727781',textAlign:'center'});
          box.append(canvas,placeholder);figure.append(box,label);fragment.appendChild(figure);
          records.push({number,figure,box,canvas,placeholder,page:number===1?first:null,ratio:base.height/base.width,baseRotation:rotation,
            version:0,visible:!!options.thumbnail||typeof IntersectionObserver==='undefined',queued:false,running:false,again:false,renderedKey:'',desiredKey:'',task:null});
        }
        root.appendChild(fragment);layout();
        if(!options.thumbnail&&typeof IntersectionObserver!=='undefined'){
          const byNode=new Map(records.map(record=>[record.box,record]));
          observer=new IntersectionObserver(entries=>{
            for(const entry of entries){
              const record=byNode.get(entry.target);if(!record) continue;
              record.visible=entry.isIntersecting;
              if(record.visible) schedule(record);else release(record);
            }
          },{rootMargin:'1000px 0px'});
          for(const record of records) observer.observe(record.box);
        }
      }else{
        const url=objectURL();image=node('img','cn-capture-image');
        image.alt=item&&item.title||item&&item.fileName||'학습 캡처';image.decoding='async';
        await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('이미지를 읽지 못했습니다.'));image.src=url;});
        if(destroyed||!root.isConnected){handle.destroy();return handle;}
        imageWidth=image.naturalWidth;imageHeight=image.naturalHeight;pageCount=1;
        if(!imageWidth||!imageHeight) throw Error('이미지를 읽지 못했습니다.');
        root.replaceChildren(image);root.dataset.mediaStatus='ready';root.dataset.pageCount='1';layout();
      }
    }catch(error){fail(error);}
    return handle;
  }
  window.CaptureMedia=Object.freeze({mount});
})();
