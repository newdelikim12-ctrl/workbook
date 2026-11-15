"""Core learning/deck failure regressions; isolated Chromium storage and synthetic words."""
from functools import partial
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import json
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass

def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(ROOT)))
    Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
            results=[]
            for width in [320,390,1280]:
                context=browser.new_context(viewport={'width':width,'height':900},service_workers='block')
                context.add_init_script("""if(!localStorage.getItem('core-seed')){
                  localStorage.setItem('decks',JSON.stringify([{id:'a',name:'A',words:[{eng:'cat',kor:'고양이',example:['Keep.'],note:[{eng:'kitten',kor:'직접 메모'}],custom:7},{eng:'dog',kor:'개'}],stats:{correct:3},dupes:[]},{id:'b',name:'B',words:[{eng:'fish',kor:'물고기'}],stats:{},dupes:[]}]));
                  localStorage.setItem('activeDeckId','a');localStorage.setItem('soundOn','0');localStorage.setItem('autoSpeak','0');localStorage.setItem('core-seed','1');}
                """)
                page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('dialog',lambda d:d.accept())
                page.goto(f'http://127.0.0.1:{server.server_address[1]}/',wait_until='domcontentloaded')
                page.wait_for_function('!!window.WrongArchive && !!window.CaptureNotebook')
                original=page.evaluate('JSON.stringify(decks[0].words)')
                page.evaluate("""()=>{flushDecks();window.coreSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='decks')throw new DOMException('full','QuotaExceededError');return coreSet.call(this,k,v);};lsOpenInStudy(0);autoPlay=true;nextCard();}""")
                assert page.evaluate('JSON.stringify(decks[0].words)')==original
                assert page.evaluate('currentIndex===0&&!autoPlay')
                assert '자동재생 중' not in page.locator('#autoPlayBtn').inner_text()
                page.evaluate('markWrong(0);del(0)');page.locator('#confirmBack.show .cf-ok').click()
                assert page.evaluate('decks.length===2&&words.length===2')
                page.evaluate('deleteDeck("b")');page.locator('#confirmBack.show .cf-ok').click()
                assert page.evaluate('decks.length===2&&activeDeckId==="a"')
                page.evaluate('Storage.prototype.setItem=coreSet;markWrong(0)')
                assert page.evaluate('decks.length===3&&decks.find(d=>d.kind==="wrong").words[0].custom===7')
                page.reload(wait_until='domcontentloaded')
                assert page.evaluate('words[0].wrong&&words[0].note[0].kor==="직접 메모"')
                page.evaluate("""()=>{window.prompt=()=> 'Audit deck';window.coreNow=Date.now;Date.now=()=>1234;createDeck();createDeck();Date.now=coreNow;}""")
                assert page.evaluate('decks.length===5&&new Set(decks.map(d=>d.id)).size===5')
                created=page.evaluate('activeDeckId');page.evaluate('id=>deleteDeck(id)',created);page.locator('#confirmBack.show .cf-ok').click()
                assert page.evaluate('decks.length===4&&activeDeckId==="a"&&words.length===2')
                assert page.locator('#front').inner_text()=='단어를 선택하세요'
                page.evaluate('del(0);words[0].kor="Changed after confirmation"');page.locator('#confirmBack.show .cf-ok').click()
                assert page.evaluate('words.length===2')
                page.evaluate('del(0)');page.locator('#confirmBack.show .cf-ok').click()
                assert page.evaluate('words.length===1&&words[0].eng==="dog"')
                page.reload(wait_until='domcontentloaded')
                assert page.evaluate('words.length===1&&words[0].eng==="dog"&&decks[1].words[0].eng==="fish"')
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                assert not errors,errors
                results.append({'width':width,'failedLearningAndDeletionRollback':True,'autoplayStops':True,'wrongCopyPreserved':True,'uniqueDeckIDs':True,'deckDeleteAndSwitch':True,'exactConfirmedWord':True,'reload':True,'errors':errors})
                context.close()
            browser.close();print(json.dumps({'passed':True,'cases':results}))
    finally:
        server.shutdown();server.server_close()
if __name__=='__main__':main()
