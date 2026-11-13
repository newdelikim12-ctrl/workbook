/* Local spelling candidates only. This module never changes vocabulary or sends text away. */
(function(){
  'use strict';
  const base=new URL('.',document.currentScript?.src||document.baseURI);
  const cache=new Map();
  let loading;
  const apostrophes=/[\u2018\u2019\u02bb\u02bc\uff07]/gu;
  const hyphens=/[\u2010\u2011\ufe63\uff0d]/gu;
  const canonical=value=>String(value||'').normalize('NFKC').replace(apostrophes,"'").replace(hyphens,'-');
  const folded=value=>canonical(value).toLocaleLowerCase('en-US');
  const abbreviations=new Set(['adj','adv','prep','pron','conj','interj','det','aux','vt','vi','sb','sth','sbd','etc','vs','mr','mrs','ms','dr','prof','jr','sr','st','fig','figs','approx','esp','eg','ie','phd','bsc','msc','esl','efl','cefr']);
  const accentedLoanwords=new Set(['café','naïve','résumé','façade','déjà','garçon','jalapeño','fiancée','fiancé','crème','brûlée','piñata']);
  const prefixes=new Set(['anti','auto','bi','co','counter','de','dis','ex','extra','hyper','hypo','inter','intra','macro','micro','mid','mis','multi','non','over','post','pre','pro','pseudo','re','semi','sub','super','trans','tri','ultra','un','under']);
  const suffixes=new Set(['able','ible','ness','ment','tion','sion','ity','ize','ise','ous','ful','less','ly','al','ic','ive','er','or','ist','ism','en','ed','ing','s','es']);
  const technicalNames=new Set(['openai','chatgpt','github','gitlab','javascript','typescript','nodejs','reactjs','nextjs','vuejs','stackoverflow','notion','figma','nspell','pdfjs','iphone','ipad','macos','ios','android','google','youtube']);
  // These are misspellings, not valid-word meaning confusions such as form/from or its/it's.
  const commonTypos=new Map(Object.entries({
    teh:'the',recieve:'receive',recieved:'received',recieving:'receiving',definately:'definitely',definate:'definite',
    seperate:'separate',seperated:'separated',seperately:'separately',occured:'occurred',occurence:'occurrence',
    accomodate:'accommodate',accomodation:'accommodation',adress:'address',enviroment:'environment',goverment:'government',
    grammer:'grammar',neccessary:'necessary',necessery:'necessary',succesful:'successful',sucess:'success',untill:'until',
    wierd:'weird',beleive:'believe',becuase:'because',freind:'friend',langauge:'language',embarassed:'embarrassed',
    dont:"don't",doesnt:"doesn't",isnt:"isn't",arent:"aren't",wasnt:"wasn't",werent:"weren't",
    couldnt:"couldn't",wouldnt:"wouldn't",shouldnt:"shouldn't",alot:'a lot'
  }));
  async function ready(){
    if(!loading){
      loading=(async()=>{
        const [module,...files]=await Promise.all([
          import(new URL('vendor/word-check/nspell.mjs',base).href),
          ...['en-US.aff','en-US.dic','en-GB.aff','en-GB.dic'].map(async name=>{
            const response=await fetch(new URL('vendor/word-check/'+name,base));
            if(!response.ok) throw Error('영어 사전을 불러오지 못했습니다. 연결 후 다시 검사해 주세요.');
            return response.text();
          })
        ]);
        return [module.default(files[0],files[1]),module.default(files[2],files[3])];
      })().catch(error=>{loading=null;throw error;});
    }
    return loading;
  }
  function variants(value){
    const lower=value.toLocaleLowerCase('en-US');
    const result=new Set([value,lower,lower.replace(/^\p{L}/u,letter=>letter.toUpperCase()),
      lower.replace(/(^|[-'])(\p{L})/gu,(_,before,letter)=>before+letter.toUpperCase())]);
    if(value.length<=5||value===value.toUpperCase()) result.add(value.toUpperCase());
    return [...result];
  }
  function correct(value,dictionaries){
    const check=word=>variants(word).some(form=>dictionaries.some(dictionary=>dictionary.correct(form)));
    if(accentedLoanwords.has(value.toLowerCase())) return true;
    if(check(value)) return true;
    // Standard Hunspell assets omit several accepted accented English loanwords.
    const unaccented=value.normalize('NFD').replace(/\p{M}/gu,'').normalize('NFC');
    if(unaccented!==value&&check(unaccented)) return true;
    const possessive=value.replace(/'s$/i,'');
    return possessive!==value&&check(possessive);
  }
  function distance(a,b){
    a=folded(a);b=folded(b);
    const matrix=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
    for(let i=0;i<=a.length;i++) matrix[i][0]=i;
    for(let j=0;j<=b.length;j++) matrix[0][j]=j;
    for(let i=1;i<=a.length;i++) for(let j=1;j<=b.length;j++){
      matrix[i][j]=Math.min(matrix[i-1][j]+1,matrix[i][j-1]+1,matrix[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
      if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1]) matrix[i][j]=Math.min(matrix[i][j],matrix[i-2][j-2]+1);
    }
    return matrix[a.length][b.length];
  }
  function sameCase(suggestion,token){
    if(token===token.toUpperCase()&&/[A-Z]/.test(token)) return suggestion.toUpperCase();
    if(/^\p{Lu}[\p{Ll}\p{M}'-]*$/u.test(token)) return suggestion.replace(/^\p{L}/u,letter=>letter.toUpperCase());
    return suggestion;
  }
  function romanizedName(value){
    const lower=folded(value).replace(/'s$/,'');
    if(technicalNames.has(lower)) return true;
    if(/^(?:kim|lee|park|choi|jung|jeong|kang|yoon|jang|kwon|hwang|hong|ryu)[a-z]{2,}$/u.test(lower)) return true;
    return /^(?:min|jun|joon|ji|soo|su|seo|seon|seong|hyun|hyeon|yeon|yeong|young|dong|ho|won|woo|jin|joo|yoo|ha|hye|bin|eun|sung|chul|cheol|tae|kyung|gyeong){2,4}$/u.test(lower);
  }
  function analyze(token,dictionaries){
    if(cache.has(token)) return cache.get(token);
    let result=null;
    if(!correct(token,dictionaries)){
      const lower=folded(token),preferred=commonTypos.get(lower);
      const knownTypo=!!preferred&&preferred.split(/\s+/u).every(word=>correct(word,dictionaries));
      const likelyName=!knownTypo&&(/^\p{Lu}/u.test(token)||/\p{Ll}.*\p{Lu}/u.test(token)||romanizedName(token));
      const raw=[];
      if(knownTypo) raw.push(preferred);
      // Unknown names/codes and very short fragments do not have a defensible
      // automatic correction; avoid both noisy guesses and expensive searches.
      if(token.length<=32&&!likelyName&&(knownTypo||token.length>=4)){
        for(const form of new Set([token,lower])) for(const dictionary of dictionaries) raw.push(...dictionary.suggest(form));
      }
      const maxDistance=lower.length<=7?2:lower.length<=15?3:4;
      const unique=new Map();
      for(const candidate of raw){
        const key=folded(candidate);
        if(key===lower||unique.has(key)) continue;
        const editDistance=distance(lower,key);
        if(editDistance>maxDistance) continue;
        unique.set(key,{candidate,editDistance,preferred:knownTypo&&key===folded(preferred),order:unique.size});
      }
      const ranked=[...unique.values()].sort((a,b)=>Number(b.preferred)-Number(a.preferred)||a.editDistance-b.editDistance||a.order-b.order);
      const nearest=ranked[0];
      const properSuggestion=!!nearest&&/^\p{Lu}/u.test(nearest.candidate)&&!dictionaries.some(dictionary=>dictionary.correct(nearest.candidate.toLowerCase()));
      const kind=likelyName||properSuggestion?'name':'spelling';
      const confidence=knownTypo||(!likelyName&&!properSuggestion&&lower.length>=4&&nearest&&nearest.editDistance<=2)?'likely':'review';
      result={kind,confidence,suggestions:ranked.slice(0,5).map(entry=>sameCase(entry.candidate,token)),
        message:confidence==='likely'?'영어 철자가 비슷한 사전 표기와 다른지 확인해 주세요.':kind==='name'?'고유명사·이름·전문용어일 수 있는 사전 미등재 표기입니다.':'사전 미등재 표기입니다. 고유명사나 전문용어일 수 있어요.'};
    }
    if(cache.size>=6000) cache.delete(cache.keys().next().value);
    cache.set(token,result);
    return result;
  }
  async function checkEnglish(text,options={}){
    const dictionaries=await ready(),results=[],source=String(text||'');
    const supplied=options&&options.acceptedTerms;
    const accepted=new Set((typeof supplied==='string'?[supplied]:supplied&&typeof supplied[Symbol.iterator]==='function'?[...supplied]:[])
      .filter(value=>typeof value==='string').map(value=>folded(value.trim())).filter(Boolean));
    const isAccepted=value=>accepted.has(folded(value))||accepted.has(folded(value).replace(/'s$/,''));
    const excluded=[];
    for(const pattern of [/\b(?:https?:\/\/|www\.)\S+/giu,/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/giu,/\b(?:[A-Za-z]{1,3}\.)+[A-Za-z]{1,3}\b/gu,/\bd[eé]\u0301?j[aà]\u0300?\s+vu\b/giu]){
      for(const match of source.matchAll(pattern)) excluded.push([match.index,match.index+match[0].length]);
    }
    const tokenPattern=/\p{Script=Latin}[\p{Script=Latin}\p{M}]*(?:['’‘ʼʻ＇]\p{Script=Latin}[\p{Script=Latin}\p{M}]*)*(?:[-‐‑﹣－]\p{Script=Latin}[\p{Script=Latin}\p{M}]*(?:['’‘ʼʻ＇]\p{Script=Latin}[\p{Script=Latin}\p{M}]*)*)*/gu;
    let checked=0;
    for(const match of source.matchAll(tokenPattern)){
      const start=match.index,end=start+match[0].length,whole=canonical(match[0]);
      if(excluded.some(([from,to])=>start>=from&&end<=to)||/\d/u.test(source[start-1]||'')||/\d/u.test(source[end]||'')) continue;
      if(isAccepted(whole)||correct(whole,dictionaries)) continue;
      const pieces=[...match[0].matchAll(/[^-‐‑﹣－]+/gu)];
      for(let index=0;index<pieces.length;index++){
        const piece=pieces[index],token=piece[0],normalized=canonical(token),lower=folded(normalized);
        if(normalized.length===1||abbreviations.has(lower)||isAccepted(normalized)) continue;
        if(index===0&&prefixes.has(lower)&&(pieces.length>1||source[end]==='-')) continue;
        if(index===0&&suffixes.has(lower)&&source[start-1]==='-'&&!/\p{Script=Latin}/u.test(source[start-2]||'')) continue;
        const finding=analyze(normalized,dictionaries);
        if(finding) results.push({start:start+piece.index,end:start+piece.index+token.length,token,...finding,suggestions:[...finding.suggestions]});
        if(++checked%30===0) await new Promise(resolve=>setTimeout(resolve,0));
      }
    }
    return results;
  }
  // Korean checks intentionally cover selected common spellings only, not morphology,
  // general spacing, grammar, or valid-word meaning confusions.
  const nounTail=/^(?:은|는|이|가|을|를|의|에|에서|에게|에게서|와|과|도|만|만을|만은|만이|만으로|로|으로|까지|부터|보다|처럼|마다|라고|라는|라도|라서|이라고|이라는|이라도|이라서|이란|이든|든|인가|인지|인|이다|입니다|이었다|였(?:다|어요)|이었(?:다|어요)|이어서|여서|이에요|예요|인데|이지만|임|임을|이라면|이면|일까|일까요|일지|일지도)?$/u;
  const adverbTail=/^(?:는|도|만)?$/u;
  const haTail=/^(?:하|한|할|해|했|합|함)[가-힣]*$/u;
  const pastTail=/^(?:다|다고|다는|다며|다면서|다니|다니까|고|고서|거나|구나|군요|는데|지만|으면|더라|더라고|네요|네|나요|나|니|냐|습니까|습니다|어요|어|었다|었던|었으면|었는데)?$/u;
  const koreanRules=[
    {wrong:'오랫만',right:'오랜만',tail:nounTail,message:'‘오래간만’의 준말은 ‘오랜만’입니다.'},
    {wrong:'설겆이',right:'설거지',tail:tail=>nounTail.test(tail)||haTail.test(tail),message:'표준 표기는 ‘설거지’입니다.'},
    {wrong:'역활',right:'역할',tail:nounTail,message:'맡은 일을 뜻한다면 ‘역할’인지 확인해 주세요.'},
    {wrong:'왠일',right:'웬일',tail:nounTail,message:'예상하지 못한 일은 ‘웬일’로 적습니다.'},
    {wrong:'짜집기',right:'짜깁기',tail:tail=>nounTail.test(tail)||haTail.test(tail),message:'표준 표기는 ‘짜깁기’입니다.'},
    {wrong:'한웅큼',right:'한 움큼',tail:nounTail,message:'한 손에 쥘 만한 양은 ‘한 움큼’으로 적습니다.'},
    {wrong:'깨끗히',right:'깨끗이',tail:adverbTail,message:'부사 표기는 ‘깨끗이’입니다.'},
    {wrong:'일일히',right:'일일이',tail:adverbTail,message:'‘하나하나’라는 뜻은 ‘일일이’입니다.'},
    {wrong:'틈틈히',right:'틈틈이',tail:adverbTail,message:'부사 표기는 ‘틈틈이’입니다.'},
    {wrong:'곰곰히',right:'곰곰이',tail:adverbTail,message:'깊이 생각한다는 뜻의 부사는 ‘곰곰이’입니다.'},
    {wrong:'웬지',right:'왠지',tail:adverbTail,message:'‘왜인지’의 준말은 ‘왠지’입니다.'},
    {wrong:'왠만',right:'웬만',tail:tail=>tail===''||haTail.test(tail)||/^(?:큼|큼은|큼만|치|치도)$/u.test(tail),message:'정도나 범위를 뜻할 때는 ‘웬만’입니다.'},
    {wrong:'희안',right:'희한',tail:haTail,message:'드물거나 신기하다는 뜻은 ‘희한하다’입니다.'},
    {wrong:'어의없',right:'어이없',tail:/^(?:다|는|고|게|이|음|어|어서|어도|어요|었[가-힣]*|으[가-힣]*|네[가-힣]*|지[가-힣]*|다면|다니|냐|나요|나|군[가-힣]*)?$/u,message:'황당하다는 뜻은 ‘어이없다’입니다.'}
  ];
  function normalizedKorean(source){
    const segments=typeof Intl!=='undefined'&&Intl.Segmenter
      ?[...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(source)].map(part=>({text:part.segment,index:part.index}))
      :[...source.matchAll(/[\u1100-\u1112][\u1161-\u1175][\u11a8-\u11c2]?|[^\p{M}]\p{M}*|\p{M}+/gu)].map(part=>({text:part[0],index:part.index}));
    let text='';const offsets=[];
    for(const part of segments){
      const normalized=part.text.normalize('NFC');text+=normalized;
      for(let i=0;i<normalized.length;i++) offsets.push({start:part.index,end:part.index+part.text.length});
    }
    return {text,offsets};
  }
  function checkKorean(text){
    const source=String(text||''),normalized=normalizedKorean(source),results=[],seen=new Set();
    function add(word,offset,wrong,right,message,confidence='likely'){
      const first=normalized.offsets[word.index+offset],last=normalized.offsets[word.index+offset+wrong.length-1];
      if(!first||!last||seen.has(first.start+':'+last.end)) return;
      seen.add(first.start+':'+last.end);
      results.push({start:first.start,end:last.end,token:source.slice(first.start,last.end),suggestions:[right],kind:'spelling',confidence,message});
    }
    for(const word of normalized.text.matchAll(/\p{Script=Hangul}+/gu)){
      const value=word[0],after=normalized.text.slice(word.index+value.length);
      for(const rule of koreanRules){
        if(!value.startsWith(rule.wrong)) continue;
        const tail=value.slice(rule.wrong.length),allowed=typeof rule.tail==='function'?rule.tail(tail):rule.tail.test(tail);
        if(allowed) add(word,0,rule.wrong,rule.right,rule.message);
      }
      const past=value.match(/^(안|못|잘|다|덜|더)?(됬)(.*)$/u);
      if(past&&pastTail.test(past[3])) add(word,(past[1]||'').length,'됬','됐','‘되었’의 준말은 ‘됐’입니다.');
      for(const [wrong,right,message] of [['되요','돼요','‘되어요’의 준말은 ‘돼요’입니다.'],['뵈요','봬요','‘뵈어요’의 준말은 ‘봬요’입니다.'],['됀','된','‘되다’의 관형형은 ‘된’입니다.'],['됄','될','‘되다’의 관형형은 ‘될’입니다.']]){
        if(value===wrong) add(word,0,wrong,right,message);
      }
      if(/^어떻해(?:요)?$/u.test(value)) add(word,0,'어떻해','어떡해','‘어떻게 해’의 준말은 ‘어떡해’입니다.');
      if(value==='꼼꼼이'&&/^\s+(?:살펴|살피|살폈|확인|검토|점검|읽|챙|보다|보고|보면|보니)/u.test(after)) add(word,0,'꼼꼼이','꼼꼼히','뒤의 동작을 꾸미는 부사는 ‘꼼꼼히’입니다.');
      if(value.startsWith('몇일')){
        const tail=value.slice(2),dayContext=/^(?:간|째|만에|전|후|뒤|동안)$/u.test(tail)||(!tail&&/^\s+(?:동안|만에|전|후|뒤|정도|걸|남|지나)/u.test(after));
        if(dayContext||nounTail.test(tail)) add(word,0,'몇일','며칠','날짜나 날의 수를 뜻한다면 ‘며칠’인지 확인해 주세요.',dayContext?'likely':'review');
      }
    }
    return results.sort((a,b)=>a.start-b.start||a.end-b.end);
  }
  window.WordSpelling=Object.freeze({ready,checkEnglish,checkKorean});
})();
