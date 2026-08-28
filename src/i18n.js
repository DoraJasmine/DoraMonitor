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
    estCost: "估算费用 (USD)",
    cacheHitRate: "缓存命中率",
    dailyTrend: "每日趋势",
    modelStats: "模型统计",
    recent: "最近请求",
    model: "模型",
    time: "时间",
    cost: "费用",
    tokens: "Token",
    language: "语言",
    pricingNote: "费用按 Kimi API Platform 官方标价估算；非 Kimi 模型使用 K2.6 标价作参考并标记为估算。",
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
    perMTok: "美元 / 百万 Token",
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
    estCost: "Est. cost (USD)",
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
      "Costs use official Kimi API Platform list prices. Non-Kimi models fall back to K2.6 rates and are marked estimated.",
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
    perMTok: "USD / 1M tokens",
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
