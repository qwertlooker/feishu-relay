# Feishu Relay

飞书机器人消息中转服务，支持 WebSocket 长连接实时消息推送。

## 功能特性

- 飞书 WebSocket 长连接接收消息
- SSE 实时推送消息到前端
- 文本、图片、文件、Opus 音频和 MP4 视频消息收发
- 超长文本发送前确认并按 UTF-8 字节安全分段
- 引用回复与撤回机器人发送的消息
- 飞书富文本消息安全渲染
- REST API 发送、上传和资源下载
- 消息历史存储
- 草稿、跨会话消息搜索、会话管理、主题和已读状态

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
| `UPSTASH_REDIS_REST_URL`   | Upstash Redis REST 地址 |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST Token |
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
  "msgType": "text",
  "replyTo": "可选，待回复的消息 ID"
}
```

也可以通过可选字段 `receiveIdType` 明确指定 `chat_id`、`open_id`、`user_id`、`union_id` 或 `email`。

飞书文本消息单条请求体最大 150 KB。网页端以 140 KB 为安全阈值：超出时会先提示分段数量，只有用户确认后才按 `[序号/总数]` 标记顺序发送，并以 300 ms 间隔规避 5 QPS 限频。若中途失败，已成功的分段不会重复发送，剩余原文会恢复到输入框。直接调用 API 时，超过飞书 150 KB 限制的单条文本会返回 HTTP 413 和明确原因。

### POST /api/upload

上传图片或文件，随后把返回的 `content` 和 `msgType` 传给 `/api/send`。服务会将 Opus/Ogg 音频映射为飞书 `audio` 消息，将 MP4 视频映射为 `media` 消息，其余附件作为普通文件发送。

- 查询参数：`kind=image` 或 `kind=file`
- 请求体：原始二进制，`Content-Type: application/octet-stream`
- 请求头：`x-file-name` 使用 URL 编码后的文件名
- 请求头：`x-file-type` 建议传入原始 MIME 类型，用于识别音频和视频
- 限制：图片最大 10 MB，文件最大 30 MB

### DELETE /api/messages/:messageId

撤回机器人发送的飞书消息。是否允许撤回仍受飞书的消息归属、机器人入群状态和撤回时限约束。

### GET /api/messages/:messageId/resources/:fileKey

代理读取消息中的图片、文件、音频或视频资源。查询参数 `type` 支持 `image`、`file`、`audio`、`media`；`name` 可指定下载文件名。接收的消息优先使用消息资源接口，机器人自己发送的资源会自动回退到应用图片/文件接口。

### GET /api/chats

获取群列表。

### GET /api/health

返回服务健康状态、当前连接数和服务器版本。网页和服务器版本仅在设置中展示；版本不一致时，标题栏会显示“有新版本，请刷新”。

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
   如果需要图片或文件功能，还需开通**获取与上传图片或文件资源**权限。
3. 如果目标是群聊：打开目标群的**设置 → 群机器人 → 添加机器人**，将本应用机器人加入群聊；同时确认群聊没有禁止机器人发言、全员禁言或仅允许指定成员发言。
4. 如果目标是私聊：确认目标用户位于应用机器人的可用范围内，且没有屏蔽机器人。
5. 添加会话时使用与场景匹配的 ID：群聊填写 `oc_...` Chat ID，私聊填写 `ou_...` 用户 Open ID，不要填写群名或用户名。

发送失败时可根据服务日志中的飞书错误码快速判断：

- `230002`：机器人不在目标群，请先将机器人加入该群；
- `230020`：发送过快，请稍后重试；
- `230025`：消息体超长，请确认自动分段或缩短消息；
- `230027`：应用缺少必要权限或授权；
- `230035`：机器人无发送权限，请检查群禁言、用户屏蔽或租户沟通限制；
- `230034`：接收 ID 无效或 ID 类型不匹配。

> 外部群还需要在飞书开发者后台为机器人开启对外共享能力，并受企业管理员的对外沟通策略限制。

## 项目结构

```
feishu-relay/
├── server.js        # 配置并启动 Redis、飞书长连接和 HTTP 服务
├── app.js           # Express 路由与依赖注入
├── lib/             # 配置、存储、飞书服务、事件和 SSE 模块
├── public/
│   ├── index.html   # 前端页面结构
│   ├── styles.css   # 前端样式
│   ├── text-splitter.js # UTF-8 安全分段
│   └── app.js       # 前端交互逻辑
├── test/            # 单元与接口回归测试
├── .env.example     # 环境变量示例
├── dockerfile       # Docker 配置
└── package.json    # 依赖配置
```
