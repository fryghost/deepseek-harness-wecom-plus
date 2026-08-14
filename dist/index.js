// src/bridge.ts
import { createHash as createHash3 } from "crypto";
import { readFile as readFile2 } from "fs/promises";
import { isAbsolute as isAbsolute3 } from "path";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  generateReqId,
  WSAuthFailureError,
  WSClient,
  WSReconnectExhaustedError
} from "@wecom/aibot-node-sdk";

// src/card.ts
import { randomBytes } from "crypto";
var CARD_LIMITS = {
  title: 26,
  titleDesc: 30,
  subtitle: 112,
  sourceDesc: 13,
  buttonText: 10,
  buttonKeyBytes: 1024,
  maxButtons: 6,
  taskIdBytes: 128,
  voteOptionText: 11,
  voteOptionIdBytes: 128,
  maxVoteOptions: 20,
  selectOptionText: 10,
  selectOptionIdBytes: 128,
  maxSelectOptions: 10,
  maxSelects: 3,
  selectTitle: 13,
  questionKeyBytes: 1024
};
var TASK_ID_PATTERN = /^[0-9A-Za-z_@-]{1,128}$/u;
function truncateChars(text, maxChars, suffix = "\u2026") {
  const normalized = text.trim();
  if (normalized.length <= maxChars) return normalized;
  const available = Math.max(0, maxChars - suffix.length);
  let result = "";
  for (const codePoint of normalized) {
    if (result.length + codePoint.length > available) break;
    result += codePoint;
  }
  return result + (suffix.length <= maxChars ? suffix : "");
}
function generateTaskId(prefix) {
  const safePrefix = prefix.replace(/[^0-9A-Za-z_@-]/gu, "").slice(0, 24) || "dshp";
  const suffix = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  return `${safePrefix}-${suffix}`.slice(0, 128);
}
function requireTitle(value) {
  const title = truncateChars(value?.trim() || "", CARD_LIMITS.title);
  if (title.length === 0) throw new Error("wecom_send_card: title must not be empty");
  return title;
}
function optionalChars(value, max) {
  const normalized = value?.trim();
  return normalized ? truncateChars(normalized, max) : void 0;
}
function normalizeTaskId(input, prefix) {
  const candidate = input?.trim();
  return candidate !== void 0 && TASK_ID_PATTERN.test(candidate) ? candidate : generateTaskId(prefix);
}
function normalizeButtons(value) {
  if (value === void 0 || value === null) return void 0;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("wecom_send_card: button_interaction requires a non-empty buttons array");
  }
  if (value.length > CARD_LIMITS.maxButtons) {
    throw new Error(`wecom_send_card: at most ${CARD_LIMITS.maxButtons} buttons are supported`);
  }
  const buttons = value.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("wecom_send_card: each button must be an object with text and key");
    }
    const item = entry;
    const text = truncateChars(typeof item.text === "string" ? item.text : "", CARD_LIMITS.buttonText);
    const key = typeof item.key === "string" ? item.key.trim() : "";
    if (text.length === 0 || key.length === 0) {
      throw new Error("wecom_send_card: each button needs a non-empty text and key");
    }
    if (Buffer.byteLength(key) > CARD_LIMITS.buttonKeyBytes) {
      throw new Error(`wecom_send_card: button key exceeds ${CARD_LIMITS.buttonKeyBytes} bytes`);
    }
    const numeric = typeof item.style === "number" ? Math.trunc(item.style) : 1;
    const style = numeric >= 1 && numeric <= 4 ? numeric : 1;
    return { text, key, style };
  });
  const keys = /* @__PURE__ */ new Set();
  for (let index = 0; index < buttons.length; index += 1) {
    const button = buttons[index];
    if (button === void 0) continue;
    let key = button.key;
    let suffix = 2;
    while (keys.has(key)) key = `${button.key}-${suffix++}`;
    keys.add(key);
    button.key = key;
  }
  return buttons;
}
function normalizeOptions(value, limits, context) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`wecom_send_card: ${context} requires a non-empty options array`);
  }
  if (value.length > limits.max) {
    throw new Error(`wecom_send_card: ${context} supports at most ${limits.max} options`);
  }
  const options = value.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`wecom_send_card: each ${context} option must be an object with id and text`);
    }
    const item = entry;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const text = truncateChars(typeof item.text === "string" ? item.text : "", limits.textCap);
    if (id.length === 0 || text.length === 0) {
      throw new Error(`wecom_send_card: each ${context} option needs a non-empty id and text`);
    }
    if (Buffer.byteLength(id) > limits.idBytes) {
      throw new Error(`wecom_send_card: ${context} option id exceeds ${limits.idBytes} bytes`);
    }
    return {
      id,
      text,
      ...item.isChecked === true ? { isChecked: true } : {}
    };
  });
  const ids = /* @__PURE__ */ new Set();
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === void 0) continue;
    let id = option.id;
    let suffix = 2;
    while (ids.has(id)) id = `${option.id}-${suffix++}`;
    ids.add(id);
    option.id = id;
  }
  return options;
}
function normalizeCheckbox(value) {
  if (value === void 0 || value === null) return void 0;
  const options = normalizeOptions(value, {
    max: CARD_LIMITS.maxVoteOptions,
    textCap: CARD_LIMITS.voteOptionText,
    idBytes: CARD_LIMITS.voteOptionIdBytes
  }, "vote_interaction");
  return {
    question_key: "vote",
    mode: 0,
    option_list: options.map(({ id, text, isChecked }) => ({
      id,
      text,
      ...isChecked === true ? { is_checked: true } : {}
    }))
  };
}
function normalizeSelects(value) {
  if (value === void 0 || value === null) return void 0;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("wecom_send_card: multiple_interaction requires a non-empty selects array");
  }
  if (value.length > CARD_LIMITS.maxSelects) {
    throw new Error(`wecom_send_card: multiple_interaction supports at most ${CARD_LIMITS.maxSelects} selectors`);
  }
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("wecom_send_card: each selector must be an object with question_key and options");
    }
    const item = entry;
    const questionKey = typeof item.questionKey === "string" ? item.questionKey.trim() : "";
    if (questionKey.length === 0) {
      throw new Error("wecom_send_card: each selector needs a non-empty question_key");
    }
    if (Buffer.byteLength(questionKey) > CARD_LIMITS.questionKeyBytes) {
      throw new Error(`wecom_send_card: question_key exceeds ${CARD_LIMITS.questionKeyBytes} bytes`);
    }
    const title = optionalChars(
      typeof item.title === "string" ? item.title : void 0,
      CARD_LIMITS.selectTitle
    );
    const options = normalizeOptions(item.options, {
      max: CARD_LIMITS.maxSelectOptions,
      textCap: CARD_LIMITS.selectOptionText,
      idBytes: CARD_LIMITS.selectOptionIdBytes
    }, `selector "${questionKey}"`);
    return {
      question_key: questionKey,
      ...title === void 0 ? {} : { title },
      option_list: options.map(({ id, text }) => ({ id, text }))
    };
  });
}
function normalizeSubmitButton(textValue, keyValue, context) {
  const text = truncateChars(typeof textValue === "string" ? textValue : "", CARD_LIMITS.buttonText);
  const key = typeof keyValue === "string" ? keyValue.trim() : "";
  if (text.length === 0 || key.length === 0) {
    throw new Error(`wecom_send_card: ${context} requires non-empty submit_text and submit_key`);
  }
  if (Buffer.byteLength(key) > CARD_LIMITS.buttonKeyBytes) {
    throw new Error(`wecom_send_card: submit_key exceeds ${CARD_LIMITS.buttonKeyBytes} bytes`);
  }
  return { text, key };
}
function buildTemplateCard(input, taskIdPrefix) {
  const title = requireTitle(input.title);
  const desc = optionalChars(input.desc, CARD_LIMITS.titleDesc);
  const subtitle = optionalChars(input.subtitle, CARD_LIMITS.subtitle);
  const taskId = normalizeTaskId(input.taskId, taskIdPrefix);
  const base = {
    card_type: input.cardType,
    ...subtitle === void 0 ? {} : { sub_title_text: subtitle },
    task_id: taskId
  };
  switch (input.cardType) {
    case "text_notice":
      return { ...base, main_title: { title, ...desc === void 0 ? {} : { desc } } };
    case "news_notice": {
      const imageUrl = input.imageUrl?.trim();
      if (imageUrl === void 0 || imageUrl.length === 0) {
        throw new Error("wecom_send_card: news_notice requires image_url");
      }
      const jumpUrl = input.jumpUrl?.trim();
      return {
        ...base,
        main_title: { title, ...desc === void 0 ? {} : { desc } },
        card_image: { url: imageUrl },
        ...jumpUrl === void 0 ? {} : { card_action: { type: 1, url: jumpUrl } }
      };
    }
    case "button_interaction": {
      const buttons = normalizeButtons(input.buttons);
      if (buttons === void 0) {
        throw new Error("wecom_send_card: button_interaction requires a non-empty buttons array");
      }
      return {
        ...base,
        main_title: { title, ...desc === void 0 ? {} : { desc } },
        button_list: buttons
      };
    }
    case "vote_interaction": {
      const checkbox = normalizeCheckbox(input.options);
      if (checkbox === void 0) {
        throw new Error("wecom_send_card: vote_interaction requires a non-empty options array");
      }
      const numeric = typeof input.voteMode === "number" ? Math.trunc(input.voteMode) : 0;
      checkbox.mode = numeric === 1 ? 1 : 0;
      return {
        ...base,
        main_title: { title, ...desc === void 0 ? {} : { desc } },
        checkbox,
        submit_button: normalizeSubmitButton(input.submitText, input.submitKey, "vote_interaction")
      };
    }
    case "multiple_interaction": {
      const selects = normalizeSelects(input.selects);
      if (selects === void 0) {
        throw new Error("wecom_send_card: multiple_interaction requires a non-empty selects array");
      }
      return {
        ...base,
        main_title: { title, ...desc === void 0 ? {} : { desc } },
        select_list: selects,
        submit_button: normalizeSubmitButton(input.submitText, input.submitKey, "multiple_interaction")
      };
    }
  }
}
function deriveAdaptiveCard(text, taskIdPrefix) {
  const choice = deriveChoiceCard(text, taskIdPrefix);
  if (choice !== void 0) return choice;
  return deriveConfirmCard(text, taskIdPrefix);
}
var LIST_ITEM_PATTERN = /^\s*(?:\d+[.、)）]\s*|[-*•·]\s+)(.+)$/u;
var CHOICE_CUE_PATTERN = /选择|选项|choose|select|pick|哪一个|哪个|which|回复数字|确认|是否|投票/iu;
function deriveChoiceCard(text, taskIdPrefix) {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  const items = [];
  let cueLine = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = LIST_ITEM_PATTERN.exec(lines[index] ?? "");
    if (match === null) {
      cueLine = lines[index] ?? "";
      break;
    }
    items.unshift(match[1] ?? "");
  }
  if (items.length < 2 || items.length > CARD_LIMITS.maxButtons) return void 0;
  if (cueLine === "") return void 0;
  const labels = [];
  let allShort = true;
  for (const item of items) {
    const label = optionLabel(item);
    if (label === void 0) return void 0;
    if (label.length > CARD_LIMITS.buttonText) allShort = false;
    labels.push(label);
  }
  const cue = CHOICE_CUE_PATTERN.test(cueLine);
  if (!cue && !(allShort && cueLine.trim().endsWith("\uFF1F"))) return void 0;
  const buttons = labels.map((label, index) => ({
    text: label,
    key: `opt-${index + 1}`
  }));
  const title = truncateChars(stripMarkdownPrefix(cueLine).replace(/[：:？?。.!！]+$/u, ""), CARD_LIMITS.title) || "\u8BF7\u9009\u62E9";
  const card = buildTemplateCard({
    cardType: "button_interaction",
    title,
    buttons
  }, taskIdPrefix);
  const keyLabels = /* @__PURE__ */ new Map();
  for (let index = 0; index < buttons.length; index += 1) {
    const button = buttons[index];
    if (button !== void 0) keyLabels.set(button.key, labels[index] ?? button.text);
  }
  return { card, labels: keyLabels };
}
var CONFIRM_QUESTION_PATTERN = /是否|要不要|需不需要|确认|继续|取消/u;
function deriveConfirmCard(text, taskIdPrefix) {
  const lines = text.trim().split("\n");
  const last = lines[lines.length - 1]?.trim() ?? "";
  if (!last.endsWith("\uFF1F") && !last.endsWith("?")) return void 0;
  if (!CONFIRM_QUESTION_PATTERN.test(last)) return void 0;
  const verb = /继续/u.test(last) ? "\u7EE7\u7EED" : "\u786E\u8BA4";
  const buttons = [
    { text: verb, key: "confirm", style: 1 },
    { text: "\u53D6\u6D88", key: "cancel", style: 2 }
  ];
  const title = truncateChars(stripMarkdownPrefix(last).replace(/[：:？?。.!！]+$/u, ""), CARD_LIMITS.title) || verb;
  const card = buildTemplateCard({
    cardType: "button_interaction",
    title,
    buttons
  }, taskIdPrefix);
  return {
    card,
    labels: /* @__PURE__ */ new Map([
      ["confirm", verb],
      ["cancel", "\u53D6\u6D88"]
    ])
  };
}
function optionLabel(item) {
  const content = item.trim();
  if (content.length === 0) return void 0;
  const separator = content.search(/[：:｜|—–-]/u);
  if (separator > 0) {
    const head = content.slice(0, separator).trim();
    return head.length === 0 ? void 0 : stripMarkdownPrefix(head);
  }
  return content.length <= CARD_LIMITS.buttonText ? content : void 0;
}
function stripMarkdownPrefix(value) {
  return value.replace(/^[#>+\-*]\s*/u, "").replace(/[*_`~]/gu, "").trim();
}

// src/conversations.ts
import { resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/inbound-file.ts
import { createHash } from "crypto";
import { chmod, mkdir, readFile, realpath, writeFile } from "fs/promises";
import { isAbsolute, join, relative, sep } from "path";
var MAX_STORED_FILENAME_BYTES = 180;
function isExists(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
function isOutside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot);
}
function safeFilename(filename, digest) {
  const leaf = (filename ?? "").replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f<>:"|?*]/gu, "_").replace(/[. ]+$/u, "");
  const fallback = `wecom-file-${digest.slice(0, 12)}.bin`;
  const source = cleaned.length === 0 || cleaned === "." || cleaned === ".." ? fallback : cleaned;
  let bounded = "";
  for (const codePoint of source) {
    if (Buffer.byteLength(bounded + codePoint) > MAX_STORED_FILENAME_BYTES) break;
    bounded += codePoint;
  }
  return bounded || fallback;
}
async function saveInboundFile(root, conversationId, data, filename, maxBytes) {
  if (!isAbsolute(root)) throw new Error(`wecom-channel: inboundFileDirectory must be absolute, got ${JSON.stringify(root)}`);
  if (data.byteLength > maxBytes) {
    throw new Error(`WeCom file is ${data.byteLength} bytes; configured inbound limit is ${maxBytes} bytes`);
  }
  await mkdir(root, { recursive: true, mode: 448 });
  const canonicalRoot = await realpath(root);
  await chmod(canonicalRoot, 448);
  const conversationKey = createHash("sha256").update(conversationId).digest("hex").slice(0, 32);
  const digest = createHash("sha256").update(data).digest("hex");
  const directory = join(canonicalRoot, conversationKey, digest);
  await mkdir(directory, { recursive: true, mode: 448 });
  const canonicalDirectory = await realpath(directory);
  if (isOutside(canonicalRoot, canonicalDirectory)) {
    throw new Error("wecom-channel: inbound file directory resolves outside its configured root");
  }
  await chmod(canonicalDirectory, 448);
  const name2 = safeFilename(filename, digest);
  const path = join(canonicalDirectory, name2);
  try {
    await writeFile(path, data, { flag: "wx", mode: 384 });
  } catch (error) {
    if (!isExists(error)) throw error;
    const existing = await readFile(path);
    if (!existing.equals(data)) throw new Error("wecom-channel: existing inbound file does not match its content digest");
  }
  return { path, name: name2, bytes: data.byteLength };
}

// src/util.ts
import { createHash as createHash2 } from "crypto";
function sessionIdFor(accountId, message) {
  const scope = message.chattype === "group" ? "group" : "single";
  const peer = scope === "group" ? message.chatid : message.from.userid;
  if (peer === void 0 || peer.length === 0) throw new Error(`WeCom ${scope} message has no peer identifier`);
  const digest = createHash2("sha256").update(`${accountId}\0${scope}\0${peer}`).digest("hex").slice(0, 32);
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
  const files = [];
  collectMessageContent(message, textParts, images, files);
  collectQuotedContent(message, textParts, images, files);
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
  for (const pending of files) {
    const downloaded = await withTimeout(
      client.downloadFile(pending.content.url, pending.content.aeskey),
      config.mediaDownloadTimeoutMs,
      `WeCom encrypted ${pending.kind} download`
    );
    const stored = await saveInboundFile(
      config.inboundFileDirectory,
      sessionIdFor(config.accountId, message),
      downloaded.buffer,
      downloaded.filename,
      config.maxInboundFileBytes
    );
    const label = pending.quoted ? `Quoted WeCom ${pending.kind}` : `WeCom ${pending.kind}`;
    textParts.push([
      `[${label} received: ${JSON.stringify(stored.name)}; ${stored.bytes} bytes.`,
      `Downloaded and decrypted to local path ${JSON.stringify(stored.path)}.`,
      "Use the available file or shell tools to inspect this attachment when needed.]"
    ].join(" "));
  }
  if (textParts.length === 1 && imageBlocks.length === 0) {
    textParts.push(`[Unsupported WeCom message type: ${message.msgtype}]`);
  }
  return [{ type: "text", text: textParts.join("\n") }, ...imageBlocks];
}
function collectMessageContent(message, text, images, files) {
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
      if (message.file?.url) files.push({ content: message.file, kind: "file", quoted: false });
      break;
    case "video":
      if (message.video?.url) files.push({ content: message.video, kind: "video", quoted: false });
      break;
    default:
      break;
  }
}
function collectQuotedContent(message, text, images, files) {
  const quote = message.quote;
  if (quote === void 0) return;
  if (quote.msgtype === "text") pushText(text, quote.text?.content, "[Quoted text]\n");
  if (quote.msgtype === "image" && quote.image !== void 0) images.push(quote.image);
  if (quote.msgtype === "mixed") collectMixed(quote.mixed?.msg_item ?? [], text, images, "[Quoted text]\n");
  if (quote.msgtype === "voice") pushText(text, quote.voice?.content, "[Quoted voice transcription]\n");
  if (quote.msgtype === "file" && quote.file?.url) {
    files.push({ content: quote.file, kind: "file", quoted: true });
  }
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

// src/outbound-file.ts
import { realpath as realpath2, stat } from "fs/promises";
import { basename, isAbsolute as isAbsolute2, relative as relative2, resolve, sep as sep2 } from "path";
function isMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function isOutside2(root, candidate) {
  const pathFromRoot = relative2(root, candidate);
  return pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep2}`) || isAbsolute2(pathFromRoot);
}
async function resolveOutboundFile(cwd, requestedPath, maxBytes) {
  if (requestedPath.trim().length === 0) throw new Error("wecom_send_file: path must not be empty");
  let root;
  try {
    root = await realpath2(cwd);
  } catch (error) {
    if (isMissing(error)) throw new Error(`wecom_send_file: configured cwd does not exist: ${JSON.stringify(cwd)}`);
    throw error;
  }
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) {
    throw new Error(`wecom_send_file: configured cwd is not a directory: ${JSON.stringify(cwd)}`);
  }
  const unresolved = isAbsolute2(requestedPath) ? requestedPath : resolve(root, requestedPath);
  let path;
  try {
    path = await realpath2(unresolved);
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(`wecom_send_file: file does not exist: ${JSON.stringify(requestedPath)}`);
    }
    throw error;
  }
  if (isOutside2(root, path)) {
    throw new Error(`wecom_send_file: file resolves outside configured cwd: ${JSON.stringify(requestedPath)}`);
  }
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`wecom_send_file: path is not a regular file: ${JSON.stringify(requestedPath)}`);
  if (info.size > maxBytes) {
    throw new Error(`wecom_send_file: file is ${info.size} bytes; configured limit is ${maxBytes} bytes`);
  }
  return { path, name: basename(path), bytes: info.size };
}

// src/conversations.ts
var MAX_CARD_LABEL_TASKS = 500;
var ConversationManager = class {
  constructor(ctx, config, sendFile) {
    this.ctx = ctx;
    this.config = config;
    this.sendFile = sendFile;
  }
  ctx;
  config;
  sendFile;
  bindings = /* @__PURE__ */ new Map();
  creations = /* @__PURE__ */ new Map();
  queues = /* @__PURE__ */ new Map();
  activeTurns = /* @__PURE__ */ new Map();
  pendingCards = /* @__PURE__ */ new Map();
  cardLabels = /* @__PURE__ */ new Map();
  generations = /* @__PURE__ */ new Map();
  persistedIds = /* @__PURE__ */ new Set();
  /** Snapshot persisted identities once before accepting traffic. */
  async initialize() {
    const headers = await this.ctx.sessionPersistence.list();
    this.persistedIds = new Set(headers.map((header) => String(header.id)));
  }
  /** Process one inbound message after earlier work in the same WeCom conversation. */
  process(message, client) {
    const baseId = sessionIdFor(this.config.accountId, message);
    return this.enqueue(baseId, () => this.processNow(this.currentSessionId(baseId), message, client));
  }
  /** Process one template card button click as a user message into the same conversation. */
  processCardEvent(message, selectedLabel) {
    const baseId = sessionIdFor(this.config.accountId, message);
    return this.enqueue(baseId, () => this.processCardEventNow(this.currentSessionId(baseId), message, selectedLabel));
  }
  /**
   * Resolve one card click back to the visible option label the card carried.
   * WeCom only echoes the key (event_key), so the bridge stores every sent
   * card's key → label mapping here.
   */
  cardLabel(taskId, eventKey) {
    if (taskId === void 0 || taskId.length === 0 || eventKey === void 0 || eventKey.length === 0) {
      return void 0;
    }
    return this.cardLabels.get(taskId)?.get(eventKey);
  }
  /** End the current WeCom conversation session while retaining its history. */
  async reset(message) {
    const baseId = sessionIdFor(this.config.accountId, message);
    this.cancel(message);
    await this.enqueue(baseId, async () => {
      const id = this.currentSessionId(baseId);
      this.pendingCards.delete(id);
      const binding = this.bindings.get(id);
      if (binding !== void 0) {
        this.bindings.delete(id);
        await binding.release();
      }
      const generation = this.generationFor(baseId);
      if (!Number.isSafeInteger(generation + 1)) throw new Error("WeCom conversation generation is exhausted");
      this.generations.set(baseId, generation + 1);
      await this.getOrCreate(this.currentSessionId(baseId));
    });
  }
  /** Execute a registered Harness command against the current WeCom session. */
  executeCommand(message, line) {
    const baseId = sessionIdFor(this.config.accountId, message);
    return this.enqueue(baseId, async () => {
      const id = this.currentSessionId(baseId);
      const binding = await this.getOrCreate(id);
      const agent = binding.agent;
      await withTimeout(
        agent.whenIdle(),
        this.config.responseTimeoutMs,
        "DeepSeek Harness conversation availability"
      );
      const start = agent.session.events.length;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(new Error(`DeepSeek Harness command timed out after ${this.config.responseTimeoutMs}ms`));
      }, this.config.responseTimeoutMs);
      this.activeTurns.set(id, chatTarget(message));
      try {
        const execution = await this.ctx.commands.execute(agent, line, controller.signal);
        if (execution === void 0) {
          this.takeCards(id);
          return { execution, response: void 0 };
        }
        await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, "DeepSeek Harness command response");
        const events = agent.session.events.slice(start);
        const response = events.some((event) => event.type === "assistant/message") ? this.finalizeReply(id, await this.collectReply(agent, events)) : (this.takeCards(id), void 0);
        return { execution, response };
      } finally {
        clearTimeout(timer);
        this.activeTurns.delete(id);
      }
    });
  }
  /** Cancel active work for one WeCom conversation. */
  cancel(message) {
    const baseId = sessionIdFor(this.config.accountId, message);
    const id = this.currentSessionId(baseId);
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
    this.pendingCards.clear();
    this.cardLabels.clear();
  }
  enqueue(baseId, operation) {
    const previous = this.queues.get(baseId) ?? Promise.resolve();
    const current = previous.catch(() => void 0).then(operation);
    const tracked = current.finally(() => {
      if (this.queues.get(baseId) === tracked) this.queues.delete(baseId);
    });
    this.queues.set(baseId, tracked);
    return current;
  }
  currentSessionId(baseId) {
    const generation = this.generationFor(baseId);
    return generation === 0 ? baseId : `${baseId}-n${generation}`;
  }
  generationFor(baseId) {
    const cached = this.generations.get(baseId);
    if (cached !== void 0) return cached;
    const prefix = `${baseId}-n`;
    let generation = 0;
    for (const id of this.persistedIds) {
      if (!id.startsWith(prefix)) continue;
      const suffix = id.slice(prefix.length);
      if (!/^[1-9][0-9]*$/u.test(suffix)) continue;
      const candidate = Number(suffix);
      if (Number.isSafeInteger(candidate)) generation = Math.max(generation, candidate);
    }
    this.generations.set(baseId, generation);
    return generation;
  }
  async processNow(id, message, client) {
    const binding = await this.getOrCreate(id);
    const agent = binding.agent;
    const content = await inboundContent(this.ctx, this.config, client, message, await this.includeImages(agent));
    await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, "DeepSeek Harness conversation availability");
    const start = agent.session.events.length;
    this.activeTurns.set(id, chatTarget(message));
    try {
      agent.followup(createUserMessage({ content, source: { kind: "user" } }));
      await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, "DeepSeek Harness response");
      const collected = await this.collectReply(agent, agent.session.events.slice(start));
      return this.finalizeReply(id, collected);
    } finally {
      this.activeTurns.delete(id);
    }
  }
  async processCardEventNow(id, message, selectedLabel) {
    const binding = await this.getOrCreate(id);
    const agent = binding.agent;
    const scope = message.chattype === "group" ? "WeCom group" : "WeCom private chat";
    const taskId = message.event.task_id?.trim() || "\uFF08\u65E0\uFF09";
    const eventKey = message.event.event_key?.trim() || "\uFF08\u65E0\uFF09";
    const content = [{
      type: "text",
      text: [
        `[${scope} template card button click from WeCom user ${message.from.userid}]`,
        `task_id: ${taskId}`,
        `event_key: ${eventKey}`,
        ...selectedLabel === void 0 ? [] : [`selected option: ${selectedLabel}`],
        `raw event: ${JSON.stringify(message.event)}`,
        "The user clicked a button (or submitted a selection) on a WeCom template card you sent earlier. Answer the click in your reply."
      ].join("\n")
    }];
    await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, "DeepSeek Harness conversation availability");
    const start = agent.session.events.length;
    this.activeTurns.set(id, chatTarget(message));
    try {
      agent.followup(createUserMessage({ content, source: { kind: "user" } }));
      await withTimeout(agent.whenIdle(), this.config.responseTimeoutMs, "DeepSeek Harness response");
      const collected = await this.collectReply(agent, agent.session.events.slice(start));
      return this.finalizeReply(id, collected);
    } finally {
      this.activeTurns.delete(id);
    }
  }
  /**
   * Attach the turn's queued cards to a collected reply. In "auto" mode an
   * adaptive interaction card accompanies the Markdown reply whenever the
   * reply asks the user to choose or confirm and the model did not send an
   * explicit card first.
   */
  finalizeReply(id, collected) {
    const cards = this.takeCards(id);
    if (this.config.cardMode === "auto" && cards.length === 0 && collected.text.trim().length > 0) {
      const derived = deriveAdaptiveCard(collected.text, this.config.cardTaskIdPrefix);
      if (derived !== void 0) cards.push(derived.card);
    }
    this.registerCardLabels(cards);
    return { ...collected, cards };
  }
  /** Drain and clear the template cards queued by one active turn's tools. */
  takeCards(id) {
    const cards = this.pendingCards.get(id) ?? [];
    this.pendingCards.delete(id);
    return cards;
  }
  /**
   * Remember every sent card's button key → visible label pairs so a later
   * click (which only echoes event_key) can be resolved to the chosen option.
   */
  registerCardLabels(cards) {
    for (const card of cards) {
      const taskId = card.task_id;
      if (taskId === void 0) continue;
      let labels = this.cardLabels.get(taskId);
      if (labels === void 0) {
        labels = /* @__PURE__ */ new Map();
        this.cardLabels.set(taskId, labels);
        while (this.cardLabels.size > MAX_CARD_LABEL_TASKS) {
          const oldest = this.cardLabels.keys().next().value;
          if (oldest === void 0) break;
          this.cardLabels.delete(oldest);
        }
      }
      for (const button of card.button_list ?? []) labels.set(button.key, button.text);
      if (card.submit_button !== void 0) {
        labels.set(card.submit_button.key, `\u63D0\u4EA4\uFF1A${card.submit_button.text}`);
      }
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
    const disposeFileTool = this.registerFileTool(agent.ctx, id);
    const disposeCardTool = this.registerCardTool(agent.ctx, id);
    let released = false;
    return {
      agent,
      release: async () => {
        if (released) return;
        released = true;
        disposeCardTool();
        disposeFileTool();
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
    this.registerFileTool(agentCtx, id);
    this.registerCardTool(agentCtx, id);
  }
  registerWeComInstructions(agentCtx, id) {
    return agentCtx.systemPrompt.section({
      name: "channel:wecom",
      order: 190,
      text: () => this.activeTurns.has(id) ? this.config.systemPrompt : ""
    });
  }
  registerFileTool(agentCtx, id) {
    return agentCtx.tools.register(defineTool({
      name: "wecom_send_file",
      description: "Send one existing regular file from the configured workspace to the user who initiated the current WeCom turn. Use this when the WeCom user asks to receive or download a local file. The path may be absolute or relative to the workspace; paths outside the workspace and files over the configured size limit are rejected. Never use it for credentials or secrets.",
      parameters: {
        path: {
          type: "string",
          required: true,
          description: "Absolute path within the configured workspace, or a path relative to that workspace."
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", required: true },
            bytes: { type: "number", required: true }
          }
        },
        render: (_args, value) => [{
          type: "text",
          text: `Sent ${JSON.stringify(value.name)} (${value.bytes} bytes) to the current WeCom conversation.`
        }]
      },
      execute: async (args, exec) => {
        const target = this.activeTurns.get(id);
        if (target === void 0) {
          throw new Error("wecom_send_file: no active WeCom turn; this tool cannot send files from another channel");
        }
        exec.signal.throwIfAborted();
        const file = await resolveOutboundFile(this.config.cwd, args.path, this.config.maxOutboundFileBytes);
        exec.signal.throwIfAborted();
        await this.sendFile(target, file);
        return { name: file.name, bytes: file.bytes };
      },
      presentCall: (args) => ({
        card: "generic",
        title: `Send file ${args.path}`,
        kind: "execute",
        rawInput: args.path,
        locations: [{ path: args.path }]
      })
    }));
  }
  registerCardTool(agentCtx, id) {
    return agentCtx.tools.register(defineTool({
      name: "wecom_send_card",
      description: "Send one WeCom template card to the user who initiated the current WeCom turn. The card is delivered as a second message right after the main Markdown reply, so one turn becomes one Markdown message plus one card. Prefer this tool when the user must choose among options or confirm/cancel an action: put the FULL option details in your Markdown reply and put SHORT labels (at most 10 characters) on the card buttons, because button text is truncated by the WeCom client. Display text is truncated to the WeCom card limits (title 26, desc 30, subtitle 112 characters), so never duplicate the full reply inside the card. Only valid during an active WeCom turn.",
      parameters: {
        card_type: {
          type: "string",
          required: true,
          enum: ["text_notice", "news_notice", "button_interaction", "vote_interaction", "multiple_interaction"],
          description: "Card layout: text_notice (title + subtitle), news_notice (image card, needs image_url), button_interaction (option/confirm buttons), vote_interaction (checkbox list + submit), multiple_interaction (up to 3 dropdown selectors + submit). Clicks and submissions come back as WeCom messages carrying task_id and event_key."
        },
        title: {
          type: "string",
          required: true,
          description: "Card main title; capped at 26 characters, longer text is truncated."
        },
        desc: {
          type: "string",
          description: "Short helper text under the title; capped at 30 characters."
        },
        subtitle: {
          type: "string",
          description: "Secondary body text; capped at 112 characters."
        },
        buttons: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string", required: true, description: "Short option label, capped at 10 characters." },
              key: { type: "string", required: true, description: "Stable key echoed back on click (event_key), max 1024 bytes." },
              style: { type: "integer", description: "Button style 1-4; defaults to 1." }
            }
          },
          description: "Buttons for button_interaction cards; 1 to 6 entries. Keep labels short; spell out the full option details in your Markdown reply instead."
        },
        options: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", required: true, description: "Option id, max 128 bytes, unique." },
              text: { type: "string", required: true, description: "Option label, capped at 11 characters." },
              is_checked: { type: "boolean", description: "Whether the option is checked by default." }
            }
          },
          description: "Options for vote_interaction cards; 1 to 20 entries."
        },
        vote_mode: {
          type: "integer",
          description: "vote_interaction mode: 0 single choice (default), 1 multiple choice."
        },
        selects: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              question_key: { type: "string", required: true, description: "Selector key, max 1024 bytes, unique." },
              title: { type: "string", description: "Selector title, capped at 13 characters." },
              options: {
                type: "array",
                required: true,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string", required: true, description: "Option id, max 128 bytes, unique." },
                    text: { type: "string", required: true, description: "Option label, capped at 10 characters." }
                  }
                },
                description: "Dropdown options; 1 to 10 entries."
              }
            }
          },
          description: "Dropdown selectors for multiple_interaction cards; 1 to 3 entries."
        },
        submit_text: {
          type: "string",
          description: "Submit button label for vote/multiple cards, capped at 10 characters; required for those types."
        },
        submit_key: {
          type: "string",
          description: "Submit button key echoed back on submission (event_key), max 1024 bytes; required for vote/multiple cards."
        },
        image_url: {
          type: "string",
          description: "Image URL for news_notice cards (required for that card type)."
        },
        jump_url: {
          type: "string",
          description: "Whole-card click URL for news_notice cards."
        },
        task_id: {
          type: "string",
          description: 'Task id identifying this card (digits, letters, "_-@", max 128 bytes). Omit to auto-generate.'
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            task_id: { type: "string", required: true },
            card_type: { type: "string", required: true },
            title: { type: "string", required: true },
            buttons: { type: "array", items: { type: "json" } }
          }
        },
        render: (_args, value) => [{
          type: "text",
          text: `Queued WeCom ${value.card_type} card ${JSON.stringify(value.task_id)}; it will be delivered after this reply.`
        }]
      },
      execute: async (args, exec) => {
        const target = this.activeTurns.get(id);
        if (target === void 0) {
          throw new Error("wecom_send_card: no active WeCom turn; this tool cannot send cards from another channel");
        }
        if (this.config.cardMode === "off") {
          throw new Error('wecom_send_card: cardMode is "off"; cards are disabled for this WeCom channel');
        }
        exec.signal.throwIfAborted();
        const input = {
          cardType: args.card_type,
          title: args.title,
          ...args.desc === void 0 ? {} : { desc: args.desc },
          ...args.subtitle === void 0 ? {} : { subtitle: args.subtitle },
          ...args.buttons === void 0 ? {} : { buttons: args.buttons },
          ...args.options === void 0 ? {} : { options: args.options },
          ...args.selects === void 0 ? {} : {
            selects: args.selects.map((select) => ({
              questionKey: select.question_key,
              ...select.title === void 0 ? {} : { title: select.title },
              options: select.options
            }))
          },
          ...args.vote_mode === void 0 ? {} : { voteMode: args.vote_mode },
          ...args.submit_text === void 0 ? {} : { submitText: args.submit_text },
          ...args.submit_key === void 0 ? {} : { submitKey: args.submit_key },
          ...args.image_url === void 0 ? {} : { imageUrl: args.image_url },
          ...args.jump_url === void 0 ? {} : { jumpUrl: args.jump_url },
          ...args.task_id === void 0 ? {} : { taskId: args.task_id }
        };
        const card = buildTemplateCard(input, this.config.cardTaskIdPrefix);
        const cards = this.pendingCards.get(id) ?? [];
        cards.push(card);
        this.pendingCards.set(id, cards);
        return {
          task_id: card.task_id ?? "",
          card_type: card.card_type,
          title: card.main_title?.title ?? "",
          buttons: (card.button_list ?? []).map((button) => ({
            text: button.text,
            key: button.key,
            style: button.style ?? 1
          }))
        };
      },
      presentCall: (args) => ({
        card: "generic",
        title: `Send ${args.card_type} card`,
        kind: "execute",
        rawInput: args.title
      })
    }));
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
var OUTBOUND_TEST_FILE = Buffer.from("DeepSeek Harness WeCom file upload test\n", "utf8");
var WeComHarnessBridge = class {
  constructor(ctx, config, clientFactory = (options) => new WSClient(options)) {
    this.ctx = ctx;
    this.config = config;
    this.clientFactory = clientFactory;
    if (!isAbsolute3(config.cwd)) throw new Error(`wecom-channel: cwd must be absolute, got ${JSON.stringify(config.cwd)}`);
    if (!isAbsolute3(config.inboundFileDirectory)) {
      throw new Error(
        `wecom-channel: inboundFileDirectory must be absolute, got ${JSON.stringify(config.inboundFileDirectory)}`
      );
    }
    this.log = ctx.logger("deepseek-harness-wecom-plus");
    this.conversations = new ConversationManager(ctx, config, (target, file) => this.sendLocalFile(target, file));
    this.seen = new SeenMessageIds(config.maxSeenMessageIds);
    this.allowedHarnessCommands = new Set(config.allowedHarnessCommands);
  }
  ctx;
  config;
  clientFactory;
  log;
  conversations;
  seen;
  allowedHarnessCommands;
  client;
  stopping = false;
  /** Stay dormant without credentials, or authenticate and wait for WeCom readiness. */
  async start() {
    if (!this.config.botId.trim()) {
      this.log.info("WeCom channel is inactive: configure botId or WECOM_BOT_ID to enable it");
      return;
    }
    if (!this.config.secretRef.trim()) {
      this.log.warn("WeCom channel is inactive: secretRef is empty");
      return;
    }
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.config.secretRef));
    const secret = resolved?.value.trim();
    if (!secret) {
      this.log.warn(
        "WeCom channel is inactive: credential %s is not configured",
        JSON.stringify(this.config.secretRef)
      );
      return;
    }
    await this.conversations.initialize();
    const client = this.createClient(secret);
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
    client.on("event.template_card_event", async (frame) => this.handleCardEvent(frame));
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
      plug_version: "deepseek-harness-wecom-plus/0.2.0"
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
  /**
   * One template card button click: acknowledge the click locally inside the
   * protocol's 5-second update window, then hand the click to the conversation
   * as a user message and push the model's reply proactively.
   */
  async handleCardEvent(frame) {
    const body = frame.body;
    if (body === void 0 || this.seen.hasOrAdd(body.msgid) || !this.allowedEvent(body)) return;
    const taskId = body.event.task_id?.trim();
    if (taskId !== void 0 && taskId.length > 0) {
      try {
        await withTimeout(this.requireClient().updateTemplateCard(frame, {
          card_type: "text_notice",
          main_title: {
            title: truncateChars(this.config.cardClickAckTitle, CARD_LIMITS.title),
            desc: truncateChars(this.config.cardClickAckSubtitle, CARD_LIMITS.titleDesc)
          },
          task_id: taskId
        }, [body.from.userid]), 4500, "WeCom card click acknowledgement");
      } catch (error) {
        this.log.warn("WeCom card click acknowledgement failed: %s", String(error));
      }
    }
    try {
      const reply = await this.conversations.processCardEvent(
        body,
        this.conversations.cardLabel(taskId, body.event.event_key)
      );
      await this.sendProactive(chatTarget(body), reply);
    } catch (error) {
      this.log.error("WeCom card click %s failed: %s", body.msgid, String(error));
      try {
        await this.sendProactive(chatTarget(body), {
          text: "\u5904\u7406\u6309\u94AE\u70B9\u51FB\u65F6\u53D1\u751F\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002",
          images: [],
          cards: []
        });
      } catch (sendError) {
        this.log.error("WeCom card click error reply failed: %s", String(sendError));
      }
    }
  }
  async handleMessage(frame) {
    const message = frame.body;
    if (message === void 0 || this.seen.hasOrAdd(message.msgid) || !this.allowed(message)) return;
    try {
      const command = slashCommand(message);
      if (command?.name === "bot-ping") {
        await this.sendReply(frame, { text: "pong \u2014 DeepSeek Harness \u4F01\u5FAE\u673A\u5668\u4EBA\u5DF2\u8FDE\u63A5\u3002", images: [], cards: [] });
        return;
      }
      if (command?.name === "help" || command?.name === "bot-help") {
        await this.sendReply(frame, { text: this.helpText(), images: [], cards: [] });
        return;
      }
      if (command?.name === "new" || command?.name === "reset") {
        await this.conversations.reset(message);
        await this.sendReply(frame, {
          text: "\u5DF2\u5F00\u542F\u65B0\u5BF9\u8BDD\u3002\u4E0B\u4E00\u6761\u6D88\u606F\u4F1A\u4F7F\u7528\u5168\u65B0\u7684 Harness \u4E0A\u4E0B\u6587\uFF0C\u65E7\u4F1A\u8BDD\u5386\u53F2\u4ECD\u4FDD\u7559\u5728\u7F51\u9875\u7AEF\u3002",
          images: [],
          cards: []
        });
        return;
      }
      if (command?.name === "bot-image-test") {
        await this.sendReply(frame, {
          text: "\u84DD\u8272\u6D4B\u8BD5\u56FE\u7247\u53D1\u9001\u6210\u529F\u3002",
          images: [{ data: OUTBOUND_TEST_PNG, mediaType: "image/png", name: "wecom-image-test.png" }],
          cards: []
        });
        return;
      }
      if (command?.name === "bot-card-test") {
        const card = buildTemplateCard({
          cardType: "button_interaction",
          title: "\u6A21\u677F\u5361\u7247\u6D4B\u8BD5",
          subtitle: "\u70B9\u51FB\u4E0B\u65B9\u6309\u94AE\u9A8C\u8BC1\u5361\u7247\u4EA4\u4E92\u94FE\u8DEF\u3002",
          buttons: [
            { text: "\u786E\u8BA4\u6536\u5230", key: "bot-card-test-ok", style: 1 },
            { text: "\u518D\u60F3\u60F3", key: "bot-card-test-retry", style: 2 }
          ]
        }, this.config.cardTaskIdPrefix);
        await this.retry(async () => withTimeout(
          this.requireClient().sendMessage(chatTarget(message), { msgtype: "template_card", template_card: card }),
          this.config.sendTimeoutMs,
          "WeCom card test send"
        ));
        await this.sendReply(frame, {
          text: "\u6A21\u677F\u5361\u7247\u5DF2\u53D1\u9001\u3002\u70B9\u51FB\u5361\u7247\u6309\u94AE\u540E\uFF0C\u4F60\u4F1A\u5148\u770B\u5230\u5904\u7406\u786E\u8BA4\uFF0C\u968F\u540E\u6536\u5230\u6A21\u578B\u56DE\u590D\u3002",
          images: [],
          cards: []
        });
        return;
      }
      if (command?.name === "bot-file-test") {
        await this.sendMedia(
          chatTarget(message),
          OUTBOUND_TEST_FILE,
          "file",
          "wecom-file-test.txt",
          "WeCom file"
        );
        await this.sendReply(frame, { text: "\u6587\u672C\u9644\u4EF6\u53D1\u9001\u6210\u529F\u3002", images: [], cards: [] });
        return;
      }
      if (command?.name === "bot-cancel") {
        const cancelled = this.conversations.cancel(message);
        await this.sendReply(frame, {
          text: cancelled ? "\u5DF2\u8BF7\u6C42\u53D6\u6D88\u5F53\u524D\u751F\u6210\u3002" : "\u5F53\u524D\u6CA1\u6709\u6B63\u5728\u751F\u6210\u7684\u56DE\u590D\u3002",
          images: [],
          cards: []
        });
        return;
      }
      if (command?.name === "bot-status") {
        await this.sendReply(frame, {
          text: "\u4F01\u5FAE\u957F\u8FDE\u63A5\u6B63\u5E38\uFF0CDeepSeek Harness \u4F1A\u8BDD\u6309\u5355\u804A/\u7FA4\u804A\u72EC\u7ACB\u6301\u4E45\u5316\u3002",
          images: [],
          cards: []
        });
        return;
      }
      if (command?.name === "export") {
        await this.sendReply(frame, {
          text: "/export \u4F9D\u8D56\u7F51\u9875\u4E0B\u8F7D\u754C\u9762\uFF0C\u4F01\u5FAE\u6682\u4E0D\u652F\u6301\u3002\u4F1A\u8BDD\u5185\u5BB9\u6CA1\u6709\u53D1\u9001\u7ED9\u6A21\u578B\u3002",
          images: [],
          cards: []
        });
        return;
      }
      if (command !== void 0 && this.allowedHarnessCommands.has(command.name)) {
        const outcome = await this.conversations.executeCommand(message, command.line);
        await this.sendReply(frame, this.commandReply(command.name, outcome));
        return;
      }
      if (command !== void 0) {
        await this.sendReply(frame, {
          text: `\u672A\u77E5\u6216\u672A\u5F00\u653E\u7684\u547D\u4EE4 /${command.name}\u3002\u8BE5\u5185\u5BB9\u6CA1\u6709\u53D1\u9001\u7ED9\u6A21\u578B\uFF1B\u53D1\u9001 /help \u67E5\u770B\u53EF\u7528\u547D\u4EE4\u3002`,
          images: [],
          cards: []
        });
        return;
      }
      const reply = await this.conversations.process(message, this.requireClient());
      await this.sendReply(frame, reply);
    } catch (error) {
      this.log.error("WeCom message %s failed: %s", message.msgid, String(error));
      try {
        await this.sendReply(frame, { text: "\u5904\u7406\u6D88\u606F\u65F6\u53D1\u751F\u9519\u8BEF\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002", images: [], cards: [] });
      } catch (sendError) {
        this.log.error("WeCom error reply failed: %s", String(sendError));
      }
    }
  }
  helpText() {
    const harnessCommands = [...this.allowedHarnessCommands].map((name2) => `/${name2}`).join("\u3001") || "\uFF08\u672A\u5F00\u653E\uFF09";
    return [
      "DeepSeek Harness \u4F01\u5FAE\u673A\u5668\u4EBA",
      "/new \u2014 \u5F00\u542F\u5168\u65B0\u7684\u6301\u4E45\u4F1A\u8BDD\uFF0C\u65E7\u5386\u53F2\u4FDD\u7559",
      "/reset \u2014 /new \u7684\u522B\u540D",
      "/help\u3001/bot-help \u2014 \u663E\u793A\u672C\u5E2E\u52A9",
      "/bot-ping \u2014 \u68C0\u67E5\u8FDE\u901A\u6027",
      "/bot-image-test \u2014 \u53D1\u9001\u4E00\u5F20\u84DD\u8272\u56FE\u7247\uFF0C\u68C0\u67E5\u56FE\u7247\u51FA\u7AD9\u94FE\u8DEF",
      "/bot-card-test \u2014 \u53D1\u9001\u4E00\u5F20\u6309\u94AE\u4EA4\u4E92\u6A21\u677F\u5361\u7247\uFF0C\u68C0\u67E5\u5361\u7247\u4E0E\u6309\u94AE\u70B9\u51FB\u94FE\u8DEF",
      "/bot-file-test \u2014 \u53D1\u9001\u4E00\u4E2A\u6587\u672C\u9644\u4EF6\uFF0C\u68C0\u67E5\u6587\u4EF6\u51FA\u7AD9\u94FE\u8DEF",
      "/bot-status \u2014 \u67E5\u770B\u5F53\u524D\u4F1A\u8BDD\u72B6\u6001",
      "/bot-cancel \u2014 \u53D6\u6D88\u5F53\u524D\u751F\u6210",
      `\u5DF2\u5F00\u653E\u7684 Harness \u547D\u4EE4\uFF1A${harnessCommands}\uFF08\u4EC5\u5728\u5F53\u524D preset \u6CE8\u518C\u540E\u53EF\u7528\uFF09`,
      "\u5176\u4ED6\u659C\u6760\u547D\u4EE4\u4F1A\u88AB\u63D2\u4EF6\u62D2\u7EDD\uFF0C\u4E0D\u4F1A\u9001\u7ED9\u6A21\u578B\uFF1B\u666E\u901A\u6D88\u606F\u4F1A\u4EA4\u7ED9\u5F53\u524D Harness \u9ED8\u8BA4\u6A21\u578B\u5904\u7406\u3002"
    ].join("\n");
  }
  commandReply(name2, outcome) {
    if (outcome.execution === void 0) {
      return {
        text: `\u5F53\u524D\u4F1A\u8BDD\u7684 agent preset \u6CA1\u6709\u6CE8\u518C /${name2}\u3002\u8BE5\u5185\u5BB9\u6CA1\u6709\u53D1\u9001\u7ED9\u6A21\u578B\u3002`,
        images: [],
        cards: []
      };
    }
    const direct = outcome.execution.result.text?.trim() || (outcome.execution.result.kind === "success" ? `/${name2} \u5DF2\u6267\u884C\u3002` : `/${name2} \u6267\u884C\u5931\u8D25\u3002`);
    const text = outcome.response?.text ? `${direct}

${outcome.response.text}` : direct;
    return {
      text,
      images: outcome.response?.images ?? [],
      cards: outcome.response?.cards ?? []
    };
  }
  allowed(message) {
    const group = message.chattype === "group";
    return this.allowedScope(group, message.from.userid);
  }
  /** Access policy check for an event frame (its chattype is optional). */
  allowedEvent(message) {
    return this.allowedScope(message.chattype === "group", message.from.userid);
  }
  allowedScope(group, userid) {
    const policy = group ? this.config.groupPolicy : this.config.singlePolicy;
    const allow = group ? this.config.groupAllowFrom : this.config.singleAllowFrom;
    if (policy === "disabled") return false;
    return policy === "open" || allow.includes(userid);
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
        md5: createHash3("md5").update(image.data).digest("hex")
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
      await this.sendMedia(chatTarget(message), Buffer.from(image.data), "image", filename, "WeCom image");
    }
    await this.sendCards(chatTarget(message), reply.cards);
  }
  /**
   * Proactive outbound path for turns without a respondable frame (template
   * card button clicks): one Markdown message, media uploads, then cards.
   */
  async sendProactive(target, reply) {
    const fallback = reply.images.length > 0 ? "\u56FE\u7247\u56DE\u590D" : "\u5904\u7406\u5B8C\u6210\u3002";
    await this.retry(async () => withTimeout(
      this.requireClient().sendMessage(target, {
        msgtype: "markdown",
        markdown: { content: truncateUtf8(reply.text || fallback, this.config.maxReplyBytes) }
      }),
      this.config.sendTimeoutMs,
      "WeCom proactive Markdown send"
    ));
    for (const image of reply.images) {
      const filename = image.name?.trim() || imageFilename(image.mediaType);
      await this.sendMedia(target, Buffer.from(image.data), "image", filename, "WeCom image");
    }
    await this.sendCards(target, reply.cards);
  }
  /** Deliver queued template cards as follow-up messages; failures only log, never retract the reply. */
  async sendCards(target, cards) {
    for (const card of cards) {
      try {
        await this.retry(async () => withTimeout(
          this.requireClient().sendMessage(target, { msgtype: "template_card", template_card: card }),
          this.config.sendTimeoutMs,
          "WeCom template card send"
        ));
      } catch (error) {
        this.log.error("WeCom template card send failed: %s", String(error));
      }
    }
  }
  async sendLocalFile(target, file) {
    const data = await readFile2(file.path);
    if (data.byteLength > this.config.maxOutboundFileBytes) {
      throw new Error(
        `wecom_send_file: file is ${data.byteLength} bytes; configured limit is ${this.config.maxOutboundFileBytes} bytes`
      );
    }
    await this.sendMedia(target, data, "file", file.name, "WeCom file");
  }
  async sendMedia(target, data, mediaType, filename, operation) {
    const uploaded = await this.retry(async () => withTimeout(
      this.requireClient().uploadMedia(data, { type: mediaType, filename }),
      this.config.sendTimeoutMs,
      `${operation} upload`
    ));
    await this.retry(async () => withTimeout(
      this.requireClient().sendMediaMessage(target, mediaType, uploaded.media_id),
      this.config.sendTimeoutMs,
      `${operation} send`
    ));
  }
  async retry(operation) {
    let lastError;
    for (let attempt = 0; attempt <= this.config.sendRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt < this.config.sendRetries) await new Promise((resolve2) => setTimeout(resolve2, 250 * (attempt + 1)));
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
function slashCommand(message) {
  let line;
  if (message.msgtype === "text") {
    line = message.text?.content?.trim() ?? "";
  } else if (message.msgtype === "mixed") {
    const mixed = message.mixed;
    line = (mixed?.msg_item ?? []).filter((item) => item.msgtype === "text").map((item) => item.text?.content ?? "").join("").trim();
  } else {
    return void 0;
  }
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/iu.exec(line);
  if (match === null) return void 0;
  const rawName = match[1];
  if (rawName === void 0) return void 0;
  const name2 = rawName.toLowerCase();
  return { name: name2, line: `/${name2}${line.slice(match[0].length)}` };
}
function imageFilename(mediaType) {
  if (mediaType === "image/jpeg") return "image.jpg";
  if (mediaType === "image/gif") return "image.gif";
  if (mediaType === "image/webp") return "image.webp";
  return "image.png";
}

// src/config.ts
import { tmpdir } from "os";
import { join as join2 } from "path";
import z from "@deepseek-ai/schemastery";
var WECOM_FILE_MAX_BYTES = 20 * 1024 * 1024;
var DEFAULT_WECOM_INBOUND_FILE_DIRECTORY = join2(
  tmpdir(),
  `deepseek-harness-wecom-plus-${typeof process.getuid === "function" ? process.getuid() : "current-user"}`,
  "inbound"
);
var COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u;
var Config = z.object({
  botId: z.string().default(""),
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
  allowedHarnessCommands: z.array(z.string().pattern(COMMAND_NAME_PATTERN)).default(["compact", "goal", "plan"]),
  imageInputMode: z.union(["auto", "always", "never"]).default("auto"),
  cardMode: z.union(["auto", "tool", "off"]).default("auto"),
  cardTaskIdPrefix: z.string().default("dshp"),
  cardClickAckTitle: z.string().default("\u6B63\u5728\u5904\u7406\u2026"),
  cardClickAckSubtitle: z.string().default("\u5DF2\u6536\u5230\u6309\u94AE\u70B9\u51FB\uFF0C\u6B63\u5728\u5904\u7406\uFF0C\u8BF7\u7A0D\u5019\u3002"),
  inboundFileDirectory: z.string().default(DEFAULT_WECOM_INBOUND_FILE_DIRECTORY),
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
  maxInboundFileBytes: z.number().step(1).min(1).max(WECOM_FILE_MAX_BYTES).default(WECOM_FILE_MAX_BYTES),
  maxOutboundFileBytes: z.number().step(1).min(1).max(WECOM_FILE_MAX_BYTES).default(WECOM_FILE_MAX_BYTES),
  systemPrompt: z.string().default(
    "You are replying through WeCom. Keep replies clear and suitable for enterprise chat. Use WeCom-compatible Markdown for headings, lists, links, emphasis, quotes, and code when structure helps. When the WeCom user asks to receive an existing workspace file, use wecom_send_file instead of claiming that file attachments are unavailable or pasting the whole file. When the user must choose among options or confirm/cancel an action, pair your reply with a card: put the FULL option details (what each choice does) in your Markdown reply, then call wecom_send_card with button_interaction whose buttons carry SHORT labels (at most 10 characters, or the WeCom client truncates them). One turn therefore renders as one Markdown message + one card. For lists of choices you may use vote_interaction (checkbox) or multiple_interaction (dropdowns) instead; keep every label within its cap and never duplicate the whole reply inside the card. When a user clicks a card button or submits a selection, the click arrives as a WeCom message carrying task_id and event_key (plus the selected label when known); answer that click in your reply. Inbound WeCom files are already downloaded and decrypted; their absolute local paths appear in the user message. Use the available file or shell tools to inspect those paths when the user asks you to process an attachment. Do not reveal credentials or internal system data. When a request needs an interactive approval that WeCom cannot provide, explain what approval is needed instead of waiting indefinitely."
  )
});

// src/index.ts
var name = "deepseek-harness-wecom-plus";
var inject = [
  "agentDefaultModel",
  "agentPresets",
  "agents",
  "attachments",
  "commands",
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