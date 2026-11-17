"""Editable capture objects and embedded photos, using only isolated synthetic data."""
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import importlib.util
import json

from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('capture_recall_helpers',ROOT/'tests/capture-recall.browser.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)


def fixture_overlay(path,second=False):
    width,height=(160,100) if not second else (120,75)
    image=Image.new('RGB',(width,height),'#00bbbb' if second else '#c40099')
    draw=ImageDraw.Draw(image);draw.fontmode='1'
    draw.rectangle((12,12,width-13,height-13),outline='#fff300',width=4)
    draw.text((25,40),'PHOTO TWO' if second else 'PHOTO ONE',fill='white')
    image.save(path)


def ids(page):
    return page.locator('#cneObjectSelect').evaluate("e=>[...e.options].map(o=>o.value).filter(Boolean)")


def new_id(page,before):
    values=r.poll(page,"before=>{const ids=[...document.querySelector('#cneObjectSelect').options].map(o=>o.value).filter(Boolean);const added=ids.filter(id=>!before.includes(id));return added.length===1?added:false;}",before)
    return values[0]


def add_image(page,path):
    before=ids(page);before_pixels=r.draft(page)
    page.locator('#cneImageInput').evaluate("e=>e.dispatchEvent(new Event('cancel',{bubbles:true,cancelable:true}))")
    assert page.locator('#cneDialog').evaluate('(e)=>e.open') and ids(page)==before and r.draft(page)==before_pixels
    r.action(page,'add-image').click()
    assert page.locator('#cneImageInput').count()==1,page.evaluate("()=>({dialog:document.querySelector('#cneDialog')?.outerHTML,state:document.querySelector('#cneDialog')?.dataset.state})")
    page.locator('#cneImageInput').set_input_files(str(path))
    value=new_id(page,before);page.wait_for_selector('#cneDialog[data-state="ready"]')
    return value


def save_project(page,item_id):
    r.action(page,'save').click();page.locator('#cneDialog').wait_for(state='hidden')
    r.poll(page,'()=>!CaptureNotebook.hasOpenDialog()')
    return r.poll(page,'async id=>{const item=(await CaptureStore.listItems()).find(i=>i.id===id);return item?.editProject?item:false;}',item_id)


def stored_objects(page,item_id):
    return page.evaluate("""async id=>{
      const item=(await CaptureStore.listItems()).find(i=>i.id===id),bundle=await CaptureStore.getImageProject(id,{expectedFileId:item.editedFileId||item.fileId});
      const [blob,originalBlob,cleanBlob]=await Promise.all([CaptureStore.getFile(item.editedFileId||item.fileId),CaptureStore.getFile(item.fileId),item.cleanFileId?CaptureStore.getFile(item.cleanFileId):Promise.resolve(null)]);
      const engine=await CaptureImage.create(blob,{originalBlob,cleanBlob:cleanBlob||undefined,project:bundle.document,baseBlob:bundle.baseBlob,assets:bundle.assets});
      try{return engine.getObjects();}finally{engine.destroy();}
    }""",item_id)


def drag_xy(page,start,end,touch=False):
    if not touch:
        page.mouse.move(*start);page.mouse.down();page.mouse.move(*end,steps=8);page.mouse.up();return
    session=page.context.new_cdp_session(page)
    try:
        session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':start[0],'y':start[1],'id':1,'radiusX':2,'radiusY':2,'force':1}]})
        for index in range(1,9):
            x=start[0]+(end[0]-start[0])*index/8;y=start[1]+(end[1]-start[1])*index/8
            session.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x,'y':y,'id':1,'radiusX':2,'radiusY':2,'force':1}]})
        session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
    finally:session.detach()


def select(page,object_id):
    r.tool(page,'select');page.locator('#cneObjectSelect').select_option(object_id)
    page.wait_for_selector('#cneSelection:not([hidden])')
    return page.locator('#cneSelection')


def move_selected(page,object_id,touch=False):
    select(page,object_id)
    box=page.locator('[data-cne-action="move-object"]').bounding_box();assert box
    start=(box['x']+box['width']/2,box['y']+box['height']/2)
    before=page.locator('#cneSelection').bounding_box()
    drag_xy(page,start,(start[0]+12,start[1]+9),touch)
    after=page.locator('#cneSelection').bounding_box()
    assert after['x']>before['x']+2 and after['y']>before['y']+2,(before,after)


def resize_selected(page,object_id,touch=False):
    select(page,object_id)
    handle=page.locator('[data-cne-handle="se"]');box=handle.bounding_box();assert box
    start=(box['x']+box['width']/2,box['y']+box['height']/2)
    before=page.locator('#cneSelection').bounding_box()
    drag_xy(page,start,(start[0]+15,start[1]+11),touch)
    after=page.locator('#cneSelection').bounding_box()
    assert after['width']>before['width']+2 and after['height']>=before['height'],(before,after)


def document_of(page,item_id):
    return page.evaluate('async id=>(await CaptureStore.listItems()).find(i=>i.id===id).editProject.document',item_id)


def check_manual(page,item_id,before,note):
    item=r.record(page,item_id)
    for key in ['id','groupId','fileId','fileName','size','mime','title','caption','createdAt']:
        assert item[key]==before[key],key
    assert page.evaluate('async id=>(await CaptureStore.listItems()).find(i=>i.id===id)',note['id'])==note


def create_annotations(page,overlays):
    result={}
    before=ids(page);r.tool(page,'mask');r.color(page,'#111111');r.drag(page,(.1,.15),(.33,.35));result['mask']=new_id(page,before)
    before=ids(page);r.tool(page,'line');r.color(page,'#ff0000');r.drag(page,(.52,.15),(.9,.15));result['line']=new_id(page,before)
    before=ids(page);r.tool(page,'draw');r.color(page,'#ff0000')
    start=r.coordinate(page,.08,.72);page.mouse.move(*start);page.mouse.down()
    for point in [(.22,.85),(.4,.7)]:page.mouse.move(*r.coordinate(page,*point),steps=8)
    page.mouse.up();result['stroke']=new_id(page,before)
    before=ids(page);r.tool(page,'text');page.mouse.click(*r.coordinate(page,.5,.75));page.locator('#cneText').fill('Editable note');r.action(page,'text-apply').click();result['text']=new_id(page,before)
    result['image']=add_image(page,overlays[0]);result['image2']=add_image(page,overlays[1])
    return result


def quota_asset_rollback(page,item_id):
    r.open_editor(page,item_id);object_id=ids(page)[0];move_selected(page,object_id)
    before=page.evaluate('CaptureStore.ready()');pixels=r.draft(page)
    archive_before=page.evaluate('async()=>JSON.parse(await(await CaptureStore.exportArchive()).text())')
    page.evaluate("""()=>{
      window.objectRealStore=CaptureStore;window.objectTargetAsset=null;window.objectFileAdds=0;window.objectNativeAdd=IDBObjectStore.prototype.add;
      window.CaptureStore={...CaptureStore,saveImage:(id,blob,options)=>{objectTargetAsset=options.project.assets[1].blob;return objectRealStore.saveImage(id,blob,options);}};
      IDBObjectStore.prototype.add=function(record,...args){if(this.name==='files'){objectFileAdds++;if(record.blob===objectTargetAsset)throw new DOMException('full','QuotaExceededError');}return objectNativeAdd.call(this,record,...args);};
    }""")
    r.action(page,'save').click();page.wait_for_selector('#cneError:not(:empty)')
    assert page.evaluate('objectFileAdds')>=4
    assert page.locator('#cneDialog').evaluate('(e)=>e.open') and r.draft(page)['hash']==pixels['hash']
    assert page.evaluate('CaptureStore.ready()')==before
    archive_after=page.evaluate('async()=>JSON.parse(await(await CaptureStore.exportArchive()).text())')
    assert archive_after['files']==archive_before['files'] and archive_after['items']==archive_before['items']
    page.evaluate('()=>{window.CaptureStore=objectRealStore;IDBObjectStore.prototype.add=objectNativeAdd;}')
    save_project(page,item_id);assert r.image_data(page,item_id)['hash']==pixels['hash']


def close_pending_import(page,item_id,overlay):
    r.open_editor(page,item_id);before=page.evaluate('CaptureStore.ready()')
    page.evaluate("""()=>{
      window.objectNativeBitmap=createImageBitmap;window.objectPendingBitmaps=[];window.objectBitmapCloses=0;window.objectNativeClose=ImageBitmap.prototype.close;
      ImageBitmap.prototype.close=function(...args){objectBitmapCloses++;return objectNativeClose.apply(this,args);};
      window.createImageBitmap=(...args)=>new Promise((resolve,reject)=>objectPendingBitmaps.push(()=>objectNativeBitmap(...args).then(resolve,reject)));
    }""")
    r.action(page,'add-image').click();page.locator('#cneImageInput').set_input_files(str(overlay))
    r.poll(page,"()=>document.querySelector('#cneDialog').dataset.state==='importing'&&objectPendingBitmaps.length>0")
    assert r.action(page,'save').is_disabled()
    r.action(page,'cancel').click();page.locator('#cneDialog').wait_for(state='hidden')
    closed=page.evaluate('objectBitmapCloses')
    page.evaluate('async()=>{window.createImageBitmap=objectNativeBitmap;await Promise.all(objectPendingBitmaps.splice(0).map(resolve=>resolve()));}')
    r.poll(page,'closed=>objectBitmapCloses>closed',closed)
    page.evaluate('()=>{ImageBitmap.prototype.close=objectNativeClose;}')
    assert not page.locator('#cneDialog[open]').count() and page.evaluate('CaptureStore.ready()')==before


def run_width(browser,base,width,paths,overlays):
    with r.fresh(browser,base,width,paths) as (page,first,_second,note):
        original_record=r.record(page,first);original=r.image_data(page,first,'original')
        r.open_editor(page,first);created=create_annotations(page,overlays)
        before_first_save=r.draft(page);first_item=save_project(page,first)
        assert set(o['kind'] for o in first_item['editProject']['document']['objects'])=={'mask','line','stroke','text','image'}
        assert len(first_item['editProject']['document']['objects'])==6 and len(first_item['editProject']['assets'])==2
        initial={o['id']:o for o in stored_objects(page,first)};assert set(initial)==set(created.values())
        assert r.image_data(page,first)['hash']==before_first_save['hash']
        assert r.image_data(page,first,'clean')['hash']==original['hash']
        assert r.image_data(page,first,'original')==original
        page.reload(wait_until='domcontentloaded');r.poll(page,'()=>!!window.CaptureEditor')
        assert document_of(page,first)==first_item['editProject']['document']
        r.open_editor(page,first)
        for kind,object_id in created.items():
            move_selected(page,object_id,touch=width==320)
            resize_selected(page,object_id,touch=width==320)
        # Deleting a selected saved object is reversible without losing its identity.
        select(page,created['text']);r.action(page,'delete-object').click();assert created['text'] not in ids(page)
        r.action(page,'undo').click();assert created['text'] in ids(page)
        edited_before_save=r.draft(page);save_project(page,first)
        moved={o['id']:o for o in stored_objects(page,first)}
        for kind,object_id in created.items():
            before,after=initial[object_id],moved[object_id]
            assert after['x']>before['x'] and after['y']>before['y'],(kind,before,after)
            assert after['width']>before['width'] and after['height']>=before['height'],(kind,before,after)
            if kind!='mask':assert abs(before['width']/max(.001,before['height'])-after['width']/max(.001,after['height']))<.05,(kind,before,after)
        assert r.image_data(page,first)['hash']==edited_before_save['hash']
        assert r.image_data(page,first,'clean')['hash']==original['hash']
        r.open_editor(page,first);assert len(ids(page))==6
        r.action(page,'rotate').click();r.tool(page,'crop');r.drag(page,(.08,.08),(.92,.92));r.action(page,'crop-apply').click()
        framed=r.draft(page);save_project(page,first)
        clean=r.image_data(page,first,'clean');assert (clean['width'],clean['height'])==(framed['width'],framed['height'])
        assert clean['mask']==0 and clean['red']==0
        assert r.peek(page,first,True)['hash']==clean['hash'];r.peek(page,first,False)
        exact=page.evaluate('CaptureStore.ready()');exact_image=r.image_data(page,first)
        r.open_editor(page,first);select(page,created['image']);move_selected(page,created['image']);r.action(page,'cancel').click()
        assert page.evaluate('CaptureStore.ready()')==exact and r.image_data(page,first)==exact_image
        if width==390:
            quota_asset_rollback(page,first)
            close_pending_import(page,first,overlays[0])
        check_manual(page,first,original_record,note);assert r.image_data(page,first,'original')==original
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
        (ROOT/'.review').mkdir(exist_ok=True)
        r.open_editor(page,first);select(page,created['image'])
        page.screenshot(path=str(ROOT/'.review'/f'capture-objects-{width}.png'));r.action(page,'cancel').click()
    return {'width':width,'embeddedPhotos':2,'editableKinds':['mask','line','stroke','text','image'],
            'savedObjectMoveResize':True,'actualTouchTransforms':width==320,'undoDeleteIdentity':True,
            'cropRotateAndCleanPeek':True,'cancelExactData':True,'projectAssetQuotaRollback':width==390,
            'closePendingImageCleanup':width==390,'originalCaptionNotesPreserved':True}


def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(r.Quiet,directory=str(ROOT)))
    Thread(target=server.serve_forever,daemon=True).start()
    try:
        with TemporaryDirectory() as tmp,sync_playwright() as p:
            paths=[Path(tmp)/'base.png',Path(tmp)/'other.png'];r.fixture(paths[0]);r.fixture(paths[1],True)
            overlays=[Path(tmp)/'photo-one.png',Path(tmp)/'photo-two.png'];fixture_overlay(overlays[0]);fixture_overlay(overlays[1],True)
            browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
            base=f'http://127.0.0.1:{server.server_address[1]}/';results=[]
            for width in [320,390,1280]:
                result=run_width(browser,base,width,paths,overlays);results.append(result);print(json.dumps(result),flush=True)
            browser.close()
        print(json.dumps({'passed':True,'cases':results},ensure_ascii=False,indent=2))
    finally:server.shutdown();server.server_close()


if __name__=='__main__':main()
