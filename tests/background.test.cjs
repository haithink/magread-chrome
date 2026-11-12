// node --test tests/*.test.cjs — isolated storage and mock responses only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const source = readFileSync(path.join(__dirname, '../background.js'), 'utf8');
const cfg = { name: 'mock', provider: 'openai', baseUrl: 'https://mock.invalid', model: 'mock', apiKey: 'test' };
const article = { url: 'https://article.invalid/read', title: 'Ocean discoveries', paragraphs: [
  'Researchers discovered a phenomenon in the ocean and collected evidence.',
  'The same phenomenon inspired research into these marine ecosystems.',
] };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(respond, initial = {}, failStorage = false) {
  const data = structuredClone({ llms: [cfg], defaultLlm: cfg.name, ...initial });
  const calls = [], saves = [], messages = [];
  let listener;
  const runtime = { lastError: null, getURL: (s) => 'extension://' + s, onMessage: { addListener(fn) { listener = fn; } } };
  const context = vm.createContext({
    Response, ReadableStream, TextDecoder, TextEncoder, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    chrome: { runtime, tabs: { async sendMessage(tabId, message, options) { messages.push({ tabId, message, options }); } }, storage: { local: {
      get(keys, callback) { setImmediate(() => callback(Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])])))); },
      set(values, callback) {
        const copy = structuredClone(values);
        setImmediate(() => {
          runtime.lastError = failStorage ? { message: 'QUOTA_BYTES quota exceeded' } : null;
          if (!failStorage) { Object.assign(data, copy); saves.push(copy); }
          callback(); runtime.lastError = null;
        });
      },
    } } },
    async fetch(url, options) {
      if (url.startsWith('extension://')) return new Response('the\tðə\nrun\trʌn\nstop\tstɑp\nbank\tbæŋk\nresearch\trɪsɜrtʃ\n');
      const body = JSON.parse(options.body);
      calls.push(body);
      return respond(body, calls.length, url, options);
    },
  });
  vm.runInContext(source, context);
  return { context, calls, data, saves, messages, run: (s) => vm.runInContext(s, context),
    request: (message, sender = { tab: { id: 7 }, frameId: 3 }) => new Promise((resolve) => listener(message, sender, resolve)),
    async generate(a = article, progress) { return JSON.parse(JSON.stringify(await context.genVocabFor(a, progress))); } };
}
function jsonResponse(result, reason = 'stop', extra = {}) {
  return new Response(JSON.stringify({ choices: [{ message: { content: typeof result === 'string' ? result : JSON.stringify(result), ...extra }, finish_reason: reason }] }),
    { headers: { 'content-type': 'application/json' } });
}
function rows(body, entry = () => []) {
  return { paragraphs: [...body.messages.at(-1).content.matchAll(/### 段落 (-?\d+)\n/g)].map((m) => ({ index: +m[1], entries: entry(+m[1]) })) };
}
const word = ['phenomenon', 'n.', '现象', '源于希腊语', false, 'fəˈnɑməˌnɑn'];
function sse(events, fragment = 7) {
  const bytes = new TextEncoder().encode(events.map((e) => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\r\n\r\n').join(''));
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += fragment) controller.enqueue(bytes.slice(i, i + fragment));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

test('compact vocab: combined title, candidate hints, local source, repeated paragraph words, cache reuse', async () => {
  const h = harness((body) => jsonResponse(rows(body, (i) => i >= 0 ? [word] : [])));
  const v = await h.generate();
  assert.deepEqual(v.processedParagraphs, [-1, 0, 1]);
  assert.equal(h.calls.length, 1);
  assert.equal(v.paragraphs[0].entries[0].word, 'phenomenon');
  assert.equal(v.paragraphs[1].entries[0].word, 'phenomenon');
  assert.match(v.paragraphs[0].entries[0].inText, /discovered a phenomenon in the/);
  assert.match(h.calls[0].messages.at(-1).content, /本地候选：.*phenomenon/);
  assert.ok(h.calls[0].max_tokens < 16000);
  assert.deepEqual(await h.generate(), v);
  assert.equal(h.calls.length, 1);
});

test('CET4 inflection filtering, original candidates, local phonetics and plural phrases', async () => {
  const h = harness((body) => jsonResponse(rows(body, (i) => i < 0 ? [] : [
    ['bank', 'n.', '常见义银行；本文义河岸', '', false, ''],
    ['marine ecosystem', 'n.', '海洋生态系统', '', true, 'məˈriːn ˈiːkoʊsɪstəm'],
  ])));
  await h.context.cet4();
  assert.deepEqual(Array.from(h.context.candidates('running stopped phenomena phenomena', new Set(['run', 'stop']))), ['phenomena']);
  const a = { ...article, paragraphs: ['These banks support marine ecosystems near the shore.'] };
  const v = await h.generate(a);
  assert.equal(v.paragraphs[0].entries[0].phonetic, 'bæŋk');
  assert.match(v.paragraphs[0].entries[1].inText, /marine ecosystems/);
});

test('only pending paragraphs requested, full long paragraph retained, legacy objects accepted', async () => {
  const h = harness((body) => jsonResponse(rows(body, () => [{ word: 'phenomenon', sense: '现象', phonetic: 'fəˈnɑməˌnɑn' }])));
  const old = { processedParagraphs: [-1, 0], titleEntries: [], paragraphs: [{ index: 0, entries: [], startWords: 'Old' }] };
  const key = 'vocab_' + h.context.urlHash(article.url);
  h.data[key] = old;
  const a = { ...article, paragraphs: [article.paragraphs[0], 'phenomenon ' + 'the '.repeat(1300) + 'lastword'] };
  const v = await h.generate(a);
  assert.equal(h.calls.length, 1);
  const prompt = h.calls[0].messages.at(-1).content;
  assert.doesNotMatch(prompt, /### 段落 (-1|0)\n/);
  assert.match(prompt, /lastword/);
  assert.deepEqual(v.processedParagraphs, [-1, 0, 1]);
});

test('long first paragraph shares title request and each chunk has only its own candidates', async () => {
  const h = harness((body) => jsonResponse(rows(body)));
  const a = { ...article, paragraphs: ['phenomenon ' + 'the '.repeat(1300), 'ecosystem ' + 'the '.repeat(650)] };
  await h.generate(a);
  assert.equal(h.calls.length, 2);
  const first = h.calls.find((c) => c.messages.at(-1).content.includes('### 段落 0\n')).messages.at(-1).content;
  const second = h.calls.find((c) => c.messages.at(-1).content.includes('### 段落 1\n')).messages.at(-1).content;
  assert.match(first, /### 段落 -1\n/);
  assert.doesNotMatch(first, /ecosystem/);
  assert.doesNotMatch(second, /phenomenon/);
  assert.match(h.context.vocabContext('phenomenon', 'These phenomena deserve study.'), /phenomena/);
});

test('two parallel workers, incremental saves, job deduplication and progress to both callers', async () => {
  let active = 0, peak = 0, resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  const h = harness(async (body, n) => {
    active++; peak = Math.max(peak, active);
    if (n > 1) await gate;
    active--;
    return jsonResponse(rows(body));
  });
  const a = { ...article, paragraphs: Array.from({ length: 4 }, (_, i) => `${i} ` + 'the '.repeat(650)) };
  const p1 = [], p2 = [];
  const first = h.generate(a, (p) => p1.push(p));
  const second = h.generate(a, (p) => p2.push(p));
  try {
    for (let i = 0; i < 100 && !h.saves.some((s) => Object.keys(s).some((k) => k.startsWith('vocab_'))); i++) await pause(5);
    const partial = h.data['vocab_' + h.context.urlHash(a.url)];
    assert.ok(partial.processedParagraphs.length > 0 && partial.processedParagraphs.length < 5);
  } finally { resume(); }
  const [v1, v2] = await Promise.all([first, second]);
  assert.deepEqual(v1, v2);
  assert.equal(h.calls.length, 4);
  assert.equal(peak, 2);
  assert.equal(p1.at(-1).finished, true);
  assert.equal(p2.at(-1).finished, true);
  assert.deepEqual(v1.processedParagraphs, [-1, 0, 1, 2, 3]);
});

test('missing, truncated, invalid and fabricated entries never mark chunks processed; manual retry works', async (t) => {
  const invalid = [
    { paragraphs: [{ index: -1, entries: [] }] },
    '{"paragraphs":[{"index":-1,"entries":[]}',
    { paragraphs: [{ index: -1, entries: [] }, { index: 0, entries: [['phantom', 'n.', '幻觉', '', false, 'x']] }] },
    { paragraphs: [{ index: -1, entries: [] }, { index: 0, entries: [['phenomenon', 'n.', '', '', false, 'x']] }] },
    { paragraphs: [{ index: -1, entries: [] }, { index: 0, entries: [['phenomenon', 'n.', '现象', '', false, '']] }] },
  ];
  for (const [i, bad] of invalid.entries()) await t.test(`invalid case ${i}`, async () => {
    let fixed = false;
    const h = harness((body) => jsonResponse(fixed ? rows(body) : bad));
    const a = { ...article, paragraphs: [article.paragraphs[0]] };
    const partial = await h.generate(a);
    assert.ok(!partial.processedParagraphs.includes(0), 'invalid paragraph must remain pending');
    assert.ok(Object.keys(partial.chunkFailures).length > 0);
    fixed = true;
    const v = await h.generate(a);
    assert.deepEqual(v.processedParagraphs, [-1, 0]);
    assert.deepEqual(v.chunkFailures, {});
    assert.equal(h.calls.length, 2);
  });
});

test('failed provider rotates, complete coverage required and failure records clear on success', async () => {
  const h = harness((body, n) => n === 1 ? jsonResponse({ paragraphs: [] }) : jsonResponse(rows(body)),
    { llms: [cfg, { ...cfg, name: 'backup', baseUrl: 'https://backup.invalid' }] });
  const v = await h.generate();
  assert.deepEqual(v.processedParagraphs, [-1, 0, 1]);
  assert.deepEqual(v.chunkFailures, {});
  assert.equal(h.calls.length, 2);
});

test('content changes invalidate vocab cache; storage failures propagate', async () => {
  const h = harness((body) => jsonResponse(rows(body)));
  await h.generate();
  await h.generate({ ...article, title: 'New title' });
  assert.equal(h.calls.length, 2);
  const failing = harness((body) => jsonResponse(rows(body)), {}, true);
  await assert.rejects(failing.generate(), /quota exceeded/);
  const unconfigured = harness(() => { throw new Error('should not call'); }, { llms: [] });
  await assert.rejects(unconfigured.generate(), /未配置 LLM/);
  assert.equal(unconfigured.calls.length, 0);
});

test('OpenAI SSE consumes split UTF8 frames, reasoning and finish reason without repeated calls', async () => {
  const h = harness(() => sse([
    { choices: [{ delta: { reasoning_content: 'thinking' } }] },
    { choices: [{ delta: { content: '中文' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]',
  ], 1));
  assert.equal(await h.context.chatLLM(cfg, 'system', 'user'), '中文');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].stream, true);
});

test('JSON length retries increase budget; rejected small budgets decrease below 4096', async () => {
  const h = harness((body, n) => n === 1 ? jsonResponse('{"partial":true}', 'length') : jsonResponse('ok'));
  assert.equal(await h.context.chatLLM(cfg, '', '', 2048), 'ok');
  assert.deepEqual(h.calls.map((c) => c.max_tokens), [2048, 4096]);
  const limited = harness((body, n) => n === 1 ? new Response('{"error":"max_tokens too large"}', { status: 400 }) : jsonResponse('ok'));
  assert.equal(await limited.context.chatLLM(cfg, '', '', 2048), 'ok');
  assert.deepEqual(limited.calls.map((c) => c.max_tokens), [2048, 1024]);
  const truncated = harness(() => jsonResponse('partial', 'length'));
  await assert.rejects(truncated.context.chatLLM(cfg, '', '', 32768), /截断/);
});

test('Anthropic stream and full endpoint, JSON fallback, interrupted stream and thinking-only retries', async () => {
  const h = harness((body, n, url) => {
    assert.equal(url, 'https://mock.invalid/v1/messages');
    return sse([
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '收到' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]);
  });
  assert.equal(await h.context.chatLLM({ ...cfg, provider: 'anthropic', baseUrl: 'https://mock.invalid/v1/messages' }, '', ''), '收到');
  const json = harness(() => jsonResponse('one request'));
  assert.equal(await json.context.chatLLM(cfg, '', ''), 'one request');
  assert.equal(json.calls.length, 1);
  const cut = harness(() => sse([{ choices: [{ delta: { content: 'unfinished' } }] }]));
  await assert.rejects(cut.context.chatLLM(cfg, '', ''), /意外中断/);
  const thinking = harness((body, n) => n === 1 ? jsonResponse('', 'length', { reasoning_content: 'thinking' }) : jsonResponse('done'));
  assert.equal(await thinking.context.chatLLM(cfg, '', '', 2048), 'done');
  assert.deepEqual(thinking.calls.map((c) => c.max_tokens), [2048, 4096]);
});

test('stalled request aborts and reports a useful timeout error', async () => {
  const h = harness((body, n, url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  h.context.setTimeout = (callback, ms) => setTimeout(callback, ms === 120000 ? 10 : ms);
  await assert.rejects(h.context.chatLLM(cfg, '', ''), /请求超时/);
  assert.equal(h.calls.length, 1);
});

test('DeepSeek uses non-thinking requests without changing other providers or saved configuration', async () => {
  const h = harness(() => jsonResponse('done'));
  const deepseek = { ...cfg, model: 'deepseek-chat' };
  await h.context.chatLLM(deepseek, '', '');
  assert.deepEqual(h.calls.at(-1).thinking, { type: 'disabled' });
  assert.equal(deepseek.thinkingMode, undefined);
  await h.context.chatLLM({ ...cfg, baseUrl: 'https://api.deepseek.com/v1' }, '', '');
  assert.deepEqual(h.calls.at(-1).thinking, { type: 'disabled' });
  await h.context.chatLLM(cfg, '', '');
  assert.equal(h.calls.at(-1).thinking, undefined);
  await h.context.chatLLM({ ...deepseek, thinkingMode: 'enabled' }, '', '');
  assert.deepEqual(h.calls.at(-1).thinking, { type: 'enabled' });
  const anthropic = harness(() => new Response(JSON.stringify({ content: [{ type: 'text', text: 'done' }] })));
  await anthropic.context.chatLLM({ ...deepseek, provider: 'anthropic' }, '', '');
  assert.deepEqual(anthropic.calls[0].thinking, { type: 'disabled' });
  await anthropic.context.chatLLM({ ...cfg, provider: 'anthropic', model: 'claude-test' }, '', '');
  assert.equal(anthropic.calls[1].thinking, undefined);
});

test('progress reports waiting, reasoning, receiving and retry attempts without streaming private text', async () => {
  const h = harness((body, n) => n === 1 ? jsonResponse('short', 'length') : sse([
    { choices: [{ delta: { reasoning_content: 'private thoughts' } }] },
    { choices: [{ delta: { content: 'final answer' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]));
  const progress = [];
  assert.equal(await h.context.chatLLM(cfg, 'private prompt', 'private article', 1000, (p) => progress.push(p)), 'final answer');
  assert.ok(progress.some((p) => p.phase === 'waiting' && p.attempt === 1));
  assert.ok(progress.some((p) => p.phase === 'retrying'));
  assert.ok(progress.some((p) => p.phase === 'thinking' && p.attempt === 2));
  assert.equal(progress.at(-1).chars, 12);
  assert.equal(progress.at(-1).attempt, 2);
  assert.doesNotMatch(JSON.stringify(progress), /private|final answer|apiKey/);
});

test('summary requests share a job, retain timings, validate output and reuse only matching cache', async () => {
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  const h = harness(async () => { await gate; return jsonResponse({ summaryZh: '海洋新发现。', titleZh: '海洋发现' }); });
  const p1 = [], p2 = [];
  const first = h.context.genDigestFor(article, (p) => p1.push(p));
  const second = h.context.genDigestFor(article, (p) => p2.push(p));
  resume();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(h.calls.length, 1);
  assert.ok(a.generationStats.outputChars > 0);
  assert.equal(p1.at(-1).phase, 'saving');
  assert.equal(p2.at(-1).phase, 'saving');
  await h.context.genDigestFor(article);
  assert.equal(h.calls.length, 1);
  await h.context.genDigestFor({ ...article, title: 'Changed' });
  assert.equal(h.calls.length, 2);
  const empty = harness(() => jsonResponse({ summaryZh: '' }));
  await assert.rejects(empty.context.genDigestFor(article), /摘要为空/);
  assert.ok(!Object.keys(empty.data).some((k) => k.startsWith('digest_')));
});

test('vocabulary progress counts successful persisted paragraphs and exposes failed chunks separately', async () => {
  let fail = true;
  const h = harness((body) => jsonResponse(fail ? { paragraphs: [] } : rows(body)));
  const p1 = [], p2 = [];
  await h.generate(article, (p) => p1.push(p));
  const failed = p1.at(-1);
  assert.equal(failed.completedParagraphs, 0);
  assert.equal(failed.totalParagraphs, 3);
  assert.equal(failed.done, 1);
  assert.equal(failed.failedChunks, 1);
  assert.ok(p1.some((p) => p.active.some((a) => a.phase === 'waiting')));
  fail = false;
  await h.generate(article, (p) => p2.push(p));
  assert.equal(p2.at(-1).completedParagraphs, 3);
  assert.equal(p2.at(-1).failedChunks, 0);
  assert.equal(p2.at(-1).active.length, 0);
});

test('task messages target the originating tab/frame with request identity, including all three generators', async () => {
  const h = harness((body) => jsonResponse(body.messages[0].content.includes('summaryZh')
    ? { summaryZh: '摘要' } : body.messages[0].content.includes('grammarDiagram')
      ? { translation: '译文' } : rows(body)), { llms: [{ ...cfg, model: 'deepseek-chat' }] });
  for (const [type, task] of [['genDigest', 'digest'], ['genVocab', 'vocab'], ['analyze', 'analysis']]) {
    const id = 'test-' + task;
    const result = await h.request({ type, article, requestId: id, payload: { ...article, sentence: 'A sentence.' } });
    assert.equal(result.ok, true);
    const messages = h.messages.filter((m) => m.message.requestId === id);
    assert.ok(messages.length > 0);
    assert.ok(messages.every((m) => m.tabId === 7 && m.options.frameId === 3 && m.message.task === task));
    assert.ok(messages.every((m) => m.message.url === article.url));
  }
  assert.ok(h.calls.every((c) => c.thinking.type === 'disabled'));
});

test('DeepSeek Anthropic route disables thinking for summary, vocabulary and sentence analysis', async () => {
  const local = { ...cfg, provider: 'anthropic', baseUrl: 'https://mock.invalid/anthropic', model: 'deepseek-v4-flash' };
  const h = harness((body, n, url) => {
    assert.equal(url, 'https://mock.invalid/anthropic/v1/messages');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.temperature, undefined);
    const result = body.system.includes('summaryZh') ? { summaryZh: '摘要' } : body.system.includes('grammarDiagram')
      ? { translation: '译文' } : rows(body);
    return sse([
      { type: 'content_block_delta', delta: { text: JSON.stringify(result) } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]);
  }, { llms: [local], defaultLlm: local.name });
  for (const type of ['genDigest', 'genVocab', 'analyze']) {
    const result = await h.request({ type, article, requestId: type, payload: { ...article, sentence: 'A sentence.' } });
    assert.equal(result.ok, true);
  }
  assert.equal(h.calls.length, 3);
  assert.ok(h.messages.every((m) => !m.message.phase || m.message.thinkingMode === 'disabled' || ['saving', 'processing', 'preparing', 'finished'].includes(m.message.phase)));
});

test('WIRED title and shrink inflections match locally without discarding a complete response', async () => {
  const a = { ...article, title: 'China’s Nvidia Honeypot Isn’t Surprising. Jensen Huang Fell for It Anyway.',
    paragraphs: ['The market shrank while the company had fallen for a promise. Its margins have shrunk.'] };
  const h = harness((body) => jsonResponse(rows(body, (i) => i === -1
    ? [['fall for', 'v.', '上当', '', false, 'fɔːl fɔːr']]
    : [['shrink', 'v.', '萎缩', '', false, 'ʃrɪŋk'], ['fall for', 'v.', '轻信', '', false, 'fɔːl fɔːr']])));
  const v = await h.generate(a);
  assert.deepEqual(v.processedParagraphs, [-1, 0]);
  assert.deepEqual(v.chunkFailures, {});
  assert.equal(h.calls.length, 1);
  assert.match(v.titleEntries[0].inText, /Fell for/);
  assert.match(v.paragraphs[0].entries[0].inText, /shrank/);
  assert.equal(h.context.vocabContext('shrink', 'The shrub is green.'), '');
});

test('invalid paragraph keeps valid siblings persisted and rotates only the remaining paragraphs', async () => {
  const backup = { ...cfg, name: 'backup', baseUrl: 'https://backup.invalid' };
  const h = harness((body, n) => jsonResponse(n === 1 ? rows(body, (i) => i === 0
    ? [['phantom', 'n.', '不存在的词', '', false, 'x']] : []) : rows(body)), { llms: [cfg, backup] });
  const v = await h.generate();
  assert.deepEqual(v.processedParagraphs, [-1, 0, 1]);
  assert.deepEqual(v.chunkFailures, {});
  const prompt = h.calls[1].messages.at(-1).content;
  assert.match(prompt, /### 段落 0\n/);
  assert.doesNotMatch(prompt, /### 段落 (-1|1)\n/);
  const partial = h.saves.find((s) => Object.keys(s).some((k) => k.startsWith('vocab_')));
  assert.deepEqual(Object.values(partial)[0].processedParagraphs, [-1, 1]);
});

test('manual retry requests only invalid paragraphs; equivalent named providers are not retried twice', async () => {
  let fixed = false;
  const duplicate = { ...cfg, name: 'same endpoint with another name', baseUrl: cfg.baseUrl + '/' };
  const h = harness((body) => jsonResponse(rows(body, (i) => !fixed && i === 0
    ? [['phantom', 'n.', '无效', '', false, 'x']] : [])), { llms: [cfg, duplicate] });
  const partial = await h.generate();
  assert.deepEqual(partial.processedParagraphs, [-1, 1]);
  assert.deepEqual(Object.keys(partial.chunkFailures), ['0']);
  assert.equal(h.calls.length, 1, 'same API credentials/model must not repeat the failed call');
  fixed = true;
  const final = await h.generate();
  assert.deepEqual(final.processedParagraphs, [-1, 0, 1]);
  assert.equal(h.calls.length, 2);
  assert.doesNotMatch(h.calls[1].messages.at(-1).content, /### 段落 (-1|1)\n/);
});
