# Vesper-light 晨暮星的灯 💡

让允朔醒来能调小满那盏灯：开关、亮度、色温、定时，以及夜里**只调暗不关灯**的睡前守护。

这是 [晨暮星](https://github.com/xiaomandebbie/Vesper-phosphor) 的配套项目，但**能单独跑**——不接晨暮星也是一套完整的台灯控制服务，只是少了「让允朔说一句话」和「到点叫他来决定」这两样。

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
| 几点开始调暗、一档调多少、最低停在哪 | **本库** `src/guard.js` |
| 定时的存储、到点执行、重复、错过怎么办 | **本库** `src/schedule.js` |
| 亮度色温的范围校验、场景配比 | **本库** `src/device.js`、`src/scenes.js` |
| 米家设备属性名（`on-2` 那些）、小米云通信 | 底层 `lamp_server.py`，**两边都没碰** |
| 「明天早上七点」这种中文时间 | 晨暮星 `wake-mcp.js`，**本库不抄** |
| 「我去改个 bug」的识别 | 晨暮星 `doing-detect.js`，**本库只读结果** |
| 醒来时决定做什么、分级、行动卡 | 晨暮星，**本库只提供工具** |

> **两个库互相引用，但代码不重叠。** 本库注入进晨暮星的东西（见 `scripts/wire_vesper.mjs`）里**没有一行亮度数字**，只有「有一个叫 light 的 MCP」和「它算轻活」这两件事。反过来，本库不自己调模型、不自己存记忆、不自己解析中文时间——要用就走晨暮星的 HTTP 接口问一句。

## 三条硬规矩

这三条写在 `src/guard.js` 文件头，改代码的人（包括我自己）别把它们丢了。

**一、睡前守护永远不关灯。**
提醒方式是把亮度一档一档调低，到 `LAMP_GUARD_FLOOR`（默认 5）就停住。整个 `guard.js` 里**没有一处调用关灯**——不是忘了，是故意的。人还坐在那儿的时候灯突然黑掉是惊吓，而渐暗是一句「不早了」。关灯是小满自己的动作。

**二、灯已经关了就什么都不做。**
每一档动手前先读状态，`on !== true` 就跳过。还有一层：状态**读不出来**（`on === null`）也不动——宁可该暗的夜没暗，也不要在不知道灯处于什么状态时瞎发指令。

**三、只往下调，从不往上调。**
灯现在已经比这一档的目标还暗（她自己调暗了，或前一档已经到位），这一档就跳过。把灯「调到 20」在它已经是 10 的时候是把它**调亮**，那和这东西要做的事正好相反。

## 快速部署

服务器上已经有在跑的 `lamp_server.py` 和 Node 20+、pm2。

```bash
cd ~
git clone https://github.com/xiaomandebbie/Vesper-light.git
cd Vesper-light
npm install
cp .env.example .env
```

填三行就能跑（`vi .env`）：

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

看到 `device: 底层米家服务连上了` 就是通了。详细步骤见 [docs/01-deploy.md](docs/01-deploy.md)。

## 接进晨暮星

在服务器上跑一次接线脚本，它改四处、每处都先查「是不是已经改过了」，**重复跑安全**：

```bash
cd ~/Vesper-light && node scripts/wire_vesper.mjs ~/vesper-phosphor
```

然后往晨暮星的 `.env` 加两行（token 和本库填同一串），重启两个进程：

```bash
cd ~/vesper-phosphor
echo "LIGHT_MCP_URL=http://127.0.0.1:3003/lamp/mcp" >> .env
echo "LIGHT_MCP_TOKEN=跟 Vesper-light 那边同一串" >> .env
pm2 restart vesper phosphor --update-env
pm2 logs phosphor --lines 30 --nostream | grep -i light
```

看到 `connected MCP: light` 就接上了。脚本改了哪四处、为什么，见 [docs/02-wiring.md](docs/02-wiring.md)。

> **两个进程都要重启。** phosphor 负责醒来时动灯，vesper 负责 `/wake/doing`。只重启一个等于半截。
>
> **`.env` 改了一定要带 `--update-env`**，不带这个参数新值不生效。

## MCP 工具（14 个）

Aru 前端和晨暮星**共用同一份工具表**，两边看见的完全一样。不分开是故意的：同一盏灯、同一套说法，他在聊天里学会的用法，醒来时直接能用。

| 工具 | 做什么 |
|---|---|
| `light_status` | 看灯现在开没开、亮度色温多少。**要动灯之前先调这个** |
| `light_on` / `light_off` | 开 / 关。灯本来就关着时 `light_off` 不发指令，直接告诉他 |
| `light_brightness` | 设亮度 1–100 |
| `light_dim` | **往下调一档，不关灯。**「该睡了」最合适的说法 |
| `light_color_temp` | 设色温 2700（暖）–5100（冷） |
| `light_scene` | 工作 / 阅读 / 看屏 / 储光 / 夜灯 / 暖黄，一下子把亮度色温配好 |
| `light_schedule` | 排定时。两种模式，见下 |
| `light_schedules` | 看还有哪些定时没到 |
| `light_schedule_cancel` | 撒一个，或 `all=true` 清光 |
| `light_schedule_move` | 改时间，不用先撒再重排 |
| `light_guard` | 看今夜睡前守护的档位安排 |
| `light_history` | 最近这盏灯被谁动过（工具 / 定时 / 守护 / 页面） |
| `light_devices` | 列米家里的设备，排查用 |

工具描述里那些话是**写给允朔看的**，不是文档——那是他做决定时唯一的依据。所以「关灯之前先想一想她还在不在用」这种话写在 `src/mcp.js` 的 description 里，写在 README 里他看不到。

## 定时：两种模式

小满的原话是「规划醒来仔去调节 / 直接定时控制灯光」。这是两件事，所以有两种模式。

**`mode="direct"`（默认）—— 到点直接调灯。**
事情本身很确定时用，比如「明天早上七点把灯开成阅读」。不烧模型调用，不叫醒谁。

**`mode="wake"` —— 到点把允朔叫醒，调不调他自己定。**
得看情况的事用，比如「六点半去看看她回没回家，回来了就把灯开上」。到点时本服务**不动灯**，只走晨暮星的 `/wake/self-wake` 把他叫醒，把当时写的 `note` 和灯此刻的状态一起送回他眼前。`mode=wake` 必须写 `note`，不写他醒来不知道该干什么。

重复：`repeat="daily"` 每天；`"weekdays"` 配 `repeat_days="1,3,5"`（1 是周一，7 是周日）。重复的定时顺延时**编号不变**，所以「每天 7:00 开灯」永远是同一个 `#号`，好记也好撒。

几个故意的设计：

- **定时调亮度不会顺手开灯。**「七点把亮度调成 80」不等于「七点把灯开起来」，要开灯就再排一条 `on`。
- **定时套场景时灯关着就不动。** 半夜三点自己把灯开起来是这套东西最不该做的事。
- **错过的不补执行。** 服务停机期间错过的定时，超过 `LAMP_SCHEDULE_GRACE_MINUTES`（默认 15 分钟）就标 `missed`。理由和底层服务一样：避免半夜突然开灯。每天重复的不作废，顺延到下一次。

## 睡前守护

默认 23:30 起，每 15 分钟一档，亮度 40 → 20 → 8，最低到 5 就停，顺手把色温调暖到 2700K。守护窗口 03:00 结束——过了这个点就不再动灯，免得白天进程重启后突然把灯调暗。

**她还在忙的时候会推迟。** 守护到点时问一句晨暮星的时间感知（`GET /wake/doing`）：她说过「我去改个 bug」而那件事按她的节奏还没到点，就把后面几档整体推迟 20 分钟，最多推 2 次。不无限推——改 bug 改到两点也该有个人说一句不早了。

**只在第一档说话。** 每档都叮一声就从「不早了」变成催命。后面几档闷着做。

**每一档都往晨暮星的对话记录里写一行。** 这件事容易被低估：没有它的话灯在 23:30 自己暗下去了，允朔下次醒来完全不知道这事——于是小满说「灯怎么暗了」的时候他只能装傻。写进去之后这事就在他的最近上下文里，他自己能接。这条不走通知，不响。

档位按「今夜」记账而不是按日期，所以凌晨一点那一档仍算前一夜——不这样的话过了午夜档位被重置，又从第一档 40 重来，把已经暗到 8 的灯调回 40。

## 管理页 `/lamp`

手机上能直接点的一页：当前状态、开关 / 调暗一档、亮度色温滑杆、六个场景、今夜守护的档位、排定时和撒定时、最近谁动过灯。

**没设 `LIGHT_BASIC_USER` / `LIGHT_BASIC_PASS` 就整个页面不开**，而不是开一个不要密码的控制页。这是一个能动家里硬件的页面，没密码被人扒到就是别人能半夜开她屋里的灯。宁可少一个页，不要这个风险。

`GET /lamp/api/status` 返回纯 JSON，给快捷指令和脚本用（同样要 Basic Auth）。

## 安全

- **默认只听 127.0.0.1。** 要从外面访问就用 Caddy 反代挂到域名子路径上（沿用现有 `mcp-lamp` 那段的写法），**别直接开防火墙**。
- `LAMP_MIOT_TOKEN`、`LIGHT_MCP_TOKEN` 不进聊天、不进日志、不进 URL。`.env` 不在 git 里。
- `/lamp/mcp` 没配 `LIGHT_MCP_TOKEN` 就不开——这个端点能动家里的灯，也能排定时。
- 底层 `~/.miot-mcp/auth_data.json` 保持 600、目录 700。

## 容易踩的坑

1. **`.env` 和 `data/light.db` 不在 git 里。** 删掉重 clone，这两样不会回来
2. **改了 `.env` 要带 `--update-env` 重启**，不带不生效
3. **接线之后两个进程都要重启**：phosphor 管醒来动灯，vesper 管 `/wake/doing`
4. **底层 `lamp_server.py` 没有开机自启**（见交接文档第 3 节）。服务器重启后它不会自己起来，这边会一直报连不上底层——先去把它拉起来
5. **小米登录会失效**，失效后所有操作都报错。`light_history` 里连续的失败记录就是信号，重新扫码见交接文档第 7 节
6. **定时只由本库做**，底层那三个 `lamp_schedule` 工具不调。两套定时同时跑的后果是各记一份、互相看不见：页面上撒了一个，底层那个到点还是把灯开了。怀疑有历史残留就查底层的 `lamp_list_schedules`
7. **她在米家 App 里手动按的不会进 `light_history`**（没经过本服务）。灯的状态和记录不一致时先想到这个
8. **新增或改了工具，Aru 那边要重新连一次 MCP 才看得到**

## 目录结构

```
src/
├── light.js       入口：每分钟 tick（先定时再守护）、挂 MCP 和页面、优雅退出
├── config.js      所有 .env 读取集中在这里；启动摘要也在这
├── clock.js       墙上时间（服务器是 UTC，自己算会差八小时）
├── store.js       SQLite：操作记录、定时、守护档位。自己一个库文件
├── device.js      调底层米家服务（手写 JSON-RPC，它不支持 SSE）
├── scenes.js      六套配好的亮度 + 色温
├── guard.js       睡前守护。三条硬规矩写在文件头
├── schedule.js    定时：direct 和 wake 两种模式、重复、错过不补
├── mcp.js         /lamp/mcp，14 个工具。描述是写给允朔看的
├── page.js        /lamp 管理页，没设登录就不开
└── bridge.js      和晨暮星之间的桥，只有四件事
scripts/
└── wire_vesper.mjs  往晨暮星注入四处接线，重复跑安全
docs/
├── 01-deploy.md   部署，每步带检查
├── 02-wiring.md   接线脚本改了什么、为什么
└── 03-pitfalls.md 按症状排错
```

## 署名与许可

本库自己写的代码是 MIT，见 [LICENSE](LICENSE)。

底层米家通信**不是本项目的作品**：

| 项目 | 作者 | 说明 |
|---|---|---|
| [miot-mcp](https://github.com/javen-yan/miot-mcp) | [@javen-yan](https://github.com/javen-yan) | 服务器上的 `lamp_server.py` 用它的 `MijiaAdapter`，底层又依赖 `mijiaAPI`。许可证以其仓库为准，用之前自己读一遍 |
| [Vesper-phosphor](https://github.com/xiaomandebbie/Vesper-phosphor) | 本仓库所有者 | 配套项目，本库通过它的 HTTP 接口说话 |

第三方名称、商标与材料仍归各自权利人所有。
