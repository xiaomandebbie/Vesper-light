// 入口。一个进程干四件事：
//   1、每分钟 tick：跑定时、到 23:00 叫允朔定今夜、跑睡前守护
//   2、/lamp/mcp：给 Aru 前端和晨暮星用的 MCP 端点
//   3、/lamp：手机上能点的管理页
//   4、/health：活着没
//
// ── 为什么是一个进程而不是两个 ──
// 定时、守护、MCP、页面全部要读写同一份数据，而这些事加起来
// 一天也跑不到一秒 CPU。拆成两个进程只是多一份 SQLite 锁竞争。
//
// ── tick 为什么不用 setInterval 直接套 ──
// 一次 tick 里有网络调用（读灯的状态、发指令），慢的时候能超过一分钟。
// setInterval 会在上一轮还没完时就启下一轮，于是同一条定时被两轮同时拿到、
// 执行两次。所以用「跑完再排下一次」加一把 running 锁。
import express from 'express';
import { CONFIG, configSummary } from './config.js';
import { ping } from './device.js';
import { tickSchedules } from './schedule.js';
import { runGuard, askGuardDecision } from './guard.js';
import { registerLightMcp, toolNames } from './mcp.js';
import { registerPage } from './page.js';
import { bridgeSummary } from './bridge.js';
import db, { pruneGuardPlans } from './store.js';
import { formatDateTime } from './clock.js';

const TICK_MS = 60000;
let running = false;
let timer = null;
let stopping = false;

async function tick() {
  if (running) {
    console.warn('tick: 上一轮还没跑完，这一轮跳过');
    return;
  }
  running = true;
  try {
    // 定时在前：要是同一分钟里既有定时又到了守护的档，
    // 先执行她明确排过的那个，再让守护在它的结果上做判断。
    await tickSchedules();
  } catch (err) {
    console.error('tick: 定时这一步出错（不影响守护）', err.message);
  }
  try {
    // 到 23:00（LAMP_GUARD_ASK_AT）且今夜还没定，就叫允朔醒一次来定。
    // 要排在 runGuard 前面：他定完之后这一轮就能用上，不必等下一分钟。
    await askGuardDecision();
  } catch (err) {
    console.error('tick: 问允朔这一步出错（今夜就不动灯）', err.message);
  }
  try {
    await runGuard();
  } catch (err) {
    console.error('tick: 守护这一步出错', err.message);
  }
  running = false;

  if (!stopping) timer = setTimeout(tick, TICK_MS);
}

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

app.get('/health', (req, res) => res.json({ ok: true, at: formatDateTime(Date.now()) }));

const mcp = registerLightMcp(app);
const pageInfo = registerPage(app);

app.use((req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, req, res, next) => {
  console.error('http: 没处理成', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'internal error' });
});

const server = app.listen(CONFIG.port, CONFIG.bind, async () => {
  console.log('─'.repeat(56));
  console.log(`vesper-light 起来了。${formatDateTime(Date.now())}`);
  console.log(`  ${configSummary()}`);
  console.log(`  ${bridgeSummary()}`);
  console.log(`  MCP 工具（${mcp.enabled ? toolNames().length : 0} 个）：${mcp.enabled ? toolNames().join('、') : '端点没开'}`);
  console.log(`  管理页：${pageInfo.enabled ? `http://${CONFIG.bind}:${CONFIG.port}/lamp` : '没开'}`);
  console.log('─'.repeat(56));

  // 表不让它一直涨：守护安排只留最近 60 夜
  try {
    pruneGuardPlans();
  } catch (err) {
    console.error('清旧守护安排失败（不影响运行）', err.message);
  }

  // 底层连不上只警告，不退出——
  // 底层那个 Python 服务没开机自启，服务器重启后它比这边起得慢很正常。
  const health = await ping();
  console.log(
    health.ok
      ? 'device: 底层米家服务连上了'
      : `device: 连不上底层米家服务（${health.error}）——检查 lamp_server.py 跑没跑、LAMP_MIOT_URL 和 token 对不对`
  );

  tick();
});

function shutdown(sig) {
  console.log(`收到 ${sig}，关闭中…`);
  stopping = true;
  if (timer) clearTimeout(timer);
  server.close(() => {
    try {
      db.close();
    } catch {
      // 已经关了就算了
    }
    process.exit(0);
  });
  // 卡住的话别让 pm2 等太久
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// 一条没捕到的 promise 不该把整个服务弄死（灯还要听话呢）
process.on('unhandledRejection', (err) => {
  console.error('有一个 promise 没接住：', err?.message ?? err);
});
