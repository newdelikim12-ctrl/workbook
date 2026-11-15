"""Capture photo editing against real Chromium, temporary images and fresh storage."""
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import base64
import hashlib
import io
import json
import os

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EDITOR = '#cneDialog'
CAPTION = 'Manual image caption\nKeep this second line.'
NOTE = 'Separate manual note\n\nKeep every line.'


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def source_image(path):
    image = Image.new('RGB', (400, 300), 'white')
    draw = ImageDraw.Draw(image)
    for x, y in [(0, 0), (380, 0), (0, 280), (380, 280)]:
        draw.rectangle((x, y, x + 19, y + 19), fill='#283347')
    draw.text((24, 14), 'SYNTHETIC ORIGINAL', fill='#283347')
    image.save(path)


PIXEL_SUMMARY = """async canvas=>{
  const context=canvas.getContext('2d'),pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
  let red=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>180&&pixels[i+1]<100&&pixels[i+2]<100&&pixels[i+3]>100)red++;
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',pixels))].map(v=>v.toString(16).padStart(2,'0')).join('');
  return {width:canvas.width,height:canvas.height,red,hash};
}"""


def draft(page):
    return page.locator('#cneCanvas').evaluate(PIXEL_SUMMARY)


def stored_image(page, item_id, original=False):
    return page.evaluate("""async ({id,original})=>{
      const item=(await CaptureStore.listItems()).find(item=>item.id===id);
      const blob=await CaptureStore.getFile(original?item.fileId:(item.editedFileId||item.fileId));
      const bitmap=await createImageBitmap(blob),canvas=document.createElement('canvas');
      canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
      const summary=await (""" + PIXEL_SUMMARY + """)(canvas);
      summary.fileId=original?item.fileId:(item.editedFileId||item.fileId);
      summary.blobHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');
      return summary;
    }""", {'id': item_id, 'original': original})


def item_record(page, item_id):
    return page.evaluate('async id=>(await CaptureStore.listItems()).find(item=>item.id===id)', item_id)


def pixel_difference(page, item_id, expected_png):
    return page.evaluate("""async ({id,expected})=>{
      const item=(await CaptureStore.listItems()).find(i=>i.id===id);
      const actual=await CaptureStore.getFile(item.editedFileId||item.fileId);
      const expectedBlob=await(await fetch(expected)).blob();
      const bitmaps=await Promise.all([createImageBitmap(expectedBlob),createImageBitmap(actual)]);
      const data=bitmaps.map(bitmap=>{const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;c.getContext('2d').drawImage(bitmap,0,0);return c.getContext('2d').getImageData(0,0,c.width,c.height).data;});
      const [a,b]=data;let total=0,max=0,changed=0,above1=0,above8=0,opaqueA=0,opaqueB=0,minX=Infinity,minY=Infinity,maxX=-1,maxY=-1;
      for(let i=0;i<a.length;i+=4){let delta=0;for(let channel=0;channel<4;channel++){const d=Math.abs(a[i+channel]-b[i+channel]);total+=d;max=Math.max(max,d);delta=Math.max(delta,d);}
        if(a[i+3]===255)opaqueA++;if(b[i+3]===255)opaqueB++;
        if(delta){changed++;const p=i/4,x=p%bitmaps[0].width,y=Math.floor(p/bitmaps[0].width);minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
        if(delta>1)above1++;if(delta>8)above8++;
      }
      const dimensions=bitmaps.map(b=>[b.width,b.height]);bitmaps.forEach(b=>b.close());
      return {dimensions,maxChannelError:max,meanChannelError:total/a.length,changedPixels:changed,above1,above8,opaquePixels:[opaqueA,opaqueB],box:changed?[minX,minY,maxX,maxY]:null};
    }""", {'id':item_id,'expected':expected_png})


def image_card(page, item_id):
    return page.locator(f'#cnItems .cn-item[data-item-id="{item_id}"]')


def action(page, name):
    return page.locator(f'{EDITOR} [data-cne-action="{name}"]')


def tool(page, name):
    page.locator(f'{EDITOR} [data-cne-tool="{name}"]').click()


def open_editor(page, item_id, viewer=False):
    if viewer:
        image_card(page, item_id).locator('.cn-item-actions [data-action="zoom"]').click()
        page.wait_for_selector('#cnViewer[open]')
        page.locator('#cnViewer [data-action="viewer-edit-image"]').click()
    else:
        image_card(page, item_id).locator('.cn-item-actions [data-action="edit-image"]').click()
    page.wait_for_selector(f'{EDITOR}[open][data-state="ready"]')
    assert page.locator('#cneOverlay').bounding_box()['width'] > 0
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'), 'Editor causes page overflow'


def point(page, x, y):
    page.locator('#cneOverlay').scroll_into_view_if_needed()
    bounds = page.locator('#cneOverlay').bounding_box()
    return bounds['x'] + bounds['width'] * x, bounds['y'] + bounds['height'] * y


def drag(page, positions):
    x, y = point(page, *positions[0])
    page.mouse.move(x, y)
    page.mouse.down()
    for position in positions[1:]:
        page.mouse.move(*point(page, *position), steps=8)
    page.mouse.up()


def touch_drag(page, positions):
    page.locator('#cneOverlay').evaluate("e=>{window.editorPointerTypes=[];e.addEventListener('pointerdown',event=>editorPointerTypes.push(event.pointerType),{once:true});}")
    session = page.context.new_cdp_session(page)
    try:
        x, y = point(page, *positions[0])
        session.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[{'x':x,'y':y,'id':1,'radiusX':2,'radiusY':2,'force':1}]})
        previous = positions[0]
        for target in positions[1:]:
            for step in range(1, 9):
                position = (previous[0]+(target[0]-previous[0])*step/8, previous[1]+(target[1]-previous[1])*step/8)
                x, y = point(page, *position)
                session.send('Input.dispatchTouchEvent', {'type':'touchMove','touchPoints':[{'x':x,'y':y,'id':1,'radiusX':2,'radiusY':2,'force':1}]})
            previous = target
        session.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]})
    finally:
        session.detach()
    assert page.evaluate('editorPointerTypes') == ['touch']


def choose_color(page):
    page.locator('#cneColor').evaluate("e=>{e.value='#ff0000';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}")
    sizes = page.locator('#cneWidth').evaluate("e=>[...e.options].map(o=>Number(o.value)).filter(v=>Number.isFinite(v)&&v>=6)")
    if sizes:
        page.locator('#cneWidth').select_option(str(min(sizes)))


def save(page, item_id):
    action(page, 'save').click()
    page.locator(EDITOR).wait_for(state='hidden')
    page.wait_for_function('!CaptureNotebook.hasOpenDialog()')
    page.wait_for_function('async id=>!!(await CaptureStore.listItems()).find(i=>i.id===id).editedFileId', arg=item_id)
    page.wait_for_function("id=>!!document.querySelector('#cnItems .cn-item[data-item-id=\"'+id+'\"] .cn-capture-image')", arg=item_id)


@contextmanager
def fresh(browser, base, width, image_path):
    context = browser.new_context(viewport={'width': width, 'height': 844 if width < 600 else 960},
                                  is_mobile=width < 600, has_touch=width < 600,
                                  service_workers='block', accept_downloads=True)
    context.add_init_script("""if(!localStorage.getItem('editor-test-seeded')){
      localStorage.setItem('decks',JSON.stringify([{id:'editor-words',name:'Unaffected vocabulary',words:[
        {eng:'keep',kor:'보존하다',example:['Keep my original example.'],note:[{eng:'retained',kor:'원래 메모'}]}],stats:{},dupes:[]}]));
      localStorage.setItem('activeDeckId','editor-words');localStorage.setItem('soundOn','0');
      localStorage.setItem('darkMode','0');localStorage.setItem('editor-test-seeded','1');
    }""")
    page = context.new_page()
    page.set_default_timeout(15000)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: dialog.accept())
    page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(base) else route.abort())
    page.goto(base, wait_until='domcontentloaded')
    page.wait_for_function('!!window.CaptureEditor && !!window.CaptureStore.saveImage')
    page.evaluate('flushDecks()')
    vocabulary = page.evaluate("localStorage.getItem('decks')")
    page.locator('#tabCapture').click()
    page.wait_for_selector('#cnGroupChips button')
    page.locator('#cnFileInput').set_input_files(str(image_path))
    page.wait_for_function("async()=>(await CaptureStore.listItems()).some(i=>i.kind==='image')")
    image_id = page.evaluate("async()=>(await CaptureStore.listItems()).find(i=>i.kind==='image').id")
    page.evaluate("""async ({id,caption,note})=>{
      const image=(await CaptureStore.listItems()).find(i=>i.id===id);
      await CaptureStore.updateItem(id,{title:'Synthetic editable image',caption});
      await CaptureStore.addNote(image.groupId,note,id);await CaptureNotebook.open();
    }""", {'id': image_id, 'caption': CAPTION, 'note': NOTE})
    page.wait_for_function("document.querySelectorAll('#cnItems .cn-item').length===2")
    try:
        yield page, image_id
        assert page.evaluate("localStorage.getItem('decks')") == vocabulary
        assert not errors, errors
    finally:
        context.close()


def assert_manual_data(page, item_id, original_record, original_note):
    current = item_record(page, item_id)
    for key in ['id', 'groupId', 'kind', 'title', 'caption', 'fileId', 'fileName', 'size', 'createdAt']:
        assert current.get(key) == original_record.get(key), key
    note = page.evaluate("async id=>(await CaptureStore.listItems()).find(i=>i.id===id)", original_note['id'])
    assert note == original_note


def backup_and_original_download(page, item_id, original_hash, expected_pixels):
    card = image_card(page, item_id)
    card.locator('summary').click()
    with page.expect_download() as downloaded:
        card.locator('[data-action="download"]').click()
    assert hashlib.sha256(Path(downloaded.value.path()).read_bytes()).hexdigest() == original_hash
    with page.expect_download() as downloaded:
        page.locator('[data-action="export"]').click()
    archive = json.loads(Path(downloaded.value.path()).read_text())
    archived_item = next(item for item in archive['items'] if item['id'] == item_id)
    originals = next(file for file in archive['files'] if file['id'] == archived_item['fileId'])
    edited = next(file for file in archive['files'] if file['id'] == archived_item['editedFileId'])
    assert hashlib.sha256(base64.b64decode(originals['data'])).hexdigest() == original_hash
    with Image.open(io.BytesIO(base64.b64decode(edited['data']))) as image:
        assert image.size == (expected_pixels['width'], expected_pixels['height'])
    before = page.evaluate('CaptureStore.ready()')
    imported = page.evaluate('async text=>CaptureStore.importArchive(text)', json.dumps(archive))
    restored = next(item for item in imported['items'] if item['kind'] == 'image' and not any(old['id'] == item['id'] for old in before['items']))
    restored_pixels = stored_image(page, restored['id'])
    assert restored_pixels['hash'] == expected_pixels['hash']
    assert stored_image(page, restored['id'], True)['blobHash'] == original_hash


def run_width(browser, base, width, image_path):
    with fresh(browser, base, width, image_path) as (page, image_id):
        original_record = item_record(page, image_id)
        original_note = page.evaluate("async()=>(await CaptureStore.listItems()).find(i=>i.kind==='note')")
        original = stored_image(page, image_id, True)
        assert original['width'] == 400 and original['height'] == 300 and original['red'] == 0

        open_editor(page, image_id)
        before = draft(page)
        tool(page, 'line')
        choose_color(page)
        drag(page, [(0.15, 0.25), (0.75, 0.25)])
        line = draft(page)
        assert line['red'] > 100 and line['hash'] != before['hash']
        action(page, 'undo').click()
        assert draft(page)['hash'] == before['hash']
        action(page, 'redo').click()
        assert draft(page)['hash'] == line['hash']
        tool(page, 'draw')
        draw_path = [(0.15, 0.55), (0.3, 0.65), (0.45, 0.5), (0.6, 0.6)]
        if width == 320:
            touch_drag(page, draw_path)
        else:
            drag(page, draw_path)
        drawn = draft(page)
        assert drawn['red'] > line['red']
        tool(page, 'text')
        page.mouse.click(*point(page, 0.15, 0.77))
        page.locator('#cneText').fill('Saved label')
        action(page, 'text-apply').click()
        annotated = draft(page)
        annotated_png = page.locator('#cneCanvas').evaluate('(canvas)=>canvas.toDataURL()')
        assert annotated['red'] > drawn['red']
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        if width == 320:
            (ROOT / '.review').mkdir(exist_ok=True)
            page.screenshot(path=str(ROOT / '.review/captures-editor-320.png'))
        save(page, image_id)
        saved = stored_image(page, image_id)
        assert (saved['width'], saved['height'], saved['hash']) == (annotated['width'], annotated['height'], annotated['hash']), {'saved':saved,'draft':annotated,'difference':pixel_difference(page,image_id,annotated_png)}
        assert saved['fileId'] != original['fileId']
        assert stored_image(page, image_id, True) == original
        assert_manual_data(page, image_id, original_record, original_note)

        page.reload(wait_until='domcontentloaded')
        page.wait_for_selector('#cnItems .cn-item')
        assert stored_image(page, image_id)['hash'] == annotated['hash']
        preview = image_card(page, image_id).locator('.cn-capture-image')
        preview.wait_for()
        assert preview.evaluate('(image)=>({width:image.naturalWidth,height:image.naturalHeight})') == {'width': 400, 'height': 300}

        # Opening from the full-screen viewer uses the same saved edited image.
        open_editor(page, image_id, viewer=width == 390)
        assert draft(page)['hash'] == annotated['hash']
        metadata_before = page.evaluate('CaptureStore.ready()')
        tool(page, 'draw');choose_color(page)
        drag(page, [(0.8, 0.15), (0.8, 0.65)])
        assert draft(page)['hash'] != annotated['hash']
        action(page, 'cancel').click()
        page.locator(EDITOR).wait_for(state='hidden')
        page.wait_for_function('!CaptureNotebook.hasOpenDialog()')
        assert page.evaluate('CaptureStore.ready()') == metadata_before
        assert stored_image(page, image_id)['hash'] == annotated['hash']
        assert_manual_data(page, image_id, original_record, original_note)

        open_editor(page, image_id)
        action(page, 'rotate').click()
        page.wait_for_function("document.querySelector('#cneCanvas').width===300 && document.querySelector('#cneCanvas').height===400")
        rotated = draft(page)
        assert rotated['width'] == 300 and rotated['height'] == 400
        tool(page, 'crop')
        drag(page, [(0.25, 0.25), (0.75, 0.75)])
        action(page, 'crop-apply').click()
        cropped = draft(page)
        assert abs(cropped['width'] - 150) <= 2 and abs(cropped['height'] - 200) <= 2
        assert cropped['red'] > 20
        save(page, image_id)
        crop_saved = stored_image(page, image_id)
        assert (crop_saved['width'], crop_saved['height'], crop_saved['hash']) == (cropped['width'], cropped['height'], cropped['hash'])
        assert item_record(page, image_id)['rotation'] == 0
        assert stored_image(page, image_id, True) == original

        # Failed IndexedDB writes keep the actual editor pixels and full draft available.
        open_editor(page, image_id)
        tool(page, 'line');choose_color(page)
        drag(page, [(0.1, 0.15), (0.85, 0.15)])
        failed_draft = draft(page)
        metadata_before = page.evaluate('CaptureStore.ready()')
        page.evaluate("""()=>{window.editorOriginalPut=IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put=function(...args){if(this.name==='items')throw new DOMException('quota','QuotaExceededError');return editorOriginalPut.apply(this,args);};}""")
        action(page, 'save').click()
        page.wait_for_selector('#cneError:not(:empty)')
        assert page.locator(EDITOR).evaluate('(dialog)=>dialog.open')
        assert draft(page)['hash'] == failed_draft['hash']
        assert page.evaluate('CaptureStore.ready()') == metadata_before
        assert stored_image(page, image_id)['hash'] == cropped['hash']
        page.evaluate('()=>{IDBObjectStore.prototype.put=editorOriginalPut;}')
        save(page, image_id)
        final_edit = stored_image(page, image_id)
        assert final_edit['hash'] == failed_draft['hash']
        assert_manual_data(page, image_id, original_record, original_note)
        if width == 390:
            backup_and_original_download(page, image_id, original['blobHash'], final_edit)

        # Reset restores original bytes through the store; it does not overwrite originals.
        open_editor(page, image_id)
        action(page, 'reset').click()
        reset = draft(page)
        assert (reset['width'], reset['height'], reset['hash']) == (original['width'], original['height'], original['hash'])
        action(page, 'save').click()
        page.locator(EDITOR).wait_for(state='hidden')
        page.wait_for_function('!CaptureNotebook.hasOpenDialog()')
        assert not item_record(page, image_id).get('editedFileId')
        assert stored_image(page, image_id) == original
        assert_manual_data(page, image_id, original_record, original_note)
        page.reload(wait_until='domcontentloaded')
        page.wait_for_selector('#cnItems .cn-item')
        assert stored_image(page, image_id) == original
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    return {'width': width, 'pointerLineFreehandText': True, 'actualTouchStroke': width == 320, 'undoRedo': True,
            'rotateCropPixels': True, 'cancelReset': True, 'quotaDraftRetained': True,
            'originalCaptionAndNotesPreserved': True, 'reload': True, 'backupOriginalAndEdited': width == 390}


def delayed_open_races(browser, base, image_path):
    with fresh(browser, base, 1280, image_path) as (page, image_id):
        before = item_record(page, image_id)
        group = page.evaluate("async()=>{const group=await CaptureStore.createGroup('Other capture group');await CaptureNotebook.open();return group;}")
        for destination in ['close-reopen', 'change-group']:
            page.wait_for_selector('#cnItems .cn-capture-image')
            page.evaluate("""()=>{
              window.editorRealStore=CaptureStore;window.editorPendingFiles=[];
              window.CaptureStore={...CaptureStore,getFile:id=>new Promise((resolve,reject)=>{
                editorPendingFiles.push(()=>editorRealStore.getFile(id).then(resolve,reject));
              })};
            }""")
            image_card(page, image_id).locator('.cn-item-actions [data-action="edit-image"]').click()
            page.wait_for_function('editorPendingFiles.length>=1')
            if destination == 'close-reopen':
                page.locator('#tabStudy').click();page.locator('#tabCapture').click()
            else:
                page.locator(f'#cnGroupChips [data-action="group"][data-id="{group["id"]}"]').click()
            page.evaluate("""async()=>{
              const callbacks=editorPendingFiles.splice(0);window.CaptureStore=editorRealStore;
              await Promise.all(callbacks.map(callback=>callback()));await Promise.resolve();
            }""")
            page.wait_for_timeout(80)
            assert page.locator(f'{EDITOR}[open]').count() == 0
            assert item_record(page, image_id) == before
        assert page.locator('.cn-group-title').inner_text() == 'Other capture group'
    return {'case': 'delayed file reads', 'closeReopenCannotOpenStaleEditor': True, 'groupChangeCannotOpenStaleEditor': True}


def batched_pointer_preview(browser, base, image_path):
    with fresh(browser, base, 390, image_path) as (page, image_id):
        before_store=stored_image(page,image_id)
        open_editor(page, image_id);tool(page, 'draw');choose_color(page)
        original=draft(page)
        start=point(page,40/400,50/300);page.mouse.move(start[0],start[1]);page.mouse.down()
        counts=page.evaluate("""async()=>{
          const canvas=document.querySelector('#cneOverlay'),context=canvas.getContext('2d'),clear=context.clearRect;
          let clears=0;context.clearRect=function(...args){clears++;return clear.apply(this,args)};
          const box=canvas.getBoundingClientRect(),width=canvas.width,height=canvas.height;
          for(let i=1;i<=120;i++)canvas.dispatchEvent(new PointerEvent('pointermove',{pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:1,bubbles:true,clientX:box.x+(40+i*2)/width*box.width,clientY:box.y+(50+i*.7)/height*box.height}));
          const beforeFrame=clears;await new Promise(requestAnimationFrame);const afterFrame=clears;
          context.clearRect=clear;return {beforeFrame,afterFrame};
        }""")
        assert counts=={'beforeFrame':0,'afterFrame':1},counts
        assert draft(page)==original
        end=point(page,280/400,134/300);page.mouse.move(end[0],end[1]);page.mouse.up()
        annotated=draft(page);assert annotated['red']>original['red']
        action(page,'undo').click();assert draft(page)==original
        action(page,'redo').click();assert draft(page)==annotated
        action(page,'cancel').click()
        assert stored_image(page,image_id)==before_store,'cancel must preserve exact stored photo bytes and pixels'
    return {'case':'pointer preview batching','rawMoves':120,'previewDrawsPerFrame':1,'singleStrokeUndoRedo':True}


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Quiet, directory=str(ROOT)))
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        with TemporaryDirectory() as temporary, sync_playwright() as playwright:
            image_path = Path(temporary) / 'synthetic-original.png'
            source_image(image_path)
            browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                                                  args=['--no-sandbox', '--disable-dev-shm-usage'])
            base = f'http://127.0.0.1:{server.server_address[1]}/'
            widths = [int(value) for value in os.environ.get('CAPTURE_EDITOR_WIDTHS', '320,390,1280').split(',')]
            reports = []
            for width in widths:
                report = run_width(browser, base, width, image_path)
                reports.append(report)
                print(json.dumps({'completed': report}, ensure_ascii=False), flush=True)
            if 1280 in widths:
                report = delayed_open_races(browser, base, image_path)
                reports.append(report)
                print(json.dumps({'completed': report}, ensure_ascii=False), flush=True)
            report=batched_pointer_preview(browser,base,image_path)
            reports.append(report)
            print(json.dumps({'completed':report},ensure_ascii=False),flush=True)
            browser.close()
        print(json.dumps({'passed': True, 'cases': reports}, ensure_ascii=False, indent=2))
    finally:
        server.shutdown();server.server_close()


if __name__ == '__main__':
    main()
