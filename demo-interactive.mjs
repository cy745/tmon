// tmon 交互式命令演示：Y/N 确认 + 密码输入（不回显）
// 用法：node bin/tmon.js "node demo-interactive.mjs"，然后在 Web 终端里用键盘回答
import readline from 'node:readline';
import { stdin, stdout } from 'node:process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

/** 密码输入：raw mode 下不回显，逐字符显示 *，支持退格与 Ctrl-C 取消 */
function askSecret(question) {
  return new Promise((resolve) => {
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    let pwd = '';
    const onData = (chunk) => {
      // 一次 data 事件可能包含多个字符（粘贴场景），逐字符处理
      for (const ch of chunk.toString()) {
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          stdout.write('\n');
          resolve(pwd);
          return;
        }
        if (ch === '') {
          // Ctrl-C（Web 端 Ctrl-C 按钮注入的 \x03 也会走这里）
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          stdout.write('\n');
          resolve(null);
          return;
        }
        if (ch === '' || ch === '\b') {
          // 仅当已有输入时才擦除（避免擦掉提示文字）
          if (pwd.length > 0) {
            pwd = pwd.slice(0, -1);
            stdout.write('\b \b');
          }
        } else if (ch !== '') {
          pwd += ch;
          stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

console.log('════════════════════════════════════════');
console.log('  tmon 交互式命令演示（Web 端可代答）');
console.log('════════════════════════════════════════');

// 场景 1：普通文本输入
const name = await ask('第一步：请输入你的名字 > ');
console.log(`你好，${name}！`);

await sleep(500);

// 场景 2：Y/N 确认
const ok = await ask('第二步：是否继续执行"危险"操作? [y/N] > ');
if (ok.trim().toLowerCase() !== 'y') {
  console.log('已取消操作，演示结束。');
  process.exit(0);
}
console.log('好，继续...');

await sleep(800);

// 场景 3：密码输入（不回显，显示 *）
const pwd = await askSecret('第三步：请输入管理员密码（不回显）> ');
if (pwd === null) {
  console.log('密码输入被取消（你按了 Ctrl-C）。');
  process.exit(1);
}
console.log(`密码长度 ${pwd.length} 位，校验通过！`);

await sleep(500);

console.log('════════════════════════════════════════');
console.log('演示完成！试试刷新页面重跑，输入不同答案');
console.log('════════════════════════════════════════');
