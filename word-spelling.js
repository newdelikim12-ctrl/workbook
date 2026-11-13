/* Local spelling review. Findings are suggestions; no vocabulary is changed here. */
(function(){
  'use strict';
  const base = new URL('.', document.currentScript?.src || document.baseURI);
  let loading;
  const cache = new Map();
  async function ready(){
    if(!loading){
      loading = (async()=>{
        const [module, ...files] = await Promise.all([
          import(new URL('vendor/word-check/nspell.mjs',base).href),
          ...['en-US.aff','en-US.dic','en-GB.aff','en-GB.dic'].map(async name=>{
            const response = await fetch(new URL('vendor/word-check/'+name,base));
            if(!response.ok) throw Error('영어 사전을 불러오지 못했습니다. 연결 후 다시 검사해 주세요.');
            return response.text();
          })
        ]);
        return [module.default(files[0],files[1]),module.default(files[2],files[3])];
      })().catch(error=>{loading=null;throw error;});
    }
    return loading;
  }
  async function checkEnglish(text){
    const dictionaries = await ready();
    const results=[];
    const source=String(text||'');
    // Preserve UTF-16 offsets, including curly apostrophes and accented Latin words.
    const tokenPattern=/[\p{Script=Latin}]+(?:['’][\p{Script=Latin}]+)*/gu;
    for(const match of source.matchAll(tokenPattern)){
      const token=match[0], normalized=token.replace(/’/g,"'").normalize('NFKC');
      if(token.length===1 || (token.length<=4 && token===token.toUpperCase())) continue;
      let result=cache.get(normalized);
      if(result===undefined){
        const correct=dictionaries.some(dictionary=>dictionary.correct(normalized));
        result=correct?null:{
          suggestions:[...new Set(dictionaries.flatMap(dictionary=>dictionary.suggest(normalized)))].slice(0,5),
          kind:/^[A-Z]/.test(token)?'name':'spelling',
          message:/^[A-Z]/.test(token)?'사전 미등재 표기입니다. 고유명사일 수 있어요.':'영어 사전에서 찾지 못한 철자입니다.'
        };
        if(cache.size>10000) cache.clear();
        cache.set(normalized,result);
      }
      if(result) results.push({start:match.index,end:match.index+token.length,token,...result,suggestions:[...result.suggestions]});
    }
    return results;
  }
  // Intentionally limited to common, relatively unambiguous misspellings.
  // This is not a Korean morphology, spacing, or grammar checker.
  const koreanRules=[
    [/됬/gu,'됐','‘되었’의 준말은 ‘됐’입니다.'],
    [/왠만/gu,'웬만','정도나 범위를 뜻할 때는 ‘웬만’입니다.'],
    [/오랫만/gu,'오랜만','‘오래간만’의 준말은 ‘오랜만’입니다.'],
    [/설겆이/gu,'설거지','표준 표기는 ‘설거지’입니다.'],
    [/어의없/gu,'어이없','황당하다는 뜻은 ‘어이없다’입니다.'],
    [/깨끗히/gu,'깨끗이','‘깨끗이’로 적습니다.'],
    [/일일히/gu,'일일이','‘하나하나’라는 뜻은 ‘일일이’입니다.'],
    [/틈틈히/gu,'틈틈이','‘틈틈이’로 적습니다.'],
    [/꼼꼼이/gu,'꼼꼼히','‘꼼꼼히’로 적습니다.'],
    [/역활(?=$|[\s.,!?;:·()\[\]]|[을은는이의에도만과로])/gu,'역할','맡은 일이라는 뜻은 ‘역할’입니다.'],
    [/몇일(?=$|[\s.,!?;:·()\[\]]|[을은는이의에도만간])/gu,'며칠','날짜나 날의 수를 물을 때는 ‘며칠’입니다.'],
    [/금새(?=$|[\s.,!?;:·()\[\]]|[에라도는])/gu,'금세','‘금방’이라는 뜻이라면 ‘금세’인지 확인해 주세요.']
  ];
  function checkKorean(text){
    const source=String(text||'').normalize('NFC'),results=[];
    for(const [pattern,suggestion,message] of koreanRules){
      pattern.lastIndex=0;
      for(const match of source.matchAll(pattern)) results.push({start:match.index,end:match.index+match[0].length,token:match[0],suggestions:[suggestion],kind:'spelling',message});
    }
    return results.sort((a,b)=>a.start-b.start);
  }
  window.WordSpelling=Object.freeze({ready,checkEnglish,checkKorean});
})();
