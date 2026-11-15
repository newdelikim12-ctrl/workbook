/* Deleted wrong-notebook words are durable records, independent of mastery state. */
(function(){
'use strict';
const PAGE_SIZE=80;
let root=null,ui=null,shown=PAGE_SIZE,busy=false,lastEntries=[],detailOpen=new Set();
const make=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
function button(label,action,id,cls='war-button'){const b=make('button',cls,label);b.type='button';b.dataset.warAction=action;if(id)b.dataset.warId=id;return b;}
function archiveIcon(){const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');for(const [name,value]of Object.entries({class:'ic war-heading-icon',viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'2','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'}))svg.setAttribute(name,value);for(const d of['M3 3h18v4H3z','M5 7v14h14V7','M10 11h4']){const path=document.createElementNS(ns,'path');path.setAttribute('d',d);svg.append(path);}return svg;}
function message(text,error=false){if(!ui)return;ui.status.textContent=text||'';ui.status.classList.toggle('war-error',error);}
function plain(value){return typeof value==='string'?value:'';}
function examples(word){const a=Array.isArray(word.example)?word.example:word.example?[word.example]:[];return a.filter(v=>typeof v==='string'&&v.trim());}
function notes(word){const a=Array.isArray(word.note)?word.note:word.note?[word.note]:[];return a.map(v=>typeof v==='string'?{eng:'',kor:v}:v&&typeof v==='object'?{eng:plain(v.eng),kor:plain(v.kor)}:{eng:'',kor:''}).filter(v=>v.eng||v.kor);}
function dateLabel(value){const d=new Date(value);return Number.isNaN(d.getTime())?'날짜 정보 없음':d.toLocaleDateString('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit'});}
function canChange(){
 if(busy)return false;
 if((typeof anyDialogOpen==='function'&&anyDialogOpen())||(typeof editIndex!=='undefined'&&editIndex>=0)||(typeof lsEditIndex!=='undefined'&&lsEditIndex>=0)){
  message('열려 있는 수정창이나 입력 내용을 저장·취소한 뒤 다시 시도해 주세요.',true);return false;
 }
 return true;
}
function mount(){
 root=document.getElementById('wrongArchivePanel');if(!root)return false;if(ui)return true;
 root.classList.add('war-panel');
 const heading=make('h3','war-heading');const toggleButton=button('','toggle',null,'war-toggle');toggleButton.setAttribute('aria-controls','wrongArchiveBox');toggleButton.setAttribute('aria-expanded','false');const label=make('span','war-heading-label'),title=make('span','war-heading-title','오답노트 보관함');ui={count:make('b','cnt war-count','(0)')};label.append(archiveIcon(),document.createTextNode(' '),title,document.createTextNode(' '),ui.count);const arrow=make('span','war-chevron','▾');arrow.setAttribute('aria-hidden','true');toggleButton.append(label,arrow);heading.append(toggleButton);
 const content=make('div','section-content war-content');content.id='wrongArchiveBox';const description=make('p','war-description','오답노트에서 지운 단어입니다. 학습완료와 별개로 보관하며, 복구하거나 여기서 완전히 삭제할 수 있습니다.');
 const tools=make('div','war-tools');ui.search=make('input','war-search');ui.search.type='search';ui.search.placeholder='단어·뜻·원래 오답노트에서 찾기';ui.search.setAttribute('aria-label','오답노트 보관함 검색');ui.search.id='wrongArchiveSearch';tools.append(ui.search);
 const bulk=make('div','war-bulk');ui.restoreAll=button('전체 복구 (0)','restore-all',null,'war-button war-restore');ui.deleteAll=button('전체 완전 삭제 (0)','purge-all',null,'war-button war-delete');bulk.append(ui.restoreAll,ui.deleteAll);ui.summary=make('p','war-summary');ui.status=make('p','war-status');ui.status.setAttribute('role','status');ui.status.setAttribute('aria-live','polite');ui.list=make('div','war-list');ui.list.id='wrongArchiveList';ui.more=button('더 보기','more',null,'war-button war-more');ui.more.hidden=true;const fold=button('∧ 접기','toggle',null,'war-fold');
 content.append(description,tools,bulk,ui.summary,ui.status,ui.list,ui.more,fold);root.append(heading,content);ui.heading=heading;ui.toggleButton=toggleButton;ui.content=content;
 try{const ids=JSON.parse(localStorage.getItem('openSections')||'[]');if(Array.isArray(ids)&&ids.includes('wrongArchiveBox')){content.classList.add('open');heading.classList.add('open-arrow');toggleButton.setAttribute('aria-expanded','true');}}catch(e){}
 root.addEventListener('click',onClick);root.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.closest('button'))e.stopPropagation();});root.addEventListener('toggle',e=>{if(e.target.matches?.('.war-details')){const id=e.target.dataset.warId;if(e.target.open)detailOpen.add(id);else detailOpen.delete(id);}},true);
 ui.search.addEventListener('input',()=>{shown=PAGE_SIZE;renderEntries();});return true;
}
function rememberDetails(){if(!ui)return;for(const d of ui.list.querySelectorAll('.war-details')){if(d.open)detailOpen.add(d.dataset.warId);else detailOpen.delete(d.dataset.warId);}}
function readEntries(){if(typeof getWrongArchiveEntries!=='function')throw Error('보관함이 아직 준비되지 않았어요. 새로고침한 뒤 다시 열어 주세요.');const entries=getWrongArchiveEntries();if(!Array.isArray(entries))throw Error('보관함 자료를 읽지 못했어요.');return entries;}
function render(){
 if(!mount())return;
 rememberDetails();ui.toggleButton.setAttribute('aria-expanded',String(ui.content.classList.contains('open')));
 try{
  lastEntries=readEntries();const valid=new Set(lastEntries.map(e=>e.id));detailOpen=new Set([...detailOpen].filter(id=>valid.has(id)));
  ui.count.textContent='('+lastEntries.length+')';ui.restoreAll.textContent='전체 복구 ('+lastEntries.length+')';ui.deleteAll.textContent='전체 완전 삭제 ('+lastEntries.length+')';ui.restoreAll.disabled=busy||!lastEntries.length;ui.deleteAll.disabled=busy||!lastEntries.length;
  renderEntries();
 }catch(err){
  lastEntries=[];ui.count.textContent='(읽기 오류)';ui.restoreAll.disabled=true;ui.deleteAll.disabled=true;ui.summary.textContent='';ui.list.replaceChildren(make('p','war-empty','보관함을 불러오지 못했어요. 기존 자료는 변경하지 않았습니다.'));ui.list.append(button('다시 불러오기','retry',null,'war-button'));ui.more.hidden=true;message(err?.message||'자료를 읽지 못했어요. 다시 시도해 주세요.',true);
 }
}
function renderEntries(){
 if(!ui)return;rememberDetails();const active=document.activeElement,hadFocus=ui.list.contains(active),focusAction=active?.dataset?.warAction,focusId=active?.dataset?.warId;const q=ui.search.value.trim().toLocaleLowerCase();const filtered=lastEntries.filter(e=>!q||[e.word?.eng,e.word?.kor,e.deckName].some(v=>String(v||'').toLocaleLowerCase().includes(q)));
 ui.summary.textContent='전체 '+lastEntries.length+'개'+(q?' · 검색 결과 '+filtered.length+'개':'')+' · 전체 버튼은 검색과 관계없이 모든 보관 단어에 적용됩니다.';ui.list.replaceChildren();
 if(!filtered.length)ui.list.append(make('p','war-empty',lastEntries.length?'검색 결과가 없어요. 다른 단어나 오답노트 이름으로 찾아보세요.':'보관 중인 단어가 없어요. 오답노트에서 지운 단어가 여기에 모입니다.'));
 for(const entry of filtered.slice(0,shown)){
  const word=entry.word||{},card=make('article','war-item');card.dataset.warId=entry.id;card.setAttribute('aria-label',plain(word.eng)+' 보관 단어');const wordsRow=make('div','war-word-row');wordsRow.append(make('div','war-eng',plain(word.eng)),make('div','war-kor',plain(word.kor)));const meta=make('div','war-meta');meta.append(make('span','war-origin',entry.deckName||'원래 오답노트'),make('time','war-date',dateLabel(entry.removedAt)));card.append(wordsRow,meta);
  const exs=examples(word),nts=notes(word);
  if(exs.length||nts.length){const details=make('details','war-details');details.dataset.warId=entry.id;details.open=detailOpen.has(entry.id);const summary=make('summary','',[(exs.length?'예문 '+exs.length+'개':''),(nts.length?'메모 '+nts.length+'개':'')].filter(Boolean).join(' · ')+' 보기');details.append(summary);if(exs.length){const block=make('div','war-detail-block');block.append(make('strong','war-detail-title','예문'));for(const ex of exs)block.append(make('div','war-example',ex));details.append(block);}if(nts.length){const block=make('div','war-detail-block');block.append(make('strong','war-detail-title','내 메모'));for(const note of nts){const line=make('div','war-note');if(note.eng)line.append(make('strong','',note.eng));if(note.eng&&note.kor)line.append(document.createTextNode(' '));if(note.kor)line.append(make('span','',note.kor));block.append(line);}details.append(block);}card.append(details);}
  const actions=make('div','war-item-actions');const restore=button('복구','restore',entry.id,'war-button war-restore');const purge=button('완전 삭제','purge',entry.id,'war-button war-delete');restore.disabled=busy;purge.disabled=busy;actions.append(restore,purge);card.append(actions);ui.list.append(card);
 }
 ui.more.hidden=filtered.length<=shown;ui.more.textContent='다음 '+Math.min(PAGE_SIZE,Math.max(0,filtered.length-shown))+'개 보기 ('+Math.min(shown,filtered.length)+' / '+filtered.length+')';ui.more.disabled=busy;
 if(hadFocus){const next=[...ui.list.querySelectorAll('button')].find(b=>b.dataset.warAction===focusAction&&b.dataset.warId===focusId);(next&&!next.disabled?next:ui.toggleButton).focus({preventScroll:true});}
}
function mutation(kind,ids){
 if(busy)return;busy=true;render();let result;
 try{result=kind==='restore'?restoreWrongArchive(ids.slice()):purgeWrongArchive(ids.slice());}catch(err){busy=false;render();message(err?.message||'저장하지 못했어요. 다시 시도해 주세요.',true);return;}
 busy=false;
 if(!result||!result.ok){render();message(result?.error||result?.message||'자료가 변경되었거나 저장하지 못했어요. 다시 확인해 주세요.',true);return;}
 const count=Number(kind==='restore'?result.restoredCount:result.purgedCount)||0;
 let refreshFailed=false;try{window.afterWrongArchiveChange?.(result);}catch(err){refreshFailed=true;}
 render();
 if(count>0)message((kind==='restore'?count+'개 단어를 원래 오답노트로 복구했어요.':count+'개 단어를 보관함에서 완전히 삭제했어요.')+(refreshFailed?' 화면을 다시 열어 변경 내용을 확인해 주세요.':''));
 else message('대상 단어가 변경되었어요. 보관함을 다시 확인해 주세요.',true);
}
function onClick(e){
 const b=e.target.closest('button[data-war-action]');if(!b||!root.contains(b)||b.disabled)return;const action=b.dataset.warAction;
 if(action==='toggle'){
  if(typeof toggle==='function')toggle('wrongArchiveBox',ui.heading);else{ui.content.classList.toggle('open');ui.heading.classList.toggle('open-arrow',ui.content.classList.contains('open'));}
  ui.toggleButton.setAttribute('aria-expanded',String(ui.content.classList.contains('open')));return;
 }
 if(action==='more'){shown+=PAGE_SIZE;renderEntries();return;}if(action==='retry'){render();return;}if(!canChange())return;
 let entries;try{entries=readEntries();}catch(err){message(err?.message||'자료를 읽지 못했어요.',true);return;}
 const all=action==='restore-all'||action==='purge-all',selected=all?entries:entries.filter(x=>x.id===b.dataset.warId),ids=selected.map(x=>x.id);
 if(!ids.length){render();message('대상 단어가 이미 변경되었어요. 다시 확인해 주세요.',true);return;}
 if(action==='restore'||action==='restore-all'){mutation('restore',ids);return;}
 if(action==='purge'||action==='purge-all'){
  const detail=all?'보관함의 단어 '+ids.length+'개 전체를':'“'+plain(selected[0]?.word?.eng).replace(/\s+/g,' ').slice(0,100)+'” 단어를';const text=detail+' 완전히 삭제할까요?\n예문·메모도 함께 삭제되며 되돌릴 수 없어요.';
  if(typeof openConfirm==='function')openConfirm(text,()=>mutation('purge',ids));
  else message('확인창을 열지 못했어요. 새로고침한 뒤 다시 시도해 주세요.',true);
 }
}
window.WrongArchive={render};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',render,{once:true});else render();
})();
