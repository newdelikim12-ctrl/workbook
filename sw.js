// 단어 연습장 서비스워커
const CACHE='wordbook-v46';
const SHELL=["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png", "./captures-store.js?v=2026-11-17.106", "./captures-media.js?v=2026-11-15.103", "./captures.js?v=2026-11-17.106", "./captures.css?v=2026-11-17.105", "./captures-image.js?v=2026-11-17.106", "./captures-editor.js?v=2026-11-17.106", "./captures-editor.css?v=2026-11-17.106", "./vendor/pdfjs/font-assets-01.json", "./vendor/pdfjs/font-assets-02.json", "./vendor/pdfjs/font-assets-03.json", "./vendor/pdfjs/font-assets-04.json", "./vendor/pdfjs/font-assets-05.json", "./vendor/pdfjs/font-assets-06.json", "./vendor/pdfjs/font-assets-07.json", "./vendor/pdfjs/font-assets.json", "./vendor/pdfjs/jbig2_nowasm_fallback.js", "./vendor/pdfjs/openjpeg_nowasm_fallback.js", "./vendor/pdfjs/pdf.min.mjs", "./vendor/pdfjs/pdf.worker.min.mjs", "./word-audit.js?v=2026-11-15.103", "./word-audit.css?v=2026-11-14.101", "./word-spelling.js?v=2026-11-14.101", "./vendor/word-check/nspell.mjs", "./vendor/word-check/en-US.aff", "./vendor/word-check/en-US.dic", "./vendor/word-check/en-GB.aff", "./vendor/word-check/en-GB.dic", "./wrong-archive.js?v=2026-11-15.103", "./wrong-archive.css?v=2026-11-15.102"];

const ROOT_URL=new URL('./',self.registration.scope).href;
const ENTRY_URL=new URL('./index.html',self.registration.scope).href;
const SHELL_URLS=SHELL.map(path=>new URL(path,self.registration.scope).href);
let shellRepair=null;
const html=response=>response&&response.status===200&&/\btext\/html\b/i.test(response.headers.get('content-type')||'');
async function currentCache(){try{return await caches.open(CACHE);}catch(_error){return null;}}
async function match(cache,request){try{return cache?await cache.match(request):null;}catch(_error){return null;}}
async function storedPage(cache,request){
  for(const key of [request,ENTRY_URL,ROOT_URL]){const response=await match(cache,key);if(html(response))return response;}
  return null;
}
function releaseOf(text){return /\bAPP_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(text)?.[1]||'';}
async function stagePageDependencies(cache,text){
  if(!cache)return false;
  const urls=new Set();
  for(const tag of text.match(/<(?:script|link)\b[^>]*>/gi)||[]){
    const script=/^<script\b/i.test(tag);
    if(!script&&!/\brel\s*=\s*['"][^'"]*\bstylesheet\b/i.test(tag))continue;
    const attribute=script?/\bsrc\s*=\s*['"]([^'"]+)['"]/i:/\bhref\s*=\s*['"]([^'"]+)['"]/i;
    const path=attribute.exec(tag)?.[1];if(!path)continue;
    try{const url=new URL(path.replace(/&amp;/g,'&'),ROOT_URL);
      if(url.origin===self.location.origin&&url.href.startsWith(ROOT_URL))urls.add(url.href);
    }catch(_error){}
  }
  try{
    const present=new Set((await cache.keys()).map(request=>request.url));
    const missing=[...urls].filter(url=>!present.has(url));
    if(missing.length)await cache.addAll(missing.map(url=>new Request(url,{cache:'reload'})));
    return true;
  }catch(_error){return false;}
}
function repairShell(){
  if(shellRepair)return shellRepair;
  shellRepair=(async()=>{
    const cache=await currentCache();if(!cache)return;
    const present=new Set((await cache.keys()).map(request=>request.url));
    // Navigation commits HTML only after its boot dependencies are available.
    const missing=SHELL_URLS.filter(url=>url!==ROOT_URL&&url!==ENTRY_URL&&!present.has(url));
    if(missing.length)await cache.addAll(missing.map(url=>new Request(url,{cache:'reload'})));
  })().finally(()=>{shellRepair=null;});
  return shellRepair;
}
self.addEventListener('install',event=>{
  // A partial update must leave the previous worker and its offline files usable.
  event.waitUntil(caches.open(CACHE)
    .then(cache=>cache.addAll(SHELL_URLS.map(url=>new Request(url,{cache:'reload'}))))
    .then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('wordbook-')&&key!==CACHE).map(key=>caches.delete(key))))
      .then(()=>self.clients.claim())
  );
});
self.addEventListener('fetch',event=>{
  const request=event.request;
  if(request.method!=='GET'||request.cache==='no-store')return;
  const url=new URL(request.url);
  if(url.hostname==='api.dictionaryapi.dev')return;
  if(request.mode==='navigate'||request.destination==='document'){
    const response=(async()=>{
      const cache=await currentCache();
      try{
        const online=await fetch(request);
        if(html(online)){
          const text=await online.clone().text(),saved=await storedPage(cache,request);
          // A newer page may refer to scripts whose update is still installing.
          // Keep this worker's complete release until the new worker is ready.
          const incoming=releaseOf(text),retained=saved?releaseOf(await saved.clone().text()):'';
          if(saved&&incoming&&retained&&incoming!==retained)return saved;
          // After complete cache eviction, stage the page's actual versioned boot
          // assets before committing HTML; old SHELL URLs alone are insufficient.
          if(cache&&(saved||await stagePageDependencies(cache,text))){
            try{await Promise.all([cache.put(ENTRY_URL,online.clone()),cache.put(ROOT_URL,online.clone())]);}catch(_error){}
          }
          return online;
        }
        return await storedPage(cache,request)||online;
      }catch(error){const saved=await storedPage(cache,request);if(saved)return saved;throw error;}
    })();
    event.respondWith(response);
    // CacheStorage can be evicted independently of the installed worker. Rebuild
    // missing lazy assets after an online visit; concurrent visits share one repair.
    event.waitUntil(response.then(page=>html(page)?repairShell():undefined).catch(()=>{}));
    return;
  }
  const prepared=(async()=>{
    const cache=await currentCache(),saved=await match(cache,request);
    const network=fetch(request).then(async response=>{
      if(cache&&response.status===200){try{await cache.put(request,response.clone());}catch(_error){}}
      return response;
    }).catch(error=>{if(saved)return saved;throw error;});
    return {saved,network};
  })();
  event.respondWith(prepared.then(({saved,network})=>saved||network));
  // Keep refresh writes alive even when a cached response can return immediately.
  event.waitUntil(prepared.then(({network})=>network).catch(()=>{}));
});
