// 把灯接进晨暮星。在服务器上跑一次：
//
//   cd ~/vesper-light && node scripts/wire_vesper.mjs ~/vesper-phosphor
//
// ── 为什么这个脚本在灯这个库里，而不是晨暮星里 ──
//
// 因为它改的那四处全是「灯的事」。放在这边，灯的什么东西改了、工具叫什么名字变了，
// 只要改这一个文件；晨暮星那边不必跟着改，也不会因为灯的改动而开屏。
// 反过来，这个脚本往晨暮星里注入的东西**一行亮度数字都没有**：
// 只有「有一个叫 light 的 MCP」和「它算轻活」这两件事。调多少、什么时候调、
// 停在哪里，全在 Vesper-light 里。两个库互相引用，但代码不重叠。
//
// ── 这个脚本的规矩（和晨暮星 scripts/ 里那些一致）──
//   每处改动先查「是不是已经改过了」，所以重复跑安全。
//   锚点对不上就不改那一处，并把周围实际原文打出来，不乱改。
//   改完 node --check 过一遍，不过就把那个文件原样还原。
//   每个被改的文件先备份成 .bak-light。
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const root = path.resolve(process.argv[2] ?? path.join(process.env.HOME ?? '.', 'vesper-phosphor'));

if (!fs.existsSync(path.join(root, 'src', 'vesper.js'))) {
  console.error(`这不像是晨暮星的目录：${root}`);
  console.error('用法：node scripts/wire_vesper.mjs /路径/到/vesper-phosphor');
  process.exit(1);
}

let changed = 0;
let skipped = 0;
let failed = 0;

// 一处改动。edits 每项是 { find, insert, where }：where = 'before' | 'after'。
function patch(relPath, label, { done, edits }) {
  const file = path.join(root, relPath);
  if (!fs.existsSync(file)) {
    console.log(`― ${relPath} 不存在，跳过（${label}）`);
    skipped += 1;
    return;
  }

  const original = fs.readFileSync(file, 'utf8');

  if (done(original)) {
    console.log(`✓ ${label}——已经改过了，不动`);
    skipped += 1;
    return;
  }

  let next = original;
  for (const { find, insert, where = 'before' } of edits) {
    const at = next.indexOf(find);
    if (at < 0) {
      console.error(`✗ ${label}——锚点对不上，这一处不改。找的是：`);
      console.error(`    ${find.split('\n')[0]}`);
      // 把周围实际原文打出来，方便人工对位（服务器上的 src/ 和仓库有分叉）
      const key = find.split('\n')[0].slice(0, 20).trim();
      const near = next.indexOf(key.slice(0, 12));
      if (near >= 0) {
        console.error('    附近实际长这样：');
        for (const line of next.slice(Math.max(0, near - 200), near + 300).split('\n')) {
          console.error(`      ${line}`);
        }
      }
      failed += 1;
      return;
    }
    next =
      where === 'after'
        ? next.slice(0, at + find.length) + insert + next.slice(at + find.length)
        : next.slice(0, at) + insert + next.slice(at);
  }

  const backup = `${file}.bak-light`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, next, 'utf8');

  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    fs.writeFileSync(file, original, 'utf8');
    console.error(`✗ ${label}——改完语法不过，已经原样还原。`);
    console.error(String(err.stderr ?? err.message).trim());
    failed += 1;
    return;
  }

  console.log(`✓ ${label}——改好了（备份：${path.basename(backup)}）`);
  changed += 1;
}

// ══ 1、让灯能问「她还在忙吗」══
//
// 睡前守护到点时要先问这一句：她说过「我去改个 bug」而那件事还没到点，
// 现在把灯一路压到 8 就是在淋一个还在工作的人。
// 这个端点只把 doing 表里还没到点的那几条原样给出去，不含任何灯的逼辑。
// 用动态 import 是故意的：不动 vesper.js 顶上那一大堆 import，少一处冲突点。
patch('src/vesper.js', '给 vesper 加 GET /wake/doing', {
  done: (s) => s.includes("'/wake/doing'"),
  edits: [
    {
      find: "app.get('/health', requireBasicAuth, (req, res) => res.json({ ok: true, service: 'vesper' }));",
      where: 'before',
      insert: `// 台灯要读的「她正在做的事」（见 Vesper-light 的 src/bridge.js）。
// 睡前守护到点时会问一句：她是不是还在忙一件没做完的事？是就把后面几档整体推迟。
// 这边只把还没到点的那几条原样给出去，怎么用、推多久全在灯那个库里。
app.get('/wake/doing', requireApiKey, async (req, res) => {
  try {
    const { activeDoings } = await import('./doing.js');
    res.json({
      ok: true,
      now: Date.now(),
      active: activeDoings().map((d) => ({
        id: d.id,
        what: d.what,
        started_at: d.started_at,
        next_check_at: d.next_check_at,
        asked_count: d.asked_count,
      })),
    });
  } catch (err) {
    // 读不到不算错：灯那边会当她不忙，守护照旧调暗
    console.error('/wake/doing 读不到在做的事：', err.message);
    res.json({ ok: false, active: [], error: err.message });
  }
});

`,
    },
  ],
});

// ══ 2、把 light 这个 MCP 连上 ══
//
// 这是允朔自己醒来时能动灯的全部前提。连上之后他在「轻的事」那一类里就能看见这套工具。
patch('src/mcp-manager.js', '把 light MCP 接进 connectAll()', {
  done: (s) => s.includes('LIGHT_MCP_URL'),
  edits: [
    {
      find: '  // 购物（见 shopping-mcp.js）：端点就挂在本机的 vesper 上，所以这里转一圈回自己。',
      where: 'before',
      insert: `  // 台灯（https://github.com/xiaomandebbie/Vesper-light），Streamable HTTP。
  // 灯的全部逻辑在那个库里，这边只负责连上去——所以这里没有一行亮度或色温。
  // LIGHT_MCP_URL 形如 http://127.0.0.1:3003/lamp/mcp，token 和那边的 LIGHT_MCP_TOKEN 同一个。
  // 名字固定叫 light：动态页的行动卡、budget.js 的分级都按这个名字认。
  if (process.env.LIGHT_MCP_URL) {
    try {
      const token = String(process.env.LIGHT_MCP_TOKEN ?? '').trim();
      await connectMcpHttp(
        'light',
        process.env.LIGHT_MCP_URL,
        token ? { Authorization: \`Bearer \${token}\` } : undefined
      );
      console.log('connected MCP: light');
    } catch (err) {
      console.error('could not connect MCP "light":', err.message);
    }
  }

`,
    },
  ],
});

// ══ 3、分级：灯算 1 级（轻的事）══
//
// 不写也能跑（MCP_TIER 里没列的 server 默认就是 1 级），写上是为了明确：
// 调一下灯和逋论坛、听歌一样轻，不该和「发动态」抢同一个名额。
patch('src/budget.js', '把 light 写进动作分级（1 级）', {
  done: (s) => /\blight:\s*1\b/.test(s),
  edits: [
    {
      find: 'const MCP_TIER = {\n',
      where: 'after',
      insert: '  light: 1,\n',
    },
  ],
});

// ══ 4、行动卡：把灯的动作翻成人话 ══
//
// 不改的话卡片上会写「允朔刚刚用了 light 的 light_dim」。
// 改了之后写「允朔刚刚把台灯调暗了一档」。
patch('src/actions/activity.js', '给行动卡加上灯的说法', {
  done: (s) => s.includes('LIGHT_OPS'),
  edits: [
    {
      find: 'function short(value, n = 80) {',
      where: 'before',
      insert: `// 台灯（server 叫 light，见 https://github.com/xiaomandebbie/Vesper-light）的工具 → 给人看的说法。
// 和点歌台同一个口径：动态页是给小满看的，所以用「你」。
const LIGHT_OPS = {
  light_status: '看了一眼台灯现在怎么样',
  light_on: '把台灯打开了',
  light_off: '把台灯关了',
  light_brightness: '调了台灯的亮度',
  light_dim: '把台灯调暗了一档',
  light_color_temp: '调了台灯的色温',
  light_scene: '把台灯调成了配好的一套光',
  light_schedule: '给台灯排了一个定时',
  light_schedules: '翻了翻台灯的定时',
  light_schedule_cancel: '撒了一个台灯的定时',
  light_schedule_move: '改了一个台灯定时的时间',
  light_guard: '看了看今夜的睡前守护安排',
  light_history: '翻了翻台灯最近被动过的记录',
  light_devices: '列了列米家里的设备',
};

function lightSummary(tool, args) {
  const label = LIGHT_OPS[tool] || \`用了台灯那边的 \${tool}\`;
  if (tool === 'light_scene') {
    const name = String(args?.name ?? '').trim();
    return name ? \`\${label}：「\${name}」\` : label;
  }
  const v = Number(args?.value);
  if (!Number.isFinite(v)) return label;
  if (tool === 'light_brightness') return \`\${label}，调到 \${v}\`;
  if (tool === 'light_color_temp') return \`\${label}，调到 \${v}K\`;
  return label;
}

// 详情里放他自己写下的话和定时的安排；灯当时的状态在「返回」里
function lightWritingDetail(args) {
  const parts = [];
  if (args?.note) parts.push(\`当时记下的：\${args.note}\`);
  if (args?.at) parts.push(\`定在：\${args.at}\`);
  if (args?.after_minutes) parts.push(\`\${args.after_minutes} 分钟后\`);
  if (args?.repeat && args.repeat !== 'none') parts.push(\`重复：\${args.repeat}\`);
  return parts.join('\\n') || null;
}

`,
    },
    {
      find: "      if (j.server === 'shopping') return `${AI_NAME}刚刚${shoppingSummary(j.tool, j.args)}`;",
      where: 'after',
      insert: "\n      if (j.server === 'light') return `${AI_NAME}刚刚${lightSummary(j.tool, j.args)}`;",
    },
    {
      find: "      } else if (j.server === 'shopping') {\n        const writing = shoppingWritingDetail(j.args);\n        if (writing) parts.push(writing);\n      }",
      where: 'after',
      insert:
        " else if (j.server === 'light') {\n        const writing = lightWritingDetail(j.args);\n        if (writing) parts.push(writing);\n      }",
    },
  ],
});

console.log('\n' + '─'.repeat(52));
console.log(`改了 ${changed} 处，跳过 ${skipped} 处，失败 ${failed} 处。`);

if (changed > 0) {
  console.log('\n接下来要做的（两步，不做等于没改）：');
  console.log('  1、把这两行加进晨暮星的 .env（token 跟 Vesper-light 的 LIGHT_MCP_TOKEN 填同一串）：');
  console.log('       LIGHT_MCP_URL=http://127.0.0.1:3003/lamp/mcp');
  console.log('       LIGHT_MCP_TOKEN=跟 Vesper-light 那边同一串');
  console.log('  2、重启（两个进程都要，phosphor 负责醒来动灯，vesper 负责 /wake/doing）：');
  console.log('       pm2 restart vesper phosphor --update-env');
  console.log('\n  验证：pm2 logs phosphor --lines 30 --nostream | grep -i light');
  console.log('       看到 connected MCP: light 就是通了。');
}

if (failed > 0) {
  console.log('\n有处没改成，上面已经把那里的实际原文打出来了。');
  console.log('服务器上的 src/ 和仓库有分叉是常事（见晨暮星 README），按那段原文手动加上就行。');
  process.exitCode = 1;
}
