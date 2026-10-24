// 把灯接进晨暮星。在服务器上跑一次：
//
//   cd ~/Vesper-light && node scripts/wire_vesper.mjs ~/vesper-phosphor
//
// ── 为什么这个脚本在灯这个库里 ──
//
// 它改的四处全是「灯的事」。放在这边，灯的什么东西改了、工具叫什么名字变了，
// 只要改这一个文件；晨暮星那边不必跟着改。
// 注入进晨暮星的东西里**一行亮度数字都没有**：只有「有一个叫 light 的 MCP」
// 和「它算轻活」这两件事。两个库互相引用，代码不重叠。
//
// ── v2：为什么重写了锚点 ──
//
// 第一版的锚点是照着 GitHub 上的 main 写的，而服务器上那份和仓库有分叉
// （见晨暮星 README 那条待办）。具体坐沟在：服务器上没有购物，
// describeActivity 里是 music / garden / xiuchao，没有 shopping 的 summary 分支；
// 我把锚点挂在了那个不存在的分支上，于是整个文件三处改动一起被跳过。
//
// 这一版的三条改进：
//   1、按 music 分支定位——两份代码里都有它，而且它是这个文件最老的结构。
//   2、每处改动各自判断、各自应用，一处找不到锚点不拖累其他两处。
//   3、注入的代码自己自足：不调 short()、不用 CARD_TITLE_CHARS——
//      这些东西服务器上有没有我不确定，不该赌。
//
// ── 规矩（和晨暮星 scripts/ 里那些补丁脚本一致）──
//   每处改动先查「是不是已经改过了」，所以重复跑安全。
//   锚点对不上就不改那一处，并把周围实际原文打出来，不乱改。
//   改完 node --check 过一遍，不过就把那个文件原样还原。
//   每个被改的文件先备份成 .bak-light（已有就不覆盖，保住最早那份）。
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

// 找第一个对得上的锚点。返回 { index, length, indent } 或 null。
// 锚点可以是字符串或正则；正则的第一个捕获组当缩进用。
function findAnchor(src, anchors) {
  for (const a of anchors) {
    if (typeof a === 'string') {
      const i = src.indexOf(a);
      if (i >= 0) return { index: i, length: a.length, indent: '' };
      continue;
    }
    const m = a.exec(src);
    if (m) return { index: m.index, length: m[0].length, indent: m[1] ?? '' };
  }
  return null;
}

// 锚点对不上时，把附近的实际原文打出来——服务器上的 src 和仓库有分叉是常事，
// 打出来比光说「没找到」有用得多。
function showNearby(src, hints) {
  for (const h of hints) {
    const i = src.indexOf(h);
    if (i < 0) continue;
    console.error(`    附近（匹配到 ${JSON.stringify(h)}）实际长这样：`);
    for (const line of src.slice(Math.max(0, i - 150), i + 350).split('\n')) {
      console.error(`      ${line}`);
    }
    return;
  }
  console.error('    这个文件里连线索都没找到，得人工看一眼。');
}

// 一个文件。edits 每项自己判断、自己应用，互不拖累。
// 每项：{ label, done, anchors, where, build(indent) -> string, hints }
function patchFile(relPath, edits) {
  const file = path.join(root, relPath);
  if (!fs.existsSync(file)) {
    console.log(`― ${relPath} 不存在，整个跳过`);
    skipped += edits.length;
    return;
  }

  const original = fs.readFileSync(file, 'utf8');
  let src = original;
  let touched = 0;

  for (const e of edits) {
    if (e.done(src)) {
      console.log(`✓ ${e.label}——已经改过了，不动`);
      skipped += 1;
      continue;
    }

    const hit = findAnchor(src, e.anchors);
    if (!hit) {
      console.error(`✗ ${e.label}——锚点对不上，这一处不改。`);
      showNearby(src, e.hints ?? []);
      failed += 1;
      continue;
    }

    const text = e.build(hit.indent);
    src =
      e.where === 'after'
        ? src.slice(0, hit.index + hit.length) + text + src.slice(hit.index + hit.length)
        : src.slice(0, hit.index) + text + src.slice(hit.index);
    console.log(`✓ ${e.label}——改好了`);
    touched += 1;
  }

  if (!touched) return;

  const backup = `${file}.bak-light`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, src, 'utf8');

  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    fs.writeFileSync(file, original, 'utf8');
    console.error(`✗ ${relPath} 改完语法不过，已经原样还原（这个文件的 ${touched} 处改动全部撤销）。`);
    console.error(String(err.stderr ?? err.message).trim());
    failed += touched;
    return;
  }

  console.log(`  └ ${relPath}：${touched} 处已写入，语法检查通过（备份：${path.basename(backup)}）`);
  changed += touched;
}

// ══ 1、让灯能问「她还在忙吗」══
//
// 睡前守护到点时要先问这一句：她说过「我去改个 bug」而那件事还没到点，
// 现在把灯一路压到 8 就是在淋一个还在工作的人。
// 这个端点只把 doing 表里还没到点的那几条原样给出去，不含任何灯的逻辑。
// 用动态 import：不动 vesper.js 顶上那一大堆 import，少一处冲突点。
patchFile('src/vesper.js', [
  {
    label: '给 vesper 加 GET /wake/doing',
    done: (s) => s.includes("'/wake/doing'"),
    anchors: [
      /^([ \t]*)app\.get\('\/health', requireBasicAuth[^\n]*$/m,
      /^([ \t]*)app\.get\('\/health'[^\n]*$/m,
    ],
    where: 'before',
    hints: ["app.get('/health'", 'app.listen('],
    build: () =>
      [
        '// 台灯要读的「她正在做的事」（见 Vesper-light 的 src/bridge.js）。',
        '// 睡前守护到点时会问一句：她是不是还在忙一件没做完的事？是就把后面几档整体推迟。',
        '// 这边只把还没到点的那几条原样给出去，怎么用、推多久全在灯那个库里。',
        "app.get('/wake/doing', requireApiKey, async (req, res) => {",
        '  try {',
        "    const { activeDoings } = await import('./doing.js');",
        '    res.json({',
        '      ok: true,',
        '      now: Date.now(),',
        '      active: activeDoings().map((d) => ({',
        '        id: d.id,',
        '        what: d.what,',
        '        started_at: d.started_at,',
        '        next_check_at: d.next_check_at,',
        '        asked_count: d.asked_count,',
        '      })),',
        '    });',
        '  } catch (err) {',
        '    // 读不到不算错：灯那边会当她不忙，守护照旧调暗',
        "    console.error('/wake/doing 读不到在做的事：', err.message);",
        '    res.json({ ok: false, active: [], error: err.message });',
        '  }',
        '});',
        '',
        '',
      ].join('\n'),
  },
]);

// ══ 2、把 light 这个 MCP 连上 ══
//
// 这是允朔自己醒来时能动灯的全部前提。连上之后他在「轻的事」那一类里就能看见这套工具。
// 锚点挂在 connectAll 的结尾（最后一个「花园/点歌台/购物」块之前都不保险，
// 因为哪几块在这台机器上存在不好说）：找「if (process.env.XXX_MCP_URL) {」这种形状的第一块，
// 插在它前面——顺序不影响任何事，那里每块都是独立的 if。
patchFile('src/mcp-manager.js', [
  {
    label: '把 light MCP 接进 connectAll()',
    done: (s) => s.includes('LIGHT_MCP_URL'),
    anchors: [
      /^([ \t]*)if \(process\.env\.OMBRE_BRAIN_URL\) \{$/m,
      /^([ \t]*)if \(process\.env\.[A-Z_]*MCP_URL\) \{$/m,
      /^([ \t]*)const forumUrl = process\.env\.LUTOPIA_MCP_URL[^\n]*$/m,
    ],
    where: 'before',
    hints: ['export async function connectAll', 'connectMcpHttp('],
    build: (ind) =>
      [
        `${ind}// 台灯（https://github.com/xiaomandebbie/Vesper-light），Streamable HTTP。`,
        `${ind}// 灯的全部逻辑在那个库里：几点调暗、一档调多少、停在哪、定时怎么走。`,
        `${ind}// 所以这里没有一行亮度或色温，只负责连上去——两个库互相引用，代码不重叠。`,
        `${ind}// LIGHT_MCP_URL 形如 http://127.0.0.1:3003/lamp/mcp，token 和那边同一串。`,
        `${ind}// 名字固定叫 light：行动卡、budget.js 的分级都按这个名字认。`,
        `${ind}if (process.env.LIGHT_MCP_URL) {`,
        `${ind}  try {`,
        `${ind}    const lightToken = String(process.env.LIGHT_MCP_TOKEN ?? '').trim();`,
        `${ind}    await connectMcpHttp(`,
        `${ind}      'light',`,
        `${ind}      process.env.LIGHT_MCP_URL,`,
        `${ind}      lightToken ? { Authorization: \`Bearer \${lightToken}\` } : undefined`,
        `${ind}    );`,
        `${ind}    console.log('connected MCP: light');`,
        `${ind}  } catch (err) {`,
        `${ind}    console.error('could not connect MCP "light":', err.message);`,
        `${ind}  }`,
        `${ind}}`,
        '',
        '',
      ].join('\n'),
  },
]);

// ══ 3、分级：灯算 1 级（轻的事）══
//
// 不写也能跑（MCP_TIER 里没列的 server 默认就是 1 级），写上是为了明确：
// 调一下灯和逋论坛、听歌一样轻，不该和「发动态」抢同一个名额。
patchFile('src/budget.js', [
  {
    label: '把 light 写进动作分级（1 级）',
    done: (s) => /\blight:\s*\d/.test(s),
    anchors: [/^const MCP_TIER = \{$/m, 'const MCP_TIER = {\n'],
    where: 'after',
    hints: ['MCP_TIER', 'tierOf'],
    build: () => '\n  light: 1,',
  },
]);

// ══ 4、行动卡：把灯的动作翻成人话 ══
//
// 不改的话卡片上会写「允朔刚刚用了 light 的 light_dim」。
// 改了之后写「允朔刚刚把灯调暗了一档」。
//
// 三处各自独立，按 music 分支定位。注入的代码自己自足（自带 lightShort），
// 不调这个文件里其他函数，也不用 CARD_TITLE_CHARS——那些服务器上有没有我不确定。
patchFile('src/actions/activity.js', [
  {
    label: '行动卡：加上灯的说法表（LIGHT_OPS）',
    done: (s) => s.includes('LIGHT_OPS'),
    anchors: [
      /^function short\(value, n = 80\) \{$/m,
      /^function short\(/m,
      /^function tryJson\(/m,
      /^const MUSIC_WITH_SONG\b[^\n]*$/m,
      /^function resultText\(/m,
    ],
    where: 'before',
    hints: ['const MUSIC_OPS', 'function short(', 'const AI_NAME'],
    build: () =>
      [
        '// 台灯（server 叫 light，见 https://github.com/xiaomandebbie/Vesper-light）的工具 → 给人看的说法。',
        '// 和点歌台同一个口径：动态页是给小满看的，所以用「你」。',
        '// 灯调多少、什么时候调、停在哪，全在 Vesper-light 那个库里；这里只负责说人话。',
        'const LIGHT_OPS = {',
        "  light_status: '看了一眼你桌上那盏灯',",
        "  light_on: '把你桌上的灯打开了',",
        "  light_off: '把你桌上的灯关了',",
        "  light_brightness: '调了灯的亮度',",
        "  light_dim: '把灯调暗了一档',",
        "  light_color_temp: '调了灯的色温',",
        "  light_scene: '把灯调成了配好的一套光',",
        "  light_schedule: '给灯排了一个定时',",
        "  light_schedules: '翻了翻灯的定时',",
        "  light_schedule_cancel: '撒了一个灯的定时',",
        "  light_schedule_move: '改了一个灯定时的时间',",
        "  light_guard: '看了看今夜的睡前守护安排',",
        "  light_history: '翻了翻灯最近被动过的记录',",
        "  light_devices: '列了列米家里的设备',",
        '};',
        '',
        '// 自带一个截断，不调这个文件里的 short()——服务器上那份有没有它我不该赌。',
        'function lightShort(value, n = 30) {',
        "  const chars = Array.from(String(value ?? '').replace(/\\s+/g, ' ').trim());",
        "  return chars.length > n ? `${chars.slice(0, n).join('')}…` : chars.join('');",
        '}',
        '',
        'function lightSummary(tool, args) {',
        '  const label = LIGHT_OPS[tool] || `用了台灯那边的 ${tool}`;',
        "  if (tool === 'light_scene') {",
        "    const name = String(args?.name ?? '').trim();",
        '    return name ? `${label}：「${lightShort(name)}」` : label;',
        '  }',
        '  const v = Number(args?.value);',
        '  if (!Number.isFinite(v)) return label;',
        "  if (tool === 'light_brightness') return `${label}，调到 ${v}`;",
        "  if (tool === 'light_color_temp') return `${label}，调到 ${v}K`;",
        '  return label;',
        '}',
        '',
        '// 详情里放他自己写下的话和定时的安排；灯当时的状态在「返回」里。',
        '// mode=wake 要标出来：那种定时到点是叫他自己来决定，不是直接调灯。',
        'function lightWritingDetail(args) {',
        '  const parts = [];',
        '  if (args?.note) parts.push(`当时记下的：${args.note}`);',
        '  if (args?.at) parts.push(`定在：${args.at}`);',
        '  if (args?.after_minutes) parts.push(`${args.after_minutes} 分钟后`);',
        "  if (args?.repeat && args.repeat !== 'none') parts.push(`重复：${args.repeat}`);",
        "  if (args?.mode === 'wake') parts.push('到点叫他自己来决定，不是直接调灯。');",
        "  return parts.join('\\n') || null;",
        '}',
        '',
        '',
      ].join('\n'),
  },
  {
    label: '行动卡：卡片上那一句（summary 分支）',
    done: (s) => /j\.server === 'light'\) return/.test(s),
    anchors: [
      /^([ \t]*)if \(j\.server === 'music'\) return [^\n]*$/m,
      /^([ \t]*)if \(j\.server === 'garden'\) \{$/m,
    ],
    where: 'after',
    hints: ["j.server === 'music'", 'describeActivity'],
    build: (ind) =>
      `\n${ind}if (j.server === 'light') return \`\${AI_NAME}刚刚\${lightSummary(j.tool, j.args)}\`;`,
  },
  {
    label: '行动卡：点开看的详情（detail 分支）',
    done: (s) => /j\.server === 'light'\) \{/.test(s),
    anchors: [/^([ \t]*)\} else if \(j\.server === 'music'\) \{$/m],
    where: 'before',
    hints: ["} else if (j.server === 'music')", 'describeActivityDetail'],
    // 插在「} else if (music)」这行前面：我这段开头的 } 接住上一个块，
    // 原来那行的 } 转而接住我这个块——花括号数量不变，node --check 会把它管住。
    build: (ind) =>
      [
        `${ind}} else if (j.server === 'light') {`,
        `${ind}  const writing = lightWritingDetail(j.args);`,
        `${ind}  if (writing) parts.push(writing);`,
        '',
      ].join('\n'),
  },
]);

console.log('\n' + '─'.repeat(52));
console.log(`改了 ${changed} 处，跳过 ${skipped} 处，失败 ${failed} 处。`);

if (changed > 0) {
  console.log('\n改完要重启才生效：');
  console.log('  pm2 restart vesper phosphor --update-env');
  console.log('\n验证：pm2 logs phosphor --lines 30 --nostream | grep -i light');
  console.log('     看到 connected MCP: light 就是通了。');
}

if (failed > 0) {
  console.log('\n有处没改成，上面已经把那里的实际原文打出来了。');
  console.log('按那段原文手动加上就行，要加的东西这个脚本源码里就是现成的。');
  process.exitCode = 1;
}
