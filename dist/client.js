window.__ModuleLoader__.load({ id: "deepseek-harness-wecom-plus", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var client_exports = {};
__export(client_exports, {
  WeComSettingsController: () => WeComSettingsController,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var ROUTE = "/_dsh/deepseek-harness-wecom-plus/settings";
async function apiRequest(init) {
  const response = await fetch(ROUTE, { credentials: "same-origin", ...init });
  const body = await response.json();
  if (!response.ok || !body.ok) {
    const failure = body;
    throw new Error(failure.error?.message ?? `settings request failed with HTTP ${response.status}`);
  }
  return body.value;
}
var WeComSettingsController = class {
  state = { status: "idle" };
  listeners = /* @__PURE__ */ new Set();
  generation = 0;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  set(next) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  async load() {
    const generation = ++this.generation;
    this.set({ ...this.state, status: "loading", error: void 0, message: void 0 });
    try {
      const snapshot = await apiRequest();
      if (generation !== this.generation) return;
      this.set({ status: "ready", snapshot });
    } catch (error) {
      if (generation !== this.generation) return;
      this.set({ ...this.state, status: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }
  refreshIfLoaded() {
    if (this.state.status === "idle" || this.state.action === "save") return;
    void this.load();
  }
  async save(value, expectedRevision) {
    this.set({ ...this.state, action: "save", error: void 0, message: void 0 });
    try {
      const snapshot = await apiRequest({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", expectedRevision, value })
      });
      this.set({ status: "ready", snapshot, message: "saved" });
    } catch (error) {
      this.set({ ...this.state, action: void 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  /** Store one pasted Secret through the credentials seam; the value never comes back out. */
  async setKey(value) {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    this.set({ ...this.state, action: "set-key", error: void 0, message: void 0 });
    try {
      const snapshot = await apiRequest({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-key", value: trimmed })
      });
      this.set({ status: "ready", snapshot, message: "keySaved" });
    } catch (error) {
      this.set({ ...this.state, action: void 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  async clearKey() {
    this.set({ ...this.state, action: "clear-key", error: void 0, message: void 0 });
    try {
      const snapshot = await apiRequest({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear-key" })
      });
      this.set({ status: "ready", snapshot, message: "keyCleared" });
    } catch (error) {
      this.set({ ...this.state, action: void 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
};
function Field({ label, hint, children }) {
  return /* @__PURE__ */ React.createElement("label", { className: "wc-field" }, /* @__PURE__ */ React.createElement("span", null, label), children, hint === void 0 ? null : /* @__PURE__ */ React.createElement("small", null, hint));
}
var SectionErrorBoundary = class extends import_react.Component {
  state = { error: void 0 };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error !== void 0) {
      const message = this.state.error?.message || String(this.state.error);
      return /* @__PURE__ */ React.createElement("div", { className: "wc-settings" }, /* @__PURE__ */ React.createElement("div", { className: "wc-alert error" }, "\u9875\u9762\u6E32\u67D3\u51FA\u9519\uFF08\u8BF7\u628A\u8FD9\u6BB5\u6587\u5B57\u548C\u6D4F\u89C8\u5668\u63A7\u5236\u53F0\u62A5\u9519\u4E00\u8D77\u53CD\u9988\uFF09\uFF1A", /* @__PURE__ */ React.createElement("pre", { style: { whiteSpace: "pre-wrap", margin: "8px 0 0" } }, message), this.state.error?.stack !== void 0 ? /* @__PURE__ */ React.createElement("pre", { style: { whiteSpace: "pre-wrap", margin: "8px 0 0" } }, this.state.error.stack) : null));
    }
    return this.props.children;
  }
};
var CHANNEL_LABEL = {
  inactive: "\u672A\u6FC0\u6D3B\uFF08\u7F3A Bot ID / Secret \u6216\u672A\u914D\u7F6E\uFF09",
  connecting: "\u8FDE\u63A5\u4E2D\u2026",
  connected: "\u5DF2\u8FDE\u63A5\uFF08WeCom AI Bot authenticated\uFF09"
};
var POLICY_OPTIONS = [
  { value: "open", label: "\u5F00\u653E\uFF08open\uFF09" },
  { value: "allowlist", label: "\u767D\u540D\u5355\uFF08allowlist\uFF09" },
  { value: "disabled", label: "\u7981\u7528\uFF08disabled\uFF09" }
];
var CARD_MODE_OPTIONS = [
  { value: "auto", label: "auto\uFF08\u81EA\u9002\u5E94\uFF1A\u9009\u9879/\u786E\u8BA4\u81EA\u52A8\u914D\u5361\uFF09" },
  { value: "tool", label: "tool\uFF08\u4EC5\u6A21\u578B\u663E\u5F0F\u53D1\u5361\uFF09" },
  { value: "off", label: "off\uFF08\u5173\u95ED\u5361\u7247\uFF09" }
];
function SettingsSection(props) {
  const { controller } = props;
  if (controller === void 0) {
    return /* @__PURE__ */ React.createElement("div", { className: "wc-settings" }, /* @__PURE__ */ React.createElement("div", { className: "wc-alert error" }, "\u5185\u90E8\u9519\u8BEF\uFF1A\u63A7\u5236\u5668\u672A\u6CE8\u5165\uFF08controller is undefined\uFF09\u3002\u8BF7\u6309 F12 \u6253\u5F00\u6D4F\u89C8\u5668\u63A7\u5236\u53F0\uFF0C\u628A\u7EA2\u8272\u62A5\u9519\u622A\u56FE\u6216\u590D\u5236\u7ED9\u6211\u3002"));
  }
  return /* @__PURE__ */ React.createElement(SectionErrorBoundary, null, /* @__PURE__ */ React.createElement(LoadedSettings, { controller }));
}
function LoadedSettings({ controller }) {
  const state = (0, import_react.useSyncExternalStore)(controller.subscribe, controller.snapshot, controller.snapshot);
  const snapshot = state.snapshot;
  const [draft, setDraft] = (0, import_react.useState)(void 0);
  const [keyDraft, setKeyDraft] = (0, import_react.useState)("");
  (0, import_react.useEffect)(() => {
    if (state.status === "idle") void controller.load();
  }, [controller, state.status]);
  (0, import_react.useEffect)(() => {
    if (snapshot !== void 0) setDraft(snapshot.settings.value);
  }, [snapshot]);
  if (state.status === "idle" || state.status === "loading" && snapshot === void 0) {
    return /* @__PURE__ */ React.createElement("div", { className: "wc-settings" }, /* @__PURE__ */ React.createElement("div", { className: "wc-loading" }, "\u52A0\u8F7D\u4E2D\u2026"));
  }
  if (snapshot === void 0 || draft === void 0) {
    return /* @__PURE__ */ React.createElement("div", { className: "wc-settings" }, /* @__PURE__ */ React.createElement("div", { className: "wc-alert error" }, state.error ?? "\u52A0\u8F7D\u5931\u8D25"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "wc-button", onClick: () => {
      void controller.load();
    } }, "\u91CD\u8BD5"));
  }
  const update = (key, value) => setDraft((current) => current === void 0 ? current : { ...current, [key]: value });
  const busy = state.action !== void 0;
  const channel = snapshot.channel;
  return /* @__PURE__ */ React.createElement("div", { className: "wc-settings" }, /* @__PURE__ */ React.createElement("header", { className: "wc-settings-header" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("span", { className: "wc-kicker" }, "deepseek-harness-wecom-plus"), /* @__PURE__ */ React.createElement("h2", null, "\u4F01\u5FAE\u673A\u5668\u4EBA"), /* @__PURE__ */ React.createElement("p", null, "\u628A\u4F01\u4E1A\u5FAE\u4FE1\u667A\u80FD\u673A\u5668\u4EBA\u901A\u8FC7\u5B98\u65B9\u957F\u8FDE\u63A5\u63A5\u5165 DeepSeek Harness\u3002Bot ID \u4E0E Secret \u6765\u81EA\u4F01\u5FAE\u7BA1\u7406\u540E\u53F0\u300C\u667A\u80FD\u673A\u5668\u4EBA\u300D\u9875\u9762\uFF1B\u4FDD\u5B58\u540E\u901A\u9053\u4F1A\u7ACB\u5373\u91CD\u8FDE\uFF0C\u65E0\u9700\u91CD\u542F DSH\u3002")), /* @__PURE__ */ React.createElement("div", { className: "wc-release" }, /* @__PURE__ */ React.createElement("span", null, "\u63D2\u4EF6\u7248\u672C ", /* @__PURE__ */ React.createElement("strong", null, snapshot.release.pluginVersion)), /* @__PURE__ */ React.createElement("span", null, "\u8FDE\u63A5\u72B6\u6001 ", /* @__PURE__ */ React.createElement("strong", null, CHANNEL_LABEL[channel.state])))), !snapshot.writable ? /* @__PURE__ */ React.createElement("div", { className: "wc-alert warning" }, "\u5F53\u524D Settings \u63D0\u4F9B\u65B9\u4E3A\u53EA\u8BFB\uFF0C\u65E0\u6CD5\u5728\u754C\u9762\u4FDD\u5B58\u3002") : null, channel.detail !== void 0 ? /* @__PURE__ */ React.createElement("div", { className: "wc-alert warning" }, channel.detail) : null, state.error === void 0 ? null : /* @__PURE__ */ React.createElement("div", { className: "wc-alert error" }, state.error), state.message === "saved" ? /* @__PURE__ */ React.createElement("div", { className: "wc-alert success" }, "\u8BBE\u7F6E\u5DF2\u4FDD\u5B58\uFF0C\u901A\u9053\u5DF2\u6309\u65B0\u914D\u7F6E\u91CD\u8FDE\u3002") : null, state.message === "keySaved" ? /* @__PURE__ */ React.createElement("div", { className: "wc-alert success" }, "Secret \u5DF2\u4FDD\u5B58\u3002") : null, state.message === "keyCleared" ? /* @__PURE__ */ React.createElement("div", { className: "wc-alert success" }, "Secret \u5DF2\u6E05\u9664\u3002") : null, /* @__PURE__ */ React.createElement("section", { className: "wc-panel" }, /* @__PURE__ */ React.createElement("div", { className: "wc-panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "\u8FDE\u63A5"), /* @__PURE__ */ React.createElement("span", { className: `wc-badge ${snapshot.credential.configured ? "ok" : "error"}` }, snapshot.credential.configured ? "Secret \u5DF2\u914D\u7F6E" : "Secret \u7F3A\u5931")), /* @__PURE__ */ React.createElement("div", { className: "wc-form-grid" }, /* @__PURE__ */ React.createElement(Field, { label: "Bot ID", hint: "\u4F01\u5FAE\u7BA1\u7406\u540E\u53F0\u667A\u80FD\u673A\u5668\u4EBA\u9875\u9762\u63D0\u4F9B\uFF1B\u7559\u7A7A\u5219\u901A\u9053\u4F11\u7720\u3002" }, /* @__PURE__ */ React.createElement("input", { className: "wc-input", type: "text", value: draft.botId, onChange: (event) => {
    update("botId", event.target.value);
  } })), /* @__PURE__ */ React.createElement(Field, { label: "Secret", hint: snapshot.credential.source === void 0 ? `\u5B58\u50A8\u5728 DSH \u51ED\u636E ${snapshot.credential.ref} \u4E0B\uFF1B\u53EA\u5199\u4E0D\u8BFB\u3002` : `\u5B58\u50A8\u5728 DSH \u51ED\u636E ${snapshot.credential.ref} \u4E0B\uFF08\u6765\u6E90\uFF1A${snapshot.credential.source}\uFF09\u3002` }, /* @__PURE__ */ React.createElement(
    "input",
    {
      className: "wc-input",
      type: "password",
      autoComplete: "off",
      value: keyDraft,
      placeholder: snapshot.credential.configured ? "\u5DF2\u5B58\u6709 Secret\u2014\u2014\u7C98\u8D34\u65B0\u503C\u53EF\u8986\u76D6" : "\u7C98\u8D34\u4F01\u5FAE\u673A\u5668\u4EBA Secret",
      disabled: busy || !snapshot.credential.writable,
      onChange: (event) => {
        setKeyDraft(event.target.value);
      }
    }
  ))), /* @__PURE__ */ React.createElement("div", { className: "wc-save-row" }, /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: "wc-button primary",
      disabled: busy || !snapshot.credential.writable || keyDraft.trim().length === 0,
      onClick: () => {
        void controller.setKey(keyDraft).then(() => setKeyDraft(""));
      }
    },
    state.action === "set-key" ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58 Secret"
  ), snapshot.credential.configured ? /* @__PURE__ */ React.createElement(
    "button",
    {
      type: "button",
      className: "wc-button",
      disabled: busy || !snapshot.credential.writable,
      onClick: () => {
        void controller.clearKey();
      }
    },
    state.action === "clear-key" ? "\u6E05\u9664\u4E2D\u2026" : "\u6E05\u9664 Secret"
  ) : null)), /* @__PURE__ */ React.createElement("section", { className: "wc-panel" }, /* @__PURE__ */ React.createElement("div", { className: "wc-panel-title" }, /* @__PURE__ */ React.createElement("h3", null, "\u4EA4\u4E92")), /* @__PURE__ */ React.createElement("div", { className: "wc-form-grid" }, /* @__PURE__ */ React.createElement(Field, { label: "\u5361\u7247\u6A21\u5F0F\uFF08cardMode\uFF09", hint: "auto\uFF1A\u56DE\u590D\u5E26\u9009\u9879/\u786E\u8BA4\u65F6\u81EA\u52A8\u751F\u6210\u6309\u94AE\u5361\u7247\uFF1Btool\uFF1A\u4EC5\u6A21\u578B\u8C03\u7528 wecom_send_card \u65F6\u53D1\u5361\uFF1Boff\uFF1A\u5173\u95ED\u5361\u7247\u3002" }, /* @__PURE__ */ React.createElement("select", { className: "wc-input", value: draft.cardMode, onChange: (event) => {
    update("cardMode", event.target.value);
  } }, CARD_MODE_OPTIONS.map((option) => /* @__PURE__ */ React.createElement("option", { key: option.value, value: option.value }, option.label)))), /* @__PURE__ */ React.createElement(Field, { label: "\u5355\u804A\u7B56\u7565\uFF08singlePolicy\uFF09" }, /* @__PURE__ */ React.createElement("select", { className: "wc-input", value: draft.singlePolicy, onChange: (event) => {
    update("singlePolicy", event.target.value);
  } }, POLICY_OPTIONS.map((option) => /* @__PURE__ */ React.createElement("option", { key: option.value, value: option.value }, option.label)))), /* @__PURE__ */ React.createElement(Field, { label: "\u7FA4\u804A\u7B56\u7565\uFF08groupPolicy\uFF09" }, /* @__PURE__ */ React.createElement("select", { className: "wc-input", value: draft.groupPolicy, onChange: (event) => {
    update("groupPolicy", event.target.value);
  } }, POLICY_OPTIONS.map((option) => /* @__PURE__ */ React.createElement("option", { key: option.value, value: option.value }, option.label)))), /* @__PURE__ */ React.createElement(Field, { label: "\u6B22\u8FCE\u8BED\uFF08welcomeText\uFF09", hint: "\u7528\u6237\u5F53\u5929\u9996\u6B21\u8FDB\u5165\u5355\u804A\u4F1A\u8BDD\u65F6\u53D1\u9001\uFF1B\u7559\u7A7A\u4E0D\u53D1\u9001\u3002" }, /* @__PURE__ */ React.createElement("input", { className: "wc-input", type: "text", value: draft.welcomeText, onChange: (event) => {
    update("welcomeText", event.target.value);
  } })))), /* @__PURE__ */ React.createElement("div", { className: "wc-save-row" }, /* @__PURE__ */ React.createElement("button", { type: "button", className: "wc-button primary", disabled: !snapshot.writable || busy, onClick: () => {
    void controller.save(draft, snapshot.settings.revision);
  } }, state.action === "save" ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58\u5E76\u5E94\u7528"), /* @__PURE__ */ React.createElement("button", { type: "button", className: "wc-button", disabled: busy, onClick: () => {
    void controller.load();
  } }, "\u91CD\u65B0\u52A0\u8F7D")), /* @__PURE__ */ React.createElement("section", { className: "wc-panel" }, /* @__PURE__ */ React.createElement("div", { className: "wc-panel-title" }, /* @__PURE__ */ React.createElement("div", null, /* @__PURE__ */ React.createElement("h3", null, "\u4F01\u5FAE\u5185\u81EA\u68C0"), /* @__PURE__ */ React.createElement("p", null, "\u8FDE\u63A5\u6210\u529F\u540E\uFF0C\u5728\u4F01\u5FAE\u4E2D\u5411\u673A\u5668\u4EBA\u53D1\u9001\u4EE5\u4E0B\u547D\u4EE4\u5373\u53EF\u9A8C\u8BC1\u6574\u6761\u94FE\u8DEF\u3002"))), /* @__PURE__ */ React.createElement("ul", { className: "wc-checklist" }, /* @__PURE__ */ React.createElement("li", null, /* @__PURE__ */ React.createElement("code", null, "/bot-ping"), " \u2014 \u8FDE\u901A\u6027\u68C0\u67E5"), /* @__PURE__ */ React.createElement("li", null, /* @__PURE__ */ React.createElement("code", null, "/bot-card-test"), " \u2014 \u6A21\u677F\u5361\u7247\u4E0E\u6309\u94AE\u4EA4\u4E92\u68C0\u67E5"), /* @__PURE__ */ React.createElement("li", null, /* @__PURE__ */ React.createElement("code", null, "/bot-image-test"), " \u2014 \u56FE\u7247\u56DE\u590D\u68C0\u67E5"), /* @__PURE__ */ React.createElement("li", null, /* @__PURE__ */ React.createElement("code", null, "/bot-file-test"), " \u2014 \u6587\u4EF6\u53D1\u9001\u68C0\u67E5"), /* @__PURE__ */ React.createElement("li", null, /* @__PURE__ */ React.createElement("code", null, "/help"), " \u2014 \u67E5\u770B\u5168\u90E8\u547D\u4EE4"))));
}
var CSS = `
.wc-settings{display:grid;gap:14px;max-width:900px;padding:8px 2px 32px;color:var(--dsw-alias-fg-primary,#26231f)}
.wc-settings-header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding:8px 2px}
.wc-settings-header h2{font-size:25px;letter-spacing:-.025em;margin:3px 0 6px}
.wc-settings-header p{max-width:620px;margin:0;color:var(--dsw-alias-fg-muted,#77736d);font-size:13px;line-height:1.55}
.wc-kicker{font-size:10px;text-transform:uppercase;letter-spacing:.1em;color:#6758d4;font-weight:700}
.wc-release{display:grid;gap:4px;min-width:190px;padding:9px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);font-size:10px;color:var(--dsw-alias-fg-muted,#77736d)}
.wc-release span{display:flex;justify-content:space-between;gap:12px}
.wc-release strong{color:var(--dsw-alias-fg-primary,#26231f)}
.wc-alert{padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.5}
.wc-alert.warning{background:rgba(224,162,55,.12);color:#986818}
.wc-alert.error{background:rgba(205,72,72,.1);color:#aa3939}
.wc-alert.success{background:rgba(48,154,100,.1);color:#267d52}
.wc-panel{display:grid;gap:12px;padding:15px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 1px rgba(0,0,0,.02)}
.wc-panel-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.wc-panel-title h3{font-size:14px;margin:0}
.wc-panel-title p{font-size:11px;line-height:1.45;color:var(--dsw-alias-fg-muted,#77736d);margin:4px 0 0;max-width:620px}
.wc-badge{font-size:10px;padding:3px 7px;border-radius:999px;font-weight:650}
.wc-badge.ok{background:rgba(48,154,100,.12);color:#267d52}
.wc-badge.error{background:rgba(205,72,72,.1);color:#aa3939}
.wc-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.wc-field{display:grid;gap:6px;align-content:start}
.wc-field>span{font-size:11px;font-weight:600;color:var(--dsw-alias-fg-muted,#77736d)}
.wc-field small{font-size:10px;line-height:1.4;color:var(--dsw-alias-fg-muted,#99958e)}
.wc-input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px}
.wc-input:focus-visible{outline:2px solid #7c6ff0;outline-offset:-1px}
.wc-save-row{display:flex;gap:8px;align-items:center}
.wc-button{display:inline-flex;align-items:center;height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.wc-button:disabled{opacity:.55;cursor:not-allowed}
.wc-button.primary{background:#6758d4;border-color:#6758d4;color:#fff}
.wc-loading{padding:24px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);font-size:12px;color:var(--dsw-alias-fg-muted,#77736d)}
.wc-checklist{display:grid;gap:6px;margin:0;padding:0;list-style:none;font-size:12px;color:var(--dsw-alias-fg-muted,#77736d)}
.wc-checklist code{background:var(--dsw-alias-bg-layer-2,#f7f5f1);padding:1px 6px;border-radius:6px;font-size:11px}
@media(max-width:720px){.wc-settings-header{display:grid}.wc-release{width:auto}.wc-form-grid{grid-template-columns:1fr}.wc-panel-title{flex-direction:column}}
`;
function installStyles() {
  const id = "deepseek-harness-wecom-plus/client";
  const existing = document.querySelector(`style[data-plugin-css="${id}"]`);
  if (existing !== null) return () => {
  };
  const style = document.createElement("style");
  style.dataset.plugin = "deepseek-harness-wecom-plus";
  style.dataset.pluginCss = id;
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => {
    style.remove();
  };
}
var inject = ["slots"];
function apply(ctx) {
  ctx.effect(installStyles, "deepseek-harness-wecom-plus: styles");
  const controller = new WeComSettingsController();
  ctx.effect(() => {
    const dispose = ctx.on("connection/reset", () => {
      controller.refreshIfLoaded();
    });
    return () => {
      dispose();
    };
  }, "deepseek-harness-wecom-plus: Settings invalidations");
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "deepseek-harness-wecom-plus",
    order: 50,
    label: () => "WeCom \u4F01\u5FAE",
    inject: () => ({ controller })
  }, SettingsSection));
}
return module.exports; } });
//# sourceMappingURL=client.js.map
