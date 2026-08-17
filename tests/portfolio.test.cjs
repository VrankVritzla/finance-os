'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

test('eine Einzahlung erscheint nicht als Investmentgewinn', () => {
  const state = Core.createDefaultState();
  state.history.investments = [
    { date: '2026-01-01', value: 2000, cost: 1800 },
    { date: '2026-02-01', value: 2500, cost: 2300 }
  ];
  state.investmentFlows = [
    { date: '2026-01-15', type: 'contribution', amount: 500 }
  ];
  const result = Core.calculatePortfolioPeriod(state, 'max', new Date(2026, 1, 1, 12));
  assert.equal(result.gain, 0);
  assert.equal(result.netExternalFlow, 500);
  assert.equal(result.percent, 0);
});

test('Dividenden sind Rendite, Verkäufe allein nicht', () => {
  const dividendState = Core.createDefaultState();
  dividendState.history.investments = [
    { date: '2026-01-01', value: 2000, cost: 1800 },
    { date: '2026-02-01', value: 2000, cost: 1800 }
  ];
  dividendState.investmentFlows = [{ date: '2026-01-15', type: 'dividend', amount: 50 }];
  assert.equal(Core.calculatePortfolioPeriod(dividendState, 'max').gain, 50);

  const saleState = Core.createDefaultState();
  saleState.history.investments = [
    { date: '2026-01-01', value: 2000, cost: 1800 },
    { date: '2026-02-01', value: 1500, cost: 1350 }
  ];
  saleState.investmentFlows = [{ date: '2026-01-15', type: 'sell', amount: 500 }];
  assert.equal(Core.calculatePortfolioPeriod(saleState, 'max').gain, 0);
});

test('Sparratenänderungen erhöhen Wert und Einstand gleich stark', () => {
  const state = Core.createDefaultState();
  state.accounts = [{ id: 'bank', balance: 1000 }];
  state.assets = [{ id: 'etf', type: 'ETF', value: 2000, costBasis: 1800, costBasisKnown: true, units: 10 }];
  const first = { assetId: 'etf', accountId: 'bank', type: 'contribution', amount: 100, units: 0, price: 0 };
  const increased = { assetId: 'etf', accountId: 'bank', type: 'contribution', amount: 150, units: 0, price: 0 };
  Core.applyInvestmentFlowEffects(state, first);
  Core.applyInvestmentFlowEffects(state, increased);
  assert.equal(state.accounts[0].balance, 750);
  assert.equal(state.assets[0].value, 2250);
  assert.equal(state.assets[0].costBasis, 2050);
  assert.equal(state.assets[0].value - state.assets[0].costBasis, 200);
});
