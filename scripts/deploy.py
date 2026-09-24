#!/usr/bin/env python3
"""数智课堂线上部署脚本（纯前端 + API 重启）。

用法：
    SSH_HOST=64.90.3.51 SSH_USER=root SSH_PASS='xxx' python scripts/deploy.py
    SSH_HOST=64.90.3.51 SSH_USER=root SSH_PASS='xxx' python scripts/deploy.py --check   # 只体检，不改动

前置：pip install paramiko

流程：
    1. 备份服务器上未提交的本地改动（favicon 等）到 /root/bak_shuzhi_local_<日期>
    2. git pull --ff-only（只做快进，避免覆盖服务器本地改动）
    3. npm run build
    4. dist 属主修正为 www:www
    5. nginx -t && nginx -s reload
    6. pm2 restart shuzhi
    7. 冒烟：首页 200 / 新资源 200 / /api/auth/me 401

注意：凭据只从环境变量读取，绝不写进仓库。
"""

import datetime
import os
import sys

try:
    import paramiko
except ImportError:
    sys.exit('缺少 paramiko，请先 pip install paramiko')

HOST = os.environ.get('SSH_HOST', '')
USER = os.environ.get('SSH_USER', 'root')
PASS = os.environ.get('SSH_PASS', '')
APP_DIR = '/www/wwwroot/shuzhi'
PM2_NAME = 'shuzhi'
CHECK_ONLY = '--check' in sys.argv


def sh(cmd: str, timeout: int = 900):
    """在服务器上执行一条 shell 脚本，返回 (退出码, 输出)。"""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=PASS, timeout=30,
                   banner_timeout=30, auth_timeout=30)
    try:
        _, stdout, _ = client.exec_command(cmd, timeout=timeout, get_pty=True)
        out = stdout.read().decode('utf-8', 'replace')
        return stdout.channel.recv_exit_status(), out
    finally:
        client.close()


def step(title: str, cmd: str, timeout: int = 900):
    print(f'\n=== {title} ===')
    code, out = sh(cmd, timeout)
    print(out.rstrip())
    if code != 0:
        sys.exit(f'[失败] {title}（退出码 {code}），已中止，未继续后续步骤')
    return out


def main():
    if not (HOST and PASS):
        sys.exit('请先设置环境变量 SSH_HOST 和 SSH_PASS（SSH_USER 默认 root）')

    stamp = datetime.date.today().isoformat()
    backup_dir = f'/root/bak_shuzhi_local_{stamp}'

    if CHECK_ONLY:
        step('体检：项目与运行环境', f'''cd {APP_DIR}
git log --oneline -2
git status --porcelain
echo '--- pm2 ---'
pm2 list | grep -E '{PM2_NAME}|online'
echo '--- 端口 ---'
ss -tlnp 2>/dev/null | grep -E ':(80|443|4001)'
echo '--- 磁盘 ---'
df -h /www | tail -1''')
        return

    # 1) 备份服务器本地改动
    step('备份服务器本地改动', f'''mkdir -p {backup_dir}
cd {APP_DIR}
git status --porcelain | awk '{{print $2}}' | while read f; do cp -a "$f" {backup_dir}/ 2>/dev/null || true; done
ls -la {backup_dir}''')

    # 2) 拉代码（仅快进）
    step('拉取最新代码', f'''cd {APP_DIR}
git pull --ff-only origin main
git log --oneline -1''')

    # 3) 构建
    step('构建前端产物', f'cd {APP_DIR} && npm run build 2>&1 | tail -8', timeout=900)

    # 4) 属主 + nginx + pm2
    step('修正属主并重载 nginx', f'''cd {APP_DIR}
chown -R www:www dist
nginx -t && nginx -s reload && echo 'nginx reloaded' ''')
    step('重启 API 进程', f'pm2 restart {PM2_NAME} 2>&1 | tail -2 && sleep 3 && pm2 list | grep {PM2_NAME}')

    # 5) 冒烟
    smoke = step('冒烟验证', f'''echo -n '首页: '; curl -s -o /dev/null -w '%{{http_code}}\\n' --resolve shuzhiclass.com:443:127.0.0.1 https://shuzhiclass.com/
echo -n 'API:  '; curl -s -o /dev/null -w '%{{http_code}}\\n' http://127.0.0.1:4001/api/auth/me
echo '--- 首页引用的资源 ---'
curl -s --resolve shuzhiclass.com:443:127.0.0.1 https://shuzhiclass.com/ | grep -oE '/assets/index-[A-Za-z0-9_-]+\\.(js|css)' | sort -u''')
    if '200' not in smoke:
        sys.exit('[失败] 冒烟未通过，请检查上面输出')
    print('\n[完成] 部署成功')


if __name__ == '__main__':
    main()
