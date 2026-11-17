"""Recall masks, pointer aiming and temporary photo reveal in isolated Chromium."""
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import hashlib
import json
import time

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDITOR = '#cneDialog'


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def fixture(path, second=False):
    image = Image.new('RGB', (400, 300), '#eef6ff' if second else 'white')
    draw = ImageDraw.Draw(image);draw.fontmode='1'
    draw.rectangle((0, 0, 24, 24), fill='#0066cc')
    draw.rectangle((375, 275, 399, 299), fill='#00aa55')
    draw.rectangle((110, 95, 290, 160), fill='black')
    draw.text((120, 120), 'SECOND ANSWER' if second else 'SECRET ANSWER 42', fill='white')
    image.save(path)


def poll(page, expression, arg=None, timeout=15):
    """Await the actual asynchronous value, rather than a promise's truthiness."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = page.evaluate(expression, arg)
        if last:
            return last
        page.wait_for_timeout(50)
    raise AssertionError(f'Condition did not become true: {expression}; last={last!r}')


SUMMARY = """async canvas=>{
 const ctx=canvas.getContext('2d'),data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
 let mask=0,red=0,opaque=0;for(let i=0;i<data.length;i+=4){if(data[i]===17&&data[i+1]===17&&data[i+2]===17&&data[i+3]===255)mask++;if(data[i]>180&&data[i+1]<80&&data[i+2]<80&&data[i+3]===255)red++;if(data[i+3]===255)opaque++;}
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(v=>v.toString(16).padStart(2,'0')).join('');
 return {width:canvas.width,height:canvas.height,mask,red,opaque,hash};
}"""


def record(page, item_id):
    return page.evaluate('async id=>(await CaptureStore.listItems()).find(i=>i.id===id)', item_id)


def image_data(page, item_id, source='edited'):
    return page.evaluate("""async ({id,source})=>{
      const item=(await CaptureStore.listItems()).find(i=>i.id===id);
      const fid=source==='original'?item.fileId:source==='clean'?item.cleanFileId:(item.editedFileId||item.fileId);
      if(!fid)return null;
      const blob=await CaptureStore.getFile(fid),image=await createImageBitmap(blob),canvas=document.createElement('canvas');
      canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);image.close();
      const result=await (""" + SUMMARY + """)(canvas);canvas.width=canvas.height=0;
      result.fileId=fid;result.blobHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');return result;
    }""", {'id': item_id, 'source': source})


def draft(page):
    return page.locator('#cneCanvas').evaluate(SUMMARY)


def displayed(page, selector):
    poll(page, "selector=>{const i=document.querySelector(selector);return !!i?.complete&&i.naturalWidth>0;}", selector)
    return page.locator(selector).evaluate("""async image=>{
      const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext('2d').drawImage(image,0,0);
      const result=await (""" + SUMMARY + """)(canvas);canvas.width=canvas.height=0;return result;
    }""")


def card(page, item_id):
    return page.locator(f'#cnItems .cn-item[data-item-id="{item_id}"]')


def card_image(item_id):
    return f'#cnItems .cn-item[data-item-id="{item_id}"] .cn-capture-image'


def action(page, name):
    return page.locator(f'{EDITOR} [data-cne-action="{name}"]')


def tool(page, name):
    page.locator(f'{EDITOR} [data-cne-tool="{name}"]').click()


def open_editor(page, item_id):
    card(page, item_id).locator('.cn-item-actions [data-action="edit-image"]').click()
    page.wait_for_selector(f'{EDITOR}[open][data-state="ready"]')
    assert page.locator('#cneOverlay').bounding_box()['width'] > 0


def coordinate(page, x, y):
    bounds = page.locator('#cneOverlay').bounding_box()
    return bounds['x'] + bounds['width'] * x, bounds['y'] + bounds['height'] * y


def drag(page, start, end):
    page.mouse.move(*coordinate(page, *start));page.mouse.down()
    page.mouse.move(*coordinate(page, *end), steps=10);page.mouse.up()


def color(page, value):
    page.locator('#cneColor').evaluate("(e,v)=>{e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));}", value)


def save(page, item_id):
    action(page, 'save').click();page.locator(EDITOR).wait_for(state='hidden')
    poll(page, '()=>!CaptureNotebook.hasOpenDialog()')
    poll(page, 'async id=>!!(await CaptureStore.listItems()).find(i=>i.id===id)?.cleanFileId', item_id)
    poll(page, 'id=>!!document.querySelector(\'#cnItems .cn-item[data-item-id="\'+id+\'"] .cn-capture-image\')', item_id)


def peek(page, item_id, revealed, viewer=False):
    button = page.locator('#cnViewer [data-action="reveal-image"]') if viewer else card(page, item_id).locator('.cn-item-actions [data-action="reveal-image"]')
    button.click()
    assert button.get_attribute('aria-pressed') == str(revealed).lower()
    selector = '#cnViewer .cn-capture-image' if viewer else card_image(item_id)
    expected = image_data(page, item_id, 'clean' if revealed else 'edited')
    if expected is None and revealed:expected=image_data(page,item_id,'original')
    poll(page, """async ({selector,hash})=>{
      const image=document.querySelector(selector);if(!image?.complete||!image.naturalWidth)return false;
      const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;c.getContext('2d').drawImage(image,0,0);
      const data=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      const value=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(v=>v.toString(16).padStart(2,'0')).join('');c.width=c.height=0;return value===hash;
    }""", {'selector': selector, 'hash': expected['hash']})
    return displayed(page, selector)


@contextmanager
def fresh(browser, base, width, paths):
    context = browser.new_context(viewport={'width': width, 'height': 900 if width < 600 else 1000},
                                  is_mobile=width < 600, has_touch=width < 600,
                                  service_workers='block', accept_downloads=True)
    context.add_init_script("""if(!localStorage.getItem('recall-seed')){
      localStorage.setItem('decks',JSON.stringify([{id:'words',name:'Preserved vocabulary',words:[{eng:'retain',kor:'유지하다',example:['Keep this example.'],note:[{eng:'kept',kor:'직접 메모'}]}],stats:{},dupes:[]}]));
      localStorage.setItem('activeDeckId','words');localStorage.setItem('soundOn','0');localStorage.setItem('recall-seed','1');}
    """)
    page = context.new_page();page.set_default_timeout(15000);errors=[]
    page.on('pageerror', lambda e: errors.append(str(e)));page.on('dialog', lambda d: d.accept())
    page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(base) else route.abort())
    page.goto(base, wait_until='domcontentloaded');page.wait_for_function('!!window.CaptureEditor&&!!window.CaptureStore')
    page.evaluate('flushDecks()');words = page.evaluate("localStorage.getItem('decks')")
    page.locator('#tabCapture').click();page.wait_for_selector('#cnGroupChips button')
    page.locator('#cnFileInput').set_input_files([str(path) for path in paths])
    items = poll(page, "async()=>{const items=(await CaptureStore.listItems()).filter(i=>i.kind==='image');return items.length===2?items:false;}")
    first, second = [item['id'] for item in items]
    note = page.evaluate(r"""async id=>{
      const item=(await CaptureStore.listItems()).find(i=>i.id===id);
      await CaptureStore.updateItem(id,{caption:'Keep my caption\nSecond line'});
      const note=await CaptureStore.addNote(item.groupId,'Independent manual note\nSecond line',id);
      await CaptureNotebook.open();return note;
    }""", first)
    try:
        yield page, first, second, note
        assert page.evaluate("localStorage.getItem('decks')") == words
        assert not errors, errors
    finally:
        context.close()


def hover_checks(page):
    tool(page, 'draw');before=draft(page)
    x,y=coordinate(page,.45,.45);page.mouse.move(x,y)
    poll(page, "()=>!document.querySelector('#cnePointer').hidden")
    bounds=page.locator('#cnePointer').bounding_box()
    assert abs(bounds['x']+bounds['width']/2-x)<3 and abs(bounds['y']+bounds['height']/2-y)<3
    assert draft(page)==before and action(page,'undo').is_disabled() and action(page,'save').is_disabled()
    page.locator('#cneOverlay').evaluate("e=>{window.recallPointerTypes=[];e.addEventListener('pointermove',event=>recallPointerTypes.push(event.pointerType));}")
    session=page.context.new_cdp_session(page)
    try:
        x,y=coordinate(page,.6,.5)
        session.send('Input.dispatchMouseEvent',{'type':'mouseMoved','x':x,'y':y,'pointerType':'pen','buttons':0})
        poll(page,"()=>recallPointerTypes.includes('pen')")
        assert not page.locator('#cnePointer').evaluate('(e)=>e.hidden')
        assert draft(page)==before and action(page,'save').is_disabled()
    finally:session.detach()
    tool(page,'pan');assert page.locator('#cnePointer').evaluate('(e)=>e.hidden')


def mask_drag(page, actual_touch):
    tool(page,'mask');color(page,'#111111');before=draft(page)
    if actual_touch:
        page.locator('#cneOverlay').evaluate("e=>{window.recallTouchTypes=[];e.addEventListener('pointerdown',event=>recallTouchTypes.push(event.pointerType),{once:true});}")
        session=page.context.new_cdp_session(page)
        try:
            x,y=coordinate(page,.2,.2)
            session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y,'id':1,'radiusX':2,'radiusY':2,'force':1}]})
            poll(page,"()=>!document.querySelector('#cneLoupe').hidden")
            assert draft(page)==before and action(page,'save').is_disabled()
            for n in range(1,11):
                x,y=coordinate(page,.2+.6*n/10,.2+.5*n/10)
                session.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x,'y':y,'id':1,'radiusX':2,'radiusY':2,'force':1}]})
            loupe=page.locator('#cneLoupe').bounding_box()
            assert loupe and abs((loupe['y']+loupe['height']/2)-y)>25
            session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
        finally:session.detach()
        assert page.evaluate('recallTouchTypes')==['touch']
        assert page.locator('#cneLoupe').evaluate('(e)=>e.hidden')
    else:drag(page,(.2,.2),(.8,.7))
    masked=draft(page);assert masked['mask']>30000 and masked['opaque']==400*300
    inside=page.locator('#cneCanvas').evaluate("""c=>{const a=c.getContext('2d').getImageData(95,75,200,120).data;for(let i=0;i<a.length;i+=4)if(a[i]!==17||a[i+1]!==17||a[i+2]!==17||a[i+3]!==255)return false;return true;}""")
    assert inside,'Every pixel of the answer area must be fully concealed'
    action(page,'undo').click();assert draft(page)['hash']==before['hash']
    action(page,'redo').click();assert draft(page)['hash']==masked['hash']
    return masked


def assert_manual(page, first, original, note):
    current=record(page,first)
    for key in ['fileId','fileName','size','mime','title','caption','createdAt']:
        assert current[key]==original[key],key
    assert page.evaluate('async id=>(await CaptureStore.listItems()).find(i=>i.id===id)',note['id'])==note


def run_width(browser, base, width, paths):
    with fresh(browser,base,width,paths) as (page,first,second,note):
        original_record=record(page,first);original=image_data(page,first,'original')
        open_editor(page,first);hover_checks(page)
        mask=mask_drag(page,width==320)
        save(page,first)
        edited=image_data(page,first);clean=image_data(page,first,'clean')
        assert edited['hash']==mask['hash'] and clean['hash']==original['hash']
        assert clean['mask']==0 and clean['opaque']==400*300
        assert image_data(page,first,'original')==original
        assert displayed(page,card_image(first))['hash']==edited['hash']
        assert_manual(page,first,original_record,note)

        # Reopened edits retain the first mask in the annotated image, while their
        # clean image excludes both old masks and new ink after rotation/cropping.
        open_editor(page,first);tool(page,'line');color(page,'#ff0000')
        drag(page,(.15,.3),(.85,.3));action(page,'rotate').click()
        tool(page,'crop');drag(page,(.1,.1),(.9,.9));action(page,'crop-apply').click()
        geometry=draft(page);assert geometry['mask']>10000 and geometry['red']>0
        save(page,first);edited=image_data(page,first);clean=image_data(page,first,'clean')
        assert (edited['width'],edited['height'])==(clean['width'],clean['height'])
        assert abs(edited['width']-240)<=2 and abs(edited['height']-320)<=2
        assert clean['mask']==0 and clean['red']==0
        assert image_data(page,first,'original')==original

        open_editor(page,second);mask_drag(page,False);save(page,second)
        second_masked=image_data(page,second)
        page.evaluate("""()=>{window.recallWrites=0;window.recallIDB={};for(const name of ['add','put','delete','clear']){recallIDB[name]=IDBObjectStore.prototype[name];IDBObjectStore.prototype[name]=function(...args){recallWrites++;return recallIDB[name].apply(this,args);};}}""")
        revealed=peek(page,first,True);assert revealed['hash']==clean['hash']
        assert card(page,second).locator('[data-action="reveal-image"]').get_attribute('aria-pressed')=='false'
        assert displayed(page,card_image(second))['hash']==second_masked['hash']
        peek(page,second,True);peek(page,second,False);peek(page,first,False)
        assert page.evaluate('recallWrites')==0
        # A burst of toggles must settle on the last requested image, independently.
        page.evaluate("""id=>{const button=document.querySelector('#cnItems .cn-item[data-item-id="'+id+'"] .cn-item-actions [data-action="reveal-image"]');for(let i=0;i<8;i++)button.click();}""",first)
        poll(page,"id=>document.querySelector('#cnItems .cn-item[data-item-id=\"'+id+'\"] .cn-item-actions [data-action=\"reveal-image\"]').getAttribute('aria-pressed')==='false'",first)
        poll(page,"async id=>{const item=document.querySelector('#cnItems .cn-item[data-item-id=\"'+id+'\"] .cn-capture-image');return !!item?.complete&&item.naturalWidth>0;}",first)
        assert displayed(page,card_image(first))['hash']==edited['hash']
        assert page.evaluate('recallWrites')==0
        page.evaluate("()=>{for(const [name,original] of Object.entries(recallIDB))IDBObjectStore.prototype[name]=original;}")

        card(page,first).locator('.cn-item-actions [data-action="zoom"]').click();page.wait_for_selector('#cnViewer[open]')
        page.locator('#cnViewer [aria-label="확대"]').click()
        zoom=page.locator('#cnViewer .cn-zoom-level').inner_text()
        page.locator('#cnViewer [aria-label="오른쪽으로 회전"]').click()
        poll(page,"()=>document.querySelector('#cnViewer .cn-capture-image').style.transform.includes('rotate(90deg)')")
        transform=page.locator('#cnViewer .cn-capture-image').evaluate('(e)=>e.style.transform')
        scroll=page.locator('#cnViewer .cn-viewer-scroll').evaluate('(e)=>{e.scrollLeft=25;e.scrollTop=20;return {left:e.scrollLeft,top:e.scrollTop};}')
        assert peek(page,first,True,viewer=True)['hash']==clean['hash']
        assert page.locator('#cnViewer .cn-zoom-level').inner_text()==zoom
        assert page.locator('#cnViewer .cn-capture-image').evaluate('(e)=>e.style.transform')==transform
        after_scroll=page.locator('#cnViewer .cn-viewer-scroll').evaluate('(e)=>({left:e.scrollLeft,top:e.scrollTop})')
        assert abs(after_scroll['left']-scroll['left'])<2 and abs(after_scroll['top']-scroll['top'])<2
        assert card(page,first).locator('[data-action="reveal-image"]').get_attribute('aria-pressed')=='true'
        assert peek(page,first,False,viewer=True)['hash']==edited['hash']
        page.locator('#cnViewer [aria-label="확대 보기 닫기"]').click()
        page.locator('#captureView [data-action="mode-list"]').click()
        assert peek(page,first,True)['hash']==clean['hash']
        assert card(page,second).locator('[data-action="reveal-image"]').get_attribute('aria-pressed')=='false'
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        if width<600:
            (ROOT/'.review').mkdir(exist_ok=True)
            page.screenshot(path=str(ROOT/'.review'/f'recall-revealed-{width}.png'))
        # Revealing is temporary; reloading restores both saved masks.
        page.reload(wait_until='domcontentloaded');poll(page,'()=>!!window.CaptureNotebook')
        assert card(page,first).locator('[data-action="reveal-image"]').get_attribute('aria-pressed')=='false'
        assert displayed(page,card_image(first))['hash']==edited['hash']
        assert displayed(page,card_image(second))['hash']==second_masked['hash']
        assert_manual(page,first,original_record,note)

        if width==390:
            # The second file write failing must not leave half a clean/edit pair.
            open_editor(page,first);tool(page,'mask');color(page,'#111111');drag(page,(.1,.1),(.3,.3))
            expected_draft=draft(page);before=page.evaluate('CaptureStore.ready()')
            archive_before=page.evaluate('async()=>JSON.parse(await(await CaptureStore.exportArchive()).text())')
            page.evaluate("""()=>{window.recallAdd=IDBObjectStore.prototype.add;window.recallFilesAdded=0;IDBObjectStore.prototype.add=function(...args){if(this.name==='files'&&++recallFilesAdded===2)throw new DOMException('full','QuotaExceededError');return recallAdd.apply(this,args);};}""")
            action(page,'save').click();page.wait_for_selector('#cneError:not(:empty)')
            assert page.locator(EDITOR).evaluate('(e)=>e.open') and draft(page)['hash']==expected_draft['hash']
            assert page.evaluate('CaptureStore.ready()')==before
            archive_after=page.evaluate('async()=>JSON.parse(await(await CaptureStore.exportArchive()).text())')
            assert archive_after['files']==archive_before['files'] and archive_after['items']==archive_before['items']
            page.evaluate('()=>{IDBObjectStore.prototype.add=recallAdd;}');save(page,first)
            assert image_data(page,first)['hash']==expected_draft['hash']
            assert image_data(page,first,'original')==original
            card(page,first).locator('summary').click()
            with page.expect_download() as downloaded:card(page,first).locator('[data-action="download"]').click()
            assert hashlib.sha256(Path(downloaded.value.path()).read_bytes()).hexdigest()==original['blobHash']

    return {'width':width,'mouseAndPenHoverWithoutEdits':True,'actualTouchAim':width==320,
            'opaqueMask':True,'undoRedo':True,'cleanReopenedGeometry':True,'independentPhotoPeek':True,
            'temporaryRevealNoWrites':True,'rapidToggle':True,'viewerZoomAndList':True,'maskedReload':True,
            'originalAndNotesPreserved':True,'twoBlobQuotaRollback':width==390}


def legacy_case(browser,base,paths):
    with fresh(browser,base,1280,paths) as (page,first,_second,_note):
        original=image_data(page,first,'original')
        page.evaluate("""async id=>{const item=(await CaptureStore.listItems()).find(i=>i.id===id),blob=await CaptureStore.getFile(item.fileId),engine=await CaptureImage.create(blob);engine.mask({x:80,y:60,width:240,height:150,color:'#111111'});const edited=await engine.toBlob();engine.destroy();await CaptureStore.saveImage(id,edited,{expectedFileId:item.fileId});await CaptureNotebook.open();}""",first)
        assert not record(page,first).get('cleanFileId')
        assert peek(page,first,True)['hash']==original['hash']
        assert peek(page,first,False)['mask']>30000
    return {'case':'legacy flattened photo','originalFallback':True}


def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(ROOT)))
    Thread(target=server.serve_forever,daemon=True).start()
    try:
        with TemporaryDirectory() as tmp,sync_playwright() as p:
            paths=[Path(tmp)/'first.png',Path(tmp)/'second.png'];fixture(paths[0]);fixture(paths[1],True)
            browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
            base=f'http://127.0.0.1:{server.server_address[1]}/';results=[]
            for width in [320,390,1280]:
                result=run_width(browser,base,width,paths);results.append(result);print(json.dumps(result),flush=True)
            results.append(legacy_case(browser,base,paths));browser.close()
        print(json.dumps({'passed':True,'cases':results},ensure_ascii=False,indent=2))
    finally:server.shutdown();server.server_close()


if __name__=='__main__':main()
