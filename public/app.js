const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const number = (value) => Number(value).toLocaleString('zh-CN');
const ballNumber = (value) => String(value).padStart(2, '0');
let state = null;
let busy = false;
let previewSequence = 0;
let activeRecord = null;

function timestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
function beijingLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 16);
}
function modelName(id) {
  const name = typeof id === 'object' ? id?.name || id?.id : id;
  return state?.models?.find((model) => model.id === name)?.name || ({ uniform: '均匀随机基线', bayes: '贝叶斯平滑模型', decay: '近期衰减模型' }[name]) || name || '—';
}
function modelId(value) { return typeof value === 'object' ? value?.id : value; }
function cutoffText(value) { return typeof value === 'object' ? `${value.issue || '—'}${value.date ? ` · ${value.date}` : ''}` : value || '—'; }
function balls(red = [], blue = []) {
  const blues = Array.isArray(blue) ? blue : [blue];
  return red.map((value) => `<span class="ball">${escapeHtml(ballNumber(value))}</span>`).join('') + (red.length && blues.length ? '<span class="ball-separator" aria-hidden="true"></span>' : '') + blues.map((value) => `<span class="ball blue">${escapeHtml(ballNumber(value))}</span>`).join('');
}
function fairOdds(probability) {
  const p = Number(probability);
  if (!Number.isFinite(p) || p <= 0) return '—';
  if (p >= 1) return '100%';
  return `约 ${number(Math.round(1 / p))} 分之一`;
}
function combinations(n, k) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k > n || n < 0) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = result * (n - k + i) / i;
  return Math.round(result);
}
function message(text, isError = false) {
  const node = $('#global-message');
  node.textContent = text;
  node.classList.toggle('error', isError);
  node.hidden = !text;
}
async function api(url, body) {
  const response = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({ error: '服务返回了无法读取的内容，请确认本地服务仍在运行。' }));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}
async function runAction(button, label, action) {
  if (busy) return;
  busy = true;
  const original = button.innerHTML;
  button.textContent = label;
  $$('button').filter((item) => !item.classList.contains('tab')).forEach((item) => { item.disabled = true; });
  message('');
  try { await action(); }
  catch (error) { message(error.message || '操作失败，请稍后重试。', true); $('#global-message').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  finally {
    button.innerHTML = original;
    busy = false;
    $$('button').forEach((item) => { item.disabled = false; });
    updateModelExplanation();
  }
}

function navigate(view) {
  const name = ['predict', 'data', 'training', 'history'].includes(view) ? view : 'predict';
  $$('.view').forEach((node) => { const active = node.id === `view-${name}`; node.hidden = !active; node.classList.toggle('active', active); });
  $$('.tab').forEach((node) => { const active = node.dataset.view === name; node.classList.toggle('active', active); if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
  if (name === 'data' && state) refreshDraws();
}

function renderState(nextState, { fillTarget = false } = {}) {
  state = nextState;
  const summary = state.data?.summary || {};
  const first = summary.first;
  const last = summary.last;
  $('#stat-count').innerHTML = `${number(summary.count || 0)}<small>期</small>`;
  $('#stat-range').textContent = first && last ? `${first.date} 至 ${last.date}` : '请先同步官方数据或导入文件';
  $('#latest-label').textContent = last ? `最近一期 · ${last.issue}` : '最近一期';
  $('#latest-balls').innerHTML = last ? balls(last.red, last.blue) : '<span class="muted">尚无开奖数据</span>';
  $('#latest-date').textContent = last ? `${last.date} 开奖` : '等待数据';
  $('#stat-records').innerHTML = `${number(state.predictions?.length || 0)}<small>次</small>`;
  $('#server-time').textContent = `${timestamp(state.serverTime)} · 北京时间`;
  if (state.training) {
    $('#stat-recommendation').textContent = state.training.stale ? '训练数据已变更' : state.training.recommendedModel === 'uniform' ? '保留随机基线' : '待前瞻验证';
    $('#stat-training').textContent = `验证截至 ${cutoffText(state.training.dataCutoff)}`;
  } else { $('#stat-recommendation').textContent = '尚未验证'; $('#stat-training').textContent = '可直接使用默认概率模型'; }
  if (state.models?.length) {
    const selected = $('#model').value;
    $('#model').innerHTML = state.models.map((model) => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name)}</option>`).join('');
    $('#model').value = state.models.some((model) => model.id === selected) ? selected : state.models[0].id;
  }
  if (state.suggestedTarget) {
    $('#target-issue').value = state.suggestedTarget.issue || '';
    $('#draw-at').value = beijingLocalInput(state.suggestedTarget.drawAt);
  }
  renderDataSummary();
  renderTraining();
  renderHistory();
  updateModelExplanation();
  updateCoverage();
  if (activeRecord) { activeRecord = state.predictions?.find((record) => record.id === activeRecord.id) || activeRecord; renderResult(activeRecord); }
}

function updateModelExplanation() {
  const id = $('#model').value;
  const model = state?.models?.find((item) => item.id === id);
  $('#model-description').textContent = model?.description || '均匀随机模型为比较基线。';
  const stale = !!state?.training?.stale;
  const trained = !!state?.training?.models?.[id] && !stale;
  $('#use-trained').disabled = id === 'uniform' || !trained;
  if ($('#use-trained').disabled) $('#use-trained').checked = false;
  $('#trained-badge').textContent = id === 'uniform' ? '无需训练' : stale ? '需重新训练' : trained ? '已有训练参数' : '尚未训练';
  $('#training-status').textContent = id === 'uniform' ? '所有合法组合使用相同概率，无需训练。' : stale ? '训练后开奖数据已变更，请重新训练后使用训练参数。当前可使用默认参数。' : trained ? `可使用训练选出的参数。验证结论：${state.training.recommendedModel === 'uniform' ? '当前保留随机基线，其他模型仅供探索' : '仍需持续验证新开奖'}。` : '可直接使用默认参数。训练用于选择参数并检查相对随机基线的表现。';
}
function updateCoverage() {
  const reds = Number($('#red-count').value), blues = Number($('#blue-count').value), groups = Number($('#group-count').value);
  const valid = Number.isInteger(reds) && reds >= 6 && reds <= 33 && Number.isInteger(blues) && blues >= 1 && blues <= 16 && Number.isInteger(groups) && groups >= 1 && groups <= 100;
  const capacity = valid ? combinations(reds, 6) * blues : 0;
  const error = !valid || groups > capacity;
  $('#coverage-hint').classList.toggle('invalid', error);
  $('#coverage-hint').textContent = !valid ? '请填写范围内的整数。' : groups > capacity ? `当前候选池最多只有 ${number(capacity)} 组，请减少生成组数或扩大候选池。` : `当前候选池可组成 ${number(capacity)} 组，将保存其中 ${number(groups)} 组。`;
  $('#group-count').setCustomValidity(valid && groups > capacity ? `候选池只能组成 ${capacity} 组不同号码。` : '');
}
function renderProbabilityGrid(selector, values, color) {
  const safeValues = (values || []).map((value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0);
  const max = Math.max(...safeValues, 0.001);
  $(selector).innerHTML = safeValues.map((value, index) => `<div class="probability-cell" title="${color === 'red' ? '红球' : '蓝球'} ${ballNumber(index + 1)}：${(value * 100).toFixed(3)}%"><span class="number">${ballNumber(index + 1)}</span><div class="bar-track"><i class="probability-bar" style="height:${Math.min(100, value / max * 100).toFixed(2)}%"></i></div><span class="probability-value">${(value * 100).toFixed(1)}%</span></div>`).join('');
  $(`#${color}-prob-sum`).textContent = `概率合计 ${safeValues.reduce((sum, value) => sum + value, 0).toFixed(3)}`;
}
async function refreshPreview({ showErrors = true } = {}) {
  const sequence = ++previewSequence;
  updateModelExplanation();
  try {
    const preview = await api('/api/preview', { model: $('#model').value, useTrained: $('#use-trained').checked });
    if (sequence !== previewSequence) return;
    renderProbabilityGrid('#red-probabilities', preview.probabilities.red, 'red');
    renderProbabilityGrid('#blue-probabilities', preview.probabilities.blue, 'blue');
    $('#preview-parameters').textContent = JSON.stringify(preview.model?.params || preview.model || {}, null, 2);
    if (preview.trainingStatus) $('#training-status').textContent = typeof preview.trainingStatus === 'string' ? preview.trainingStatus : preview.trainingStatus.message || preview.trainingStatus.reason || $('#training-status').textContent;
  } catch (error) {
    if (sequence !== previewSequence) return;
    $('#red-probabilities').innerHTML = '<p class="muted">暂无可用概率</p>';
    $('#blue-probabilities').innerHTML = '<p class="muted">请先检查数据</p>';
    if (showErrors) message(error.message, true);
  }
}

function selectionMarkup(record) {
  const selection = record.selection || {};
  const groups = selection.groups || [];
  const evaluation = record.evaluation;
  const evaluated = evaluation?.status === 'evaluated';
  const metricsMarkup = evaluated && evaluation.metrics && Number.isFinite(evaluation.metrics.logLoss) && Number.isFinite(evaluation.metrics.improvement) ? `<p class="training-note">封存模型损失 ${evaluation.metrics.logLoss.toFixed(5)} / 相对随机基线改善 ${evaluation.metrics.improvement.toFixed(5)}（正数更好）。使用开奖前保存的模型计算。</p>` : '';
  const groupProbability = selection.groupJackpotProbability ?? groups.length / 17721088;
  const poolProbability = selection.fairJackpotProbability ?? (selection.coverageCombinations || 0) / 17721088;
  const evaluationMarkup = evaluation ? `<div class="evaluation-strip">${evaluated ? `已开奖 · 本次记录最多命中 ${escapeHtml(evaluation.bestRedHits ?? Math.max(0, ...(evaluation.groups || []).map((row) => row.redHits || 0)))} 个红球${evaluation.anyBlueHit ? '，有组合命中蓝球' : ''}` : `记录未计入验证：${escapeHtml(evaluation.message || '请核对原始记录与开奖日期。')}`}${evaluation.actual ? `<div class="ball-row compact">${balls(evaluation.actual.red, evaluation.actual.blue)}</div>` : ''}</div>` : '';
  return `<div class="record-meta"><span>目标 ${escapeHtml(record.targetIssue)} 期</span><span>保存于 ${escapeHtml(timestamp(record.createdAt))}</span><span>数据截止 ${escapeHtml(cutoffText(record.dataCutoff))}</span></div>
    <div class="candidate-section"><span class="candidate-label">红球候选池 · ${(selection.redCandidates || []).length} 个</span><div class="ball-row">${balls(selection.redCandidates || [], [])}</div><span class="candidate-label">蓝球候选池 · ${(selection.blueCandidates || []).length} 个</span><div class="ball-row">${balls([], selection.blueCandidates || [])}</div></div>
    <div class="selection-stats"><div class="selection-stat"><span>候选池全部展开</span><strong>${number(selection.coverageCombinations || 0)}<small>组组合</small></strong><p>假如覆盖全部组合，公平头奖率<br>${escapeHtml(fairOdds(poolProbability))}</p></div><div class="selection-stat actual"><span>本次实际生成</span><strong>${number(groups.length)}<small>组号码</small></strong><p>仅这 ${number(groups.length)} 组的公平头奖率<br>${escapeHtml(fairOdds(groupProbability))}</p></div></div>
    ${evaluationMarkup}${metricsMarkup}<div class="group-list">${groups.map((group, index) => `<div class="group-row"><div class="group-content"><span class="group-number">${String(index + 1).padStart(2, '0')}</span><div class="ball-row">${balls(group.red, group.blue)}</div></div>${evaluated && evaluation.groups?.[index] ? `<span class="group-evaluation">红 ${escapeHtml(evaluation.groups[index].redHits)} · 蓝 ${evaluation.groups[index].blueHit ? '中' : '未中'}</span>` : ''}</div>`).join('')}</div>
    <div class="result-footer"><span class="record-hash">数据指纹 ${escapeHtml(record.dataHash ? record.dataHash.slice(0, 16) + '…' : '—')}</span><a class="button quiet small" href="/api/predictions/${encodeURIComponent(record.id)}" download="prediction-${escapeHtml(record.targetIssue)}-${escapeHtml(record.id)}.json">下载完整记录 ↓</a></div>
    <details class="model-parameters"><summary>记录详情与模型参数</summary><pre>${escapeHtml(JSON.stringify({ id: record.id, createdAt: record.createdAt, targetIssue: record.targetIssue, drawAt: record.drawAt, model: record.model, params: record.params, seed: record.seed || record.options?.seed, dataCutoff: record.dataCutoff, dataHash: record.dataHash }, null, 2))}</pre></details>`;
}
function renderResult(record) {
  $('#result-title').textContent = `${record.targetIssue} 期 · ${modelName(record.model)}`;
  $('#result-status').textContent = record.evaluation?.status === 'evaluated' ? '已核对开奖' : record.evaluation ? '未计入验证' : '已保存 · 待开奖';
  $('#result-status').classList.add('saved');
  $('#prediction-result').innerHTML = selectionMarkup(record);
}

function renderDataSummary() {
  const summary = state.data?.summary || {};
  const provenance = state.data?.provenance || {};
  const sources = Array.isArray(provenance.sources) ? provenance.sources : [];
  const sourceName = provenance.source || provenance.sourceName || sources.map((source) => source.name || source.source || source.url || source).join('；') || '查看完整来源信息';
  const fetchedAt = provenance.fetchedAt || provenance.updatedAt || provenance.retrievedAt || provenance.importedAt;
  const warnings = [...(summary.warnings || [])];
  if (summary.missingIssues?.length) warnings.push(`检测到 ${summary.missingIssues.length} 个缺失期号：${summary.missingIssues.slice(0, 12).join('、')}${summary.missingIssues.length > 12 ? '…' : ''}`);
  $('#data-warnings').innerHTML = warnings.map((item) => `<p>${escapeHtml(typeof item === 'object' ? JSON.stringify(item) : item)}</p>`).join('');
  $('#data-provenance').innerHTML = [
    ['来源', typeof sourceName === 'object' ? JSON.stringify(sourceName) : sourceName],
    ['最近获取时间', timestamp(fetchedAt)],
    ['期号覆盖', summary.first && summary.last ? `${summary.first.issue} — ${summary.last.issue}` : '尚无数据'],
    ['数据检查', summary.missingIssues?.length ? `${summary.missingIssues.length} 个缺期提示，详见完整信息` : '未报告期号缺口；请以实际来源覆盖为准'],
  ].map(([label, value]) => `<div class="metadata-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  $('#provenance-json').textContent = JSON.stringify(provenance, null, 2);
}
async function refreshDraws() {
  try {
    const result = await api('/api/draws?limit=30');
    $('#draw-table-count').textContent = `${result.draws?.length || 0} 期`;
    $('#draw-table').innerHTML = result.draws?.length ? result.draws.map((draw) => `<tr><td>${escapeHtml(draw.issue)}</td><td>${escapeHtml(draw.date)}</td><td><div class="ball-row">${balls(draw.red, [])}</div></td><td><div class="ball-row">${balls([], draw.blue)}</div></td></tr>`).join('') : '<tr><td colspan="4" class="empty-cell">尚无数据，请同步或导入。</td></tr>';
  } catch (error) { $('#draw-table').innerHTML = `<tr><td colspan="4" class="empty-cell">${escapeHtml(error.message)}</td></tr>`; }
}

function renderTraining() {
  const training = state.training;
  if (!training) return;
  const report = training.report || {};
  $('#training-title').textContent = training.recommendedModel === 'uniform' ? '当前保留均匀随机基线' : `研究候选：${modelName(training.recommendedModel)}`;
  $('#training-created').textContent = timestamp(training.createdAt);
  const reason = report.reason || report.conclusion || report.recommendationReason || report.message || (training.recommendedModel === 'uniform' ? '留出数据未提供足够证据支持改变随机基线。训练结果已保留，其他模型仍可作为探索对象。' : '模型在本次检验中表现较好，仍需用新的开奖记录验证。这不代表已经证明头奖优势。');
  const splitEntries = Object.entries(report.splits || report.split || {});
  const splits = splitEntries.length ? `<div class="split-grid">${splitEntries.map(([key, value]) => `<div class="split-item">${escapeHtml(({ train: '早期训练区间', validation: '参数验证区间', test: '留出测试区间' })[key] || key)}<strong>${escapeHtml(typeof value === 'object' ? `${value.count ?? value.size ?? '—'} 期` : value)}</strong>${escapeHtml(typeof value === 'object' ? `${cutoffText(value.start || value.first || value.from || '')} — ${cutoffText(value.end || value.last || value.to || '')}` : '')}</div>`).join('')}</div>` : '';
  let rows = report.scores || report.results || report.metrics || report.testResults || [];
  if (!Array.isArray(rows) && rows && typeof rows === 'object') rows = Object.entries(rows).map(([id, value]) => ({ id, ...value }));
  const metrics = Array.isArray(rows) && rows.length ? `<div class="table-wrap"><table class="report-table"><thead><tr><th>模型</th><th>测试损失 ↓</th><th>相对基线改善</th><th>诊断区间</th></tr></thead><tbody>${rows.map((row) => { const loss = row.logLoss ?? row.meanLogLoss ?? row.testLogLoss ?? row.loss; const improvement = row.improvement ?? row.meanImprovement ?? row.gain; const ci = row.improvementInterval || row.ci || row.confidenceInterval || row.improvementCI; return `<tr><td>${escapeHtml(modelName(row.id || row.model))}</td><td>${typeof loss === 'number' ? loss.toFixed(5) : '—'}</td><td>${typeof improvement === 'number' ? improvement.toFixed(5) : '—'}</td><td>${escapeHtml(Array.isArray(ci) ? ci.map((n) => Number(n).toFixed(5)).join(' 至 ') : ci && typeof ci === 'object' ? `${Number(ci.lower ?? ci.low).toFixed(5)} 至 ${Number(ci.upper ?? ci.high).toFixed(5)}` : '—')}</td></tr>`; }).join('')}</tbody></table></div><p class="training-note">测试损失越低越好；相对基线改善为正表示本次更好。诊断区间不是已证实的优势，跨过 0 时不能判断有稳定改善。</p>` : '';
  $('#training-report').innerHTML = `${training.stale ? '<div class="message error">数据已更新，此报告仅对应旧数据。需重新训练后才能使用训练参数。</div>' : ''}<div class="training-verdict"><h3>${escapeHtml(training.recommendedModel === 'uniform' ? '当前没有充分理由采用更复杂的模型' : '保留研究候选，继续做前瞻验证')}</h3><p>${escapeHtml(typeof reason === 'object' ? JSON.stringify(reason) : reason)}</p></div>${splits}${metrics}<div class="metadata-grid"><div class="metadata-item"><span>训练数据量</span><strong>${number(training.drawCount || 0)} 期</strong></div><div class="metadata-item"><span>数据截止</span><strong>${escapeHtml(cutoffText(training.dataCutoff))}</strong></div></div><details><summary>完整验证报告与参数</summary><pre>${escapeHtml(JSON.stringify(training, null, 2))}</pre></details>`;
}
function renderHistory() {
  const records = state.predictions || [];
  $('#history-count').textContent = `${records.length} 次`;
  if (!records.length) return;
  $('#history-list').innerHTML = records.map((record) => `<details class="history-item"><summary class="history-summary"><div><h3>${escapeHtml(record.targetIssue)} 期<span class="history-model">${escapeHtml(modelName(record.model))}</span></h3><p>${escapeHtml(timestamp(record.createdAt))} 保存 · ${record.selection?.groups?.length || 0} 组</p></div><span class="history-right"><span class="pill ${record.evaluation?.status === 'evaluated' ? 'saved' : ''}">${record.evaluation?.status === 'evaluated' ? '已核对' : record.evaluation ? '未计入验证' : '待开奖'}</span><span aria-hidden="true">⌄</span></span></summary><div class="history-content">${selectionMarkup(record)}</div></details>`).join('');
}

$$('.tab').forEach((button) => button.addEventListener('click', () => { location.hash = button.dataset.view; navigate(button.dataset.view); }));
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
$('#model').addEventListener('change', () => refreshPreview());
$('#use-trained').addEventListener('change', () => refreshPreview());
['#red-count', '#blue-count', '#group-count'].forEach((selector) => $(selector).addEventListener('input', updateCoverage));
$('#refresh-preview').addEventListener('click', () => runAction($('#refresh-preview'), '计算中…', () => refreshPreview()));
$('#sync-button').addEventListener('click', () => runAction($('#sync-button'), '正在获取官方数据…', async () => {
  const result = await api('/api/sync', {});
  renderState(result.state, { fillTarget: true });
  await Promise.all([refreshDraws(), refreshPreview({ showErrors: false })]);
  message(`数据已更新，当前共 ${number(state.data?.summary?.count || 0)} 期。`);
}));
$('#import-button').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', () => {
  const file = $('#import-file').files[0];
  if (!file) return;
  runAction($('#import-button'), '正在校验并导入…', async () => {
    if (file.size > 4 * 1024 * 1024) throw new Error('文件超过 4 MB，请缩小后再导入。');
    const content = await file.text();
    const result = await api('/api/import', { content, filename: file.name });
    renderState(result.state, { fillTarget: true });
    await Promise.all([refreshDraws(), refreshPreview({ showErrors: false })]);
    message(`已完成数据校验与合并，当前共 ${number(state.data?.summary?.count || 0)} 期。`);
  }).finally(() => { $('#import-file').value = ''; });
});
$('#train-button').addEventListener('click', () => runAction($('#train-button'), '正在按时间训练与验证…', async () => {
  const result = await api('/api/train', {});
  renderState(result.state);
  await refreshPreview({ showErrors: false });
  message(result.reused ? '数据和模型版本未变，已复用上次验证结果，无需重复训练。' : '训练验证已完成。请查看留出测试结果与是否需要采用训练参数的结论。');
}));
$('#prediction-form').addEventListener('submit', (event) => {
  event.preventDefault();
  updateCoverage();
  if (!$('#prediction-form').reportValidity()) return;
  runAction($('#predict-button'), '正在生成并保存…', async () => {
    const drawAt = `${$('#draw-at').value}:00+08:00`;
    const body = { model: $('#model').value, useTrained: $('#use-trained').checked, redCount: Number($('#red-count').value), blueCount: Number($('#blue-count').value), groupCount: Number($('#group-count').value), targetIssue: $('#target-issue').value.trim(), drawAt };
    const seed = $('#seed').value.trim();
    if (seed) body.seed = seed;
    const result = await api('/api/predict', body);
    activeRecord = result.record;
    renderState(result.state);
    renderResult(activeRecord);
    message(`已保存 ${activeRecord.targetIssue} 期预测。原始记录已保留，可下载完整 JSON。`);
    if (window.innerWidth < 700) $('.result-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

async function initialize() {
  navigate(location.hash.slice(1));
  try {
    const initial = await api('/api/state');
    renderState(initial.state || initial, { fillTarget: true });
    await refreshPreview({ showErrors: false });
    if (location.hash === '#data') await refreshDraws();
  } catch (error) {
    message(`无法读取本地工作台：${error.message}`, true);
    $('#stat-range').textContent = '请确认本地服务已启动';
  }
}
initialize();
