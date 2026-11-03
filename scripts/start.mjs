import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.PORT || 3210);
const majorVersion = Number(process.versions.node.split('.')[0]);

if (majorVersion < 22) {
  console.error(`当前 Node.js 为 ${process.version}，请安装 Node.js 22 或更新版本。`);
  process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT 必须为 1—65535 的端口号。');
  process.exit(1);
}

const url = `http://127.0.0.1:${port}/`;

async function isReady() {
  try {
    const response = await fetch(`${url}api/state`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const state = await response.json();
    return typeof state.engineVersion === 'string' && state.engineVersion.startsWith('ssq-lab/');
  } catch { return false; }
}

function openBrowser() {
  console.log(`工作台已就绪：${url}`);
  if (process.argv.includes('--no-open')) return;
  let command, args;
  if (process.platform === 'win32') {
    command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe');
    args = ['url.dll,FileProtocolHandler', url];
  } else {
    command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    args = [url];
  }
  const browser = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  browser.once('error', () => console.error(`浏览器未能自动打开，请手动访问 ${url}`));
  browser.once('exit', code => { if (code) console.error(`浏览器未能自动打开，请手动访问 ${url}`); });
  browser.unref();
}

if (await isReady()) {
  console.log('检测到工作台已经运行，直接打开页面。');
  openBrowser();
} else {
  console.log('正在启动双色球研究工作台，请稍候…');
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  let exited = false;
  let stopping = false;
  child.once('error', error => {
    exited = true;
    process.exitCode = 1;
    console.error(`无法启动服务：${error.message}`);
  });
  child.once('exit', code => {
    exited = true;
    if (!stopping) process.exitCode = code ?? 1;
  });
  const stop = () => {
    stopping = true;
    if (!exited) child.kill();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('exit', stop);
  let ready = false;
  for (let attempt = 0; attempt < 30 && !exited; attempt++) {
    if (await isReady()) { ready = true; break; }
    await delay(250);
  }
  if (ready && !exited) {
    console.log('请保持这个启动窗口打开；关闭窗口或按 Ctrl+C 可停止服务。');
    openBrowser();
  } else if (!exited) {
    console.error(`服务没有就绪。请查看上面的错误信息，或确认端口 ${port} 没有被其他程序占用。`);
    stop();
    process.exitCode = 1;
  }
}
