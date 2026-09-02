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
var import_jsx_runtime = require("react/jsx-runtime");
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
  /** Run one CLI action against the backend; returns the action payload. */
  async cliAction(action) {
    return apiRequest({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    });
  }
};
function Field({ label, hint, children }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "wc-field", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: label }),
    children,
    hint === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { children: hint })
  ] });
}
var SectionErrorBoundary = class extends import_react.Component {
  state = { error: void 0 };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error !== void 0) {
      const message = this.state.error?.message || String(this.state.error);
      return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-settings", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-alert error", children: [
        "\u9875\u9762\u6E32\u67D3\u51FA\u9519\uFF08\u8BF7\u628A\u8FD9\u6BB5\u6587\u5B57\u548C\u6D4F\u89C8\u5668\u63A7\u5236\u53F0\u62A5\u9519\u4E00\u8D77\u53CD\u9988\uFF09\uFF1A",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { style: { whiteSpace: "pre-wrap", margin: "8px 0 0" }, children: message }),
        this.state.error?.stack !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { style: { whiteSpace: "pre-wrap", margin: "8px 0 0" }, children: this.state.error.stack }) : null
      ] }) });
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
  { value: "tool", label: "tool\uFF08\u4EC5\u6A21\u578B\u663E\u5F0F\u53D1\u5361\uFF0C\u9ED8\u8BA4\uFF09" },
  { value: "off", label: "off\uFF08\u5173\u95ED\u5361\u7247\uFF09" }
];
function SettingsSection(props) {
  const { controller } = props;
  if (controller === void 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-settings", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-alert error", children: "\u5185\u90E8\u9519\u8BEF\uFF1A\u63A7\u5236\u5668\u672A\u6CE8\u5165\uFF08controller is undefined\uFF09\u3002\u8BF7\u6309 F12 \u6253\u5F00\u6D4F\u89C8\u5668\u63A7\u5236\u53F0\uFF0C\u628A\u7EA2\u8272\u62A5\u9519\u622A\u56FE\u6216\u590D\u5236\u7ED9\u6211\u3002" }) });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(SectionErrorBoundary, { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(LoadedSettings, { controller }) });
}
function CliCard({ controller, initial }) {
  const [cli, setCli] = (0, import_react.useState)(initial);
  const [busy, setBusy] = (0, import_react.useState)(void 0);
  const [installOutput, setInstallOutput] = (0, import_react.useState)("");
  const [error, setError] = (0, import_react.useState)(void 0);
  const [qr, setQr] = (0, import_react.useState)(void 0);
  const [authSuccess, setAuthSuccess] = (0, import_react.useState)(false);
  const probe = async () => {
    setBusy("probe");
    setError(void 0);
    try {
      setCli(await controller.cliAction("cli-probe"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(void 0);
    }
  };
  const install = async () => {
    setBusy("install");
    setError(void 0);
    setInstallOutput("");
    try {
      const result = await controller.cliAction("cli-install");
      setInstallOutput(result.outcome === "failed" ? result.output : "");
      setCli(result.probe);
      if (result.outcome === "failed") setError("\u5B89\u88C5\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B\u4E0B\u65B9\u8F93\u51FA\uFF0C\u6216\u590D\u5236\u547D\u4EE4\u624B\u52A8\u5B89\u88C5\u3002");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(void 0);
    }
  };
  const authorize = async () => {
    setBusy("auth");
    setError(void 0);
    try {
      const result = await controller.cliAction("cli-authorize");
      if (result.outcome === "started" && result.qrDataUrl !== void 0) setQr(result.qrDataUrl);
      else setError(result.outcome === "in-progress" ? "\u5DF2\u6709\u6388\u6743\u6D41\u7A0B\u5728\u8FDB\u884C\u4E2D\u3002" : "\u672A\u80FD\u53D6\u5F97\u6388\u6743\u94FE\u63A5\uFF0C\u8BF7\u91CD\u8BD5\u3002");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(void 0);
    }
  };
  const cancelAuth = async () => {
    setQr(void 0);
    try {
      await controller.cliAction("cli-cancel-auth");
    } catch {
    }
  };
  (0, import_react.useEffect)(() => {
    if (qr === void 0) return;
    const timer = setInterval(async () => {
      try {
        const status = await controller.cliAction("cli-auth-status");
        if (status.auth === "authorized") {
          setQr(void 0);
          setAuthSuccess(true);
          setCli((current) => current === void 0 ? current : { ...current, auth: "authorized" });
        } else if (!status.waiting) {
          setQr(void 0);
          setError("\u6388\u6743\u6D41\u7A0B\u5DF2\u4E2D\u65AD\uFF08\u4E8C\u7EF4\u7801\u53EF\u80FD\u5DF2\u8FC7\u671F\uFF09\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u6388\u6743\u3002");
        }
      } catch {
      }
    }, 2e3);
    return () => {
      clearInterval(timer);
    };
  }, [qr, controller]);
  const dotClass = cli === void 0 ? "" : !cli.installed || !cli.meetsMin || cli.auth !== "authorized" ? "warn" : "ok";
  const statusText = cli === void 0 ? "\u672A\u68C0\u6D4B" : !cli.installed ? "\u672A\u5B89\u88C5" : !cli.meetsMin ? `\u7248\u672C\u8FC7\u4F4E \xB7 v${cli.version}\uFF08\u9700 \u22651.1.0\uFF09` : cli.auth === "authorized" ? `\u5DF2\u6388\u6743 \xB7 v${cli.version}` : `\u5DF2\u5B89\u88C5 \xB7 v${cli.version} \xB7 \u5F85\u6388\u6743`;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "wc-panel", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-panel-title", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "CLI \u96C6\u6210" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "\u68C0\u6D4B\u4F01\u4E1A\u5FAE\u4FE1\u5B98\u65B9\u547D\u4EE4\u884C\u5DE5\u5177\uFF08wecom-cli\uFF09\u7684\u5B89\u88C5\u4E0E\u6388\u6743\u72B6\u6001\u3002\u5B89\u88C5\u5E76\u6388\u6743\u540E\uFF0C\u540E\u7EED\u7248\u672C\u7684\u63D2\u4EF6\u53EF\u8BA9 AI \u76F4\u63A5\u64CD\u4F5C\u4F01\u5FAE\u7684\u6587\u6863\u3001\u65E5\u7A0B\u3001\u5F85\u529E\u7B49\u3002" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "wc-button", disabled: busy !== void 0, onClick: () => {
        void probe();
      }, children: busy === "probe" ? "\u68C0\u6D4B\u4E2D\u2026" : "\u91CD\u65B0\u68C0\u6D4B" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-cli-status", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `wc-cli-dot ${dotClass}` }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: statusText })
    ] }),
    error === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-alert error", children: error }),
    cli !== void 0 && (!cli.installed || !cli.meetsMin) ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-cli-actions", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "wc-button primary", disabled: busy !== void 0, onClick: () => {
        void install();
      }, children: busy === "install" ? "\u5B89\u88C5\u4E2D\u2026" : "\u4E00\u952E\u5B89\u88C5 / \u5347\u7EA7" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "npm install -g @wecom/cli" })
    ] }) : null,
    installOutput === "" ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("pre", { className: "wc-cli-output", children: installOutput }),
    cli !== void 0 && cli.installed && cli.meetsMin && cli.auth !== "authorized" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-cli-actions", children: qr === void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "wc-button primary", disabled: busy !== void 0, onClick: () => {
      void authorize();
    }, children: busy === "auth" ? "\u51C6\u5907\u4E2D\u2026" : "\u53D1\u8D77\u6388\u6743" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-cli-qr", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("img", { src: qr, alt: "wecom-cli \u6388\u6743\u4E8C\u7EF4\u7801", width: 160, height: 160 }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-cli-qr-steps", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "wc-cli-waiting", children: "\u7B49\u5F85\u626B\u7801\u6388\u6743\u2026" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("ol", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: "\u7528\u624B\u673A\u4F01\u4E1A\u5FAE\u4FE1\u626B\u63CF\u5DE6\u4FA7\u4E8C\u7EF4\u7801" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: "\u5728\u624B\u673A\u4E0A\u786E\u8BA4\u6388\u6743" }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("li", { children: "\u5B8C\u6210\u540E\u672C\u9875\u81EA\u52A8\u66F4\u65B0\u4E3A\u300C\u5DF2\u6388\u6743\u300D" })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { children: "CLI \u5C06\u4EE5\u6388\u6743\u771F\u4EBA\u8EAB\u4EFD\u64CD\u4F5C\u4F01\u4E1A\u5FAE\u4FE1\uFF1B\u6388\u6743\u8FC7\u7A0B\u5168\u90E8\u5728\u672C\u9875\u5B8C\u6210\uFF0C\u65E0\u9700\u6253\u5F00\u6D4F\u89C8\u5668\u3002" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "wc-button", onClick: () => {
          void cancelAuth();
        }, children: "\u53D6\u6D88\u6388\u6743" })
      ] })
    ] }) }) : null,
    cli !== void 0 && cli.installed && cli.meetsMin && cli.auth === "authorized" && authSuccess ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-alert success", children: "\u6388\u6743\u6210\u529F\uFF0Cwecom-cli \u5DF2\u5C31\u7EEA\u3002" }) : null
  ] });
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
    return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-settings", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-loading", children: "\u52A0\u8F7D\u4E2D\u2026" }) });
  }
  if (snapshot === void 0 || draft === void 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-settings", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-alert error", children: state.error ?? "\u52A0\u8F7D\u5931\u8D25" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "wc-button", onClick: () => {
        void controller.load();
      }, children: "\u91CD\u8BD5" })
    ] });
  }
  const update = (key, value) => setDraft((current) => current === void 0 ? current : { ...current, [key]: value });
  const busy = state.action !== void 0;
  const channel = snapshot.channel;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-settings", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { className: "wc-settings-header", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "wc-kicker", children: "deepseek-harness-wecom-plus" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { children: "\u4F01\u5FAE\u673A\u5668\u4EBA" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "\u628A\u4F01\u4E1A\u5FAE\u4FE1\u667A\u80FD\u673A\u5668\u4EBA\u901A\u8FC7\u5B98\u65B9\u957F\u8FDE\u63A5\u63A5\u5165 DeepSeek Harness\u3002Bot ID \u4E0E Secret \u6765\u81EA\u4F01\u5FAE\u7BA1\u7406\u540E\u53F0\u300C\u667A\u80FD\u673A\u5668\u4EBA\u300D\u9875\u9762\uFF1B\u4FDD\u5B58\u540E\u901A\u9053\u4F1A\u7ACB\u5373\u91CD\u8FDE\uFF0C\u65E0\u9700\u91CD\u542F DSH\u3002" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-release", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
          "\u63D2\u4EF6\u7248\u672C ",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: snapshot.release.pluginVersion })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: [
          "\u8FDE\u63A5\u72B6\u6001 ",
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: CHANNEL_LABEL[channel.state] })
        ] })
      ] })
    ] }),
    !snapshot.writable ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-alert warning", children: "\u5F53\u524D Settings \u63D0\u4F9B\u65B9\u4E3A\u53EA\u8BFB\uFF0C\u65E0\u6CD5\u5728\u754C\u9762\u4FDD\u5B58\u3002" }) : null,
    channel.state === "inactive" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-alert warning", children: draft.botId.trim() === "" ? "\u901A\u9053\u672A\u6FC0\u6D3B\uFF1A\u8FD8\u6CA1\u6709\u586B\u5199 Bot ID\u3002\u8BF7\u5728\u4F01\u5FAE\u7BA1\u7406\u540E\u53F0\u300C\u5E94\u7528\u7BA1\u7406 \u2192 \u667A\u80FD\u673A\u5668\u4EBA\u300D\u7684\u673A\u5668\u4EBA\u8BE6\u60C5\u9875\u590D\u5236 Bot ID\uFF0C\u7C98\u8D34\u5230\u4E0A\u65B9\u8F93\u5165\u6846\u5E76\u4FDD\u5B58\u3002" : snapshot.credential.configured ? "\u901A\u9053\u672A\u6FC0\u6D3B\uFF1A\u8BF7\u786E\u8BA4 Secret \u4E0E Bot ID \u5C5E\u4E8E\u540C\u4E00\u4E2A\u673A\u5668\u4EBA\uFF0C\u5E76\u628A\u8BE5\u673A\u5668\u4EBA\u7684\u63A5\u6536\u6D88\u606F\u6A21\u5F0F\u8BBE\u4E3A\u300C\u957F\u8FDE\u63A5\u6D41\u5F0F\u63A5\u6536\u300D\u3002" : "\u901A\u9053\u672A\u6FC0\u6D3B\uFF1A\u8FD8\u6CA1\u6709\u4FDD\u5B58 Secret\u3002\u8BF7\u628A\u673A\u5668\u4EBA Secret \u7C98\u8D34\u5230\u51ED\u636E\u6846\u5E76\u70B9\u51FB\u300C\u4FDD\u5B58 Secret\u300D\u3002" }) : null,
    channel.state !== "inactive" && channel.detail !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-alert warning", children: channel.detail }) : null,
    state.error === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-alert error", children: state.error }),
    state.message === "saved" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-alert success", children: "\u8BBE\u7F6E\u5DF2\u4FDD\u5B58\uFF0C\u901A\u9053\u5DF2\u6309\u65B0\u914D\u7F6E\u91CD\u8FDE\u3002" }) : null,
    state.message === "keySaved" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-alert success", children: "Secret \u5DF2\u4FDD\u5B58\u3002" }) : null,
    state.message === "keyCleared" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-alert success", children: "Secret \u5DF2\u6E05\u9664\u3002" }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "wc-panel", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-panel-title", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u8FDE\u63A5" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: `wc-badge ${snapshot.credential.configured ? "ok" : "error"}`, children: snapshot.credential.configured ? "Secret \u5DF2\u914D\u7F6E" : "Secret \u7F3A\u5931" })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-form-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: "Bot ID", hint: "\u4F01\u5FAE\u7BA1\u7406\u540E\u53F0\u667A\u80FD\u673A\u5668\u4EBA\u9875\u9762\u63D0\u4F9B\uFF1B\u7559\u7A7A\u5219\u901A\u9053\u4F11\u7720\u3002", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { className: "wc-input", type: "text", value: draft.botId, onChange: (event) => {
          update("botId", event.target.value);
        } }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: "Secret", hint: snapshot.credential.source === void 0 ? `\u5B58\u50A8\u5728 DSH \u51ED\u636E ${snapshot.credential.ref} \u4E0B\uFF1B\u53EA\u5199\u4E0D\u8BFB\u3002` : `\u5B58\u50A8\u5728 DSH \u51ED\u636E ${snapshot.credential.ref} \u4E0B\uFF08\u6765\u6E90\uFF1A${snapshot.credential.source}\uFF09\u3002`, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
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
        ) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-save-row", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            className: "wc-button primary",
            disabled: busy || !snapshot.credential.writable || keyDraft.trim().length === 0,
            onClick: () => {
              void controller.setKey(keyDraft).then(() => setKeyDraft(""));
            },
            children: state.action === "set-key" ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58 Secret"
          }
        ),
        snapshot.credential.configured ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            className: "wc-button",
            disabled: busy || !snapshot.credential.writable,
            onClick: () => {
              void controller.clearKey();
            },
            children: state.action === "clear-key" ? "\u6E05\u9664\u4E2D\u2026" : "\u6E05\u9664 Secret"
          }
        ) : null
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "wc-panel", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "wc-panel-title", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u4EA4\u4E92" }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-form-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: "\u5361\u7247\u6A21\u5F0F\uFF08cardMode\uFF09", hint: "tool\uFF1A\u4EC5\u6A21\u578B\u8C03\u7528 wecom_send_card \u65F6\u53D1\u5361\uFF08Markdown \u627F\u8F7D\u5168\u6587\u3001\u5361\u7247\u627F\u8F7D\u77ED\u6807\u7B7E\u4EA4\u4E92\uFF09\uFF1Boff\uFF1A\u5173\u95ED\u5361\u7247\u3002", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("select", { className: "wc-input", value: draft.cardMode, onChange: (event) => {
          update("cardMode", event.target.value);
        }, children: CARD_MODE_OPTIONS.map((option) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: option.value, children: option.label }, option.value)) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: "\u5355\u804A\u7B56\u7565\uFF08singlePolicy\uFF09", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("select", { className: "wc-input", value: draft.singlePolicy, onChange: (event) => {
          update("singlePolicy", event.target.value);
        }, children: POLICY_OPTIONS.map((option) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: option.value, children: option.label }, option.value)) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: "\u7FA4\u804A\u7B56\u7565\uFF08groupPolicy\uFF09", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("select", { className: "wc-input", value: draft.groupPolicy, onChange: (event) => {
          update("groupPolicy", event.target.value);
        }, children: POLICY_OPTIONS.map((option) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: option.value, children: option.label }, option.value)) }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Field, { label: "\u6B22\u8FCE\u8BED\uFF08welcomeText\uFF09", hint: "\u7528\u6237\u5F53\u5929\u9996\u6B21\u8FDB\u5165\u5355\u804A\u4F1A\u8BDD\u65F6\u53D1\u9001\uFF1B\u7559\u7A7A\u4E0D\u53D1\u9001\u3002", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { className: "wc-input", type: "text", value: draft.welcomeText, onChange: (event) => {
          update("welcomeText", event.target.value);
        } }) })
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(CliCard, { controller, initial: snapshot.cli }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "wc-save-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "wc-button primary", disabled: !snapshot.writable || busy, onClick: () => {
        void controller.save(draft, snapshot.settings.revision);
      }, children: state.action === "save" ? "\u4FDD\u5B58\u4E2D\u2026" : "\u4FDD\u5B58\u5E76\u5E94\u7528" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "wc-button", disabled: busy, onClick: () => {
        void controller.load();
      }, children: "\u91CD\u65B0\u52A0\u8F7D" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("details", { className: "wc-details", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("summary", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: "\u4F01\u5FAE\u5185\u81EA\u68C0" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: "\u8FDE\u63A5\u6210\u529F\u540E\uFF0C\u5728\u4F01\u5FAE\u4E2D\u5411\u673A\u5668\u4EBA\u53D1\u9001\u4EE5\u4E0B\u547D\u4EE4\u5373\u53EF\u9A8C\u8BC1\u6574\u6761\u94FE\u8DEF\u3002" })
      ] }) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("ul", { className: "wc-checklist", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "/bot-ping" }),
          " \u2014 \u8FDE\u901A\u6027\u68C0\u67E5"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "/bot-card-test" }),
          " \u2014 \u6A21\u677F\u5361\u7247\u4E0E\u6309\u94AE\u4EA4\u4E92\u68C0\u67E5"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "/bot-image-test" }),
          " \u2014 \u56FE\u7247\u56DE\u590D\u68C0\u67E5"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "/bot-file-test" }),
          " \u2014 \u6587\u4EF6\u53D1\u9001\u68C0\u67E5"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "/bot-cli" }),
          " \u2014 wecom-cli \u72B6\u6001\u68C0\u67E5\u4E0E\u5F15\u5BFC"
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("li", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: "/help" }),
          " \u2014 \u67E5\u770B\u5168\u90E8\u547D\u4EE4"
        ] })
      ] })
    ] })
  ] });
}
var CSS = `
/* Type scale: the only five font sizes allowed in this section. */
.wc-settings{--wc-fs-xs:11px;--wc-fs-sm:12px;--wc-fs-md:13px;--wc-fs-lg:14px;--wc-fs-xl:20px;display:grid;gap:14px;max-width:900px;padding:8px 2px 32px;color:var(--dsw-alias-fg-primary,#26231f);font-size:var(--wc-fs-sm);contain:content}
.wc-settings-header{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;padding:8px 2px}
.wc-settings-header h2{font-size:var(--wc-fs-xl);letter-spacing:-.02em;margin:3px 0 6px}
.wc-settings-header p{max-width:620px;margin:0;color:var(--dsw-alias-fg-muted,#77736d);font-size:var(--wc-fs-md);line-height:1.55}
.wc-kicker{font-size:var(--wc-fs-xs);text-transform:uppercase;letter-spacing:.1em;color:#6758d4;font-weight:700}
.wc-release{display:grid;gap:4px;min-width:220px;padding:9px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);font-size:var(--wc-fs-xs);color:var(--dsw-alias-fg-muted,#77736d)}
.wc-release span{display:flex;justify-content:space-between;gap:12px;white-space:nowrap}
.wc-release strong{color:var(--dsw-alias-fg-primary,#26231f);white-space:normal;word-break:break-word;text-align:right}
.wc-alert{padding:10px 12px;border-radius:10px;font-size:var(--wc-fs-sm);line-height:1.5}
.wc-alert.warning{background:rgba(224,162,55,.12);color:#986818}
.wc-alert.error{background:rgba(205,72,72,.1);color:#aa3939}
.wc-alert.success{background:rgba(48,154,100,.1);color:#267d52}
.wc-panel{display:grid;gap:12px;padding:15px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 1px rgba(0,0,0,.02)}
.wc-panel-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.wc-panel-title h3{font-size:var(--wc-fs-lg);margin:0}
.wc-panel-title p{font-size:var(--wc-fs-xs);line-height:1.45;color:var(--dsw-alias-fg-muted,#77736d);margin:4px 0 0;max-width:620px}
.wc-badge{font-size:var(--wc-fs-xs);padding:3px 8px;border-radius:999px;font-weight:600}
.wc-badge.ok{background:rgba(48,154,100,.12);color:#267d52}
.wc-badge.error{background:rgba(205,72,72,.1);color:#aa3939}
.wc-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.wc-field{display:grid;gap:6px;align-content:start}
.wc-field>span{font-size:var(--wc-fs-md);font-weight:600;color:var(--dsw-alias-fg-primary,#26231f)}
.wc-field small{font-size:var(--wc-fs-xs);line-height:1.4;color:var(--dsw-alias-fg-muted,#99958e)}
.wc-input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:var(--wc-fs-sm)}
.wc-input:focus-visible{outline:2px solid #7c6ff0;outline-offset:-1px}
.wc-save-row{display:flex;gap:8px;align-items:center}
.wc-button{display:inline-flex;align-items:center;height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:var(--wc-fs-sm);font-weight:600;cursor:pointer;white-space:nowrap}
.wc-button:disabled{opacity:.55;cursor:not-allowed}
.wc-button.primary{background:#6758d4;border-color:#6758d4;color:#fff}
.wc-loading{padding:24px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#f7f5f1);font-size:var(--wc-fs-sm);color:var(--dsw-alias-fg-muted,#77736d)}
.wc-checklist{display:grid;gap:6px;margin:0;padding:0 0 0 2px;list-style:none;font-size:var(--wc-fs-sm);color:var(--dsw-alias-fg-muted,#77736d)}
.wc-checklist code{background:var(--dsw-alias-bg-layer-2,#f7f5f1);padding:1px 6px;border-radius:6px;font-size:var(--wc-fs-xs)}
@media(max-width:720px){.wc-settings-header{display:grid}.wc-release{width:auto;min-width:0}.wc-form-grid{grid-template-columns:1fr}.wc-panel-title{flex-direction:column}.wc-release span{white-space:normal;flex-wrap:wrap}}
.wc-details{display:grid;gap:10px;padding:13px 15px;border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);content-visibility:auto;contain-intrinsic-size:auto 120px}
.wc-details summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:2px 4px;margin:-2px -4px;border-radius:8px;transition:background .15s}
.wc-details summary:hover{background:rgba(0,0,0,.035)}
.wc-details summary:focus-visible{outline:2px solid #7c6ff0;outline-offset:0}
.wc-details summary::-webkit-details-marker{display:none}
.wc-details summary::after{content:'';flex:none;width:7px;height:7px;margin-top:5px;border-right:2px solid #b9b5ae;border-bottom:2px solid #b9b5ae;transform:rotate(-45deg);transition:transform .15s}
.wc-details[open] summary::after{transform:rotate(45deg)}
.wc-details summary h3{font-size:var(--wc-fs-lg);margin:0}
.wc-details summary p{font-size:var(--wc-fs-xs);line-height:1.45;color:var(--dsw-alias-fg-muted,#77736d);margin:4px 0 0;max-width:620px}
.wc-details[open] summary{margin-bottom:4px}
.wc-cli-status{display:flex;align-items:center;gap:9px;font-size:var(--wc-fs-md)}
.wc-cli-dot{width:9px;height:9px;border-radius:999px;background:#b9b5ae;flex:none}
.wc-cli-dot.ok{background:#309a64}
.wc-cli-dot.warn{background:#e0a237}
.wc-cli-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.wc-cli-actions code{background:var(--dsw-alias-bg-layer-2,#f7f5f1);padding:3px 8px;border-radius:7px;font-size:var(--wc-fs-xs)}
.wc-cli-qr{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.wc-cli-qr img{border:1px solid var(--dsw-alias-border-subtle,#dedbd5);border-radius:10px;background:#fff;flex:none}
.wc-cli-qr-steps{display:grid;gap:7px;justify-items:start;font-size:var(--wc-fs-xs);color:var(--dsw-alias-fg-muted,#77736d);max-width:340px;line-height:1.5}
.wc-cli-qr-steps ol{margin:0;padding-left:18px;display:grid;gap:2px}
.wc-cli-qr-steps small{color:var(--dsw-alias-fg-muted,#99958e)}
.wc-cli-waiting{display:flex;align-items:center;gap:7px;font-size:var(--wc-fs-md);font-weight:600;color:var(--dsw-alias-fg-primary,#26231f)}
.wc-cli-waiting::before{content:'';width:8px;height:8px;border-radius:999px;background:#e0a237;animation:wc-pulse 1.2s ease-in-out infinite}
@keyframes wc-pulse{0%,100%{opacity:.3}50%{opacity:1}}
.wc-cli-output{margin:0;font-family:ui-monospace,monospace;font-size:var(--wc-fs-xs);line-height:1.5;background:var(--dsw-alias-bg-layer-2,#f7f5f1);border-radius:9px;padding:9px 11px;white-space:pre-wrap;max-height:130px;overflow:auto}
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
    label: () => "\u4F01\u5FAE\u63D2\u4EF6",
    inject: () => ({ controller })
  }, SettingsSection));
}
return module.exports; } });
//# sourceMappingURL=client.js.map
