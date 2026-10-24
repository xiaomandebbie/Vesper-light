// 和底层米家服务说话的那一层。真正的开关调光全部转给它，这个库不重写米家通信。
//
// 底层是服务器上已经在跑的 lamp_server.py（底层又靠 javen-yan/miot-mcp 的
// MijiaAdapter → mijiaAPI → 小米云 → 灯）。它暴露的是这几个工具：
//   lamp_on / lamp_off / lamp_status / list_devices
//   lamp_set_brightness（1–100）/ lamp_set_color_temp（2700–5100）
//   lamp_schedule / lamp_list_schedules / lamp_cancel_schedule
//
// ── 两个必须记住的事 ──
//
// 1、为什么不用 MCP SDK 的 client 连它：
//    底层是「手写的 JSON-RPC over HTTP」，POST /mcp 直接返回一个 JSON，
//    不支持 SSE、也没有 GET 流，只实现了 initialize / tools/list / tools/call / ping。
//    StreamableHTTPClientTransport 会期待 event-stream、会带会话头，接上去很脉。
//    所以这里就赤手空拳发一个 fetch，十行的事。
//
// 2、不用底层的 lamp_schedule：
//    本库自己有一套定时（schedule.js），因为要支持「到点叫允朔来决定」这种底层做不了的模式。
//    两套定时同时跑的后果是：各记一份、互相看不见，小满在管理页上撒了一个，
//    底层那个到点还是把灯开了。所以定时只由这边做；底层那三个工具留着不调。
//    如果底层曾经排过定时，用 lampListRawSchedules() 能看到，归一次就行。
import { CONFIG, BRIGHTNESS_MIN, BRIGHTNESS_MAX, TEMP_MIN, TEMP_MAX } from './config.js';
import { logAction } from './store.js';

let rpcId = 0;

// 向底层发一次 JSON-RPC。失败统一 throw，谁调谁接。
async function rpc(method, params) {
  if (!CONFIG.miotToken) {
    throw new Error('没配 LAMP_MIOT_TOKEN，连不上底层米家服务');
  }
  const res = await fetch(CONFIG.miotUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${CONFIG.miotToken}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(CONFIG.miotTimeoutMs),
  });

  if (res.status === 401) throw new Error('底层服务返回 401：LAMP_MIOT_TOKEN 不对');
  if (!res.ok) throw new Error(`底层服务 HTTP ${res.status}`);

  const body = await res.json().catch(() => null);
  if (!body) throw new Error('底层服务返回的不是 JSON');
  if (body.error) throw new Error(body.error.message || `底层错误 ${body.error.code}`);
  return body.result ?? null;
}

// MCP 工具返回 { content: [{ type: 'text', text }] }，只要文字
function resultText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result.trim();
  if (!Array.isArray(result.content)) return '';
  return result.content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

async function callLampTool(name, args = {}) {
  const result = await rpc('tools/call', { name, arguments: args });
  const text = resultText(result);
  // 底层自己也会把失败包成 isError（比如回读状态不一致）
  if (result?.isError) throw new Error(text || `${name} 执行失败`);
  return text;
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(n)));

export function checkBrightness(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return { error: '亮度要是一个数字' };
  if (n < BRIGHTNESS_MIN || n > BRIGHTNESS_MAX) {
    return { error: `亮度只能是 ${BRIGHTNESS_MIN}–${BRIGHTNESS_MAX}，给的是 ${n}` };
  }
  return { value: Math.round(n) };
}

export function checkTemp(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return { error: '色温要是一个数字' };
  if (n < TEMP_MIN || n > TEMP_MAX) {
    return { error: `色温只能是 ${TEMP_MIN}–${TEMP_MAX}K（2700 最暖，5100 最冷），给的是 ${n}` };
  }
  return { value: Math.round(n) };
}

// 底层 lamp_status 返回的原话长这样：
//   「桌面台灯: 关, 亮度 70, 色温 3596K」
// 解析按关键词抓，不按逗号位置抓：底层改了措辞也不至于整套塌。
// 认不出开关的时候 on 是 null，**不当成关**——这一点很要紧：
// 睡前守护看见 on === false 就不动手，要是把「读不出来」也当成关，
// 真正开着的那些夜里就永远不会被调暗了。
export function parseStatus(text) {
  const s = String(text ?? '');
  const out = { raw: s, on: null, brightness: null, temp: null, name: null };

  const name = /^\s*([^:：]+)\s*[:：]/.exec(s);
  if (name) out.name = name[1].trim();

  if (/(?:^|[\s,，:：])(?:开|开启|已开|on\b|亮着)/i.test(s)) out.on = true;
  if (/(?:^|[\s,，:：])(?:关|关闭|已关|off\b|灭着)/i.test(s)) out.on = false;

  const b = /亮度\s*[:：]?\s*(\d{1,3})/.exec(s) || /brightness\D{0,3}(\d{1,3})/i.exec(s);
  if (b) {
    const n = Number(b[1]);
    if (n >= 0 && n <= 100) out.brightness = n;
  }

  const t = /色温\s*[:：]?\s*(\d{3,5})/.exec(s) || /(\d{3,5})\s*K/i.exec(s);
  if (t) {
    const n = Number(t[1]);
    if (n >= 1000 && n <= 10000) out.temp = n;
  }

  return out;
}

// 查状态。这是整套东西里调得最多的一个：
// 睡前守护、定时、场景动手前都得先看一眼灯现在怎么样。
export async function lampStatus({ source = 'mcp', log = false } = {}) {
  try {
    const text = await callLampTool('lamp_status');
    const st = parseStatus(text);
    if (log) logAction({ source, action: 'status', ok: true, detail: text });
    return { ok: true, ...st };
  } catch (err) {
    if (log) logAction({ source, action: 'status', ok: false, detail: err.message });
    return { ok: false, error: err.message, raw: null, on: null, brightness: null, temp: null };
  }
}

// 开 / 关。注意：关灯只有小满和允朔明确要求时才调，
// 睡前守护永远不调它（见 guard.js 开头那段）。
export async function lampPower(on, { source = 'mcp', note = null } = {}) {
  const action = on ? 'on' : 'off';
  try {
    const text = await callLampTool(on ? 'lamp_on' : 'lamp_off');
    logAction({ source, action, ok: true, detail: text, note });
    return { ok: true, detail: text };
  } catch (err) {
    logAction({ source, action, ok: false, detail: err.message, note });
    return { ok: false, error: err.message };
  }
}

export async function lampBrightness(value, { source = 'mcp', note = null } = {}) {
  const checked = checkBrightness(value);
  if (checked.error) return { ok: false, error: checked.error };
  try {
    const text = await callLampTool('lamp_set_brightness', { value: checked.value });
    logAction({ source, action: 'brightness', value: checked.value, ok: true, detail: text, note });
    return { ok: true, value: checked.value, detail: text };
  } catch (err) {
    logAction({ source, action: 'brightness', value: checked.value, ok: false, detail: err.message, note });
    return { ok: false, error: err.message };
  }
}

export async function lampTemp(value, { source = 'mcp', note = null } = {}) {
  const checked = checkTemp(value);
  if (checked.error) return { ok: false, error: checked.error };
  try {
    const text = await callLampTool('lamp_set_color_temp', { value: checked.value });
    logAction({ source, action: 'color_temp', value: checked.value, ok: true, detail: text, note });
    return { ok: true, value: checked.value, detail: text };
  } catch (err) {
    logAction({ source, action: 'color_temp', value: checked.value, ok: false, detail: err.message, note });
    return { ok: false, error: err.message };
  }
}

export async function listDevices({ source = 'mcp' } = {}) {
  try {
    const text = await callLampTool('list_devices');
    logAction({ source, action: 'list_devices', ok: true, detail: text });
    return { ok: true, detail: text };
  } catch (err) {
    logAction({ source, action: 'list_devices', ok: false, detail: err.message });
    return { ok: false, error: err.message };
  }
}

// 底层自己那套定时里还挂着什么。只读，用来排查「我这边一个定时都没有，
// 灯怎么自己开了」——那通常是历史上在底层排过一个 daily。
export async function lampListRawSchedules() {
  try {
    return { ok: true, detail: await callLampTool('lamp_list_schedules') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 底层连得上吗。启动时查一次，管理页也用。
export async function ping() {
  try {
    await rpc('ping', {});
    return { ok: true };
  } catch (err) {
    // 有些版本没实现 ping，那就拿 tools/list 当探活
    try {
      await rpc('tools/list', {});
      return { ok: true };
    } catch (err2) {
      return { ok: false, error: err2.message || err.message };
    }
  }
}
