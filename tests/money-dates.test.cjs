'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

test('parseMoney versteht deutsche und internationale Geldeingaben', () => {
  const cases = {
    '12': 12,
    '12,5': 12.5,
    '12.50': 12.5,
    '123,45': 123.45,
    '123.45': 123.45,
    '1.234': 1234,
    '1.234,56': 1234.56,
    '1,234.56': 1234.56,
    '1234567,89': 1234567.89,
    '1.234.567,89': 1234567.89
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(Core.parseMoney(input), expected, input);
});

test('parseMoney lehnt leere und strukturell falsche Eingaben ab', () => {
  for (const input of ['', '   ', '1.23.4', '1,23,4', '12,3456', '-12', 'abc']) {
    assert.equal(Number.isNaN(Core.parseMoney(input)), true, input);
  }
});

test('parseSignedMoney erlaubt negative Kontostände, ohne Ausgabenparser zu lockern', () => {
  assert.equal(Core.parseSignedMoney('-1.234,56'), -1234.56);
  assert.equal(Core.parseSignedMoney('250,10'), 250.1);
  assert.equal(Number.isNaN(Core.parseSignedMoney('--12')), true);
  assert.equal(Number.isNaN(Core.parseMoney('-12')), true);
});

test('parseLocalDate validiert reale lokale Kalendertage', () => {
  assert.equal(Core.localISO(Core.parseLocalDate('2024-02-29')), '2024-02-29');
  assert.equal(Core.parseLocalDate('2026-02-29'), null);
  assert.equal(Core.parseLocalDate('2026-02-31'), null);
  assert.equal(Core.parseLocalDate('2026-00-10'), null);
});

test('Gehaltstag 31 bleibt über Februar und Jahreswechsel verankert', () => {
  const feb = Core.getSalaryCycle(31, new Date(2026, 1, 28, 12));
  assert.equal(Core.localISO(feb.start), '2026-02-28');
  assert.equal(Core.localISO(feb.end), '2026-03-30');
  assert.equal(Core.localISO(feb.next), '2026-03-31');

  const january = Core.getSalaryCycle(31, new Date(2027, 0, 15, 12));
  assert.equal(Core.localISO(january.start), '2026-12-31');
  assert.equal(Core.localISO(january.end), '2027-01-30');
});
