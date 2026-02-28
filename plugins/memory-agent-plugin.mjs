import { spawnSync } from 'node:child_process';
import { pluginContext, respond, fail } from '../sdk/typescript/pinokio-sdk.mjs';

const SUPPORTED_ACTIONS = new Set(['create', 'read', 'update', 'delete']);
const SUPPORTED_POLICIES = new Set(['owner', 'all', 'acl']);
const DEFAULT_READ_POLICY = 'all';
const DEFAULT_WRITE_POLICY = 'owner';
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 500;

function normalizeAction(value) {
	return String(value || '')
		.trim()
		.toLowerCase();
}

function parseTargetMeta(target) {
	if (typeof target !== 'string') {
		return {};
	}
	const trimmed = target.trim();
	if (!trimmed) {
		return {};
	}
	if (!trimmed.startsWith('{')) {
		return { query: trimmed };
	}
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed;
		}
		return {};
	} catch {
		return { query: trimmed };
	}
}

function normalizeActor(value) {
	const raw = String(value || '').trim();
	if (!raw) {
		return 'anonymous';
	}
	return raw.toLowerCase();
}

function defaultNamespaceForActor(actor) {
	const safe = String(actor || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	if (!safe) {
		return 'namespace_anonymous';
	}
	return `namespace_${safe}`;
}

function normalizeNamespace(value, fallbackActor) {
	const raw = String(value || '').trim();
	if (!raw) {
		return defaultNamespaceForActor(fallbackActor);
	}
	const safe = raw
		.toLowerCase()
		.replace(/[^a-z0-9_.:-]+/g, '_')
		.replace(/^_+|_+$/g, '');
	if (!safe) {
		return defaultNamespaceForActor(fallbackActor);
	}
	return safe;
}

function toInt(value, fallback, min, max) {
	const n = Number.parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(n)) {
		return fallback;
	}
	return Math.min(Math.max(n, min), max);
}

function asObject(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}
	return value;
}

function asStringArray(value) {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((item) => String(item ?? '').trim())
		.filter((item) => item.length > 0)
		.slice(0, 200);
}

function sqlQuote(value) {
	return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function sqlJson(value) {
	return `${sqlQuote(JSON.stringify(asObject(value)))}::jsonb`;
}

function sqlTextArray(values) {
	const list = asStringArray(values);
	if (list.length === 0) {
		return 'ARRAY[]::text[]';
	}
	return `ARRAY[${list.map(sqlQuote).join(',')}]::text[]`;
}

function firstNonEmptyLine(text) {
	for (const line of String(text || '').split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return null;
}

function resolveConnection(targetMeta) {
	const timeoutRaw = Number(targetMeta.timeout_ms);
	const timeoutMs = Number.isFinite(timeoutRaw)
		? Math.min(Math.max(Math.trunc(timeoutRaw), 1_000), 120_000)
		: 30_000;
	return {
		container:
			(typeof targetMeta.container === 'string' && targetMeta.container.trim()) ||
			process.env.PINOKIO_DB_CONTAINER ||
			'pinokio-postgres-main',
		database:
			(typeof targetMeta.database === 'string' && targetMeta.database.trim()) ||
			process.env.PINOKIO_DB_NAME ||
			process.env.PGDATABASE ||
			'pinokio',
		user:
			(typeof targetMeta.user === 'string' && targetMeta.user.trim()) ||
			process.env.PINOKIO_DB_USER ||
			process.env.PGUSER ||
			'pinokio',
		password:
			(typeof targetMeta.password === 'string' && targetMeta.password) ||
			process.env.PINOKIO_DB_PASSWORD ||
			process.env.PGPASSWORD ||
			'',
		timeoutMs
	};
}

function runSql(connection, sql, options = {}) {
	const args = ['exec', '-i'];
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
	if (options.tuplesOnly) {
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

function runJson(connection, sql) {
	const stdout = runSql(connection, sql, { tuplesOnly: true });
	const line = firstNonEmptyLine(stdout);
	if (!line) {
		return null;
	}
	try {
		return JSON.parse(line);
	} catch {
		throw new Error(`database returned invalid JSON: ${line.slice(0, 120)}`);
	}
}

function ensureSchema(connection) {
	runSql(
		connection,
		[
			'CREATE SCHEMA IF NOT EXISTS pinokio_memory;',
			`CREATE TABLE IF NOT EXISTS pinokio_memory.namespaces (
				namespace_key TEXT PRIMARY KEY,
				owner_actor TEXT NOT NULL,
				read_policy TEXT NOT NULL DEFAULT '${DEFAULT_READ_POLICY}',
				write_policy TEXT NOT NULL DEFAULT '${DEFAULT_WRITE_POLICY}',
				metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);`,
			`CREATE TABLE IF NOT EXISTS pinokio_memory.namespace_permissions (
				namespace_key TEXT NOT NULL REFERENCES pinokio_memory.namespaces(namespace_key) ON DELETE CASCADE,
				actor TEXT NOT NULL,
				can_read BOOLEAN NOT NULL DEFAULT false,
				can_create BOOLEAN NOT NULL DEFAULT false,
				can_update BOOLEAN NOT NULL DEFAULT false,
				can_delete BOOLEAN NOT NULL DEFAULT false,
				can_admin BOOLEAN NOT NULL DEFAULT false,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				PRIMARY KEY (namespace_key, actor)
			);`,
			`CREATE TABLE IF NOT EXISTS pinokio_memory.memories (
				id BIGSERIAL PRIMARY KEY,
				namespace_key TEXT NOT NULL REFERENCES pinokio_memory.namespaces(namespace_key) ON DELETE CASCADE,
				memory_key TEXT NOT NULL,
				content TEXT NOT NULL,
				metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
				tags TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
				source_actor TEXT NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				UNIQUE(namespace_key, memory_key)
			);`,
			'CREATE INDEX IF NOT EXISTS pka_memories_namespace_updated_idx ON pinokio_memory.memories (namespace_key, updated_at DESC);',
			'CREATE INDEX IF NOT EXISTS pka_memories_tags_idx ON pinokio_memory.memories USING GIN (tags);',
			"CREATE INDEX IF NOT EXISTS pka_memories_content_fts_idx ON pinokio_memory.memories USING GIN (to_tsvector('simple', content));"
		].join('\n')
	);
}

function normalizePolicy(value, fallback) {
	const normalized = String(value || '')
		.trim()
		.toLowerCase();
	if (SUPPORTED_POLICIES.has(normalized)) {
		return normalized;
	}
	return fallback;
}

function parsePermissions(targetMeta) {
	const raw = targetMeta.permissions;
	const byName = { read: false, create: false, update: false, delete: false, admin: false };
	if (Array.isArray(raw)) {
		for (const value of raw) {
			const key = String(value || '')
				.trim()
				.toLowerCase();
			if (key in byName) {
				byName[key] = true;
			}
		}
		return byName;
	}
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		const obj = raw;
		byName.read = obj.read === true;
		byName.create = obj.create === true;
		byName.update = obj.update === true;
		byName.delete = obj.delete === true;
		byName.admin = obj.admin === true;
	}
	return byName;
}

function loadNamespaceAccess(connection, namespace, actor) {
	return runJson(
		connection,
		`WITH ns AS (
			SELECT
				n.namespace_key,
				n.owner_actor,
				n.read_policy,
				n.write_policy,
				n.metadata,
				COALESCE(p.can_read, false) AS can_read,
				COALESCE(p.can_create, false) AS can_create,
				COALESCE(p.can_update, false) AS can_update,
				COALESCE(p.can_delete, false) AS can_delete,
				COALESCE(p.can_admin, false) AS can_admin
			FROM pinokio_memory.namespaces n
			LEFT JOIN pinokio_memory.namespace_permissions p
				ON p.namespace_key = n.namespace_key
				AND p.actor = ${sqlQuote(actor)}
			WHERE n.namespace_key = ${sqlQuote(namespace)}
		)
		SELECT COALESCE((SELECT row_to_json(ns)::text FROM ns), 'null');`
	);
}

function createNamespaceIfMissing(connection, namespace, actor, targetMeta) {
	const readPolicy = normalizePolicy(targetMeta.read_policy, DEFAULT_READ_POLICY);
	const writePolicy = normalizePolicy(targetMeta.write_policy, DEFAULT_WRITE_POLICY);
	const metadata = asObject(targetMeta.namespace_metadata ?? targetMeta.metadata);

	runSql(
		connection,
		`INSERT INTO pinokio_memory.namespaces (
			namespace_key,
			owner_actor,
			read_policy,
			write_policy,
			metadata,
			created_at,
			updated_at
		) VALUES (
			${sqlQuote(namespace)},
			${sqlQuote(actor)},
			${sqlQuote(readPolicy)},
			${sqlQuote(writePolicy)},
			${sqlJson(metadata)},
			now(),
			now()
		)
		ON CONFLICT (namespace_key) DO NOTHING;`
	);
}

function canPerform(namespaceAccess, actor, capability) {
	if (!namespaceAccess) {
		return false;
	}

	const asBool = (value) =>
		value === true ||
		value === 'true' ||
		value === 't' ||
		value === 1 ||
		value === '1';
	const isOwner = namespaceAccess.owner_actor === actor;
	const canAdmin = isOwner || asBool(namespaceAccess.can_admin);
	if (capability === 'read') {
		if (canAdmin || asBool(namespaceAccess.can_read)) {
			return true;
		}
		if (namespaceAccess.read_policy === 'all') {
			return true;
		}
		if (namespaceAccess.read_policy === 'owner') {
			return isOwner;
		}
		return false;
	}

	if (canAdmin) {
		return true;
	}
	const specific =
		capability === 'create'
			? asBool(namespaceAccess.can_create)
			: capability === 'update'
				? asBool(namespaceAccess.can_update)
				: asBool(namespaceAccess.can_delete);
	if (specific) {
		return true;
	}
	if (namespaceAccess.write_policy === 'all') {
		return true;
	}
	if (namespaceAccess.write_policy === 'owner') {
		return isOwner;
	}
	return false;
}

function hasAdmin(namespaceAccess, actor) {
	if (!namespaceAccess) {
		return false;
	}
	return (
		namespaceAccess.owner_actor === actor ||
		namespaceAccess.can_admin === true ||
		namespaceAccess.can_admin === 'true' ||
		namespaceAccess.can_admin === 't' ||
		namespaceAccess.can_admin === 1 ||
		namespaceAccess.can_admin === '1'
	);
}

function requireCapability(namespaceAccess, actor, capability, namespace) {
	if (!canPerform(namespaceAccess, actor, capability)) {
		fail(`actor '${actor}' is not allowed to ${capability} namespace '${namespace}'`);
	}
}

function resolveActor(request, targetMeta) {
	return normalizeActor(
		targetMeta.actor ||
			request.caller_resource ||
			request.caller_agent_id ||
			request.llm_profile ||
			process.env.PINOKIO_MEMORY_ACTOR ||
			'anonymous'
	);
}

function resolveNamespace(targetMeta, actor) {
	return normalizeNamespace(targetMeta.namespace, actor);
}

function ensureNamespaceForAction(connection, actor, namespace, action, targetMeta) {
	createNamespaceIfMissing(connection, namespace, actor, targetMeta);
	const access = loadNamespaceAccess(connection, namespace, actor);
	if (!access) {
		fail(`namespace '${namespace}' was not found`);
	}
	requireCapability(access, actor, action, namespace);
	return access;
}

function listReadableNamespaces(connection, actor) {
	const sql = `SELECT COALESCE(json_agg(row_to_json(t))::text, '[]')
	FROM (
		SELECT
			n.namespace_key,
			n.owner_actor,
			n.read_policy,
			n.write_policy,
			n.metadata,
			n.created_at,
			n.updated_at,
			(n.owner_actor = ${sqlQuote(actor)}) AS is_owner,
			COALESCE(p.can_read, false) AS can_read,
			COALESCE(p.can_create, false) AS can_create,
			COALESCE(p.can_update, false) AS can_update,
			COALESCE(p.can_delete, false) AS can_delete,
			COALESCE(p.can_admin, false) AS can_admin
		FROM pinokio_memory.namespaces n
		LEFT JOIN pinokio_memory.namespace_permissions p
			ON p.namespace_key = n.namespace_key
			AND p.actor = ${sqlQuote(actor)}
		WHERE
			n.owner_actor = ${sqlQuote(actor)}
			OR n.read_policy = 'all'
			OR COALESCE(p.can_read, false)
			OR COALESCE(p.can_admin, false)
		ORDER BY n.namespace_key
		LIMIT 500
	) t;`;
	const rows = runJson(connection, sql);
	return Array.isArray(rows) ? rows : [];
}

function memoryRowProjection(alias = 'm') {
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

function runReadAction(connection, request, actor, targetMeta) {
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

	const namespaceInput = typeof targetMeta.namespace === 'string' ? targetMeta.namespace : '';
	const namespace = namespaceInput ? normalizeNamespace(namespaceInput, actor) : null;
	const key = typeof targetMeta.key === 'string' ? targetMeta.key.trim() : '';
	const id = Number.isFinite(Number(targetMeta.id)) ? Math.trunc(Number(targetMeta.id)) : null;
	const query = typeof targetMeta.query === 'string' ? targetMeta.query.trim() : '';
	const tag = typeof targetMeta.tag === 'string' ? targetMeta.tag.trim() : '';
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

	let readableNamespaces = [];
	if (namespace) {
		const access = loadNamespaceAccess(connection, namespace, actor);
		if (!access) {
			fail(`namespace '${namespace}' was not found`);
		}
		requireCapability(access, actor, 'read', namespace);
		readableNamespaces = [namespace];
	} else {
		const rows = listReadableNamespaces(connection, actor);
		readableNamespaces = rows.map((row) => row.namespace_key).filter((value) => typeof value === 'string');
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

function runGrantOperation(connection, actor, targetMeta) {
	const namespace = resolveNamespace(targetMeta, actor);
	const access = ensureNamespaceForAction(connection, actor, namespace, 'update', targetMeta);
	if (!canPerform(access, actor, 'update') || !hasAdmin(access, actor)) {
		fail(`actor '${actor}' is not allowed to change permissions on '${namespace}'`);
	}

	const targetActor = normalizeActor(targetMeta.target_actor || targetMeta.actor_id || targetMeta.actor_name);
	if (!targetActor || targetActor === 'anonymous') {
		fail('grant/revoke requires target_actor');
	}
	const perms = parsePermissions(targetMeta);
	if (targetMeta.op === 'revoke') {
		runSql(
			connection,
			`DELETE FROM pinokio_memory.namespace_permissions
			WHERE namespace_key = ${sqlQuote(namespace)}
				AND actor = ${sqlQuote(targetActor)};`
		);
		return {
			op: 'revoke',
			actor,
			namespace,
			target_actor: targetActor,
			revoked: true
		};
	}

	runSql(
		connection,
		`INSERT INTO pinokio_memory.namespace_permissions (
			namespace_key,
			actor,
			can_read,
			can_create,
			can_update,
			can_delete,
			can_admin,
			created_at,
			updated_at
		) VALUES (
			${sqlQuote(namespace)},
			${sqlQuote(targetActor)},
			${perms.read ? 'true' : 'false'},
			${perms.create ? 'true' : 'false'},
			${perms.update ? 'true' : 'false'},
			${perms.delete ? 'true' : 'false'},
			${perms.admin ? 'true' : 'false'},
			now(),
			now()
		)
		ON CONFLICT (namespace_key, actor) DO UPDATE SET
			can_read = EXCLUDED.can_read,
			can_create = EXCLUDED.can_create,
			can_update = EXCLUDED.can_update,
			can_delete = EXCLUDED.can_delete,
			can_admin = EXCLUDED.can_admin,
			updated_at = now();`
	);

	return {
		op: 'grant',
		actor,
		namespace,
		target_actor: targetActor,
		permissions: perms
	};
}

function runSetPolicyOperation(connection, actor, targetMeta) {
	const namespace = resolveNamespace(targetMeta, actor);
	const access = ensureNamespaceForAction(connection, actor, namespace, 'update', targetMeta);
	if (!hasAdmin(access, actor)) {
		fail(`actor '${actor}' is not allowed to set policy on '${namespace}'`);
	}

	const readPolicy = normalizePolicy(targetMeta.read_policy, access.read_policy || DEFAULT_READ_POLICY);
	const writePolicy = normalizePolicy(targetMeta.write_policy, access.write_policy || DEFAULT_WRITE_POLICY);
	runSql(
		connection,
		`UPDATE pinokio_memory.namespaces
		SET read_policy = ${sqlQuote(readPolicy)},
			write_policy = ${sqlQuote(writePolicy)},
			updated_at = now()
		WHERE namespace_key = ${sqlQuote(namespace)};`
	);

	const updated = loadNamespaceAccess(connection, namespace, actor);
	return {
		op: 'set_policy',
		actor,
		namespace,
		policy: {
			read_policy: updated?.read_policy ?? readPolicy,
			write_policy: updated?.write_policy ?? writePolicy
		}
	};
}

function runCreateMemory(connection, request, actor, targetMeta) {
	const op = String(targetMeta.op || '').trim().toLowerCase();
	if (op === 'grant' || op === 'revoke') {
		return runGrantOperation(connection, actor, targetMeta);
	}
	if (op === 'set_policy') {
		return runSetPolicyOperation(connection, actor, targetMeta);
	}

	const namespace = resolveNamespace(targetMeta, actor);
	ensureNamespaceForAction(connection, actor, namespace, 'create', targetMeta);

	const keyRaw = typeof targetMeta.key === 'string' ? targetMeta.key.trim() : '';
	const key = keyRaw || `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	const content =
		(typeof targetMeta.content === 'string' && targetMeta.content.trim()) ||
		(typeof targetMeta.text === 'string' && targetMeta.text.trim()) ||
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

function runUpdateMemory(connection, actor, targetMeta) {
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
	const key = typeof targetMeta.key === 'string' ? targetMeta.key.trim() : '';
	if (id === null && !key) {
		fail('memory update requires id or key');
	}

	const hasContent = typeof targetMeta.content === 'string' || typeof targetMeta.text === 'string';
	const nextContent =
		typeof targetMeta.content === 'string'
			? targetMeta.content
			: typeof targetMeta.text === 'string'
				? targetMeta.text
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

function runDeleteMemory(connection, actor, targetMeta) {
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
	const key = typeof targetMeta.key === 'string' ? targetMeta.key.trim() : '';
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

try {
	const { request } = pluginContext();
	const action = normalizeAction(request.action);
	if (!SUPPORTED_ACTIONS.has(action)) {
		fail(`unsupported action '${action}' for memory_agent`);
	}

	const targetMeta = parseTargetMeta(request.target);
	const connection = resolveConnection(targetMeta);
	ensureSchema(connection);

	const actor = resolveActor(request, targetMeta);
	let result;
	if (action === 'read') {
		result = runReadAction(connection, request, actor, targetMeta);
	} else if (action === 'create') {
		result = runCreateMemory(connection, request, actor, targetMeta);
	} else if (action === 'update') {
		result = runUpdateMemory(connection, actor, targetMeta);
	} else {
		result = runDeleteMemory(connection, actor, targetMeta);
	}

	respond({
		ok: true,
		plugin: 'memory_agent',
		action,
		actor,
		container: connection.container,
		database: connection.database,
		result
	});
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
