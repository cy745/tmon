// tmon 演示脚本：慢速分步输出 + 进度上报（通过 tmon progress 子命令）
// 用法：node bin/tmon.js "node demo.mjs"（executor 会注入 TMON_TASK_ID 环境变量）
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmon = path.join(__dirname, 'bin', 'tmon.js');
const STEPS = 20;

for (let i = 1; i <= STEPS; i++) {
  console.log(`[${i}/${STEPS}] 处理数据块 ${i} ...`);
  // 模拟偶发缓慢（观察间隔热力图的变化）
  if (i % 7 === 0) await sleep(3000);
  else if (i % 5 === 0) await sleep(1500);
  else await sleep(600);
  try {
    execSync(`node "${tmon}" progress ${Math.round((i / STEPS) * 100)} "步骤 ${i}/${STEPS}"`);
  } catch {
    /* 非 tmon 环境下运行则跳过进度上报 */
  }
}
console.log('全部完成！');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
