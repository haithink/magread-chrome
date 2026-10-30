// 刊读助手 · content script：正文抽取、界面注入、消息中转
(() => {
  if (window.__kanduLoaded) return;
  window.__kanduLoaded = true;

  const state = { panel: null, busy: false, vocab: null, digest: null };

  // 后台生词表逐块进度
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "vocabProgress") {
      const sec = document.querySelector("#sec-vocab .kandu-loading");
      const llm = msg.llm ? " · " + msg.llm : "";
      if (sec) sec.textContent = `生词表生成中… ${msg.done}/${msg.total}${llm}（失败块自动换模型重试）`;
    }
  });

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
      const t = (p.innerText || "").replace(/\s+/g, " ").trim();
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
    const pill = el("div", "kandu-pill", "刊读");
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
        if (state.panel && state.panel.isConnected) renderCached(article);
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
    const header = el("div", "kandu-panel-header");
    header.appendChild(el("span", "kandu-panel-title", "刊读助手"));
    const close = el("span", "kandu-close", "×");
    close.addEventListener("click", () => panel.remove());
    header.appendChild(close);
    panel.appendChild(header);
    const tabs = el("div", "kandu-tabs");
    for (const [id, label] of PANEL_SECTIONS) {
      const t = el("span", "kandu-tab", label);
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
    document.documentElement.appendChild(panel);
    state.panel = panel;
    return panel;
  }
  function showSection(id) {
    const panel = ensurePanel();
    for (const sec of panel.querySelectorAll(".kandu-section"))
      sec.style.display = sec.id === id ? "block" : "none";
    for (const t of panel.querySelectorAll(".kandu-tab"))
      t.classList.toggle("kandu-tab-active", t.dataset.sec === id);
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
    const r = await send({ type: "getCache", url: article.url });
    if (r.digest) { state.digest = r.digest; return r.digest; }
    const sec = panelSection("文章摘要", "sec-digest");
    sec.appendChild(el("div", "kandu-loading", "摘要生成中…（首次约十几秒，结果缓存）"));
    const rr = await send({ type: "genDigest", article });
    if (!rr.ok) { clearEl(sec); sec.appendChild(el("div", "kandu-error", "失败：" + rr.error)); throw new Error(rr.error); }
    state.digest = rr.digest;
    return rr.digest;
  }
  function renderDigest(article, d, activate = true) {
    const sec = panelSection("文章摘要", "sec-digest", activate);
    sec.appendChild(el("div", "kandu-title-en", d.titleEn || article.title));
    if (d.titleZh) sec.appendChild(el("div", "kandu-title-zh", d.titleZh));
    if (d.summaryZh) sec.appendChild(el("div", "kandu-summary", d.summaryZh));
  }

  // ---------------- 生词表 ----------------
  async function ensureVocab(article) {
    if (state.vocab) return state.vocab;
    const r = await send({ type: "getCache", url: article.url });
    if (r.vocab) { state.vocab = r.vocab; return r.vocab; }
    return null;
  }
  async function genVocab(article) {
    const sec = panelSection("生词表", "sec-vocab");
    sec.appendChild(el("div", "kandu-loading", "生词表生成中…（逐块调用，敏感内容自动换模型跳过）"));
    const rr = await send({ type: "genVocab", article });
    if (!rr.ok) { clearEl(sec); sec.appendChild(el("div", "kandu-error", "失败：" + rr.error)); throw new Error(rr.error); }
    state.vocab = rr.vocab;
    injectBadges(article, state.vocab);
    return state.vocab;
  }
  function renderVocabList(article, vocab, activate = true) {
    const sec = panelSection("生词表", "sec-vocab", activate);
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
    if (!shown && !te.length) sec.appendChild(el("div", "kandu-meta", "全书无生词记录"));
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
      if (!p.entries.length) continue;
      const elP = ps[p.index];
      if (!elP || elP.querySelector(":scope > .kandu-badge")) continue;
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

  function collectArticlePs() {
    const root = document.querySelector("article") || document.querySelector('[role="main"]') || document.querySelector("main") || document.body;
    const seen = new Set(), out = [];
    for (const p of root.querySelectorAll("p")) {
      const t = (p.innerText || "").replace(/\s+/g, " ").trim();
      if (t.length < 40 || seen.has(t)) continue;
      seen.add(t);
      out.push(p);
    }
    return out;
  }

  // ---------------- 句解 ----------------
  async function analyzeSentence(sentence, paraText, paraIdx) {
    const sents = splitSentences(paraText);
    const hit = sentenceAt(sents, paraText.indexOf(sentence.slice(0, 40)));
    const { before, after } = neighbors(sents, hit || sents[0]);
    const article = extractArticle();
    const sec = panelSection("句解", "sec-analysis");
    sec.appendChild(el("div", "kandu-src", sentence));
    sec.appendChild(el("div", "kandu-loading", "解析中…（首次约需十几秒，结果缓存）"));
    const r = await send({
      type: "analyze",
      payload: { url: article.url, title: article.title, sentence, before, after },
    });
    clearEl(sec);
    if (!r.ok) { sec.appendChild(el("div", "kandu-error", "失败：" + r.error)); return; }
    const a = r.analysis;
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
    // sec 是内容容器，没有标签页 ID。
    showSection("sec-analysis");
  }

  // ---------------- 交互 ----------------
  function paraInfoFromNode(node) {
    const ps = collectArticlePs();
    let elP = node && node.nodeType === 3 ? node.parentElement : node;
    while (elP && elP.tagName !== "P") elP = elP.parentElement;
    if (!elP) return null;
    const idx = ps.indexOf(elP);
    if (idx < 0) return null;
    return { elP, idx, text: ps[idx].innerText.replace(/\s+/g, " ").trim() };
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
    const r = await send({ type: "getCache", url: article.url });
    if (!r.ok) throw new Error(r.error);
    state.digest = r.digest || null;
    state.vocab = r.vocab || null;
  }
  function renderAll(article) {
    const actions = panelSection("操作", "sec-actions", false);
    const b1 = el("button", "kandu-btn", "生成摘要");
    b1.addEventListener("click", async () => {
      b1.disabled = true; b1.textContent = "生成中…";
      try { renderDigest(article, await ensureDigest(article)); }
      catch (e) { secError("sec-digest", e); }
      b1.disabled = false; b1.textContent = "生成摘要";
    });
    actions.appendChild(b1);
    const b2 = el("button", "kandu-btn", "生成生词表");
    b2.addEventListener("click", async () => {
      b2.disabled = true; b2.textContent = "生成中…";
      try {
        const v = await genVocab(article);
        renderVocabList(article, v);
        injectBadges(article, v);
      } catch (e) { secError("sec-vocab", e); }
      b2.disabled = false; b2.textContent = "生成生词表";
    });
    actions.appendChild(b2);
    const b3 = el("button", "kandu-btn", "查看生词表");
    b3.addEventListener("click", () => {
      if (state.vocab) renderVocabList(article, state.vocab);
      else alert("先点「生成生词表」");
    });
    actions.appendChild(b3);
    secError("sec-digest", null);
    secError("sec-vocab", null);

    renderCached(article);
  }
  function renderCached(article) {
    if (state.digest) renderDigest(article, state.digest, false);
    if (state.vocab) { renderVocabList(article, state.vocab, false); injectBadges(article, state.vocab); }
  }
  function secError(id, e) {
    const panel = ensurePanel();
    const sec = panel.querySelector("#" + id);
    if (!sec) return;
    let old = sec.querySelector(".kandu-error");
    if (old) old.remove();
    if (e) {
      const content = sec.querySelector(".kandu-section-content") ||
        panelSection(PANEL_SECTIONS.find(([sectionId]) => sectionId === id)[1], id, false);
      content.prepend(el("div", "kandu-error", "失败：" + (e.message || e)));
      showSection(id);
    }
  }

  function openPanel(article) {
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
