import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_CATALOG, TOTAL_COMBINATIONS, fitModel, getProbabilities, generatePrediction, groupProbability, walkForwardEvaluate, trainModels } from '../src/models.mjs';

function fixture(count = 240) {
  let state = 1234567;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  return Array.from({ length: count }, (_, index) => {
    const red = Array.from({ length: 33 }, (_, i) => i + 1);
    for (let i = red.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [red[i], red[j]] = [red[j], red[i]]; }
    return { issue: String(2020001 + index), date: new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10),
      red: red.slice(0, 6).sort((a, b) => a - b), blue: 1 + Math.floor(random() * 16) };
  });
}

function close(a, b, tolerance = 1e-10) { assert.ok(Math.abs(a - b) < tolerance, `${a} is not close to ${b}`); }

test('uniform model matches the exact full-result probability and marginal sums', () => {
  const fitted = fitModel([], { model: 'uniform' });
  const probabilities = getProbabilities(fitted);
  for (const value of probabilities.red) close(value, 6 / 33);
  for (const value of probabilities.blue) close(value, 1 / 16);
  close(probabilities.red.reduce((sum, value) => sum + value, 0), 6);
  close(probabilities.blue.reduce((sum, value) => sum + value, 0), 1);
  close(groupProbability(fitted, { red: [1, 2, 3, 4, 5, 6], blue: 1 }), 1 / TOTAL_COMBINATIONS, 1e-20);
});

test('smoothed full-history and decay models have coherent positive probabilities', () => {
  for (const model of ['bayes', 'decay']) {
    const fitted = fitModel(fixture(), { model, strength: 20, halfLife: 30 });
    const probabilities = getProbabilities(fitted);
    close(probabilities.red.reduce((sum, value) => sum + value, 0), 6);
    close(probabilities.blue.reduce((sum, value) => sum + value, 0), 1);
    assert.ok(probabilities.red.every(value => value > 0 && value < 1));
    assert.ok(probabilities.blue.every(value => value > 0 && value < 1));
    assert.equal(fitted.dataCutoff, '2020240');
  }
});

test('generated groups remain within the candidate pool, are reproducible, and never duplicate', () => {
  const fitted = fitModel(fixture(), { model: 'bayes' });
  const options = { redCount: 8, blueCount: 3, groupCount: 50, seed: 'repeatable' };
  const result = generatePrediction(fitted, options);
  assert.deepEqual(result, generatePrediction(fitted, options));
  assert.equal(result.coverageCombinations, 84);
  close(result.candidatePoolFairJackpotProbability, 84 / TOTAL_COMBINATIONS);
  close(result.fairJackpotProbability, 50 / TOTAL_COMBINATIONS);
  const keys = new Set();
  for (const group of result.groups) {
    assert.equal(group.red.length, 6);
    assert.equal(new Set(group.red).size, 6);
    assert.ok(group.red.every(number => result.redCandidates.includes(number)));
    assert.ok(result.blueCandidates.includes(group.blue));
    keys.add(`${group.red}|${group.blue}`);
  }
  assert.equal(keys.size, 50);
});

test('default candidate pool supports exactly one group and capacity is enforced', () => {
  const fitted = fitModel([], { model: 'uniform' });
  assert.equal(generatePrediction(fitted).groups.length, 1);
  assert.throws(() => generatePrediction(fitted, { groupCount: 2 }), /只有 1 种/);
  assert.throws(() => generatePrediction(fitted, { redCount: 5 }), /红球候选/);
  assert.throws(() => generatePrediction(fitted, { blueCount: 17 }), /蓝球候选/);
  assert.throws(() => generatePrediction(fitted, { groupCount: 101 }), /完整号码组数/);
  assert.throws(() => fitModel([], { model: 'decay', halfLife: 0 }), /半衰期/);
});

test('large full-space candidate pool is sampled without expanding millions of combinations', () => {
  const fitted = fitModel(fixture(), { model: 'decay' });
  const prediction = generatePrediction(fitted, { redCount: 33, blueCount: 16, groupCount: 100, seed: 'all' });
  assert.equal(prediction.groups.length, 100);
  assert.equal(prediction.coverageCombinations, TOTAL_COMBINATIONS);
  close(prediction.candidatePoolFairJackpotProbability, 1);
  close(prediction.candidatePoolModelProbability, 1);
  assert.equal(new Set(prediction.groups.map(group => `${group.red}|${group.blue}`)).size, 100);
});

test('conditional subset sampler empirically follows exact marginals', () => {
  const history = fixture();
  const fitted = fitModel(history, { model: 'decay', halfLife: 30, strength: 20 });
  // Each draw is an independent call, not 100 distinct groups from one call.
  const hits = new Array(33).fill(0);
  const repetitions = 4500;
  for (let index = 0; index < repetitions; index++) {
    const prediction = generatePrediction(fitted, { redCount: 33, blueCount: 16, seed: `mc:${index}` });
    for (const number of prediction.groups[0].red) hits[number - 1]++;
  }
  for (let index = 0; index < 33; index++) close(hits[index] / repetitions, fitted.redProbabilities[index], 0.035);
});

test('walk-forward scores cannot see future rows and every fit cutoff precedes its target', () => {
  const draws = fixture();
  const changed = structuredClone(draws);
  for (let index = 180; index < changed.length; index++) { changed[index].red = [1, 2, 3, 4, 5, 6]; changed[index].blue = 16; }
  const options = { model: 'decay', start: 120, end: 180, strength: 100, halfLife: 30 };
  const before = walkForwardEvaluate(draws, options);
  assert.deepEqual(before, walkForwardEvaluate(changed, options));
  for (const row of before) assert.ok(row.trainedThrough < row.issue);
  const target = 150;
  const direct = fitModel(draws.slice(0, target), options);
  close(before[target - 120].loss, -Math.log(groupProbability(direct, draws[target])));
});

test('changing only the held-out test suffix cannot change selected parameters or validation-selected model', () => {
  const draws = fixture(240);
  const changedTest = structuredClone(draws);
  for (let index = 180; index < changedTest.length; index++) { changedTest[index].red = [1, 2, 3, 4, 5, 6]; changedTest[index].blue = 16; }
  const a = trainModels(draws, { now: '2026-10-30T00:00:00Z' });
  const b = trainModels(changedTest, { now: '2026-10-30T00:00:00Z' });
  assert.equal(a.report.split.test.count, 60);
  assert.equal(a.report.split.validation.count, 60);
  assert.deepEqual(a.report.selectedParams, b.report.selectedParams);
  assert.equal(a.report.validationSelectedModel, b.report.validationSelectedModel);
  assert.deepEqual(a.report.trials, b.report.trials);
  assert.notEqual(a.dataHash, b.dataHash);
  assert.notEqual(a.report.scores.find(row => row.id === 'bayes').testLogLoss, b.report.scores.find(row => row.id === 'bayes').testLogLoss);
  assert.ok(['uniform', a.report.validationSelectedModel].includes(a.recommendedModel));
  assert.ok(a.report.scores.every(row => Number.isFinite(row.testLogLoss)));
  assert.equal(a.models.bayes.dataCutoff, draws.at(-1).issue);
  assert.throws(() => trainModels(draws.slice(0, 199)), /至少需要 200 期/);
});

test('all models run with defaults while only parameterized models support optional training', () => {
  for (const entry of MODEL_CATALOG) {
    assert.equal(entry.trainingRequired, false);
    assert.equal(entry.supportsTraining, entry.id !== 'uniform');
    const fitted = fitModel(fixture(20), { model: entry.id });
    assert.equal(generatePrediction(fitted, { seed: 'defaults' }).groups.length, 1);
  }
});

test('bad fitted state and out-of-order input are rejected', () => {
  assert.throws(() => fitModel(fixture().reverse()), /递增/);
  assert.throws(() => getProbabilities({ id: 'uniform' }), /不完整/);
  assert.throws(() => groupProbability(fitModel([], { model: 'uniform' }), { red: [1, 1, 2, 3, 4, 5], blue: 1 }), /不合法/);
});
