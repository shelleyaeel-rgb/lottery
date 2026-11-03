import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';
import { importData } from '../src/data.mjs';
import { fitModel } from '../src/models.mjs';
import { atomicJson, digest, ENGINE_VERSION } from '../src/workspace.mjs';

const draws = [
  { issue: '2026123', date: '2026-10-27', red: [1, 2, 3, 4, 5, 6], blue: 1 },
  { issue: '2026124', date: '2026-10-29', red: [7, 8, 9, 10, 11, 12], blue: 2 },
];
const prediction = { model: 'bayes', useTrained: false, redCount: 8, blueCount: 2, groupCount: 5, targetIssue: '2026125', drawAt: '2026-11-01T21:15:00+08:00', seed: 'isolated-test' };

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ssq-server-test-'));
  await importData(dataDir, draws, { source: '仅自动化测试使用的模拟数据' });
  const server = createApp({ dataDir, clock: () => new Date('2026-10-30T10:00:00+08:00'), verifyLatest: async () => ({ draw: draws.at(-1), checkedAt: '2026-10-30T02:00:00Z', url: 'test://official-source-mock' }), ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(dataDir);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('ssq-server-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  async function post(route, body, headers = {}) {
    const response = await fetch(`${url}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  return { dataDir, url, post };
}

test('API previews valid probabilities, seals reproducible predictions and returns saved history', async t => {
  const { url, post } = await setup(t);
  const preview = await post('/api/preview', { model: 'bayes' });
  assert.equal(preview.status, 200);
  assert.ok(Math.abs(preview.data.probabilities.red.reduce((a, b) => a + b) - 6) < 1e-10);
  const saved = await post('/api/predict', prediction);
  assert.equal(saved.status, 201, saved.data.error);
  const record = saved.data.record;
  assert.equal(record.selection.groups.length, 5);
  assert.equal(record.selection.coverageCombinations, 56);
  assert.equal(record.selection.fairJackpotProbability, 56 / 17721088);
  assert.equal(record.selection.groupJackpotProbability, 5 / 17721088);
  assert.ok(record.contentHash && record.dataHash && record.officialCheck);
  const downloaded = await (await fetch(`${url}/api/predictions/${record.id}`)).json();
  assert.deepEqual(downloaded.selection.groups, record.selection.groups);
  const state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.predictions.length, 1);
  assert.equal(state.predictions[0].evaluation, null);
});

test('invalid pools, insufficient training data, and cross-site writes are rejected', async t => {
  const { post } = await setup(t);
  const invalid = await post('/api/predict', { ...prediction, redCount: 6, blueCount: 1, groupCount: 5 });
  assert.equal(invalid.status, 400);
  assert.match(invalid.data.error, /只有 1/);
  assert.equal((await post('/api/train', {})).status, 400);
  assert.equal((await post('/api/predict', prediction, { Origin: 'https://unrelated.example' })).status, 403);
});

test('official-source mismatch or outage prevents any pre-draw record', async t => {
  for (const verifyLatest of [async () => ({ draw: draws[0] }), async () => { throw new Error('官方来源不可用'); }]) {
    const { url, post } = await setup(t, { verifyLatest });
    const result = await post('/api/predict', prediction);
    assert.equal(result.status, 400);
    const state = await (await fetch(`${url}/api/state`)).json();
    assert.equal(state.predictions.length, 0);
  }
});

test('clock is checked again after the official request completes', async t => {
  let now = new Date('2026-11-01T21:14:59+08:00');
  const { url, post } = await setup(t, {
    clock: () => now,
    verifyLatest: async () => { now = new Date('2026-11-01T21:15:01+08:00'); return { draw: draws.at(-1) }; },
  });
  const result = await post('/api/predict', prediction);
  assert.equal(result.status, 400);
  assert.match(result.data.error, /已到/);
  assert.equal((await (await fetch(`${url}/api/state`)).json()).predictions.length, 0);
});

test('changed data and engine version invalidate previously fitted parameters', async t => {
  const { dataDir, url, post } = await setup(t);
  const artifact = { id: 'test-training', dataHash: digest(draws), engineVersion: ENGINE_VERSION, models: { bayes: fitModel(draws) }, report: { reason: 'isolated test' } };
  await atomicJson(path.join(dataDir, 'models', 'latest.json'), artifact);
  assert.equal((await (await fetch(`${url}/api/state`)).json()).training.stale, false);
  assert.equal((await post('/api/train', {})).data.reused, true);
  assert.equal((await post('/api/preview', { model: 'bayes', useTrained: true })).status, 200);
  await importData(dataDir, [{ issue: '2026122', date: '2026-10-25', red: [1, 3, 5, 7, 9, 11], blue: 3 }]);
  assert.equal((await (await fetch(`${url}/api/state`)).json()).training.stale, true);
  assert.equal((await post('/api/preview', { model: 'bayes', useTrained: true })).status, 400);
  await atomicJson(path.join(dataDir, 'models', 'latest.json'), { ...artifact, engineVersion: 'obsolete' });
  assert.equal((await post('/api/preview', { model: 'bayes', useTrained: true })).status, 400);
});
