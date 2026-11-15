"""Real browser pixel tests. Requires Playwright, Pillow and an installed Chromium."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.parse import urlparse
import json
import os
import shutil

from PIL import Image
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


def pdf_fixture(path, count=20):
    font_id = 3 + count * 2
    kids = " ".join(f"{3 + index * 2} 0 R" for index in range(count))
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", f"<< /Type /Pages /Kids [{kids}] /Count {count} >>".encode()]
    for index in range(count):
        content = f"BT /F1 24 Tf 30 350 Td (LOCAL PDF PAGE {index + 1}) Tj ET".encode()
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {4 + index * 2} 0 R >>".encode())
        objects.append(b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    raw = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, value in enumerate(objects, 1):
        offsets.append(len(raw))
        raw.extend(f"{number} 0 obj\n".encode() + value + b"\nendobj\n")
    start = len(raw)
    raw.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        raw.extend(f"{offset:010d} 00000 n \n".encode())
    raw.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF".encode())
    path.write_bytes(raw)


# Delay only completion notification: rendering, cancellation and cleanup still
# use the actual bundled PDF.js. This makes the scroll-away race reproducible.
PDF_LIFECYCLE_MODULE = r"""
import * as pdf from './pdf.min.mjs?lifecycle-actual';
export const GlobalWorkerOptions=pdf.GlobalWorkerOptions;
const seen=new WeakSet();
window.__pdfLifecycle={started:[],cancelled:[],cleaned:[],destroyed:0};
export function getDocument(options){
  const task=pdf.getDocument(options),destroy=task.destroy.bind(task);
  task.destroy=()=>{window.__pdfLifecycle.destroyed++;return destroy();};
  task.promise.then(document=>{
    const getPage=document.getPage.bind(document);
    document.getPage=async number=>{
      const page=await getPage(number);
      if(!seen.has(page)){
        seen.add(page);
        const cleanup=page.cleanup.bind(page),render=page.render.bind(page);
        page.cleanup=(...args)=>{window.__pdfLifecycle.cleaned.push(number);return cleanup(...args);};
        page.render=options=>{
          window.__pdfLifecycle.started.push(number);
          const running=render(options);
          return {
            promise:running.promise.then(()=>new Promise(resolve=>setTimeout(resolve,window.__renderDelay||0))),
            cancel(){window.__pdfLifecycle.cancelled.push(number);running.cancel();}
          };
        };
      }
      return page;
    };
  }).catch(()=>{});
  return task;
}
"""


def main():
    with TemporaryDirectory(prefix="capture-image-test-") as directory:
        fixtures = Path(directory)
        image = Image.new("RGBA", (8, 6))
        for y in range(6):
            for x in range(8):
                image.putpixel((x, y), (x * 20, y * 30, 50, 0 if x >= 4 and y >= 3 else 255))
        image.save(fixtures / "original.png")
        Image.new("RGBA", (3, 2), (0, 0, 255, 255)).save(fixtures / "edited.png")
        Image.new("RGBA", (128, 100), (0, 0, 0, 0)).save(fixtures / "blank.png")
        Image.new("RGBA", (5000, 4000), (30, 60, 90, 128)).save(fixtures / "large.png")
        pdf_fixture(fixtures / "pages.pdf")

        class Handler(SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                parsed = urlparse(self.path)
                route = parsed.path
                if route == "/__image_test/harness":
                    raw = b'<!doctype html><html lang="ko"><meta charset="utf-8"><script src="/captures-image.js"></script>'
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                elif route == "/__image_test/media-harness":
                    raw = b'<!doctype html><html lang="ko"><meta charset="utf-8"><style>body{margin:0}#scroll{width:360px;height:600px;overflow:auto}#host{width:100%}</style><div id="scroll"><div id="host"></div></div><script src="/captures-media.js"></script>'
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html; charset=utf-8")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                elif route == "/vendor/pdfjs/pdf.min.mjs" and not parsed.query:
                    raw = PDF_LIFECYCLE_MODULE.encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/javascript")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                elif route.startswith("/__image_test/"):
                    name = route.rsplit("/", 1)[-1]
                    target = fixtures / name
                    if not target.is_file():
                        self.send_error(404)
                        return
                    raw = target.read_bytes()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/pdf" if target.suffix == ".pdf" else "image/png")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                else:
                    super().do_GET()

        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, directory=str(ROOT)))
        Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as playwright:
                chromium = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium")
                browser = playwright.chromium.launch(
                    executable_path=chromium,
                    headless=True,
                    args=["--no-sandbox", "--disable-dev-shm-usage"],
                )
                page = browser.new_page(viewport={"width": 390, "height": 844}, has_touch=True)
                errors = []
                requests = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.on("request", lambda request: requests.append(request.url))
                page.goto(f"http://127.0.0.1:{server.server_port}/__image_test/harness", wait_until="load")
                result = page.evaluate(r"""async()=>{
                  const assert=(value,message)=>{if(!value)throw Error(message);};
                  const same=(actual,expected,message)=>assert(JSON.stringify(actual)===JSON.stringify(expected),message+': '+JSON.stringify(actual));
                  const blob=async name=>(await fetch('/__image_test/'+name)).blob();
                  const original=await blob('original.png'),edited=await blob('edited.png'),blank=await blob('blank.png');
                  const output=document.createElement('canvas');
                  const pixel=(engine,x,y)=>{engine.render(output);return [...output.getContext('2d').getImageData(x,y,1,1).data];};
                  const size=engine=>[engine.width,engine.height];
                  let engine=await CaptureImage.create(original,{rotation:90});
                  same(size(engine),[6,8],'initial rotation dimensions');
                  same(pixel(engine,0,0),[0,150,50,255],'initial rotation top left');
                  same(pixel(engine,5,7),[140,0,50,255],'initial rotation bottom right');
                  assert(pixel(engine,0,7)[3]===0,'initial rotation keeps transparency');
                  assert(!engine.isOriginal,'rotation metadata differs from original');
                  engine.reset();same(size(engine),[8,6],'reset removes initial rotation');assert(engine.isOriginal,'reset recognized');
                  engine.undo();same(size(engine),[6,8],'undo reset restores initial rotation');
                  engine.redo();same(size(engine),[8,6],'redo reset');engine.destroy();

                  engine=await CaptureImage.create(original);
                  assert(!engine.canUndo&&!engine.canRedo&&engine.isOriginal,'clean initial history');
                  assert(engine.crop({x:1.2,y:1,width:0,height:2})===false,'zero crop is no-op');
                  assert(engine.crop({x:30,y:30,width:3,height:3})===false,'outside crop is no-op');
                  engine.line({x1:0,y1:1,x2:8,y2:1,color:'#00ff00',width:2});
                  engine.crop({x:2,y:0,width:4,height:4});
                  engine.stroke({points:[{x:0,y:3},{x:2,y:3},{x:4,y:3}],color:'#ff00ff',width:2});
                  engine.rotate();engine.crop({x:1,y:1,width:2,height:2});
                  same(size(engine),[2,2],'crop rotate crop dimensions');
                  same(pixel(engine,0,0),[255,0,255,255],'mark after crop moves correctly');
                  same(pixel(engine,1,0),[0,255,0,255],'mark before crop moves correctly');
                  engine.undo();engine.undo();
                  same(pixel(engine,1,2),[255,0,255,255],'undo geometry restores later mark');
                  engine.undo();same(pixel(engine,1,2),[60,60,50,255],'undo mark restores pixels');
                  engine.redo();same(pixel(engine,1,2),[255,0,255,255],'redo mark');
                  engine.undo();engine.line({x1:0,y1:3,x2:4,y2:3,color:'#0000ff',width:2});
                  assert(!engine.canRedo,'new branch clears redo');
                  engine.reset();assert(engine.isOriginal,'reset original state');
                  engine.stroke({points:[{x:1.5,y:1.5}],color:'#ff0000',width:1});assert(!engine.isOriginal,'edit after reset');
                  engine.undo();assert(engine.isOriginal,'undo edit returns original');
                  engine.redo();assert(!engine.isOriginal,'redo edit leaves original');
                  engine.undo();engine.undo();assert(!engine.isOriginal,'undo reset returns edited state');
                  engine.redo();assert(engine.isOriginal,'redo reset returns original');engine.destroy();

                  engine=await CaptureImage.create(edited,{rotation:90,originalBlob:original});
                  same(size(engine),[2,3],'edited file initial orientation');
                  same(pixel(engine,0,0),[0,0,255,255],'edited file initial pixels');
                  engine.reset();same(size(engine),[8,6],'true original reset dimensions');
                  same(pixel(engine,2,1),[40,30,50,255],'true original reset pixels');
                  engine.undo();same(size(engine),[2,3],'undo original reset restores saved edit');
                  same(pixel(engine,0,0),[0,0,255,255],'undo reset restores saved pixels');
                  engine.redo();engine.crop({x:4,y:3,width:4,height:3});
                  const transparent=await engine.toBlob();assert(transparent.type==='image/png','PNG export type');
                  const transparentBitmap=await createImageBitmap(transparent);
                  same([transparentBitmap.width,transparentBitmap.height],[4,3],'PNG export current dimensions');
                  output.width=4;output.height=3;output.getContext('2d').drawImage(transparentBitmap,0,0);
                  assert([...output.getContext('2d').getImageData(0,0,4,3).data].filter((_,i)=>i%4===3).every(alpha=>alpha===0),'PNG transparency preserved');
                  transparentBitmap.close();engine.undo();assert(engine.isOriginal,'undo crop after true reset');engine.destroy();

                  engine=await CaptureImage.create(original);
                  engine.crop({x:6,y:5,width:-3,height:-2});same(size(engine),[3,2],'reverse rectangle normalized');
                  same(pixel(engine,0,0),[60,90,50,255],'reverse crop pixels');
                  engine.undo();engine.crop({x:-2,y:-2,width:5,height:5});same(size(engine),[3,3],'crop clamped to image');engine.destroy();

                  engine=await CaptureImage.create(blank);
                  engine.text({x:10,y:12,text:'A\nB',color:'#ff0000',size:20});engine.render(output);
                  const data=output.getContext('2d').getImageData(0,0,128,100).data;
                  const hasInk=(from,to)=>{for(let y=from;y<to;y++)for(let x=0;x<128;x++)if(data[(y*128+x)*4+3])return true;return false;};
                  assert(hasInk(12,36)&&hasInk(38,64),'multiline text preserves line separation');
                  assert(!hasInk(0,12),'text top baseline matches placement');engine.undo();
                  assert(pixel(engine,20,20)[3]===0,'undo text restores transparency');engine.redo();
                  engine.text({x:10,y:65,text:'Study note 한글 메모',color:'#2233aa',size:14});
                  const attached=document.createElement('canvas');document.body.appendChild(attached);
                  engine.render(attached);assert(engine.language==='ko'&&attached.lang==='ko','preview locale fixed explicitly');
                  const preview=attached.getContext('2d').getImageData(0,0,engine.width,engine.height).data;
                  const textPNG=await engine.toBlob(),textBitmap=await createImageBitmap(textPNG);
                  const detached=document.createElement('canvas');detached.width=engine.width;detached.height=engine.height;
                  detached.getContext('2d').drawImage(textBitmap,0,0);
                  const saved=detached.getContext('2d').getImageData(0,0,engine.width,engine.height).data;
                  assert(preview.length===saved.length&&preview.every((channel,index)=>channel===saved[index]),'attached Korean-locale text preview and saved PNG must be pixel-identical');
                  textBitmap.close();attached.remove();attached.width=0;attached.height=0;detached.width=0;detached.height=0;
                  assert(engine.text({x:0,y:0,text:'  '})===false,'empty text no-op');
                  engine.destroy();assert(!engine.canUndo&&!engine.canRedo&&!engine.isOriginal,'destroyed history flags');
                  let rejected=false;try{engine.render(output);}catch(error){rejected=true;}assert(rejected,'destroyed engine rejects render');

                  const nativeBitmap=window.createImageBitmap,nativeCreate=URL.createObjectURL,nativeRevoke=URL.revokeObjectURL;
                  let created=0,revoked=0;
                  window.createImageBitmap=undefined;
                  URL.createObjectURL=function(...args){created++;return nativeCreate.apply(this,args);};
                  URL.revokeObjectURL=function(...args){revoked++;return nativeRevoke.apply(this,args);};
                  try{
                    engine=await CaptureImage.create(original);
                    same(pixel(engine,1,1),[20,30,50,255],'Image fallback pixels');engine.destroy();
                    assert(created===1&&revoked===1,'fallback object URL released');
                  }finally{window.createImageBitmap=nativeBitmap;URL.createObjectURL=nativeCreate;URL.revokeObjectURL=nativeRevoke;}

                  engine=await CaptureImage.create(await blob('large.png'));
                  assert(engine.scaled,'oversized source reports downsizing');
                  assert(engine.width*engine.height<=16000000&&Math.max(engine.width,engine.height)<=8192,'source size bounded');
                  same([engine.sourceWidth,engine.sourceHeight],[5000,4000],'original source dimensions exposed');
                  const largeSize=size(engine);const exported=await engine.toBlob(),largeBitmap=await createImageBitmap(exported);
                  same([largeBitmap.width,largeBitmap.height],largeSize,'bounded source exports exact edited dimensions');
                  largeBitmap.close();engine.destroy();output.width=0;output.height=0;
                  return {initialRotation:true,cropBeforeAndAfterAnnotations:true,undoRedoAndBranching:true,trueOriginalReset:true,
                    multilineText:true,previewExportTextIdentical:true,transparentPNG:true,fallbackURLCleanup:true,source16MPBound:true};
                }""")
                page.goto(f"http://127.0.0.1:{server.server_port}/__image_test/media-harness", wait_until="load")
                page.evaluate("""async()=>{
                  window.__renderDelay=250;
                  const blob=await(await fetch('/__image_test/pages.pdf')).blob();
                  window.handle=await CaptureMedia.mount(document.getElementById('host'),{kind:'pdf',title:'Local PDF'},blob);
                }""")
                page.wait_for_function("window.__pdfLifecycle.started.includes(1)")
                page.locator(".cn-pdf-page").last.scroll_into_view_if_needed()
                page.wait_for_function("window.__pdfLifecycle.cancelled.includes(1)")
                page.wait_for_function("window.__pdfLifecycle.cleaned.includes(1)", timeout=3000)
                page.wait_for_function("document.querySelectorAll('.cn-pdf-canvas')[19].dataset.rendered==='true'")
                assert page.locator(".cn-pdf-canvas").first.evaluate("canvas=>canvas.width===1")
                page.evaluate("handle.setZoom(2);handle.rotate(90);handle.setZoom(.75);handle.rotate(270);handle.setZoom(1)")
                page.locator(".cn-pdf-page").first.scroll_into_view_if_needed()
                page.wait_for_function("document.querySelector('.cn-pdf-canvas').dataset.rendered==='true'")
                page.evaluate("handle.destroy();handle.destroy()")
                assert page.locator(".cn-media-surface").count() == 0
                assert page.evaluate("window.__pdfLifecycle.destroyed") == 1
                result["pdfCancelledRenderCleanup"] = True
                result["pdfZoomRotateDestroy"] = True
                page.evaluate("""async()=>{
                  const assert=(value,message)=>{if(!value)throw Error(message);};
                  const host=document.getElementById('host');
                  const nativeCreate=URL.createObjectURL,nativeRevoke=URL.revokeObjectURL;
                  let created=0,revoked=0;
                  URL.createObjectURL=function(...args){created++;return nativeCreate.apply(this,args);};
                  URL.revokeObjectURL=function(...args){revoked++;return nativeRevoke.apply(this,args);};
                  try{
                    const image=await(await fetch('/__image_test/original.png')).blob();
                    for(let index=0;index<10;index++){
                      const handle=await CaptureMedia.mount(host,{kind:'image',title:'Repeat image'},image);
                      handle.setZoom(2);handle.rotate(90);handle.destroy();handle.destroy();
                    }
                    const broken=await CaptureMedia.mount(host,{kind:'image',title:'Broken'},new Blob(['invalid image']));
                    assert(broken.error&&host.querySelector('a[download]'),'invalid image keeps download fallback');
                    broken.destroy();
                    assert(created===revoked&&created===12,'every image and fallback URL revoked exactly once');
                    const pdf=await(await fetch('/__image_test/pages.pdf')).blob();
                    for(let index=0;index<3;index++){
                      const handle=await CaptureMedia.mount(host,{kind:'pdf',title:'Repeat PDF'},pdf);
                      handle.destroy();
                    }
                    assert(window.__pdfLifecycle.destroyed===4&&!host.children.length,'repeat PDF mounts destroy all loading tasks');
                  }finally{URL.createObjectURL=nativeCreate;URL.revokeObjectURL=nativeRevoke;}
                }""")
                result["mediaRepeatedOpenDestroy"] = True
                result["mediaURLCleanup"] = True
                assert all(url.startswith((f"http://127.0.0.1:{server.server_port}/", "blob:")) for url in requests), requests
                result["pdfLocalAssetsOnly"] = True
                assert not errors, errors
                print(json.dumps({"passed": True, **result, "pageErrors": errors}))
                browser.close()
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
