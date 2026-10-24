// 把台灯的**页面**接进晨暮星。在服务器上跑一次：
//
//   cd ~/Vesper-light && node scripts/wire_light_page.mjs ~/vesper-phosphor
//
// 和 wire_vesper.mjs 分开：那个管「允朔能不能动灯」（MCP、分级、行动卡），
// 这个管「小满能不能在晨暮星里看到灯那一页」。两件事互不依赖，
// 一个出问题不应该拖累另一个。
//
// 做三件事：
//   1、把 assets/light-proxy.js 装到 vesper-phosphor/src/ 下（源文件在灯这个库里维护）
//   2、vesper.js 里注册转发
//   3、page-chrome.js 的菜单里加一项「台灯」，**排在日记后面**（小满定的位置）
//
// 规矩和 wire_vesper.mjs 一样：已经改过就不动（重复跑安全），锚点对不上
// 就不改那一处并把实际原文打出来，改完 node --check，不过则整文件还原。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? path.join(process.env.HOME ?? '.', 'vesper-phosphor'));

if (!fs.existsSync(path.join(root, 'src', 'vesper.js'))) {
  console.error(`这不像是晨暮星的目录：${root}`);
  console.error('用法：node scripts/wire_light_page.mjs /路径/到/vesper-phosphor');
  process.exit(1);
}

let changed = 0;
let skipped = 0;
let failed = 0;

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

function showNearby(src, hints) {
  for (const h of hints) {
    const i = src.indexOf(h);
    if (i < 0) continue;
    console.error(`    附近（匹配到 ${JSON.stringify(h)}）实际长这样：`);
    for (const line of src.slice(Math.max(0, i - 150), i + 400).split('\n')) {
      console.error(`      ${line}`);
    }
    return;
  }
  console.error('    这个文件里连线索都没找到，得人工看一眼。');
}

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

// ══ 1、把转发层装过去 ══
//
// 源文件在灯这个库的 assets/ 里维护，这边只是拷一份。
// 以后改了重跑一次这个脚本就行——所以内容不同时覆盖，相同时不动。
const srcFile = path.join(here, '..', 'assets', 'light-proxy.js');
const dstFile = path.join(root, 'src', 'light-proxy.js');

if (!fs.existsSync(srcFile)) {
  console.error(`✗ 找不到 ${srcFile}——先 git pull 一下灯这个库。`);
  failed += 1;
} else {
  const incoming = fs.readFileSync(srcFile, 'utf8');
  const existing = fs.existsSync(dstFile) ? fs.readFileSync(dstFile, 'utf8') : null;
  if (existing === incoming) {
    console.log('✓ src/light-proxy.js——已经是最新的，不动');
    skipped += 1;
  } else {
    fs.writeFileSync(dstFile, incoming, 'utf8');
    try {
      execFileSync(process.execPath, ['--check', dstFile], { stdio: 'pipe' });
      console.log(`✓ src/light-proxy.js——${existing ? '更新了' : '装好了'}，语法检查通过`);
      changed += 1;
    } catch (err) {
      if (existing) fs.writeFileSync(dstFile, existing, 'utf8');
      else fs.unlinkSync(dstFile);
      console.error('✗ src/light-proxy.js 语法不过，已还原。');
      console.error(String(err.stderr ?? err.message).trim());
      failed += 1;
    }
  }
}

// ══ 2、vesper 里注册转发 ══
//
// 用顶层 await import：不动 vesper.js 顶上那一排 import，少一处冲突点。
// vesper.js 是 ESM（package.json 里 type: module），这么写没问题。
//
// 挂在哪里都行：它是 app.use('/lamp', …)，路径不和其他页重叠。
// 插在 /health 前面——那行在两份代码里都有，是这个文件最稳的锚点。
patchFile('src/vesper.js', [
  {
    label: '在 vesper 里注册台灯页转发 /lamp',
    done: (s) => s.includes('registerLightProxy'),
    anchors: [
      /^([ \t]*)app\.get\('\/health', requireBasicAuth[^\n]*$/m,
      /^([ \t]*)app\.get\('\/health'[^\n]*$/m,
    ],
    where: 'before',
    hints: ["app.get('/health'", 'app.listen('],
    build: () =>
      [
        '// 台灯页 /lamp（见 light-proxy.js）：把 Vesper-light 的管理页转发过来。',
        '// 灯那个服务只听 127.0.0.1（它能动家里的硬件，不该开到公网），',
        '// 所以菜单里挂外链手机上点不开——和记忆库、音乐同一个路子，转一道。',
        '// 没配 LIGHT_MCP_URL / LIGHT_PAGE_URL 时整页不挂，菜单里那一项显示灰色「没配置」。',
        "const { registerLightProxy } = await import('./light-proxy.js');",
        'const lightPage = registerLightProxy(app, { requireBasicAuth });',
        "console.log(`台灯页：${lightPage ? '/lamp（转发 ' + lightPage + '）' : '未配置'}`);",
        '',
        '',
      ].join('\n'),
  },
]);

// ══ 3、菜单里加一项「台灯」，排在日记后面 ══
//
// 位置是小满定的。和音乐、共读同一个写法：先看真实能力（配了灯就指站内 /lamp），
// 没配就是灰色「没配置」——不让菜单里出现一个点了打不开的条目。
//
// noStars：那页是转发过来的，不跑 HEAD_SCRIPT，进场动画的记号没人清。
// 和音乐那一项同理（见 page-chrome.js 里 renderItem 的说明）。
//
// 两处改动：先加一个判断能力的小函数，再把条目插进排序里。
patchFile('src/page-chrome.js', [
  {
    label: '菜单：加一个「灯配好了没」的判断（lightPageEnabled）',
    done: (s) => s.includes('lightPageEnabled'),
    anchors: [/^function navGroups\(\) \{$/m, /^function navGroups\(/m],
    where: 'before',
    hints: ['function navGroups', 'export function renderMenu'],
    build: () =>
      [
        '// 台灯配好了没有。判断口径和 light-proxy.js 的 lightPageBase() 一致：',
        '// 配了 LIGHT_MCP_URL（或单独的 LIGHT_PAGE_URL）就有站内页 /lamp。',
        '// 两个地方各说一套的话，就是音乐那个坏毛病：转发正常，菜单里却写着「没配置」。',
        'export function lightPageEnabled() {',
        "  const explicit = env('LIGHT_PAGE_URL');",
        '  if (/^(off|0|false|no)$/i.test(explicit)) return false;',
        "  const raw = explicit || env('LIGHT_MCP_URL');",
        '  if (!raw) return false;',
        '  try {',
        '    const u = new URL(raw);',
        "    return u.protocol === 'http:' || u.protocol === 'https:';",
        '  } catch {',
        '    return false;',
        '  }',
        '}',
        '',
        '',
      ].join('\n'),
  },
  {
    label: '菜单：把「台灯」插在日记后面',
    done: (s) => /label: '台灯'/.test(s),
    anchors: [
      // 排序里日记那一行。两份代码里都是先 const diary = … 再在数组里写 diary,
      /^([ \t]*)diary,$/m,
      // 退一步：数组里直接写着日记条目的写法
      /^([ \t]*)\{ href: '\/diary', label: '日记' \},$/m,
    ],
    where: 'after',
    hints: ["label: '日记'", 'const diary =', "label: '梦境'"],
    build: (ind) =>
      [
        '',
        `${ind}// 台灯排在日记后面（小满定的位置）。配了灯才能点，没配是灰色「没配置」。`,
        `${ind}// noStars：那页是转发过来的，不跑 HEAD_SCRIPT，不该留进场动画的记号。`,
        `${ind}lightPageEnabled()`,
        `${ind}  ? { href: '/lamp', label: '台灯', noStars: true }`,
        `${ind}  : { href: '', label: '台灯', note: '没配置' },`,
      ].join('\n'),
  },
]);

console.log('\n' + '─'.repeat(52));
console.log(`改了 ${changed} 处，跳过 ${skipped} 处，失败 ${failed} 处。`);

if (changed > 0) {
  console.log('\n还要做两件事：');
  console.log('  1、把灯的管理页密码告诉晨暮星（转发时代签，浏览器不会再弹第二个登录框）：');
  console.log('       cd ~/vesper-phosphor');
  console.log("       grep -E '^LIGHT_BASIC_(USER|PASS)=' ~/Vesper-light/.env >> .env");
  console.log('  2、重启 vesper：');
  console.log('       pm2 restart vesper --update-env');
  console.log('\n然后手机上从三条杠菜单进「台灯」，或者直接开 /lamp。');
}

if (failed > 0) {
  console.log('\n有处没改成，上面已经把那里的实际原文打出来了。');
  process.exitCode = 1;
}
