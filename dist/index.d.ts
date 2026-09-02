import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { BaseMessage, WSClientOptions, WsFrame, EventMessageWith, EnterChatEvent, TemplateCardEventData, WsFrameHeaders, ReplyMsgItem, TemplateCard, UploadMediaOptions, WeComMediaType } from '@wecom/aibot-node-sdk';
import { EventEmitter } from 'node:events';
import { ImageMediaType } from '@deepseek-ai/dsh-attachment';
import { ContentBlock } from '@deepseek-ai/dsh-llm';
import { IncomingMessage, ServerResponse } from 'node:http';
import { SettingsNamespace } from '@deepseek-ai/dsh-settings';

/**
 * WeComCliService: the only module allowed to spawn wecom-cli processes.
 * Probe/install/authorize live here so both the Settings backend and the
 * /bot-cli command share one set of timeouts and one auth-process singleton.
 * The spawn function and the QR renderer are injectable for tests.
 * @module deepseek-harness-wecom-plus/cli
 */

interface CliProbeResult {
    installed: boolean;
    version?: string;
    meetsMin: boolean;
    auth: 'authorized' | 'unauthorized' | 'unknown';
}
interface CliInstallResult {
    outcome: 'already-installed' | 'installed' | 'failed';
    /** Tail of the installer output for the Settings page to display. */
    output: string;
    probe: CliProbeResult;
}
interface CliAuthStart {
    outcome: 'started' | 'in-progress' | 'cli-missing' | 'no-url';
    authUrl?: string;
    qrDataUrl?: string;
}
interface CliAuthStatus {
    auth: CliProbeResult['auth'];
    waiting: boolean;
}
/** The subset of ChildProcess behaviour WeComCliService relies on. */
interface CliChild extends EventEmitter {
    stdout: EventEmitter | null;
    stderr: EventEmitter | null;
    kill(): boolean;
    pid?: number | undefined;
}
type CliSpawn = (command: string, args: string[]) => CliChild;
type CliQrRenderer = (text: string) => Promise<string>;
type CliQrFileReader = (path: string) => Promise<string | undefined>;
declare class WeComCliService {
    private readonly spawnFn;
    private readonly platform;
    private readonly qrFileFn;
    private authProcess;
    /** Synchronous mutex covering the async probe window inside beginAuth. */
    private authBusy;
    private readonly qrFn;
    constructor(spawnFn?: CliSpawn, qrFn?: CliQrRenderer, platform?: NodeJS.Platform, qrFileFn?: CliQrFileReader);
    /** Kill any pending authorization process; safe to call at any time. */
    dispose(): void;
    /**
     * One process run with a hard timeout. A spawn failure (binary missing)
     * resolves with code null and empty output instead of rejecting.
     */
    private run;
    probe(): Promise<CliProbeResult>;
    install(): Promise<CliInstallResult>;
    /**
     * Spawn `auth init` and surface the scan QR inside the Settings page.
     * The stdout URL is only a login PAGE that itself renders the real QR —
     * QR-encoding it just opens that page inside WeCom's webview where it
     * cannot be scanned. Preferred path is therefore `--output-qrcode`: the
     * CLI writes the actual scannable QR as a PNG we embed directly.
     * `--no-browser` stops the CLI from opening that login page itself; CLIs
     * too old to know the flag fall back to the URL mode, then bare.
     * Only one authorization may run at a time.
     */
    beginAuth(): Promise<CliAuthStart>;
    private attemptAuth;
    /** Best-effort removal of a leftover QR PNG (cancel paths, unreadable file). */
    private cleanupQrFile;
    cancelAuth(): void;
    authStatus(): Promise<CliAuthStatus>;
}

/** Access policy for one WeCom chat scope. */
type AccessMode = 'open' | 'allowlist' | 'disabled';
/** How inbound WeCom images are presented to the selected Harness model. */
type ImageInputMode = 'auto' | 'always' | 'never';
/**
 * How template cards accompany model replies.
 * - "tool" (default): cards are sent only when the model calls
 *   `wecom_send_card`. The Markdown message keeps the full content, the card
 *   carries only the short-label interaction surface — deriving cards from
 *   reply text was removed because protocol caps force truncated labels.
 * - "off": no cards; `wecom_send_card` fails with a teaching error.
 * - "auto": deprecated alias of "tool"; accepted so existing configurations
 *   keep loading, but no adaptive derivation happens anymore.
 */
type CardMode = 'auto' | 'tool' | 'off';
/** WeCom AI Bot channel configuration. */
interface Config {
    botId: string;
    secretRef: string;
    accountId: string;
    cwd: string;
    agentPreset?: string;
    websocketUrl: string;
    scene: number;
    singlePolicy: AccessMode;
    singleAllowFrom: string[];
    groupPolicy: AccessMode;
    groupAllowFrom: string[];
    allowedHarnessCommands: string[];
    imageInputMode: ImageInputMode;
    cardMode: CardMode;
    cardTaskIdPrefix: string;
    cardClickAckTitle: string;
    cardClickAckSubtitle: string;
    questionTimeoutMs: number;
    inboundFileDirectory: string;
    welcomeText: string;
    startupTimeoutMs: number;
    /** Turn inactivity limit: cancel only after this long with no session events. */
    responseTimeoutMs: number;
    /** Streaming-bubble heartbeat interval; 0 disables the heartbeat. */
    streamHeartbeatMs: number;
    mediaDownloadTimeoutMs: number;
    sendTimeoutMs: number;
    reconnectIntervalMs: number;
    maxReconnectAttempts: number;
    maxAuthFailureAttempts: number;
    sendRetries: number;
    maxReplyBytes: number;
    maxSeenMessageIds: number;
    maxInboundFileBytes: number;
    maxOutboundFileBytes: number;
    systemPrompt: string;
}
/** Runtime-validated plugin configuration. */
declare const Config: z<Config>;

/** Minimal official-SDK media download surface used by inbound conversion. */
interface WeComDownloadPort {
    downloadFile(url: string, aesKey?: string): Promise<{
        buffer: Buffer;
        filename?: string;
    }>;
}
/** Build durable DSH content blocks from one WeCom message. */
declare function inboundContent(ctx: Context, config: Config, client: WeComDownloadPort, message: BaseMessage, includeImages?: boolean): Promise<ContentBlock[]>;
/** Detect the image formats accepted by Harness attachments from magic bytes. */
declare function detectImageMediaType(data: Uint8Array): ImageMediaType;

interface WeComClientPort extends WeComDownloadPort {
    readonly isConnected: boolean;
    on(event: 'connected' | 'authenticated', handler: () => void): this;
    on(event: 'disconnected', handler: (reason: string) => void): this;
    on(event: 'reconnecting', handler: (attempt: number) => void): this;
    on(event: 'error', handler: (error: Error) => void): this;
    on(event: 'message', handler: (frame: WsFrame<BaseMessage>) => void | Promise<void>): this;
    on(event: 'event.enter_chat', handler: (frame: WsFrame<EventMessageWith<EnterChatEvent>>) => void | Promise<void>): this;
    on(event: 'event.template_card_event', handler: (frame: WsFrame<EventMessageWith<TemplateCardEventData>>) => void | Promise<void>): this;
    on(event: 'event.disconnected_event', handler: () => void): this;
    connect(): this;
    disconnect(): void;
    replyStream(frame: WsFrameHeaders, streamId: string, content: string, finish?: boolean, msgItem?: ReplyMsgItem[]): Promise<unknown>;
    replyWelcome(frame: WsFrameHeaders, body: {
        msgtype: 'text';
        text: {
            content: string;
        };
    }): Promise<unknown>;
    replyStreamWithCard(frame: WsFrameHeaders, streamId: string, content: string, finish: boolean, options: {
        templateCard: TemplateCard;
    }): Promise<unknown>;
    updateTemplateCard(frame: WsFrameHeaders, templateCard: TemplateCard, userids?: string[]): Promise<unknown>;
    sendMessage(chatid: string, body: {
        msgtype: 'markdown';
        markdown: {
            content: string;
        };
    } | {
        msgtype: 'template_card';
        template_card: TemplateCard;
    }): Promise<unknown>;
    uploadMedia(fileBuffer: Buffer, options: UploadMediaOptions): Promise<{
        media_id: string;
    }>;
    sendMediaMessage(chatid: string, mediaType: WeComMediaType, mediaId: string): Promise<unknown>;
}
type WeComClientFactory = (options: WSClientOptions) => WeComClientPort;
/** Live WeCom WebSocket ↔ DeepSeek Harness bridge. */
declare class WeComHarnessBridge {
    private readonly ctx;
    private readonly config;
    private readonly clientFactory;
    private readonly cli?;
    private readonly log;
    private readonly conversations;
    private readonly seen;
    private readonly allowedHarnessCommands;
    private client;
    private stopping;
    private lastError;
    /** Task ids whose click was already processed; re-clicks are dropped. */
    private readonly consumedCardTasks;
    constructor(ctx: Context, config: Config, clientFactory?: WeComClientFactory, cli?: WeComCliService | undefined);
    /** Latest channel fact for configuration surfaces. */
    status(): {
        state: 'inactive' | 'connecting' | 'connected';
        detail?: string;
    };
    /** Stay dormant without credentials, or authenticate and wait for WeCom readiness. */
    start(): Promise<void>;
    /** Stop ingress and drain owned conversations. */
    stop(): Promise<void>;
    private createClient;
    private handleWelcome;
    /**
     * One template card button click: acknowledge the click locally inside the
     * protocol's 5-second update window, then hand the click to the conversation
     * as a user message and push the model's reply proactively.
     */
    private handleCardEvent;
    private handleCardEventInner;
    /**
     * Update the clicked card in place within the protocol's 5-second window,
     * trying the best shape first: same-type (options preserved) → text_notice
     * without a jump → the known-good text_notice with a neutral link. Every
     * platform rejection is logged with its errcode so constraints are visible.
     * userids is deliberately omitted so the replacement reaches every view of
     * the card, not only the clicker's.
     */
    private acknowledgeCardClick;
    /** Bound the consumed-task memory; oldest entries are evicted first. */
    private rememberConsumedTask;
    private handleMessage;
    private helpText;
    /** Human guidance for the three CLI states; probing errors stay soft. */
    private cliStatusText;
    private commandReply;
    private allowed;
    /** Access policy check for an event frame (its chattype is optional). */
    private allowedEvent;
    private allowedScope;
    /**
     * Live streaming transport for message-initiated turns. The model's text
     * deltas flow through throttled `replyStream` frames (200ms), a transient
     * activity line shows tool executions, and finish() sends the final frame
     * with inline images, then media uploads and queued cards.
     */
    private beginMessageTransport;
    /**
     * Buffering transport for card-click turns: the protocol gives event frames
     * no stream channel, so the model's text accumulates and one Markdown
     * message (plus media and cards) goes out at finish.
     */
    private beginProactiveTransport;
    private sendReply;
    /**
     * Proactive outbound path for turns without a respondable frame (template
     * card button clicks): one Markdown message, media uploads, then cards.
     */
    private sendProactive;
    /** Deliver queued template cards as follow-up messages; failures only log, never retract the reply. */
    private sendCards;
    private sendLocalFile;
    private sendMedia;
    private retry;
    private requireClient;
}

/** Deterministic, non-identifying DSH session id for one WeCom conversation. */
declare function sessionIdFor(accountId: string, message: {
    chattype?: 'single' | 'group';
    chatid?: string;
    from: {
        userid: string;
    };
}): string;
/** Target id accepted by WeCom proactive-send APIs. */
declare function chatTarget(message: {
    chattype?: 'single' | 'group';
    chatid?: string;
    from: {
        userid: string;
    };
}): string;
/** Bound UTF-8 text to a WeCom byte limit without splitting a code point. */
declare function truncateUtf8(text: string, maxBytes: number, suffix?: string): string;
/** Bounded insertion-ordered duplicate detector. */
declare class SeenMessageIds {
    private readonly limit;
    private readonly ids;
    constructor(limit: number);
    /** Return true for a duplicate; record a new id otherwise. */
    hasOrAdd(id: string): boolean;
}

/**
 * Optional Web-profile Settings route for the WeCom channel: the browser
 * Settings page reads a snapshot and saves the UI-editable subset through the
 * same-origin JSON endpoint below. Stored credential values never travel back
 * to the browser; a pasted Secret goes one way — through `set-key` into the
 * DSH credentials seam, the same write path first-party pages use. Saving the
 * settings section restarts the channel live through the owning plugin's
 * settings wiring.
 * @module deepseek-harness-wecom-plus/settings-web
 */

/** Exact route used by the browser Settings page. */
declare const SETTINGS_ROUTE = "/_dsh/deepseek-harness-wecom-plus/settings";
/** The settings namespace this plugin owns. */
declare const SETTINGS_NS: SettingsNamespace;
/** Channel connection facts the Settings page surfaces (no credentials, ever). */
interface WeComChannelStatus {
    state: 'inactive' | 'connecting' | 'connected';
    detail?: string;
}
/** UI-editable subset of the full channel configuration. */
interface WeComUserSettings {
    botId: string;
    cardMode: Config['cardMode'];
    singlePolicy: Config['singlePolicy'];
    groupPolicy: Config['groupPolicy'];
    welcomeText: string;
}
/** Public Settings snapshot; credential values are deliberately impossible here. */
interface WeComSettingsSnapshot {
    schemaVersion: 1;
    writable: boolean;
    settings: {
        value: WeComUserSettings;
        revision: number;
        applies: 'live';
    };
    credential: {
        ref: string;
        configured: boolean;
        source?: string;
        writable: boolean;
    };
    channel: WeComChannelStatus;
    cli?: CliProbeResult;
    release: {
        pluginVersion: string;
    };
}
interface SaveRequest {
    action: 'save';
    expectedRevision: number;
    value: WeComUserSettings;
}
interface SetKeyRequest {
    action: 'set-key';
    value: string;
}
interface ClearKeyRequest {
    action: 'clear-key';
}
declare const CLI_ACTIONS: readonly ["cli-probe", "cli-install", "cli-authorize", "cli-auth-status", "cli-cancel-auth"];
type CliActionName = typeof CLI_ACTIONS[number];
interface CliActionRequest {
    action: CliActionName;
}
type SettingsRequest = SaveRequest | SetKeyRequest | ClearKeyRequest | CliActionRequest;
/** Validate and parse one POST body; throws TypeError on a malformed request. */
declare function parseRequest(value: unknown): SettingsRequest;
/** Same-origin Settings handler for the WeCom channel. */
declare class WeComWebBackend {
    private readonly ctx;
    private readonly status;
    private readonly cli?;
    private cliProbeCache;
    constructor(ctx: Context, status: () => WeComChannelStatus, cli?: WeComCliService | undefined);
    private credential;
    /** Build the current settings/credential/channel snapshot without secrets. */
    snapshot(): Promise<WeComSettingsSnapshot>;
    /** Probe with a tiny cache: GET snapshots may arrive in bursts. */
    private cliSnapshot;
    private handleCli;
    /** Merge the UI-editable subset into the namespace's user layer. */
    private save;
    /**
     * Store one pasted Secret under the configured credential reference. The
     * credentials seam enforces writability and never lets the value back out.
     */
    private setKey;
    /** Remove the stored Secret; an absent credential is a no-op. */
    private clearKey;
    /** Handle the exact Settings route. */
    handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

/** WeCom AI Bot channel bundle for DeepSeek Harness. */

declare const name = "deepseek-harness-wecom-plus";
declare const inject: string[];

/**
 * Mount the WeCom long connection and tie its lifecycle to the Cordis plugin
 * lifecycle. The composition entry doubles as the settings base layer: edits
 * saved through the Web Settings page override it and restart the channel
 * live, while a channel failure is always contained to a loud log line and a
 * dormant channel — never a failed plugin mount.
 */
declare function apply(ctx: Context, config: Config): Promise<void>;
declare const _default: {
    name: string;
    inject: string[];
    Config: z<Config>;
    apply: typeof apply;
};

export { Config, Config as ConfigType, SETTINGS_NS, SETTINGS_ROUTE, SeenMessageIds, WeComHarnessBridge, WeComWebBackend, apply, chatTarget, _default as default, detectImageMediaType, inboundContent, inject, name, parseRequest, sessionIdFor, truncateUtf8 };
