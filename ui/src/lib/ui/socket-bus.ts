import { readdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface SocketBusMessage {
	seq: number;
	channel: string;
	sender_agent_id: string;
	sender_resource: string;
	schema: string;
	summary: string;
	timestamp: string;
}

export interface SocketBusActivity {
	messages: SocketBusMessage[];
	channels: string[];
	activeSenders: string[];
}

const TAIL_BYTES = 8192;
const MAX_MESSAGES = 30;

/**
 * Read the tail of a file (last `bytes` bytes) and return the content as a string.
 * Skips the first (likely partial) line.
 */
async function tailFile(filePath: string, bytes: number): Promise<{ lines: string[]; mtime: Date }> {
	const info = await stat(filePath);
	const fileSize = info.size;
	if (fileSize === 0) return { lines: [], mtime: info.mtime };

	const readStart = Math.max(0, fileSize - bytes);
	const readLen = fileSize - readStart;
	const buf = Buffer.alloc(readLen);

	const fh = await open(filePath, 'r');
	try {
		await fh.read(buf, 0, readLen, readStart);
	} finally {
		await fh.close();
	}

	const raw = buf.toString('utf-8');
	const allLines = raw.split('\n').filter((l) => l.trim().length > 0);

	// If we didn't read from the start, the first line is likely partial — skip it
	const lines = readStart > 0 ? allLines.slice(1) : allLines;
	return { lines, mtime: info.mtime };
}

function channelFromFilename(filename: string): string {
	// e.g. "plugin_pinokio.chat_meta.jsonl" → "plugin:pinokio.chat:meta"
	// "global.jsonl" → "global"
	// "plugins_index.jsonl" → "plugins_index"
	// "explorer_task_1.jsonl" → "explorer_task_1"
	const base = filename.replace(/\.jsonl$/, '');

	// plugin_pinokio.X_Y → plugin:pinokio.X:Y
	const pluginMatch = base.match(/^plugin_([^_]+(?:\.[^_]+)*)_(.+)$/);
	if (pluginMatch) {
		return `plugin:${pluginMatch[1]}:${pluginMatch[2]}`;
	}
	return base;
}

function summarizeMessage(payload: Record<string, unknown>): string {
	if (typeof payload.message === 'string') return payload.message.slice(0, 120);
	if (typeof payload.name === 'string') return payload.name;
	const schema = typeof payload.schema === 'string' ? payload.schema : '';
	if (schema) return schema;
	return 'message';
}

/**
 * Read recent socket bus activity from .pka/socket-bus/ directory.
 */
export async function readSocketBusActivity(busDir: string): Promise<SocketBusActivity> {
	let entries: string[];
	try {
		entries = await readdir(busDir);
	} catch {
		return { messages: [], channels: [], activeSenders: [] };
	}

	const jsonlFiles = entries.filter((f) => f.endsWith('.jsonl'));
	if (jsonlFiles.length === 0) {
		return { messages: [], channels: [], activeSenders: [] };
	}

	const seen = new Set<string>();
	const allMessages: SocketBusMessage[] = [];

	const results = await Promise.allSettled(
		jsonlFiles.map(async (file) => {
			const filePath = join(busDir, file);
			const channel = channelFromFilename(file);
			const { lines, mtime } = await tailFile(filePath, TAIL_BYTES);
			const timestamp = mtime.toISOString();

			const parsed: SocketBusMessage[] = [];
			for (const line of lines) {
				try {
					const msg = JSON.parse(line) as {
						seq?: number;
						channel?: string;
						sender_agent_id?: string;
						sender_resource?: string;
						payload?: Record<string, unknown>;
					};
					if (typeof msg.seq !== 'number') continue;

					const ch = msg.channel ?? channel;
					const dedupKey = `${msg.seq}:${ch}`;
					if (seen.has(dedupKey)) continue;
					seen.add(dedupKey);

					const payload = msg.payload ?? {};
					parsed.push({
						seq: msg.seq,
						channel: ch,
						sender_agent_id: msg.sender_agent_id ?? 'unknown',
						sender_resource: msg.sender_resource ?? 'unknown',
						schema: typeof payload.schema === 'string' ? payload.schema : '',
						summary: summarizeMessage(payload),
						timestamp
					});
				} catch {
					// skip malformed lines
				}
			}
			return parsed;
		})
	);

	for (const result of results) {
		if (result.status === 'fulfilled') {
			allMessages.push(...result.value);
		}
	}

	// Sort by seq descending, take most recent
	allMessages.sort((a, b) => b.seq - a.seq);
	const messages = allMessages.slice(0, MAX_MESSAGES);

	const channels = [...new Set(messages.map((m) => m.channel))].sort();
	const activeSenders = [...new Set(messages.map((m) => m.sender_resource))].sort();

	return { messages, channels, activeSenders };
}
