"""Known words can be removed from the active wrong notebook during study only."""
from functools import partial
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import json
import os
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
DECKS=[
    {'id':'ordinary','name':'원본 단어장','words':[{'eng':'cat','kor':'원본 고양이','wrong':True,'mastered':True,
      'example':['Original example.','Another original.'],'note':[{'eng':'kitten','kor':'남겨 둘 원본 메모'}],'custom':7}],'stats':{'correct':9},'dupes':[]},
    {'id':'deck_wrong_review','name':'다시 볼 단어','words':[
      {'eng':'cat','kor':'오답 복사본','example':['Review example.'],'note':'지울 복사본 메모'},
      {'eng':'dog','kor':'다음 학습 단어','example':['Dog example.'],'note':'다음 단어 메모'},
      {'eng':'bird','kor':'이미 외운 단어','mastered':True}],'stats':{'correct':2},'dupes':[]},
    {'id':'otherwrong','name':'다른 복습장','kind':'wrong','words':[{'eng':'cat','kor':'다른 오답 복사본','note':'별도 보존 메모'}],'stats':{},'dupes':[]}
]


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*_args):pass


def confirm(page):
    page.locator('#confirmBack.show .cf-ok').click()


def run(browser,base,width):
    context=browser.new_context(viewport={'width':width,'height':844},is_mobile=width<600,has_touch=width<600,service_workers='block')
    page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)));page.on('dialog',lambda dialog:dialog.dismiss())
    page.goto(base,wait_until='domcontentloaded')
    page.evaluate("""decks=>{localStorage.setItem('decks',JSON.stringify(decks));localStorage.setItem('activeDeckId','deck_wrong_review');
      localStorage.setItem('wrongDeckId','deck_wrong_review');localStorage.setItem('activeTab','study');localStorage.setItem('soundOn','0');}""",DECKS)
    page.reload(wait_until='domcontentloaded');page.evaluate('flushDecks();lsOpenInStudy(0)')
    original=page.evaluate('JSON.stringify(decks[0])');other=page.evaluate('JSON.stringify(decks[2])')
    assert page.locator('#front').inner_text()=='cat'
    assert page.locator('#cardNextBtn').inner_text()=='외웠음 · 보관'
    assert page.locator('#cardNextBtn').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
    if os.environ.get('WORD_STUDY_SCREENSHOTS'):
        directory=Path(os.environ['WORD_STUDY_SCREENSHOTS']);directory.mkdir(parents=True,exist_ok=True)
        page.screenshot(path=str(directory/f'wrong-study-delete-{width}.png'))
    # Cancel does not touch either the copy or the original.
    before=page.evaluate("localStorage.getItem('decks')")
    page.locator('#cardNextBtn').click()
    assert '다시 볼 단어의 학습 목록에서 빼고 보관함' in page.locator('#confirmMsg').inner_text()
    page.locator('#confirmBack .cf-cancel').click()
    assert page.evaluate("localStorage.getItem('decks')")==before and page.locator('#front').inner_text()=='cat'
    page.locator('#cardNextBtn').click();confirm(page)
    assert page.locator('#front').inner_text()=='dog'
    assert page.evaluate('words.map(w=>w.eng)')==['dog','bird']
    assert page.evaluate('getWrongArchiveEntries().length')==1
    assert page.evaluate('getWrongArchiveEntries()[0].word.note')=='지울 복사본 메모'
    assert page.evaluate('JSON.stringify(decks[0])')==original and page.evaluate('JSON.stringify(decks[2])')==other
    # A quota failure leaves the current card and exact in-memory array intact.
    before=page.evaluate("localStorage.getItem('decks')")
    page.evaluate("""()=>{window.studyWords=words;window.studyWrite=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){if(key==='decks')throw Error('quota');return studyWrite.call(this,key,value);};}""")
    page.locator('#cardNextBtn').click();confirm(page)
    assert page.locator('#front').inner_text()=='dog' and page.evaluate('words===studyWords')
    assert page.evaluate("localStorage.getItem('decks')")==before
    page.evaluate('()=>{Storage.prototype.setItem=studyWrite;}')
    page.locator('#cardNextBtn').click();confirm(page)
    assert page.evaluate('words.map(w=>w.eng)')==['bird']
    assert page.evaluate('currentIndex')==-1 and not page.locator('#cardActions').is_visible()
    # The mastered row is removable without navigating to another notebook.
    page.locator('#tabList').click()
    row=page.locator('#lsList .ls-row');assert row.count()==1
    row.locator('[data-action=delete-wrong-word]').click();confirm(page)
    assert page.evaluate('words.length')==0 and page.evaluate('activeDeckId')=='deck_wrong_review'
    assert page.evaluate('JSON.stringify(decks[0])')==original and page.evaluate('JSON.stringify(decks[2])')==other
    # Additional kind-marked wrong notebooks get the same immediate action.
    page.evaluate("switchDeck('otherwrong','study')")
    if not page.locator('#allWords').evaluate('(e)=>e.classList.contains("open")'):
        page.locator('h3').filter(has_text='전체 단어').click()
    page.locator('#allWordsList .wl-row [data-action=delete-wrong-word]').click();confirm(page)
    assert page.evaluate('words.length')==0 and page.evaluate('JSON.stringify(decks[0])')==original
    page.reload(wait_until='domcontentloaded')
    assert page.evaluate('decks.find(d=>d.id==="deck_wrong_review").words.length')==0
    assert page.evaluate('decks.find(d=>d.id==="otherwrong").words.length')==0
    assert page.evaluate('getWrongArchiveEntries().length')==4
    assert page.evaluate('JSON.stringify(decks[0])')==original
    # Ordinary originals, even when marked wrong, have no new delete action.
    page.evaluate("switchDeck('ordinary','study');lsOpenInStudy(0)")
    assert '삭제' not in page.locator('#cardNextBtn').inner_text()
    assert page.locator('[data-action=delete-wrong-word]').count()==0
    before=page.evaluate("localStorage.getItem('decks')");page.evaluate('deleteWrongStudyWord(0)')
    assert not page.locator('#confirmBack').evaluate('(e)=>e.classList.contains("show")')
    assert page.evaluate("localStorage.getItem('decks')")==before and page.evaluate('JSON.stringify(decks[0])')==original
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth') and not errors,errors
    context.close();return {'width':width,'cardAndListDelete':True,'nextEligibleCard':True,'quotaRollback':True,
      'onlySelectedWrongNotebook':True,'originalNotesAndExamplesPreserved':True,'reload':True,'errors':errors}


def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(ROOT)));Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
            result=[run(browser,f'http://127.0.0.1:{server.server_address[1]}/',width) for width in [320,390,1280]];browser.close()
        print(json.dumps(result,ensure_ascii=False))
    finally:server.shutdown();server.server_close()


if __name__=='__main__':main()
