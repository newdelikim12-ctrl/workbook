"""Durable wrong-notebook archive, exercised in real isolated Chromium pages."""
from contextlib import contextmanager
from copy import deepcopy
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import importlib.util
import json

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('wrong_study_fixture', ROOT / 'tests/wrong-study-delete.browser.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
DECKS = fixture.DECKS
WRONG = 'deck_wrong_review'


def confirm(page, accept=True):
    page.locator('#confirmBack.show .cf-ok' if accept else '#confirmBack.show .cf-cancel').click()
    assert not page.locator('#confirmBack').evaluate('(node)=>node.classList.contains("show")')


def entries(page):
    return page.evaluate('getWrongArchiveEntries()')


def deck(page, deck_id):
    return page.evaluate('(id)=>decks.find(d=>d.id===id)', deck_id)


def panel(page):
    page.evaluate("showTab('study')")
    toggle = page.locator('#wrongArchivePanel [data-war-action="toggle"]').first
    if toggle.get_attribute('aria-expanded') != 'true':
        toggle.click()
    assert page.locator('#wrongArchiveBox').is_visible()
    return page.locator('#wrongArchivePanel')


def item(page, entry_id):
    return page.locator(f'#wrongArchiveList .war-item[data-war-id="{entry_id}"]')


def archive(page, deck_id, indexes):
    result = page.evaluate("""({id,indexes})=>{
      const d=decks.find(d=>d.id===id),source=id===activeDeckId?words:d.words;
      const result=archiveWrongWords(id,indexes.map(i=>source[i]));
      if(result.ok)afterWrongArchiveChange({...result,activeChanged:result.isActive});
      return result;
    }""", {'id':deck_id,'indexes':indexes})
    assert result['ok'], result
    return result['entries']


def assert_protected(page, original, other=None):
    assert deck(page, 'ordinary') == original
    if other is not None:
        assert deck(page, 'otherwrong') == other


@contextmanager
def fresh(browser, base, width=390, data=None):
    context = browser.new_context(viewport={'width':width,'height':844},
                                  is_mobile=width<600,has_touch=width<600,
                                  service_workers='block',accept_downloads=True)
    page = context.new_page()
    page.set_default_timeout(10000)
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.on('dialog',lambda dialog:dialog.dismiss())
    page.route('**/*', lambda route:route.continue_() if route.request.url.startswith(base) else route.abort())
    page.goto(base,wait_until='domcontentloaded')
    page.evaluate("""data=>{
      localStorage.clear();localStorage.setItem('decks',JSON.stringify(data));
      localStorage.setItem('activeDeckId','deck_wrong_review');localStorage.setItem('wrongDeckId','deck_wrong_review');
      localStorage.setItem('activeTab','study');localStorage.setItem('soundOn','0');
    }""",deepcopy(data if data is not None else DECKS))
    page.reload(wait_until='domcontentloaded')
    page.wait_for_function("typeof archiveWrongWords==='function' && window.WrongArchive && document.querySelector('#wrongArchivePanel [data-war-action=toggle]')")
    page.evaluate('flushDecks()')
    try:
        yield page
        assert not errors, errors
    finally:
        context.close()


def card_and_restore(browser, base, width):
    with fresh(browser,base,width) as page:
        original,other=deck(page,'ordinary'),deck(page,'otherwrong')
        target=deepcopy(deck(page,WRONG)['words'][0])
        page.evaluate('lsOpenInStudy(0)')
        assert page.locator('#front').inner_text()=='cat'
        assert page.locator('#cardNextBtn').inner_text()=='외웠음 · 보관'
        assert page.locator('#cardNextBtn').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        disk=page.evaluate("localStorage.getItem('decks')")
        page.locator('#cardNextBtn').click()
        assert not page.locator('#confirmBack').evaluate('(node)=>node.classList.contains("show")')
        assert page.evaluate("localStorage.getItem('decks')")!=disk
        assert page.locator('#front').inner_text()=='dog'
        assert page.evaluate('words.map(w=>w.eng)')==['dog','bird']
        archived=entries(page);assert len(archived)==1 and archived[0]['word']==target
        archive_id=archived[0]['id']
        assert_protected(page,original,other)
        page.reload(wait_until='domcontentloaded');panel(page)
        assert entries(page)[0]['id']==archive_id
        assert entries(page)[0]['word']==target
        assert item(page,archive_id).is_visible()
        item(page,archive_id).locator('summary').click()
        assert 'Review example.' in item(page,archive_id).inner_text()
        assert '지울 복사본 메모' in item(page,archive_id).inner_text()
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        if width==320:
            (ROOT/'.review').mkdir(exist_ok=True)
            page.locator('#wrongArchivePanel').scroll_into_view_if_needed()
            page.screenshot(path=str(ROOT/'.review/archive-final320.png'))
        item(page,archive_id).locator('[data-war-action="restore"]').click()
        assert entries(page)==[]
        restored=deck(page,WRONG)['words'][0]
        assert restored==target and restored['mastered'] is False
        assert_protected(page,original,other)
        page.reload(wait_until='domcontentloaded')
        assert entries(page)==[] and deck(page,WRONG)['words'][0]==target
        # Explicitly archived mastered words retain mastery on restoration.
        bird=deepcopy(deck(page,WRONG)['words'][2])
        bird_entry=archive(page,WRONG,[2])[0]
        panel(page);item(page,bird_entry['id']).locator('[data-war-action="restore"]').click()
        assert deck(page,WRONG)['words'][2]==bird and bird['mastered'] is True
    return {'case':'card/archive/restore','width':width,'reload':True,'preservesFullFieldsAndMastery':True}


def multiple_books_and_duplicates(browser,base):
    model=deepcopy(DECKS)
    model[1]['words'].append({'eng':'cat','kor':'같은 철자의 별도 메모','mastered':False,
                              'example':['Distinct duplicate.'],'note':[{'eng':'line one\nline two','kor':'첫째\n둘째'}]})
    with fresh(browser,base,390,model) as page:
        original=deck(page,'ordinary')
        expected_review=deepcopy(deck(page,WRONG)['words'])
        expected_other=deepcopy(deck(page,'otherwrong')['words'])
        archive(page,WRONG,[0,2,3]);archive(page,'otherwrong',[0])
        assert len(entries(page))==4
        panel(page);page.locator('#wrongArchivePanel [data-war-action="restore-all"]').click()
        assert entries(page)==[]
        assert deck(page,WRONG)['words']==expected_review
        assert deck(page,'otherwrong')['words']==expected_other
        assert_protected(page,original)
        page.reload(wait_until='domcontentloaded')
        assert deck(page,WRONG)['words']==expected_review
        assert deck(page,'otherwrong')['words']==expected_other
        assert entries(page)==[]
    return {'case':'restore-all across books','duplicateSpellings':True,'multilineNotes':True}


def purge_cancel_and_persistence(browser,base):
    with fresh(browser,base) as page:
        original=deck(page,'ordinary')
        first=archive(page,WRONG,[0])[0];second=archive(page,'otherwrong',[0])[0]
        live_review=deepcopy(deck(page,WRONG)['words'])
        panel(page);disk=page.evaluate("localStorage.getItem('decks')")
        item(page,first['id']).locator('[data-war-action="purge"]').click();confirm(page,False)
        assert page.evaluate("localStorage.getItem('decks')")==disk and len(entries(page))==2
        item(page,first['id']).locator('[data-war-action="purge"]').click()
        assert '되돌릴 수 없어요' in page.locator('#confirmMsg').inner_text()
        confirm(page)
        assert [entry['id'] for entry in entries(page)]==[second['id']]
        assert deck(page,WRONG)['words']==live_review
        assert_protected(page,original)
        page.reload(wait_until='domcontentloaded');panel(page)
        assert [entry['id'] for entry in entries(page)]==[second['id']]
        page.locator('#wrongArchivePanel [data-war-action="purge-all"]').click();confirm(page,False)
        assert len(entries(page))==1
        page.locator('#wrongArchivePanel [data-war-action="purge-all"]').click();confirm(page)
        assert entries(page)==[]
        page.reload(wait_until='domcontentloaded')
        assert entries(page)==[] and deck(page,WRONG)['words']==live_review
        assert_protected(page,original)
    return {'case':'per-item and all permanent deletion','cancel':True,'reloadDoesNotRecreate':True,'liveWordsUnchanged':True}


def quota_rollback(browser,base):
    with fresh(browser,base) as page:
        archived=archive(page,WRONG,[0])[0];panel(page)
        for action in ['restore','purge']:
            before=page.evaluate("({disk:localStorage.getItem('decks'),model:JSON.stringify(decks)})")
            page.evaluate("""()=>{
              window.archiveRollbackState={words,archive:decks.find(d=>d.id===activeDeckId).wrongArchive};
              window.archiveRealWrite=Storage.prototype.setItem;
              Storage.prototype.setItem=function(key,value){if(key==='decks')throw Error('quota');return archiveRealWrite.call(this,key,value);};
            }""")
            item(page,archived['id']).locator(f'[data-war-action="{action}"]').click()
            if action=='purge':confirm(page)
            assert page.evaluate("localStorage.getItem('decks')")==before['disk']
            assert page.evaluate('JSON.stringify(decks)')==before['model']
            assert page.evaluate('words===archiveRollbackState.words && decks.find(d=>d.id===activeDeckId).wrongArchive===archiveRollbackState.archive')
            status=page.locator('#wrongArchivePanel .war-status')
            assert '저장' in status.inner_text()
            assert 'war-error' in (status.get_attribute('class') or '')
            assert '복구했어요' not in status.inner_text() and '완전히 삭제했어요' not in status.inner_text()
            assert item(page,archived['id']).count()==1
            page.evaluate('()=>{Storage.prototype.setItem=archiveRealWrite;}')
        item(page,archived['id']).locator('[data-war-action="restore"]').click()
        assert entries(page)==[] and page.evaluate('words[0].eng')=='cat'
    return {'case':'quota rollback','restore':True,'purge':True,'exactReferences':True,'noFalseSuccess':True}


def swipe_undo_and_timeout(browser,base):
    with fresh(browser,base,320) as page:
        original,other=deck(page,'ordinary'),deck(page,'otherwrong')
        cat=deepcopy(deck(page,WRONG)['words'][0])
        page.evaluate("showTab('list');lsSwipeDelete(0)")
        cat_id=entries(page)[0]['id']
        assert page.evaluate('Object.keys(_lsUndo)')==['archiveId']
        assert page.evaluate('_lsUndo.archiveId')==cat_id
        # A second archive mutation cannot make undo restore the wrong row.
        dog_id=archive(page,WRONG,[0])[0]['id']
        page.locator('#toast .undo-btn').click()
        assert deck(page,WRONG)['words'][0]==cat
        assert [entry['id'] for entry in entries(page)]==[dog_id]
        page.evaluate('lsSwipeDelete(0)')
        timed_id=page.evaluate('_lsUndo.archiveId')
        page.wait_for_timeout(3200)
        assert page.evaluate('_lsUndo') is None
        assert timed_id in [entry['id'] for entry in entries(page)]
        page.reload(wait_until='domcontentloaded')
        assert {entry['id'] for entry in entries(page)}=={dog_id,timed_id}
        assert_protected(page,original,other)
    return {'case':'swipe undo','usesArchiveId':True,'undoExpiryKeepsArchive':True,'reload':True}


def delete_routes_and_guard(browser,base):
    with fresh(browser,base) as page:
        original,other=deck(page,'ordinary'),deck(page,'otherwrong')
        baseline=deepcopy(deck(page,WRONG)['words'])
        before=page.evaluate("localStorage.getItem('decks')")
        page.evaluate("deleteDeck('deck_wrong_review')")
        assert page.evaluate("localStorage.getItem('decks')")==before
        assert not page.locator('#confirmBack').evaluate('(e)=>e.classList.contains("show")')
        routes=[
            ('selected-list','lsSelected=new Set([0,1]);lsDeleteSelected()',[0,1]),
            ('selected-study','wlSelected=new Set([0,1]);wlDeleteSelected()',[0,1]),
            ('mastered','lsDeleteMastered()',[2]),
            ('generic-bulk','bulkDelete([{w:words[0],i:0},{w:words[1],i:1}])',[0,1]),
            ('generic-single','del(0)',[0]),
            ('clear-all','clearAll()',[0,1,2]),
        ]
        for name,script,indexes in routes:
            page.evaluate(script)
            if name=='generic-single':
                assert not page.locator('#confirmBack').evaluate('(node)=>node.classList.contains("show")')
            else:
                confirm(page)
            assert [entry['word'] for entry in entries(page)]==[baseline[i] for i in indexes],name
            assert page.evaluate('words')==[word for i,word in enumerate(baseline) if i not in indexes],name
            assert_protected(page,original,other)
            if name=='clear-all':
                before=page.evaluate("localStorage.getItem('decks')")
                page.evaluate("deleteDeck('deck_wrong_review')")
                assert page.evaluate("localStorage.getItem('decks')")==before
                assert not page.locator('#confirmBack').evaluate('(e)=>e.classList.contains("show")')
            panel(page);page.locator('#wrongArchivePanel [data-war-action="restore-all"]').click()
            assert page.evaluate('words')==baseline and entries(page)==[],name
        # A normal notebook remains on its existing permanent-delete route.
        review=deepcopy(deck(page,WRONG))
        page.evaluate("switchDeck('ordinary','study');lsOpenInStudy(0)")
        assert '보관' not in page.locator('#cardNextBtn').inner_text()
        before=page.evaluate("localStorage.getItem('decks')")
        assert page.evaluate('deleteWrongStudyWord(0)') is False
        assert page.evaluate("localStorage.getItem('decks')")==before
        page.evaluate('bulkDelete([{w:words[0],i:0}])');confirm(page)
        assert deck(page,'ordinary')['words']==[] and entries(page)==[]
        assert deck(page,WRONG)==review and deck(page,'otherwrong')==other
    return {'case':'all deletion routes','routes':[route[0] for route in routes],
            'nonemptyWrongBookDeletionBlocked':True,'ordinaryDeletionUnchanged':True}


def backup_ui_roundtrip(browser,base):
    with fresh(browser,base) as page:
        first=archive(page,WRONG,[0])[0];second=archive(page,'otherwrong',[0])[0]
        page.evaluate("words[0].note=[{eng:'saved line one\\nsaved line two',kor:'보존할 메모\\n두 번째 줄'}];saveDeckData()")
        overwritten=deepcopy(page.evaluate('words[0]'))
        with page.expect_download():page.evaluate('exportBackup()')
        exported=json.loads(page.locator('#backupBox').input_value())
        assert sum(len(d.get('wrongArchive',[])) for d in exported['decks'])==2
        older=deepcopy(DECKS)
        older[1]['words']=[older[1]['words'][2]]
        older[2]['words']=[]
        panel(page)
        if not page.locator('#backup').evaluate('(e)=>e.classList.contains("open")'):
            page.locator('h3').filter(has_text='단어장 데이터 백업').click()
        page.locator('#backupBox').fill(json.dumps({'version':2,'decks':older,'activeDeckId':WRONG},ensure_ascii=False))
        page.locator('#backup [onclick="restoreBackup()"]').click();confirm(page)
        remaining=entries(page)
        assert {first['id'],second['id']} <= {entry['id'] for entry in remaining}
        assert len(remaining)==3 and any(entry['word']==overwritten for entry in remaining)
        page.reload(wait_until='domcontentloaded')
        assert entries(page)==remaining
        with page.expect_download():page.evaluate('exportBackup()')
        exported_value=page.locator('#backupBox').input_value()
        if not page.locator('#backup').evaluate('(e)=>e.classList.contains("open")'):
            page.locator('h3').filter(has_text='단어장 데이터 백업').click()
        page.locator('#backupBox').fill(exported_value)
        page.locator('#backup [onclick="restoreBackup()"]').click();confirm(page)
        assert entries(page)==remaining
        page.reload(wait_until='domcontentloaded')
        assert entries(page)==remaining
    return {'case':'backup UI roundtrip','exportsArchive':True,'oldBackupPreservesArchive':True,
            'overwrittenWrongLiveArchived':True,'fullBackupDoesNotDuplicate':True}


def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(fixture.Quiet,directory=str(ROOT)))
    Thread(target=server.serve_forever,daemon=True).start()
    try:
        base=f'http://127.0.0.1:{server.server_address[1]}/'
        with sync_playwright() as p:
            browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
            reports=[]
            for width in [320,390,1280]:
                reports.append(card_and_restore(browser,base,width))
            for case in [multiple_books_and_duplicates,purge_cancel_and_persistence,quota_rollback,
                         swipe_undo_and_timeout,delete_routes_and_guard,backup_ui_roundtrip]:
                reports.append(case(browser,base))
            browser.close()
        print(json.dumps({'passed':True,'cases':reports},ensure_ascii=False,indent=2))
    finally:
        server.shutdown();server.server_close()


if __name__=='__main__':main()
