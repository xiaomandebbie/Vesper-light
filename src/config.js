// 所有 .env 读取集中在这里，别处只 import CONFIG。
//
// 为什么集中：这套东西有二十几个开关，散在各文件里读 process.env 的话，
// 「现在到底生效的是什么」只能靠翻代码。集中之后启动日志能一次打全（见 configSummary），
// 配完东西先看那一行，比翻 .env 准。
import 'dotenv/config';

const str = (key, fallback = '') => {
  const v = String(process.env[key] ?? '').trim();
  return v || fallback;
};

const num = (key, fallback) => {
  const raw = str(key);
  const n = Number(raw);
  return raw && Number.isFinite(n) ? n : fallback;
};

const int = (key, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const n = Math.round(num(key, fallback));
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
};

// 开关一律「只有明确写了关才算关」，免得写错一个字母整块功能悄悄消失
const on = (key, fallback = true) => {
  const raw = str(key);
  if (!raw) return fallback;
  return !/^(0|off|false|no)$/i.test(raw);
};

// 「40,20,8」→ [40, 20, 8]，顺带夹到合法亮度范围并按从亮到暗排好
function stages(key, fallback) {
  const raw = str(key);
  if (!raw) return fallback;
  const list = raw
    .split(/[,，\s]+/)
    .map((s) => Math.round(Number(s)))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 100);
  return list.length ? [...new Set(list)].sort((a, b) => b - a) : fallback;
}

// 「23:30」→ { h: 23, m: 30 }。写错格式就退回默认值，不让服务起不来。
export function parseHhMm(raw, fallback) {
  const m = /^(\d{1,2})\s*[:：.]\s*(\d{1,2})$/.exec(String(raw ?? '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return fallback;
  return { h, m: mi };
}

// 亮度和色温的硬范围，底层设备就是这个范围（见交接文档第 5 节）
export const BRIGHTNESS_MIN = 1;
export const BRIGHTNESS_MAX = 100;
export const TEMP_MIN = 2700;
export const TEMP_MAX = 5100;

export const CONFIG = {
  // 底层米家服务
  miotUrl: str('LAMP_MIOT_URL', 'http://127.0.0.1:8890/mcp'),
  miotToken: str('LAMP_MIOT_TOKEN'),
  miotTimeoutMs: int('LAMP_MIOT_TIMEOUT_MS', 20000, { min: 2000, max: 120000 }),
  lampName: str('LAMP_NAME', '桌面台灯'),

  // 自己这个服务
  port: int('LIGHT_PORT', 3003, { min: 1, max: 65535 }),
  bind: str('LIGHT_BIND', '127.0.0.1'),
  basicUser: str('LIGHT_BASIC_USER'),
  basicPass: str('LIGHT_BASIC_PASS'),
  mcpToken: str('LIGHT_MCP_TOKEN'),
  timeZone: str('TIME_ZONE', 'Asia/Shanghai'),
  dbPath: str('LIGHT_DB', 'data/light.db'),

  // 晨暮星
  vesperUrl: str('VESPER_URL').replace(/\/+$/, ''),
  vesperKey: str('VESPER_API_KEY'),
  vesperNotify: on('VESPER_NOTIFY', true),
  vesperConversationLog: on('VESPER_CONVERSATION_LOG', true),
  vesperReadDoing: on('VESPER_READ_DOING', true),
  aiName: str('AI_DISPLAY_NAME', '允朔'),
  userName: str('USER_DISPLAY_NAME', '她'),

  // 睡前守护
  guard: on('LAMP_GUARD', true),
  bedtime: parseHhMm(str('LAMP_BEDTIME'), { h: 23, m: 30 }),
  guardStages: stages('LAMP_GUARD_STAGES', [40, 20, 8]),
  guardStepMinutes: int('LAMP_GUARD_STEP_MINUTES', 15, { min: 1, max: 240 }),
  guardFloor: int('LAMP_GUARD_FLOOR', 5, { min: BRIGHTNESS_MIN, max: BRIGHTNESS_MAX }),
  guardWarm: int('LAMP_GUARD_WARM', TEMP_MIN, { min: 0, max: TEMP_MAX }),
  guardWindowEnd: parseHhMm(str('LAMP_GUARD_WINDOW_END'), { h: 3, m: 0 }),
  guardBusyDelayMinutes: int('LAMP_GUARD_BUSY_DELAY_MINUTES', 20, { min: 1, max: 180 }),
  guardBusyMaxDelays: int('LAMP_GUARD_BUSY_MAX_DELAYS', 2, { min: 0, max: 10 }),
  guardNotify: on('LAMP_GUARD_NOTIFY', true),

  // 定时
  scheduleGraceMinutes: int('LAMP_SCHEDULE_GRACE_MINUTES', 15, { min: 1, max: 1440 }),
  maxPending: int('LAMP_MAX_PENDING', 30, { min: 1, max: 200 }),

  // 兜底通知
  barkKey: str('LAMP_BARK_KEY'),
  barkTitle: str('LAMP_BARK_TITLE', '台灯'),
};

// 守护的档位里不该出现比地板还低的值，也不该有重复。
// 地板本身永远是最后一档：到了它就停，不再往下，更不会关灯。
CONFIG.guardStages = CONFIG.guardStages.filter((v) => v > CONFIG.guardFloor);
if (!CONFIG.guardStages.length) CONFIG.guardStages = [CONFIG.guardFloor];

const hhmm = (t) => `${String(t.h).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;

// 启动时打一行，把真实生效的状态全写出来。
export function configSummary() {
  const lines = [];
  lines.push(`灯：${CONFIG.lampName}，底层服务 ${CONFIG.miotUrl}${CONFIG.miotToken ? '（带 token）' : '（没配 token）'}`);
  lines.push(
    `服务：${CONFIG.bind}:${CONFIG.port}，时区 ${CONFIG.timeZone}，` +
      `管理页${CONFIG.basicUser && CONFIG.basicPass ? '开着' : '没开（没设登录）'}，` +
      `MCP 端点${CONFIG.mcpToken ? '开着' : '没开（没设口令）'}`
  );
  lines.push(
    CONFIG.guard
      ? `睡前守护：开着，${hhmm(CONFIG.bedtime)} 起每 ${CONFIG.guardStepMinutes} 分钟一档 ` +
        `${CONFIG.guardStages.join(' → ')}，最低 ${CONFIG.guardFloor} 就停，` +
        `${CONFIG.guardWarm ? `顺手调暖到 ${CONFIG.guardWarm}K，` : '不动色温，'}` +
        `窗口到 ${hhmm(CONFIG.guardWindowEnd)}，永不关灯`
      : '睡前守护：关闭'
  );
  lines.push(
    CONFIG.vesperUrl
      ? `晨暮星：${CONFIG.vesperUrl}${CONFIG.vesperKey ? '' : '（没配 key，接口会被拒）'}，` +
        `发消息${CONFIG.vesperNotify ? '开' : '关'}、` +
        `写对话记录${CONFIG.vesperConversationLog ? '开' : '关'}、` +
        `读时间感知${CONFIG.vesperReadDoing ? '开' : '关'}`
      : '晨暮星：没接（守护只调灯，不说话；定时不能叫允朔来处理）'
  );
  lines.push(
    `定时：最多挂 ${CONFIG.maxPending} 个，错过超过 ${CONFIG.scheduleGraceMinutes} 分钟不补执行`
  );
  return lines.join('\n  ');
}
