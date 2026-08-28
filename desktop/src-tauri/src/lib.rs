use chrono::{DateTime, Datelike, NaiveDateTime};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use walkdir::WalkDir;

// ---------------------------------------------------------------------------
// Types – match the Node API JSON shape exactly
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PathsResult {
    pub current: String,
    pub valid: bool,
    pub candidates: Vec<PathCandidate>,
    pub env: EnvInfo,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PathCandidate {
    pub path: String,
    pub valid: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EnvInfo {
    #[serde(rename = "KIMI_CODE_HOME")]
    pub kimi_code_home: Option<String>,
    #[serde(rename = "KIMI_MODEL_NAME")]
    pub kimi_model_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PriceRow {
    pub id: String,
    pub cache_hit: f64,
    pub input: f64,
    pub output: f64,
    pub context: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PricesResult {
    pub prices: Vec<PriceRow>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SummaryResult {
    pub home: String,
    pub valid: bool,
    pub scanned_at: u64,
    pub meta: ScanMeta,
    pub model_map: ModelMapInfo,
    pub range: String,
    pub stats: RangeStats,
    pub heatmap: HeatmapData,
    pub all_models: Vec<AllModelRow>,
    pub all_model_count: usize,
    pub range_totals: HashMap<String, TotalsRow>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanMeta {
    pub files_scanned: usize,
    pub lines_seen: usize,
    pub record_count: usize,
    pub home: String,
    pub sessions_root: String,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelMapInfo {
    pub default_model: Option<String>,
    pub env_model: Option<EnvModelInfo>,
    pub alias_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EnvModelInfo {
    pub name: String,
    pub provider: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RangeStats {
    pub range: String,
    pub totals: TotalsRow,
    pub daily: Vec<DailyRow>,
    pub daily_by_model: DailyByModel,
    pub models: Vec<ModelRow>,
    pub recent: Vec<RecentRow>,
    pub recent_total: usize,
    pub recent_limit: usize,
}

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DailyByModel {
    pub dates: Vec<String>,
    pub series: Vec<DailyModelSeries>,
    pub totals: Vec<DailyTotalPoint>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DailyModelSeries {
    pub key: String,
    pub label: String,
    pub model_display: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub is_others: bool,
    pub values: Vec<u64>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DailyTotalPoint {
    pub date: String,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub requests: usize,
    pub cache_hit_rate: f64,
}

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TotalsRow {
    pub requests: usize,
    pub input_other: u64,
    pub output: u64,
    pub input_cache_read: u64,
    pub input_cache_creation: u64,
    pub cost_usd: f64,
    pub total_tokens: u64,
    pub cache_hit_rate: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DailyRow {
    pub date: String,
    pub requests: usize,
    pub input_other: u64,
    pub output: u64,
    pub input_cache_read: u64,
    pub input_cache_creation: u64,
    pub cost_usd: f64,
    pub total_tokens: u64,
    pub cache_hit_rate: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelRow {
    pub model: String,
    pub model_display: String,
    pub model_resolved: String,
    pub price_id: String,
    pub cost_estimated: bool,
    pub requests: usize,
    pub input_other: u64,
    pub output: u64,
    pub input_cache_read: u64,
    pub input_cache_creation: u64,
    pub cost_usd: f64,
    pub total_tokens: u64,
    pub cache_hit_rate: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentRow {
    pub time: u64,
    pub model: String,
    pub model_display: String,
    pub model_resolved: String,
    pub input_other: u64,
    pub output: u64,
    pub input_cache_read: u64,
    pub input_cache_creation: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub cost_estimated: bool,
    pub price_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_hint: Option<SessionHint>,
    pub from_env: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionHint {
    pub workspace: Option<String>,
    pub session: Option<String>,
    pub agent: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AllModelRow {
    pub model: String,
    pub model_display: String,
    pub requests: usize,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub cost_estimated: bool,
    pub cache_hit_rate: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HeatmapData {
    pub weeks: usize,
    pub start: String,
    pub end: String,
    pub max_tokens: u64,
    pub cells: Vec<HeatmapCell>,
    pub month_labels: Vec<MonthLabel>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HeatmapCell {
    pub date: String,
    pub dow: usize,
    pub week_index: usize,
    pub requests: usize,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub cache_hit_rate: f64,
    pub level: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MonthLabel {
    pub week_index: usize,
    pub label: String,
}

// Sessions types
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionsResult {
    pub home: String,
    pub archive_root: String,
    pub workspaces: Vec<WorkspaceRow>,
    pub sessions: Vec<SessionRow>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRow {
    pub id: String,
    pub name: String,
    pub root: Option<String>,
    pub created_at: Option<String>,
    pub last_opened_at: Option<String>,
    pub active_count: usize,
    pub archived_count: usize,
    pub empty: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub workspace_id: String,
    pub status: String,
    pub title: Option<String>,
    pub work_dir: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub bytes: u64,
    pub files: usize,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ActionResponse {
    pub ok: bool,
    pub workspace_id: String,
    pub session_id: String,
    pub status: Option<String>,
    pub path: Option<String>,
    pub deleted: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub workspace_id: String,
    pub session_id: String,
    pub status: String,
    pub title: Option<String>,
    pub work_dir: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub message_count: usize,
    pub truncated: bool,
    pub messages: Vec<PreviewMessage>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreviewMessage {
    pub role: String,
    pub time: Option<u64>,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDeleteBody {
    pub workspace_id: String,
    pub confirm: Option<bool>,
    pub force: Option<bool>,
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
pub struct AppState {
    pub scan_cache: Mutex<ScanCache>,
}

#[derive(Clone)]
pub struct ScanCache {
    pub home: String,
    pub scanned_at: u64,
    pub records: Vec<UsageRecord>,
    pub meta: ScanMeta,
    pub model_map: ModelMapInfo,
}

#[derive(Debug, Clone)]
pub struct UsageRecord {
    pub time: u64,
    pub model: String,
    pub input_other: u64,
    pub output: u64,
    pub input_cache_read: u64,
    pub input_cache_creation: u64,
    pub cost_usd: f64,
    pub cost_estimated: bool,
    pub price_id: String,
    pub model_resolved: String,
    pub model_display: String,
    pub provider: Option<String>,
    pub from_env: bool,
    pub session_hint: Option<SessionHint>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn resolve_kimi_home(override_path: Option<String>) -> PathBuf {
    if let Some(p) = override_path {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Ok(env_home) = std::env::var("KIMI_CODE_HOME") {
        if !env_home.trim().is_empty() {
            return PathBuf::from(env_home);
        }
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".kimi-code")
}

fn is_kimi_home(dir: &Path) -> bool {
    if !dir.exists() || !dir.is_dir() {
        return false;
    }
    dir.join("config.toml").exists() || dir.join("sessions").exists()
}

fn sessions_root(home: &Path) -> PathBuf {
    home.join("sessions")
}

fn workspace_re() -> Regex {
    Regex::new(r"^wd_[A-Za-z0-9._-]+$").unwrap()
}

fn session_re() -> Regex {
    Regex::new(r"^session_[0-9a-fA-F-]{8,}$").unwrap()
}

fn safe_read_dir(path: &Path) -> Vec<fs::DirEntry> {
    let mut entries = Vec::new();
    if let Ok(rd) = fs::read_dir(path) {
        for e in rd.flatten() {
            entries.push(e);
        }
    }
    entries
}

fn file_size_approx(path: &Path) -> (u64, usize) {
    let mut total_bytes = 0u64;
    let mut total_files = 0usize;
    for entry in WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            if let Ok(meta) = entry.metadata() {
                total_bytes += meta.len();
                total_files += 1;
            }
        }
    }
    (total_bytes, total_files)
}

fn day_key(ts_ms: u64) -> String {
    let secs = if ts_ms > 1e12 as u64 { ts_ms / 1000 } else { ts_ms };
    let naive = DateTime::from_timestamp(secs as i64, 0)
        .unwrap_or_default();
    let local: NaiveDateTime = naive.naive_utc(); // UTC-local; close enough
    format!("{:04}-{:02}-{:02}", local.year(), local.month(), local.day())
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

fn list_prices() -> Vec<PriceRow> {
    vec![
        PriceRow { id: "kimi-k3".into(), cache_hit: 0.30, input: 3.00, output: 15.00, context: 1_048_576 },
        PriceRow { id: "kimi-k2.7-code".into(), cache_hit: 0.19, input: 0.95, output: 4.00, context: 262_144 },
        PriceRow { id: "kimi-k2.6".into(), cache_hit: 0.16, input: 0.95, output: 4.00, context: 262_144 },
        PriceRow { id: "kimi-k2.5".into(), cache_hit: 0.10, input: 0.60, output: 3.00, context: 262_144 },
        PriceRow { id: "kimi-k2-turbo".into(), cache_hit: 0.15, input: 1.15, output: 8.00, context: 262_144 },
        PriceRow { id: "kimi-k2".into(), cache_hit: 0.15, input: 0.60, output: 2.50, context: 262_144 },
    ]
}

fn match_price(model_name: &str) -> (String, f64, f64, f64, bool) {
    let bare = match model_name.rsplit_once('/') {
        Some((_, b)) => b,
        None => model_name,
    };
    let bare_l = bare.to_ascii_lowercase();
    for p in &list_prices() {
        let id_l = p.id.to_ascii_lowercase();
        if bare_l == id_l || bare_l.contains(&id_l) || id_l.contains(&bare_l) {
            return (p.id.clone(), p.cache_hit, p.input, p.output, false);
        }
    }
    ("kimi-k2.6".into(), 0.16, 0.95, 4.00, true)
}

fn cost_for_usage(input_other: u64, output: u64, cache_read: u64, cache_create: u64, model: &str) -> (f64, bool) {
    let (_price_id, cache_hit, input_price, output_price, est) = match_price(model);
    let cost = (input_other as f64 / 1e6) * input_price
        + (cache_read as f64 / 1e6) * cache_hit
        + (cache_create as f64 / 1e6) * input_price
        + (output as f64 / 1e6) * output_price;
    (cost, est)
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

fn scan_usage(home: &Path) -> (Vec<UsageRecord>, ScanMeta) {
    let root = sessions_root(home);
    let mut records = Vec::new();
    let mut files_scanned = 0;
    let mut lines_seen = 0;
    let errors = Vec::new();

    if !root.exists() {
        return (records, ScanMeta {
            files_scanned: 0, lines_seen: 0, record_count: 0,
            home: home.to_string_lossy().to_string(),
            sessions_root: root.to_string_lossy().to_string(),
            errors: vec!["sessions directory not found".into()],
        });
    }

    for entry in WalkDir::new(&root).into_iter().filter_map(|e| e.ok()) {
        if entry.file_name() != "wire.jsonl" { continue; }
        if !entry.file_type().is_file() { continue; }
        // Skip blob/task directories
        let p = entry.path();
        if p.to_string_lossy().contains("blobs") || p.to_string_lossy().contains("tasks") {
            continue;
        }
        files_scanned += 1;
        let content = match fs::read_to_string(entry.path()) {
            Ok(c) => c,
            Err(_) => continue,
        };
        for line in content.lines() {
            lines_seen += 1;
            if !line.contains("\"usage.record\"") { continue; }
            let obj: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if obj.get("type").and_then(|v| v.as_str()) != Some("usage.record") { continue; }
            let scope = obj.get("usageScope").and_then(|v| v.as_str()).unwrap_or("turn");
            if scope != "turn" { continue; }

            let model_raw = obj.get("model").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
            let time = obj.get("time").and_then(|v| v.as_u64()).unwrap_or(0);
            let usage = &obj["usage"];
            let input_other = usage.get("inputOther").and_then(|v| v.as_u64()).unwrap_or(0);
            let output = usage.get("output").and_then(|v| v.as_u64()).unwrap_or(0);
            let cache_read = usage.get("inputCacheRead").and_then(|v| v.as_u64()).unwrap_or(0);
            let cache_create = usage.get("inputCacheCreation").and_then(|v| v.as_u64()).unwrap_or(0);

            // Resolve model display
            let bare = model_raw.rsplit_once('/').map(|x| x.1).unwrap_or(&model_raw);
            let (cost, est) = cost_for_usage(input_other, output, cache_read, cache_create, &model_raw);
            let (pid, _ch, _ip, _op, _) = match_price(&model_raw);
            let hint = session_hint_from_path(p, &root);

            records.push(UsageRecord {
                time,
                model: model_raw.clone(),
                model_resolved: bare.to_string(),
                model_display: model_raw.clone(),
                provider: model_raw.rsplit_once('/').map(|x| x.0.to_string()),
                from_env: model_raw == "__kimi_env_model__",
                input_other,
                output,
                input_cache_read: cache_read,
                input_cache_creation: cache_create,
                cost_usd: cost,
                cost_estimated: est,
                price_id: pid,
                session_hint: hint,
            });
        }
    }

    records.sort_by(|a, b| b.time.cmp(&a.time));
    let count = records.len();
    (records, ScanMeta {
        files_scanned, lines_seen, record_count: count,
        home: home.to_string_lossy().to_string(),
        sessions_root: root.to_string_lossy().to_string(),
        errors: errors.into_iter().take(20).collect(),
    })
}

/// Basename chain hint: sessions/<workspace>/session_<id>/agents/<agent>/wire.jsonl
fn session_hint_from_path(p: &Path, sessions_root: &Path) -> Option<SessionHint> {
    let rel = p.strip_prefix(sessions_root).ok()?;
    let parts: Vec<&str> = rel
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_str().unwrap_or("")),
            _ => None,
        })
        .collect();
    if parts.is_empty() {
        return None;
    }
    Some(SessionHint {
        workspace: parts.first().map(|s| s.to_string()),
        session: parts.get(1).map(|s| s.to_string()),
        agent: parts.get(3).or_else(|| parts.get(2)).map(|s| s.to_string()),
    })
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

fn aggregate(records: &[UsageRecord], range: &str, now_ms: u64) -> RangeStats {
    let filtered: Vec<&UsageRecord> = filter_by_range(records, range, now_ms);
    let range_label = range.to_string();

    if filtered.is_empty() {
        return RangeStats {
            range: range_label,
            totals: TotalsRow::default(),
            daily: vec![],
            daily_by_model: DailyByModel::default(),
            models: vec![],
            recent: vec![],
            recent_total: 0,
            recent_limit: 500,
        };
    }

    let mut totals = TotalsRow::default();
    let mut by_day: HashMap<String, TotalsRow> = HashMap::new();
    let mut by_model: HashMap<String, (ModelRow, TotalsRow)> = HashMap::new();
    // day -> model -> tokens
    let mut by_day_model: HashMap<String, HashMap<String, u64>> = HashMap::new();

    for r in &filtered {
        totals.add(r);
        let dk = day_key(r.time);
        let day_totals = by_day.entry(dk.clone()).or_default();
        day_totals.add(r);

        let mk = r.model.clone();
        let tok = r.input_other + r.output + r.input_cache_read + r.input_cache_creation;
        by_day_model
            .entry(dk.clone())
            .or_default()
            .entry(mk.clone())
            .and_modify(|v| *v += tok)
            .or_insert(tok);

        let entry = by_model.entry(mk.clone()).or_insert_with(|| {
            let m = ModelRow {
                model: mk.clone(),
                model_display: r.model_display.clone(),
                model_resolved: r.model_resolved.clone(),
                price_id: r.price_id.clone(),
                cost_estimated: r.cost_estimated,
                requests: 0, input_other: 0, output: 0,
                input_cache_read: 0, input_cache_creation: 0,
                cost_usd: 0.0, total_tokens: 0, cache_hit_rate: 0.0,
            };
            (m, TotalsRow::default())
        });
        entry.1.add(r);
        entry.0.cost_estimated = entry.0.cost_estimated || r.cost_estimated;
    }

    let total_input = totals.input_other + totals.input_cache_read + totals.input_cache_creation;
    totals.cache_hit_rate = if total_input > 0 { totals.input_cache_read as f64 / total_input as f64 } else { 0.0 };

    let mut daily: Vec<DailyRow> = by_day.into_iter()
        .map(|(date, t)| {
            let ti = t.input_other + t.input_cache_read + t.input_cache_creation;
            let ch = if ti > 0 { t.input_cache_read as f64 / ti as f64 } else { 0.0 };
            DailyRow {
                date, requests: t.requests,
                input_other: t.input_other, output: t.output,
                input_cache_read: t.input_cache_read, input_cache_creation: t.input_cache_creation,
                cost_usd: t.cost_usd, total_tokens: t.total_tokens, cache_hit_rate: ch,
            }
        })
        .collect();
    daily.sort_by(|a, b| a.date.cmp(&b.date));

    let mut models: Vec<ModelRow> = by_model.into_iter().map(|(_, (mut m, t))| {
        let ti = t.input_other + t.input_cache_read + t.input_cache_creation;
        m.cache_hit_rate = if ti > 0 { t.input_cache_read as f64 / ti as f64 } else { 0.0 };
        m.requests = t.requests;
        m.input_other = t.input_other; m.output = t.output;
        m.input_cache_read = t.input_cache_read; m.input_cache_creation = t.input_cache_creation;
        m.cost_usd = t.cost_usd; m.total_tokens = t.total_tokens;
        m
    }).collect();
    models.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));

    let daily_by_model = build_daily_by_model(&daily, &models, &by_day_model);

    let recent_total = filtered.len();
    let recent_limit = 500;
    let recent: Vec<RecentRow> = filtered.iter().take(recent_limit).map(|r| RecentRow {
        time: r.time, model: r.model.clone(), model_display: r.model_display.clone(),
        model_resolved: r.model_resolved.clone(),
        input_other: r.input_other, output: r.output,
        input_cache_read: r.input_cache_read, input_cache_creation: r.input_cache_creation,
        total_tokens: r.input_other + r.output + r.input_cache_read + r.input_cache_creation,
        cost_usd: r.cost_usd, cost_estimated: r.cost_estimated,
        price_id: r.price_id.clone(), session_hint: r.session_hint.clone(), from_env: r.from_env,
    }).collect();

    RangeStats {
        range: range_label,
        totals,
        daily,
        daily_by_model,
        models,
        recent,
        recent_total,
        recent_limit,
    }
}

const DAILY_MODEL_SERIES: usize = 6;

fn build_daily_by_model(
    daily: &[DailyRow],
    models: &[ModelRow],
    by_day_model: &HashMap<String, HashMap<String, u64>>,
) -> DailyByModel {
    if daily.is_empty() {
        return DailyByModel::default();
    }

    let top: Vec<&ModelRow> = models.iter().take(DAILY_MODEL_SERIES).collect();
    let top_keys: std::collections::HashSet<&str> =
        top.iter().map(|m| m.model.as_str()).collect();
    let has_others = models.len() > top.len();

    let start = parse_day_local(&daily[0].date);
    let end = parse_day_local(&daily[daily.len() - 1].date);
    let span_days = ((end - start).num_days() + 1).max(1);

    let dates: Vec<String> = if span_days <= 93 {
        let mut out = Vec::new();
        let mut cursor = start;
        while cursor <= end {
            out.push(format!(
                "{:04}-{:02}-{:02}",
                cursor.year(),
                cursor.month(),
                cursor.day()
            ));
            cursor += chrono::Duration::days(1);
        }
        out
    } else {
        daily.iter().map(|d| d.date.clone()).collect()
    };

    let day_lookup: HashMap<&str, &DailyRow> =
        daily.iter().map(|d| (d.date.as_str(), d)).collect();

    let totals: Vec<DailyTotalPoint> = dates
        .iter()
        .map(|date| {
            if let Some(row) = day_lookup.get(date.as_str()) {
                DailyTotalPoint {
                    date: date.clone(),
                    total_tokens: row.total_tokens,
                    cost_usd: row.cost_usd,
                    requests: row.requests,
                    cache_hit_rate: row.cache_hit_rate,
                }
            } else {
                DailyTotalPoint {
                    date: date.clone(),
                    total_tokens: 0,
                    cost_usd: 0.0,
                    requests: 0,
                    cache_hit_rate: 0.0,
                }
            }
        })
        .collect();

    let mut series: Vec<DailyModelSeries> = top
        .iter()
        .map(|m| {
            let key = m.model.clone();
            let values: Vec<u64> = dates
                .iter()
                .map(|date| {
                    by_day_model
                        .get(date)
                        .and_then(|dm| dm.get(&key).copied())
                        .unwrap_or(0)
                })
                .collect();
            DailyModelSeries {
                key: key.clone(),
                label: key.clone(),
                model_display: m.model_display.clone(),
                is_others: false,
                values,
            }
        })
        .collect();

    if has_others {
        let values: Vec<u64> = dates
            .iter()
            .map(|date| {
                let Some(dm) = by_day_model.get(date) else {
                    return 0;
                };
                dm.iter()
                    .filter(|(k, _)| !top_keys.contains(k.as_str()))
                    .map(|(_, v)| *v)
                    .sum()
            })
            .collect();
        series.push(DailyModelSeries {
            key: "__others__".into(),
            label: "others".into(),
            model_display: "others".into(),
            is_others: true,
            values,
        });
    }

    DailyByModel {
        dates,
        series,
        totals,
    }
}

fn parse_day_local(yyyy_mm_dd: &str) -> chrono::NaiveDate {
    chrono::NaiveDate::parse_from_str(yyyy_mm_dd, "%Y-%m-%d")
        .unwrap_or_else(|_| chrono::NaiveDate::from_ymd_opt(1970, 1, 1).unwrap())
}

impl TotalsRow {
    fn default() -> Self {
        TotalsRow {
            requests: 0, input_other: 0, output: 0,
            input_cache_read: 0, input_cache_creation: 0,
            cost_usd: 0.0, total_tokens: 0, cache_hit_rate: 0.0,
        }
    }
    fn add(&mut self, r: &UsageRecord) {
        self.requests += 1;
        self.input_other += r.input_other;
        self.output += r.output;
        self.input_cache_read += r.input_cache_read;
        self.input_cache_creation += r.input_cache_creation;
        self.cost_usd += r.cost_usd;
        self.total_tokens = self.input_other + self.output + self.input_cache_read + self.input_cache_creation;
    }
}

fn filter_by_range<'a>(records: &'a [UsageRecord], range: &str, now_ms: u64) -> Vec<&'a UsageRecord> {
    if range == "all" { return records.iter().collect(); }
    let start = range_start(range, now_ms);
    records.iter().filter(|r| r.time >= start).collect()
}

fn range_start(range: &str, now_ms: u64) -> u64 {
    match range {
        "today" => {
            let now = DateTime::from_timestamp((now_ms / 1000) as i64, 0).unwrap_or_default();
            let today_date = now.date_naive();
            let today_start = today_date.and_hms_opt(0, 0, 0).unwrap_or_default();
            today_start.and_utc().timestamp() as u64 * 1000
        }
        "7d" => now_ms - 7 * 24 * 3600 * 1000,
        "30d" => now_ms - 30 * 24 * 3600 * 1000,
        _ => now_ms - 30 * 24 * 3600 * 1000,
    }
}

fn build_heatmap(records: &[UsageRecord], now_ms: u64) -> HeatmapData {
    let weeks = 53;
    let end = DateTime::from_timestamp((now_ms / 1000) as i64, 0).unwrap_or_default();
    let end_date = end.date_naive();
    let start_date = end_date - chrono::Duration::days(weeks * 7 - 1);
    let start_date = start_date - chrono::Duration::days(start_date.weekday().num_days_from_sunday() as i64);

    let mut by_day: HashMap<String, TotalsRow> = HashMap::new();
    for r in records {
        let dk = day_key(r.time);
        let t = by_day.entry(dk).or_default();
        t.add(r);
    }

    let mut cursor = start_date;
    let mut cells = Vec::new();
    let mut max_tokens = 0u64;

    while cursor <= end_date {
        let key = format!("{:04}-{:02}-{:02}", cursor.year(), cursor.month(), cursor.day());
        let t = by_day.get(&key).cloned().unwrap_or_else(TotalsRow::default);
        let tok = t.total_tokens;
        if tok > max_tokens { max_tokens = tok; }
        let dow = cursor.weekday().num_days_from_sunday() as usize;
        let week_idx = ((cursor - start_date).num_days() / 7) as usize;
        let ti = t.input_other + t.input_cache_read + t.input_cache_creation;
        let ch = if ti > 0 { t.input_cache_read as f64 / ti as f64 } else { 0.0 };
        cells.push(HeatmapCell {
            date: key, dow, week_index: week_idx,
            requests: t.requests, total_tokens: tok, cost_usd: t.cost_usd,
            cache_hit_rate: ch, level: 0,
        });
        cursor += chrono::Duration::days(1);
        if cells.len() > (weeks * 7 + 7) as usize { break; }
    }
    for c in &mut cells {
        c.level = if max_tokens == 0 || c.total_tokens == 0 {
            0
        } else {
            let r = c.total_tokens as f64 / max_tokens as f64;
            if r > 0.75 { 4 } else if r > 0.5 { 3 } else if r > 0.25 { 2 } else { 1 }
        };
    }

    let mut month_labels = Vec::new();
    let mut last_month = String::new();
    for c in &cells {
        let m = c.date[..7].to_string();
        if m != last_month {
            month_labels.push(MonthLabel { week_index: c.week_index, label: c.date[5..7].to_string() });
            last_month = m;
        }
    }

    HeatmapData {
        weeks: weeks as usize,
        start: start_date.format("%Y-%m-%d").to_string(),
        end: end_date.format("%Y-%m-%d").to_string(),
        max_tokens,
        cells,
        month_labels,
    }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

fn list_workspace_dirs(home: &Path) -> Vec<String> {
    let root = sessions_root(home);
    if !root.exists() { return vec![]; }
    let mut out = Vec::new();
    let re = workspace_re();
    for entry in safe_read_dir(&root) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".kcd-archive" { continue; }
        if !re.is_match(&name) { continue; }
        out.push(name);
    }
    out.sort();
    out
}

fn read_state_safe(session_dir: &Path) -> (Option<String>, Option<String>, Option<String>, Option<String>) {
    let sp = session_dir.join("state.json");
    if !sp.exists() { return (None, None, None, None); }
    if let Ok(content) = fs::read_to_string(&sp) {
        if let Ok(obj) = serde_json::from_str::<serde_json::Value>(&content) {
            let title = obj.get("title").and_then(|v| v.as_str().map(|s| s.to_string()));
            let work_dir = obj.get("workDir").and_then(|v| v.as_str().map(|s| s.to_string()));
            let created_at = obj.get("createdAt").and_then(|v| v.as_str().map(|s| s.to_string()));
            let updated_at = obj.get("updatedAt").and_then(|v| v.as_str().map(|s| s.to_string()));
            return (title, work_dir, created_at, updated_at);
        }
    }
    (None, None, None, None)
}

fn humanize_workspace(id: &str) -> String {
    let re = Regex::new(r"^wd_(.+)_[0-9a-fA-F]{8,}$").unwrap();
    if let Some(caps) = re.captures(id) {
        caps.get(1).map(|m| m.as_str().to_string()).unwrap_or_else(|| id.to_string())
    } else {
        id.to_string()
    }
}

fn list_sessions_in_dir(dir: &Path, workspace_id: &str, status: &str) -> Vec<SessionRow> {
    let mut sessions = Vec::new();
    if !dir.exists() { return sessions; }
    let re = session_re();
    for entry in safe_read_dir(dir) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        if !re.is_match(&name) { continue; }
        let (title, work_dir, created_at, updated_at) = read_state_safe(&entry.path());
        let (bytes, files) = file_size_approx(&entry.path());
        let mtime = entry.path().metadata().ok().and_then(|m| m.modified().ok())
            .map(|t| t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)).flatten();
        sessions.push(SessionRow {
            id: name, workspace_id: workspace_id.to_string(), status: status.to_string(),
            title, work_dir, created_at,
            updated_at: updated_at.or_else(|| mtime.map(|m| {
                let secs = if m > 1e12 as u64 { m / 1000 } else { m };
                let dt = DateTime::from_timestamp(secs as i64, 0).unwrap_or_default().naive_utc();
                dt.to_string()
            })),
            bytes, files,
        });
    }
    sessions
}

fn list_sessions_cmd(home: &Path, status: &str, workspace_filter: Option<String>) -> SessionsResult {
    let root = sessions_root(home);
    let archive_root = root.join(".kcd-archive");
    let mut ws_ids: Vec<String> = list_workspace_dirs(home);
    // Also include archive-only workspaces
    if archive_root.exists() {
        for entry in safe_read_dir(&archive_root) {
            let name = entry.file_name().to_string_lossy().to_string();
            if workspace_re().is_match(&name) && !ws_ids.contains(&name) {
                ws_ids.push(name);
            }
        }
    }
    ws_ids.sort();

    // Load workspaces.json
    let wp = home.join("workspaces.json");
    let mut ws_meta: HashMap<String, serde_json::Value> = HashMap::new();
    if let Ok(content) = fs::read_to_string(&wp) {
        if let Ok(obj) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(ws) = obj.get("workspaces").and_then(|v| v.as_object()) {
                for (k, v) in ws {
                    ws_meta.insert(k.clone(), v.clone());
                }
            }
        }
    }

    let mut workspaces = Vec::new();
    let mut all_sessions = Vec::new();

    for wid in &ws_ids {
        if let Some(ref filter) = workspace_filter {
            if wid != filter { continue; }
        }
        let meta = ws_meta.get(wid);
        let name = meta.and_then(|m| m.get("name").and_then(|v| v.as_str()))
            .map(|s| s.to_string()).unwrap_or_else(|| humanize_workspace(wid));
        let root_path = meta.and_then(|m| m.get("root").and_then(|v| v.as_str()).map(|s| s.to_string()));

        let active_dir = root.join(wid);
        let arch_dir = archive_root.join(wid);
        let active_all = list_sessions_in_dir(&active_dir, wid, "active");
        let arch_all = list_sessions_in_dir(&arch_dir, wid, "archived");
        let active_list = if status == "archived" { vec![] } else { active_all.clone() };
        let arch_list = if status == "active" { vec![] } else { arch_all.clone() };

        let empty = active_all.is_empty() && arch_all.is_empty();
        // created_at / last_opened_at from workspaces.json when present
        let created_at = meta.and_then(|m| m.get("createdAt").and_then(|v| v.as_str()).map(|s| s.to_string()));
        let last_opened_at = meta.and_then(|m| m.get("lastOpenedAt").and_then(|v| v.as_str()).map(|s| s.to_string()));
        workspaces.push(WorkspaceRow {
            id: wid.clone(), name, root: root_path,
            created_at, last_opened_at,
            active_count: active_all.len(), archived_count: arch_all.len(), empty,
        });
        all_sessions.extend(active_list);
        all_sessions.extend(arch_list);
    }

    all_sessions.sort_by(|a, b| {
        let ta = a.updated_at.as_deref().or(a.created_at.as_deref()).unwrap_or("").to_string();
        let tb = b.updated_at.as_deref().or(b.created_at.as_deref()).unwrap_or("").to_string();
        tb.cmp(&ta)
    });

    SessionsResult {
        home: home.to_string_lossy().to_string(),
        archive_root: ".kcd-archive".into(),
        workspaces,
        sessions: all_sessions,
    }
}

fn assert_safe_path(home: &Path, workspace_id: &str, session_id: &str) -> Result<PathBuf, String> {
    if !workspace_re().is_match(workspace_id) {
        return Err("invalid workspace id".into());
    }
    if !session_re().is_match(session_id) {
        return Err("invalid session id".into());
    }
    let root = sessions_root(home).canonicalize().unwrap_or_else(|_| sessions_root(home));
    let candidate = root.join(workspace_id).join(session_id).canonicalize().unwrap_or_else(|_| root.join(workspace_id).join(session_id));
    if !candidate.starts_with(&root) {
        return Err("path escape blocked".into());
    }
    Ok(candidate)
}

fn archive_session_cmd(home: &Path, workspace_id: &str, session_id: &str) -> Result<ActionResponse, String> {
    let src = assert_safe_path(home, workspace_id, session_id)?;
    let dest = sessions_root(home).join(".kcd-archive").join(workspace_id).join(session_id);
    if !src.exists() { return Err("session not found".into()); }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    fs::rename(&src, &dest).or_else(|_| {
        // cross-device fallback
        fs_extra::dir::copy(&src, dest.parent().unwrap(), &Default::default()).ok();
        fs::remove_dir_all(&src).ok();
        Ok::<(), String>(())
    }).map_err(|e: String| format!("move: {}", e))?;
    scrub_session_index(home, session_id);
    Ok(ActionResponse {
        ok: true, workspace_id: workspace_id.to_string(),
        session_id: session_id.to_string(), status: Some("archived".into()),
        path: Some(dest.to_string_lossy().to_string()), deleted: None,
    })
}

fn unarchive_session_cmd(home: &Path, workspace_id: &str, session_id: &str) -> Result<ActionResponse, String> {
    let src = sessions_root(home).join(".kcd-archive").join(workspace_id).join(session_id);
    let dest = assert_safe_path(home, workspace_id, session_id)?;
    if !src.exists() { return Err("archived session not found".into()); }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    fs::rename(&src, &dest).or_else(|_| {
        fs_extra::dir::copy(&src, dest.parent().unwrap(), &Default::default()).ok();
        fs::remove_dir_all(&src).ok();
        Ok::<(), String>(())
    }).map_err(|e: String| format!("move: {}", e))?;
    Ok(ActionResponse {
        ok: true, workspace_id: workspace_id.to_string(),
        session_id: session_id.to_string(), status: Some("active".into()),
        path: Some(dest.to_string_lossy().to_string()), deleted: None,
    })
}

fn delete_session_cmd(home: &Path, workspace_id: &str, session_id: &str, status_hint: Option<&str>) -> Result<ActionResponse, String> {
    let active = assert_safe_path(home, workspace_id, session_id)?;
    let archived = sessions_root(home).join(".kcd-archive").join(workspace_id).join(session_id);
    let target = match status_hint {
        Some("archived") if archived.exists() => archived,
        Some("active") if active.exists() => active,
        _ => {
            if active.exists() { active } else if archived.exists() { archived }
            else { return Err("session not found".into()); }
        }
    };
    fs::remove_dir_all(&target).map_err(|e| format!("delete: {}", e))?;
    scrub_session_index(home, session_id);
    Ok(ActionResponse {
        ok: true, workspace_id: workspace_id.to_string(),
        session_id: session_id.to_string(), status: None,
        path: Some(target.to_string_lossy().to_string()), deleted: Some(true),
    })
}

fn scrub_session_index(home: &Path, session_id: &str) {
    let ip = home.join("session_index.jsonl");
    if !ip.exists() { return; }
    if let Ok(content) = fs::read_to_string(&ip) {
        let lines: Vec<&str> = content.lines().filter(|l| {
            let sid = format!("\"sessionId\":\"{}\"", session_id);
            let sid2 = format!("\"sessionId\": \"{}\"", session_id);
            let path_match = format!("/{}\"", session_id);
            !l.contains(&sid) && !l.contains(&sid2) && !l.contains(&path_match)
        }).collect();
        if lines.len() < content.lines().count() {
            let _ = fs::write(&ip, lines.join("\n") + "\n");
        }
    }
}

fn delete_workspace_cmd(home: &Path, workspace_id: &str, _confirm: bool, _force: bool) -> Result<ActionResponse, String> {
    if !workspace_re().is_match(workspace_id) {
        return Err("invalid workspace id".into());
    }
    let root = sessions_root(home);
    let active_dir = root.join(workspace_id);
    let arch_dir = root.join(".kcd-archive").join(workspace_id);

    if active_dir.exists() {
        let active_list = list_sessions_in_dir(&active_dir, workspace_id, "active");
        if !active_list.is_empty() { return Err("workspace is not empty; archive/delete sessions first".into()); }
    }
    if arch_dir.exists() {
        let arch_list = list_sessions_in_dir(&arch_dir, workspace_id, "archived");
        if !arch_list.is_empty() { return Err("workspace is not empty; archive/delete sessions first".into()); }
    }

    if active_dir.exists() { fs::remove_dir_all(&active_dir).ok(); }
    if arch_dir.exists() { fs::remove_dir_all(&arch_dir).ok(); }

    // Update workspaces.json
    let wp = home.join("workspaces.json");
    if let Ok(content) = fs::read_to_string(&wp) {
        if let Ok(mut obj) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(ws) = obj.get_mut("workspaces").and_then(|v| v.as_object_mut()) {
                ws.remove(workspace_id);
            }
            let deleted = obj.get_mut("deleted_workspace_ids")
                .and_then(|v| v.as_array_mut());
            if let Some(arr) = deleted {
                if !arr.iter().any(|v| v.as_str() == Some(workspace_id)) {
                    arr.push(serde_json::Value::String(workspace_id.to_string()));
                }
            }
            let _ = fs::write(&wp, serde_json::to_string_pretty(&obj).unwrap() + "\n");
        }
    }

    Ok(ActionResponse {
        ok: true, workspace_id: workspace_id.to_string(),
        session_id: String::new(), status: None, path: None, deleted: Some(true),
    })
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

fn clip_text(s: &str, max: usize) -> String {
    let t: String = s.chars().filter(|&c| c != '\0').collect();
    if t.len() <= max { t } else { format!("{}…", &t[..max]) }
}

fn extract_text_parts(content: &serde_json::Value) -> String {
    if let Some(s) = content.as_str() { return s.to_string(); }
    if let Some(arr) = content.as_array() {
        let mut parts = Vec::new();
        for p in arr {
            if let Some(obj) = p.as_object() {
                if let Some(t) = obj.get("text").and_then(|v| v.as_str()) {
                    parts.push(t.to_string());
                }
            }
        }
        return parts.join("\n");
    }
    String::new()
}

fn push_user_msg(msgs: &mut Vec<PreviewMessage>, role: &str, text: &str, time: u64) {
    let norm: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if norm.is_empty() { return; }
    if let Some(last) = msgs.last() {
        if last.role == role {
            let last_norm: String = last.text.split_whitespace().collect::<Vec<_>>().join(" ");
            if last_norm == norm { return; }
        }
    }
    let text = if looks_like_secret(text) { "[redacted: possible secret content]".into() } else { clip_text(text, 2500) };
    msgs.push(PreviewMessage { role: role.into(), time: Some(time), text });
}

fn flush_assistant_msg(msgs: &mut Vec<PreviewMessage>, bucket: &Option<(Vec<String>, u64)>) {
    if let Some((texts, _)) = bucket {
        let combined = texts.join("");
        if !combined.trim().is_empty() {
            let text = if looks_like_secret(&combined) { "[redacted: possible secret content]".into() } else { clip_text(&combined, 2500) };
            if let Some(last) = msgs.last() {
                if last.role == "assistant" {
                    let last_norm: String = last.text.split_whitespace().collect::<Vec<_>>().join(" ");
                    let this_norm: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
                    if last_norm == this_norm { return; }
                }
            }
            msgs.push(PreviewMessage { role: "assistant".into(), time: None, text });
        }
    }
}

fn get_session_preview_cmd(home: &Path, workspace_id: &str, session_id: &str, status_hint: Option<&str>) -> Result<PreviewResult, String> {
    let root = sessions_root(home);
    let active = assert_safe_path(home, workspace_id, session_id)?;
    let archived = root.join(".kcd-archive").join(workspace_id).join(session_id);
    let session_dir = match status_hint {
        Some("archived") if archived.exists() => archived,
        _ => if active.exists() { active } else if archived.exists() { archived }
            else { return Err("session not found".into()); }
    };

    let (title, work_dir, created_at, updated_at) = read_state_safe(&session_dir);
    let api_dir = session_dir.join("agents").join("main");
    let mut wire_path = api_dir.join("wire.jsonl");
    if !wire_path.exists() {
        wire_path = session_dir.join("wire.jsonl");
    }
    if !wire_path.exists() {
        // try first agent wire
        let agents_dir = session_dir.join("agents");
        if agents_dir.exists() {
            for entry in safe_read_dir(&agents_dir) {
                let w = entry.path().join("wire.jsonl");
                if w.exists() { wire_path = w; break; }
            }
        }
    }

    let mut messages: Vec<PreviewMessage> = Vec::new();
    let mut truncated = false;
    let max_msgs = 80;
    let _max_chars = 2500usize;

    if wire_path.exists() {
        let content = fs::read_to_string(&wire_path).unwrap_or_default();
        let lines: Vec<&str> = content.lines().collect();
        let mut current_assistant: Option<(Vec<String>, u64)> = None;
        let mut current_step_key: Option<String> = None;
        for line in &lines {
            if messages.len() >= max_msgs { truncated = true; break; }
            if !line.contains("\"context.append_message\"") && !line.contains("\"turn.steer\"")
                && !line.contains("\"turn.prompt\"") && !line.contains("\"content.part\"")
                && !line.contains("\"step.end\"") { continue; }
            let obj: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v, Err(_) => continue,
            };
            let typ = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");

            if typ == "context.append_message" {
                flush_assistant_msg(&mut messages, &current_assistant);
                current_assistant = None;
                current_step_key = None;
                let msg = &obj["message"];
                let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("unknown");
                if role == "tool" { continue; }
                let raw = extract_text_parts(&msg["content"]);
                if raw.trim().is_empty() { continue; }
                push_user_msg(&mut messages, role, &raw, obj.get("time").and_then(|v| v.as_u64()).unwrap_or(0));
                continue;
            }

            if typ == "turn.steer" || typ == "turn.prompt" {
                let input = &obj["input"];
                let raw = if let Some(s) = input.as_str() { s.to_string() }
                    else if let Some(arr) = input.as_array() {
                        arr.iter().filter_map(|x| x.get("text").and_then(|v| v.as_str())).collect::<Vec<_>>().join("\n")
                    } else { String::new() };
                if raw.trim().is_empty() { continue; }
                push_user_msg(&mut messages, "user", &raw, obj.get("time").and_then(|v| v.as_u64()).unwrap_or(0));
                continue;
            }

            if typ == "context.append_loop_event" {
                let ev = &obj["event"];
                let ev_type = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if ev_type == "content.part" {
                    let part = &ev["part"];
                    if part.get("type").and_then(|v| v.as_str()) == Some("text") {
                        let text = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        if !text.is_empty() {
                            let step_key = ev.get("stepUuid").and_then(|v| v.as_str())
                                .map(|s| s.to_string()).unwrap_or_else(|| format!("{}:{}", ev["turnId"], ev["step"]));
                            // flush if step changed
                            if current_step_key.as_deref() != Some(&step_key) {
                                flush_assistant_msg(&mut messages, &current_assistant);
                                current_assistant = Some((Vec::new(), obj.get("time").and_then(|v| v.as_u64()).unwrap_or(0)));
                                current_step_key = Some(step_key.clone());
                            } else if current_assistant.is_none() {
                                current_assistant = Some((Vec::new(), obj.get("time").and_then(|v| v.as_u64()).unwrap_or(0)));
                            }
                            current_assistant.as_mut().unwrap().0.push(text.to_string());
                        }
                    }
                    continue;
                }
                if ev_type == "step.end" {
                    flush_assistant_msg(&mut messages, &current_assistant);
                    current_assistant = None;
                    current_step_key = None;
                }
            }
        }
        flush_assistant_msg(&mut messages, &current_assistant);
        if lines.len() > 8000 { truncated = true; }
        if messages.len() >= max_msgs { truncated = true; }
    }

    Ok(PreviewResult {
        workspace_id: workspace_id.to_string(),
        session_id: session_id.to_string(),
        status: if session_dir.to_string_lossy().contains(".kcd-archive") { "archived".into() } else { "active".into() },
        title, work_dir, created_at, updated_at,
        message_count: messages.len(),
        truncated,
        messages,
    })
}

fn looks_like_secret(s: &str) -> bool {
    let re = regex::Regex::new(r"(?i)api[_-]?key|sk-[a-zA-Z0-9]{12,}|BEGIN (RSA |OPENSSH )?PRIVATE KEY").unwrap();
    re.is_match(s)
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_paths() -> PathsResult {
    let home = resolve_kimi_home(None);
    let valid = is_kimi_home(&home);
    let mut candidates = Vec::new();
    if let Ok(env_home) = std::env::var("KIMI_CODE_HOME") {
        let p = PathBuf::from(&env_home);
        candidates.push(PathCandidate { path: env_home, valid: is_kimi_home(&p) });
    }
    if let Some(hd) = dirs::home_dir() {
        let p = hd.join(".kimi-code");
        candidates.push(PathCandidate { path: p.to_string_lossy().to_string(), valid: is_kimi_home(&p) });
        if let Ok(up) = std::env::var("USERPROFILE") {
            let p2 = PathBuf::from(&up).join(".kimi-code");
            if !candidates.iter().any(|c| c.path == p2.to_string_lossy()) {
                candidates.push(PathCandidate { path: p2.to_string_lossy().to_string(), valid: is_kimi_home(&p2) });
            }
        }
    }
    PathsResult {
        current: home.to_string_lossy().to_string(),
        valid,
        candidates,
        env: EnvInfo {
            kimi_code_home: std::env::var("KIMI_CODE_HOME").ok(),
            kimi_model_name: std::env::var("KIMI_MODEL_NAME").ok(),
        },
    }
}

#[tauri::command]
fn get_prices() -> PricesResult {
    PricesResult { prices: list_prices() }
}

#[tauri::command]
fn get_summary(home_override: Option<String>, range: Option<String>, refresh: Option<bool>) -> SummaryResult {
    let _refresh = refresh.unwrap_or(false);
    let home = resolve_kimi_home(home_override);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
    let r = range.unwrap_or_else(|| "30d".into());

    let (records, meta) = scan_usage(&home);
    let stats = aggregate(&records, &r, now_ms);
    let all_stats = aggregate(&records, "all", now_ms);
    let heatmap = build_heatmap(&records, now_ms);

    let all_models: Vec<AllModelRow> = all_stats.models.into_iter().map(|m| {
        AllModelRow {
            model: m.model, model_display: m.model_display, requests: m.requests,
            total_tokens: m.total_tokens, cost_usd: m.cost_usd, cost_estimated: m.cost_estimated,
            cache_hit_rate: m.cache_hit_rate,
        }
    }).collect();

    let all_model_count = all_models.len();
    let mut range_totals = HashMap::new();
    for r_k in ["today", "7d", "30d", "all"] {
        let s = aggregate(&records, r_k, now_ms);
        range_totals.insert(r_k.to_string(), s.totals);
    }

    let (model_map_info, _aliases) = load_model_map(&home);
    let default_model = model_map_info.default_model.clone();
    let env_model = std::env::var("KIMI_MODEL_NAME").ok().map(|name| EnvModelInfo {
        name, provider: std::env::var("KIMI_MODEL_PROVIDER").ok(), model: std::env::var("KIMI_MODEL_ID").ok(),
    });
    let alias_count = model_map_info.alias_count;

    SummaryResult {
        home: home.to_string_lossy().to_string(),
        valid: is_kimi_home(&home),
        scanned_at: now_ms,
        meta,
        model_map: ModelMapInfo { default_model, env_model, alias_count },
        range: r,
        stats,
        heatmap,
        all_models,
        all_model_count,
        range_totals,
    }
}

/// Restricted config.toml model-map reader — identity fields only.
/// Secret-looking lines (api_key/token/secret/password/...) are stripped
/// before parsing; no credentials are ever exposed.
fn load_model_map(home: &Path) -> (ModelMapInfo, Vec<(String, String)>) {
    let mut info = ModelMapInfo { default_model: None, env_model: None, alias_count: 0 };
    let mut aliases = Vec::new();

    let cfg = home.join("config.toml");
    if !cfg.exists() {
        return (info, aliases);
    }
    let Ok(content) = fs::read_to_string(&cfg) else {
        return (info, aliases);
    };

    // Strip secret-like lines before parsing (defense in depth).
    let safe: Vec<&str> = content
        .lines()
        .filter(|l| {
            let t = l.trim();
            !t.is_empty()
                && !Regex::new(r"^(api[_-]?key|token|secret|password|authorization)\s*=")
                    .unwrap()
                    .is_match(t)
                && !Regex::new(r"^[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)\s*=")
                    .unwrap()
                    .is_match(t)
        })
        .collect();
    let safe_text = safe.join("\n");

    // default_model = "..."
    if let Some(caps) = Regex::new(r#"(?m)^\s*default_model\s*=\s*"([^"]+)""#)
        .unwrap()
        .captures(&safe_text)
    {
        info.default_model = Some(caps.get(1).unwrap().as_str().to_string());
    }

    // [models."provider/name"] sections — count only.
    let section_re = Regex::new(r#"(?m)^\s*\[models\."([^"]+)"\]"#).unwrap();
    for caps in section_re.captures_iter(&safe_text) {
        let alias = caps.get(1).unwrap().as_str().to_string();
        let mut provider = None;
        let mut model = None;
        // read following lines until next section header
        let after = &safe_text[caps.get(0).unwrap().end()..];
        let block_end = after.find("\n[").unwrap_or(after.len());
        let block = &after[..block_end];
        if let Some(m) = Regex::new(r#"(?m)^\s*provider\s*=\s*"([^"]*)""#).unwrap().captures(block) {
            provider = Some(m.get(1).unwrap().as_str().to_string());
        }
        if let Some(m) = Regex::new(r#"(?m)^\s*model\s*=\s*"([^"]*)""#).unwrap().captures(block) {
            model = Some(m.get(1).unwrap().as_str().to_string());
        }
        aliases.push((alias, format!("{:?}/{:?}", provider, model)));
    }
    info.alias_count = aliases.len();

    (info, aliases)
}

#[tauri::command]
fn list_sessions(home_override: Option<String>, status: Option<String>, workspace: Option<String>) -> SessionsResult {
    let home = resolve_kimi_home(home_override);
    list_sessions_cmd(&home, &status.unwrap_or_else(|| "active".into()), workspace)
}

#[tauri::command]
fn archive_session(home_override: Option<String>, workspace_id: String, session_id: String) -> Result<ActionResponse, String> {
    let home = resolve_kimi_home(home_override);
    archive_session_cmd(&home, &workspace_id, &session_id)
}

#[tauri::command]
fn unarchive_session(home_override: Option<String>, workspace_id: String, session_id: String) -> Result<ActionResponse, String> {
    let home = resolve_kimi_home(home_override);
    unarchive_session_cmd(&home, &workspace_id, &session_id)
}

#[tauri::command]
fn delete_session(home_override: Option<String>, workspace_id: String, session_id: String, status: Option<String>) -> Result<ActionResponse, String> {
    let home = resolve_kimi_home(home_override);
    delete_session_cmd(&home, &workspace_id, &session_id, status.as_deref())
}

#[tauri::command]
fn delete_workspace(home_override: Option<String>, workspace_id: String, confirm: bool, force: Option<bool>) -> Result<ActionResponse, String> {
    if !confirm { return Err("confirm_required: Pass confirm:true to delete an empty workspace".into()); }
    let home = resolve_kimi_home(home_override);
    delete_workspace_cmd(&home, &workspace_id, confirm, force.unwrap_or(false))
}

#[tauri::command]
fn get_session_preview(home_override: Option<String>, workspace_id: String, session_id: String, status: Option<String>) -> Result<PreviewResult, String> {
    let home = resolve_kimi_home(home_override);
    get_session_preview_cmd(&home, &workspace_id, &session_id, status.as_deref())
}

// ---------------------------------------------------------------------------
// Model configuration (config.toml) + provider catalog
// Mirrors src/config-store.js / src/catalog.js so the Tauri shell behaves like
// the HTTP server. Disk format is snake_case; views are camelCase with secrets
// masked (api_key -> has_api_key, env values dropped).
// ---------------------------------------------------------------------------

fn config_file(home: &Path) -> PathBuf {
    home.join("config.toml")
}

fn read_config(home: &Path) -> Result<toml::Table, String> {
    let p = config_file(home);
    if !p.exists() {
        return Ok(toml::Table::new());
    }
    let text = fs::read_to_string(&p)
        .map_err(|e| format!("read_failed: Cannot read {}: {}", p.display(), e))?;
    if text.trim().is_empty() {
        return Ok(toml::Table::new());
    }
    text.parse::<toml::Table>()
        .map_err(|e| format!("invalid_toml: config.toml is not valid TOML: {}", e))
}

fn write_config(home: &Path, doc: &toml::Table) -> Result<(), String> {
    let p = config_file(home);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("write_failed: Cannot create {}: {}", parent.display(), e))?;
    }
    if p.exists() {
        // Best-effort backup, never blocks a save.
        let _ = fs::copy(&p, format!("{}.kcd-bak", p.display()));
    }
    let body = toml::to_string(doc).map_err(|e| format!("write_failed: {}", e))?;
    let out = if body.is_empty() { String::new() } else { format!("{}\n", body) };
    let file_name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
    let tmp = p.with_file_name(format!(".{}.tmp-{}", file_name, std::process::id()));
    let res = fs::write(&tmp, out).and_then(|_| fs::rename(&tmp, &p));
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "write_failed: Cannot write {}: {}",
            p.display(),
            res.unwrap_err()
        ));
    }
    Ok(())
}

fn toml_to_json(v: &toml::Value) -> serde_json::Value {
    serde_json::to_value(v).unwrap_or(serde_json::Value::Null)
}

const PROVIDER_TYPES_RUST: [&str; 6] =
    ["kimi", "anthropic", "openai", "openai_responses", "google-genai", "vertexai"];

fn normalize_id(raw: &str, label: &str) -> Result<String, String> {
    let id = raw.trim().to_string();
    if id.is_empty() {
        return Err(format!("invalid_id: {} must not be empty", label));
    }
    let re = Regex::new(r"^[A-Za-z0-9_-]+$").unwrap();
    if !re.is_match(&id) {
        return Err(format!(
            "invalid_id: {} may only contain letters, digits, '-' and '_'",
            label
        ));
    }
    Ok(id)
}

fn normalize_alias(raw: &str) -> Result<String, String> {
    let alias = raw.trim().to_string();
    if alias.is_empty() {
        return Err("invalid_alias: Model alias must not be empty".into());
    }
    if alias.starts_with("__") {
        return Err(format!(
            "invalid_alias: Alias may not start with \"__\" (reserved by the runtime)"
        ));
    }
    Ok(alias)
}

fn normalize_type(raw: &str) -> Result<String, String> {
    let t = raw.trim().to_string();
    if !PROVIDER_TYPES_RUST.contains(&t.as_str()) {
        return Err(format!(
            "invalid_type: Provider type must be one of: {}",
            PROVIDER_TYPES_RUST.join(", ")
        ));
    }
    Ok(t)
}

fn validate_base_url(raw: &str) -> Result<(), String> {
    let url = raw.trim();
    if !url.is_empty() && !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("invalid_url: base_url must start with http(s)://".into());
    }
    Ok(())
}

fn positive_int_i64(v: Option<i64>, label: &str, required: bool) -> Result<Option<i64>, String> {
    match v {
        None => {
            if required {
                Err(format!("invalid_value: {} is required", label))
            } else {
                Ok(None)
            }
        }
        Some(n) => {
            if n <= 0 {
                Err(format!("invalid_value: {} must be a positive integer", label))
            } else {
                Ok(Some(n))
            }
        }
    }
}

fn set_opt_string(entry: &mut toml::Table, key: &str, value: Option<&str>) {
    match value {
        None => {}
        Some("") => {
            entry.remove(key);
        }
        Some(s) => {
            entry.insert(key.into(), toml::Value::String(s.to_string()));
        }
    }
}

fn ensure_providers_section(doc: &mut toml::Table) -> &mut toml::Table {
    if !doc.contains_key("providers") {
        doc.insert("providers".into(), toml::Value::Table(toml::Table::new()));
    }
    doc.get_mut("providers")
        .and_then(|v| v.as_table_mut())
        .expect("providers is a table")
}

fn config_view(home: &Path) -> Result<serde_json::Value, String> {
    let doc = read_config(home)?;

    let mut providers: Vec<serde_json::Value> = Vec::new();
    let mut provider_models: HashMap<String, Vec<String>> = HashMap::new();
    if let Some(raw) = doc.get("providers").and_then(|v| v.as_table()) {
        for (id, p) in raw {
            if !p.is_table() {
                continue;
            }
            let t = p.as_table().expect("checked above");
            let mut obj = toml_to_json(p).as_object().cloned().unwrap_or_default();
            obj.insert("id".into(), serde_json::Value::String(id.clone()));
            obj.remove("api_key");
            obj.remove("env");
            let has_key = t
                .get("api_key")
                .and_then(|v| v.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            obj.insert("has_api_key".into(), serde_json::Value::Bool(has_key));
            let env_keys: Vec<serde_json::Value> = t
                .get("env")
                .and_then(|v| v.as_table())
                .map(|env| {
                    env.keys()
                        .map(|k| serde_json::Value::String(k.clone()))
                        .collect()
                })
                .unwrap_or_default();
            obj.insert("env_keys".into(), serde_json::Value::Array(env_keys));
            obj.insert("models".into(), serde_json::Value::Array(vec![]));
            providers.push(serde_json::Value::Object(obj));
            provider_models.insert(id.clone(), Vec::new());
        }
    }

    let mut models: Vec<serde_json::Value> = Vec::new();
    if let Some(raw) = doc.get("models").and_then(|v| v.as_table()) {
        for (alias, m) in raw {
            if alias.starts_with("__") {
                continue;
            }
            if !m.is_table() {
                continue;
            }
            let t = m.as_table().expect("checked above");
            let mut obj = toml_to_json(m).as_object().cloned().unwrap_or_default();
            obj.insert("alias".into(), serde_json::Value::String(alias.clone()));
            obj.remove("api_key");
            let has_key = t
                .get("api_key")
                .and_then(|v| v.as_str())
                .map(|s| !s.is_empty())
                .unwrap_or(false);
            obj.insert("has_api_key".into(), serde_json::Value::Bool(has_key));
            let pid = t
                .get("provider_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| t.get("provider").and_then(|v| v.as_str()).map(|s| s.to_string()));
            if let Some(pid) = pid {
                if let Some(list) = provider_models.get_mut(&pid) {
                    list.push(alias.clone());
                }
            }
            models.push(serde_json::Value::Object(obj));
        }
    }
    providers.sort_by(|a, b| {
        a["id"].as_str().unwrap_or("").cmp(b["id"].as_str().unwrap_or(""))
    });
    models.sort_by(|a, b| {
        a["alias"]
            .as_str()
            .unwrap_or("")
            .cmp(b["alias"].as_str().unwrap_or(""))
    });
    for p in providers.iter_mut() {
        let id = p["id"].as_str().unwrap_or("").to_string();
        let list: Vec<serde_json::Value> = provider_models
            .get(&id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(serde_json::Value::String)
            .collect();
        p.as_object_mut()
            .expect("provider object")
            .insert("models".into(), serde_json::Value::Array(list));
    }

    let default_model = doc
        .get("default_model")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let default_provider = doc
        .get("default_provider")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let secondary_model = doc
        .get("secondary_model")
        .and_then(|v| v.as_table())
        .map(|t| toml_to_json(&toml::Value::Table(t.clone())));

    let mut out = serde_json::Map::new();
    out.insert(
        "defaultModel".into(),
        default_model
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
    );
    out.insert(
        "defaultProvider".into(),
        default_provider
            .map(serde_json::Value::String)
            .unwrap_or(serde_json::Value::Null),
    );
    out.insert("providers".into(), serde_json::Value::Array(providers));
    out.insert("models".into(), serde_json::Value::Array(models));
    out.insert(
        "secondaryModel".into(),
        secondary_model.unwrap_or(serde_json::Value::Null),
    );
    Ok(serde_json::Value::Object(out))
}

fn clear_pointers(doc: &mut toml::Table, removed_aliases: &[String], removed_provider: Option<&str>) {
    let alias_hit = |a: &str| removed_aliases.iter().any(|x| x == a);
    if let Some(v) = doc.get("default_model").and_then(|v| v.as_str()) {
        if alias_hit(v) {
            doc.remove("default_model");
        }
    }
    if let Some(p) = removed_provider {
        if let Some(v) = doc.get("default_provider").and_then(|v| v.as_str()) {
            if v == p {
                doc.remove("default_provider");
            }
        }
    }
    if let Some(sec) = doc.get_mut("secondary_model").and_then(|v| v.as_table_mut()) {
        if let Some(m) = sec.get("model").and_then(|v| v.as_str()) {
            if alias_hit(m) {
                doc.remove("secondary_model");
            }
        }
    }
    if let Some(providers) = doc.get("providers").and_then(|v| v.as_table()) {
        if providers.is_empty() {
            doc.remove("providers");
        }
    }
}

fn save_provider_impl(
    home: &Path,
    id: &str,
    type_: Option<&str>,
    api_key: Option<&str>,
    base_url: Option<&str>,
    default_model: Option<&str>,
) -> Result<serde_json::Value, String> {
    let id = normalize_id(id, "Provider id")?;
    let mut doc = read_config(home)?;
    if let Some(u) = base_url {
        validate_base_url(u)?;
    }
    let existing_type = doc
        .get("providers")
        .and_then(|v| v.as_table())
        .and_then(|t| t.get(&id))
        .and_then(|v| v.as_table())
        .and_then(|t| t.get("type"))
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);
    let typ = match type_ {
        Some(t) => Some(normalize_type(t)?),
        None => None,
    };
    if typ.is_none() && !existing_type {
        return Err("invalid_type: Provider type is required".into());
    }
    {
        let providers = ensure_providers_section(&mut doc);
        if !providers.contains_key(&id) {
            providers.insert(id.clone(), toml::Value::Table(toml::Table::new()));
        }
        let entry = providers
            .get_mut(&id)
            .and_then(|v| v.as_table_mut())
            .expect("provider entry is a table");
        if let Some(t) = typ {
            entry.insert("type".into(), toml::Value::String(t));
        }
        set_opt_string(entry, "api_key", api_key);
        set_opt_string(entry, "base_url", base_url);
        set_opt_string(entry, "default_model", default_model);
    }
    write_config(home, &doc)?;
    config_view(home)
}

fn delete_provider_impl(home: &Path, provider_id: &str) -> Result<serde_json::Value, String> {
    let id = normalize_id(provider_id, "Provider id")?;
    let mut doc = read_config(home)?;
    let exists = doc
        .get("providers")
        .and_then(|v| v.as_table())
        .map(|t| t.contains_key(&id))
        .unwrap_or(false);
    if !exists {
        return Err(format!("not_found: Provider \"{}\" does not exist", id));
    }
    let mut removed_aliases: Vec<String> = Vec::new();
    if let Some(providers) = doc.get_mut("providers").and_then(|v| v.as_table_mut()) {
        providers.remove(&id);
    }
    if let Some(models) = doc.get_mut("models").and_then(|v| v.as_table_mut()) {
        let to_remove: Vec<String> = models
            .iter()
            .filter(|(_, m)| {
                let t = m.as_table();
                let pid = t.and_then(|x| x.get("provider_id")).and_then(|v| v.as_str());
                if pid == Some(id.as_str()) {
                    return true;
                }
                t.and_then(|x| x.get("provider")).and_then(|v| v.as_str()) == Some(id.as_str())
            })
            .map(|(k, _)| k.clone())
            .collect();
        for k in &to_remove {
            models.remove(k);
            removed_aliases.push(k.clone());
        }
        if models.is_empty() {
            doc.remove("models");
        }
    }
    clear_pointers(&mut doc, &removed_aliases, Some(&id));
    write_config(home, &doc)?;
    config_view(home)
}

#[allow(clippy::too_many_arguments)]
fn save_model_impl(
    home: &Path,
    provider_id: Option<&str>,
    alias: &str,
    model: Option<&str>,
    display_name: Option<&str>,
    max_context_size: Option<i64>,
    max_input_size: Option<i64>,
    max_output_size: Option<i64>,
    capabilities: Option<&[String]>,
    support_efforts: Option<&[String]>,
    default_effort: Option<&str>,
    off_effort: Option<&str>,
    reasoning_key: Option<&str>,
    adaptive_thinking: Option<bool>,
) -> Result<serde_json::Value, String> {
    let alias = normalize_alias(alias)?;
    let mut doc = read_config(home)?;
    if !doc.contains_key("models") {
        doc.insert("models".into(), toml::Value::Table(toml::Table::new()));
    }
    let entry = {
        let models = doc.get_mut("models").and_then(|v| v.as_table_mut()).expect("models table");
        models
            .get_mut(&alias)
            .and_then(|v| v.as_table_mut())
            .map(|t| t.clone())
            .unwrap_or_else(toml::Table::new)
    };
    let mut entry = entry;

    if let Some(pid) = provider_id {
        let pid = normalize_id(pid, "Provider id")?;
        let has = doc
            .get("providers")
            .and_then(|v| v.as_table())
            .map(|t| t.contains_key(&pid))
            .unwrap_or(false);
        if !has {
            return Err(format!("not_found: Provider \"{}\" does not exist", pid));
        }
        entry.insert("provider".into(), toml::Value::String(pid));
        entry.remove("provider_id");
        entry.remove("base_url");
        entry.remove("api_key");
        entry.remove("protocol");
    }

    set_opt_string(&mut entry, "model", model);
    set_opt_string(&mut entry, "display_name", display_name);
    set_opt_string(&mut entry, "reasoning_key", reasoning_key);
    set_opt_string(&mut entry, "default_effort", default_effort);
    set_opt_string(&mut entry, "off_effort", off_effort);
    if let Some(n) = positive_int_i64(max_context_size, "max_context_size", false)? {
        entry.insert("max_context_size".into(), toml::Value::Integer(n));
    }
    if let Some(n) = positive_int_i64(max_input_size, "max_input_size", false)? {
        entry.insert("max_input_size".into(), toml::Value::Integer(n));
    }
    if let Some(n) = positive_int_i64(max_output_size, "max_output_size", false)? {
        entry.insert("max_output_size".into(), toml::Value::Integer(n));
    }
    if let Some(caps) = capabilities {
        entry.insert(
            "capabilities".into(),
            toml::Value::Array(
                caps.iter()
                    .map(|c| toml::Value::String(c.clone()))
                    .collect(),
            ),
        );
    }
    if let Some(efforts) = support_efforts {
        entry.insert(
            "support_efforts".into(),
            toml::Value::Array(
                efforts
                    .iter()
                    .map(|e| toml::Value::String(e.clone()))
                    .collect(),
            ),
        );
    }
    if let Some(ad) = adaptive_thinking {
        entry.insert("adaptive_thinking".into(), toml::Value::Boolean(ad));
    }

    let has_wire = entry
        .get("model")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
        || entry
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| !s.is_empty())
            .unwrap_or(false);
    let has_pointer = entry.get("provider").is_some()
        || entry.get("provider_id").is_some()
        || entry.get("base_url").is_some();
    if !has_wire {
        return Err(format!(
            "invalid_model: Model \"{}\" needs a wire model id (model/name)",
            alias
        ));
    }
    if !has_pointer {
        return Err(format!(
            "invalid_model: Model \"{}\" needs provider or provider_id or base_url",
            alias
        ));
    }
    if entry.get("max_context_size").is_none() {
        return Err(format!(
            "invalid_value: Model \"{}\" must define a positive max_context_size",
            alias
        ));
    }

    let models = doc.get_mut("models").and_then(|v| v.as_table_mut()).expect("models table");
    models.insert(alias.clone(), toml::Value::Table(entry));
    write_config(home, &doc)?;
    config_view(home)
}

fn delete_model_impl(home: &Path, alias: &str) -> Result<serde_json::Value, String> {
    let alias = normalize_alias(alias)?;
    let mut doc = read_config(home)?;
    let exists = doc
        .get("models")
        .and_then(|v| v.as_table())
        .map(|t| t.contains_key(&alias))
        .unwrap_or(false);
    if !exists {
        return Err(format!("not_found: Model \"{}\" does not exist", alias));
    }
    if let Some(models) = doc.get_mut("models").and_then(|v| v.as_table_mut()) {
        models.remove(&alias);
        if models.is_empty() {
            doc.remove("models");
        }
    }
    clear_pointers(&mut doc, &[alias.clone()], None);
    write_config(home, &doc)?;
    config_view(home)
}

fn set_default_model_impl(home: &Path, alias: &str) -> Result<serde_json::Value, String> {
    let alias = alias.trim().to_string();
    let mut doc = read_config(home)?;
    if alias.is_empty() {
        doc.remove("default_model");
    } else {
        let has = doc
            .get("models")
            .and_then(|v| v.as_table())
            .map(|t| t.contains_key(&alias))
            .unwrap_or(false);
        if !has {
            return Err(format!("not_found: Model \"{}\" is not configured", alias));
        }
        doc.insert("default_model".into(), toml::Value::String(alias));
    }
    write_config(home, &doc)?;
    config_view(home)
}

#[allow(clippy::too_many_arguments)]
fn set_secondary_model_impl(
    home: &Path,
    model: &str,
    default_effort: Option<&str>,
    off_effort: Option<&str>,
    max_output_size: Option<i64>,
    support_efforts: Option<&[String]>,
    max_context_size: Option<i64>,
    max_input_size: Option<i64>,
) -> Result<serde_json::Value, String> {
    let model = model.trim().to_string();
    let mut doc = read_config(home)?;
    if model.is_empty() {
        doc.remove("secondary_model");
        write_config(home, &doc)?;
        return config_view(home);
    }
    let has = doc
        .get("models")
        .and_then(|v| v.as_table())
        .map(|t| t.contains_key(&model))
        .unwrap_or(false);
    if !has {
        return Err(format!("not_found: Model \"{}\" is not configured", model));
    }
    let mut section = toml::Table::new();
    section.insert("model".into(), toml::Value::String(model));
    set_opt_string(&mut section, "default_effort", default_effort);
    set_opt_string(&mut section, "off_effort", off_effort);
    if let Some(n) = positive_int_i64(max_output_size, "max_output_size", false)? {
        section.insert("max_output_size".into(), toml::Value::Integer(n));
    }
    if let Some(n) = positive_int_i64(max_context_size, "max_context_size", false)? {
        section.insert("max_context_size".into(), toml::Value::Integer(n));
    }
    if let Some(n) = positive_int_i64(max_input_size, "max_input_size", false)? {
        section.insert("max_input_size".into(), toml::Value::Integer(n));
    }
    if let Some(efforts) = support_efforts {
        section.insert(
            "support_efforts".into(),
            toml::Value::Array(
                efforts
                    .iter()
                    .map(|e| toml::Value::String(e.clone()))
                    .collect(),
            ),
        );
    }
    doc.insert("secondary_model".into(), toml::Value::Table(section));
    write_config(home, &doc)?;
    config_view(home)
}

// ---------------------------------------------------------------------------
// Provider catalog (models.dev with builtin snapshot fallback)
// ---------------------------------------------------------------------------

const CATALOG_URL: &str =
    "https://gh-proxy.org/https://github.com/JochenYang/models.dev/blob/main/api.json";
const BUILTIN_CATALOG: &str = include_str!("../../../src/data/builtin-catalog.json");
const CATALOG_TTL_MS: u64 = 60_000;

struct CatalogCache {
    at: u64,
    data: serde_json::Value,
}

static CATALOG_CACHE: Mutex<Option<CatalogCache>> = Mutex::new(None);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn load_builtin_catalog() -> Result<serde_json::Value, String> {
    serde_json::from_str::<serde_json::Value>(BUILTIN_CATALOG)
        .map_err(|e| format!("catalog_missing: Builtin catalog invalid: {}", e))
}

/// Bundled snapshot as catalog data (`{ _source, _fetched_at, providers }`).
/// Accepts both the strip format shipped alongside the full models.dev mirror
/// (`{ fetchedAt: null, providers: [...] }`) and a legacy raw document.
fn builtin_catalog_data() -> Result<serde_json::Value, String> {
    let raw = load_builtin_catalog()?;
    if let Some(obj) = raw.as_object() {
        if let Some(providers) = obj.get("providers").and_then(|v| v.as_array()) {
            let mut out = serde_json::Map::new();
            out.insert("_source".into(), serde_json::Value::String("builtin".into()));
            out.insert("_fetched_at".into(), serde_json::Value::Null);
            out.insert("providers".into(), serde_json::Value::Array(providers.clone()));
            return Ok(serde_json::Value::Object(out));
        }
    }
    let mut data = strip_catalog(&raw);
    let obj = data.as_object_mut().expect("catalog object");
    obj.insert("_source".into(), serde_json::Value::String("builtin".into()));
    obj.insert("_fetched_at".into(), serde_json::Value::Null);
    Ok(data)
}

/// Persisted snapshot of the last successful remote fetch, stored in the
/// user home so offline restarts reuse the full catalog instead of the
/// small bundled snapshot.
fn default_catalog_cache_path() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| PathBuf::from(home).join(".kimicode-dashboard").join("catalog-cache.json"))
}

/// `{ fetched_at: u64, providers: [...] }` from disk; None when missing,
/// corrupt, or wrong shape. Cache failures must never break the catalog path.
/// Accepts the Node-written `fetchedAt` spelling for cross-shell cache sharing.
fn read_catalog_cache(path: &Path) -> Option<(u64, serde_json::Value)> {
    let text = fs::read_to_string(path).ok()?;
    let data: serde_json::Value = serde_json::from_str(&text).ok()?;
    let obj = data.as_object()?;
    let fetched_at = obj
        .get("fetched_at")
        .or_else(|| obj.get("fetchedAt"))
        .and_then(|v| v.as_u64())?;
    let providers = obj.get("providers")?.clone();
    if !providers.is_array() {
        return None;
    }
    Some((fetched_at, providers))
}

fn write_catalog_cache(path: &Path, providers: &serde_json::Value, fetched_at: u64) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let payload = serde_json::json!({ "fetched_at": fetched_at, "providers": providers });
    let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string());
    let _ = fs::write(path, text);
}

/// Fallback chain after a failed network fetch: persisted snapshot first,
/// bundled snapshot last. Returns (source, fetched_at, catalog data).
fn catalog_fallback(cache_path: Option<&Path>) -> Result<(String, Option<u64>, serde_json::Value), String> {
    if let Some((fetched_at, providers)) = cache_path.and_then(read_catalog_cache) {
        let mut data = serde_json::Map::new();
        data.insert("_source".into(), serde_json::Value::String("cached".into()));
        data.insert("_fetched_at".into(), serde_json::Value::from(fetched_at));
        data.insert("providers".into(), providers);
        return Ok((
            "cached".to_string(),
            Some(fetched_at),
            serde_json::Value::Object(data),
        ));
    }
    let builtin = builtin_catalog_data()?;
    Ok(("builtin".to_string(), None, builtin))
}

fn fetch_remote_catalog() -> Result<serde_json::Value, String> {
    let config = ureq::config::Config::builder()
        .timeout_global(Some(std::time::Duration::from_secs(15)))
        .build();
    let agent = ureq::Agent::new_with_config(config);
    let mut resp = agent
        .get(CATALOG_URL)
        .call()
        .map_err(|e| format!("catalog http: {}", e))?;
    resp.body_mut()
        .read_json::<serde_json::Value>()
        .map_err(|e| format!("catalog parse: {}", e))
}

fn strip_catalog(raw: &serde_json::Value) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    let mut providers: Vec<serde_json::Value> = Vec::new();
    if let Some(obj) = raw.as_object() {
        for (id, p) in obj {
            if !p.is_object() {
                continue;
            }
            let po = p.as_object().expect("checked above");
            let mut entry = serde_json::Map::new();
            for k in ["id", "name", "api", "env", "npm", "type"] {
                if let Some(v) = po.get(k) {
                    entry.insert(k.into(), v.clone());
                }
            }
            if !entry.contains_key("id") {
                entry.insert("id".into(), serde_json::Value::String(id.clone()));
            }
            if let Some(models) = po.get("models").and_then(|v| v.as_object()) {
                let mut m = serde_json::Map::new();
                for (mid, mm) in models {
                    if !mm.is_object() {
                        continue;
                    }
                    let mmo = mm.as_object().expect("checked above");
                    let mut me = serde_json::Map::new();
                    for k in [
                        "id",
                        "name",
                        "family",
                        "limit",
                        "tool_call",
                        "reasoning",
                        "reasoning_options",
                        "interleaved",
                        "modalities",
                        "dynamically_loaded_tools",
                        "status",
                    ] {
                        if let Some(v) = mmo.get(k) {
                            me.insert(k.into(), v.clone());
                        }
                    }
                    if !me.contains_key("id") {
                        me.insert("id".into(), serde_json::Value::String(mid.clone()));
                    }
                    m.insert(mid.clone(), serde_json::Value::Object(me));
                }
                entry.insert("models".into(), serde_json::Value::Object(m));
            }
            providers.push(serde_json::Value::Object(entry));
        }
    }
    out.insert("providers".into(), serde_json::Value::Array(providers));
    serde_json::Value::Object(out)
}

fn load_catalog_data(force: bool, cache_path: Option<&Path>) -> Result<(String, Option<u64>, serde_json::Value), String> {
    let now = now_ms();
    {
        let cache = CATALOG_CACHE.lock().expect("catalog cache lock");
        if let Some(c) = cache.as_ref() {
            if !force && now.saturating_sub(c.at) < CATALOG_TTL_MS {
                let source = c
                    .data
                    .get("_source")
                    .and_then(|v| v.as_str())
                    .unwrap_or("builtin")
                    .to_string();
                let fetched = c.data.get("_fetched_at").and_then(|v| v.as_u64());
                return Ok((source, fetched, c.data.clone()));
            }
        }
    }
    let (source, fetched, raw) = match fetch_remote_catalog() {
        Ok(raw) => ("remote".to_string(), Some(now), raw),
        Err(_) => return catalog_fallback(cache_path),
    };
    let mut data = strip_catalog(&raw);
    if let Some(cache_file) = cache_path {
        // Persist the stripped snapshot for offline reuse.
        let providers = data
            .get("providers")
            .cloned()
            .unwrap_or(serde_json::Value::Array(Vec::new()));
        write_catalog_cache(cache_file, &providers, now);
    }
    let obj = data.as_object_mut().expect("catalog object");
    obj.insert(
        "_source".into(),
        serde_json::Value::String(source.clone()),
    );
    obj.insert(
        "_fetched_at".into(),
        fetched
            .map(|t| serde_json::Value::from(t))
            .unwrap_or(serde_json::Value::Null),
    );
    *CATALOG_CACHE.lock().expect("catalog cache lock") =
        Some(CatalogCache { at: now, data: data.clone() });
    Ok((source, fetched, data))
}

fn is_chat_model(m: &serde_json::Value) -> bool {
    let obj = m.as_object();
    let output = obj
        .and_then(|o| o.get("modalities"))
        .and_then(|v| v.as_object())
        .and_then(|o| o.get("output"))
        .and_then(|v| v.as_array());
    if let Some(out) = output {
        if !out.is_empty() && !out.iter().any(|v| v.as_str() == Some("text")) {
            return false;
        }
    }
    let id = obj
        .and_then(|o| o.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    let embed_re = Regex::new(r"(?:^|[-_/])embed(?:$|[-_/])").unwrap();
    if id.contains("embedding") || embed_re.is_match(&id) {
        return false;
    }
    let status = obj
        .and_then(|o| o.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    if status == "deprecated" || status == "alpha" {
        return false;
    }
    true
}

fn catalog_thinking_options(
    reasoning_options: Option<&serde_json::Value>,
) -> (Option<Vec<String>>, Option<String>, bool, Option<bool>) {
    // (efforts, off_effort, has_toggle, always_thinking)
    let arr = match reasoning_options.and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return (None, None, false, None),
    };
    let mut efforts: Option<Vec<String>> = None;
    let mut off_effort: Option<String> = None;
    let mut has_toggle = false;
    for opt in arr {
        let Some(o) = opt.as_object() else { continue };
        match o.get("type").and_then(|v| v.as_str()) {
            Some("toggle") => {
                has_toggle = true;
            }
            Some("effort") => {
                let Some(values) = o.get("values").and_then(|v| v.as_array()) else {
                    continue;
                };
                let has_null_tier = values.iter().any(|v| v.is_null());
                let levels: Vec<String> = values
                    .iter()
                    .filter_map(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect();
                if let Some(off) = levels.iter().find(|v| v.to_lowercase() == "none") {
                    off_effort = Some(off.clone());
                } else if has_null_tier {
                    off_effort = Some("none".into());
                }
                let selectable: Vec<String> =
                    levels.into_iter().filter(|v| v.to_lowercase() != "none").collect();
                if !selectable.is_empty() {
                    efforts = Some(selectable);
                }
            }
            _ => {}
        }
    }
    let always_thinking =
        if efforts.is_some() && off_effort.is_none() && !has_toggle { Some(true) } else { None };
    (efforts, off_effort, has_toggle, always_thinking)
}

fn catalog_reasoning_key(interleaved: Option<&serde_json::Value>) -> Option<String> {
    let field = interleaved
        .and_then(|v| v.as_object())
        .and_then(|o| o.get("field"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string());
    field.filter(|s| !s.is_empty())
}

fn normalize_catalog_model(m: &serde_json::Value) -> Option<serde_json::Value> {
    let obj = m.as_object()?;
    let id = obj.get("id")?.as_str()?;
    if id.is_empty() {
        return None;
    }
    let context = obj.get("limit")?.as_object()?.get("context")?.as_i64()?;
    if context <= 0 {
        return None;
    }
    if !is_chat_model(m) {
        return None;
    }
    let inputs = obj
        .get("modalities")
        .and_then(|v| v.as_object())
        .and_then(|o| o.get("input"))
        .and_then(|v| v.as_array());
    let output = obj
        .get("limit")
        .and_then(|v| v.as_object())
        .and_then(|o| o.get("output"))
        .and_then(|v| v.as_i64());
    let (efforts, off_effort, has_toggle, always_thinking) =
        catalog_thinking_options(obj.get("reasoning_options"));
    let input = obj
        .get("limit")
        .and_then(|v| v.as_object())
        .and_then(|o| o.get("input"))
        .and_then(|v| v.as_i64());
    let max_input_tokens = input.filter(|n| *n > 0).map(|n| n.min(context));

    let mut caps: Vec<String> = Vec::new();
    if let Some(inp) = inputs {
        if inp.iter().any(|v| v.as_str() == Some("image")) {
            caps.push("image_in".into());
        }
        if inp.iter().any(|v| v.as_str() == Some("video")) {
            caps.push("video_in".into());
        }
        if inp.iter().any(|v| v.as_str() == Some("audio")) {
            caps.push("audio_in".into());
        }
    }
    let has_thinking = obj
        .get("reasoning")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || efforts.is_some()
        || has_toggle;
    if has_thinking {
        caps.push("thinking".into());
    }
    if obj
        .get("tool_call")
        .map(|v| v.as_bool().unwrap_or(true))
        .unwrap_or(true)
    {
        caps.push("tool_use".into());
    }
    if obj
        .get("dynamically_loaded_tools")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        caps.push("dynamically_loaded_tools".into());
    }

    let mut out = serde_json::Map::new();
    out.insert("id".into(), serde_json::Value::String(id.to_string()));
    if let Some(name) = obj.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        out.insert("name".into(), serde_json::Value::String(name.to_string()));
    }
    out.insert("context".into(), serde_json::Value::from(context));
    if let Some(v) = max_input_tokens {
        out.insert("maxInputSize".into(), serde_json::Value::from(v));
    }
    if let Some(v) = output.filter(|n| *n > 0) {
        out.insert("maxOutputSize".into(), serde_json::Value::from(v));
    }
    if let Some(k) = catalog_reasoning_key(obj.get("interleaved")) {
        out.insert("reasoningKey".into(), serde_json::Value::String(k));
    }
    if let Some(e) = efforts {
        out.insert(
            "supportEfforts".into(),
            serde_json::Value::Array(e.into_iter().map(serde_json::Value::String).collect()),
        );
    }
    if let Some(o) = off_effort {
        out.insert("offEffort".into(), serde_json::Value::String(o));
    }
    if let Some(a) = always_thinking {
        out.insert("alwaysThinking".into(), serde_json::Value::Bool(a));
    }
    if !caps.is_empty() {
        out.insert(
            "capabilities".into(),
            serde_json::Value::Array(caps.into_iter().map(serde_json::Value::String).collect()),
        );
    }
    Some(serde_json::Value::Object(out))
}

fn catalog_provider_models(provider_entry: &serde_json::Value) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = Vec::new();
    if let Some(models) = provider_entry.get("models").and_then(|v| v.as_object()) {
        for m in models.values() {
            if let Some(n) = normalize_catalog_model(m) {
                out.push(n);
            }
        }
    }
    out.sort_by(|a, b| a["id"].as_str().unwrap_or("").cmp(b["id"].as_str().unwrap_or("")));
    out
}

fn catalog_provider_type(provider_entry: &serde_json::Value) -> (String, bool) {
    let declared = provider_entry
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if PROVIDER_TYPES_RUST.contains(&declared) {
        (declared.to_string(), false)
    } else {
        ("openai".to_string(), true)
    }
}

fn normalize_url(v: Option<&str>) -> Option<String> {
    let url = v.map(|s| s.trim()).unwrap_or("");
    if url.is_empty() {
        return None;
    }
    if url.starts_with("http://") || url.starts_with("https://") {
        Some(url.to_string())
    } else {
        None
    }
}

#[allow(clippy::too_many_arguments)]
fn import_catalog_impl(
    home: &Path,
    provider_id: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
    default_model: Option<&str>,
) -> Result<serde_json::Value, String> {
    let key = normalize_id(provider_id, "Provider id")?;
    let (_, _, data) = load_catalog_data(false, default_catalog_cache_path().as_deref())?;
    let providers = data
        .get("providers")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let provider_entry = providers
        .iter()
        .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(key.as_str()));
    let Some(provider_entry) = provider_entry else {
        return Err(format!("not_found: Provider \"{}\" is not in the catalog", key));
    };
    let (type_, guessed) = catalog_provider_type(provider_entry);
    let models = catalog_provider_models(provider_entry);
    if models.is_empty() {
        return Err(format!("no_models: No usable chat models for \"{}\"", key));
    }

    let mut doc = read_config(home)?;
    {
        let providers_sec = ensure_providers_section(&mut doc);
        let mut entry = providers_sec
            .get_mut(&key)
            .and_then(|v| v.as_table_mut())
            .map(|t| t.clone())
            .unwrap_or_else(toml::Table::new);
        entry.insert("type".into(), toml::Value::String(type_.clone()));
        let api_key_val = api_key.map(|s| s.trim()).unwrap_or("").to_string();
        if !api_key_val.is_empty() {
            entry.insert("api_key".into(), toml::Value::String(api_key_val));
        }
        let url = normalize_url(base_url)
            .or_else(|| provider_entry.get("api").and_then(|v| v.as_str()).and_then(|s| normalize_url(Some(s))));
        match url {
            Some(u) => {
                entry.insert("base_url".into(), toml::Value::String(u));
            }
            None => {
                entry.remove("base_url");
            }
        }
        providers_sec.insert(key.clone(), toml::Value::Table(entry));
    }
    if !doc.contains_key("models") {
        doc.insert("models".into(), toml::Value::Table(toml::Table::new()));
    }
    {
        let models_sec = doc.get_mut("models").and_then(|v| v.as_table_mut()).expect("models table");
        for m in &models {
            let mid = m.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let alias = format!("{}/{}", key, mid);
            let mut me = models_sec
                .get_mut(&alias)
                .and_then(|v| v.as_table_mut())
                .map(|t| t.clone())
                .unwrap_or_else(toml::Table::new);
            me.insert("provider".into(), toml::Value::String(key.clone()));
            me.remove("provider_id");
            me.insert("model".into(), toml::Value::String(mid));
            if let Some(name) = m
                .get("name")
                .and_then(|v| v.as_str())
                .filter(|n| *n != me.get("model").and_then(|v| v.as_str()).unwrap_or(""))
            {
                me.insert("display_name".into(), toml::Value::String(name.to_string()));
            }
            if let Some(ctx) = m.get("context").and_then(|v| v.as_i64()) {
                me.insert("max_context_size".into(), toml::Value::Integer(ctx));
            }
            if let Some(v) = m.get("maxInputSize").and_then(|v| v.as_i64()) {
                me.insert("max_input_size".into(), toml::Value::Integer(v));
            }
            if let Some(v) = m.get("maxOutputSize").and_then(|v| v.as_i64()) {
                me.insert("max_output_size".into(), toml::Value::Integer(v));
            }
            if let Some(k) = m.get("reasoningKey").and_then(|v| v.as_str()) {
                me.insert("reasoning_key".into(), toml::Value::String(k.to_string()));
            }
            if let Some(e) = m.get("supportEfforts").and_then(|v| v.as_array()) {
                me.insert(
                    "support_efforts".into(),
                    toml::Value::Array(
                        e.iter()
                            .filter_map(|x| x.as_str())
                            .map(|s| toml::Value::String(s.to_string()))
                            .collect(),
                    ),
                );
            }
            if let Some(o) = m.get("offEffort").and_then(|v| v.as_str()) {
                me.insert("off_effort".into(), toml::Value::String(o.to_string()));
            }
            if let Some(caps) = m.get("capabilities").and_then(|v| v.as_array()) {
                let always = m
                    .get("alwaysThinking")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let list: Vec<toml::Value> = caps
                    .iter()
                    .filter_map(|c| c.as_str())
                    .map(|c| {
                        let cc = if always && c == "thinking" {
                            "always_thinking"
                        } else {
                            c
                        };
                        toml::Value::String(cc.to_string())
                    })
                    .collect();
                me.insert("capabilities".into(), toml::Value::Array(list));
            }
            models_sec.insert(alias, toml::Value::Table(me));
        }
    }
    let default_alias = default_model
        .map(|d| format!("{}/{}", key, d.trim()))
        .filter(|a| !a.ends_with('/'));
    if let Some(da) = &default_alias {
        let has = doc
            .get("models")
            .and_then(|v| v.as_table())
            .map(|t| t.contains_key(da))
            .unwrap_or(false);
        if has {
            doc.insert("default_model".into(), toml::Value::String(da.clone()));
        }
    }
    if doc.get("default_provider").and_then(|v| v.as_str()).is_none() {
        doc.insert("default_provider".into(), toml::Value::String(key.clone()));
    }
    write_config(home, &doc)?;
    let mut out = serde_json::Map::new();
    out.insert("providerId".into(), serde_json::Value::String(key));
    out.insert("type".into(), serde_json::Value::String(type_));
    out.insert("guessed".into(), serde_json::Value::Bool(guessed));
    out.insert("modelsImported".into(), serde_json::Value::from(models.len()));
    out.insert(
        "defaultModel".into(),
        doc.get("default_model")
            .and_then(|v| v.as_str())
            .map(|s| serde_json::Value::String(s.to_string()))
            .unwrap_or(serde_json::Value::Null),
    );
    Ok(serde_json::Value::Object(out))
}

#[tauri::command]
fn get_config(home_override: Option<String>) -> Result<serde_json::Value, String> {
    let home = resolve_kimi_home(home_override);
    config_view(&home)
}

#[tauri::command]
fn save_provider(
    home_override: Option<String>,
    id: String,
    r#type: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    default_model: Option<String>,
) -> Result<serde_json::Value, String> {
    let home = resolve_kimi_home(home_override);
    save_provider_impl(
        &home,
        &id,
        r#type.as_deref(),
        api_key.as_deref(),
        base_url.as_deref(),
        default_model.as_deref(),
    )
}

#[tauri::command]
fn delete_provider(
    home_override: Option<String>,
    provider_id: String,
) -> Result<serde_json::Value, String> {
    let home = resolve_kimi_home(home_override);
    delete_provider_impl(&home, &provider_id)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn save_model(
    home_override: Option<String>,
    provider_id: Option<String>,
    alias: String,
    model: Option<String>,
    display_name: Option<String>,
    max_context_size: Option<i64>,
    max_input_size: Option<i64>,
    max_output_size: Option<i64>,
    capabilities: Option<Vec<String>>,
    support_efforts: Option<Vec<String>>,
    default_effort: Option<String>,
    off_effort: Option<String>,
    reasoning_key: Option<String>,
    adaptive_thinking: Option<bool>,
) -> Result<serde_json::Value, String> {
    let home = resolve_kimi_home(home_override);
    save_model_impl(
        &home,
        provider_id.as_deref(),
        &alias,
        model.as_deref(),
        display_name.as_deref(),
        max_context_size,
        max_input_size,
        max_output_size,
        capabilities.as_deref(),
        support_efforts.as_deref(),
        default_effort.as_deref(),
        off_effort.as_deref(),
        reasoning_key.as_deref(),
        adaptive_thinking,
    )
}

#[tauri::command]
fn delete_model(home_override: Option<String>, alias: String) -> Result<serde_json::Value, String> {
    let home = resolve_kimi_home(home_override);
    delete_model_impl(&home, &alias)
}

#[tauri::command]
fn set_default_model(
    home_override: Option<String>,
    alias: String,
) -> Result<serde_json::Value, String> {
    let home = resolve_kimi_home(home_override);
    set_default_model_impl(&home, &alias)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
fn set_secondary_model(
    home_override: Option<String>,
    model: String,
    default_effort: Option<String>,
    off_effort: Option<String>,
    max_output_size: Option<i64>,
    support_efforts: Option<Vec<String>>,
    max_context_size: Option<i64>,
    max_input_size: Option<i64>,
) -> Result<serde_json::Value, String> {
    let home = resolve_kimi_home(home_override);
    set_secondary_model_impl(
        &home,
        &model,
        default_effort.as_deref(),
        off_effort.as_deref(),
        max_output_size,
        support_efforts.as_deref(),
        max_context_size,
        max_input_size,
    )
}

#[tauri::command]
fn get_catalog(
    home_override: Option<String>,
    refresh: Option<bool>,
) -> Result<serde_json::Value, String> {
    let _home = resolve_kimi_home(home_override);
    let (source, fetched_at, data) =
        load_catalog_data(refresh.unwrap_or(false), default_catalog_cache_path().as_deref())?;
    let providers = data
        .get("providers")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut provs_out: Vec<serde_json::Value> = Vec::new();
    for p in &providers {
        let mut obj = p.as_object().cloned().unwrap_or_default();
        obj.insert(
            "models".into(),
            serde_json::Value::Array(catalog_provider_models(p)),
        );
        provs_out.push(serde_json::Value::Object(obj));
    }
    let mut out = serde_json::Map::new();
    out.insert("source".into(), serde_json::Value::String(source));
    out.insert(
        "fetchedAt".into(),
        fetched_at
            .map(serde_json::Value::from)
            .unwrap_or(serde_json::Value::Null),
    );
    out.insert("providers".into(), serde_json::Value::Array(provs_out));
    Ok(serde_json::Value::Object(out))
}

#[tauri::command]
fn import_catalog(
    home_override: Option<String>,
    provider_id: String,
    api_key: Option<String>,
    base_url: Option<String>,
    default_model: Option<String>,
) -> Result<serde_json::Value, String> {
    let home = resolve_kimi_home(home_override);
    import_catalog_impl(
        &home,
        &provider_id,
        api_key.as_deref(),
        base_url.as_deref(),
        default_model.as_deref(),
    )
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            get_paths,
            get_prices,
            get_summary,
            list_sessions,
            archive_session,
            unarchive_session,
            delete_session,
            delete_workspace,
            get_session_preview,
            get_config,
            save_provider,
            delete_provider,
            save_model,
            delete_model,
            set_default_model,
            set_secondary_model,
            get_catalog,
            import_catalog,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------------------------------------------------------------------------
// Tests — desktop logic parity with the Node implementation
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_home_with_wire(
        tag: &str,
        workspace: &str,
        session: &str,
        agent: &str,
        record: &str,
    ) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kcd_test_{}_{}", std::process::id(), tag));
        let wire = if agent.is_empty() {
            dir.join("sessions").join(workspace).join(session).join("wire.jsonl")
        } else {
            dir.join("sessions")
                .join(workspace)
                .join(session)
                .join("agents")
                .join(agent)
                .join("wire.jsonl")
        };
        fs::create_dir_all(wire.parent().unwrap()).unwrap();
        fs::write(&wire, record).unwrap();
        dir
    }

    fn usage_line(model: &str, time_ms: u64, input_other: u64, output: u64) -> String {
        format!(
            "{{\"type\":\"usage.record\",\"usageScope\":\"turn\",\"model\":\"{}\",\"time\":{},\"usage\":{{\"inputOther\":{},\"output\":{},\"inputCacheRead\":0,\"inputCacheCreation\":0}}}}",
            model, time_ms, input_other, output
        )
    }

    #[test]
    fn session_hint_from_path_parses_agent_wire() {
        let root = PathBuf::from("/home/u/.kimi-code/sessions");
        let p = root.join("wd_demo").join("session_abc123def456").join("agents").join("main").join("wire.jsonl");
        let h = session_hint_from_path(&p, &root).expect("hint");
        assert_eq!(h.workspace.as_deref(), Some("wd_demo"));
        assert_eq!(h.session.as_deref(), Some("session_abc123def456"));
        assert_eq!(h.agent.as_deref(), Some("main"));
    }

    #[test]
    fn scan_usage_reads_turn_records_with_hint() {
        let now_ms = 1_700_000_000_000u64;
        let home = mk_home_with_wire(
            "turn",
            "wd_demo",
            "session_abc123def456",
            "main",
            &usage_line("kimi-k2.6", now_ms, 100, 50),
        );
        let (records, meta) = scan_usage(&home);
        let _ = fs::remove_dir_all(&home);
        assert_eq!(records.len(), 1);
        assert_eq!(meta.record_count, 1);
        assert!(meta.lines_seen >= 1);
        let r = &records[0];
        assert_eq!(r.model, "kimi-k2.6");
        assert_eq!(r.input_other, 100);
        assert_eq!(r.output, 50);
        let h = r.session_hint.as_ref().expect("hint");
        assert_eq!(h.workspace.as_deref(), Some("wd_demo"));
        assert_eq!(h.session.as_deref(), Some("session_abc123def456"));
        assert_eq!(h.agent.as_deref(), Some("main"));
    }

    #[test]
    fn scan_usage_ignores_non_turn_records() {
        let now_ms = 1_700_000_000_000u64;
        let line = "{\"type\":\"usage.record\",\"usageScope\":\"session\",\"model\":\"kimi-k2.6\",\"time\":".to_string()
            + &now_ms.to_string()
            + ",\"usage\":{\"inputOther\":999,\"output\":0,\"inputCacheRead\":0,\"inputCacheCreation\":0}}";
        let home = mk_home_with_wire("scope", "wd_demo", "session_abc123def456", "", &line);
        let (records, _) = scan_usage(&home);
        let _ = fs::remove_dir_all(&home);
        assert_eq!(records.len(), 0, "session-scope records must be skipped");
    }

    #[test]
    fn aggregate_daily_by_model_is_continuous() {
        let now_ms = 1_700_000_000_000u64;
        let home = mk_home_with_wire(
            "agg",
            "wd_demo",
            "session_abc123def456",
            "main",
            &format!(
                "{}\n{}",
                usage_line("kimi-k3", now_ms - 2 * 86400_000, 1000, 100),
                usage_line("kimi-k2.6", now_ms, 500, 50)
            ),
        );
        let (records, _) = scan_usage(&home);
        let _ = fs::remove_dir_all(&home);
        let s = aggregate(&records, "all", now_ms);
        let d = &s.daily_by_model;
        assert!(d.dates.len() >= 3, "gap days must be filled");
        assert!(d.dates.iter().any(|x| x == &day_key(now_ms - 2 * 86400_000)));
        assert!(d.series.iter().any(|x| x.key == "kimi-k3"));
        assert!(d.series.iter().any(|x| x.key == "kimi-k2.6"));
        // total of the two active days
        let sum: u64 = d.totals.iter().map(|t| t.total_tokens).sum();
        assert_eq!(sum, 1100 + 550);
    }

    fn mk_config_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kcd_cfg_{}_{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn catalog_seed_builtin() -> serde_json::Value {
        builtin_catalog_data().unwrap()
    }

    #[test]
    fn config_store_roundtrips_provider_model_and_secondary() {
        let home = mk_config_home("roundtrip");
        fs::write(
            config_file(&home),
            "default_model = \"openai/gpt-4o\"\n\n[providers.openai]\ntype = \"openai\"\napi_key = \"sk-x\"\n\n[models.\"openai/gpt-4o\"]\nprovider = \"openai\"\nmodel = \"gpt-4o\"\nmax_context_size = 128000\n",
        )
        .unwrap();

        let view = config_view(&home).unwrap();
        assert_eq!(view["defaultModel"].as_str(), Some("openai/gpt-4o"));
        assert_eq!(view["providers"][0]["id"].as_str(), Some("openai"));
        assert_eq!(view["providers"][0]["has_api_key"].as_bool(), Some(true));
        assert_eq!(view["providers"][0]["models"][0].as_str(), Some("openai/gpt-4o"));
        assert_eq!(view["models"][0]["alias"].as_str(), Some("openai/gpt-4o"));
        assert_eq!(view["models"][0]["provider"].as_str(), Some("openai"));
        assert!(view["providers"][0].get("api_key").is_none(), "api_key must be masked");

        // save a second provider + model
        save_provider_impl(&home, "anthropic", Some("anthropic"), Some("sk-y"), None, None).unwrap();
        save_model_impl(
            &home,
            Some("anthropic"),
            "anthropic/claude",
            Some("claude-3-7-sonnet"),
            None,
            Some(200_000),
            None,
            None,
            Some(&["thinking".to_string(), "tool_use".to_string()]),
            Some(&["low".to_string(), "high".to_string()]),
            Some("medium"),
            None,
            None,
            Some(true),
        )
        .unwrap();
        set_default_model_impl(&home, "anthropic/claude").unwrap();
        set_secondary_model_impl(
            &home,
            "anthropic/claude",
            Some("low"),
            None,
            Some(8192),
            None,
            None,
            None,
        )
        .unwrap();

        let view2 = config_view(&home).unwrap();
        assert_eq!(view2["providers"].as_array().unwrap().len(), 2);
        assert_eq!(view2["defaultModel"].as_str(), Some("anthropic/claude"));
        assert_eq!(view2["secondaryModel"]["model"].as_str(), Some("anthropic/claude"));
        let claude = view2["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["alias"].as_str() == Some("anthropic/claude"))
            .expect("claude model");
        assert_eq!(claude["max_context_size"].as_i64(), Some(200_000));
        assert_eq!(
            claude["capabilities"][0].as_str(),
            Some("thinking"),
            "capabilities follow official order"
        );

        // deleting the provider removes its models and pointers
        delete_provider_impl(&home, "anthropic").unwrap();
        let view3 = config_view(&home).unwrap();
        assert_eq!(view3["providers"].as_array().unwrap().len(), 1);
        assert!(view3["defaultModel"].is_null(), "default pointer cleared");
        assert!(view3["secondaryModel"].is_null(), "secondary pointer cleared");
        assert!(
            view3["models"]
                .as_array()
                .unwrap()
                .iter()
                .all(|m| m["alias"].as_str() != Some("anthropic/claude"))
        );
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn save_model_requires_context_and_rejects_bad_ids() {
        let home = mk_config_home("valid");
        save_provider_impl(&home, "my-prov", Some("openai"), None, None, None).unwrap();

        let err = save_model_impl(
            &home,
            Some("my-prov"),
            "my-prov/gpt",
            Some("gpt-4o"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("max_context_size"), "context required: {}", err);

        let err = save_provider_impl(&home, "bad id!", Some("openai"), None, None, None).unwrap_err();
        assert!(err.contains("invalid_id"), "id whitelist enforced: {}", err);

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn import_catalog_writes_provider_and_models_from_snapshot() {
        let home = mk_config_home("import");
        *CATALOG_CACHE.lock().unwrap() = Some(CatalogCache {
            at: now_ms(),
            data: catalog_seed_builtin(),
        });
        let out = import_catalog_impl(&home, "openai", Some("sk-z"), None, None).unwrap();
        assert_eq!(out["providerId"].as_str(), Some("openai"));
        assert!(out["modelsImported"].as_u64().unwrap_or(0) > 0);

        let view = config_view(&home).unwrap();
        assert_eq!(view["providers"][0]["id"].as_str(), Some("openai"));
        assert_eq!(view["providers"][0]["type"].as_str(), Some("openai"));
        assert_eq!(view["defaultProvider"].as_str(), Some("openai"));
        let models = view["models"].as_array().unwrap();
        assert!(models.len() > 0);
        let first = &models[0];
        assert_eq!(first["provider"].as_str(), Some("openai"));
        assert!(first["max_context_size"].as_i64().unwrap_or(0) > 0, "catalog context written");

        // unknown provider is rejected
        let err = import_catalog_impl(&home, "not-a-provider", None, None, None).unwrap_err();
        assert!(err.contains("not_found"), "unknown provider: {}", err);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn catalog_normalization_matches_snapshot_models() {
        let data = catalog_seed_builtin();
        let providers = data["providers"].as_array().unwrap();
        let openai = providers.iter().find(|p| p["id"].as_str() == Some("openai")).unwrap();
        let models = catalog_provider_models(openai);
        assert!(models.len() > 0, "openai snapshot has chat models");
        let m = &models[0];
        assert!(m["context"].as_i64().unwrap_or(0) > 0);
        assert!(
            m["capabilities"]
                .as_array()
                .map(|c| c.iter().any(|v| v.as_str() == Some("tool_use")))
                .unwrap_or(false),
            "chat models default to tool_use"
        );
    }

    #[test]
    fn strip_catalog_keeps_reasoning_options() {
        let raw = serde_json::json!({
            "demo": {
                "id": "demo",
                "name": "Demo",
                "api": "https://demo.example/v1",
                "models": {
                    "m1": {
                        "id": "m1",
                        "limit": { "context": 131072 },
                        "tool_call": true,
                        "reasoning": true,
                        "reasoning_options": [
                            { "type": "effort", "values": ["none", "low", "high"] }
                        ],
                        "modalities": { "input": ["text"] }
                    }
                }
            }
        });
        let data = strip_catalog(&raw);
        let m = &data["providers"][0]["models"]["m1"];
        assert!(
            m.get("reasoning_options").is_some(),
            "strip must keep reasoning_options so effort tiers survive"
        );
        let (efforts, off, toggle, always) = catalog_thinking_options(m.get("reasoning_options"));
        assert_eq!(
            efforts.as_deref().map(|v| v.iter().map(|s| s.as_str()).collect::<Vec<_>>()),
            Some(vec!["low", "high"])
        );
        assert_eq!(off.as_deref(), Some("none"), "none is the disable tier");
        assert!(!toggle);
        assert_eq!(always, None, "off tier exists so not always-on");
    }

    #[test]
    fn read_catalog_cache_accepts_node_fetchedat_spelling() {
        let cache_file =
            std::env::temp_dir().join(format!("kcd_catcache_node_{}.json", std::process::id()));
        let _ = fs::remove_file(&cache_file);
        // Node writes camelCase; the Tauri reader must accept it too.
        fs::write(
            &cache_file,
            serde_json::json!({ "fetchedAt": 1_700_000_000_000u64, "providers": [] })
                .to_string(),
        )
        .unwrap();
        let (fetched_at, providers) = read_catalog_cache(&cache_file).unwrap();
        assert_eq!(fetched_at, 1_700_000_000_000);
        assert!(providers.is_array());
        let _ = fs::remove_file(&cache_file);
    }

    #[test]
    fn catalog_fallback_prefers_persisted_snapshot_over_builtin() {
        let cache_file =
            std::env::temp_dir().join(format!("kcd_catcache_{}.json", std::process::id()));
        let _ = fs::remove_file(&cache_file);
        let snapshot = builtin_catalog_data().unwrap();
        let providers = snapshot["providers"].clone();
        write_catalog_cache(&cache_file, &providers, 1_700_000_000_000);

        let (source, fetched_at, data) = catalog_fallback(Some(&cache_file)).unwrap();
        assert_eq!(source, "cached");
        assert_eq!(fetched_at, Some(1_700_000_000_000));
        assert_eq!(data["_source"].as_str(), Some("cached"));
        assert_eq!(
            data["providers"].as_array().map(|a| a.len()),
            Some(providers.as_array().unwrap().len()),
            "persisted providers served"
        );
        let _ = fs::remove_file(&cache_file);
    }

    #[test]
    fn catalog_fallback_uses_builtin_without_persisted_cache() {
        let missing =
            std::env::temp_dir().join(format!("kcd_catcache_missing_{}.json", std::process::id()));
        let _ = fs::remove_file(&missing);
        let (source, fetched_at, data) = catalog_fallback(Some(&missing)).unwrap();
        assert_eq!(source, "builtin");
        assert_eq!(fetched_at, None);
        assert_eq!(data["_source"].as_str(), Some("builtin"));
        assert!(
            data["providers"].as_array().map(|a| a.len() >= 6).unwrap_or(false),
            "bundled snapshot served"
        );
    }

    #[test]
    fn catalog_fallback_ignores_corrupt_persisted_cache() {
        let corrupt =
            std::env::temp_dir().join(format!("kcd_catcache_corrupt_{}.json", std::process::id()));
        fs::write(&corrupt, "{not json").unwrap();
        let (source, _, _) = catalog_fallback(Some(&corrupt)).unwrap();
        assert_eq!(source, "builtin", "corrupt cache must not break catalog");
        let _ = fs::remove_file(&corrupt);
    }
}