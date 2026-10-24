// 管理页 /lamp。手机上能直接点的那一页。
//
// ── 为什么要有这个页 ──
// 小满不该为了把灯调暗一点而必须先跟允朔说一句话。
// 而且「灯现在到底是什么状态、守护今多走到哪了、谁动的」这些事
// 看一眼比问一句快。
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
import { guardPlan } from './guard.js';
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

const STYLE = `
:root {
  --bg: #14110f; --card: #1f1a17; --line: #342c27;
  --text: #f2e9e1; --dim: #a8988c; --warm: #f0b458; --cool: #7fb2d6; --bad: #e07a5f;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 16px 14px 40px;
  background: var(--bg); color: var(--text);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
  max-width: 560px; margin-inline: auto;
}
h1 { font-size: 19px; margin: 4px 0 16px; font-weight: 600; }
h2 { font-size: 15px; margin: 0 0 10px; color: var(--warm); font-weight: 600; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px; margin-bottom: 14px; }
.now { font-size: 17px; margin-bottom: 4px; }
.dim { color: var(--dim); font-size: 13px; }
.bad { color: var(--bad); }
.row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
button, .btn {
  appearance: none; cursor: pointer; font: inherit; font-size: 14px;
  background: #2b2420; color: var(--text); border: 1px solid var(--line);
  border-radius: 10px; padding: 9px 14px; min-height: 42px;
}
button:active { background: #3a302a; }
button.on { border-color: var(--warm); color: var(--warm); }
button.off { border-color: #4a3f39; color: var(--dim); }
button.wide { flex: 1; min-width: 92px; }
label { display: block; font-size: 13px; color: var(--dim); margin: 12px 0 4px; }
input[type=range] { width: 100%; height: 40px; accent-color: var(--warm); }
input[type=text], input[type=number], select {
  width: 100%; font: inherit; padding: 9px 10px; border-radius: 10px;
  background: #2b2420; color: var(--text); border: 1px solid var(--line); min-height: 42px;
}
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
td { padding: 6px 4px; border-bottom: 1px solid var(--line); vertical-align: top; }
td.t { color: var(--dim); white-space: nowrap; width: 1%; }
.stage { display: flex; justify-content: space-between; padding: 4px 0; font-size: 14px; }
.stage.done { color: var(--dim); }
.note { font-size: 12px; color: var(--dim); margin-top: 10px; line-height: 1.5; }
form { margin: 0; }
.flash { border-color: var(--warm); }
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

function renderGuard(plan) {
  if (!plan.enabled) return '<div class="dim">睡前守护关着。</div>';
  const stages = plan.stages
    .map(
      (s) =>
        `<div class="stage${s.done ? ' done' : ''}"><span>第 ${s.index + 1} 档 → 亮度 ${s.target}</span>` +
        `<span>${formatTime(s.at)}${s.done ? ' 已过' : ''}</span></div>`
    )
    .join('');
  const next = plan.next
    ? `下一档：亮度 ${plan.next.target}，${formatTime(plan.next.at)}（${inWords(plan.next.at)}）`
    : '今多的档已经走完了';
  const delayed = plan.delays ? `· 因为她还在忙，推迟过 ${plan.delays} 次` : '';
  return (
    stages +
    `<div class="dim" style="margin-top:8px">${esc(next)} ${esc(delayed)}</div>` +
    `<div class="note">最低到 ${plan.floor} 就停。守护从不关灯——关灯是你自己的动作。` +
    `灯已经关着时守护什么都不做。</div>`
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
<meta name="color-scheme" content="dark">
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
