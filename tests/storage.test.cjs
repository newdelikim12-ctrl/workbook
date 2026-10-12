const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]);
const app=scripts.find(s=>s.includes('const APP_VERSION='));
function setup(initial={},failure=''){
  const data=new Map(Object.entries(initial)), writes=[],alerts=[],timers=[];
  const context=vm.createContext({
    localStorage:{
      getItem(k){if(failure==='read')throw Error('denied');return data.get(k)??null;},
      setItem(k,v){if(failure==='write')throw Error('quota');data.set(k,v);writes.push(k);},
      removeItem(k){if(failure==='write')throw Error('quota');data.delete(k);}
    },
    alert:m=>alerts.push(m),setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},
    window:{addEventListener(){}},document:{addEventListener(){}},
    invalidateWordIndex(){},showToast(){},console
  });
  vm.runInContext(app.slice(app.indexOf('// Storage access'),app.indexOf('// ===== 앱 자체 확인창')),context);
  return {data,writes,alerts,timers,context,run:s=>vm.runInContext(s,context)};
}
test('all inline scripts and service worker have valid syntax',()=>{
  scripts.forEach(s=>new vm.Script(s));
  new vm.Script(fs.readFileSync(path.join(__dirname,'../sw.js'),'utf8'));
});
test('fresh installation creates a usable default deck',()=>{
  const s=setup();assert.equal(s.run('decks.length'),1);assert.equal(s.run('words.length'),0);
});
test('malformed JSON is backed up and does not prevent startup',()=>{
  const s=setup({decks:'{broken',words:'[broken',stats:'null',dupes:'{}',recentDeckIds:'42'});
  assert.equal(s.run('words.length'),0);assert.equal(s.data.get('decks.recovery'),'{broken');
  s.timers.forEach(fn=>fn());assert.equal(s.alerts.length,1);
});
test('wrong shapes are normalized while valid fields are preserved',()=>{
  const raw=JSON.stringify([null,{id:'a',name:42,words:[null,{eng:'cat',kor:'고양이',note:4,example:9,custom:7}],stats:[],dupes:[{eng:'cat',sheets:null}]},{id:'a',words:'bad'}]);
  const s=setup({decks:raw,activeDeckId:'missing'});
  assert.equal(s.run('decks.length'),2);assert.equal(s.run('activeDeckId'),'a');
  assert.equal(s.run('words[0].custom'),7);assert.equal(s.run('words[0].example'),'');
  assert.equal(s.run('dupes[0].sheets.length'),0);assert.notEqual(s.run('decks[0].id'),s.run('decks[1].id'));
  assert.equal(s.data.get('decks.recovery'),raw);
});
test('unavailable storage does not crash initialization',()=>{
  const s=setup({},'read');assert.equal(s.run('decks.length'),1);
  s.timers.forEach(fn=>fn());assert.equal(s.alerts.length,1);
});
test('failed migration retains legacy data and alerts once',()=>{
  const raw=JSON.stringify([{eng:'cat',kor:'고양이'}]);
  const s=setup({words:raw},'write');assert.equal(s.data.get('words'),raw);
  assert.equal(s.run('_writeDecks()'),false);s.timers.forEach(fn=>fn());assert.equal(s.alerts.length,1);
});
test('failed recovery backup blocks overwriting damaged original',()=>{
  const s=setup({decks:'broken'},'write');
  assert.equal(s.run('blockedStorageKeys.has("decks")'),true);assert.equal(s.data.get('decks'),'broken');
});
test('identical saves do not write again; changed data still saves',()=>{
  const s=setup();s.run('_writeDecks()');const n=s.writes.length;
  assert.equal(s.run('_writeDecks()'),true);assert.equal(s.writes.length,n);
  s.run('words.push({eng:"cat",kor:"고양이"});_writeDecks()');assert.equal(s.writes.length,n+1);
});
test('invalid deck switch leaves state untouched',()=>{
  const s=setup();const id=s.run('activeDeckId');
  vm.runInContext(app.slice(app.indexOf('function switchDeck('),app.indexOf('\n}',app.indexOf('function switchDeck('))+2),s.context);
  assert.equal(s.run('switchDeck("missing")'),false);assert.equal(s.run('activeDeckId'),id);
});
test('bulk add rejects existing and same-batch case-insensitive duplicates',()=>{
  const s=setup();s.run('words.push({eng:"cat",kor:"고양이"})');
  const rows=[['CAT','고양이'],['dog','개'],['Dog','강아지'],['bird','새'],['','빈칸']].map(([eng,kor])=>({querySelector:q=>({value:q==='.bulkEng'?eng:q==='.bulkKor'?kor:''})}));
  Object.assign(s.context,{saveOnly(){return true;},render(){},playSound(){},addBulkRow(){}});
  s.context.document.querySelectorAll=()=>rows;s.context.document.getElementById=()=>({innerHTML:''});
  vm.runInContext(app.slice(app.indexOf('function bulkAdd('),app.indexOf('function parseCsv(')),s.context);
  s.run('bulkAdd()');assert.equal(s.run('words.map(w=>w.eng).join(",")'),'cat,dog,bird');
});

test('multiple examples and structured notes survive save and reopen',()=>{
  const original=[{eng:'test',kor:'시험',example:['First.','Second.'],note:[{eng:'take a test',kor:'시험을 보다'}]}];
  const s=setup({decks:JSON.stringify([{id:'a',name:'A',words:original,stats:{},dupes:[]}]),activeDeckId:'a'});
  s.run('saveDecks()');
  const again=setup(Object.fromEntries(s.data));
  assert.deepEqual(JSON.parse(again.run('JSON.stringify(words[0].example)')),original[0].example);
  assert.deepEqual(JSON.parse(again.run('JSON.stringify(words[0].note)')),original[0].note);
});
test('refresh never recreates recovery decks or replays old snapshots',()=>{
  const original=JSON.stringify([{id:'a',name:'A',words:[{eng:'cat',kor:'옛 뜻',example:['old one','old two']}]}]);
  const current=JSON.stringify([{id:'a',name:'A',words:[{eng:'cat',kor:'수정한 뜻\n둘째 줄',example:['new one','new two'],note:[{eng:'kitten',kor:'새끼 고양이'}]},{eng:'dog',kor:'개'}]}]);
  let state={decks:current,'decks.recovery':original,'words.recovery':JSON.stringify([{eng:'old',kor:'옛 단어'}]),activeDeckId:'a'};
  for(let i=0;i<5;i++){
    const s=setup(state);
    assert.equal(s.run('decks.length'),1);
    assert.equal(s.run('words[0].kor'),'수정한 뜻\n둘째 줄');
    assert.equal(s.run('words[0].example.join("|")'),'new one|new two');
    assert.equal(s.run('words[0].note[0].eng'),'kitten');
    assert.equal(s.run('words.length'),2);
    s.run('flushDecks()');s.timers.forEach(fn=>fn());
    assert.equal(s.alerts.length,0);
    assert.equal(s.data.get('decks.recovery'),original);
    state=Object.fromEntries(s.data);
  }
});
test('existing recovery deck data stays intact, and deleting it stays deleted',()=>{
  const raw=JSON.stringify([{id:'a',name:'A',words:[]},{id:'recovery_decks_123_0',name:'복구 사본 · A',words:[{eng:'cat',kor:'고양이',example:['one','two']}]}]);
  const s=setup({decks:raw,'decks.recovery':raw,activeDeckId:'a'});
  assert.equal(s.run('decks[1].words[0].example.length'),2);
  s.run('decks.splice(1,1);saveDecks()');
  const again=setup(Object.fromEntries(s.data));assert.equal(again.run('decks.length'),1);
});
test('stale unchanged window cannot erase newer words; conflicting edits are preserved separately',()=>{
  const s=setup();
  const latest=JSON.parse(s.data.get('decks'));latest[0].words.push({eng:'new',kor:'새 단어'});
  const raw=JSON.stringify(latest);s.data.set('decks',raw);
  s.run('flushDecks()');assert.equal(s.data.get('decks'),raw);
  s.run('words.push({eng:"local",kor:"이 창의 단어"})');
  assert.equal(s.run('saveDecks()'),false);assert.equal(s.data.get('decks'),raw);
  const key=[...s.data.keys()].find(k=>k.startsWith('workbook.unsaved.'));
  assert.equal(JSON.parse(s.data.get(key))[0].words[0].eng,'local');
});
test('user edits persist immediately without running timers',()=>{
  const s=setup();s.run('words.push({eng:"now",kor:"지금"});saveDeckData()');
  assert.equal(JSON.parse(s.data.get('decks'))[0].words[0].eng,'now');
});
test('sheet reload retains all saved examples and does not remove manually added words',()=>{
  const s=setup();Object.assign(s.context,{saveOnly(){return true;},render(){}});
  vm.runInContext(app.slice(app.indexOf('function parseCsv('),app.indexOf('// ===== 중복 단어 기록')),s.context);
  vm.runInContext(app.slice(app.indexOf('function exList('),app.indexOf('function showExample(')),s.context);
  s.run('words.push({eng:"cat",kor:"고양이",example:["local one","local two"]},{eng:"manual",kor:"직접 추가"});addFromCsvText("cat,고양이,sheet example","Sheet")');
  assert.equal(s.run('words.length'),2);assert.equal(s.run('words[0].example.join("|")'),'local one|local two|sheet example');
  s.run('addFromCsvText("cat,고양이,sheet example","Sheet")');assert.equal(s.run('words[0].example.length'),3);
});

function lexicalContext(fetcher){
  const c=vm.createContext({fetchT:fetcher,console});
  vm.runInContext(app.slice(app.indexOf('// ===== Explicit lexical relations'),app.indexOf('// ===== 예문 찾기')),c);
  vm.runInContext(app.slice(app.indexOf('const _dictionaryChecks='),app.indexOf('async function findBaseWord(')),c);
  return s=>vm.runInContext(s,c);
}
test('relations use two explicit endpoints, deduplicate taps and cache successful results',async()=>{
  const urls=[];const run=lexicalContext(async url=>{urls.push(url);return {ok:true,json:async()=>url.includes('rel_syn')?[{word:'happy'},{word:'Glad'},{word:'glad'},{}]:[{word:'sad'}]};});
  const results=await run('Promise.all([lookupRelations(" Happy "),lookupRelations("happy")])');
  assert.equal(urls.length,2);assert.ok(urls.every(u=>!u.includes('ml=')));
  assert.equal(results[0].syn.join(','),'glad');assert.equal(results[0].ant.join(','),'sad');
  await run('lookupRelations("happy")');assert.equal(urls.length,2);
});
test('temporary errors remain retryable and are not reported as confirmed empty results',async()=>{
  let calls=0,fail=true;const run=lexicalContext(async()=>{calls++;if(fail)return {ok:false,status:429};return {ok:true,json:async()=>[]};});
  assert.equal((await run('lookupRelations("unknown")')).failed,true);
  fail=false;assert.equal((await run('lookupRelations("unknown")')).failed,false);assert.equal(calls,4);
  await run('lookupRelations("unknown")');assert.equal(calls,4);
});
test('dictionary checks share pending work and do not cache transport errors',async()=>{
  let calls=0,fail=true;const run=lexicalContext(async()=>{calls++;if(fail)throw Error('offline');return {ok:true,status:200};});
  await assert.rejects(run('dictionaryHasWord("happy")'));
  fail=false;await run('Promise.all([dictionaryHasWord("happy"),dictionaryHasWord("happy")])');assert.equal(calls,2);
  await run('dictionaryHasWord("happy")');assert.equal(calls,2);
});
test('root heuristic does not silently discard unmatched letters',()=>{
  const c=vm.createContext({_ROOTSKIP:new Set(),_ROOTKEYS:['port'],_ROOT:{port:'carry'},_PREKEYS:[],_PRE:{},_SUFKEYS:['able'],_SUF:{able:'able'}});
  vm.runInContext(app.slice(app.indexOf('function analyzeRoots('),app.indexOf('// ===== 합성어 분해')),c);
  assert.equal(vm.runInContext('analyzeRoots("portable").length',c),2);
  assert.equal(vm.runInContext('analyzeRoots("portfolio").length',c),0);
});

function installEditHelpers(s){
  s.context.render=()=>{};
  vm.runInContext(app.slice(app.indexOf('function saveOnly('),app.indexOf('function duplicate(')),s.context);
  vm.runInContext(app.slice(app.indexOf('function exList('),app.indexOf('function showExample(')),s.context);
}
test('failed word edits restore all fields including multiple examples and missing properties',()=>{
  const s=setup();installEditHelpers(s);
  s.run('words.push({eng:"cat",kor:"고양이",example:["one","two"],note:[{eng:"kitten",kor:"새끼"}]});saveOnly()');
  const disk=s.data.get('decks');
  s.context.localStorage.setItem=()=>{throw Error('quota');};
  assert.equal(s.run('persistWordEdit(words[0],"dog","개",["new"])'),false);
  assert.equal(s.run('words[0].eng'),'cat');assert.equal(s.run('words[0].kor'),'고양이');
  assert.equal(s.run('words[0].example.join("|")'),'one|two');assert.equal(s.data.get('decks'),disk);
  s.run('words.push({eng:"bird",kor:"새"})');
  assert.equal(s.run('persistWordEdit(words[1],"bird","새",["new"])'),false);
  assert.equal(s.run('Object.hasOwn(words[1],"example")'),false);
});
test('conflicting edits roll back memory without overwriting newer disk data',()=>{
  const s=setup();installEditHelpers(s);s.run('words.push({eng:"cat",kor:"고양이",example:"old"});saveOnly()');
  const latest=JSON.parse(s.data.get('decks'));latest[0].words[0].example='other tab';const raw=JSON.stringify(latest);s.data.set('decks',raw);
  assert.equal(s.run('persistWordEdit(words[0],"cat","고양이",["unsaved"])'),false);
  assert.equal(s.run('words[0].example'),'old');assert.equal(s.data.get('decks'),raw);
});
test('successful word edits persist and remain after reopening',()=>{
  const s=setup();installEditHelpers(s);s.run('words.push({eng:"cat",kor:"고양이"});saveOnly()');
  assert.equal(s.run('persistWordEdit(words[0],"cat","새 뜻",["first","second"])'),true);
  const again=setup(Object.fromEntries(s.data));assert.equal(again.run('words[0].example.join("|")'),'first|second');assert.equal(again.run('words[0].kor'),'새 뜻');
});

function audioSetup(state='suspended',options={}){
  const instances=[],listeners={},played=[];
  const param=()=>({value:0,setValueAtTime(){},exponentialRampToValueAtTime(){}});
  class AudioContext{
    constructor(){this.state=state;this.currentTime=10;this.destination={};this.resumes=0;this.requests=[];instances.push(this);}
    createGain(){return {gain:param(),connect(){}};}
    createDynamicsCompressor(){return {threshold:param(),knee:param(),ratio:param(),attack:param(),release:param(),connect(){}};}
    createOscillator(){return {frequency:param(),connect(){},start:()=>played.push(this.state),stop(){}};}
    resume(){this.resumes++;return new Promise((resolve,reject)=>{
      const request={finish:()=>{this.state='running';resolve();},fail:()=>reject(Error('blocked'))};
      this.requests.push(request);this.finish=request.finish;this.fail=request.fail;
    });}
  }
  const document={hidden:!!options.hidden,addEventListener:(name,fn)=>listeners[name]=fn};
  const globals={window:{AudioContext,addEventListener:(name,fn)=>listeners[name]=fn},safeStorage:{getItem:()=>null},document};
  if(Object.hasOwn(options,'navigator'))globals.navigator=options.navigator;
  const context=vm.createContext(globals);
  vm.runInContext(app.slice(app.indexOf('// ===== 효과음'),app.indexOf('function applyTheme(')),context);
  return {instances,listeners,played,document,run:s=>vm.runInContext(s,context)};
}
test('effects wait for mobile audio resume before scheduling sound',async()=>{
  const s=audioSetup();const pending=s.run('playSound("tap")');
  assert.equal(s.played.length,0);s.instances[0].finish();await pending;
  assert.deepEqual(s.played,['running']);
});
test('interrupted audio resumes and concurrent effects share the request',async()=>{
  const s=audioSetup('interrupted');const first=s.run('playSound("tap")'),second=s.run('playSound("tap")');
  assert.equal(s.instances[0].resumes,1);s.instances[0].finish();await Promise.all([first,second]);
  assert.deepEqual(s.played,['running','running']);
});
test('failed audio resume stays retryable without rejecting button handlers',async()=>{
  const s=audioSetup();const first=s.run('playSound("tap")');s.instances[0].fail();await first;
  assert.equal(s.played.length,0);const second=s.run('playSound("tap")');
  assert.equal(s.instances[0].resumes,2);s.instances[0].finish();await second;assert.equal(s.played.length,1);
});
test('muting during audio resume prevents delayed playback',async()=>{
  const s=audioSetup();const pending=s.run('playSound("tap")');s.run('soundOn=false');s.instances[0].finish();await pending;
  assert.equal(s.played.length,0);
});
test('closed audio context is replaced and effects work again',async()=>{
  const s=audioSetup('running');await s.run('playSound("tap")');s.instances[0].state='closed';await s.run('playSound("tap")');
  assert.equal(s.instances.length,2);assert.deepEqual(s.played,['running','running']);
});
test('only a foreground gesture unlocks audio; returning to the app stays silent',async()=>{
  const s=audioSetup();const first=s.listeners.pointerdown({type:'pointerdown'});s.instances[0].finish();await first;
  s.instances[0].state='interrupted';s.listeners.visibilitychange();assert.equal(s.instances[0].resumes,1);
  const second=s.listeners.touchend({type:'touchend'});assert.equal(s.instances[0].resumes,2);
  s.instances[0].finish();await second;assert.equal(s.played.length,0);
  s.run('soundOn=false');s.instances[0].state='suspended';s.listeners.touchend({type:'touchend'});assert.equal(s.instances[0].resumes,2);
});
test('an iOS release gesture retries a blocked resume on the same context',async()=>{
  const s=audioSetup();const blocked=s.run('resumeAudio(getCtx())');
  assert.equal(s.instances[0].resumes,1);
  const released=s.listeners.pointerup({type:'pointerup'});
  assert.equal(s.instances.length,1);assert.equal(s.instances[0].resumes,2);
  s.instances[0].requests[1].finish();await released;
  await s.run('playSound("tap")');assert.deepEqual(s.played,['running']);
  s.instances[0].requests[0].finish();await blocked;
});
test('hidden apps neither request audio resume nor schedule effects',async()=>{
  const s=audioSetup('suspended',{hidden:true});
  await s.run('playSound("tap")');s.listeners.pointerup({type:'pointerup'});
  assert.equal(s.instances.length,0);assert.equal(s.played.length,0);
  s.document.hidden=false;s.listeners.visibilitychange();assert.equal(s.instances.length,0);
});
test('effects awaiting resume are discarded after the app goes into the background',async()=>{
  const s=audioSetup();const pending=s.run('playSound("tap")');
  s.document.hidden=true;s.listeners.visibilitychange();
  s.document.hidden=false;s.listeners.visibilitychange();
  assert.equal(s.instances[0].resumes,1);
  const released=s.listeners.pointerup({type:'pointerup'});assert.equal(s.instances[0].resumes,2);
  s.instances[0].requests[1].finish();await released;
  s.instances[0].requests[0].finish();await pending;
  assert.equal(s.played.length,0);
  await s.run('playSound("tap")');assert.deepEqual(s.played,['running']);
});
test('effects awaiting resume stay silent while the document is hidden',async()=>{
  const s=audioSetup();const pending=s.run('playSound("tap")');
  s.document.hidden=true;s.instances[0].finish();await pending;
  assert.equal(s.played.length,0);
});
test('initial pageshow preserves a user sound but history restoration drops stale effects',async()=>{
  const s=audioSetup();const initial=s.run('playSound("tap")');
  s.listeners.pageshow({persisted:false});s.instances[0].finish();await initial;
  assert.deepEqual(s.played,['running']);
  s.instances[0].state='suspended';const restored=s.run('playSound("tap")');
  s.listeners.pageshow({persisted:true});s.instances[0].finish();await restored;
  assert.deepEqual(s.played,['running']);
});
test('audio recovery preserves the browser audio category and other media',async()=>{
  const categories=[];const audioSession={set type(value){categories.push(value);}};
  const s=audioSetup('suspended',{navigator:{audioSession}});
  const pending=s.listeners.click({type:'click'});s.instances[0].finish();await pending;
  await s.run('playSound("tap")');assert.deepEqual(s.played,['running']);assert.deepEqual(categories,[]);
});

function speechSetup({supported=true,paused=false}={}){
  const utterances=[],calls=[],timers=[];let inGesture=false;
  class SpeechSynthesisUtterance{
    constructor(text){this.text=text;utterances.push(this);}
  }
  const speechSynthesis={paused,cancel(){calls.push('cancel');},resume(){calls.push('resume');this.paused=false;},speak(utterance){
    assert.equal(inGesture,true,'speech must be queued before the user gesture ends');calls.push(utterance);
  }};
  const window=supported?{speechSynthesis}:{};
  const context=vm.createContext({window,speechSynthesis,SpeechSynthesisUtterance,console,
    setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},
    currentIndex:0,words:[{eng:'cat',kor:'고양이'}],cardDir:'e2k',speakMode:'eng',
    safeStorage:{setItem(){}},updateSpeakBtns(){},alert(){}});
  vm.runInContext(app.slice(app.indexOf('// ===== 음성 읽기'),app.indexOf('function updateSpeakBtns(')),context);
  const run=s=>vm.runInContext(s,context);
  return {utterances,calls,timers,speechSynthesis,run,gesture(s){
    inGesture=true;try{return run(s);}finally{inGesture=false;}
  }};
}
test('word and text speech are queued while the initiating gesture is active',()=>{
  const s=speechSetup();s.gesture('speakWord()');
  assert.equal(s.calls[0],'cancel');assert.equal(s.calls[1].text,'cat');assert.equal(s.calls[1].lang,'en-US');
  s.gesture('speakText("hello")');
  assert.equal(s.calls[2],'cancel');assert.equal(s.calls[3].text,'hello');assert.equal(s.calls[3].lang,'en-US');
  assert.equal(s.timers.length,0);
});
test('paused speech resumes and both languages are queued in card order',()=>{
  const s=speechSetup({paused:true});s.gesture('speakWord("both")');
  assert.equal(s.calls[0],'cancel');assert.equal(s.calls[1],'resume');
  assert.deepEqual(s.calls.slice(2).map(u=>[u.text,u.lang]),[['cat','en-US'],['고양이','ko-KR']]);
  s.run('cardDir="k2e"');s.gesture('speakWord("both")');
  assert.deepEqual(s.calls.slice(5).map(u=>[u.text,u.lang]),[['고양이','ko-KR'],['cat','en-US']]);
});
test('queued speech remains retained until end or error and canceled speech is released',()=>{
  const s=speechSetup();assert.equal(s.gesture('speakUtterances([{text:"cat",lang:"en-US"},{text:"고양이",lang:"ko-KR"}])'),true);
  assert.equal(s.run('activeUtterances.length'),2);
  s.utterances[0].onend();assert.equal(s.run('activeUtterances.length'),1);
  s.utterances[1].onerror();assert.equal(s.run('activeUtterances.length'),0);
  s.gesture('speakText("old")');const canceled=s.utterances.at(-1);
  s.gesture('speakText("new")');assert.equal(s.run('activeUtterances.length'),1);
  canceled.onend();assert.equal(s.run('activeUtterances.length'),1);
  s.utterances.at(-1).onend();assert.equal(s.run('activeUtterances.length'),0);
});
test('unsupported speech fails quietly without queuing delayed work',()=>{
  const s=speechSetup({supported:false});
  assert.equal(s.gesture('speakUtterances([{text:"cat",lang:"en-US"}])'),false);
  s.gesture('speakText("cat")');assert.equal(s.calls.length,0);assert.equal(s.timers.length,0);
});

function themeDocument(){
  const root={dataset:{},style:{}};
  const metas=Object.fromEntries(['theme-color','color-scheme'].map(name=>[name,{content:'',setAttribute(key,value){this[key]=value;}}]));
  const document={documentElement:root,querySelector:selector=>{
    const name=selector.match(/meta\[name=["']([^"']+)["']\]/)?.[1];
    return metas[name]??null;
  }};
  return {document,root,metas};
}
function assertTheme(s,isDark){
  const scheme=isDark?'dark':'light',color=isDark?'#101216':'#e8eaed';
  assert.equal(s.root.dataset.theme,scheme);
  assert.equal(s.root.style.colorScheme,scheme);
  assert.equal(s.root.style.backgroundColor,color);
  assert.equal(s.metas['theme-color'].content,color);
  assert.equal(s.metas['color-scheme'].content,scheme);
}
function initialTheme({saved=null,systemDark=false,denied=false}={}){
  const s=themeDocument();
  const bootstrap=scripts.find(script=>script.includes('첫 화면 테마'));
  assert.ok(bootstrap,'the first-paint theme must initialize in the document head');
  assert.ok(html.indexOf('첫 화면 테마')<html.indexOf('<style'),'theme must be selected before styles render');
  const localStorage={getItem(key){assert.equal(key,'darkMode');if(denied)throw Error('denied');return saved;}};
  const window={localStorage,matchMedia:query=>{
    assert.equal(query,'(prefers-color-scheme: dark)');return {matches:systemDark};
  }};
  vm.runInContext(bootstrap,vm.createContext({localStorage,window,document:s.document}));
  return s;
}
test('saved app theme sets system UI colors before first paint and overrides the phone theme',()=>{
  assertTheme(initialTheme({saved:'1',systemDark:false}),true);
  assertTheme(initialTheme({saved:'0',systemDark:true}),false);
});
test('first launch follows the phone theme when no app preference has been saved',()=>{
  assertTheme(initialTheme({systemDark:true}),true);
  assertTheme(initialTheme({systemDark:false}),false);
});
test('unavailable storage still applies the phone theme before first paint',()=>{
  assertTheme(initialTheme({denied:true,systemDark:true}),true);
  assertTheme(initialTheme({denied:true,systemDark:false}),false);
});
test('changing app theme keeps document background and system UI metadata in sync',()=>{
  const s=themeDocument();
  const classes=new Set();
  s.document.body={classList:{
    add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name),
    toggle(name,force){const active=force??!classes.has(name);if(active)classes.add(name);else classes.delete(name);return active;}
  }};
  const context=vm.createContext({document:s.document});
  vm.runInContext(app.slice(app.indexOf('function applyTheme('),app.indexOf('function toggleDark(')),context);
  vm.runInContext('applyTheme(true)',context);assertTheme(s,true);
  vm.runInContext('applyTheme(false)',context);assertTheme(s,false);
});

test('switching decks keeps restored study ranges visible and filters the same numbers',()=>{
  const deckWords=Array.from({length:30},(_,i)=>({eng:'word'+i,kor:'뜻'+i}));
  const s=setup({decks:JSON.stringify([{id:'a',name:'A',words:[]},{id:'b',name:'B',words:deckWords}]),activeDeckId:'a'});
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{value:'',style:{},classList:{remove(){}}});
    return elements.get(id);
  };
  Object.assign(s.context,{rangeMemo:{b:[11,20]},rangeFrom:null,rangeTo:null,RANGE_STEPS:[10],rangeStepIdx:0,
    lsPeeked:new Set(),lsSelected:new Set(),wlSelected:new Set(),
    render(){},renderDeckPanel(){},renderRecentDecks(){},showCardActions(){},showTab(){}});
  s.context.document.getElementById=element;
  for(const [start,end] of [
    ['function clampRange(','function bulkDelete('],
    ['function restoreRangeMemo(','// ===== 음성 읽기'],
    ['function updateRangeCnt(','// ===== 학습취소'],
    ['function getDeck(','function randomMode('],
    ['function switchDeck(','function createDeck(']
  ])vm.runInContext(app.slice(app.indexOf(start),app.indexOf(end)),s.context);
  s.run('switchDeck("b")');
  assert.equal(element('rangeFrom').value,11);assert.equal(element('rangeTo').value,20);
  assert.equal(s.run('getDeck("all").map(x=>x.num).join(",")'),'11,12,13,14,15,16,17,18,19,20');
  s.run('switchDeck("a")');
  assert.equal(element('rangeFrom').value,'');assert.equal(element('rangeTo').value,'');
});

test('opening an editor during an autoplay countdown pauses completion until the dialog closes',()=>{
  const timers=new Map();let nextTimer=0,open=false,advances=0;
  const word={mastered:false};
  const context=vm.createContext({autoPlay:true,currentIndex:0,autoPlaySpeed:3,autoPlayTimer:null,
    clearTimeout:id=>timers.delete(id),setTimeout:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},
    anyDialogOpen:()=>open,nextCard:()=>{word.mastered=true;advances++;}});
  vm.runInContext(app.slice(app.indexOf('function scheduleAutoPlay('),app.indexOf('function toggleAutoPlay(')),context);
  const fireNext=()=>{const [id,timer]=timers.entries().next().value;timers.delete(id);timer.fn();};
  vm.runInContext('scheduleAutoPlay()',context);
  open=true;fireNext();
  assert.equal(word.mastered,false);assert.equal(advances,0);
  fireNext();assert.equal(advances,0);
  open=false;fireNext();assert.equal(advances,0);
  fireNext();assert.equal(word.mastered,true);assert.equal(advances,1);
});

function exampleFillSetup(){
  let input={value:''},complete;
  const toasts=[];
  const context=vm.createContext({_editTarget:null,
    document:{getElementById:()=>input},showToast:message=>toasts.push(message),
    getExamples:()=>new Promise(resolve=>{complete=resolve;})});
  vm.runInContext(app.slice(app.indexOf('let _exFillIdx='),app.indexOf('function cardClick(')),context);
  return {context,toasts,get input(){return input;},replace(next){input=next;},
    request:()=>vm.runInContext('exampleFill("lsEditEx","cat")',context),
    finish:()=>complete([{en:'A cat example.'}])};
}
test('pending examples do not fill another word after a list editor is reopened',async()=>{
  const s=exampleFillSetup(),old=s.input,pending=s.request();
  s.replace({value:'Dog draft.'});s.finish();await pending;
  assert.equal(old.value,'');assert.equal(s.input.value,'Dog draft.');
  assert.equal(s.toasts.some(message=>message.includes('예문을 채웠어요')),false);
});
test('pending examples preserve text entered by the user while lookup runs',async()=>{
  const s=exampleFillSetup(),pending=s.request();
  s.input.value='My own example.';s.finish();await pending;
  assert.equal(s.input.value,'My own example.');
});
test('successful examples still fill the original untouched editor',async()=>{
  const s=exampleFillSetup(),pending=s.request();s.finish();await pending;
  assert.equal(s.input.value,'A cat example.');
  assert.equal(s.toasts.some(message=>message.includes('예문을 채웠어요')),true);
});

function rootAnalysisSetup(){
  const context=vm.createContext({});
  vm.runInContext(app.slice(app.indexOf('const _PRE='),app.indexOf('// ===== 합성어 분해')),context);
  return word=>JSON.parse(vm.runInContext('JSON.stringify(analyzeRoots('+JSON.stringify(word)+'))',context));
}
test('root hints retain a whole root when a longer suffix would hide it',()=>{
  const analyze=rootAnalysisSetup();
  for(const [word,root] of [['tension','tens'],['extension','tens'],['prediction','dict'],['diction','dict'],['question','quest']]){
    const parts=analyze(word);
    assert.equal(parts.find(part=>part.t==='root').p,root,word);
    assert.equal(parts.map(part=>part.p).join(''),word,word);
  }
});
test('layered roots remain available for common prefixes and inflected derivatives',()=>{
  const analyze=rootAnalysisSetup();
  for(const [word,root] of [['unpredictable','dict'],['reconstruction','struct'],['aggregates','greg'],['congregations','greg'],['attractively','tract'],['artists','art']]){
    const parts=analyze(word);
    assert.equal(parts.find(part=>part.t==='root').p,root,word);
    assert.equal(parts.map(part=>part.p).join(''),word,word);
  }
  assert.equal(analyze('aggregates').at(-1).g,'~들(복수·3인칭)');
});
test('layered matching still rejects unknown tails, unrelated words and standalone roots',()=>{
  const analyze=rootAnalysisSetup();
  for(const word of ['portfolio','portablex','unpredictablexyz','mother','summer','person','personally','personalize','reason','reasonable','season','seasonally','general','generous','generation','greg','port'])
    assert.deepEqual(analyze(word),[],word);
  assert.equal(analyze('portable').find(part=>part.t==='root').p,'port');
});

function backupRestoreSetup(backup){
  const initialDecks=[{id:'a',name:'A',words:[{eng:'original',kor:'기존 단어',example:['Old.']}],stats:{old:1},dupes:[]},
    {id:'b',name:'B',words:[{eng:'other',kor:'다른 단어'}],stats:{},dupes:[]}];
  const s=setup({decks:JSON.stringify(initialDecks),activeDeckId:'a',recentDeckIds:'["a","b"]'});
  const toasts=[],calls={confirm:0,reset:0,render:0};
  s.context.document.getElementById=()=>({value:JSON.stringify(backup)});
  Object.assign(s.context,{currentIndex:0,showToast:message=>toasts.push(message),
    needConfirm2(){calls.confirm++;return true;},afterWordsRemoved(){calls.reset++;},resetCardView(){calls.reset++;},
    render(){calls.render++;},renderDeckPanel(){calls.render++;},renderRecentDecks(){calls.render++;}});
  s.run('editIndex=0;const beforeRestore={decks,words,stats,dupes,activeDeckId,recentDeckIds};');
  vm.runInContext(app.slice(app.indexOf('function prepareBackupRestore('),app.indexOf('function matchQ(')),s.context);
  return {...s,toasts,calls,originalDisk:s.data.get('decks'),
    assertOriginal(){
      assert.equal(s.run('decks===beforeRestore.decks&&words===beforeRestore.words&&stats===beforeRestore.stats&&dupes===beforeRestore.dupes&&activeDeckId===beforeRestore.activeDeckId&&recentDeckIds===beforeRestore.recentDeckIds'),true);
      assert.equal(s.run('currentIndex'),0);assert.equal(s.run('editIndex'),0);
      assert.equal(calls.reset,0);assert.equal(calls.render,0);
    }};
}
test('malformed full backups are rejected before confirmation or changes to memory and disk',()=>{
  const validDeck={id:'restore',name:'Restore',words:[{eng:'cat',kor:'고양이'}]};
  for(const badDeck of [null,{...validDeck,words:null},{...validDeck,words:[null]},
    {...validDeck,words:[{eng:7,kor:'고양이'}]},{...validDeck,words:[{eng:'cat',kor:42}]},
    {...validDeck,name:7},{...validDeck,stats:[]},{...validDeck,dupes:[null]}]){
    const s=backupRestoreSetup({version:2,decks:[validDeck,badDeck]});
    s.run('restoreBackup()');s.assertOriginal();
    assert.equal(s.data.get('decks'),s.originalDisk);assert.equal(s.calls.confirm,0);assert.equal(s.alerts.length,1);
  }
  const s=backupRestoreSetup({version:2,decks:[],words:[{eng:'cat',kor:'고양이'}]});
  s.run('restoreBackup()');s.assertOriginal();assert.equal(s.calls.confirm,0);
});
test('malformed legacy backups preserve all current data instead of partially restoring words',()=>{
  for(const words of [null,[null],[{eng:'cat',kor:42}],[{eng:7,kor:'고양이'}],[{eng:'cat',kor:'고양이'},null]]){
    const s=backupRestoreSetup({words});s.run('restoreBackup()');s.assertOriginal();
    assert.equal(s.data.get('decks'),s.originalDisk);assert.equal(s.calls.confirm,0);assert.equal(s.alerts.length,1);
  }
});
test('quota failures roll back both full and legacy restores without resetting the current study',()=>{
  for(const backup of [
    {version:2,decks:[{id:'restore',name:'Restore',words:[{eng:'new',kor:'새 단어'}]}]},
    {words:[{eng:'new',kor:'새 단어'}],stats:{new:1}}
  ]){
    const s=backupRestoreSetup(backup);s.context.localStorage.setItem=()=>{throw Error('quota');};
    assert.equal(s.run('restoreBackup()'),false);s.assertOriginal();
    assert.equal(s.data.get('decks'),s.originalDisk);
    assert.equal(s.toasts.some(message=>message.includes('복원했어요')),false);
  }
});
test('conflicting restores preserve newer disk data and roll back memory',()=>{
  const s=backupRestoreSetup({decks:[{id:'restore',words:[{eng:'new',kor:'새 단어'}]}]});
  const newer=JSON.parse(s.originalDisk);newer[0].words.push({eng:'other tab',kor:'다른 창'});
  const raw=JSON.stringify(newer);s.data.set('decks',raw);
  assert.equal(s.run('restoreBackup()'),false);s.assertOriginal();
  assert.equal(s.data.get('decks'),raw);assert.equal(s.toasts.some(message=>message.includes('복원했어요')),false);
});
test('valid backups retain multiple examples, structured notes and custom fields after reopening',()=>{
  const word={eng:'cat',kor:'고양이',example:['First.','Second.'],note:[{eng:'kitten',kor:'새끼 고양이'}],custom:{tag:'keep'}};
  for(const allDecks of [true,false]){
    const backup=allDecks?{decks:[{id:'restore',name:'Restore',words:[word],customDeck:{color:'blue'}}],activeDeckId:'restore'}:{words:[word],stats:{restored:2}};
    const s=backupRestoreSetup(backup);assert.equal(s.run('restoreBackup()'),true);
    const again=setup(Object.fromEntries(s.data));
    assert.deepEqual(JSON.parse(again.run('JSON.stringify(words[0].example)')),word.example);
    assert.deepEqual(JSON.parse(again.run('JSON.stringify(words[0].note)')),word.note);
    assert.deepEqual(JSON.parse(again.run('JSON.stringify(words[0].custom)')),word.custom);
    if(allDecks)assert.equal(again.run('decks[0].customDeck.color'),'blue');
    else{assert.equal(again.run('decks[1].words[0].eng'),'other');assert.equal(again.run('stats.restored'),2);}
    assert.equal(s.calls.reset,2);assert.equal(s.calls.render,3);
  }
});
test('restored deck IDs are safe and distinct and the selected deck follows its original ID',()=>{
  const s=backupRestoreSetup({decks:[
    {id:'a!',name:'First',words:[{eng:'first',kor:'첫째'}]},
    {id:'a?',name:'Second',words:[{eng:'second',kor:'둘째'}]},
    {id:'"',name:'Third',words:[]},{id:'"',name:'Fourth',words:[]}
  ],activeDeckId:'a?'});
  assert.equal(s.run('restoreBackup()'),true);
  const ids=JSON.parse(s.run('JSON.stringify(decks.map(d=>d.id))'));
  assert.equal(new Set(ids).size,4);assert.ok(ids.every(id=>/^[a-zA-Z0-9_-]+$/.test(id)));
  assert.equal(s.run('activeDeckId'),ids[1]);assert.equal(s.run('words[0].eng'),'second');
  const again=setup(Object.fromEntries(s.data));assert.equal(again.run('words[0].eng'),'second');
});

function morphologySetup(decks=[],fetcher=async()=>{throw Error('offline');},options={}){
  const toasts=[],dialog={open:false,shows:0,showModal(){this.open=true;this.shows++;}},title={textContent:''},body={innerHTML:''};
  if(options.unsupportedDialog)delete dialog.showModal;
  const elements={etymologyDialog:options.missingDialog?null:dialog,etymologyTitle:title,etymologyBody:body};
  const context=vm.createContext({decks,activeDeckId:decks[0]?.id||'a',words:decks[0]?.words||[],fetchT:fetcher,
    document:{getElementById:id=>elements[id]||null},showToast:message=>toasts.push(message)});
  vm.runInContext(app.slice(app.indexOf('function escapeHtml('),app.indexOf('// 캐시 무효화 파라미터 추가')),context);
  vm.runInContext(app.slice(app.indexOf('const _PRE='),app.indexOf('// 카드 안 남은 공간')),context);
  return {run:source=>vm.runInContext(source,context),toasts,
    html:word=>vm.runInContext('rootsHtml('+JSON.stringify(word)+')',context),
    open(word){
      vm.runInContext('openEtymology('+JSON.stringify(word)+')',context);
      return {title:title.textContent,body:body.innerHTML,open:dialog.open,shows:dialog.shows};
    },
    hint:word=>JSON.parse(vm.runInContext('JSON.stringify(etymologyHint('+JSON.stringify(word)+'))',context))};
}
test('greg family memory hints work offline even when the card already exists in a deck',()=>{
  let calls=0;
  const s=morphologySetup([{id:'a',words:[{eng:'gregarious',kor:'사교적인'},{eng:'egregious',kor:'터무니없는'}]}],async()=>{calls++;throw Error('offline');});
  assert.match(s.html('gregarious'),/어원·암기/);
  assert.match(s.html('gregarious'),/greg<\/b>\(무리·모이다\)/);
  assert.match(s.html('gregarious'),/무리에 어울리는 → 사교적인/);
  assert.match(s.html('egregious'),/무리 밖으로 두드러진다는 뜻에서 → 지독한·터무니없는/);
  const modal=s.open('egregious');
  assert.equal(modal.open,true);assert.equal(modal.title,'egregious · 어원·암기');
  assert.match(modal.body,/>gregarious<\/button>/);
  assert.match(modal.body,/>aggregate<\/button>/);assert.match(modal.body,/>segregate<\/button>/);
  assert.match(modal.body,/한데 모으다/);assert.match(modal.body,/무리에서 떼어 놓다/);
  assert.match(modal.body,/라틴어 grex, gregis/);
  assert.equal(calls,0);
});
test('common missing word families now show useful memory hints instead of unrelated splits',()=>{
  const s=morphologySetup();
  for(const [word,meaning] of [['biology','생물학'],['photography','사진 촬영'],['unpredictable','예측 불가능한'],['valuable','가치가 있는'],['reduce','되돌려 줄이다'],['benefit','혜택']]){
    const html=s.html(word);
    assert.match(html,/어원·암기/,word);assert.ok(html.includes(meaning),word);
    assert.ok(html.includes('관련 단어'),word);assert.ok(html.includes('어원 출처'),word);
    assert.ok(html.includes('https://en.wiktionary.org/wiki/'+word+'#Etymology'),word);
    const modal=s.open(word);
    assert.equal(modal.open,true,word);assert.match(modal.body,/같은 어근[\s\S]*<button/,word);
    assert.ok(modal.body.includes(meaning),word);
  }
  assert.match(s.html('display'),/접힌 것을 펼쳐 보이다/);
  assert.doesNotMatch(s.html('display'),/play<\/b>|놀다/);
  assert.match(s.html('salty'),/salt\(소금\) \+ y\(~한\) → 짠/);
  assert.doesNotMatch(s.html('salty'),/뛰다|~성질\(명사\)/);
});
test('common inflections retain the correct curated lemma and its source',()=>{
  const s=morphologySetup();
  for(const [word,lemma] of [['aggregates','aggregate'],['aggregated','aggregate'],['aggregating','aggregate'],['congregations','congregation'],['incredibly','incredible'],['predictably','predictable'],['gregariously','gregarious'],['gregariousness','gregarious'],['unpredictability','unpredictable'],['flexibility','flexible'],['portability','portable']]){
    assert.equal(s.hint(word).word,lemma,word);
    const html=s.html(word);
    assert.match(html,/어원·암기/,word);
    assert.ok(html.includes(lemma+'의 어형'),word);
    assert.ok(html.includes('/wiki/'+lemma+'#Etymology'),word);
  }
});
test('ordinary phrase explanations remain available without inventing historical hints for unknown words',()=>{
  const s=morphologySetup();
  const phrase=s.html('go over');
  assert.match(phrase,/구성 추정/);assert.match(phrase,/go<\/b>/);assert.match(phrase,/over<\/b>/);
  assert.doesNotMatch(phrase,/어원·암기/);
  for(const word of ['grag','portfolio']){
    assert.equal(s.hint(word),null,word);assert.equal(s.html(word),'',word);
  }
});
test('every curated memory note has a defined family, useful explanation and valid related entries',()=>{
  const s=morphologySetup();
  const {families,hints}=JSON.parse(s.run('JSON.stringify({families:_ETYMOLOGY_FAMILIES,hints:_ETYMOLOGY_HINTS})'));
  for(const [word,[family,memory]] of Object.entries(hints)){
    assert.ok(families[family],word);
    assert.equal(typeof memory,'string',word);assert.ok(memory.trim().length>4,word);
    assert.ok(memory.includes('→'),word);
  }
  for(const [key,family] of Object.entries(families)){
    for(const field of ['root','meaning','origin'])assert.ok(typeof family[field]==='string'&&family[field].trim(),key+' '+field);
    assert.ok(family.words.length>=2,key);
    assert.equal(new Set(family.words).size,family.words.length,key);
    for(const related of family.words)assert.ok(hints[related],key+' '+related);
  }
});
test('ordinary dictionary keys are not mistaken for inherited JavaScript properties',()=>{
  const s=morphologySetup();
  assert.equal(s.hint('constructor'),null);assert.equal(s.hint('constructors'),null);
  assert.match(s.html('constructor'),/struct/);
  assert.equal(s.open('constructor').open,false);
});
test('known false base-word matches cannot trigger dictionary requests or reuse unrelated deck words',async()=>{
  let calls=0;
  const s=morphologySetup([{id:'a',words:[{eng:'flow',kor:'흐르다'},{eng:'sum',kor:'합'},{eng:'corn',kor:'옥수수'}]}],async()=>{calls++;return {ok:true,status:200};});
  for(const word of ['flower','summer','corner','seven','seventy'])
    assert.equal(await s.run('findBaseWord('+JSON.stringify(word)+')'),null,word);
  assert.equal(calls,0);
});
test('unknown words cannot open or populate the related-word dialog',()=>{
  const s=morphologySetup();
  for(const word of ['grag','portfolio','go over']){
    const modal=s.open(word);
    assert.equal(modal.open,false,word);assert.equal(modal.shows,0,word);
    assert.equal(modal.title,'',word);assert.equal(modal.body,'',word);
  }
  assert.deepEqual(s.toasts,[]);
});
test('related-word details fall back to the useful memory note when native dialogs are unavailable',()=>{
  for(const options of [{missingDialog:true},{unsupportedDialog:true}]){
    const s=morphologySetup([],undefined,options),modal=s.open('gregarious');
    assert.equal(modal.open,false);assert.equal(modal.shows,0);
    assert.equal(modal.title,'');assert.equal(modal.body,'');
    assert.deepEqual(s.toasts,['무리에 어울리는 → 사교적인']);
  }
});

function backupExportSetup(failure=''){
  const s=setup(),box={value:''},toasts=[],timers=[],revoked=[];
  let blob,anchor,attached=false,clickedWhileAttached=false;
  s.run('words.push({eng:"cat",kor:"고양이",example:["First.","Second."]})');
  Object.assign(s.context,{Blob,showToast:message=>toasts.push(message),
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},
    URL:{createObjectURL(value){if(failure==='create')throw Error('unsupported');blob=value;return 'blob:backup';},
      revokeObjectURL:url=>revoked.push(url)}});
  s.context.document.getElementById=()=>box;
  s.context.document.body={appendChild(value){assert.equal(value,anchor);attached=true;}};
  s.context.document.createElement=()=>{
    anchor={style:{},click(){clickedWhileAttached=attached;if(failure==='click')throw Error('blocked');},remove(){attached=false;}};
    return anchor;
  };
  vm.runInContext(app.slice(app.indexOf('function exportBackup('),app.indexOf('function prepareBackupRestore(')),s.context);
  return {...s,box,toasts,timers,revoked,get blob(){return blob;},get anchor(){return anchor;},
    get attached(){return attached;},get clickedWhileAttached(){return clickedWhileAttached;}};
}
test('backup export requests a download with an attached anchor and releases its URL afterward',async()=>{
  const s=backupExportSetup();s.run('exportBackup()');
  assert.equal(s.clickedWhileAttached,true);assert.equal(s.attached,false);
  assert.equal(s.anchor.href,'blob:backup');assert.equal(s.anchor.download,'wordbook-backup.json');
  const data=JSON.parse(s.box.value);assert.equal(data.version,2);assert.equal(data.decks[0].words[0].eng,'cat');
  assert.deepEqual(data.decks[0].words[0].example,['First.','Second.']);
  assert.equal(await s.blob.text(),s.box.value);
  assert.equal(s.toasts.length,1);assert.match(s.toasts[0],/다운로드를 요청/);assert.match(s.toasts[0],/확인/);
  assert.deepEqual(s.revoked,[]);assert.equal(s.timers.length,1);assert.equal(s.timers[0].ms,60000);
  s.timers[0].fn();assert.deepEqual(s.revoked,['blob:backup']);
});
test('backup export failures preserve copyable JSON and explain the fallback instead of claiming success',()=>{
  for(const failure of ['create','click']){
    const s=backupExportSetup(failure);s.run('exportBackup()');
    assert.equal(JSON.parse(s.box.value).decks[0].words[0].eng,'cat');
    assert.equal(s.toasts.length,1);assert.match(s.toasts[0],/실패/);assert.match(s.toasts[0],/복사/);
    assert.equal(s.attached,false);assert.deepEqual(s.revoked,[]);
    if(failure==='click'){
      assert.equal(s.clickedWhileAttached,true);assert.equal(s.timers.length,1);
      s.timers[0].fn();assert.deepEqual(s.revoked,['blob:backup']);
    }else assert.equal(s.timers.length,0);
  }
});

function startupStorageFault(initial={},beforeRead=()=>{}){
  const data=new Map(Object.entries(initial)),reads=new Map(),writes=[],alerts=[],timers=[];
  const context=vm.createContext({
    localStorage:{
      getItem(key){
        const count=(reads.get(key)||0)+1;reads.set(key,count);
        beforeRead(key,count,data);
        return data.get(key)??null;
      },
      setItem(key,value){data.set(key,String(value));writes.push(key);},
      removeItem(key){data.delete(key);}
    },
    alert:message=>alerts.push(message),setTimeout:fn=>{timers.push(fn);},clearTimeout(){},
    window:{addEventListener(){}},document:{addEventListener(){}},
    invalidateWordIndex(){},showToast(){},console
  });
  vm.runInContext(app.slice(app.indexOf('// Storage access'),app.indexOf('// ===== 앱 자체 확인창')),context);
  return {data,reads,writes,alerts,timers,context,run:source=>vm.runInContext(source,context)};
}
test('one failed startup deck read cannot overwrite existing examples and notes after reads recover',()=>{
  const original=JSON.stringify([{id:'saved',name:'Saved',words:[{eng:'cat',kor:'고양이',
    example:['First saved example.','Second saved example.'],note:[{eng:'kitten',kor:'헷갈리는 단어'}]}],stats:{},dupes:[]}]);
  const initial={decks:original,activeDeckId:'saved'};
  const s=startupStorageFault(initial,(key,count)=>{if(key==='decks'&&count===1)throw Error('temporary read failure');});
  assert.deepEqual(Object.fromEntries(s.data),initial);
  assert.equal(s.run('safeStorage.getItem("decks")'),original);
  assert.equal(s.run('flushDecks()'),false);
  s.run('words.push({eng:"new",kor:"새 단어"})');
  assert.equal(s.run('saveDeckData()'),false);
  assert.equal(s.run('safeStorage.removeItem("decks")'),false);
  assert.deepEqual(Object.fromEntries(s.data),initial);
  s.timers.forEach(fn=>fn());assert.equal(s.alerts.length,1);
  const reopened=setup(Object.fromEntries(s.data));
  assert.equal(reopened.run('words[0].example.length'),2);
  assert.equal(reopened.run('words[0].note[0].eng'),'kitten');
});
test('a failed legacy read never creates empty persistent decks or removes the legacy originals',()=>{
  const initial={
    words:JSON.stringify([{eng:'cat',kor:'고양이',example:['one','two'],note:[{eng:'kitten',kor:'새끼'}],wrong:false,mastered:false}]),
    stats:JSON.stringify({correct:3}),dupes:JSON.stringify([{eng:'cat',sheets:['Sheet'],n:1}]),activeDeckId:'legacy'
  };
  for(const failedKey of ['words','stats','dupes']){
    const s=startupStorageFault(initial,(key,count)=>{if(key===failedKey&&count===1)throw Error('temporary read failure');});
    assert.deepEqual(Object.fromEntries(s.data),initial);
    assert.equal(s.data.has('decks'),false);
    assert.equal(s.run('safeStorage.getItem('+JSON.stringify(failedKey)+')'),initial[failedKey]);
    assert.equal(s.run('flushDecks()'),false);
    assert.equal(s.run('saveDeckData()'),false);
    assert.deepEqual(Object.fromEntries(s.data),initial);
    assert.equal(s.writes.length,0);
    const reopened=setup(Object.fromEntries(s.data));
    assert.equal(reopened.run('words[0].example.join("|")'),'one|two');
    assert.equal(reopened.run('words[0].note[0].eng'),'kitten');
    assert.equal(reopened.run('stats.correct'),3);
  }
});
test('the startup comparison baseline is the loaded deck snapshot even when another window saves during initialization',()=>{
  const original=JSON.stringify([{id:'saved',name:'Saved',words:[{eng:'cat',kor:'고양이',example:['one','two']}],stats:{},dupes:[]}]);
  const updated=JSON.parse(original);updated[0].words.push({eng:'dog',kor:'다른 창에서 추가'});
  const latest=JSON.stringify(updated);
  const s=startupStorageFault({decks:original,activeDeckId:'saved'},(key,count,data)=>{
    if(key==='activeDeckId'&&count===1)data.set('decks',latest);
  });
  assert.equal(s.run('words.length'),1);
  assert.equal(s.run('_diskDecks'),original);
  assert.equal(s.run('flushDecks()'),false);
  assert.equal(s.data.get('decks'),latest);
  s.run('words[0].example.push("Local addition")');
  assert.equal(s.run('saveDeckData()'),false);
  assert.equal(s.data.get('decks'),latest);
  assert.equal(JSON.parse(s.data.get('decks'))[0].words.length,2);
  const conflict=[...s.data.keys()].find(key=>key.startsWith('workbook.unsaved.'));
  assert.ok(conflict);
  assert.equal(JSON.parse(s.data.get(conflict))[0].words[0].example.at(-1),'Local addition');
});
test('an interrupted fresh migration cannot replace a deck saved by another window',()=>{
  const latest=JSON.stringify([{id:'other',name:'Other window',words:[{eng:'cat',kor:'고양이',note:[{eng:'kitten',kor:'새끼'}]}],stats:{},dupes:[]}]);
  const s=startupStorageFault({},(key,count,data)=>{if(key==='decks'&&count===2)data.set('decks',latest);});
  assert.equal(s.data.get('decks'),latest);
  assert.equal(s.run('flushDecks()'),false);
  assert.equal(s.data.get('decks'),latest);
  assert.equal(JSON.parse(s.data.get('decks'))[0].words[0].note[0].eng,'kitten');
});
test('successful first migration records its written snapshot and saves later registration immediately',()=>{
  const s=startupStorageFault();
  assert.equal(s.run('_diskDecks'),s.data.get('decks'));
  assert.equal(s.run('flushDecks()'),true);
  s.run('words.push({eng:"cat",kor:"고양이",example:["one","two"],note:[{eng:"kitten",kor:"새끼"}]})');
  assert.equal(s.run('saveDeckData()'),true);
  const reopened=setup(Object.fromEntries(s.data));
  assert.equal(reopened.run('words[0].example.join("|")'),'one|two');
  assert.equal(reopened.run('words[0].note[0].eng'),'kitten');
});

function noteEditorSetup(note=[{eng:'old',kor:'기존 메모'}]){
  const word={eng:'cat',kor:'고양이',example:['First.','Second.']};
  if(note!==undefined) word.note=note;
  const s=setup({decks:JSON.stringify([{id:'a',name:'A',words:[word],stats:{},dupes:[]}]),activeDeckId:'a'});
  installEditHelpers(s);
  const rows=[],toasts=[],sounds=[],listeners={},classes=new Set();
  const modal={classList:{contains:x=>classes.has(x),add:x=>classes.add(x),remove:x=>classes.delete(x)}};
  const box={set innerHTML(value){rows.length=0;},querySelector:()=>rows[0]?.inputs[0]};
  const elements={noteBack:modal,noteRows:box,noteTitle:{},noteDelBtn:{style:{}}};
  s.context.document.getElementById=id=>elements[id];
  s.context.document.querySelectorAll=()=>rows;
  s.context.document.addEventListener=(name,fn)=>listeners[name]=fn;
  Object.assign(s.context,{currentIndex:0,_noteTarget:null,showToast:m=>toasts.push(m),playSound:m=>sounds.push(m),
    renderCardNote(){},fitCardExample(){},cardReveal(){},
    addNoteRow(eng='',kor=''){
      const inputs=[eng,kor].map(value=>({value,focus(){}}));
      rows.push({inputs,querySelectorAll:()=>inputs});
    }});
  vm.runInContext(app.slice(app.indexOf('function noteList('),app.indexOf('function addNoteRow(')),s.context);
  vm.runInContext(app.slice(app.indexOf('function noteEditorOpen('),app.indexOf('function getDeck(')),s.context);
  s.run('openNoteEditor()');sounds.length=0;
  return {...s,rows,toasts,sounds,listeners,modal,setRows(notes){
    rows.length=0;notes.forEach(n=>s.context.addNoteRow(n.eng,n.kor));
  }};
}
test('note save failures retain all input rows and the editor without claiming success',()=>{
  for(const failure of ['quota','conflict']){
    const s=noteEditorSetup(),original=s.run('words[0].note');
    s.setRows([{eng:'kitten',kor:'새끼 고양이'},{eng:'catnap',kor:'짧은 낮잠'}]);
    let expectedDisk=s.data.get('decks');
    if(failure==='quota') s.context.localStorage.setItem=()=>{throw Error('quota');};
    else {
      const latest=JSON.parse(expectedDisk);latest[0].words[0].note=[{eng:'other',kor:'다른 창 메모'}];
      expectedDisk=JSON.stringify(latest);s.data.set('decks',expectedDisk);
    }
    assert.equal(s.run('closeNoteEditor(true)'),false);
    assert.equal(s.run('noteEditorOpen()'),true);assert.equal(s.run('_noteTarget===words[0]'),true);
    assert.equal(s.run('words[0].note'),original);assert.equal(s.data.get('decks'),expectedDisk);
    assert.deepEqual(s.rows.map(r=>r.inputs.map(i=>i.value)),[['kitten','새끼 고양이'],['catnap','짧은 낮잠']]);
    assert.deepEqual(s.sounds,[]);assert.ok(s.toasts.some(m=>m.includes('저장하지 못했습니다')));
    assert.equal(s.toasts.some(m=>m.includes('저장했어요')),false);
  }
});
test('failed note additions and deletions restore the exact previous note property',()=>{
  for(const action of ['clearCardNote()','closeNoteEditor(true)']){
    const s=noteEditorSetup(),original=s.run('words[0].note'),disk=s.data.get('decks');
    s.setRows([]);s.context.localStorage.setItem=()=>{throw Error('quota');};
    assert.equal(s.run(action),false);assert.equal(s.run('words[0].note'),original);
    assert.equal(s.data.get('decks'),disk);assert.equal(s.run('noteEditorOpen()'),true);
    assert.deepEqual(s.sounds,[]);assert.equal(s.toasts.some(m=>m.includes('지웠어요')),false);
  }
  const s=noteEditorSetup(undefined);s.run('delete words[0].note');
  s.setRows([{eng:'kitten',kor:'새끼 고양이'}]);s.context.localStorage.setItem=()=>{throw Error('quota');};
  assert.equal(s.run('closeNoteEditor(true)'),false);
  assert.equal(s.run('Object.hasOwn(words[0],"note")'),false);assert.equal(s.run('noteEditorOpen()'),true);
});
test('saved multiple notes persist immediately and remain through repeated reloads',()=>{
  const notes=[{eng:'kitten',kor:'새끼 고양이'},{eng:'catnap',kor:'짧은 낮잠'}];
  const s=noteEditorSetup();s.setRows(notes);s.run('closeNoteEditor(true)');
  assert.equal(s.run('noteEditorOpen()'),false);assert.equal(s.run('_noteTarget'),null);
  assert.deepEqual(JSON.parse(s.data.get('decks'))[0].words[0].note,notes);
  assert.deepEqual(s.sounds,['memoSave']);assert.match(s.toasts[0],/2줄을 저장/);
  s.timers.forEach(fn=>fn());let state=Object.fromEntries(s.data);
  for(let i=0;i<3;i++){
    const again=setup(state);assert.deepEqual(JSON.parse(again.run('JSON.stringify(words[0].note)')),notes);
    assert.equal(again.run('words[0].example.join("|")'),'First.|Second.');
    again.run('flushDecks()');state=Object.fromEntries(again.data);
  }
});
test('explicit note deletion persists and cannot delete a different or absent editor target',()=>{
  const s=noteEditorSetup();s.run('clearCardNote()');
  assert.equal(s.run('noteEditorOpen()'),false);assert.equal(s.run('_noteTarget'),null);
  assert.equal(Object.hasOwn(JSON.parse(s.data.get('decks'))[0].words[0],'note'),false);
  assert.equal(setup(Object.fromEntries(s.data)).run('words[0].note'),undefined);
  const missing=noteEditorSetup(),disk=missing.data.get('decks');missing.run('_noteTarget=null');
  assert.equal(missing.run('clearCardNote()'),false);assert.equal(missing.data.get('decks'),disk);
  assert.equal(missing.run('words[0].note[0].eng'),'old');assert.equal(missing.run('noteEditorOpen()'),true);
});
test('saving or deleting notes for a removed or replaced word keeps the draft open',()=>{
  for(const action of ['closeNoteEditor(true)','clearCardNote()']){
    const s=noteEditorSetup();s.setRows([{eng:'kitten',kor:'초안'}]);
    s.run('words.splice(0,1,{eng:"cat",kor:"새 단어",note:[{eng:"new",kor:"새 메모"}]});saveOnly()');
    const disk=s.data.get('decks');
    assert.equal(s.run(action),false);assert.equal(s.run('noteEditorOpen()'),true);
    assert.equal(s.run('words[0].note[0].eng'),'new');assert.equal(s.data.get('decks'),disk);
    assert.equal(s.rows[0].inputs[1].value,'초안');assert.deepEqual(s.sounds,[]);
    assert.match(s.toasts[0],/단어가 변경/);
  }
});
test('note Enter ignores Korean composition and still saves ordinary Enter',()=>{
  const s=noteEditorSetup();s.setRows([{eng:'',kor:'헷갈리는 표현'}]);
  let prevented=0,stopped=0;
  const enter={key:'Enter',preventDefault(){prevented++;},stopPropagation(){stopped++;}};
  s.listeners.keydown({...enter,isComposing:true,keyCode:13});
  s.listeners.keydown({...enter,isComposing:false,keyCode:229});
  assert.equal(s.run('noteEditorOpen()'),true);assert.equal(s.run('words[0].note[0].eng'),'old');
  assert.equal(prevented,0);assert.equal(stopped,0);assert.deepEqual(s.sounds,[]);
  s.listeners.keydown({...enter,isComposing:false,keyCode:13});
  assert.equal(s.run('noteEditorOpen()'),false);assert.equal(prevented,1);assert.equal(stopped,1);
  assert.equal(JSON.parse(s.data.get('decks'))[0].words[0].note[0].kor,'헷갈리는 표현');
});
test('legacy text notes remain visible in the editor and survive saving and reload',()=>{
  const text='  헷갈리는 단어와 표현을 적어 둔 메모  ',s=noteEditorSetup(text);
  assert.equal(s.rows.length,1);assert.equal(s.rows[0].inputs[0].value,'');
  assert.equal(s.rows[0].inputs[1].value,text.trim());
  s.run('closeNoteEditor(true)');
  const again=setup(Object.fromEntries(s.data));
  assert.equal(again.run('words[0].note[0].kor'),text.trim());
  assert.equal(s.run('noteList({note:["한글 메모",{eng:"word",kor:"뜻"},null]}).map(n=>n.kor).join("|")'),'한글 메모|뜻');
});

function registrationSetup(initial={}){
  const s=setup(initial),rows=[],toasts=[],sounds=[];
  let renders=0,searchRenders=0;
  installEditHelpers(s);
  const elements={eng:{value:''},kor:{value:''},exampleInput:{value:''},
    sheetUrl:{value:'https://docs.google.com/spreadsheets/d/saved-sheet/edit#gid=0'},
    bulkRows:{get innerHTML(){return '';},set innerHTML(value){rows.length=0;}}};
  Object.assign(s.context,{showToast:message=>toasts.push(message),playSound:name=>sounds.push(name),
    render:()=>renders++,renderGlobalSearch:()=>searchRenders++,
    addBulkRow(eng='',kor='',example=''){
      const inputs={'.bulkEng':{value:eng},'.bulkKor':{value:kor},'.bulkEx':{value:example}};
      rows.push({inputs,querySelector:selector=>inputs[selector]});
    }});
  s.context.document.getElementById=id=>elements[id];
  s.context.document.querySelectorAll=()=>rows;
  vm.runInContext(app.slice(app.indexOf('function duplicate('),app.indexOf('function addBulkRow(')),s.context);
  vm.runInContext(app.slice(app.indexOf('function bulkAdd('),app.indexOf('// ===== 중복 단어 기록')),s.context);
  vm.runInContext(app.slice(app.indexOf('function dictAddWord('),app.indexOf('// 통일된 단어 행 카드')),s.context);
  return {...s,rows,toasts,sounds,elements,get renders(){return renders;},get searchRenders(){return searchRenders;}};
}
function failRegistrationStorage(s,failure){
  if(failure==='quota'){
    s.context.localStorage.setItem=()=>{throw Error('quota');};
    return s.data.get('decks');
  }
  const latest=JSON.parse(s.data.get('decks'));
  latest[0].words.push({eng:'other-window',kor:'다른 창에서 저장한 단어',example:['Saved elsewhere.']});
  const raw=JSON.stringify(latest);s.data.set('decks',raw);return raw;
}
test('failed bulk registration preserves every input and never claims that unsaved words were added',()=>{
  for(const failure of ['quota','conflict']){
    const s=registrationSetup();
    s.run('words.push({eng:"cat",kor:"고양이",example:["one","two"],note:[{eng:"kitten",kor:"새끼"}]});saveOnly()');
    s.context.addBulkRow(' dog ',' 개 ',' First example. ');
    s.context.addBulkRow('bird','새','Second example.');
    const inputs=s.rows.map(row=>Object.values(row.inputs).map(input=>input.value));
    const original=s.run('words[0]'),disk=failRegistrationStorage(s,failure);
    assert.equal(s.run('bulkAdd()'),false);
    assert.equal(s.run('words.length'),1);assert.equal(s.run('words[0]'),original);
    assert.equal(s.data.get('decks'),disk);
    assert.deepEqual(s.rows.map(row=>Object.values(row.inputs).map(input=>input.value)),inputs);
    assert.equal(s.renders,0);assert.deepEqual(s.sounds,[]);
    assert.ok(s.toasts.some(message=>message.includes('저장하지 못했습니다')));
    assert.equal(s.toasts.some(message=>message.includes('추가했어요')),false);
  }
});
test('failed dictionary registration leaves the lookup available and does not report success',()=>{
  for(const failure of ['quota','conflict']){
    const s=registrationSetup();s.context._dictLast={eng:'cat',kor:'고양이'};
    const lookup=s.context._dictLast,disk=failRegistrationStorage(s,failure);
    assert.equal(s.run('dictAddWord()'),false);
    assert.equal(s.run('words.length'),0);assert.equal(s.context._dictLast,lookup);
    assert.equal(s.data.get('decks'),disk);assert.equal(s.renders,0);assert.equal(s.searchRenders,0);
    assert.deepEqual(s.sounds,[]);assert.equal(s.toasts.some(message=>message.includes('추가했어요')),false);
    assert.ok(s.toasts.some(message=>message.includes('저장하지 못했습니다')));
  }
});
test('bulk and dictionary registration persist immediately and can be retried after a quota error',()=>{
  const s=registrationSetup();s.context.addBulkRow('cat','고양이','Saved example.');
  const write=s.context.localStorage.setItem;s.context.localStorage.setItem=()=>{throw Error('quota');};
  assert.equal(s.run('bulkAdd()'),false);
  s.context.localStorage.setItem=write;s.run('bulkAdd()');
  assert.equal(s.rows.length,3);assert.ok(s.rows.every(row=>Object.values(row.inputs).every(input=>input.value==='')));
  s.context._dictLast={eng:'dog',kor:'개'};s.run('dictAddWord()');
  assert.deepEqual(JSON.parse(s.data.get('decks'))[0].words.map(word=>word.eng),['cat','dog']);
  const again=setup(Object.fromEntries(s.data));
  assert.equal(again.run('words[0].example'),'Saved example.');assert.equal(again.run('words[1].kor'),'개');
  assert.deepEqual(s.sounds,['add','add']);assert.equal(s.searchRenders,1);
});
test('failed CSV imports restore exact existing fields and references, including absent source and examples',()=>{
  for(const failure of ['quota','conflict']){
    const s=registrationSetup();
    s.run('words.push({eng:"cat",kor:"고양이",example:["one","two"],note:[{eng:"kitten",kor:"새끼"}],wrong:true,mastered:true,custom:{value:3}},{eng:"dog",kor:"개"});saveOnly();var originalWords=words.slice(),originalExample=words[0].example,originalNote=words[0].note,originalCustom=words[0].custom');
    const original=s.run('JSON.stringify(words)'),disk=failRegistrationStorage(s,failure);
    const result=s.run('addFromCsvText("cat,수정된 뜻,new example\\ncat,수정된 뜻,new example\\ndog,강아지,dog example\\nbird,새,bird example","New sheet")');
    assert.deepEqual(JSON.parse(JSON.stringify(result)),{added:0,updated:0,dups:[],saved:false});
    assert.equal(s.run('JSON.stringify(words)'),original);assert.equal(s.data.get('decks'),disk);
    assert.equal(s.run('words.every((w,i)=>w===originalWords[i])'),true);
    assert.equal(s.run('words[0].example===originalExample&&words[0].note===originalNote&&words[0].custom===originalCustom'),true);
    assert.equal(s.run('Object.hasOwn(words[0],"src")||Object.hasOwn(words[1],"src")||Object.hasOwn(words[1],"example")'),false);
    assert.equal(s.renders,0);assert.deepEqual(s.sounds,[]);
    assert.ok(s.toasts.some(message=>message.includes('저장하지 못해')));
  }
});
test('CSV merges retain all local examples, notes, manual words and learning state through repeated reloads',()=>{
  const s=registrationSetup(),notes=[{eng:'kitten',kor:'새끼 고양이'},{eng:'catnap',kor:'짧은 낮잠'}];
  s.context.savedNotes=notes;
  s.run('words.push({eng:"cat",kor:"고양이",example:["First local.","Second local."],note:savedNotes,wrong:true,mastered:true,wrongResult:"local",src:"Old sheet"},{eng:"manual",kor:"직접 추가",note:"내 메모"});saveOnly()');
  const result=s.run('addFromCsvText("cat,새 뜻,Sheet example.\\nbird,새,Bird example.","New sheet")');
  assert.equal(result.saved,true);assert.equal(result.added,1);assert.equal(result.updated,2);
  assert.equal(s.renders,1);
  let state=Object.fromEntries(s.data);
  for(let i=0;i<3;i++){
    const again=setup(state);
    assert.equal(again.run('words.map(w=>w.eng).join(",")'),'cat,manual,bird');
    assert.equal(again.run('words[0].example.join("|")'),'First local.|Second local.|Sheet example.');
    assert.deepEqual(JSON.parse(again.run('JSON.stringify(words[0].note)')),notes);
    assert.equal(again.run('words[0].wrong&&words[0].mastered'),true);
    assert.equal(again.run('words[0].wrongResult'),'local');assert.equal(again.run('words[0].src'),'New sheet');
    assert.equal(again.run('words[1].note'),'내 메모');again.run('flushDecks()');state=Object.fromEntries(again.data);
  }
});
test('a removed word or a word from another deck cannot be silently edited',()=>{
  const s=registrationSetup();
  s.run('words.push({eng:"cat",kor:"고양이",example:["Saved."]});saveOnly();var removedTarget=words[0];words.splice(0,1,{eng:"dog",kor:"개"});saveOnly()');
  const disk=s.data.get('decks'),writes=s.writes.length;
  assert.equal(s.run('persistWordEdit(removedTarget,"cat","새 뜻",["Unsaved."])'),false);
  assert.equal(s.run('removedTarget.kor'),'고양이');assert.equal(s.run('removedTarget.example[0]'),'Saved.');
  assert.equal(s.run('words[0].eng'),'dog');assert.equal(s.data.get('decks'),disk);assert.equal(s.writes.length,writes);
  assert.ok(s.toasts.some(message=>message.includes('대상이 바뀌어')));
});
test('legacy arrays of text notes are normalized without losing their content on reload',()=>{
  const initial={decks:JSON.stringify([{id:'a',name:'A',words:[{eng:'cat',kor:'고양이',
    note:['한글 메모',{eng:'kitten',kor:'새끼 고양이'},null,42,'두 번째 메모']},
    {eng:'dog',kor:'개',note:'원래 문자열 메모'}],stats:{},dupes:[]}]),activeDeckId:'a'};
  const expected=[{eng:'',kor:'한글 메모'},{eng:'kitten',kor:'새끼 고양이'},{eng:'',kor:'두 번째 메모'}];
  const s=setup(initial);assert.deepEqual(JSON.parse(s.run('JSON.stringify(words[0].note)')),expected);
  assert.equal(s.run('saveDeckData()'),true);
  const again=setup(Object.fromEntries(s.data));
  assert.deepEqual(JSON.parse(again.run('JSON.stringify(words[0].note)')),expected);
  assert.equal(again.run('words[1].note'),'원래 문자열 메모');
});

function sheetImportSetup(){
  const s=registrationSetup({decks:JSON.stringify([
    {id:'a',name:'A',words:[{eng:'cat',kor:'고양이',example:['First.','Second.'],note:[{eng:'kitten',kor:'새끼'}]}],stats:{},dupes:[]},
    {id:'b',name:'B',words:[{eng:'dog',kor:'개'}],stats:{},dupes:[]}
  ]),activeDeckId:'a'}),requests=[],dialogs={word:false,note:false,confirm:false};
  Object.assign(s.context,{lsEditIndex:-1,wordEditorOpen:()=>dialogs.word,noteEditorOpen:()=>dialogs.note,
    confirmOpen:()=>dialogs.confirm,withProxies:urls=>({direct:urls,proxied:[]}),
    fetchFirstOk(urls,validate){
      return new Promise((resolve,reject)=>requests.push({urls,resolve(text){try{validate(text);resolve(text);}catch(error){reject(error);}},reject}));
    }});
  vm.runInContext(app.slice(app.indexOf('function saveDupes('),app.indexOf('function removeDupe(')),s.context);
  vm.runInContext(app.slice(app.indexOf('let _sheetImportSeq='),app.indexOf('let currentIndex=')),s.context);
  return {...s,requests,dialogs,get renders(){return s.renders;},get searchRenders(){return s.searchRenders;}};
}
test('pending sheet imports cannot modify another deck or a replaced array in the same deck',async()=>{
  for(const replacement of ['deck','array']){
    const s=sheetImportSetup(),pending=s.run('importGoogleSheet({sheet:"Sheet"})');
    assert.ok(pending&&typeof pending.then==='function');
    if(replacement==='deck')s.run('activeDeckId="b";words=decks[1].words;stats=decks[1].stats;dupes=decks[1].dupes');
    else s.run('words=words.slice();decks[0].words=words');
    const memory=s.run('JSON.stringify(decks)'),disk=s.data.get('decks');
    s.requests[0].resolve('cat,새 뜻,Remote example.\nbird,새,Bird example.');
    const result=await pending;
    assert.equal(result.cancelled,true);assert.equal(result.saved,false);
    assert.equal(s.run('JSON.stringify(decks)'),memory);assert.equal(s.data.get('decks'),disk);
    assert.deepEqual(s.sounds,[]);assert.deepEqual(s.alerts,[]);assert.equal(s.renders,0);
    assert.equal(s.toasts.some(message=>message.includes('📥')),false);
  }
});
test('opening any editor or confirmation cancels a pending sheet import without touching drafts',async()=>{
  for(const editing of ['word','note','confirm','inline','list']){
    const s=sheetImportSetup(),pending=s.run('importGoogleSheet({sheet:"Sheet"})');
    if(editing==='inline')s.run('editIndex=0');
    else if(editing==='list')s.context.lsEditIndex=0;
    else s.dialogs[editing]=true;
    const memory=s.run('JSON.stringify(decks)'),disk=s.data.get('decks');
    s.requests[0].resolve('cat,새 뜻,Remote example.');const result=await pending;
    assert.equal(result.cancelled,true,editing);
    assert.equal(s.run('JSON.stringify(decks)'),memory,editing);assert.equal(s.data.get('decks'),disk,editing);
    assert.deepEqual(s.sounds,[],editing);assert.deepEqual(s.alerts,[],editing);
    if(editing==='inline')assert.equal(s.run('editIndex'),0);
    else if(editing==='list')assert.equal(s.context.lsEditIndex,0);
    else assert.equal(s.dialogs[editing],true);
  }
});
test('only the newest sheet import can apply, whichever network response arrives first',async()=>{
  for(const order of ['new-first','old-first']){
    const s=sheetImportSetup();
    const old=s.run('importGoogleSheet({sheet:"Old"})'),latest=s.run('importGoogleSheet({sheet:"Latest"})');
    if(order==='old-first'){
      s.requests[0].resolve('cat,오래된 응답,Old remote.');assert.equal((await old).cancelled,true);
      assert.equal(s.run('words[0].kor'),'고양이');
    }
    s.requests[1].resolve('cat,최신 응답,Latest remote.');await latest;
    if(order==='new-first'){
      s.requests[0].resolve('cat,오래된 응답,Old remote.');assert.equal((await old).cancelled,true);
    }
    assert.equal(s.run('words[0].kor'),'최신 응답');
    assert.equal(s.run('words[0].example.join("|")'),'First.|Second.|Latest remote.');
    assert.equal(JSON.parse(s.data.get('decks'))[0].words[0].src,'Latest');
    assert.equal(s.alerts.length,1);assert.match(s.alerts[0],/Latest/);assert.deepEqual(s.sounds,['add']);
  }
});
test('sheet import save failures preserve existing data and never trigger success alerts or audio',async()=>{
  for(const failure of ['quota','conflict']){
    const s=sheetImportSetup(),disk=failRegistrationStorage(s,failure),memory=s.run('JSON.stringify(words)');
    const pending=s.run('importGoogleSheet({sheet:"Sheet"})');
    s.requests[0].resolve('cat,새 뜻,Unsaved example.\ncat,새 뜻,Unsaved example.\nbird,새,Unsaved bird.');
    const result=await pending;
    assert.equal(result.saved,false);assert.equal(result.added,0);assert.equal(result.updated,0);
    assert.equal(s.run('JSON.stringify(words)'),memory);assert.equal(s.data.get('decks'),disk);
    assert.equal(s.run('dupes.length'),0);assert.deepEqual(s.sounds,[]);assert.deepEqual(s.alerts,[]);
    assert.equal(s.renders,0);assert.equal(s.toasts.some(message=>message.includes('📥')),false);
    assert.equal(s.elements.sheetUrl.value,'https://docs.google.com/spreadsheets/d/saved-sheet/edit#gid=0');
  }
});

function wordEditorSetup(){
  const s=registrationSetup({decks:JSON.stringify([{id:'a',name:'A',words:[{eng:'cat',kor:'고양이',
    example:['First.','Second.'],note:[{eng:'kitten',kor:'새끼'}]}],stats:{},dupes:[]}]),activeDeckId:'a'});
  const examples=[],classes=new Set(),modal={classList:{contains:name=>classes.has(name),
    add:name=>classes.add(name),remove:name=>classes.delete(name)}};
  Object.assign(s.elements,{wordEditBack:modal,wordEditEng:{value:''},wordEditKor:{value:''},
    wordEditExRows:{set innerHTML(value){examples.length=0;},querySelectorAll:()=>examples},
    front:{innerText:''},back:{innerText:''},card:{classList:{contains:()=>false}}});
  s.context.document.querySelectorAll=selector=>selector==='#wordEditExRows textarea'?examples:s.rows;
  Object.assign(s.context,{currentIndex:0,cardDir:'e2k',confirmOpen:()=>false,noteEditorOpen:()=>false,
    addExRow(value=''){const input={value,focus(){},scrollIntoView(){}};examples.push(input);return input;},
    showExample(){},fitCardExample(){}});
  vm.runInContext(app.slice(app.indexOf('function wordEditorOpen('),app.indexOf('function noteEditorOpen(')),s.context);
  s.run('openWordEditor(false)');s.sounds.length=0;
  return {...s,examples,modal,get renders(){return s.renders;},get searchRenders(){return s.searchRenders;}};
}
test('failed card example edits keep the modal and all typed examples available',()=>{
  for(const failure of ['quota','conflict']){
    const s=wordEditorSetup(),disk=failRegistrationStorage(s,failure);
    s.elements.wordEditKor.value='새 뜻';s.examples[0].value='Edited first.';s.context.addExRow('Third draft.');
    s.run('closeWordEditor(true)');
    assert.equal(s.run('wordEditorOpen()'),true);assert.equal(s.run('_editTarget===words[0]'),true);
    assert.equal(s.run('words[0].kor'),'고양이');assert.equal(s.run('words[0].example.join("|")'),'First.|Second.');
    assert.equal(s.elements.wordEditKor.value,'새 뜻');assert.deepEqual(s.examples.map(input=>input.value),['Edited first.','Second.','Third draft.']);
    assert.equal(s.data.get('decks'),disk);assert.deepEqual(s.sounds,[]);
    assert.equal(s.toasts.some(message=>message.includes('저장했어요')||message.includes('수정했어요')),false);
  }
});
test('card example saves and later CSV merges keep multiple examples and confusing-word notes after reload',()=>{
  const s=wordEditorSetup();s.examples[0].value='Edited first.';s.context.addExRow('Third example.');
  s.run('closeWordEditor(true)');assert.equal(s.run('wordEditorOpen()'),false);
  assert.equal(s.run('_editTarget'),null);assert.deepEqual(s.sounds,['memoSave']);
  let again=setup(Object.fromEntries(s.data));
  assert.equal(again.run('words[0].example.join("|")'),'Edited first.|Second.|Third example.');
  assert.equal(again.run('words[0].note[0].eng'),'kitten');
  s.run('addFromCsvText("cat,고양이,Sheet example.","Sheet")');
  again=setup(Object.fromEntries(s.data));
  assert.equal(again.run('words[0].example.join("|")'),'Edited first.|Second.|Third example.|Sheet example.');
  assert.equal(again.run('words[0].note[0].eng'),'kitten');
});
test('a card example draft for a replaced target stays open and cannot alter the replacement word',()=>{
  const s=wordEditorSetup();s.examples[0].value='Draft for previous word.';
  s.run('words.splice(0,1,{eng:"cat",kor:"교체한 단어",example:["Replacement."]});saveOnly()');
  const disk=s.data.get('decks');s.run('closeWordEditor(true)');
  assert.equal(s.run('wordEditorOpen()'),true);assert.equal(s.examples[0].value,'Draft for previous word.');
  assert.equal(s.run('words[0].kor'),'교체한 단어');assert.equal(s.run('words[0].example[0]'),'Replacement.');
  assert.equal(s.data.get('decks'),disk);assert.deepEqual(s.sounds,[]);
});
test('persistent storage requests are best effort and never turn successful local saves into failures',async()=>{
  for(const mode of ['already-persistent','granted','denied','async-error','sync-error','unavailable']){
    const s=setup(),calls=[];
    const storage=mode==='unavailable'?{}:{
      persisted(){calls.push('persisted');if(mode==='sync-error')throw Error('unsupported');return Promise.resolve(mode==='already-persistent');},
      persist(){calls.push('persist');return mode==='async-error'?Promise.reject(Error('denied')):Promise.resolve(mode==='granted');}
    };
    s.context.navigator={storage};
    s.run('words.push({eng:"cat",kor:"고양이",example:["Saved."],note:[{eng:"kitten",kor:"새끼"}]})');
    assert.equal(s.run('saveDeckData()'),true,mode);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(JSON.parse(s.data.get('decks'))[0].words[0].example[0],'Saved.',mode);
    assert.equal(s.alerts.length,0,mode);assert.equal(s.run('saveDeckData()'),true,mode);
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(calls,mode==='unavailable'?[]:mode==='already-persistent'||mode==='sync-error'?['persisted']:['persisted','persist'],mode);
  }
});

test('resaving unchanged notes detects another window deleting or replacing them and keeps the draft open',()=>{
  for(const externalChange of ['delete','replace']){
    const s=noteEditorSetup();assert.equal(s.run('saveOnly()'),true);
    const original=s.run('words[0].note'),inputs=s.rows.map(row=>row.inputs.map(input=>input.value));
    const latest=JSON.parse(s.data.get('decks'));
    if(externalChange==='delete')delete latest[0].words[0].note;
    else latest[0].words[0].note=[{eng:'other-window',kor:'다른 창에서 변경한 메모'}];
    const disk=JSON.stringify(latest);s.data.set('decks',disk);
    // An unchanged background page remains quiet, but pressing Save must verify current disk data.
    const timers=s.timers.length,writes=s.writes.length;
    assert.equal(s.run('flushDecks()'),true);
    assert.equal(s.data.get('decks'),disk);assert.equal(s.timers.length,timers);assert.equal(s.writes.length,writes);
    assert.equal(s.run('closeNoteEditor(true)'),false,externalChange);
    assert.equal(s.run('noteEditorOpen()'),true,externalChange);
    assert.equal(s.run('_noteTarget===words[0]'),true,externalChange);
    assert.equal(s.run('words[0].note'),original,externalChange);
    assert.deepEqual(s.rows.map(row=>row.inputs.map(input=>input.value)),inputs,externalChange);
    assert.equal(s.data.get('decks'),disk,externalChange);assert.deepEqual(s.sounds,[],externalChange);
    assert.equal(s.toasts.some(message=>message.includes('저장했어요')||message.includes('지웠어요')),false,externalChange);
    assert.ok(s.toasts.some(message=>message.includes('저장하지 못했습니다')),externalChange);
    const reopened=setup(Object.fromEntries(s.data));
    if(externalChange==='delete')assert.equal(reopened.run('words[0].note'),undefined);
    else assert.equal(reopened.run('words[0].note[0].eng'),'other-window');
  }
});
