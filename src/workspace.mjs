import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { groupProbability, TOTAL_COMBINATIONS } from './models.mjs';

export const ENGINE_VERSION = 'ssq-lab/0.1.0';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const beijingDate = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}

export function suggestedTarget(draws, now = new Date()) {
  const last = draws.at(-1);
  const cursor = new Date(`${last?.date || beijingDate(now)}T12:00:00+08:00`);
  do { cursor.setUTCDate(cursor.getUTCDate() + 1); }
  while (![0, 2, 4].includes(cursor.getUTCDay()));
  const date = beijingDate(cursor);
  const year = date.slice(0, 4);
  return {
    issue: last ? (last.issue.slice(0, 4) === year ? String(Number(last.issue) + 1) : `${year}001`) : '',
    drawAt: `${date}T21:15:00+08:00`,
    approximate: true,
    needsSync: new Date(`${date}T21:15:00+08:00`) <= now,
    note: '按常规周二、四、日推算；休市或调整时请以官方公告为准。',
  };
}

export function validateTarget(draws, { targetIssue, drawAt }, now = new Date()) {
  if (!draws.length) throw new Error('请先导入真实开奖数据。');
  if (!/^20\d{5}$/.test(targetIssue || '') || Number(targetIssue.slice(4)) < 1) throw new Error('目标期号应为 7 位，例如 2026125。');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?\+08:00$/.test(drawAt || '')) throw new Error('开奖时间必须包含北京时间时区 +08:00。');
  const timestamp = new Date(drawAt);
  if (!Number.isFinite(timestamp.getTime()) || beijingDate(timestamp) !== drawAt.slice(0, 10)) throw new Error('开奖日期不合法。');
  if (!/T21:15(:00)?\+08:00$/.test(drawAt)) throw new Error('本版按常规北京时间 21:15 封存，不能手动延后截止时间。');
  if (timestamp <= now) throw new Error('目标开奖时间已到，不能补记为开奖前预测。请同步最新数据并核对下一期。');
  const last = draws.at(-1);
  const targetDate = drawAt.slice(0, 10);
  const targetYear = targetDate.slice(0, 4);
  const scheduled = suggestedTarget(draws, now);
  if (targetDate !== scheduled.drawAt.slice(0, 10)) throw new Error('目标日期必须是最新数据后的下一常规开奖日，不能挪动日期补记预测；休市或调整请先核对官方安排。');
  if (targetIssue.slice(0, 4) !== targetYear) throw new Error('期号年份与开奖日期不一致。');
  if (targetDate <= last.date || Number(targetIssue) <= Number(last.issue)) throw new Error('目标必须晚于所有已导入的开奖结果。');
  const expected = targetYear === last.issue.slice(0, 4) ? String(Number(last.issue) + 1) : `${targetYear}001`;
  if (targetIssue !== expected) throw new Error(`请先补齐历史数据。当前数据之后的一期应为 ${expected}，不能跳期留档。`);
  if (targetYear !== last.issue.slice(0, 4) && Number(targetYear) !== Number(last.issue.slice(0, 4)) + 1) throw new Error('数据年份过旧，请先同步。');
  // A timestamp is supplied by the user, not a trusted official schedule. Never allow
  // a past calendar date to become a pre-draw record by changing only its issue.
  if (targetDate < beijingDate(now)) throw new Error('不能为过去日期创建开奖前记录。');
  const gapDays = (timestamp - new Date(`${last.date}T21:15:00+08:00`)) / 86400000;
  if (gapDays > 21) throw new Error('目标日期距最新数据超过 21 天，请先同步数据并核对开奖安排。');
  return { targetIssue, drawAt: `${drawAt.slice(0, 16)}:00+08:00` };
}

export function evaluateRecord(record, draws) {
  const actual = draws.find(draw => draw.issue === record.targetIssue);
  if (!actual) return null;
  if (new Date(record.createdAt) >= new Date(`${actual.date}T21:15:00+08:00`)) return { status: 'late', message: '记录时间不早于实际开奖日的封存截止，不计入前瞻验证。', actual };
  if (actual.date !== record.drawAt.slice(0, 10)) return { status: 'date_mismatch', message: '目标日期与实际开奖日期不符，请核对原始记录。', actual };
  const groups = record.selection.groups.map(group => ({
    redHits: group.red.filter(number => actual.red.includes(number)).length,
    blueHit: group.blue === actual.blue,
  }));
  const probability = record.fittedModel ? groupProbability(record.fittedModel, actual) : null;
  const metrics = probability ? {
    actualModelProbability: probability,
    logLoss: -Math.log(probability),
    baselineLogLoss: Math.log(TOTAL_COMBINATIONS),
    improvement: Math.log(TOTAL_COMBINATIONS) + Math.log(probability),
  } : null;
  return {
    status: 'evaluated', actual, groups, metrics,
    bestRedHits: Math.max(0, ...groups.map(group => group.redHits)),
    anyBlueHit: groups.some(group => group.blueHit),
    jackpotHits: groups.filter(group => group.redHits === 6 && group.blueHit).length,
  };
}

export async function saveRecord(dataDir, record, draws) {
  const snapshot = { draws, hash: digest(draws) };
  const snapshotDirectory = path.join(dataDir, 'snapshots');
  await mkdir(snapshotDirectory, { recursive: true });
  try { await writeFile(path.join(snapshotDirectory, `${snapshot.hash}.json`), JSON.stringify(snapshot), { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const folder = path.join(dataDir, 'predictions');
  await mkdir(folder, { recursive: true });
  const sealed = { ...record, contentHash: digest(record) };
  await writeFile(path.join(folder, `${record.id}.json`), `${JSON.stringify(sealed, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return sealed;
}

export async function loadRecords(dataDir, draws) {
  let files;
  try { files = await readdir(path.join(dataDir, 'predictions')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const file of files.filter(file => /^[\da-f-]+\.json$/i.test(file))) {
    const record = await readJson(path.join(dataDir, 'predictions', file));
    const { contentHash, ...original } = record;
    if (digest(original) !== contentHash) throw new Error(`预测记录 ${file} 内容校验失败，请检查本地文件。`);
    records.push({ ...record, evaluation: evaluateRecord(record, draws) });
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
