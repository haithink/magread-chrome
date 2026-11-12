// 刊读助手 · service worker：LLM 调用、摘要/生词/句解编排、缓存
// 与桌面版 core_llm/core_prompts/core_gen 同源的能力移植（MV3 service worker）


// ---------------- 存储 ----------------
async function stGet(keys) {
  return new Promise((res, reject) => chrome.storage.local.get(keys, (r) => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else res(r || {});
  }));
}
async function stSet(obj) {
  return new Promise((res, reject) => chrome.storage.local.set(obj, () => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else res();
  }));
}

// ---------------- 日志（环形，持久化） ----------------
let logQueue = Promise.resolve();
function pushLog(level, msg) {
  logQueue = logQueue.catch(() => {}).then(async () => {
    const { logs = [] } = await stGet(["logs"]);
    logs.push(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}][${level}] ${String(msg).slice(0, 500)}`);
    while (logs.length > 300) logs.shift();
    await stSet({ logs });
  }).catch(() => {});
  return logQueue;
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
  const identity = (p) => JSON.stringify([p.provider, llmEndpoint(p), (p.model || "").trim(),
    (p.apiKey || "").trim(), thinkingMode(p)]);
  for (const p of config.llms) {
    if (!rot.some((r) => identity(r) === identity(p))) rot.push(p);
  }
  return rot;
}

// ---------------- LLM 客户端 ----------------
function isBudgetReject(text) {
  const t = (text || "").toLowerCase();
  return ["max_tokens", "max_output_tokens", "max_completion_tokens", "max output", "output token"].some((k) => t.includes(k));
}
function llmEndpoint(cfg) {
  let base = (cfg.baseUrl || "").trim().replace(/\/+$/, "");
  if (cfg.provider === "anthropic") {
    if (/\/messages$/.test(base)) return base;
    if (/\/v\d+$/.test(base)) return base + "/messages";
    return base + "/v1/messages";
  }
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+$/.test(base)) return base + "/chat/completions";
  return base + "/v1/chat/completions";
}
function thinkingMode(cfg) {
  if (["enabled", "disabled"].includes(cfg.thinkingMode)) return cfg.thinkingMode;
  // 与桌面版一致：精读任务默认使用 DeepSeek 非思考模式。
  return /deepseek/i.test(cfg.model || "") || /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test((cfg.baseUrl || "").trim())
    ? "disabled" : null;
}
async function chatOnce(cfg, system, user, maxTokens, progress = () => {}) {
  const headers = { "Content-Type": "application/json" };
  if (cfg.provider === "anthropic") {
    headers["x-api-key"] = cfg.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = "Bearer " + cfg.apiKey;
  }
  let body;
  if (cfg.provider === "anthropic") {
    body = { model: cfg.model, max_tokens: maxTokens, stream: true, system: system || undefined,
             messages: [{ role: "user", content: user }] };
  } else {
    body = { model: cfg.model, max_tokens: maxTokens, stream: true, temperature: 0.3,
             messages: [...(system ? [{ role: "system", content: system }] : []),
                        { role: "user", content: user }] };
  }
  // DeepSeek 的 /anthropic/v1/messages 同样支持该字段，不能只给 chat/completions 传递。
  const mode = thinkingMode(cfg);
  if (mode) body.thinking = { type: mode };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  // 仅在请求期间维持 worker 活动；即使任务被中断，已完成块也已保存。
  const heartbeat = setInterval(() => { stGet([]).catch(() => {}); }, 20000);
  try {
    const resp = await fetch(llmEndpoint(cfg), {
      method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text();
      const err = new Error(`HTTP ${resp.status}（${llmEndpoint(cfg)}）：${text.slice(0, 200)}`);
      err.respText = text;
      err.status = resp.status;
      throw err;
    }
    const result = { content: "", cut: false, reasoning: false, reasoningChars: 0 };
    let reported = 0;
    function consume(obj) {
      if (obj.error) throw new Error("接口报错：" + String(obj.error.message || obj.error).slice(0, 300));
      const c = obj.choices?.[0];
      const reason = c?.finish_reason || obj.stop_reason || obj.delta?.stop_reason;
      if (reason === "content_filter" || reason === "refusal") throw new Error("content_filter：模型拒绝输出");
      if (reason === "length" || reason === "max_tokens") result.cut = true;
      if (Array.isArray(obj.content)) {
        result.content += obj.content.filter((b) => b.type === "text").map((b) => b.text || "").join("");
        result.reasoning ||= obj.content.some((b) => b.type === "thinking");
        result.reasoningChars += obj.content.filter((b) => b.type === "thinking").reduce((n, b) => n + (b.thinking || "").length, 0);
      }
      const message = c?.delta || c?.message;
      result.content += message?.content || c?.text || "";
      result.reasoning ||= !!message?.reasoning_content;
      result.reasoningChars += (message?.reasoning_content || "").length;
      if (obj.type === "content_block_delta") {
        result.content += obj.delta?.text || "";
        result.reasoning ||= !!obj.delta?.thinking;
        result.reasoningChars += (obj.delta?.thinking || "").length;
      }
      const now = Date.now();
      if (!reported || now - reported >= 250) {
        progress({ phase: result.content ? "receiving" : (result.reasoning ? "thinking" : "waiting"), chars: result.content.length, reasoningChars: result.reasoningChars });
        reported = now;
      }
    }
    if ((resp.headers.get("content-type") || "").includes("text/event-stream")) {
      const reader = resp.body.getReader(), decoder = new TextDecoder();
      let buffer = "", ended = false;
      function line(text) {
        if (!text.startsWith("data:")) return;
        const data = text.slice(5).trim();
        if (!data || data === "[DONE]") { if (data) ended = true; return; }
        const obj = JSON.parse(data);
        consume(obj);
        if (obj.type === "message_stop" || obj.choices?.[0]?.finish_reason) ended = true;
      }
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            line(buffer.slice(0, end).replace(/\r$/, ""));
            buffer = buffer.slice(end + 1);
          }
          if (done) { if (buffer.trim()) line(buffer.trim()); break; }
          if (ended) break;
        }
        if (!ended) throw new Error("流式响应意外中断，请重试");
      } finally { await reader.cancel().catch(() => {}); }
    } else {
      // 部分兼容网关忽略 stream，直接使用 JSON，避免重复付费请求。
      consume(JSON.parse(await resp.text()));
    }
    progress({ phase: "validating", chars: result.content.length, reasoningChars: result.reasoningChars });
    return result;
  } catch (e) {
    if (controller.signal.aborted) throw new Error("模型请求超时（120 秒），请重试或切换模型");
    throw e;
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
  }
}
function stripThink(t) { return (t || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim(); }

async function chatLLM(cfg, system, user, maxTokens = 4000, progress = () => {}) {
  const started = Date.now();
  let budget = maxTokens;
  let rejectedAt = Infinity;
  for (let attempt = 0; attempt < 6; attempt++) {
    const report = (p) => progress({ llm: cfg.name, model: cfg.model, thinkingMode: thinkingMode(cfg), attempt: attempt + 1, ...p });
    report({ phase: "waiting", chars: 0 });
    let raw;
    try {
      raw = await chatOnce(cfg, system, user, budget, report);
    } catch (e) {
      if (e.status >= 400 && e.status < 500 && isBudgetReject(e.respText) && budget > 256 && attempt < 5) {
        rejectedAt = Math.min(rejectedAt, budget);
        budget = Math.max(256, Math.floor(budget / 2));
        report({ phase: "retrying", reason: "调整输出额度", chars: 0 });
        pushLog("warn", `额度超限，预算减半至 ${budget}：${cfg.name}`);
        continue;
      }
      pushLog("error", `LLM 失败 [${cfg.name}]：${String(e.message || e).slice(0, 300)}`);
      throw e;
    }
    const content = stripThink(raw.content);
    if (content && !raw.cut) {
      pushLog("info", `LLM 完成 [${cfg.name}] ${cfg.provider}/${cfg.model}，思考设置 ${thinkingMode(cfg) || "默认"}，${Date.now() - started} ms，正文 ${content.length} 字符，思考 ${raw.reasoningChars} 字符，请求 ${attempt + 1} 次`);
      return content;
    }
    if (raw.cut || (!content && raw.reasoning)) {
      const next = Math.min(budget * 2, 32768, rejectedAt - 1);
      if (next > budget && attempt < 5) {
        report({ phase: "retrying", reason: "输出截断，增加额度重试", chars: content.length });
        budget = next; continue;
      }
      throw new Error("模型输出被长度截断，请切换模型后重试");
    }
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
    "你是英语外刊精读助教。学生已掌握「" + label + "」。本地已按词表筛出候选词。" +
    "排除人名、地名、机构名和常用词，保留超纲词、术语（含缩略语），并结合正文补充词组和熟词僻义。" +
    "专名即使标为术语也不能收录（如 Nvidia、Jensen Huang、Bloomberg、Nestlé）；只收语言学习需要的词。" +
    "每段独立收词，同词在不同段落可重复。只输出本次给出的段落，编号原样保留，-1 为标题。" +
    '只输出紧凑 JSON：{"paragraphs":[{"index":0,"entries":[["原形小写","词性","本文中文义项","词根词源",false,"音标"]]}]}。' +
    "词条数组固定为以上六列，术语列为布尔值。释义≤25字，熟词僻义写「常见义X；本文义Y」；" +
    "词根词源≤25字，无可靠依据留空。每个词的第六列必须给出美式音标，不能留空；不新增其他列。" +
    '例如 [["honeypot","n.","诱捕陷阱","honey+pot",true,"ˈhʌnipɑːt"]]，词条只能六列，不额外插入布尔值。' +
    "无生词的段落也返回空 entries。不输出 startWords、inText、titleEntries 或额外解释，这些由本地程序处理。不要展示思考过程。",
  vocabUser: (title, chunk, cand) => {
    let out = `文章标题：${title.slice(0, 80)}。以下为本次待处理段落（-1 为标题），编号原样保留：\n`;
    for (const [index, text] of chunk) {
      out += `\n### 段落 ${index}\n${text}\n本地候选：${cand[index].join(", ") || "无；仍需检查熟词僻义和词组"}\n`;
    }
    out += "\n输出前检查：每个词条恰好六列，最后一列是非空音标；不要把专有人名或机构名放入词表。";
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
        case "log": {
          pushLog(msg.level || "info", msg.msg || "");
          sendResponse({ ok: true });
          break;
        }
        case "getLogs": {
          const { logs = [] } = await stGet(["logs"]);
          sendResponse({ ok: true, logs });
          break;
        }
        case "clearLogs": {
          await stSet({ logs: [] });
          sendResponse({ ok: true });
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
          sendResponse({ ok: true, digest: currentCache(got["digest_" + h], msg.article),
                         vocab: currentCache(got["vocab_" + h], msg.article) });
          break;
        }
        case "genDigest": {
          const digest = await genDigestFor(msg.article, taskReporter(msg, sender, "digest"));
          sendResponse({ ok: true, digest });
          break;
        }
        case "genVocab": {
          pushLog("info", `生词表生成开始：${msg.article.title.slice(0, 60)}`);
          const vocab = await genVocabFor(msg.article, taskReporter(msg, sender, "vocab"));
          const fc = vocab.chunkFailures ? Object.keys(vocab.chunkFailures).length : 0;
          pushLog(fc ? "warn" : "info", `生词表生成结束：段落 ${vocab.paragraphs.length}，失败块 ${fc}，${vocab.generationStats?.elapsedMs || 0} ms`);
          for (const [key, names] of Object.entries(vocab.chunkFailures || {})) {
            pushLog("warn", `块 [${key}] 失败渠道：${names.join(", ")}`);
          }
          sendResponse({ ok: true, vocab });
          break;
        }
        case "analyze": {
          const a = msg.payload;
          const h = urlHash(a.url) + "_s" + hashStr(a.sentence);
          const got = await stGet(["analysis_" + h]);
          if (got["analysis_" + h]) { sendResponse({ ok: true, analysis: got["analysis_" + h], cached: true }); break; }
          const cfg = await defaultCfg();
          const started = Date.now();
          const report = taskReporter(msg, sender, "analysis");
          const raw = await chatLLM(cfg, P.analysisSystem(),
            P.analysisUser(a.sentence, a.before, a.after, a.title), 6000, report);
          const obj = parseJsonLoose(raw, false);
          const analysis = {
            vocab: Array.isArray(obj.vocab) ? obj.vocab : [],
            grammarDiagram: String(obj.grammarDiagram || "").replace(/\\n/g, "\n"),
            grammarPoints: Array.isArray(obj.grammarPoints) ? obj.grammarPoints : [],
            context: String(obj.context || ""),
            translation: String(obj.translation || ""),
            generationStats: { elapsedMs: Date.now() - started, outputChars: raw.length, model: cfg.model },
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
function articleHash(article) { return hashStr(JSON.stringify([article.title, article.paragraphs])); }
function currentCache(cache, article) {
  return cache && (!article || !cache.contentHash || cache.contentHash === articleHash(article)) ? cache : null;
}
function taskReporter(msg, sender, task) {
  return (p) => {
    if (!sender.tab) return;
    chrome.tabs.sendMessage(sender.tab.id, {
      ...p, type: "generationProgress", task, requestId: msg.requestId,
      url: msg.article?.url || msg.payload?.url,
      contentHash: msg.article ? articleHash(msg.article) : undefined,
    }, { frameId: sender.frameId || 0 }).catch(() => {});
  };
}
async function defaultCfg() {
  const c = await getConfig();
  if (!c.defaultCfg) throw new Error("未配置 LLM：请点浏览器工具栏的刊读助手图标进行设置");
  return c.defaultCfg;
}

// ---------------- CET-4 词表（本地粗筛） ----------------
let cet4Set = null;
let cet4Phonetics = new Map();
let cet4Loading = null;
async function cet4() {
  if (cet4Set) return cet4Set;
  if (!cet4Loading) cet4Loading = (async () => {
    const response = await fetch(chrome.runtime.getURL("assets/cet4_words.txt"));
    if (!response.ok) throw new Error("无法加载本地 CET-4 词表");
    const text = await response.text();
    const words = new Set();
    for (const line of text.split("\n")) {
      const [raw, phonetic = ""] = line.split("\t");
      const word = raw.trim().toLowerCase();
      if (word) { words.add(word); if (phonetic.trim()) cet4Phonetics.set(word, phonetic.trim()); }
    }
    cet4Set = words;
    return words;
  })().finally(() => { cet4Loading = null; });
  return cet4Loading;
}
function lemmaForms(word) {
  const w = word.toLowerCase();
  const forms = [w];
  if (Object.hasOwn(IRREGULAR_FORMS, w)) forms.push(IRREGULAR_FORMS[w]);
  if (w.endsWith("'s")) forms.push(w.slice(0, -2));
  if (w.endsWith("s") && !w.endsWith("ss")) forms.push(w.slice(0, -1));
  if (w.endsWith("es")) forms.push(w.slice(0, -2));
  if (w.endsWith("ies")) forms.push(w.slice(0, -3) + "y");
  if (w.endsWith("ed")) { forms.push(w.slice(0, -1), w.slice(0, -2)); if (w.endsWith("ied")) forms.push(w.slice(0, -3) + "y"); }
  if (w.endsWith("ing")) { forms.push(w.slice(0, -3), w.slice(0, -3) + "e"); if (w.endsWith("ying")) forms.push(w.slice(0, -4) + "ie"); }
  if (w.endsWith("ed") || w.endsWith("ing")) {
    const stem = w.slice(0, w.endsWith("ing") ? -3 : -2);
    if (/([b-df-hj-np-tv-z])\1$/.test(stem)) forms.push(stem.slice(0, -1));
  }
  return [...new Set(forms)];
}
// 常见不规则形式仅作本地词表筛选和原文定位，不据此生成释义。
const IRREGULAR_FORMS = Object.freeze({
  am: "be", is: "be", are: "be", was: "be", were: "be", been: "be", has: "have", had: "have",
  does: "do", did: "do", done: "do", went: "go", gone: "go", saw: "see", seen: "see",
  made: "make", took: "take", taken: "take", wrote: "write", written: "write",
  bought: "buy", brought: "bring", thought: "think", found: "find", felt: "feel", left: "leave",
  said: "say", told: "tell", kept: "keep", held: "hold", knew: "know", known: "know",
  grew: "grow", grown: "grow", gave: "give", given: "give", became: "become", began: "begin", begun: "begin",
  fell: "fall", fallen: "fall", shrank: "shrink", shrunk: "shrink", shrunken: "shrink", ran: "run",
  flew: "fly", flown: "fly", spoke: "speak", spoken: "speak", broke: "break", broken: "break",
  chose: "choose", chosen: "choose", rose: "rise", risen: "rise", drove: "drive", driven: "drive",
  ate: "eat", eaten: "eat", drank: "drink", drunk: "drink", slept: "sleep", woke: "wake", woken: "wake",
  wore: "wear", worn: "wear", tore: "tear", torn: "tear", threw: "throw", thrown: "throw",
  drew: "draw", drawn: "draw", froze: "freeze", frozen: "freeze", hid: "hide", hidden: "hide",
  rode: "ride", ridden: "ride", shook: "shake", shaken: "shake", stole: "steal", stolen: "steal",
  swam: "swim", swum: "swim", sang: "sing", sung: "sing", sank: "sink", sunk: "sink",
  caught: "catch", taught: "teach", paid: "pay", won: "win", lost: "lose", built: "build",
  sent: "send", lent: "lend", spent: "spend", sold: "sell", stood: "stand", sat: "sit",
  shot: "shoot", led: "lead", dealt: "deal", meant: "mean", met: "meet", understood: "understand",
  sought: "seek", fought: "fight", laid: "lay", lay: "lie", lain: "lie", bound: "bind", hung: "hang",
  children: "child", men: "man", women: "woman", feet: "foot", teeth: "tooth", mice: "mouse",
  phenomena: "phenomenon", criteria: "criterion", analyses: "analysis", diagnoses: "diagnosis",
  hypotheses: "hypothesis", theses: "thesis", indices: "index", matrices: "matrix", fungi: "fungus", bacteria: "bacterium",
});

// ---------------- 摘要 ----------------
const digestJobs = new Map();
function sharedJob(jobs, key, progress, run) {
  if (jobs.has(key)) {
    const job = jobs.get(key);
    job.listeners.add(progress);
    if (job.last) progress(job.last);
    return job.promise;
  }
  const job = { listeners: new Set([progress]), last: null };
  jobs.set(key, job);
  job.promise = run((p) => {
    job.last = p;
    for (const listener of job.listeners) { try { listener(p); } catch {} }
  }).finally(() => jobs.delete(key));
  return job.promise;
}
function genDigestFor(article, progress = () => {}) {
  return sharedJob(digestJobs, article.url + "|" + articleHash(article), progress, async (report) => {
    const started = Date.now(), key = "digest_" + urlHash(article.url);
    const got = await stGet([key]);
    const cached = currentCache(got[key], article);
    if (cached) return cached;
    const cfg = await defaultCfg();
    const text = article.paragraphs.join("\n").slice(0, 6000);
    const raw = await chatLLM(cfg, P.digestSystem(), `文章标题：${article.title}\n\n正文：\n${text}`, 1500, report);
    const obj = parseJsonLoose(raw, false);
    if (!String(obj.summaryZh || "").trim()) throw new Error("模型返回的摘要为空，请重试");
    const digest = {
      titleEn: String(obj.titleEn || article.title), titleZh: String(obj.titleZh || ""),
      summaryZh: String(obj.summaryZh), ts: Date.now(), contentHash: articleHash(article),
      generationStats: { elapsedMs: Date.now() - started, outputChars: raw.length, model: cfg.model },
    };
    report({ phase: "saving", chars: raw.length });
    await stSet({ [key]: digest });
    return digest;
  });
}

// ---------------- 生词表编排（分块 + LLM 轮换 + 续传） ----------------
function candidates(text, dictSet) {
  const words = (text.replace(/’/g, "'").match(/[A-Za-z][A-Za-z'-]*/g) || [])
    .map((w) => w.replace(/^['-]+|['-]+$/g, "").toLowerCase());
  // 无完整词典时保留原词，避免把 phenomenon 等词错误截成不存在的词根。
  return [...new Set(words.filter((w) => w.length >= 3 && !lemmaForms(w).some((f) => dictSet.has(f))))];
}

function vocabContext(word, text) {
  const source = text.replace(/’/g, "'");
  const tokens = [...source.matchAll(/[A-Za-z][A-Za-z'-]*/g)];
  const wanted = word.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const first = tokens.findIndex((_, i) => wanted.length && wanted.every((w, j) =>
    tokens[i + j] && lemmaForms(tokens[i + j][0]).includes(w.toLowerCase())));
  if (first < 0) return "";
  const last = first + wanted.length - 1;
  const left = tokens[Math.max(0, first - 2)].index;
  const right = tokens[Math.min(tokens.length - 1, last + 2)];
  return text.slice(left, right.index + right[0].length);
}

class VocabValidationError extends Error {
  constructor(sections, errors) {
    super([...errors].map(([i, text]) => `段落 ${i}：${text}`).join("；").slice(0, 500));
    this.sections = sections;
  }
}
function vocabSections(obj, chunk) {
  if (!obj || !Array.isArray(obj.paragraphs)) throw new Error("生词结果缺少 paragraphs");
  const source = new Map(chunk), result = new Map(), errors = new Map(), indices = new Set();
  let rows = obj.paragraphs;
  // 兼容旧提示词的 titleEntries 返回方式。
  if (source.has(-1) && !rows.some((p) => p && Number(p.index) === -1) && Array.isArray(obj.titleEntries))
    rows = [...rows, { index: -1, entries: obj.titleEntries }];
  for (const p of rows) {
    if (!p || !Number.isInteger(Number(p.index)) || p.index === null) continue;
    const index = Number(p.index);
    if (!source.has(index)) continue;
    if (indices.has(index)) {
      result.delete(index); errors.set(index, "生词段落重复"); continue;
    }
    indices.add(index);
    try {
      if (!Array.isArray(p.entries)) throw new Error("缺少 entries");
      const entries = [], seen = new Set();
      for (const row of p.entries) {
        if (Array.isArray(row) && row.length !== 6) throw new Error("生词数组必须包含六列");
        const e = Array.isArray(row) ? { word: row[0], pos: row[1], sense: row[2], root: row[3], term: row[4], phonetic: row[5] } : row;
        if (!e || typeof e.word !== "string" || typeof e.sense !== "string" || !e.word.trim() || !e.sense.trim())
          throw new Error("生词缺少单词或本文释义");
        const word = e.word.trim().toLowerCase(), sense = e.sense.trim();
        const inText = vocabContext(word, source.get(index));
        // 生词须能对应原文；不把模型幻觉写入已完成缓存。
        if (!inText) throw new Error(`生词未匹配原文：${word}`);
        const phonetic = cet4Phonetics.get(word) || String(e.phonetic || "").trim();
        if (!phonetic) throw new Error(`生词缺少音标：${word}`);
        const key = word + "|" + sense;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ word, pos: String(e.pos || "").trim(), sense, phonetic, inText,
          root: String(e.root || "").trim(), term: e.term === true });
      }
      result.set(index, { index, startWords: source.get(index).split(/\s+/).slice(0, 6).join(" "), entries });
    } catch (e) { errors.set(index, String(e.message || e)); }
  }
  for (const [index] of source) if (!result.has(index) && !errors.has(index)) errors.set(index, "模型漏掉段落，保留为待重试");
  if (errors.size) throw new VocabValidationError(result, errors);
  return result;
}

const vocabJobs = new Map();
function genVocabFor(article, progress = () => {}) {
  return sharedJob(vocabJobs, article.url + "|" + articleHash(article), progress,
    (report) => generateVocab(article, report));
}

async function generateVocab(article, progress) {
  const started = Date.now(), cacheKey = "vocab_" + urlHash(article.url);
  const got = await stGet([cacheKey]);
  const existing = currentCache(got[cacheKey], article);
  const sections = new Map(((existing && existing.paragraphs) || []).map((p) => [p.index, p]));
  const processed = new Set(((existing && existing.processedParagraphs) || [])
    .filter((i) => i === -1 || (sections.has(i) && Array.isArray(sections.get(i).entries))));
  let titleEntries = (existing && existing.titleEntries) || [];
  // 每次显式点击只重试未完成段落；过去失败的同名配置也允许修正后重试。
  const chunkFailures = {};
  const units = [[-1, article.title], ...article.paragraphs.map((text, i) => [i, text])];
  const pending = units.filter(([i]) => !processed.has(i));
  if (!pending.length) return { ...existing, chunkFailures: {} };
  const config = await getConfig();
  if (!config.defaultCfg) throw new Error("未配置 LLM：请点浏览器工具栏的刊读助手图标进行设置");
  const rot = rotation(config.defaultCfg, config), dictSet = await cet4();
  const cand = Object.fromEntries(pending.map(([i, text]) => [i, candidates(text, dictSet)]));
  const chunks = [];
  let cur = [], chars = 0;
  for (const unit of pending) {
    if (chars + unit[1].length > 4500 && cur.some(([i]) => i >= 0)) { chunks.push(cur); cur = []; chars = 0; }
    cur.push(unit); chars += unit[1].length;
  }
  if (cur.length) chunks.push(cur);
  const stats = { chunks: chunks.length, requests: 0, inputChars: 0, outputChars: 0,
    workers: Math.min(2, chunks.length), elapsedMs: 0 };
  let done = 0, cursor = 0, saveQueue = Promise.resolve(), latest;
  const active = new Map();
  function report(extra = {}) {
    progress({ done, total: chunks.length, completedParagraphs: processed.size,
      totalParagraphs: units.length, failedChunks: Object.keys(chunkFailures).length,
      elapsedMs: Date.now() - started, active: [...active.values()], ...extra });
  }
  report({ phase: "preparing" });
  function snapshot() {
    return { contentHash: articleHash(article), processedParagraphs: [...processed].sort((a, b) => a - b),
      chunkFailures: { ...chunkFailures }, paragraphs: [...sections.values()].sort((a, b) => a.index - b.index),
      titleEntries, generationStats: { ...stats, elapsedMs: Date.now() - started } };
  }
  function commit(result, remaining, tried, chunkId, finished = true) {
    const saved = saveQueue.then(async () => {
      if (result) {
        for (const [i, p] of result) {
          if (i === -1) titleEntries = p.entries; else sections.set(i, p);
          processed.add(i);
        }
      }
      if (finished && remaining.length) chunkFailures[remaining.map(([i]) => i).join(",")] = [...tried];
      if (finished) done++;
      latest = snapshot();
      await stSet({ [cacheKey]: latest });
      if (finished) active.delete(chunkId);
      report({ phase: "processing", vocab: latest });
    });
    saveQueue = saved;
    return saved;
  }
  async function worker() {
    while (cursor < chunks.length) {
      const chunkId = cursor++, chunk = chunks[chunkId], tried = [];
      const system = P.vocabSystem("大学英语四级 CET-4");
      const collected = new Map();
      let remaining = [...chunk];
      for (const cfg of rot) {
        const user = P.vocabUser(article.title, remaining, cand);
        const count = remaining.reduce((n, [i]) => n + cand[i].length, 0);
        const budget = Math.max(2048, Math.min(8192, 512 + count * 100));
        const chunkProgress = (p) => {
          active.set(chunkId, { chunk: chunkId + 1, ...p });
          report({ phase: "processing" });
        };
        stats.requests++; stats.inputChars += system.length + user.length;
        let accepted = new Map();
        try {
          const raw = await chatLLM(cfg, system, user, budget, chunkProgress);
          stats.outputChars += raw.length;
          // 生词表必须完整；不能用 JSON 修补把截断段落误判为完成。
          accepted = vocabSections(JSON.parse(extractJsonBlock(raw)), remaining);
        } catch (e) {
          if (e instanceof VocabValidationError) accepted = e.sections;
          tried.push(cfg.name);
          pushLog("warn", `生词块 [${remaining.map(([i]) => i)}] ${cfg.name}：${String(e.message || e).slice(0, 200)}`);
        }
        for (const [i, p] of accepted) collected.set(i, p);
        remaining = remaining.filter(([i]) => !accepted.has(i));
        if (!remaining.length) break;
        // 在换渠道前保存正常段落；只让剩余问题段落进入下一次请求。
        if (accepted.size) await commit(accepted, remaining, tried, chunkId, false);
      }
      await commit(collected, remaining, tried, chunkId);
    }
  }
  // 等待所有在途块落盘，再向调用方报告存储等异常。
  const settled = await Promise.allSettled(Array.from({ length: stats.workers }, () => worker()));
  const failed = settled.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  report({ phase: "finished", finished: true });
  return latest;
}

