(function initFinanceCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FinanceCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function financeCoreFactory() {
  'use strict';

  const STATE_VERSION = 5;
  const DAY = 86_400_000;
  const CASH_ASSET_TYPES = new Set(['Konto', 'Cash', 'Tagesgeld', 'Girokonto', 'Bargeld']);
  const INVESTMENT_TYPES = new Set(['ETF', 'Aktie', 'Aktien', 'Krypto', 'Investment']);
  const TRANSACTION_TYPES = new Set(['expense', 'income', 'refund', 'transfer', 'investment', 'correction']);
  const FREQUENCIES = new Set(['weekly', 'fourweekly', 'monthly', 'quarterly', 'semiannual', 'yearly', 'oneTime']);
  const BUILTIN_CATEGORIES = new Set([
    'Lebensmittel', 'Essen & Trinken', 'Rauchen', 'Freizeit & Party', 'Shopping', 'Mobilität',
    'Reisen', 'Wohnen', 'Gesundheit', 'Sport', 'Digital & Abos', 'Geschenke & Familie',
    'Bildung', 'Gebühren & Bank', 'Sonstiges'
  ]);

  function createDefaultState() {
    return {
      version: STATE_VERSION,
      meta: { lastSavedAt: null, lastBackupAt: null, migratedAt: null },
      settings: {
        currency: 'EUR',
        budgetMode: 'auto',
        manualBudget: 0,
        salaryDay: 28,
        customCategories: [],
        marketData: { provider: 'manual', apiKey: '', lastRefreshAt: null }
      },
      accounts: [],
      incomes: [],
      fixedCosts: [],
      savings: [],
      debtPayments: [],
      transactions: [],
      assets: [],
      liabilities: [],
      recurringPayments: [],
      investmentFlows: [],
      history: { netWorth: [], investments: [] }
    };
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function clamp(number, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, number));
  }

  function roundMoney(number) {
    return Math.round((Number(number) + Number.EPSILON) * 100) / 100;
  }

  function parseMoney(value) {
    let text = String(value ?? '').trim().replace(/[\s€$£'’]/g, '');
    if (!text) return NaN;
    if (!/^\+?\d+(?:[.,]\d+)*$/.test(text)) return NaN;
    text = text.replace(/^\+/, '');

    const commas = (text.match(/,/g) || []).length;
    const dots = (text.match(/\./g) || []).length;
    let normalized;

    if (commas && dots) {
      const decimalSeparator = text.lastIndexOf(',') > text.lastIndexOf('.') ? ',' : '.';
      const groupSeparator = decimalSeparator === ',' ? '.' : ',';
      if ((text.match(new RegExp(`\\${decimalSeparator}`, 'g')) || []).length !== 1) return NaN;
      const [integerPart, decimalPart] = text.split(decimalSeparator);
      if (!/^\d{1,3}(?:[.,]\d{3})*$/.test(integerPart) || !integerPart.includes(groupSeparator)) return NaN;
      if (!/^\d{1,2}$/.test(decimalPart)) return NaN;
      normalized = integerPart.split(groupSeparator).join('') + '.' + decimalPart;
    } else if (commas || dots) {
      const separator = commas ? ',' : '.';
      const parts = text.split(separator);
      if (parts.length === 2 && parts[1].length >= 1 && parts[1].length <= 2) {
        normalized = parts[0] + '.' + parts[1];
      } else if (parts.length >= 2 && parts[0].length >= 1 && parts[0].length <= 3 && parts.slice(1).every(part => /^\d{3}$/.test(part))) {
        normalized = parts.join('');
      } else {
        return NaN;
      }
    } else {
      normalized = text;
    }

    const number = Number(normalized);
    return Number.isFinite(number) ? roundMoney(number) : NaN;
  }

  function parseSignedMoney(value) {
    const text = String(value ?? '').trim();
    if (!text) return NaN;
    const negative = text.startsWith('-');
    const unsigned = negative ? text.slice(1).trim() : text;
    const parsed = parseMoney(unsigned);
    return Number.isFinite(parsed) ? roundMoney(negative ? -parsed : parsed) : NaN;
  }

  function normalizeMoney(value, warnings, label, fallback = 0) {
    if (typeof value === 'number' && Number.isFinite(value)) return roundMoney(value);
    const parsed = parseMoney(value);
    if (Number.isFinite(parsed)) return parsed;
    if (value !== undefined && value !== null && String(value).trim() !== '') warnings.push(`${label}: ungültiger Betrag wurde als ${fallback} übernommen.`);
    return fallback;
  }

  function localISO(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function parseLocalDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    const [year, month, day] = String(value).split('-').map(Number);
    const date = new Date(year, month - 1, day, 12);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
  }

  function atNoon(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  }

  function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1, 12);
  }

  function endOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0, 12);
  }

  function addDays(date, amount) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount, 12);
  }

  function daysInMonth(year, month) {
    return new Date(year, month + 1, 0, 12).getDate();
  }

  function makeDate(year, month, day) {
    const targetDays = daysInMonth(year, month);
    return new Date(year, month, clamp(Number(day) || 1, 1, targetDays), 12);
  }

  function addMonthsAnchored(anchor, amount) {
    return makeDate(anchor.getFullYear(), anchor.getMonth() + amount, anchor.getDate());
  }

  function dateInRange(date, start, end) {
    const time = atNoon(date).getTime();
    return time >= atNoon(start).getTime() && time <= atNoon(end).getTime();
  }

  function daysBetween(start, end) {
    const a = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
    const b = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
    return Math.round((b - a) / DAY);
  }

  function monthKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function salaryDate(year, month, salaryDay) {
    return makeDate(year, month, clamp(Number(salaryDay) || 28, 1, 31));
  }

  function getSalaryCycle(salaryDay, reference = new Date()) {
    const ref = atNoon(reference);
    const currentSalary = salaryDate(ref.getFullYear(), ref.getMonth(), salaryDay);
    const start = ref >= currentSalary
      ? currentSalary
      : salaryDate(ref.getFullYear(), ref.getMonth() - 1, salaryDay);
    const next = ref >= currentSalary
      ? salaryDate(ref.getFullYear(), ref.getMonth() + 1, salaryDay)
      : currentSalary;
    return { start, next, end: addDays(next, -1) };
  }

  function previousSalaryCycle(salaryDay, cycle) {
    return getSalaryCycle(salaryDay, addDays(cycle.start, -1));
  }

  function monthlyEquivalent(item) {
    const amount = Number(item?.amount) || 0;
    return ({
      weekly: amount * 52 / 12,
      fourweekly: amount * 13 / 12,
      monthly: amount,
      quarterly: amount / 3,
      semiannual: amount / 6,
      yearly: amount / 12,
      oneTime: 0
    })[item?.frequency || 'monthly'] ?? amount;
  }

  function yearlyEquivalent(item) {
    return monthlyEquivalent(item) * 12;
  }

  function occurrenceDates(item, start, end) {
    if (!item || item.active === false) return [];
    const anchor = parseLocalDate(item.dueDate);
    if (!anchor || !start || !end || start > end) return [];
    const explicitStart = parseLocalDate(item.startDate);
    const explicitEnd = parseLocalDate(item.endDate);
    let rangeStart = atNoon(start);
    let rangeEnd = atNoon(end);
    if (explicitStart && explicitStart > rangeStart) rangeStart = explicitStart;
    if (explicitEnd && explicitEnd < rangeEnd) rangeEnd = explicitEnd;
    if (rangeStart > rangeEnd) return [];

    const frequency = FREQUENCIES.has(item.frequency) ? item.frequency : 'monthly';
    if (frequency === 'oneTime') return dateInRange(anchor, rangeStart, rangeEnd) ? [anchor] : [];

    const output = [];
    if (frequency === 'weekly' || frequency === 'fourweekly') {
      const step = frequency === 'weekly' ? 7 : 28;
      let index = Math.ceil(daysBetween(anchor, rangeStart) / step);
      if (explicitStart) index = Math.max(index, Math.ceil(daysBetween(anchor, explicitStart) / step));
      let current = addDays(anchor, index * step);
      let guard = 0;
      while (current <= rangeEnd && guard++ < 5000) {
        if (current >= rangeStart) output.push(current);
        index += 1;
        current = addDays(anchor, index * step);
      }
      return output;
    }

    const step = ({ monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 })[frequency] || 1;
    let index = 0;
    let current = anchor;
    let guard = 0;
    while (current > rangeStart && !explicitStart && guard++ < 1200) {
      index -= 1;
      current = addMonthsAnchored(anchor, index * step);
    }
    while (current < rangeStart && guard++ < 2400) {
      index += 1;
      current = addMonthsAnchored(anchor, index * step);
    }
    while (current <= rangeEnd && guard++ < 3600) {
      if ((!explicitStart || current >= explicitStart) && (!explicitEnd || current <= explicitEnd)) output.push(current);
      index += 1;
      current = addMonthsAnchored(anchor, index * step);
    }
    return output;
  }

  function defaultIdFactory(prefix = 'id') {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function cleanText(value, fallback = '') {
    return String(value ?? fallback).trim();
  }

  function ensureUniqueId(raw, used, prefix, idFactory, warnings) {
    let candidate = cleanText(raw);
    if (!candidate || used.has(candidate)) {
      if (candidate && used.has(candidate)) warnings.push(`${prefix}: doppelte ID wurde ersetzt.`);
      candidate = idFactory(prefix);
      while (used.has(candidate)) candidate = idFactory(prefix);
    }
    used.add(candidate);
    return candidate;
  }

  function normalizeDate(value, warnings, label) {
    if (!value) return '';
    if (parseLocalDate(value)) return String(value);
    warnings.push(`${label}: ungültiges Datum „${String(value)}“ wurde entfernt.`);
    return '';
  }

  function nextDateForDay(day, now) {
    const today = atNoon(now);
    const thisMonth = makeDate(today.getFullYear(), today.getMonth(), day);
    return thisMonth < today
      ? makeDate(today.getFullYear(), today.getMonth() + 1, day)
      : thisMonth;
  }

  function migrateState(rawState, options = {}) {
    const warnings = [];
    const idFactory = options.idFactory || defaultIdFactory;
    const now = options.now instanceof Date ? options.now : new Date();
    const source = isPlainObject(rawState) ? rawState : {};
    const rawVersion = Number(source.version) || 1;
    if (rawVersion > STATE_VERSION) throw new Error(`State-Version ${rawVersion} ist neuer als die unterstützte Version ${STATE_VERSION}.`);
    const sourceVersion = clamp(rawVersion, 1, STATE_VERSION);
    const state = createDefaultState();
    const usedIds = new Set();

    const rawSettings = isPlainObject(source.settings) ? source.settings : {};
    state.settings.currency = /^[A-Z]{3}$/.test(cleanText(rawSettings.currency)) ? cleanText(rawSettings.currency) : 'EUR';
    state.settings.budgetMode = rawSettings.budgetMode === 'manual' ? 'manual' : 'auto';
    state.settings.manualBudget = Math.max(0, normalizeMoney(rawSettings.manualBudget, warnings, 'Eigenes Budget'));
    state.settings.salaryDay = clamp(Number(rawSettings.salaryDay) || 28, 1, 31);
    state.settings.customCategories = Array.isArray(rawSettings.customCategories)
      ? [...new Set(rawSettings.customCategories.filter(value => typeof value === 'string').map(value => cleanText(value)).filter(Boolean))]
      : [];
    const marketData = isPlainObject(rawSettings.marketData) ? rawSettings.marketData : {};
    state.settings.marketData = {
      provider: ['manual', 'twelveData', 'alphaVantage'].includes(marketData.provider) ? marketData.provider : 'manual',
      apiKey: cleanText(marketData.apiKey),
      lastRefreshAt: marketData.lastRefreshAt || null
    };

    const rawAssets = Array.isArray(source.assets) ? source.assets : [];
    const rawAccounts = Array.isArray(source.accounts) ? source.accounts : [];
    const accountSources = [...rawAccounts];
    for (const asset of rawAssets) {
      if (isPlainObject(asset) && CASH_ASSET_TYPES.has(asset.type)) accountSources.push({
        ...asset,
        balance: asset.balance ?? asset.value,
        legacyAssetId: asset.id
      });
    }

    state.accounts = accountSources.map((account, index) => {
      const originalType = cleanText(account.type, 'Girokonto');
      const type = ({ Konto: 'Girokonto', Cash: 'Bargeld' })[originalType] || originalType;
      const id = ensureUniqueId(account.id || account.legacyAssetId, usedIds, 'account', idFactory, warnings);
      const balance = normalizeMoney(account.balance ?? account.value, warnings, `Konto ${index + 1}`);
      return {
        id,
        name: cleanText(account.name, `Konto ${index + 1}`),
        type: type || 'Girokonto',
        bank: cleanText(account.bank),
        balance,
        includeInAvailable: typeof account.includeInAvailable === 'boolean'
          ? account.includeInAvailable
          : !['Tagesgeld', 'Depot', 'Kreditkarte'].includes(type),
        active: account.active !== false,
        lastReconciledAt: account.lastReconciledAt || null,
        reconciliations: Array.isArray(account.reconciliations) ? account.reconciliations.filter(isPlainObject).map(entry => ({
          id: ensureUniqueId(entry.id, usedIds, 'reconcile', idFactory, warnings),
          date: normalizeDate(entry.date, warnings, 'Kontenabgleich') || localISO(now),
          previousBalance: normalizeMoney(entry.previousBalance, warnings, 'Alter Kontostand'),
          actualBalance: normalizeMoney(entry.actualBalance, warnings, 'Bank-Kontostand'),
          difference: Number.isFinite(Number(entry.difference)) ? roundMoney(Number(entry.difference)) : 0,
          note: cleanText(entry.note)
        })) : []
      };
    });

    const accountByName = new Map(state.accounts.map(account => [account.name.toLocaleLowerCase('de'), account.id]));
    const accountIds = new Set(state.accounts.map(account => account.id));
    const resolveAccount = (idValue, nameValue) => {
      const id = cleanText(idValue);
      if (id && accountIds.has(id)) return id;
      return accountByName.get(cleanText(nameValue).toLocaleLowerCase('de')) || '';
    };

    state.assets = rawAssets.filter(asset => isPlainObject(asset) && !CASH_ASSET_TYPES.has(asset.type)).map((asset, index) => {
      const rawCost = asset.costBasis;
      const costBasis = normalizeMoney(rawCost, warnings, `Einstand Anlage ${index + 1}`);
      return {
        id: ensureUniqueId(asset.id, usedIds, 'asset', idFactory, warnings),
        name: cleanText(asset.name, `Anlage ${index + 1}`),
        type: cleanText(asset.type, 'Sonstiges'),
        value: normalizeMoney(asset.value, warnings, `Wert Anlage ${index + 1}`),
        costBasis,
        costBasisKnown: typeof asset.costBasisKnown === 'boolean' ? asset.costBasisKnown : costBasis > 0,
        units: Number.isFinite(Number(asset.units)) && Number(asset.units) >= 0 ? Number(asset.units) : 0,
        ticker: cleanText(asset.ticker),
        isin: cleanText(asset.isin).toUpperCase(),
        currency: /^[A-Z]{3}$/.test(cleanText(asset.currency)) ? cleanText(asset.currency) : state.settings.currency,
        lastPrice: Number.isFinite(Number(asset.lastPrice)) ? Number(asset.lastPrice) : null,
        lastPriceAt: asset.lastPriceAt || null,
        note: cleanText(asset.note),
        active: asset.active !== false
      };
    });
    const assetIds = new Set(state.assets.map(asset => asset.id));

    const normalizeRecurring = (items, kind) => (Array.isArray(items) ? items : []).filter(isPlainObject).map((item, index) => {
      let name = cleanText(item.name, `Position ${index + 1}`);
      let amount = normalizeMoney(item.amount, warnings, `${kind} ${name}`);
      let frequency = FREQUENCIES.has(item.frequency) ? item.frequency : 'monthly';
      if (!item.frequency && sourceVersion <= 3 && kind === 'Fixkosten' && /\(Monatsanteil\)/i.test(name)) {
        name = name.replace(/\s*\(Monatsanteil\)\s*/i, '').trim();
        amount = roundMoney(amount * 12);
        frequency = 'yearly';
      }
      let dueDate = normalizeDate(item.dueDate, warnings, `${kind} ${name}`);
      if (!dueDate && Number(item.dueDay) >= 1) dueDate = localISO(nextDateForDay(clamp(Number(item.dueDay), 1, 31), now));
      return {
        id: ensureUniqueId(item.id, usedIds, kind.toLowerCase(), idFactory, warnings),
        name,
        amount,
        frequency,
        dueDate,
        startDate: normalizeDate(item.startDate, warnings, `${kind} ${name} Beginn`),
        endDate: normalizeDate(item.endDate, warnings, `${kind} ${name} Ende`),
        active: item.active !== false,
        accountId: resolveAccount(item.accountId, item.account),
        targetAccountId: resolveAccount(item.targetAccountId, item.targetAccount),
        targetAssetId: assetIds.has(cleanText(item.targetAssetId)) ? cleanText(item.targetAssetId) : '',
        liabilityId: cleanText(item.liabilityId),
        category: cleanText(item.category),
        type: cleanText(item.type),
        note: cleanText(item.note)
      };
    });

    state.incomes = (Array.isArray(source.incomes) ? source.incomes : []).filter(isPlainObject).map((income, index) => ({
      id: ensureUniqueId(income.id, usedIds, 'income', idFactory, warnings),
      name: cleanText(income.name, `Einnahme ${index + 1}`),
      amount: normalizeMoney(income.amount, warnings, `Einnahme ${index + 1}`),
      accountId: resolveAccount(income.accountId, income.account),
      active: income.active !== false
    }));
    state.fixedCosts = normalizeRecurring(source.fixedCosts, 'Fixkosten');
    state.savings = normalizeRecurring(source.savings, 'Sparen');
    state.debtPayments = normalizeRecurring(source.debtPayments, 'Rate');

    const categoryMap = {
      Restaurant: ['Essen & Trinken', 'Restaurant'],
      Kaffee: ['Essen & Trinken', 'Kaffee'],
      Freizeit: ['Freizeit & Party', 'Hobby'],
      Party: ['Freizeit & Party', 'Events'],
      Auto: ['Mobilität', ''],
      Games: ['Digital & Abos', 'Games']
    };
    state.transactions = (Array.isArray(source.transactions) ? source.transactions : []).filter(isPlainObject).map((transaction, index) => {
      let category = cleanText(transaction.category, 'Sonstiges');
      let subcategory = cleanText(transaction.subcategory);
      if (categoryMap[category]) {
        const mapped = categoryMap[category];
        category = mapped[0];
        if (!subcategory) subcategory = mapped[1];
      }
      const type = TRANSACTION_TYPES.has(transaction.type) ? transaction.type : 'expense';
      if (!['expense', 'refund'].includes(type)) { category = ''; subcategory = ''; }
      if (category && !BUILTIN_CATEGORIES.has(category) && !state.settings.customCategories.includes(category)) state.settings.customCategories.push(category);
      return {
        id: ensureUniqueId(transaction.id, usedIds, 'transaction', idFactory, warnings),
        date: normalizeDate(transaction.date, warnings, `Buchung ${index + 1}`),
        amount: Math.max(0, normalizeMoney(transaction.amount, warnings, `Buchung ${index + 1}`)),
        type,
        category,
        subcategory,
        note: cleanText(transaction.note),
        merchant: cleanText(transaction.merchant),
        accountId: resolveAccount(transaction.accountId, transaction.account),
        fromAccountId: resolveAccount(transaction.fromAccountId, transaction.fromAccount),
        toAccountId: resolveAccount(transaction.toAccountId, transaction.toAccount),
        assetId: assetIds.has(cleanText(transaction.assetId)) ? cleanText(transaction.assetId) : '',
        investmentFlowId: cleanText(transaction.investmentFlowId),
        adjustment: Number.isFinite(Number(transaction.adjustment)) ? roundMoney(Number(transaction.adjustment)) : 0,
        balanceApplied: sourceVersion >= STATE_VERSION && transaction.balanceApplied === true,
        noteTags: Array.isArray(transaction.noteTags) ? transaction.noteTags.map(cleanText).filter(Boolean) : []
      };
    });

    state.liabilities = (Array.isArray(source.liabilities) ? source.liabilities : []).filter(isPlainObject).map((liability, index) => ({
      id: ensureUniqueId(liability.id, usedIds, 'liability', idFactory, warnings),
      name: cleanText(liability.name, `Verbindlichkeit ${index + 1}`),
      type: cleanText(liability.type, 'Sonstiges'),
      balance: Math.max(0, normalizeMoney(liability.balance, warnings, `Verbindlichkeit ${index + 1}`)),
      active: liability.active !== false,
      note: cleanText(liability.note)
    }));
    const liabilityIds = new Set(state.liabilities.map(item => item.id));
    state.debtPayments.forEach(item => { if (!liabilityIds.has(item.liabilityId)) item.liabilityId = ''; });

    state.recurringPayments = (Array.isArray(source.recurringPayments) ? source.recurringPayments : []).filter(isPlainObject).map((payment, index) => ({
      id: ensureUniqueId(payment.id, usedIds, 'recurring-payment', idFactory, warnings),
      itemId: cleanText(payment.itemId),
      kind: ['fixed', 'saving', 'debt'].includes(payment.kind) ? payment.kind : 'fixed',
      date: normalizeDate(payment.date, warnings, `Wiederkehrende Zahlung ${index + 1}`),
      status: ['paid', 'skipped'].includes(payment.status) ? payment.status : 'paid',
      amount: Math.max(0, normalizeMoney(payment.amount, warnings, `Wiederkehrende Zahlung ${index + 1}`)),
      accountEffectApplied: payment.accountEffectApplied === true,
      investmentFlowId: cleanText(payment.investmentFlowId),
      createdAt: payment.createdAt || null
    }));

    state.investmentFlows = (Array.isArray(source.investmentFlows) ? source.investmentFlows : []).filter(isPlainObject).map((flow, index) => ({
      id: ensureUniqueId(flow.id, usedIds, 'investment-flow', idFactory, warnings),
      assetId: assetIds.has(cleanText(flow.assetId)) ? cleanText(flow.assetId) : '',
      accountId: resolveAccount(flow.accountId, flow.account),
      date: normalizeDate(flow.date, warnings, `Investment-Cashflow ${index + 1}`),
      type: ['contribution', 'withdrawal', 'dividend', 'fee', 'buy', 'sell'].includes(flow.type) ? flow.type : 'contribution',
      amount: Math.max(0, normalizeMoney(flow.amount, warnings, `Investment-Cashflow ${index + 1}`)),
      units: Number.isFinite(Number(flow.units)) ? Number(flow.units) : 0,
      price: Number.isFinite(Number(flow.price)) ? Number(flow.price) : 0,
      note: cleanText(flow.note),
      recurringPaymentId: cleanText(flow.recurringPaymentId),
      applied: flow.applied === true
    }));

    const rawHistory = isPlainObject(source.history) ? source.history : {};
    const normalizeHistory = (points, type) => (Array.isArray(points) ? points : []).filter(isPlainObject).map(point => {
      const date = normalizeDate(point.date, warnings, `${type}-Historie`);
      if (!date) return null;
      if (type === 'Investment') return {
        date,
        value: normalizeMoney(point.value, warnings, 'Investmentwert'),
        cost: normalizeMoney(point.cost, warnings, 'Investmenteinstand')
      };
      return { date, value: Number.isFinite(Number(point.value)) ? roundMoney(Number(point.value)) : 0 };
    }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
    state.history = {
      netWorth: normalizeHistory(rawHistory.netWorth, 'Vermögen'),
      investments: normalizeHistory(rawHistory.investments, 'Investment')
    };

    const rawMeta = isPlainObject(source.meta) ? source.meta : {};
    state.meta = {
      lastSavedAt: rawMeta.lastSavedAt || null,
      lastBackupAt: rawMeta.lastBackupAt || null,
      migratedAt: sourceVersion < STATE_VERSION ? new Date(now).toISOString() : rawMeta.migratedAt || null
    };
    state.version = STATE_VERSION;

    return { state, warnings, sourceVersion, targetVersion: STATE_VERSION };
  }

  function validateImportPayload(payload, options = {}) {
    const errors = [];
    let source = payload;
    if (isPlainObject(payload) && payload.format) {
      if (payload.format !== 'finance-os-backup') errors.push('Unbekanntes Backup-Format.');
      source = payload.state;
    }
    if (!isPlainObject(source)) errors.push('Das Backup enthält keinen gültigen Finance-OS-Datenbestand.');
    const knownKeys = ['version', 'settings', 'accounts', 'incomes', 'fixedCosts', 'savings', 'debtPayments', 'transactions', 'assets', 'liabilities', 'history'];
    if (isPlainObject(source) && !knownKeys.some(key => Object.prototype.hasOwnProperty.call(source, key))) errors.push('Die Datei enthält keine erkennbaren Finance-OS-Felder.');
    if (isPlainObject(source) && Number(source.version) > STATE_VERSION) errors.push(`Das Backup stammt aus einer neueren, nicht unterstützten State-Version ${source.version}.`);
    for (const key of ['accounts', 'incomes', 'fixedCosts', 'savings', 'debtPayments', 'transactions', 'assets', 'liabilities', 'recurringPayments', 'investmentFlows']) {
      if (isPlainObject(source) && source[key] !== undefined && !Array.isArray(source[key])) errors.push(`${key} muss eine Liste sein.`);
    }
    if (errors.length) return { valid: false, errors, warnings: [], state: null, summary: null };

    const migrated = migrateState(source, options);
    const state = migrated.state;
    const summary = {
      sourceVersion: migrated.sourceVersion,
      targetVersion: STATE_VERSION,
      accounts: state.accounts.length,
      transactions: state.transactions.length,
      recurring: state.fixedCosts.length + state.savings.length + state.debtPayments.length,
      investments: state.assets.filter(asset => INVESTMENT_TYPES.has(asset.type)).length,
      liabilities: state.liabilities.length
    };
    return { valid: true, errors: [], warnings: migrated.warnings, state, summary };
  }

  function occurrencesFrom(items, kind, start, end) {
    return (Array.isArray(items) ? items : []).flatMap(item => occurrenceDates(item, start, end).map(date => ({
      date,
      amount: Number(item.amount) || 0,
      name: item.name || 'Ohne Namen',
      kind,
      itemId: item.id,
      frequency: item.frequency || 'monthly',
      accountId: item.accountId || '',
      targetAccountId: item.targetAccountId || '',
      targetAssetId: item.targetAssetId || '',
      liabilityId: item.liabilityId || '',
      category: item.category || '',
      item
    })));
  }

  function allOccurrences(state, start, end) {
    return [
      ...occurrencesFrom(state.fixedCosts, 'fixed', start, end),
      ...occurrencesFrom(state.savings, 'saving', start, end),
      ...occurrencesFrom(state.debtPayments, 'debt', start, end)
    ].sort((a, b) => a.date - b.date || a.name.localeCompare(b.name, 'de'));
  }

  function recurringPaymentFor(state, occurrence) {
    const date = localISO(occurrence.date);
    return (state.recurringPayments || []).find(payment => payment.itemId === occurrence.itemId && payment.date === date) || null;
  }

  function transactionConsumption(transaction) {
    const amount = Number(transaction?.amount) || 0;
    if (transaction?.type === 'expense' || !transaction?.type) return amount;
    if (transaction?.type === 'refund') return -amount;
    return 0;
  }

  function transactionsBetween(state, start, end) {
    return (state.transactions || []).filter(transaction => {
      const date = parseLocalDate(transaction.date);
      return date && dateInRange(date, start, end);
    });
  }

  function calculateBudget(state, reference = new Date()) {
    const salaryDay = state.settings?.salaryDay || 28;
    const cycle = getSalaryCycle(salaryDay, reference);
    const income = (state.incomes || []).filter(item => item.active !== false).reduce((total, item) => total + (Number(item.amount) || 0), 0);
    const avgFixed = (state.fixedCosts || []).filter(item => item.active !== false).reduce((total, item) => total + monthlyEquivalent(item), 0);
    const avgSaving = (state.savings || []).filter(item => item.active !== false).reduce((total, item) => total + monthlyEquivalent(item), 0);
    const avgDebt = (state.debtPayments || []).filter(item => item.active !== false).reduce((total, item) => total + monthlyEquivalent(item), 0);
    const averageBudget = Math.max(0, income - avgFixed - avgSaving - avgDebt);

    const cycleOccurrences = allOccurrences(state, cycle.start, cycle.end).map(occurrence => {
      const payment = recurringPaymentFor(state, occurrence);
      if (payment?.status === 'skipped') return null;
      return payment?.status === 'paid' ? { ...occurrence, amount: Number(payment.amount) || 0 } : occurrence;
    }).filter(Boolean);
    const undatedItems = [
      ...(state.fixedCosts || []).map(item => ({ item, kind: 'fixed' })),
      ...(state.savings || []).map(item => ({ item, kind: 'saving' })),
      ...(state.debtPayments || []).map(item => ({ item, kind: 'debt' }))
    ].filter(entry => entry.item.active !== false && !parseLocalDate(entry.item.dueDate));
    const undatedFallback = undatedItems.reduce((total, entry) => total + monthlyEquivalent(entry.item), 0);
    const cycleRequired = cycleOccurrences.reduce((total, occurrence) => total + occurrence.amount, 0) + undatedFallback;
    const cycleAutoBudget = Math.max(0, income - cycleRequired);
    const requestedManualBudget = Math.max(0, Number(state.settings?.manualBudget) || 0);
    const cycleBudget = state.settings?.budgetMode === 'manual' ? Math.min(cycleAutoBudget, requestedManualBudget) : cycleAutoBudget;

    const cycleTransactions = transactionsBetween(state, cycle.start, cycle.end);
    const spent = cycleTransactions.reduce((total, transaction) => total + transactionConsumption(transaction), 0);
    const remaining = cycleBudget - spent;
    const activeAccounts = (state.accounts || []).filter(account => account.active !== false);
    const cash = activeAccounts.reduce((total, account) => total + (Number(account.balance) || 0), 0);
    const availableCash = activeAccounts.filter(account => account.includeInAvailable !== false).reduce((total, account) => total + (Number(account.balance) || 0), 0);

    const investmentAssets = (state.assets || []).filter(asset => asset.active !== false && INVESTMENT_TYPES.has(asset.type));
    const investments = investmentAssets.reduce((total, asset) => total + (Number(asset.value) || 0), 0);
    const investmentCost = investmentAssets.reduce((total, asset) => total + (Number(asset.costBasis) || 0), 0);
    const investmentCostKnown = investmentAssets.length > 0 && investmentAssets.every(asset => asset.costBasisKnown === true);
    const investmentGain = investmentCostKnown ? investments - investmentCost : null;
    const investmentPct = investmentGain !== null && investmentCost > 0 ? investmentGain / investmentCost * 100 : null;
    const otherAssets = (state.assets || []).filter(asset => asset.active !== false).reduce((total, asset) => total + (Number(asset.value) || 0), 0);
    const liabilities = (state.liabilities || []).filter(item => item.active !== false).reduce((total, item) => total + (Number(item.balance) || 0), 0);
    const assets = cash + otherAssets;
    const netWorth = assets - liabilities;

    const today = atNoon(reference);
    const futureOccurrences = allOccurrences(state, today, addDays(cycle.next, -1)).filter(occurrence => {
      const payment = recurringPaymentFor(state, occurrence);
      return !payment || !['paid', 'skipped'].includes(payment.status);
    });
    const futureDue = futureOccurrences.reduce((total, occurrence) => total + occurrence.amount, 0);
    const accountAvailability = new Map(activeAccounts.map(account => [account.id, account.includeInAvailable !== false]));
    const futureAvailableEffect = futureOccurrences.reduce((total, occurrence) => {
      const amount = Number(occurrence.amount) || 0;
      const sourceEffect = occurrence.accountId ? (accountAvailability.get(occurrence.accountId) ? -amount : 0) : -amount;
      const targetEffect = occurrence.kind === 'saving' && occurrence.targetAccountId && accountAvailability.get(occurrence.targetAccountId) ? amount : 0;
      return total + sourceEffect + targetEffect;
    }, 0);
    const safeUntilSalary = roundMoney(availableCash + futureAvailableEffect);

    return {
      income, avgFixed, avgSaving, avgDebt, averageBudget,
      cycle, cycleOccurrences, cycleRequired, cycleAutoBudget, cycleBudget,
      requestedManualBudget, manualBudgetClamped: requestedManualBudget > cycleAutoBudget,
      cycleTransactions, spent, remaining,
      cash, availableCash, investments, investmentCost, investmentCostKnown, investmentGain, investmentPct,
      assets, liabilities, netWorth,
      futureOccurrences, futureDue, futureAvailableEffect: roundMoney(futureAvailableEffect), safeUntilSalary,
      undatedItems, undatedFallback
    };
  }

  function findById(items, id) {
    return (items || []).find(item => item.id === id) || null;
  }

  function applyTransactionEffects(state, transaction, direction = 1) {
    const amount = (Number(transaction.amount) || 0) * direction;
    const adjustAccount = (accountId, delta) => {
      const account = findById(state.accounts, accountId);
      if (account) account.balance = roundMoney((Number(account.balance) || 0) + delta);
    };
    if (transaction.type === 'expense') adjustAccount(transaction.accountId, -amount);
    else if (transaction.type === 'income' || transaction.type === 'refund') adjustAccount(transaction.accountId, amount);
    else if (transaction.type === 'transfer') {
      adjustAccount(transaction.fromAccountId, -amount);
      adjustAccount(transaction.toAccountId, amount);
    } else if (transaction.type === 'correction') {
      adjustAccount(transaction.accountId, (Number(transaction.adjustment) || 0) * direction);
    }
  }

  function externalFlowValue(flow) {
    const amount = Number(flow?.amount) || 0;
    if (flow?.type === 'contribution' || flow?.type === 'buy') return amount;
    if (flow?.type === 'withdrawal' || flow?.type === 'sell' || flow?.type === 'dividend') return -amount;
    return 0;
  }

  function applyInvestmentFlowEffects(state, flow, direction = 1) {
    const asset = findById(state.assets, flow.assetId);
    const account = findById(state.accounts, flow.accountId);
    const amount = (Number(flow.amount) || 0) * direction;
    if (!asset) return;

    if (flow.type === 'contribution' || flow.type === 'buy') {
      if (account) account.balance = roundMoney(account.balance - amount);
      asset.value = roundMoney((Number(asset.value) || 0) + amount);
      asset.costBasis = roundMoney((Number(asset.costBasis) || 0) + amount);
      asset.costBasisKnown = true;
      if (flow.units) asset.units = Math.max(0, Number(asset.units || 0) + Number(flow.units) * direction);
    } else if (flow.type === 'withdrawal' || flow.type === 'sell') {
      const beforeValue = Number(asset.value) || 0;
      const beforeCost = Number(asset.costBasis) || 0;
      if (direction === 1) {
        const ratio = beforeValue > 0 ? Math.min(1, (Number(flow.amount) || 0) / beforeValue) : 0;
        flow.costBasisReduction = roundMoney(beforeCost * ratio);
      }
      if (account) account.balance = roundMoney(account.balance + amount);
      asset.value = Math.max(0, roundMoney(beforeValue - amount));
      asset.costBasis = Math.max(0, roundMoney(beforeCost - (Number(flow.costBasisReduction) || 0) * direction));
      if (flow.units) asset.units = Math.max(0, Number(asset.units || 0) - Number(flow.units) * direction);
    } else if (flow.type === 'dividend') {
      if (account) account.balance = roundMoney(account.balance + amount);
    } else if (flow.type === 'fee') {
      asset.value = Math.max(0, roundMoney((Number(asset.value) || 0) - amount));
    }
  }

  function calculatePortfolioPeriod(state, range = 'max', reference = new Date()) {
    const history = [...(state.history?.investments || [])].filter(point => parseLocalDate(point.date)).sort((a, b) => a.date.localeCompare(b.date));
    if (!history.length) return { available: false, startValue: 0, endValue: 0, netExternalFlow: 0, gain: 0, percent: null };
    const endDate = atNoon(reference);
    let cutoff = null;
    if (range === '1m') cutoff = addMonthsAnchored(endDate, -1);
    else if (range === '3m') cutoff = addMonthsAnchored(endDate, -3);
    else if (range === '1y') cutoff = makeDate(endDate.getFullYear() - 1, endDate.getMonth(), endDate.getDate());
    const selected = cutoff ? history.filter(point => parseLocalDate(point.date) >= cutoff) : history;
    const points = selected.length ? selected : [history[history.length - 1]];
    const startPoint = points[0];
    const endPoint = points[points.length - 1];
    const startDate = parseLocalDate(startPoint.date);
    const periodDays = Math.max(1, daysBetween(startDate, parseLocalDate(endPoint.date) || endDate));
    const flows = (state.investmentFlows || []).filter(flow => {
      const date = parseLocalDate(flow.date);
      return date && date >= startDate && date <= (parseLocalDate(endPoint.date) || endDate);
    });
    let netExternalFlow = 0;
    let weightedFlow = 0;
    for (const flow of flows) {
      const value = externalFlowValue(flow);
      netExternalFlow += value;
      const elapsed = Math.max(0, daysBetween(startDate, parseLocalDate(flow.date)));
      const weight = Math.max(0, (periodDays - elapsed) / periodDays);
      weightedFlow += value * weight;
    }
    const fees = flows.filter(flow => flow.type === 'fee').reduce((total, flow) => total + (Number(flow.amount) || 0), 0);
    const startValue = Number(startPoint.value) || 0;
    const endValue = Number(endPoint.value) || 0;
    const gain = roundMoney(endValue - startValue - netExternalFlow);
    const denominator = startValue + weightedFlow;
    const percent = denominator > 0 ? gain / denominator * 100 : null;
    return { available: points.length >= 2 || flows.length > 0, startValue, endValue, netExternalFlow: roundMoney(netExternalFlow), fees: roundMoney(fees), gain, percent, points };
  }

  return {
    STATE_VERSION,
    DAY,
    INVESTMENT_TYPES,
    TRANSACTION_TYPES,
    FREQUENCIES,
    BUILTIN_CATEGORIES,
    createDefaultState,
    isPlainObject,
    clamp,
    roundMoney,
    parseMoney,
    parseSignedMoney,
    localISO,
    parseLocalDate,
    atNoon,
    startOfMonth,
    endOfMonth,
    addDays,
    daysInMonth,
    makeDate,
    addMonthsAnchored,
    dateInRange,
    daysBetween,
    monthKey,
    getSalaryCycle,
    previousSalaryCycle,
    monthlyEquivalent,
    yearlyEquivalent,
    occurrenceDates,
    migrateState,
    validateImportPayload,
    occurrencesFrom,
    allOccurrences,
    recurringPaymentFor,
    transactionConsumption,
    transactionsBetween,
    calculateBudget,
    applyTransactionEffects,
    externalFlowValue,
    applyInvestmentFlowEffects,
    calculatePortfolioPeriod
  };
});
