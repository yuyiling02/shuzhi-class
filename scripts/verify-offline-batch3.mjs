// 离线验证：用 Edge + CDP 拦截所有外网请求，确认课件仍能渲染
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const EDGE = String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;
const PORT = 9333;
const PROFILE = path.join(os.tmpdir(), 'offline-verify-edge-' + Date.now());

const edge = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const r = await fetch(url);
  return r.json();
}

let ws;
let msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

async function main() {
  // 等待 CDP 就绪
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await getJson(`http://127.0.0.1:${PORT}/json`); break; }
    catch { await sleep(250); }
  }
  if (!targets) throw new Error('Edge CDP 未就绪');
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  // 拦截所有外部域名请求 -> 模拟断网；localhost/127.0.0.1 放行
  await send('Network.setBlockedURLs', {
    urls: [
      '*://*.jsdelivr.net/*',
      '*://*.cloudflare.com/*',
      '*://*.unpkg.com/*',
      '*://cdnjs.cloudflare.com/*',
      '*://cdn.jsdelivr.net/*',
      '*://unpkg.com/*',
      '*://fonts.googleapis.com/*',
      '*://fonts.gstatic.com/*',
    ],
  });

  const results = [];
  const cases = [
    ['g8/b/c01/p0101.html', '二力平衡'],
    ['g8/b/c01/p0110.html', '弹簧弹力与伸长量'],
    ['g8/b/c01/p0100.html', '阻力对物体运动的影响'],
    ['g8/b/c02/p0103.html', '压力的作用效果'],
    ['g8/b/c01/p0102.html', '滑动摩擦力'],
    ['g8/b/c04/p0097.html', '杠杆平衡条件'],
    ['g8/b/c04/p0099.html', '滑轮组'],
    ['g8/b/c02/p0186.html', '活塞式抽水机'],
    ['g2/a/c06/p0187.html', '油膜法估测油酸分子大小'],
  ];

  for (const [rel, name] of cases) {
    const errors = [];
    const failedReq = [];
    const onMsg = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push(m.params.exceptionDetails.text || 'JS异常');
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        const txt = (m.params.args || []).map((a) => a.value || a.description || '').join(' ');
        if (txt) errors.push('console: ' + txt.slice(0, 120));
      }
      if (m.method === 'Network.loadingFailed') {
        failedReq.push(m.params.errorText || 'failed');
      }
    };
    ws.addEventListener('message', onMsg);
    const url = `http://localhost:3000/visual-classroom/physics/${rel}`;
    await send('Page.navigate', { url });
    await sleep(2500);
    const evalRes = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        title: document.title,
        canvases: document.querySelectorAll('canvas').length,
        canvasOk: Array.from(document.querySelectorAll('canvas')).some(c => c.width > 0 && c.height > 0),
        threeLoaded: typeof THREE !== 'undefined' || !!document.querySelector('script[type=module]'),
        bodyLen: document.body ? document.body.innerText.length : 0
      })`,
      returnByValue: true,
    });
    ws.removeEventListener('message', onMsg);
    let info = {};
    try { info = JSON.parse(evalRes.result.value); } catch {}
    results.push({ name, rel, ...info, errors: errors.slice(0, 3), failedReq: failedReq.slice(0, 3) });
  }

  console.log(JSON.stringify(results, null, 2));
  ws.close();
}

main().catch((e) => { console.error('验证失败:', e.message); process.exitCode = 1; })
  .finally(() => { try { edge.kill(); } catch {} setTimeout(() => process.exit(), 500); });
