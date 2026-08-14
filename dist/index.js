// src/bridge.ts
import { createHash as createHash2 } from "crypto";
import { isAbsolute } from "path";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  generateReqId,
  WSAuthFailureError,
  WSClient,
  WSReconnectExhaustedError
} from "@wecom/aibot-node-sdk";

// src/conversations.ts
import { resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

// src/util.ts
import { createHash } from "crypto";
function sessionIdFor(accountId, message) {
  const scope = message.chattype === "group" ? "group" : "single";
  const peer = scope === "group" ? message.chatid : message.from.userid;
  if (peer === void 0 || peer.length === 0) throw new Error(`WeCom ${scope} message has no peer identifier`);
  const digest = createHash("sha256").update(`${accountId}\0${scope}\0${peer}`).digest("hex").slice(0, 32);
  return `wecom-v2-${scope}-${digest}`;
}
function chatTarget(message) {
  const target = message.chattype === "group" ? message.chatid : message.from.userid;
  if (target === void 0 || target.length === 0) throw new Error("WeCom message has no outbound chat target");
  return target;
}
function truncateUtf8(text, maxBytes, suffix = "\n\n[\u56DE\u590D\u5DF2\u622A\u65AD]") {
  const normalized = text.trim();
  if (Buffer.byteLength(normalized) <= maxBytes) return normalized;
  const suffixBytes = Buffer.byteLength(suffix);
  const available = Math.max(0, maxBytes - suffixBytes);
  let result = "";
  let bytes = 0;
  for (const codePoint of normalized) {
    const size = Buffer.byteLength(codePoint);
    if (bytes + size > available) break;
    result += codePoint;
    bytes += size;
  }
  return result + (suffixBytes <= maxBytes ? suffix : "");
}
async function withTimeout(task, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      task,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
var SeenMessageIds = class {
  constructor(limit) {
    this.limit = limit;
  }
  limit;
  ids = /* @__PURE__ */ new Set();
  /** Return true for a duplicate; record a new id otherwise. */
  hasOrAdd(id) {
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    while (this.ids.size > this.limit) {
      const oldest = this.ids.values().next().value;
      if (oldest === void 0) break;
      this.ids.delete(oldest);
    }
    return false;
  }
};

// src/inbound.ts
async function inboundContent(ctx, config, client, message, includeImages = true) {
  const scope = message.chattype === "group" ? "WeCom group" : "WeCom private chat";
  const textParts = [`[${scope} message from WeCom user ${shortId(message.from.userid)}]`];
  const images = [];
  collectMessageContent(message, textParts, images);
  collectQuotedContent(message, textParts, images);
  const selectedImages = images.slice(0, ctx.attachments.imageLimits.maxImagesPerMessage);
  const imageBlocks = [];
  let totalImageBytes = 0;
  for (const image of selectedImages) {
    const remaining = ctx.attachments.imageLimits.maxMessageImageBytes - totalImageBytes;
    const maxBytes = Math.min(ctx.attachments.imageLimits.maxImageBytes, remaining);
    if (maxBytes <= 0) break;
    const downloaded = await withTimeout(
      client.downloadFile(image.url, image.aeskey),
      config.mediaDownloadTimeoutMs,
      "WeCom encrypted image download"
    );
    if (downloaded.buffer.byteLength > maxBytes) {
      throw new Error(`WeCom image exceeds the ${maxBytes}-byte attachment limit`);
    }
    const mediaType = detectImageMediaType(downloaded.buffer);
    const ref = await ctx.attachments.saveImage({
      data: downloaded.buffer,
      mediaType,
      ...downloaded.filename === void 0 ? {} : { name: downloaded.filename }
    });
    totalImageBytes += ref.bytes;
    if (includeImages) {
      imageBlocks.push({ type: "image", attachment: ref });
    } else {
      const label = downloaded.filename?.trim() || ref.mediaType;
      textParts.push([
        `[WeCom image received: ${label}.`,
        `Stored as Harness attachment ${String(ref.attachmentId)}.`,
        "The selected model is text-only and cannot inspect its pixels.]"
      ].join(" "));
    }
  }
  if (textParts.length === 1 && imageBlocks.length === 0) {
    textParts.push(`[Unsupported WeCom message type: ${message.msgtype}]`);
  }
  return [{ type: "text", text: textParts.join("\n") }, ...imageBlocks];
}
function collectMessageContent(message, text, images) {
  switch (message.msgtype) {
    case "text":
      pushText(text, message.text?.content);
      break;
    case "image":
      if (message.image !== void 0) images.push(message.image);
      break;
    case "mixed":
      collectMixed(message.mixed?.msg_item ?? [], text, images);
      break;
    case "voice":
      if (message.voice?.content?.trim()) text.push(`[Voice transcription]
${message.voice.content.trim()}`);
      break;
    case "file":
      text.push("[WeCom file received; this plugin version handles text and images only.]");
      break;
    case "video":
      text.push("[WeCom video received; this plugin version handles text and images only.]");
      break;
    default:
      break;
  }
}
function collectQuotedContent(message, text, images) {
  const quote = message.quote;
  if (quote === void 0) return;
  if (quote.msgtype === "text") pushText(text, quote.text?.content, "[Quoted text]\n");
  if (quote.msgtype === "image" && quote.image !== void 0) images.push(quote.image);
  if (quote.msgtype === "mixed") collectMixed(quote.mixed?.msg_item ?? [], text, images, "[Quoted text]\n");
  if (quote.msgtype === "voice") pushText(text, quote.voice?.content, "[Quoted voice transcription]\n");
}
function collectMixed(items, text, images, prefix = "") {
  for (const item of items) {
    if (item.msgtype === "text") pushText(text, item.text?.content, prefix);
    if (item.msgtype === "image" && item.image !== void 0) images.push(item.image);
  }
}
function pushText(target, value, prefix = "") {
  const normalized = value?.trim();
  if (normalized) target.push(prefix + normalized);
}
function shortId(value) {
  return value.length <= 8 ? value : value.slice(0, 8);
}
function detectImageMediaType(data) {
  if (startsWith(data, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (startsWith(data, [255, 216, 255])) return "image/jpeg";
  if (startsWith(data, [71, 73, 70, 56])) return "image/gif";
  if (startsWith(data, [82, 73, 70, 70]) && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80) return "image/webp";
  throw new Error("WeCom image has an unsupported or unrecognized format");
}
function startsWith(data, prefix) {
  return prefix.every((byte, index) => data[index] === byte);
}

// src/conversations.ts
var ConversationManager = class {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
  }
  ctx;
  config;
  bindings = /* @__PURE__ */ new Map();
  creations = /* @__PURE__ */ new Map();
  queues = /* @__PURE__ */ new Map();
  activeTurns = /* @__PURE__ */ new Set();
  persistedIds = /* @__PURE__ */ new Set();
  /** Snapshot persisted identities once before accepting traffic. */
  async initialize() {
    const headers = await this.ctx.sessionPersistence.list();
    this.persistedIds = new Set(headers.map((header) => String(header.id)));
  }
  /** Process one inbound message after earlier work in the same WeCom conversation. */
  process(message, client) {
    const id = sessionIdFor(this.config.accountId, message);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(() => this.processNow(id, message, client));
    const tracked = current.finally(() => {
      if (this.queues.get(id) === tracked) this.queues.delete(id);
    });
    this.queues.set(id, tracked);
    return current;
  }
  /** Cancel active work for one WeCom conversation. */
  cancel(message) {
    const id = sessionIdFor(this.config.accountId, message);
    const agent = this.bindings.get(id)?.agent ?? this.ctx.agents.get(SessionId(id));
    if (agent === void 0 || agent.status === "idle") return false;
    agent.cancel({ kind: "user" });
    return true;
  }
  /** Dispose every bridge-owned Agent after queued message work settles. */
  async dispose() {
    await Promise.allSettled(this.queues.values());
    await Promise.allSettled([...this.bindings.values()].map((binding) => binding.release()));
    this.bindings.clear();
    this.activeTurns.clear();
  }
  async processNow(id, message, client) {
    const binding = await this.getOrCreate(id);
    const agent = binding.agent;
    const content = await inboundContent(this.ctx, this.config, client, message, await this.includeImages(agent));
    await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, "DeepSeek Harness conversation availability");
    const start = agent.session.events.length;
    this.activeTurns.add(id);
    try {
      agent.followup(createUserMessage({ content, source: { kind: "user" } }));
      await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, "DeepSeek Harness response");
      return await this.collectReply(agent, agent.session.events.slice(start));
    } finally {
      this.activeTurns.delete(id);
    }
  }
  async includeImages(agent) {
    if (this.config.imageInputMode === "always") return true;
    if (this.config.imageInputMode === "never") return false;
    const { provider, model } = agent.options;
    if (provider === void 0 || model === void 0) return false;
    const info = await this.ctx.llm.resolveModelInfo(provider, model);
    return info.inputModalities?.includes("image") ?? false;
  }
  async getOrCreate(id) {
    const sessionId = SessionId(id);
    const existing = this.bindings.get(id);
    if (existing !== void 0 && this.ctx.agents.get(sessionId) === existing.agent) return existing;
    if (existing !== void 0) {
      this.bindings.delete(id);
      await existing.release();
    }
    const pending = this.creations.get(id);
    if (pending !== void 0) return pending;
    const creation = this.createOrResume(id).finally(() => this.creations.delete(id));
    this.creations.set(id, creation);
    const binding = await creation;
    this.bindings.set(id, binding);
    return binding;
  }
  async createOrResume(id) {
    const sessionId = SessionId(id);
    const live = this.ctx.agents.get(sessionId);
    if (live !== void 0) return this.borrowAgent(live, id);
    const current = this.ctx.agentDefaultModel.currentSelection();
    const agentOptions = { provider: current.provider, model: current.model };
    if (this.persistedIds.has(id)) {
      const inspected = await this.ctx.sessionPersistence.inspect(sessionId);
      const agentPreset2 = resolveSessionPreset({
        header: inspected.meta,
        events: inspected.events
      }) ?? this.resolveAgentPreset();
      try {
        return this.ownAgent(await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions,
          setup: (agentCtx) => this.setupAgent(agentCtx, agentPreset2, id)
        }));
      } catch (error) {
        const raced = this.ctx.agents.get(sessionId);
        if (raced !== void 0) return this.borrowAgent(raced, id);
        throw error;
      }
    }
    const agentPreset = this.resolveAgentPreset();
    let handle;
    try {
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: this.config.cwd, agentPreset },
        agentOptions,
        setup: (agentCtx) => this.setupAgent(agentCtx, agentPreset, id)
      });
    } catch (error) {
      const raced = this.ctx.agents.get(sessionId);
      if (raced !== void 0) return this.borrowAgent(raced, id);
      throw error;
    }
    this.persistedIds.add(id);
    return this.ownAgent(handle);
  }
  ownAgent(handle) {
    return { agent: handle.agent, release: () => handle.dispose() };
  }
  borrowAgent(agent, id) {
    const disposeInstructions = this.registerWeComInstructions(agent.ctx, id);
    let released = false;
    return {
      agent,
      release: async () => {
        if (released) return;
        released = true;
        disposeInstructions();
      }
    };
  }
  resolveAgentPreset() {
    return this.config.agentPreset ?? this.ctx.agentPresets.defaultId;
  }
  async setupAgent(agentCtx, agentPreset, id) {
    await this.ctx.agentPresets.mount(agentCtx, agentPreset);
    this.registerWeComInstructions(agentCtx, id);
  }
  registerWeComInstructions(agentCtx, id) {
    return agentCtx.systemPrompt.section({
      name: "channel:wecom",
      order: 190,
      text: () => this.activeTurns.has(id) ? this.config.systemPrompt : ""
    });
  }
  async collectReply(agent, events) {
    const texts = [];
    const images = [];
    for (const event of events) {
      if (event.type !== "assistant/message") continue;
      for (const block of event.data.message.content) {
        if (block.type === "text" && block.text.trim()) texts.push(block.text.trim());
        if (block.type === "image") {
          const stored = await this.ctx.attachments.readImage(block.attachment);
          images.push({
            data: stored.data,
            mediaType: stored.ref.mediaType,
            ...stored.ref.name === void 0 ? {} : { name: stored.ref.name }
          });
        }
      }
    }
    const finalTurn = [...events].reverse().find((event) => event.type === "turn/end");
    if (texts.length === 0 && finalTurn?.type === "turn/end" && finalTurn.data.reason.kind === "error") {
      return { text: `\u5904\u7406\u5931\u8D25\uFF08${finalTurn.data.reason.error.code}\uFF09\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002`, images };
    }
    if (texts.length === 0 && images.length === 0) {
      return { text: "\u5904\u7406\u5B8C\u6210\uFF0C\u4F46\u6CA1\u6709\u751F\u6210\u53EF\u53D1\u9001\u7684\u5185\u5BB9\u3002", images };
    }
    return { text: texts.join("\n\n"), images };
  }
};

// src/bridge.ts
var OUTBOUND_TEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAMgAAABkCAYAAADDhn8LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAACn0lEQVR4nO3XsZFCQRDEUDIhxA28g1gS4JwrCmQ8QwmoR/vh8Ty74MAN7K2DBzHicAP704FABCKQIxBH4CG4/3HgC+JwPB5HII7AQ3B9QRyBh+B81oGfWKIS1RGII/AQXF8QR+AhOH5iOQIPwf2WA/9BHJsH5wjEEXgIri+II/AQHD+xHIGH4PoP4gg8BOf3DvxJD4yAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwApZ1IJDACFjWgUACI2BZBwIJjIBlHQgkMAKWdSCQwAhY1oFAAiNgWQcCCYyAZR0IJDAClnUgkMAIWNaBQAIjYFkHAgmMgGUdCCQwAroOBBIYAcs6EEhgBCzrQCCBEbCsA4EERsCyDgQSGAHLOhBIYAQs60AggRGwrAOBBEbAsg4EEhgByzoQSGAELOtAIIERsKwDgQRGwLIOBBIYAcs6EEhgBCzrQCCBEbCsA4EERsCyDgQSGAHLOhBIYAQs6+AFcF3qQZOWm4IAAAAASUVORK5CYII=",
  "base64"
);
var WeComHarnessBridge = class {
  constructor(ctx, config, clientFactory = (options) => new WSClient(options)) {
    this.ctx = ctx;
    this.config = config;
    this.clientFactory = clientFactory;
    if (!isAbsolute(config.cwd)) throw new Error(`wecom-channel: cwd must be absolute, got ${JSON.stringify(config.cwd)}`);
    this.log = ctx.logger("deepseek-harness-wecom");
    this.conversations = new ConversationManager(ctx, config);
    this.seen = new SeenMessageIds(config.maxSeenMessageIds);
  }
  ctx;
  config;
  clientFactory;
  log;
  conversations;
  seen;
  client;
  stopping = false;
  /** Load persisted ids, authenticate, and wait for WeCom readiness. */
  async start() {
    await this.conversations.initialize();
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.config.secretRef));
    if (resolved === void 0) {
      throw new Error(`wecom-channel: credential ${JSON.stringify(this.config.secretRef)} is not configured`);
    }
    const client = this.createClient(resolved.value);
    this.client = client;
    const ready = Promise.withResolvers();
    let readySettled = false;
    const resolveReady = () => {
      if (readySettled) return;
      readySettled = true;
      ready.resolve();
    };
    const rejectReady = (error) => {
      if (readySettled) return;
      readySettled = true;
      ready.reject(error);
    };
    client.on("connected", () => this.log.info("WeCom WebSocket connected; authenticating"));
    client.on("authenticated", resolveReady);
    client.on("disconnected", (reason) => {
      if (!this.stopping) this.log.warn("WeCom WebSocket disconnected: %s", reason);
    });
    client.on("reconnecting", (attempt) => this.log.warn("WeCom WebSocket reconnect attempt %d", attempt));
    client.on("error", (error) => {
      if (error instanceof WSAuthFailureError || error instanceof WSReconnectExhaustedError) {
        rejectReady(error);
      }
      if (!this.stopping) this.log.error("WeCom WebSocket error: %s", error.message);
    });
    client.on("event.disconnected_event", () => {
      if (!this.stopping) this.log.error("WeCom connection was replaced by another client for this Bot ID");
    });
    client.on("message", async (frame) => this.handleMessage(frame));
    client.on("event.enter_chat", async (frame) => this.handleWelcome(frame));
    try {
      client.connect();
      await withTimeout(ready.promise, this.config.startupTimeoutMs, "WeCom authentication");
      this.log.info("WeCom AI Bot authenticated for Bot ID %s", this.config.botId);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  /** Stop ingress and drain owned conversations. */
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.client?.disconnect();
    await this.conversations.dispose();
  }
  createClient(secret) {
    const sdkLogger = {
      debug: (message, ...args) => this.log.debug(message, ...args),
      info: (message, ...args) => this.log.info(message, ...args),
      warn: (message, ...args) => this.log.warn(message, ...args),
      error: (message, ...args) => this.log.error(message, ...args)
    };
    return this.clientFactory({
      botId: this.config.botId,
      secret,
      wsUrl: this.config.websocketUrl,
      scene: this.config.scene,
      logger: sdkLogger,
      reconnectInterval: this.config.reconnectIntervalMs,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      maxAuthFailureAttempts: this.config.maxAuthFailureAttempts,
      requestTimeout: this.config.sendTimeoutMs,
      plug_version: "deepseek-harness-wecom/0.1.1"
    });
  }
  async handleWelcome(frame) {
    if (!this.config.welcomeText.trim()) return;
    try {
      await withTimeout(
        this.requireClient().replyWelcome(frame, {
          msgtype: "text",
          text: { content: truncateUtf8(this.config.welcomeText, this.config.maxReplyBytes) }
        }),
        this.config.sendTimeoutMs,
        "WeCom welcome reply"
      );
    } catch (error) {
      this.log.error("WeCom welcome reply failed: %s", String(error));
    }
  }
  async handleMessage(frame) {
    const message = frame.body;
    if (message === void 0 || this.seen.hasOrAdd(message.msgid) || !this.allowed(message)) return;
    const command = commandText(message);
    if (command === "/bot-ping") {
      await this.sendReply(frame, { text: "pong \u2014 DeepSeek Harness \u4F01\u5FAE\u673A\u5668\u4EBA\u5DF2\u8FDE\u63A5\u3002", images: [] });
      return;
    }
    if (command === "/bot-help") {
      await this.sendReply(frame, {
        text: [
          "DeepSeek Harness \u4F01\u5FAE\u673A\u5668\u4EBA",
          "/bot-ping \u2014 \u68C0\u67E5\u8FDE\u901A\u6027",
          "/bot-image-test \u2014 \u53D1\u9001\u4E00\u5F20\u84DD\u8272\u56FE\u7247\uFF0C\u68C0\u67E5\u56FE\u7247\u51FA\u7AD9\u94FE\u8DEF",
          "/bot-status \u2014 \u67E5\u770B\u5F53\u524D\u4F1A\u8BDD\u72B6\u6001",
          "/bot-cancel \u2014 \u53D6\u6D88\u5F53\u524D\u751F\u6210",
          "\u5176\u4ED6\u6D88\u606F\u4F1A\u4EA4\u7ED9\u5F53\u524D Harness \u9ED8\u8BA4\u6A21\u578B\u5904\u7406\u3002"
        ].join("\n"),
        images: []
      });
      return;
    }
    if (command === "/bot-image-test") {
      await this.sendReply(frame, {
        text: "\u84DD\u8272\u6D4B\u8BD5\u56FE\u7247\u53D1\u9001\u6210\u529F\u3002",
        images: [{ data: OUTBOUND_TEST_PNG, mediaType: "image/png", name: "wecom-image-test.png" }]
      });
      return;
    }
    if (command === "/bot-cancel") {
      const cancelled = this.conversations.cancel(message);
      await this.sendReply(frame, {
        text: cancelled ? "\u5DF2\u8BF7\u6C42\u53D6\u6D88\u5F53\u524D\u751F\u6210\u3002" : "\u5F53\u524D\u6CA1\u6709\u6B63\u5728\u751F\u6210\u7684\u56DE\u590D\u3002",
        images: []
      });
      return;
    }
    if (command === "/bot-status") {
      await this.sendReply(frame, {
        text: "\u4F01\u5FAE\u957F\u8FDE\u63A5\u6B63\u5E38\uFF0CDeepSeek Harness \u4F1A\u8BDD\u6309\u5355\u804A/\u7FA4\u804A\u72EC\u7ACB\u6301\u4E45\u5316\u3002",
        images: []
      });
      return;
    }
    try {
      const reply = await this.conversations.process(message, this.requireClient());
      await this.sendReply(frame, reply);
    } catch (error) {
      this.log.error("WeCom message %s failed: %s", message.msgid, String(error));
      try {
        await this.sendReply(frame, { text: "\u5904\u7406\u6D88\u606F\u65F6\u53D1\u751F\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", images: [] });
      } catch (sendError) {
        this.log.error("WeCom error reply failed: %s", String(sendError));
      }
    }
  }
  allowed(message) {
    const group = message.chattype === "group";
    const policy = group ? this.config.groupPolicy : this.config.singlePolicy;
    const allow = group ? this.config.groupAllowFrom : this.config.singleAllowFrom;
    if (policy === "disabled") return false;
    return policy === "open" || allow.includes(message.from.userid);
  }
  async sendReply(frame, reply) {
    const message = frame.body;
    if (message === void 0) throw new Error("WeCom reply frame has no message body");
    const inline = reply.images.filter(
      (image) => (image.mediaType === "image/png" || image.mediaType === "image/jpeg") && image.data.byteLength <= 10 * 1024 * 1024
    ).slice(0, 10);
    const inlineSet = new Set(inline);
    const active = reply.images.filter((image) => !inlineSet.has(image));
    const msgItems = inline.map((image) => ({
      msgtype: "image",
      image: {
        base64: Buffer.from(image.data).toString("base64"),
        md5: createHash2("md5").update(image.data).digest("hex")
      }
    }));
    const fallback = reply.images.length > 0 ? "\u56FE\u7247\u56DE\u590D" : "\u5904\u7406\u5B8C\u6210\u3002";
    const text = truncateUtf8(reply.text || fallback, this.config.maxReplyBytes);
    const streamId = generateReqId("dsh");
    await this.retry(async () => withTimeout(
      this.requireClient().replyStream(frame, streamId, text, true, msgItems),
      this.config.sendTimeoutMs,
      "WeCom reply send"
    ));
    for (const image of active) {
      const filename = image.name?.trim() || imageFilename(image.mediaType);
      const uploaded = await this.retry(async () => withTimeout(
        this.requireClient().uploadMedia(Buffer.from(image.data), { type: "image", filename }),
        this.config.sendTimeoutMs,
        "WeCom image upload"
      ));
      await this.retry(async () => withTimeout(
        this.requireClient().sendMediaMessage(chatTarget(message), "image", uploaded.media_id),
        this.config.sendTimeoutMs,
        "WeCom image send"
      ));
    }
  }
  async retry(operation) {
    let lastError;
    for (let attempt = 0; attempt <= this.config.sendRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < this.config.sendRetries) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw lastError;
  }
  requireClient() {
    if (this.client === void 0 || !this.client.isConnected) {
      throw new Error("wecom-channel: client is not connected");
    }
    return this.client;
  }
};
function commandText(message) {
  if (message.msgtype === "text") return message.text?.content?.trim().toLowerCase() ?? "";
  if (message.msgtype !== "mixed") return "";
  const mixed = message.mixed;
  return (mixed?.msg_item ?? []).filter((item) => item.msgtype === "text").map((item) => item.text?.content ?? "").join("").trim().toLowerCase();
}
function imageFilename(mediaType) {
  if (mediaType === "image/jpeg") return "image.jpg";
  if (mediaType === "image/gif") return "image.gif";
  if (mediaType === "image/webp") return "image.webp";
  return "image.png";
}

// src/config.ts
import z from "@deepseek-ai/schemastery";
var Config = z.object({
  botId: z.string().required(),
  secretRef: z.string().default("WECOM_BOT_SECRET"),
  accountId: z.string().default("default"),
  cwd: z.string().required(),
  agentPreset: z.string(),
  websocketUrl: z.string().default("wss://openws.work.weixin.qq.com"),
  scene: z.number().step(1).min(0).default(1),
  singlePolicy: z.union(["open", "allowlist", "disabled"]).default("open"),
  singleAllowFrom: z.array(z.string()).default([]),
  groupPolicy: z.union(["open", "allowlist", "disabled"]).default("open"),
  groupAllowFrom: z.array(z.string()).default([]),
  imageInputMode: z.union(["auto", "always", "never"]).default("auto"),
  welcomeText: z.string().default(""),
  startupTimeoutMs: z.number().step(1).min(1).default(3e4),
  responseTimeoutMs: z.number().step(1).min(1).default(3e5),
  mediaDownloadTimeoutMs: z.number().step(1).min(1).default(3e4),
  sendTimeoutMs: z.number().step(1).min(1).default(3e4),
  reconnectIntervalMs: z.number().step(1).min(100).default(1e3),
  maxReconnectAttempts: z.number().step(1).min(-1).default(10),
  maxAuthFailureAttempts: z.number().step(1).min(1).default(2),
  sendRetries: z.number().step(1).min(0).max(5).default(2),
  maxReplyBytes: z.number().step(1).min(100).max(20480).default(2e4),
  maxSeenMessageIds: z.number().step(1).min(100).max(1e5).default(5e3),
  systemPrompt: z.string().default(
    "You are replying through WeCom. Keep replies clear and suitable for enterprise chat. Use WeCom-compatible Markdown for headings, lists, links, emphasis, quotes, and code when structure helps. Do not reveal credentials or internal system data. When a request needs an interactive approval that WeCom cannot provide, explain what approval is needed instead of waiting indefinitely."
  )
});

// src/index.ts
var name = "deepseek-harness-wecom";
var inject = [
  "agentDefaultModel",
  "agentPresets",
  "agents",
  "attachments",
  "credentials",
  "llm",
  "sessionPersistence",
  "systemPrompt"
];
async function apply(ctx, config) {
  const bridge = new WeComHarnessBridge(ctx, config);
  await ctx.effect(async function* () {
    yield async () => bridge.stop();
    await bridge.start();
  }, "deepseek-harness-wecom.websocket");
}
var index_default = { name, inject, Config, apply };
export {
  Config,
  SeenMessageIds,
  WeComHarnessBridge,
  apply,
  chatTarget,
  index_default as default,
  detectImageMediaType,
  inboundContent,
  inject,
  name,
  sessionIdFor,
  truncateUtf8
};
//# sourceMappingURL=index.js.map