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
