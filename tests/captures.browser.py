"""Capture notebook browser regressions. Run: python tests/captures.browser.py.
Requires Python Playwright and Chromium (system Chromium or Playwright install).
All browsers use isolated temporary storage; existing browser data is never opened.
"""
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import json
import shutil
import struct
import zlib
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass

def png(path,width,height,color):
    def chunk(kind,data):
        return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    raw=(b'\0'+bytes(color)*width)*height
    path.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b''))

def pdf(path):
    objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>']
    for page in range(3):
        content=('BT /F1 24 Tf 30 350 Td (CAPTURE PDF PAGE '+str(page+1)+') Tj ET').encode()
        objects.append(('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 9 0 R >> >> /Contents '+str(4+page*2)+' 0 R >>').encode())
        objects.append(b'<< /Length '+str(len(content)).encode()+b' >>\nstream\n'+content+b'\nendstream')
    objects.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    out=bytearray(b'%PDF-1.4\n');offsets=[0]
    for i,obj in enumerate(objects,1):
        offsets.append(len(out));out.extend(str(i).encode()+b' 0 obj\n'+obj+b'\nendobj\n')
    offset=len(out);out.extend(b'xref\n0 '+str(len(offsets)).encode()+b'\n0000000000 65535 f \n')
    for value in offsets[1:]:out.extend(f'{value:010d} 00000 n \n'.encode())
    out.extend(b'trailer\n<< /Size '+str(len(offsets)).encode()+b' /Root 1 0 R >>\nstartxref\n'+str(offset).encode()+b'\n%%EOF')
    path.write_bytes(out)

# STORE_CHECKS is inserted below from the real IndexedDB transaction regression.
STORE_CHECKS=r'''async()=>{
   const s=CaptureStore, checks=[];
   const assert=(v,m)=>{if(!v)throw Error(m);};
   const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
   localStorage.setItem('decks','word-data-untouched');
   const initial=await s.ready();assert(initial.groups.length===1&&initial.items.length===0,'default group');
   const inbox=initial.groups[0].id,math=await s.createGroup('  수학  ');assert(math.name==='수학','group trim');
   const added=await s.addFiles(inbox,[new File(['image-one'],'first.png',{type:'image/png'}),new File(['%PDF-1.7 example'],'lesson.pdf',{type:'application/pdf'})]);
   assert(added.length===2&&added[0].order===0&&added[1].order===1,'batch order');
   const note=await s.addNote(inbox,'첫 줄\n\n둘째 줄',added[0].id);
   let items=await s.listItems(inbox);assert(equal(items.map(i=>i.kind),['image','note','pdf']),'insert note between files');
   assert(equal(items.map(i=>i.order),[0,1,2]),'contiguous order');
   await s.updateItem(added[0].id,{title:'복습 이미지',caption:'메모 첫 줄\n둘째 줄',rotation:90});
   assert(await(await s.getFile(added[0].fileId)).text()==='image-one','blob retained');
   await s.moveItem(added[1].id,math.id);assert((await s.listItems(math.id))[0].id===added[1].id,'move file');
   await s.reorderItem(note.id,-1);items=await s.listItems(inbox);assert(items[0].id===note.id,'move order');
   await s.reorderItems(inbox,items.map(i=>i.id).reverse());assert((await s.listItems(inbox))[0].id===added[0].id,'full reorder');
   checks.push('files, groups, interleaved notes, editing, movement and ordering');
   const before=await s.ready(),fileCountBefore=JSON.parse(await(await s.exportArchive()).text()).files.length;
   const put=IDBObjectStore.prototype.put;let writes=0,failed=false;
   IDBObjectStore.prototype.put=function(...args){if(this.name==='items'&&++writes===2)throw new DOMException('full','QuotaExceededError');return put.apply(this,args);};
   try{await s.addFiles(inbox,[new File(['new-one'],'new.png',{type:'image/png'}),new File(['new-two'],'new2.png',{type:'image/png'})]);}catch(e){failed=e.name==='QuotaExceededError';}finally{IDBObjectStore.prototype.put=put;}
   assert(failed,'quota error surfaced');assert(equal(await s.ready(),before),'quota abort metadata rollback');
   assert(JSON.parse(await(await s.exportArchive()).text()).files.length===fileCountBefore,'quota abort blob rollback');
   let rejected=false;try{await s.reorderItems(inbox,['missing']);}catch(e){rejected=true;}assert(rejected&&equal(await s.ready(),before),'stale reorder rejected');
   rejected=false;try{await s.addNote(inbox,'draft','missing-anchor');}catch(e){rejected=true;}assert(rejected&&equal(await s.ready(),before),'stale insertion rejected');
   checks.push('atomic cross-store quota rollback and stale-operation protection');
   const archive=await s.exportArchive(),raw=JSON.parse(await archive.text());assert(raw.format==='workbook-captures'&&raw.version===1,'backup format');
   assert(raw.files.length===2,'backup blob count');
   const restored=await s.importArchive(archive);assert(restored.items.length===before.items.length*2&&restored.groups.length===before.groups.length*2,'append restored count');
   for(const item of before.items)assert(equal(restored.items.find(i=>i.id===item.id),item),'restore preserved existing item');
   for(const item of restored.items.filter(i=>!before.items.some(old=>old.id===i.id))){
    if(item.kind==='note')assert(item.text==='첫 줄\n\n둘째 줄','restored multiline note');
    if(item.kind==='image')assert(await(await s.getFile(item.fileId)).text()==='image-one','restored image blob');
    if(item.kind==='pdf')assert(await(await s.getFile(item.fileId)).text()==='%PDF-1.7 example','restored PDF blob');
   }
   const bad=structuredClone(raw);bad.items.find(i=>i.kind==='image').fileId='missing';
   rejected=false;try{await s.importArchive(JSON.stringify(bad));}catch(e){rejected=true;}assert(rejected&&equal(await s.ready(),restored),'invalid archive is atomic');
   rejected=false;try{await s.importArchive('{bad-json');}catch(e){rejected=true;}assert(rejected&&equal(await s.ready(),restored),'malformed archive is atomic');
   checks.push('archive roundtrip, remapped IDs, original blobs and invalid backup preservation');
   await Promise.all([s.addNote(inbox,'concurrent A'),s.addNote(inbox,'concurrent B')]);
   items=await s.listItems(inbox);assert(items.filter(i=>i.text.startsWith('concurrent')).length===2,'concurrent additions kept');assert(equal(items.map(i=>i.order),items.map((_,i)=>i)),'concurrent contiguous order');
   checks.push('concurrent transactions reread current records');
   const movedFile=await s.getFile(added[1].fileId);assert(movedFile.size>0,'file before group deletion');
   await s.deleteGroup(math.id);rejected=false;try{await s.getFile(added[1].fileId);}catch(e){rejected=true;}assert(rejected,'deleted group removes blobs');
   await s.removeItem(added[0].id);rejected=false;try{await s.getFile(added[0].fileId);}catch(e){rejected=true;}assert(rejected,'deleted item removes blob');
   assert(localStorage.getItem('decks')==='word-data-untouched','word storage untouched');
   checks.push('atomic group/item deletion and vocabulary storage isolation');
   return {passed:true,checks,groups:(await s.listGroups()).length,items:(await s.listItems()).length};
  }'''


def run():
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(ROOT)))
    Thread(target=server.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{server.server_address[1]}'
    reports=[]
    try:
        with TemporaryDirectory() as temp,sync_playwright() as p:
            fixtures=Path(temp);one=fixtures/'first.png';two=fixtures/'second.png';document=fixtures/'lesson.pdf'
            png(one,180,240,(70,110,160));png(two,240,140,(150,100,70));pdf(document)
            binary=shutil.which('chromium') or shutil.which('google-chrome')
            options={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
            if binary:options['executable_path']=binary
            browser=p.chromium.launch(**options)
            isolated=browser.new_context(service_workers='block')
            store_page=isolated.new_page();store_page.goto(base+'/manifest.json')
            store_page.add_script_tag(url=base+'/captures-store.js')
            reports.append(store_page.evaluate(STORE_CHECKS));isolated.close()
            for width,height in [(320,740),(390,844),(1280,960)]:
                context=browser.new_context(viewport={'width':width,'height':height},is_mobile=width<600,has_touch=width<600,service_workers='allow' if width==390 else 'block',accept_downloads=True)
                context.route('https://cdn.jsdelivr.net/**',lambda route:route.abort())
                context.add_init_script("if(!localStorage.getItem('capture-regression-seeded')){localStorage.setItem('decks',JSON.stringify([{id:'words',name:'기존 단어장',words:[{eng:'keep',kor:'유지하다',example:['Keep my example.'],note:[{eng:'retained',kor:'보존한 메모'}]},{eng:'safe',kor:'안전한'}],stats:{},dupes:[]}]));localStorage.setItem('activeDeckId','words');localStorage.setItem('darkMode','0');localStorage.setItem('capture-regression-seeded','1');}")
                page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                page.goto(base+'/',wait_until='domcontentloaded');page.wait_for_function('!!window.CaptureNotebook')
                page.evaluate('showWord(words[0],0);autoPlay=true;autoPlaySpeed=1;scheduleAutoPlay()')
                words_before=page.evaluate('JSON.stringify(words)');page.evaluate('flushDecks()');disk_before=page.evaluate("localStorage.getItem('decks')")
                page.locator('#tabCapture').click();page.wait_for_selector('#cnGroupChips button')
                assert page.evaluate('autoPlay') is False
                assert page.locator('#captureView').is_visible() and page.locator('#studyView').is_hidden()
                page.keyboard.press('w');page.keyboard.press('p');page.keyboard.press('Space');page.keyboard.press('ArrowRight')
                assert page.locator('#captureView').is_visible() and page.evaluate('currentIndex')==0
                page.locator('[data-action=new-group]').click();page.locator('#cnField-name').fill('시험 캡처');page.locator('#cnEditor button[type=submit]').click()
                page.wait_for_function("document.querySelector('.cn-group-title').textContent==='시험 캡처'")
                page.locator('#cnFileInput').set_input_files([str(one),str(two),str(document)])
                page.wait_for_function("document.querySelectorAll('#cnItems .cn-item').length===3",timeout=20000)
                pdf_card=page.locator('#cnItems .cn-item').nth(2);pdf_card.scroll_into_view_if_needed()
                page.wait_for_function("document.querySelectorAll('#cnItems .cn-pdf-page').length===3",timeout=20000)
                pdf_card.locator('[data-action=zoom]').click();page.wait_for_selector('#cnViewer .cn-pdf-page')
                assert page.locator('#cnViewer .cn-pdf-page').count()==3
                page.locator('#cnViewer button[aria-label="확대"]').click();assert page.locator('.cn-zoom-level').inner_text()=='125%'
                page.locator('#cnViewer button[aria-label="오른쪽으로 회전"]').click();page.locator('#cnViewer button[aria-label="확대 보기 닫기"]').click()
                first=page.locator('#cnItems .cn-item').first;first.locator('summary').click();first.locator('[data-action=insert-note]').click()
                page.locator('#cnField-text').fill('핵심 첫 줄');page.locator('#cnField-text').press('Enter');page.keyboard.insert_text('둘째 줄 with W and P')
                assert page.locator('#cnEditor').evaluate('(e)=>e.open')
                page.locator('#cnEditor button[type=submit]').click();page.wait_for_function("document.querySelectorAll('#cnItems .cn-item').length===4")
                assert page.locator('#cnItems .cn-item').nth(1).locator('.cn-note-text').inner_text()=='핵심 첫 줄\n둘째 줄 with W and P'
                first=page.locator('#cnItems .cn-item').first;first.locator('[data-action=edit-item]').click()
                page.locator('#cnField-title').fill('첫 캡처');page.locator('#cnField-caption').fill('자료 메모\n보존할 줄바꿈');page.locator('#cnEditor button[type=submit]').click()
                page.wait_for_function("document.querySelector('#cnItems .cn-item-title').textContent==='첫 캡처'")
                page.locator('[data-action=mode-list]').click();assert page.locator('#cnItems').get_attribute('data-mode')=='list'
                page.locator('#cnItems .cn-item').first.locator('summary').click()
                menu=page.locator('#cnItems .cn-item').first.locator('.cn-menu-panel').bounding_box();assert menu['x']>=0 and menu['x']+menu['width']<=width
                page.locator('#cnItems .cn-item').first.locator('summary').click()
                page.locator('#cnSearch').fill('핵심');assert page.locator('#cnItems .cn-item').count()==1
                page.locator('#cnSearch').fill('');page.locator('[data-action=mode-feed]').click()
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),('horizontal overflow',width)
                page.locator('[data-action=new-note]').click();page.locator('#cnField-text').fill('저장 실패에도 유지할 초안\n둘째 줄')
                page.evaluate("()=>{window.originalCapturePut=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='items')throw new DOMException('quota','QuotaExceededError');return window.originalCapturePut.apply(this,args);};}")
                page.locator('#cnEditor button[type=submit]').click();page.wait_for_selector('#cnEditor .cn-dialog-error:not(:empty)')
                assert page.locator('#cnField-text').input_value()=='저장 실패에도 유지할 초안\n둘째 줄'
                page.evaluate('()=>{IDBObjectStore.prototype.put=window.originalCapturePut;}');page.locator('#cnEditor button[type=button]').click()
                if width==390:
                    before=page.evaluate('CaptureStore.ready()')
                    with page.expect_download() as downloaded:page.locator('[data-action=export]').click()
                    backup=downloaded.value.path();assert json.loads(Path(backup).read_text())['format']=='workbook-captures'
                    page.locator('#cnRestoreInput').set_input_files(backup);page.locator('#cnEditor button[type=submit]').click()
                    page.wait_for_function('(n)=>CaptureStore.ready().then(s=>s.items.length===n)',arg=len(before['items'])*2)
                    snapshot=page.evaluate('CaptureStore.ready()');assert len(snapshot['groups'])==len(before['groups'])*2
                    for item in before['items']:assert item in snapshot['items']
                    page.locator('#cnGroupChips button').filter(has_text='시험 캡처').first.click()
                    page.wait_for_function("document.querySelectorAll('#cnItems .cn-item').length===4")
                    bad=fixtures/'invalid.json';bad.write_text('{bad-json')
                    page.locator('#cnRestoreInput').set_input_files(str(bad));page.locator('#cnEditor button[type=submit]').click();page.wait_for_selector('#cnEditor .cn-dialog-error:not(:empty)')
                    assert page.evaluate('CaptureStore.ready()')==snapshot
                    page.locator('#cnEditor button[type=button]').click()
                    page.evaluate('()=>navigator.serviceWorker.ready');page.wait_for_function('!!navigator.serviceWorker.controller')
                    assert page.evaluate("async()=>!!(await(await caches.open('wordbook-v35')).match('vendor/pdfjs/pdf.worker.min.mjs'))")
                    context.set_offline(True);page.reload(wait_until='domcontentloaded')
                    page.wait_for_selector('#cnItems .cn-item');assert page.locator('#cnItems .cn-item').count()==4
                    pdf_card=page.locator('#cnItems .cn-item').filter(has_text='lesson.pdf');pdf_card.scroll_into_view_if_needed()
                    page.wait_for_function("document.querySelectorAll('#cnItems .cn-pdf-page').length===3",timeout=20000)
                    page.wait_for_selector('#cnItems canvas[data-rendered=true]',timeout=20000)
                    context.set_offline(False)
                else:
                    page.reload(wait_until='domcontentloaded');page.wait_for_selector('#cnItems .cn-item');assert page.locator('#cnItems .cn-item').count()==4
                assert page.locator('#cnItems .cn-note-text').inner_text()=='핵심 첫 줄\n둘째 줄 with W and P'
                assert page.locator('#cnItems .cn-caption').inner_text()=='자료 메모\n보존할 줄바꿈'
                assert page.evaluate('JSON.stringify(words)')==words_before
                assert page.evaluate("localStorage.getItem('decks')")==disk_before
                page.locator('#tabList').click();assert page.locator('#listStudyView').is_visible()
                page.locator('#tabStudy').click();assert page.locator('#studyView').is_visible()
                assert not errors,errors
                reports.append({'width':width,'multiFilePDFNotesZoom':True,'reload':True,'wordDataUnchanged':True,'offlineBackup':width==390,'errors':errors})
                context.close()
            browser.close()
        print(json.dumps(reports,ensure_ascii=False))
    finally:server.shutdown();server.server_close()

if __name__=='__main__':run()
