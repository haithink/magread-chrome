# 刊读助手 · Chrome 扩展 功能需求与设计文档

版本：v1.1.1（2026-10-30）· 对应仓库 `I:\awesomeEnglish\magread-chrome`（分支 main）
姊妹项目：刊读桌面版（`magread-desktop`，Python/Tkinter）· 刊读安卓版（`magread`，Kotlin/Compose）
三端共享同一套提示词、容错策略与数据结构约定。

## 一、定位与目标用户

面向「刊读」英语精读工作流：用户在真实新闻网站（WIRED、经济学人等）阅读英文文章时，
就地获得 LLM 辅助——**文章摘要、逐段生词表、双击/选中句解**——而不用切换到桌面应用。
扩展只处理**单篇网页文章**；本地刊物管理由桌面版承担。

## 二、功能需求（当前已实现）

### F1 文章摘要
- 触发：侧栏「操作」Tab → 生成摘要
- 输入：页面抽取的标题 + 正文（截断至 6000 字符）
- 输出：`{titleEn, titleZh, summaryZh}`（100~150 字中文摘要）
- 缓存：按 URL 哈希缓存，重开秒出

### F2 逐段生词表
- 触发：侧栏「生成生词表」
- 流程：本地 CET-4 词表粗筛候选 → 按 4500 字符分块 → LLM 确认/释义
- 词表校准：CET-4 及以上常用词不收；超纲词/术语/熟词僻义收录；
  词条含音标（必须）、词性、释义（本文义项）、原文短语、词根拆解、术语标记
- 界面：每个段落前出现「词 N」绿色徽标，点击展开/收起该段生词
- 容错：单块失败（含内容安全过滤）自动**轮换其他已配置 LLM**；
  全部渠道试过仍失败的块留待下次（`chunkFailures` 记录试用渠道，不重复烧 token）
- 缓存：按 URL 哈希 + 段落级 `processedParagraphs` 续传

### F3 句解（双击 / 选中）
- 双击句子：定位光标所在句 → 五段式解析
- 选中文字块：悬浮「解析」按钮 → 对所选文本块解析
- 输出格式（与用户精读工作流固定格式一致）：
  疑难词汇（音标/释义/词根）→ 语法对齐图解（等宽）→ 编号语法点 → 语境 → 参考译文
- 缓存：URL 哈希 + 句子哈希

### F4 多 LLM 配置管理
- 任意数量配置；字段：名称/接口类型（OpenAI 兼容、Anthropic 原生）/URL/Key/模型名
- ★ 默认配置：日常生成使用；cc-switch JSON 粘贴自动识别（含 `ANTHROPIC_*` 键名判定）
- 测试连接、获取可用模型（/v1/models）
- 单配置删除/编辑；默认切换

### F5 运行日志
- 环形 300 条，storage 持久化
- 记录：LLM 失败（渠道名+错误原文）、额度减半自适应、生词块失败渠道、
  摘要缓存命中、面板初始化异常
- 弹窗内查看/复制/清空

## 三、架构设计

### 3.1 组件（MV3）

```
┌─ content.js（隔离世界，注入每页）─────────────┐
│ 正文抽取（DOM + JSON-LD 兜底）                │
│ 悬浮球 / 侧栏面板（Tab：操作|摘要|生词表|句解）│
│ 段落徽标 + 行内生词面板                        │
│ 双击/选中交互                                  │
└──────────────┬───────────────────────────────┘
        chrome.runtime 消息（Promise）
┌──────────────▼───────────────────────────────┐
│ background.js（service worker）                │
│ LLM 客户端（预算自适应/截断/censor 识别）       │
│ 提示词（摘要/生词/句解，与桌面版同源）           │
│ 编排：分块、chunkFailures 轮换、缓存读写        │
│ CET-4 粗筛词表（runtime.getURL 资产）           │
└──────────────┬───────────────────────────────┘
┌──────────────▼───────────────┐
│ chrome.storage.local           │
│ cfg/摘要/生词/句解/日志         │
└──────────────────────────────┘
```

### 3.2 关键设计决策

| 决策 | 理由 |
|---|---|
| LLM 调用全部在 service worker | 集中管理配置/缓存；`host_permissions: <all_urls>` 覆盖用户自定义网关 |
| 非流式调用 | MV3 SW 生命周期靠 fetch 保活，非流式实现简单；长文本靠预算自适应 |
| 正文抽取：DOM 优先 + JSON-LD 兜底 | 同意墙/懒加载会遮挡 DOM；新闻站普遍内嵌 ld+json 全文 |
| 生词分块 4500 字符 + LLM 轮换 | 单块超限自动减半预算；censor 拒答自动换渠道；`chunkFailures` 防重复烧 token |
| 音标缺失 → 提示词强制 + （桌面版）ECDICT 回填 | 模型省略音标的兜底；扩展版暂无本地词典，音标由模型给出 |
| 按钮状态机：none/partial/complete | `processedParagraphs` 缺段即 partial（兼容旧缓存无 chunkFailures 的情况） |

### 3.3 消息协议（content ↔ background）

| type | 方向 | 载荷 | 返回 |
|---|---|---|---|
| getConfig | →bg | — | {llms, defaultLlm, defaultCfg} |
| saveConfig | →bg | {llms, defaultLlm} | — |
| testLLM | →bg | {cfg} | {ok, reply} |
| listModels | →bg | {cfg} | {ok, models[]} |
| getCache | →bg | {url} | {digest, vocab} |
| genDigest | →bg | {article} | {digest, cached?} |
| genVocab | →bg | {article} | {vocab}（进度经 tabs.sendMessage vocabProgress） |
| analyze | →bg | {payload} | {analysis} |
| log / getLogs / clearLogs | →bg | — | 日志 |

### 3.4 存储结构（chrome.storage.local）

| 键 | 内容 |
|---|---|
| `llms` / `defaultLlm` | LLM 配置数组与默认名 |
| `digest_<urlHash>` | {titleEn, titleZh, summaryZh, ts} |
| `vocab_<urlHash>` | {processedParagraphs[], chunkFailures{}, paragraphs[], titleEntries[]} |
| `analysis_<urlHash>_s<sentHash>` | 句解五段对象 |
| `logs` | 环形日志数组 |

### 3.5 容错矩阵

| 故障 | 处理 |
|---|---|
| max_tokens 超限（HTTP 4xx 措辞识别） | 预算减半重试（下限 4096） |
| 输出被 length 截断 | 预算加倍重试（上限 32768）；到顶仍截断 → 原样返回 |
| 推理模型思考烧尽额度无正文 | 同上加倍策略 |
| 内容安全过滤（censor） | 生词块：记录渠道、轮换下一配置；全部渠道失败才放弃 |
| JSON 截断/损坏 | 引号裁剪 + 悬空键清理 + 括号补全（repairJson） |
| JSON-LD 抽取异常 | 静默跳过，回退 DOM 抽取 |
| 面板初始化异常 | 错误显示在面板内 + 写入运行日志 |

## 四、正文抽取策略

1. 标题：`og:title` → `<h1>` → `document.title`
2. 根容器：`article` → `[role=main]` → `main` → 特定类名 → innerText 最长的 p 集合容器
3. 段落：容器内 `<p>` 的 innerText，去重、≥40 字符
4. 兜底：`<script type="application/ld+json">` 中 Article/NewsArticle 的 `articleBody` 按空行切分

## 五、已知限制与后续方向

- 本地离线查词（ECDICT）未内置：桌面版已实现，扩展受体积考虑暂缓
- MV3 service worker 可能在极长任务中途被回收：生词表分块规模（≤6 块）实测安全
- 正文抽取对反爬站点（硬付费墙）无解：需要登录的内容以登录后 DOM 为准
- 句解双击依赖浏览器选词行为；生僻缩写的句子边界偶有偏差，不影响解析正确性

## 六、版本历史（摘要）

- v1.0.0 首版：摘要/生词表/句解/多 LLM
- v1.0.1 内建运行日志；v1.0.2 面板加载状态与即时渲染
- v1.1.0 面板 Tab 导航；v1.1.1 JSON-LD 兜底抽取
