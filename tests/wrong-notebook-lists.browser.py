"""No wrong-notebook copies in current duplicates, spelling, or the old list."""
from functools import partial
from http.server import ThreadingHTTPServer
from importlib.util import module_from_spec,spec_from_file_location
from pathlib import Path
from threading import Thread
import json
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
spec=spec_from_file_location('audit_baseline',Path(__file__).with_name('word-audit.browser.py'))
baseline=module_from_spec(spec);spec.loader.exec_module(baseline)


def run(browser,base,width):
    context=browser.new_context(viewport={'width':width,'height':844},service_workers='block')
    page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    fixture=json.loads(json.dumps(baseline.DECKS))
    fixture[0]['words'].append({'eng':'seperate','kor':'분리하다','wrong':True,'note':'원본은 검사에 남아야 함'})
    fixture[0]['dupes']=[{'eng':'apple','sheets':['오답노트','옛 시트'],'n':3},
                         {'eng':'ghost','sheets':['삭제한 오답노트'],'n':1}]
    fixture[2]['words'] += [{'eng':'recieve','kor':'역활 복사본','note':'보존할 오답 메모'},
                            {'eng':'definately','kor':'오답노트에만 있는 단어'}]
    fixture += [
        {'id':'spaced','name':'📕 오\u3000답 노트 ２','words':[{'eng':'apple','kor':'사과 복사본'},{'eng':'recieve','kor':'역활'}],'stats':{},'dupes':[]},
        {'id':'deck_wrong_123','name':'다시 볼 단어','words':[{'eng':'apple','kor':'이름 바꾼 복사본'},{'eng':'adress','kor':'주소'}],'stats':{},'dupes':[]},
        {'id':'marked','name':'개인 복습','kind':'wrong','words':[{'eng':'apple','kor':'표시한 복사본'},{'eng':'grammer','kor':'문법'}],'stats':{},'dupes':[]},
    ]
    page.goto(base,wait_until='domcontentloaded')
    page.evaluate("""decks=>{localStorage.setItem('decks',JSON.stringify(decks));localStorage.setItem('activeDeckId','a');
      localStorage.setItem('wrongDeckId','wrong');localStorage.setItem('activeTab','study');localStorage.setItem('soundOn','0');}""",fixture)
    page.reload(wait_until='domcontentloaded');page.evaluate('flushDecks()')
    disk=page.evaluate("localStorage.getItem('decks')")
    wrong=page.evaluate('JSON.stringify(decks.filter(isWrongNotebookDeck))')
    classification=page.evaluate("getAllWordEntries().filter(e=>e.isWrongDeck).map(e=>e.deckId)")
    assert set(classification)=={'wrong','spaced','deck_wrong_123','marked'},classification
    page.locator('h3').filter(has_text='중복 단어').click()
    assert page.locator('#cntDupes').inner_text()=='(1)'
    legacy=page.locator('#dupesList').inner_text()
    assert '기초 1번' in legacy and '심화 1번' in legacy
    assert not any(text in legacy for text in ['오답','ghost','다시 볼 단어','개인 복습']),legacy
    page.locator('#tabDecks').click();page.locator('#wordAuditOpen').click()
    assert '일반 단어장 3개' in page.locator('#waSummary').inner_text()
    assert '오답노트 4개 제외' in page.locator('#waSummary').inner_text()
    assert page.locator('.wa-group').count()==1 and page.locator('.wa-group .wa-entry').count()==2
    page.locator('#waSpellingTab').click();page.locator('#waScan').click()
    page.wait_for_function("document.getElementById('waStatus').textContent.includes('검사 완료')",timeout=90000)
    assert sorted(page.locator('#waResults .wa-word').all_inner_texts())==['cat','recieve','seperate']
    page.locator('#waShowReview').check()
    locations=page.locator('#waResults .wa-location').all_inner_texts()
    assert all(location.startswith(('기초','심화')) for location in locations),locations
    words=page.locator('#waResults .wa-word').all_inner_texts()
    assert words.count('recieve')==1 and not any(word in words for word in ['definately','adress','grammer']),words
    assert page.evaluate("findWordDuplicates('definately').length+findWordDuplicates('adress').length+findWordDuplicates('grammer').length")==0
    assert page.evaluate("localStorage.getItem('decks')")==disk
    assert page.evaluate('JSON.stringify(decks.filter(isWrongNotebookDeck))')==wrong
    # Only one ordinary original plus several review copies is not a duplicate anywhere.
    page.locator('[data-action=close]').click()
    page.evaluate('()=>{window.savedOrdinaryCopy=decks[1].words.shift();render();}')
    assert page.locator('#cntDupes').inner_text()=='(0)'
    assert page.locator('#dupesList li').count()==0
    page.locator('#wordAuditOpen').click();assert page.locator('.wa-group').count()==0
    page.locator('[data-action=close]').click()
    page.evaluate('()=>{decks[1].words.unshift(savedOrdinaryCopy);render();}')
    assert page.evaluate("localStorage.getItem('decks')")==disk
    page.reload(wait_until='domcontentloaded')
    page.locator('#wordAuditOpen').click();assert page.locator('.wa-group .wa-entry').count()==2
    assert '오답노트 4개 제외' in page.locator('#waSummary').inner_text()
    assert page.evaluate('JSON.stringify(decks.filter(isWrongNotebookDeck))')==wrong
    assert page.locator('#wordAuditDialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
    assert not errors,errors;context.close()
    return {'width':width,'allWrongNotebooksExcluded':True,'spellingCopiesNotRepeated':True,'legacyHistoryNotReplayed':True,
            'ordinaryWrongMarkedOriginalIncluded':True,'reload':True,'dataUnchanged':True,'errors':errors}


def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(baseline.Quiet,directory=str(ROOT)));Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
            reports=[run(browser,f'http://127.0.0.1:{server.server_address[1]}/',width) for width in [320,390,1280]];browser.close()
        print(json.dumps(reports,ensure_ascii=False))
    finally:server.shutdown();server.server_close()


if __name__=='__main__':main()
