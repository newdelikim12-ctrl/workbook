// 단어 연습장 서비스워커
const CACHE='wordbook-v38';
const SHELL=["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png", "./captures-store.js", "./captures-media.js", "./captures.js", "./captures.css", "./vendor/pdfjs/font-assets-01.json", "./vendor/pdfjs/font-assets-02.json", "./vendor/pdfjs/font-assets-03.json", "./vendor/pdfjs/font-assets-04.json", "./vendor/pdfjs/font-assets-05.json", "./vendor/pdfjs/font-assets-06.json", "./vendor/pdfjs/font-assets-07.json", "./vendor/pdfjs/font-assets.json", "./vendor/pdfjs/jbig2_nowasm_fallback.js", "./vendor/pdfjs/openjpeg_nowasm_fallback.js", "./vendor/pdfjs/pdf.min.mjs", "./vendor/pdfjs/pdf.worker.min.mjs", "./word-audit.js?v=2026-11-13.98", "./word-audit.css?v=2026-11-13.98", "./word-spelling.js?v=2026-11-13.98", "./vendor/word-check/nspell.mjs", "./vendor/word-check/en-US.aff", "./vendor/word-check/en-US.dic", "./vendor/word-check/en-GB.aff", "./vendor/word-check/en-GB.dic"];

self.addEventListener('install',e=>{
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).catch(()=>{}));
});
self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('wordbook-')&&k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});
self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);
  // Keep online dictionary requests out of the asset cache.
  if(url.hostname==='api.dictionaryapi.dev') return;
  // 페이지(HTML): 네트워크 우선 → 수정사항이 온라인에서 항상 바로 반영, 오프라인이면 캐시
  if(req.mode==='navigate'||req.destination==='document'){
    e.respondWith(
      fetch(req).then(res=>{
        const copy=res.clone();
        caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{});
        return res;
      }).catch(()=>caches.match(req).then(r=>r||caches.match('./index.html')))
    );
    return;
  }
  // 그 외(아이콘/폰트 등): 캐시 우선, 뒤에서 갱신
  e.respondWith(
    caches.match(req).then(cached=>{
      const net=fetch(req).then(res=>{
        if(res&&res.status===200){const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{});}
        return res;
      }).catch(()=>cached);
      return cached||net;
    })
  );
});

