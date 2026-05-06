# WeChat AI Assistant

这是一个微信公众号 AI 助手后端：接收微信公众号消息，调用 OpenAI-compatible API，例如 DeepSeek，然后把回复返回到微信聊天页。

## 本地启动

复制环境变量示例：

```powershell
Copy-Item .env.example .env
notepad .env
```

启动服务：

```powershell
npm.cmd run dev
```

本地接口：

```text
http://localhost:3000/wechat
```

## 环境变量

```env
PORT=3000
WECHAT_TOKEN=my_ai_assistant_2026
AI_BASE_URL=https://api.deepseek.com/v1
AI_API_KEY=你的 DeepSeek API Key
AI_MODEL=deepseek-chat
AI_TIMEOUT_MS=4500
SYSTEM_PROMPT=你是一个接入微信公众号的AI智能助手，回答要清晰、简洁、友好。
```

注意：`.env` 里有真实密钥，不要上传到 GitHub。

## 微信公众号配置

进入微信公众平台：

```text
设置与开发 -> 基本配置 -> 服务器配置
```

填写：

```text
URL: https://你的公网域名/wechat
Token: 和 WECHAT_TOKEN 完全一致
EncodingAESKey: 随机生成
消息加解密方式: 明文模式
```

## 云部署

GitHub 只负责保存代码，真正让服务 24 小时运行需要部署到云平台，例如 Render、Railway、Fly.io、腾讯云、阿里云等。

云平台启动命令：

```text
npm start
```

健康检查地址：

```text
/health
```
