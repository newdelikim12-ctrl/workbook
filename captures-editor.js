/* Local photo editor. The image draft is written only by the explicit Save action. */
(function(){
'use strict';
let dialog=null,current=null,serial=0;
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
function button(text,action,cls='cne-button'){const b=node('button',cls,text);b.type='button';b.dataset.cneAction=action;return b;}
function hasOpenDialog(){return !!dialog?.open;}
function friendly(err){if(/quota/i.test(err?.name||'')||/quota/i.test(err?.message||''))return '저장 공간이 부족해요. 편집 내용은 그대로 있으니 자료를 백업·정리한 뒤 다시 저장해 주세요.';return /[가-힣]/.test(err?.message||'')?err.message:'처리하지 못했어요. 편집 내용은 유지되니 다시 시도해 주세요.';}
function error(s,text){if(current!==s)return;s.ui.error.textContent=text||'';s.ui.error.hidden=!text;}
function ready(s){return current===s&&!s.closed&&!!s.engine&&!s.loading&&!s.saving;}
function changed(s){return !!s.engine?.canUndo;}
function mount(){
 if(dialog)return;const root=document.getElementById('captureView');if(!root)throw Error('사진 편집 화면을 열지 못했어요.');
 dialog=node('dialog','cne-dialog');dialog.id='cneDialog';dialog.setAttribute('aria-labelledby','cneTitle');root.append(dialog);
}
function createUI(s){
 dialog.replaceChildren();const ui=s.ui={};
 const header=node('header','cne-header');const heading=node('div','cne-heading');const title=node('h3','cne-title',s.item.title||s.item.fileName||'사진 편집');title.id='cneTitle';heading.append(node('span','cne-eyebrow','사진 편집'),title);
 const mainActions=node('div','cne-main-actions');ui.cancel=button('취소','cancel','cne-button cne-quiet');ui.save=button('저장','save','cne-button cne-primary');mainActions.append(ui.cancel,ui.save);header.append(heading,mainActions);
 const controls=node('div','cne-controls');const tools=node('div','cne-tools');tools.setAttribute('role','group');tools.setAttribute('aria-label','사진 편집 도구');
 for(const [value,label,symbol]of [['pan','이동','✥'],['crop','자르기','⌗'],['line','밑줄','—'],['draw','펜','〰'],['text','글자','T']]){const b=node('button','cne-tool');b.type='button';b.dataset.cneTool=value;b.setAttribute('aria-pressed',String(value==='pan'));b.append(node('span','cne-tool-icon',symbol),node('span','',label));tools.append(b);}
 const actions=node('div','cne-actions');const history=node('div','cne-history');ui.undo=button('↶ 취소','undo','cne-button cne-compact');ui.undo.title='이전 편집 취소 (Ctrl/⌘+Z)';ui.redo=button('↷ 다시','redo','cne-button cne-compact');ui.redo.title='편집 다시 실행';ui.rotate=button('↻ 회전','rotate','cne-button cne-compact');ui.reset=button('원본으로','reset','cne-button cne-compact');ui.reset.title='처음 등록한 원본으로 되돌리기 (실행 취소 가능)';history.append(ui.undo,ui.redo,ui.rotate,ui.reset);
 const zoom=node('div','cne-zoom');ui.zoomOut=button('−','zoom-out','cne-button cne-icon');ui.zoomOut.setAttribute('aria-label','사진 축소');ui.zoomLevel=node('span','cne-zoom-label','100%');ui.zoomLevel.id='cneZoomLabel';ui.zoomLevel.setAttribute('aria-live','polite');ui.zoomIn=button('＋','zoom-in','cne-button cne-icon');ui.zoomIn.setAttribute('aria-label','사진 확대');ui.fit=button('맞춤','fit','cne-button cne-compact');zoom.append(ui.zoomOut,ui.zoomLevel,ui.zoomIn,ui.fit);actions.append(history,zoom);
 ui.options=node('div','cne-options');ui.colorWrap=node('label','cne-option');ui.colorWrap.append(node('span','','색상'));ui.color=node('input');ui.color.id='cneColor';ui.color.type='color';ui.color.value='#e53935';ui.color.setAttribute('aria-label','선과 글자 색상');ui.colorWrap.append(ui.color);
 ui.widthWrap=node('label','cne-option');ui.widthWrap.append(node('span','','굵기'));ui.width=node('select');ui.width.id='cneWidth';ui.width.setAttribute('aria-label','선 굵기');ui.widthWrap.append(ui.width);
 ui.lockWrap=node('label','cne-lock');ui.lineLock=node('input');ui.lineLock.type='checkbox';ui.lineLock.id='cneLineLock';ui.lineLock.checked=true;ui.lockWrap.append(ui.lineLock,node('span','','수평 밑줄'));
 ui.textSizeWrap=node('label','cne-option');ui.textSizeWrap.append(node('span','','글자 크기'));ui.textSize=node('select');ui.textSize.id='cneTextSize';ui.textSize.setAttribute('aria-label','글자 크기');ui.textSizeWrap.append(ui.textSize);ui.options.append(ui.colorWrap,ui.widthWrap,ui.lockWrap,ui.textSizeWrap);
 ui.cropPanel=node('div','cne-crop-panel');ui.cropHint=node('span','cne-panel-hint','사진 위에서 남길 영역을 드래그하세요.');ui.cropApply=button('자르기 적용','crop-apply','cne-button cne-primary cne-compact');ui.cropCancel=button('선택 취소','crop-cancel','cne-button cne-compact');ui.cropPanel.append(ui.cropHint,ui.cropApply,ui.cropCancel);
 ui.textPanel=node('div','cne-text-panel');ui.text=node('textarea');ui.text.id='cneText';ui.text.rows=2;ui.text.placeholder='사진에 넣을 글자 (Enter로 줄바꿈)';ui.text.setAttribute('aria-label','사진에 넣을 글자');ui.text.enterKeyHint='enter';const textActions=node('div','cne-text-actions');ui.textHint=node('span','cne-panel-hint','사진에서 글자를 넣을 위치를 눌러 주세요.');ui.textApply=button('글자 넣기','text-apply','cne-button cne-primary cne-compact');ui.textCancel=button('입력 취소','text-cancel','cne-button cne-compact');textActions.append(ui.textHint,ui.textApply,ui.textCancel);ui.textPanel.append(ui.text,textActions);
 controls.append(tools,actions,ui.options,ui.cropPanel,ui.textPanel);
 ui.viewport=node('div','cne-viewport');ui.viewport.id='cneViewport';ui.viewport.tabIndex=0;ui.viewport.setAttribute('aria-label','사진 편집 영역. 이동 도구에서 끌거나 확대해 볼 수 있어요.');ui.plane=node('div','cne-plane');ui.stage=node('div','cne-stage');ui.canvas=node('canvas','cne-canvas');ui.canvas.id='cneCanvas';ui.canvas.setAttribute('aria-label','편집 중인 사진');ui.overlay=node('canvas','cne-overlay');ui.overlay.id='cneOverlay';ui.overlay.setAttribute('aria-label','사진 편집 입력 영역');ui.stage.append(ui.canvas,ui.overlay);ui.plane.append(ui.stage);ui.viewport.append(ui.plane);
 const footer=node('footer','cne-footer');ui.hint=node('span','cne-hint','사진을 준비하는 중…');ui.dimensions=node('span','cne-dimensions');footer.append(ui.hint,ui.dimensions);ui.error=node('p','cne-error');ui.error.id='cneError';ui.error.hidden=true;ui.error.setAttribute('role','alert');
 dialog.append(header,controls,ui.error,ui.viewport,footer);
}
function update(s){
 if(current!==s)return;const ui=s.ui,enabled=ready(s);dialog.dataset.state=s.saving?'saving':s.loading?'loading':s.engine?'ready':'error';dialog.setAttribute('aria-busy',String(s.loading||s.saving));
 for(const b of dialog.querySelectorAll('button,input,select,textarea'))b.disabled=!enabled;
 ui.cancel.disabled=s.saving;ui.save.disabled=!enabled||!changed(s)||!!s.gesture;ui.undo.disabled=!enabled||!s.engine.canUndo;ui.redo.disabled=!enabled||!s.engine.canRedo;ui.reset.disabled=!enabled||s.engine.isOriginal;
 ui.zoomOut.disabled=!enabled||s.zoom<=.25;ui.zoomIn.disabled=!enabled||s.zoom>=8;
 for(const b of dialog.querySelectorAll('[data-cne-tool]'))b.setAttribute('aria-pressed',String(b.dataset.cneTool===s.tool));
 ui.options.hidden=!['line','draw','text'].includes(s.tool);ui.widthWrap.hidden=!['line','draw'].includes(s.tool);ui.lockWrap.hidden=s.tool!=='line';ui.textSizeWrap.hidden=s.tool!=='text';ui.cropPanel.hidden=s.tool!=='crop';ui.textPanel.hidden=s.tool!=='text';ui.cropApply.disabled=!enabled||!s.crop;ui.cropCancel.disabled=!enabled||!s.crop;ui.textApply.disabled=!enabled||!s.textAnchor||!ui.text.value.trim();
 ui.zoomLevel.textContent=Math.round(s.zoom*100)+'%';ui.overlay.style.touchAction=s.tool==='pan'?'pan-x pan-y pinch-zoom':'none';ui.overlay.style.cursor=s.tool==='pan'?(s.gesture?'grabbing':'grab'):s.tool==='text'?'text':'crosshair';
 if(enabled){const hints={pan:'이동 도구로 끌어서 보세요. 원본은 별도로 유지됩니다.',crop:'남길 영역을 선택한 뒤 자르기 적용을 누르세요.',line:ui.lineLock.checked?'수평으로 그어 밑줄을 넣으세요.':'시작점에서 끝점까지 곧은 선을 그으세요.',draw:'사진 위에 자유롭게 그려 보세요.',text:'사진에서 위치를 선택하고 글자를 입력하세요.'};ui.hint.textContent=hints[s.tool];ui.dimensions.textContent=s.engine.width+' × '+s.engine.height+(s.engine.scaled?' · 편집 크기 조정됨':'');}
}
function selectOptions(select,values,selected){select.replaceChildren();for(const [value,label]of values){const opt=node('option','',label);opt.value=String(value);select.append(opt);}select.value=String(selected);}
function configureSizes(s){const width=s.engine.width;const line=[Math.max(1,Math.round(width/500)),Math.max(2,Math.round(width/250)),Math.max(3,Math.round(width/125)),Math.max(5,Math.round(width/70))];selectOptions(s.ui.width,line.map((v,i)=>[v,['얇게','보통','굵게','아주 굵게'][i]]),line[1]);const sizes=[Math.max(8,Math.round(width/35)),Math.max(12,Math.round(width/22)),Math.max(16,Math.round(width/14)),Math.max(20,Math.round(width/10))];selectOptions(s.ui.textSize,sizes.map((v,i)=>[v,['작게','보통','크게','아주 크게'][i]]),sizes[1]);}
function layout(s,reset=false){
 if(current!==s||!s.engine||!s.ui.viewport.clientWidth)return;const ui=s.ui,v=ui.viewport,style=getComputedStyle(v),padX=parseFloat(style.paddingLeft)+parseFloat(style.paddingRight),padY=parseFloat(style.paddingTop)+parseFloat(style.paddingBottom);const availableWidth=Math.max(1,v.clientWidth-padX-2),availableHeight=Math.max(1,v.clientHeight-padY-2);
 const oldX=(v.scrollLeft+v.clientWidth/2)/Math.max(1,v.scrollWidth),oldY=(v.scrollTop+v.clientHeight/2)/Math.max(1,v.scrollHeight);
 if(reset)s.zoom=1;s.fitScale=Math.min(availableWidth/s.engine.width,availableHeight/s.engine.height);s.scale=s.fitScale*s.zoom;const width=s.engine.width*s.scale,height=s.engine.height*s.scale;
 ui.stage.style.width=width+'px';ui.stage.style.height=height+'px';ui.plane.style.width=Math.max(availableWidth,width)+'px';ui.plane.style.height=Math.max(availableHeight,height)+'px';
 if(reset){v.scrollLeft=0;v.scrollTop=0;}else{v.scrollLeft=Math.max(0,v.scrollWidth*oldX-v.clientWidth/2);v.scrollTop=Math.max(0,v.scrollHeight*oldY-v.clientHeight/2);}preview(s);update(s);
}
function clearGesture(s){const id=s.gesture?.id;s.gesture=null;try{if(id!==undefined&&s.ui.overlay.hasPointerCapture(id))s.ui.overlay.releasePointerCapture(id);}catch(e){}}
function clearDraft(s){clearGesture(s);s.crop=null;s.textAnchor=null;}
function draw(s,reset=false){if(current!==s||!s.engine)return;s.engine.render(s.ui.canvas);s.ui.overlay.width=s.engine.width;s.ui.overlay.height=s.engine.height;layout(s,reset);}
function textDraft(s){const size=Number(s.ui.textSize.value)||24,lines=s.ui.text.value.replace(/\r\n?/g,'\n').split('\n'),ctx=s.ui.overlay.getContext('2d');ctx.font=size+'px sans-serif';const width=Math.max(0,...lines.map(line=>ctx.measureText(line).width)),height=lines.length*size*1.3;const anchor=s.textAnchor||{x:0,y:0};return {size,lines,text:lines.join('\n'),x:clamp(anchor.x,0,Math.max(0,s.engine.width-width)),y:clamp(anchor.y,0,Math.max(0,s.engine.height-height)),width,height};}
function preview(s){
 if(current!==s||!s.engine)return;const canvas=s.ui.overlay,ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);const g=s.gesture,pixel=1/Math.max(.001,s.scale||1);
 if(s.tool==='crop'&&(s.crop||g?.type==='crop')){const rect=g?.type==='crop'?rectFrom(g.start,g.last):s.crop;ctx.fillStyle='rgba(0,0,0,.45)';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.clearRect(rect.x,rect.y,rect.width,rect.height);ctx.strokeStyle='#ffffff';ctx.lineWidth=2*pixel;ctx.setLineDash([7*pixel,4*pixel]);ctx.strokeRect(rect.x,rect.y,rect.width,rect.height);ctx.setLineDash([]);ctx.fillStyle='#ffffff';for(const [x,y]of[[rect.x,rect.y],[rect.x+rect.width,rect.y],[rect.x,rect.y+rect.height],[rect.x+rect.width,rect.y+rect.height]])ctx.fillRect(x-3*pixel,y-3*pixel,6*pixel,6*pixel);s.ui.cropHint.textContent=Math.round(rect.width)+' × '+Math.round(rect.height)+' · 영역을 다시 드래그해 바꿀 수 있어요.';}
 if(g?.type==='line'){ctx.strokeStyle=g.color;ctx.lineWidth=g.width;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(g.start.x,g.start.y);ctx.lineTo(g.last.x,g.horizontal?g.start.y:g.last.y);ctx.stroke();}
 if(g?.type==='draw'){ctx.strokeStyle=g.color;ctx.lineWidth=g.width;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();g.points.forEach((point,i)=>i?ctx.lineTo(point.x,point.y):ctx.moveTo(point.x,point.y));ctx.stroke();}
 if(s.tool==='text'&&s.textAnchor){const draft=textDraft(s);ctx.font=draft.size+'px sans-serif';ctx.textBaseline='top';ctx.fillStyle=s.ui.color.value;draft.lines.forEach((line,i)=>ctx.fillText(line,draft.x,draft.y+i*draft.size*1.3));ctx.strokeStyle='rgba(255,255,255,.9)';ctx.lineWidth=1.5*pixel;ctx.beginPath();ctx.moveTo(draft.x-5*pixel,draft.y);ctx.lineTo(draft.x+5*pixel,draft.y);ctx.moveTo(draft.x,draft.y-5*pixel);ctx.lineTo(draft.x,draft.y+5*pixel);ctx.stroke();s.ui.textHint.textContent='사진을 다시 누르면 글자 위치가 바뀝니다.';}
}
function point(s,event){const r=s.ui.overlay.getBoundingClientRect();return {x:clamp((event.clientX-r.left)/Math.max(.001,r.width)*s.engine.width,0,s.engine.width),y:clamp((event.clientY-r.top)/Math.max(.001,r.height)*s.engine.height,0,s.engine.height)};}
function rectFrom(a,b){return {x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),width:Math.abs(a.x-b.x),height:Math.abs(a.y-b.y)};}
function mutate(s,method,arg,reset=false){if(!ready(s))return false;try{const changed=s.engine[method](arg);if(changed){clearDraft(s);error(s,'');draw(s,reset);}else update(s);return !!changed;}catch(err){error(s,friendly(err));update(s);return false;}}
function tool(s,value){if(!ready(s))return;clearGesture(s);s.crop=null;if(value!=='text')s.textAnchor=null;s.tool=value;error(s,'');update(s);layout(s);}
function pointerDown(s,e){
 if(!ready(s)||s.gesture||!e.isPrimary||(e.button!==undefined&&e.button!==0))return;
 if(s.tool==='pan'&&e.pointerType==='touch')return;
 e.preventDefault();const p=point(s,e);error(s,'');
 if(s.tool==='text'){s.textAnchor=p;preview(s);update(s);s.ui.text.focus({preventScroll:true});return;}
 s.gesture={id:e.pointerId,type:s.tool,start:p,last:p,points:[p],color:s.ui.color.value,width:Number(s.ui.width.value)||2,horizontal:s.ui.lineLock.checked,clientX:e.clientX,clientY:e.clientY,scrollX:s.ui.viewport.scrollLeft,scrollY:s.ui.viewport.scrollTop};s.ui.overlay.setPointerCapture(e.pointerId);update(s);preview(s);
}
function pointerMove(s,e){const g=s.gesture;if(!g||g.id!==e.pointerId||!ready(s))return;e.preventDefault();if(g.type==='pan'){s.ui.viewport.scrollLeft=g.scrollX-(e.clientX-g.clientX);s.ui.viewport.scrollTop=g.scrollY-(e.clientY-g.clientY);return;}g.last=point(s,e);if(g.type==='draw'){const last=g.points[g.points.length-1];if(Math.hypot(g.last.x-last.x,g.last.y-last.y)>.4)g.points.push(g.last);}preview(s);}
function pointerUp(s,e){const g=s.gesture;if(!g||g.id!==e.pointerId)return;if(!ready(s)){clearGesture(s);return;}e.preventDefault();g.last=point(s,e);clearGesture(s);
 if(g.type==='crop'){const rect=rectFrom(g.start,g.last);s.crop=rect.width>=2&&rect.height>=2?rect:null;preview(s);update(s);return;}
 if(g.type==='line'){mutate(s,'line',{x1:g.start.x,y1:g.start.y,x2:g.last.x,y2:g.horizontal?g.start.y:g.last.y,color:g.color,width:g.width});}
 else if(g.type==='draw'){if(g.points.length===1)g.points.push(g.last);else if(Math.hypot(g.last.x-g.points[g.points.length-1].x,g.last.y-g.points[g.points.length-1].y)>.1)g.points.push(g.last);mutate(s,'stroke',{points:g.points,color:g.color,width:g.width});}
 preview(s);update(s);
}
async function save(s){
 if(!ready(s)||!changed(s))return;if(s.gesture)return;
 if(s.crop){error(s,'자르기 적용 또는 선택 취소를 누른 뒤 저장해 주세요.');return;}
 if(s.textAnchor&&s.ui.text.value.trim()){error(s,'입력한 글자는 ‘글자 넣기’를 누른 뒤 저장해 주세요.');s.ui.text.focus({preventScroll:true});return;}
 s.saving=true;error(s,'');update(s);
 try{const blob=s.engine.isOriginal?null:await s.engine.toBlob();if(current!==s||s.closed)return;const item=await s.onSave(blob);if(item===false||item?.ok===false)throw Error(item?.error||'저장하지 못했어요. 다시 시도해 주세요.');finish(s,{saved:true,item},true);}
 catch(err){if(current!==s||s.closed)return;s.saving=false;error(s,friendly(err));update(s);}
}
function finish(s,result,restoreFocus){
 if(current!==s||s.closed)return false;if(s.saving&&!result.saved)return false;s.closed=true;current=null;clearGesture(s);s.abort.abort();s.resize?.disconnect();try{s.engine?.destroy();}catch(e){}s.engine=null;
 document.documentElement.style.overflow=s.previousOverflow;try{if(dialog.open)dialog.close();}catch(e){}dialog.replaceChildren();
 if(restoreFocus&&s.previousFocus?.isConnected){try{s.previousFocus.focus({preventScroll:true});}catch(e){}}
 s.resolve(result);return true;
}
function close(){return current?finish(current,{saved:false},false):true;}
function listen(s,target,type,fn,extra={}){target.addEventListener(type,fn,{...extra,signal:s.abort.signal});}
function attach(s){
 const ui=s.ui;listen(s,dialog,'cancel',e=>{e.preventDefault();finish(s,{saved:false},true);});listen(s,dialog,'close',()=>{if(current===s&&!dialog.open)finish(s,{saved:false},true);});
 listen(s,dialog,'click',e=>{const t=e.target.closest('[data-cne-tool]');if(t){tool(s,t.dataset.cneTool);return;}const b=e.target.closest('[data-cne-action]');if(!b||b.disabled)return;const a=b.dataset.cneAction;
 if(a==='cancel'){finish(s,{saved:false},true);return;}if(a==='save'){save(s);return;}if(!ready(s))return;
 if(a==='rotate'){mutate(s,'rotate',undefined,true);return;}if(a==='undo'||a==='redo'){clearDraft(s);mutate(s,a);preview(s);return;}if(a==='reset'){if(mutate(s,'reset',undefined,true)){ui.text.value='';configureSizes(s);update(s);}return;}
 if(a==='zoom-in'||a==='zoom-out'){s.zoom=clamp(s.zoom*(a==='zoom-in'?1.25:.8),.25,8);layout(s);return;}if(a==='fit'){layout(s,true);return;}
 if(a==='crop-apply'&&s.crop){mutate(s,'crop',s.crop,true);return;}if(a==='crop-cancel'){s.crop=null;preview(s);update(s);return;}
 if(a==='text-cancel'){s.textAnchor=null;ui.text.value='';preview(s);update(s);return;}
 if(a==='text-apply'&&s.textAnchor&&ui.text.value.trim()){const draft=textDraft(s);if(draft.width>s.engine.width||draft.height>s.engine.height){error(s,'글자 크기를 줄이거나 줄바꿈해 이미지 안에 맞춰 주세요.');return;}if(mutate(s,'text',{x:draft.x,y:draft.y,text:draft.text,color:ui.color.value,size:draft.size})){ui.text.value='';s.textAnchor=null;preview(s);update(s);}return;}
 });
 listen(s,dialog,'keydown',e=>{e.stopPropagation();if(s.saving){if(e.key==='Escape')e.preventDefault();return;}const typing=e.target.matches?.('input,textarea,select')||e.target.isContentEditable;if(!typing&&(e.ctrlKey||e.metaKey)&&!e.altKey){const k=e.key.toLowerCase();if(k==='z'||k==='y'){e.preventDefault();if(ready(s)){clearDraft(s);mutate(s,k==='y'||e.shiftKey?'redo':'undo');}return;}}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();save(s);}});
 listen(s,ui.overlay,'pointerdown',e=>pointerDown(s,e));listen(s,ui.overlay,'pointermove',e=>pointerMove(s,e));listen(s,ui.overlay,'pointerup',e=>pointerUp(s,e));listen(s,ui.overlay,'pointercancel',()=>{clearGesture(s);preview(s);update(s);});listen(s,ui.overlay,'lostpointercapture',()=>{if(s.gesture){clearGesture(s);preview(s);update(s);}});
 for(const input of[ui.color,ui.width,ui.lineLock,ui.textSize,ui.text])listen(s,input,'input',()=>{preview(s);update(s);});
 listen(s,window,'resize',()=>layout(s));if(typeof ResizeObserver!=='undefined'){s.resize=new ResizeObserver(()=>layout(s));s.resize.observe(ui.viewport);}
}
function open(options={}){
 try{mount();}catch(err){return Promise.resolve({saved:false,error:friendly(err)});}
 if(current){dialog.focus();return Promise.resolve({saved:false});}
 return new Promise(resolve=>{
  const s=current={id:++serial,item:options.item||{},onSave:options.onSave,engine:null,loading:true,saving:false,closed:false,tool:'pan',zoom:1,scale:1,fitScale:1,crop:null,textAnchor:null,gesture:null,abort:new AbortController(),resize:null,resolve,previousFocus:document.activeElement,previousOverflow:document.documentElement.style.overflow};
  createUI(s);attach(s);update(s);document.documentElement.style.overflow='hidden';dialog.showModal();s.ui.cancel.focus();
  (async()=>{try{if(!(options.blob instanceof Blob)||!options.blob.size)throw Error('편집할 이미지를 읽지 못했어요.');if(typeof s.onSave!=='function')throw Error('저장 기능을 연결하지 못했어요. 새로고침한 뒤 다시 시도해 주세요.');if(!window.CaptureImage?.create)throw Error('사진 편집 도구를 불러오지 못했어요. 새로고침한 뒤 다시 시도해 주세요.');const config={rotation:s.item.rotation||0};if(s.item.editedFileId&&options.originalBlob instanceof Blob)config.originalBlob=options.originalBlob;const engine=await window.CaptureImage.create(options.blob,config);if(current!==s||s.closed){engine.destroy();return;}s.engine=engine;s.ui.overlay.lang=engine.language||document.documentElement.lang||'ko';s.loading=false;configureSizes(s);draw(s,true);update(s);s.ui.viewport.focus({preventScroll:true});}catch(err){if(current!==s||s.closed)return;s.loading=false;error(s,friendly(err));update(s);}})();
 });
}
window.CaptureEditor={open,close,hasOpenDialog};
})();
