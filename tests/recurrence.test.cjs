'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

const date = Core.parseLocalDate;
const occurrences = (item, start, end) => Core.occurrenceDates(item, date(start), date(end)).map(Core.localISO);

test('monatlich am 31. klemmt nur den jeweiligen Monat', () => {
  assert.deepEqual(occurrences({ dueDate: '2026-01-31', startDate: '2026-01-31', frequency: 'monthly', active: true }, '2026-01-01', '2026-04-30'), [
    '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'
  ]);
});

test('Schaltjahr, jährlich, Quartal und vier Wochen', () => {
  assert.deepEqual(occurrences({ dueDate: '2024-02-29', startDate: '2024-02-29', frequency: 'yearly' }, '2024-01-01', '2028-12-31'), [
    '2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29'
  ]);
  assert.deepEqual(occurrences({ dueDate: '2026-01-31', startDate: '2026-01-31', frequency: 'quarterly' }, '2026-01-01', '2027-01-31'), [
    '2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31', '2027-01-31'
  ]);
  assert.deepEqual(occurrences({ dueDate: '2026-01-05', startDate: '2026-01-05', frequency: 'fourweekly' }, '2026-01-01', '2026-03-31'), [
    '2026-01-05', '2026-02-02', '2026-03-02', '2026-03-30'
  ]);
});

test('Start, Ende und Pausierung begrenzen Wiederholungen', () => {
  assert.deepEqual(occurrences({ dueDate: '2026-12-15', startDate: '2026-12-15', frequency: 'monthly' }, '2026-07-01', '2026-09-30'), []);
  assert.deepEqual(occurrences({ dueDate: '2026-01-15', startDate: '2026-02-01', endDate: '2026-03-20', frequency: 'monthly' }, '2026-01-01', '2026-05-31'), [
    '2026-02-15', '2026-03-15'
  ]);
  assert.deepEqual(occurrences({ dueDate: '2026-01-15', frequency: 'monthly', active: false }, '2026-01-01', '2026-12-31'), []);
});

test('Ungültige Ankerdaten erzeugen keine Fälligkeiten', () => {
  assert.deepEqual(occurrences({ dueDate: '2026-02-31', frequency: 'oneTime' }, '2026-01-01', '2026-12-31'), []);
});
