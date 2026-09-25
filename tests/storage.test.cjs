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
