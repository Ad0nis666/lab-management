const readline = require('node:readline/promises');
const { AuthStore } = require('./auth.cjs');

// Passwords are read from the terminal without echo; never from command arguments.
function secret(question) {
  if (!process.stdin.isTTY) throw new Error('请在交互终端输入密码，不要通过命令行参数传入。');
  return new Promise(resolve => {
    let value = '';
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
    const onData = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') { process.stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (char === '\r' || char === '\n') {
          process.stdin.off('data', onData); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); resolve(value); return;
        }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', onData);
    process.stdout.write(question);
  });
}
async function main() {
  const [command, target, newAccount] = process.argv.slice(2);
  if (!['init-admin', 'create', 'disable', 'enable', 'reset-password', 'rename'].includes(command)) {
    throw new Error('用法：npm run init-admin；npm run user -- create；npm run user -- disable|enable|reset-password 账号；npm run user -- rename 旧账号 新账号');
  }
  const store = new AuthStore({ dbPath: process.env.LAB_DB_PATH });
  let rl;
  try {
    if (command === 'rename') {
      if (!target || !newAccount) throw new Error('请指定旧账号和新账号。');
      const user = store.renameAccount(target, newAccount);
      console.log(`账号已更新为 ${user.account}，原密码和角色保留，请重新登录。`); return;
    }
    if (['disable', 'enable'].includes(command)) {
      if (!target) throw new Error('请指定账号。');
      store.setActive(target, command === 'enable'); console.log('账号状态已更新，旧会话已撤销。'); return;
    }
    if (command === 'init-admin' && store.db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new Error('已初始化账号，请使用账号管理命令。');
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const account = command === 'reset-password' ? target : (await rl.question('账号（3–80 位字母/数字/_ . @ -）：')).trim();
    if (!account) throw new Error('请指定账号。');
    const display_name = command === 'reset-password' ? '' : (await rl.question('显示姓名：')).trim();
    const role = command === 'create' ? (await rl.question('角色（admin/member，默认 member）：')).trim() || 'member' : 'admin';
    rl.close(); rl = undefined;
    const password = await secret('密码（9–128 位，输入不显示）：');
    const confirmation = await secret('再次输入密码：');
    if (password !== confirmation) throw new Error('两次密码不一致，未保存。');
    if (command === 'reset-password') await store.resetPassword(account, password);
    else await store.createUser({ account, display_name, password, role }, command === 'init-admin');
    console.log(command === 'reset-password' ? '密码已重置，旧会话已撤销。' : '账号已创建，可以登录。');
  } finally { rl?.close(); await store.dummyHash; store.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
