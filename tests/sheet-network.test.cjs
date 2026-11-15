const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const app=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(match=>match[1]).find(source=>source.includes('const APP_VERSION='));
const sourceBetween=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const plain=value=>JSON.parse(JSON.stringify(value));

function networkSetup(fetch){
  const timers=new Map();let nextId=0;
  const context=vm.createContext({AbortController,fetch,
    setTimeout(callback){const id=++nextId;timers.set(id,callback);return id;},
    clearTimeout(id){timers.delete(id);}
  });
  vm.runInContext(sourceBetween('async function tryFetch(','// 직접 먼저 경쟁'),context);
  return {timers,request:(url,validate,timeout=10)=>context.tryFetch(url,validate,timeout)};
}

function exampleSetup(fetch){
  const timers=new Map();let nextId=0;
  const context=vm.createContext({AbortController,fetch,
    setTimeout(callback){const id=++nextId;timers.set(id,callback);return id;},
    clearTimeout(id){timers.delete(id);}
  });
  vm.runInContext(sourceBetween('async function fetchT(','// CORS 프록시 경유'),context);
  return {timers,request:(url,timeout=10)=>context.fetchT(url,timeout)};
}

test('example fetch timeout aborts a real streaming response that stalls after headers',async()=>{
  let response,bodyStarted=false;
  const s=exampleSetup(async(_url,{signal})=>{
    response=new Response(new ReadableStream({start(controller){
      bodyStarted=true;controller.enqueue(new TextEncoder().encode('{"partial":'));
      signal.addEventListener('abort',()=>controller.error(signal.reason),{once:true});
    }}),{headers:{'Content-Type':'application/json'}});
    return response;
  });
  const request=s.request('synthetic-streaming-example');
  const rejected=assert.rejects(request,{name:'AbortError'});
  await tick();assert.equal(bodyStarted,true);assert.equal(response.bodyUsed,false);assert.equal(s.timers.size,1);
  [...s.timers.values()][0]();await rejected;assert.equal(s.timers.size,0);
});

test('example fetch preserves the original Response and normal JSON/text readers',async()=>{
  for(const json of [false,true]){
    const original=new Response(json?'[{"example":"Saved example."}]':'Saved example.',{
      status:201,statusText:'Created',headers:{'Content-Type':json?'application/json':'text/plain','X-Example':'preserved'}
    });
    Object.defineProperty(original,'url',{value:'https://synthetic.example/api'});
    const s=exampleSetup(async()=>original),response=await s.request('synthetic-example');
    assert.strictEqual(response,original);assert.equal(response.url,'https://synthetic.example/api');
    assert.equal(response.status,201);assert.equal(response.statusText,'Created');assert.equal(response.headers.get('X-Example'),'preserved');
    assert.equal(response.bodyUsed,false);assert.equal(s.timers.size,0);
    if(json)assert.deepEqual(await response.json(),[{example:'Saved example.'}]);
    else assert.equal(await response.text(),'Saved example.');
  }
});

test('example fetch clears timeout on network and streaming-body failures',async()=>{
  for(const fetch of [async()=>{throw Error('network unavailable');},async()=>new Response(new ReadableStream({start(controller){controller.error(Error('body unavailable'));}}))]){
    const s=exampleSetup(fetch);await assert.rejects(s.request('synthetic-example'),/unavailable/);assert.equal(s.timers.size,0);
  }
});

test('sheet timeout remains active while a response body stalls after its headers',async()=>{
  let bodyStarted=false;
  const s=networkSetup(async(_url,{signal})=>({ok:true,text:()=>new Promise((_resolve,reject)=>{
    bodyStarted=true;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  })}));
  const request=s.request('synthetic-slow-csv');
  await tick();assert.equal(bodyStarted,true);assert.equal(s.timers.size,1);
  [...s.timers.values()][0]();
  await assert.rejects(request,{name:'AbortError'});assert.equal(s.timers.size,0);
});

test('successful sheet reads clear their timeout only after body parsing and validation',async()=>{
  let resolveBody,validated=false;
  const s=networkSetup(async()=>({ok:true,text:()=>new Promise(resolve=>{resolveBody=resolve;})}));
  const request=s.request('synthetic-csv',text=>{assert.equal(text,'cat,고양이');validated=true;});
  await tick();assert.equal(validated,false);assert.equal(s.timers.size,1);
  resolveBody('cat,고양이');assert.equal(await request,'cat,고양이');
  assert.equal(validated,true);assert.equal(s.timers.size,0);
});

test('HTTP, body, validation and network failures all release the sheet timeout',async()=>{
  const cases=[
    {fetch:async()=>({ok:false,status:503,text:()=>{throw Error('must not read an error page');}}),pattern:/status 503/},
    {fetch:async()=>({ok:true,text:async()=>{throw Error('body failed');}}),pattern:/body failed/},
    {fetch:async()=>({ok:true,text:async()=>'not CSV'}),validate:()=>{throw Error('invalid CSV');},pattern:/invalid CSV/},
    {fetch:async()=>{throw Error('offline');},pattern:/offline/}
  ];
  for(const scenario of cases){
    const s=networkSetup(scenario.fetch);
    await assert.rejects(s.request('synthetic-error',scenario.validate),scenario.pattern);
    assert.equal(s.timers.size,0);
  }
});

const sheetUrl=(id,gid='0')=>'https://docs.google.com/spreadsheets/d/'+id+'/edit#gid='+gid;
function tabsSetup(){
  const url={value:sheetUrl('BOOK_A')},box={innerHTML:''},pending=[],renders=[],imports=[],messages=[],alerts=[];
  const context=vm.createContext({document:{getElementById:id=>id==='sheetUrl'?url:box},
    alert:message=>alerts.push(message),showToast:message=>messages.push(message),
    withProxies:urls=>urls,
    fetchFirstOk:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),
    parseSheetTabs:text=>JSON.parse(text),captureRender:tabs=>renders.push(plain(tabs)),
    importGoogleSheet:options=>{imports.push(plain(options));return {saved:true};}
  });
  vm.runInContext(sourceBetween('function parseSheetId(','function parseSheetGid('),context);
  vm.runInContext(sourceBetween('let detectedTabs=','// HTML에서 시트 탭'),context);
  vm.runInContext('function renderSheetTabs(tabs){detectedTabs=tabs||[];captureRender(detectedTabs);}',context);
  vm.runInContext(sourceBetween('function importSheetTab(','function importManualSheet('),context);
  return {url,box,pending,renders,imports,messages,alerts,
    load:()=>context.loadSheetTabs(),importTab:index=>context.importSheetTab(index),
    source:()=>vm.runInContext('detectedTabsSourceId',context),
    tabs:()=>plain(vm.runInContext('detectedTabs',context))};
}
const tabs=(gid,name)=>JSON.stringify([{gid,name}]);

test('a slower old workbook response cannot replace newer workbook tabs',async()=>{
  const s=tabsSetup(),first=s.load();s.url.value=sheetUrl('BOOK_B');const second=s.load();
  s.pending[1].resolve(tabs('22','B lesson'));await second;
  s.pending[0].resolve(tabs('11','A lesson'));await first;
  assert.deepEqual(s.renders,[[{gid:'22',name:'B lesson'}]]);assert.equal(s.source(),'BOOK_B');
  assert.equal(s.importTab(0).saved,true);assert.deepEqual(s.imports,[{gid:'22',sheet:'B lesson'}]);
});

test('changing a workbook link cannot import a previously displayed workbook tab',async()=>{
  const s=tabsSetup(),request=s.load();s.pending[0].resolve(tabs('11','A lesson'));await request;
  s.url.value=sheetUrl('BOOK_B');assert.equal(s.importTab(0),false);
  assert.deepEqual(s.imports,[]);assert.match(s.messages.at(-1),/시트 목록을 다시/);
  s.url.value=sheetUrl('BOOK_A','37');assert.equal(s.importTab(0).saved,true);
  assert.deepEqual(s.imports,[{gid:'11',sheet:'A lesson'}]);
});

test('changing the link during a pending tab load prevents stale tabs from appearing',async()=>{
  const s=tabsSetup(),request=s.load();s.url.value=sheetUrl('BOOK_B');
  s.pending[0].resolve(tabs('11','A lesson'));await request;
  assert.deepEqual(s.renders,[]);assert.deepEqual(s.tabs(),[]);assert.equal(s.source(),'');
  assert.equal(s.importTab(0),false);assert.deepEqual(s.imports,[]);
});

test('an old failed tab request cannot wipe a newer successful request',async()=>{
  const s=tabsSetup(),first=s.load();s.url.value=sheetUrl('BOOK_B');const second=s.load();
  s.pending[1].resolve(tabs('22','B lesson'));await second;s.pending[0].reject(Error('old offline response'));await first;
  assert.deepEqual(s.renders,[[{gid:'22',name:'B lesson'}]]);assert.equal(s.source(),'BOOK_B');
});

test('reloading tabs immediately invalidates old buttons and only the newest same-book request wins',async()=>{
  const s=tabsSetup(),initial=s.load();s.pending[0].resolve(tabs('11','Old lesson'));await initial;
  const first=s.load();assert.deepEqual(s.tabs(),[]);assert.equal(s.importTab(0),false);
  const second=s.load();s.pending[2].resolve(tabs('33','Newest lesson'));await second;
  s.pending[1].resolve(tabs('22','Older lesson'));await first;
  assert.deepEqual(s.tabs(),[{gid:'33',name:'Newest lesson'}]);assert.equal(s.importTab(0).saved,true);
  assert.deepEqual(s.imports,[{gid:'33',sheet:'Newest lesson'}]);
});

test('an explicit invalid-link load cancels an older request even if the original link is restored',async()=>{
  const s=tabsSetup(),first=s.load();s.url.value='invalid';await s.load();s.url.value=sheetUrl('BOOK_A');
  s.pending[0].resolve(tabs('11','Old lesson'));await first;
  assert.deepEqual(s.renders,[]);assert.deepEqual(s.tabs(),[]);assert.equal(s.alerts.length,1);
});
