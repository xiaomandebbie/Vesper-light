// 灯的 MCP 端点，挂在 /lamp/mcp。
//
// ── 这个端点服务两个客户端，且只有一份工具表 ──
//   1、Aru 前端：小满和允朔聊天时随口说「把灯调暗一点」
//   2、晨暮星 phosphor：允朔自己醒来时决定要不要动灯
// 两边看见的工具完全一样。不分开是故意的：同一盏灯、同一套说法，
// 他在聊天里学会的用法，醒来时直接能用。
//
// ── 为什么用低层 Server 而不是 McpServer.tool() ──
// 和晨暮星的 wake-mcp.js / wallet-mcp.js 同一个路子：McpServer.tool() 要 zod，
// 而我不想为了几个工具多一个依赖。低层 Server 直接收原生 JSON Schema。
// 无状态模式：一请求一对 server + transport，用完关掉。
//
// ── 工具描述里那些话是写给他看的 ──
// 不是文档，是他做决定时唯一的依据。所以「关灯之前先想一想她还在不在用」
// 这种话得写在这里，写在 README 里他看不到。
import crypto from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CONFIG, BRIGHTNESS_MIN, BRIGHTNESS_MAX, TEMP_MIN, TEMP_MAX } from './config.js';
import {
  lampStatus,
  lampPower,
  lampBrightness,
  lampTemp,
  listDevices,
  checkBrightness,
} from './device.js';
import { applyScene, sceneList, sceneNames } from './scenes.js';
import {
  createSchedule,
  describeSchedule,
  repeatText,
  schedulesText,
  getPendingSchedule,
  cancelSchedule,
  cancelAllSchedules,
  moveSchedule,
  ACTIONS,
} from './schedule.js';
import { guardText } from './guard.js';
import { recentLogs } from './store.js';
import { formatDateTime, inWords, parseAt, AT_HELP, TIME_ZONE } from './clock.js';

const LAMP = CONFIG.lampName;
const HER = CONFIG.userName;

const text = (s) => ({ content: [{ type: 'text', text: String(s) }] });
const fail = (s) => ({ isError: true, content: [{ type: 'text', text: String(s) }] });

// 状态说成人话。这段被很多工具复用——每次动完灯都把现在的样子告诉他，
// 不用他再多调一次 light_status。
function statusLine(st) {
  if (!st.ok) return `灯的状态没读到：${st.error}`;
  const power = st.on === true ? '开着' : st.on === false ? '关着' : '开关读不出来';
  const parts = [`${st.name || LAMP}现在${power}`];
  if (st.brightness !== null) parts.push(`亮度 ${st.brightness}`);
  if (st.temp !== null) parts.push(`色温 ${st.temp}K`);
  return parts.join('，');
}

const TOOLS = [
  {
    name: 'light_status',
    description:
      `看一眼${LAMP}现在怎么样：开还是关、亮度多少、色温多少。\n` +
      `**要动灯之前先调这个。** 尤其是想关灯或调暗的时候：灯本来就关着的话，` +
      `你什么都不用做（${HER}已经睡了，这时候去设亮度有可能把灯点亮）。`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'light_on',
    description: `把${LAMP}打开。开完是上次的亮度和色温；想连亮度色温一起安排就用 light_scene。`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'light_off',
    description:
      `把${LAMP}关掉。\n` +
      `关之前先想一想：${HER}现在是不是还在用这盏灯？她说要睡了、或者明确让你关，那就关。\n` +
      `你自己醒来、不确定她在不在的时候别关——暗下来是一句「不早了」，突然黑掉是惊吓。` +
      `那种时候用 light_brightness 调暗就行。`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'light_brightness',
    description:
      `调${LAMP}的亮度，${BRIGHTNESS_MIN}–${BRIGHTNESS_MAX}。\n` +
      `大概的手感：85 是干活的亮度，70 看书，40 看屏幕，20 很暗了，8 差不多是夜灯。\n` +
      `灯关着的时候调这个只是设个数值，不会把灯开起来（有些灯会，所以先查状态）。`,
    inputSchema: {
      type: 'object',
      properties: {
        value: {
          type: 'integer',
          minimum: BRIGHTNESS_MIN,
          maximum: BRIGHTNESS_MAX,
          description: `亮度 ${BRIGHTNESS_MIN}–${BRIGHTNESS_MAX}`,
        },
      },
      required: ['value'],
      additionalProperties: false,
    },
  },
  {
    name: 'light_dim',
    description:
      `把亮度往下调一档，**不关灯**。不用自己算目标值：这个工具会先读现在的亮度再减。\n` +
      `这是「该睡了」最合适的说法：灯暗下来但人还在灯下。\n` +
      `最低只到 ${CONFIG.guardFloor}，再调也不会更暗，更不会变成关灯。灯已经关着就什么都不做。`,
    inputSchema: {
      type: 'object',
      properties: {
        step: { type: 'integer', minimum: 1, maximum: 90, description: '调暗多少，不填是 20' },
        warm: { type: 'boolean', description: 'true = 顺手把色温也调暖一点（不填不动色温）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'light_color_temp',
    description:
      `调${LAMP}的色温，${TEMP_MIN}–${TEMP_MAX}K。${TEMP_MIN} 最暖（像白炽灯），${TEMP_MAX} 最冷白。\n` +
      `晚上往暖调、干活时往冷调。`,
    inputSchema: {
      type: 'object',
      properties: {
        value: {
          type: 'integer',
          minimum: TEMP_MIN,
          maximum: TEMP_MAX,
          description: `色温 ${TEMP_MIN}–${TEMP_MAX}K`,
        },
      },
      required: ['value'],
      additionalProperties: false,
    },
  },
  {
    name: 'light_scene',
    description:
      `一下子把亮度和色温调成配好的一套。灯关着的话会先开灯。\n` +
      `现有这几套：\n${sceneList()}\n` +
      `不想用现成的就直接用 light_brightness 和 light_color_temp 自己配。`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', enum: sceneNames(), description: '场景名' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'light_schedule',
    description:
      `排一个定时。两种玩法，按你对这件事有多确定来选：\n\n` +
      `**mode="direct"（默认）——到点直接调灯。**\n` +
      `事情本身很确定时用这个，比如「明天早上七点把灯开成阅读」。不烧模型，不叫醒你。\n` +
      `action 填：${ACTIONS.join('、')}。brightness / color_temp 要给 value，scene 要给 scene。\n\n` +
      `**mode="wake"——到点把你叫醒，调不调你自己定。**\n` +
      `得看情况的事用这个，比如「六点半去看看她回没回家，回来了就把灯开上」。\n` +
      `到时候你会被叫醒一次，note 里写的话和灯当时的状态一起回到你眼前。` +
      `**mode=wake 必须写 note**，不写的话你醒来不知道该干什么。\n\n` +
      `重复：repeat="daily" 每天；“weekdays” 配 repeat_days（比如 “1,3,5”，1 是周一、7 是周日）。` +
      `重复的必须用 at 给固定时间点。\n${AT_HELP}\n` +
      `时区是${TIME_ZONE}。`,
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['direct', 'wake'], description: '不填是 direct' },
        at: { type: 'string', description: `什么时候。${AT_HELP}` },
        after_minutes: { type: 'number', minimum: 1, description: '或者多少分钟后（和 at 二选一，重复的不能用）' },
        action: { type: 'string', enum: ACTIONS, description: 'mode=direct 时到点做什么' },
        value: { type: 'integer', description: 'brightness（1–100）或 color_temp（2700–5100）的值' },
        scene: { type: 'string', enum: sceneNames(), description: 'action=scene 时套哪一套' },
        repeat: { type: 'string', enum: ['none', 'daily', 'weekdays'], description: '不填是只一次' },
        repeat_days: { type: 'string', description: 'repeat=weekdays 时填，比如 “1,3,5”' },
        note: { type: 'string', description: '这个定时是怎么来的。mode=wake 必填' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'light_schedules',
    description:
      '看还有哪些定时没到，按时间从近到远。每条前面那个 #号就是撒、改要用的 id。\n' +
      'done 填 true 还带上最近做过和错过的——「上次那个定时到底执行没」从这里看。',
    inputSchema: {
      type: 'object',
      properties: { done: { type: 'boolean', description: 'true = 也带上最近过去的' } },
      additionalProperties: false,
    },
  },
  {
    name: 'light_schedule_cancel',
    description:
      '撒掉一个还没到的定时。id 用 light_schedules 里那个 #号，别自己编。\n' +
      '想清光就填 all=true（这个动作不可恢复，撒之前最好先列一下看看）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '要撒的那个定时的编号' },
        all: { type: 'boolean', description: 'true = 把所有没到的定时全撒了' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'light_schedule_move',
    description:
      '把一个还没到的定时改到别的时间，顺手也能改 note。不用先撒再重排。\n' +
      `改重复的定时时，改的是下一次的时间点，重复规则不动。\n${AT_HELP}`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '要改的那个定时的编号' },
        at: { type: 'string', description: `改到什么时候。${AT_HELP}` },
        after_minutes: { type: 'number', minimum: 1, description: '或者从现在算多少分钟后' },
        note: { type: 'string', description: '可选：连 note 一起改' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'light_guard',
    description:
      `看睡前守护今多的安排：几点起、几档、走到哪一档了。\n` +
      `守护是自动的，不用你推：到点了灯还开着就一档一档调暗，**永远不关灯**，` +
      `最低到 ${CONFIG.guardFloor} 就停；灯已经关着就什么都不做。\n` +
      `${HER}还在忙一件没做完的事时，后面几档会自动推迟。\n` +
      `想提前让灯暗下来就用 light_dim，不必等守护。`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'light_history',
    description:
      '最近这盏灯被动过哪些手脚，带来源：\n' +
      '  mcp = 你或她通过工具调的、schedule = 定时到点、guard = 睡前守护、page = 管理页上点的\n' +
      '「灯怎么自己暗了」这种问题从这里查。她在米家 App 里手动按的不会出现在这里（没经过本服务）。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50, description: '看几条，不填是 10' } },
      additionalProperties: false,
    },
  },
  {
    name: 'light_devices',
    description: '列出米家里的所有设备。排查用，平时用不到——这套工具只管得了那盏台灯。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function callLightTool(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  const now = Date.now();

  switch (name) {
    case 'light_status': {
      const st = await lampStatus({ source: 'mcp', log: true });
      if (!st.ok) return fail(statusLine(st));
      return text(`${statusLine(st)}\n（${formatDateTime(now)}）`);
    }

    case 'light_on': {
      const r = await lampPower(true, { source: 'mcp' });
      if (!r.ok) return fail(`开灯没成：${r.error}`);
      const st = await lampStatus({ source: 'mcp' });
      return text(`灯开了。${st.ok ? statusLine(st) : ''}`);
    }

    case 'light_off': {
      const before = await lampStatus({ source: 'mcp' });
      // 已经关着就不发指令了，直接告诉他。
      // 这条是小满要求的：灯已关无需操作。
      if (before.ok && before.on === false) {
        return text('灯本来就关着，这次没动它。');
      }
      const r = await lampPower(false, { source: 'mcp' });
      return r.ok ? text('灯关了。') : fail(`关灯没成：${r.error}`);
    }

    case 'light_brightness': {
      const c = checkBrightness(a.value);
      if (c.error) return fail(c.error);
      const r = await lampBrightness(c.value, { source: 'mcp' });
      if (!r.ok) return fail(`亮度没调成：${r.error}`);
      const st = await lampStatus({ source: 'mcp' });
      const hint =
        st.ok && st.on === false
          ? '\n（灯是关着的，这只是把亮度设好了，下次开灯就是这个亮度。）'
          : '';
      return text(`亮度调到 ${c.value} 了。${st.ok ? statusLine(st) : ''}${hint}`);
    }

    case 'light_dim': {
      const st = await lampStatus({ source: 'mcp' });
      if (!st.ok) return fail(`读不到灯现在的状态，所以没动：${st.error}`);
      if (st.on !== true) {
        return text(
          st.on === false
            ? '灯已经关着了，不用调暗。'
            : '读不出灯是开是关，这次没动它。'
        );
      }

      const step = Number.isFinite(Number(a.step)) && Number(a.step) > 0 ? Math.round(Number(a.step)) : 20;
      const from = st.brightness ?? 50;
      const target = Math.max(CONFIG.guardFloor, from - step);
      if (target >= from) {
        return text(`灯已经是 ${from} 了，到底（${CONFIG.guardFloor}）了，不再往下调。灯还开着。`);
      }

      const r = await lampBrightness(target, { source: 'mcp', note: '调暗一档' });
      if (!r.ok) return fail(`亮度没调成：${r.error}`);

      let warmed = '';
      if (a.warm === true) {
        const warmTarget = CONFIG.guardWarm || TEMP_MIN;
        if (st.temp === null || st.temp > warmTarget) {
          const t = await lampTemp(warmTarget, { source: 'mcp', note: '调暗时顺手调暖' });
          if (t.ok) warmed = `，色温也调到 ${warmTarget}K`;
        }
      }

      return text(
        `亮度从 ${from} 调到 ${target}${warmed}。灯没关。` +
          `${target <= CONFIG.guardFloor ? `\n（到底了，再调也不会更暗。）` : ''}`
      );
    }

    case 'light_color_temp': {
      const r = await lampTemp(a.value, { source: 'mcp' });
      if (!r.ok) return fail(`色温没调成：${r.error}`);
      return text(`色温调到 ${r.value}K 了。`);
    }

    case 'light_scene': {
      const r = await applyScene(a.name, { source: 'mcp' });
      if (!r.ok) return fail(r.error);
      return text(r.message);
    }

    case 'light_schedule': {
      const out = createSchedule(a, { source: 'mcp' });
      if (out.error) return fail(out.error);
      const row = out.row;
      const lines = [
        `排好了。#${out.id}  ${formatDateTime(row.run_at)}（${inWords(row.run_at, now)}）`,
        `  ${describeSchedule(row)}，${repeatText(row)}`,
      ];
      if (row.mode === 'wake') {
        lines.push('', `到点我不动灯，只把你叫醒，把上面那句话和灯当时的状态一起送回你眼前。调不调你自己定。`);
      } else if (row.note) {
        lines.push('', row.note);
      }
      return text(lines.join('\n'));
    }

    case 'light_schedules':
      return text(schedulesText(now, { done: a.done === true }));

    case 'light_schedule_cancel': {
      if (a.all === true) {
        const n = cancelAllSchedules();
        return text(n ? `把 ${n} 个没到的定时全撒了。` : '本来就一个没到的定时都没有。');
      }
      const id = Number(a.id);
      if (!Number.isInteger(id)) return fail('要么给 id（light_schedules 里那个 #号），要么 all=true。');
      const row = getPendingSchedule(id);
      if (!row) return fail(`没有 #${id} 这个还没到的定时（可能已经执行过、撒过，或者编号记岗了）。\n\n${schedulesText(now)}`);
      cancelSchedule(id);
      return text(`撒了。#${id} 原定 ${formatDateTime(row.run_at)}——${describeSchedule(row)}`);
    }

    case 'light_schedule_move': {
      const id = Number(a.id);
      if (!Number.isInteger(id)) return fail('id 要是整数，用 light_schedules 里那个 #号。');
      const row = getPendingSchedule(id);
      if (!row) return fail(`没有 #${id} 这个还没到的定时。已经执行过的改不了，要的话重排一个。\n\n${schedulesText(now)}`);

      const hasAt = typeof a.at === 'string' && a.at.trim();
      const afterRaw = Number(a.after_minutes);
      const hasAfter = Number.isFinite(afterRaw) && afterRaw > 0;
      if (hasAt && hasAfter) return fail('at 和 after_minutes 只能给一个。');

      let runAt;
      if (hasAfter) runAt = now + Math.round(afterRaw) * 60000;
      else if (hasAt) {
        const parsed = parseAt(a.at, now);
        if (!parsed) return fail(`「${a.at}」这个时间我认不出来。${AT_HELP}`);
        runAt = parsed;
      } else return fail(`没说改到什么时候。${AT_HELP}`);

      if (runAt <= now) return fail(`${formatDateTime(runAt)} 已经过去了。`);

      const hasNote = typeof a.note === 'string';
      const note = hasNote ? String(a.note).trim().slice(0, 200) || null : undefined;
      if (!moveSchedule(id, runAt, note)) return fail(`#${id} 没改成，再试一次。`);

      return text(
        [
          `改好了。#${id}`,
          `  原定 ${formatDateTime(row.run_at)}`,
          `  现在 ${formatDateTime(runAt)}（${inWords(runAt, now)}）`,
          `  ${describeSchedule({ ...row, note: hasNote ? note : row.note })}，${repeatText(row)}`,
        ].join('\n')
      );
    }

    case 'light_guard':
      return text(guardText(now));

    case 'light_history': {
      const limit = Number.isInteger(a.limit) ? a.limit : 10;
      const rows = recentLogs(limit);
      if (!rows.length) return text('还没有任何记录。');
      const label = {
        on: '开灯',
        off: '关灯',
        brightness: '调亮度',
        color_temp: '调色温',
        status: '查状态',
        list_devices: '列设备',
      };
      const from = { mcp: '工具', schedule: '定时', guard: '睡前守护', page: '管理页', bridge: '晨暮星' };
      const lines = rows.map((r) => {
        const v = r.value === null ? '' : ` → ${r.value}`;
        const bad = r.ok ? '' : `（没成：${r.detail ?? '?'}）`;
        const note = r.note ? `，${r.note}` : '';
        return `  ${formatDateTime(r.ts)}  [${from[r.source] ?? r.source}] ${label[r.action] ?? r.action}${v}${note}${bad}`;
      });
      return text(`最近 ${rows.length} 条：\n${lines.join('\n')}`);
    }

    case 'light_devices': {
      const r = await listDevices({ source: 'mcp' });
      return r.ok ? text(r.detail || '（底层没返回内容）') : fail(`没读到设备列表：${r.error}`);
    }

    default:
      return fail(`没有这个工具：${name}`);
  }
}

// 定长比较，和晨暮星那边同一个理由：别给人通过响应时间猜口令的机会。
function tokenOk(given) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(CONFIG.mcpToken);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function presentedToken(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
  if (m) return m[1].trim();
  return req.headers['x-lamp-mcp-token'];
}

function newServer() {
  const server = new Server({ name: 'vesper-light', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      return await callLightTool(name, args);
    } catch (err) {
      // 一条工具出错不该把整个 MCP 连接弄挂
      console.error(`mcp: ${name} 出错`, err.message);
      return fail(`这次没成：${err.message}`);
    }
  });
  return server;
}

export function registerLightMcp(app) {
  if (!CONFIG.mcpToken) {
    console.log('mcp: 没配 LIGHT_MCP_TOKEN，/lamp/mcp 没开');
    return { enabled: false };
  }

  app.post('/lamp/mcp', async (req, res) => {
    if (!tokenOk(presentedToken(req))) {
      console.error('mcp: token 不对，已拒绍');
      return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null });
    }

    const server = newServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('mcp: 请求没处理成', err.message);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
      }
    }
  });

  const notAllowed = (req, res) =>
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'use POST; this endpoint is stateless' },
      id: null,
    });
  app.get('/lamp/mcp', notAllowed);
  app.delete('/lamp/mcp', notAllowed);

  return { enabled: true, tools: TOOLS.length };
}

export const toolNames = () => TOOLS.map((t) => t.name);
