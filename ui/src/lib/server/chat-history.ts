import { spawnSync } from 'node:child_process';

interface ChatDbConnection {
	container: string;
	database: string;
	user: string;
	password: string;
	timeoutMs: number;
}

interface RecentMessage {
	role: string;
	content: string;
	turn_index: number;
}

interface AssistantCandidate {
	text: string;
	mode: string | null;
	plugin: string | null;
	routedResource: string | null;
	routedAction: string | null;
	llmProfile: string | null;
	llmProvider: string | null;
	llmModel: string | null;
	depth: number;
	spawned: boolean;
}

const CHAT_DB_ENABLED_DEFAULT = true;
const STATUS_ONLY_PREFIXES = [
	'routing via ',
	'executing through directory plugin',
	'delegating '
];
const STATUS_ONLY_EXACT = new Set(['task completed.', 'here is what i found.']);

function asOptionalString(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function parseJsonOutput(raw: unknown): unknown | null {
	const trimmed = String(raw ?? '').trim();
	if (!trimmed) {
		return null;
	}
	try {
		return JSON.parse(trimmed);
	} catch {
		const firstObject = trimmed.indexOf('{');
		const firstArray = trimmed.indexOf('[');
		const start =
			firstObject === -1
				? firstArray
				: firstArray === -1
					? firstObject
					: Math.min(firstObject, firstArray);
		if (start < 0) {
			return null;
		}
		const endCandidates = [
			trimmed.length,
			Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']')) + 1
		].filter((value) => Number.isFinite(value) && value > start);
		for (const end of endCandidates) {
			try {
				return JSON.parse(trimmed.slice(start, end));
			} catch {
				// try next
			}
		}
		return null;
	}
}

function decodeJsonEscapedString(value: string): string {
	try {
		return JSON.parse(`"${value}"`) as string;
	} catch {
		return value.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
	}
}

function extractChatResponseFromRaw(raw: string): string | null {
	const match = raw.match(/"chat_response"\s*:\s*"((?:\\.|[^"\\])*)"/s);
	if (!match || !match[1]) {
		return null;
	}
	return asOptionalString(decodeJsonEscapedString(match[1]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStatusOnlyText(value: string): boolean {
	const lower = value.trim().toLowerCase();
	if (!lower) {
		return true;
	}
	if (STATUS_ONLY_EXACT.has(lower)) {
		return true;
	}
	return STATUS_ONLY_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function toBool(value: unknown, fallback = false): boolean {
	if (typeof value === 'boolean') {
		return value;
	}
	const normalized = String(value ?? '')
		.trim()
		.toLowerCase();
	if (!normalized) {
		return fallback;
	}
	if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
		return true;
	}
	if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
		return false;
	}
	return fallback;
}

function sqlQuote(value: unknown): string {
	return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function runSql(connection: ChatDbConnection, sql: string, tuplesOnly = false): string {
	const args: string[] = ['exec', '-i'];
	if (connection.password) {
		args.push('-e', `PGPASSWORD=${connection.password}`);
	}
	args.push(
		connection.container,
		'psql',
		'-v',
		'ON_ERROR_STOP=1',
		'-X',
		'-U',
		connection.user,
		'-d',
		connection.database,
		'-P',
		'pager=off'
	);
	if (tuplesOnly) {
		args.push('-t', '-A');
	}
	args.push('-c', sql);

	const out = spawnSync('docker', args, {
		encoding: 'utf8',
		env: process.env,
		timeout: connection.timeoutMs
	});
	if (out.error) {
		throw new Error(`failed to execute docker: ${out.error.message}`);
	}
	if (out.status !== 0) {
		throw new Error((out.stderr || out.stdout || `docker exited ${String(out.status)}`).trim());
	}
	return (out.stdout || '').trim();
}

function runJson(connection: ChatDbConnection, sql: string): unknown {
	const stdout = runSql(connection, sql, true);
	const firstLine = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) {
		return null;
	}
	try {
		return JSON.parse(firstLine);
	} catch {
		return null;
	}
}

function resolveConnection(): ChatDbConnection {
	const rawTimeout = Number.parseInt(String(process.env.PINOKIO_CHAT_DB_TIMEOUT_MS ?? ''), 10);
	return {
		container: process.env.PINOKIO_DB_CONTAINER || 'pinokio-postgres-main',
		database: process.env.PINOKIO_DB_NAME || process.env.PGDATABASE || 'pinokio',
		user: process.env.PINOKIO_DB_USER || process.env.PGUSER || 'pinokio',
		password: process.env.PINOKIO_DB_PASSWORD || process.env.PGPASSWORD || '',
		timeoutMs:
			Number.isFinite(rawTimeout) && rawTimeout >= 500 && rawTimeout <= 60000
				? rawTimeout
				: 6000
	};
}

let schemaEnsured = false;

function ensureChatSchema(connection: ChatDbConnection): void {
	if (schemaEnsured) {
		return;
	}
	runSql(
		connection,
		[
			'CREATE SCHEMA IF NOT EXISTS pinokio_chat;',
			`CREATE TABLE IF NOT EXISTS pinokio_chat.sessions (
				id BIGSERIAL PRIMARY KEY,
				session_key TEXT NOT NULL UNIQUE,
				channel TEXT NOT NULL DEFAULT 'default',
				agent_id TEXT,
				caller_agent_id TEXT,
				caller_resource TEXT,
				llm_profile TEXT,
				status TEXT NOT NULL DEFAULT 'active',
				metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
				tags TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
				summary TEXT,
				message_count INTEGER NOT NULL DEFAULT 0,
				first_message_at TIMESTAMPTZ,
				last_message_at TIMESTAMPTZ,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);`,
			`CREATE TABLE IF NOT EXISTS pinokio_chat.messages (
				id BIGSERIAL PRIMARY KEY,
				session_id BIGINT NOT NULL REFERENCES pinokio_chat.sessions(id) ON DELETE CASCADE,
				role TEXT NOT NULL,
				content TEXT NOT NULL,
				turn_index INTEGER NOT NULL DEFAULT 0,
				metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
				tags TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
				importance SMALLINT NOT NULL DEFAULT 0,
				flagged_for_memory BOOLEAN NOT NULL DEFAULT false,
				llm_profile TEXT,
				llm_provider TEXT,
				llm_model TEXT,
				routed_resource TEXT,
				routed_action TEXT,
				response_mode TEXT,
				token_estimate INTEGER,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);`,
			'CREATE INDEX IF NOT EXISTS pka_chat_sessions_channel_idx ON pinokio_chat.sessions (channel, updated_at DESC);',
			'CREATE INDEX IF NOT EXISTS pka_chat_messages_session_idx ON pinokio_chat.messages (session_id, turn_index);'
		].join('\n')
	);
	schemaEnsured = true;
}

function findOrCreateSession(connection: ChatDbConnection, channel: string, llmProfile: string | null): number {
	const existing = runJson(
		connection,
		`SELECT COALESCE(
			(SELECT row_to_json(s)::text
			 FROM pinokio_chat.sessions s
			 WHERE s.channel = ${sqlQuote(channel)}
				AND s.status = 'active'
				AND s.updated_at >= now() - interval '30 minutes'
			 ORDER BY s.updated_at DESC
			 LIMIT 1),
			'null'
		);`
	) as Record<string, unknown> | null;
	if (existing && typeof existing.id === 'number') {
		return existing.id;
	}
	const key = `${channel}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
	const created = runJson(
		connection,
		`WITH ins AS (
			INSERT INTO pinokio_chat.sessions (
				session_key, channel, llm_profile
			) VALUES (
				${sqlQuote(key)},
				${sqlQuote(channel)},
				${llmProfile ? sqlQuote(llmProfile) : 'NULL'}
			)
			RETURNING *
		)
		SELECT row_to_json(ins)::text FROM ins;`
	) as Record<string, unknown> | null;
	if (!created || typeof created.id !== 'number') {
		throw new Error('failed to create chat session');
	}
	return created.id;
}

function listRecentMessages(connection: ChatDbConnection, sessionId: number): RecentMessage[] {
	const rows = runJson(
		connection,
		`SELECT COALESCE(
			(SELECT json_agg(row_to_json(t))::text
			 FROM (
				SELECT role, content, turn_index
				FROM pinokio_chat.messages
				WHERE session_id = ${sessionId}
				ORDER BY turn_index DESC
				LIMIT 8
			 ) t),
			'[]'
		);`
	);
	if (!Array.isArray(rows)) {
		return [];
	}
	return rows
		.map((row) => {
			if (!isRecord(row)) {
				return null;
			}
			const role = asOptionalString(row.role);
			const content = asOptionalString(row.content);
			const turnIndex = typeof row.turn_index === 'number' ? row.turn_index : Number(row.turn_index);
			if (!role || !content || !Number.isFinite(turnIndex)) {
				return null;
			}
			return { role, content, turn_index: turnIndex };
		})
		.filter((value): value is RecentMessage => value !== null);
}

function nextTurnIndex(recent: RecentMessage[]): number {
	const maxTurn = recent.reduce((max, row) => Math.max(max, row.turn_index), -1);
	return maxTurn + 1;
}

function estimateTokens(text: string): number {
	const words = text.split(/\s+/).filter((word) => word.length > 0).length;
	return Math.ceil(words * 1.3);
}

function insertMessage(
	connection: ChatDbConnection,
	sessionId: number,
	role: 'user' | 'assistant',
	content: string,
	turnIndex: number,
	meta: {
		responseMode?: string | null;
		routedResource?: string | null;
		routedAction?: string | null;
		llmProfile?: string | null;
		llmProvider?: string | null;
		llmModel?: string | null;
	}
): void {
	runSql(
		connection,
		`INSERT INTO pinokio_chat.messages (
			session_id, role, content, turn_index, response_mode,
			routed_resource, routed_action, llm_profile, llm_provider, llm_model, token_estimate
		) VALUES (
			${sessionId},
			${sqlQuote(role)},
			${sqlQuote(content)},
			${turnIndex},
			${meta.responseMode ? sqlQuote(meta.responseMode) : 'NULL'},
			${meta.routedResource ? sqlQuote(meta.routedResource) : 'NULL'},
			${meta.routedAction ? sqlQuote(meta.routedAction) : 'NULL'},
			${meta.llmProfile ? sqlQuote(meta.llmProfile) : 'NULL'},
			${meta.llmProvider ? sqlQuote(meta.llmProvider) : 'NULL'},
			${meta.llmModel ? sqlQuote(meta.llmModel) : 'NULL'},
			${estimateTokens(content)}
		);`
	);
}

function updateSessionCounters(connection: ChatDbConnection, sessionId: number): void {
	runSql(
		connection,
		`UPDATE pinokio_chat.sessions SET
			message_count = (SELECT COUNT(*) FROM pinokio_chat.messages WHERE session_id = ${sessionId}),
			first_message_at = (SELECT MIN(created_at) FROM pinokio_chat.messages WHERE session_id = ${sessionId}),
			last_message_at = (SELECT MAX(created_at) FROM pinokio_chat.messages WHERE session_id = ${sessionId}),
			updated_at = now()
		WHERE id = ${sessionId};`
	);
}

function extractAssistantCandidate(report: unknown): AssistantCandidate | null {
	const seen = new Set<unknown>();
	const candidates: AssistantCandidate[] = [];

	const visitData = (value: unknown, depth: number, spawned: boolean): void => {
		if (!isRecord(value) || seen.has(value)) {
			return;
		}
		seen.add(value);

		const direct = asOptionalString(value.chat_response);
		if (direct) {
			candidates.push({
				text: direct,
				mode: asOptionalString(value.mode),
				plugin: asOptionalString(value.plugin),
				routedResource: asOptionalString(value.routed_resource),
				routedAction: asOptionalString(value.routed_action),
				llmProfile: asOptionalString(value.profile) ?? asOptionalString(value.llm_profile),
				llmProvider: asOptionalString(value.provider) ?? asOptionalString(value.llm_provider),
				llmModel: asOptionalString(value.model) ?? asOptionalString(value.llm_model),
				depth,
				spawned
			});
		}

		if (typeof value.raw === 'string') {
			const parsed = parseJsonOutput(value.raw);
			if (parsed) {
				visitData(parsed, depth + 1, spawned);
			} else {
				const fallback = extractChatResponseFromRaw(value.raw);
				if (fallback) {
					candidates.push({
						text: fallback,
						mode: asOptionalString(value.mode),
						plugin: asOptionalString(value.plugin),
						routedResource: asOptionalString(value.routed_resource),
						routedAction: asOptionalString(value.routed_action),
						llmProfile: asOptionalString(value.profile) ?? asOptionalString(value.llm_profile),
						llmProvider: asOptionalString(value.provider) ?? asOptionalString(value.llm_provider),
						llmModel: asOptionalString(value.model) ?? asOptionalString(value.llm_model),
						depth,
						spawned
					});
				}
			}
		}

		const spawnResult = isRecord(value.spawn_child_result) ? value.spawn_child_result : null;
		if (spawnResult && spawnResult.report) {
			visitReport(spawnResult.report, depth + 1, true);
		}

		for (const nested of Object.values(value)) {
			visitData(nested, depth + 1, spawned);
		}
	};

	const visitReport = (value: unknown, depth: number, spawned: boolean): void => {
		if (!isRecord(value) || seen.has(value)) {
			return;
		}
		seen.add(value);
		if (Array.isArray(value.agents)) {
			for (const agent of value.agents) {
				if (!isRecord(agent)) {
					continue;
				}
				visitData(agent.data, depth + 1, spawned);
			}
		}
		for (const nested of Object.values(value)) {
			visitData(nested, depth + 1, spawned);
		}
	};

	visitReport(report, 0, false);
	if (candidates.length === 0) {
		return null;
	}
	const nonStatus = candidates.filter((item) => !isStatusOnlyText(item.text));
	const pool = nonStatus.length > 0 ? nonStatus : candidates;
	pool.sort((a, b) => {
		if (a.spawned !== b.spawned) {
			return a.spawned ? 1 : -1;
		}
		if (a.depth !== b.depth) {
			return a.depth - b.depth;
		}
		return 0;
	});
	return pool[pool.length - 1] ?? null;
}

function shouldPersistChatDb(): boolean {
	return toBool(process.env.PINOKIO_CHAT_DB_ENABLED, CHAT_DB_ENABLED_DEFAULT);
}

export async function persistChatFromTaskResult(input: {
	resource: string;
	task: string;
	target?: string;
	profile?: string;
	report: unknown;
}): Promise<void> {
	if (input.resource !== 'plugin:chat_agent') {
		return;
	}
	if (!shouldPersistChatDb()) {
		return;
	}

	const targetMeta = parseJsonOutput(input.target ?? '') as Record<string, unknown> | null;
	const op = asOptionalString(targetMeta?.op)?.toLowerCase();
	if (op === 'load_history') {
		return;
	}

	const channel = asOptionalString(targetMeta?.channel) || 'default';
	const userText = asOptionalString(targetMeta?.message) || asOptionalString(input.task);
	if (!userText) {
		return;
	}

	const assistant = extractAssistantCandidate(input.report);
	if (!assistant || !assistant.text) {
		return;
	}

	const connection = resolveConnection();
	ensureChatSchema(connection);
	const sessionId = findOrCreateSession(
		connection,
		channel,
		assistant.llmProfile || asOptionalString(input.profile)
	);

	const recent = listRecentMessages(connection, sessionId);
	let turn = nextTurnIndex(recent);
	let wroteMessage = false;

	const recentUser = recent.find((row) => row.role === 'user');
	const hasRecentUser = Boolean(
		recentUser && recentUser.content === userText && recentUser.turn_index >= turn - 3
	);
	if (!hasRecentUser) {
		insertMessage(connection, sessionId, 'user', userText, turn, {
			responseMode: asOptionalString(assistant.mode) || 'chat_api_postprocess_user',
			llmProfile: assistant.llmProfile || asOptionalString(input.profile)
		});
		turn += 1;
		wroteMessage = true;
	}

	const lastAssistant = recent.find((row) => row.role === 'assistant');
	if (lastAssistant && lastAssistant.content === assistant.text) {
		if (wroteMessage) {
			updateSessionCounters(connection, sessionId);
		}
		return;
	}

	insertMessage(connection, sessionId, 'assistant', assistant.text, turn, {
		responseMode: asOptionalString(assistant.mode) || 'chat_api_postprocess',
		routedResource: assistant.routedResource,
		routedAction: assistant.routedAction,
		llmProfile: assistant.llmProfile || asOptionalString(input.profile),
		llmProvider: assistant.llmProvider,
		llmModel: assistant.llmModel
	});
	wroteMessage = true;
	if (wroteMessage) {
		updateSessionCounters(connection, sessionId);
	}
}
