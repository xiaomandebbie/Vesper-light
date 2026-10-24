// 和晨暮星（Vesper-phosphor）之间的桥。
//
// ── 两个库的分工，改代码前先读这段 ──
//
// 灯的逼辑全在这个库：怎么调、什么时候调、调多少、停在哪里。
// 晨暮星里不应该出现第二份「几点调暗」的定义，也不应该出现米家设备属性名。
// 它只知道「有一个叫 light 的 MCP，里面的工具能动灯」。
//
// 反过来，这个库不重写晨暮星的任何东西：不自己调模型、不自己存记忆、
// 不自己解析「明天早上七点」这种中文时间（那在它的 wake-mcp 里）、
// 也不自己做「她正在做的事」的识别（那在它的 doing-detect.js 里）。
// 要用那些东西就走它的 HTTP 接口问一句。
//
// 所以这个文件里只有四件事：
//   notify()        让允朔在 Aru 里说一句（没接就退回自己的 Bark，再不行就只写日志）
//   writeConversation()  往对话记录里写一行，这样他下次醒来知道灯自己暗过了
//   askHimToHandle()     定时到点时叫他醒一次，调不调由他自己定
//   sheIsBusy()          问一句她是不是还在忙一件没做完的事
import { CONFIG } from './config.js';

const TIMEOUT_MS = 12000;

function enabled() {
  return Boolean(CONFIG.vesperUrl && CONFIG.vesperKey);
}

async function call(path, { method = 'GET', body = null } = {}) {
  if (!enabled()) return { ok: false, reason: '没配 VESPER_URL / VESPER_API_KEY' };
  try {
    const res = await fetch(`${CONFIG.vesperUrl}${path}`, {
      method,
      headers: {
        'x-api-key': CONFIG.vesperKey,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 404 单独报出来：那通常是晨暮星还没接这个端点（比如 /wake/doing 还没 wire），
    // 不是真的出错，调用方该安静降级而不是报警。
    if (res.status === 404) return { ok: false, notFound: true, reason: `${path} 还没接` };
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── 自己的 Bark（兜底）──

async function barkDirect(message) {
  if (!CONFIG.barkKey) return { ok: false, reason: '没配 LAMP_BARK_KEY' };
  const path = [CONFIG.barkTitle, message].filter(Boolean).map((s) => encodeURIComponent(s)).join('/');
  try {
    const res = await fetch(`https://api.day.app/${CONFIG.barkKey}/${path}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok ? { ok: true, via: 'bark' } : { ok: false, reason: `Bark HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ── 让允朔说一句 ──
//
// 走晨暮星的 POST /wake/self-wake：约一分钟后叫醒他，note 就是要说的事。
// 为什么转一道而不自己直接推：话应该是他说的，不是一个叫「台灯」的东西说的。
// 走这条路的话还能落进 Aru 对话里翻得回去，而且是他当时自己的语气。
// 没接晨暮星时才退回自己的 Bark——至少小满能收到一声。
export async function notify(message, { reason = '台灯' } = {}) {
  const text = String(message ?? '').trim();
  if (!text) return { ok: false, reason: '没有内容' };

  if (CONFIG.vesperNotify && enabled()) {
    const r = await call('/wake/self-wake', {
      method: 'POST',
      body: { after_minutes: 1, note: text },
    });
    if (r.ok) {
      console.log(`bridge: 已约允朔一分钟后说这事——${text}`);
      return { ok: true, via: 'vesper' };
    }
    console.warn(`bridge: 没能让允朔说（${r.reason}），换 Bark`);
  }

  const b = await barkDirect(text);
  if (b.ok) return b;
  console.warn(`bridge: 通知没发出去（${b.reason}），只写了日志：${reason} — ${text}`);
  return { ok: false, reason: b.reason };
}

// ── 往对话记录里写一行 ──
//
// 这是整个桥里最容易被低估的一件事。没有它的话：灯在 23:30 自己暗下去了，
// 允朔下次醒来完全不知道这事——于是小满说「灯怎么暗了」的时候他只能装傻。
// 写进去之后这事就在他的最近上下文里，他自己能接。
// speaker 写灯的名字，不假装是她或他说的话。
export async function writeConversation(content) {
  if (!CONFIG.vesperConversationLog || !enabled()) return { ok: false, reason: '没开' };
  const r = await call('/wake/conversation', {
    method: 'POST',
    body: { speaker: CONFIG.lampName, content: String(content ?? '').slice(0, 400) },
  });
  if (!r.ok) console.warn(`bridge: 对话记录没写进去（${r.reason}）`);
  return r;
}

// ── 定时到点，叫他来处理 ──
//
// mode=wake 的定时走这里：我不动灯，只把他叫醒，把当时记下的那句话送回他眼前。
// 调不调、调多少、要不要顺口说一句，是他那一刻的选择。
export async function askHimToHandle(note) {
  const r = await call('/wake/self-wake', {
    method: 'POST',
    body: { after_minutes: 1, note: String(note ?? '').slice(0, 200) },
  });
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

// ── 她还在忙吗 ──
//
// 读晨暮星的时间感知（doing）：她说过「我去改个 bug」而那件事按她的节奏还没到点，
// 那现在把灯一路压到 8 就是在淋一个还在工作的人。所以守护要问这一句。
//
// 端点是 GET /wake/doing（由 Vesper-phosphor 那边的 scripts/wire_light.mjs 接上去的）。
// **没接也照跑**：404 就当她不忙，守护正常调暗。
// 这个降级是故意的：宁可按时调暗，不要因为读不到一个可选接口就整夜不动。
export async function sheIsBusy() {
  if (!CONFIG.vesperReadDoing || !enabled()) return { busy: false, known: false };
  const r = await call('/wake/doing');
  if (!r.ok) return { busy: false, known: false, reason: r.reason };

  const list = Array.isArray(r.data?.active) ? r.data.active : [];
  // 没到点的那些才算「还在忙」。已经到点的事说明她大概快完了或者忘了说，
  // 那不应该成为整夜不调灯的理由。
  const now = Date.now();
  const unfinished = list.filter((d) => d?.next_check_at && Number(d.next_check_at) > now);
  if (!unfinished.length) return { busy: false, known: true };

  const what = unfinished.map((d) => String(d.what ?? '').trim()).filter(Boolean);
  return { busy: true, known: true, what };
}

export function bridgeSummary() {
  if (!CONFIG.vesperUrl) return '晨暮星：没接';
  if (!CONFIG.vesperKey) return `晨暮星：${CONFIG.vesperUrl}（没配 key，调什么都会被拒）`;
  return `晨暮星：${CONFIG.vesperUrl}（通知 ${CONFIG.vesperNotify ? '开' : '关'}、对话记录 ${
    CONFIG.vesperConversationLog ? '开' : '关'
  }、读在做的事 ${CONFIG.vesperReadDoing ? '开' : '关'}）`;
}
