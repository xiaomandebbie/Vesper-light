# 01 · 部署

前提：服务器上 `lamp_server.py` 已经在跑（见那份交接文档），Node 20+ 和 pm2 已经有了。

## 1. 先确认底层活着

这一步别跳。底层不通的话后面全是白忙。

```bash
curl -s -X POST http://127.0.0.1:8890/mcp \
  -H "content-type: application/json" \
  -H "authorization: Bearer $(cat ~/miot-lamp/lamp_token)" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"lamp_status","arguments":{}}}'
```

应该返回类似 `桌面台灯: 关, 亮度 70, 色温 3596K` 的文字。

- 连接被拒 → `lamp_server.py` 没在跑。按交接文档第 3 节启动它
- 401 → token 不对
- 返回登录失效 → 要重新扫码，见交接文档第 7 节

## 2. 装

```bash
cd ~
git clone https://github.com/xiaomandebbie/Vesper-light.git
cd Vesper-light
npm install
```

`better-sqlite3` 要编译，机器上没有 `gcc` / `make` / `python3` 时会失败：

```bash
dnf install -y gcc-c++ make python3    # OpenCloudOS / CentOS 系
```

## 3. 配

```bash
cp .env.example .env
openssl rand -hex 24          # 这串留着当 LIGHT_MCP_TOKEN
vi .env
```

至少填这四样：

```bash
LAMP_MIOT_TOKEN=<~/miot-lamp/lamp_token 里那串>
LIGHT_MCP_TOKEN=<上面生成的>
LIGHT_BASIC_USER=<管理页用户名>
LIGHT_BASIC_PASS=<管理页密码>
```

其余全有默认值。每一项什么意思，`.env.example` 里逐条写了。

> 管理页那两个留空的话 `/lamp` **整个不开**。这是故意的：能动家里硬件的页面不该没有密码。

## 4. 起

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs vesper-light --lines 40 --nostream
```

该看到：

```
vesper-light 起来了。2026-10-24 22:30
  灯：桌面台灯，底层服务 http://127.0.0.1:8890/mcp（带 token）
  服务：127.0.0.1:3003，时区 Asia/Shanghai，管理页开着，MCP 端点开着
  睡前守护：开着，23:30 起每 15 分钟一档 40 → 20 → 8，最低 5 就停，顺手调暖到 2700K，窗口到 03:00，永不关灯
  ...
device: 底层米家服务连上了
```

**那行配置摘要是真实生效的值**，配完东西先看它，比翻 `.env` 准。

## 5. 验

```bash
# 活着没
curl -s http://127.0.0.1:3003/health

# 查状态（换成自己的用户名密码）
curl -s -u 用户名:密码 http://127.0.0.1:3003/lamp/api/status

# MCP 不带 token 应该是 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3003/lamp/mcp

# 带 token 应该列出 14 个工具
curl -s -X POST http://127.0.0.1:3003/lamp/mcp \
  -H "content-type: application/json" \
  -H "authorization: Bearer $(grep '^LIGHT_MCP_TOKEN=' .env | cut -d= -f2)" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400
```

手机上打开管理页（经 Caddy 反代之后）点一下「调暗一档」，再看 `light_history` 里有没有那条 `[页面]` 的记录。有就是整条链都通了。

## 6. 挂到域名上（可选）

默认只听 127.0.0.1。要从手机访问就在 `/etc/caddy/Caddyfile` 里加一段，沿用现有 `mcp-lamp` 那段的写法：

```
handle /lamp* {
  reverse_proxy 127.0.0.1:3003
}
```

```bash
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-light
# 改完
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
```

> **别直接在防火墙上开 3003。** 走 Caddy 至少有 https，管理页的密码不会在公网上裸传。

## 7. 开机自启

`pm2 save` 之后还要让 pm2 本身开机起来：

```bash
pm2 startup      # 按它打印的那条命令再执行一次
pm2 save
```

> 注意：**底层 `lamp_server.py` 仍然没有开机自启**（见交接文档第 8 节的待办）。服务器重启后它不会自己起来，这边会一直报连不上底层。那份交接文档建议给它写个 systemd，值得做。
