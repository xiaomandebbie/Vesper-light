// SQLite。自己一个库文件（data/light.db）。
//
// 为什么不共用底层那个 lamp_log.db：那个文件是 Python 那边的进程在写，
// 两个进程各自打开同一个 SQLite 只是在给自己找锁的麻烦，而且 schema 也不归我管。
// 底层照旧记它的 logs / schedules；这边记自己的。两份记录回答的不是同一个问题：
// 底层答「指令有没有发到灯上」，这边答「是谁、为什么要动这盏灯」。
//
// 三张表：
//   light_log   每一次动作，带来源（mcp / schedule / guard / page / bridge）
//   schedules   定时（直接调灯的和叫允朔来处理的两种）
//   guard_log   睡前守护每天走到哪一档了，重启之后不至于从头再来一遍
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { CONFIG } from './config.js';
import { todayStart } from './clock.js';

const file = path.resolve(process.cwd(), CONFIG.dbPath);
fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS light_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  value INTEGER,
  ok INTEGER NOT NULL,
  detail TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_light_log_ts ON light_log (ts);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  run_at INTEGER NOT NULL,
  -- direct = 到点这个服务自己调灯；wake = 到点叫允朔醒一次，气氛和该不该动由他当时定
  mode TEXT NOT NULL DEFAULT 'direct',
  action TEXT,
  value INTEGER,
  temp INTEGER,
  scene TEXT,
  note TEXT,
  -- none / daily / weekdays（1-7，7 是周日，逗号分隔）
  repeat TEXT NOT NULL DEFAULT 'none',
  repeat_days TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  done_at INTEGER,
  result TEXT,
  source TEXT NOT NULL DEFAULT 'mcp'
);
CREATE INDEX IF NOT EXISTS idx_schedules_run ON schedules (status, run_at);

CREATE TABLE IF NOT EXISTS guard_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  night TEXT NOT NULL,
  stage INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  brightness_before INTEGER,
  brightness_after INTEGER,
  outcome TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_guard_night ON guard_log (night, stage);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

export default db;

// ── meta ──

export const getMeta = (key) => stmt('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
export const setMeta = (key, value) =>
  stmt('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));

// ── 操作记录 ──

// 每一次动作都记，包括没成的。没成的那些最有用——
// 登录失效、灯离线都是从这里看出来的。
export function logAction({ source, action, value = null, ok, detail = null, note = null }) {
  stmt(
    'INSERT INTO light_log (ts, source, action, value, ok, detail, note) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(Date.now(), String(source), String(action), value, ok ? 1 : 0, detail, note);
  // 表不让它一直涨：只留最近 2000 条
  stmt(
    'DELETE FROM light_log WHERE id NOT IN (SELECT id FROM light_log ORDER BY ts DESC, id DESC LIMIT 2000)'
  ).run();
}

export const recentLogs = (limit = 20) =>
  stmt('SELECT * FROM light_log ORDER BY ts DESC, id DESC LIMIT ?').all(Math.min(Math.max(1, limit), 200));

export const lastActionBySource = (source) =>
  stmt('SELECT * FROM light_log WHERE source = ? AND ok = 1 ORDER BY ts DESC LIMIT 1').get(source) ?? null;

// ── 定时 ──

export const pendingSchedules = () =>
  stmt("SELECT * FROM schedules WHERE status = 'pending' ORDER BY run_at ASC").all();

export const pendingCount = () =>
  stmt("SELECT COUNT(*) AS c FROM schedules WHERE status = 'pending'").get().c;

export const getSchedule = (id) => stmt('SELECT * FROM schedules WHERE id = ?').get(id) ?? null;

export const getPendingSchedule = (id) =>
  stmt("SELECT * FROM schedules WHERE id = ? AND status = 'pending'").get(id) ?? null;

export const dueSchedules = (now = Date.now()) =>
  stmt("SELECT * FROM schedules WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC").all(now);

export function addSchedule(row) {
  return stmt(
    `INSERT INTO schedules
       (created_at, run_at, mode, action, value, temp, scene, note, repeat, repeat_days, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(),
    row.run_at,
    row.mode ?? 'direct',
    row.action ?? null,
    row.value ?? null,
    row.temp ?? null,
    row.scene ?? null,
    row.note ?? null,
    row.repeat ?? 'none',
    row.repeat_days ?? null,
    row.source ?? 'mcp'
  ).lastInsertRowid;
}

export const cancelSchedule = (id) =>
  stmt("UPDATE schedules SET status = 'cancelled', done_at = ? WHERE id = ? AND status = 'pending'")
    .run(Date.now(), id).changes;

export const cancelAllSchedules = () =>
  stmt("UPDATE schedules SET status = 'cancelled', done_at = ? WHERE status = 'pending'").run(Date.now()).changes;

export const moveSchedule = (id, runAt, note) =>
  note === undefined
    ? stmt("UPDATE schedules SET run_at = ? WHERE id = ? AND status = 'pending'").run(runAt, id).changes
    : stmt("UPDATE schedules SET run_at = ?, note = ? WHERE id = ? AND status = 'pending'")
        .run(runAt, note, id).changes;

export const finishSchedule = (id, status, result = null) =>
  stmt('UPDATE schedules SET status = ?, done_at = ?, result = ? WHERE id = ?')
    .run(status, Date.now(), result, id).changes;

// 每天重复的顺延到下一次：不新建一条，就把 run_at 往后推。
// 这样「每天 7:00 开灯」永远是同一个 #号，小满记得住，撒的时候也好找。
export const rollSchedule = (id, nextRunAt, result = null) =>
  stmt('UPDATE schedules SET run_at = ?, result = ?, done_at = ? WHERE id = ?')
    .run(nextRunAt, result, Date.now(), id).changes;

export const recentFinished = (limit = 10) =>
  stmt(
    "SELECT * FROM schedules WHERE status IN ('done', 'failed', 'missed', 'cancelled') ORDER BY done_at DESC LIMIT ?"
  ).all(Math.min(Math.max(1, limit), 50));

// ── 睡前守护 ──

// 「今多」的标记用守护窗口开始那天的日期，所以凌晨一点调的那一档
// 仍算前一天那一夜——不然过了午夜档位会被重置，又从第一档重来。
export const guardStagesDone = (night) =>
  stmt("SELECT stage FROM guard_log WHERE night = ? AND outcome IN ('dimmed', 'skipped', 'floor') ORDER BY stage ASC")
    .all(night)
    .map((r) => r.stage);

export const guardLastEvent = (night) =>
  stmt('SELECT * FROM guard_log WHERE night = ? ORDER BY ts DESC LIMIT 1').get(night) ?? null;

export function logGuard({ night, stage, before = null, after = null, outcome, detail = null }) {
  stmt(
    'INSERT INTO guard_log (night, stage, ts, brightness_before, brightness_after, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(night, stage, Date.now(), before, after, outcome, detail);
  stmt(
    'DELETE FROM guard_log WHERE id NOT IN (SELECT id FROM guard_log ORDER BY ts DESC, id DESC LIMIT 500)'
  ).run();
}

export const guardTonight = (night) =>
  stmt('SELECT * FROM guard_log WHERE night = ? ORDER BY stage ASC, ts ASC').all(night);

// 今天的操作记录（管理页用）
export const todayLogs = () =>
  stmt('SELECT * FROM light_log WHERE ts >= ? ORDER BY ts DESC').all(todayStart());
