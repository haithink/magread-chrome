// Run with: node --test tests/panel.test.cjs
// Uses a separate Chrome profile and a local mock LLM; no API key is needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { mkdtemp, readFile, rm, mkdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const http = require('node:http');

const extension = path.resolve(__dirname, '..');
const screenshotDirectory = process.env.KANDU_SCREENSHOT_DIR ? path.resolve(process.env.KANDU_SCREENSHOT_DIR) : null;
if (screenshotDirectory) {
  const relative = path.relative(extension, screenshotDirectory);
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) {
    throw new Error('KANDU_SCREENSHOT_DIR must be outside the unpacked extension directory; Chrome rejects reserved debug directory names.');
  }
}
const chrome = process.env.CHROME_PATH || path.resolve(extension, '../chrome-win64/chrome.exe');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(read, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await pause(50);
  }
  throw new Error(message);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(() => {
        pending.delete(next);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15000);
      pending.set(next, { resolve, reject, timer });
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  }
  return {
    send,
    close: () => socket.close(),
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
  };
}

test('article panel in Chrome', { skip: !existsSync(chrome), timeout: 90000 }, async (t) => {
  const profile = await mkdtemp(path.join(tmpdir(), 'kandu-panel-'));
  const article = `<!doctype html><meta charset="utf-8"><title>The Ocean's Hidden Signals</title>
    <style>body{background:#fdfcf8;color:#253e38;margin:0;font:18px/1.9 Georgia,serif}article{max-width:650px;margin:65px 6vw}h1{font-size:46px;line-height:1.15;margin:15px 0 34px}.kicker{font:12px/1.6 sans-serif;letter-spacing:2px;color:#987d49}p{margin:0 0 25px}</style>
    <article><div class="kicker">FIELD NOTES · MARINE SCIENCE</div><h1>The Ocean's Hidden Signals</h1>
    <p>Researchers discovered a remarkable phenomenon in the ocean. Their findings could transform our understanding of marine ecosystems. Beneath the surface, tiny organisms respond to changes in light and temperature, leaving traces that instruments can detect.</p>
    <p>The scientists collected evidence over several years. They hope further research will explain these extraordinary observations. By comparing measurements from different depths, the team is learning how the ocean connects living systems across vast distances.</p></article>`;
  let vocabCalls = 0, digestCalls = 0, holdTask = null, releaseResponse;
  const capturedRequests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(article);
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body), messages = request.messages;
    capturedRequests.push(request);
    const system = request.system || messages[0].content;
    let result;
    if (system.includes('summaryZh')) {
      digestCalls++;
      result = { titleEn: "The Ocean's Hidden Signals", titleZh: '海洋深处的隐秘信号', summaryZh: '研究人员通过长期观测发现，海洋微小生物对光线与温度的变化会留下可探测的痕迹。比较不同深度的测量数据，有助于理解海洋生态系统如何跨越广阔距离相互联系。新的发现为认识深海生命与环境变化提供了线索，研究团队正继续收集证据。' };
    } else if (system.includes('grammarDiagram')) {
      result = { vocab: [], grammarDiagram: 'Researchers discovered a phenomenon.\n主语 谓语 宾语', grammarPoints: [], context: '介绍研究发现。', translation: '研究人员发现了一种现象。' };
    } else {
      vocabCalls++;
      result = { paragraphs: [...messages.at(-1).content.matchAll(/### 段落 (-?\d+)\n/g)].map((m) => ({
        index: +m[1], entries: +m[1] === 0 ? [['phenomenon', 'n.', '现象', '', false, 'fəˈnɑːmɪnən']] : [],
      })) };
    }
    const task = system.includes('summaryZh') ? 'digest' : system.includes('grammarDiagram') ? 'analysis' : 'vocab';
    if (holdTask === task) {
      holdTask = null;
      const text = JSON.stringify(result), split = Math.floor(text.length / 2);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text.slice(0, split) } }] }) + '\n\n');
      await new Promise((resolve) => { releaseResponse = resolve; });
      releaseResponse = null;
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text.slice(split) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(request.system
      ? { content: [{ type: 'text', text: JSON.stringify(result) }], stop_reason: 'end_turn' }
      : { choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(chrome, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  const clients = [];
  t.after(async () => {
    if (releaseResponse) releaseResponse();
    for (const client of clients) client.close();
    const stopped = child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await stopped;
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const port = await until(async () => {
    try { return (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
    catch { return null; }
  }, 'Chrome did not start');
  const targets = () => fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const worker = await until(async () => {
    for (const target of (await targets()).filter((item) => item.type === 'service_worker')) {
      const candidate = await connect(target.webSocketDebuggerUrl);
      if (await candidate.evaluate("typeof chrome !== 'undefined' && chrome.runtime?.getManifest().name === '刊读助手'")) return candidate;
      candidate.close();
    }
    return null;
  }, 'Reading extension service worker not found');
  clients.push(worker);
  await worker.send('Runtime.enable');
  await until(() => worker.evaluate("typeof chrome !== 'undefined' && !!chrome.storage?.local"), 'Extension storage API not available');
  const page = await connect((await targets()).find((target) => target.type === 'page').webSocketDebuggerUrl);
  clients.push(page);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1360, height: 960, deviceScaleFactor: 1, mobile: false });
  const click = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const visible = (selector) => page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    return !!element && element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== 'hidden';
  })()`);
  const active = () => page.evaluate("document.querySelector('.kandu-tab-active')?.dataset.sec");
  const buttons = () => page.evaluate("Array.from(document.querySelectorAll('#sec-actions button'), e => e.textContent)");
  async function screenshot(name) {
    if (!screenshotDirectory) return;
    await mkdir(screenshotDirectory, { recursive: true });
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(screenshotDirectory, name + '.png'), Buffer.from(data, 'base64'));
  }
  async function loadArticle() {
    await page.evaluate('window.__previousTestDocument = true');
    await page.send('Page.navigate', { url: baseUrl + '/article' });
    await until(() => page.evaluate("!window.__previousTestDocument && document.readyState === 'complete'"), 'Article navigation did not finish');
    await until(() => visible('#kandu-pill'), 'Reading pill not shown');
    await click('#kandu-pill');
    await until(() => visible('#sec-actions button'), 'Action buttons not shown');
    // Let the extension finish its asynchronous storage/cache callback.
    await pause(200);
  }

  await t.test('opens one panel with all three buttons and working tabs', async () => {
    await loadArticle();
    assert.equal(await page.evaluate("document.querySelectorAll('#kandu-panel').length"), 1);
    assert.deepEqual(await buttons(), ['生成摘要', '生成生词表', '查看生词表']);
    assert.equal(await active(), 'sec-actions');
    await click('[data-sec="sec-digest"]');
    assert.equal(await active(), 'sec-digest');
    await click('[data-sec="sec-actions"]');
    assert.equal(await visible('#sec-actions button'), true);
    await screenshot('actions');
  });

  await t.test('missing LLM configuration leaves navigation and buttons usable', async () => {
    await worker.evaluate('chrome.storage.local.clear()');
    await loadArticle();
    await click('#sec-actions button');
    await until(() => page.evaluate("document.querySelector('#sec-digest')?.textContent.includes('未配置 LLM')"), 'Missing configuration error not shown');
    assert.equal(await active(), 'sec-digest');
    await click('[data-sec="sec-actions"]');
    assert.equal(await visible('#sec-actions button'), true);
    assert.equal(await page.evaluate("document.querySelector('#sec-actions button').disabled"), false);
    await click('#kandu-gen-vocab');
    await until(() => page.evaluate("document.querySelector('#sec-vocab')?.textContent.includes('未配置 LLM')"), 'Vocabulary configuration error not shown');
    assert.equal(await page.evaluate("document.querySelector('#kandu-gen-vocab').disabled"), false);
  });

  await t.test('summary and vocabulary buttons render results through the background worker', async () => {
    const cfg = { name: 'Local test', provider: 'openai', baseUrl, apiKey: 'test-only', model: 'mock' };
    await worker.evaluate(`chrome.storage.local.set(${JSON.stringify({ llms: [cfg], defaultLlm: cfg.name })})`);
    await loadArticle();
    await click('#sec-actions button');
    await until(() => visible('#sec-digest .kandu-summary'), 'Summary not shown');
    assert.equal(await active(), 'sec-digest');
    await screenshot('summary');
    await click('[data-sec="sec-actions"]');
    await click('#kandu-gen-vocab');
    await until(() => visible('#sec-vocab .kandu-word'), 'Vocabulary not shown').catch(async (error) => {
      throw new Error(error.message + ': ' + await page.evaluate("document.querySelector('#sec-vocab').textContent") +
        '\n' + JSON.stringify(await worker.evaluate("chrome.storage.local.get('logs')")));
    });
    assert.equal(await active(), 'sec-vocab');
    assert.equal(await page.evaluate("document.querySelectorAll('article .kandu-badge').length"), 1);
    await click('[data-sec="sec-actions"]');
    await click('#kandu-view-vocab');
    assert.equal(await visible('#sec-vocab .kandu-word'), true);
    assert.equal(vocabCalls, 1, 'title and paragraphs should share one request');
    assert.equal(await page.evaluate("document.querySelector('#kandu-gen-vocab').textContent"), '生词表已完成');
    await screenshot('vocabulary');
  });

  await t.test('cached results keep the action tab selected and closing/reopening keeps one panel', async () => {
    await loadArticle();
    assert.equal(await active(), 'sec-actions');
    assert.equal(await visible('#sec-actions button'), true);
    await click('.kandu-close');
    assert.equal(await page.evaluate("document.querySelectorAll('#kandu-panel').length"), 0);
    await click('#kandu-pill');
    await until(() => visible('#sec-actions button'), 'Reopened buttons not shown');
    await pause(200);
    assert.equal(await page.evaluate("document.querySelectorAll('#kandu-panel').length"), 1);
    assert.equal(await active(), 'sec-actions');
    assert.equal(await page.evaluate("document.querySelector('#kandu-gen-vocab').textContent"), '生词表已完成');
    await click('#kandu-gen-vocab');
    await until(() => visible('#sec-vocab .kandu-word'), 'Cached vocabulary not shown after reopening');
    assert.equal(vocabCalls, 1, 'badge text must not change article cache identity');
    await click('article .kandu-badge');
    assert.equal(await visible('article .kandu-inline-vocab'), true);
    await click('article .kandu-badge');
    assert.equal(await visible('article .kandu-inline-vocab'), false);
  });

  await t.test('sentence analysis remains visible after the response', async () => {
    await page.evaluate(`(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('article p'));
      selection.removeAllRanges();
      selection.addRange(range);
      document.querySelector('article p').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    })()`);
    await until(() => visible('.kandu-selbtn'), 'Analyze button not shown');
    await click('.kandu-selbtn');
    await until(() => visible('#sec-analysis .kandu-trans'), 'Sentence analysis not shown');
    assert.equal(await active(), 'sec-analysis');
    assert.equal(await page.evaluate("document.querySelectorAll('#kandu-panel').length"), 1);
    await screenshot('analysis');
  });

  await t.test('streaming summary keeps its progress, elapsed timer and disabled button after closing/reopening', async () => {
    await worker.evaluate("chrome.storage.local.clear()");
    const cfg = { name: 'Local DeepSeek', provider: 'openai', baseUrl, apiKey: 'test-only', model: 'deepseek-chat' };
    await worker.evaluate(`chrome.storage.local.set(${JSON.stringify({ llms: [cfg], defaultLlm: cfg.name })})`);
    await loadArticle();
    holdTask = 'digest';
    const before = digestCalls;
    await click('#kandu-gen-digest');
    try {
      await until(() => page.evaluate("document.querySelector('#sec-digest .kandu-progress-detail')?.textContent.includes('已接收')"), 'Streaming summary characters not shown');
      assert.equal(await page.evaluate("document.querySelector('#sec-digest progress').hasAttribute('value')"), false, 'summary must not invent a percentage');
      await screenshot('summary-progress');
      await click('[data-sec="sec-actions"]');
      assert.equal(await page.evaluate("document.querySelector('#kandu-gen-digest').disabled"), true);
      await click('.kandu-close');
      await click('#kandu-pill');
      await until(() => visible('#kandu-gen-digest'), 'Reopened action page not shown');
      assert.equal(await page.evaluate("document.querySelector('#kandu-gen-digest').disabled"), true);
      await click('[data-sec="sec-digest"]');
      assert.equal(await visible('#sec-digest .kandu-progress'), true);
      const previous = await page.evaluate("document.querySelector('#sec-digest .kandu-progress-title').textContent");
      await pause(1100);
      assert.notEqual(await page.evaluate("document.querySelector('#sec-digest .kandu-progress-title').textContent"), previous);
      await worker.evaluate(`chrome.tabs.query({}).then(tabs => Promise.all(tabs.filter(t => t.url?.startsWith(${JSON.stringify(baseUrl)})).map(t => chrome.tabs.sendMessage(t.id, { type: 'generationProgress', task: 'digest', requestId: 'stale', url: t.url, phase: 'receiving', chars: 999999 }))))`);
      assert.equal(await page.evaluate("document.querySelector('#sec-digest .kandu-progress-detail').textContent.includes('999999')"), false);
      await click('[data-sec="sec-actions"]');
    } finally { if (releaseResponse) releaseResponse(); }
    await until(() => page.evaluate("!!document.querySelector('#sec-digest .kandu-summary') && !document.querySelector('#sec-digest .kandu-progress')"), 'Summary did not finish');
    assert.equal(await active(), 'sec-actions', 'completion must preserve the tab the user chose');
    assert.equal(digestCalls, before + 1);
    assert.deepEqual(capturedRequests.at(-1).thinking, { type: 'disabled' });
    assert.equal(await page.evaluate("document.querySelector('#kandu-gen-digest').disabled"), false);
  });

  await t.test('streaming vocabulary keeps progress through view-list and close/reopen without duplicate calls', async () => {
    await loadArticle();
    holdTask = 'vocab';
    const before = vocabCalls;
    await click('#kandu-gen-vocab');
    try {
      await until(() => page.evaluate("document.querySelector('#sec-vocab .kandu-progress-detail')?.textContent.includes('字符')"), 'Streaming vocabulary progress not shown');
      assert.equal(await page.evaluate("document.querySelector('#sec-vocab progress').value"), 0);
      assert.match(await page.evaluate("document.querySelector('#sec-vocab .kandu-progress-title').textContent"), /0\/3/);
      await click('[data-sec="sec-actions"]');
      await click('#kandu-view-vocab');
      assert.equal(await visible('#sec-vocab .kandu-progress'), true);
      await click('.kandu-close');
      await click('#kandu-pill');
      await until(() => visible('#kandu-gen-vocab'), 'Vocabulary action page did not reopen');
      assert.equal(await page.evaluate("document.querySelector('#kandu-gen-vocab').disabled"), true);
      await click('[data-sec="sec-vocab"]');
      assert.equal(await visible('#sec-vocab .kandu-progress'), true);
      await screenshot('vocabulary-progress');
    } finally { if (releaseResponse) releaseResponse(); }
    await until(() => page.evaluate("!!document.querySelector('#sec-vocab .kandu-word') && !document.querySelector('#sec-vocab .kandu-progress')"), 'Vocabulary did not finish');
    assert.equal(vocabCalls, before + 1);
    assert.equal(await page.evaluate("document.querySelector('#kandu-gen-vocab').disabled"), false);
    assert.deepEqual(capturedRequests.at(-1).thinking, { type: 'disabled' });
  });

  await t.test('background completion saves results without reopening a panel the reader closed', async () => {
    for (const task of ['digest', 'vocab']) {
      await worker.evaluate(`chrome.storage.local.get(null).then(data => chrome.storage.local.remove(Object.keys(data).filter(k => k.startsWith('${task}_'))))`);
      await loadArticle();
      holdTask = task;
      await click('#kandu-gen-' + task);
      try {
        await until(() => !!releaseResponse, 'Held response was not started');
        await click('.kandu-close');
      } finally { if (releaseResponse) releaseResponse(); }
      await until(() => worker.evaluate(`chrome.storage.local.get(null).then(data => Object.keys(data).some(k => k.startsWith('${task}_')))`), 'Result not persisted after closing');
      await pause(150);
      assert.equal(await page.evaluate("document.querySelector('#kandu-panel') === null"), true, 'background result must respect the closed panel');
      await click('#kandu-pill');
      await until(() => visible('#sec-actions button'), 'Completed panel did not reopen');
      await click(`[data-sec="sec-${task}"]`);
      await until(() => visible(task === 'digest' ? '#sec-digest .kandu-summary' : '#sec-vocab .kandu-word'), 'Saved result not restored');
    }
  });

  await t.test('DeepSeek Anthropic configuration sends disabled thinking for all three tasks in Chrome', async () => {
    await worker.evaluate('chrome.storage.local.clear()');
    const cfg = { name: 'Local DeepSeek', provider: 'anthropic', baseUrl: baseUrl + '/anthropic', apiKey: 'test-only', model: 'deepseek-v4-flash' };
    await worker.evaluate(`chrome.storage.local.set(${JSON.stringify({ llms: [cfg], defaultLlm: cfg.name })})`);
    await loadArticle();
    const before = capturedRequests.length;
    await click('#kandu-gen-digest');
    await until(() => visible('#sec-digest .kandu-summary'), 'Anthropic summary not shown');
    await click('[data-sec="sec-actions"]');
    await click('#kandu-gen-vocab');
    await until(() => visible('#sec-vocab .kandu-word'), 'Anthropic vocabulary not shown');
    await page.evaluate(`(() => {
      const selection = window.getSelection(), range = document.createRange();
      range.selectNodeContents(document.querySelector('article p'));
      selection.removeAllRanges(); selection.addRange(range);
      document.querySelector('article p').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    })()`);
    await until(() => visible('.kandu-selbtn'), 'Anthropic sentence button not shown');
    await click('.kandu-selbtn');
    await until(() => visible('#sec-analysis .kandu-trans'), 'Anthropic sentence result not shown');
    const requests = capturedRequests.slice(before);
    assert.equal(requests.length, 3);
    assert.ok(requests.every((r) => r.system && r.thinking?.type === 'disabled'));
    assert.ok(requests.every((r) => r.temperature === undefined));
  });

  await t.test('narrow screen keeps tabs, close and progress footer within viewport', async () => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 680, deviceScaleFactor: 1, mobile: false });
    await click('[data-sec="sec-actions"]');
    const bounds = await page.evaluate("(() => { const p=document.querySelector('#kandu-panel').getBoundingClientRect(); const b=document.querySelector('.kandu-panel-body'); return {left:p.left,right:p.right,bottom:p.bottom,width:innerWidth,height:innerHeight,scrollable:b.scrollHeight>b.clientHeight}; })()");
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height, JSON.stringify(bounds));
    assert.equal(bounds.scrollable, true);
    assert.equal(await visible('.kandu-close'), true);
    assert.equal(await visible('.kandu-footer'), true);
    await screenshot('narrow-actions');
  });

  await t.test('settings can edit, rename and delete a profile without creating duplicates', async () => {
    const extensionUrl = await worker.evaluate('chrome.runtime.getURL("popup.html")');
    await page.send('Emulation.clearDeviceMetricsOverride');
    await page.send('Page.navigate', { url: extensionUrl });
    await until(() => visible('#llmList div'), 'Settings profile list not shown');
    await click('#llmList div');
    assert.equal(await page.evaluate("document.querySelector('#fName').value"), 'Local DeepSeek');
    await page.evaluate("document.querySelector('#fName').value = 'Renamed test'");
    await click('#bSave');
    await until(() => page.evaluate("document.querySelector('#status').textContent.includes('已保存')"), 'Edited profile not saved');
    const saved = await worker.evaluate('chrome.storage.local.get(["llms", "defaultLlm"])');
    assert.equal(saved.llms.length, 1);
    assert.equal(saved.llms[0].name, 'Renamed test');
    assert.equal(saved.defaultLlm, 'Renamed test');
    await screenshot('settings');
    await click('#llmList div');
    await click('#bDel');
    await until(() => page.evaluate("document.querySelectorAll('#llmList div').length === 0"), 'Profile not deleted');
    assert.equal(await page.evaluate("document.querySelector('#fName').value"), '');
  });
});
