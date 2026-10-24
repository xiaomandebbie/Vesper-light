// 定时。每分钟 tick 一次，到点的拿出来执行。
//
// ── 两种定时，这是这套东西和底层 lamp_schedule 最大的区别 ──
//
//   direct：到点我自己调灯。「明天七点把灯开成阅读模式」这种确定的事。
//   wake：  到点把允朔叫醒，把当时记下的那句话送回他眼前，调不调由他定。
//            「六点半去看看她回没回家，回来了就把灯开上」这种得看情况的事。
//
// 为什么要有 wake 这种：小满说的是「规划醒来仔去调节 / 直接定时控制灯光」。
// 前半句是 wake，后半句是 direct。确定的事不必烧一次模型调用；
// 不确定的事不该由一个定时器替他做决定。
//
// ── 错过的不补执行 ──
//
// 服务停机期间错过的定时，超过 scheduleGraceMinutes 就标 missed，不执行。
// 这条是照抄底层服务那个设计的，理由也一样：避免半夜突然开灯。
// 一个排在下午三点的「开灯」，服务半夜两点才恢复，那时候把灯点起来是灾难。
// 每天重复的错过不作废，顺延到下一次。
import { CONFIG } from './config.js';
import { lampStatus, lampPower, lampBrightness, lampTemp, checkBrightness, checkTemp } from './device.js';
import { applyScene, SCENES, sceneNames } from './scenes.js';
import { askHimToHandle } from './bridge.js';
import {
  addSchedule,
  dueSchedules,
  finishSchedule,
  rollSchedule,
  pendingSchedules,
  pendingCount,
  getPendingSchedule,
  cancelSchedule,
  cancelAllSchedules,
  moveSchedule,
  recentFinished,
} from './store.js';
import { formatDateTime, inWords, weekday, parseAt, AT_HELP } from './clock.js';

export const ACTIONS = ['on', 'off', 'brightness', 'color_temp', 'scene'];

const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// repeat_days 存的是 1-7（7 = 周日，和中文习惯一致），
// 而 weekday() 返回 0-6（0 = 周日）。转一下。
const toStoredDay = (jsDay) => (jsDay === 0 ? 7 : jsDay);

function parseDays(raw) {
  if (raw == null || raw === '') return null;
  const list = String(raw)
    .split(/[,，\s]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  return list.length ? [...new Set(list)].sort((a, b) => a - b) : null;
}

const dayText = (days) => days.map((d) => DAY_NAMES[d === 7 ? 0 : d]).join('、');

// 一条定时说成人话
export function describeSchedule(row) {
  if (row.mode === 'wake') {
    return `叫允朔来处理${row.note ? `：${row.note}` : ''}`;
  }
  switch (row.action) {
    case 'on':
      return '开灯';
    case 'off':
      return '关灯';
    case 'brightness':
      return `亮度调到 ${row.value}`;
    case 'color_temp':
      return `色温调到 ${row.value}K`;
    case 'scene':
      return `套上「${row.scene}」场景`;
    default:
      return row.action ?? '？';
  }
}

export function repeatText(row) {
  if (row.repeat === 'daily') return '每天';
  if (row.repeat === 'weekdays') {
    const days = parseDays(row.repeat_days);
    return days ? `每${dayText(days)}` : '每周';
  }
  return '只一次';
}

// 排一个定时。参数校验全在这里，MCP 和管理页都走这一个入口。
// 返回 { id, row } 或 { error }。
export function createSchedule(input, { source = 'mcp' } = {}) {
  const now = Date.now();

  if (pendingCount() >= CONFIG.maxPending) {
    return { error: `已经挂着 ${pendingCount()} 个定时了（上限 ${CONFIG.maxPending}）。先用 light_schedules 看一眼，把不要的撒掉。` };
  }

  const mode = input.mode === 'wake' ? 'wake' : 'direct';
  const repeat = ['daily', 'weekdays'].includes(input.repeat) ? input.repeat : 'none';
  const days = repeat === 'weekdays' ? parseDays(input.repeat_days) : null;
  if (repeat === 'weekdays' && !days) {
    return { error: 'repeat=weekdays 要给 repeat_days，比如 「1,3,5」（1 是周一，7 是周日）。' };
  }

  // 时间：at 或 after_minutes
  const hasAt = typeof input.at === 'string' && input.at.trim();
  const afterRaw = Number(input.after_minutes);
  const hasAfter = Number.isFinite(afterRaw) && afterRaw > 0;
  if (hasAt && hasAfter) return { error: 'at 和 after_minutes 只能给一个。' };

  let runAt;
  if (hasAfter) {
    if (repeat !== 'none') return { error: '重复的定时要用 at 给一个固定时间点，不能用 after_minutes。' };
    runAt = now + Math.round(afterRaw) * 60000;
  } else if (hasAt) {
    const parsed = parseAt(input.at, now);
    if (!parsed) return { error: `「${input.at}」这个时间我认不出来。${AT_HELP}` };
    runAt = parsed;
  } else {
    return { error: `没说什么时候。${AT_HELP}` };
  }

  if (runAt <= now) return { error: `${formatDateTime(runAt)} 已经过去了，排个往后的时间。` };
  if (runAt - now > 400 * 86400000) return { error: '太远了（超过 400 天），是不是年份写错了？' };

  // 到点做什么
  let action = null;
  let value = null;
  let scene = null;

  if (mode === 'direct') {
    action = String(input.action ?? '').trim();
    if (!ACTIONS.includes(action)) {
      return { error: `action 要是这几个之一：${ACTIONS.join('、')}。` };
    }
    if (action === 'brightness') {
      const c = checkBrightness(input.value);
      if (c.error) return { error: c.error };
      value = c.value;
    } else if (action === 'color_temp') {
      const c = checkTemp(input.value);
      if (c.error) return { error: c.error };
      value = c.value;
    } else if (action === 'scene') {
      scene = String(input.scene ?? '').trim();
      if (!SCENES[scene]) return { error: `没有「${scene}」这个场景。现有的：${sceneNames().join('、')}。` };
    }
  } else if (!String(input.note ?? '').trim()) {
    // wake 模式没 note 就没意义：允朔被叫醒之后不知道该干什么
    return { error: 'mode=wake 必须给 note，写清到点要允朔去看什么、做什么判断。' };
  }

  const note = String(input.note ?? '').trim().slice(0, 200) || null;
  const id = addSchedule({
    run_at: runAt,
    mode,
    action,
    value,
    temp: null,
    scene,
    note,
    repeat,
    repeat_days: days ? days.join(',') : null,
    source,
  });

  const row = { id, run_at: runAt, mode, action, value, scene, note, repeat, repeat_days: days?.join(',') ?? null };
  console.log(`schedule: 排了 #${id} ${formatDateTime(runAt)}（${inWords(runAt, now)}）——${describeSchedule(row)}，${repeatText(row)}`);
  return { id, row };
}

// 算下一次重复的时间。daily 加一天；weekdays 找下一个中的星期。
// 为什么用循环而不是算数：要求不高，最多转 8 次；而算数很容易在跨周时差一天。
function nextRepeatAt(row, from) {
  const step = 86400000;
  if (row.repeat === 'daily') {
    let next = row.run_at + step;
    while (next <= from) next += step;
    return next;
  }
  if (row.repeat === 'weekdays') {
    const days = parseDays(row.repeat_days);
    if (!days) return null;
    let next = row.run_at + step;
    for (let i = 0; i < 8; i += 1) {
      if (next > from && days.includes(toStoredDay(weekday(next)))) return next;
      next += step;
    }
    return null;
  }
  return null;
}

// 执行一条到点的定时。返回 { ok, text }。
async function runOne(row) {
  const note = row.note ? `定时 #${row.id}：${row.note}` : `定时 #${row.id}`;

  // wake 模式：我不动灯，只把他叫醒。
  if (row.mode === 'wake') {
    const st = await lampStatus({ source: 'schedule' });
    const state = st.ok
      ? `灯现在：${st.on === true ? '开着' : st.on === false ? '关着' : '开关读不出来'}${
          st.brightness !== null ? `，亮度 ${st.brightness}` : ''
        }${st.temp !== null ? `，色温 ${st.temp}K` : ''}。`
      : `灯的状态没读到（${st.error}）。`;
    const r = await askHimToHandle(
      `你之前约的灯的事到点了：${row.note ?? '（当时没写理由）'}\n${state}\n` +
        `要不要动、怎么动，你自己定——不动也行。要调就用 light 那套工具。`
    );
    return r.ok
      ? { ok: true, text: '已经叫允朔来处理了' }
      : { ok: false, text: `没叫到允朔（${r.reason}）` };
  }

  switch (row.action) {
    case 'on': {
      const r = await lampPower(true, { source: 'schedule', note });
      return { ok: r.ok, text: r.ok ? '开灯了' : `开灯没成：${r.error}` };
    }
    case 'off': {
      const r = await lampPower(false, { source: 'schedule', note });
      return { ok: r.ok, text: r.ok ? '关灯了' : `关灯没成：${r.error}` };
    }
    case 'brightness': {
      // 灯关着的时候调亮度：只设数值，**不自作主张开灯**。
      // 「七点把亮度调成 80」不等于「七点把灯开起来」，要开灯就再排一条 on。
      const r = await lampBrightness(row.value, { source: 'schedule', note });
      return { ok: r.ok, text: r.ok ? `亮度调到 ${row.value}` : `亮度没调成：${r.error}` };
    }
    case 'color_temp': {
      const r = await lampTemp(row.value, { source: 'schedule', note });
      return { ok: r.ok, text: r.ok ? `色温调到 ${row.value}K` : `色温没调成：${r.error}` };
    }
    case 'scene': {
      // 定时套场景：requireOn=false——灯关着就不动。
      // 半夜三点自己把灯开起来是这套东西最不应该做的事。
      const r = await applyScene(row.scene, { source: 'schedule', note, requireOn: false });
      return { ok: r.ok, text: r.ok ? r.message : `场景没套上：${r.error}` };
    }
    default:
      return { ok: false, text: `不认识的动作：${row.action}` };
  }
}

// 每分钟跑一次。
export async function tickSchedules(now = Date.now()) {
  const due = dueSchedules(now);
  if (!due.length) return { ran: 0 };

  const graceMs = CONFIG.scheduleGraceMinutes * 60000;
  let ran = 0;

  for (const row of due) {
    const late = now - row.run_at;

    // 错过太久：不补执行。每天重复的顺延到下一次。
    if (late > graceMs) {
      const next = nextRepeatAt(row, now);
      if (next) {
        rollSchedule(row.id, next, `错过了 ${formatDateTime(row.run_at)}（过了 ${Math.round(late / 60000)} 分钟），顺延到下一次`);
        console.warn(`schedule: #${row.id} 错过了，顺延到 ${formatDateTime(next)}`);
      } else {
        finishSchedule(row.id, 'missed', `错过了 ${formatDateTime(row.run_at)}，过了 ${Math.round(late / 60000)} 分钟，不补执行`);
        console.warn(`schedule: #${row.id} 错过超过 ${CONFIG.scheduleGraceMinutes} 分钟，标成 missed，不补执行`);
      }
      continue;
    }

    let out;
    try {
      out = await runOne(row);
    } catch (err) {
      out = { ok: false, text: `出错：${err.message}` };
    }
    ran += 1;

    const next = nextRepeatAt(row, now);
    if (next) {
      rollSchedule(row.id, next, out.text);
      console.log(`schedule: #${row.id} ${out.text}；下一次 ${formatDateTime(next)}`);
    } else {
      finishSchedule(row.id, out.ok ? 'done' : 'failed', out.text);
      console.log(`schedule: #${row.id} ${out.text}`);
    }
  }

  return { ran };
}

// ── 给人看的列表 ──

export function schedulesText(now = Date.now(), { done = false } = {}) {
  const pending = pendingSchedules();
  const out = [];

  if (!pending.length) {
    out.push('现在一个定时都没有。');
  } else {
    out.push(`还没到的定时（${pending.length} 个）：`);
    for (const row of pending) {
      const rep = row.repeat === 'none' ? '' : `，${repeatText(row)}`;
      const noteLine = row.mode === 'direct' && row.note ? `\n       ${row.note}` : '';
      out.push(
        `  #${row.id}  ${formatDateTime(row.run_at)}（${inWords(row.run_at, now)}）——${describeSchedule(row)}${rep}${noteLine}`
      );
    }
  }

  if (done) {
    const finished = recentFinished(8);
    if (finished.length) {
      out.push('', '最近过去的：');
      const mark = { done: '做了', failed: '没成', missed: '错过了', cancelled: '撒了' };
      for (const row of finished) {
        out.push(
          `  #${row.id}  ${formatDateTime(row.run_at)}  ${mark[row.status] ?? row.status}——${describeSchedule(row)}` +
            `${row.result ? `\n       ${row.result}` : ''}`
        );
      }
    }
  }

  out.push('', `（现在是 ${formatDateTime(now)}）`);
  return out.join('\n');
}

export { getPendingSchedule, cancelSchedule, cancelAllSchedules, moveSchedule, pendingSchedules };
