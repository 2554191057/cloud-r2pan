import type { Env } from "./types";

/**
 * 数据库初始化 —— 首次请求时自动建表, 无需手动迁移。
 * 表结构:
 *   files              上传到 R2 的文件元数据
 *   shares             分享链接 (token 即主键)
 *   download_logs      下载记录 (IP / 浏览器 / 系统 / 流量)
 *   login_logs         管理员登录记录 (成功/失败/登出, 防盗号审计)
 *   turnstile_visits   IP 每日访问计数 (超过阈值触发 Turnstile)
 *   banned_ips         封禁名单 (支持到期自动解封)
 *   settings           可调参数 + 流量用量统计
 *   traffic_stats      每日流量/下载汇总 (用于图表)
 */
const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    uploaded_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    max_downloads INTEGER,
    download_count INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,
    password_cipher TEXT,
    download_name TEXT,
    is_market INTEGER NOT NULL DEFAULT 0,
    market_views INTEGER NOT NULL DEFAULT 0,
    market_title TEXT,
    market_desc TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_shares_file ON shares(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_shares_market ON shares(is_market, revoked)`,
  `CREATE TABLE IF NOT EXISTS download_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    share_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    ip TEXT NOT NULL,
    ua TEXT,
    browser TEXT,
    os TEXT,
    country TEXT,
    bytes INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_logs_share_ip ON download_logs(share_id, ip, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_created ON download_logs(created_at)`,
  `CREATE TABLE IF NOT EXISTS login_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    ip TEXT NOT NULL,
    ua TEXT,
    browser TEXT,
    os TEXT,
    country TEXT,
    result TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_login_logs_created ON login_logs(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_login_logs_ip ON login_logs(ip)`,
  `CREATE TABLE IF NOT EXISTS turnstile_visits (
    ip TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(ip, day)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_turnstile_day ON turnstile_visits(day)`,
  `CREATE TABLE IF NOT EXISTS banned_ips (
    ip TEXT PRIMARY KEY,
    reason TEXT,
    banned_at INTEGER NOT NULL,
    expires_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS traffic_stats (
    day TEXT PRIMARY KEY,
    bytes INTEGER NOT NULL DEFAULT 0,
    downloads INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at)`,
  `CREATE TABLE IF NOT EXISTS oauth_providers (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    client_id TEXT NOT NULL DEFAULT '',
    client_secret_cipher TEXT,
    scope TEXT NOT NULL DEFAULT 'openid email profile',
    custom_authorize_url TEXT NOT NULL DEFAULT '',
    custom_token_url TEXT NOT NULL DEFAULT '',
    custom_userinfo_url TEXT NOT NULL DEFAULT '',
    custom_token_field TEXT NOT NULL DEFAULT 'access_token',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_providers_enabled ON oauth_providers(enabled)`,
  // ═══════════ 激活码 ═══════════
  // 每个激活码独立额度，和全局 traffic_limit_bytes 互不影响
  `CREATE TABLE IF NOT EXISTS activation_plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    traffic_bytes INTEGER NOT NULL DEFAULT 0,
    days_valid INTEGER NOT NULL DEFAULT 0,
    quota_message TEXT,
    batch_id TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS activation_codes (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    plan_id TEXT,
    traffic_bytes INTEGER NOT NULL DEFAULT 0,
    used_bytes INTEGER NOT NULL DEFAULT 0,
    days_valid INTEGER NOT NULL DEFAULT 0,
    quota_message TEXT,
    status TEXT NOT NULL DEFAULT 'unused',
    batch_id TEXT,
    notes TEXT,
    created_at INTEGER NOT NULL,
    activated_at INTEGER,
    expires_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_codes_status ON activation_codes(status)`,
  `CREATE INDEX IF NOT EXISTS idx_codes_batch ON activation_codes(batch_id)`,
  `CREATE INDEX IF NOT EXISTS idx_codes_code ON activation_codes(code)`,
];

let schemaReady = false;

/**
 * 确保数据库表结构存在 —— 首次请求时自动建表，无需手动迁移。
 *
 * ── Bug #5 修复：并发 DDL 风险 ──────────────────────────────────
 * 原实现每个 Isolate 都有独立的 schemaReady 布尔，冷启动时多 Isolate 会并发跑 DDL batch，
 * 虽然 CREATE TABLE IF NOT EXISTS 本身幂等，但每次都跑完整 DDL 很重。
 *
 * 新实现分层短路：
 *   1. schemaReady（内存）—— 本 Isolate 内的快速短路，零成本
 *   2. 轻量 SELECT settings —— 跨 Isolate 安全检测，schema 已就绪时极快（D1 命中索引）
 *   3. 只有表真的不存在时才执行 DDL batch —— 且用 try/catch 兜底竞态
 *
 * 绝大多数请求命中 ① 或 ②，不会触发 DDL。
 *
 * ⚠️ 注意：ALTER TABLE 迁移语句不参与 schemaReady 短路，每次 ensureSchema 都执行一遍
 * （用 try/catch 保护，列已存在时静默忽略），保证老用户库升级后列补齐。
 */

/** 所有增量迁移语句 —— 每次 ensureSchema 都执行一遍，幂等安全 */
const MIGRATION_STATEMENTS: string[] = [
  "ALTER TABLE shares ADD COLUMN password_hash TEXT",
  "ALTER TABLE shares ADD COLUMN password_cipher TEXT",
  "ALTER TABLE shares ADD COLUMN download_name TEXT",
  "ALTER TABLE download_logs ADD COLUMN activation_code TEXT",
  "ALTER TABLE shares ADD COLUMN is_market INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE shares ADD COLUMN market_views INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE shares ADD COLUMN market_title TEXT",
  "ALTER TABLE shares ADD COLUMN market_desc TEXT",
  "CREATE INDEX IF NOT EXISTS idx_shares_market ON shares(is_market, revoked)",
];

export async function ensureSchema(env: Env): Promise<void> {
  // ① 防御性检查：如果数据库绑定不存在，直接报错
  if (!env.db) {
    throw new Error("Database binding 'db' is not configured. " +
      "在 Cloudflare 控制台 → Worker Settings → Bindings 添加 D1 绑定，" +
      "或在 wrangler.jsonc 的 d1_databases 中声明。");
  }

  // ② 每次都跑一遍增量迁移 —— 幂等安全（列已存在时 D1 会抛错，被 catch 住静默忽略）
  // 这样无论老库新库、首次部署还是已跑过 CREATE TABLE，都能补齐所有新增列
  for (const sql of MIGRATION_STATEMENTS) {
    try {
      await env.db.prepare(sql).run();
    } catch {
      /* 列/索引已存在，忽略 */
    }
  }

  // ③ 基础表已就绪 —— 用 schemaReady 短路 CREATE TABLE
  if (schemaReady) return;

  // ④ 跨 Isolate 安全检测：用 sqlite_master 检查表是否存在
  try {
    const row: any = await env.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='settings'"
    ).first();
    if (row) {
      schemaReady = true;
      return;
    }
  } catch {
    // 查询失败（如数据库完全损坏），继续尝试建表
  }

  // ⑤ 真正的建表路径（首次部署 / 库被清空时触发）
  // 用 try/catch 处理极端竞态：另一个 Isolate 刚好也在执行 DDL
  try {
    await env.db.batch(SCHEMA_STATEMENTS.map((sql) => env.db.prepare(sql)));
  } catch {
    // 竞态兜底：可能另一个 Isolate 刚建完表。
    // 再检测一次，确认表存在就算成功
    try {
      const row: any = await env.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='settings'"
      ).first();
      if (!row) throw new Error("schema still missing after DDL attempt");
    } catch (e) {
      // 表确实没建起来，重新抛出让上层决定
      throw e;
    }
  }

  schemaReady = true;
}

/** 生成 URL 安全的随机 ID */
export function randomId(len = 12): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
