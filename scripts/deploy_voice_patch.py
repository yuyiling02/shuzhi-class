"""Publish only locally built frontend assets, without restarting services."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import time
import warnings

warnings.filterwarnings('ignore', category=DeprecationWarning)
import paramiko

ROOT = Path(__file__).resolve().parents[1]
REMOTE = '/www/wwwroot/shuzhi/dist'
STATE = Path(tempfile.gettempdir()) / 'shuzhi-voice-release.json'


def build():
    stage = Path(tempfile.mkdtemp(prefix='shuzhi-voice-'))
    paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    for name in paths:
        if not name or name.split('/')[0] in {'public', 'server', 'scripts', 'teacher-studio-service', 'versions'}:
            continue
        if Path(name).suffix not in {'.ts', '.tsx', '.js', '.json', '.html', '.css', '.svg'}:
            continue
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(subprocess.check_output(['git', 'show', f'HEAD:{name}'], cwd=ROOT))
    for name in ['browserSpeechRecognition.ts', 'xiaozhiSpeechService.ts']:
        (stage / 'services' / name).write_bytes((ROOT / 'services' / name).read_bytes())
    # Vite loads the same build configuration without publishing private env files.
    for name in ['.env', '.env.local']:
        if (ROOT / name).exists():
            (stage / name).write_bytes((ROOT / name).read_bytes())
    subprocess.run(['cmd', '/c', 'mklink', '/J', str(stage / 'node_modules'), str(ROOT / 'node_modules')], check=True, capture_output=True)
    subprocess.run(['cmd', '/c', 'npm', 'run', 'build'], cwd=stage, check=True)
    STATE.write_text(json.dumps({'stage': str(stage)}))
    print(f'BUILD_READY {stage}')


def connect():
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(os.environ.get('SSH_HOST', '64.90.3.51'), username=os.environ.get('SSH_USER', 'root'),
                   password=os.environ['SSH_PASS'], timeout=15, banner_timeout=20, auth_timeout=20)
    return client


def run(client, command):
    _, out, err = client.exec_command(command, timeout=25)
    value = out.read().decode()
    error = err.read().decode()
    if out.channel.recv_exit_status():
        raise RuntimeError(error or value)
    return value


def health(client):
    load = float(run(client, 'cat /proc/loadavg').split()[0])
    cores = int(run(client, 'getconf _NPROCESSORS_ONLN').strip())
    memory = run(client, 'cat /proc/meminfo')
    available = int(next(line.split()[1] for line in memory.splitlines() if line.startswith('MemAvailable:')))
    print(json.dumps({'load_1m': load, 'cores': cores, 'available_mb': available // 1024}))
    if load >= cores * 0.8 or available < 250 * 1024:
        raise RuntimeError('Server is busy; no publication attempted')


def publish(apply=False):
    client = connect()
    try:
        health(client)
        print(run(client, 'df -h /www | tail -1'))
        if not apply:
            return
        stage = Path(json.loads(STATE.read_text())['stage']) / 'dist'
        files = [(file.name, file.read_bytes()) for file in sorted((stage / 'assets').iterdir()) if file.is_file()]
        index = (stage / 'index.html').read_bytes()
        with client.open_sftp() as sftp:
            old = sftp.open(f'{REMOTE}/index.html', 'rb').read()
            stamp = time.strftime('%Y%m%d-%H%M%S')
            backup = f'{REMOTE}/index.html.before-voice-{stamp}'
            with sftp.open(backup, 'wb') as handle:
                handle.write(old)
            for name, content in files:
                target = f'{REMOTE}/assets/{name}'
                expected = hashlib.sha256(content).hexdigest()
                try:
                    actual = run(client, f'sha256sum {shlex.quote(target)}').split()[0]
                except RuntimeError:
                    actual = ''
                if actual == expected:
                    print(f'UNCHANGED {name}')
                    continue
                health(client)
                temporary = f'{target}.voice-{stamp}'
                with sftp.open(temporary, 'wb') as handle:
                    for offset in range(0, len(content), 32768):
                        handle.write(content[offset:offset + 32768])
                        time.sleep(0.04)  # At most 0.8 MB/s, one upload at a time.
                if run(client, f'sha256sum {shlex.quote(temporary)}').split()[0] != expected:
                    raise RuntimeError('Upload checksum mismatch')
                sftp.chmod(temporary, 0o644)
                sftp.posix_rename(temporary, target)
                print(f'UPLOADED {name} {len(content)} bytes')
            health(client)
            if sftp.open(f'{REMOTE}/index.html', 'rb').read() != old:
                raise RuntimeError('Another release changed index.html; switch cancelled')
            temporary = f'{REMOTE}/index.html.voice-{stamp}'
            with sftp.open(temporary, 'wb') as handle:
                handle.write(index)
            sftp.chmod(temporary, 0o644)
            sftp.posix_rename(temporary, f'{REMOTE}/index.html')
            try:
                served = run(client, 'curl --fail --silent --show-error --max-time 15 --resolve shuzhiclass.com:443:127.0.0.1 https://shuzhiclass.com/')
                if served.encode() != index:
                    raise RuntimeError('Served index does not match release')
                for name, _ in files:
                    print(name, run(client, f'curl --fail --silent --show-error --max-time 15 --resolve shuzhiclass.com:443:127.0.0.1 -o /dev/null -w "%{{http_code}}" https://shuzhiclass.com/assets/{name}'))
                api_status = run(client, 'curl --silent --show-error --max-time 10 -o /dev/null -w "%{http_code}" http://127.0.0.1:4001/api/auth/me')
                print('API', api_status)
                if api_status != '401':
                    raise RuntimeError('API health verification failed')
            except Exception:
                sftp.posix_rename(backup, f'{REMOTE}/index.html')
                raise
            print(f'RELEASE_VERIFIED backup={backup}')
        health(client)
    finally:
        client.close()


if __name__ == '__main__':
    if '--build' in sys.argv:
        build()
    else:
        publish('--apply' in sys.argv)
