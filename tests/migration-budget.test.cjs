'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

function deterministicIds() {
  let index = 0;
  return prefix => `${prefix}-${++index}`;
}

test('v1.2 wird ohne rückwirkende Kontobelastung nach State 5 migriert', () => {
  const raw = {
    version: 3,
    settings: { salaryDay: 28, customCategories: [] },
    fixedCosts: [{ id: 'fix-1', name: 'Miete', amount: 450, dueDay: 27 }],
    transactions: [{ id: 'tx-1', date: '2026-08-01', amount: 20, category: 'Restaurant', account: 'Sparkasse' }],
    assets: [
      { id: 'cash-1', name: 'Sparkasse', type: 'Konto', value: 1000 },
      { id: 'etf-1', name: 'ETF', type: 'ETF', value: 500, costBasis: 400 }
    ]
  };
  const { state } = Core.migrateState(raw, { idFactory: deterministicIds(), now: new Date(2026, 7, 17, 12) });
  assert.equal(state.version, 5);
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].balance, 1000);
  assert.equal(state.assets.length, 1);
  assert.equal(state.fixedCosts[0].dueDate, '2026-08-27');
  assert.equal(state.transactions[0].category, 'Essen & Trinken');
  assert.equal(state.transactions[0].subcategory, 'Restaurant');
  assert.equal(state.transactions[0].accountId, state.accounts[0].id);
  assert.equal(state.transactions[0].balanceApplied, false);
});

test('unbekannte Kategorien und fehlende IDs bleiben nutzbar', () => {
  const { state } = Core.migrateState({
    version: 4,
    settings: { customCategories: [{}] },
    transactions: [{ date: '2026-08-01', amount: 5, category: 'Hund' }],
    fixedCosts: [{ name: 'Ohne ID', amount: 10 }]
  }, { idFactory: deterministicIds() });
  assert.deepEqual(state.settings.customCategories, ['Hund']);
  assert.match(state.transactions[0].id, /^transaction-/);
  assert.match(state.fixedCosts[0].id, /^fixkosten-/);
});

test('Import lehnt leere, fremde und zukünftige Daten ab', () => {
  assert.equal(Core.validateImportPayload({}).valid, false);
  assert.equal(Core.validateImportPayload(null).valid, false);
  assert.equal(Core.validateImportPayload({ hello: 'world' }).valid, false);
  assert.equal(Core.validateImportPayload({ version: 99, settings: {} }).valid, false);
  assert.equal(Core.validateImportPayload(Core.createDefaultState()).valid, true);
  assert.throws(() => Core.migrateState({ version: 99 }), /neuer als/);
});

test('Ausgaben, Erstattungen und Transfers wirken korrekt auf Konten', () => {
  const state = Core.createDefaultState();
  state.accounts = [
    { id: 'a', balance: 1000 },
    { id: 'b', balance: 200 }
  ];
  Core.applyTransactionEffects(state, { type: 'expense', amount: 50, accountId: 'a' });
  Core.applyTransactionEffects(state, { type: 'refund', amount: 10, accountId: 'a' });
  Core.applyTransactionEffects(state, { type: 'transfer', amount: 100, fromAccountId: 'a', toAccountId: 'b' });
  assert.equal(state.accounts[0].balance, 860);
  assert.equal(state.accounts[1].balance, 300);
});

test('Transfers zählen nicht als Konsum und manuelles Budget wird sichtbar gekappt', () => {
  const state = Core.createDefaultState();
  state.settings.salaryDay = 28;
  state.settings.budgetMode = 'manual';
  state.settings.manualBudget = 2000;
  state.incomes = [{ id: 'income', amount: 1000, active: true }];
  state.transactions = [
    { id: 'expense', date: '2026-08-01', amount: 100, type: 'expense' },
    { id: 'transfer', date: '2026-08-02', amount: 500, type: 'transfer' },
    { id: 'refund', date: '2026-08-03', amount: 20, type: 'refund' }
  ];
  const result = Core.calculateBudget(state, new Date(2026, 7, 17, 12));
  assert.equal(result.spent, 80);
  assert.equal(result.cycleBudget, 1000);
  assert.equal(result.manualBudgetClamped, true);
});

test('eine erhöhte Sparrate ändert bereits bezahlte Monate nicht rückwirkend', () => {
  const state = Core.createDefaultState();
  state.settings.salaryDay = 1;
  state.incomes = [{ id: 'income', amount: 500, active: true }];
  state.savings = [{ id: 'saving', name: 'ETF', amount: 150, frequency: 'monthly', dueDate: '2026-08-05', startDate: '2026-08-05', active: true }];
  state.recurringPayments = [{ id: 'paid', itemId: 'saving', kind: 'saving', date: '2026-08-05', status: 'paid', amount: 100 }];
  const result = Core.calculateBudget(state, new Date(2026, 7, 17, 12));
  assert.equal(result.cycleOccurrences[0].amount, 100);
  assert.equal(result.cycleRequired, 100);
  assert.equal(result.cycleBudget, 400);
});

test('interne Rücklagen-Transfers verändern freie Liquidität nur bei gesperrtem Ziel', () => {
  const makeState = targetAvailable => {
    const state = Core.createDefaultState();
    state.settings.salaryDay = 28;
    state.accounts = [
      { id: 'source', balance: 1000, active: true, includeInAvailable: true },
      { id: 'target', balance: 200, active: true, includeInAvailable: targetAvailable }
    ];
    state.savings = [{ id: 'saving', name: 'Rücklage', type: 'Rücklage', amount: 100, frequency: 'oneTime', dueDate: '2026-08-20', startDate: '2026-08-20', active: true, accountId: 'source', targetAccountId: 'target' }];
    return state;
  };
  assert.equal(Core.calculateBudget(makeState(true), new Date(2026, 7, 17, 12)).safeUntilSalary, 1200);
  assert.equal(Core.calculateBudget(makeState(false), new Date(2026, 7, 17, 12)).safeUntilSalary, 900);
});
