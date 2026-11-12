# 刊读助手 · Chrome 扩展 功能需求与设计文档

版本：v1.3.1（2026-11-12）· 对应仓库 `I:\awesomeEnglish\magread-chrome`（分支 main）
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
- 缓存：按 URL 哈希缓存，新结果记录正文哈希以识别文章更新
- 同文并发请求合并；默认输出预算 1500（截断时自适应增加）；空摘要不入缓存。
- 生成时显示阶段、已接收正文字符数、重试次数和经过秒数；不伪造百分比。

### F2 逐段生词表
- 触发：侧栏「生成生词表」
- 流程：本地 CET-4 词表粗筛候选并附到本块提示词 → 约 4500 字符分块（标题合并首块，长段保留全文） → 最多两块并发 LLM 确认/释义
- 词表校准：CET-4 及以上常用词不收；超纲词/术语/熟词僻义收录；
  词条含音标（必须）、词性、释义（本文义项）、原文短语、词根拆解、术语标记
- 界面：每个段落前出现「词 N」绿色徽标，点击展开/收起该段生词
- 进度：已保存段落数 / 总段落数（含标题），失败块不计入完成百分比；
  显示最多两个在途块的渠道、阶段、字符数和重试次数，失败块单独列数。
- 容错：按段独立校验并立即保存正常段落，问题段落（含内容安全过滤）自动**轮换其他已配置 LLM**；
  全部渠道试过仍失败的块留待下次；再次显式点击会允许重试失败渠道，已完成段落不重复生成
- 缓存：按 URL 哈希 + 正文哈希校验 + 段落级 `processedParagraphs` 续传；每块完成立即保存
- 输出：固定六列紧凑词条 `[word,pos,sense,root,term,phonetic]`；段首和原文短语本地提取，
  要求每词给出非空音标，CET-4 词表可提供的音标本地优先回填；兼容旧对象词条。同词在不同段落独立保留。

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
| 流式调用，兼容 JSON 返回 | 逐帧保留结束原因；请求期间定时访问 storage，单次超时 120 秒；完成块立即落盘 |
| 正文抽取：DOM 优先 + JSON-LD 兜底 | 同意墙/懒加载会遮挡 DOM；新闻站普遍内嵌 ld+json 全文 |
| 生词分块约 4500 字符 + 两路并发 + LLM 轮换 | 标题合并首块；预算自适应；失败换渠道；同文任务合并；只对未完成段落请求 |
| 音标由本地 CET-4 词表与模型提供 | 模型一律输出音标，已有音标本地优先回填，避免长名单的省略提示使模型遗漏其他词的音标；扩展未内置完整 ECDICT |
| 按钮状态机：none/partial/complete | `processedParagraphs` 缺段即 partial（兼容旧缓存无 chunkFailures 的情况） |
| DeepSeek 默认关闭思考 | 按模型名或官方 API 地址识别，OpenAI 和 Anthropic 兼容请求均传递 `thinking.type=disabled`；不改变其他模型默认行为 |
| 段落级容错 | `VocabValidationError.sections` 保存正常段落，仅将问题段落送入下一渠道或下次续传，严格保留原文匹配与音标校验 |
| 渠道去重 | 根据协议、完整地址、模型、密钥和思考设置判断相同请求，不将同一接口不同名称当作备用渠道 |
| 任务与 DOM 独立 | requestId 隔离旧消息，关闭侧栏不丢任务、不重复请求；完成不抢标签或自动弹窗 |
| 真实进度 + 节流 | LLM 每 250ms 最多上报一次字符进度，页面每 500ms 更新时间；生词完整结果只在块保存后传递 |

### 3.3 消息协议（content ↔ background）

| type | 方向 | 载荷 | 返回 |
|---|---|---|---|
| getConfig | →bg | — | {llms, defaultLlm, defaultCfg} |
| saveConfig | →bg | {llms, defaultLlm} | — |
| testLLM | →bg | {cfg} | {ok, reply} |
| listModels | →bg | {cfg} | {ok, models[]} |
| getCache | →bg | {url} | {digest, vocab} |
| genDigest | →bg | {article, requestId} | {digest} |
| genVocab | →bg | {article, requestId} | {vocab} |
| analyze | →bg | {payload, requestId} | {analysis} |
| generationProgress | bg→content | {task, requestId, url, contentHash?, phase, chars?, attempt?, active?, completedParagraphs?, totalParagraphs?, failedChunks?, vocab?} | 仅发给原 tab/frame；按 requestId 匹配当前任务 |
| log / getLogs / clearLogs | →bg | — | 日志 |

### 3.4 存储结构（chrome.storage.local）

| 键 | 内容 |
|---|---|
| `llms` / `defaultLlm` | LLM 配置数组与默认名 |
| `digest_<urlHash>` | {titleEn, titleZh, summaryZh, ts, contentHash, generationStats} |
| `vocab_<urlHash>` | {contentHash, processedParagraphs[], chunkFailures{}, paragraphs[], titleEntries[], generationStats} |
| `analysis_<urlHash>_s<sentHash>` | 句解五段对象 + generationStats |
| `logs` | 环形日志数组 |

### 3.5 容错矩阵

| 故障 | 处理 |
|---|---|
| max_tokens 超限（HTTP 4xx 措辞识别） | 预算减半重试（下限 256），不重复提交已被拒绝的预算 |
| 输出被 length 截断 | 保留接口结束标记，预算加倍重试（上限 32768）；仍截断则报错，不标记完成 |
| 推理模型思考烧尽额度无正文 | 同上加倍策略 |
| 内容安全过滤（censor） | 生词块：记录渠道、轮换下一配置；全部渠道失败才放弃 |
| JSON 截断/损坏 | 摘要/句解支持 repairJson；生词表严格解析与校验完整段落覆盖，失败则轮换渠道/续传 |
| JSON-LD 抽取异常 | 静默跳过，回退 DOM 抽取 |
| 面板初始化异常 | 错误显示在面板内 + 写入运行日志 |

## 四、正文抽取策略

1. 标题：`og:title` → `<h1>` → `document.title`
2. 根容器：`article` → `[role=main]` → `main` → 特定类名 → innerText 最长的 p 集合容器
3. 段落：容器内 `<p>` 的 innerText，去重、≥40 字符
4. 兜底：`<script type="application/ld+json">` 中 Article/NewsArticle 的 `articleBody` 按空行切分

## 五、已知限制与后续方向

- 本地离线查词（ECDICT）未内置：桌面版已实现，扩展受体积考虑暂缓
- MV3 service worker 仍可能因浏览器退出/扩展重载等被终止；逐块缓存保证下次只补未完成段落
- 正文抽取对反爬站点（硬付费墙）无解：需要登录的内容以登录后 DOM 为准
- 句解双击依赖浏览器选词行为；生僻缩写的句子边界偶有偏差，不影响解析正确性

## 六、版本历史（摘要）

- v1.0.0 首版：摘要/生词表/句解/多 LLM
- v1.0.1 内建运行日志；v1.0.2 面板加载状态与即时渲染
- v1.1.0 面板 Tab 导航；v1.1.1 JSON-LD 兜底抽取
- v1.1.2 修复操作按钮、缓存标签切换及句解显示
- v1.2.0 候选词实际接入、紧凑词条、两路并发、流式兼容、逐块保存与严格续传，修复徽标污染正文及跨段生词去重
- v1.3.0 同步 DeepSeek 关闭思考模式，摘要/句解实时阶段与字符进度、生词保存进度；
  任务独立于面板，关闭重开和切换标签保留进度，后台完成不强行弹窗；暖白墨绿界面、窄屏滚动、修复模型配置重命名。
- v1.3.1 补齐 DeepSeek Anthropic 接口的关闭思考参数；不规则词形、段落级校验保存、同接口去重与明确音标提示。
  日志记录接口类型、模型、思考设置、正文与思考字符数和请求次数，便于核对网关是否遵守参数。
