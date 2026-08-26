import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	DynamicBorder,
	highlightCode,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	TreeSelectorComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	getKeybindings,
	SelectList,
	Spacer,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	TuiAltScreen,
	TuiMainScreen,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type ScrollView,
	type SelectItem,
	type TUI,
} from "@earendil-works/pi-tui";

const WORK_ENTRY_TYPE = "task-timing-work";
const TOOL_TIMING_MESSAGE_FIELD = "_piTaskTiming";
const TREE_SELECTOR_PATCH = Symbol.for("pi.task-timing.tree-selector-patch");
const TREE_SELECTOR_ACTION = Symbol.for("pi.task-timing.tree-selector-action");
const TREE_LIST_PATCH = Symbol.for("pi.task-timing.tree-list-patch");
const TREE_LIST_ACTION_PATCH = Symbol.for("pi.task-timing.tree-list-action-patch");
const TREE_LIST_TIMINGS = Symbol.for("pi.task-timing.tree-list-timings");
const TREE_LIST_RESULT_CHARACTERS = Symbol.for("pi.task-timing.tree-list-result-characters");
const TREE_LIST_RENDER_WIDTH = Symbol.for("pi.task-timing.tree-list-render-width");
const TREE_LIST_TUI = Symbol.for("pi.task-timing.tree-list-tui");
const TUI_FOCUS_PATCH = Symbol.for("pi.task-timing.tui-focus-patch");
const LARGE_RESULT_CHARACTERS = 10_000;
const VERY_LARGE_RESULT_CHARACTERS = 40_000;
const TREE_DURATION_COLUMN_WIDTH = 8;
const TREE_TOOL_SUMMARY_MAX_WIDTH = 4096;
const TREE_ROW_RIGHT_MARGIN = 2;

interface WorkEntryData {
	startedAt: number;
	endedAt: number;
	durationMs: number;
	toolCount: number;
}

interface ToolTiming {
	toolCallId: string;
	toolName: string;
	startedAt: number;
	endedAt?: number;
	isError?: boolean;
	argsSummary?: string;
}

interface SessionToolCall {
	toolCallId: string;
	toolName: string;
	startedAt: number;
	argsSummary?: string;
}

interface NativeToolInvocation {
	entryId: string;
	toolCallId: string;
	toolName: string;
	args?: unknown;
	result: Record<string, unknown>;
	timing?: ToolTiming;
}

interface DetailSection {
	title?: string;
	content: string;
	language?: "bash" | "json";
	metadata?: boolean;
}

type NativeTreeActionRole = "tool" | "user" | "assistant";

interface NativeTreeAction {
	entry: Record<string, unknown>;
	entryId: string;
	role: NativeTreeActionRole;
	invocation?: NativeToolInvocation;
}

interface TreeActionState {
	view: TreeEntryActionComponent;
}

interface GotoTui extends TUI {
	getPrimaryScrollView?: () => ScrollView;
}

function pad(value: number, width = 2): string {
	return value.toString().padStart(width, "0");
}

function formatTimestamp(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function formatEndTimestamp(startedAt: number, endedAt: number): string {
	const start = new Date(startedAt);
	const end = new Date(endedAt);
	if (
		start.getFullYear() === end.getFullYear() &&
		start.getMonth() === end.getMonth() &&
		start.getDate() === end.getDate()
	) {
		return `${pad(end.getHours())}:${pad(end.getMinutes())}:${pad(end.getSeconds())}.${pad(end.getMilliseconds(), 3)}`;
	}
	return formatTimestamp(endedAt);
}

function formatDuration(durationMs: number): string {
	const ms = Math.max(0, durationMs);
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	if (minutes < 60) return `${minutes}m ${pad(seconds)}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${pad(minutes % 60)}m ${pad(seconds)}s`;
}

function formatTreeDuration(durationMs: number): string {
	if (durationMs < 3_600_000) return formatDuration(durationMs);
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return `${hours}:${pad(minutes)}:${pad(seconds)}`;
}

function countCharacters(value: string): number {
	return Array.from(value).length;
}

function formatCharacterCount(value: number): string {
	return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatElapsed(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${pad(seconds)}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${pad(minutes % 60)}m ${pad(seconds)}s`;
}

function cleanInline(value: string): string {
	return value
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function summarizeArgs(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	for (const key of ["command", "path", "query", "pattern", "agent", "action"]) {
		if (typeof record[key] === "string" && record[key].trim()) {
			return cleanInline(record[key]).slice(0, 180);
		}
	}
	try {
		const serialized = cleanInline(JSON.stringify(args));
		return serialized ? serialized.slice(0, 180) : undefined;
	} catch {
		return undefined;
	}
}

function numericTimestamp(messageTimestamp: unknown, entryTimestamp: unknown): number | undefined {
	if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) return messageTimestamp;
	if (typeof entryTimestamp === "string") {
		const parsed = Date.parse(entryTimestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function persistedToolTiming(message: Record<string, unknown>): { startedAt: number; endedAt: number } | undefined {
	const value = message[TOOL_TIMING_MESSAGE_FIELD];
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.startedAt !== "number" || !Number.isFinite(record.startedAt)) return undefined;
	if (typeof record.endedAt !== "number" || !Number.isFinite(record.endedAt)) return undefined;
	if (record.endedAt < record.startedAt) return undefined;
	return { startedAt: record.startedAt, endedAt: record.endedAt };
}

function collectToolTimings(ctx: ExtensionContext, liveTimings: ReadonlyMap<string, ToolTiming>): ToolTiming[] {
	const entries = ctx.sessionManager.getBranch() as unknown as ReadonlyArray<Record<string, unknown>>;
	const calls = new Map<string, SessionToolCall>();
	const resultIds = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as Record<string, unknown>;
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const startedAt = numericTimestamp(message.timestamp, entry.timestamp);
		if (startedAt === undefined) continue;
		for (const block of message.content) {
			if (!block || typeof block !== "object") continue;
			const content = block as Record<string, unknown>;
			if (content.type !== "toolCall" || typeof content.id !== "string" || typeof content.name !== "string") continue;
			calls.set(content.id, {
				toolCallId: content.id,
				toolName: content.name,
				startedAt,
				argsSummary: summarizeArgs(content.arguments),
			});
		}
	}

	const exact = new Map<string, ToolTiming>();
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as Record<string, unknown>;
		if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
		resultIds.add(message.toolCallId);
		const persisted = persistedToolTiming(message);
		if (!persisted) continue;
		const call = calls.get(message.toolCallId);
		exact.set(message.toolCallId, {
			toolCallId: message.toolCallId,
			toolName: call?.toolName ?? (typeof message.toolName === "string" ? message.toolName : "tool"),
			startedAt: persisted.startedAt,
			endedAt: persisted.endedAt,
			isError: message.isError === true,
			argsSummary: call?.argsSummary,
		});
	}

	for (const [toolCallId, timing] of liveTimings) {
		if (calls.has(toolCallId) || resultIds.has(toolCallId) || timing.endedAt === undefined) exact.set(toolCallId, timing);
	}
	return [...exact.values()].sort((a, b) => a.startedAt - b.startedAt || a.toolCallId.localeCompare(b.toolCallId));
}

function timingItem(timing: ToolTiming, now: number): SelectItem {
	const endLabel = timing.endedAt === undefined ? "running" : formatEndTimestamp(timing.startedAt, timing.endedAt);
	const duration = (timing.endedAt ?? now) - timing.startedAt;
	const state = timing.endedAt === undefined ? "…" : timing.isError ? "✗" : "✓";
	const label = `${state} ${cleanInline(timing.toolName)} · ${formatTimestamp(timing.startedAt)} → ${endLabel} · ${formatDuration(duration)}`;
	const notes = [timing.argsSummary].filter(Boolean);
	return {
		value: timing.toolCallId,
		label,
		description: notes.length > 0 ? notes.join(" · ") : undefined,
	};
}

function bracketedToolSummary(toolName: string, body: string, maxWidth: number): string {
	const label = cleanInline(toolName) || "tool";
	const prefix = `[${label}: `;
	const maxBodyWidth = Math.max(1, maxWidth - visibleWidth(prefix) - 1);
	return `${prefix}${truncateToWidth(cleanInline(body), maxBodyWidth, "…")}]`;
}

function formatTreeToolSummary(toolName: string, args: unknown, maxWidth = TREE_TOOL_SUMMARY_MAX_WIDTH): string {
	const record = args && typeof args === "object" && !Array.isArray(args)
		? args as Record<string, unknown>
		: {};
	const value = (key: string): string => typeof record[key] === "string" ? record[key] : String(record[key] ?? "");
	switch (toolName) {
		case "read": {
			let path = value("path") || value("file_path");
			const offset = typeof record.offset === "number" ? record.offset : undefined;
			const limit = typeof record.limit === "number" ? record.limit : undefined;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				path += `:${start}${end ? `-${end}` : ""}`;
			}
			return bracketedToolSummary(toolName, path, maxWidth);
		}
		case "write":
		case "edit":
			return bracketedToolSummary(toolName, value("path") || value("file_path"), maxWidth);
		case "bash":
			return bracketedToolSummary(toolName, value("command"), maxWidth);
		case "grep":
			return bracketedToolSummary(toolName, `/${value("pattern")}/ in ${value("path") || "."}`, maxWidth);
		case "find":
			return bracketedToolSummary(toolName, `${value("pattern")} in ${value("path") || "."}`, maxWidth);
		case "ls":
			return bracketedToolSummary(toolName, value("path") || ".", maxWidth);
		default: {
			try {
				return bracketedToolSummary(toolName, JSON.stringify(args) ?? String(args ?? ""), maxWidth);
			} catch {
				return bracketedToolSummary(toolName, String(args ?? ""), maxWidth);
			}
		}
	}
}

function treeToolSummaryMaxWidth(
	entry: Record<string, unknown>,
	treeList: Record<PropertyKey, unknown>,
): number {
	const renderWidth = typeof treeList[TREE_LIST_RENDER_WIDTH] === "number"
		? treeList[TREE_LIST_RENDER_WIDTH] as number
		: TREE_TOOL_SUMMARY_MAX_WIDTH;
	let structuralWidth = 0;
	if (Array.isArray(treeList.flatNodes)) {
		const flatNode = treeList.flatNodes.find((candidate: unknown) => {
			if (!candidate || typeof candidate !== "object") return false;
			const node = (candidate as Record<string, unknown>).node;
			if (!node || typeof node !== "object") return false;
			return (node as Record<string, unknown>).entry === entry;
		}) as Record<string, unknown> | undefined;
		if (flatNode) {
			const indent = typeof flatNode.indent === "number" ? flatNode.indent : 0;
			const displayIndent = treeList.multipleRoots === true ? Math.max(0, indent - 1) : indent;
			structuralWidth += displayIndent * 3;
			if (treeList.activePathIds instanceof Set && typeof entry.id === "string" && treeList.activePathIds.has(entry.id)) {
				structuralWidth += 2;
			}
			const node = flatNode.node as Record<string, unknown> | undefined;
			if (node && typeof node.label === "string") {
				structuralWidth += visibleWidth(`[${node.label}] `);
				if (treeList.showLabelTimestamps === true) structuralWidth += 12;
			}
		}
	}
	const fixedContentWidth = visibleWidth(`🕐 00:00 · ⏱ ${" ".repeat(TREE_DURATION_COLUMN_WIDTH)}${" ".repeat(4)}`);
	const available = renderWidth - 2 - structuralWidth - fixedContentWidth - TREE_ROW_RIGHT_MARGIN;
	return Math.max(8, Math.min(TREE_TOOL_SUMMARY_MAX_WIDTH, available));
}

function nativeTreeToolSummary(
	entry: Record<string, unknown>,
	treeList: Record<PropertyKey, unknown>,
): string | undefined {
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return undefined;
	const message = entry.message as Record<string, unknown>;
	if (message.role !== "toolResult" || typeof message.toolCallId !== "string") return undefined;
	const toolCallMap = treeList.toolCallMap instanceof Map
		? treeList.toolCallMap as Map<string, { name?: unknown; arguments?: unknown }>
		: undefined;
	const call = toolCallMap?.get(message.toolCallId);
	if (!call) return undefined;
	const toolName = typeof call.name === "string"
		? call.name
		: typeof message.toolName === "string"
			? message.toolName
			: "tool";
	return formatTreeToolSummary(toolName, call.arguments, treeToolSummaryMaxWidth(entry, treeList));
}

function nativeTreeEntries(treeList: Record<PropertyKey, unknown>): Record<string, unknown>[] {
	if (!Array.isArray(treeList.flatNodes)) return [];
	const entries: Record<string, unknown>[] = [];
	for (const flatNode of treeList.flatNodes) {
		if (!flatNode || typeof flatNode !== "object") continue;
		const node = (flatNode as Record<string, unknown>).node;
		if (!node || typeof node !== "object") continue;
		const entry = (node as Record<string, unknown>).entry;
		if (entry && typeof entry === "object") entries.push(entry as Record<string, unknown>);
	}
	return entries;
}

function collectNativeTreeTimings(
	treeList: Record<PropertyKey, unknown>,
	liveTimings: ReadonlyMap<string, ToolTiming>,
): Map<string, ToolTiming> {
	const entries = nativeTreeEntries(treeList);
	const resultIds = new Set<string>();
	const exact = new Map<string, ToolTiming>();
	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as Record<string, unknown>;
		if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
		resultIds.add(message.toolCallId);
		const persisted = persistedToolTiming(message);
		if (!persisted) continue;
		exact.set(message.toolCallId, {
			toolCallId: message.toolCallId,
			toolName: typeof message.toolName === "string" ? message.toolName : "tool",
			startedAt: persisted.startedAt,
			endedAt: persisted.endedAt,
			isError: message.isError === true,
		});
	}
	for (const [toolCallId, live] of liveTimings) {
		if (resultIds.has(toolCallId)) exact.set(toolCallId, live);
	}
	return exact;
}

function collectNativeTreeResultCharacters(treeList: Record<PropertyKey, unknown>): Map<string, number> {
	const cached = treeList[TREE_LIST_RESULT_CHARACTERS] instanceof Map
		? treeList[TREE_LIST_RESULT_CHARACTERS] as Map<string, number>
		: new Map<string, number>();
	for (const entry of nativeTreeEntries(treeList)) {
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
		const message = entry.message as Record<string, unknown>;
		if (message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
		if (!cached.has(message.toolCallId)) {
			cached.set(message.toolCallId, countCharacters(toolResultContentText(message.content)));
		}
	}
	return cached;
}

function formatTreeResultEmphasis(
	entry: Record<string, unknown>,
	resultCharacters: ReadonlyMap<string, number>,
	theme: Theme,
): string {
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return "";
	const message = entry.message as Record<string, unknown>;
	if (message.role !== "toolResult" || typeof message.toolCallId !== "string") return "";
	const count = resultCharacters.get(message.toolCallId);
	if (count === undefined || count < LARGE_RESULT_CHARACTERS) return "    ";
	const marker = count >= VERY_LARGE_RESULT_CHARACTERS ? " !! " : " !  ";
	return theme.fg("warning", count >= VERY_LARGE_RESULT_CHARACTERS ? theme.bold(marker) : marker);
}

function formatTreeTimestampPrefix(timestamp: number, durationMs?: number): string {
	const start = new Date(timestamp);
	const clock = `🕐 ${pad(start.getHours())}:${pad(start.getMinutes())}`;
	if (durationMs === undefined) return `${clock}  `;
	const duration = formatTreeDuration(durationMs).padStart(TREE_DURATION_COLUMN_WIDTH);
	return `${clock} · ⏱ ${duration}`;
}

function formatTreeEntryPrefix(entry: Record<string, unknown>, timings: ReadonlyMap<string, ToolTiming>): string {
	if (entry.type === "compaction") {
		const timestamp = numericTimestamp(undefined, entry.timestamp);
		return timestamp === undefined ? "" : formatTreeTimestampPrefix(timestamp);
	}
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return "";
	const message = entry.message as Record<string, unknown>;
	if (message.role === "toolResult" && typeof message.toolCallId === "string") {
		const timing = timings.get(message.toolCallId);
		if (timing?.endedAt !== undefined) {
			return formatTreeTimestampPrefix(timing.startedAt, timing.endedAt - timing.startedAt);
		}
		const timestamp = numericTimestamp(message.timestamp, entry.timestamp);
		return timestamp === undefined ? "" : formatTreeTimestampPrefix(timestamp);
	}
	if (message.role !== "user" && message.role !== "assistant") return "";
	const timestamp = numericTimestamp(message.timestamp, entry.timestamp);
	return timestamp === undefined ? "" : formatTreeTimestampPrefix(timestamp);
}

function nativeWorkEntryText(entry: Record<string, unknown>): string | undefined {
	if (entry.type !== "custom" || entry.customType !== WORK_ENTRY_TYPE || !entry.data || typeof entry.data !== "object") return undefined;
	const data = entry.data as Partial<WorkEntryData>;
	if (typeof data.durationMs !== "number") return undefined;
	let text = `⏱ Worked for ${formatDuration(data.durationMs)}`;
	if (typeof data.toolCount === "number" && data.toolCount > 0) text += ` · ${data.toolCount} tool${data.toolCount === 1 ? "" : "s"}`;
	return text;
}

function sanitizeDetailText(value: string): string {
	return stripTerminalSequences(value)
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "  ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�");
}

function prettyValue(value: unknown, quoteStrings = false): string {
	if (value === undefined) return "(not available)";
	if (typeof value === "string" && !quoteStrings) return sanitizeDetailText(value);
	const seen = new WeakSet<object>();
	try {
		const serialized = JSON.stringify(value, (_key, current: unknown) => {
			if (typeof current === "bigint") return `${current.toString()}n`;
			if (typeof current !== "object" || current === null) return current;
			if (ArrayBuffer.isView(current)) {
				const view = current as ArrayBufferView;
				return `[${current.constructor.name}: ${view.byteLength} bytes]`;
			}
			if (seen.has(current)) return "[Circular]";
			seen.add(current);
			return current;
		}, 2);
		return sanitizeDetailText(serialized ?? String(value));
	} catch {
		return sanitizeDetailText(String(value));
	}
}

function toolResultContentText(content: unknown): string {
	if (typeof content === "string") return sanitizeDetailText(content);
	if (!Array.isArray(content)) return prettyValue(content);
	const blocks: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") {
			blocks.push(prettyValue(block));
			continue;
		}
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") {
			blocks.push(sanitizeDetailText(record.text));
		} else if (record.type === "image") {
			const mimeType = typeof record.mimeType === "string"
				? record.mimeType
				: record.source && typeof record.source === "object" && typeof (record.source as Record<string, unknown>).mediaType === "string"
					? String((record.source as Record<string, unknown>).mediaType)
					: "unknown type";
			blocks.push(`[image: ${mimeType}]`);
		} else {
			blocks.push(prettyValue(record));
		}
	}
	return blocks.join("\n") || "(empty)";
}

function nativeToolInvocation(
	entry: Record<string, unknown>,
	treeList: Record<PropertyKey, unknown>,
	liveTimings: ReadonlyMap<string, ToolTiming>,
): NativeToolInvocation | undefined {
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return undefined;
	const message = entry.message as Record<string, unknown>;
	if (message.role !== "toolResult" || typeof message.toolCallId !== "string" || typeof entry.id !== "string") return undefined;

	const toolCallMap = treeList.toolCallMap instanceof Map
		? treeList.toolCallMap as Map<string, { name?: unknown; arguments?: unknown }>
		: undefined;
	const call = toolCallMap?.get(message.toolCallId);
	const persisted = persistedToolTiming(message);
	const live = liveTimings.get(message.toolCallId);
	const toolName = typeof call?.name === "string"
		? call.name
		: typeof message.toolName === "string"
			? message.toolName
			: live?.toolName ?? "tool";
	const timing = persisted
		? {
			toolCallId: message.toolCallId,
			toolName,
			startedAt: persisted.startedAt,
			endedAt: persisted.endedAt,
			isError: message.isError === true,
		} satisfies ToolTiming
		: live;

	return {
		entryId: entry.id,
		toolCallId: message.toolCallId,
		toolName,
		args: call?.arguments,
		result: message,
		timing,
	};
}

function nativeTreeAction(
	entry: Record<string, unknown>,
	treeList: Record<PropertyKey, unknown>,
	liveTimings: ReadonlyMap<string, ToolTiming>,
): NativeTreeAction | undefined {
	if (typeof entry.id !== "string") return undefined;
	const invocation = nativeToolInvocation(entry, treeList, liveTimings);
	if (invocation) {
		return { entry, entryId: entry.id, role: "tool", invocation };
	}
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return undefined;
	const message = entry.message as Record<string, unknown>;
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	return { entry, entryId: entry.id, role: message.role };
}

function toolArgumentSections(invocation: NativeToolInvocation): DetailSection[] {
	if (invocation.args === undefined) {
		return [{ title: "Arguments", content: prettyValue(invocation.args) }];
	}
	if (
		invocation.toolName === "bash" &&
		invocation.args !== null &&
		typeof invocation.args === "object" &&
		!Array.isArray(invocation.args)
	) {
		const args = invocation.args as Record<string, unknown>;
		if (typeof args.command === "string") {
			const options = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "command"));
			const sections: DetailSection[] = [
				{ title: "Arguments · command", content: sanitizeDetailText(args.command), language: "bash" },
			];
			if (Object.keys(options).length > 0) {
				sections.push({ title: "Arguments · options", content: prettyValue(options, true), language: "json" });
			}
			return sections;
		}
	}
	return [{ title: "Arguments", content: prettyValue(invocation.args, true), language: "json" }];
}

function toolDetailSections(invocation: NativeToolInvocation): DetailSection[] {
	const status = invocation.result.isError === true ? "error" : "success";
	const resultText = toolResultContentText(invocation.result.content);
	const resultCharacters = countCharacters(resultText);
	const metadata = [
		`Tool: ${invocation.toolName}`,
		`Status: ${status}`,
		`Tool call ID: ${invocation.toolCallId}`,
		`Tree entry ID: ${invocation.entryId}`,
	];
	if (invocation.timing) {
		metadata.push(`Started: ${formatTimestamp(invocation.timing.startedAt)}`);
		if (invocation.timing.endedAt !== undefined) {
			metadata.push(`Ended: ${formatTimestamp(invocation.timing.endedAt)}`);
			metadata.push(`Duration: ${formatDuration(invocation.timing.endedAt - invocation.timing.startedAt)}`);
		} else {
			metadata.push("Ended: running");
		}
	}

	const sections: DetailSection[] = [
		{ content: metadata.join("\n"), metadata: true },
		...toolArgumentSections(invocation),
		{ title: `Result · ${formatCharacterCount(resultCharacters)} characters`, content: resultText },
	];
	if (invocation.result.details !== undefined) {
		sections.push({ title: "Details", content: prettyValue(invocation.result.details, true), language: "json" });
	}
	if (invocation.result.usage !== undefined) {
		sections.push({ title: "Usage", content: prettyValue(invocation.result.usage, true), language: "json" });
	}
	return sections;
}

function userMessageText(message: Record<string, unknown>): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => String(block.text))
		.join("");
}

function skillBlockKey(value: ReturnType<typeof parseSkillBlock>): string | undefined {
	if (!value) return undefined;
	return `${value.name}\u0000${value.content}\u0000${value.userMessage ?? ""}`;
}

function collectComponents(root: Component, predicate: (component: Component) => boolean): Component[] {
	const matches: Component[] = [];
	const visited = new Set<Component>();
	const visit = (component: Component): void => {
		if (visited.has(component)) return;
		visited.add(component);
		if (predicate(component)) matches.push(component);
		const children = (component as Component & { children?: Component[] }).children;
		if (!Array.isArray(children)) return;
		for (const child of children) visit(child);
	};
	visit(root);
	return matches;
}

function findComponentRow(root: Component, target: Component, width: number, visited = new Set<Component>()): number | undefined {
	if (root === target) return 0;
	if (visited.has(root)) return undefined;
	visited.add(root);
	const children = (root as Component & { children?: Component[] }).children;
	if (!Array.isArray(children)) return undefined;
	let row = 0;
	for (const child of children) {
		const nestedRow = findComponentRow(child, target, width, visited);
		if (nestedRow !== undefined) return row + nestedRow;
		row += child.render(width).length;
	}
	return undefined;
}

function activeEntryForGoto(ctx: ExtensionContext, entryId: string): {
	entry: Record<string, unknown>;
	entries: Record<string, unknown>[];
	index: number;
} | undefined {
	const entries = ctx.sessionManager.buildContextEntries() as unknown as Record<string, unknown>[];
	const index = entries.findIndex((entry) => entry.id === entryId);
	if (index < 0) return undefined;
	return { entry: entries[index], entries, index };
}

function findGotoComponent(
	root: Component,
	action: NativeTreeAction,
	active: NonNullable<ReturnType<typeof activeEntryForGoto>>,
): Component | undefined {
	if (active.entry.type !== "message" || !active.entry.message || typeof active.entry.message !== "object") {
		return undefined;
	}
	const message = active.entry.message as Record<string, unknown>;
	if (action.role === "tool") {
		const toolCallId = typeof message.toolCallId === "string"
			? message.toolCallId
			: action.invocation?.toolCallId;
		return collectComponents(root, (component) =>
			component instanceof ToolExecutionComponent &&
			(component as unknown as { toolCallId?: unknown }).toolCallId === toolCallId
		)[0];
	}
	if (action.role === "assistant") {
		const assistants = collectComponents(root, (component) => component instanceof AssistantMessageComponent);
		const exact = assistants.find((component) =>
			(component as unknown as { lastMessage?: unknown }).lastMessage === message
		);
		if (exact) return exact;
		return assistants.find((component) => {
			const candidate = (component as unknown as { lastMessage?: Record<string, unknown> }).lastMessage;
			return candidate?.timestamp === message.timestamp &&
				candidate?.provider === message.provider &&
				candidate?.model === message.model;
		});
	}

	const text = userMessageText(message);
	if (!text) return undefined;
	const parsedSkill = parseSkillBlock(text);
	const targetKey = skillBlockKey(parsedSkill);
	const occurrence = active.entries.slice(0, active.index + 1).filter((entry) => {
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return false;
		const candidate = entry.message as Record<string, unknown>;
		if (candidate.role !== "user") return false;
		const candidateText = userMessageText(candidate);
		return targetKey !== undefined
			? skillBlockKey(parseSkillBlock(candidateText)) === targetKey
			: candidateText === text;
	}).length - 1;
	if (occurrence < 0) return undefined;
	if (targetKey !== undefined) {
		const skills = collectComponents(root, (component) => {
			if (!(component instanceof SkillInvocationMessageComponent)) return false;
			const skillBlock = (component as unknown as { skillBlock?: ReturnType<typeof parseSkillBlock> }).skillBlock;
			return skillBlockKey(skillBlock ?? null) === targetKey;
		});
		return skills[occurrence];
	}
	const users = collectComponents(root, (component) =>
		component instanceof UserMessageComponent &&
		(component as unknown as { text?: unknown }).text === text
	);
	return users[occurrence];
}

function gotoTreeEntry(ctx: ExtensionContext, action: NativeTreeAction, treeList: Record<PropertyKey, unknown>): void {
	const tui = treeList[TREE_LIST_TUI] as GotoTui | undefined;
	if (!tui) {
		ctx.ui.notify("Could not access the transcript viewport for Goto.", "error");
		return;
	}
	if (tui.mode !== "fullscreen" || typeof tui.getPrimaryScrollView !== "function") {
		ctx.ui.notify("Goto is available in fullscreen TUI mode only.", "warning");
		return;
	}
	const active = activeEntryForGoto(ctx, action.entryId);
	if (!active) {
		ctx.ui.notify("The selected entry is not visible on the active transcript branch.", "warning");
		return;
	}
	const scrollView = tui.getPrimaryScrollView();
	const root = scrollView.children[0];
	if (!root) {
		ctx.ui.notify("Could not find the transcript content for Goto.", "error");
		return;
	}
	const width = scrollView.getContentWidth(Math.max(1, tui.terminal.columns));
	const target = findGotoComponent(root, action, active);
	if (!target) {
		ctx.ui.notify("The selected entry is not currently rendered in the transcript.", "warning");
		return;
	}
	const targetRow = findComponentRow(root, target, width);
	if (targetRow === undefined) {
		ctx.ui.notify("Could not locate the selected entry in the transcript.", "error");
		return;
	}
	const viewportHeight = Math.max(1, scrollView.viewportHeight || tui.terminal.rows);
	const targetHeight = Math.max(1, target.render(width).length);
	const contextAbove = Math.max(1, Math.floor((viewportHeight - Math.min(viewportHeight, targetHeight)) / 3));
	scrollView.scrollTo(targetRow - contextAbove, { disableFollow: true });
	tui.requestRender();
	ctx.ui.notify(`Goto ${action.role} · ${action.entryId}`, "info");
}

class TreeEntryActionComponent implements Component {
	private mode: "menu" | "details" = "menu";
	private selectedIndex = 0;
	private scrollOffset = 0;
	private detailLineCount = 0;
	private detailPageSize = 1;

	constructor(
		private readonly ctx: ExtensionContext,
		private readonly action: NativeTreeAction,
		private readonly maxVisibleLines: number,
		private readonly onGoto: () => void,
		private readonly onNavigate: () => void,
		private readonly onBack: () => void,
	) {}

	invalidate(): void {}

	private getMenuOptions(): Array<{
		id: "details" | "goto" | "navigate" | "back";
		label: string;
		description: string;
	}> {
		const options: Array<{
			id: "details" | "goto" | "navigate" | "back";
			label: string;
			description: string;
		}> = [];
		if (this.action.invocation) {
			options.push({
				id: "details",
				label: "View Details",
				description: "Inspect arguments, result, metadata, and timing",
			});
		}
		options.push(
			{ id: "goto", label: "Goto", description: "Close the tree and scroll to this transcript entry" },
			{ id: "navigate", label: "Continue from Here", description: "Navigate the session tree to this entry" },
			{ id: "back", label: "Back to Tree", description: "Return without changing the active branch" },
		);
		return options;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (this.mode === "menu") {
			const options = this.getMenuOptions();
			const lastIndex = options.length - 1;
			if (keybindings.matches(data, "tui.select.up")) {
				this.selectedIndex = this.selectedIndex === 0 ? lastIndex : this.selectedIndex - 1;
			} else if (keybindings.matches(data, "tui.select.down")) {
				this.selectedIndex = this.selectedIndex === lastIndex ? 0 : this.selectedIndex + 1;
			} else if (keybindings.matches(data, "tui.select.confirm")) {
				const selected = options[this.selectedIndex];
				if (selected?.id === "details") {
					this.mode = "details";
					this.scrollOffset = 0;
				} else if (selected?.id === "goto") {
					this.onGoto();
				} else if (selected?.id === "navigate") {
					this.onNavigate();
				} else if (selected?.id === "back") {
					this.onBack();
				}
			} else if (keybindings.matches(data, "tui.select.cancel")) {
				this.onBack();
			}
			return;
		}

		if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "tui.select.confirm")) {
			this.mode = "menu";
			return;
		}
		const maxOffset = Math.max(0, this.detailLineCount - this.detailPageSize);
		if (keybindings.matches(data, "tui.select.up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.scrollOffset = Math.min(maxOffset, this.scrollOffset + 1);
		} else if (keybindings.matches(data, "tui.select.pageUp") || keybindings.matches(data, "tui.editor.cursorLeft")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - this.detailPageSize);
		} else if (keybindings.matches(data, "tui.select.pageDown") || keybindings.matches(data, "tui.editor.cursorRight")) {
			this.scrollOffset = Math.min(maxOffset, this.scrollOffset + this.detailPageSize);
		}
	}

	render(width: number): string[] {
		return this.mode === "menu" ? this.renderMenu(width) : this.renderDetails(width);
	}

	private renderMenu(width: number): string[] {
		const theme = this.ctx.ui.theme;
		const options = this.getMenuOptions();
		const invocation = this.action.invocation;
		const title = invocation
			? `Tool Call · ${invocation.toolName}`
			: this.action.role === "user"
				? "User Message"
				: "Assistant Message";
		const subtitle = invocation?.toolCallId ?? this.action.entryId;
		const lines = [
			truncateToWidth(theme.fg("accent", theme.bold(`  ${title}`)), width, ""),
			truncateToWidth(theme.fg("dim", `  ${subtitle}`), width, ""),
			"",
		];
		for (let index = 0; index < options.length; index++) {
			const { label, description } = options[index];
			const selected = index === this.selectedIndex;
			const prefix = selected ? "› " : "  ";
			let line = prefix + (selected ? theme.fg("accent", theme.bold(label)) : theme.fg("text", label));
			if (selected) line = theme.bg("selectedBg", line);
			lines.push(truncateToWidth(line, width, ""));
			lines.push(truncateToWidth(theme.fg("dim", `    ${description}`), width, ""));
		}
		lines.push(truncateToWidth(theme.fg("muted", "  ↑↓ move · Enter select · Esc back"), width, ""));
		return lines;
	}

	private renderDetails(width: number): string[] {
		const invocation = this.action.invocation;
		if (!invocation) {
			this.mode = "menu";
			return this.renderMenu(width);
		}
		const theme = this.ctx.ui.theme;
		const innerWidth = Math.max(1, width - 2);
		const body: string[] = [];
		const appendWrapped = (text: string, style: (value: string) => string): void => {
			for (const rawLine of text.split("\n")) {
				if (!rawLine) {
					body.push("");
					continue;
				}
				body.push(...wrapTextWithAnsi(style(rawLine), innerWidth));
			}
		};
		const styleMetadataLine = (line: string): string => {
			const separator = line.indexOf(":");
			if (separator < 0) return theme.fg("text", line);
			const label = line.slice(0, separator + 1);
			const value = line.slice(separator + 1).trimStart();
			const styledLabel = theme.fg("muted", label);
			if (label === "Status:") {
				return `${styledLabel} ${theme.fg(value === "error" ? "error" : "success", value)}`;
			}
			if (label === "Tool:") {
				return `${styledLabel} ${theme.fg("accent", value)}`;
			}
			if (["Tool call ID:", "Tree entry ID:", "Started:", "Ended:", "Duration:"].includes(label)) {
				return `${styledLabel} ${theme.fg("dim", value)}`;
			}
			return `${styledLabel} ${theme.fg("text", value)}`;
		};
		const appendHighlighted = (text: string, language: "bash" | "json"): void => {
			const hasBorder = innerWidth > 2;
			const prefix = hasBorder ? theme.fg("mdCodeBlockBorder", "│ ") : "";
			const codeWidth = Math.max(1, innerWidth - (hasBorder ? 2 : 0));
			for (const highlightedLine of highlightCode(text, language)) {
				if (!highlightedLine) {
					body.push(prefix);
					continue;
				}
				for (const wrappedLine of wrapTextWithAnsi(highlightedLine, codeWidth)) {
					body.push(`${prefix}${wrappedLine}`);
				}
			}
		};
		for (const [index, section] of toolDetailSections(invocation).entries()) {
			if (index > 0) body.push("");
			if (section.title) appendWrapped(`${section.title}:`, (value) => theme.fg("accent", theme.bold(value)));
			if (section.metadata) appendWrapped(section.content, styleMetadataLine);
			else if (section.language) appendHighlighted(section.content, section.language);
			else appendWrapped(section.content, (value) => theme.fg("text", value));
		}

		this.detailLineCount = body.length;
		this.detailPageSize = Math.max(3, this.maxVisibleLines - 1);
		const maxOffset = Math.max(0, body.length - this.detailPageSize);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const visible = body.slice(this.scrollOffset, this.scrollOffset + this.detailPageSize);
		const lines = [
			truncateToWidth(theme.fg("accent", theme.bold(`  Tool Call Details · ${invocation.toolName}`)), width, ""),
			truncateToWidth(theme.fg("dim", `  Lines ${body.length === 0 ? 0 : this.scrollOffset + 1}-${Math.min(body.length, this.scrollOffset + this.detailPageSize)} of ${body.length}`), width, ""),
			...visible.map((line) => truncateToWidth(`  ${line}`, width, "")),
		];
		while (lines.length < this.detailPageSize + 2) lines.push("");
		lines.push(truncateToWidth(theme.fg("muted", "  ↑↓ scroll · ←→/PgUp/PgDn page · Enter/Esc back"), width, ""));
		return lines;
	}
}

export default function taskTimingExtension(pi: ExtensionAPI) {
	const liveTimings = new Map<string, ToolTiming>();
	let pendingRequestAt: number | undefined;
	let taskStartedAt: number | undefined;
	let taskToolCount = 0;
	let workingClock: ReturnType<typeof setInterval> | undefined;
	let timelineOpen = false;
	let restoreNativeTreePatch: (() => void) | undefined;
	let restoreTuiFocusPatch: (() => void) | undefined;

	const installTuiFocusPatch = (): void => {
		restoreTuiFocusPatch?.();
		restoreTuiFocusPatch = undefined;
		const owner = {};
		const restorers: Array<() => void> = [];
		for (const value of [TuiAltScreen.prototype, TuiMainScreen.prototype]) {
			const prototype = value as unknown as Record<PropertyKey, unknown> & {
				setFocus(component: Component | null): void;
			};
			if (prototype[TUI_FOCUS_PATCH] !== undefined) continue;
			const hadOwnSetFocus = Object.prototype.hasOwnProperty.call(prototype, "setFocus");
			const originalSetFocus = prototype.setFocus;
			const patchedSetFocus = function (this: GotoTui, component: Component | null): void {
				if (component && typeof component === "object") {
					const focused = component as Component & Record<PropertyKey, unknown>;
					let candidate = focused;
					if (typeof focused.getTreeList === "function") {
						const treeList = (focused.getTreeList as () => unknown).call(focused);
						if (treeList && typeof treeList === "object") {
							candidate = treeList as Component & Record<PropertyKey, unknown>;
						}
					} else if (focused.treeList && typeof focused.treeList === "object") {
						candidate = focused.treeList as Component & Record<PropertyKey, unknown>;
					}
					if (typeof candidate.getSelectedNode === "function" && Array.isArray(candidate.flatNodes)) {
						candidate[TREE_LIST_TUI] = this;
					}
				}
				originalSetFocus.call(this, component);
			};
			prototype.setFocus = patchedSetFocus;
			Object.defineProperty(prototype, TUI_FOCUS_PATCH, {
				value: { owner, originalSetFocus, patchedSetFocus, hadOwnSetFocus },
				configurable: true,
			});
			restorers.push(() => {
				const state = prototype[TUI_FOCUS_PATCH] as { owner?: object } | undefined;
				if (state?.owner !== owner) return;
				if (prototype.setFocus === patchedSetFocus) {
					if (hadOwnSetFocus) prototype.setFocus = originalSetFocus;
					else Reflect.deleteProperty(prototype, "setFocus");
				}
				delete prototype[TUI_FOCUS_PATCH];
			});
		}
		restoreTuiFocusPatch = () => {
			for (const restore of restorers) restore();
		};
	};

	const installNativeTreePatch = (ctx: ExtensionContext): void => {
		restoreNativeTreePatch?.();
		restoreNativeTreePatch = undefined;
		const prototype = TreeSelectorComponent.prototype as unknown as Record<PropertyKey, unknown> & {
			render(width: number): string[];
			handleInput(data: string): void;
		};
		if (prototype[TREE_SELECTOR_PATCH] !== undefined) return;

		const owner = {};
		const hadOwnRender = Object.prototype.hasOwnProperty.call(prototype, "render");
		const hadOwnHandleInput = Object.prototype.hasOwnProperty.call(prototype, "handleInput");
		const originalRender = prototype.render;
		const originalHandleInput = prototype.handleInput;
		const patchedRender = function (this: Record<PropertyKey, unknown>, width: number): string[] {
			const treeList = this.treeList;
			if (treeList && typeof treeList === "object") {
				const internal = treeList as Record<PropertyKey, unknown>;
				internal[TREE_LIST_RENDER_WIDTH] = width;
				internal[TREE_LIST_TIMINGS] = collectNativeTreeTimings(internal, liveTimings);
				internal[TREE_LIST_RESULT_CHARACTERS] = collectNativeTreeResultCharacters(internal);
				if (internal[TREE_LIST_PATCH] === undefined && typeof internal.getEntryDisplayText === "function") {
					const originalDisplay = internal.getEntryDisplayText as (node: unknown, isSelected: boolean) => string;
					internal.getEntryDisplayText = function (
						this: Record<PropertyKey, unknown>,
						node: unknown,
						isSelected: boolean,
					): string {
						let text = originalDisplay.call(this, node, isSelected);
						if (!node || typeof node !== "object") return text;
						const entry = (node as Record<string, unknown>).entry;
						if (!entry || typeof entry !== "object") return text;
						const typedEntry = entry as Record<string, unknown>;
						text = nativeWorkEntryText(typedEntry) ?? text;
						const toolSummary = nativeTreeToolSummary(typedEntry, this);
						if (toolSummary !== undefined) {
							const styledSummary = ctx.ui.theme.fg("muted", toolSummary);
							text = isSelected ? ctx.ui.theme.bold(styledSummary) : styledSummary;
						}
						const timings = this[TREE_LIST_TIMINGS] instanceof Map
							? this[TREE_LIST_TIMINGS] as ReadonlyMap<string, ToolTiming>
							: new Map<string, ToolTiming>();
						const resultCharacters = this[TREE_LIST_RESULT_CHARACTERS] instanceof Map
							? this[TREE_LIST_RESULT_CHARACTERS] as ReadonlyMap<string, number>
							: new Map<string, number>();
						return formatTreeEntryPrefix(typedEntry, timings) +
							formatTreeResultEmphasis(typedEntry, resultCharacters, ctx.ui.theme) +
							text;
					};
					internal[TREE_LIST_PATCH] = true;
				}
				if (
					internal[TREE_LIST_ACTION_PATCH] === undefined &&
					typeof internal.onSelect === "function" &&
					typeof internal.getSelectedNode === "function"
				) {
					const selector = this;
					const originalSelect = internal.onSelect as (entryId: string) => unknown;
					const originalCancel = typeof internal.onCancel === "function"
						? internal.onCancel as () => unknown
						: undefined;
					internal.onSelect = (entryId: string): void => {
						const selectedNode = (internal.getSelectedNode as () => unknown).call(internal);
						const entry = selectedNode && typeof selectedNode === "object"
							? (selectedNode as Record<string, unknown>).entry
							: undefined;
						const target = entry && typeof entry === "object"
							? nativeTreeAction(entry as Record<string, unknown>, internal, liveTimings)
							: undefined;
						if (!target || target.entryId !== entryId) {
							void originalSelect(entryId);
							return;
						}

						const treeContainer = selector.treeContainer as {
							clear?: () => void;
							addChild?: (component: Component) => void;
						} | undefined;
						if (!treeContainer?.clear || !treeContainer.addChild) {
							void originalSelect(entryId);
							return;
						}

						const restoreTree = (): void => {
							const action = selector[TREE_SELECTOR_ACTION] as TreeActionState | undefined;
							if (!action) return;
							delete selector[TREE_SELECTOR_ACTION];
							treeContainer.clear?.();
							treeContainer.addChild?.(treeList as Component);
						};
						const gotoEntry = (): void => {
							if (!originalCancel) {
								restoreTree();
								ctx.ui.notify("Could not close the tree selector for Goto.", "error");
								return;
							}
							delete selector[TREE_SELECTOR_ACTION];
							void originalCancel.call(internal);
							queueMicrotask(() => gotoTreeEntry(ctx, target, internal));
						};
						const maxVisibleLines = typeof internal.maxVisibleLines === "number" ? internal.maxVisibleLines : 10;
						const view = new TreeEntryActionComponent(
							ctx,
							target,
							maxVisibleLines,
							gotoEntry,
							() => {
								restoreTree();
								void originalSelect(entryId);
							},
							restoreTree,
						);
						selector[TREE_SELECTOR_ACTION] = { view } satisfies TreeActionState;
						treeContainer.clear();
						treeContainer.addChild(view);
					};
					internal[TREE_LIST_ACTION_PATCH] = true;
				}
			}
			return originalRender.call(this, width);
		};
		const patchedHandleInput = function (this: Record<PropertyKey, unknown>, data: string): void {
			const action = this[TREE_SELECTOR_ACTION] as TreeActionState | undefined;
			if (action) {
				action.view.handleInput(data);
				return;
			}
			originalHandleInput.call(this, data);
		};

		prototype.render = patchedRender;
		prototype.handleInput = patchedHandleInput;
		Object.defineProperty(prototype, TREE_SELECTOR_PATCH, {
			value: {
				owner,
				originalRender,
				patchedRender,
				hadOwnRender,
				originalHandleInput,
				patchedHandleInput,
				hadOwnHandleInput,
			},
			configurable: true,
		});
		restoreNativeTreePatch = () => {
			const state = prototype[TREE_SELECTOR_PATCH] as { owner?: object } | undefined;
			if (state?.owner !== owner) return;
			if (prototype.render === patchedRender) {
				if (hadOwnRender) prototype.render = originalRender;
				else Reflect.deleteProperty(prototype, "render");
			}
			if (prototype.handleInput === patchedHandleInput) {
				if (hadOwnHandleInput) prototype.handleInput = originalHandleInput;
				else Reflect.deleteProperty(prototype, "handleInput");
			}
			delete prototype[TREE_SELECTOR_PATCH];
		};
	};

	const updateWorkingMessage = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui" || taskStartedAt === undefined) return;
		ctx.ui.setWorkingMessage(`Working... · ${formatElapsed(Date.now() - taskStartedAt)} elapsed`);
	};

	const startWorkingClock = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		updateWorkingMessage(ctx);
		if (workingClock !== undefined) return;
		workingClock = setInterval(() => updateWorkingMessage(ctx), 1000);
	};

	const stopWorkingClock = (ctx?: ExtensionContext): void => {
		if (workingClock !== undefined) clearInterval(workingClock);
		workingClock = undefined;
		if (ctx?.mode === "tui") ctx.ui.setWorkingMessage();
	};

	const showToolTimeline = async (ctx: ExtensionContext): Promise<void> => {
		if (timelineOpen || ctx.mode !== "tui") return;
		timelineOpen = true;
		try {
			const timings = collectToolTimings(ctx, liveTimings);
			const now = Date.now();
			const items: SelectItem[] = timings.length > 0
				? timings.map((timing) => timingItem(timing, now))
				: [{ value: "none", label: "No tool executions recorded in the current branch." }];

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold(`Tool execution timeline · ${timings.length} tool${timings.length === 1 ? "" : "s"}`)), 1, 0));
				container.addChild(new Text(theme.fg("dim", "Local timestamps · ↑↓ navigate · Enter/Esc close · /tool-times also opens this view"), 1, 0));
				container.addChild(new Spacer(1));

				const maxVisible = Math.max(3, Math.min(items.length, Math.max(3, (tui.terminal.rows ?? 24) - 10), 16));
				const list = new SelectList(items, maxVisible, {
					selectedPrefix: (text: string) => theme.fg("accent", text),
					selectedText: (text: string) => theme.fg("accent", text),
					description: (text: string) => theme.fg("muted", text),
					scrollInfo: (text: string) => theme.fg("dim", text),
					noMatch: (text: string) => theme.fg("warning", text),
				}, {
					minPrimaryColumnWidth: 72,
					maxPrimaryColumnWidth: 96,
				});
				list.setSelectedIndex(items.length - 1);
				list.onSelect = () => done();
				list.onCancel = () => done();
				container.addChild(list);
				container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						list.handleInput(data);
						tui.requestRender();
					},
				};
			}, {
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "90%",
					minWidth: 50,
					maxHeight: "80%",
					margin: 1,
				},
			});
		} finally {
			timelineOpen = false;
		}
	};

	pi.registerEntryRenderer<WorkEntryData>(WORK_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data || typeof data.durationMs !== "number") return undefined;
		let text = `⏱ Worked for ${formatDuration(data.durationMs)}`;
		if (data.toolCount > 0) text += ` · ${data.toolCount} tool${data.toolCount === 1 ? "" : "s"}`;
		if (expanded) text += `\n  ${formatTimestamp(data.startedAt)} → ${formatTimestamp(data.endedAt)}`;
		return new Text(theme.fg("dim", text), 1, 0);
	});

	pi.registerCommand("tool-times", {
		description: "Show tool start/end timestamps and execution durations for the current branch",
		handler: async (_args, ctx) => showToolTimeline(ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		stopWorkingClock();
		liveTimings.clear();
		pendingRequestAt = undefined;
		taskStartedAt = undefined;
		taskToolCount = 0;
		installTuiFocusPatch();
		installNativeTreePatch(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopWorkingClock(ctx);
		restoreNativeTreePatch?.();
		restoreNativeTreePatch = undefined;
		restoreTuiFocusPatch?.();
		restoreTuiFocusPatch = undefined;
	});

	pi.on("input", () => {
		// The next agent_start confirms that this input became an agent request.
		// Replacing this value on every idle input avoids stale timestamps from built-in commands.
		if (taskStartedAt === undefined) pendingRequestAt = Date.now();
	});

	pi.on("agent_start", (_event, ctx) => {
		if (taskStartedAt === undefined) {
			taskStartedAt = pendingRequestAt ?? Date.now();
			pendingRequestAt = undefined;
			taskToolCount = 0;
		}
		startWorkingClock(ctx);
	});

	pi.on("tool_execution_start", (event) => {
		const startedAt = Date.now();
		liveTimings.set(event.toolCallId, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			startedAt,
			argsSummary: summarizeArgs(event.args),
		});
		if (taskStartedAt !== undefined) taskToolCount++;
	});

	pi.on("tool_execution_end", (event) => {
		const endedAt = Date.now();
		const existing = liveTimings.get(event.toolCallId);
		liveTimings.set(event.toolCallId, {
			...existing,
			toolCallId: event.toolCallId,
			toolName: existing?.toolName ?? event.toolName,
			startedAt: existing?.startedAt ?? endedAt,
			endedAt,
			isError: event.isError,
		});
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "toolResult") return;
		const timing = liveTimings.get(event.message.toolCallId);
		if (timing?.endedAt === undefined) return;
		return {
			message: {
				...event.message,
				[TOOL_TIMING_MESSAGE_FIELD]: {
					startedAt: timing.startedAt,
					endedAt: timing.endedAt,
				},
			},
		};
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (taskStartedAt === undefined) {
			stopWorkingClock(ctx);
			return;
		}
		const endedAt = Date.now();
		const startedAt = taskStartedAt;
		const toolCount = taskToolCount;
		pendingRequestAt = undefined;
		taskStartedAt = undefined;
		taskToolCount = 0;
		stopWorkingClock(ctx);
		pi.appendEntry<WorkEntryData>(WORK_ENTRY_TYPE, {
			startedAt,
			endedAt,
			durationMs: Math.max(0, endedAt - startedAt),
			toolCount,
		});
	});
}
