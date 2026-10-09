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
  Object.assign(s.context,{save(){},playSound(){},addBulkRow(){}});
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
  const s=setup();Object.assign(s.context,{save(){}});
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

function audioSetup(state='suspended'){
  const instances=[],listeners={},played=[];
  const param=()=>({value:0,setValueAtTime(){},exponentialRampToValueAtTime(){}});
  class AudioContext{
    constructor(){this.state=state;this.currentTime=10;this.destination={};this.resumes=0;instances.push(this);}
    createGain(){return {gain:param(),connect(){}};}
    createDynamicsCompressor(){return {threshold:param(),knee:param(),ratio:param(),attack:param(),release:param(),connect(){}};}
    createOscillator(){return {frequency:param(),connect(){},start:()=>played.push(this.state),stop(){}};}
    resume(){this.resumes++;return new Promise((resolve,reject)=>{this.finish=()=>{this.state='running';resolve();};this.fail=()=>reject(Error('blocked'));});}
  }
  const context=vm.createContext({window:{AudioContext},safeStorage:{getItem:()=>null},document:{hidden:false,addEventListener:(name,fn)=>listeners[name]=fn}});
  vm.runInContext(app.slice(app.indexOf('// ===== 효과음'),app.indexOf('function applyTheme(')),context);
  return {instances,listeners,played,run:s=>vm.runInContext(s,context)};
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
test('gesture and app return unlock audio without playing a sound',async()=>{
  const s=audioSetup();const first=s.listeners.pointerdown();s.instances[0].finish();await first;
  s.instances[0].state='interrupted';s.listeners.visibilitychange();assert.equal(s.instances[0].resumes,2);
  const pending=s.run('resumeAudio(audioCtx)');s.instances[0].finish();await pending;assert.equal(s.played.length,0);
  s.run('soundOn=false');s.instances[0].state='suspended';s.listeners.touchend();assert.equal(s.instances[0].resumes,2);
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
