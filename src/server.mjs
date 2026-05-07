import http from "node:http";
import crypto from "node:crypto";

const port = Number(process.env.PORT || 3000);
const wechatToken = process.env.WECHAT_TOKEN;
const wechatAppId = process.env.WECHAT_APP_ID;
const wechatAppSecret = process.env.WECHAT_APP_SECRET;

const aiBaseUrl = process.env.AI_BASE_URL;
const aiApiKey = process.env.AI_API_KEY;
const aiModel = process.env.AI_MODEL || "deepseek-chat";
const aiTimeoutMs = Number(process.env.AI_TIMEOUT_MS || 4500);

const visionBaseUrl = process.env.VISION_BASE_URL || aiBaseUrl;
const visionApiKey = process.env.VISION_API_KEY || aiApiKey;
const visionModel = process.env.VISION_MODEL || "";
const visionTimeoutMs = Number(process.env.VISION_TIMEOUT_MS || 8000);

const memoryTurns = Number(process.env.MEMORY_TURNS || 6);
const conversationMemory = new Map();
const defaultSystemPrompt = [
  "你是公众号的AI助理，语气自然、聪明、清晰，像一个可靠的真人助理。",
  "你要优先给出有用、可执行的回答，不要空泛客套。",
  "问题不明确时，先用一句话追问关键缺口。",
  "回答尽量简洁，但需要步骤、清单或示例时可以分点说明。",
  "不要编造不确定的信息；不确定时说明原因，并给出下一步建议。",
].join("\n");
const systemPrompt = process.env.SYSTEM_PROMPT || defaultSystemPrompt;

let cachedWechatToken = null;

if (!wechatToken) {
  console.warn("Missing WECHAT_TOKEN. Fill it before configuring WeChat.");
}

if (!aiBaseUrl || !aiApiKey) {
  console.warn("Missing AI_BASE_URL or AI_API_KEY. AI replies will fail until configured.");
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/health") {
      return sendText(res, 200, "ok");
    }

    if (url.pathname !== "/wechat") {
      return sendText(res, 404, "not found");
    }

    if (req.method === "GET") {
      return verifyWechatServer(url, res);
    }

    if (req.method === "POST") {
      return handleWechatMessage(req, res);
    }

    return sendText(res, 405, "method not allowed");
  } catch (error) {
    console.error(error);
    return sendText(res, 500, "server error");
  }
});

server.listen(port, () => {
  console.log(`WeChat AI assistant listening on http://localhost:${port}`);
  console.log(`WeChat callback path: http://localhost:${port}/wechat`);
});

function verifyWechatServer(url, res) {
  const signature = url.searchParams.get("signature") || "";
  const timestamp = url.searchParams.get("timestamp") || "";
  const nonce = url.searchParams.get("nonce") || "";
  const echostr = url.searchParams.get("echostr") || "";

  if (!isValidWechatSignature({ signature, timestamp, nonce })) {
    return sendText(res, 403, "invalid signature");
  }

  return sendText(res, 200, echostr);
}

async function handleWechatMessage(req, res) {
  const body = await readRequestBody(req);
  const message = parseWechatXml(body);

  if (!message.FromUserName || !message.ToUserName) {
    return sendText(res, 400, "invalid message");
  }

  if (message.MsgType === "text") {
    const userText = (message.Content || "").trim();
    const aiReply = await askAi(userText, message.FromUserName);
    return sendXmlReply(res, message, aiReply);
  }

  if (message.MsgType === "image") {
    const imageReply = await askVision(message);
    return sendXmlReply(res, message, imageReply);
  }

  return sendXmlReply(res, message, "我现在支持文字和图片。你可以直接发问题，或发一张图片让我帮你看。");
}

function sendXmlReply(res, message, content) {
  const reply = buildTextReply({
    toUser: message.FromUserName,
    fromUser: message.ToUserName,
    content,
  });
  return sendXml(res, reply);
}

function isValidWechatSignature({ signature, timestamp, nonce }) {
  if (!wechatToken || !signature || !timestamp || !nonce) {
    return false;
  }

  const raw = [wechatToken, timestamp, nonce].sort().join("");
  const digest = crypto.createHash("sha1").update(raw).digest("hex");
  return digest === signature;
}

async function askAi(userText, userId) {
  if (!aiBaseUrl || !aiApiKey) {
    return "AI API 还没有配置好，请先填写 AI_BASE_URL 和 AI_API_KEY。";
  }

  const history = getConversation(userId);
  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: userText },
  ];

  const reply = await requestChatCompletion({
    baseUrl: aiBaseUrl,
    apiKey: aiApiKey,
    model: aiModel,
    messages,
    timeoutMs: aiTimeoutMs,
    maxTokens: 260,
    stream: true,
    user: userId,
  });

  if (reply.ok) {
    rememberTurn(userId, userText, reply.content);
    return reply.content;
  }

  return reply.fallback;
}

async function askVision(message) {
  if (!visionModel) {
    return "我已经收到图片了，但还没有配置视觉模型。请在 Render 里配置 VISION_MODEL、VISION_BASE_URL 和 VISION_API_KEY。";
  }

  if (!visionBaseUrl || !visionApiKey) {
    return "图片识别 API 还没有配置好，请先填写视觉模型的 API 配置。";
  }

  const imageSource = await getWechatImageSource(message);
  if (!imageSource) {
    return "我收到图片了，但暂时没能读取到图片内容。请稍后再试，或重新发送图片。";
  }

  const messages = [
    {
      role: "system",
      content: "你是一个细致的图片理解助手。请先说出图片里看到了什么，再根据用户可能的需求给出简洁有用的判断或建议。",
    },
    {
      role: "user",
      content: [
        { type: "text", text: "请识别这张图片，并用中文简洁说明重点。" },
        { type: "image_url", image_url: { url: imageSource } },
      ],
    },
  ];

  const reply = await requestChatCompletion({
    baseUrl: visionBaseUrl,
    apiKey: visionApiKey,
    model: visionModel,
    messages,
    timeoutMs: visionTimeoutMs,
    maxTokens: 350,
    stream: false,
  });

  return reply.ok ? reply.content : reply.fallback;
}

async function requestChatCompletion({
  baseUrl,
  apiKey,
  model,
  messages,
  timeoutMs,
  maxTokens,
  stream,
  user,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        user,
        temperature: 0.7,
        max_tokens: maxTokens,
        stream,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI API error:", response.status, errorText);
      return { ok: false, fallback: "AI 服务暂时没有成功响应，请稍后再试。" };
    }

    const content = stream ? await readStreamingReply(response) : await readJsonReply(response);
    return {
      ok: Boolean(content),
      content,
      fallback: content || "我没有生成有效回复，请再试一次。",
    };
  } catch (error) {
    if (error.name === "AbortError") {
      console.warn(`AI request timed out after ${timeoutMs}ms.`);
      return { ok: false, fallback: "AI 正在忙，请稍后再发一次。" };
    }

    console.error("AI request failed:", error);
    return { ok: false, fallback: "AI 服务连接失败，请稍后再试。" };
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonReply(response) {
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function readStreamingReply(response) {
  if (!response.body) {
    return "";
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let content = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) {
        continue;
      }

      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        return content.trim();
      }

      try {
        const data = JSON.parse(payload);
        content += data.choices?.[0]?.delta?.content || "";
      } catch {
        // Ignore incomplete stream chunks.
      }
    }
  }

  return content.trim();
}

function getConversation(userId) {
  return conversationMemory.get(userId) || [];
}

function rememberTurn(userId, userText, assistantText) {
  const history = getConversation(userId);
  history.push({ role: "user", content: userText });
  history.push({ role: "assistant", content: assistantText });
  conversationMemory.set(userId, history.slice(-memoryTurns * 2));
}

async function getWechatImageSource(message) {
  if (wechatAppId && wechatAppSecret && message.MediaId) {
    const imageDataUrl = await downloadWechatMediaAsDataUrl(message.MediaId);
    if (imageDataUrl) {
      return imageDataUrl;
    }
  }

  return message.PicUrl || "";
}

async function downloadWechatMediaAsDataUrl(mediaId) {
  const accessToken = await getWechatAccessToken();
  if (!accessToken) {
    return "";
  }

  const url = new URL("https://api.weixin.qq.com/cgi-bin/media/get");
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("media_id", mediaId);

  const response = await fetch(url);
  const contentType = response.headers.get("content-type") || "image/jpeg";

  if (!response.ok || contentType.includes("application/json")) {
    console.error("WeChat media download failed:", await response.text());
    return "";
  }

  const imageBuffer = Buffer.from(await response.arrayBuffer());
  return `data:${contentType};base64,${imageBuffer.toString("base64")}`;
}

async function getWechatAccessToken() {
  const now = Date.now();
  if (cachedWechatToken && cachedWechatToken.expiresAt > now + 60_000) {
    return cachedWechatToken.value;
  }

  if (!wechatAppId || !wechatAppSecret) {
    return "";
  }

  const url = new URL("https://api.weixin.qq.com/cgi-bin/token");
  url.searchParams.set("grant_type", "client_credential");
  url.searchParams.set("appid", wechatAppId);
  url.searchParams.set("secret", wechatAppSecret);

  const response = await fetch(url);
  const data = await response.json();

  if (!data.access_token) {
    console.error("WeChat access_token failed:", data);
    return "";
  }

  cachedWechatToken = {
    value: data.access_token,
    expiresAt: now + Number(data.expires_in || 7200) * 1000,
  };
  return cachedWechatToken.value;
}

function parseWechatXml(xml) {
  return {
    ToUserName: getXmlValue(xml, "ToUserName"),
    FromUserName: getXmlValue(xml, "FromUserName"),
    CreateTime: getXmlValue(xml, "CreateTime"),
    MsgType: getXmlValue(xml, "MsgType"),
    Content: getXmlValue(xml, "Content"),
    PicUrl: getXmlValue(xml, "PicUrl"),
    MediaId: getXmlValue(xml, "MediaId"),
    MsgId: getXmlValue(xml, "MsgId"),
  };
}

function getXmlValue(xml, tagName) {
  const pattern = new RegExp(`<${tagName}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*<\\/${tagName}>`);
  const match = xml.match(pattern);
  return match ? decodeXml(match[1] ?? match[2] ?? "") : "";
}

function buildTextReply({ toUser, fromUser, content }) {
  const now = Math.floor(Date.now() / 1000);
  return `<xml>
  <ToUserName><![CDATA[${escapeCdata(toUser)}]]></ToUserName>
  <FromUserName><![CDATA[${escapeCdata(fromUser)}]]></FromUserName>
  <CreateTime>${now}</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[${escapeCdata(content)}]]></Content>
</xml>`;
}

function escapeCdata(value) {
  return String(value).replaceAll("]]>", "]]]]><![CDATA[>");
}

function decodeXml(value) {
  return String(value)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendXml(res, xml) {
  res.writeHead(200, { "content-type": "application/xml; charset=utf-8" });
  res.end(xml);
}
