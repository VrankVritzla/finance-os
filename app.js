'use strict';

const APP_VERSION = '1.4.0';
const DB_NAME = 'finance-os-db';
const DB_VERSION = 2;
const STORE = 'state';
const SNAPSHOTS = 'snapshots';
const Core = window.FinanceCore;

if (!Core) throw new Error('FinanceCore konnte nicht geladen werden.');

const CATEGORY_TREE = {
  'Lebensmittel': ['Supermarkt', 'Bäcker', 'Getränke', 'Haushaltslebensmittel'],
  'Essen & Trinken': ['Restaurant', 'Lieferdienst', 'Fast Food', 'Kaffee', 'Snacks'],
  'Rauchen': ['Zigaretten / Tabak', 'IQOS / Terea', 'Vape', 'Cannabis', 'Sonstiges'],
  'Freizeit & Party': ['Bars', 'Clubs', 'Events', 'Kino', 'Hobby', 'Sonstiges'],
  'Shopping': ['Kleidung', 'Schuhe', 'Technik', 'Haushalt', 'Beauty', 'Sonstiges'],
  'Mobilität': ['Tanken', 'Parken', 'Maut', 'Taxi', 'ÖPNV', 'Autowäsche', 'Werkstatt'],
  'Reisen': ['Flug', 'Fähre', 'Hotel', 'Unterkunft', 'Mietwagen', 'Aktivitäten', 'Sonstiges'],
  'Wohnen': ['Miete', 'Strom', 'Wasser', 'Internet', 'Möbel', 'Reparatur', 'Sonstiges'],
  'Gesundheit': ['Arzt', 'Zahnarzt', 'Apotheke', 'Therapie', 'Versicherung', 'Sonstiges'],
  'Sport': ['Fitnessstudio', 'Ausrüstung', 'Verein', 'Sonstiges'],
  'Digital & Abos': ['Apps', 'Streaming', 'Cloud', 'Software', 'Games', 'Sonstiges'],
  'Geschenke & Familie': ['Geschenke', 'Familie', 'Spenden', 'Sonstiges'],
  'Bildung': ['Kurse', 'Bücher', 'Prüfungen', 'Sonstiges'],
  'Gebühren & Bank': ['Bankgebühren', 'Zinsen', 'Behörden', 'Sonstiges'],
  'Sonstiges': ['Sonstiges']
};

const TRANSACTION_LABELS = {
  expense: 'Ausgabe', income: 'Einnahme', refund: 'Erstattung', transfer: 'Transfer',
  investment: 'Investment', correction: 'Korrektur'
};
const FREQUENCY_LABELS = {
  weekly: 'Wöchentlich', fourweekly: 'Alle 4 Wochen', monthly: 'Monatlich',
  quarterly: 'Vierteljährlich', semiannual: 'Halbjährlich', yearly: 'Jährlich', oneTime: 'Einmalig'
};
const INVESTMENT_TYPES = ['ETF', 'Aktie', 'Aktien', 'Krypto', 'Investment'];

let state = Core.createDefaultState();
let editing = null;
let pendingImport = null;
let reconcileAccountId = null;
let storagePersistent = false;
let storageReady = true;
let dbPromise = null;
let analysisRange = '30d';
let investmentRange = 'max';
let calendarCursor = Core.startOfMonth(new Date());
let selectedCalendarDate = '';
let waitingWorker = null;
let reloadingForUpdate = false;

function $(id) { return document.getElementById(id); }
function id(prefix = 'id') { return crypto.randomUUID ? crypto.randomUUID() : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
function clone(value) { return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)); }
function esc(value = '') { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }
function sum(items, key = 'amount') { return (items || []).reduce((total, item) => total + (Number(item?.[key]) || 0), 0); }
function money(value) { return new Intl.NumberFormat('de-DE', { style: 'currency', currency: state.settings.currency || 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0); }
function percent(value) { return `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value) || 0)} %`; }
function numberInput(value) { return value === '' || value === null || value === undefined ? '' : new Intl.NumberFormat('de-DE', { useGrouping: false, maximumFractionDigits: 2 }).format(Number(value)); }
function fmtDate(date, options = { day: '2-digit', month: '2-digit', year: 'numeric' }) { return date.toLocaleDateString('de-DE', options); }
function formatDateTime(value) { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : 'Noch nie'; }
function accountById(accountId) { return state.accounts.find(account => account.id === accountId) || null; }
function assetById(assetId) { return state.assets.find(asset => asset.id === assetId) || null; }
function liabilityById(liabilityId) { return state.liabilities.find(item => item.id === liabilityId) || null; }
function isInvestment(asset) { return INVESTMENT_TYPES.includes(asset?.type); }
function allCategories() { return [...new Set([...Object.keys(CATEGORY_TREE), ...(state.settings.customCategories || [])])].sort((a, b) => a.localeCompare(b, 'de')); }
function toast(message) { const element = $('toast'); element.textContent = message; element.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 2400); }

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    request.onerror = () => { dbPromise = null; reject(request.error || new Error('IndexedDB konnte nicht geöffnet werden.')); };
    request.onblocked = () => { dbPromise = null; reject(new Error('Datenbank ist durch eine andere geöffnete Finance-OS-Version blockiert.')); };
  });
  return dbPromise;
}

function getStoredMain(db) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get('main');
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Daten konnten nicht gelesen werden.'));
  });
}

async function loadState() {
  const db = await openDB();
  const raw = await getStoredMain(db);
  if (!raw) return { ...Core.migrateState(Core.createDefaultState()), hadStoredState: false };
  const validation = Core.validateImportPayload(raw);
  if (!validation.valid) throw new Error(`Lokaler Datenbestand ist ungültig: ${validation.errors.join(' ')}`);
  return { state: validation.state, warnings: validation.warnings, sourceVersion: validation.summary.sourceVersion, targetVersion: Core.STATE_VERSION, hadStoredState: true };
}

function upsertDaily(points, point, maximum) {
  const index = points.findIndex(item => item.date === point.date);
  if (index >= 0) points[index] = { ...points[index], ...point };
  else points.push(point);
  points.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (points.length > maximum) points.splice(0, points.length - maximum);
}

function recordHistoryPoints() {
  state.history ||= { netWorth: [], investments: [] };
  state.history.netWorth = Array.isArray(state.history.netWorth) ? state.history.netWorth : [];
  state.history.investments = Array.isArray(state.history.investments) ? state.history.investments : [];
  const date = Core.localISO();
  const accountValue = sum(state.accounts, 'balance');
  const assetValue = sum(state.assets, 'value');
  const liabilities = sum(state.liabilities, 'balance');
  const investments = state.assets.filter(isInvestment);
  upsertDaily(state.history.netWorth, { date, value: Core.roundMoney(accountValue + assetValue - liabilities) }, 1095);
  upsertDaily(state.history.investments, { date, value: sum(investments, 'value'), cost: sum(investments, 'costBasis') }, 1095);
}

function trimSnapshots(db) {
  return new Promise(resolve => {
    const tx = db.transaction(SNAPSHOTS, 'readwrite');
    const store = tx.objectStore(SNAPSHOTS);
    const request = store.getAllKeys();
    request.onsuccess = () => {
      const keys = request.result.sort();
      while (keys.length > 40) store.delete(keys.shift());
    };
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

async function saveState({ snapshot = true } = {}) {
  if (!storageReady) throw new Error('Lokaler Speicher ist nicht verfügbar.');
  recordHistoryPoints();
  const db = await openDB();
  const previous = snapshot ? await getStoredMain(db) : null;
  state.meta = { ...state.meta, lastSavedAt: new Date().toISOString() };
  await new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, SNAPSHOTS], 'readwrite');
    if (previous) tx.objectStore(SNAPSHOTS).put(previous, `${new Date().toISOString()}-${id('snapshot')}`);
    tx.objectStore(STORE).put(state, 'main');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('Speichern fehlgeschlagen.'));
    tx.onabort = () => reject(tx.error || new Error('Speichern wurde abgebrochen.'));
  });
  await trimSnapshots(db);
}

async function commitMutation(mutator, message = 'Gespeichert') {
  const before = clone(state);
  try {
    await mutator();
    await saveState();
    render();
    if (message) toast(message);
    return true;
  } catch (error) {
    state = before;
    console.error(error);
    render();
    alert('Speichern fehlgeschlagen. Deine vorherigen Daten wurden in der geöffneten App wiederhergestellt. Bitte exportiere ein Backup und prüfe den Gerätespeicher.');
    return false;
  }
}

function setView(name) {
  document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
  $(`${name}View`)?.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  $('pageTitle').textContent = ({ dashboard: 'Home', plan: 'Plan', transactions: 'Buchungen', due: 'Fällig', wealth: 'Vermögen' })[name] || 'Finance OS';
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function render() {
  renderDashboard();
  renderPlan();
  renderTransactions();
  renderDue();
  renderWealth();
  renderDataSafety();
}

function renderDashboard() {
  const calculation = Core.calculateBudget(state);
  const remaining = $('cycleRemaining');
  remaining.textContent = money(calculation.remaining);
  remaining.className = `hero-value ${calculation.remaining < 0 ? 'negative' : 'positive'}`;
  $('cycleSub').textContent = `${fmtDate(calculation.cycle.start, { day: '2-digit', month: '2-digit' })}–${fmtDate(calculation.cycle.end, { day: '2-digit', month: '2-digit' })} · ${money(calculation.cycleBudget)} variables Budget`;
  $('cycleProgress').style.width = `${calculation.cycleBudget ? Math.min(100, Math.max(0, calculation.spent / calculation.cycleBudget * 100)) : 0}%`;
  $('safeUntilSalary').textContent = money(calculation.safeUntilSalary);
  $('safeUntilSalary').className = calculation.safeUntilSalary < 0 ? 'negative' : '';
  $('safeUntilSalaryNote').textContent = calculation.undatedItems.length ? `${calculation.undatedItems.length} Position(en) ohne Termin nicht enthalten` : `${calculation.futureOccurrences.length} offene Zahlung(en)`;
  $('netWorth').textContent = money(calculation.netWorth);
  $('netWorth').className = calculation.netWorth < 0 ? 'negative' : '';
  $('investmentTotal').textContent = money(calculation.investments);
  if (calculation.investmentGain === null) {
    $('investmentGainSmall').textContent = calculation.investments ? 'Einstand unvollständig' : 'Noch keine Investments';
    $('investmentGainSmall').className = '';
  } else {
    $('investmentGainSmall').textContent = `${calculation.investmentGain >= 0 ? '+' : ''}${money(calculation.investmentGain)} · ${calculation.investmentPct >= 0 ? '+' : ''}${percent(calculation.investmentPct)}`;
    $('investmentGainSmall').className = calculation.investmentGain >= 0 ? 'positive' : 'negative';
  }
  $('cycleSpent').textContent = money(calculation.spent);
  const previousCycle = Core.previousSalaryCycle(state.settings.salaryDay, calculation.cycle);
  const previousSpent = Core.transactionsBetween(state, previousCycle.start, previousCycle.end).reduce((total, transaction) => total + Core.transactionConsumption(transaction), 0);
  $('cycleCompare').textContent = previousSpent > 0 ? `${calculation.spent - previousSpent >= 0 ? '+' : ''}${percent((calculation.spent - previousSpent) / previousSpent * 100)} vs. davor` : 'Keine Vergleichsdaten';
  const flowRows = [
    ['Einnahmen', calculation.income], ['Ø Fixkosten', -calculation.avgFixed], ['Ø Sparen', -calculation.avgSaving],
    ...(calculation.avgDebt ? [['Ø Raten', -calculation.avgDebt]] : []), ['Ø variables Maximum', calculation.averageBudget]
  ];
  $('flowRows').innerHTML = flowRows.map((row, index) => `<div class="flow-row ${index === flowRows.length - 1 ? 'total' : ''}"><span>${esc(row[0])}</span><strong class="${row[1] < 0 ? 'negative' : ''}">${money(row[1])}</strong></div>`).join('');
  renderAccountSnapshot();
  const upcoming = calculation.futureOccurrences.slice(0, 4);
  $('upcomingMini').innerHTML = upcoming.map(occurrence => dueRowHTML(occurrence, 'upcoming', false)).join('');
  $('upcomingMiniEmpty').style.display = upcoming.length ? 'none' : 'block';
  renderAnalysis();
}

function renderAccountSnapshot() {
  const accounts = state.accounts.filter(account => account.active !== false);
  $('accountSnapshot').innerHTML = accounts.map(account => `<div class="account-chip ${account.includeInAvailable === false ? 'held' : ''}"><span>${esc(account.type)}</span><strong>${money(account.balance)}</strong><small>${esc(account.name)}</small></div>`).join('');
  $('accountSnapshotEmpty').style.display = accounts.length ? 'none' : 'block';
}

function analysisPeriod(range) {
  const end = Core.atNoon(new Date());
  let start = Core.atNoon(end);
  if (range === '30d') start = Core.addDays(end, -29);
  else if (range === '3m') start = Core.addMonthsAnchored(end, -3);
  else if (range === '6m') start = Core.addMonthsAnchored(end, -6);
  else start = Core.makeDate(end.getFullYear() - 1, end.getMonth(), end.getDate());
  const days = Core.daysBetween(start, end) + 1;
  const previousEnd = Core.addDays(start, -1);
  const previousStart = Core.addDays(previousEnd, -days + 1);
  return { start, end, days, previousStart, previousEnd };
}

function analysisData() {
  const period = analysisPeriod(analysisRange);
  const transactions = Core.transactionsBetween(state, period.start, period.end);
  const previous = Core.transactionsBetween(state, period.previousStart, period.previousEnd);
  const spent = transactions.reduce((total, transaction) => total + Core.transactionConsumption(transaction), 0);
  const previousSpent = previous.reduce((total, transaction) => total + Core.transactionConsumption(transaction), 0);
  const delta = previousSpent > 0 ? (spent - previousSpent) / previousSpent * 100 : null;
  return { ...period, transactions, previous, spent, previousSpent, delta };
}

function renderAnalysis() {
  const analysis = analysisData();
  $('analysisSpent').textContent = money(analysis.spent);
  $('analysisCompare').textContent = analysis.delta === null ? '—' : `${analysis.delta >= 0 ? '+' : ''}${percent(analysis.delta)}`;
  $('analysisCompare').className = analysis.delta === null ? '' : analysis.delta <= 0 ? 'positive' : 'negative';
  $('analysisDaily').textContent = money(analysis.spent / analysis.days);
  document.querySelectorAll('#analysisRange button').forEach(button => button.classList.toggle('active', button.dataset.range === analysisRange));
  const categories = Object.entries(analysis.transactions.reduce((map, transaction) => {
    const value = Core.transactionConsumption(transaction);
    if (!value) return map;
    map[transaction.category || 'Sonstiges'] = (map[transaction.category || 'Sonstiges'] || 0) + value;
    return map;
  }, {})).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
  $('analysisTop').textContent = categories[0]?.[0] || '—';
  const maximum = categories[0]?.[1] || 1;
  $('categoryBars').innerHTML = categories.slice(0, 8).map(([name, value]) => `<div class="bar-row"><div class="bar-label">${esc(name)}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(0, value / maximum * 100)}%"></div></div><div class="bar-value">${money(value)}</div></div>`).join('');
  $('categoryEmpty').style.display = categories.length ? 'none' : 'block';
  drawSpendingTrend(analysis);
}

function renderPlan() {
  const calculation = Core.calculateBudget(state);
  $('salaryDayInput').value = state.settings.salaryDay;
  $('salaryCyclePreview').textContent = `Aktueller Zyklus: ${fmtDate(calculation.cycle.start)} bis ${fmtDate(calculation.cycle.end)} · nächstes Gehalt: ${fmtDate(calculation.cycle.next)}`;
  renderSimpleList('incomeList', state.incomes, 'income', item => `${item.active === false ? 'Pausiert · ' : ''}${accountById(item.accountId)?.name || 'Kein Zielkonto'}`);
  renderSimpleList('fixedList', state.fixedCosts, 'fixed', recurringSub);
  renderSimpleList('savingList', state.savings, 'saving', item => `${item.type || 'Sparen'} · ${recurringSub(item)}`);
  renderSimpleList('debtPaymentList', state.debtPayments, 'debtPayment', recurringSub);
  $('averageBudgetValue').textContent = money(calculation.averageBudget);
  $('cycleBudgetValue').textContent = money(calculation.cycleAutoBudget);
  document.querySelectorAll('#budgetModeSwitch button').forEach(button => button.classList.toggle('active', button.dataset.mode === state.settings.budgetMode));
  $('manualBudgetWrap').classList.toggle('hidden', state.settings.budgetMode !== 'manual');
  $('manualBudgetInput').value = state.settings.manualBudget ? numberInput(state.settings.manualBudget) : '';
  updateMoneyPreview($('manualBudgetInput'), $('manualBudgetPreview'));
  $('manualBudgetWarning').classList.toggle('hidden', !calculation.manualBudgetClamped);
  $('manualBudgetWarning').textContent = calculation.manualBudgetClamped ? `Dein Limit von ${money(calculation.requestedManualBudget)} liegt über dem verfügbaren Maximum. Verwendet werden ${money(calculation.cycleAutoBudget)}.` : '';
}

function recurringSub(item) {
  const next = Core.occurrenceDates(item, Core.atNoon(new Date()), Core.addDays(new Date(), 800))[0];
  const account = accountById(item.accountId)?.name || 'ohne Konto';
  return `${item.active === false ? 'Pausiert · ' : ''}${FREQUENCY_LABELS[item.frequency] || 'Monatlich'} · Ø ${money(Core.monthlyEquivalent(item))}/Monat · ${next ? `nächster Termin ${fmtDate(next)}` : 'kein kommender Termin'} · ${account}`;
}

function renderSimpleList(elementId, items, kind, subFunction) {
  const element = $(elementId);
  if (!items.length) { element.innerHTML = '<div class="empty-state" style="display:block">Noch nichts eingetragen.</div>'; return; }
  element.innerHTML = items.map(item => `<div class="edit-row ${item.active === false ? 'paused' : ''}"><div class="meta"><div class="name">${esc(item.name || 'Ohne Namen')}</div><div class="sub">${esc(subFunction ? subFunction(item) : '')}</div></div><div class="amount">${money(item.amount ?? item.value ?? item.balance)}</div><div class="mini-actions"><button class="mini-btn" type="button" data-edit-kind="${esc(kind)}" data-id="${esc(item.id)}" aria-label="${esc(item.name)} bearbeiten">✎</button><button class="mini-btn danger" type="button" data-delete-kind="${esc(kind)}" data-id="${esc(item.id)}" aria-label="${esc(item.name)} löschen">×</button></div></div>`).join('');
}

function renderTransactions() {
  if (!$('monthFilter').value) $('monthFilter').value = Core.monthKey();
  const typeFilter = $('transactionTypeFilter');
  const selectedType = typeFilter.value;
  typeFilter.innerHTML = '<option value="">Alle Typen</option>' + Object.entries(TRANSACTION_LABELS).filter(([type]) => type !== 'correction').map(([type, label]) => `<option value="${type}">${label}</option>`).join('');
  typeFilter.value = selectedType;
  fillAccountSelect($('accountFilter'), $('accountFilter').value, 'Alle Konten');
  const categoryFilter = $('categoryFilter');
  const selectedCategory = categoryFilter.value;
  categoryFilter.innerHTML = '<option value="">Alle Kategorien</option>' + allCategories().map(category => `<option value="${esc(category)}">${esc(category)}</option>`).join('');
  if ([...categoryFilter.options].some(option => option.value === selectedCategory)) categoryFilter.value = selectedCategory;
  const query = $('searchFilter').value.trim().toLocaleLowerCase('de');
  const month = $('monthFilter').value;
  const accountId = $('accountFilter').value;
  const filtered = state.transactions.filter(transaction => {
    const accountMatch = !accountId || [transaction.accountId, transaction.fromAccountId, transaction.toAccountId].includes(accountId);
    return (!month || String(transaction.date).slice(0, 7) === month)
      && (!typeFilter.value || transaction.type === typeFilter.value)
      && accountMatch
      && (!categoryFilter.value || transaction.category === categoryFilter.value)
      && (!query || [transaction.note, transaction.merchant, transaction.category, transaction.subcategory, accountById(transaction.accountId)?.name, accountById(transaction.fromAccountId)?.name, accountById(transaction.toAccountId)?.name].join(' ').toLocaleLowerCase('de').includes(query));
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  $('filteredTransactionSum').textContent = money(filtered.reduce((total, transaction) => total + Core.transactionConsumption(transaction), 0));
  $('transactionList').innerHTML = filtered.map(transaction => transactionHTML(transaction)).join('');
  $('transactionEmpty').style.display = filtered.length ? 'none' : 'block';
}

function transactionHTML(transaction) {
  const date = Core.parseLocalDate(transaction.date) || new Date();
  const type = transaction.type || 'expense';
  const incoming = ['income', 'refund'].includes(type);
  const neutral = ['transfer', 'investment', 'correction'].includes(type);
  const sign = incoming ? '+' : neutral ? '' : '−';
  const accountText = type === 'transfer' ? `${accountById(transaction.fromAccountId)?.name || 'Ohne Quelle'} → ${accountById(transaction.toAccountId)?.name || 'Ohne Ziel'}` : accountById(transaction.accountId)?.name || '';
  const categorized = ['expense', 'refund'].includes(type);
  const investmentName = type === 'investment' ? assetById(transaction.assetId)?.name : '';
  const title = transaction.merchant || transaction.note || investmentName || (categorized ? transaction.subcategory || transaction.category : '') || TRANSACTION_LABELS[type];
  const meta = [categorized ? transaction.category : '', categorized ? transaction.subcategory : '', investmentName && title !== investmentName ? investmentName : '', accountText].filter(Boolean).join(' · ');
  return `<div class="transaction-item"><div class="transaction-date"><strong>${date.getDate()}</strong><small>${date.toLocaleDateString('de-DE', { month: 'short' })}</small></div><div class="transaction-info"><strong>${esc(title)}</strong><small>${esc(meta)}</small><span class="transaction-type ${esc(type)}">${esc(TRANSACTION_LABELS[type] || type)}</span></div><div class="transaction-amount ${incoming ? 'incoming' : neutral ? 'neutral' : ''}">${sign}${money(transaction.amount)}<div class="transaction-actions"><button class="text-btn" type="button" data-edit-kind="transaction" data-id="${esc(transaction.id)}">Bearbeiten</button><button class="text-btn negative" type="button" data-delete-kind="transaction" data-id="${esc(transaction.id)}">Löschen</button></div></div></div>`;
}

function openOccurrences(start, end) {
  return Core.allOccurrences(state, start, end).filter(occurrence => {
    const payment = Core.recurringPaymentFor(state, occurrence);
    return !payment || !['paid', 'skipped'].includes(payment.status);
  });
}

function renderDue() {
  const calculation = Core.calculateBudget(state);
  const today = Core.atNoon(new Date());
  const next30 = Core.addDays(today, 29);
  const next60 = Core.addDays(today, 60);
  const occurrences30 = openOccurrences(today, next30);
  $('dueTotalUntilSalary').textContent = money(calculation.futureDue);
  const days = Math.max(0, Core.daysBetween(today, calculation.cycle.next));
  $('dueSalarySub').textContent = `${calculation.futureOccurrences.length} Position(en) · noch ${days} Tag${days === 1 ? '' : 'e'}`;
  $('due30Total').textContent = money(sum(occurrences30));
  $('due30Count').textContent = `${occurrences30.length} Abbuchung${occurrences30.length === 1 ? '' : 'en'}`;
  $('safeAfterDue').textContent = money(calculation.safeUntilSalary);
  $('safeAfterDue').className = calculation.safeUntilSalary < 0 ? 'negative' : '';
  $('undatedCount').textContent = String(calculation.undatedItems.length);
  renderCalendar();
  const upcoming = openOccurrences(today, next60);
  const groups = groupUpcoming(upcoming, today);
  $('dueGroupedList').innerHTML = Object.entries(groups).filter(([, items]) => items.length).map(([label, items]) => `<section class="due-group"><h3>${esc(label)}</h3><div class="due-list">${items.map(occurrence => dueRowHTML(occurrence, 'due', true)).join('')}</div></section>`).join('');
  $('dueEmpty').style.display = upcoming.length ? 'none' : 'block';
}

function groupUpcoming(occurrences, today) {
  const groups = { Heute: [], Morgen: [], 'Diese Woche': [], Später: [] };
  for (const occurrence of occurrences) {
    const difference = Core.daysBetween(today, occurrence.date);
    if (difference === 0) groups.Heute.push(occurrence);
    else if (difference === 1) groups.Morgen.push(occurrence);
    else if (difference <= 7) groups['Diese Woche'].push(occurrence);
    else groups.Später.push(occurrence);
  }
  return groups;
}

function renderCalendar() {
  const monthStart = Core.startOfMonth(calendarCursor);
  const monthEnd = Core.endOfMonth(calendarCursor);
  $('calendarTitle').textContent = monthStart.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  const firstWeekday = (monthStart.getDay() + 6) % 7;
  const gridStart = Core.addDays(monthStart, -firstWeekday);
  const gridEnd = Core.addDays(gridStart, 41);
  const occurrences = Core.allOccurrences(state, gridStart, gridEnd);
  const byDate = occurrences.reduce((map, occurrence) => {
    const key = Core.localISO(occurrence.date);
    (map[key] ||= []).push(occurrence);
    return map;
  }, {});
  const today = Core.localISO();
  $('calendarGrid').innerHTML = Array.from({ length: 42 }, (_, index) => {
    const date = Core.addDays(gridStart, index);
    const key = Core.localISO(date);
    const items = byDate[key] || [];
    const openItems = items.filter(item => !['paid', 'skipped'].includes(Core.recurringPaymentFor(state, item)?.status));
    const classes = ['calendar-cell', date.getMonth() !== monthStart.getMonth() ? 'outside' : '', key === today ? 'today' : '', items.length ? 'has-due' : '', key === selectedCalendarDate ? 'selected' : ''].filter(Boolean).join(' ');
    return `<button type="button" class="${classes}" data-cal-date="${key}" aria-label="${fmtDate(date)}${items.length ? `, ${items.length} Zahlung(en)` : ''}"><span class="day">${date.getDate()}</span><div>${items.length ? `<div class="sum">${money(sum(openItems))}</div><div class="dot-row">${items.slice(0, 4).map(item => `<span class="dot ${Core.recurringPaymentFor(state, item) ? 'settled' : ''}"></span>`).join('')}</div>` : ''}</div></button>`;
  }).join('');
  if (selectedCalendarDate) renderSelectedDay(selectedCalendarDate);
  else $('selectedDayPanel').classList.add('hidden');
  const monthOccurrences = Core.allOccurrences(state, monthStart, monthEnd);
  if (!selectedCalendarDate && monthOccurrences.length === 0) $('selectedDayPanel').classList.add('hidden');
}

function renderSelectedDay(dateString) {
  const date = Core.parseLocalDate(dateString);
  if (!date) return;
  const items = Core.allOccurrences(state, date, date);
  $('selectedDayTitle').textContent = fmtDate(date, { weekday: 'long', day: '2-digit', month: 'long' });
  $('selectedDayList').innerHTML = items.length ? items.map(item => dueRowHTML(item, 'due', true, true)).join('') : '<div class="empty-state" style="display:block">Keine Zahlungen an diesem Tag.</div>';
  $('selectedDayPanel').classList.remove('hidden');
}

function dueRowHTML(occurrence, kind = 'due', withActions = false, showSettled = false) {
  const payment = Core.recurringPaymentFor(state, occurrence);
  const settled = payment && ['paid', 'skipped'].includes(payment.status);
  const type = ({ fixed: 'Fixkosten', saving: 'Sparen', debt: 'Rate' })[occurrence.kind] || occurrence.kind;
  const account = accountById(occurrence.accountId)?.name;
  const displayAmount = settled ? Number(payment.amount) || 0 : occurrence.amount;
  const actions = withActions ? (settled && showSettled
    ? `<div class="due-actions"><button type="button" data-occ-action="undo" data-item-id="${esc(occurrence.itemId)}" data-date="${Core.localISO(occurrence.date)}" data-kind="${esc(occurrence.kind)}">Rückgängig</button></div>`
    : !settled ? `<div class="due-actions"><button type="button" data-occ-action="paid" data-item-id="${esc(occurrence.itemId)}" data-date="${Core.localISO(occurrence.date)}" data-kind="${esc(occurrence.kind)}">Bezahlt</button><button class="skip" type="button" data-occ-action="skipped" data-item-id="${esc(occurrence.itemId)}" data-date="${Core.localISO(occurrence.date)}" data-kind="${esc(occurrence.kind)}">Überspringen</button></div>` : '') : '';
  return `<div class="${kind}-item"><div class="date-badge"><strong>${occurrence.date.getDate()}</strong><small>${occurrence.date.toLocaleDateString('de-DE', { month: 'short' })}</small></div><div class="${kind}-info"><strong>${esc(occurrence.name)}</strong><small>${esc([type, FREQUENCY_LABELS[occurrence.frequency], account].filter(Boolean).join(' · '))}</small>${settled ? `<span class="status-pill">${payment.status === 'paid' ? 'Bezahlt' : 'Übersprungen'}</span>` : ''}</div><div class="due-amount-wrap"><strong>−${money(displayAmount)}</strong>${actions}</div></div>`;
}

function renderWealth() {
  const calculation = Core.calculateBudget(state);
  $('wealthNetWorth').textContent = money(calculation.netWorth);
  $('wealthNetWorth').className = calculation.netWorth < 0 ? 'negative' : '';
  $('wealthBreakdown').textContent = calculation.liabilities ? `${money(calculation.assets)} Vermögen − ${money(calculation.liabilities)} Verbindlichkeiten` : `${money(calculation.assets)} Vermögen`;
  renderAccountList();
  renderInvestmentSummary(calculation);
  renderInvestmentList();
  renderSimpleList('assetList', state.assets.filter(asset => !isInvestment(asset)), 'asset', item => `${item.type || 'Vermögen'}${item.active === false ? ' · Inaktiv' : ''}`);
  renderSimpleList('liabilityList', state.liabilities, 'liability', item => `${item.type || 'Verbindlichkeit'}${item.active === false ? ' · Inaktiv' : ''}`);
  drawAllocation();
  drawNetWorthHistory();
  $('marketProvider').value = state.settings.marketData?.provider || 'manual';
  $('marketApiKey').value = state.settings.marketData?.apiKey || '';
  $('marketDataStatus').textContent = state.settings.marketData?.lastRefreshAt ? `Letzte Kursaktualisierung: ${formatDateTime(state.settings.marketData.lastRefreshAt)}` : 'Noch keine Kurse automatisch geladen.';
}

function renderAccountList() {
  if (!state.accounts.length) $('accountList').innerHTML = '<div class="empty-state" style="display:block">Noch kein Konto angelegt.</div>';
  else $('accountList').innerHTML = state.accounts.map(account => `<div class="edit-row ${account.active === false ? 'paused' : ''}"><div class="meta"><div class="name">${esc(account.name)}</div><div class="sub">${esc([account.type, account.bank, account.includeInAvailable === false ? 'Rücklage / nicht frei' : 'frei verfügbar', account.lastReconciledAt ? `Abgleich ${formatDateTime(account.lastReconciledAt)}` : 'noch nicht abgeglichen'].filter(Boolean).join(' · '))}</div></div><div class="amount">${money(account.balance)}</div><div class="mini-actions"><button class="mini-btn reconcile" type="button" data-reconcile-id="${esc(account.id)}">Abgleich</button><button class="mini-btn" type="button" data-edit-kind="account" data-id="${esc(account.id)}" aria-label="${esc(account.name)} bearbeiten">✎</button><button class="mini-btn danger" type="button" data-delete-kind="account" data-id="${esc(account.id)}" aria-label="${esc(account.name)} löschen">×</button></div></div>`).join('');
  $('accountTotal').textContent = money(sum(state.accounts.filter(account => account.active !== false), 'balance'));
}

function renderInvestmentSummary(calculation) {
  $('portfolioValue').textContent = money(calculation.investments);
  $('portfolioCost').textContent = calculation.investmentCostKnown ? money(calculation.investmentCost) : '—';
  $('portfolioGain').textContent = calculation.investmentGain === null ? '—' : `${calculation.investmentGain >= 0 ? '+' : ''}${money(calculation.investmentGain)}`;
  $('portfolioGain').className = calculation.investmentGain === null ? '' : calculation.investmentGain >= 0 ? 'positive' : 'negative';
  const period = Core.calculatePortfolioPeriod(state, investmentRange);
  $('portfolioPeriodGain').textContent = period.available ? `${period.gain >= 0 ? '+' : ''}${money(period.gain)}` : '—';
  $('portfolioPeriodGain').className = !period.available ? '' : period.gain >= 0 ? 'positive' : 'negative';
  $('portfolioPerformanceBadge').textContent = period.available && period.percent !== null ? `${period.percent >= 0 ? '+' : ''}${percent(period.percent)}` : '—';
  $('portfolioPerformanceBadge').className = `badge ${period.available && period.gain < 0 ? 'negative' : period.available ? 'positive' : ''}`;
  document.querySelectorAll('#investmentRange button').forEach(button => button.classList.toggle('active', button.dataset.range === investmentRange));
  drawInvestmentHistory(period);
}

function renderInvestmentList() {
  const investments = state.assets.filter(isInvestment);
  if (!investments.length) { $('investmentList').innerHTML = '<div class="empty-state" style="display:block">Noch kein Investment angelegt.</div>'; return; }
  $('investmentList').innerHTML = investments.map(asset => {
    const gain = asset.costBasisKnown ? Number(asset.value) - Number(asset.costBasis) : null;
    const performance = gain === null ? 'Einstand fehlt' : `${gain >= 0 ? '+' : ''}${money(gain)}${asset.costBasis > 0 ? ` (${gain >= 0 ? '+' : ''}${percent(gain / asset.costBasis * 100)})` : ''}`;
    const quote = asset.lastPrice ? ` · Kurs ${money(asset.lastPrice)}${asset.lastPriceAt ? ` · ${formatDateTime(asset.lastPriceAt)}` : ''}` : '';
    return `<div class="edit-row ${asset.active === false ? 'paused' : ''}"><div class="meta"><div class="name">${esc(asset.name)}</div><div class="sub">${esc([asset.type, asset.ticker, asset.units ? `${asset.units} Anteile` : '', performance].filter(Boolean).join(' · '))}${esc(quote)}</div></div><div class="amount">${money(asset.value)}</div><div class="mini-actions"><button class="mini-btn reconcile" type="button" data-invest-flow-id="${esc(asset.id)}">Cashflow</button><button class="mini-btn" type="button" data-refresh-asset="${esc(asset.id)}" aria-label="Kurs aktualisieren">↻</button><button class="mini-btn" type="button" data-edit-kind="investment" data-id="${esc(asset.id)}" aria-label="${esc(asset.name)} bearbeiten">✎</button><button class="mini-btn danger" type="button" data-delete-kind="investment" data-id="${esc(asset.id)}" aria-label="${esc(asset.name)} löschen">×</button></div></div>`;
  }).join('');
}

function drawLineChart(canvas, points, valueFunction, labelFunction, noteElement, emptyText, secondFunction = null) {
  if (!canvas) return;
  const context = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 320;
  const height = 170;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!points.length) {
    context.strokeStyle = '#252525'; context.beginPath(); context.moveTo(12, height / 2); context.lineTo(width - 12, height / 2); context.stroke();
    if (noteElement) noteElement.textContent = emptyText;
    return;
  }
  const values = points.flatMap(point => secondFunction ? [valueFunction(point), secondFunction(point)] : [valueFunction(point)]).map(Number).filter(Number.isFinite);
  let minimum = Math.min(...values), maximum = Math.max(...values);
  if (minimum === maximum) { minimum -= 1; maximum += 1; }
  const padding = Math.max((maximum - minimum) * 0.08, 1);
  minimum -= padding; maximum += padding;
  const left = 12, right = width - 12, top = 15, bottom = height - 28;
  const dates = points.map(point => Core.parseLocalDate(point.date)?.getTime() || 0);
  const firstTime = Math.min(...dates), lastTime = Math.max(...dates), timeRange = Math.max(lastTime - firstTime, 1);
  const x = (point, index) => points.length === 1 ? (left + right) / 2 : left + ((dates[index] - firstTime) / timeRange) * (right - left);
  const y = value => bottom - (Number(value) - minimum) / (maximum - minimum) * (bottom - top);
  context.strokeStyle = '#292929'; context.lineWidth = 1;
  [0, .5, 1].forEach(factor => { const lineY = top + (bottom - top) * factor; context.beginPath(); context.moveTo(left, lineY); context.lineTo(right, lineY); context.stroke(); });
  if (minimum < 0 && maximum > 0) { context.strokeStyle = '#4a3434'; context.beginPath(); context.moveTo(left, y(0)); context.lineTo(right, y(0)); context.stroke(); }
  const draw = (fn, color, lineWidth) => { context.strokeStyle = color; context.lineWidth = lineWidth; context.lineJoin = 'round'; context.lineCap = 'round'; context.beginPath(); points.forEach((point, index) => { const pointX = x(point, index), pointY = y(fn(point)); index ? context.lineTo(pointX, pointY) : context.moveTo(pointX, pointY); }); context.stroke(); };
  if (secondFunction) draw(secondFunction, '#6d6d73', 1.8);
  draw(valueFunction, '#f4f4f4', 2.5);
  context.fillStyle = '#8e8e93'; context.font = '10px -apple-system,system-ui'; context.textAlign = 'left'; context.fillText(labelFunction(points[0]), left, height - 8); context.textAlign = 'right'; context.fillText(labelFunction(points[points.length - 1]), right, height - 8);
  if (noteElement) noteElement.textContent = points.length < 2 ? 'Erster Tagesstand gespeichert.' : `${points.length} lokale Tagesstände · helle Linie Wert, graue Linie Einstand`;
}

function drawInvestmentHistory(period) {
  const points = period.points || [];
  drawLineChart($('investmentChart'), points, point => Number(point.value) || 0, point => fmtDate(Core.parseLocalDate(point.date), { day: '2-digit', month: 'short' }), $('investmentChartNote'), 'Noch keine Investment-Historie.', point => Number(point.cost) || 0);
  if (period.available) $('investmentChartNote').textContent += ` · Netto-Cashflow ${money(period.netExternalFlow)}`;
}

function drawNetWorthHistory() {
  const points = [...(state.history?.netWorth || [])].filter(point => Core.parseLocalDate(point.date)).sort((a, b) => a.date.localeCompare(b.date)).slice(-730);
  drawLineChart($('netWorthChart'), points, point => Number(point.value) || 0, point => fmtDate(Core.parseLocalDate(point.date), { day: '2-digit', month: 'short' }), $('netWorthChartNote'), 'Noch keine Vermögenshistorie.');
}

function drawAllocation() {
  const canvas = $('allocationChart');
  if (!canvas) return;
  const context = canvas.getContext('2d'), ratio = window.devicePixelRatio || 1, width = canvas.clientWidth || 320, height = 170;
  canvas.width = width * ratio; canvas.height = height * ratio; context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
  const groups = [
    ['Konten', sum(state.accounts.filter(account => account.active !== false), 'balance'), '#67f29a'],
    ['Investments', sum(state.assets.filter(asset => asset.active !== false && isInvestment(asset)), 'value'), '#f4f4f4'],
    ['Sonstiges', sum(state.assets.filter(asset => asset.active !== false && !isInvestment(asset)), 'value'), '#8e8e93']
  ].filter(group => group[1] > 0);
  const total = groups.reduce((value, group) => value + group[1], 0);
  $('allocationLegend').innerHTML = groups.map(([name, value, color]) => `<div class="legend-item"><span class="legend-dot" style="--legend-color:${color}"></span><span>${esc(name)} · ${money(value)}</span></div>`).join('');
  $('allocationEmpty').style.display = total ? 'none' : 'block';
  const centerX = width / 2, centerY = height / 2, radius = Math.min(60, width * .2), lineWidth = 18;
  if (!total) { context.strokeStyle = '#252525'; context.lineWidth = lineWidth; context.beginPath(); context.arc(centerX, centerY, radius, 0, Math.PI * 2); context.stroke(); return; }
  let start = -Math.PI / 2;
  groups.forEach(([, value, color]) => { const angle = Math.PI * 2 * value / total; context.strokeStyle = color; context.lineWidth = lineWidth; context.beginPath(); context.arc(centerX, centerY, radius, start, start + angle); context.stroke(); start += angle; });
  context.fillStyle = '#f4f4f4'; context.font = '700 17px -apple-system'; context.textAlign = 'center'; context.fillText(money(total), centerX, centerY + 5);
}

function drawSpendingTrend(analysis) {
  const monthly = analysisRange !== '30d';
  const buckets = new Map();
  if (monthly) {
    let cursor = Core.startOfMonth(analysis.start);
    while (cursor <= analysis.end) { buckets.set(Core.monthKey(cursor), { date: Core.localISO(cursor), label: cursor.toLocaleDateString('de-DE', { month: 'short' }), value: 0 }); cursor = Core.startOfMonth(Core.addMonthsAnchored(cursor, 1)); }
  } else {
    let cursor = Core.addDays(analysis.start, -((analysis.start.getDay() + 6) % 7));
    while (cursor <= analysis.end) { buckets.set(Core.localISO(cursor), { date: Core.localISO(cursor), label: fmtDate(cursor, { day: '2-digit', month: '2-digit' }), value: 0 }); cursor = Core.addDays(cursor, 7); }
  }
  analysis.transactions.forEach(transaction => {
    const date = Core.parseLocalDate(transaction.date); if (!date) return;
    const key = monthly ? Core.monthKey(date) : Core.localISO(Core.addDays(date, -((date.getDay() + 6) % 7)));
    if (buckets.has(key)) buckets.get(key).value += Core.transactionConsumption(transaction);
  });
  drawLineChart($('trendChart'), [...buckets.values()], point => Math.max(0, point.value), point => point.label, null, '');
}

function moneyField(label, value, key = 'amount', required = true, signed = false) {
  return `<label class="field"><span>${esc(label)}</span><input name="${esc(key)}" data-money="1" ${signed ? 'data-money-signed="1"' : ''} type="text" inputmode="decimal" autocomplete="off" value="${esc(numberInput(value))}" placeholder="0,00" ${required ? 'required' : ''}><small class="money-live" data-money-preview-for="${esc(key)}"></small></label>`;
}

function textField(label, name, value = '', options = '') { return `<label class="field"><span>${esc(label)}</span><input name="${esc(name)}" value="${esc(value)}" ${options}></label>`; }
function selectField(label, name, options, selected = '', attributes = '') { return `<label class="field"><span>${esc(label)}</span><select name="${esc(name)}" ${attributes}>${options.map(([value, text]) => `<option value="${esc(value)}" ${String(value) === String(selected) ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`; }
function checkboxField(label, name, checked = true) { return `<label class="checkbox-field"><input type="checkbox" name="${esc(name)}" ${checked ? 'checked' : ''}><span>${esc(label)}</span></label>`; }
function accountOptions(selected = '', empty = 'Nicht zugeordnet') { return [["", empty], ...state.accounts.filter(account => account.active !== false || account.id === selected).map(account => [account.id, `${account.name} · ${money(account.balance)}`])]; }
function assetOptions(selected = '') { return [["", 'Nicht zugeordnet'], ...state.assets.filter(asset => isInvestment(asset) && (asset.active !== false || asset.id === selected)).map(asset => [asset.id, asset.name])]; }
function liabilityOptions(selected = '') { return [["", 'Nicht zugeordnet'], ...state.liabilities.filter(item => item.active !== false || item.id === selected).map(item => [item.id, item.name])]; }

function recurringFields(item = {}, kind) {
  const frequency = item.frequency || 'monthly';
  const source = selectField('Zahlungskonto', 'accountId', accountOptions(item.accountId), item.accountId);
  const dates = `<div class="field-row"><label class="field"><span>Referenz-/erste Fälligkeit</span><input name="dueDate" type="date" value="${esc(item.dueDate || '')}" required></label><label class="field"><span>Beginn (optional)</span><input name="startDate" type="date" value="${esc(item.startDate || '')}"></label></div><label class="field"><span>Ende (optional)</span><input name="endDate" type="date" value="${esc(item.endDate || '')}"></label>`;
  let extra = '';
  if (kind === 'fixed') extra = selectField('Kategorie', 'category', allCategories().map(category => [category, category]), item.category || 'Wohnen');
  if (kind === 'saving') extra = `${selectField('Sparart', 'type', [['ETF', 'ETF / Investment'], ['Tagesgeld', 'Tagesgeld'], ['Rücklage', 'Rücklage'], ['Sonstiges', 'Sonstiges']], item.type || 'Rücklage')}<div id="savingAccountTarget">${selectField('Zielkonto', 'targetAccountId', accountOptions(item.targetAccountId, 'Kein Zielkonto'), item.targetAccountId)}</div><div id="savingAssetTarget">${selectField('Ziel-Investment', 'targetAssetId', assetOptions(item.targetAssetId), item.targetAssetId)}</div>`;
  if (kind === 'debtPayment') extra = selectField('Verbindlichkeit', 'liabilityId', liabilityOptions(item.liabilityId), item.liabilityId);
  return `${moneyField('Betrag pro Ausführung', item.amount)}<div class="field-row">${selectField('Rhythmus', 'frequency', Object.entries(FREQUENCY_LABELS), frequency)}${source}</div>${dates}${extra}${textField('Notiz (optional)', 'note', item.note || '')}${checkboxField('Aktiv', 'active', item.active !== false)}<div class="frequency-hint" data-frequency-hint></div>`;
}

function fieldsFor(kind, item = {}) {
  const today = Core.localISO();
  if (kind === 'transaction') {
    const categories = allCategories();
    const category = item.category || categories[0] || 'Sonstiges';
    const subcategories = CATEGORY_TREE[category] || [];
    return `<div class="field-row"><label class="field"><span>Datum</span><input name="date" type="date" value="${esc(item.date || today)}" required></label>${selectField('Typ', 'type', Object.entries(TRANSACTION_LABELS).filter(([type]) => type !== 'correction').map(([type, label]) => [type, label]), item.type || 'expense', 'id="transactionType"')}</div>${moneyField('Betrag', item.amount)}<div id="simpleAccountGroup">${selectField('Konto', 'accountId', accountOptions(item.accountId), item.accountId)}</div><div id="transferAccountGroup" class="conditional-group"><div class="field-row">${selectField('Von Konto', 'fromAccountId', accountOptions(item.fromAccountId), item.fromAccountId)}${selectField('Auf Konto', 'toAccountId', accountOptions(item.toAccountId), item.toAccountId)}</div></div><div id="investmentAccountGroup" class="conditional-group"><div class="field-row">${selectField('Zahlungskonto', 'investmentAccountId', accountOptions(item.accountId), item.accountId)}${selectField('Investment', 'assetId', assetOptions(item.assetId), item.assetId)}</div></div><div id="transactionCategoryGroup"><div class="subcat-row">${selectField('Kategorie', 'category', [...categories.map(value => [value, value]), ['__custom', '+ Eigene Kategorie']], category, 'id="txCategory"')}${selectField('Unterkategorie', 'subcategory', [...subcategories.map(value => [value, value]), ['', 'Keine']], item.subcategory || '', 'id="txSubcategory"')}</div><div id="customCategoryWrap" class="field hidden"><span>Eigene Kategorie</span><input name="customCategory" placeholder="z. B. Hund"></div></div>${textField('Händler / Empfänger (optional)', 'merchant', item.merchant || '', 'placeholder="z. B. Sklavenitis"')}${textField('Notiz (optional)', 'note', item.note || '')}`;
  }
  if (kind === 'account') return `${textField('Kontoname', 'name', item.name || '', 'required')}${textField('Bank (optional)', 'bank', item.bank || '')}${selectField('Kontotyp', 'type', [['Girokonto', 'Girokonto'], ['Bargeld', 'Bargeld'], ['Tagesgeld', 'Tagesgeld'], ['Kreditkarte', 'Kreditkarte'], ['Sonstiges', 'Sonstiges']], item.type || 'Girokonto')}${moneyField('Aktueller Kontostand', item.balance, 'balance', true, true)}${checkboxField('Im frei verfügbaren Geld berücksichtigen', 'includeInAvailable', item.includeInAvailable !== false)}${checkboxField('Konto aktiv', 'active', item.active !== false)}`;
  if (kind === 'income') return `${textField('Einnahmequelle', 'name', item.name || '', 'required')}${moneyField('Betrag je Gehaltszyklus', item.amount)}${selectField('Zielkonto (optional)', 'accountId', accountOptions(item.accountId), item.accountId)}${checkboxField('Aktiv', 'active', item.active !== false)}`;
  if (kind === 'fixed') return `${textField('Fixkosten', 'name', item.name || '', 'required')}${recurringFields(item, 'fixed')}`;
  if (kind === 'saving') return `${textField('Sparplan / Rücklage', 'name', item.name || '', 'required')}${recurringFields(item, 'saving')}`;
  if (kind === 'debtPayment') return `${textField('Verpflichtung / Rate', 'name', item.name || '', 'required')}${recurringFields(item, 'debtPayment')}`;
  if (kind === 'investment') return `${textField('Investment', 'name', item.name || '', 'required')}<div class="field-row">${selectField('Typ', 'type', [['ETF', 'ETF'], ['Aktie', 'Aktie'], ['Krypto', 'Krypto'], ['Investment', 'Investment']], item.type || 'ETF')}${textField('Ticker / Symbol', 'ticker', item.ticker || '', 'placeholder="z. B. VWCE:XETR"')}</div><div class="field-row">${textField('ISIN (optional)', 'isin', item.isin || '')}${textField('Währung', 'currency', item.currency || state.settings.currency, 'maxlength="3"')}</div><div class="field-row">${moneyField('Wert heute', item.value, 'value')}${moneyField('Einstand / investiert', item.costBasis, 'costBasis', false)}</div><div class="field-row">${textField('Anteile (optional)', 'units', item.units || '', 'inputmode="decimal"')}${textField('Notiz (optional)', 'note', item.note || '')}</div>${checkboxField('Einstand ist vollständig bekannt', 'costBasisKnown', item.costBasisKnown === true)}${checkboxField('Investment aktiv', 'active', item.active !== false)}`;
  if (kind === 'asset') return `${textField('Asset', 'name', item.name || '', 'required')}${moneyField('Aktueller Wert', item.value, 'value')}${selectField('Typ', 'type', [['Immobilie', 'Immobilie'], ['Fahrzeug', 'Fahrzeug'], ['Wertgegenstand', 'Wertgegenstand'], ['Sonstiges', 'Sonstiges']], item.type || 'Sonstiges')}${textField('Notiz (optional)', 'note', item.note || '')}${checkboxField('Asset aktiv', 'active', item.active !== false)}`;
  if (kind === 'liability') return `${textField('Verbindlichkeit', 'name', item.name || '', 'required')}${moneyField('Restschuld', item.balance, 'balance')}${selectField('Typ', 'type', [['Kredit', 'Kredit'], ['Kreditkarte', 'Kreditkarte'], ['Privat', 'Privat'], ['Rückstand', 'Rückstand'], ['Immobilie', 'Immobilie'], ['Sonstiges', 'Sonstiges']], item.type || 'Kredit')}${textField('Notiz (optional)', 'note', item.note || '')}${checkboxField('Aktiv', 'active', item.active !== false)}`;
  if (kind === 'investmentFlow') return `<input type="hidden" name="assetId" value="${esc(item.assetId || '')}"><label class="field"><span>Datum</span><input name="date" type="date" value="${today}" required></label>${selectField('Cashflow-Typ', 'type', [['contribution', 'Einzahlung'], ['buy', 'Kauf'], ['withdrawal', 'Entnahme'], ['sell', 'Verkauf'], ['dividend', 'Dividende'], ['fee', 'Gebühr']], 'contribution', 'id="investmentFlowType"')}${moneyField('Betrag', '')}<div class="field-row">${selectField('Gegenkonto', 'accountId', accountOptions('', 'Kein Gegenkonto'), '')}${textField('Anteile (optional)', 'units', '', 'inputmode="decimal"')}</div>${textField('Notiz (optional)', 'note', '')}`;
  return '';
}

function openEntry(kind, item = null) {
  editing = { kind, id: item?.id || null };
  const names = {
    transaction: ['BUCHUNG', 'Neue Buchung'], account: ['KONTO', 'Konto'], income: ['PLAN', 'Einnahme'], fixed: ['PLAN', 'Fixkosten'],
    saving: ['SPAREN', 'Sparplan / Rücklage'], debtPayment: ['PLAN', 'Rate / Verpflichtung'], investment: ['DEPOT', 'Investment'],
    investmentFlow: ['INVESTMENT', `Cashflow · ${assetById(item?.assetId)?.name || ''}`], asset: ['VERMÖGEN', 'Asset'], liability: ['OPTIONAL', 'Verbindlichkeit']
  };
  $('dialogKicker').textContent = names[kind][0];
  $('dialogTitle').textContent = `${editing.id ? 'Bearbeiten: ' : ''}${names[kind][1]}`;
  $('dialogFields').innerHTML = fieldsFor(kind, item || {});
  $('entryDialog').showModal();
  bindDynamicForm(kind, item || {});
}

function bindDynamicForm(kind, item = {}) {
  document.querySelectorAll('#entryForm [data-money]').forEach(input => {
    const preview = input.parentElement.querySelector('[data-money-preview-for]');
    input.addEventListener('input', () => updateMoneyPreview(input, preview));
    input.addEventListener('blur', () => { const value = input.dataset.moneySigned ? Core.parseSignedMoney(input.value) : Core.parseMoney(input.value); if (Number.isFinite(value)) input.value = numberInput(value); updateMoneyPreview(input, preview); });
    updateMoneyPreview(input, preview);
  });
  const frequency = document.querySelector('#entryForm select[name="frequency"]');
  if (frequency) {
    const hint = document.querySelector('[data-frequency-hint]');
    const amount = document.querySelector('#entryForm [name="amount"]');
    const sync = () => { const parsed = Core.parseMoney(amount.value); hint.textContent = Number.isFinite(parsed) ? `Planungswert: Ø ${money(Core.monthlyEquivalent({ amount: parsed, frequency: frequency.value }))}/Monat · ${money(Core.yearlyEquivalent({ amount: parsed, frequency: frequency.value }))}/Jahr` : ''; };
    frequency.addEventListener('change', sync); amount.addEventListener('input', sync); sync();
  }
  if (kind === 'transaction') bindTransactionForm();
  if (kind === 'account') {
    const type = document.querySelector('#entryForm [name="type"]');
    const include = document.querySelector('#entryForm [name="includeInAvailable"]');
    type.addEventListener('change', () => { include.checked = !['Tagesgeld', 'Kreditkarte'].includes(type.value); });
  }
  if (kind === 'saving') {
    const type = document.querySelector('[name="type"]');
    const sync = () => { $('savingAccountTarget').classList.toggle('hidden', !['Tagesgeld', 'Rücklage'].includes(type.value)); $('savingAssetTarget').classList.toggle('hidden', type.value !== 'ETF'); };
    type.addEventListener('change', sync); sync();
  }
}

function bindTransactionForm() {
  const type = $('transactionType');
  const category = $('txCategory');
  const subcategory = $('txSubcategory');
  const syncType = () => {
    const value = type.value;
    $('simpleAccountGroup').classList.toggle('hidden', ['transfer', 'investment'].includes(value));
    $('transferAccountGroup').classList.toggle('hidden', value !== 'transfer');
    $('investmentAccountGroup').classList.toggle('hidden', value !== 'investment');
    $('transactionCategoryGroup').classList.toggle('hidden', !['expense', 'refund'].includes(value));
  };
  const syncCategory = () => {
    const custom = category.value === '__custom';
    $('customCategoryWrap').classList.toggle('hidden', !custom);
    const current = subcategory.value;
    const values = CATEGORY_TREE[category.value] || [];
    subcategory.innerHTML = values.map(value => `<option value="${esc(value)}">${esc(value)}</option>`).join('') + '<option value="">Keine</option>';
    if (values.includes(current)) subcategory.value = current;
  };
  type.addEventListener('change', syncType); category.addEventListener('change', syncCategory); syncType(); syncCategory();
}

function updateMoneyPreview(input, element) {
  if (!input || !element) return;
  const parsed = input.dataset.moneySigned ? Core.parseSignedMoney(input.value) : Core.parseMoney(input.value);
  element.textContent = input.value.trim() ? Number.isFinite(parsed) ? `Speichert: ${money(parsed)}` : 'Ungültige Zahl' : '';
  element.className = `money-preview ${input.value.trim() && !Number.isFinite(parsed) ? 'negative' : ''}`;
}

function formObject(form) {
  const data = new FormData(form), object = {};
  for (const [key, value] of data.entries()) object[key] = typeof value === 'string' ? value.trim() : value;
  for (const input of form.querySelectorAll('[data-money]')) {
    const signed = Boolean(input.dataset.moneySigned);
    const value = signed ? Core.parseSignedMoney(input.value) : Core.parseMoney(input.value);
    if (!Number.isFinite(value) || (!signed && value < 0)) { input.focus(); throw new Error('INVALID_MONEY'); }
    object[input.name] = value;
  }
  return object;
}

function arrayFor(kind) {
  return ({ account: state.accounts, income: state.incomes, fixed: state.fixedCosts, saving: state.savings, debtPayment: state.debtPayments, transaction: state.transactions, investment: state.assets, asset: state.assets, liability: state.liabilities, investmentFlow: state.investmentFlows })[kind];
}

async function saveEntry() {
  const form = $('entryForm');
  let object;
  let customCategory = '';
  try { object = formObject(form); } catch (error) { if (error.message === 'INVALID_MONEY') alert('Bitte einen gültigen Betrag eingeben, z. B. 123,45 oder 1.234,56.'); else throw error; return false; }
  if (['account', 'income', 'fixed', 'saving', 'debtPayment', 'investment', 'asset', 'liability'].includes(editing.kind) && !String(object.name || '').trim()) { alert('Bitte einen Namen eingeben.'); return false; }
  object.active = form.elements.active ? form.elements.active.checked : true;
  if (form.elements.includeInAvailable) object.includeInAvailable = form.elements.includeInAvailable.checked;
  if (form.elements.costBasisKnown) object.costBasisKnown = form.elements.costBasisKnown.checked;

  if (editing.kind === 'transaction') {
    object.type ||= 'expense';
    if (object.category === '__custom') {
      const custom = String(object.customCategory || '').trim();
      if (!custom) { alert('Bitte die eigene Kategorie benennen.'); return false; }
      object.category = custom;
      customCategory = custom;
    }
    delete object.customCategory;
    if (!Core.parseLocalDate(object.date)) { alert('Bitte ein gültiges Buchungsdatum eingeben.'); return false; }
    if (!['expense', 'refund'].includes(object.type)) { object.category = ''; object.subcategory = ''; }
    if (object.type === 'transfer' && (!object.fromAccountId || !object.toAccountId || object.fromAccountId === object.toAccountId)) { alert('Bitte zwei unterschiedliche Konten für den Transfer auswählen.'); return false; }
    if (object.type === 'investment') { object.accountId = object.investmentAccountId; delete object.investmentAccountId; if (!object.assetId) { alert('Bitte ein Investment auswählen.'); return false; } }
  }
  if (['fixed', 'saving', 'debtPayment'].includes(editing.kind)) {
    if (!Core.parseLocalDate(object.dueDate)) { alert('Bitte eine gültige Fälligkeit eingeben.'); return false; }
    if (object.startDate && !Core.parseLocalDate(object.startDate)) { alert('Das Startdatum ist ungültig.'); return false; }
    if (object.endDate && !Core.parseLocalDate(object.endDate)) { alert('Das Enddatum ist ungültig.'); return false; }
    if (!editing.id && !object.startDate) object.startDate = object.dueDate;
    if (object.startDate && object.endDate && object.startDate > object.endDate) { alert('Das Enddatum muss nach dem Beginn liegen.'); return false; }
    if (editing.kind === 'saving') {
      if (object.type === 'ETF') object.targetAccountId = '';
      else if (['Tagesgeld', 'Rücklage'].includes(object.type)) object.targetAssetId = '';
      else { object.targetAccountId = ''; object.targetAssetId = ''; }
      if (object.accountId && object.targetAccountId && object.accountId === object.targetAccountId) { alert('Quell- und Zielkonto der Rücklage müssen unterschiedlich sein.'); return false; }
    }
  }
  if (editing.kind === 'investment') {
    object.units = object.units === '' ? 0 : Number(String(object.units).replace(',', '.'));
    if (!Number.isFinite(object.units) || object.units < 0) { alert('Bitte gültige Anteile eingeben.'); return false; }
    object.currency = String(object.currency || state.settings.currency).toUpperCase();
    object.isin = String(object.isin || '').toUpperCase();
    object.lastPrice = editing.id ? assetById(editing.id)?.lastPrice || null : null;
    object.lastPriceAt = editing.id ? assetById(editing.id)?.lastPriceAt || null : null;
  }
  if (editing.kind === 'investmentFlow') {
    if (!Core.parseLocalDate(object.date)) { alert('Bitte ein gültiges Cashflow-Datum eingeben.'); return false; }
    object.units = object.units === '' ? 0 : Number(String(object.units).replace(',', '.'));
    if (!Number.isFinite(object.units) || object.units < 0) { alert('Bitte gültige Anteile eingeben.'); return false; }
    if (!assetById(object.assetId)) { alert('Das Investment existiert nicht mehr.'); return false; }
  }

  const success = await commitMutation(() => {
    if (customCategory && !state.settings.customCategories.includes(customCategory)) state.settings.customCategories.push(customCategory);
    if (editing.kind === 'transaction') saveTransactionObject(object);
    else if (editing.kind === 'investmentFlow') saveInvestmentFlowObject(object);
    else {
      const array = arrayFor(editing.kind);
      if (editing.id) {
        const index = array.findIndex(item => item.id === editing.id);
        if (index >= 0) array[index] = { ...array[index], ...object };
      } else array.push({ id: id(editing.kind), ...object });
    }
  });
  return success;
}

function reverseTransaction(transaction) {
  if (!transaction?.balanceApplied) return;
  if (transaction.type === 'investment' && transaction.investmentFlowId) {
    const index = state.investmentFlows.findIndex(flow => flow.id === transaction.investmentFlowId);
    if (index >= 0) { Core.applyInvestmentFlowEffects(state, state.investmentFlows[index], -1); state.investmentFlows.splice(index, 1); }
  } else Core.applyTransactionEffects(state, transaction, -1);
}

function saveTransactionObject(object) {
  const existingIndex = editing.id ? state.transactions.findIndex(transaction => transaction.id === editing.id) : -1;
  const previous = existingIndex >= 0 ? state.transactions[existingIndex] : null;
  if (previous) reverseTransaction(previous);
  const transaction = { ...(previous || {}), ...object, id: previous?.id || id('transaction'), balanceApplied: false, investmentFlowId: '' };
  if (transaction.type === 'investment') {
    const flow = { id: id('investment-flow'), assetId: transaction.assetId, accountId: transaction.accountId, date: transaction.date, type: 'contribution', amount: transaction.amount, units: 0, price: 0, note: transaction.note || transaction.merchant || '', applied: true };
    Core.applyInvestmentFlowEffects(state, flow, 1);
    state.investmentFlows.push(flow);
    transaction.investmentFlowId = flow.id;
    transaction.balanceApplied = true;
  } else {
    const hasEffect = (['expense', 'income', 'refund'].includes(transaction.type) && transaction.accountId) || (transaction.type === 'transfer' && transaction.fromAccountId && transaction.toAccountId);
    if (hasEffect) { Core.applyTransactionEffects(state, transaction, 1); transaction.balanceApplied = true; }
  }
  if (existingIndex >= 0) state.transactions[existingIndex] = transaction; else state.transactions.push(transaction);
}

function saveInvestmentFlowObject(object) {
  const flow = { id: id('investment-flow'), assetId: object.assetId, accountId: object.accountId || '', date: object.date, type: object.type, amount: object.amount, units: object.units || 0, price: 0, note: object.note || '', applied: true };
  Core.applyInvestmentFlowEffects(state, flow, 1);
  state.investmentFlows.push(flow);
}

function itemForKind(kind, itemId) {
  if (kind === 'fixed') return state.fixedCosts.find(item => item.id === itemId);
  if (kind === 'saving') return state.savings.find(item => item.id === itemId);
  if (kind === 'debt') return state.debtPayments.find(item => item.id === itemId);
  return null;
}

function applyRecurringEffect(item, kind, amount, direction) {
  const source = accountById(item.accountId);
  if (source) source.balance = Core.roundMoney(source.balance - amount * direction);
  if (kind === 'saving') {
    const targetAccount = accountById(item.targetAccountId);
    if (targetAccount) targetAccount.balance = Core.roundMoney(targetAccount.balance + amount * direction);
    const targetAsset = assetById(item.targetAssetId);
    if (targetAsset) { targetAsset.value = Core.roundMoney(targetAsset.value + amount * direction); targetAsset.costBasis = Math.max(0, Core.roundMoney(targetAsset.costBasis + amount * direction)); targetAsset.costBasisKnown = true; }
  }
  if (kind === 'debt') {
    const liability = liabilityById(item.liabilityId);
    if (liability) liability.balance = Math.max(0, Core.roundMoney(liability.balance - amount * direction));
  }
}

async function handleOccurrenceAction(button) {
  const { occAction: action, itemId, date, kind } = button.dataset;
  const item = itemForKind(kind, itemId);
  if (!item) return;
  if (action === 'paid' && kind === 'saving') {
    if (!item.accountId) { alert('Bitte dem Sparplan zuerst ein Zahlungskonto zuordnen.'); return; }
    if (['Tagesgeld', 'Rücklage'].includes(item.type) && (!item.targetAccountId || item.targetAccountId === item.accountId)) { alert('Bitte der Rücklage zuerst ein anderes Zielkonto zuordnen.'); return; }
    if (item.type === 'ETF' && !item.targetAssetId) { alert('Bitte dem ETF-Sparplan zuerst ein Investment zuordnen.'); return; }
  }
  const existingIndex = state.recurringPayments.findIndex(payment => payment.itemId === itemId && payment.date === date);
  await commitMutation(() => {
    if (action === 'undo') {
      if (existingIndex < 0) return;
      const payment = state.recurringPayments[existingIndex];
      if (payment.investmentFlowId) {
        const flowIndex = state.investmentFlows.findIndex(flow => flow.id === payment.investmentFlowId);
        if (flowIndex >= 0) { Core.applyInvestmentFlowEffects(state, state.investmentFlows[flowIndex], -1); state.investmentFlows.splice(flowIndex, 1); }
      } else if (payment.accountEffectApplied) applyRecurringEffect(item, kind, payment.amount, -1);
      state.recurringPayments.splice(existingIndex, 1);
      return;
    }
    if (existingIndex >= 0) return;
    const paid = action === 'paid';
    const paymentId = id('recurring-payment');
    let investmentFlowId = '';
    if (paid && kind === 'saving' && item.targetAssetId) {
      const flow = { id: id('investment-flow'), assetId: item.targetAssetId, accountId: item.accountId, date, type: 'contribution', amount: Number(item.amount) || 0, units: 0, price: 0, note: `Sparplan: ${item.name}`, recurringPaymentId: paymentId, applied: true };
      Core.applyInvestmentFlowEffects(state, flow, 1);
      state.investmentFlows.push(flow);
      investmentFlowId = flow.id;
    } else if (paid) applyRecurringEffect(item, kind, Number(item.amount) || 0, 1);
    state.recurringPayments.push({ id: paymentId, itemId, kind, date, status: paid ? 'paid' : 'skipped', amount: Number(item.amount) || 0, accountEffectApplied: paid, investmentFlowId, createdAt: new Date().toISOString() });
  }, action === 'undo' ? 'Zahlung wieder geöffnet' : action === 'paid' ? 'Als bezahlt markiert' : 'Termin übersprungen');
}

function hasReferences(kind, itemId) {
  if (kind === 'account') return state.transactions.some(transaction => [transaction.accountId, transaction.fromAccountId, transaction.toAccountId].includes(itemId)) || [...state.incomes, ...state.fixedCosts, ...state.savings, ...state.debtPayments].some(item => [item.accountId, item.targetAccountId].includes(itemId)) || state.investmentFlows.some(flow => flow.accountId === itemId);
  if (kind === 'investment') return state.investmentFlows.some(flow => flow.assetId === itemId) || state.transactions.some(transaction => transaction.assetId === itemId) || state.savings.some(item => item.targetAssetId === itemId);
  if (kind === 'liability') return state.debtPayments.some(item => item.liabilityId === itemId);
  if (['fixed', 'saving', 'debtPayment'].includes(kind)) return state.recurringPayments.some(payment => payment.itemId === itemId);
  return false;
}

async function deleteItem(kind, itemId) {
  if (hasReferences(kind, itemId)) { alert('Dieser Eintrag wird bereits verwendet. Deaktiviere ihn stattdessen oder löse zuerst die verknüpften Buchungen/Zahlungen.'); return; }
  if (!confirm('Eintrag wirklich löschen?')) return;
  await commitMutation(() => {
    if (kind === 'transaction') {
      const index = state.transactions.findIndex(transaction => transaction.id === itemId);
      if (index >= 0) { reverseTransaction(state.transactions[index]); state.transactions.splice(index, 1); }
      return;
    }
    const array = arrayFor(kind);
    const index = array.findIndex(item => item.id === itemId);
    if (index >= 0) array.splice(index, 1);
  }, 'Eintrag gelöscht');
}

function findEditable(kind, itemId) {
  return arrayFor(kind)?.find(item => item.id === itemId) || null;
}

function fillAccountSelect(select, selected, emptyLabel) {
  select.innerHTML = `<option value="">${esc(emptyLabel)}</option>` + state.accounts.map(account => `<option value="${esc(account.id)}">${esc(account.name)}</option>`).join('');
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

function openReconcile(accountId) {
  const account = accountById(accountId); if (!account) return;
  reconcileAccountId = accountId;
  $('reconcileTitle').textContent = account.name;
  $('reconcileExpected').textContent = money(account.balance);
  $('reconcileActual').value = numberInput(account.balance);
  $('reconcileNote').value = '';
  updateReconcilePreview();
  $('reconcileDialog').showModal();
}

function updateReconcilePreview() {
  const account = accountById(reconcileAccountId); if (!account) return;
  updateMoneyPreview($('reconcileActual'), $('reconcilePreview'));
  const actual = Core.parseSignedMoney($('reconcileActual').value);
  const difference = Number.isFinite(actual) ? Core.roundMoney(actual - account.balance) : null;
  $('reconcileDifference').innerHTML = difference === null ? 'Bitte gültigen Bank-Kontostand eingeben.' : `<span>Differenz</span><strong class="${difference < 0 ? 'negative' : difference > 0 ? 'positive' : ''}">${difference >= 0 ? '+' : ''}${money(difference)}</strong>`;
}

async function saveReconciliation() {
  const account = accountById(reconcileAccountId); if (!account) return false;
  const actual = Core.parseSignedMoney($('reconcileActual').value);
  if (!Number.isFinite(actual)) { alert('Bitte einen gültigen Kontostand eingeben.'); return false; }
  return commitMutation(() => {
    const previousBalance = Number(account.balance) || 0;
    const difference = Core.roundMoney(actual - previousBalance);
    account.reconciliations ||= [];
    account.reconciliations.push({ id: id('reconcile'), date: Core.localISO(), previousBalance, actualBalance: actual, difference, note: $('reconcileNote').value.trim() });
    account.balance = actual;
    account.lastReconciledAt = new Date().toISOString();
  }, 'Konto abgeglichen');
}

async function refreshAssetPrice(asset) {
  const settings = state.settings.marketData || {};
  if (settings.provider === 'manual') throw new Error('Wähle zuerst einen Kursanbieter.');
  if (!settings.apiKey) throw new Error('Für den gewählten Anbieter fehlt der persönliche API-Key.');
  if (!asset.ticker) throw new Error(`${asset.name}: Ticker / Symbol fehlt.`);
  let price, currency = asset.currency;
  if (settings.provider === 'twelveData') {
    const response = await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(asset.ticker)}&apikey=${encodeURIComponent(settings.apiKey)}`);
    if (!response.ok) throw new Error(`${asset.name}: Twelve Data HTTP ${response.status}.`);
    const data = await response.json();
    price = Number(data.close);
    currency = data.currency || currency;
    if (data.status === 'error') throw new Error(`${asset.name}: ${data.message || 'Twelve Data Fehler'}`);
  } else if (settings.provider === 'alphaVantage') {
    const response = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(asset.ticker)}&apikey=${encodeURIComponent(settings.apiKey)}`);
    if (!response.ok) throw new Error(`${asset.name}: Alpha Vantage HTTP ${response.status}.`);
    const data = await response.json();
    price = Number(data['Global Quote']?.['05. price']);
    if (data.Note || data.Information) throw new Error(`${asset.name}: ${data.Note || data.Information}`);
  }
  if (!Number.isFinite(price) || price <= 0) throw new Error(`${asset.name}: Kein gültiger Kurs empfangen.`);
  asset.lastPrice = price;
  asset.lastPriceAt = new Date().toISOString();
  if (asset.units > 0 && (!currency || currency === state.settings.currency)) asset.value = Core.roundMoney(asset.units * price);
  return asset;
}

async function refreshPrices(assetId = null) {
  const assets = state.assets.filter(asset => isInvestment(asset) && asset.active !== false && asset.ticker && (!assetId || asset.id === assetId));
  if (!assets.length) { toast('Kein Investment mit Ticker gefunden'); return; }
  const before = clone(state);
  const errors = [];
  try {
    for (const asset of assets) {
      try { await refreshAssetPrice(asset); } catch (error) { errors.push(error.message); }
    }
    if (errors.length === assets.length) throw new Error(errors.join('\n'));
    state.settings.marketData.lastRefreshAt = new Date().toISOString();
    await saveState(); render();
    toast(errors.length ? `${assets.length - errors.length} aktualisiert · ${errors.length} Fehler` : `${assets.length} Kurs${assets.length === 1 ? '' : 'e'} aktualisiert`);
    if (errors.length) console.warn(errors.join('\n'));
  } catch (error) {
    state = before; render(); console.error(error); alert(error.message || 'Kurse konnten nicht geladen werden.');
  }
}

async function updateStorageStatus(request = false) {
  const element = $('storageStatus'), button = $('persistBtn');
  try {
    storagePersistent = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    if (!storagePersistent && request && navigator.storage?.persist) storagePersistent = await navigator.storage.persist();
    element.textContent = storagePersistent ? 'Geschützt' : 'Standard';
    element.className = storagePersistent ? 'status-good' : 'status-warn';
    button.classList.toggle('hidden', storagePersistent || !navigator.storage?.persist);
  } catch (error) {
    console.warn(error); element.textContent = 'Standard'; element.className = 'status-warn'; button.classList.remove('hidden');
  }
}

function hasUserData() { return state.accounts.length + state.incomes.length + state.fixedCosts.length + state.savings.length + state.debtPayments.length + state.transactions.length + state.assets.length + state.liabilities.length > 0; }
function renderDataSafety() {
  $('lastBackupStatus').textContent = state.meta?.lastBackupAt ? formatDateTime(state.meta.lastBackupAt) : 'Noch keines';
  const backupAge = state.meta?.lastBackupAt ? (Date.now() - new Date(state.meta.lastBackupAt).getTime()) / Core.DAY : 999;
  $('backupWarning').classList.toggle('show', hasUserData() && backupAge >= 7);
  $('appVersionLabel').textContent = `Finance OS ${APP_VERSION} · State ${state.version} · lokal auf diesem Gerät`;
}

async function exportBackup() {
  const timestamp = new Date().toISOString();
  const backupState = clone(state);
  if (backupState.settings?.marketData) backupState.settings.marketData.apiKey = '';
  const payload = { format: 'finance-os-backup', version: Core.STATE_VERSION, appVersion: APP_VERSION, exportedAt: timestamp, secretsExcluded: ['settings.marketData.apiKey'], state: backupState };
  const filename = `finance-os-backup-${Core.localISO()}.json`;
  const file = new File([JSON.stringify(payload, null, 2)], filename, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] }) && navigator.share) await navigator.share({ files: [file], title: 'Finance OS Backup' });
    else {
      const url = URL.createObjectURL(file), link = document.createElement('a');
      link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
    await commitMutation(() => { state.meta.lastBackupAt = timestamp; }, 'Backup-Export gestartet');
  } catch (error) {
    if (error.name !== 'AbortError') { console.error(error); alert('Backup konnte nicht exportiert werden.'); }
  }
}

async function prepareImport(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { alert('Das Backup ist größer als 5 MB und wird aus Sicherheitsgründen nicht geladen.'); return; }
  try {
    const parsed = JSON.parse(await file.text());
    const validation = Core.validateImportPayload(parsed);
    if (!validation.valid) throw new Error(validation.errors.join('\n'));
    pendingImport = validation.state;
    const summary = validation.summary;
    $('importSummary').innerHTML = [['Quelle', `State ${summary.sourceVersion}`], ['Konten', summary.accounts], ['Buchungen', summary.transactions], ['Wiederkehrend', summary.recurring], ['Investments', summary.investments], ['Verbindlichkeiten', summary.liabilities]].map(([label, value]) => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');
    $('importWarnings').innerHTML = validation.warnings.map(warning => `<div class="import-warning">${esc(warning)}</div>`).join('');
    $('importDialog').showModal();
  } catch (error) {
    console.error(error); alert(`Backup wurde nicht übernommen:\n${error.message || 'Ungültige Datei'}`);
  } finally { $('importInput').value = ''; }
}

async function confirmImport() {
  if (!pendingImport) return;
  const imported = pendingImport;
  const success = await commitMutation(() => { state = clone(imported); }, 'Backup geprüft und importiert');
  if (success) { pendingImport = null; $('importDialog').close(); }
}

async function restoreLastSnapshot() {
  const db = await openDB();
  const snapshots = await new Promise((resolve, reject) => { const request = db.transaction(SNAPSHOTS, 'readonly').objectStore(SNAPSHOTS).getAll(); request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error); });
  if (!snapshots.length) { toast('Noch kein lokaler Stand vorhanden'); return; }
  if (!confirm('Den letzten lokalen Stand wiederherstellen? Der aktuelle Stand bleibt als Snapshot erhalten.')) return;
  const migrated = Core.migrateState(snapshots[snapshots.length - 1]).state;
  await commitMutation(() => { state = migrated; }, 'Lokaler Stand wiederhergestellt');
}

async function resetAllData() {
  if (!confirm('Wirklich ALLE Finance-OS-Daten auf diesem Gerät löschen? Auch lokale Snapshots werden entfernt. Dies kann nicht rückgängig gemacht werden.')) return;
  try {
    const db = await openDB();
    await new Promise((resolve, reject) => { const tx = db.transaction([STORE, SNAPSHOTS], 'readwrite'); tx.objectStore(STORE).delete('main'); tx.objectStore(SNAPSHOTS).clear(); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    state = Core.createDefaultState();
    await saveState({ snapshot: false });
    render(); toast('Alle lokalen Finanzdaten gelöscht');
  } catch (error) { console.error(error); alert('Daten konnten nicht vollständig gelöscht werden.'); }
}

function showUpdate(registration) {
  waitingWorker = registration.waiting;
  $('updateVersionText').textContent = `Finance OS ${APP_VERSION} ist bereit. Deine IndexedDB bleibt erhalten.`;
  $('updateBanner').classList.remove('hidden');
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register('./service-worker.js', { scope: './' });
    if (registration.waiting) showUpdate(registration);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate(registration); });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloadingForUpdate) { reloadingForUpdate = true; location.reload(); } });
    registration.update().catch(error => console.warn('Update-Prüfung fehlgeschlagen', error));
  } catch (error) { console.warn('Service Worker nicht verfügbar', error); }
}

function bind() {
  document.querySelectorAll('.nav-item').forEach(button => button.onclick = () => setView(button.dataset.view));
  document.querySelectorAll('[data-nav]').forEach(button => button.onclick = () => setView(button.dataset.nav));
  document.querySelectorAll('[data-dialog-cancel]').forEach(button => button.onclick = () => { editing = null; $('entryDialog').close(); });
  $('entryDialog').addEventListener('cancel', () => { editing = null; });
  document.querySelectorAll('[data-import-cancel]').forEach(button => button.onclick = () => { pendingImport = null; $('importDialog').close(); });
  document.querySelectorAll('[data-reconcile-cancel]').forEach(button => button.onclick = () => { reconcileAccountId = null; $('reconcileDialog').close(); });
  $('quickAddBtn').onclick = () => openEntry('transaction'); $('addTransactionBtn').onclick = () => openEntry('transaction');
  [['addAccountBtn', 'account'], ['addIncomeBtn', 'income'], ['addFixedBtn', 'fixed'], ['addSavingBtn', 'saving'], ['addDebtPaymentBtn', 'debtPayment'], ['addInvestmentBtn', 'investment'], ['addAssetBtn', 'asset'], ['addLiabilityBtn', 'liability']].forEach(([elementId, kind]) => $(elementId).onclick = () => openEntry(kind));
  document.body.addEventListener('click', async event => {
    const editButton = event.target.closest('[data-edit-kind]');
    if (editButton) { const item = findEditable(editButton.dataset.editKind, editButton.dataset.id); if (item) openEntry(editButton.dataset.editKind, item); return; }
    const deleteButton = event.target.closest('[data-delete-kind]');
    if (deleteButton) { await deleteItem(deleteButton.dataset.deleteKind, deleteButton.dataset.id); return; }
    const reconcileButton = event.target.closest('[data-reconcile-id]');
    if (reconcileButton) { openReconcile(reconcileButton.dataset.reconcileId); return; }
    const flowButton = event.target.closest('[data-invest-flow-id]');
    if (flowButton) { openEntry('investmentFlow', { assetId: flowButton.dataset.investFlowId }); return; }
    const refreshButton = event.target.closest('[data-refresh-asset]');
    if (refreshButton) { await refreshPrices(refreshButton.dataset.refreshAsset); return; }
    const occurrenceButton = event.target.closest('[data-occ-action]');
    if (occurrenceButton) { await handleOccurrenceAction(occurrenceButton); return; }
    const calendarButton = event.target.closest('[data-cal-date]');
    if (calendarButton) { selectedCalendarDate = calendarButton.dataset.calDate; renderCalendar(); }
  });
  $('entryForm').addEventListener('submit', async event => { event.preventDefault(); if (await saveEntry()) { editing = null; $('entryDialog').close(); } });
  $('reconcileActual').addEventListener('input', updateReconcilePreview);
  $('reconcileForm').addEventListener('submit', async event => { event.preventDefault(); if (await saveReconciliation()) { reconcileAccountId = null; $('reconcileDialog').close(); } });
  $('salaryDayInput').addEventListener('change', async event => commitMutation(() => { state.settings.salaryDay = Core.clamp(Number(event.target.value) || 28, 1, 31); }));
  document.querySelectorAll('#budgetModeSwitch button').forEach(button => button.onclick = async () => commitMutation(() => { state.settings.budgetMode = button.dataset.mode; }));
  $('manualBudgetInput').addEventListener('input', event => updateMoneyPreview(event.target, $('manualBudgetPreview')));
  $('manualBudgetInput').addEventListener('change', async event => { const value = Core.parseMoney(event.target.value); if (!Number.isFinite(value) || value < 0) { alert('Bitte ein gültiges Limit eingeben.'); renderPlan(); return; } await commitMutation(() => { state.settings.manualBudget = value; }); });
  ['monthFilter', 'transactionTypeFilter', 'accountFilter', 'categoryFilter'].forEach(elementId => $(elementId).onchange = renderTransactions); $('searchFilter').oninput = renderTransactions;
  document.querySelectorAll('#analysisRange button').forEach(button => button.onclick = () => { analysisRange = button.dataset.range; renderAnalysis(); });
  document.querySelectorAll('#investmentRange button').forEach(button => button.onclick = () => { investmentRange = button.dataset.range; renderWealth(); });
  $('calendarPrev').onclick = () => { calendarCursor = Core.startOfMonth(Core.addMonthsAnchored(calendarCursor, -1)); selectedCalendarDate = ''; renderCalendar(); };
  $('calendarNext').onclick = () => { calendarCursor = Core.startOfMonth(Core.addMonthsAnchored(calendarCursor, 1)); selectedCalendarDate = ''; renderCalendar(); };
  $('calendarToday').onclick = () => { calendarCursor = Core.startOfMonth(new Date()); selectedCalendarDate = Core.localISO(); renderCalendar(); };
  $('saveMarketSettingsBtn').onclick = async () => commitMutation(() => { state.settings.marketData = { ...state.settings.marketData, provider: $('marketProvider').value, apiKey: $('marketApiKey').value.trim() }; }, 'Kursanbieter lokal gespeichert');
  $('refreshPricesBtn').onclick = () => refreshPrices();
  $('exportBtn').onclick = exportBackup; $('importInput').onchange = event => prepareImport(event.target.files[0]); $('confirmImportBtn').onclick = confirmImport; $('restoreBtn').onclick = restoreLastSnapshot; $('resetBtn').onclick = resetAllData;
  $('persistBtn').onclick = async () => { await updateStorageStatus(true); toast(storagePersistent ? 'Speicher geschützt' : 'Schutz konnte nicht erzwungen werden'); };
  $('updateNowBtn').onclick = () => waitingWorker?.postMessage({ type: 'SKIP_WAITING' });
  window.addEventListener('resize', () => { drawSpendingTrend(analysisData()); renderInvestmentSummary(Core.calculateBudget(state)); drawAllocation(); drawNetWorthHistory(); });
}

async function init() {
  try {
    const loaded = await loadState();
    state = loaded.state;
    bind();
    recordHistoryPoints();
    render();
    await updateStorageStatus(false);
    if (!loaded.hadStoredState || loaded.sourceVersion < Core.STATE_VERSION || loaded.warnings.length) await saveState({ snapshot: loaded.hadStoredState });
    if (loaded.warnings.length) console.warn('Migration:', loaded.warnings);
  } catch (error) {
    storageReady = false;
    console.error(error);
    state = Core.createDefaultState();
    bind(); render();
    alert('Finance OS konnte deine lokale Datenbank nicht sicher lesen. Es wird nichts überschrieben. Schließe andere Finance-OS-Tabs und lade die App neu.');
  }
  await registerServiceWorker();
}

window.FinanceOSTest = { ...Core, calculate: reference => Core.calculateBudget(state, reference), getState: () => clone(state) };
document.addEventListener('DOMContentLoaded', init);
