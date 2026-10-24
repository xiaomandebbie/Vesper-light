// 墙上时间。服务器是 UTC，自己拿 new Date() 算日期会差八小时，
// 「今晚」「明天七点」这种事全错，所以所有涉及日期的运算都走这里。
//
// 只做这个库真的要用的那几件事：取墙上年月日时分、算某天零点、
// 格式化、以及把 HH:MM 和 YYYY-MM-DD HH:MM 变成时间戳。
//
// 刻意不做中文自然语言时间（「明天早上七点」）：那套解析住在晨暮星的
// wake-mcp 里，允朔在聊天里听到那种说法，由他换算成 HH:MM 再来调灯。
// 两个库各管一段，不互相抄。
import { CONFIG } from './config.js';

export const TIME_ZONE = CONFIG.timeZone;

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export const pad = (n) => String(n).padStart(2, '0');

// 某个时间戳在 TIME_ZONE 下是几年几月几日几点几分
export function wallParts(ms = Date.now()) {
  const out = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, mi: out.minute, s: out.second };
}

// 这一刻时区偏了多少毫秒（东八区是 +8h）
function offsetAt(ms) {
  const p = wallParts(ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - ms;
}

// TIME_ZONE 下某一天的零点。日可以溢出（d = 32 就是下个月 1 号），
// 跨月跨年的加减交给 Date.UTC 自己算。
export function wallMidnight(y, m, d) {
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  // 偏移要用「目标时刻附近」的偏移来算，所以校正两次。
  // 中国没有夏令时，一次就够；多这一次是为了换时区时也不出错。
  const once = guess - offsetAt(guess);
  return guess - offsetAt(once);
}

// 今天（墙上时间）的零点
export function todayStart(ms = Date.now()) {
  const p = wallParts(ms);
  return wallMidnight(p.y, p.m, p.d);
}

// 当天的 H:M 对应的时间戳。dayShift = 1 就是明天的那个点。
export function atHhMm({ h, m }, ms = Date.now(), dayShift = 0) {
  const p = wallParts(ms);
  return wallMidnight(p.y, p.m, p.d + dayShift) + (h * 60 + m) * 60000;
}

// 2026-10-25（墙上日期）
export function formatDate(ms) {
  const p = wallParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function formatTime(ms) {
  const p = wallParts(ms);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

export function formatDateTime(ms) {
  return `${formatDate(ms)} ${formatTime(ms)}`;
}

// 星期几，0 是周日（按墙上日期算，不是 UTC）
export function weekday(ms) {
  const p = wallParts(ms);
  return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
}

// 还有多久 / 多久以前，说成人话
export function inWords(ms, now = Date.now()) {
  const min = Math.round((ms - now) / 60000);
  const ago = min < 0;
  const v = Math.abs(min);
  let body;
  if (v === 0) body = '就是现在';
  else if (v < 60) body = `${v} 分钟`;
  else if (v < 1440) {
    const h = Math.floor(v / 60);
    const rest = v % 60;
    body = rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
  } else {
    const d = Math.floor(v / 1440);
    const h = Math.floor((v % 1440) / 60);
    body = h ? `${d} 天 ${h} 小时` : `${d} 天`;
  }
  if (v === 0) return body;
  return ago ? `${body}前` : `${body}后`;
}

// 「HH:MM」或「YYYY-MM-DD HH:MM」→ 时间戳。
// 只给 HH:MM 时是今天的那个点；已经过了就是明天（和定时的直觉一致）。
// 认不出来返回 null —— 猜一个时间比报错危险得多。
export function parseAt(raw, now = Date.now()) {
  const s = String(raw ?? '').trim().replace(/：/g, ':');
  if (!s) return null;

  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[\sT]+(\d{1,2}):(\d{1,2})$/.exec(s);
  if (m) {
    const [, y, mo, d, h, mi] = m.map(Number);
    if (h > 23 || mi > 59) return null;
    return wallMidnight(y, mo, d) + (h * 60 + mi) * 60000;
  }

  m = /^(\d{1,2})[-/](\d{1,2})[\sT]+(\d{1,2}):(\d{1,2})$/.exec(s);
  if (m) {
    const [, mo, d, h, mi] = m.map(Number);
    if (h > 23 || mi > 59) return null;
    const p = wallParts(now);
    let ts = wallMidnight(p.y, mo, d) + (h * 60 + mi) * 60000;
    if (ts <= now) ts = wallMidnight(p.y + 1, mo, d) + (h * 60 + mi) * 60000;
    return ts;
  }

  m = /^(\d{1,2}):(\d{1,2})$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    const today = atHhMm({ h, m: mi }, now);
    return today > now ? today : atHhMm({ h, m: mi }, now, 1);
  }

  return null;
}

export const AT_HELP =
  '时间这样写：23:30（今天，过了就是明天）、2026-10-25 07:00、10-25 07:00。' +
  '或者用 after_minutes 说多少分钟后。';
