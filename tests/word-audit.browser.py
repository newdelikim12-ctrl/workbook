"""Browser integration checks; isolated synthetic decks, no shared user data."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import json
import os
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


DECKS = [
    {"id": "a", "name": "기초", "words": [
        {"eng": "apple", "kor": "사과"},
        {"eng": "recieve", "kor": "받다", "example": ["First example.", "Second example."],
         "note": [{"eng": "receipt", "kor": "영수증"}], "mastered": True, "wrong": True, "custom": 7},
        {"eng": "take care", "kor": "돌보다"},
        {"eng": "colour", "kor": "색"},
        {"eng": "responsibilities", "kor": "책임들"},
        {"eng": "cat", "kor": "역활을 하다"},
        {"eng": "hello", "kor": "안녕"},
    ], "stats": {}, "dupes": []},
    {"id": "b", "name": "심화", "words": [
        {"eng": " ＡＰＰＬＥ ", "kor": "다른 사과"},
        {"eng": "banana", "kor": "바나나"},
        {"eng": "don't", "kor": "하지 않다"},
        {"eng": "Xylophonix", "kor": "브랜드"},
    ], "stats": {}, "dupes": []},
    {"id": "wrong", "name": "오답노트", "words": [{"eng": "APPLE", "kor": "사과"}], "stats": {}, "dupes": []},
    {"id": "empty", "name": "빈 단어장", "words": [], "stats": {}, "dupes": []},
]


def exercise(browser, base, width):
    context = browser.new_context(viewport={"width": width, "height": 844}, service_workers="block")
    page = context.new_page()
    errors, dialogs, external = [], [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
    page.on("request", lambda req: external.append(req.url) if "word-check" in req.url and not req.url.startswith(base) else None)
    page.goto(base, wait_until="domcontentloaded")
    page.evaluate("""decks => {
      localStorage.setItem('decks',JSON.stringify(decks));localStorage.setItem('activeDeckId','a');
      localStorage.setItem('soundOn','0');localStorage.setItem('activeTab','study');
    }""", DECKS)
    page.reload(wait_until="domcontentloaded")
    page.evaluate("flushDecks()")
    original = page.evaluate("localStorage.getItem('decks')")
    page.locator('h3').filter(has_text='단어 추가').click()
    page.locator('#eng').fill(' BANANA ')
    page.locator('#kor').fill('새로 등록할 뜻')
    page.locator('#addWord button').filter(has_text='추가').first.click()
    assert dialogs and '심화' in dialogs[-1], dialogs
    assert page.locator('#eng').input_value() == ' BANANA '
    assert page.evaluate("localStorage.getItem('decks')") == original
    page.locator('#tabDecks').click()
    page.locator('#wordAuditOpen').click()
    page.wait_for_selector('#wordAuditDialog[open]')
    assert '4개 단어장' in page.locator('#waSummary').inner_text()
    assert page.locator('.wa-group').count() == 1
    assert page.locator('.wa-group .wa-entry').count() == 2
    assert '오답노트' not in page.locator('#waResults').inner_text()
    assert '심화' in page.locator('#waResults').inner_text()
    # One ordinary original plus its review copy must produce no duplicate group.
    page.evaluate("""()=>{window.auditForeignCopy=decks[1].words.shift();WordAudit.close();WordAudit.open();}""")
    assert page.locator('.wa-group').count() == 0
    assert page.evaluate("localStorage.getItem('decks')") == original
    page.evaluate("""()=>{decks[1].words.unshift(auditForeignCopy);WordAudit.close();WordAudit.open();}""")
    assert page.locator('.wa-group .wa-entry').count() == 2
    page.locator('#waSpellingTab').click()
    page.locator('#waScan').click()
    page.wait_for_function("document.querySelector('#waStatus').textContent.includes('검사 완료')", timeout=90000)
    assert page.evaluate("localStorage.getItem('decks')") == original
    words = page.locator('#waResults .wa-word').all_inner_texts()
    assert 'recieve' in words and 'cat' in words and 'Xylophonix' not in words, words
    page.locator('#waShowReview').check()
    assert 'Xylophonix' in page.locator('#waResults .wa-word').all_inner_texts()
    assert not any(word in words for word in ['colour', 'responsibilities', "don't", 'take care']), words
    direct = page.evaluate("""async()=>({
      valid:await WordSpelling.checkEnglish('colour responsibilities don’t take care ＡＰＰＬＥ'),
      typo:await WordSpelling.checkEnglish('recieve'),
      korean:WordSpelling.checkKorean('역활을 했다. 오랫만에 왠만하면 설겆이를 깨끗히 해. 올바른 역할과 역활용'),
      correct:WordSpelling.checkKorean('역할을 맡다. 오랜만에 웬만하면 설거지를 깨끗이 해.')
    })""")
    assert direct['valid'] == [] and direct['correct'] == [], direct
    assert 'receive' in direct['typo'][0]['suggestions'], direct
    assert [x['token'] for x in direct['korean']] == ['역활', '오랫만', '왠만', '설겆이', '깨끗히'], direct
    if os.environ.get('WORD_AUDIT_SCREENSHOTS'):
        directory=Path(os.environ['WORD_AUDIT_SCREENSHOTS']);directory.mkdir(parents=True,exist_ok=True)
        page.screenshot(path=str(directory/f'word-audit-spelling-{width}.png'))
        page.evaluate('toggleDark()')
        page.screenshot(path=str(directory/f'word-audit-dark-{width}.png'))
        page.evaluate('toggleDark()')
    row = page.locator('#waResults .wa-entry').filter(has=page.locator('.wa-word', has_text='recieve'))
    row.locator('[data-action=edit]').click()
    page.locator('#waEnglish').fill('banana')
    page.locator('#waEditor button[type=submit]').click()
    assert '이미 등록' in page.locator('#waEditError').inner_text()
    assert page.locator('#waEnglish').input_value() == 'banana'
    page.locator('#waEnglish').fill('receive')
    page.locator('#waKorean').fill('받다\n수령하다')
    page.locator('#waEditor button[type=submit]').click()
    assert not page.locator('#waEditor').is_visible()
    page.wait_for_function("document.getElementById('waActionMessage').textContent.includes('나머지 검사 결과')")
    assert 'recieve' not in page.locator('#waResults .wa-word').all_inner_texts()
    assert 'cat' in page.locator('#waResults .wa-word').all_inner_texts()
    assert 'Xylophonix' in page.locator('#waResults .wa-word').all_inner_texts()
    saved = page.evaluate("decks[0].words.find(w=>w.eng==='receive')")
    assert saved['kor'] == '받다\n수령하다'
    assert saved['example'] == DECKS[0]['words'][1]['example'] and saved['note'] == DECKS[0]['words'][1]['note']
    assert saved['mastered'] and saved['wrong'] and saved['custom'] == 7
    page.locator('#waDupesTab').click()
    page.locator('.wa-group .wa-entry').first.locator('[data-action=edit]').click()
    page.locator('#waKorean').fill('보존할 입력\n둘째 줄')
    page.evaluate("""()=>{window.auditOriginalWrite=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){if(key==='decks')throw Error('quota');return auditOriginalWrite.call(this,key,value);};} """)
    page.locator('#waEditor button[type=submit]').click()
    assert '저장하지 못했습니다' in page.locator('#waEditError').inner_text()
    assert page.locator('#waKorean').input_value() == '보존할 입력\n둘째 줄'
    assert page.evaluate('words[0].kor') == '사과'
    page.evaluate('()=>{Storage.prototype.setItem=auditOriginalWrite;}')
    page.locator('#waEditor button[type=submit]').click()
    assert page.evaluate('words[0].kor') == '보존할 입력\n둘째 줄'
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    assert page.locator('#wordAuditDialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
    # A stale result must never overwrite a changed word.
    page.locator('.wa-group .wa-entry').first.locator('[data-action=edit]').click()
    page.locator('#waKorean').fill('덮어쓰면 안 되는 입력')
    page.evaluate("()=>{words[0].kor='새로운 뜻';}")
    page.locator('#waEditor button[type=submit]').click()
    assert '단어가 변경' in page.locator('#waEditError').inner_text()
    assert page.evaluate('words[0].kor') == '새로운 뜻'
    page.locator('[data-action=cancel-edit]').click()
    page.locator('[data-action=close]').click()
    page.reload(wait_until='domcontentloaded')
    assert page.evaluate("words.find(w=>w.eng==='receive').kor") == '받다\n수령하다'
    page.locator('#wordAuditOpen').click()
    page.locator('#waSpellingTab').click()
    # Close during an asynchronous scan; late results must not touch a new review.
    page.evaluate("""()=>{window.auditRealSpelling=WordSpelling;window.WordSpelling={
      ready:()=>new Promise(resolve=>{window.auditReady=resolve;}),checkEnglish:()=>[],checkKorean:()=>[]};} """)
    page.locator('#waScan').click()
    page.locator('[data-action=close]').click()
    page.locator('#wordAuditOpen').click()
    page.evaluate('()=>{window.WordSpelling=auditRealSpelling;auditReady();}')
    page.wait_for_timeout(100)
    assert page.locator('#waDupesTab').get_attribute('aria-selected') == 'true'
    assert page.locator('.wa-group').count() == 1
    page.locator('[data-action=close]').click()
    assert not errors and not external, (errors,external)
    context.close()
    return {'width':width,'globalBlocking':True,'duplicateLocations':True,'wrongNotebookExcluded':True,'spellingAndVariants':True,
            'editPreservesData':True,'quotaDraftAndStaleGuard':True,'scanCancellation':True,'errors':errors}


def resilience(browser,base):
    context=browser.new_context(viewport={'width':390,'height':844},service_workers='allow')
    page=context.new_page();page.goto(base,wait_until='domcontentloaded')
    page.evaluate("""decks=>{localStorage.setItem('decks',JSON.stringify(decks));localStorage.setItem('activeDeckId','a');
      localStorage.setItem('activeTab','decks');localStorage.setItem('soundOn','0');}""",DECKS)
    page.reload(wait_until='domcontentloaded')
    page.evaluate('()=>navigator.serviceWorker.ready')
    page.wait_for_function("async()=>!!(await caches.match('./vendor/word-check/en-GB.dic'))",timeout=60000)
    context.set_offline(True)
    page.reload(wait_until='domcontentloaded')
    page.locator('#wordAuditOpen').click();page.locator('#waSpellingTab').click();page.locator('#waScan').click()
    page.wait_for_function("document.getElementById('waStatus').textContent.includes('검사 완료')",timeout=90000)
    assert 'recieve' in page.locator('#waResults').inner_text()
    # Obsolete unversioned modules in an installed app must not replace this release.
    before=page.evaluate("localStorage.getItem('decks')")
    page.evaluate("""async()=>{
      const keys=await caches.keys();
      for(const key of keys.filter(key=>key.startsWith('wordbook-'))){const cache=await caches.open(key);
        for(const path of ['word-audit.js','word-spelling.js'])await cache.put(path,new Response('window.auditObsoleteModule=true;',{
          headers:{'Content-Type':'application/javascript'}}));}
    }""")
    page.reload(wait_until='domcontentloaded')
    assert page.evaluate("typeof window.auditObsoleteModule")=='undefined'
    assert page.evaluate("localStorage.getItem('decks')")==before
    page.locator('#wordAuditOpen').click();page.locator('#waSpellingTab').click();page.locator('#waScan').click()
    page.wait_for_function("document.getElementById('waStatus').textContent.includes('검사 완료')",timeout=90000)
    context.close()
    # A failed English dictionary load must retain Korean findings and support retry.
    context=browser.new_context(service_workers='block')
    page=context.new_page();page.goto(base,wait_until='domcontentloaded')
    page.evaluate("""decks=>{localStorage.setItem('decks',JSON.stringify(decks));localStorage.setItem('activeDeckId','a');
      localStorage.setItem('activeTab','decks');localStorage.setItem('soundOn','0');}""",DECKS)
    page.reload(wait_until='domcontentloaded')
    page.route('**/vendor/word-check/en-US.dic',lambda route:route.abort())
    page.locator('#wordAuditOpen').click();page.locator('#waSpellingTab').click();page.locator('#waScan').click()
    page.wait_for_function("document.getElementById('waStatus').textContent.includes('완료하지 못했습니다')",timeout=60000)
    assert '역활' in page.locator('#waResults').inner_text()
    assert '한글 표현 결과만' in page.locator('#waStatus').inner_text()
    page.unroute('**/vendor/word-check/en-US.dic')
    page.locator('#waScan').click()
    page.wait_for_function("document.getElementById('waStatus').textContent.includes('검사 완료')",timeout=90000)
    assert 'recieve' in page.locator('#waResults').inner_text()
    context.close()
    return {'offlineEnglishAndKorean':True,'dictionaryFailureAndRetry':True,'obsoleteCachedModulesBypassed':True}


def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(ROOT)))
    Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
            results=[exercise(browser,f'http://127.0.0.1:{server.server_address[1]}/',width) for width in [320,390,1280]]
            results.append(resilience(browser,f'http://127.0.0.1:{server.server_address[1]}/'))
            browser.close()
        print(json.dumps(results,ensure_ascii=False))
    finally:
        server.shutdown();server.server_close()


if __name__=='__main__':main()
