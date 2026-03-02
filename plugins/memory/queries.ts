/**
 * CRUD query handlers for the memory plugin.
 *
 * Extracted from index.ts to keep the main entry-point focused on
 * request dispatch and schema bootstrapping.
 */

import { fail } from '../../sdk/typescript/pinokio-sdk.ts';
import type { PluginRequest } from '../../sdk/typescript/pinokio-sdk.ts';
import { toInt } from '../plugin-utils.ts';
import {
	runJson,
	sqlQuote,
	sqlJson,
	sqlTextArray,
	asObject,
	asStringArray
} from '../database/db-common.ts';
import type { DbConnection } from '../database/db-common.ts';
import {
	runSql,
	normalizeNamespace,
	loadNamespaceAccess,
	requireCapability,
	listReadableNamespaces,
	resolveNamespace,
	ensureNamespaceForAction,
	runGrantOperation,
	runSetPolicyOperation,
	hasAdmin
} from './index.ts';
import type { TargetMeta } from './index.ts';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export function memoryRowProjection(alias: string = 'm'): string {
	return `json_build_object(
		'id', ${alias}.id,
		'namespace', ${alias}.namespace_key,
		'key', ${alias}.memory_key,
		'content', ${alias}.content,
		'metadata', ${alias}.metadata,
		'tags', ${alias}.tags,
		'source_actor', ${alias}.source_actor,
		'created_at', ${alias}.created_at,
		'updated_at', ${alias}.updated_at
	)`;
}

/* ------------------------------------------------------------------ */
/*  READ                                                               */
/* ------------------------------------------------------------------ */

export function runReadAction(connection: DbConnection, request: PluginRequest, actor: string, targetMeta: TargetMeta): Record<string, unknown> {
	const op = String(targetMeta.op || '').trim().toLowerCase();
	if (op === 'list_namespaces') {
		const namespaces = listReadableNamespaces(connection, actor);
		return {
			op: 'list_namespaces',
			actor,
			count: namespaces.length,
			namespaces
		};
	}

	if (op === 'chat_recall') {
		const chatQuery = typeof targetMeta.query === 'string' ? (targetMeta.query as string).trim() : '';
		const chatLimit = toInt(targetMeta.limit, 20, 1, 100);
		const minImportance = toInt(targetMeta.min_importance, 1, 0, 3);
		const chatChannel = typeof targetMeta.channel === 'string' ? (targetMeta.channel as string).trim() : '';
		const conditions: string[] = [
			'm.flagged_for_memory = true',
			`m.importance >= ${minImportance}`,
		];
		if (chatQuery) {
			conditions.push(`(to_tsvector('simple', m.content) @@ plainto_tsquery('simple', ${sqlQuote(chatQuery)}) OR m.content ILIKE ${sqlQuote('%' + chatQuery + '%')})`);
		}
		if (chatChannel) {
			conditions.push(`s.channel = ${sqlQuote(chatChannel)}`);
		}
		const items = runJson(
			connection,
			`SELECT COALESCE(json_agg(row_to_json(t))::text, '[]')
			FROM (
				SELECT
					m.id AS message_id,
					m.content,
					m.role,
					m.importance,
					m.tags,
					m.created_at,
					m.routed_resource,
					m.response_mode,
					s.session_key,
					s.channel,
					s.agent_id,
					s.id AS session_id,
					s.message_count AS session_message_count
				FROM pinokio_chat.messages m
				JOIN pinokio_chat.sessions s ON s.id = m.session_id
				WHERE ${conditions.join(' AND ')}
				ORDER BY m.importance DESC, m.created_at DESC
				LIMIT ${chatLimit}
			) t;`
		);
		return {
			op: 'chat_recall',
			actor,
			count: Array.isArray(items) ? items.length : 0,
			items: Array.isArray(items) ? items : [],
			hint: 'Use session_id with op=chat_context to retrieve full conversation context'
		};
	}

	if (op === 'chat_context') {
		const sessionId = Number(targetMeta.session_id);
		if (!Number.isFinite(sessionId)) {
			fail('chat_context requires session_id (integer)');
		}
		const session = runJson(
			connection,
			`SELECT COALESCE(
				(SELECT row_to_json(s)::text FROM pinokio_chat.sessions s WHERE s.id = ${sessionId}),
				'null'
			);`
		);
		const messages = runJson(
			connection,
			`SELECT COALESCE(
				(SELECT json_agg(row_to_json(t))::text
				 FROM (
					SELECT * FROM pinokio_chat.messages
					WHERE session_id = ${sessionId}
					ORDER BY turn_index ASC
				 ) t),
				'[]'
			);`
		);
		return {
			op: 'chat_context',
			actor,
			session,
			messages: Array.isArray(messages) ? messages : [],
			message_count: Array.isArray(messages) ? messages.length : 0
		};
	}

	const DEFAULT_LIMIT = 30;
	const MAX_LIMIT = 500;

	const namespaceInput = typeof targetMeta.namespace === 'string' ? targetMeta.namespace as string : '';
	const namespace = namespaceInput ? normalizeNamespace(namespaceInput, actor) : null;
	const key = typeof targetMeta.key === 'string' ? (targetMeta.key as string).trim() : '';
	const id = Number.isFinite(Number(targetMeta.id)) ? Math.trunc(Number(targetMeta.id)) : null;
	const query = typeof targetMeta.query === 'string' ? (targetMeta.query as string).trim() : '';
	const tag = typeof targetMeta.tag === 'string' ? (targetMeta.tag as string).trim() : '';
	const limit = toInt(targetMeta.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);

	if (namespace && (key || id !== null || op === 'get')) {
		const access = loadNamespaceAccess(connection, namespace, actor);
		if (!access) {
			fail(`namespace '${namespace}' was not found`);
		}
		requireCapability(access, actor, 'read', namespace);
		const whereClause = id !== null ? `m.id = ${id}` : `m.memory_key = ${sqlQuote(key)}`;
		const item = runJson(
			connection,
			`SELECT COALESCE((
				SELECT ${memoryRowProjection('m')}::text
				FROM pinokio_memory.memories m
				WHERE m.namespace_key = ${sqlQuote(namespace)}
					AND ${whereClause}
				LIMIT 1
			), 'null');`
		);
		return {
			op: 'get',
			actor,
			namespace,
			item
		};
	}

	let readableNamespaces: string[] = [];
	if (namespace) {
		const access = loadNamespaceAccess(connection, namespace, actor);
		if (!access) {
			fail(`namespace '${namespace}' was not found`);
		}
		requireCapability(access, actor, 'read', namespace);
		readableNamespaces = [namespace];
	} else {
		const rows = listReadableNamespaces(connection, actor);
		readableNamespaces = rows.map((row) => row.namespace_key as string).filter((value) => typeof value === 'string');
	}

	if (readableNamespaces.length === 0) {
		return {
			op: 'search',
			actor,
			namespace: namespace || null,
			count: 0,
			items: []
		};
	}

	const nsArraySql = `ARRAY[${readableNamespaces.map(sqlQuote).join(',')}]::text[]`;
	const hasQuery = query.length > 0;
	const queryLike = `%${query}%`;
	const queryPredicate = hasQuery
		? `(
			m.content ILIKE ${sqlQuote(queryLike)}
			OR m.memory_key ILIKE ${sqlQuote(queryLike)}
			OR m.metadata::text ILIKE ${sqlQuote(queryLike)}
			OR to_tsvector('simple', m.content) @@ plainto_tsquery('simple', ${sqlQuote(query)})
		)`
		: 'TRUE';
	const tagPredicate = tag ? `${sqlQuote(tag)} = ANY(m.tags)` : 'TRUE';

	const items = runJson(
		connection,
		`SELECT COALESCE(json_agg(row_to_json(t))::text, '[]')
		FROM (
			SELECT
				m.id,
				m.namespace_key AS namespace,
				m.memory_key AS key,
				m.content,
				m.metadata,
				m.tags,
				m.source_actor,
				m.created_at,
				m.updated_at
			FROM pinokio_memory.memories m
			WHERE m.namespace_key = ANY(${nsArraySql})
				AND ${queryPredicate}
				AND ${tagPredicate}
			ORDER BY m.updated_at DESC
			LIMIT ${limit}
		) t;`
	);

	return {
		op: 'search',
		actor,
		namespace: namespace || null,
		count: Array.isArray(items) ? items.length : 0,
		items: Array.isArray(items) ? items : []
	};
}

/* ------------------------------------------------------------------ */
/*  CREATE                                                             */
/* ------------------------------------------------------------------ */

export function runCreateMemory(connection: DbConnection, request: PluginRequest, actor: string, targetMeta: TargetMeta): Record<string, unknown> {
	const op = String(targetMeta.op || '').trim().toLowerCase();
	if (op === 'grant' || op === 'revoke') {
		return runGrantOperation(connection, actor, targetMeta);
	}
	if (op === 'set_policy') {
		return runSetPolicyOperation(connection, actor, targetMeta);
	}

	if (op === 'remember_from_chat') {
		const messageId = Number(targetMeta.message_id);
		const sessionId = Number(targetMeta.session_id);
		if (!Number.isFinite(messageId) || !Number.isFinite(sessionId)) {
			fail('remember_from_chat requires message_id and session_id (integers)');
		}
		const chatContent =
			(typeof targetMeta.content === 'string' && (targetMeta.content as string).trim()) ||
			(typeof targetMeta.text === 'string' && (targetMeta.text as string).trim()) ||
			String(request.summary || '').trim();
		if (!chatContent) {
			fail('remember_from_chat requires content/text');
		}
		const chatNamespace = resolveNamespace(targetMeta, actor);
		ensureNamespaceForAction(connection, actor, chatNamespace, 'create', targetMeta);
		const chatKey = typeof targetMeta.key === 'string' && (targetMeta.key as string).trim()
			? (targetMeta.key as string).trim()
			: `chat_${sessionId}_${messageId}_${Date.now().toString(36)}`;
		const chatMetadata = asObject(targetMeta.metadata);
		const chatTags = asStringArray(targetMeta.tags);

		// Create the memory entry
		const memItem = runJson(
			connection,
			`WITH upserted AS (
				INSERT INTO pinokio_memory.memories (
					namespace_key, memory_key, content, metadata, tags, source_actor,
					created_at, updated_at
				) VALUES (
					${sqlQuote(chatNamespace)}, ${sqlQuote(chatKey)}, ${sqlQuote(chatContent)},
					${sqlJson(chatMetadata)}, ${sqlTextArray(chatTags)}, ${sqlQuote(actor)},
					now(), now()
				)
				ON CONFLICT (namespace_key, memory_key) DO UPDATE SET
					content = EXCLUDED.content, metadata = EXCLUDED.metadata,
					tags = EXCLUDED.tags, source_actor = EXCLUDED.source_actor,
					updated_at = now()
				RETURNING *
			)
			SELECT COALESCE((SELECT ${memoryRowProjection('upserted')}::text FROM upserted LIMIT 1), 'null');`
		);

		// Create cross-reference in pinokio_chat.memory_refs
		try {
			runSql(
				connection,
				`INSERT INTO pinokio_chat.memory_refs (
					message_id, session_id, memory_namespace, memory_key,
					ref_type, excerpt
				) VALUES (
					${messageId}, ${sessionId}, ${sqlQuote(chatNamespace)}, ${sqlQuote(chatKey)},
					'excerpt', ${sqlQuote(chatContent.slice(0, 500))}
				)
				ON CONFLICT (message_id, memory_namespace, memory_key) DO NOTHING;`
			);
		} catch {
			// Cross-ref creation is best-effort; pinokio_chat schema may not exist
		}

		return {
			op: 'remember_from_chat',
			actor,
			namespace: chatNamespace,
			memory_key: chatKey,
			message_id: messageId,
			session_id: sessionId,
			item: memItem
		};
	}

	const namespace = resolveNamespace(targetMeta, actor);
	ensureNamespaceForAction(connection, actor, namespace, 'create', targetMeta);

	const keyRaw = typeof targetMeta.key === 'string' ? (targetMeta.key as string).trim() : '';
	const key = keyRaw || `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	const content =
		(typeof targetMeta.content === 'string' && (targetMeta.content as string).trim()) ||
		(typeof targetMeta.text === 'string' && (targetMeta.text as string).trim()) ||
		String(request.summary || '').trim();
	if (!content) {
		fail('memory create requires content/text or non-empty task summary');
	}
	const metadata = asObject(targetMeta.metadata);
	const tags = asStringArray(targetMeta.tags);

	const item = runJson(
		connection,
		`WITH upserted AS (
			INSERT INTO pinokio_memory.memories (
				namespace_key,
				memory_key,
				content,
				metadata,
				tags,
				source_actor,
				created_at,
				updated_at
			) VALUES (
				${sqlQuote(namespace)},
				${sqlQuote(key)},
				${sqlQuote(content)},
				${sqlJson(metadata)},
				${sqlTextArray(tags)},
				${sqlQuote(actor)},
				now(),
				now()
			)
			ON CONFLICT (namespace_key, memory_key) DO UPDATE SET
				content = EXCLUDED.content,
				metadata = EXCLUDED.metadata,
				tags = EXCLUDED.tags,
				source_actor = EXCLUDED.source_actor,
				updated_at = now()
			RETURNING *
		)
		SELECT COALESCE((SELECT ${memoryRowProjection('upserted')}::text FROM upserted LIMIT 1), 'null');`
	);
	if (!item) {
		fail(`failed to upsert memory key '${key}' in namespace '${namespace}'`);
	}

	return {
		op: 'remember',
		actor,
		namespace,
		item
	};
}

/* ------------------------------------------------------------------ */
/*  UPDATE                                                             */
/* ------------------------------------------------------------------ */

export function runUpdateMemory(connection: DbConnection, actor: string, targetMeta: TargetMeta): Record<string, unknown> {
	const op = String(targetMeta.op || '').trim().toLowerCase();
	if (op === 'grant' || op === 'revoke') {
		return runGrantOperation(connection, actor, targetMeta);
	}
	if (op === 'set_policy') {
		return runSetPolicyOperation(connection, actor, targetMeta);
	}

	const namespace = resolveNamespace(targetMeta, actor);
	ensureNamespaceForAction(connection, actor, namespace, 'update', targetMeta);

	const id = Number.isFinite(Number(targetMeta.id)) ? Math.trunc(Number(targetMeta.id)) : null;
	const key = typeof targetMeta.key === 'string' ? (targetMeta.key as string).trim() : '';
	if (id === null && !key) {
		fail('memory update requires id or key');
	}

	const hasContent = typeof targetMeta.content === 'string' || typeof targetMeta.text === 'string';
	const nextContent =
		typeof targetMeta.content === 'string'
			? targetMeta.content as string
			: typeof targetMeta.text === 'string'
				? targetMeta.text as string
				: '';
	const hasMetadata = targetMeta.metadata && typeof targetMeta.metadata === 'object' && !Array.isArray(targetMeta.metadata);
	const hasTags = Array.isArray(targetMeta.tags);
	if (!hasContent && !hasMetadata && !hasTags) {
		fail('memory update requires at least one of content, metadata, or tags');
	}

	const whereClause = id !== null ? `id = ${id}` : `memory_key = ${sqlQuote(key)}`;
	const row = runJson(
		connection,
		`WITH updated AS (
			UPDATE pinokio_memory.memories
			SET
				content = ${hasContent ? sqlQuote(nextContent) : 'content'},
				metadata = ${hasMetadata ? sqlJson(targetMeta.metadata) : 'metadata'},
				tags = ${hasTags ? sqlTextArray(targetMeta.tags) : 'tags'},
				updated_at = now(),
				source_actor = ${sqlQuote(actor)}
			WHERE namespace_key = ${sqlQuote(namespace)}
				AND ${whereClause}
			RETURNING *
		)
		SELECT COALESCE((SELECT ${memoryRowProjection('updated')}::text FROM updated LIMIT 1), 'null');`
	);
	if (!row) {
		fail(`memory record not found in namespace '${namespace}'`);
	}

	return {
		op: 'update_memory',
		actor,
		namespace,
		item: row
	};
}

/* ------------------------------------------------------------------ */
/*  DELETE                                                             */
/* ------------------------------------------------------------------ */

export function runDeleteMemory(connection: DbConnection, actor: string, targetMeta: TargetMeta): Record<string, unknown> {
	const op = String(targetMeta.op || '').trim().toLowerCase();
	const namespace = resolveNamespace(targetMeta, actor);
	ensureNamespaceForAction(connection, actor, namespace, 'delete', targetMeta);

	if (op === 'delete_namespace' || op === 'namespace') {
		const access = loadNamespaceAccess(connection, namespace, actor);
		if (!(access && hasAdmin(access, actor))) {
			fail(`actor '${actor}' is not allowed to delete namespace '${namespace}'`);
		}
		const deleted = runJson(
			connection,
			`WITH gone AS (
				DELETE FROM pinokio_memory.namespaces
				WHERE namespace_key = ${sqlQuote(namespace)}
				RETURNING namespace_key, owner_actor
			)
			SELECT COALESCE((
				SELECT json_build_object('namespace', namespace_key, 'owner_actor', owner_actor)::text
				FROM gone
				LIMIT 1
			), 'null');`
		);
		return {
			op: 'delete_namespace',
			actor,
			namespace,
			deleted
		};
	}

	const id = Number.isFinite(Number(targetMeta.id)) ? Math.trunc(Number(targetMeta.id)) : null;
	const key = typeof targetMeta.key === 'string' ? (targetMeta.key as string).trim() : '';
	if (id === null && !key) {
		fail('memory delete requires id or key');
	}
	const whereClause = id !== null ? `id = ${id}` : `memory_key = ${sqlQuote(key)}`;

	const deleted = runJson(
		connection,
		`WITH gone AS (
			DELETE FROM pinokio_memory.memories
			WHERE namespace_key = ${sqlQuote(namespace)}
				AND ${whereClause}
			RETURNING *
		)
		SELECT COALESCE((SELECT ${memoryRowProjection('gone')}::text FROM gone LIMIT 1), 'null');`
	);
	if (!deleted) {
		fail(`memory record not found in namespace '${namespace}'`);
	}

	return {
		op: 'delete_memory',
		actor,
		namespace,
		item: deleted
	};
}
