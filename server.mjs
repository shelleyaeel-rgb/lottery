import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { loadData, importData, syncData, fetchLatestOfficialDraw } from './src/data.mjs';
import { MODEL_CATALOG, fitModel, getProbabilities, generatePrediction } from './src/models.mjs';
import { ENGINE_VERSION, digest, readJson, atomicJson, suggestedTarget, validateTarget, saveRecord, loadRecords } from './src/workspace.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_FILES = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };

function respond(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) throw new Error('请求必须为 JSON 格式。');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Error('导入文件不能超过 5 MB。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求 JSON 解析失败。'); }
}

function runTraining(draws, now) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./src/train-worker.mjs', import.meta.url), { workerData: { draws, now: now.toISOString() } });
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error('训练超过 120 秒，请减少数据或检查运行环境。')); }, 120000);
    worker.once('message', message => { clearTimeout(timeout); message.error ? reject(new Error(message.error)) : resolve(message.result); });
    worker.once('error', error => { clearTimeout(timeout); reject(error); });
    worker.once('exit', code => { clearTimeout(timeout); if (code) reject(new Error(`训练进程退出：${code}`)); });
  });
}

export function createApp({ dataDir = process.env.SSQ_DATA_DIR || path.join(ROOT, 'data'), clock = () => new Date(), train = runTraining, verifyLatest = fetchLatestOfficialDraw } = {}) {
  let mutating = false;
  async function getTraining(draws) {
    const artifact = await readJson(path.join(dataDir, 'models', 'latest.json'));
    return artifact ? { ...artifact, stale: artifact.dataHash !== digest(draws) || artifact.engineVersion !== ENGINE_VERSION } : null;
  }
  async function state() {
    const data = await loadData(dataDir);
    const [training, predictions] = await Promise.all([getTraining(data.draws), loadRecords(dataDir, data.draws)]);
    return {
      data: { summary: data.summary, provenance: data.provenance }, models: MODEL_CATALOG,
      training, predictions, suggestedTarget: suggestedTarget(data.draws, clock()), serverTime: clock().toISOString(),
      engineVersion: ENGINE_VERSION,
    };
  }
  async function resolveModel(input, data) {
    const id = input.model || 'uniform';
    if (!MODEL_CATALOG.some(model => model.id === id)) throw new Error('请选择有效的概率模型。');
    if (!data.draws.length) throw new Error('请先同步或导入真实开奖数据。');
    const training = await getTraining(data.draws);
    if (id === 'uniform') return { fitted: fitModel(data.draws, { model: id }), trainingStatus: '均匀基线无需训练。', trainingId: null };
    if (input.useTrained) {
      if (!training || training.stale) throw new Error('当前数据没有对应的训练结果，请先训练或取消“使用训练参数”。');
      const fitted = training.models[id];
      if (!fitted) throw new Error('该模型未包含在训练结果中。');
      return { fitted, trainingStatus: training.report.reason, trainingId: training.id };
    }
    return { fitted: fitModel(data.draws, { model: id }), trainingStatus: '使用预先设定的平滑参数；尚未经过本数据集的独立验证。', trainingId: null };
  }

  return http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const host = request.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return respond(response, 403, { error: '仅允许本机访问。' });
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}`) return respond(response, 403, { error: '拒绝跨站请求。' });
    const url = new URL(request.url, `http://${host}`);
    let ownsLock = false;
    try {
      if (request.method === 'GET' && PUBLIC_FILES[url.pathname]) {
        const [file, type] = PUBLIC_FILES[url.pathname];
        const content = await readFile(path.join(ROOT, 'public', file));
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        response.end(content);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (request.method === 'GET' && url.pathname === '/api/state') return respond(response, 200, await state());
      if (request.method === 'GET' && url.pathname === '/api/draws') {
        const { draws } = await loadData(dataDir);
        const limit = Number(url.searchParams.get('limit') || 30);
        if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('期数范围应为 1—10000。');
        return respond(response, 200, { draws: draws.slice(-limit).reverse() });
      }
      if (request.method === 'GET' && /^\/api\/predictions\/[\da-f-]+$/.test(url.pathname)) {
        const { draws } = await loadData(dataDir);
        const record = (await loadRecords(dataDir, draws)).find(record => record.id === url.pathname.split('/').at(-1));
        if (!record) return respond(response, 404, { error: '没有找到该预测记录。' });
        response.setHeader('Content-Disposition', `attachment; filename="prediction-${record.targetIssue}-${record.id}.json"`);
        return respond(response, 200, record);
      }
      if (request.method !== 'POST') return respond(response, 404, { error: '页面或接口不存在。' });
      const allowed = ['/api/sync', '/api/import', '/api/train', '/api/preview', '/api/predict'];
      if (!allowed.includes(url.pathname)) return respond(response, 404, { error: '接口不存在。' });
      const input = await readBody(request);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求内容应为一个对象。');
      if (url.pathname !== '/api/preview') {
        if (mutating) return respond(response, 409, { error: '正在同步、训练或保存，请等待当前操作完成。' });
        mutating = true;
        ownsLock = true;
      }
      if (url.pathname === '/api/sync') { await syncData(dataDir); return respond(response, 200, { state: await state() }); }
      if (url.pathname === '/api/import') {
        if (typeof input.content !== 'string' || !input.content.trim()) throw new Error('请选择包含开奖数据的 JSON 或 CSV 文件。');
        await importData(dataDir, input.content, { source: `用户导入：${String(input.filename || '未命名文件').slice(0, 200)}`, now: clock() });
        return respond(response, 200, { state: await state() });
      }
      const data = await loadData(dataDir);
      if (url.pathname === '/api/train') {
        const previous = await getTraining(data.draws);
        if (previous && !previous.stale) return respond(response, 200, { state: await state(), reused: true });
        const artifact = await train(data.draws, clock());
        artifact.id = randomUUID();
        artifact.createdAt = clock().toISOString();
        artifact.dataHash = digest(data.draws);
        artifact.engineVersion = ENGINE_VERSION;
        await mkdir(path.join(dataDir, 'models'), { recursive: true });
        await writeFile(path.join(dataDir, 'models', `${artifact.id}.json`), JSON.stringify(artifact, null, 2), { flag: 'wx' });
        await atomicJson(path.join(dataDir, 'models', 'latest.json'), artifact);
        return respond(response, 200, { state: await state() });
      }
      const { fitted, trainingStatus, trainingId } = await resolveModel(input, data);
      if (url.pathname === '/api/preview') return respond(response, 200, { model: fitted, probabilities: getProbabilities(fitted), trainingStatus });
      const target = validateTarget(data.draws, input, clock());
      const seed = input.seed === undefined || input.seed === '' ? randomBytes(16).toString('hex') : String(input.seed);
      if (seed.length > 256) throw new Error('随机种子不能超过 256 个字符。');
      const options = {
        redCount: input.redCount ?? 8, blueCount: input.blueCount ?? 2, groupCount: input.groupCount ?? 5, seed,
      };
      const generated = generatePrediction(fitted, options);
      const officialCheck = await verifyLatest();
      const latest = data.draws.at(-1);
      if (!officialCheck?.draw || digest(officialCheck.draw) !== digest(latest)) throw new Error('本地最新一期与官方最新结果不一致，请先同步数据，再重新生成预测。');
      validateTarget(data.draws, input, clock());
      // Public API distinguishes pool coverage (hypothetically expanded) from the
      // unique complete groups actually recorded. Neither is a model's win claim.
      const selection = {
        ...generated,
        fairJackpotProbability: generated.candidatePoolFairJackpotProbability,
        groupJackpotProbability: generated.fairJackpotProbability,
      };
      const record = await saveRecord(dataDir, {
        id: randomUUID(), createdAt: clock().toISOString(), ...target, engineVersion: ENGINE_VERSION,
        model: fitted.id, params: fitted.params, fittedModel: fitted, trainingId, trainingStatus,
        dataCutoff: data.draws.at(-1), drawCount: data.draws.length, dataHash: digest(data.draws),
        sourceSummary: data.provenance, options, selection, probabilities: getProbabilities(fitted),
        officialCheck,
        archiveNote: '本地预测留档；系统不提供历史记录修改接口。校验码不是第三方时间戳或公证。',
      }, data.draws);
      return respond(response, 201, { record: { ...record, evaluation: null }, state: await state() });
    } catch (error) {
      if (!response.headersSent) respond(response, 400, { error: error.message || '处理失败。' });
      else response.end();
    } finally { if (ownsLock) mutating = false; }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1—65535 的端口号。');
  const server = createApp();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用；请关闭旧服务或设置 PORT。` : error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`双色球研究工作台：http://127.0.0.1:${port}\n数据保存在 ${process.env.SSQ_DATA_DIR || path.join(ROOT, 'data')}，关闭终端停止服务。`));
}
