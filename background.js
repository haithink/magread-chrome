// 刊读助手 · service worker：LLM 调用、摘要/生词/句解编排、缓存
// 与桌面版 core_llm/core_prompts/core_gen 同源的能力移植（MV3 service worker）


// ---------------- 存储 ----------------
async function stGet(keys) {
  return new Promise((res) => chrome.storage.local.get(keys, (r) => res(r || {})));
}
async function stSet(obj) {
  return new Promise((res) => chrome.storage.local.set(obj, () => res()));
}
function urlHash(url) {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) >>> 0;
  return "u" + h.toString(36);
}

// ---------------- 配置 ----------------
async function getConfig() {
  const { llms, defaultLlm } = await stGet(["llms", "defaultLlm"]);
  const list = Array.isArray(llms) ? llms : [];
  const dn = defaultLlm && list.some((p) => p.name === defaultLlm) ? defaultLlm : (list[0] ? list[0].name : "");
  const def = list.find((p) => p.name === dn) || list[0] || null;
  return { llms: list, defaultLlm: dn, defaultCfg: def };
}
function rotation(cfg, config) {
  const rot = [cfg];
  for (const p of config.llms) {
    if (!rot.some((r) => r.name === p.name)) rot.push(p);
  }
  return rot;
}

// ---------------- LLM 客户端 ----------------
function isBudgetReject(text) {
  const t = (text || "").toLowerCase();
  return ["max_tokens", "max_output_tokens", "max output", "output token", "maximum",
          "too large", "out of range", "must be less than", "must be greater than",
          "invalid_request_error"].some((k) => t.includes(k));
}
function isCensor(text) {
  const t = (text || "").toLowerCase();
  return ["sensitive", "敏感", "upstream_error", "content_filter", "content filter"].some((k) => t.includes(k));
}
function llmEndpoint(cfg) {
  let base = (cfg.baseUrl || "").trim().replace(/\/+$/, "");
  if (cfg.provider === "anthropic") {
    if (/\/v\d+$/.test(base)) return base + "/messages";
    return base + "/v1/messages";
  }
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return base + "/chat/completions";
  return base + "/v1/chat/completions";
}
async function chatOnce(cfg, system, user, maxTokens) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.provider === "anthropic") {
    headers["x-api-key"] = cfg.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = "Bearer " + cfg.apiKey;
  }
  let body;
  if (cfg.provider === "anthropic") {
    body = { model: cfg.model, max_tokens: maxTokens, system: system || undefined,
             messages: [{ role: "user", content: user }] };
  } else {
    body = { model: cfg.model, max_tokens: maxTokens, temperature: 0.3,
             messages: [...(system ? [{ role: "system", content: system }] : []),
                        { role: "user", content: user }] };
  }
  const resp = await fetch(llmEndpoint(cfg), {
    method: "POST", headers,
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (resp.status !== 200) {
    const err = new Error(`HTTP ${resp.status}（${llmEndpoint(cfg)}）：${text.slice(0, 200)}`);
    err.respText = text;
    err.status = resp.status;
    throw err;
  }
  let obj;
  try { obj = JSON.parse(text); } catch { return text.slice(0, 2000); }
  if (cfg.provider === "anthropic" && Array.isArray(obj.content)) {
    const t = obj.content.filter((b) => b && b.type === "text").map((b) => b.text || "").join("");
    if (t.trim()) return t;
  }
  if (Array.isArray(obj.choices) && obj.choices[0]) {
    const c = obj.choices[0];
    const t = (c.message && c.message.content) || c.text || "";
    if (String(t).trim()) return String(t);
  }
  if (obj.error && obj.error.message) throw new Error("接口报错：" + String(obj.error.message).slice(0, 300));
  return "";
}
function stripThink(t) { return (t || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim(); }

async function chatLLM(cfg, system, user, maxTokens = 4000) {
  let budget = maxTokens;
  for (let attempt = 0; attempt < 4; attempt++) {
    let raw, failed = null;
    try {
      raw = await chatOnce(cfg, system, user, budget);
    } catch (e) {
      if (isBudgetReject(String(e.message || e)) && attempt < 3) {
        budget = Math.max(4096, Math.floor(budget / 2));
        continue;
      }
      throw e;
    }
    const content = stripThink(raw);
    const cut = /"finish_reason"\s*:\s*"length"/.test(raw) || (cfg.provider === "anthropic" && /"stop_reason"\s*:\s*"max_tokens"/.test(raw));
    if (content && !cut) return content;
    if (cut && budget < 32768) { budget = Math.min(budget * 2, 32768); continue; }
    if (content) return content;
    throw new Error("响应里没有内容");
  }
  throw new Error("响应里没有内容");
}

// ---------------- JSON 提取/修补 ----------------
function extractJsonBlock(text) {
  let t = (text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.search(/[{[]/);
  if (start > 0) t = t.slice(start);
  const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (end >= 0 && end < t.length - 1) t = t.slice(0, end + 1);
  return t.trim();
}
function repairJson(text) {
  let s = text.trim();
  if (s.length < 2) return null;
  let inStr = false, esc = false;
  for (const c of s) {
    if (esc) { esc = false; continue; }
    if (c === "\\" && inStr) esc = true;
    else if (c === '"') inStr = !inStr;
  }
  if (inStr) {
    const cut = s.lastIndexOf('"');
    if (cut <= 0) return null;
    s = s.slice(0, cut);
  }
  let prev = null;
  while (prev !== s) {
    prev = s;
    s = s.replace(/[,\s]+$/, "").replace(/,\s*"[^"]*"\s*$/, "");
  }
  const stack = [];
  inStr = false; esc = false;
  for (const c of s) {
    if (esc) { esc = false; continue; }
    if (c === "\\" && inStr) esc = true;
    else if (c === '"') inStr = !inStr;
    else if (!inStr) {
      if (c === "{") stack.push("}");
      else if (c === "[") stack.push("]");
      else if (c === "}" && stack[stack.length - 1] === "}") stack.pop();
      else if (c === "]" && stack[stack.length - 1] === "]") stack.pop();
    }
  }
  while (stack.length) s += stack.pop();
  return s;
}
function parseJsonLoose(text, wantArray) {
  const t = extractJsonBlock(text);
  const load = (s) => {
    const o = JSON.parse(s);
    if (wantArray && Array.isArray(o)) return o;
    if (wantArray && o && typeof o === "object") {
      if ("index" in o) return [o];
      const lists = Object.values(o).filter((v) => Array.isArray(v));
      if (lists.length === 1) return lists[0];
    }
    if (!wantArray && o && typeof o === "object" && !Array.isArray(o)) return o;
    throw new Error("shape");
  };
  try { return load(t); } catch {}
  const repaired = repairJson(t);
  if (repaired) { try { return load(repaired); } catch {} }
  throw new Error("模型输出不是有效 JSON（可能被长度截断）：" + text.slice(0, 160));
}

// ---------------- 提示词（与桌面版同源） ----------------
const P = {
  digestSystem: () =>
    "你是资深外刊编辑和译者。用户会给你一篇英文杂志文章的标题和正文，" +
    "请生成：1) titleEn：文章英文标题（若给出标题原样保留）；" +
    "2) titleZh：地道、简洁的中文标题（意译，不要直译腔）；3) summaryZh：100～150 字的中文内容摘要，" +
    "概括核心论点与关键信息，不用套话。只输出 JSON 对象，" +
    '格式：{"titleEn":"...","titleZh":"...","summaryZh":"..."}，不要输出任何其他文字，不要展示思考过程。',
  vocabSystem: (label) =>
    "你是英语外刊精读助教。学生的词汇量基准是「" + label + "」：" +
    "四级及更常用的词一律不算生词，不要收录；只收录超纲词、专业术语、熟词僻义（常见词的非常用义项）。" +
    "专有名词（人名/地名/机构名）不收录。缩略语如 IMF、NATO 收录为术语。" +
    "每个词条给出：word（原形，小写）、phonetic（美式音标，每个词条都必须给出，不许省略）、" +
    "pos（词性，如 n. / v. / adj.）、sense（中文释义，取「本文语境下的义项」，不超过 25 字；" +
    "熟词僻义须写明「常见义 X；本文义 Y」）、inText（该词在原文中出现的短语，含前后 2～4 个词，不超过 40 字符）、" +
    "root（词根词缀拆解或词源线索，不超过 40 字；没有词根故事的给空串，不强加）、term（是否术语，布尔）。" +
    "务必控制总输出长度，宁可精简也不要截断。" +
    "只输出 JSON 对象，格式：" +
    '{"paragraphs":[{"index":段落编号,"startWords":"该段开头前几个单词","entries":[{...}]}],"titleEntries":[标题生词]}' +
    "没有生词的段落也要有对应元素，entries 为空数组。不要输出 JSON 以外的任何文字，不要展示思考过程。",
  vocabUser: (title, chunk) => {
    let out = `以下是文章《${title.slice(0, 80)}》的标题和逐段文本。段落编号是全文统一编号。\n`;
    out += "输出 JSON 里 paragraphs 的 index 必须原样使用我给出的段落编号，绝不要自行重新计数。\n";
    out += "startWords 直接摘取该段开头的连续几个单词。\n\n";
    out += `### 标题（段落编号 -1）\n${title}\n`;
    for (const [index, text] of chunk) {
      out += `\n### 段落 ${index}\n${text.slice(0, 3500)}\n`;
    }
    return out;
  },
  analysisSystem: () =>
    "你是英语语法精讲老师，给词汇量 CET-4～6 的中国学生逐句精讲外刊。按固定格式输出 JSON：" +
    '1) vocab：疑难词汇数组 [{"word":"","phonetic":"美式音标","sense":"中文释义；熟词僻义须写「常见义 X；本文义 Y」","note":"词根词缀拆解或说明，可空串"}]，' +
    "只收学生可能不懂的词，专有名词不收；" +
    "2) grammarDiagram：语法对齐图解——把英文原句按成分用空格排开（可多行），每个成分正下方对齐写中文成分名" +
    "（主语/谓语/宾语/形式主语/定语从句等），短语和从句用方括号 [] 框住，从属说明用 └── 前缀；换行用 \\n；" +
    '3) grammarPoints：编号语法点数组 [{"title":"...","text":"..."}]；' +
    "4) context：该句在文章中的功能、与上下文的呼应、作者修辞意图，1～2 句；" +
    "5) translation：一两句自然的中文参考译文。只输出 JSON 对象，不要输出任何其他文字，不要展示思考过程。",
  analysisUser: (sentence, before, after, title) => {
    const lines = [`文章标题：${title.slice(0, 80)}`];
    if (before) lines.push(`上句：${before.slice(0, 200)}`);
    lines.push(`待解析句子：${sentence}`);
    if (after) lines.push(`下句：${after.slice(0, 200)}`);
    return lines.join("\n");
  },
};

// ---------------- 消息路由 ----------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "getConfig": {
          const c = await getConfig();
          sendResponse({ ok: true, config: c });
          break;
        }
        case "saveConfig": {
          await stSet({ llms: msg.llms || [], defaultLlm: msg.defaultLlm || "" });
          sendResponse({ ok: true });
          break;
        }
        case "testLLM": {
          const r = await chatLLM(msg.cfg, "你是连通性测试助手。", "请只回复两个字母：ok", 2000);
          sendResponse({ ok: true, reply: String(r).slice(0, 80) });
          break;
        }
        case "listModels": {
          const base = (msg.cfg.baseUrl || "").trim().replace(/\/+$/, "");
          let url;
          if (/\/chat\/completions$/.test(base) || /\/messages$/.test(base))
            url = base.slice(0, base.lastIndexOf("/")) + "/models";
          else if (/\/v\d+$/.test(base)) url = base + "/models";
          else url = base + "/v1/models";
          const headers = msg.cfg.provider === "anthropic"
            ? { "x-api-key": msg.cfg.apiKey, "anthropic-version": "2023-06-01" }
            : { Authorization: "Bearer " + msg.cfg.apiKey };
          const resp = await fetch(url, { headers });
          const text = await resp.text();
          if (resp.status !== 200) throw new Error(`HTTP ${resp.status}：${text.slice(0, 200)}`);
          const obj = JSON.parse(text);
          const ids = (obj.data || obj.models || []).map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean);
          sendResponse({ ok: true, models: ids.sort() });
          break;
        }
        case "getCache": {
          const h = urlHash(msg.url);
          const keys = ["digest_" + h, "vocab_" + h];
          const got = await stGet(keys);
          sendResponse({ ok: true, digest: got["digest_" + h] || null, vocab: got["vocab_" + h] || null });
          break;
        }
        case "genDigest": {
          const a = msg.article;
          const h = urlHash(a.url);
          const got = await stGet(["digest_" + h]);
          if (got["digest_" + h]) { sendResponse({ ok: true, digest: got["digest_" + h], cached: true }); break; }
          const cfg = await defaultCfg();
          const text = a.paragraphs.join("\n").slice(0, 6000);
          const raw = await chatLLM(cfg, P.digestSystem(),
            `文章标题：${a.title}\n\n正文：\n${text}`, 4000);
          const obj = parseJsonLoose(raw, false);
          const digest = {
            titleEn: String(obj.titleEn || a.title),
            titleZh: String(obj.titleZh || ""),
            summaryZh: String(obj.summaryZh || ""),
            ts: Date.now(),
          };
          await stSet({ ["digest_" + h]: digest });
          sendResponse({ ok: true, digest });
          break;
        }
        case "genVocab": {
          const vocab = await genVocabFor(msg.article, (p) => {
            if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, { type: "vocabProgress", ...p }).catch(() => {});
          });
          sendResponse({ ok: true, vocab });
          break;
        }
        case "analyze": {
          const a = msg.payload;
          const h = urlHash(a.url) + "_s" + hashStr(a.sentence);
          const got = await stGet(["analysis_" + h]);
          if (got["analysis_" + h]) { sendResponse({ ok: true, analysis: got["analysis_" + h], cached: true }); break; }
          const cfg = await defaultCfg();
          const raw = await chatLLM(cfg, P.analysisSystem(),
            P.analysisUser(a.sentence, a.before, a.after, a.title), 6000);
          const obj = parseJsonLoose(raw, false);
          const analysis = {
            vocab: Array.isArray(obj.vocab) ? obj.vocab : [],
            grammarDiagram: String(obj.grammarDiagram || "").replace(/\\n/g, "\n"),
            grammarPoints: Array.isArray(obj.grammarPoints) ? obj.grammarPoints : [],
            context: String(obj.context || ""),
            translation: String(obj.translation || ""),
          };
          await stSet({ ["analysis_" + h]: analysis });
          sendResponse({ ok: true, analysis });
          break;
        }
        default:
          sendResponse({ ok: false, error: "unknown type" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // 异步 sendResponse
});

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
async function defaultCfg() {
  const c = await getConfig();
  if (!c.defaultCfg) throw new Error("未配置 LLM：请点浏览器工具栏的刊读助手图标进行设置");
  return c.defaultCfg;
}

// ---------------- CET-4 词表（本地粗筛） ----------------
let cet4Set = null;
async function cet4() {
  if (cet4Set) return cet4Set;
  const url = chrome.runtime.getURL("assets/cet4_words.txt");
  const text = await (await fetch(url)).text();
  cet4Set = new Set(text.split("\n").map((l) => l.split("\t")[0].trim().toLowerCase()).filter(Boolean));
  return cet4Set;
}
function lemmaForms(word) {
  const w = word.toLowerCase();
  const forms = [w];
  if (w.endsWith("'s")) forms.push(w.slice(0, -2));
  if (w.endsWith("s") && !w.endsWith("ss")) forms.push(w.slice(0, -1));
  if (w.endsWith("es")) forms.push(w.slice(0, -2));
  if (w.endsWith("ies")) forms.push(w.slice(0, -3) + "y");
  if (w.endsWith("ed")) { forms.push(w.slice(0, -1), w.slice(0, -2)); if (w.endsWith("ied")) forms.push(w.slice(0, -3) + "y"); }
  if (w.endsWith("ing")) { forms.push(w.slice(0, -3), w.slice(0, -3) + "e"); if (w.endsWith("ying")) forms.push(w.slice(0, -4) + "ie"); }
  return [...new Set(forms)];
}

// ---------------- 摘要 ----------------
// （genDigest 在消息路由里内联实现）

// ---------------- 生词表编排（分块 + LLM 轮换 + 续传） ----------------
async function genVocabFor(article, progress) {
  const h = urlHash(article.url);
  const got = await stGet(["vocab_" + h]);
  const existing = got["vocab_" + h] || null;
  const processed = new Set((existing && existing.processedParagraphs) || []);
  const chunkFailures = (existing && existing.chunkFailures) || {};
  const sections = {};
  for (const p of (existing && existing.paragraphs) || []) sections[p.index] = p;
  const titleEntries = (existing && existing.titleEntries) || [];
  const config = await getConfig();

  const rot = config.defaultCfg ? [config.defaultCfg, ...config.llms.filter((p) => p.name !== config.defaultCfg.name)] : config.llms;

  const units = [[-1, article.title], ...article.paragraphs.map((t, i) => [i, t])];
  const dictSet = await cet4();
  const cand = {};
  for (const [idx, text] of units) {
    if (idx === -1) continue;
    cand[idx] = candidates(text, dictSet);
  }

  const chunks = [];
  let cur = [], chars = 0;
  for (const [idx, text] of units) {
    if (idx === -1) { chunks.push([[-1, text]]); continue; }
    if (chars + text.length > 4500 && cur.length) { chunks.push(cur); cur = []; chars = 0; }
    cur.push([idx, text]); chars += text.length;
  }
  if (cur.length) chunks.push(cur);

  const chunkKey = (chunk) => chunk.map(([i]) => i).sort((a, b) => a - b).join(",");
  const pending = [];
  for (const chunk of chunks) {
    if (chunk_done(chunk, processed)) continue;
    const key = chunkKey(chunk);
    const tried = new Set(chunkFailures[key] || []);
    const llms = rot.filter((c) => !tried.has(c.name));
    if (llms.length) pending.push([chunk, llms]);
  }
  const totalUnits = pending.reduce((a, [c, ls]) => a + Math.max(1, ls.length), 0);
  let doneUnits = 0;
  let failedChunks = 0, censorHit = false;
  const seen = new Set();

  for (const [chunk, llmsToTry] of pending) {
    const key = chunkKey(chunk);
    let ok = false;
    for (const lcfg of llmsToTry) {
      doneUnits++;
      progress({ done: doneUnits, total: totalUnits, llm: lcfg.name });
      const user = P.vocabUser(article.title, chunk);
      let obj = null;
      try {
        const raw = await chatLLM(lcfg, P.vocabSystem(labelCN()), user, 16000, undefined);
        obj = parseJsonLoose(raw, false);
      } catch (e) {
        (chunkFailures[key] = chunkFailures[key] || []).push(lcfg.name);
        if (isCensor(String(e.message || e))) censorHit = true;
        continue;
      }
      if (!obj || !Array.isArray(obj.paragraphs)) { (chunkFailures[key] = chunkFailures[key] || []).push(lcfg.name); continue; }
      for (const p of obj.paragraphs) {
        try {
          const idx = parseInt(p.index, 10);
          const entries = (p.entries || []).map(fixEntry).filter(Boolean);
          if (idx < 0) {
            const by = Object.fromEntries(titleEntries.map((e) => [e.word, e]));
            for (const e of entries) by[e.word] = e;
            titleEntries.length = 0; titleEntries.push(...Object.values(by));
            continue;
          }
          const startWords = (p.startWords || "").trim() || (article.paragraphs[idx] || "").slice(0, 30);
          sections[idx] = { index: idx, startWords, entries };
        } catch {}
      }
      ok = true;
      break;
    }
    if (ok) for (const [idx] of chunk) processed.add(idx);
  }

  const paragraphs = Object.values(sections).sort((a, b) => a.index - b.index);
  const vocab = { processedParagraphs: [...processed].sort((a, b) => a - b),
                  chunkFailures, paragraphs, titleEntries };
  await stSet({ ["vocab_" + h]: vocab });
  progress({ done: totalUnits, total: totalUnits, llm: "", finished: true });
  return vocab;

  function chunk_done(chunk, proc) { return chunk.every(([idx]) => proc.has(idx)); }
  function labelCN() { return "大学英语四级 CET-4"; }
  function fixEntry(el) {
    if (!el || typeof el !== "object") return null;
    const word = String(el.word || "").trim().toLowerCase();
    if (!word) return null;
    const dedupKey = word + "|" + String(el.sense || "").slice(0, 20);
    if (seen.has(dedupKey)) return null;
    seen.add(dedupKey);
    return { word, phonetic: String(el.phonetic || "").trim(), pos: String(el.pos || "").trim(),
             sense: String(el.sense || "").trim() || "（模型未给释义）",
             inText: String(el.inText || "").trim(), root: String(el.root || "").trim(),
             term: el.term === true };
  }
  function candidates(text, dictSet) {
    const out = [];
    const tokens = text.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    const seenC = new Set();
    for (let raw0 of tokens) {
      const raw = raw0.replace(/^['-]+|['-]+$/g, "");
      if (raw.length < 3) continue;
      const forms = lemmaForms(raw);
      if (forms.some((f) => dictSet.has(f))) continue;
      const base = forms.reduce((a, b) => (a.length <= b.length ? a : b));
      if (!seenC.has(base)) { seenC.add(base); out.push(base); if (out.length >= 50) return out; }
    }
    return out;
  }
}

