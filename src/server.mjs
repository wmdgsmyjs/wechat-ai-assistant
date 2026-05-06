import http from "node:http";
import crypto from "node:crypto";

const port = Number(process.env.PORT || 3000);
const wechatToken = process.env.WECHAT_TOKEN;
const aiBaseUrl = process.env.AI_BASE_URL;
const aiApiKey = process.env.AI_API_KEY;
const aiModel = process.env.AI_MODEL || "deepseek-chat";
const aiTimeoutMs = Number(process.env.AI_TIMEOUT_MS || 4500);
const systemPrompt =
  process.env.SYSTEM_PROMPT ||
  "你是一个接入微信公众号的AI智能助手，回答要清晰、简洁、友好。";

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

  if (message.MsgType !== "text") {
    const reply = buildTextReply({
      toUser: message.FromUserName,
      fromUser: message.ToUserName,
      content: "我现在先支持文字聊天。你可以直接发问题给我。",
    });
    return sendXml(res, reply);
  }

  const userText = (message.Content || "").trim();
  const aiReply = await askAi(userText, message.FromUserName);

  const reply = buildTextReply({
    toUser: message.FromUserName,
    fromUser: message.ToUserName,
    content: aiReply,
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), aiTimeoutMs);

  try {
    const response = await fetch(`${aiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${aiApiKey}`,
      },
      body: JSON.stringify({
        model: aiModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ],
        user: userId,
        temperature: 0.7,
        max_tokens: 180,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI API error:", response.status, errorText);
      return "AI 服务暂时没有成功响应，请稍后再试。";
    }

    const content = await readStreamingReply(response);
    return content || "我没有生成有效回复，请再试一次。";
  } catch (error) {
    if (error.name === "AbortError") {
      console.warn(`AI request timed out after ${aiTimeoutMs}ms.`);
      return "AI 正在忙，请稍后再发一次。";
    }

    console.error("AI request failed:", error);
    return "AI 服务连接失败，请稍后再试。";
  } finally {
    clearTimeout(timeout);
  }
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

function parseWechatXml(xml) {
  return {
    ToUserName: getXmlValue(xml, "ToUserName"),
    FromUserName: getXmlValue(xml, "FromUserName"),
    CreateTime: getXmlValue(xml, "CreateTime"),
    MsgType: getXmlValue(xml, "MsgType"),
    Content: getXmlValue(xml, "Content"),
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
