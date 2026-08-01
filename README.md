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

发送消息到飞书群或用户。`chatId` 保留为兼容字段：群聊传 `oc_...` Chat ID，私聊传 `ou_...` 用户 Open ID；服务会自动选择正确的 `receive_id_type`。

```json
{
  "chatId": "oc_群聊ID 或 ou_用户OpenID",
  "message": "消息内容",
  "msgType": "text"
}
```

也可以通过可选字段 `receiveIdType` 明确指定 `chat_id`、`open_id`、`user_id`、`union_id` 或 `email`。

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

### 添加新会话前检查

在页面中添加新的群聊或私聊前，按下面顺序确认飞书配置：

1. 在飞书开发者后台为应用启用**机器人**能力，并创建、发布包含该能力的应用版本。
2. 在**权限管理**中至少开通以下权限之一，并发布包含该权限的应用版本：
   - **以应用的身份发消息**（`im:message:send_as_bot`，推荐）；
   - **获取与发送单聊、群组消息**（`im:message`）。
3. 如果目标是群聊：打开目标群的**设置 → 群机器人 → 添加机器人**，将本应用机器人加入群聊；同时确认群聊没有禁止机器人发言、全员禁言或仅允许指定成员发言。
4. 如果目标是私聊：确认目标用户位于应用机器人的可用范围内，且没有屏蔽机器人。
5. 添加会话时使用与场景匹配的 ID：群聊填写 `oc_...` Chat ID，私聊填写 `ou_...` 用户 Open ID，不要填写群名或用户名。

发送失败时可根据服务日志中的飞书错误码快速判断：

- `230002`：机器人不在目标群，请先将机器人加入该群；
- `230027`：应用缺少必要权限或授权；
- `230035`：机器人无发送权限，请检查群禁言、用户屏蔽或租户沟通限制；
- `230034`：接收 ID 无效或 ID 类型不匹配。

> 外部群还需要在飞书开发者后台为机器人开启对外共享能力，并受企业管理员的对外沟通策略限制。

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
