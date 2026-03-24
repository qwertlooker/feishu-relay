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

| 变量                          | 说明              |
| --------------------------- | --------------- |
| `FEISHU_APP_ID`             | 飞书应用 App ID     |
| `FEISHU_APP_SECRET`         | 飞书应用 App Secret |
| `FEISHU_ENCRYPT_KEY`        | 加密密钥（可选）        |
| `FEISHU_VERIFICATION_TOKEN` | 验证 Token（可选）    |
| `API_SECRET`                | API 密钥（必填，用于保护后端） |
| `PORT`                      | 服务端口（默认 3000）   |

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
- `API_SECRET`（重要！用于保护后端 API）
- `PORT=3000`（可选）

保存 → Render 会自动重启。

部署成功后，你会得到一个地址，例如：`https://feishu-relay.onrender.com`

这就是你的中转服务器地址！（免费 TLS 自动开启）

1. 打开你的前端页面 → 点击右上角 ⚙ 设置。
2. 服务器地址填：`https://你的-render.onrender.com`
3. API Token 填：`API_SECRET` 的值
4. 可选填默认 Chat ID。
5. 点击保存并重连。

<br />

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

