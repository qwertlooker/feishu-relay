# Feishu Relay

飞书机器人消息中转服务，支持 WebSocket 长连接实时消息推送。

## 功能特性

- 飞书 WebSocket 长连接接收消息
- SSE 实时推送消息到前端
- REST API 发送消息
- 消息历史存储

## 快速开始

### 安装依赖

```bash
npm install
```

### 配置环境变量

复制 `.env.example` 为 `.env`，填入你的飞书应用配置：

```bash
cp .env.example .env
```

必需的环境变量：

| 变量 | 说明 |
|------|------|
| `FEISHU_APP_ID` | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | 飞书应用 App Secret |
| `FEISHU_ENCRYPT_KEY` | 加密密钥（可选） |
| `FEISHU_VERIFICATION_TOKEN` | 验证 Token（可选） |
| `PORT` | 服务端口（默认 3000） |

### 启动服务

```bash
node server.js
```

## API 接口

### GET /api/events

SSE 实时消息流，连接后可实时接收消息。

### POST /api/send

发送消息到飞书群。

```json
{
  "chatId": "群 ID",
  "message": "消息内容",
  "msgType": "text"
}
```

### GET /api/chats

获取群列表。

### GET /api/health

健康检查。

## 使用 Docker

```bash
docker build -t feishu-relay .
docker run -d -p 3000:3000 --env-file .env feishu-relay
```

## 部署指南

### 第二步：在 Render 部署后端（3 分钟）

打开 `https://dashboard.render.com` → 注册/登录（GitHub 一键）。

点击 New → Web Service。

连接你的 GitHub 仓库 → 选择刚才的 feishu-relay。

配置如下（重要参数）：

- **Name**：随便填（如 feishu-relay）
- **Branch**：main
- **Runtime**：Node
- **Build Command**：留空（Render 自动 npm install）
- **Start Command**：node server.js
- **Instance Type**：Free（必须选这个才免费）

点击 Create Web Service。

部署完成后，进入服务页面 → Environment 标签，添加你的飞书密钥：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_ENCRYPT_KEY`
- `PORT=3000`（可选）

保存 → Render 会自动重启。

部署成功后，你会得到一个地址，例如：`https://feishu-relay.onrender.com`

这就是你的中转服务器地址！（免费 TLS 自动开启）

### 第三步：前端部署到 Cloudflare Pages（永久免费 + 全球加速）

把 index.html 单独上传到另一个 GitHub 仓库（或直接拖文件到 Cloudflare）。

登录 `https://pages.cloudflare.com` → Connect to Git 或 Direct Upload。

部署完成后得到 Pages URL，例如 `https://feishu-message.pages.dev`。

### 第四步：连接前后端（30 秒）

1. 打开你的前端页面 → 点击右上角 ⚙ 设置。
2. 服务器地址填：`https://你的-render.onrender.com`
3. 可选填默认 Chat ID。
4. 点击保存并重连。

大功告成！现在内网浏览器直接访问 Cloudflare Pages，前端通过 SSE 连接 Render 的 Node.js，后端维持飞书 WebSocket 长连接，所有功能（消息、已读、历史）完全和本地一样。

### 实用提示（避免小坑）

- **首次冷启动**：如果很久没人用（>15 分钟），打开前端页面后等 30–60 秒即可（Render 显示加载中）。
- **日志查看**：Render 仪表盘有实时日志，飞书 WS 重连、错误一目了然。
- **超过 750 小时**：如果多个用户常开页面超限，下月自动暂停（极少发生，个人/小团队够用）。想无限制只需升级 Starter 实例（$7/月）。
- **自定义域名**：Render 和 Cloudflare Pages 都支持免费绑定域名。
- **后续优化**：想加 Redis 防内存重启，Render 也有免费 Redis（但 90 天过期）。

## 项目结构

```
feishu-relay/
├── server.js        # 主服务
├── public/
│   └── index.html   # 前端页面
├── .env.example     # 环境变量示例
├── dockerfile       # Docker 配置
└── package.json    # 依赖配置
```
