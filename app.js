'use strict';

const APP_VERSION='1.3.0';
const DB_NAME='finance-os-db', DB_VERSION=2, STORE='state', SNAPSHOTS='snapshots';
const DAY=86400000;

const CATEGORY_TREE={
  'Lebensmittel':['Supermarkt','Bäcker','Getränke','Haushaltslebensmittel'],
  'Essen & Trinken':['Restaurant','Lieferdienst','Fast Food','Kaffee','Snacks'],
  'Rauchen':['Zigaretten / Tabak','IQOS / Terea','Vape','Cannabis','Sonstiges'],
  'Freizeit & Party':['Bars','Clubs','Events','Kino','Hobby','Sonstiges'],
  'Shopping':['Kleidung','Schuhe','Technik','Haushalt','Beauty','Sonstiges'],
  'Mobilität':['Tanken','Parken','Maut','Taxi','ÖPNV','Autowäsche','Werkstatt'],
  'Reisen':['Flug','Fähre','Hotel','Unterkunft','Mietwagen','Aktivitäten','Sonstiges'],
  'Wohnen':['Miete','Strom','Wasser','Internet','Möbel','Reparatur','Sonstiges'],
  'Gesundheit':['Arzt','Zahnarzt','Apotheke','Therapie','Versicherung','Sonstiges'],
  'Sport':['Fitnessstudio','Ausrüstung','Verein','Sonstiges'],
  'Digital & Abos':['Apps','Streaming','Cloud','Software','Games','Sonstiges'],
  'Geschenke & Familie':['Geschenke','Familie','Spenden','Sonstiges'],
  'Bildung':['Kurse','Bücher','Prüfungen','Sonstiges'],
  'Gebühren & Bank':['Bankgebühren','Zinsen','Behörden','Sonstiges'],
  'Sonstiges':['Sonstiges']
};

const defaultState={
  version:4,
  meta:{lastSavedAt:null,lastBackupAt:null},
  settings:{currency:'EUR',budgetMode:'auto',manualBudget:0,salaryDay:28,customCategories:[]},
  incomes:[],fixedCosts:[],savings:[],debtPayments:[],transactions:[],assets:[],liabilities:[],
  history:{netWorth:[],investments:[]}
};

let state=structuredClone(defaultState),editing=null,storagePersistent=false;
let analysisRange='30d', investmentRange='max';
let calendarCursor=startOfMonth(new Date());

function $(id){return document.getElementById(id)}
function sum(arr,key='amount'){return arr.reduce((a,x)=>a+(Number(x?.[key])||0),0)}
function clamp(n,min,max){return Math.min(max,Math.max(min,n))}
function esc(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
function localISO(d=new Date()){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function parseISO(s){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(s||'')))return null;const [y,m,d]=s.split('-').map(Number),x=new Date(y,m-1,d,12);return Number.isNaN(x.getTime())?null:x}
function atNoon(d){return new Date(d.getFullYear(),d.getMonth(),d.getDate(),12)}
function startOfMonth(d){return new Date(d.getFullYear(),d.getMonth(),1,12)}
function endOfMonth(d){return new Date(d.getFullYear(),d.getMonth()+1,0,12)}
function addDays(d,n){const x=atNoon(d);x.setDate(x.getDate()+n);return x}
function daysInMonth(y,m){return new Date(y,m+1,0).getDate()}
function makeDate(y,m,day){return new Date(y,m,Math.min(day,daysInMonth(y,m)),12)}
function addMonthsAnchor(anchor,n){return makeDate(anchor.getFullYear(),anchor.getMonth()+n,anchor.getDate())}
function dateInRange(date,start,end){const t=atNoon(date).getTime();return t>=atNoon(start).getTime()&&t<=atNoon(end).getTime()}
function daysBetween(a,b){return Math.round((atNoon(b)-atNoon(a))/DAY)}
function fmtDate(d,opts={day:'2-digit',month:'2-digit',year:'numeric'}){return d.toLocaleDateString('de-DE',opts)}
function monthKey(d=new Date()){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`}
function id(){return crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2)}

function money(n){return new Intl.NumberFormat('de-DE',{style:'currency',currency:state.settings.currency||'EUR',minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(n)||0)}
function percent(n){return new Intl.NumberFormat('de-DE',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(n)||0)+' %'}
function numberInput(n){if(n===null||n===undefined||n==='')return '';const v=Number(n);return Number.isFinite(v)?new Intl.NumberFormat('de-DE',{minimumFractionDigits:0,maximumFractionDigits:2,useGrouping:false}).format(v):''}

function parseMoney(value){
  let s=String(value??'').trim().replace(/[\s€$£'’]/g,'');
  if(!s)return 0;
  if(!/^[+]?[0-9.,]+$/.test(s))return NaN;
  s=s.replace(/^\+/, '');
  const commas=(s.match(/,/g)||[]).length,dots=(s.match(/\./g)||[]).length;
  let normalized=s;
  if(commas&&dots){
    const decimalSep=s.lastIndexOf(',')>s.lastIndexOf('.')?',':'.';
    const groupSep=decimalSep===','?'.':',';
    normalized=s.split(groupSep).join('');
    const idx=normalized.lastIndexOf(decimalSep);
    normalized=normalized.slice(0,idx).split(decimalSep).join('')+'.'+normalized.slice(idx+1);
  }else if(commas||dots){
    const sep=commas?',':'.',parts=s.split(sep);
    if(parts.length===2){
      const [left,right]=parts;
      const looksGrouped=right.length===3&&left.length>=1&&left!=='0';
      normalized=looksGrouped?left+right:left+'.'+right;
    }else{
      const last=parts[parts.length-1];
      if(last.length===1||last.length===2)normalized=parts.slice(0,-1).join('')+'.'+last;
      else normalized=parts.join('');
    }
  }
  const n=Number(normalized);
  return Number.isFinite(n)?Math.round(n*100)/100:NaN;
}

function isInvestmentType(type){return ['ETF','Aktien','Krypto','Investment'].includes(type)}
function frequencyLabel(f){return ({weekly:'wöchentlich',fourweekly:'alle 4 Wochen',monthly:'monatlich',quarterly:'vierteljährlich',semiannual:'halbjährlich',yearly:'jährlich',oneTime:'einmalig'})[f]||'monatlich'}
function monthlyEquivalent(item){const a=Number(item.amount)||0;return ({weekly:a*52/12,fourweekly:a*13/12,monthly:a,quarterly:a/3,semiannual:a/6,yearly:a/12,oneTime:0})[item.frequency||'monthly']??a}
function yearlyEquivalent(item){return monthlyEquivalent(item)*12}

function migrateRecurring(item,kind){
  const x={...item};x.amount=Number(x.amount)||0;
  const hadFrequency=!!x.frequency;
  if(!hadFrequency){
    if(kind==='fixed'&&/\(Monatsanteil\)/i.test(x.name||'')){
      x.name=String(x.name).replace(/\s*\(Monatsanteil\)\s*/i,'').trim();x.amount=Math.round(x.amount*1200)/100;x.frequency='yearly';
    }else x.frequency='monthly';
  }
  if(!x.dueDate&&Number(x.dueDay)>=1){
    const today=new Date(),candidate=makeDate(today.getFullYear(),today.getMonth(),Number(x.dueDay));
    x.dueDate=localISO(candidate<atNoon(today)?makeDate(today.getFullYear(),today.getMonth()+1,Number(x.dueDay)):candidate);
  }
  x.dueDate=x.dueDate||'';
  return x;
}

function migrateTransaction(x){
  const t={...x,amount:Number(x.amount)||0,subcategory:x.subcategory||'',account:x.account||''};
  const map={Restaurant:['Essen & Trinken','Restaurant'],Kaffee:['Essen & Trinken','Kaffee'],Freizeit:['Freizeit & Party','Hobby'],Party:['Freizeit & Party','Events'],Auto:['Mobilität',''],Games:['Digital & Abos','Games']};
  if(map[t.category]){const [cat,sub]=map[t.category];t.category=cat;if(!t.subcategory)t.subcategory=sub}
  return t;
}

function normalizeState(data){
  const d=(data&&typeof data==='object')?data:{};
  const settings={...defaultState.settings,...(d.settings||{})};
  settings.salaryDay=clamp(Number(settings.salaryDay)||28,1,31);
  settings.customCategories=Array.isArray(settings.customCategories)?settings.customCategories.filter(Boolean):[];
  return {
    ...structuredClone(defaultState),...d,version:4,
    meta:{...defaultState.meta,...(d.meta||{})},settings,
    incomes:Array.isArray(d.incomes)?d.incomes.map(x=>({...x,amount:Number(x.amount)||0})):[],
    fixedCosts:Array.isArray(d.fixedCosts)?d.fixedCosts.map(x=>migrateRecurring(x,'fixed')):[],
    savings:Array.isArray(d.savings)?d.savings.map(x=>migrateRecurring(x,'saving')):[],
    debtPayments:Array.isArray(d.debtPayments)?d.debtPayments.map(x=>migrateRecurring(x,'debt')):[],
    transactions:Array.isArray(d.transactions)?d.transactions.map(migrateTransaction):[],
    assets:Array.isArray(d.assets)?d.assets.map(x=>({...x,value:Number(x.value)||0,costBasis:Number(x.costBasis)||0})):[],
    liabilities:Array.isArray(d.liabilities)?d.liabilities.map(x=>({...x,balance:Number(x.balance)||0})):[],
    history:{netWorth:Array.isArray(d.history?.netWorth)?d.history.netWorth:[],investments:Array.isArray(d.history?.investments)?d.history.investments:[]}
  };
}

function openDB(){return new Promise((resolve,reject)=>{const r=indexedDB.open(DB_NAME,DB_VERSION);r.onupgradeneeded=()=>{const db=r.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE);if(!db.objectStoreNames.contains(SNAPSHOTS))db.createObjectStore(SNAPSHOTS)};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('Datenbank blockiert'))})}
async function loadState(){try{const db=await openDB();return await new Promise(res=>{const tx=db.transaction(STORE,'readonly'),g=tx.objectStore(STORE).get('main');g.onsuccess=()=>res(normalizeState(g.result));g.onerror=()=>res(structuredClone(defaultState))})}catch(e){console.error(e);return structuredClone(defaultState)}}
async function trimSnapshots(db){return new Promise(res=>{const tx=db.transaction(SNAPSHOTS,'readwrite'),store=tx.objectStore(SNAPSHOTS),req=store.getAllKeys();req.onsuccess=()=>{const keys=req.result.sort();while(keys.length>25)store.delete(keys.shift())};tx.oncomplete=res;tx.onerror=res})}
function recordHistoryPoints(){
  state.history=state.history||{netWorth:[],investments:[]};
  state.history.netWorth=Array.isArray(state.history.netWorth)?state.history.netWorth:[];
  state.history.investments=Array.isArray(state.history.investments)?state.history.investments:[];
  const today=localISO(),net=sum(state.assets,'value')-sum(state.liabilities,'balance');
  const invAssets=state.assets.filter(a=>isInvestmentType(a.type)),value=sum(invAssets,'value'),cost=sum(invAssets,'costBasis'),gain=value-cost;
  const upsert=(arr,p)=>{const last=arr[arr.length-1];if(last?.date===today)Object.assign(last,p);else arr.push(p);if(arr.length>730)arr.splice(0,arr.length-730)};
  upsert(state.history.netWorth,{date:today,value:net});upsert(state.history.investments,{date:today,value,cost,gain});
}
async function saveState(){try{recordHistoryPoints();const db=await openDB();const previous=await new Promise(res=>{const tx=db.transaction(STORE,'readonly'),g=tx.objectStore(STORE).get('main');g.onsuccess=()=>res(g.result||null);g.onerror=()=>res(null)});state.meta={...defaultState.meta,...(state.meta||{}),lastSavedAt:new Date().toISOString()};await new Promise((res,rej)=>{const tx=db.transaction([STORE,SNAPSHOTS],'readwrite');if(previous)tx.objectStore(SNAPSHOTS).put(previous,`${new Date().toISOString()}-${id()}`);tx.objectStore(STORE).put(state,'main');tx.oncomplete=res;tx.onerror=()=>rej(tx.error);tx.onabort=()=>rej(tx.error||new Error('Speichern abgebrochen'))});await trimSnapshots(db);return true}catch(e){console.error(e);alert('Speichern fehlgeschlagen. Bitte sofort ein Backup exportieren und freien Gerätespeicher prüfen.');return false}}
async function restoreLastSnapshot(){const db=await openDB();const snaps=await new Promise(res=>{const tx=db.transaction(SNAPSHOTS,'readonly'),r=tx.objectStore(SNAPSHOTS).getAll();r.onsuccess=()=>res(r.result||[]);r.onerror=()=>res([])});if(!snaps.length){toast('Noch kein lokaler Stand vorhanden');return}if(!confirm('Den letzten lokalen Stand wiederherstellen?'))return;state=normalizeState(snaps[snaps.length-1]);await saveState();render();toast('Lokaler Stand wiederhergestellt')}

function salaryDate(y,m){return makeDate(y,m,state.settings.salaryDay)}
function getSalaryCycle(ref=new Date()){
  const r=atNoon(ref),thisSalary=salaryDate(r.getFullYear(),r.getMonth());
  let start,next;
  if(r>=thisSalary){start=thisSalary;next=salaryDate(r.getFullYear(),r.getMonth()+1)}else{start=salaryDate(r.getFullYear(),r.getMonth()-1);next=thisSalary}
  return {start,next,end:addDays(next,-1)};
}
function previousSalaryCycle(cycle){const prevEnd=addDays(cycle.start,-1);return getSalaryCycle(prevEnd)}

function occurrenceDates(item,start,end){
  const anchor=parseISO(item.dueDate);if(!anchor)return [];
  const f=item.frequency||'monthly';
  if(f==='oneTime')return dateInRange(anchor,start,end)?[anchor]:[];
  const out=[];
  if(f==='weekly'||f==='fourweekly'){
    const step=f==='weekly'?7:28;let cur=anchor,guard=0;
    while(cur>start&&guard++<3000)cur=addDays(cur,-step);
    while(cur<start&&guard++<3500)cur=addDays(cur,step);
    while(cur<=end&&guard++<4500){out.push(cur);cur=addDays(cur,step)}
    return out;
  }
  const step=({monthly:1,quarterly:3,semiannual:6,yearly:12})[f]||1;
  let n=0,cur=anchor,guard=0;
  while(cur>start&&guard++<600){n--;cur=addMonthsAnchor(anchor,n*step)}
  while(cur<start&&guard++<700){n++;cur=addMonthsAnchor(anchor,n*step)}
  while(cur<=end&&guard++<1200){out.push(cur);n++;cur=addMonthsAnchor(anchor,n*step)}
  return out;
}
function occurrencesFrom(arr,kind,start,end){return arr.flatMap(item=>occurrenceDates(item,start,end).map(date=>({date,amount:Number(item.amount)||0,name:item.name||'Ohne Namen',kind,itemId:item.id,type:item.type||'',frequency:item.frequency||'monthly'})))}
function allOccurrences(start,end){return [...occurrencesFrom(state.fixedCosts,'fixed',start,end),...occurrencesFrom(state.savings,'saving',start,end),...occurrencesFrom(state.debtPayments,'debt',start,end)].sort((a,b)=>a.date-b.date)}
function undatedRecurring(){return [...state.fixedCosts.map(x=>({item:x,kind:'fixed'})),...state.savings.map(x=>({item:x,kind:'saving'})),...state.debtPayments.map(x=>({item:x,kind:'debt'}))].filter(x=>!parseISO(x.item.dueDate)&&x.item.frequency!=='oneTime')}
function nextOccurrence(item,ref=new Date()){
  const end=addDays(ref,800);return occurrenceDates(item,atNoon(ref),end)[0]||null;
}

function transactionsBetween(start,end){return state.transactions.filter(t=>{const d=parseISO(t.date);return d&&dateInRange(d,start,end)})}
function calc(){
  const income=sum(state.incomes),avgFixed=state.fixedCosts.reduce((a,x)=>a+monthlyEquivalent(x),0),avgSaving=state.savings.reduce((a,x)=>a+monthlyEquivalent(x),0),avgDebt=state.debtPayments.reduce((a,x)=>a+monthlyEquivalent(x),0);
  const averageBudget=Math.max(0,income-avgFixed-avgSaving-avgDebt);
  const cycle=getSalaryCycle(),cycleOcc=allOccurrences(cycle.start,cycle.end),datedRequired=sum(cycleOcc),undatedFallback=undatedRecurring().reduce((a,x)=>a+monthlyEquivalent(x.item),0),cycleRequired=datedRequired+undatedFallback;
  const cycleAutoBudget=Math.max(0,income-cycleRequired),cycleBudget=state.settings.budgetMode==='manual'?Math.max(0,Math.min(cycleAutoBudget,Number(state.settings.manualBudget)||0)):cycleAutoBudget;
  const cycleTx=transactionsBetween(cycle.start,cycle.end),spent=sum(cycleTx),remaining=cycleBudget-spent;
  const cash=sum(state.assets.filter(a=>['Konto','Cash','Tagesgeld'].includes(a.type)),'value');
  const invAssets=state.assets.filter(a=>isInvestmentType(a.type)),investments=sum(invAssets,'value'),investmentCost=sum(invAssets,'costBasis'),investmentGain=investments-investmentCost,investmentPct=investmentCost?investmentGain/investmentCost*100:0;
  const assets=sum(state.assets,'value'),liabilities=sum(state.liabilities,'balance'),netWorth=assets-liabilities;
  const futureOcc=allOccurrences(atNoon(new Date()),addDays(cycle.next,-1)),futureDue=sum(futureOcc),safeUntilSalary=cash-futureDue;
  return {income,avgFixed,avgSaving,avgDebt,averageBudget,cycle,cycleOcc,cycleRequired,cycleAutoBudget,cycleBudget,cycleTx,spent,remaining,cash,investments,investmentCost,investmentGain,investmentPct,assets,liabilities,netWorth,futureOcc,futureDue,safeUntilSalary,undatedFallback};
}

function getAnalysisPeriod(range){
  const end=atNoon(new Date()),start=atNoon(end);
  if(range==='30d')start.setDate(start.getDate()-29);else if(range==='3m')start.setMonth(start.getMonth()-3);else if(range==='6m')start.setMonth(start.getMonth()-6);else start.setFullYear(start.getFullYear()-1);
  const days=daysBetween(start,end)+1,prevEnd=addDays(start,-1),prevStart=addDays(prevEnd,-days+1);return {start,end,prevStart,prevEnd};
}
function analysisData(){const p=getAnalysisPeriod(analysisRange),tx=transactionsBetween(p.start,p.end),prev=transactionsBetween(p.prevStart,p.prevEnd),spent=sum(tx),prevSpent=sum(prev),delta=prevSpent?((spent-prevSpent)/prevSpent)*100:null;return {...p,tx,prev,spent,prevSpent,delta}}

function setView(name){document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));$(`${name}View`)?.classList.add('active');document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===name));$('pageTitle').textContent={dashboard:'Dashboard',plan:'Plan',transactions:'Buchungen',due:'Fällig',wealth:'Vermögen'}[name]||'Finance OS';render();window.scrollTo({top:0,behavior:'smooth'})}
function render(){renderDashboard();renderPlan();renderTransactions();renderDue();renderWealth();renderDataSafety()}

function renderDashboard(){
  const c=calc(),cycleDays=daysBetween(c.cycle.start,c.cycle.end)+1;
  const rem=$('cycleRemaining');rem.textContent=money(c.remaining);rem.className='hero-value '+(c.remaining<0?'negative':'positive');
  $('cycleSub').textContent=`${fmtDate(c.cycle.start,{day:'2-digit',month:'2-digit'})}–${fmtDate(c.cycle.end,{day:'2-digit',month:'2-digit'})} · von ${money(c.cycleBudget)} variablem Budget`;
  $('cycleProgress').style.width=`${c.cycleBudget?Math.min(100,Math.max(0,c.spent/c.cycleBudget*100)):0}%`;
  $('safeUntilSalary').textContent=money(c.safeUntilSalary);$('safeUntilSalary').className=c.safeUntilSalary<0?'negative':'';$('safeUntilSalaryNote').textContent=undatedRecurring().length?`Nur datierte Abbuchungen · ${undatedRecurring().length} ohne Termin`:'Cash nach geplanten Abbuchungen';
  $('netWorth').textContent=money(c.netWorth);$('netWorth').className=c.netWorth<0?'negative':'';
  $('investmentTotal').textContent=money(c.investments);$('investmentGainSmall').textContent=c.investmentCost?`${c.investmentGain>=0?'+':''}${money(c.investmentGain)} · ${c.investmentGain>=0?'+':''}${percent(c.investmentPct)}`:'Noch kein Einstand';$('investmentGainSmall').className=c.investmentGain>=0?'positive':'negative';
  $('cycleSpent').textContent=money(c.spent);
  const prev=previousSalaryCycle(c.cycle),prevSpent=sum(transactionsBetween(prev.start,prev.end));$('cycleCompare').textContent=prevSpent?`${c.spent-prevSpent>=0?'+':''}${percent((c.spent-prevSpent)/prevSpent*100)} vs. davor`:'Keine Vergleichsdaten';
  const flows=[['Einnahmen',c.income],['Ø Fixkosten',-c.avgFixed],['Ø Sparen',-c.avgSaving],...(c.avgDebt?[['Ø Raten',-c.avgDebt]]:[]),['Ø variables Maximum',c.averageBudget]];
  $('flowRows').innerHTML=flows.map((x,i)=>`<div class="flow-row ${i===flows.length-1?'total':''}"><span>${x[0]}</span><strong class="${x[1]<0?'negative':''}">${money(x[1])}</strong></div>`).join('');
  renderUpcomingMini(c);
  renderAnalysis();
}
function renderUpcomingMini(c){const list=c.futureOcc.slice(0,4);$('upcomingMini').innerHTML=list.map(o=>dueRowHTML(o,'upcoming')).join('');$('upcomingMiniEmpty').style.display=list.length?'none':'block'}
function renderAnalysis(){const a=analysisData();$('analysisSpent').textContent=money(a.spent);$('analysisCompare').textContent=a.delta===null?'—':`${a.delta>=0?'+':''}${percent(a.delta)}`;$('analysisCompare').className=a.delta===null?'':a.delta<=0?'positive':'negative';document.querySelectorAll('#analysisRange button').forEach(b=>b.classList.toggle('active',b.dataset.range===analysisRange));const cats=Object.entries(a.tx.reduce((m,t)=>(m[t.category]=(m[t.category]||0)+Number(t.amount||0),m),{})).sort((a,b)=>b[1]-a[1]).slice(0,8),max=cats[0]?.[1]||1;$('categoryBars').innerHTML=cats.map(([k,v])=>`<div class="bar-row"><div class="bar-label">${esc(k)}</div><div class="bar-track"><div class="bar-fill" style="width:${v/max*100}%"></div></div><div class="bar-value">${money(v)}</div></div>`).join('');$('categoryEmpty').style.display=cats.length?'none':'block';drawSpendingTrend(a)}

function renderPlan(){
  const c=calc();$('salaryDayInput').value=state.settings.salaryDay;$('salaryCyclePreview').textContent=`Aktueller Zyklus: ${fmtDate(c.cycle.start)} bis ${fmtDate(c.cycle.end)} · nächstes Gehalt: ${fmtDate(c.cycle.next)}`;
  renderList('incomeList',state.incomes,'income',()=> 'monatlich');
  renderList('fixedList',state.fixedCosts,'fixed',recurringSub);
  renderList('savingList',state.savings,'saving',x=>`${x.type||'Sparen'} · ${recurringSub(x)}`);
  renderList('debtPaymentList',state.debtPayments,'debtPayment',recurringSub);
  $('averageBudgetValue').textContent=money(c.averageBudget);$('cycleBudgetValue').textContent=money(c.cycleAutoBudget);
  document.querySelectorAll('#budgetModeSwitch button').forEach(b=>b.classList.toggle('active',b.dataset.mode===state.settings.budgetMode));$('manualBudgetWrap').classList.toggle('hidden',state.settings.budgetMode!=='manual');$('manualBudgetInput').value=state.settings.manualBudget?numberInput(state.settings.manualBudget):'';updateMoneyPreview($('manualBudgetInput'),$('manualBudgetPreview'));
}
function recurringSub(x){const next=nextOccurrence(x),avg=monthlyEquivalent(x);return `${frequencyLabel(x.frequency)} · Ø ${money(avg)}/Monat${next?` · nächster Termin ${fmtDate(next)}`:' · Fälligkeit fehlt'}`}

function allMainCategories(){return [...Object.keys(CATEGORY_TREE),...state.settings.customCategories.filter(c=>!CATEGORY_TREE[c])].sort((a,b)=>a.localeCompare(b,'de'))}
function renderTransactions(){const m=$('monthFilter');if(!m.value)m.value=monthKey();const cat=$('categoryFilter'),current=cat.value;cat.innerHTML='<option value="">Alle Kategorien</option>'+allMainCategories().map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');if([...cat.options].some(o=>o.value===current))cat.value=current;const q=$('searchFilter').value.trim().toLowerCase();const filtered=state.transactions.filter(t=>(!m.value||String(t.date).slice(0,7)===m.value)&&(!cat.value||t.category===cat.value)&&(!q||[t.note,t.category,t.subcategory,t.account].join(' ').toLowerCase().includes(q))).sort((a,b)=>String(b.date).localeCompare(String(a.date)));$('filteredTransactionSum').textContent=money(sum(filtered));$('transactionList').innerHTML=filtered.map(t=>{const d=parseISO(t.date)||new Date(),sub=[t.category,t.subcategory,t.account].filter(Boolean).join(' · ');return `<div class="transaction-item"><div class="transaction-date"><strong>${d.getDate()}</strong><small>${d.toLocaleDateString('de-DE',{month:'short'})}</small></div><div class="transaction-info"><strong>${esc(t.note||t.subcategory||t.category)}</strong><small>${esc(sub)}</small></div><div class="transaction-amount">−${money(t.amount)}<small><button class="text-btn" data-edit-kind="transaction" data-id="${t.id}">Bearbeiten</button></small></div></div>`}).join('');$('transactionEmpty').style.display=filtered.length?'none':'block'}

function renderDue(){
  const c=calc(),today=atNoon(new Date()),next30=addDays(today,29),o30=allOccurrences(today,next30),untilSalary=allOccurrences(today,addDays(c.cycle.next,-1));$('dueTotalUntilSalary').textContent=money(sum(untilSalary));$('dueSalarySub').textContent=`${untilSalary.length} geplante Position${untilSalary.length===1?'':'en'} bis ${fmtDate(c.cycle.next)}`;$('due30Total').textContent=money(sum(o30));$('due30Count').textContent=`${o30.length} Abbuchung${o30.length===1?'':'en'}`;$('undatedCount').textContent=String(undatedRecurring().length);
  renderCalendar();
}
function renderCalendar(){
  const monthStart=startOfMonth(calendarCursor),monthEnd=endOfMonth(calendarCursor);$('calendarTitle').textContent=monthStart.toLocaleDateString('de-DE',{month:'long',year:'numeric'});$('dueListTitle').textContent=monthStart.toLocaleDateString('de-DE',{month:'long',year:'numeric'});
  const firstDow=(monthStart.getDay()+6)%7,gridStart=addDays(monthStart,-firstDow),gridEnd=addDays(gridStart,41),occ=allOccurrences(gridStart,gridEnd),byDate=occ.reduce((m,o)=>((m[localISO(o.date)]??=[]).push(o),m),{}),today=localISO();
  $('calendarGrid').innerHTML=Array.from({length:42},(_,i)=>{const d=addDays(gridStart,i),key=localISO(d),items=byDate[key]||[],outside=d.getMonth()!==monthStart.getMonth(),cls=['calendar-cell',outside?'outside':'',key===today?'today':'',items.length?'has-due':''].filter(Boolean).join(' '),total=sum(items);return `<div class="${cls}" data-cal-date="${key}"><span class="day">${d.getDate()}</span><div>${items.length?`<div class="sum">${money(total)}</div><div class="dot-row">${items.slice(0,4).map(()=>'<span class="dot"></span>').join('')}</div>`:''}</div></div>`}).join('');
  const monthOcc=allOccurrences(monthStart,monthEnd);$('dueList').innerHTML=monthOcc.map(o=>dueRowHTML(o,'due')).join('');$('dueEmpty').style.display=monthOcc.length?'none':'block';
}
function dueRowHTML(o,kind='due'){const d=o.date,type=({fixed:'Fixkosten',saving:'Sparen',debt:'Rate'})[o.kind]||o.kind;return `<div class="${kind}-item"><div class="date-badge"><strong>${d.getDate()}</strong><small>${d.toLocaleDateString('de-DE',{month:'short'})}</small></div><div class="${kind}-info"><strong>${esc(o.name)}</strong><small>${type} · ${frequencyLabel(o.frequency)}</small></div><div class="${kind}-amount">−${money(o.amount)}</div></div>`}

function renderWealth(){
  const c=calc();$('wealthNetWorth').textContent=money(c.netWorth);$('wealthNetWorth').className=c.netWorth<0?'negative':'';$('wealthBreakdown').textContent=c.liabilities?`${money(c.assets)} Vermögen − ${money(c.liabilities)} Verbindlichkeiten`:`${money(c.assets)} Vermögen`;
  $('portfolioValue').textContent=money(c.investments);$('portfolioCost').textContent=money(c.investmentCost);$('portfolioGain').textContent=`${c.investmentGain>=0?'+':''}${money(c.investmentGain)}`;$('portfolioGain').className=c.investmentGain>=0?'positive':'negative';$('portfolioPerformanceBadge').textContent=c.investmentCost?`${c.investmentGain>=0?'+':''}${percent(c.investmentPct)}`:'—';$('portfolioPerformanceBadge').className='badge '+(c.investmentGain>=0?'positive':'negative');
  renderList('assetList',state.assets,'asset',x=>x.type||'Vermögen');renderList('liabilityList',state.liabilities,'liability',x=>x.type||'Verbindlichkeit');document.querySelectorAll('#investmentRange button').forEach(b=>b.classList.toggle('active',b.dataset.range===investmentRange));drawInvestmentHistory();drawAllocation();drawNetWorthHistory();
}
function renderList(elId,arr,kind,subFn){const el=$(elId);el.innerHTML=arr.length?arr.map(item=>{let sub=esc(subFn?subFn(item):'');if(kind==='asset'&&isInvestmentType(item.type)&&Number(item.costBasis)>0){const gain=Number(item.value)-Number(item.costBasis),pct=gain/Number(item.costBasis)*100;sub+=` · <span class="asset-performance ${gain>=0?'positive':'negative'}">${gain>=0?'+':''}${money(gain)} (${gain>=0?'+':''}${percent(pct)})</span>`}return `<div class="edit-row"><div class="meta"><div class="name">${esc(item.name||'Ohne Namen')}</div><div class="sub">${sub}</div></div><div class="amount">${money(item.amount??item.value??item.balance)}</div><div class="mini-actions"><button class="mini-btn" data-edit-kind="${kind}" data-id="${item.id}">✎</button><button class="mini-btn" data-delete-kind="${kind}" data-id="${item.id}">×</button></div></div>`}).join(''):`<div class="empty-state" style="display:block">Noch nichts eingetragen.</div>`}

function rangeCutoff(range){const d=atNoon(new Date());if(range==='1m')d.setMonth(d.getMonth()-1);else if(range==='3m')d.setMonth(d.getMonth()-3);else if(range==='1y')d.setFullYear(d.getFullYear()-1);else return null;return d}
function drawLineChart(canvas,points,valueFn,labelFn,noteEl,emptyText,secondFn=null){
  if(!canvas)return;const ctx=canvas.getContext('2d'),dpr=window.devicePixelRatio||1,w=canvas.clientWidth||320,h=170;canvas.width=w*dpr;canvas.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);if(!points.length){ctx.strokeStyle='#252525';ctx.beginPath();ctx.moveTo(10,h/2);ctx.lineTo(w-10,h/2);ctx.stroke();if(noteEl)noteEl.textContent=emptyText;return}
  const allVals=points.flatMap(p=>secondFn?[valueFn(p),secondFn(p)]:[valueFn(p)]).map(Number).filter(Number.isFinite),min=Math.min(...allVals),max=Math.max(...allVals),range=Math.max(max-min,1),left=12,right=w-12,top=16,bottom=h-30,step=(right-left)/Math.max(points.length-1,1),y=v=>bottom-(v-min)/range*(bottom-top);
  ctx.strokeStyle='#292929';ctx.lineWidth=1;[0,.5,1].forEach(f=>{const yy=top+(bottom-top)*f;ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke()});
  const draw=(fn,color,width=2.4)=>{ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineJoin='round';ctx.lineCap='round';ctx.beginPath();points.forEach((p,i)=>{const x=points.length===1?(left+right)/2:left+i*step,yy=y(Number(fn(p))||0);i?ctx.lineTo(x,yy):ctx.moveTo(x,yy)});ctx.stroke()};
  if(secondFn)draw(secondFn,'#6d6d73',1.8);draw(valueFn,'#f4f4f4',2.5);
  ctx.fillStyle='#8e8e93';ctx.font='10px -apple-system,system-ui';ctx.textAlign='left';ctx.fillText(labelFn(points[0]),left,h-8);ctx.textAlign='right';ctx.fillText(labelFn(points[points.length-1]),right,h-8);if(noteEl)noteEl.textContent=points.length<2?'Erster Stand gespeichert. Der Verlauf wächst bei späteren Aktualisierungen.':`${points.length} lokale Stände gespeichert`;
}
function drawInvestmentHistory(){let pts=(state.history?.investments||[]).filter(p=>p?.date).sort((a,b)=>String(a.date).localeCompare(String(b.date)));const cut=rangeCutoff(investmentRange);if(cut)pts=pts.filter(p=>(parseISO(p.date)||new Date(0))>=cut);drawLineChart($('investmentChart'),pts,p=>Number(p.value)||0,p=>fmtDate(parseISO(p.date)||new Date(),{day:'2-digit',month:'short'}),$('investmentChartNote'),'Noch keine Investment-Historie.',p=>Number(p.cost)||0)}
function drawNetWorthHistory(){const pts=(state.history?.netWorth||[]).filter(p=>p?.date).sort((a,b)=>String(a.date).localeCompare(String(b.date))).slice(-365);drawLineChart($('netWorthChart'),pts,p=>Number(p.value)||0,p=>fmtDate(parseISO(p.date)||new Date(),{day:'2-digit',month:'short'}),$('netWorthChartNote'),'Noch keine Vermögenshistorie.')}
function drawAllocation(){const canvas=$('allocationChart');if(!canvas)return;const ctx=canvas.getContext('2d'),dpr=window.devicePixelRatio||1,w=canvas.clientWidth||320,h=170;canvas.width=w*dpr;canvas.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);const groups=[['Cash',sum(state.assets.filter(a=>['Konto','Cash','Tagesgeld'].includes(a.type)),'value'),'#67f29a'],['Investments',sum(state.assets.filter(a=>isInvestmentType(a.type)),'value'),'#f4f4f4'],['Sonstiges',sum(state.assets.filter(a=>!['Konto','Cash','Tagesgeld'].includes(a.type)&&!isInvestmentType(a.type)),'value'),'#8e8e93']].filter(x=>x[1]>0),total=groups.reduce((a,x)=>a+x[1],0),legend=$('allocationLegend');legend.innerHTML=groups.map(([n,v,c])=>`<div class="legend-item"><span class="legend-dot" style="--legend-color:${c}"></span><span>${esc(n)} · ${money(v)}</span></div>`).join('');$('allocationEmpty').style.display=total?'none':'block';const cx=w/2,cy=h/2,r=Math.min(60,w*.2),line=18;if(!total){ctx.strokeStyle='#252525';ctx.lineWidth=line;ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.stroke();return}let start=-Math.PI/2;groups.forEach(([,v,c])=>{const angle=Math.PI*2*v/total;ctx.strokeStyle=c;ctx.lineWidth=line;ctx.beginPath();ctx.arc(cx,cy,r,start,start+angle);ctx.stroke();start+=angle});ctx.fillStyle='#f4f4f4';ctx.font='700 17px -apple-system';ctx.textAlign='center';ctx.fillText(money(total),cx,cy+5)}
function drawSpendingTrend(a){const canvas=$('trendChart');if(!canvas)return;const bucketMonthly=analysisRange!=='30d',map=new Map();a.tx.forEach(t=>{const d=parseISO(t.date);if(!d)return;let key,label;if(bucketMonthly){key=monthKey(d);label=d.toLocaleDateString('de-DE',{month:'short'})}else{const weekStart=addDays(d,-((d.getDay()+6)%7));key=localISO(weekStart);label=fmtDate(weekStart,{day:'2-digit',month:'2-digit'})}const v=map.get(key)||{key,label,value:0};v.value+=Number(t.amount)||0;map.set(key,v)});let pts=[...map.values()].sort((x,y)=>x.key.localeCompare(y.key));if(!pts.length)pts=[];drawLineChart(canvas,pts,p=>p.value,p=>p.label,null,'')}

function hasUserData(){return state.incomes.length+state.fixedCosts.length+state.savings.length+state.debtPayments.length+state.transactions.length+state.assets.length+state.liabilities.length>0}
async function updateStorageStatus(request=false){const el=$('storageStatus'),btn=$('persistBtn');try{if(navigator.storage?.persisted){storagePersistent=await navigator.storage.persisted();if(!storagePersistent&&request&&navigator.storage.persist)storagePersistent=await navigator.storage.persist()}el.textContent=storagePersistent?'Geschützt':'Standard';el.className=storagePersistent?'status-good':'status-warn';btn.classList.toggle('hidden',storagePersistent||!navigator.storage?.persist)}catch{el.textContent='Standard';el.className='status-warn';btn.classList.remove('hidden')}}
function renderDataSafety(){const d=state.meta?.lastBackupAt?new Date(state.meta.lastBackupAt):null;$('lastBackupStatus').textContent=d?d.toLocaleString('de-DE',{dateStyle:'medium',timeStyle:'short'}):'Noch keines';const age=d?(Date.now()-d.getTime())/DAY:999;$('backupWarning').classList.toggle('show',hasUserData()&&age>=7);$('appVersionLabel').textContent=`Finance OS ${APP_VERSION} · lokal auf diesem Gerät`}

function recurringFields(item={}){const freq=item.frequency||'monthly';return `${moneyField('Betrag pro Abbuchung',item.amount)}<div class="field-row"><div class="field"><label>Rhythmus</label><select name="frequency">${[['monthly','Monatlich'],['quarterly','Vierteljährlich'],['semiannual','Halbjährlich'],['yearly','Jährlich'],['weekly','Wöchentlich'],['fourweekly','Alle 4 Wochen'],['oneTime','Einmalig']].map(([v,l])=>`<option value="${v}" ${freq===v?'selected':''}>${l}</option>`).join('')}</select></div><div class="field"><label>Nächste / erste Fälligkeit</label><input name="dueDate" type="date" value="${esc(item.dueDate||'')}"></div></div><div class="frequency-hint" data-frequency-hint></div>`}
function moneyField(label,val,key='amount',required=true){return `<div class="field"><label>${label}</label><input name="${key}" data-money="1" type="text" inputmode="decimal" autocomplete="off" value="${numberInput(val)}" placeholder="0,00" ${required?'required':''}><div class="money-live" data-money-preview-for="${key}"></div></div>`}
function nameField(label='Name',item={}){return `<div class="field"><label>${label}</label><input name="name" value="${esc(item.name||'')}" required></div>`}
function fieldsFor(kind,item={}){
  const today=localISO(),cashAccounts=state.assets.filter(a=>['Konto','Cash','Tagesgeld'].includes(a.type)).map(a=>a.name).filter(Boolean);
  if(kind==='transaction'){
    const cats=allMainCategories();const cat=item.category||cats[0]||'Sonstiges',subs=CATEGORY_TREE[cat]||[];
    return `<div class="field"><label>Datum</label><input name="date" type="date" value="${item.date||today}" required></div>${moneyField('Betrag',item.amount)}<div class="subcat-row"><div class="field"><label>Kategorie</label><select name="category" id="txCategory">${cats.map(c=>`<option value="${esc(c)}" ${cat===c?'selected':''}>${esc(c)}</option>`).join('')}<option value="__custom">+ Eigene Kategorie</option></select></div><div class="field"><label>Unterkategorie</label><select name="subcategory" id="txSubcategory">${subs.map(s=>`<option value="${esc(s)}" ${item.subcategory===s?'selected':''}>${esc(s)}</option>`).join('')}<option value="">Keine</option></select></div></div><div id="customCategoryWrap" class="field hidden"><label>Eigene Kategorie</label><input name="customCategory" placeholder="z. B. Hund"></div><div class="field"><label>Beschreibung (optional)</label><input name="note" value="${esc(item.note||'')}" placeholder="z. B. Sklavenitis"></div><div class="field"><label>Konto (optional)</label><select name="account"><option value="">Nicht zugeordnet</option>${cashAccounts.map(a=>`<option value="${esc(a)}" ${item.account===a?'selected':''}>${esc(a)}</option>`).join('')}</select></div>`;
  }
  if(kind==='income')return nameField('Einnahmequelle',item)+moneyField('Monatlicher Betrag',item.amount);
  if(kind==='fixed')return nameField('Fixkosten',item)+recurringFields(item);
  if(kind==='saving')return nameField('Sparplan / Rücklage',item)+recurringFields(item)+`<div class="field"><label>Typ</label><select name="type">${['ETF','Tagesgeld','Rücklage','Sonstiges'].map(v=>`<option ${item.type===v?'selected':''}>${v}</option>`).join('')}</select></div>`;
  if(kind==='debtPayment')return nameField('Verpflichtung / Rate',item)+recurringFields(item);
  if(kind==='asset'){const types=['Konto','Cash','Tagesgeld','ETF','Aktien','Krypto','Investment','Sonstiges'];return nameField('Konto / Anlage',item)+moneyField('Wert heute / aktueller Wert',item.value,'value')+`<div class="field"><label>Typ</label><select name="type" id="assetTypeSelect">${types.map(v=>`<option ${item.type===v?'selected':''}>${v}</option>`).join('')}</select></div><div id="costBasisField">${moneyField('Einstand / insgesamt investiert',item.costBasis,'costBasis',false)}<p class="helper">Bei ETF/Aktien/Krypto berechnet Finance OS daraus den echten Gewinn/Verlust. Einzahlungen erhöhen den Einstand, nicht den Gewinn.</p></div>`}
  if(kind==='liability')return nameField('Verbindlichkeit',item)+moneyField('Restschuld',item.balance,'balance')+`<div class="field"><label>Typ</label><select name="type">${['Kredit','Kreditkarte','Privat','Rückstand','Immobilie','Sonstiges'].map(v=>`<option ${item.type===v?'selected':''}>${v}</option>`).join('')}</select></div>`;
  return '';
}
function arrFor(kind){return ({income:state.incomes,fixed:state.fixedCosts,saving:state.savings,debtPayment:state.debtPayments,transaction:state.transactions,asset:state.assets,liability:state.liabilities})[kind]}
function openEntry(kind,item=null){editing={kind,id:item?.id||null};const names={transaction:['AUSGABE','Neue Buchung'],income:['PLAN','Einnahme'],fixed:['PLAN','Fixkosten'],saving:['PLAN','Sparplan'],debtPayment:['PLAN','Verpflichtung / Rate'],asset:['VERMÖGEN','Konto / Anlage'],liability:['OPTIONAL','Verbindlichkeit']};$('dialogKicker').textContent=names[kind][0];$('dialogTitle').textContent=(item?'Bearbeiten: ':'')+names[kind][1];$('dialogFields').innerHTML=fieldsFor(kind,item||{});$('entryDialog').showModal();bindDynamicForm(kind)}
function bindDynamicForm(kind){
  document.querySelectorAll('#entryForm [data-money]').forEach(input=>{const preview=input.parentElement.querySelector('[data-money-preview-for]');input.addEventListener('input',()=>updateMoneyPreview(input,preview));input.addEventListener('blur',()=>{const n=parseMoney(input.value);if(Number.isFinite(n))input.value=numberInput(n);updateMoneyPreview(input,preview)});updateMoneyPreview(input,preview)});
  document.querySelectorAll('#entryForm select[name="frequency"]').forEach(sel=>{const hint=document.querySelector('[data-frequency-hint]'),amount=document.querySelector('#entryForm [data-money][name="amount"]');const sync=()=>{const n=parseMoney(amount?.value),mock={amount:Number.isFinite(n)?n:0,frequency:sel.value};if(hint)hint.textContent=`Planungswert: Ø ${money(monthlyEquivalent(mock))}/Monat · ${money(yearlyEquivalent(mock))}/Jahr`};sel.addEventListener('change',sync);amount?.addEventListener('input',sync);sync()});
  if(kind==='transaction'){const cat=$('txCategory'),sub=$('txSubcategory'),custom=$('customCategoryWrap');const sync=()=>{const isCustom=cat.value==='__custom';custom.classList.toggle('hidden',!isCustom);const current=sub.value,subs=CATEGORY_TREE[cat.value]||[];sub.innerHTML=subs.map(s=>`<option value="${esc(s)}">${esc(s)}</option>`).join('')+'<option value="">Keine</option>';if(subs.includes(current))sub.value=current};cat.addEventListener('change',sync);sync()}
  if(kind==='asset'){const select=$('assetTypeSelect'),cost=$('costBasisField'),sync=()=>cost.classList.toggle('hidden',!isInvestmentType(select.value));select.addEventListener('change',sync);sync()}
}
function updateMoneyPreview(input,el){if(!input||!el)return;const n=parseMoney(input.value);el.textContent=input.value.trim()?(Number.isFinite(n)?`Speichert: ${money(n)}`:'Ungültige Zahl'):'';el.className='money-preview '+(input.value.trim()&&!Number.isFinite(n)?'negative':'')}
async function saveEntry(){
  const form=$('entryForm'),fd=new FormData(form),obj={};for(const [k,v] of fd.entries())obj[k]=v;
  for(const input of form.querySelectorAll('[data-money]')){const n=parseMoney(input.value);if(!Number.isFinite(n)||n<0){input.focus();alert('Bitte eine gültige Zahl eingeben, z. B. 123,45 oder 1.234,56.');return false}obj[input.name]=n}
  if(editing.kind==='transaction'&&obj.category==='__custom'){const custom=String(obj.customCategory||'').trim();if(!custom){alert('Bitte die eigene Kategorie benennen.');return false}obj.category=custom;if(!state.settings.customCategories.includes(custom))state.settings.customCategories.push(custom)}delete obj.customCategory;
  if(['fixed','saving','debtPayment'].includes(editing.kind)){obj.frequency=obj.frequency||'monthly';obj.dueDate=obj.dueDate||''}
  const arr=arrFor(editing.kind);if(editing.id){const idx=arr.findIndex(x=>x.id===editing.id);if(idx>=0)arr[idx]={...arr[idx],...obj}}else arr.push({id:id(),...obj});const ok=await saveState();if(!ok)return false;render();toast('Gespeichert');return true;
}
function toast(msg){const t=$('toast');t.textContent=msg;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1800)}

function bind(){
  document.querySelectorAll('.nav-item').forEach(b=>b.onclick=()=>setView(b.dataset.view));document.querySelectorAll('[data-nav]').forEach(b=>b.onclick=()=>setView(b.dataset.nav));document.querySelectorAll('[data-dialog-cancel]').forEach(b=>b.onclick=()=>{editing=null;$('entryDialog').close()});$('entryDialog').addEventListener('cancel',()=>{editing=null});
  $('quickAddBtn').onclick=()=>openEntry('transaction');$('addTransactionBtn').onclick=()=>openEntry('transaction');[['addIncomeBtn','income'],['addFixedBtn','fixed'],['addSavingBtn','saving'],['addDebtPaymentBtn','debtPayment'],['addAssetBtn','asset'],['addLiabilityBtn','liability']].forEach(([el,k])=>$(el).onclick=()=>openEntry(k));
  document.body.addEventListener('click',async e=>{const edit=e.target.closest('[data-edit-kind]');if(edit){const arr=arrFor(edit.dataset.editKind),item=arr.find(x=>x.id===edit.dataset.id);if(item)openEntry(edit.dataset.editKind,item);return}const del=e.target.closest('[data-delete-kind]');if(del&&confirm('Eintrag wirklich löschen?')){const arr=arrFor(del.dataset.deleteKind),idx=arr.findIndex(x=>x.id===del.dataset.id);if(idx>=0)arr.splice(idx,1);await saveState();render()}});
  $('entryForm').addEventListener('submit',async e=>{e.preventDefault();if(await saveEntry()){editing=null;$('entryDialog').close()}});
  $('salaryDayInput').addEventListener('change',async e=>{state.settings.salaryDay=clamp(Number(e.target.value)||28,1,31);await saveState();render()});
  document.querySelectorAll('#budgetModeSwitch button').forEach(b=>b.onclick=async()=>{state.settings.budgetMode=b.dataset.mode;await saveState();render()});$('manualBudgetInput').addEventListener('input',e=>updateMoneyPreview(e.target,$('manualBudgetPreview')));$('manualBudgetInput').addEventListener('change',async e=>{const n=parseMoney(e.target.value);if(!Number.isFinite(n)||n<0){alert('Bitte eine gültige Zahl eingeben.');renderPlan();return}state.settings.manualBudget=n;await saveState();render()});
  $('monthFilter').onchange=renderTransactions;$('categoryFilter').onchange=renderTransactions;$('searchFilter').oninput=renderTransactions;
  document.querySelectorAll('#analysisRange button').forEach(b=>b.onclick=()=>{analysisRange=b.dataset.range;renderAnalysis()});document.querySelectorAll('#investmentRange button').forEach(b=>b.onclick=()=>{investmentRange=b.dataset.range;renderWealth()});
  $('calendarPrev').onclick=()=>{calendarCursor=startOfMonth(addMonthsAnchor(calendarCursor,-1));renderCalendar()};$('calendarNext').onclick=()=>{calendarCursor=startOfMonth(addMonthsAnchor(calendarCursor,1));renderCalendar()};$('calendarToday').onclick=()=>{calendarCursor=startOfMonth(new Date());renderCalendar()};
  $('exportBtn').onclick=async()=>{state.meta={...defaultState.meta,...(state.meta||{}),lastBackupAt:new Date().toISOString()};const payload={format:'finance-os-backup',version:4,appVersion:APP_VERSION,exportedAt:state.meta.lastBackupAt,state};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`finance-os-backup-${localISO()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);await saveState();render();toast('Backup erstellt')};
  $('importInput').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{const raw=JSON.parse(await file.text()),data=raw?.format==='finance-os-backup'?raw.state:raw;state=normalizeState(data);await saveState();render();toast('Backup importiert')}catch(err){console.error(err);alert('Backup konnte nicht gelesen werden. Die Datei wurde nicht übernommen.')}finally{e.target.value=''}};
  $('restoreBtn').onclick=restoreLastSnapshot;$('persistBtn').onclick=async()=>{await updateStorageStatus(true);renderDataSafety();toast(storagePersistent?'Speicher geschützt':'Schutz konnte nicht erzwungen werden')};$('resetBtn').onclick=async()=>{if(confirm('Wirklich ALLE Finanzdaten auf diesem Gerät löschen?')){state=structuredClone(defaultState);await saveState();render();toast('Daten gelöscht')}};
  window.addEventListener('resize',()=>{drawSpendingTrend(analysisData());drawInvestmentHistory();drawAllocation();drawNetWorthHistory()});
}

async function init(){state=await loadState();recordHistoryPoints();bind();render();await updateStorageStatus(true);renderDataSafety();if('serviceWorker'in navigator){try{const reg=await navigator.serviceWorker.register('./service-worker.js',{scope:'./'});reg.update().catch(()=>{})}catch(e){console.warn('Service Worker nicht verfügbar',e)}}}

window.FinanceOSTest={parseMoney,monthlyEquivalent,getSalaryCycle:()=>getSalaryCycle(),occurrenceDates,normalizeState,localISO};
document.addEventListener('DOMContentLoaded',init);
