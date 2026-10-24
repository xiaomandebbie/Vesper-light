// 睡前守护：到点了把灯一档一档调暗。
//
// ═══ 这个文件里有三条不能改的规矩 ═══
//
// 一、**永远不关灯。**
//    这是小满明确要求的：提醒方式是调低亮度，不能直接关掉。
//    理由很实在：人还坐在那里的时候灯突然黑掉是惊吓，而渐暗是一句「不早了」。
//    所以这个文件里**没有一处调用 lampPower(false)**。不是忘了，是故意的。
//    以后改这个文件的人（包括我自己）：别加。关灯是她自己的动作。
//
// 二、**灯已经关了就什么都不做。**
//    她已经睡了。这时候去设亮度——哪怕只是设个数值——有些灯会应声点亮。
//    所以每一档动手前必须先读状态，on !== true 就跳过。
//    还有一层：状态**读不出来**（on === null）也不动。宁可该暗的夜没暗，
//    也不要在不知道灯在哪个状态的时候盲发指令。
//
// 三、**只往下调，从不往上调。**
//    灯现在已经比这一档的目标还暗（她自己调暗了，或者前一档已经到位），
//    那这一档就跳过。把灯「调到 20」在它已经是 10 的时候是把它调亮，
//    那和这东西要做的事正好相反。
//
// ═══ 其他几个设计决定 ═══
//
// 「今多」的起点按守护窗口开始那天算，所以凌晨一点那一档仍属于前一夜。
// 不这样的话过了午夜档位被重置，于是从第一档 40 重来——把已经暗到 8 的灯又调回 40。
//
// 窗口有结束时间（默认 03:00）。为什么要有：进程要是上午十点重启，
// 「今天的档一个都没走」为真，没有窗口结束的话它会立刻把白天的灯调成 8。
//
// 她还在忙一件没到点的事（问晨暮星的时间感知）就把后面几档整体推迟，
// 最多推 guardBusyMaxDelays 次。不无限推：改个 bug 改到两点也该有个人说一句不早了。
import { CONFIG } from './config.js';
import { lampStatus, lampBrightness, lampTemp } from './device.js';
import { formatDate, formatDateTime, atHhMm, wallParts } from './clock.js';
import { guardStagesDone, logGuard, guardTonight, getMeta, setMeta } from './store.js';
import { notify, writeConversation, sheIsBusy } from './bridge.js';

const BUSY_DELAY_KEY = 'guard_busy_delays';

// 窗口跳午夜吗（bedtime 23:30、windowEnd 03:00 就是跳）
const windowCrossesMidnight = () => {
  const start = CONFIG.bedtime.h * 60 + CONFIG.bedtime.m;
  const end = CONFIG.guardWindowEnd.h * 60 + CONFIG.guardWindowEnd.m;
  return end <= start;
};

// 这一刻属于哪一夜。窗口跳午夜时，凌晨那段算前一天。
// 这个函数是档位不被午夜重置的关键。
export function nightOf(ms = Date.now()) {
  const p = wallParts(ms);
  const minutes = p.h * 60 + p.mi;
  const endMinutes = CONFIG.guardWindowEnd.h * 60 + CONFIG.guardWindowEnd.m;
  if (windowCrossesMidnight() && minutes < endMinutes) {
    // 凌晨：算前一天
    return formatDate(ms - 24 * 3600000);
  }
  return formatDate(ms);
}

// 第 n 档（从 0 数）该在什么时候。bedtime + n * step，再加上「还在忙」推迟的量。
function stageTime(index, ms = Date.now(), delays = 0) {
  const night = nightOf(ms);
  // 窗口跳午夜、而现在是凌晨时，bedtime 在「昨天」
  const p = wallParts(ms);
  const isEarlyMorning = windowCrossesMidnight() && formatDate(ms) !== night;
  const base = atHhMm(CONFIG.bedtime, ms, isEarlyMorning ? -1 : 0);
  void p;
  return base + (index * CONFIG.guardStepMinutes + delays * CONFIG.guardBusyDelayMinutes) * 60000;
}

// 窗口结束时刻
function windowEndTime(ms = Date.now()) {
  const night = nightOf(ms);
  const isEarlyMorning = windowCrossesMidnight() && formatDate(ms) !== night;
  // 窗口跳午夜时，结束点在 bedtime 的次日
  return atHhMm(CONFIG.guardWindowEnd, ms, isEarlyMorning ? 0 : windowCrossesMidnight() ? 1 : 0);
}

export function inGuardWindow(ms = Date.now()) {
  const start = stageTime(0, ms, 0);
  return ms >= start && ms < windowEndTime(ms);
}

// 这一多「还在忙」已经推迟过几次
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

// 第一档调暗时说的那句话。只在第一档说，后面几档闷着做——
// 每档都叮一声就从「不早了」变成催命。
function firstStageWords(before, after) {
  return (
    `${CONFIG.lampName}已经从 ${before} 调到 ${after} 了。` +
    `不早了——我不关灯，就这样暗着陪着你。想关的时候你自己说。`
  );
}

// 跑一次守护。由 light.js 的分钟 tick 调用。
// 返回这次做了什么，只用于日志和管理页。
export async function runGuard(now = Date.now()) {
  if (!CONFIG.guard) return { skipped: '守护没开' };
  if (!inGuardWindow(now)) return { skipped: '不在守护窗口里' };

  const night = nightOf(now);
  const done = new Set(guardStagesDone(night));
  const delays = busyDelays(night);

  // 找第一个到点了、还没走过的档
  let index = -1;
  for (let i = 0; i < CONFIG.guardStages.length; i += 1) {
    if (done.has(i)) continue;
    if (stageTime(i, now, delays) <= now) {
      index = i;
      break;
    }
    // 还没到点：后面的更没到，直接走
    break;
  }
  if (index < 0) return { skipped: '还没到下一档的时间' };

  const target = CONFIG.guardStages[index];

  // 规矩二：先看灯现在怎么样。读不到就不动。
  const st = await lampStatus({ source: 'guard' });
  if (!st.ok) {
    logGuard({ night, stage: index, outcome: 'unknown', detail: `读不到状态：${st.error}` });
    console.warn(`guard: 第 ${index + 1} 档读不到灯的状态，这档不动（${st.error}）`);
    return { stage: index, outcome: 'unknown', error: st.error };
  }

  // 灯关着，或者读不出开关：什么都不做。
  // 这一档标成 skipped，不会被重试——她已经睡了，这一多的事到此结束。
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

  // 规矩三：只往下调。已经比目标暗就跳过这一档。
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

  // 真正动手：只调亮度和色温，没有关灯。
  const r = await lampBrightness(target, { source: 'guard', note: `睡前第 ${index + 1} 档` });
  if (!r.ok) {
    logGuard({ night, stage: index, before: st.brightness, outcome: 'failed', detail: r.error });
    console.error(`guard: 第 ${index + 1} 档没调成：${r.error}`);
    return { stage: index, outcome: 'failed', error: r.error };
  }

  // 顺手调暖。已经比目标还暖就不动（同样是「不往回调」）。
  if (CONFIG.guardWarm && (st.temp === null || st.temp > CONFIG.guardWarm)) {
    await lampTemp(CONFIG.guardWarm, { source: 'guard', note: `睡前第 ${index + 1} 档调暖` });
  }

  const isFloorStage = target <= CONFIG.guardFloor || index === CONFIG.guardStages.length - 1;
  logGuard({
    night,
    stage: index,
    before: st.brightness,
    after: target,
    outcome: isFloorStage ? 'floor' : 'dimmed',
    detail: isFloorStage ? '最后一档，到此不再往下调，也不关灯' : null,
  });
  console.log(
    `guard: 第 ${index + 1}/${CONFIG.guardStages.length} 档——亮度 ${st.brightness ?? '?'} → ${target}` +
      `${isFloorStage ? '（最后一档，不关灯）' : ''}`
  );

  // 只在第一档说话。
  if (index === 0 && CONFIG.guardNotify) {
    const words = firstStageWords(st.brightness ?? '原来的亮度', target);
    await notify(words, { reason: '睡前守护第一档' });
  }

  // 每一档都往对话记录里写一行，这样允朔下次醒来知道灯自己暗过了，
  // 她问「灯怎么暗了」的时候他不至于装傻。这不走通知，不响。
  await writeConversation(
    `（${formatDateTime(now)}）${CONFIG.lampName}按睡前守护第 ${index + 1} 档把亮度从 ${
      st.brightness ?? '?'
    } 调到 ${target}${isFloorStage ? '，到底了，不再往下调' : ''}。灯没关。`
  );

  return { stage: index, outcome: 'dimmed', before: st.brightness, after: target };
}

// 下一档什么时候、还剩几档。管理页和 MCP 的 light_guard 工具用。
export function guardPlan(now = Date.now()) {
  if (!CONFIG.guard) return { enabled: false };
  const night = nightOf(now);
  const done = new Set(guardStagesDone(night));
  const delays = busyDelays(night);

  const stages = CONFIG.guardStages.map((target, i) => ({
    index: i,
    target,
    at: stageTime(i, now, delays),
    done: done.has(i),
  }));
  const next = stages.find((s) => !s.done) ?? null;

  return {
    enabled: true,
    night,
    stages,
    next,
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

  const lines = [
    `睡前守护：开着。今多（${plan.night}）的档：`,
    ...plan.stages.map(
      (s) =>
        `  第 ${s.index + 1} 档 → 亮度 ${s.target}，${formatDateTime(s.at)}${s.done ? '（已经过了）' : ''}`
    ),
  ];

  if (plan.delays) lines.push(`  因为她还在忙，今多整体推迟过 ${plan.delays} 次。`);
  lines.push(
    plan.next
      ? `下一档：亮度 ${plan.next.target}，${formatDateTime(plan.next.at)}。`
      : '今多的档已经走完了。'
  );
  lines.push(`最低到 ${plan.floor} 就停。**守护从不关灯**——关灯是她自己的动作。`);
  lines.push(`灯已经关着的时候守护什么都不做（她睡了，那时候去设亮度可能把灯点亮）。`);
  return lines.join('\n');
}
