import { createHash, randomBytes } from 'node:crypto';

export const TOTAL_COMBINATIONS = 17_721_088;
export const MODEL_VERSION = 'conditional-subset-v1';
export const MODEL_CATALOG = [
  { id: 'uniform', name: '均匀随机基线', description: '每种合法完整组合等概率，不读取历史频次，也不需要训练。', trainingRequired: false, supportsTraining: false },
  { id: 'bayes', name: '贝叶斯平滑概率模型', description: '将全历史号码频次向均匀先验收缩，再构造固定 6 个红球的联合概率模型。可直接使用默认参数；可选训练只选择平滑强度。', trainingRequired: false, supportsTraining: true },
  { id: 'decay', name: '近期衰减平滑模型', description: '在平滑模型上降低较早数据的权重。可直接使用默认参数；可选训练选择平滑强度和半衰期。', trainingRequired: false, supportsTraining: true },
];

const RED_SIZE = 33;
const BLUE_SIZE = 16;
const RED_PICK = 6;
const DEFAULT_STRENGTH = 100;
const DEFAULT_HALF_LIFE = 100;

function requireInteger(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name}必须是 ${min} 至 ${max} 的整数。`);
  }
}

function requireDraws(draws) {
  if (!Array.isArray(draws)) throw new Error('开奖数据必须是数组。');
  let lastIssue = '';
  for (const draw of draws) {
    if (!draw || !/^\d{7}$/.test(String(draw.issue)) || String(draw.issue) <= lastIssue) {
      throw new Error('开奖期号必须唯一并按时间递增。');
    }
    if (!Array.isArray(draw.red) || draw.red.length !== 6 || new Set(draw.red).size !== 6 ||
        draw.red.some(number => !Number.isInteger(number) || number < 1 || number > 33) ||
        !Number.isInteger(draw.blue) || draw.blue < 1 || draw.blue > 16) {
      throw new Error(`第 ${draw.issue} 期号码不合法。`);
    }
    lastIssue = String(draw.issue);
  }
}

function parameters(options = {}) {
  const model = options.model ?? 'bayes';
  if (!MODEL_CATALOG.some(entry => entry.id === model)) throw new Error('未知概率模型。');
  const strength = options.strength ?? DEFAULT_STRENGTH;
  const halfLife = model === 'decay' ? (options.halfLife ?? DEFAULT_HALF_LIFE) : null;
  if (model !== 'uniform' && (!Number.isFinite(strength) || strength < 1 || strength > 1_000_000)) {
    throw new Error('平滑强度必须为 1 至 1000000 的有限数值。');
  }
  if (model === 'decay' && (!Number.isFinite(halfLife) || halfLife < 1 || halfLife > 100_000)) {
    throw new Error('半衰期必须为 1 至 100000 的有限期数。');
  }
  return { model, strength, halfLife };
}

/** Elementary symmetric polynomials: e[k] = sum of products of all k-subsets. */
function elementary(weights, size = RED_PICK) {
  const coefficients = new Array(size + 1).fill(0);
  coefficients[0] = 1;
  for (const weight of weights) {
    for (let count = size; count >= 1; count--) coefficients[count] += weight * coefficients[count - 1];
  }
  return coefficients;
}

function subsetTables(weights, size = RED_PICK) {
  const prefix = Array.from({ length: weights.length + 1 }, () => new Array(size + 1).fill(0));
  const suffix = Array.from({ length: weights.length + 1 }, () => new Array(size + 1).fill(0));
  prefix[0][0] = 1;
  suffix[weights.length][0] = 1;
  for (let index = 0; index < weights.length; index++) {
    prefix[index + 1][0] = 1;
    for (let count = 1; count <= size; count++) {
      prefix[index + 1][count] = prefix[index][count] + weights[index] * prefix[index][count - 1];
    }
  }
  for (let index = weights.length - 1; index >= 0; index--) {
    suffix[index][0] = 1;
    for (let count = 1; count <= size; count++) {
      suffix[index][count] = suffix[index + 1][count] + weights[index] * suffix[index + 1][count - 1];
    }
  }
  return { prefix, suffix, normalizer: suffix[0][size] };
}

function redMarginals(weights) {
  const { prefix, suffix, normalizer } = subsetTables(weights);
  return weights.map((weight, index) => {
    let excluded = 0;
    for (let count = 0; count < RED_PICK; count++) {
      excluded += prefix[index][count] * suffix[index + 1][RED_PICK - 1 - count];
    }
    return weight * excluded / normalizer;
  });
}

function emptyState(options) {
  return { red: new Array(RED_SIZE).fill(0), blue: new Array(BLUE_SIZE).fill(0), effectiveCount: 0,
    count: 0, dataCutoff: null, factor: options.model === 'decay' ? 2 ** (-1 / options.halfLife) : 1 };
}

function consume(state, draw) {
  if (state.factor !== 1) {
    for (let index = 0; index < RED_SIZE; index++) state.red[index] *= state.factor;
    for (let index = 0; index < BLUE_SIZE; index++) state.blue[index] *= state.factor;
  }
  state.effectiveCount = state.effectiveCount * state.factor + 1;
  for (const number of draw.red) state.red[number - 1] += 1;
  state.blue[draw.blue - 1] += 1;
  state.count += 1;
  state.dataCutoff = String(draw.issue);
}

function fittedFromState(state, options, includeMarginals = true) {
  let redWeights = new Array(RED_SIZE).fill(1);
  let blueProbabilities = new Array(BLUE_SIZE).fill(1 / BLUE_SIZE);
  if (options.model !== 'uniform') {
    const denominator = state.effectiveCount + options.strength;
    // Independent beta posterior means are used as input weights, then conditioned
    // on exactly six successes. They are NOT presented as the final marginals.
    redWeights = state.red.map(count => {
      const mean = (count + options.strength * RED_PICK / RED_SIZE) / denominator;
      return mean / (1 - mean);
    });
    const meanWeight = redWeights.reduce((sum, value) => sum + value, 0) / RED_SIZE;
    redWeights = redWeights.map(value => value / meanWeight);
    blueProbabilities = state.blue.map(count => (count + options.strength / BLUE_SIZE) / denominator);
  }
  const normalizer = elementary(redWeights)[RED_PICK];
  return {
    id: options.model,
    version: MODEL_VERSION,
    params: { strength: options.model === 'uniform' ? null : options.strength, halfLife: options.halfLife },
    observationCount: state.count,
    effectiveCount: state.effectiveCount,
    dataCutoff: state.dataCutoff,
    redWeights,
    redProbabilities: includeMarginals ? redMarginals(redWeights) : undefined,
    blueProbabilities,
    normalizer,
    probabilityMeaning: '模型估计；红球为进入当期 6 个红球的边际概率，合计为 6，蓝球概率合计为 1。',
  };
}

export function fitModel(draws, options = {}) {
  requireDraws(draws);
  const settings = parameters(options);
  const state = emptyState(settings);
  for (const draw of draws) consume(state, draw);
  return fittedFromState(state, settings);
}

function requireFitted(fitted) {
  if (!fitted || !MODEL_CATALOG.some(model => model.id === fitted.id) ||
      !Array.isArray(fitted.redWeights) || fitted.redWeights.length !== RED_SIZE ||
      fitted.redWeights.some(value => !Number.isFinite(value) || value <= 0) ||
      !Array.isArray(fitted.blueProbabilities) || fitted.blueProbabilities.length !== BLUE_SIZE ||
      fitted.blueProbabilities.some(value => !Number.isFinite(value) || value <= 0) ||
      Math.abs(fitted.blueProbabilities.reduce((sum, value) => sum + value, 0) - 1) > 1e-8) {
    throw new Error('模型文件不完整或概率参数无效，请重新训练。');
  }
}

export function getProbabilities(fitted) {
  requireFitted(fitted);
  return { red: redMarginals(fitted.redWeights), blue: [...fitted.blueProbabilities] };
}

/** The full probability of ONE exact six-red / one-blue result under this model. */
export function groupProbability(fitted, group) {
  requireFitted(fitted);
  if (!group || !Array.isArray(group.red) || group.red.length !== 6 || new Set(group.red).size !== 6 ||
      group.red.some(number => !Number.isInteger(number) || number < 1 || number > 33) ||
      !Number.isInteger(group.blue) || group.blue < 1 || group.blue > 16) throw new Error('完整号码组合不合法。');
  const redMass = group.red.reduce((product, number) => product * fitted.redWeights[number - 1], 1);
  return redMass / elementary(fitted.redWeights)[6] * fitted.blueProbabilities[group.blue - 1];
}

function negativeLogLikelihood(fitted, draw) {
  let loss = Math.log(fitted.normalizer) - Math.log(fitted.blueProbabilities[draw.blue - 1]);
  for (const number of draw.red) loss -= Math.log(fitted.redWeights[number - 1]);
  return loss;
}

/** Seeded generator is for reproducibility, not secrecy. */
function randomGenerator(seed) {
  const hash = createHash('sha256').update(String(seed)).digest();
  let a = hash.readUInt32LE(0), b = hash.readUInt32LE(4), c = hash.readUInt32LE(8), d = hash.readUInt32LE(12);
  return () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let value = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    value = (value + d) | 0;
    c = (c + value) | 0;
    return ((value >>> 0) + 0.5) / 4294967296;
  };
}

function combinations(n, k) {
  let result = 1;
  for (let index = 1; index <= k; index++) result = result * (n - k + index) / index;
  return Math.round(result);
}

function rankedCandidates(probabilities, count, random) {
  return probabilities.map((probability, index) => ({ number: index + 1, probability, tie: random() }))
    .sort((a, b) => Math.abs(a.probability - b.probability) < 1e-12 ? a.tie - b.tie : b.probability - a.probability)
    .slice(0, count).map(entry => entry.number).sort((a, b) => a - b);
}

function categorical(values, weights, random) {
  let threshold = random() * weights.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < values.length; index++) {
    threshold -= weights[index];
    if (threshold <= 0) return values[index];
  }
  return values.at(-1);
}

// Exact conditional-subset sampler. Unlike successive weighted drawing, this
// yields P(S) proportional to the PRODUCT of the six weights.
function sampleSubset(numbers, weights, suffix, random) {
  const chosen = [];
  let remaining = RED_PICK;
  for (let index = 0; index < numbers.length && remaining > 0; index++) {
    const probability = weights[index] * suffix[index + 1][remaining - 1] / suffix[index][remaining];
    if (random() < probability) {
      chosen.push(numbers[index]);
      remaining--;
    }
  }
  if (remaining !== 0) throw new Error('概率采样失败，请检查模型。');
  return chosen;
}

function enumerateSmallPool(redNumbers, blueNumbers, fitted) {
  const rows = [];
  const selected = [];
  function visit(start, product) {
    if (selected.length === RED_PICK) {
      for (const blue of blueNumbers) rows.push({ red: [...selected], blue, mass: product * fitted.blueProbabilities[blue - 1] });
      return;
    }
    for (let index = start; index <= redNumbers.length - (RED_PICK - selected.length); index++) {
      selected.push(redNumbers[index]);
      visit(index + 1, product * fitted.redWeights[redNumbers[index] - 1]);
      selected.pop();
    }
  }
  visit(0, 1);
  return rows;
}

export function generatePrediction(fitted, options = {}) {
  requireFitted(fitted);
  const { redCount = 6, blueCount = 1, groupCount = 1 } = options;
  requireInteger(redCount, 6, 33, '红球候选数量');
  requireInteger(blueCount, 1, 16, '蓝球候选数量');
  requireInteger(groupCount, 1, 100, '完整号码组数');
  const seed = options.seed == null || options.seed === '' ? randomBytes(16).toString('hex') : String(options.seed);
  if (seed.length > 256) throw new Error('随机种子不能超过 256 个字符。');
  const random = randomGenerator(seed);
  const probabilities = getProbabilities(fitted);
  const redCandidates = rankedCandidates(probabilities.red, redCount, random);
  const blueCandidates = rankedCandidates(probabilities.blue, blueCount, random);
  const coverageCombinations = combinations(redCount, 6) * blueCount;
  if (groupCount > coverageCombinations) throw new Error(`候选池只有 ${coverageCombinations} 种不同完整组合，不能生成 ${groupCount} 组。`);
  const groups = [];
  if (coverageCombinations <= 10_000) {
    // Exponential races produce exact weighted sampling without replacement.
    const pool = enumerateSmallPool(redCandidates, blueCandidates, fitted);
    for (const group of pool) group.key = -Math.log(random()) / group.mass;
    pool.sort((a, b) => a.key - b.key);
    for (const group of pool.slice(0, groupCount)) groups.push({ red: group.red, blue: group.blue });
  } else {
    const weights = redCandidates.map(number => fitted.redWeights[number - 1]);
    const { suffix } = subsetTables(weights);
    const blueWeights = blueCandidates.map(number => fitted.blueProbabilities[number - 1]);
    const used = new Set();
    for (let attempt = 0; groups.length < groupCount && attempt < 100_000; attempt++) {
      const red = sampleSubset(redCandidates, weights, suffix, random);
      const blue = categorical(blueCandidates, blueWeights, random);
      const key = `${red.join(',')}|${blue}`;
      if (!used.has(key)) {
        used.add(key);
        groups.push({ red, blue });
      }
    }
    if (groups.length !== groupCount) throw new Error('模型概率过于集中，无法及时生成指定数量的不同组合；请减少组数或使用均匀模型。');
  }
  const normalizer = elementary(fitted.redWeights)[6];
  const candidatesRedMass = elementary(redCandidates.map(number => fitted.redWeights[number - 1]))[6] / normalizer;
  const candidatesBlueMass = blueCandidates.reduce((sum, number) => sum + fitted.blueProbabilities[number - 1], 0);
  return {
    model: fitted.id,
    seed,
    redCandidates,
    blueCandidates,
    groups: groups.map(group => ({ ...group, modelProbability: groupProbability(fitted, group) })),
    redProbabilities: probabilities.red,
    blueProbabilities: probabilities.blue,
    coverageCombinations,
    fairJackpotProbability: groups.length / TOTAL_COMBINATIONS,
    candidatePoolFairJackpotProbability: coverageCombinations / TOTAL_COMBINATIONS,
    candidatePoolModelProbability: candidatesRedMass * candidatesBlueMass,
    generatedGroupsModelProbability: groups.reduce((sum, group) => sum + groupProbability(fitted, group), 0),
    probabilityMeaning: '模型概率是估计值；公平开奖理论概率仅按不同组合数计算。候选池覆盖率假设全部展开，不能当成实际生成组数的覆盖率。',
  };
}

/** Scores index i using only draws [0, i); consuming i happens AFTER scoring. */
export function walkForwardEvaluate(draws, options = {}) {
  requireDraws(draws);
  const settings = parameters(options);
  const start = options.start ?? 0;
  const end = options.end ?? draws.length;
  requireInteger(start, 0, draws.length, '验证起点');
  requireInteger(end, start, draws.length, '验证终点');
  const state = emptyState(settings);
  const rows = [];
  for (let index = 0; index < end; index++) {
    if (index >= start) {
      const fitted = fittedFromState(state, settings, false);
      rows.push({ issue: String(draws[index].issue), trainedThrough: state.dataCutoff, loss: negativeLogLikelihood(fitted, draws[index]) });
    }
    consume(state, draws[index]);
  }
  return rows;
}

function average(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }

function blockInterval(differences, seed) {
  const random = randomGenerator(seed);
  const blockSize = Math.min(10, Math.max(1, Math.floor(differences.length / 6)));
  const estimates = [];
  for (let sample = 0; sample < 1000; sample++) {
    let sum = 0;
    let count = 0;
    while (count < differences.length) {
      const start = Math.floor(random() * differences.length);
      for (let offset = 0; offset < blockSize && count < differences.length; offset++, count++) {
        sum += differences[(start + offset) % differences.length];
      }
    }
    estimates.push(sum / differences.length);
  }
  estimates.sort((a, b) => a - b);
  return [estimates[24], estimates[974]];
}

function sliceDescription(draws, start, end) {
  return { count: end - start, from: String(draws[start].issue), to: String(draws[end - 1].issue),
    fromDate: draws[start].date, toDate: draws[end - 1].date };
}

export function trainModels(draws, options = {}) {
  requireDraws(draws);
  if (draws.length < 200) throw new Error(`训练至少需要 200 期真实开奖数据，目前只有 ${draws.length} 期。均匀基线无需训练。`);
  const createdAt = options.now == null ? new Date().toISOString() : new Date(options.now).toISOString();
  const dataHash = createHash('sha256').update(JSON.stringify(draws)).digest('hex');
  const testCount = Math.max(60, Math.floor(draws.length * 0.2));
  const validationCount = Math.max(60, Math.floor(draws.length * 0.2));
  const validationStart = draws.length - testCount - validationCount;
  const testStart = draws.length - testCount;
  const baselineLoss = Math.log(TOTAL_COMBINATIONS);
  const grid = {
    bayes: [20, 100, 500, 2000].map(strength => ({ model: 'bayes', strength })),
    decay: [20, 100, 500].flatMap(strength => [30, 100, 300].map(halfLife => ({ model: 'decay', strength, halfLife }))),
  };
  const selected = {};
  const trials = [];
  for (const id of ['bayes', 'decay']) {
    for (const configuration of grid[id]) {
      const rows = walkForwardEvaluate(draws, { ...configuration, start: validationStart, end: testStart });
      const loss = average(rows.map(row => row.loss));
      const trial = { id, params: { strength: configuration.strength, halfLife: configuration.halfLife ?? null }, validationLogLoss: loss };
      trials.push(trial);
      if (!selected[id] || loss < selected[id].validationLogLoss) selected[id] = trial;
    }
  }
  let validationSelectedModel = 'uniform';
  let bestValidationLoss = baselineLoss;
  for (const id of ['bayes', 'decay']) {
    if (selected[id].validationLogLoss < bestValidationLoss) {
      bestValidationLoss = selected[id].validationLogLoss;
      validationSelectedModel = id;
    }
  }
  const scores = [{ id: 'uniform', name: MODEL_CATALOG[0].name, validationLogLoss: baselineLoss,
    testLogLoss: baselineLoss, meanImprovement: 0, improvementInterval: [0, 0], testCount }];
  for (const id of ['bayes', 'decay']) {
    const rows = walkForwardEvaluate(draws, { model: id, ...selected[id].params, start: testStart });
    const losses = rows.map(row => row.loss);
    const differences = losses.map(loss => baselineLoss - loss);
    scores.push({ id, name: MODEL_CATALOG.find(model => model.id === id).name,
      validationLogLoss: selected[id].validationLogLoss, testLogLoss: average(losses),
      meanImprovement: average(differences), improvementInterval: blockInterval(differences, `${dataHash}:${id}`), testCount });
  }
  const selectedScore = scores.find(score => score.id === validationSelectedModel);
  const recommendedModel = validationSelectedModel !== 'uniform' && selectedScore.improvementInterval[0] > 0
    ? validationSelectedModel : 'uniform';
  const trainingNecessary = recommendedModel !== 'uniform';
  const reason = trainingNecessary
    ? '验证集选定的模型在留出测试中出现正向候选信号，可以继续前瞻验证；这一诊断还不能证明未来有效或头奖概率提高。'
    : '本次时间留出验证未显示足以支持切换模型的优势。当前建议保留均匀基线，无需对同一批数据反复训练；这不等于证明其他模型永远无效。';
  const selectedParams = Object.fromEntries(['bayes', 'decay'].map(id => [id, selected[id].params]));
  return {
    id: createHash('sha256').update(`${MODEL_VERSION}:${dataHash}:${createdAt}`).digest('hex').slice(0, 24),
    version: MODEL_VERSION,
    createdAt,
    dataCutoff: String(draws.at(-1).issue),
    drawCount: draws.length,
    dataHash,
    recommendedModel,
    models: Object.fromEntries(['bayes', 'decay'].map(id => [id, fitModel(draws, { model: id, ...selectedParams[id] })])),
    report: {
      metric: '完整开奖负对数似然（越小越好）',
      split: { train: sliceDescription(draws, 0, validationStart), validation: sliceDescription(draws, validationStart, testStart), test: sliceDescription(draws, testStart, draws.length) },
      validationSelectedModel,
      selectedParams,
      scores,
      trials,
      trainingNecessary,
      trainingMeaning: '训练是可选的超参数选择流程。trainingNecessary 表示本次留出测试是否支持继续验证该候选模型，不表示模型运行必须训练。',
      reason,
      intervalMethod: '逐期相对均匀基线的 log loss 改善；循环分块 bootstrap，块长至多 10 期，1000 次重采样，95% 诊断区间。',
      notes: [
        '所有预测只使用该期之前的数据；验证集选择超参数和模型，测试集只作检查或退回均匀基线，不再挑选赢家。',
        '滚动测试会在每期结束后将已知结果加入下一期训练前缀，超参数保持锁定。',
        '最终可用模型按锁定参数重新拟合全部历史；最终模型不得回头用于报告中的历史测试。',
        '红球采用固定抽取 6 个的联合子集模型，不假设一组中的红球互相独立。',
        '区间只是探索性诊断；重复训练或反复选策略不构成独立验证。',
        '完整开奖 log loss 的改善不等于头奖命中率提高，头奖事件太稀少，需要另行前瞻验证。',
      ],
    },
  };
}
