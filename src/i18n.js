"use strict";

const messages = {
  zh: {
    appTitle: "Kimi Code 用量看板",
    subtitle: "仅统计 usage.record 中的模型、时间与 Token，不读取提示词与凭据",
    dataDir: "数据目录",
    chooseDir: "选择其他目录",
    refresh: "刷新",
    autoDetect: "自动检测",
    rangeToday: "今天",
    range7d: "近 7 天",
    range30d: "近 30 天",
    rangeAll: "全部",
    inputOther: "普通输入",
    output: "模型输出",
    cacheRead: "缓存读取",
    cacheCreate: "缓存创建",
    requests: "请求数",
    totalTokens: "总 Token",
    estCost: "估算费用",
    cacheHitRate: "缓存命中率",
    dailyTrend: "每日趋势",
    modelStats: "模型统计",
    recent: "最近请求",
    model: "模型",
    time: "时间",
    cost: "费用",
    tokens: "Token",
    language: "语言",
    pricingNote: "Kimi 中国区、DeepSeek 与智谱使用人民币官方价；OpenAI 使用美元官方价并按设置汇率换算。DeepSeek 分高峰/空闲价，未识别模型按 K2.6 参考价估算。",
    noData: "暂无 usage.record 数据",
    scanning: "正在扫描…",
    filesScanned: "已扫描文件",
    records: "记录数",
    homeInvalid: "目录无效：未找到 sessions 或 config.toml",
    estimated: "估算",
    official: "官方价",
    session: "会话",
    workspace: "工作区",
    applyDir: "应用",
    dirPlaceholder: "例如 C:\\Users\\you\\.kimi-code 或 ~/.kimi-code",
    envModel: "环境变量模型",
    defaultModel: "默认模型",
    priceTable: "官方价格表",
    perMTok: "当前显示币种 / 百万 Token",
    privacy: "隐私：不显示提示词、回复、代码、API Key 与 Provider 凭据。",
    quickCompare: "各时间范围总览",
    unknownDir: "未检测到有效数据目录",
    lastScan: "上次扫描",
  },
  en: {
    appTitle: "Kimi Code Usage Dashboard",
    subtitle: "Counts only model, time, and tokens from usage.record — no prompts or credentials",
    dataDir: "Data directory",
    chooseDir: "Choose another directory",
    refresh: "Refresh",
    autoDetect: "Auto-detect",
    rangeToday: "Today",
    range7d: "7 days",
    range30d: "30 days",
    rangeAll: "All",
    inputOther: "Input",
    output: "Output",
    cacheRead: "Cache read",
    cacheCreate: "Cache create",
    requests: "Requests",
    totalTokens: "Total tokens",
    estCost: "Est. cost",
    cacheHitRate: "Cache hit rate",
    dailyTrend: "Daily trend",
    modelStats: "Model stats",
    recent: "Recent requests",
    model: "Model",
    time: "Time",
    cost: "Cost",
    tokens: "Tokens",
    language: "Language",
    pricingNote:
      "Kimi China, DeepSeek, and BigModel use official CNY prices; OpenAI uses official USD prices converted at the configured rate. DeepSeek has peak/off-peak pricing; unknown models use an estimated K2.6 fallback.",
    noData: "No usage.record data found",
    scanning: "Scanning…",
    filesScanned: "Files scanned",
    records: "Records",
    homeInvalid: "Invalid directory: sessions/ or config.toml not found",
    estimated: "Estimated",
    official: "Official",
    session: "Session",
    workspace: "Workspace",
    applyDir: "Apply",
    dirPlaceholder: "e.g. C:\\Users\\you\\.kimi-code or ~/.kimi-code",
    envModel: "Env model",
    defaultModel: "Default model",
    priceTable: "Official price table",
    perMTok: "display currency / 1M tokens",
    privacy: "Privacy: prompts, replies, code, API keys, and provider credentials are never shown or stored.",
    quickCompare: "Range overview",
    unknownDir: "No valid data directory detected",
    lastScan: "Last scan",
  },
};

function detectLocale(headerLang) {
  if (headerLang && /^zh/i.test(headerLang)) return "zh";
  if (headerLang && /^en/i.test(headerLang)) return "en";
  // system locale
  const env =
    process.env.LANG ||
    process.env.LC_ALL ||
    process.env.LC_MESSAGES ||
    Intl.DateTimeFormat().resolvedOptions().locale ||
    "";
  if (/^zh/i.test(env) || /zh[_-]/i.test(env)) return "zh";
  return "en";
}

function t(locale, key) {
  const pack = messages[locale] || messages.en;
  return pack[key] || messages.en[key] || key;
}

module.exports = { messages, detectLocale, t };
