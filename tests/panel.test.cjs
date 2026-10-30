// Run with: node --test tests/panel.test.cjs
// Uses a separate Chrome profile and a local mock LLM; no API key is needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const http = require('node:http');

const extension = path.resolve(__dirname, '..');
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
  const article = '<!doctype html><meta charset="utf-8"><title>Reading test</title><article><h1>Reading test</h1>' +
    '<p>Researchers discovered a remarkable phenomenon in the ocean. Their findings could transform our understanding of marine ecosystems.</p>' +
    '<p>The scientists collected evidence over several years. They hope further research will explain these extraordinary observations.</p></article>';
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(article);
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const messages = JSON.parse(body).messages;
    const system = messages[0].content;
    let result;
    if (system.includes('summaryZh')) {
      result = { titleEn: 'Reading test', titleZh: '阅读测试', summaryZh: '这是测试摘要。' };
    } else if (system.includes('grammarDiagram')) {
      result = { vocab: [], grammarDiagram: 'Researchers discovered a phenomenon.\n主语 谓语 宾语', grammarPoints: [], context: '介绍研究发现。', translation: '研究人员发现了一种现象。' };
    } else if (messages.at(-1).content.includes('### 段落 0\n')) {
      result = { titleEntries: [], paragraphs: [{ index: 0, startWords: 'Researchers discovered', entries: [{ word: 'phenomenon', phonetic: 'fəˈnɑːmɪnən', pos: 'n.', sense: '现象' }] }] };
    } else {
      result = { paragraphs: [{ index: -1, startWords: 'Reading test', entries: [] }] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
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
  const click = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const visible = (selector) => page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    return !!element && element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== 'hidden';
  })()`);
  const active = () => page.evaluate("document.querySelector('.kandu-tab-active')?.dataset.sec");
  const buttons = () => page.evaluate("Array.from(document.querySelectorAll('#sec-actions button'), e => e.textContent)");
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
  });

  await t.test('summary and vocabulary buttons render results through the background worker', async () => {
    const cfg = { name: 'Local test', provider: 'openai', baseUrl, apiKey: 'test-only', model: 'mock' };
    await worker.evaluate(`chrome.storage.local.set(${JSON.stringify({ llms: [cfg], defaultLlm: cfg.name })})`);
    await loadArticle();
    await click('#sec-actions button');
    await until(() => visible('#sec-digest .kandu-summary'), 'Summary not shown');
    assert.equal(await active(), 'sec-digest');
    await click('[data-sec="sec-actions"]');
    await click('#sec-actions button:nth-child(2)');
    await until(() => visible('#sec-vocab .kandu-word'), 'Vocabulary not shown').catch(async (error) => {
      throw new Error(error.message + ': ' + await page.evaluate("document.querySelector('#sec-vocab').textContent") +
        '\n' + JSON.stringify(await worker.evaluate("chrome.storage.local.get('logs')")));
    });
    assert.equal(await active(), 'sec-vocab');
    assert.equal(await page.evaluate("document.querySelectorAll('article .kandu-badge').length"), 1);
    await click('[data-sec="sec-actions"]');
    await click('#sec-actions button:nth-child(3)');
    assert.equal(await visible('#sec-vocab .kandu-word'), true);
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
  });
});
