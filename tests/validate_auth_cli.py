"""Exercise the real terminal CLI with a disposable database; no password echo."""
import os
import pty
import select
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PASSWORD = 'CLIpass9!'


def run_terminal(arguments, answers):
    master, slave = pty.openpty()
    process = subprocess.Popen(
        ['node', 'backend/manage-users.cjs', *arguments], cwd=ROOT,
        stdin=slave, stdout=slave, stderr=slave, env=environment,
        start_new_session=True,
    )
    os.close(slave)
    output = b''
    consumed = 0

    def wait_for(prompt):
        nonlocal output, consumed
        deadline = time.monotonic() + 10
        expected = prompt.encode()
        while expected not in output[consumed:]:
            if time.monotonic() >= deadline:
                raise AssertionError(f'CLI prompt timeout: {prompt}')
            if select.select([master], [], [], .1)[0]:
                try:
                    data = os.read(master, 8192)
                except OSError:
                    break
                if not data:
                    break
                output += data
        assert expected in output[consumed:], f'Missing prompt: {prompt}'
        consumed = output.index(expected, consumed) + len(expected)

    try:
        for prompt, answer in answers:
            wait_for(prompt)
            os.write(master, (answer + '\n').encode())
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                try:
                    data = os.read(master, 8192)
                except OSError:
                    break
                if not data:
                    break
                output += data
            elif process.poll() is not None:
                break
        code = process.wait(timeout=3)
        text = output.decode(errors='replace')
        assert PASSWORD not in text, 'CLI must never echo the password'
        return code, text
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)


with tempfile.TemporaryDirectory(prefix='lab-auth-cli-') as directory:
    environment = {**os.environ, 'LAB_DB_PATH': str(Path(directory) / 'test.sqlite')}
    password_answers = [('密码（9–128 位，输入不显示）：', PASSWORD), ('再次输入密码：', PASSWORD)]
    code, output = run_terminal(['init-admin'], [('账号（3–80 位字母/数字/_ . @ -）：', 'cli_admin'), ('显示姓名：', 'CLI管理员'), *password_answers])
    assert code == 0 and '账号已创建' in output, output
    code, output = run_terminal(['init-admin'], [])
    assert code != 0 and '已初始化' in output, output
    code, output = run_terminal(['disable', 'cli_admin'], [])
    assert code != 0 and '最后一位有效管理员' in output, output
    code, output = run_terminal(['create'], [('账号（3–80 位字母/数字/_ . @ -）：', 'cli_member'), ('显示姓名：', 'CLI成员'), ('角色（admin/member，默认 member）：', ''), *password_answers])
    assert code == 0 and '账号已创建' in output, output
    for command in ['disable', 'enable']:
        code, output = run_terminal([command, 'cli_member'], [])
        assert code == 0 and '旧会话已撤销' in output, output
    code, output = run_terminal(['reset-password', 'cli_member'], password_answers)
    assert code == 0 and '密码已重置' in output, output
    code, output = run_terminal(['rename', 'cli_member', 'cli_member_new'], [])
    assert code == 0 and '账号已更新为 cli_member_new' in output, output
    code, output = run_terminal(['rename', 'cli_admin', 'cli_member_new'], [])
    assert code != 0 and '新账号已存在' in output, output
print('Auth CLI validation passed: initialization, duplicate guard, member creation, disable/enable, password reset, rename and hidden password input.')
