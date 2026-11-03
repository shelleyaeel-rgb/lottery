import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export const OFFICIAL_API = 'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice';
export const SHANGHAI_HISTORY = 'https://appsh.swlc.net.cn/shfcoc_datachart/datachart/ssq/lskj/ls_award.html';
const locks = new Map();
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const datasetHash = draws => sha256(JSON.stringify(draws));

function nowDate(now = new Date()) {
  const value = new Date(now);
  if (!Number.isFinite(value.getTime())) throw new Error('当前时间无效。');
  return value;
}

function chinaDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(nowDate(now));
}

function dateValue(input) {
  const match = String(input ?? '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:$|[ (（T])/);
  if (!match) throw new Error('开奖日期必须为 YYYY-MM-DD。');
  const normalized = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  const value = new Date(`${normalized}T00:00:00Z`);
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== normalized) throw new Error(`开奖日期不存在：${normalized}`);
  return normalized;
}

function integer(value, label) {
  if (!['number', 'string'].includes(typeof value)) throw new Error(`${label}必须是整数。`);
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) throw new Error(`${label}必须是整数。`);
  if (value === '' || value == null || typeof value === 'boolean' || !Number.isInteger(Number(value))) throw new Error(`${label}必须是整数。`);
  return Number(value);
}

/** Validate every row before mutating the store. Dates and comparisons use Shanghai time. */
export function validateDraws(rows, { now } = {}) {
  if (!Array.isArray(rows)) throw new Error('开奖数据必须是数组。');
  if (rows.length > 50000) throw new Error('单次最多导入 50000 行。');
  const today = chinaDate(now);
  const unique = new Map();
  rows.forEach((row, index) => {
    try {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('每行必须是开奖对象。');
      const issue = String(row.issue ?? row.code ?? row['期号'] ?? '').trim();
      if (!/^20\d{5}$/.test(issue) || Number(issue.slice(0, 4)) < 2003 || Number(issue.slice(4)) < 1 || Number(issue.slice(4)) > 366) throw new Error('期号必须是 YYYYNNN 格式，例如 2026124。');
      const date = dateValue(row.date ?? row['开奖日期'] ?? row['日期']);
      if (date < '2003-02-23' || date > today) throw new Error(`开奖日期超出已发生的双色球开奖范围：${date}`);
      if (date.slice(0, 4) !== issue.slice(0, 4)) throw new Error(`期号与开奖日期的年份不一致：${issue}`);
      let redInput = row.red ?? row['红球'];
      if (redInput == null && row.r1 != null) redInput = Array.from({ length: 6 }, (_, i) => row[`r${i + 1}`]);
      const red = (Array.isArray(redInput) ? redInput : String(redInput ?? '').trim().split(/[\s,，;；|]+/)).map(value => integer(value, '红球'));
      if (red.length !== 6 || new Set(red).size !== 6 || red.some(value => value < 1 || value > 33)) throw new Error('红球必须是 1—33 之间的 6 个不同整数。');
      red.sort((a, b) => a - b);
      const blue = integer(row.blue ?? row['蓝球'], '蓝球');
      if (blue < 1 || blue > 16) throw new Error('蓝球必须在 1—16 之间。');
      const draw = { issue, date, red, blue };
      if (unique.has(issue) && JSON.stringify(unique.get(issue)) !== JSON.stringify(draw)) throw new Error(`同一期号有冲突数据：${issue}；未覆盖原记录。`);
      unique.set(issue, draw);
    } catch (error) {
      throw new Error(`第 ${index + 1} 行：${error.message}`);
    }
  });
  const draws = [...unique.values()].sort((a, b) => a.issue.localeCompare(b.issue));
  for (let i = 1; i < draws.length; i++) {
    if (draws[i].date <= draws[i - 1].date) throw new Error(`开奖日期未随期号严格递增：${draws[i - 1].issue} / ${draws[i].issue}`);
  }
  return draws;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, afterQuote = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else field += char;
    } else if (char === '"' && field === '' && !afterQuote) quoted = true;
    else if (char === ',') { row.push(field); field = ''; afterQuote = false; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field); if (row.some(value => value.trim())) rows.push(row);
      row = []; field = ''; afterQuote = false;
    } else {
      if (afterQuote && char.trim()) throw new Error('CSV 引号后含有无效字符。');
      field += char;
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合。');
  row.push(field); if (row.some(value => value.trim())) rows.push(row);
  if (rows.length < 2) throw new Error('CSV 必须包含表头和至少一行数据。');
  const headers = rows.shift().map(value => value.trim());
  if (new Set(headers).size !== headers.length) throw new Error('CSV 表头不能重复。');
  return rows.map((values, i) => {
    if (values.length !== headers.length) throw new Error(`CSV 第 ${i + 2} 行列数与表头不一致；含逗号的红球字段需要双引号。`);
    return Object.fromEntries(headers.map((name, j) => [name, values[j]]));
  });
}

export function parseImport(input) {
  let value = input;
  if (typeof input === 'string') {
    const text = input.replace(/^\uFEFF/, '').trim();
    if (!text) throw new Error('导入内容不能为空。');
    if (text.startsWith('{') || text.startsWith('[')) {
      try { value = JSON.parse(text); } catch { throw new Error('JSON 格式无效。'); }
    } else value = parseCsv(text);
  }
  const rows = Array.isArray(value) ? value : value?.draws ?? value?.data ?? value?.result;
  if (!Array.isArray(rows) || !rows.length) throw new Error('导入文件没有开奖数据；支持数组、draws/data/result 数组或 CSV。');
  return rows;
}

function summarize(draws, provenance, now) {
  const warnings = [];
  const missingIssues = [];
  const byYear = new Map();
  for (const draw of draws) {
    const year = draw.issue.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(Number(draw.issue.slice(4)));
  }
  for (const [year, numbers] of byYear) {
    const have = new Set(numbers);
    const start = year === draws[0]?.issue.slice(0, 4) ? numbers[0] : 1;
    for (let n = start; n < numbers.at(-1); n++) if (!have.has(n)) missingIssues.push(`${year}${String(n).padStart(3, '0')}`);
  }
  if (draws.length) {
    for (let year = Number(draws[0].issue.slice(0, 4)); year <= Number(draws.at(-1).issue.slice(0, 4)); year++) {
      if (!byYear.has(String(year))) warnings.push(`${year} 年没有记录；无法据此推断该年实际开奖期数，请补充核验。`);
    }
  }
  if (!draws.length) warnings.push('尚无开奖数据，请同步官方数据或导入文件。');
  else {
    if (draws[0].issue !== '2003001') warnings.push(`当前数据从 ${draws[0].issue} 期开始，不是 2003 年起的完整历史；不会虚构更早数据。`);
    if (missingIssues.length) warnings.push(`已覆盖区间内发现 ${missingIssues.length} 个年内缺期，请核验数据源。`);
    if (new Date(`${chinaDate(now)}T00:00:00Z`) - new Date(`${draws.at(-1).date}T00:00:00Z`) > 7 * 86400000) warnings.push('最新开奖数据距今天超过 7 天，请先同步并核对是否存在休市。');
  }
  if (provenance.sources?.some(source => source.type === 'import')) warnings.push('数据包含用户导入记录，导入数据未自动获得官方核验。');
  if (draws.length && !provenance.sources?.length) warnings.push('此数据没有来源记录，请核验后再用于研究。');
  for (const source of provenance.sources?.slice(-1) ?? []) if (source.warning) warnings.push(source.warning);
  return { count: draws.length, first: draws[0] ?? null, last: draws.at(-1) ?? null, missingIssues, warnings, datasetHash: datasetHash(draws) };
}

export async function loadData(dataDir) {
  let snapshot;
  try { snapshot = JSON.parse(await readFile(path.join(dataDir, 'draws.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`无法读取数据快照：${error.message}`);
    snapshot = { draws: [], provenance: { schemaVersion: 1, sources: [] } };
  }
  const draws = validateDraws(Array.isArray(snapshot) ? snapshot : snapshot.draws);
  const provenance = snapshot.provenance ?? { schemaVersion: 1, sources: [] };
  if (provenance.datasetHash && provenance.datasetHash !== datasetHash(draws)) throw new Error('数据快照哈希不匹配，文件可能被手动改动；请核验后重新导入。');
  return { draws, provenance, summary: summarize(draws, provenance) };
}

async function atomicJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filename);
}

async function locked(dataDir, action) {
  const key = path.resolve(dataDir);
  const previous = locks.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(action);
  locks.set(key, operation);
  try { return await operation; }
  finally { if (locks.get(key) === operation) locks.delete(key); }
}

async function commit(dataDir, incoming, source, raw, now) {
  return locked(dataDir, async () => {
    const existing = await loadData(dataDir);
    const draws = validateDraws([...existing.draws, ...incoming], { now });
    const fetchedAt = nowDate(now).toISOString();
    const id = `${fetchedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const rawFile = `raw/${id}.txt`;
    const entry = {
      id, ...source, fetchedAt, rowCount: incoming.length, addedCount: draws.length - existing.draws.length,
      firstIssue: incoming[0].issue, lastIssue: incoming.at(-1).issue,
      responseSha256: sha256(raw), normalizedSha256: datasetHash(incoming), rawFile,
    };
    const provenance = {
      schemaVersion: 1, updatedAt: fetchedAt, datasetHash: datasetHash(draws),
      coverage: { count: draws.length, firstIssue: draws[0].issue, lastIssue: draws.at(-1).issue },
      sources: [...(existing.provenance.sources ?? []), entry],
    };
    await mkdir(path.join(dataDir, 'raw'), { recursive: true });
    await writeFile(path.join(dataDir, rawFile), raw, { encoding: 'utf8', flag: 'wx' });
    // Draws and provenance are committed in one atomic snapshot. The second file is only a readable mirror.
    await atomicJson(path.join(dataDir, 'draws.json'), { schemaVersion: 1, draws, provenance });
    try { await atomicJson(path.join(dataDir, 'provenance.json'), provenance); }
    catch { /* The canonical snapshot already contains the provenance; a mirror failure loses no data. */ }
    return { draws, provenance, summary: summarize(draws, provenance, now) };
  });
}

export async function importData(dataDir, input, { source = '用户导入', now } = {}) {
  const incoming = validateDraws(parseImport(input), { now });
  const raw = typeof input === 'string' ? input : JSON.stringify(input);
  return commit(dataDir, incoming, { type: 'import', name: String(source).slice(0, 200) }, raw, now);
}

async function fetchText(url, timeout = 15000) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { 'User-Agent': 'Mozilla/5.0 SSQResearchLab/0.1', Referer: 'https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 15_000_000) throw new Error('数据源返回内容过大。');
  return text;
}

export function parseShanghai(text) {
  const rows = [];
  const pattern = /employee\.push\(\{'id':'(\d{7})','c':'([\d,]+)\|(\d{1,2})','t':'([^']+)'/g;
  for (const match of text.matchAll(pattern)) rows.push({ issue: match[1], date: match[4].slice(0, 10), red: match[2], blue: match[3] });
  if (!rows.length) throw new Error('上海福彩页面格式已改变，未识别到开奖数据。');
  return validateDraws(rows);
}

/** Read-only freshness check used immediately before sealing a forecast. */
export async function fetchLatestOfficialDraw() {
  const url = new URL(OFFICIAL_API);
  Object.entries({ name: 'ssq', issueCount: '1', pageNo: '1', pageSize: '1', systemType: 'PC' }).forEach(([key, value]) => url.searchParams.set(key, value));
  try {
    const json = JSON.parse(await fetchText(url));
    if (json.state !== 0 || !Array.isArray(json.result) || json.result.length !== 1) throw new Error(json.message || '未返回唯一的最新一期开奖');
    const [draw] = validateDraws(json.result);
    return { draw, checkedAt: new Date().toISOString(), url: url.href };
  } catch (error) {
    throw new Error(`无法核验中国福彩最新一期：${error.message}。请稍后重试；未通过最新开奖核验时不能封存预测。`);
  }
}

export async function syncData(dataDir) {
  const url = new URL(OFFICIAL_API);
  Object.entries({ name: 'ssq', issueCount: '5000', pageNo: '1', pageSize: '5000', systemType: 'PC' }).forEach(([key, value]) => url.searchParams.set(key, value));
  let raw, json, incoming;
  try {
    raw = await fetchText(url);
    json = JSON.parse(raw);
    if (json.state !== 0 || !Array.isArray(json.result) || !json.result.length) throw new Error(json.message || '未返回开奖数据');
    incoming = validateDraws(json.result);
    if (Number(json.total) !== incoming.length || Number(json.pageNum) !== 1) throw new Error('官方接口返回分页或不完整结果，请更新数据适配器后再同步。');
  } catch (error) { throw new Error(`中国福彩官方同步失败：${error.message}。本地数据保持不变，可稍后重试或导入官方记录。`); }

  let crossCheck, warning;
  try {
    const shanghaiRaw = await fetchText(SHANGHAI_HISTORY, 10000);
    const secondary = parseShanghai(shanghaiRaw);
    const primary = new Map(incoming.map(row => [row.issue, row]));
    const overlap = secondary.filter(row => primary.has(row.issue));
    const conflict = overlap.find(row => JSON.stringify(row) !== JSON.stringify(primary.get(row.issue)));
    if (conflict) throw Object.assign(new Error(`两个官方来源在 ${conflict.issue} 期存在冲突，已拒绝同步。`), { conflict: true });
    crossCheck = { url: SHANGHAI_HISTORY, checkedAt: new Date().toISOString(), matchedCount: overlap.length, responseSha256: sha256(shanghaiRaw), latestIssue: secondary.at(-1).issue };
    if (!overlap.length) warning = '上海福彩与主数据没有可比对的交集，尚未完成交叉核验。';
  } catch (error) {
    if (error.conflict) throw error;
    warning = `主数据来自中国福彩；上海福彩交叉核验暂不可用：${error.message}`;
  }
  return commit(dataDir, incoming, { type: 'official', name: '中国福利彩票发行管理中心', url: url.href, crossCheck, warning }, raw);
}
