const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {pathToFileURL,fileURLToPath}=require('node:url');
const sourcePath=path.join(__dirname,'../word-spelling.js');
const source=fs.readFileSync(sourcePath,'utf8');
function setup(options={}){
  const requests=[];let fail=!!options.fail;
  const context=vm.createContext({window:{},document:{currentScript:{src:pathToFileURL(sourcePath).href},baseURI:pathToFileURL(sourcePath).href},URL,setTimeout,clearTimeout,console,
    fetch:async url=>{
      const file=fileURLToPath(url);requests.push(file);
      if(fail) return {ok:false,text:async()=>''};
      return {ok:true,text:async()=>fs.readFileSync(file,'utf8')};
    }});
  new vm.Script(source,{filename:sourcePath,importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER}).runInContext(context);
  return {api:context.window.WordSpelling,requests,setFailure(value){fail=value;}};
}
const shared=setup();
const plain=value=>JSON.parse(JSON.stringify(value));

test('local US/GB dictionaries load once and concurrent readiness shares the result',async()=>{
  const [first,second]=await Promise.all([shared.api.ready(),shared.api.ready()]);
  assert.strictEqual(first,second);assert.equal(first.length,2);
  assert.equal(shared.requests.length,4);
  assert.ok(shared.requests.every(file=>file.startsWith(path.join(__dirname,'../vendor/word-check/'))));
});
test('valid US/GB variants, inflections and contractions are not spelling findings',async()=>{
  assert.deepEqual(plain(await shared.api.checkEnglish("colour color centre center organise organize realise realize travelling traveling studied studying children children's doesn't isn't would've we're")),[]);
});
test('accented Latin loanwords, decomposed accents and compatibility letters remain valid',async()=>{
  assert.deepEqual(plain(await shared.api.checkEnglish('café naïve résumé façade déjà vu garçon jalapeño fiancée crème brûlée cafe\u0301 ＣＡＴ ﬁnal')),[]);
});
test('case variants of known words and names are accepted rather than flagged as misspelled',async()=>{
  assert.deepEqual(plain(await shared.api.checkEnglish('CAT Cat cat seoul Seoul january January kim Kim nasa NASA')),[]);
});
test('likely common typos rank the intended word ahead of equally close unrelated suggestions',async()=>{
  const results=plain(await shared.api.checkEnglish('recieve RECIEVE Recieve Teh definately langauge'));
  assert.deepEqual(results.map(result=>result.suggestions[0]),['receive','RECEIVE','Receive','The','definitely','language']);
  assert.ok(results.every(result=>result.kind==='spelling'&&result.confidence==='likely'));
  assert.ok(results[0].suggestions.indexOf('receive')<results[0].suggestions.indexOf('relieve'));
});
test('valid-word meaning confusions are not claimed to be detectable spelling errors',async()=>{
  assert.deepEqual(plain(await shared.api.checkEnglish("form from its it's loose lose than then affect effect")),[]);
});
test('unknown names, transliterations, technical names and short uppercase identifiers remain review candidates',async()=>{
  const results=plain(await shared.api.checkEnglish("OpenAI OpenAI's Seoyeon minjun KimCheolsu ZZQX"));
  assert.equal(results.length,6);
  assert.ok(results.every(result=>result.kind==='name'&&result.confidence==='review'));
  assert.ok(results.every(result=>result.suggestions.length===0),'unknown names must not receive unrelated corrections');
});
test('hyphenated phrases, productive prefixes and suffix notation do not create false findings',async()=>{
  assert.deepEqual(plain(await shared.api.checkEnglish('well-known state-of-the-art re-enter co-operate anti-inflammatory non-profit computer-aided re- -ness')),[]);
  const typo=plain(await shared.api.checkEnglish('well-recieved'));
  assert.equal(typo.length,1);assert.equal(typo[0].token,'recieved');assert.equal(typo[0].start,5);assert.equal(typo[0].suggestions[0],'received');
});
test('Unicode apostrophes are checked as contractions while findings retain original UTF-16 spans',async()=>{
  assert.deepEqual(plain(await shared.api.checkEnglish('don’t isn’t we’re teacher’s O’Connor')),[]);
  const text='😀 ｒｅｃｉｅｖｅ and dont';
  const results=plain(await shared.api.checkEnglish(text));
  assert.equal(results.length,2);assert.equal(results[0].start,3);assert.equal(results[0].suggestions[0],'receive');
  for(const result of results) assert.equal(text.slice(result.start,result.end),result.token);
});
test('abbreviations, URL/email fragments and number identifiers are excluded conservatively',async()=>{
  assert.deepEqual(plain(await shared.api.checkEnglish('Dr. Smith Ph.D. PhD e.g. i.e. adj. sth https://example.invalid/recieve user@example.com 3rd 21st B12 10mg')),[]);
});
test('accepted terms are per-call, case/apostrophe normalized, and do not poison token caches',async()=>{
  const text="Recieve OpenAI’s";
  assert.equal((await shared.api.checkEnglish(text)).length,2);
  assert.deepEqual(plain(await shared.api.checkEnglish(text,{acceptedTerms:new Set(['recieve','openai'])})),[]);
  assert.equal((await shared.api.checkEnglish(text,{acceptedTerms:[]})).length,2);
  const first=await shared.api.checkEnglish('recieve');first[0].suggestions.length=0;
  assert.equal((await shared.api.checkEnglish('recieve'))[0].suggestions[0],'receive');
});
test('dictionary failures reject English checks, permit Korean checks, and allow a later retry',async()=>{
  const s=setup({fail:true});
  await assert.rejects(s.api.checkEnglish('recieve'),/영어 사전/);
  assert.equal(s.api.checkKorean('오랫만').length,1);
  s.setFailure(false);assert.equal((await s.api.checkEnglish('recieve'))[0].suggestions[0],'receive');
});
test('Korean common misspellings produce bounded suggestions without changing source text',()=>{
  const text='오랫만에 설겆이를 했다. 역활을 맡고 왠만하면 깨끗히, 일일히, 틈틈히, 곰곰히 확인한다. 어의없는 일이다. 내일 뵈요. 되요. 어떻해요. 희안한 짜집기 한웅큼. 안됬어요.';
  const results=plain(shared.api.checkKorean(text));
  for(const expected of ['오랜만','설거지','역할','웬만','깨끗이','일일이','틈틈이','곰곰이','어이없','봬요','돼요','어떡해','희한','짜깁기','한 움큼','됐']) assert.ok(results.some(result=>result.suggestions.includes(expected)),expected);
  assert.ok(results.every(result=>result.confidence==='likely'));
  for(const result of results) assert.equal(text.slice(result.start,result.end),result.token);
});
test('valid Korean words, compounds, names and ambiguous uses are not blanket corrected',()=>{
  assert.deepEqual(plain(shared.api.checkKorean('어의가 금새를 계산했고 역활용으로 만든 설거지 도구를 깨끗이 닦았다. 왠지 웬일 오랜만에 뵈어요. 희안 꼼꼼이 설레임 바램 답이 몇일까요?')),[]);
  assert.deepEqual(plain(shared.api.checkKorean('오랫만두 역활용 설겆이름 어의없애다')),[]);
});
test('ambiguous Korean 몇일 and 꼼꼼이 are distinguished from clear adverb/day contexts',()=>{
  assert.equal(shared.api.checkKorean('몇일')[0].confidence,'review');
  assert.equal(shared.api.checkKorean('몇일 동안')[0].confidence,'likely');
  assert.equal(shared.api.checkKorean('몇일째')[0].suggestions[0],'며칠');
  assert.deepEqual(plain(shared.api.checkKorean('꼼꼼이')),[]);
  assert.equal(shared.api.checkKorean('꼼꼼이 확인한다')[0].suggestions[0],'꼼꼼히');
});
test('decomposed Korean findings map back to original UTF-16 offsets including emoji and blank lines',()=>{
  const text='😀 '+ '오랫만에'.normalize('NFD')+'\n\n'+ '됬다'.normalize('NFD');
  const results=plain(shared.api.checkKorean(text));
  assert.equal(results.length,2);assert.equal(results[0].start,3);
  assert.equal(results[0].token.normalize('NFC'),'오랫만');assert.equal(results[1].token.normalize('NFC'),'됬');
  for(const result of results) assert.equal(text.slice(result.start,result.end),result.token);
});
