const http = require("http");
const https = require("https");

const PORT = Number(process.env.PORT) || 1371;
const UPSTREAM_URL = "https://chatjimmy.ai/api/chat";
const DEFAULT_MODEL = "llama3.1-8B";
const DEFAULT_TOP_K = 1;
const DEFAULT_TEMPERATURE = 0;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function postUpstream(payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(UPSTREAM_URL);
    const request = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers: {
          "User-Agent": "node-proxy",
          Accept: "*/*",
          "Content-Type": "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({ statusCode: res.statusCode || 500, body: data });
        });
      }
    );

    request.on("error", reject);
    request.write(JSON.stringify(payload));
    request.end();
  });
}

function extractStats(rawText) {
  const match = rawText.match(/<\|stats\|>([\s\S]*?)<\|\/stats\|>/);
  if (!match) {
    return { cleaned: rawText, stats: null };
  }

  const cleaned = rawText.replace(match[0], "").trim();
  try {
    return { cleaned, stats: JSON.parse(match[1]) };
  } catch {
    return { cleaned, stats: null };
  }
}

function toOpenAIResponse(content, model, createdAt) {
  return {
    id: `chatcmpl_${Math.random().toString(36).slice(2)}`,
    object: "chat.completion",
    created: createdAt || Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
  };
}

function toOpenAIChunk(id, model, createdAt, delta, finishReason) {
  return {
    id,
    object: "chat.completion.chunk",
    created: createdAt || Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason || null,
      },
    ],
  };
}

function streamOpenAIResponse(res, content, model, createdAt) {
  const id = `chatcmpl_${Math.random().toString(36).slice(2)}`;
  const chunkSize = 24;
  const chunks = [];

  for (let i = 0; i < content.length; i += chunkSize) {
    chunks.push(content.slice(i, i + chunkSize));
  }

  res.write(`data: ${JSON.stringify(toOpenAIChunk(id, model, createdAt, { role: "assistant" }, null))}\n\n`);

  let index = 0;
  const pushNext = () => {
    if (index >= chunks.length) {
      res.write(`data: ${JSON.stringify(toOpenAIChunk(id, model, createdAt, {}, "stop"))}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.write(
      `data: ${JSON.stringify(toOpenAIChunk(id, model, createdAt, { content: chunks[index] }, null))}\n\n`
    );
    index += 1;
    setImmediate(pushNext);
  };

  setImmediate(pushNext);
}

function buildUpstreamPayload(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemMessage = messages.find((m) => m.role === "system");
  const fallbackSystemPrompt = body.chatOptions && typeof body.chatOptions.systemPrompt === "string"
    ? body.chatOptions.systemPrompt
    : "";

  return {
    messages,
    chatOptions: {
      selectedModel: body.model || DEFAULT_MODEL,
      systemPrompt: systemMessage ? String(systemMessage.content || "") : fallbackSystemPrompt,
      topK: DEFAULT_TOP_K,
      temperature: DEFAULT_TEMPERATURE,
    },
    attachment: null,
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    try {
      const body = await readJsonBody(req);
      const upstreamPayload = buildUpstreamPayload(body);
      const upstream = await postUpstream(upstreamPayload);

      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        res.writeHead(upstream.statusCode, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Upstream error",
              type: "upstream_error",
              status: upstream.statusCode,
            },
          })
        );
        return;
      }

      const { cleaned, stats } = extractStats(upstream.body);
      const createdAt = stats && typeof stats.created_at === "number"
        ? Math.floor(stats.created_at)
        : undefined;
      const model = upstreamPayload.chatOptions.selectedModel;

      if (body.stream === true) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        streamOpenAIResponse(res, cleaned, model, createdAt);
        return;
      }

      const response = toOpenAIResponse(cleaned, model, createdAt);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: err.message || "Invalid request",
            type: "bad_request",
          },
        })
      );
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found" } }));
});

server.listen(PORT, () => {
  console.log(`Proxy listening on http://localhost:${PORT}`);
});
