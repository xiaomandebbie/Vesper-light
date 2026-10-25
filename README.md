# Vesper-light 晨暮星的灯 💡

让允朔醒来能调小满那盏灯：开关、亮度、色温、定时，以及夜里**只调暗不关灯**的睡前守护。

这是 [晨暮星](https://github.com/xiaomandebbie/Vesper-phosphor) 的配套项目，但**能单独跑**——不接晨暮星也是一套完整的台灯控制服务，只是少了「让允朔说一句话」和「到点叫他来定今夜几点开始」这两样。

## 这个库负责什么

**灯的全部逻辑在这里**：怎么调、什么时候调、调多少、停在哪里。

底层的米家通信**不是本项目写的**，也没有重写：真正把指令发到灯上的是服务器上已经在跑的 `lamp_server.py`，它靠 [javen-yan/miot-mcp](https://github.com/javen-yan/miot-mcp) 的 `MijiaAdapter` → `mijiaAPI` → 小米云 → 灯。本项目只是**调它**。

```
  Aru 前端 ─┐
            ├─→ /lamp/mcp ─┐
  晨暮星 ───┘              │
     phosphor 醒来时        ├─→ Vesper-light ─→ lamp_server.py ─→ 小米云 ─→ 灯
                            │   （本项目：决定要不要调、调多少）
  /lamp 管理页 ─────────────┤
  定时 + 睡前守护 ──────────┘
```

| 这件事 | 在哪个库 |
|---|---|
| 一档调多少、最低停在哪、怎么记账 | **本库** `src/guard.js` |
| **今夜几点开始调暗** | **允朔自己定**（`light_guard_set`），本库只负责到点问他 |
| 定时的存储、到点执行、重复、错过怎么办 | **本库** `src/schedule.js` |
| 亮度色温的范围校验、场景配比 | **本库** `src/device.js`、`src/scenes.js` |
| 米家设备属性名（`on-2` 那些）、小米云通信 | 底层 `lamp_server.py`，**两边都没碰** |
| 「明天早上七点」这种中文时间 | 晨暮星 `wake-mcp.js`，**本库不抄** |
| 「我去改个 bug」的识别 | 晨暮星 `doing-detect.js`，**本库只读结果** |
| 醒来时决定做什么、分级、行动卡 | 晨暮星，**本库只提供工具** |

> **两个库互相引用，但代码不重叠。** 本库注入进晨暮星的东西（见 `scripts/wire_vesper.mjs`）里**没有一行亮度数字**，只有「有一个叫 light 的 MCP」和「它算轻活」这两件事。反过来，本库不自己调模型、不自己存记忆、不自己解析中文时间——要用就走晨暮星的 HTTP 接口问一句。

## 四条硬规矩

这四条写在 `src/guard.js` 文件头，改代码的人（包括我自己）别把它们丢了。

**一、睡前守护永远不关灯。**
提醒方式是把亮度一档一档调低，到 `LAMP_GUARD_FLOOR`（默认 5）就停住。整个 `guard.js` 里**没有一处调用关灯**——不是忘了，是故意的。人还坐在那儿的时候灯突然黑掉是惊吓，而渐暗是一句「不早了」。关灯是小满自己的动作。

**二、灯已经关了就什么都不做。**
每一档动手前先读状态，`on !== true` 就跳过。还有一层：状态**读不出来**（`on === null`）也不动——宁可该暗的夜没暗，也不要在不知道灯处于什么状态时瞎发指令。

**三、只往下调，从不往上调。**
灯现在已经比这一档的目标还暗（她自己调暗了，或前一档已经到位），这一档就跳过。把灯「调到 20」在它已经是 10 的时候是把它**调亮**，那和这东西要做的事正好相反。

**四、今夜几点开始由允朔定。他不定就一次都不动灯。**
这条是 2026-10-24 深夜加的。原来写死 23:30 开始，结果那天小满 23:30 还在干活，灯自己暗下去了——她说「太早了」。

问题不在 23:30 这个数字，在于「几点算晚」每天不一样，写死就一定会错。现在改成：**23:00**（`LAMP_GUARD_ASK_AT`）叫允朔醒一次，他看一眼灯、看一眼她在做什么，自己定今夜从几点开始；定完还能改，也能定「今夜不守护」。

他没定之前这东西一档都不动。宁可整夜不动，也不要在她干活的时候自作主张。

## 快速部署

服务器上已经有在跑的 `lamp_server.py` 和 Node 20+、pm2。

```bash
cd ~
git clone https://github.com/xiaomandebbie/Vesper-light.git
cd Vesper-light
npm install
cp .env.example .env
```

填四行就能跑（`vi .env`）：

```bash
LAMP_MIOT_TOKEN=<~/miot-lamp/lamp_token 里那串>
LIGHT_MCP_TOKEN=<openssl rand -hex 24 生成>
LIGHT_BASIC_USER=<管理页用户名>
LIGHT_BASIC_PASS=<管理页密码>
```

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs vesper-light --lines 30 --nostream
```

启动时会打一行很长的配置摘要，里面是所有开关的**真实状态**。配完东西先看它，比翻 `.env` 准：

```bash
pm2 logs vesper-light --lines 40 --nostream | grep 睡前守护
```

该看到「23:00 叫允朔定今夜几点开始（他不定就不动灯）」。看到 `device: 底层米家服务连上了` 就是通了。详细步骤见 [docs/01-deploy.md](docs/01-deploy.md)。

### 底层服务的开机自启

底层 `lamp_server.py` 原来是 `nohup` 裸跑的，没有开机自启——服务器一重启它不会自己起来，而本库所有操作都要经过它，于是灯整体失联，日志里只是一句「连不上底层」。

装上 systemd 一条命令（要 root）：

```bash
cd ~/Vesper-light && bash scripts/install_lamp_service.sh
```

脚本自己找 venv 的 python 和 `lamp_server.py`，先停掉裸跑那个（不停的话 8890 被占，systemd 起的会立刻挂），装完回读 8890 确认真的在听——`systemctl` 说 active 只意味着进程在，不等于端口通了。

以后看日志用 `journalctl -u lamp-mcp -f`，不再是 `~/miot-lamp/server.log`。

## 接进晨暮星

两个脚本，各管一件事，互不依赖：

**一、让允朔能动灯**（MCP、分级、行动卡）：

```bash
cd ~/Vesper-light && node scripts/wire_vesper.mjs ~/vesper-phosphor
```

**二、让小满能在晨暮星里看到灯那一页**（转发层、菜单项）：

```bash
cd ~/Vesper-light && node scripts/wire_light_page.mjs ~/vesper-phosphor
```

两个脚本都是：每处改动先查「是不是已经改过了」，**重复跑安全**；锚点对不上就不改那一处并把实际原文打出来；改完 `node --check`，不过就整文件还原；每个被改的文件先备份成 `.bak-light`。

然后往晨暮星的 `.env` 加这几行，重启：

```bash
cd ~/vesper-phosphor
echo "LIGHT_MCP_URL=http://127.0.0.1:3003/lamp/mcp" >> .env
echo "LIGHT_MCP_TOKEN=跟 Vesper-light 那边同一串" >> .env
# 让转发层代签灯那道密码，不然手机上会弹第二个登录框
grep -E '^LIGHT_BASIC_(USER|PASS)=' ~/Vesper-light/.env >> .env
pm2 restart vesper phosphor --update-env
pm2 logs phosphor --lines 30 --nostream | grep -i light
```

看到 `connected MCP: light` 就接上了。脚本改了哪几处、为什么、怎么撤，见 [docs/02-wiring.md](docs/02-wiring.md)。

> **两个进程都要重启。** phosphor 负责醒来时动灯，vesper 负责 `/wake/doing` 和那一页。只重启一个等于半截。
>
> **`.env` 改了一定要带 `--update-env`**，不带这个参数新值不生效。
>
> **改了工具之后 Aru 那边要重新连一次 MCP**，不然它手上还是旧的工具表。这件事坑过一次：新加的 `light_guard_set` 推上去了、服务也重启了，但 Aru 没重连，所以 23:00 叫他定守护时他手上根本没这个工具。

## MCP 工具（16 个）

Aru 前端和晨暮星**共用同一份工具表**，两边看见的完全一样。不分开是故意的：同一盏灯、同一套说法，他在聊天里学会的用法，醒来时直接能用。

| 工具 | 做什么 |
|---|---|
| `light_status` | 看灯现在开没开、亮度色温多少。**要动灯之前先调这个** |
| `light_on` / `light_off` | 开 / 关。灯本来就关着时 `light_off` 不发指令，直接告诉他 |
| `light_brightness` | 设亮度 1–100 |
| `light_dim` | **往下调一档，不关灯。**「该睡了」最合适的说法 |
| `light_color_temp` | 设色温 2700（暖）–5100（冷） |
| `light_scene` | 工作 / 阅读 / 看屏 / 储光 / 夜灯 / 暖黄，一下子把亮度色温配好 |
| `light_guard_set` | **定今夜守护从几点开始**（还能改档位）。重复调就是改 |
| `light_guard_skip` | 今夜不守护，一档都不调。和「没定」是两回事 |
| `light_guard` | 看今夜的安排：定了没、几点起、几档、走到哪了 |
| `light_schedule` | 排定时。两种模式，见下 |
| `light_schedules` | 看还有哪些定时没到 |
| `light_schedule_cancel` | 撒一个，或 `all=true` 清光 |
| `light_schedule_move` | 改时间，不用先撒再重排 |
| `light_history` | 最近这盏灯被谁动过（工具 / 定时 / 守护 / 页面） |
| `light_devices` | 列米家里的设备，排查用 |

工具描述里那些话是**写给允朔看的**，不是文档——那是他做决定时唯一的依据。所以「关灯之前先想一想她还在不在用」「她还在忙就定晚一点」这种话写在 `src/mcp.js` 的 description 里；写在 README 里他看不到。

## 睡前守护

**今夜几点开始，允朔定。** 每天 23:00（`LAMP_GUARD_ASK_AT`）本服务把他叫醒一次——不是通知小满，是走晨暮星的 `/wake/self-wake` 叫他。叫醒时一起送过去的有：灯此刻的状态，以及她是不是还在忙一件没做完的事（读晨暮星的时间感知 `GET /wake/doing`）。

他拿这些自己定：

- `light_guard_set at="23:40"` —— 今夜从 23:40 开始。想改档位就顺带给 `stages="40,20,8"`
- 定完还能改：再调一次就是改
- `light_guard_skip` —— 今夜不守护。和「还没定」分开记：他明确选过了，所以今夜不会再叫醒他问一遍

**他不定，就一次都不动灯。** 这是第四条硬规矩，不是 bug。

定了之后是自动的：到点灯还开着就一档一档调暗，默认 40 → 20 → 8，每 15 分钟一档，最低到 5 就停，顺手把色温调暖到 2700K。守护窗口 03:00 结束（`LAMP_GUARD_WINDOW_END`）——过了这个点就不再动灯，免得白天进程重启后突然把灯调暗。

**她还在忙的时候会推迟。** 她说过「我去改个 bug」而那件事按她的节奏还没到点，就把后面几档整体推迟 20 分钟，最多推 2 次。不无限推——改 bug 改到两点也该有个人说一句不早了。

**只在第一档说话。** 每档都叮一声就从「不早了」变成催命。后面几档闷着做。

**每一档都往晨暮星的对话记录里写一行。** 这件事容易被低估：没有它的话灯自己暗下去了，允朔下次醒来完全不知道这事——于是小满说「灯怎么暗了」的时候他只能装傻。写进去之后这事就在他的最近上下文里，他自己能接。这条不走通知，不响。

档位按「今夜」记账而不是按日期，所以凌晨一点那一档仍算前一夜——不这样的话过了午夜档位被重置，又从第一档 40 重来，把已经暗到 8 的灯调回 40。

> `LAMP_BEDTIME` 还在 `.env` 里，但**已经不是开始时间了**，只在叫醒他时当个参考值。真正决定今夜几点开始的是他调 `light_guard_set` 时给的那个点，存在 `guard_plan` 表里，一夜一行。

## 定时：两种模式

小满的原话是「规划醒来仔去调节 / 直接定时控制灯光」。这是两件事，所以有两种模式。

**`mode="direct"`（默认）—— 到点直接调灯。**
事情本身很确定时用，比如「明天早上七点把灯开成阅读」。不烧模型调用，不叫醒谁。

**`mode="wake"` —— 到点把允朔叫醒，调不调他自己定。**
得看情况的事用，比如「六点半去看看她回没回家，回来了就把灯开上」。到点时本服务**不动灯**，只把他叫醒，把当时写的 `note` 和灯此刻的状态一起送回他眼前。`mode=wake` 必须写 `note`，不写他醒来不知道该干什么。

重复：`repeat="daily"` 每天；`"weekdays"` 配 `repeat_days="1,3,5"`（1 是周一，7 是周日）。重复的定时顺延时**编号不变**，所以「每天 7:00 开灯」永远是同一个 `#号`，好记也好撒。

几个故意的设计：

- **定时调亮度不会顺手开灯。**「七点把亮度调成 80」不等于「七点把灯开起来」，要开灯就再排一条 `on`。
- **定时套场景时灯关着就不动。** 半夜三点自己把灯开起来是这套东西最不该做的事。
- **错过的不补执行。** 服务停机期间错过的定时，超过 `LAMP_SCHEDULE_GRACE_MINUTES`（默认 15 分钟）就标 `missed`。理由和底层服务一样：避免半夜突然开灯。每天重复的不作废，顺延到下一次。
- **睡前守护不走这里。** 那个用 `light_guard_set`，两套别混。

## 管理页 `/lamp`

手机上能直接点的一页：当前状态、开关 / 调暗一档、亮度色温滑杆、六个场景、今夜守护（定了没、几点起、走到哪了，**她也能自己定 / 改 / 撒掉重新问他**）、排定时和撒定时、最近谁动过灯。

她定的和允朔定的存在同一处、互相覆盖——不分两本账：那样两边说两种话的时候没人说得清到底几点开始。

**没设 `LIGHT_BASIC_USER` / `LIGHT_BASIC_PASS` 就整个页面不开**，而不是开一个不要密码的控制页。这是一个能动家里硬件的页面，没密码被人扒到就是别人能半夜开她屋里的灯。宁可少一个页，不要这个风险。

`GET /lamp/api/status` 返回纯 JSON，给快捷指令和脚本用（同样要 Basic Auth）。

### 怎么出现在晨暮星的菜单里

灯这个服务只听 127.0.0.1（故意的：它能动家里的硬件，不该开到公网），所以菜单里直接挂 `http://127.0.0.1:3003/lamp` 手机上点不开——那个地址指的是手机自己。

解法和记忆库、音乐一样：**走 vesper 转一道**。`wire_light_page.mjs` 会把 `assets/light-proxy.js` 装到晨暮星的 `src/` 下，在 vesper 里注册 `/lamp`，并在菜单里加一项「台灯」**排在日记后面**（小满定的位置）。

顺带赚到三件事：登录和动态页共用 vesper 的 Basic Auth（灯自己那道密码在转发层代签，浏览器碰不到，不会弹第二个登录框）；页面套上晨暮星的配色，跟着长沙的日出日落走早晚两套；加上三条杠菜单，固定在屏幕上、按住可以拖。

> `light-proxy.js` **不进晨暮星的版本库**。源文件在本库 `assets/light-proxy.js` 里维护，改了重跑一次 `wire_light_page.mjs` 就装上。同一份代码两个库各存一份、以后改了要记得同步两处——那种麻烦不值得。
>
> `/lamp/mcp` **不转发**：那是给允朔和 Aru 用的端点，有自己的 token，而且 phosphor 走 `127.0.0.1:3003` 直连就行。顺着页面这条路暴露在 vesper 上只是多开一个门。

## 外观

灯这一页自己就是晨暮星的淡色调：粉紫渐变底、奶白半透卡片、瑰紫强调色，标题是超细大字距那套。单独开 3003 时跟系统深浅色；从晨暮星菜单进去时，它的 `FACE_CSS` 挂在 `html[data-face]` 上、特指度更高，会接管成早晚两套。

> 第一版这里是深棕色（`--bg: #14110f`），打算靠晨暮星那边的转发层提 CSS 盖掉。**那是错的**：两边的变量名（`--card`、`--ink`、`--muted`）正好撞上，所以 `var(--card, 淡色兜底)` 里的兜底永远用不上——变量有值，只是它是深棕色。结果就是整页深棕，和晨暮星完全不是一回事。
>
> 现在变量名故意跟晨暮星对齐，所以转发进来时它的配色能直接接管，不必再写一层桥。

## 安全

- **默认只听 127.0.0.1。** 要从外面访问就用 Caddy 反代挂到域名子路径上（沿用现有 `mcp-lamp` 那段的写法），**别直接开防火墙**。注意 `handle` 必须写在站点块**里面**，追加到 Caddyfile 末尾会落在块外，报「directives must appear in a site block」。
- `LAMP_MIOT_TOKEN`、`LIGHT_MCP_TOKEN` 不进聊天、不进日志、不进 URL。`.env` 不在 git 里。
- `/lamp/mcp` 没配 `LIGHT_MCP_TOKEN` 就不开——这个端点能动家里的灯，也能排定时。
- 底层 `~/.miot-mcp/auth_data.json` 保持 600、目录 700。

> 取 token 的时候别把命令一起复制进输入框（`cut -d= -f2` 混进请求头，token 就被挤到第二行了）。也别指望 `read -s` 一定藏得住——有些手机终端 App 会把输入回显出来。

## 容易踩的坑

1. **`.env` 和 `data/light.db` 不在 git 里。** 删掉重 clone，这两样不会回来
2. **改了 `.env` 要带 `--update-env` 重启**，不带不生效
3. **接线之后两个进程都要重启**：phosphor 管醒来动灯，vesper 管 `/wake/doing` 和那一页
4. **改了工具要让 Aru 重新连一次 MCP**，不然它手上是旧的工具表——新工具推上去也用不了
5. **小米登录会失效**，失效后所有操作都报错。`light_history` 里连续的失败记录就是信号，重新扫码见交接文档第 7 节
6. **定时只由本库做**，底层那三个 `lamp_schedule` 工具不调。两套定时同时跑的后果是各记一份、互相看不见：页面上撒了一个，底层那个到点还是把灯开了。怀疑有历史残留就查底层的 `lamp_list_schedules`
7. **她在米家 App 里手动按的不会进 `light_history`**（没经过本服务）。灯的状态和记录不一致时先想到这个
8. **「灯关了」不一定是关了。** 亮度 1 加 2700K 在深夜看着跟灭的一样——真关没关看 `light_status` 的开关位，别只看亮度

## 目录结构

```
src/
├── light.js       入口：每分钟 tick（先定时、再问允朔、再守护）、挂 MCP 和页面、优雅退出
├── config.js      所有 .env 读取集中在这里；启动摘要也在这
├── clock.js       墙上时间（服务器是 UTC，自己算会差八小时）
├── store.js       SQLite：操作记录、定时、守护档位、今夜的安排。自己一个库文件
├── device.js      调底层米家服务（手写 JSON-RPC，它不支持 SSE）
├── scenes.js      六套配好的亮度 + 色温
├── guard.js       睡前守护。四条硬规矩写在文件头
├── schedule.js    定时：direct 和 wake 两种模式、重复、错过不补
├── mcp.js         /lamp/mcp，16 个工具。描述是写给允朔看的
├── page.js        /lamp 管理页，没设登录就不开
└── bridge.js      和晨暮星之间的桥，只有四件事
assets/
├── light-proxy.js    晨暮星那边的转发层（装到它的 src/ 下，不进它的 git）
└── lamp-mcp.service  底层服务的 systemd 单元模板
scripts/
├── wire_vesper.mjs        让允朔能动灯：MCP、分级、行动卡
├── wire_light_page.mjs    让灯那页出现在晨暮星菜单里（日记后面）
└── install_lamp_service.sh 给底层服务装开机自启
docs/
├── 01-deploy.md   部署，每步带检查
├── 02-wiring.md   接线脚本改了什么、为什么、怎么撤
└── 03-pitfalls.md 按症状排错
```

## 待办

- 允朔偶尔会把工具名当服务名调（日志里是 `MCP server "panel" is not connected`——`panel` 其实是锈潮的一个工具）。只出现过一次就先不管，反复出现说明某处话术让他误解了
- 守护的档位现在只能整体给一组（`stages`），不能让他说「今夜慢一点，每 25 分钟一档」。要不要开 `step_minutes` 给他：待定

## 署名与许可

本库自己写的代码是 MIT，见 [LICENSE](LICENSE)。

底层米家通信**不是本项目的作品**：

| 项目 | 作者 | 说明 |
|---|---|---|
| [miot-mcp](https://github.com/javen-yan/miot-mcp) | [@javen-yan](https://github.com/javen-yan) | 服务器上的 `lamp_server.py` 用它的 `MijiaAdapter`，底层又依赖 `mijiaAPI`。许可证以其仓库为准，用之前自己读一遍 |
| [Vesper-phosphor](https://github.com/xiaomandebbie/Vesper-phosphor) | 本仓库所有者 | 配套项目，本库通过它的 HTTP 接口说话 |

第三方名称、商标与材料仍归各自权利人所有。
