import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { suggestedTarget, validateTarget, evaluateRecord, saveRecord, loadRecords, digest } from '../src/workspace.mjs';
import { fitModel } from '../src/models.mjs';

// Synthetic data exists only inside isolated automated tests.
const draws = [{ issue: '2026124', date: '2026-10-29', red: [1, 2, 3, 4, 5, 6], blue: 1 }];
const now = new Date('2026-10-30T10:00:00+08:00');
const target = { targetIssue: '2026125', drawAt: '2026-11-01T21:15:00+08:00' };

async function temporary(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'ssq-workspace-test-'));
  t.after(async () => {
    const resolved = path.resolve(folder);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('ssq-workspace-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return folder;
}

test('next target follows Shanghai calendar and supports year rollover', () => {
  assert.equal(suggestedTarget(draws, now).drawAt, target.drawAt);
  assert.equal(suggestedTarget(draws, now).issue, target.targetIssue);
  assert.equal(suggestedTarget([{ ...draws[0], issue: '2026153', date: '2026-12-31' }], now).issue, '2027001');
  assert.deepEqual(validateTarget(draws, target, now), target);
});

test('past results, moving dates, late times and second normalization cannot backfill predictions', () => {
  assert.throws(() => validateTarget(draws, target, new Date('2026-11-01T21:15:00+08:00')), /已到/);
  assert.throws(() => validateTarget(draws, { ...target, drawAt: '2026-11-01T23:59:00+08:00' }, new Date('2026-11-01T21:30:00+08:00')), /延后/);
  assert.throws(() => validateTarget(draws, { ...target, drawAt: '2026-11-01T21:15:59+08:00' }, new Date('2026-11-01T21:15:30+08:00')), /延后/);
  assert.throws(() => validateTarget(draws, { ...target, drawAt: '2026-11-03T21:15:00+08:00' }, new Date('2026-11-02T10:00:00+08:00')), /挪动日期/);
  assert.throws(() => validateTarget(draws, { ...target, targetIssue: '2026126' }, now), /不能跳期/);
  assert.throws(() => validateTarget(draws, { ...target, targetIssue: '2026124' }, now), /晚于/);
  assert.throws(() => validateTarget(draws, { ...target, drawAt: '2026-11-01T21:15:00Z' }, now), /时区/);
});

test('records are non-overwritable, snapshot their input, and detect edited contents', async t => {
  const dataDir = await temporary(t);
  const record = { id: 'abc-123', createdAt: now.toISOString(), ...target, dataHash: digest(draws), selection: { groups: [{ red: [1, 2, 3, 4, 5, 6], blue: 1 }] } };
  await saveRecord(dataDir, record, draws);
  await assert.rejects(saveRecord(dataDir, record, draws), { code: 'EEXIST' });
  const stored = await loadRecords(dataDir, draws);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].evaluation, null);
  const snapshot = JSON.parse(await readFile(path.join(dataDir, 'snapshots', `${digest(draws)}.json`), 'utf8'));
  assert.deepEqual(snapshot.draws, draws);
  const file = path.join(dataDir, 'predictions', `${record.id}.json`);
  const modified = JSON.parse(await readFile(file, 'utf8'));
  modified.selection.groups[0].blue = 9;
  await writeFile(file, JSON.stringify(modified));
  await assert.rejects(loadRecords(dataDir, draws), /校验失败/);
});

test('evaluation scores the original saved groups and rejects late or wrong-date records', () => {
  const record = { createdAt: now.toISOString(), ...target, fittedModel: fitModel(draws, { model: 'uniform' }), selection: { groups: [{ red: [1, 2, 3, 4, 5, 6], blue: 1 }, { red: [2, 3, 4, 5, 6, 7], blue: 2 }] } };
  const actual = [{ ...draws[0], issue: '2026125', date: '2026-11-01' }];
  const result = evaluateRecord(record, actual);
  assert.equal(result.jackpotHits, 1);
  assert.ok(Math.abs(result.metrics.improvement) < 1e-10);
  assert.deepEqual(result.groups[1], { redHits: 5, blueHit: false });
  assert.equal(evaluateRecord({ ...record, createdAt: '2026-11-01T21:16:00+08:00' }, actual).status, 'late');
  assert.equal(evaluateRecord({ ...record, drawAt: '2026-11-03T21:15:00+08:00' }, actual).status, 'date_mismatch');
});
