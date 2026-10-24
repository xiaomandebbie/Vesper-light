# 03 · 按症状排错

出问题先看这篇。

## 启动就报「连不上底层米家服务」

按顺序查：

```bash
# 1. 底层在跑吗
ps aux | grep lamp_server

# 2. 端口对吗（.env 里的 LAMP_MIOT_URL）
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8890/mcp

# 3. token 对吗（401 就是不对）
curl -s -X POST http://127.0.0.1:8890/mcp \
  -H "authorization: Bearer $(cat ~/miot-lamp/lamp_token)" \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 200
```

**服务器刚重启过的话多半是第 1 条**：底层没有开机自启，它不会自己起来。

```bash
cd ~/miot-lamp/miot-mcp && source ../venv/bin/activate
nohup python lamp_server.py > ~/miot-lamp/server.log 2>&1 &
```

## 所有操作都失败，底层却是通的

小米登录失效了。`light_history` 里连续一片失败记录就是信号。

重新扫码见交接文档第 7 节：删 `auth_data.json`、跑 `login_once.py`、把二维码**用图片**扫（终端里的扫不出来），扫完立刻关掉临时服务、删共享目录和防火墙规则、删二维码文件。

## 灯自己变了，但 `light_history` 里没有记录

三种可能，按概率排：

1. **她在米家 App 里手动按的** —— 不经过本服务，记不到。最常见
2. **底层自己那套定时** —— 历史上在底层排过 `daily`。本库不用底层的定时，所以这边看不见它。查底层的 `lamp_list_schedules`
3. 灯自带的延时属性 —— 交接文档说那些没被使用也没实测

## 睡前守护没动

按这个顺序看日志：

```bash
pm2 logs vesper-light --lines 100 --nostream | grep guard
```

可能的原因，每一条日志里都写明了：

| 日志里写的 | 意思 | 要不要修 |
|---|---|---|
| `灯已经关了，不动` | 她已经睡了 | 不用，这是对的 |
| `读不出灯是开是关，这档不动` | 状态读失败 | 查底层 |
| `灯已经是 8，比 20 还暗，跳过` | 她自己调暗了 | 不用，只往下调是规矩 |
| `她还在忙「...」，整体推迟` | 时间感知说她没做完 | 不用；推够次数就会接着调 |
| `不在守护窗口里` | 过了 `LAMP_GUARD_WINDOW_END` | 窗口太短就改那个值 |
| `还没到下一档的时间` | 正常等着 | 不用 |

想看今夜的完整安排：调 `light_guard`，或打开 `/lamp` 页面。

## 守护把灯调暗了，但允朔不知道这事

小满问「灯怎么暗了」而他装傻，就是对话记录没写进去。查：

```bash
pm2 logs vesper-light --lines 50 --nostream | grep 对话记录
curl -s "http://127.0.0.1:3001/wake/conversation?limit=5" -H "x-api-key: 晨暮星的key"
```

要么 `VESPER_CONVERSATION_LOG` 关了，要么 `VESPER_URL` / `VESPER_API_KEY` 没配对。

## 允朔的工具列表里没有灯

```bash
pm2 logs phosphor --lines 50 --nostream | grep -i light
```

- 什么都没有 → 晨暮星 `.env` 里没有 `LIGHT_MCP_URL`，或者改了没带 `--update-env` 重启
- `could not connect MCP "light"` → 地址或 token 不对；两边的 token 必须是同一串
- 日志里有 `connected MCP: light` 但聊天里看不见 → **Aru 那边要重新连一次 MCP**

## 定时到点没执行

```bash
pm2 logs vesper-light --lines 100 --nostream | grep schedule
```

- `错过超过 N 分钟，标成 missed，不补执行` → 服务那会儿停着。**这是故意的**，避免半夜突然开灯。每天重复的会顺延
- `上一轮还没跑完，这一轮跳过` → 底层很慢（一次调用能到 20 秒）。偶尔一次没事，一直这样就查网络
- 定时在但一直不到点 → 查时区。配置摘要里那行写着实际用的时区

## 定时调了亮度但灯没开

这是设计。「七点把亮度调成 80」不等于「七点把灯开起来」——要开灯就再排一条 `action="on"`。

同理，定时套场景时灯关着**不动**：半夜三点自己把灯开起来是这套东西最不该做的事。

## 管理页打不开

- 404 → 没设 `LIGHT_BASIC_USER` / `LIGHT_BASIC_PASS`，页面整个没开。这是故意的
- 一直弹登录框 → 用户名密码不对
- 从外面访问不了 → 默认只听 127.0.0.1，要走 Caddy 反代

## 数据库锁住了

```
SQLITE_BUSY: database is locked
```

本库用自己的 `data/light.db`，正常只有一个进程在写。出现这个说明跑了两份：

```bash
pm2 list | grep light
ps aux | grep 'src/light.js'
```

多余的那个停掉。

## 想从头来一次

```bash
pm2 stop vesper-light
rm -f data/light.db data/light.db-wal data/light.db-shm
pm2 start vesper-light --update-env
```

操作记录、定时、守护档位全没了，`.env` 不受影响。
