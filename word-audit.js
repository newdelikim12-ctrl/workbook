/* Local vocabulary review. Each user action changes only the selected record. */
(function(){
  'use strict';
  const ACCEPTED_KEY='wordbook.spelling.accepted.v1';
  let ui,opener,sequence=0,entries=[],groups=[],findings=[],mode='duplicates',limit=80;
  let scanState='idle',progress=0,scanError='',editing=null,deleting=null,deleteError='';
  let busy=false,showReview=false,editPosition=null,accepted=new Set(),checked=new Map();
  const rowWords=new WeakMap();
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const normalize=value=>String(value||'').normalize('NFKC').replace(/[‘’ʻʼ＇]/g,"'").replace(/[‐‑﹣－]/g,'-').toLocaleLowerCase('en-US');
  const review=issue=>issue.confidence==='review'||(!issue.confidence&&issue.kind==='name');
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
      <div id="waSpellingOptions" hidden><label class="wa-review-toggle"><input type="checkbox" id="waShowReview"> 추가 검토도 보기 <span id="waReviewCount"></span></label><details class="wa-accepted"><summary id="waAcceptedSummary">유지한 영어 표기</summary><div id="waAcceptedList"></div></details></div>
      <p class="wa-notice" id="waNotice"></p><p class="wa-status" id="waStatus" role="status" aria-live="polite"></p><p id="waActionMessage" class="wa-action-message" role="status" aria-live="polite"></p>
      <div id="waResults" class="wa-results" role="tabpanel"></div><button type="button" class="wa-more" data-action="more" id="waMore" hidden>더 보기</button>`;
    document.body.appendChild(dialog);
    const byId=id=>dialog.querySelector('#'+id);
    ui={dialog,summary:byId('waSummary'),editor:byId('waEditor'),eng:byId('waEnglish'),kor:byId('waKorean'),editError:byId('waEditError'),scan:byId('waScan'),cancel:byId('waCancelScan'),notice:byId('waNotice'),status:byId('waStatus'),message:byId('waActionMessage'),results:byId('waResults'),more:byId('waMore'),options:byId('waSpellingOptions'),showReview:byId('waShowReview'),reviewCount:byId('waReviewCount'),acceptedSummary:byId('waAcceptedSummary'),acceptedList:byId('waAcceptedList')};
    dialog.addEventListener('keydown',event=>{
      event.stopPropagation();
      if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&editing&&!event.isComposing&&event.keyCode!==229){event.preventDefault();saveEdit();}
      if((event.key==='ArrowLeft'||event.key==='ArrowRight')&&event.target.getAttribute('role')==='tab'){
        event.preventDefault();setMode(mode==='duplicates'?'spelling':'duplicates');dialog.querySelector('[data-mode="'+mode+'"]').focus();
      }
    });
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    dialog.addEventListener('close',()=>{if(!dialog.open){++sequence;editing=null;deleting=null;busy=false;}});
    dialog.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button)return;
      if(button.dataset.mode){setMode(button.dataset.mode);return;}
      switch(button.dataset.action){
        case 'close':close();break;
        case 'scan':if(!editing&&!busy)mode==='duplicates'?refresh():scan();break;
        case 'cancel-scan':++sequence;scanState='stopped';render();break;
        case 'edit':startEdit(Number(button.dataset.entry));break;
        case 'cancel-edit':cancelEdit(true);break;
        case 'delete':askDelete(Number(button.dataset.entry));break;
        case 'cancel-delete':deleting=null;deleteError='';renderKeepingPosition();break;
        case 'confirm-delete':deleteEntry();break;
        case 'accept':acceptIssue(Number(button.dataset.entry),Number(button.dataset.issue));break;
        case 'unaccept':unaccept(button.dataset.term);break;
        case 'more':limit+=80;renderResults();break;
      }
    });
    ui.editor.addEventListener('submit',event=>{event.preventDefault();saveEdit();});
    ui.showReview.addEventListener('change',()=>{showReview=ui.showReview.checked;limit=80;renderKeepingPosition();});
  }
  function dirty(){return editing&&(ui.eng.value!==editing.eng||ui.kor.value!==editing.kor);}
  function discard(){return !dirty()||window.confirm('수정 중인 내용을 저장하지 않고 닫을까요?');}
  function open(){
    if(isOpen())return;
    if((typeof anyDialogOpen==='function'&&anyDialogOpen())||editIndex>=0||lsEditIndex>=0){showToast('수정 중인 내용을 저장하거나 취소한 뒤 검사해 주세요.');return;}
    create();opener=document.activeElement;++_sheetImportSeq;clearTimeout(autoPlayTimer);
    try{const saved=JSON.parse(safeStorage.getItem(ACCEPTED_KEY)||'[]');accepted=new Set(Array.isArray(saved)?saved.filter(x=>typeof x==='string').map(normalize):[]);}catch(_error){accepted=new Set();}
    mode='duplicates';scanState='idle';findings=[];checked.clear();editing=null;deleting=null;busy=false;ui.editor.hidden=true;ui.message.textContent='';
    snapshot();limit=80;render();ui.dialog.showModal();ui.dialog.querySelector('[data-mode="duplicates"]').focus();
  }
  function close(){
    if(!isOpen()||!discard())return;
    ++sequence;ui.dialog.close();editing=null;deleting=null;busy=false;
    if(opener?.isConnected)opener.focus({preventScroll:true});
    if(autoPlay&&currentIndex>=0)scheduleAutoPlay();
  }
  function snapshot(){
    entries=getAllWordEntries().map(entry=>({...entry,eng:entry.word.eng,kor:entry.word.kor}));
    const byKey=new Map(),byWord=new Map();
    entries.forEach((entry,index)=>{
      entry.auditIndex=index;byWord.set(entry.word,entry);
      if(entry.isWrongDeck)return;
      let group=byKey.get(entry.key);if(!group)byKey.set(entry.key,group=[]);group.push(entry);
    });
    groups=[...byKey.values()].filter(group=>group.length>1);
    findings=findings.flatMap(item=>{
      const entry=byWord.get(item.entry.word);
      return entry&&entry.eng===item.entry.eng&&entry.kor===item.entry.kor?[{entry,issues:item.issues}]:[];
    });
    for(const [word,values] of checked){const entry=byWord.get(word);if(!entry||entry.eng!==values.eng||entry.kor!==values.kor)checked.delete(word);}
    progress=checked.size;
    if(scanState==='done'&&progress<entries.length)scanState='stopped';
    ui.summary.textContent=decks.length+'개 단어장 · '+entries.length+'개 단어를 확인합니다.';
  }
  function refresh(){
    const saved=position();++sequence;snapshot();deleting=null;deleteError='';renderKeepingPosition(saved);
  }
  function setMode(next){
    if(mode===next||busy||!discard())return;
    cancelEdit(false);deleting=null;if(scanState==='running'){++sequence;scanState='stopped';}
    mode=next;limit=80;render();
  }
  function position(excludeWord=null){
    const top=ui.dialog.getBoundingClientRect().top,bottom=ui.dialog.getBoundingClientRect().bottom;
    const anchors=[...ui.results.querySelectorAll('.wa-entry')].flatMap(element=>{
      const rect=element.getBoundingClientRect(),word=rowWords.get(element);
      return word&&word!==excludeWord&&rect.bottom>top&&rect.top<bottom?[{word,offset:rect.top-top}]:[];
    });
    return {scroll:ui.dialog.scrollTop,anchors};
  }
  function restorePosition(saved){
    if(!saved)return;
    for(const anchor of saved.anchors){
      const entry=entries.find(e=>e.word===anchor.word),element=entry&&ui.results.querySelector('.wa-entry[data-entry="'+entry.auditIndex+'"]');
      if(element){ui.dialog.scrollTop+=element.getBoundingClientRect().top-ui.dialog.getBoundingClientRect().top-anchor.offset;return;}
    }
    ui.dialog.scrollTop=saved.scroll;
  }
  function renderKeepingPosition(saved=position()){render();restorePosition(saved);}
  function render(){
    ui.dialog.querySelectorAll('[data-mode]').forEach(button=>{
      const selected=button.dataset.mode===mode;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;button.disabled=busy;
    });
    ui.results.setAttribute('aria-labelledby',mode==='duplicates'?'waDupesTab':'waSpellingTab');
    ui.scan.textContent=mode==='duplicates'?'현재 단어 다시 검사':scanState==='idle'?'오탈자 검사 시작':'오탈자 다시 검사';
    ui.scan.disabled=scanState==='running'||!!editing||busy;ui.cancel.hidden=scanState!=='running';ui.options.hidden=mode!=='spelling';
    ui.showReview.checked=showReview;ui.showReview.disabled=busy;
    const likelyCount=findings.reduce((sum,item)=>sum+item.issues.filter(issue=>!review(issue)).length,0);
    const reviewCount=findings.reduce((sum,item)=>sum+item.issues.filter(review).length,0);
    ui.reviewCount.textContent=reviewCount?'('+reviewCount+')':'';
    if(mode==='duplicates'){
      ui.notice.textContent='대소문자·전각 문자·띄어쓰기 차이를 정리해 영어 단어를 비교합니다. 오답노트의 복사본은 중복 집계에서 제외합니다. 각 위치의 항목을 수정하거나 삭제할 수 있습니다.';
      ui.status.textContent=groups.length?groups.length+'개 단어가 중복되어 있습니다. 각 위치와 뜻을 비교해 주세요.':'현재 저장된 전체 단어장에서 중복된 영어 단어가 없습니다.';
    }else{
      ui.notice.textContent='영어는 미국·영국 사전과 철자 유사도를 함께 확인합니다. 고유명사·전문용어·문맥 확인이 필요한 표현은 추가 검토로 나눕니다. 한글은 자주 틀리는 표현을 검사하며, 문법·뜻의 정확성이나 모든 띄어쓰기를 판정하지는 않습니다.';
      const statuses={idle:'영어 단어와 한글 뜻을 검사합니다. 예문·메모는 검사 대상에 포함하지 않습니다.',running:progress?progress+' / '+entries.length+'개 검사 중…':'영어 사전 준비 중…',done:entries.length+'개 검사 완료 · 수정 후보 '+likelyCount+'개 · 추가 검토 '+reviewCount+'개',stopped:progress+' / '+entries.length+'개를 확인했습니다. 아래는 일부 검사 결과입니다.',error:'검사를 모두 완료하지 못했습니다. '+scanError};
      ui.status.textContent=statuses[scanState]||'';
    }
    renderAccepted();renderResults();
  }
  function renderAccepted(){
    ui.acceptedSummary.textContent='유지한 영어 표기 ('+accepted.size+')';
    ui.acceptedList.innerHTML=[...accepted].sort().map(term=>`<div class="wa-accepted-term"><span>${esc(term)}</span><button type="button" data-action="unaccept" data-term="${esc(term)}"${busy||scanState==='running'?' disabled':''}>유지 해제</button></div>`).join('')||'<p>고유명사나 전문용어는 후보의 ‘이 표기 유지’를 누르면 다음 검사에서도 제외됩니다.</p>';
  }
  function entryHtml(entry,details=''){
    const disabled=busy||scanState==='running'?' disabled':'';
    const examples=exList(entry.word),notes=noteList(entry.word);
    const meta=[examples.length?'예문 '+examples.length+'개':'',notes.length?'메모 '+notes.length+'개':'',entry.word.mastered?'학습 완료':''].filter(Boolean);
    const savedDetails=examples.length||notes.length?`<details class="wa-saved-details"><summary>예문·메모 보기</summary>${examples.map(example=>'<p>'+esc(example)+'</p>').join('')}${notes.map(note=>'<p>'+esc([note.eng,note.kor].filter(Boolean).join(' — '))+'</p>').join('')}</details>`:'';
    const confirmation=deleting?.word===entry.word?`<div class="wa-delete-confirm" role="group" aria-label="선택한 단어 삭제 확인"><b>${esc(entry.deckName)} · ${entry.number}번만 삭제할까요?</b><p>이 항목의 예문·메모·학습 기록도 함께 삭제됩니다. 다른 위치와 오답노트의 복사본은 유지됩니다.</p>${deleteError?'<p class="wa-error" role="alert">'+esc(deleteError)+'</p>':''}<div class="wa-actions"><button type="button" data-action="confirm-delete"${disabled}>이 항목 삭제</button><button type="button" data-action="cancel-delete"${disabled}>취소</button></div></div>`:'';
    return `<article class="wa-entry" data-entry="${entry.auditIndex}"><div class="wa-location">${esc(entry.deckName)} · ${entry.number}번</div><div class="wa-word">${esc(entry.eng)}</div><div class="wa-meaning">${esc(entry.kor)}</div>${meta.length?'<div class="wa-meta">'+esc(meta.join(' · '))+'</div>':''}${savedDetails}${details}<div class="wa-entry-actions"><button type="button" data-action="edit" data-entry="${entry.auditIndex}"${disabled}>수정</button><button type="button" data-action="delete" data-entry="${entry.auditIndex}"${disabled}>삭제</button><a href="https://en.dict.naver.com/#/search?query=${encodeURIComponent(entry.eng)}" target="_blank" rel="noopener">사전에서 확인 ↗</a></div>${confirmation}</article>`;
  }
  function visibleFindings(){return findings.map(item=>({entry:item.entry,issues:item.issues.map((issue,index)=>({...issue,issueIndex:index})).filter(issue=>showReview||!review(issue))})).filter(item=>item.issues.length);}
  function renderResults(){
    const expanded=new Set([...ui.results.querySelectorAll('.wa-saved-details[open]')].map(element=>rowWords.get(element.closest('.wa-entry'))));
    let count;
    if(mode==='duplicates'){
      count=groups.length;
      ui.results.innerHTML=groups.slice(0,limit).map(group=>`<section class="wa-group"><h3>${esc(group[0].eng)} <span>${group.length}곳</span></h3>${group.map(entry=>entryHtml(entry)).join('')}</section>`).join('')||'<div class="wa-empty">겹치는 단어가 없습니다.</div>';
    }else{
      const visible=visibleFindings();count=visible.length;
      ui.results.innerHTML=visible.slice(0,limit).map(item=>entryHtml(item.entry,'<ul class="wa-findings">'+item.issues.map(issue=>`<li><b>${issue.field==='eng'?'영어':'한글 뜻'} · ${esc(issue.token)}</b><span>${esc(issue.message)}</span>${issue.suggestions.length?'<span class="wa-suggestion">확인할 표기: '+issue.suggestions.map(esc).join(' · ')+'</span>':''}${issue.field==='eng'?'<button type="button" class="wa-accept" data-action="accept" data-entry="'+item.entry.auditIndex+'" data-issue="'+issue.issueIndex+'"'+(busy||scanState==='running'?' disabled':'')+'>이 표기 유지</button>':''}</li>`).join('')+'</ul>')).join('');
      if(!visible.length&&scanState==='done')ui.results.innerHTML='<div class="wa-empty">철자 수정 후보가 없습니다.'+(findings.length?' 추가 검토도 보려면 위 항목을 켜 주세요.':'')+'</div>';
    }
    ui.results.querySelectorAll('.wa-entry').forEach(element=>{
      const word=entries[Number(element.dataset.entry)]?.word;rowWords.set(element,word);
      const details=element.querySelector('.wa-saved-details');if(details&&expanded.has(word))details.open=true;
    });
    ui.more.hidden=limit>=count;ui.more.textContent='더 보기 ('+Math.min(limit,count)+' / '+count+')';
  }
  async function checkEntry(entry){
    const issues=WordSpelling.checkKorean(entry.kor).map(issue=>({...issue,field:'kor'}));
    try{issues.push(...(await WordSpelling.checkEnglish(entry.eng,{acceptedTerms:new Set(accepted)})).map(issue=>({...issue,field:'eng'})));return {issues,error:''};}
    catch(_error){return {issues,error:'영어 사전 처리 중 문제가 생겼습니다. 나머지 결과는 유지되어 있습니다.'};}
  }
  async function scan(){
    if(editing||busy)return;
    snapshot();const token=++sequence;findings=[];checked.clear();progress=0;limit=80;scanError='';scanState='running';deleting=null;ui.message.textContent='';render();
    const current=()=>token===sequence&&isOpen()&&mode==='spelling';
    if(!window.WordSpelling){scanState='error';scanError='검사 모듈을 불러오지 못했습니다. 연결 후 앱을 새로고침해 주세요.';render();return;}
    let english=true,errorMessage='';
    try{await WordSpelling.ready();}catch(_error){english=false;errorMessage='영어 사전을 불러오지 못했습니다. 연결 후 다시 시도해 주세요. 한글 표현 결과만 확인할 수 있습니다.';}
    if(!current())return;
    for(const entry of entries){
      if(!current())return;
      const issues=WordSpelling.checkKorean(entry.kor).map(issue=>({...issue,field:'kor'}));
      if(english){
        try{issues.push(...(await WordSpelling.checkEnglish(entry.eng,{acceptedTerms:accepted})).map(issue=>({...issue,field:'eng'})));}
        catch(_error){english=false;errorMessage='영어 사전 처리 중 문제가 생겼습니다. 한글 표현 결과와 일부 영어 결과만 확인할 수 있습니다.';}
      }
      if(!current())return;
      if(entry.word.eng===entry.eng&&entry.word.kor===entry.kor){if(issues.length)findings.push({entry,issues});checked.set(entry.word,{eng:entry.eng,kor:entry.kor});}
      progress=checked.size;
      if(progress%8===0){renderKeepingPosition();await new Promise(resolve=>setTimeout(resolve,0));}
    }
    if(!current())return;scanError=errorMessage;scanState=english?'done':'error';snapshot();renderKeepingPosition();
  }
  function startEdit(index){
    if(scanState==='running'||busy||!discard())return;
    const entry=entries[index];if(!entry)return;
    editPosition=position(entry.word);deleting=null;editing=entry;ui.eng.value=entry.eng;ui.kor.value=entry.kor;ui.editError.textContent='';ui.editor.hidden=false;ui.scan.disabled=true;
    ui.eng.focus();ui.editor.scrollIntoView({block:'nearest',behavior:'smooth'});
  }
  function cancelEdit(restore){const saved=editPosition;editing=null;ui.editor.hidden=true;ui.editError.textContent='';ui.scan.disabled=scanState==='running'||busy;if(restore)restorePosition(saved);}
  function currentEntry(entry){return getAllWordEntries().find(candidate=>candidate.deckId===entry.deckId&&candidate.word===entry.word&&candidate.eng===entry.eng&&candidate.kor===entry.kor);}
  async function saveEdit(){
    if(!editing||busy)return;
    const entry=editing,eng=ui.eng.value.trim(),kor=ui.kor.value.trim();
    if(!eng||!kor){ui.editError.textContent='영어와 뜻을 모두 입력해 주세요.';return;}
    if(!currentEntry(entry)){ui.editError.textContent='단어가 변경되었습니다. 입력을 복사해 두고 다시 확인해 주세요.';return;}
    const collisions=normalizeHeadword(eng)!==normalizeHeadword(entry.eng)?findWordDuplicates(eng,entry.word):[];
    if(collisions.length){ui.editError.textContent='이미 등록된 단어입니다: '+collisions.map(e=>e.deckName+' '+e.number+'번').join(', ');return;}
    entry.word.eng=eng;entry.word.kor=kor;
    const active=decks.find(deck=>deck.id===activeDeckId),previousWords=active?.words;
    if(active)active.words=words;
    if(!saveDecks()){
      entry.word.eng=entry.eng;entry.word.kor=entry.kor;if(active)active.words=previousWords;
      ui.editError.textContent='저장하지 못했습니다. 입력은 유지되어 있으니 다시 시도해 주세요.';return;
    }
    ++_sheetImportSeq;const token=++sequence,savedPosition=editPosition,previousState=scanState;
    busy=true;cancelEdit(false);snapshot();ui.message.textContent=previousState==='idle'?'단어를 수정했습니다.':'수정한 항목만 다시 확인하는 중…';render();
    refreshReadingViews(entry.word);
    if(previousState!=='idle'&&window.WordSpelling){
      const updated=entries.find(e=>e.word===entry.word),result=await checkEntry(updated);
      if(token!==sequence||!isOpen())return;
      findings=findings.filter(item=>item.entry.word!==updated.word);
      if(currentEntry(updated)){if(result.issues.length)findings.push({entry:updated,issues:result.issues});checked.set(updated.word,{eng:updated.eng,kor:updated.kor});}
      findings.sort((a,b)=>a.entry.auditIndex-b.entry.auditIndex);progress=checked.size;
      if(result.error){scanState='error';scanError=result.error;}
      else if(scanState!=='error')scanState=previousState==='done'&&progress===entries.length?'done':previousState;
    }
    if(token!==sequence||!isOpen())return;
    busy=false;ui.message.textContent='수정했습니다. 나머지 검사 결과는 유지됩니다.';render();restorePosition(savedPosition);
  }
  function askDelete(index){
    if(busy||scanState==='running'||!discard())return;
    const entry=entries[index];if(!entry)return;
    cancelEdit(false);deleting=entry;deleteError='';renderKeepingPosition();
    ui.results.querySelector('.wa-delete-confirm')?.scrollIntoView({block:'nearest',behavior:'smooth'});
  }
  function deleteEntry(){
    if(!deleting||busy||scanState==='running')return;
    const entry=deleting,saved=position(entry.word),viewed=words[currentIndex]||null;
    const result=removeAuditedWord(entry);
    if(!result.ok){deleteError=result.error;renderKeepingPosition(saved);return;}
    ++sequence;++_sheetImportSeq;deleting=null;deleteError='';
    if(result.isActive){currentIndex=viewed&&viewed!==entry.word?words.indexOf(viewed):-1;afterWordsRemoved();if(currentIndex<0)resetCardView();saveRangeMemo();}
    snapshot();ui.message.textContent=entry.deckName+'의 항목을 삭제했습니다. 다른 위치의 단어는 유지됩니다.';
    refreshReadingViews();render();restorePosition(saved);
  }
  function refreshReadingViews(changedWord){
    window.render?.();window.renderDeckPanel?.();window.renderRecentDecks?.();
    if(changedWord&&currentIndex>=0&&words[currentIndex]===changedWord){
      document.getElementById('front').innerText=cardDir==='k2e'?changedWord.kor:changedWord.eng;
      document.getElementById('back').innerText=cardDir==='k2e'?changedWord.eng:changedWord.kor;fitCardExample();
    }
  }
  function saveAccepted(next){
    if(!safeStorage.setItem(ACCEPTED_KEY,JSON.stringify([...next].sort()))){ui.message.textContent='유지할 표기를 저장하지 못했습니다. 다시 시도해 주세요.';return false;}
    accepted=next;return true;
  }
  function acceptIssue(index,issueIndex){
    if(busy||scanState==='running'||editing)return;
    const entry=entries[index],item=findings.find(item=>item.entry.word===entry?.word),issue=item?.issues[issueIndex];
    if(!entry||!issue||issue.field!=='eng'||!currentEntry(entry))return;
    const term=normalize(issue.token),next=new Set(accepted);next.add(term);if(!saveAccepted(next))return;
    const saved=position(entry.word);
    findings=findings.flatMap(item=>{const issues=item.issues.filter(issue=>issue.field!=='eng'||![term,term+"'s"].includes(normalize(issue.token)));return issues.length?[{entry:item.entry,issues}]:[];});
    ui.message.textContent='‘'+issue.token+'’ 표기를 유지합니다. 다음 검사에서도 제외됩니다.';render();restorePosition(saved);
  }
  function unaccept(term){
    if(busy||scanState==='running')return;
    const next=new Set(accepted);next.delete(term);if(!saveAccepted(next))return;
    ui.message.textContent='‘'+term+'’ 표기는 다음 오탈자 검사부터 다시 확인합니다.';renderKeepingPosition();
  }
  window.WordAudit=Object.freeze({open,close,isOpen});
})();
