/* Review the current vocabulary across all decks without automatic removal or correction. */
(function(){
  'use strict';
  let ui,opener,sequence=0,entries=[],groups=[],findings=[],mode='duplicates',limit=80;
  let scanState='idle',progress=0,scanError='',editing=null;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function isOpen(){return !!ui?.dialog.open;}
  function create(){
    if(ui)return;
    const dialog=document.createElement('dialog');dialog.id='wordAuditDialog';dialog.className='wa-dialog';
    dialog.setAttribute('aria-labelledby','waTitle');
    dialog.innerHTML=`<header class="wa-head"><div><div class="wa-eyebrow">ALL VOCABULARY</div><h2 id="waTitle">전체 단어장 점검</h2></div><button type="button" data-action="close" aria-label="단어장 점검 닫기">✕</button></header>
      <p class="wa-summary" id="waSummary"></p>
      <div class="wa-tabs" role="tablist" aria-label="검사 종류"><button type="button" role="tab" id="waDupesTab" aria-controls="waResults" data-mode="duplicates">중복 단어</button><button type="button" role="tab" id="waSpellingTab" aria-controls="waResults" data-mode="spelling">오탈자 후보</button></div>
      <form class="wa-editor" id="waEditor" hidden><h3>단어 수정</h3><label>영어<textarea id="waEnglish" rows="3" lang="en" spellcheck="true" required></textarea></label><label>뜻<textarea id="waKorean" rows="3" lang="ko" spellcheck="true" required></textarea></label><p id="waEditError" class="wa-error" role="alert"></p><div class="wa-actions"><button type="submit">변경 저장</button><button type="button" data-action="cancel-edit">취소</button></div><small>예문·메모·학습 기록은 그대로 유지됩니다.</small></form>
      <div class="wa-toolbar"><button type="button" data-action="scan" id="waScan">현재 단어 다시 검사</button><button type="button" data-action="cancel-scan" id="waCancelScan" hidden>검사 중단</button></div>
      <p class="wa-notice" id="waNotice"></p><p class="wa-status" id="waStatus" role="status" aria-live="polite"></p>
      <div id="waResults" class="wa-results" role="tabpanel"></div><button type="button" class="wa-more" data-action="more" id="waMore" hidden>더 보기</button>`;
    document.body.appendChild(dialog);
    const byId=id=>dialog.querySelector('#'+id);
    ui={dialog,summary:byId('waSummary'),editor:byId('waEditor'),eng:byId('waEnglish'),kor:byId('waKorean'),editError:byId('waEditError'),scan:byId('waScan'),cancel:byId('waCancelScan'),notice:byId('waNotice'),status:byId('waStatus'),results:byId('waResults'),more:byId('waMore')};
    dialog.addEventListener('keydown',event=>{
      event.stopPropagation();
      if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&editing&&!event.isComposing&&event.keyCode!==229){event.preventDefault();saveEdit();}
      if((event.key==='ArrowLeft'||event.key==='ArrowRight')&&event.target.getAttribute('role')==='tab'){
        event.preventDefault();setMode(mode==='duplicates'?'spelling':'duplicates');dialog.querySelector('[data-mode="'+mode+'"]').focus();
      }
    });
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    dialog.addEventListener('close',()=>{if(!dialog.open){++sequence;editing=null;}});
    dialog.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button)return;
      if(button.dataset.mode){setMode(button.dataset.mode);return;}
      switch(button.dataset.action){
        case 'close':close();break;
        case 'scan':if(!editing)mode==='duplicates'?refresh():scan();break;
        case 'cancel-scan':++sequence;scanState='stopped';render();break;
        case 'edit':startEdit(Number(button.dataset.entry));break;
        case 'cancel-edit':cancelEdit();break;
        case 'more':limit+=80;renderResults();break;
      }
    });
    ui.editor.addEventListener('submit',event=>{event.preventDefault();saveEdit();});
  }
  function dirty(){return editing&&(ui.eng.value!==editing.eng||ui.kor.value!==editing.kor);}
  function discard(){return !dirty()||window.confirm('수정 중인 내용을 저장하지 않고 닫을까요?');}
  function open(){
    if(isOpen())return;
    if((typeof anyDialogOpen==='function'&&anyDialogOpen())||editIndex>=0||lsEditIndex>=0){showToast('수정 중인 내용을 저장하거나 취소한 뒤 검사해 주세요.');return;}
    create();opener=document.activeElement;++_sheetImportSeq;clearTimeout(autoPlayTimer);
    mode='duplicates';scanState='idle';findings=[];editing=null;ui.editor.hidden=true;
    refresh();ui.dialog.showModal();ui.dialog.querySelector('[data-mode="duplicates"]').focus();
  }
  function close(){
    if(!isOpen()||!discard())return;
    ++sequence;ui.dialog.close();editing=null;
    if(opener?.isConnected)opener.focus({preventScroll:true});
    if(autoPlay&&currentIndex>=0)scheduleAutoPlay();
  }
  function snapshot(){
    entries=getAllWordEntries().map(entry=>({...entry,eng:entry.word.eng,kor:entry.word.kor}));
    const byKey=new Map();
    entries.forEach((entry,index)=>{entry.auditIndex=index;if(entry.isWrongDeck)return;let group=byKey.get(entry.key);if(!group)byKey.set(entry.key,group=[]);group.push(entry);});
    groups=[...byKey.values()].filter(group=>group.length>1);
    ui.summary.textContent=decks.length+'개 단어장 · '+entries.length+'개 단어를 확인합니다.';
  }
  function refresh(){
    ++sequence;snapshot();limit=80;findings=[];scanState='idle';scanError='';render();
  }
  function setMode(next){
    if(mode===next||!discard())return;
    cancelEdit();if(scanState==='running'){++sequence;scanState='stopped';}
    mode=next;limit=80;render();
  }
  function render(){
    ui.dialog.querySelectorAll('[data-mode]').forEach(button=>{
      const selected=button.dataset.mode===mode;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
    });
    ui.results.setAttribute('aria-labelledby',mode==='duplicates'?'waDupesTab':'waSpellingTab');
    ui.scan.textContent=mode==='duplicates'?'현재 단어 다시 검사':scanState==='idle'?'오탈자 검사 시작':'오탈자 다시 검사';
    ui.scan.disabled=scanState==='running'||!!editing;ui.cancel.hidden=scanState!=='running';
    if(mode==='duplicates'){
      ui.notice.textContent='대소문자·전각 문자·띄어쓰기 차이를 정리해 영어 단어를 비교합니다. 오답노트의 복사본은 중복 집계에서 제외합니다. 단어는 자동 삭제하지 않습니다.';
      ui.status.textContent=groups.length?groups.length+'개 단어가 중복되어 있습니다. 각 위치와 뜻을 비교해 주세요.':'현재 저장된 전체 단어장에서 중복된 영어 단어가 없습니다.';
    }else{
      ui.notice.textContent='영어는 미국·영국 사전, 한글 뜻은 자주 틀리는 표현만 확인합니다. 고유명사·전문용어도 후보에 포함될 수 있으며, 문법·뜻의 정확성이나 모든 한글 띄어쓰기를 검사하지는 않습니다. 검사는 기기 안에서 진행됩니다.';
      const statuses={idle:'영어 단어와 한글 뜻을 검사합니다. 예문·메모는 검사 대상에 포함하지 않습니다.',running:progress?progress+' / '+entries.length+'개 검사 중…':'영어 사전 준비 중…',done:entries.length+'개 검사 완료 · 확인할 후보가 있는 단어 '+findings.length+'개',stopped:progress+' / '+entries.length+'개에서 중단했습니다. 아래는 일부 검사 결과입니다.',error:'검사를 모두 완료하지 못했습니다. '+scanError,stale:'단어를 수정했습니다. 최신 내용으로 다시 검사해 주세요.'};
      ui.status.textContent=statuses[scanState]||'';
    }
    renderResults();
  }
  function entryHtml(entry,details=''){
    return `<article class="wa-entry"><div class="wa-location">${esc(entry.deckName)} · ${entry.number}번</div><div class="wa-word">${esc(entry.eng)}</div><div class="wa-meaning">${esc(entry.kor)}</div>${details}<div class="wa-entry-actions"><button type="button" data-action="edit" data-entry="${entry.auditIndex}"${scanState==='running'?' disabled':''}>수정</button><a href="https://en.dict.naver.com/#/search?query=${encodeURIComponent(entry.eng)}" target="_blank" rel="noopener">사전에서 확인 ↗</a></div></article>`;
  }
  function renderResults(){
    if(mode==='duplicates'){
      ui.results.innerHTML=groups.slice(0,limit).map(group=>`<section class="wa-group"><h3>${esc(group[0].eng)} <span>${group.length}곳</span></h3>${group.map(entry=>entryHtml(entry)).join('')}</section>`).join('')||'<div class="wa-empty">겹치는 단어가 없습니다.</div>';
      ui.more.hidden=limit>=groups.length;
    }else{
      ui.results.innerHTML=findings.slice(0,limit).map(item=>entryHtml(item.entry,'<ul class="wa-findings">'+item.issues.map(issue=>`<li><b>${issue.field==='eng'?'영어':'한글 뜻'} · ${esc(issue.token)}</b><span>${esc(issue.message)}</span>${issue.suggestions.length?'<span class="wa-suggestion">확인할 표기: '+issue.suggestions.map(esc).join(' · ')+'</span>':''}</li>`).join('')+'</ul>')).join('');
      if(!findings.length&&scanState==='done')ui.results.innerHTML='<div class="wa-empty">검사 기준에 해당하는 오탈자 후보가 없습니다.</div>';
      ui.more.hidden=limit>=findings.length;
    }
    ui.more.textContent='더 보기 ('+Math.min(limit,mode==='duplicates'?groups.length:findings.length)+' / '+(mode==='duplicates'?groups.length:findings.length)+')';
  }
  async function scan(){
    if(editing)return;
    snapshot();const token=++sequence;findings=[];progress=0;limit=80;scanError='';scanState='running';render();
    const current=()=>token===sequence&&isOpen()&&mode==='spelling';
    if(!window.WordSpelling){scanState='error';scanError='검사 모듈을 불러오지 못했습니다. 연결 후 앱을 새로고침해 주세요.';render();return;}
    let english=true;
    try{await WordSpelling.ready();}catch(error){english=false;scanError='영어 사전을 불러오지 못했습니다. 연결 후 다시 시도해 주세요. 한글 표현 결과만 확인할 수 있습니다.';}
    if(!current())return;
    for(const entry of entries){
      if(!current())return;
      let issues=WordSpelling.checkKorean(entry.kor).map(issue=>({...issue,field:'kor'}));
      if(english){
        try{issues.push(...(await WordSpelling.checkEnglish(entry.eng)).map(issue=>({...issue,field:'eng'})));}
        catch(error){english=false;scanError='영어 사전 처리 중 문제가 생겼습니다. 다시 시도해 주세요. 한글 표현 결과와 일부 영어 결과만 확인할 수 있습니다.';}
      }
      if(issues.length)findings.push({entry,issues});
      ++progress;
      if(progress%8===0){render();await new Promise(resolve=>setTimeout(resolve,0));}
    }
    if(!current())return;scanState=english?'done':'error';render();
  }
  function startEdit(index){
    if(scanState==='running'||!discard())return;
    const entry=entries[index];if(!entry)return;
    editing=entry;ui.eng.value=entry.eng;ui.kor.value=entry.kor;ui.editError.textContent='';ui.editor.hidden=false;ui.scan.disabled=true;
    ui.eng.focus();ui.editor.scrollIntoView({block:'nearest',behavior:'smooth'});
  }
  function cancelEdit(){editing=null;ui.editor.hidden=true;ui.editError.textContent='';ui.scan.disabled=scanState==='running';}
  function saveEdit(){
    if(!editing)return;
    const entry=editing,eng=ui.eng.value.trim(),kor=ui.kor.value.trim();
    if(!eng||!kor){ui.editError.textContent='영어와 뜻을 모두 입력해 주세요.';return;}
    const now=getAllWordEntries().find(candidate=>candidate.deckId===entry.deckId&&candidate.word===entry.word);
    if(!now||entry.word.eng!==entry.eng||entry.word.kor!==entry.kor){ui.editError.textContent='단어가 변경되었습니다. 입력을 복사해 두고 닫은 뒤 다시 검사해 주세요.';return;}
    const collisions=normalizeHeadword(eng)!==normalizeHeadword(entry.eng)?findWordDuplicates(eng,entry.word):[];
    if(collisions.length){ui.editError.textContent='이미 등록된 단어입니다: '+collisions.map(e=>e.deckName+' '+e.number+'번').join(', ');return;}
    entry.word.eng=eng;entry.word.kor=kor;
    const active=decks.find(deck=>deck.id===activeDeckId),previousWords=active?.words;
    if(active)active.words=words;
    if(!saveDecks()){
      entry.word.eng=entry.eng;entry.word.kor=entry.kor;if(active)active.words=previousWords;
      ui.editError.textContent='저장하지 못했습니다. 입력은 유지되어 있으니 다시 시도해 주세요.';return;
    }
    ++sequence;cancelEdit();snapshot();findings=[];scanState='stale';limit=80;
    render();
    // Refresh reading views after the committed edit without resetting notes or progress.
    window.render?.();window.renderDeckPanel?.();window.renderRecentDecks?.();
    if(currentIndex>=0&&words[currentIndex]===entry.word){
      document.getElementById('front').innerText=cardDir==='k2e'?kor:eng;
      document.getElementById('back').innerText=cardDir==='k2e'?eng:kor;
      fitCardExample();
    }
    showToast('단어를 수정했습니다.');
  }
  window.WordAudit=Object.freeze({open,close,isOpen});
})();
