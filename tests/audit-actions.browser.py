"""Continuous review, selective deletion, accepted spellings and long-list regressions."""
from functools import partial
from http.server import ThreadingHTTPServer
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from threading import Thread
import json
import os
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
spec=spec_from_file_location('audit_baseline',Path(__file__).with_name('word-audit.browser.py'))
baseline=module_from_spec(spec);spec.loader.exec_module(baseline)


def seed(page,base,decks):
    page.goto(base,wait_until='domcontentloaded')
    page.evaluate("""decks=>{localStorage.clear();localStorage.setItem('decks',JSON.stringify(decks));
      localStorage.setItem('activeDeckId','a');localStorage.setItem('activeTab','decks');localStorage.setItem('soundOn','0');}""",decks)
    page.reload(wait_until='domcontentloaded');page.evaluate('flushDecks()')
    page.locator('#wordAuditOpen').click()


def scan(page):
    page.locator('#waSpellingTab').click();page.locator('#waScan').click()
    page.wait_for_function("document.getElementById('waStatus').textContent.includes('검사 완료')",timeout=90000)


def row(page,word):
    return page.locator('#waResults .wa-entry').filter(has=page.locator('.wa-word').filter(has_text=word))


def idle(page):
    page.wait_for_function("!document.getElementById('waScan').disabled")


def continuous(browser,base):
    context=browser.new_context(viewport={'width':390,'height':844},service_workers='block')
    page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)));page.on('dialog',lambda dialog:dialog.dismiss())
    fixture=json.loads(json.dumps(baseline.DECKS));fixture[0]['words'].append({'eng':'seperate','kor':'분리하다'})
    fixture[1]['words'][0].update({'example':['Selected duplicate example.'],'note':[{'eng':'only here','kor':'선택한 항목의 메모'}],'custom':{'keep':1}})
    seed(page,base,fixture);wrong=page.evaluate('JSON.stringify(decks[2])');scan(page)
    assert row(page,'recieve').count()==1 and row(page,'cat').count()==1 and row(page,'seperate').count()==1
    assert row(page,'Xylophonix').count()==0
    page.locator('#waShowReview').check();assert row(page,'Xylophonix').count()==1
    # Saving an unchanged candidate must not duplicate its row.
    row(page,'seperate').locator('[data-action=edit]').click();page.locator('#waEditor button[type=submit]').click();idle(page)
    assert row(page,'seperate').count()==1
    page.evaluate("""()=>{window.auditEngine=WordSpelling;window.auditChecked=[];window.WordSpelling={...auditEngine,
      checkEnglish:(text,options)=>{auditChecked.push(text);return auditEngine.checkEnglish(text,options);}};}""")
    row(page,'recieve').locator('[data-action=edit]').click();page.locator('#waEnglish').fill('receive')
    page.locator('#waEditor button[type=submit]').click();idle(page)
    assert page.evaluate('auditChecked')==['receive']
    assert row(page,'recieve').count()==0 and row(page,'cat').count()==1 and row(page,'seperate').count()==1
    assert row(page,'Xylophonix').count()==1 and '검사 완료' in page.locator('#waStatus').inner_text()
    page.evaluate('()=>{auditChecked=[];}')
    row(page,'cat').locator('[data-action=edit]').click();page.locator('#waKorean').fill('역할을 하다')
    page.locator('#waEditor button[type=submit]').click();idle(page)
    assert page.evaluate('auditChecked')==['cat']
    assert row(page,'cat').count()==0 and row(page,'seperate').count()==1
    page.evaluate('()=>{window.WordSpelling=auditEngine;}')
    fixed=page.evaluate("words.find(w=>w.eng==='receive')")
    assert fixed['example']==fixture[0]['words'][1]['example'] and fixed['note']==fixture[0]['words'][1]['note'] and fixed['custom']==7
    # A failed preference save keeps both the candidate and its previous settings.
    page.evaluate("""()=>{window.auditWrite=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){
      if(key==='wordbook.spelling.accepted.v1')throw Error('quota');return auditWrite.call(this,key,value);};}""")
    row(page,'Xylophonix').locator('[data-action=accept]').click()
    assert '저장하지 못했습니다' in page.locator('#waActionMessage').inner_text() and row(page,'Xylophonix').count()==1
    page.evaluate('()=>{Storage.prototype.setItem=auditWrite;}')
    row(page,'Xylophonix').locator('[data-action=accept]').click()
    assert row(page,'Xylophonix').count()==0 and row(page,'seperate').count()==1
    assert json.loads(page.evaluate("localStorage.getItem('wordbook.spelling.accepted.v1')"))==['xylophonix']
    page.locator('#waScan').click();page.wait_for_function("document.getElementById('waStatus').textContent.includes('검사 완료')")
    assert row(page,'Xylophonix').count()==0 and row(page,'seperate').count()==1
    page.locator('.wa-accepted summary').click();page.locator('[data-action=unaccept]').click()
    page.locator('#waScan').click();page.wait_for_function("document.getElementById('waStatus').textContent.includes('검사 완료')")
    assert row(page,'Xylophonix').count()==1
    row(page,'Xylophonix').locator('[data-action=accept]').click()
    # Delete exactly the chosen inactive duplicate; a failed save and a stale view do nothing.
    page.locator('#waDupesTab').click()
    selected=page.locator('.wa-group .wa-entry').filter(has=page.locator('.wa-location',has_text='심화'))
    selected.locator('.wa-saved-details summary').click();assert '선택한 항목의 메모' in selected.inner_text()
    selected.locator('[data-action=delete]').click()
    assert '심화 · 1번만 삭제' in page.locator('.wa-delete-confirm').inner_text()
    before=page.evaluate("localStorage.getItem('decks')")
    page.evaluate("""()=>{window.auditWrite=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){
      if(key==='decks')throw Error('quota');return auditWrite.call(this,key,value);};}""")
    page.locator('[data-action=confirm-delete]').click()
    assert '삭제하지 않았습니다' in page.locator('.wa-delete-confirm .wa-error').inner_text()
    assert page.evaluate("localStorage.getItem('decks')")==before and page.locator('.wa-group .wa-entry').count()==2
    page.evaluate("()=>{Storage.prototype.setItem=auditWrite;window.auditDeleteTarget=decks[1].words[0];auditDeleteTarget.kor='새 메모와 함께 바뀐 뜻';}")
    page.locator('[data-action=confirm-delete]').click();assert '변경' in page.locator('.wa-delete-confirm .wa-error').inner_text()
    page.evaluate("()=>{auditDeleteTarget.kor='다른 사과';}")
    page.locator('[data-action=confirm-delete]').click()
    assert page.locator('.wa-group').count()==0 and page.evaluate("decks[1].words[0].eng")=='banana'
    assert page.evaluate('JSON.stringify(decks[2])')==wrong and page.evaluate('words[0].eng')=='apple'
    page.locator('#waSpellingTab').click();assert row(page,'seperate').count()==1
    assert '검사 완료' in page.locator('#waStatus').inner_text()
    # Removal from the active deck follows the currently viewed surviving word.
    page.locator('[data-action=close]').click()
    page.evaluate("()=>{decks[1].words.push({eng:'apple',kor:'남겨 둘 사과'});currentIndex=words.findIndex(w=>w.eng==='receive');saveDecks();}")
    page.locator('#wordAuditOpen').click()
    active=page.locator('.wa-group .wa-entry').filter(has=page.locator('.wa-location',has_text='기초'))
    active.locator('[data-action=delete]').click();page.locator('[data-action=confirm-delete]').click()
    assert page.evaluate("words[currentIndex].eng")=='receive' and page.evaluate('currentIndex')==0
    assert page.locator('.wa-group').count()==0 and page.evaluate('JSON.stringify(decks[2])')==wrong
    page.locator('[data-action=close]').click();page.reload(wait_until='domcontentloaded')
    assert page.evaluate("words[0].eng")=='receive'
    assert page.evaluate('JSON.stringify(decks[2])')==wrong
    page.locator('#wordAuditOpen').click();scan(page);page.locator('#waShowReview').check()
    assert row(page,'Xylophonix').count()==0 and row(page,'seperate').count()==1
    # A committed edit may finish checking after closing; it must not alter a reopened review.
    page.evaluate("""()=>{window.auditEngine=WordSpelling;window.WordSpelling={...auditEngine,
      checkEnglish:()=>new Promise(resolve=>{window.auditFinishRecheck=resolve;})};}""")
    row(page,'seperate').locator('[data-action=edit]').click();page.locator('#waEnglish').fill('separate')
    page.locator('#waEditor button[type=submit]').click()
    page.wait_for_function("typeof window.auditFinishRecheck==='function'")
    page.locator('[data-action=close]').click();page.locator('#wordAuditOpen').click()
    page.evaluate('()=>{window.WordSpelling=auditEngine;auditFinishRecheck([]);}')
    page.wait_for_timeout(100)
    assert page.locator('#waDupesTab').get_attribute('aria-selected')=='true'
    assert page.locator('.wa-group').count()==0
    page.locator('[data-action=close]').click()
    # Deleting the currently viewed record clears the card while preserving its other copy.
    page.evaluate("()=>{words.push({eng:'banana',kor:'삭제할 현재 카드'});currentIndex=words.length-1;saveDeckData();}")
    page.locator('#wordAuditOpen').click()
    active=page.locator('.wa-group .wa-entry').filter(has=page.locator('.wa-location',has_text='기초'))
    active.locator('[data-action=delete]').click();page.locator('[data-action=confirm-delete]').click()
    assert page.evaluate('currentIndex')==-1 and page.locator('#front').inner_text()=='단어를 선택하세요'
    assert page.evaluate("decks[1].words[0].eng")=='banana' and page.evaluate('JSON.stringify(decks[2])')==wrong
    page.locator('[data-action=close]').click();page.reload(wait_until='domcontentloaded')
    assert page.evaluate("words.some(w=>w.eng==='separate')")
    page.locator('#wordAuditOpen').click();scan(page)
    if os.environ.get('WORD_AUDIT_SCREENSHOTS'):
        directory=Path(os.environ['WORD_AUDIT_SCREENSHOTS']);directory.mkdir(parents=True,exist_ok=True)
        page.screenshot(path=str(directory/'word-audit-continuous-mobile.png'))
    assert not errors,errors
    context.close()
    return {'continuousSingleWordRecheck':True,'unchangedSaveNoDuplicates':True,'acceptedTermsPersistAndCanBeRemoved':True,
            'selectiveDeleteAndRollback':True,'wrongCopiesAndOtherFieldsPreserved':True,'activeCardIndex':True,'lateRecheckIsolation':True,'errors':errors}


def long_list(browser,base):
    context=browser.new_context(viewport={'width':1280,'height':900},service_workers='block');page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    fixture=[{'id':'a','name':'긴 단어장','words':[{'eng':f'recieve {i}','kor':f'뜻 {i}'} for i in range(105)],'stats':{},'dupes':[]}]
    seed(page,base,fixture);scan(page)
    assert page.locator('#waResults .wa-entry').count()==80
    page.locator('#waMore').click();assert page.locator('#waResults .wa-entry').count()==105
    target=page.locator('#waResults .wa-entry').filter(has=page.get_by_text('recieve 90',exact=True))
    target.locator('[data-action=edit]').click();page.locator('#waEnglish').fill('receive 90')
    page.locator('#waEditor button[type=submit]').click();idle(page)
    assert page.locator('#waResults .wa-entry').count()==104
    assert page.get_by_text('recieve 104',exact=True).count()==1
    assert page.locator('#wordAuditDialog').evaluate('(e)=>e.scrollTop')>1000
    assert '검사 완료' in page.locator('#waStatus').inner_text() and not errors,errors
    context.close();return {'longListResultsAndPositionKept':True,'errors':errors}


def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(baseline.Quiet,directory=str(ROOT)));Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
            base=f'http://127.0.0.1:{server.server_address[1]}/';reports=[continuous(browser,base),long_list(browser,base)];browser.close()
        print(json.dumps(reports,ensure_ascii=False))
    finally:server.shutdown();server.server_close()


if __name__=='__main__':main()
