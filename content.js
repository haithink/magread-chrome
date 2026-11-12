// 刊读助手 · content script：正文抽取、界面注入、消息中转
(() => {
  if (window.__kanduLoaded) return;
  window.__kanduLoaded = true;

  const state = { panel: null, vocab: null, digest: null, article: null, tasks: {}, analysis: null };
  const TASKS = { digest: ["摘要", "sec-digest"], vocab: ["生词表", "sec-vocab"], analysis: ["句解", "sec-analysis"] };
  let progressTimer = null;

  // 进度只更新对应请求，防止旧文章或并发句解的消息覆盖当前面板。
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "generationProgress") return;
    const task = state.tasks[msg.task];
    if (!task?.running || task.requestId !== msg.requestId || task.article.url !== msg.url) return;
    task.info = { ...task.info, ...msg };
    if (msg.vocab) {
      state.vocab = msg.vocab;
      injectBadges(task.article, msg.vocab);
      if (state.panel?.isConnected) renderVocabList(task.article, msg.vocab, false);
    }
    updateProgress();
  });

  function startTask(kind, article) {
    const task = { requestId: kind + "-" + Date.now() + "-" + Math.random().toString(36).slice(2),
      running: true, article, started: Date.now(), info: { phase: "preparing" } };
    state.tasks[kind] = task;
    if (!progressTimer) progressTimer = setInterval(updateProgress, 500);
    updateProgress();
    return task;
  }
  function finishTask(kind, task) {
    task.running = false;
    // 已被后一个句解替代的任务，不改变新任务的显示。
    if (state.tasks[kind] !== task) return;
    updateProgress();
    if (!Object.values(state.tasks).some((t) => t.running)) {
      clearInterval(progressTimer); progressTimer = null;
    }
  }
  function progressCard(kind) {
    const box = el("div", "kandu-progress");
    box.dataset.task = kind;
    box.setAttribute("role", "status");
    box.appendChild(el("div", "kandu-progress-title"));
    const bar = el("progress", "kandu-progress-bar");
    bar.max = 100;
    bar.setAttribute("aria-label", TASKS[kind][0] + "生成进度");
    box.appendChild(bar);
    box.appendChild(el("div", "kandu-progress-detail"));
    return box;
  }
  function phaseText(info) {
    const phases = { preparing: "准备请求", waiting: "等待模型响应", thinking: "模型正在思考",
      receiving: "正在接收内容", validating: "校验结果", saving: "保存结果", retrying: "正在重试", processing: "处理段落", finished: "正在整理结果" };
    return phases[info.phase] || "生成中";
  }
  function updateProgress() {
    const panel = state.panel;
    if (!panel?.isConnected) return;
    const running = Object.entries(state.tasks).filter(([, t]) => t.running);
    for (const [kind, [, id]] of Object.entries(TASKS)) {
      const task = state.tasks[kind], section = panel.querySelector("#" + id);
      let box = section.querySelector(".kandu-progress");
      if (!task?.running) { if (box) box.remove(); continue; }
      if (!box) {
        box = progressCard(kind);
        (section.querySelector(".kandu-section-content") || section).prepend(box);
      }
      const info = task.info, seconds = ((Date.now() - task.started) / 1000).toFixed(1);
      const bar = box.querySelector("progress");
      let label = phaseText(info), detail;
      if (kind === "vocab" && info.totalParagraphs) {
        // 以真正保存成功的段落计数，失败块不计入完成百分比。
        const percent = Math.floor(info.completedParagraphs / info.totalParagraphs * 100);
        bar.value = percent;
        label = `已完成 ${info.completedParagraphs}/${info.totalParagraphs} 段（含标题） · ${percent}%`;
        const active = (info.active || []).map((a) => `块 ${a.chunk} · ${a.llm || "模型"} · ${phaseText(a)}${a.chars ? " " + a.chars + " 字符" : ""}${a.attempt > 1 ? " · 第 " + a.attempt + " 次请求" : ""}`);
        detail = [active.join("；"), info.failedChunks ? `${info.failedChunks} 块失败待补，可稍后继续生成` : "完成的段落可立即点击正文「词」标记查看"].filter(Boolean).join("\n");
      } else {
        bar.removeAttribute("value");
        detail = [info.llm, info.chars ? `已接收 ${info.chars} 字符` : "连接成功后会显示接收进度",
          info.attempt > 1 ? `第 ${info.attempt} 次请求` : "", info.reason].filter(Boolean).join(" · ");
      }
      box.querySelector(".kandu-progress-title").textContent = `${label} · ${seconds} 秒`;
      box.querySelector(".kandu-progress-detail").textContent = detail;
    }
    const footer = panel.querySelector(".kandu-footer");
    footer.classList.toggle("kandu-footer-busy", running.length > 0);
    footer.textContent = running.length ? running.map(([kind, t]) => `${TASKS[kind][0]}生成中 · ${Math.floor((Date.now() - t.started) / 1000)} 秒`).join(" ｜ ") : "结果保存在此浏览器 · 双击原文可解析句子";
    const digestButton = panel.querySelector("#kandu-gen-digest");
    if (digestButton) { digestButton.disabled = !!state.tasks.digest?.running; digestButton.textContent = state.tasks.digest?.running ? "摘要生成中…" : (state.digest ? "查看摘要" : "生成摘要"); }
    const vocabButton = panel.querySelector("#kandu-gen-vocab");
    if (vocabButton) { vocabButton.disabled = !!state.tasks.vocab?.running; vocabButton.textContent = state.tasks.vocab?.running ? "生词表生成中…" : vocabLabel(); }
  }
  function vocabLabel() {
    return vocabComplete(state.article, state.vocab) ? "生词表已完成" : (state.vocab ? "继续生成生词表" : "生成生词表");
  }

  // ---------------- 正文抽取 ----------------
  function extractArticle() {
    const url = location.href.split("#")[0];
    const og = document.querySelector('meta[property="og:title"]');
    const h1 = document.querySelector("h1");
    const title = (og && og.content) || (h1 && h1.innerText.trim()) || document.title || "";

    const candidates = ["article", '[role="main"]', "main", "#article-body", ".article-body", ".post-content"];
    let root = null;
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.length > 500) { root = el; break; }
    }
    if (!root) {
      // 兜底：选 innerText 最长的 <p> 集合容器（body 内）
      let best = null, bestLen = 0;
      for (const el of document.querySelectorAll("div, section")) {
        const ps = el.querySelectorAll(":scope > p");
        let len = 0;
        ps.forEach((p) => (len += p.innerText.trim().length));
        if (len > bestLen && len > 800) { bestLen = len; best = el; }
      }
      root = best || document.body;
    }
    const seen = new Set();
    const paragraphs = [];
    for (const p of root.querySelectorAll("p")) {
      const t = paragraphText(p);
      if (t.length < 40 || seen.has(t)) continue;
      seen.add(t);
      paragraphs.push(t);
    }
    // JSON-LD 兜底：同意墙/懒加载导致 DOM 缺正文时，从结构化数据取全文
    if (paragraphs.length < 2) {
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(s.textContent);
          const items = Array.isArray(data) ? data : [data, ...((data && data["@graph"]) || [])];
          for (const d of items) {
            if (!d || !(d["@type"] === "Article" || d["@type"] === "NewsArticle" || d["@type"] === "BlogPosting") || !d.articleBody) continue;
            paragraphs.length = 0;
            for (const para of String(d.articleBody).split(/\n\s*\n/)) {
              const t = para.replace(/\s+/g, " ").trim();
              if (t.length >= 40) paragraphs.push(t);
            }
            break;
          }
          if (paragraphs.length >= 2) break;
        } catch {}
      }
    }
    return { url, title: title.trim(), paragraphs };
  }

  // ---------------- 句子切分 ----------------
  function paragraphText(p) {
    let text = p.innerText || "";
    const badge = p.querySelector(":scope > .kandu-badge");
    if (badge && text.startsWith(badge.innerText)) text = text.slice(badge.innerText.length);
    return text.replace(/\s+/g, " ").trim();
  }
  const ABBREV = new Set(["mr", "mrs", "ms", "dr", "prof", "st", "jr", "sr", "vs", "etc", "inc", "ltd", "no", "fig", "u.s", "u.k", "d.c"]);
  function splitSentences(text) {
    const out = [];
    let start = 0, i = 0;
    const ENDERS = new Set([".", "!", "?"]);
    const CLOSERS = new Set(['"', "'", ")", "”", "’"]);
    while (i < text.length) {
      const c = text[i];
      if (ENDERS.has(c)) {
        let j = i + 1;
        while (j < text.length && (ENDERS.has(text[j]) || CLOSERS.has(text[j]))) j++;
        let isEnd = true;
        if (j < text.length && text[j] === " " && j + 1 < text.length && text[j + 1] === text[j + 1].toLowerCase() && /[a-z]/i.test(text[j + 1])) {
          const ts = Math.max(text.lastIndexOf(" ", i - 1), -1) + 1;
          const token = text.slice(ts, j).trim().replace(/[.!?]+$/, "").toLowerCase();
          if (ABBREV.has(token) || /^[a-z]([.-][a-z])[.]?$/.test(token)) isEnd = false;
        }
        if (isEnd && j > start) {
          const piece = text.slice(start, j).trim();
          if (piece) out.push({ start, end: j, text: piece });
          start = j;
        }
        i = j;
      } else i++;
    }
    if (start < text.length) {
      const piece = text.slice(start).trim();
      if (piece) out.push({ start, end: text.length, text: piece });
    }
    return out;
  }
  function sentenceAt(sents, offset) {
    for (const s of sents) if (offset >= s.start && offset < s.end) return s;
    return sents.length ? (offset <= sents[0].start ? sents[0] : sents[sents.length - 1]) : null;
  }
  function neighbors(sents, sent) {
    const idx = sents.findIndex((s) => s.start === sent.start && s.end === sent.end);
    return {
      before: idx > 0 ? sents[idx - 1].text : "",
      after: idx >= 0 && idx < sents.length - 1 ? sents[idx + 1].text : "",
    };
  }

  // ---------------- 工具 ----------------
  function send(msg) {
    return new Promise((res) => chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) res({ ok: false, error: chrome.runtime.lastError.message });
      else res(r || { ok: false, error: "no response" });
    }));
  }
  function log(level, msg) {
    try { chrome.runtime.sendMessage({ type: "log", level, msg }, () => void chrome.runtime.lastError); } catch {}
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function clearEl(e) { while (e.firstChild) e.removeChild(e.firstChild); }

  // ---------------- 悬浮球 ----------------
  function ensurePill() {
    if (document.getElementById("kandu-pill")) return;
    const pill = el("button", "kandu-pill", "刊读");
    pill.id = "kandu-pill";
    pill.addEventListener("click", async () => {
      try {
        let article = extractArticle();
        if (article.paragraphs.length < 2) {
          // 页面可能尚未加载完：等 1.5 秒重试一次
          await new Promise((r) => setTimeout(r, 1500));
          article = extractArticle();
        }
        openPanel(article);
        if (article.paragraphs.length < 2) {
          const sec = panelSection("文章摘要", "sec-digest");
          sec.appendChild(el("div", "kandu-error",
            "本页未检测到文章正文：可能被登录墙/同意墙遮挡，或这不是文章页。请确认正文已显示后再点悬浮球。"));
          return;
        }
        await refreshCache(article);
        // 缓存只更新结果，不重建按钮或切换用户正在查看的标签页。
        if (state.panel && state.panel.isConnected) { renderCached(article); updateProgress(); }
      } catch (e) {
        console.error("[kandu] init failed:", e);
        log("error", "面板初始化失败：" + ((e && e.stack) || e.message || e));
        secError("sec-actions", e);
      }
    });
    document.documentElement.appendChild(pill);
  }

  // ---------------- 侧栏面板 ----------------
  const PANEL_SECTIONS = [
    ["sec-actions", "操作"],
    ["sec-digest", "摘要"],
    ["sec-vocab", "生词表"],
    ["sec-analysis", "句解"],
  ];
  function ensurePanel() {
    // 面板挂在 documentElement 下，不属于 body；必须按实际挂载位置检查。
    if (state.panel && document.documentElement.contains(state.panel)) return state.panel;
    const panel = el("div", "kandu-panel");
    panel.id = "kandu-panel";
    panel.setAttribute("role", "complementary");
    panel.setAttribute("aria-label", "刊读阅读助手");
    const header = el("div", "kandu-panel-header");
    const brand = el("div", "kandu-brand");
    brand.appendChild(el("span", "kandu-brand-icon", "Aa"));
    const name = el("div", "kandu-brand-name");
    name.appendChild(el("span", "kandu-panel-title", "刊读"));
    name.appendChild(el("span", "kandu-brand-subtitle", "陪你读懂每一篇英文"));
    brand.appendChild(name);
    header.appendChild(brand);
    const close = el("button", "kandu-close", "×");
    close.setAttribute("aria-label", "关闭侧栏");
    close.addEventListener("click", () => panel.remove());
    header.appendChild(close);
    panel.appendChild(header);
    const tabs = el("div", "kandu-tabs");
    for (const [id, label] of PANEL_SECTIONS) {
      const t = el("button", "kandu-tab", label);
      t.dataset.sec = id;
      t.addEventListener("click", () => showSection(id));
      tabs.appendChild(t);
    }
    panel.appendChild(tabs);
    const body = el("div", "kandu-panel-body");
    panel.appendChild(body);
    for (const [id] of PANEL_SECTIONS) {
      const sec = el("div", "kandu-section");
      sec.id = id;
      sec.style.display = "none";
      body.appendChild(sec);
    }
    panel.appendChild(el("div", "kandu-footer"));
    document.documentElement.appendChild(panel);
    state.panel = panel;
    return panel;
  }
  function showSection(id) {
    const panel = ensurePanel();
    for (const sec of panel.querySelectorAll(".kandu-section"))
      sec.style.display = sec.id === id ? "block" : "none";
    for (const t of panel.querySelectorAll(".kandu-tab")) {
      t.classList.toggle("kandu-tab-active", t.dataset.sec === id);
      t.setAttribute("aria-pressed", String(t.dataset.sec === id));
    }
  }
  function panelSection(title, id, activate = true) {
    const panel = ensurePanel();
    if (activate) showSection(id);
    const sec = panel.querySelector("#" + id);
    clearEl(sec);
    sec.appendChild(el("div", "kandu-section-h", title));
    const content = el("div", "kandu-section-content");
    sec.appendChild(content);
    return content;
  }

  // ---------------- 摘要 ----------------
  async function ensureDigest(article) {
    if (state.digest) return state.digest;
    if (state.tasks.digest?.running) { showSection("sec-digest"); return null; }
    const r = await send({ type: "getCache", url: article.url, article });
    if (r.digest) { state.digest = r.digest; return r.digest; }
    panelSection("文章摘要", "sec-digest");
    const task = startTask("digest", article);
    try {
      const rr = await send({ type: "genDigest", article, requestId: task.requestId });
      if (!rr.ok) throw new Error(rr.error);
      if (state.tasks.digest !== task) return null;
      state.digest = rr.digest;
      return rr.digest;
    } finally { finishTask("digest", task); }
  }
  function renderDigest(article, d, activate = true) {
    const sec = panelSection("文章摘要", "sec-digest", activate);
    sec.appendChild(el("div", "kandu-title-en", d.titleEn || article.title));
    if (d.titleZh) sec.appendChild(el("div", "kandu-title-zh", d.titleZh));
    if (d.summaryZh) sec.appendChild(el("div", "kandu-summary", d.summaryZh));
    if (d.generationStats) sec.appendChild(el("div", "kandu-result-meta", `生成用时 ${(d.generationStats.elapsedMs / 1000).toFixed(1)} 秒 · 已保存在本地`));
  }

  // ---------------- 生词表 ----------------
  async function ensureVocab(article) {
    if (state.vocab) return state.vocab;
    const r = await send({ type: "getCache", url: article.url, article });
    if (r.vocab) { state.vocab = r.vocab; return r.vocab; }
    return null;
  }
  async function genVocab(article) {
    panelSection("生词表", "sec-vocab");
    const task = startTask("vocab", article);
    try {
      const rr = await send({ type: "genVocab", article, requestId: task.requestId });
      if (!rr.ok) throw new Error(rr.error);
      if (state.tasks.vocab !== task) return null;
      state.vocab = rr.vocab;
      injectBadges(article, state.vocab);
      return state.vocab;
    } finally { finishTask("vocab", task); }
  }
  function renderVocabList(article, vocab, activate = true) {
    const body = state.panel?.querySelector(".kandu-panel-body"), previousScroll = body?.scrollTop || 0;
    const sec = panelSection("生词表", "sec-vocab", activate);
    const complete = vocabComplete(article, vocab);
    const elapsed = vocab.generationStats ? ` · 本次 ${(vocab.generationStats.elapsedMs / 1000).toFixed(1)} 秒` : "";
    const failed = Object.keys(vocab.chunkFailures || {}).length;
    const coverage = `${(vocab.processedParagraphs || []).length}/${article.paragraphs.length + 1} 段（含标题）`;
    sec.appendChild(el("div", "kandu-meta", (complete ? "生词表已完成" : `已保存 ${coverage}${failed ? " · " + failed + " 块失败待补" : ""}，可在操作页继续生成`) + elapsed));
    const te = vocab.titleEntries || [];
    if (te.length) {
      sec.appendChild(el("div", "kandu-sub", "标题生词"));
      te.forEach((e) => sec.appendChild(entryEl(e)));
    }
    let shown = 0;
    for (const p of vocab.paragraphs || []) {
      if (!p.entries.length) continue;
      sec.appendChild(el("div", "kandu-sub", `第 ${p.index + 1} 段 ｜ ${p.startWords.slice(0, 24)}…`));
      p.entries.forEach((e) => { sec.appendChild(entryEl(e)); shown++; });
    }
    if (!shown && !te.length) sec.appendChild(el("div", "kandu-meta", complete ? "本文无生词记录" : "暂无生词结果"));
    updateProgress();
    if (!activate && body) body.scrollTop = previousScroll;
  }
  function vocabComplete(article, vocab) {
    const processed = new Set(vocab?.processedParagraphs || []);
    return processed.has(-1) && !!article && article.paragraphs.every((_, i) => processed.has(i));
  }
  function entryEl(e) {
    const box = el("div", "kandu-entry");
    const head = el("div", "kandu-entry-head");
    head.appendChild(el("span", "kandu-word", e.word));
    if (e.phonetic) head.appendChild(el("span", "kandu-ph", "/" + e.phonetic.replace(/^\/|\/$/g, "") + "/"));
    if (e.pos) head.appendChild(el("span", "kandu-pos", e.pos));
    if (e.term) head.appendChild(el("span", "kandu-tag", "术语"));
    box.appendChild(head);
    if (e.sense) box.appendChild(el("div", "kandu-sense", e.sense));
    if (e.inText) box.appendChild(el("div", "kandu-intext", "原文：" + e.inText));
    if (e.root) box.appendChild(el("div", "kandu-root", "拆词：" + e.root));
    return box;
  }

  // ---------------- 段落徽标 ----------------
  function injectBadges(article, vocab) {
    const ps = collectArticlePs(article);
    for (const p of vocab.paragraphs || []) {
      const elP = ps[p.index];
      if (!elP) continue;
      const old = elP.querySelector(":scope > .kandu-badge");
      if (!p.entries.length) { if (old) old.remove(); continue; }
      if (old) old.remove();
      const badge = el("span", "kandu-badge", `词 ${p.entries.length}`);
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleInlineVocab(elP, p);
      });
      elP.insertBefore(badge, elP.firstChild);
      elP.classList.add("kandu-has-badge");
    }
  }
  function toggleInlineVocab(elP, p) {
    const next = elP.nextElementSibling;
    if (next && next.classList && next.classList.contains("kandu-inline-vocab")) { next.remove(); return; }
    const box = el("div", "kandu-inline-vocab");
    p.entries.forEach((e) => box.appendChild(entryEl(e)));
    elP.insertAdjacentElement("afterend", box);
  }

  function collectArticlePs(article) {
    // 按抽取时的正文匹配 DOM，避免根容器不同造成徽标错位。
    const expected = article ? new Set(article.paragraphs) : null;
    const out = new Map();
    for (const p of document.querySelectorAll("p")) {
      if (p.closest("#kandu-panel, .kandu-inline-vocab")) continue;
      const t = paragraphText(p);
      if (t.length < 40 || out.has(t)) continue;
      if (expected && !expected.has(t)) continue;
      out.set(t, p);
    }
    return article ? article.paragraphs.map((t) => out.get(t)) : [...out.values()];
  }

  // ---------------- 句解 ----------------
  async function analyzeSentence(sentence, paraText, paraIdx) {
    const sents = splitSentences(paraText);
    const hit = sentenceAt(sents, paraText.indexOf(sentence.slice(0, 40)));
    const { before, after } = neighbors(sents, hit || sents[0]);
    const article = extractArticle();
    if (state.tasks.analysis?.running && state.tasks.analysis.sentence === sentence) { showSection("sec-analysis"); return; }
    const sec = panelSection("句解", "sec-analysis");
    sec.appendChild(el("div", "kandu-src", sentence));
    const task = startTask("analysis", article);
    task.sentence = sentence;
    const r = await send({
      type: "analyze", requestId: task.requestId,
      payload: { url: article.url, title: article.title, sentence, before, after },
    });
    finishTask("analysis", task);
    if (state.tasks.analysis !== task) return;
    if (!r.ok) { secError("sec-analysis", new Error(r.error)); return; }
    state.analysis = { sentence, result: r.analysis };
    if (state.panel?.isConnected) renderAnalysis(sentence, r.analysis, false);
  }
  function renderAnalysis(sentence, a, activate = true) {
    const sec = panelSection("句子讲解", "sec-analysis", activate);
    sec.appendChild(el("div", "kandu-src", sentence));
    if (a.vocab && a.vocab.length) {
      sec.appendChild(el("div", "kandu-sub", "一、疑难词汇"));
      a.vocab.forEach((v) => {
        const head = el("div", "kandu-entry-head");
        head.appendChild(el("span", "kandu-word", v.word));
        if (v.phonetic) head.appendChild(el("span", "kandu-ph", "/" + v.phonetic.replace(/^\/|\/$/g, "") + "/"));
        sec.appendChild(head);
        if (v.sense) sec.appendChild(el("div", "kandu-sense", v.sense));
        if (v.note) sec.appendChild(el("div", "kandu-root", v.note));
      });
    }
    if (a.grammarDiagram) {
      sec.appendChild(el("div", "kandu-sub", "二、语法图解"));
      const pre = el("pre", "kandu-mono", a.grammarDiagram);
      sec.appendChild(pre);
    }
    (a.grammarPoints || []).forEach((p, i) => {
      const head = el("div", "kandu-entry-head", `${i + 1}. ${p.title || ""}`);
      head.className += " kandu-point";
      sec.appendChild(head);
      if (p.text) sec.appendChild(el("div", "kandu-sense", p.text));
    });
    if (a.context) {
      sec.appendChild(el("div", "kandu-sub", "三、语境"));
      sec.appendChild(el("div", "kandu-sense", a.context));
    }
    if (a.translation) {
      sec.appendChild(el("div", "kandu-sub", "参考译文"));
      sec.appendChild(el("div", "kandu-trans", a.translation));
    }
    if (a.generationStats) sec.appendChild(el("div", "kandu-result-meta", `生成用时 ${(a.generationStats.elapsedMs / 1000).toFixed(1)} 秒 · 已保存在本地`));
  }

  // ---------------- 交互 ----------------
  function paraInfoFromNode(node) {
    const ps = collectArticlePs(state.article || extractArticle());
    let elP = node && node.nodeType === 3 ? node.parentElement : node;
    while (elP && elP.tagName !== "P") elP = elP.parentElement;
    if (!elP) return null;
    const idx = ps.indexOf(elP);
    if (idx < 0) return null;
    return { elP, idx, text: paragraphText(ps[idx]) };
  }

  // 双击：解析光标所在句
  document.addEventListener("dblclick", (e) => {
    const info = paraInfoFromNode(e.target);
    if (!info) return;
    const range = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
    if (!range || !range.startContainer) return;
    // 计算点击处字符偏移（近似：把该文本节点前缀长度累计）
    let prefix = "";
    const walker = document.createTreeWalker(info.elP, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.parentElement.closest(".kandu-badge")) continue;
      if (n === range.startContainer) { prefix += n.textContent.slice(0, range.startOffset); break; }
      prefix += n.textContent;
    }
    const paraText = info.text;
    const offset = prefix.replace(/\s+/g, " ").length;
    const sents = splitSentences(paraText);
    const sent = sentenceAt(sents, offset);
    if (sent && sent.text.length > 10) analyzeSentence(sent.text, paraText, info.idx);
  });

  // 选中 → 悬浮「解析」按钮
  let selBtn = null;
  document.addEventListener("mouseup", (e) => {
    if (selBtn) { selBtn.remove(); selBtn = null; }
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString().trim();
      if (text.length < 2 || !sel.anchorNode || !document.body.contains(sel.anchorNode)) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const b = el("div", "kandu-selbtn", "解析");
      b.addEventListener("mousedown", (ev) => { ev.stopPropagation(); ev.preventDefault(); });
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        b.remove(); selBtn = null;
        const info = paraInfoFromNode(sel.anchorNode);
        const paraText = info ? info.text : text;
        analyzeSentence(text, paraText, info ? info.idx : 0);
      });
      document.documentElement.appendChild(b);
      b.style.top = rect.bottom + window.scrollY + 6 + "px";
      b.style.left = rect.left + window.scrollX + "px";
      selBtn = b;
      setTimeout(() => { if (selBtn) { selBtn.remove(); selBtn = null; } }, 6000);
    }, 10);
  });

  // ---------------- 面板总渲染 ----------------
  async function refreshCache(article) {
    const r = await send({ type: "getCache", url: article.url, article });
    if (!r.ok) throw new Error(r.error);
    if (state.article !== article) return;
    if (!state.tasks.digest?.running) state.digest = r.digest || state.digest;
    if (!state.tasks.vocab?.running) state.vocab = r.vocab || state.vocab;
  }
  function renderAll(article) {
    const actions = panelSection("阅读工具", "sec-actions", false);
    const intro = el("div", "kandu-article-card");
    intro.appendChild(el("div", "kandu-eyebrow", "READ & UNDERSTAND"));
    intro.appendChild(el("div", "kandu-article-title", article.title));
    const wordCount = (article.paragraphs.join(" ").match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
    intro.appendChild(el("div", "kandu-meta", `${article.paragraphs.length} 段正文 · ${wordCount.toLocaleString()} 词 · 默认已掌握四级词汇`));
    actions.appendChild(intro);
    const addTool = (number, title, description, button) => {
      const card = el("div", "kandu-tool-card");
      card.appendChild(el("span", "kandu-tool-number", number));
      const text = el("div", "kandu-tool-copy");
      text.appendChild(el("div", "kandu-tool-title", title));
      text.appendChild(el("div", "kandu-tool-desc", description));
      card.appendChild(text); card.appendChild(button); actions.appendChild(card);
    };
    const b1 = el("button", "kandu-btn", "生成摘要");
    b1.id = "kandu-gen-digest";
    b1.addEventListener("click", async () => {
      if (state.tasks.digest?.running) return;
      b1.disabled = true;
      showSection("sec-digest");
      try { const result = await ensureDigest(article); if (result && state.panel?.isConnected) renderDigest(article, result, false); }
      catch (e) { secError("sec-digest", e); }
      updateProgress();
    });
    addTool("01", "先读懂大意", "中英文标题与中文摘要，快速把握文章重点。", b1);
    const b2 = el("button", "kandu-btn", vocabLabel());
    b2.id = "kandu-gen-vocab";
    b2.addEventListener("click", async () => {
      if (state.tasks.vocab?.running) return;
      if (vocabComplete(article, state.vocab)) { renderVocabList(article, state.vocab); return; }
      try {
        const v = await genVocab(article);
        if (v) {
          if (state.panel?.isConnected) renderVocabList(article, v, false);
          injectBadges(article, v);
        }
      } catch (e) { secError("sec-vocab", e); }
      updateProgress();
    });
    addTool("02", "扫清生词障碍", "逐段整理音标、本文含义和词根，已完成的段落可先读。", b2);
    const b3 = el("button", "kandu-btn", "查看生词表");
    b3.id = "kandu-view-vocab";
    b3.addEventListener("click", () => {
      if (state.vocab) renderVocabList(article, state.vocab);
      else { showSection("sec-vocab"); updateProgress(); }
    });
    addTool("03", "回看与巩固", "集中浏览已生成的词条，也可点击正文中的绿色词数标记。", b3);
    actions.appendChild(el("div", "kandu-reading-tip", "读到长难句？双击句子，或选中文字后点击「解析」，即可查看语法与译文。"));
    secError("sec-digest", null);
    secError("sec-vocab", null);

    renderCached(article);
    for (const [kind, [label, id]] of Object.entries(TASKS)) {
      if (!state.panel.querySelector("#" + id + " .kandu-section-content")) {
        const empty = panelSection(label, id, false);
        if (state.tasks[kind]?.running) {
          if (state.tasks[kind].sentence) empty.appendChild(el("div", "kandu-src", state.tasks[kind].sentence));
        } else empty.appendChild(el("div", "kandu-empty", kind === "analysis" ? "双击原文中的句子，开始精读。" : `还没有${label}，在「操作」页开始生成。`));
      }
      if (state.tasks[kind]?.error) secError(id, new Error(state.tasks[kind].error), false);
    }
    updateProgress();
  }
  function renderCached(article) {
    if (state.digest) renderDigest(article, state.digest, false);
    if (state.vocab) { renderVocabList(article, state.vocab, false); injectBadges(article, state.vocab); }
    if (state.analysis && !state.tasks.analysis?.running) renderAnalysis(state.analysis.sentence, state.analysis.result, false);
    updateProgress();
  }
  function secError(id, e, activate = true) {
    const kind = Object.keys(TASKS).find((key) => TASKS[key][1] === id);
    if (e && state.tasks[kind]) state.tasks[kind].error = String(e.message || e);
    const panel = state.panel;
    if (!panel?.isConnected) return;
    const sec = panel.querySelector("#" + id);
    if (!sec) return;
    let old = sec.querySelector(".kandu-error");
    if (old) old.remove();
    if (e) {
      sec.querySelector(".kandu-empty")?.remove();
      const content = sec.querySelector(".kandu-section-content") ||
        panelSection(PANEL_SECTIONS.find(([sectionId]) => sectionId === id)[1], id, false);
      content.prepend(el("div", "kandu-error", "失败：" + (e.message || e)));
      if (activate) showSection(id);
    }
  }

  function openPanel(article) {
    if (state.article && (state.article.url !== article.url || state.article.title !== article.title ||
        JSON.stringify(state.article.paragraphs) !== JSON.stringify(article.paragraphs))) {
      state.digest = null; state.vocab = null; state.analysis = null; state.tasks = {};
      clearInterval(progressTimer); progressTimer = null;
      if (state.panel) for (const [, id] of Object.values(TASKS)) clearEl(state.panel.querySelector("#" + id));
    }
    state.article = article;
    ensurePanel();
    showSection("sec-actions");
    renderAll(article);
  }

  // 启动：若本页像文章页（正文较长）则显示悬浮球
  setTimeout(() => {
    const a = extractArticle();
    if (a.paragraphs.length >= 2) ensurePill();
  }, 800);
})();
