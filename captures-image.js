/* Local image editor. Vector command history keeps undo/redo independent of image size. */
(function(){
  'use strict';
  const MAX_PIXELS=16000000,MAX_SIDE=8192,MAX_HISTORY=500,MAX_POINTS=4096,MAX_TEXT=2000;
  const identity=()=>[1,0,0,1,0,0];
  const finite=value=>Number.isFinite(Number(value));
  const rotation=value=>((Math.round((Number(value)||0)/90)*90)%360+360)%360;
  function multiply(a,b){
    return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
  }
  function oriented(width,height,degrees){
    if(degrees===90) return {width:height,height:width,matrix:[0,1,-1,0,height,0]};
    if(degrees===180) return {width,height,matrix:[-1,0,0,-1,width,height]};
    if(degrees===270) return {width:height,height:width,matrix:[0,-1,1,0,0,width]};
    return {width,height,matrix:identity()};
  }
  function canvas(width,height){
    const result=document.createElement('canvas');result.width=width;result.height=height;return result;
  }
  function release(image){
    if(!image) return;
    if(typeof image.close==='function'){try{image.close();}catch(error){}}
    else if(image.tagName==='CANVAS'){image.width=0;image.height=0;}
    else if(image.tagName==='IMG') image.src='';
  }
  async function decode(blob,pixelBudget){
    if(!(blob instanceof Blob)||!blob.size) throw Error('편집할 이미지 파일이 없습니다.');
    let image=null,url=null;
    try{
      if(typeof createImageBitmap==='function'){
        try{image=await createImageBitmap(blob,{imageOrientation:'from-image'});}catch(error){}
      }
      if(!image){
        image=new Image();image.decoding='async';url=URL.createObjectURL(blob);
        await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(Error('이 이미지를 읽지 못했어요. PNG나 JPG 파일을 확인해 주세요.'));image.src=url;});
      }
      const sourceWidth=image.naturalWidth||image.width,sourceHeight=image.naturalHeight||image.height;
      if(!sourceWidth||!sourceHeight) throw Error('이미지 크기를 읽지 못했습니다.');
      const scale=Math.min(1,Math.sqrt(pixelBudget/(sourceWidth*sourceHeight)),MAX_SIDE/sourceWidth,MAX_SIDE/sourceHeight);
      const width=Math.max(1,Math.floor(sourceWidth*scale)),height=Math.max(1,Math.floor(sourceHeight*scale));
      if(width!==sourceWidth||height!==sourceHeight){
        let resized=null;
        if(typeof createImageBitmap==='function'){
          try{resized=await createImageBitmap(image,{resizeWidth:width,resizeHeight:height,resizeQuality:'high'});}catch(error){}
        }
        if(!resized){resized=canvas(width,height);resized.getContext('2d').drawImage(image,0,0,width,height);}
        release(image);image=resized;
      }
      return {image,width,height,sourceWidth,sourceHeight,scaled:width!==sourceWidth||height!==sourceHeight};
    }catch(error){release(image);throw error;}
    finally{if(url) URL.revokeObjectURL(url);}
  }
  function color(value){
    const candidate=typeof value==='string'?value.trim():'';
    return candidate&&candidate.length<=128&&!/\b(?:var|url)\s*\(/iu.test(candidate)&&typeof CSS!=='undefined'&&CSS.supports('color',candidate)?candidate:'#e5484d';
  }
  async function create(blob,options={}){
    // Generic canvas fonts depend on the element language. Keep attached previews
    // and detached PNG exports on the same locale for identical text rasterization.
    const language=document.documentElement.lang||navigator.language||'ko';
    const originalBlob=options.originalBlob instanceof Blob?options.originalBlob:blob;
    const hasSeparateOriginal=originalBlob!==blob;
    const budget=hasSeparateOriginal?MAX_PIXELS/2:MAX_PIXELS;
    let currentSource=null,originalSource=null,destroyed=false;
    try{
      currentSource=await decode(blob,budget);
      originalSource=hasSeparateOriginal?await decode(originalBlob,budget):currentSource;
    }catch(error){if(currentSource) release(currentSource.image);throw error;}
    const initialRotation=rotation(options.rotation);
    const initial=oriented(currentSource.width,currentSource.height,initialRotation);
    let width=initial.width,height=initial.height,cursor=0;
    const history=[];
    function alive(){if(destroyed) throw Error('이미지 편집기가 닫혔습니다.');}
    function dimensions(){
      width=initial.width;height=initial.height;
      for(let i=0;i<cursor;i++){
        const command=history[i];
        if(command.kind==='reset'){width=originalSource.width;height=originalSource.height;}
        else if(command.kind==='crop'){width=command.width;height=command.height;}
        else if(command.kind==='rotate'){const old=width;width=height;height=old;}
      }
    }
    function commit(command){
      alive();
      if(cursor>=MAX_HISTORY) throw Error('편집 기록이 많아요. 저장한 뒤 다시 편집해 주세요.');
      history.splice(cursor);history.push({...command,beforeWidth:width,beforeHeight:height});cursor++;
      dimensions();return true;
    }
    function point(x,y){
      if(!finite(x)||!finite(y)) return null;
      const limit=Math.max(width,height)*4+1024;
      return {x:Math.max(-limit,Math.min(limit,Number(x))),y:Math.max(-limit,Math.min(limit,Number(y)))};
    }
    function pen(value){return Math.max(.5,Math.min(Math.max(width,height)/2,Number(value)||4));}
    function draw(ctx,command){
      ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;
      if(command.kind==='text'){
        ctx.fillStyle=command.color;ctx.font=command.size+'px sans-serif';ctx.textAlign='left';ctx.textBaseline='top';
        const lines=command.text.split('\n');
        for(let i=0;i<lines.length;i++) ctx.fillText(lines[i],command.x,command.y+i*command.size*1.3);
        return;
      }
      ctx.strokeStyle=command.color;ctx.fillStyle=command.color;ctx.lineWidth=command.width;ctx.lineCap='round';ctx.lineJoin='round';
      const points=command.points;
      if(points.length===2){ctx.beginPath();ctx.arc(points[0],points[1],command.width/2,0,Math.PI*2);ctx.fill();return;}
      ctx.beginPath();ctx.moveTo(points[0],points[1]);
      for(let i=2;i<points.length;i+=2) ctx.lineTo(points[i],points[i+1]);
      ctx.stroke();
    }
    function render(target){
      alive();
      if(!target||typeof target.getContext!=='function') throw Error('이미지를 표시할 캔버스가 없습니다.');
      target.lang=language;target.width=width;target.height=height;
      const ctx=target.getContext('2d',{alpha:true});
      if(!ctx) throw Error('이미지 편집 기능을 시작하지 못했습니다.');
      let reset=-1;
      for(let i=cursor-1;i>=0;i--) if(history[i].kind==='reset'){reset=i;break;}
      // Crops only shrink the viewport; quarter-turns reorient it. The final
      // canvas clips every earlier crop while each mark gets its later transforms.
      let transform=identity();const drawing=[];
      for(let i=cursor-1;i>reset;i--){
        const command=history[i];
        if(command.kind==='crop') transform=multiply(transform,[1,0,0,1,-command.x,-command.y]);
        else if(command.kind==='rotate') transform=multiply(transform,[0,1,-1,0,command.beforeHeight,0]);
        else drawing.push({command,transform:transform.slice()});
      }
      const source=reset>=0?originalSource:currentSource;
      const sourceTransform=reset>=0?identity():initial.matrix;
      ctx.setTransform(...multiply(transform,sourceTransform));
      ctx.drawImage(source.image,0,0,source.width,source.height);
      for(let i=drawing.length-1;i>=0;i--){
        ctx.save();ctx.setTransform(...drawing[i].transform);draw(ctx,drawing[i].command);ctx.restore();
      }
      ctx.setTransform(1,0,0,1,0,0);
      return target;
    }
    const engine={
      get width(){return width;},get height(){return height;},
      get language(){return language;},
      get canUndo(){return !destroyed&&cursor>0;},get canRedo(){return !destroyed&&cursor<history.length;},
      get isOriginal(){return !destroyed&&(cursor>0?history[cursor-1].kind==='reset':currentSource===originalSource&&initialRotation===0);},
      get scaled(){return currentSource.scaled||originalSource.scaled;},
      get sourceWidth(){return currentSource.sourceWidth;},get sourceHeight(){return currentSource.sourceHeight;},
      get originalWidth(){return originalSource.sourceWidth;},get originalHeight(){return originalSource.sourceHeight;},
      get historyLimit(){return MAX_HISTORY;},get maxTextLength(){return MAX_TEXT;},
      render,
      rotate(){alive();return commit({kind:'rotate'});},
      crop(rect={}){
        alive();if(![rect.x,rect.y,rect.width,rect.height].every(finite)) return false;
        if(Number(rect.width)===0||Number(rect.height)===0) return false;
        const x1=Number(rect.x),x2=x1+Number(rect.width),y1=Number(rect.y),y2=y1+Number(rect.height);
        const left=Math.max(0,Math.floor(Math.min(x1,x2))),top=Math.max(0,Math.floor(Math.min(y1,y2)));
        const right=Math.min(width,Math.ceil(Math.max(x1,x2))),bottom=Math.min(height,Math.ceil(Math.max(y1,y2)));
        if(right<=left||bottom<=top||left===0&&top===0&&right===width&&bottom===height) return false;
        return commit({kind:'crop',x:left,y:top,width:right-left,height:bottom-top});
      },
      line(args={}){
        alive();const from=point(args.x1,args.y1),to=point(args.x2,args.y2);if(!from||!to) return false;
        return commit({kind:'stroke',points:new Float32Array([from.x,from.y,to.x,to.y]),color:color(args.color),width:pen(args.width)});
      },
      stroke(args={}){
        alive();if(!Array.isArray(args.points)||!args.points.length) return false;
        const valid=args.points.map(value=>value&&point(value.x,value.y)).filter(Boolean);if(!valid.length) return false;
        const count=Math.min(valid.length,MAX_POINTS),points=new Float32Array(count*2);
        for(let i=0;i<count;i++){
          const value=valid[count===1?0:Math.round(i*(valid.length-1)/(count-1))];points[i*2]=value.x;points[i*2+1]=value.y;
        }
        return commit({kind:'stroke',points,color:color(args.color),width:pen(args.width)});
      },
      text(args={}){
        alive();const position=point(args.x,args.y),value=String(args.text??'').replace(/\r\n?/g,'\n');
        if(!position||!value.trim()) return false;
        if(value.length>MAX_TEXT) throw Error('글자가 너무 많아요. 2,000자 이하로 나누어 넣어 주세요.');
        return commit({kind:'text',x:position.x,y:position.y,text:value,color:color(args.color),size:Math.max(1,Math.min(Math.max(width,height)*2,Number(args.size)||32))});
      },
      undo(){alive();if(!cursor) return false;cursor--;dimensions();return true;},
      redo(){alive();if(cursor>=history.length) return false;cursor++;dimensions();return true;},
      reset(){
        alive();if(cursor&&history[cursor-1].kind==='reset'||!cursor&&currentSource===originalSource&&initialRotation===0) return false;
        return commit({kind:'reset'});
      },
      async toBlob(){
        alive();const output=canvas(width,height);
        try{
          render(output);
          return await new Promise((resolve,reject)=>{
            try{output.toBlob(blob=>blob?resolve(blob):reject(Error('편집한 이미지를 저장 파일로 만들지 못했습니다.')),'image/png');}
            catch(error){reject(error);}
          });
        }finally{output.width=0;output.height=0;}
      },
      destroy(){
        if(destroyed) return;destroyed=true;history.length=0;cursor=0;
        release(currentSource.image);if(originalSource!==currentSource) release(originalSource.image);
      }
    };
    return Object.freeze(engine);
  }
  window.CaptureImage=Object.freeze({create});
})();
