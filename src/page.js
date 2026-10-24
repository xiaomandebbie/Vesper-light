// 管理页 /lamp。手机上能直接点的那一页。
//
// ── 为什么要有这个页 ──
// 小满不该为了把灯调暗一点而必须先跟允朔说一句话。
// 而且「灯现在到底是什么状态、守护今夜走到哪了、谁动的」这些事
// 看一眼比问一句快。
//
// ── 配色：和晨暮星一致，早晨两套 ──
//
// 第一版这里是深棕色（--bg: #14110f），打算靠晨暮星那边的转发层提 CSS 盖掉。
// 那是错的：两边的变量名（--card、--ink、--muted）正好撞上，
// 所以 var(--card, 淡色兜底) 里的兜底永远用不上——变量有值，只是它是深棕色。
// 结果就是她看到的那一屏：整页深棕，和晨暮星完全不是一回事。
//
// 现在改成这边自己就是晨暮星的淡色调，不靠外面打补丁：
//   白天：粉紫渐变底 + 奶白卡片 + 紫棕色字，强调色是玑紫 #7a3e5d
//   夜里：深紫底 + 半透卡片 + 浅色字
// 两套走 prefers-color-scheme，单独打开（3003 直连）时跟系统深浅色；
// 从晨暮星转发进来时，FACE_CSS 挂在 html[data-face] 上、特指度更高，
// 会把这里的颜色覆掉，跟着长沙的日出日落走——正是我要的：
// 单独看也好看，嵌进晨暮星就和她那边一模一样。
//
// ── 安全 ──
// 没设 LIGHT_BASIC_USER / PASS 就**整个页不开**，而不是开一个不要密码的控制页。
// 这是一个能动家里硬件的页面，没密码被人扒到就是别人能半夜开她屋里的灯。
// 宁可少一个页，不要这个风险。
import crypto from 'crypto';
import { CONFIG, BRIGHTNESS_MIN, BRIGHTNESS_MAX, TEMP_MIN, TEMP_MAX } from './config.js';
import { lampStatus, lampPower, lampBrightness, lampTemp, ping } from './device.js';
import { applyScene, SCENES } from './scenes.js';
import { createSchedule, describeSchedule, repeatText, cancelSchedule, pendingSchedules } from './schedule.js';
import { guardPlan, decideTonight, skipTonight, resetTonight } from './guard.js';
import { recentLogs } from './store.js';
import { formatDateTime, formatTime, inWords } from './clock.js';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// 定长比较，和 MCP 那边同一个理由
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function basicAuth(req, res, next) {
  const m = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
  if (m) {
    const [user, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    if (safeEqual(user, CONFIG.basicUser) && safeEqual(rest.join(':'), CONFIG.basicPass)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="vesper-light"');
  return res.status(401).send('要登录');
}

// 晨暮星的配色。变量名故意跟晨暮星对齐（--ink / --card / --muted / --rose 这些），
// 这样从那边转发进来时它的 FACE_CSS 能直接接管，不必再写一层桥。
const STYLE = `
:root {
  --bg1: #efe7f4; --bg2: #f9f0ee; --bg3: #fdf8f2;
  --ink: #2b2233; --muted: #665a70; --faint: #a597ab;
  --card: rgba(255, 253, 251, 0.92);
  --line: rgba(122, 62, 93, 0.14);
  --rose: #9b4a7a; --rose-deep: #7a3e5d; --gold: #b7792f;
  --cool: #4a7fa5; --bad: #c0506a;
  --tint: rgba(122, 62, 93, 0.1);
  --shadow: 0 10px 28px rgba(90, 50, 80, 0.12);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg1: #1a1626; --bg2: #221b2e; --bg3: #2a2033;
    --ink: #f2e9e1; --muted: #a89bb0; --faint: #7d7088;
    --card: rgba(255, 253, 251, 0.07);
    --line: rgba(255, 255, 255, 0.13);
    --rose: #d59bbd; --rose-deep: #e2a6c4; --gold: #f0b458;
    --cool: #8fc0dd; --bad: #e8899b;
    --tint: rgba(226, 166, 196, 0.14);
    --shadow: 0 10px 28px rgba(0, 0, 0, 0.3);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 16px 14px 40px;
  background: linear-gradient(180deg, var(--bg1) 0%, var(--bg2) 55%, var(--bg3) 100%) fixed;
  color: var(--ink);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
  max-width: 560px; margin-inline: auto;
  -webkit-font-smoothing: antialiased;
}
/* 标题：跟晨暮星那套走——苹方超细 + 大字距，不要粗黑居中那种死沉 */
h1 {
  font-weight: 200; font-size: 26px; letter-spacing: 0.36em; padding-left: 0.36em;
  margin: 6px 0 18px; padding-right: 56px; color: var(--rose-deep);
}
h2 { font-size: 14px; margin: 0 0 12px; color: var(--rose); font-weight: 600; letter-spacing: 0.08em; }
.card {
  background: var(--card); border: 1px solid var(--line); border-radius: 16px;
  padding: 15px; margin-bottom: 13px; box-shadow: var(--shadow);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
.now { font-size: 17px; margin-bottom: 4px; }
.dim { color: var(--muted); font-size: 13px; }
.bad { color: var(--bad); }
.row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 11px; }
button, .btn {
  appearance: none; cursor: pointer; font: inherit; font-size: 14px;
  background: var(--card); color: var(--ink); border: 1px solid var(--line);
  border-radius: 11px; padding: 9px 14px; min-height: 42px;
  transition: background 0.15s ease, border-color 0.15s ease;
}
button:active { background: var(--tint); }
button.on { border-color: var(--gold); color: var(--gold); }
button.off { border-color: var(--line); color: var(--muted); }
button.go { border-color: var(--rose); color: var(--rose); }
button.wide { flex: 1; min-width: 92px; }
label { display: block; font-size: 13px; color: var(--muted); margin: 12px 0 4px; }
input[type=range] { width: 100%; height: 40px; accent-color: var(--rose); }
input[type=text], input[type=number], select {
  width: 100%; font: inherit; padding: 9px 10px; border-radius: 11px;
  background: var(--card); color: var(--ink); border: 1px solid var(--line); min-height: 42px;
}
input::placeholder { color: var(--faint); }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
td { padding: 7px 4px; border-bottom: 1px solid var(--line); vertical-align: top; }
td.t { color: var(--muted); white-space: nowrap; width: 1%; }
.stage { display: flex; justify-content: space-between; padding: 5px 0; font-size: 14px; }
.stage.done { color: var(--muted); }
.note { font-size: 12px; color: var(--muted); margin-top: 11px; line-height: 1.55; }
.tag {
  display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: var(--tint); color: var(--rose); margin-left: 6px;
}
form { margin: 0; }
.flash { border-color: var(--rose); }
`;

function renderStatus(st) {
  if (!st.ok) return `<div class="now bad">灯的状态没读到</div><div class="dim">${esc(st.error)}</div>`;
  const power = st.on === true ? '开着' : st.on === false ? '关着' : '开关读不出来';
  const bits = [];
  if (st.brightness !== null) bits.push(`亮度 ${st.brightness}`);
  if (st.temp !== null) bits.push(`色温 ${st.temp}K`);
  return (
    `<div class="now">${esc(st.name || CONFIG.lampName)} · ${power}</div>` +
    `<div class="dim">${bits.join('、') || '读不到亮度和色温'}</div>`
  );
}

// 睡前守护那张卡。三种状态：还没定 / 定了不守 / 定了几点开始。
function renderGuard(plan) {
  if (!plan.enabled) return '<div class="dim">睡前守护关着。</div>';

  if (!plan.decided) {
    return (
      `<div class="now">今夜还没定<span class="tag">等允朔</span></div>` +
      `<div class="dim" style="margin-top:6px">` +
      `${formatTime(plan.askAt)} 会叫允朔来定今夜从几点开始${plan.asked ? '（今夜已经叫过了）' : ''}。` +
      `</div>` +
      `<div class="note">他没定之前这东西一次都不动灯。你也可以自己在下面定一个。</div>` +
      guardForm(plan)
    );
  }

  if (plan.off) {
    return (
      `<div class="now">今夜不守护<span class="tag">允朔定的</span></div>` +
      `${plan.note ? `<div class="dim" style="margin-top:6px">${esc(plan.note)}</div>` : ''}` +
      guardForm(plan)
    );
  }

  const stages = plan.stages
    .map(
      (s) =>
        `<div class="stage${s.done ? ' done' : ''}"><span>第 ${s.index + 1} 档 → 亮度 ${s.target}</span>` +
        `<span>${formatTime(s.at)}${s.done ? ' 已过' : ''}</span></div>`
    )
    .join('');
  const next = plan.next
    ? `下一档：亮度 ${plan.next.target}，${formatTime(plan.next.at)}（${inWords(plan.next.at)}）`
    : '今夜的档已经走完了';
  const delayed = plan.delays ? `· 因为你还在忙，推迟过 ${plan.delays} 次` : '';

  return (
    `<div class="now">今夜从 ${formatTime(plan.stages[0].at)} 开始<span class="tag">允朔定的</span></div>` +
    `${plan.note ? `<div class="dim" style="margin-top:6px">${esc(plan.note)}</div>` : ''}` +
    `<div style="margin-top:10px">${stages}</div>` +
    `<div class="dim" style="margin-top:8px">${esc(next)} ${esc(delayed)}</div>` +
    `<div class="note">最低到 ${plan.floor} 就停。守护从不关灯——关灯是你自己的动作。` +
    `灯已经关着时守护什么都不做。</div>` +
    guardForm(plan)
  );
}

// 你也能自己定 / 改 / 撒。允朔定的和你定的存在同一处，互相覆盖——
// 不分两本账：那样两边说两种话的时候没人说得清到底几点开始。
function guardForm(plan) {
  return (
    `<form method="post" action="/lamp/do" style="margin-top:12px">` +
    `<input type="hidden" name="act" value="guard_set">` +
    `<div class="grid2">` +
    `<div><label>今夜从几点开始</label><input type="text" name="at" placeholder="23:40" required></div>` +
    `<div><label>档位（可空）</label><input type="text" name="stages" placeholder="40,20,8"></div>` +
    `</div>` +
    `<div class="row"><button class="wide go" type="submit">${plan.decided ? '改成这个' : '定下来'}</button>` +
    `</form>` +
    `<form method="post" action="/lamp/do" style="flex:1"><input type="hidden" name="act" value="guard_skip">` +
    `<button class="wide off" type="submit">今夜不守护</button></form>` +
    `${plan.decided ? `<form method="post" action="/lamp/do" style="flex:1"><input type="hidden" name="act" value="guard_reset">` +
      `<button class="wide" type="submit">撒掉，重新问他</button></form>` : ''}` +
    `</div>`
  );
}

function page({ st, plan, logs, pending, flash }) {
  const sceneButtons = Object.entries(SCENES)
    .map(
      ([name, s]) =>
        `<form method="post" action="/lamp/do" style="flex:1;min-width:92px">` +
        `<input type="hidden" name="act" value="scene"><input type="hidden" name="scene" value="${esc(name)}">` +
        `<button class="wide" type="submit" title="亮度 ${s.brightness}、色温 ${s.temp}K">${esc(name)}</button></form>`
    )
    .join('');

  const logRows = logs
    .map((r) => {
      const label =
        { on: '开灯', off: '关灯', brightness: '亮度', color_temp: '色温', status: '查状态', list_devices: '列设备' }[r.action] ??
        r.action;
      const from = { mcp: '工具', schedule: '定时', guard: '守护', page: '页面', bridge: '晨暮星' }[r.source] ?? r.source;
      const v = r.value === null ? '' : ` → ${r.value}`;
      const bad = r.ok ? '' : ` <span class="bad">没成</span>`;
      return `<tr><td class="t">${formatTime(r.ts)}</td><td>[${esc(from)}] ${esc(label)}${v}${bad}${
        r.note ? `<div class="dim">${esc(r.note)}</div>` : ''
      }</td></tr>`;
    })
    .join('');

  const pendingRows = pending.length
    ? pending
        .map(
          (row) =>
            `<tr><td class="t">#${row.id}<br>${formatTime(row.run_at)}</td><td>` +
            `${esc(describeSchedule(row))} · ${esc(repeatText(row))}` +
            `<div class="dim">${esc(formatDateTime(row.run_at))}（${esc(inWords(row.run_at))}）</div>` +
            `${row.note ? `<div class="dim">${esc(row.note)}</div>` : ''}</td>` +
            `<td class="t"><form method="post" action="/lamp/do">` +
            `<input type="hidden" name="act" value="cancel"><input type="hidden" name="id" value="${row.id}">` +
            `<button type="submit" class="off">撒</button></form></td></tr>`
        )
        .join('')
    : '<tr><td class="dim">一个定时都没有。</td></tr>';

  const brightnessNow = st.ok && st.brightness !== null ? st.brightness : 50;
  const tempNow = st.ok && st.temp !== null ? st.temp : 3500;

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(CONFIG.lampName)}</title>
<style>${STYLE}</style>
</head><body>
<h1>${esc(CONFIG.lampName)}</h1>

<div class="card${flash ? ' flash' : ''}">
  ${renderStatus(st)}
  ${flash ? `<div class="dim" style="margin-top:8px">${esc(flash)}</div>` : ''}
  <div class="row">
    <form method="post" action="/lamp/do" style="flex:1"><input type="hidden" name="act" value="on">
      <button class="wide on" type="submit">开灯</button></form>
    <form method="post" action="/lamp/do" style="flex:1"><input type="hidden" name="act" value="off">
      <button class="wide off" type="submit">关灯</button></form>
    <form method="post" action="/lamp/do" style="flex:1"><input type="hidden" name="act" value="dim">
      <button class="wide" type="submit">调暗一档</button></form>
  </div>
  <div class="note">「调暗一档」不会关灯，最低到 ${CONFIG.guardFloor} 就停。</div>
</div>

<div class="card">
  <h2>亮度和色温</h2>
  <form method="post" action="/lamp/do">
    <input type="hidden" name="act" value="brightness">
    <label>亮度（${BRIGHTNESS_MIN}–${BRIGHTNESS_MAX}）</label>
    <input type="range" name="value" min="${BRIGHTNESS_MIN}" max="${BRIGHTNESS_MAX}" value="${brightnessNow}"
      oninput="this.form.querySelector('output').textContent=this.value">
    <div class="row"><output>${brightnessNow}</output><button class="wide" type="submit">调亮度</button></div>
  </form>
  <form method="post" action="/lamp/do" style="margin-top:14px">
    <input type="hidden" name="act" value="temp">
    <label>色温（${TEMP_MIN} 暖 – ${TEMP_MAX} 冷）</label>
    <input type="range" name="value" min="${TEMP_MIN}" max="${TEMP_MAX}" step="100" value="${tempNow}"
      oninput="this.form.querySelector('output').textContent=this.value+'K'">
    <div class="row"><output>${tempNow}K</output><button class="wide" type="submit">调色温</button></div>
  </form>
</div>

<div class="card">
  <h2>场景</h2>
  <div class="row">${sceneButtons}</div>
</div>

<div class="card">
  <h2>睡前守护</h2>
  ${renderGuard(plan)}
</div>

<div class="card">
  <h2>定时</h2>
  <form method="post" action="/lamp/do">
    <input type="hidden" name="act" value="schedule">
    <div class="grid2">
      <div><label>时间</label><input type="text" name="at" placeholder="07:00" required></div>
      <div><label>做什么</label><select name="action">
        <option value="on">开灯</option>
        <option value="off">关灯</option>
        <option value="brightness">调亮度</option>
        <option value="color_temp">调色温</option>
        <option value="scene">套场景</option>
      </select></div>
      <div><label>数值 / 场景</label><input type="text" name="value" placeholder="亮度 40，或场景名"></div>
      <div><label>重复</label><select name="repeat">
        <option value="none">只一次</option>
        <option value="daily">每天</option>
      </select></div>
    </div>
    <label>备注（可选）</label><input type="text" name="note" placeholder="这个定时是怎么来的">
    <div class="row"><button class="wide" type="submit">排上</button></div>
  </form>
  <table style="margin-top:12px">${pendingRows}</table>
</div>

<div class="card">
  <h2>最近谁动过灯</h2>
  <table>${logRows || '<tr><td class="dim">还没有记录。</td></tr>'}</table>
  <div class="note">在米家 App 里手动按的不会出现在这里（没经过本服务）。</div>
</div>

<div class="dim" style="text-align:center;font-size:12px">${esc(formatDateTime(Date.now()))}</div>
</body></html>`;
}

export function registerPage(app) {
  if (!CONFIG.basicUser || !CONFIG.basicPass) {
    console.log('page: 没设 LIGHT_BASIC_USER / LIGHT_BASIC_PASS，/lamp 管理页没开');
    return { enabled: false };
  }

  app.get('/lamp', basicAuth, async (req, res) => {
    const st = await lampStatus({ source: 'page' });
    res.set('content-type', 'text/html; charset=utf-8').send(
      page({
        st,
        plan: guardPlan(),
        logs: recentLogs(12),
        pending: pendingSchedules(),
        flash: typeof req.query.msg === 'string' ? req.query.msg.slice(0, 200) : '',
      })
    );
  });

  // 所有动作走同一个 POST，完事重定向回 /lamp（PRG）——
  // 这样手机上下拉刷新不会把同一个动作再发一遍。
  app.post('/lamp/do', basicAuth, async (req, res) => {
    const b = req.body ?? {};
    const act = String(b.act ?? '');
    let msg = '';

    try {
      switch (act) {
        case 'on': {
          const r = await lampPower(true, { source: 'page' });
          msg = r.ok ? '灯开了' : `开灯没成：${r.error}`;
          break;
        }
        case 'off': {
          const before = await lampStatus({ source: 'page' });
          if (before.ok && before.on === false) {
            msg = '灯本来就关着';
            break;
          }
          const r = await lampPower(false, { source: 'page' });
          msg = r.ok ? '灯关了' : `关灯没成：${r.error}`;
          break;
        }
        case 'dim': {
          const st = await lampStatus({ source: 'page' });
          if (!st.ok) {
            msg = `读不到状态，没动：${st.error}`;
            break;
          }
          if (st.on !== true) {
            msg = st.on === false ? '灯已经关着，不用调暗' : '读不出开关，没动';
            break;
          }
          const from = st.brightness ?? 50;
          const target = Math.max(CONFIG.guardFloor, from - 20);
          if (target >= from) {
            msg = `已经是 ${from}，到底了`;
            break;
          }
          const r = await lampBrightness(target, { source: 'page', note: '页面调暗一档' });
          msg = r.ok ? `亮度 ${from} → ${target}，灯没关` : `没调成：${r.error}`;
          break;
        }
        case 'brightness': {
          const r = await lampBrightness(b.value, { source: 'page' });
          msg = r.ok ? `亮度调到 ${r.value}` : `没调成：${r.error}`;
          break;
        }
        case 'temp': {
          const r = await lampTemp(b.value, { source: 'page' });
          msg = r.ok ? `色温调到 ${r.value}K` : `没调成：${r.error}`;
          break;
        }
        case 'scene': {
          const r = await applyScene(b.scene, { source: 'page' });
          msg = r.ok ? r.message : r.error;
          break;
        }
        case 'guard_set': {
          const out = decideTonight({ at: b.at, stages: b.stages || null, note: '她在页面上定的' });
          msg = out.error ? out.error : `今夜从 ${b.at} 开始，档位 ${out.plan.stages.join(' → ')}`;
          break;
        }
        case 'guard_skip': {
          skipTonight({ note: '她在页面上关的' });
          msg = '今夜不守护了';
          break;
        }
        case 'guard_reset': {
          resetTonight();
          msg = '今夜的安排撒了，下次会重新问允朔';
          break;
        }
        case 'schedule': {
          const action = String(b.action ?? '');
          const raw = String(b.value ?? '').trim();
          const out = createSchedule(
            {
              at: b.at,
              action,
              value: action === 'brightness' || action === 'color_temp' ? Number(raw) : undefined,
              scene: action === 'scene' ? raw : undefined,
              repeat: b.repeat,
              note: b.note,
            },
            { source: 'page' }
          );
          msg = out.error ? out.error : `排好了 #${out.id}，${formatDateTime(out.row.run_at)}`;
          break;
        }
        case 'cancel': {
          const id = Number(b.id);
          msg = Number.isInteger(id) && cancelSchedule(id) ? `撒了 #${id}` : '没撒成（可能已经执行或撒过了）';
          break;
        }
        default:
          msg = '不认识的动作';
      }
    } catch (err) {
      console.error('page: 动作出错', err.message);
      msg = `出错：${err.message}`;
    }

    res.redirect(303, `/lamp?msg=${encodeURIComponent(msg)}`);
  });

  // 给脚本和快捷指令用的纯 JSON
  app.get('/lamp/api/status', basicAuth, async (req, res) => {
    const st = await lampStatus({ source: 'page' });
    const health = await ping();
    res.json({
      ok: st.ok,
      lamp: CONFIG.lampName,
      on: st.on,
      brightness: st.brightness,
      temp: st.temp,
      raw: st.raw,
      backend: health.ok ? 'up' : `down: ${health.error}`,
      guard: guardPlan(),
      pending: pendingSchedules().map((r) => ({
        id: r.id,
        run_at: r.run_at,
        what: describeSchedule(r),
        repeat: repeatText(r),
      })),
    });
  });

  return { enabled: true };
}
