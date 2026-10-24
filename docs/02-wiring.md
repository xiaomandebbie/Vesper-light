# 02 · 接线脚本改了什么

```bash
cd ~/Vesper-light && node scripts/wire_vesper.mjs ~/vesper-phosphor
```

## 为什么脚本在灯这个库里

它改的四处全是「灯的事」。放在这边，灯的什么东西改了、工具叫什么名字变了，只要改这一个文件；晨暮星那边不必跟着改，也不会因为灯的改动而开屏。

## 规矩

和晨暮星 `scripts/` 里那些补丁脚本一致：

- 每处改动先查「是不是已经改过了」，所以**重复跑安全**
- **锚点对不上就不改那一处**，并把周围实际原文打出来（服务器上的 `src/` 和仓库有分叉是常事，见晨暮星 README）
- 改完 `node --check` 过一遍，不过就把那个文件**原样还原**
- 每个被改的文件先备份成 `.bak-light`

## 改的四处

### 1. `src/vesper.js` → 加 `GET /wake/doing`

睡前守护到点时要问一句：她是不是还在忙一件没做完的事？是就把后面几档整体推迟。

这个端点只把 `doing` 表里**还没到点**的那几条原样给出去，不含任何灯的逻辑。用动态 `import` 是故意的：不动 `vesper.js` 顶上那一大堆 import，少一处冲突点。

读不到不算错——灯那边会当她不忙，守护照旧调暗。宁可按时调暗，也不要因为读不到一个可选接口就整夜不动。

### 2. `src/mcp-manager.js` → 把 `light` 这个 MCP 连上

这是允朔自己醒来时能动灯的全部前提。连上之后他在「轻的事」那一类里就能看见这套工具。

注入的代码里**没有一行亮度或色温**，只有连接地址和 token。

### 3. `src/budget.js` → 灯算 1 级（轻的事）

不写也能跑（`MCP_TIER` 里没列的 server 默认就是 1 级），写上是为了明确：调一下灯和逛论坛、听歌一样轻，不该和「发动态」抢同一个名额。

### 4. `src/actions/activity.js` → 行动卡的说法

不改的话卡片上会写「允朔刚刚用了 light 的 light_dim」。改了之后写「允朔刚刚把台灯调暗了一档」。

## 跑完还要做两件事

不做等于没改。

```bash
cd ~/vesper-phosphor
echo "LIGHT_MCP_URL=http://127.0.0.1:3003/lamp/mcp" >> .env
echo "LIGHT_MCP_TOKEN=跟 Vesper-light 那边同一串" >> .env
pm2 restart vesper phosphor --update-env
```

**两个进程都要重启**：phosphor 管醒来动灯，vesper 管 `/wake/doing`。只重启一个等于半截。

验证：

```bash
pm2 logs phosphor --lines 30 --nostream | grep -i light
# 看到 connected MCP: light 就是通了

curl -s http://127.0.0.1:3001/wake/doing -H "x-api-key: 晨暮星的REPORT_STATUS_API_KEY"
# 返回 {"ok":true,...,"active":[...]}
```

## 锚点对不上怎么办

脚本会把那一处的实际原文打出来。按那段原文手动加上就行——要加的东西脚本源码里就是现成的，照着抄。

改完手动跑一次语法检查：

```bash
cd ~/vesper-phosphor && node --check src/mcp-manager.js
```

## 怎么撤

```bash
cd ~/vesper-phosphor
for f in src/vesper.js src/mcp-manager.js src/budget.js src/actions/activity.js; do
  [ -f "$f.bak-light" ] && cp "$f.bak-light" "$f" && echo "还原了 $f"
done
pm2 restart vesper phosphor --update-env
```

或者更轻的办法：把晨暮星 `.env` 里的 `LIGHT_MCP_URL` 注释掉再重启。那样代码还在，但灯不出现在允朔的工具列表里。
