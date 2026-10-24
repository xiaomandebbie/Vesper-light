// 睡前守护：到点了把灯一档一档调暗。
//
// ═══ 四条不能改的规矩 ═══
//
// 一、**永远不关灯。**
//    小满明确要求的：提醒方式是调低亮度，不能直接关掉。
//    人还坐在那里的时候灯突然黑掉是惊吓，而渐暗是一句「不早了」。
//    所以这个文件里**没有一处调用 lampPower(false)**。不是忘了，是故意的。
//
// 二、**灯已经关了就什么都不做。**
//    她已经睡了。这时候去设亮度——哪怕只是设个数值——有些灯会应声点亮。
//    状态**读不出来**（on === null）也不动。
//
// 三、**只往下调，从不往上调。**
//    灯现在已经比这一档的目标还暗，这一档就跳过。
//
// 四、**今夜几点开始，由允朔定。没定就不动灯。**
//    这条是 2026-10-24 深夜加的。原来写死 23:30 开始，结果那天她 23:30
//    还在干活，灯自己暗下去了——她说「太早了」。
//    问题不在 23:30 这个数字，在于「几点算晚」每天不一样，写死就一定会错。
//    现在改成：23:00（LAMP_GUARD_ASK_AT）叫允朔醒一次，他看一眼灯、看一眼她在做什么，
//    自己定今夜从几点开始；定完还能改，也能定「今夜不守护」。
//    **他没定之前，这东西一次都不动灯。** 宁可整夜不动，也不要在她干活的时候自作主张。
//
// ═══ 其他设计决定 ═══
//
// 「今夜」的起点按守护窗口开始那天算，所以凌晨一点那一档仍属于前一夜。
// 不这样的话过了午夜档位被重置，又从第一档 40 重来——把已经暗到 8 的灯调回 40。
//
// 她还在忙一件没到点的事（问晨暮星的时间感知）就把后面几档整体推迟，
// 最多推 guardBusyMaxDelays 次。
import { CONFIG } from './config.js';
import { lampStatus, lampBrightness, lampTemp } from './device.js';
import { formatDate, formatDateTime, formatTime, atHhMm, wallParts, parseAt } from './clock.js';
import {
  guardStagesDone,
  logGuard,
  guardTonight,
  getMeta,
  setMeta,
  getGuardPlan,
  saveGuardPlan,
  clearGuardPlan,
} from './store.js';
import { notify, writeConversation, sheIsBusy, askHimToHandle } from './bridge.js';

const BUSY_DELAY_KEY = 'guard_busy_delays';
const ASKED_KEY = 'guard_asked_night';

// 窗口跳午夜吗。用「问的时间」当起点算：那是一夜里最早发生的事，
// 比允朔定的 bedtime 稳（后者每天不一样，用它算「今夜」会让分组自己漂）。
const windowCrossesMidnight = () => {
  const start = CONFIG.guardAskAt.h * 60 + CONFIG.guardAskAt.m;
  const end = CONFIG.guardWindowEnd.h * 60 + CONFIG.guardWindowEnd.m;
  return end <= start;
};

// 这一刻属于哪一夜。窗口跳午夜时，凌晨那段算前一天。
export function nightOf(ms = Date.now()) {
  const p = wallParts(ms);
  const minutes = p.h * 60 + p.mi;
  const endMinutes = CONFIG.guardWindowEnd.h * 60 + CONFIG.guardWindowEnd.m;
  if (windowCrossesMidnight() && minutes < endMinutes) {
    return formatDate(ms - 24 * 3600000);
  }
  return formatDate(ms);
}

// 今夜允朔定的安排。返回 { bedtime:{h,m}, stages:[…], note, off, decidedAt } 或 null。
// off = true 表示他明确定了「今夜不守护」——和「还没定」是两件事。
export function tonightPlan(ms = Date.now()) {
  const row = getGuardPlan(nightOf(ms));
  if (!row) return null;
  if (row.off) return { off: true, note: row.note, decidedAt: row.decided_at };
  const bedtime = parseHhMmLoose(row.bedtime);
  if (!bedtime) return null;
  let stages;
  try {
    const list = JSON.parse(row.stages || '[]');
    stages = Array.isArray(list) && list.length ? list : CONFIG.guardStages;
  } catch {
    stages = CONFIG.guardStages;
  }
  return { bedtime, stages, note: row.note, decidedAt: row.decided_at, source: row.source };
}

function parseHhMmLoose(raw) {
  const m = /^(\d{1,2})[:：.](\d{1,2})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return { h, m: mi };
}

// 第 n 档（从 0 数）该在什么时候。bedtime 来自今夜的安排。
function stageTime(plan, index, ms = Date.now(), delays = 0) {
  const night = nightOf(ms);
  const isEarlyMorning = windowCrossesMidnight() && formatDate(ms) !== night;
  const base = atHhMm(plan.bedtime, ms, isEarlyMorning ? -1 : 0);
  return base + (index * CONFIG.guardStepMinutes + delays * CONFIG.guardBusyDelayMinutes) * 60000;
}

function windowEndTime(ms = Date.now()) {
  const night = nightOf(ms);
  const isEarlyMorning = windowCrossesMidnight() && formatDate(ms) !== night;
  return atHhMm(CONFIG.guardWindowEnd, ms, isEarlyMorning ? 0 : windowCrossesMidnight() ? 1 : 0);
}

export function inGuardWindow(ms = Date.now()) {
  const plan = tonightPlan(ms);
  if (!plan || plan.off) return false;
  return ms >= stageTime(plan, 0, ms, 0) && ms < windowEndTime(ms);
}

function busyDelays(night) {
  const raw = getMeta(BUSY_DELAY_KEY);
  if (!raw) return 0;
  const [n, count] = String(raw).split('|');
  return n === night ? Number(count) || 0 : 0;
}

function bumpBusyDelays(night) {
  const next = busyDelays(night) + 1;
  setMeta(BUSY_DELAY_KEY, `${night}|${next}`);
  return next;
}

// ── 允朔定今夜几点开始 ──

// 允朔定下来。at 认 「23:40」这种写法；也能跟着改档位。
// 重复调就是改（小满要求的「后面也可以更改」）。
export function decideTonight({ at, stages = null, note = null, ms = Date.now() }) {
  const bedtime = parseHhMmLoose(at);
  if (!bedtime) return { error: `「${at}」这个时间我认不出来。写成 23:40 这样就行。` };

  let list = null;
  if (stages != null) {
    const arr = Array.isArray(stages)
      ? stages
      : String(stages).split(/[,，\s]+/);
    list = arr
      .map((v) => Math.round(Number(v)))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 100);
    list = [...new Set(list)].sort((a, b) => b - a).filter((v) => v > CONFIG.guardFloor);
    if (!list.length) return { error: `档位得是比地板（${CONFIG.guardFloor}）高的亮度，比如 「40,20,8」。` };
  }

  const night = nightOf(ms);
  saveGuardPlan({
    night,
    bedtime: `${String(bedtime.h).padStart(2, '0')}:${String(bedtime.m).padStart(2, '0')}`,
    stages: JSON.stringify(list ?? CONFIG.guardStages),
    note: note ? String(note).slice(0, 200) : null,
    off: 0,
    source: 'decide',
  });
  // 改了开始时间就把「还在忙」推迟的账清了：那是按旧时间算的
  setMeta(BUSY_DELAY_KEY, `${night}|0`);

  const plan = tonightPlan(ms);
  console.log(
    `guard: 允朔定了今夜（${night}）从 ${formatTime(stageTime(plan, 0, ms))} 开始，` +
      `${plan.stages.join(' → ')}${note ? `——${note}` : ''}`
  );
  return { plan };
}

// 今夜不守护。和「还没定」分开记：他明确说过不守，就不该在 23:00 再问一遍。
export function skipTonight({ note = null, ms = Date.now() } = {}) {
  const night = nightOf(ms);
  saveGuardPlan({
    night,
    bedtime: null,
    stages: null,
    note: note ? String(note).slice(0, 200) : null,
    off: 1,
    source: 'decide',
  });
  console.log(`guard: 允朔定了今夜（${night}）不守护${note ? `——${note}` : ''}`);
  return { off: true };
}

// 把今夜的安排撒掉，回到「还没定」。下次 tick 会重新问他。
export function resetTonight(ms = Date.now()) {
  const night = nightOf(ms);
  clearGuardPlan(night);
  setMeta(ASKED_KEY, '');
  console.log(`guard: 今夜（${night}）的安排撒了，回到还没定的状态`);
  return { reset: true };
}

// 到 23:00 了、今夜还没定、今夜还没问过——就叫允朔醒一次。
// 只问一遍：他醒了不定也是一种回答（那今夜就不动灯），不该每分钟追他。
export async function askGuardDecision(now = Date.now()) {
  if (!CONFIG.guard) return { skipped: '守护没开' };

  const night = nightOf(now);
  if (tonightPlan(now)) return { skipped: '今夜已经定过了' };
  if (getMeta(ASKED_KEY) === night) return { skipped: '今夜已经问过了' };

  const askAt = atHhMm(CONFIG.guardAskAt, now, windowCrossesMidnight() && formatDate(now) !== night ? -1 : 0);
  if (now < askAt) return { skipped: `还没到问的时间（${formatTime(askAt)}）` };
  if (now >= windowEndTime(now)) return { skipped: '这一夜已经过去了' };

  const st = await lampStatus({ source: 'guard' });
  const lamp = st.ok
    ? `${CONFIG.lampName}现在${st.on === true ? '开着' : st.on === false ? '关着' : '开关读不出来'}` +
      `${st.brightness !== null ? `，亮度 ${st.brightness}` : ''}${st.temp !== null ? `，色温 ${st.temp}K` : ''}。`
    : `${CONFIG.lampName}的状态没读到（${st.error}）。`;

  const busy = await sheIsBusy();
  const doing = busy.busy && busy.what?.length ? `她还在忙「${busy.what.join('、')}」，那件事按她的节奏还没到点。` : '';

  const words =
    `现在 ${formatTime(now)}，该定今夜的睡前守护了。\n${lamp}${doing ? `\n${doing}` : ''}\n\n` +
    `今夜从几点开始把灯一档一档调暗，你定。用 light_guard_set（比如 at="23:40"）。\n` +
    `定完还能改；觉得今夜不该调就用 light_guard_skip。\n` +
    `**你不定的话今夜就不动灯**——这比猜一个时间然后在她干活的时候把灯压暗强。`;

  setMeta(ASKED_KEY, night);
  const r = await askHimToHandle(words);
  console.log(
    r.ok
      ? `guard: 已经叫允朔来定今夜（${night}）几点开始`
      : `guard: 没叫到允朔（${r.reason}），今夜就不动灯了`
  );
  return r.ok ? { asked: true } : { asked: false, reason: r.reason };
}

// 第一档调暗时说的那句话。只在第一档说，后面几档闷着做。
function firstStageWords(before, after) {
  return (
    `${CONFIG.lampName}已经从 ${before} 调到 ${after} 了。` +
    `不早了——我不关灯，就这样暗着陪着你。想关的时候你自己说。`
  );
}

// 跑一次守护。由 light.js 的分钟 tick 调用。
export async function runGuard(now = Date.now()) {
  if (!CONFIG.guard) return { skipped: '守护没开' };

  const plan = tonightPlan(now);
  // 规矩四：允朔没定就不动灯。这是整个守护的门槛。
  if (!plan) return { skipped: '今夜还没定开始时间' };
  if (plan.off) return { skipped: '允朔定了今夜不守护' };
  if (!inGuardWindow(now)) return { skipped: '不在守护窗口里' };

  const night = nightOf(now);
  const done = new Set(guardStagesDone(night));
  const delays = busyDelays(night);

  let index = -1;
  for (let i = 0; i < plan.stages.length; i += 1) {
    if (done.has(i)) continue;
    if (stageTime(plan, i, now, delays) <= now) index = i;
    break;
  }
  if (index < 0) return { skipped: '还没到下一档的时间' };

  const target = plan.stages[index];

  // 规矩二：先看灯现在怎么样。读不到就不动。
  const st = await lampStatus({ source: 'guard' });
  if (!st.ok) {
    logGuard({ night, stage: index, outcome: 'unknown', detail: `读不到状态：${st.error}` });
    console.warn(`guard: 第 ${index + 1} 档读不到灯的状态，这档不动（${st.error}）`);
    return { stage: index, outcome: 'unknown', error: st.error };
  }

  if (st.on !== true) {
    const why = st.on === false ? '灯已经关了' : '读不出灯是开是关';
    logGuard({ night, stage: index, before: st.brightness, outcome: 'skipped', detail: why });
    console.log(`guard: 第 ${index + 1} 档——${why}，不动。`);
    return { stage: index, outcome: 'skipped', why };
  }

  // 她还在忙：整体推迟，档位不消耗。
  if (index === 0 || done.size === 0) {
    const busy = await sheIsBusy();
    if (busy.busy && delays < CONFIG.guardBusyMaxDelays) {
      const n = bumpBusyDelays(night);
      const what = busy.what?.length ? busy.what.join('、') : '手头的事';
      logGuard({
        night,
        stage: index,
        before: st.brightness,
        outcome: 'delayed',
        detail: `她还在忙「${what}」，第 ${n} 次推迟 ${CONFIG.guardBusyDelayMinutes} 分钟`,
      });
      console.log(
        `guard: 她还在忙「${what}」，整体推迟 ${CONFIG.guardBusyDelayMinutes} 分钟（第 ${n}/${CONFIG.guardBusyMaxDelays} 次）`
      );
      return { stage: index, outcome: 'delayed', what: busy.what };
    }
  }

  // 规矩三：只往下调。
  if (st.brightness !== null && st.brightness <= target) {
    logGuard({
      night,
      stage: index,
      before: st.brightness,
      after: st.brightness,
      outcome: 'skipped',
      detail: `已经是 ${st.brightness}，比这一档的 ${target} 还暗，不往上调`,
    });
    console.log(`guard: 第 ${index + 1} 档——灯已经是 ${st.brightness}，比 ${target} 还暗，跳过。`);
    return { stage: index, outcome: 'skipped', why: '已经足够暗' };
  }

  const r = await lampBrightness(target, { source: 'guard', note: `睡前第 ${index + 1} 档` });
  if (!r.ok) {
    logGuard({ night, stage: index, before: st.brightness, outcome: 'failed', detail: r.error });
    console.error(`guard: 第 ${index + 1} 档没调成：${r.error}`);
    return { stage: index, outcome: 'failed', error: r.error };
  }

  if (CONFIG.guardWarm && (st.temp === null || st.temp > CONFIG.guardWarm)) {
    await lampTemp(CONFIG.guardWarm, { source: 'guard', note: `睡前第 ${index + 1} 档调暖` });
  }

  const isFloorStage = target <= CONFIG.guardFloor || index === plan.stages.length - 1;
  logGuard({
    night,
    stage: index,
    before: st.brightness,
    after: target,
    outcome: isFloorStage ? 'floor' : 'dimmed',
    detail: isFloorStage ? '最后一档，到此不再往下调，也不关灯' : null,
  });
  console.log(
    `guard: 第 ${index + 1}/${plan.stages.length} 档——亮度 ${st.brightness ?? '?'} → ${target}` +
      `${isFloorStage ? '（最后一档，不关灯）' : ''}`
  );

  if (index === 0 && CONFIG.guardNotify) {
    await notify(firstStageWords(st.brightness ?? '原来的亮度', target), { reason: '睡前守护第一档' });
  }

  await writeConversation(
    `（${formatDateTime(now)}）${CONFIG.lampName}按睡前守护第 ${index + 1} 档把亮度从 ${
      st.brightness ?? '?'
    } 调到 ${target}${isFloorStage ? '，到底了，不再往下调' : ''}。灯没关。`
  );

  return { stage: index, outcome: 'dimmed', before: st.brightness, after: target };
}

// 下一档什么时候、还剩几档。管理页和 MCP 都用。
export function guardPlan(now = Date.now()) {
  if (!CONFIG.guard) return { enabled: false };
  const night = nightOf(now);
  const plan = tonightPlan(now);
  const askAt = atHhMm(CONFIG.guardAskAt, now, windowCrossesMidnight() && formatDate(now) !== night ? -1 : 0);

  if (!plan) {
    return {
      enabled: true,
      night,
      decided: false,
      askAt,
      asked: getMeta(ASKED_KEY) === night,
      floor: CONFIG.guardFloor,
      windowEnd: windowEndTime(now),
      tonight: guardTonight(night),
    };
  }
  if (plan.off) {
    return { enabled: true, night, decided: true, off: true, note: plan.note, askAt, tonight: guardTonight(night) };
  }

  const done = new Set(guardStagesDone(night));
  const delays = busyDelays(night);
  const stages = plan.stages.map((target, i) => ({
    index: i,
    target,
    at: stageTime(plan, i, now, delays),
    done: done.has(i),
  }));

  return {
    enabled: true,
    night,
    decided: true,
    askAt,
    bedtime: plan.bedtime,
    note: plan.note,
    stages,
    next: stages.find((s) => !s.done) ?? null,
    delays,
    inWindow: inGuardWindow(now),
    windowEnd: windowEndTime(now),
    floor: CONFIG.guardFloor,
    tonight: guardTonight(night),
  };
}

// 说成人话。MCP 里给允朔看的就是这段。
export function guardText(now = Date.now()) {
  const plan = guardPlan(now);
  if (!plan.enabled) return '睡前守护：关着。';

  if (!plan.decided) {
    return [
      `睡前守护：今夜（${plan.night}）**还没定开始时间**。`,
      `我 ${formatTime(plan.askAt)} 会叫你一次来定${plan.asked ? '（今夜已经叫过了）' : ''}。`,
      `用 light_guard_set 定（比如 at="23:40"），定完还能改；今夜不想调就用 light_guard_skip。`,
      `**你没定之前这东西一次都不动灯**——这比猜一个时间强。`,
    ].join('\n');
  }

  if (plan.off) {
    return `睡前守护：你定了今夜（${plan.night}）不守护${plan.note ? `——${plan.note}` : ''}。想改主意就再调 light_guard_set。`;
  }

  const lines = [
    `睡前守护：你定了今夜（${plan.night}）从 ${formatTime(plan.stages[0].at)} 开始。`,
    ...plan.stages.map(
      (s) =>
        `  第 ${s.index + 1} 档 → 亮度 ${s.target}，${formatDateTime(s.at)}${s.done ? '（已经过了）' : ''}`
    ),
  ];
  if (plan.note) lines.push(`  当时记下的：${plan.note}`);
  if (plan.delays) lines.push(`  因为她还在忙，今夜整体推迟过 ${plan.delays} 次。`);
  lines.push(
    plan.next
      ? `下一档：亮度 ${plan.next.target}，${formatDateTime(plan.next.at)}。`
      : '今夜的档已经走完了。'
  );
  lines.push(`最低到 ${plan.floor} 就停。**守护从不关灯**——关灯是她自己的动作。`);
  lines.push(`还能改：再调一次 light_guard_set 就是改时间或改档位。`);
  return lines.join('\n');
}
