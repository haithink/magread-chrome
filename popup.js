// 刊读助手 · 设置弹窗
const $ = (id) => document.getElementById(id);
const statusEl = $("status");
function setStatus(text, isErr) {
  statusEl.textContent = text || "";
  statusEl.className = "status" + (isErr ? " err" : "");
}

async function loadConfig() {
  const r = await chrome.runtime.sendMessage({ type: "getConfig" });
  return r.ok ? r.config : { llms: [], defaultLlm: "" };
}
async function saveConfig(config) {
  await chrome.runtime.sendMessage({ type: "saveConfig", llms: config.llms, defaultLlm: config.defaultLlm });
}

let profiles = [];
let defaultName = "";
let selected = null; // 当前编辑的原始名（null = 新增）

function renderList() {
  const box = $("llmList");
  box.innerHTML = "";
  profiles.forEach((p, i) => {
    const d = document.createElement("div");
    d.textContent = (p.name === defaultName ? "★ " : "　 ") + p.name + " — " + p.provider + " / " + p.model;
    if (p.name === selected) d.classList.add("sel");
    d.addEventListener("click", () => {
      [...box.children].forEach((c) => c.classList.remove("sel"));
      d.classList.add("sel");
    });
    d.addEventListener("dblclick", () => editProfile(p.name));
    box.appendChild(d);
  });
}

function currentFormCfg() {
  return {
    name: $("fName").value.trim() || "LLM",
    provider: $("fProvider").value,
    baseUrl: $("fUrl").value.trim(),
    apiKey: $("fKey").value.trim(),
    model: $("fModel").value.trim(),
  };
}
function fillForm(cfg) {
  $("fName").value = cfg.name || "";
  $("fProvider").value = cfg.provider || "openai";
  $("fUrl").value = cfg.baseUrl || "";
  $("fKey").value = cfg.apiKey || "";
  $("fModel").value = cfg.model || "";
}

async function init() {
  const c = await loadConfig();
  profiles = c.llms;
  defaultName = c.defaultLlm;
  renderList();
}
init();

$("bParse").addEventListener("click", () => {
  const text = $("fPaste").value.trim();
  const parsed = parsePasted(text);
  if (!parsed) { setStatus("无法解析：不是有效的 JSON 或缺少 URL 字段", true); return; }
  $("fProvider").value = parsed.provider;
  $("fUrl").value = parsed.baseUrl;
  $("fKey").value = parsed.apiKey;
  $("fModel").value = parsed.model;
  setStatus("已解析填入（" + (parsed.provider === "anthropic" ? "Anthropic 原生" : "OpenAI 兼容") + "）");
});

$("bTest").addEventListener("click", async () => {
  const cfg = currentFormCfg();
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) { setStatus("URL / Key / 模型名 需先填写", true); return; }
  setStatus("测试连接中…");
  const r = await chrome.runtime.sendMessage({ type: "testLLM", cfg });
  if (r.ok) setStatus(`连接成功（${r.reply}）`);
  else setStatus("连接失败：" + r.error, true);
});

$("bModels").addEventListener("click", async () => {
  const cfg = currentFormCfg();
  if (!cfg.baseUrl || !cfg.apiKey) { setStatus("URL / Key 需先填写", true); return; }
  setStatus("获取模型列表中…");
  const r = await chrome.runtime.sendMessage({ type: "listModels", cfg });
  if (!r.ok) { setStatus("获取失败：" + r.error, true); return; }
  const win = window.open("", "_blank");
  win.document.write("<pre style='font:12px sans-serif'>" + r.models.map((m) => m.replace(/</g, "&lt;")).join("<br>") + "</pre>");
  win.document.title = "可用模型（手动复制名称填入）";
});

$("bSave").addEventListener("click", async () => {
  const cfg = currentFormCfg();
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) { setStatus("URL / Key / 模型名 需填写完整", true); return; }
  // 编辑：保留原名定位；否则按名替换/新增
  const existing = profiles.find((p) => p.name === cfg.name);
  if (selected !== null && profiles[selected]) {
    const oldName = profiles[selected].name;
    profiles[selected] = cfg;
    if (defaultName === oldName) defaultName = cfg.name;
  } else {
    const i = profiles.findIndex((p) => p.name === cfg.name);
    if (i >= 0) profiles[i] = cfg; else profiles.push(cfg);
  }
  if (!defaultName) defaultName = profiles[0].name;
  await saveConfig({ llms: profiles, defaultLlm: defaultName });
  selected = null;
  renderList();
  setStatus("已保存「" + cfg.name + "」" + (defaultName === cfg.name ? "（默认）" : ""));
});

$("bDefault").addEventListener("click", async () => {
  const sel = [...$("llmList").children].findIndex((d) => d.classList.contains("sel"));
  const name = sel >= 0 ? profiles[sel].name : null;
  if (!name) { setStatus("先在列表中点选一个配置", true); return; }
  defaultName = name;
  await saveConfig({ llms: profiles, defaultLlm: defaultName });
  renderList();
  setStatus("默认已切换：" + name);
});

$("bDel").addEventListener("click", async () => {
  const sel = [...$("llmList").children].findIndex((d) => d.classList.contains("sel"));
  if (sel < 0) { setStatus("先在列表中点选一个配置", true); return; }
  const name = profiles[sel].name;
  profiles.splice(sel, 1);
  if (defaultName === name) defaultName = profiles[0] ? profiles[0].name : "";
  await saveConfig({ llms: profiles, defaultLlm: defaultName });
  renderList();
});

function editProfile(name) {
  const p = profiles.find((x) => x.name === name);
  if (!p) return;
  selected = name;
  fillForm(p);
  setStatus("正在编辑「" + name + "」，保存后生效");
}

// cc-switch / 通用 JSON 提取（与桌面版 parse_pasted_json 同源启发式）
function parsePasted(text) {
  let root;
  try { root = JSON.parse(text.trim()); } catch { return null; }
  const urls = {}, keys = {}, models = {};
  let sawAnthropic = false, sawOpenai = false;
  (function walk(el) {
    if (el && typeof el === "object" && !Array.isArray(el)) {
      for (const [k, v] of Object.entries(el)) {
        const kl = k.toLowerCase();
        if (kl.includes("anthropic")) sawAnthropic = true;
        if (kl.includes("openai")) sawOpenai = true;
        const p = keyPriority(k);
        if (p && typeof v === "string" && v.trim()) {
          const [kind, pri] = p;
          const table = kind === "url" ? urls : kind === "key" ? keys : models;
          const cur = table[v.trim()];
          if (!cur || pri > cur[0]) table[v.trim()] = [pri, k];
        } else walk(v);
      }
    } else if (Array.isArray(el)) el.forEach(walk);
  })(root);
  if (!Object.keys(urls).length) return null;
  const pick = (t) => {
    const e = Object.entries(t).sort((a, b) => b[1][0] - a[1][0]);
    return e[0] ? { value: e[0][0], key: e[0][1][1] } : null;
  };
  const u = pick(urls), k = pick(keys), m = pick(models);
  const provider =
    sawAnthropic && (!sawOpenai || /anthropic/i.test(u.key || "")) ? "anthropic"
    : sawOpenai && !sawAnthropic ? "openai"
    : /anthropic/i.test(u.value || "") || /claude|anthropic/i.test(m ? m.value : "") ? "anthropic"
    : "openai";
  return {
    provider,
    baseUrl: u.value,
    apiKey: k ? k.value : "",
    model: m ? m.value : "",
  };
}
function keyPriority(k) {
  const kl = k.toLowerCase();
  if (/anthropic_base_url|openai_base_url/.test(kl)) return ["url", 100];
  if (/^base_?url$|^api_?base$/.test(kl)) return ["url", 80];
  if (/base_?url/.test(kl)) return ["url", 60];
  if (/^url$|endpoint/.test(kl)) return ["url", 40];
  if (/anthropic_auth_token|openai_api_key/.test(kl)) return ["key", 100];
  if (/^api_?key$|^auth_?token$|^token$/.test(kl)) return ["key", 80];
  if (/api_?key|auth|token/.test(kl)) return ["key", 50];
  if (/^key$/.test(kl)) return ["key", 30];
  if (/^anthropic_model$|^openai_model$|^model_name$/.test(kl)) return ["model", 100];
  if (/^model$/.test(kl)) return ["model", 80];
  if (/model/.test(kl)) return ["model", 40];
  return null;
}
