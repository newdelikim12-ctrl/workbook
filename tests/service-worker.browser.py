"""Real Chromium regression checks for service-worker updates and cache recovery.
Run with Python Playwright and a system Chromium. All storage is temporary.
"""
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit
import json
import re
import time

from playwright.sync_api import Error as PlaywrightError, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'sw.js').read_text()
SHELL = ['./', './index.html', './app.js', './lazy.js']


def worker(name, shell=None):
    source = re.sub(r"const CACHE='[^']+';", 'const CACHE=' + repr(name) + ';', SOURCE, count=1)
    return re.sub(r'const SHELL=.+?;\n', 'const SHELL=' + json.dumps(shell or SHELL) + ';\n', source, count=1)


class Fixture:
    def __init__(self, upgrade=False, versioned=False):
        self.upgrade = upgrade
        self.versioned = versioned
        self.new_worker = False
        self.bad_asset = False
        self.bad_html = False
        self.lazy_delay = 0
        self.requests = Counter()
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                path = urlsplit(self.path).path
                fixture.requests[path] += 1
                status, kind, body = 200, 'text/javascript', ''
                if path == '/sw.js':
                    name = 'wordbook-pwa-old' if fixture.upgrade and not fixture.new_worker else 'wordbook-pwa-current'
                    shell = list(SHELL)
                    if fixture.versioned:
                        shell[2] += '?v=' + ('2' if fixture.new_worker else '1')
                    body = worker(name, shell)
                elif path in ['/', '/index.html']:
                    kind = 'text/html; charset=utf-8'
                    version = '2' if fixture.new_worker else '1'
                    stamp = "const APP_VERSION='fixture-" + version + "';" if fixture.versioned else ''
                    script = 'app.js?v=' + version if fixture.versioned else 'app.js'
                    body = '<!doctype html><title>working shell</title><body><script>' + stamp + '</script><script src="' + script + '"></script>'
                    if fixture.bad_html:
                        status, body = 503, '<!doctype html><title>outage</title><div id="error">TEMPORARY_503</div>'
                elif path == '/app.js':
                    body = 'window.pwaReady=true;document.body.insertAdjacentHTML("beforeend",\'<div id="app">WORKING_APP</div>\');'
                    if fixture.bad_asset:
                        status, body = 503, 'asset temporarily unavailable'
                elif path == '/lazy.js':
                    time.sleep(fixture.lazy_delay)
                    body = 'lazy asset available'
                elif path == '/dynamic.js':
                    body = 'fresh dynamic asset'
                else:
                    status, body = 404, 'not found'
                self.send_response(status)
                self.send_header('Content-Type', kind)
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                try:
                    self.wfile.write(body.encode())
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}/'

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def start(browser, fixture):
    context = browser.new_context()
    page = context.new_page()
    page.goto(fixture.url, wait_until='load')
    assert page.locator('#app').count() == 1
    page.evaluate("""async()=>{
      await navigator.serviceWorker.register('sw.js',{updateViaCache:'none'});
      await navigator.serviceWorker.ready;
      localStorage.setItem('pwa-user-sentinel','keep-me');
    }""")
    page.wait_for_function('!!navigator.serviceWorker.controller')
    return context, page


def idle_registration(page):
    return page.evaluate("""async()=>{
      const end=Date.now()+10000;
      while(Date.now()<end){
        const registration=await navigator.serviceWorker.getRegistration();
        if(!registration.installing&&registration.active?.state==='activated')return true;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      return false;
    }""")


def upgrade_case(browser):
    fixture = Fixture(upgrade=True)
    try:
        context, page = start(browser, fixture)
        fixture.bad_asset = fixture.new_worker = True
        page.evaluate('async()=>{await(await navigator.serviceWorker.getRegistration()).update();}')
        assert idle_registration(page)
        page.wait_for_timeout(150)
        keys = page.evaluate('caches.keys()')
        context.set_offline(True)
        working, failure = False, ''
        try:
            page.reload(wait_until='domcontentloaded', timeout=10000)
            working = page.locator('#app').count() == 1
        except PlaywrightError as error:
            failure = str(error).splitlines()[0]
        context.set_offline(False)
        fixture.bad_asset = False
        page.goto(fixture.url, wait_until='domcontentloaded')
        sentinel = page.evaluate("localStorage.getItem('pwa-user-sentinel')")
        context.close()
        return {'offlineWorkingAfterFailedUpgrade': working, 'oldCachePreserved': 'wordbook-pwa-old' in keys,
                'navigationFailure': failure, 'userDataPreserved': sentinel == 'keep-me'}
    finally:
        fixture.close()


def versioned_upgrade_case(browser):
    fixture = Fixture(upgrade=True, versioned=True)
    try:
        context, page = start(browser, fixture)
        page.evaluate('window.originalController=navigator.serviceWorker.controller')
        fixture.bad_asset = fixture.new_worker = True
        page.evaluate('async()=>{await(await navigator.serviceWorker.getRegistration()).update();}')
        assert idle_registration(page)
        page.wait_for_timeout(100)
        retained = page.evaluate('navigator.serviceWorker.controller===window.originalController')
        page.reload(wait_until='load')
        online = page.locator('#app').count() == 1 and page.evaluate('APP_VERSION') == 'fixture-1'
        context.set_offline(True)
        page.reload(wait_until='load')
        offline = page.locator('#app').count() == 1 and page.evaluate('APP_VERSION') == 'fixture-1'
        context.set_offline(False)
        fixture.bad_asset = False
        page.evaluate('window.previousController=navigator.serviceWorker.controller')
        page.evaluate('async()=>{await(await navigator.serviceWorker.getRegistration()).update();}')
        assert idle_registration(page)
        page.wait_for_function('navigator.serviceWorker.controller!==window.previousController')
        page.reload(wait_until='load')
        updated = page.locator('#app').count() == 1 and page.evaluate('APP_VERSION') == 'fixture-2'
        context.set_offline(True)
        page.reload(wait_until='load')
        updated_offline = page.locator('#app').count() == 1 and page.evaluate('APP_VERSION') == 'fixture-2'
        context.close()
        return {'previousControllerRetained': retained, 'onlineKeepsCompleteRelease': online,
                'offlineKeepsCompleteRelease': offline, 'successfulUpgradeReplacesRelease': updated,
                'successfulUpgradeWorksOffline': updated_offline}
    finally:
        fixture.close()


def cold_boot_case(browser):
    fixture = Fixture(versioned=True)
    try:
        context, page = start(browser, fixture)
        page.evaluate("caches.delete('wordbook-pwa-current')")
        fixture.bad_asset = fixture.new_worker = True
        page.reload(wait_until='load')
        uncached = page.evaluate("async()=>!await(await caches.open('wordbook-pwa-current')).match(new URL('index.html',location.href))")
        fixture.bad_asset = False
        page.reload(wait_until='load')
        online = page.locator('#app').count() == 1 and page.evaluate('APP_VERSION') == 'fixture-2'
        context.set_offline(True)
        page.reload(wait_until='load')
        offline = page.locator('#app').count() == 1 and page.evaluate('APP_VERSION') == 'fixture-2'
        context.close()
        return {'unreadyHtmlNotCommittedAfterEviction': uncached,
                'versionedBootAssetsRestoredOnline': online, 'versionedBootWorksOffline': offline}
    finally:
        fixture.close()


def html_case(browser):
    fixture = Fixture()
    try:
        context, page = start(browser, fixture)
        fixture.bad_html = True
        page.reload(wait_until='domcontentloaded')
        online = page.locator('#app').count() == 1
        page.wait_for_timeout(100)
        context.set_offline(True)
        page.reload(wait_until='domcontentloaded')
        offline = page.locator('#app').count() == 1
        context.close()
        return {'temporary503KeepsOnlineApp': online, 'temporary503KeepsOfflineApp': offline}
    finally:
        fixture.close()


def recovery_case(browser):
    fixture = Fixture()
    try:
        context, page = start(browser, fixture)
        page.evaluate("caches.delete('wordbook-pwa-current')")
        fixture.requests.clear()
        fixture.lazy_delay = 0.35
        page.reload(wait_until='load')
        page.evaluate("""async()=>await Promise.all([1,2].map(number=>new Promise(resolve=>{
          const frame=document.createElement('iframe');frame.onload=resolve;
          frame.src='index.html?concurrent-repair='+number;document.body.append(frame);
        })))""")
        restored = page.evaluate("""async()=>{
          const end=Date.now()+10000;
          while(Date.now()<end){
            if(await(await caches.open('wordbook-pwa-current')).match(new URL('lazy.js',location.href)))return true;
            await new Promise(resolve=>setTimeout(resolve,100));
          }
          return false;
        }""")
        context.set_offline(True)
        lazy = page.evaluate("async()=>{try{const r=await fetch('lazy.js');return r.ok&&await r.text()==='lazy asset available';}catch(e){return false;}}")
        context.close()
        return {'unusedShellRepaired': restored, 'offlineUnusedAssetWorks': lazy,
                'concurrentRepairsDeduplicated': fixture.requests['/lazy.js'] == 1}
    finally:
        fixture.close()


def scope_case(browser):
    fixture = Fixture()
    try:
        context, page = start(browser, fixture)
        page.evaluate("async()=>{const c=await caches.open('wordbook-orphaned-old');await c.put(new URL('dynamic.js',location.href),new Response('stale dynamic asset'));}")
        value = page.evaluate("async()=>await(await fetch('dynamic.js')).text()")
        context.close()
        return {'ignoresOrphanedCache': value == 'fresh dynamic asset'}
    finally:
        fixture.close()


def no_store_case(browser):
    fixture = Fixture()
    try:
        context, page = start(browser, fixture)
        value = page.evaluate("async()=>await(await fetch('dynamic.js',{cache:'no-store'})).text()")
        for index in range(3):
            page.evaluate("async n=>await(await fetch('index.html?_v='+n,{cache:'no-store'})).text()", index)
            page.goto(fixture.url + '?visit=' + str(index), wait_until='load')
        page.wait_for_timeout(100)
        keys = page.evaluate("async()=>(await(await caches.open('wordbook-pwa-current')).keys()).map(r=>r.url)")
        context.close()
        return {'noStoreUsesNetwork': value == 'fresh dynamic asset',
                'noStoreRequestsNotCached': not any('dynamic.js' in key or '_v=' in key for key in keys),
                'navigationQueriesNotAccumulated': not any('visit=' in key for key in keys)}
    finally:
        fixture.close()


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                                              args=['--no-sandbox', '--disable-dev-shm-usage'])
        results = {'failedUpgrade': upgrade_case(browser), 'versionedUpgrade': versioned_upgrade_case(browser),
                   'coldVersionedBoot': cold_boot_case(browser), 'temporary503': html_case(browser),
                   'cacheRecovery': recovery_case(browser), 'cacheScope': scope_case(browser),
                   'requestPolicy': no_store_case(browser)}
        browser.close()
    print(json.dumps(results, ensure_ascii=False, indent=2), flush=True)
    checks = [value for case in results.values() for value in case.values() if isinstance(value, bool)]
    assert all(checks), 'Service-worker recovery or request policy regression'


if __name__ == '__main__':
    main()
