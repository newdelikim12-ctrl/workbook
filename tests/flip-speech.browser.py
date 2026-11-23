"""Optional card-flip speech follows the visible language without changing playback modes."""
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


def run(browser, base, width):
    context = browser.new_context(viewport={'width': width, 'height': 900}, service_workers='block')
    context.add_init_script("""(() => {
      if (!localStorage.getItem('flip-test-seeded')) {
        localStorage.setItem('decks',JSON.stringify([{id:'a',name:'테스트',words:[{eng:'cat',kor:'고양이'},{eng:'dog',kor:'개'}],stats:{},dupes:[]}]));
        localStorage.setItem('activeDeckId','a');
        localStorage.setItem('soundOn','0');
        localStorage.setItem('autoSpeak','0');
        localStorage.setItem('flip-test-seeded','1');
      }
      window.spoken=[];
      window.SpeechSynthesisUtterance=class {constructor(text){this.text=text;}};
      Object.defineProperty(window,'speechSynthesis',{value:{paused:false,
        cancel(){},resume(){},speak(u){window.spoken.push({text:u.text,lang:u.lang});}
      }});
    })();""")
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base, wait_until='domcontentloaded')
    page.evaluate('lsOpenInStudy(0)')
    toggle = page.locator('#flipSpeakBtn')
    card = page.locator('#front')

    def take():
        return page.evaluate('spoken.splice(0)')

    # Existing users start silent; enabling the preference does not read a card itself.
    assert toggle.get_attribute('aria-pressed') == 'false'
    card.click(); card.click()
    assert take() == []
    toggle.click()
    assert toggle.get_attribute('aria-pressed') == 'true' and take() == []
    card.click()
    assert take() == [{'text': '고양이', 'lang': 'ko-KR'}]
    card.click()
    assert take() == [{'text': 'cat', 'lang': 'en-US'}]
    assert page.evaluate('speakMode') == 'eng'

    # Programmatic reveal/fold and card redraws do not start this optional speech.
    page.evaluate('cardReveal(true);cardReveal(false);showWord(words[0],0,true)')
    assert take() == []
    page.locator('#cardDirBtn').click()
    assert page.locator('#front').inner_text() == '고양이' and take() == []
    card.click()
    assert take() == [{'text': 'cat', 'lang': 'en-US'}]
    card.click()
    assert take() == [{'text': '고양이', 'lang': 'ko-KR'}]

    # Both-visible mode retains manual folding and uses the same direction mapping.
    page.locator('#bothModeBtn').click()
    assert page.locator('#back').is_visible() and take() == []
    card.click()
    assert take() == [{'text': '고양이', 'lang': 'ko-KR'}]
    card.click()
    assert take() == [{'text': 'cat', 'lang': 'en-US'}]

    # Manual and automatic playback keep their existing language order and preferences.
    page.locator('#speakSegBoth').click()
    assert take() == [{'text': '고양이', 'lang': 'ko-KR'}, {'text': 'cat', 'lang': 'en-US'}]
    card.click()
    assert take() == [{'text': '고양이', 'lang': 'ko-KR'}]
    assert page.evaluate('speakMode') == 'both'
    page.locator('#autoSpeakBtn').click()
    assert take() == [{'text': '고양이', 'lang': 'ko-KR'}, {'text': 'cat', 'lang': 'en-US'}]
    page.evaluate('showWord(words[1],1,true)')
    assert take() == [{'text': '개', 'lang': 'ko-KR'}, {'text': 'dog', 'lang': 'en-US'}]
    page.locator('#autoSpeakBtn').click()
    assert take() == []

    # The setting survives refresh and can be disabled persistently.
    page.reload(wait_until='domcontentloaded')
    assert toggle.get_attribute('aria-pressed') == 'true'
    page.evaluate('lsOpenInStudy(0)')
    assert take() == []
    card.click()
    assert take() == [{'text': '고양이', 'lang': 'ko-KR'}]
    assert page.evaluate('words.length') == 2
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    assert toggle.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
    if os.environ.get('WORD_STUDY_SCREENSHOTS'):
        directory = Path(os.environ['WORD_STUDY_SCREENSHOTS'])
        directory.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(directory / f'flip-speech-{width}.png'))
    toggle.click()
    card.click()
    assert take() == []
    page.reload(wait_until='domcontentloaded')
    assert toggle.get_attribute('aria-pressed') == 'false'
    page.evaluate('lsOpenInStudy(0)')
    card.click()
    assert take() == [] and not errors, errors
    context.close()
    return {'width': width, 'bothDirections': True, 'bothVisibleMode': True,
            'defaultOffAndPersisted': True, 'programmaticRevealSilent': True,
            'existingPlaybackPreserved': True, 'errors': errors}


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Quiet, directory=str(ROOT)))
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                                                  args=['--no-sandbox', '--disable-dev-shm-usage'])
            results = [run(browser, f'http://127.0.0.1:{server.server_address[1]}/', width)
                       for width in [320, 390, 1280]]
            browser.close()
        print(json.dumps({'passed': True, 'cases': results}, ensure_ascii=False))
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
