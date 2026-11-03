import { fileURLToPath } from 'node:url';
import { syncData } from '../src/data.mjs';

const dataDir = fileURLToPath(new URL('../data/', import.meta.url));
try {
  const result = await syncData(dataDir);
  console.log(`已保存 ${result.summary.count} 期真实开奖数据：${result.summary.first.issue}—${result.summary.last.issue}`);
  console.log(`最新开奖日期：${result.summary.last.date}`);
  console.log(`数据 SHA-256：${result.summary.datasetHash}`);
  for (const warning of result.summary.warnings) console.log(`提示：${warning}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
