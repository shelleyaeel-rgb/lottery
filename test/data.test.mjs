import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { datasetHash, fetchLatestOfficialDraw, importData, loadData, parseImport, parseShanghai, validateDraws } from '../src/data.mjs';

const one = { issue: '2026001', date: '2026-01-01', red: [1, 2, 3, 4, 5, 6], blue: 1 };
const two = { issue: '2026002', date: '2026-01-04', red: [7, 8, 9, 10, 11, 12], blue: 16 };
const now = new Date('2026-10-30T00:00:00+08:00');

async function temporary(action) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ssq-data-test-'));
  try { return await action(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('validates, normalizes, orders and deduplicates draws', () => {
  const result = validateDraws([two, { code: '2026001', date: '2026-01-01(四)', red: '06,05,04,03,02,01', blue: '01' }, one], { now });
  assert.deepEqual(result, [one, two]);
});

test('rejects conflicts, invalid red/blue/date, future records and date reversal', () => {
  assert.throws(() => validateDraws([one, { ...one, blue: 2 }], { now }), /冲突/);
  assert.throws(() => validateDraws([{ ...one, red: [1, 2, 3, 4, 5, 5] }], { now }), /不同整数/);
  assert.throws(() => validateDraws([{ ...one, blue: 17 }], { now }), /1—16/);
  assert.throws(() => validateDraws([{ ...one, date: '2026-02-30' }], { now }), /不存在/);
  assert.throws(() => validateDraws([{ ...one, date: '2027-01-01', issue: '2027001' }], { now }), /范围/);
  assert.throws(() => validateDraws([one, { ...two, date: '2026-01-01' }], { now }), /递增/);
  assert.throws(() => validateDraws([{ ...one, blue: '1x' }], { now }), /整数/);
});

test('parses Chinese CSV, quoted comma-separated red balls and JSON envelopes', () => {
  const csv = '\uFEFF期号,开奖日期,红球,蓝球\r\n2026001,2026/1/1,"01,02,03,04,05,06",01\r\n';
  assert.deepEqual(validateDraws(parseImport(csv), { now }), [one]);
  assert.deepEqual(parseImport(JSON.stringify({ draws: [one] })), [one]);
  assert.throws(() => parseImport('issue,date,red,blue\n2026001,2026-01-01,"1 2 3'), /未闭合/);
  assert.throws(() => parseImport('issue,date,red,blue\n1,2,3,4,5'), /列数/);
});

test('merges imports with provenance and preserves original data on conflict', async () => temporary(async directory => {
  const initial = await importData(directory, [one], { source: '测试导入', now });
  assert.equal(initial.summary.count, 1);
  const merged = await importData(directory, [two, one], { now });
  assert.equal(merged.summary.count, 2);
  assert.equal(merged.provenance.sources.length, 2);
  assert.equal(merged.provenance.sources[1].addedCount, 1);
  assert.equal(merged.provenance.datasetHash, datasetHash([one, two]));
  assert.equal(merged.provenance.sources[0].type, 'import');
  const raw = await readFile(path.join(directory, merged.provenance.sources[0].rawFile), 'utf8');
  assert.equal(raw, JSON.stringify([one]));
  await assert.rejects(importData(directory, [{ ...one, blue: 9 }], { now }), /冲突/);
  assert.deepEqual((await loadData(directory)).draws, [one, two]);
}));

test('concurrent import operations do not lose records', async () => temporary(async directory => {
  await Promise.all([importData(directory, [one], { now }), importData(directory, [two], { now })]);
  assert.equal((await loadData(directory)).summary.count, 2);
}));

test('detects tampering and reports missing issues', async () => temporary(async directory => {
  const third = { ...two, issue: '2026003' };
  const result = await importData(directory, [one, third], { now });
  assert.deepEqual(result.summary.missingIssues, ['2026002']);
  const file = path.join(directory, 'draws.json');
  const snapshot = JSON.parse(await readFile(file, 'utf8'));
  snapshot.draws[0].blue = 2;
  await writeFile(file, JSON.stringify(snapshot));
  await assert.rejects(loadData(directory), /哈希不匹配/);
}));

test('Shanghai parsing treats remote script as data without executing it', () => {
  const text = "employee.push({'id':'2026001','c':'01,02,03,04,05,06|01','t':'2026-01-01 21:15:00','x':'x'}); throw new Error('do not execute');";
  assert.deepEqual(parseShanghai(text), [one]);
});

test('latest official check requests exactly one draw and normalizes it', async t => {
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    assert.equal(url.hostname, 'www.cwl.gov.cn');
    assert.equal(url.searchParams.get('issueCount'), '1');
    assert.equal(url.searchParams.get('pageSize'), '1');
    return new Response(JSON.stringify({ state: 0, result: [{ code: one.issue, date: `${one.date}(四)`, red: one.red.join(','), blue: '01' }] }));
  });
  const result = await fetchLatestOfficialDraw();
  assert.deepEqual(result.draw, one);
  assert.ok(Number.isFinite(new Date(result.checkedAt).getTime()));
});

test('latest official check fails closed on network and malformed results', async t => {
  const mocked = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network unavailable'); });
  await assert.rejects(fetchLatestOfficialDraw(), /无法核验中国福彩最新一期/);
  mocked.mock.mockImplementation(async () => new Response(JSON.stringify({ state: 0, result: [] })));
  await assert.rejects(fetchLatestOfficialDraw(), /不能封存预测/);
  mocked.mock.mockImplementation(async () => new Response(JSON.stringify({ state: 0, result: [{ ...one, red: [1] }] })));
  await assert.rejects(fetchLatestOfficialDraw(), /6 个不同整数/);
});
