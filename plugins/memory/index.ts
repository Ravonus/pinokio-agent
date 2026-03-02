import { pluginContext, respond, fail } from '../../sdk/typescript/pinokio-sdk.ts';
import type { PluginRequest } from '../../sdk/typescript/pinokio-sdk.ts';
import { normalizeAction } from '../plugin-utils.ts';
import {
	resolveDbConnection,
	runSql as runSqlBase,
	runJson,
	sqlQuote,
	sqlJson,
	asObject
} from '../database/db-common.ts';
import type { DbConnection } from '../database/db-common.ts';
import {
	runReadAction,
	runCreateMemory,
	runUpdateMemory,
	runDeleteMemory
} from './queries.ts';

const SUPPORTED_ACTIONS: Set<string> = new Set(['create', 'read', 'update', 'delete']);
const SUPPORTED_POLICIES: Set<string> = new Set(['owner', 'all', 'acl']);
const DEFAULT_READ_POLICY: string = 'all';
const DEFAULT_WRITE_POLICY: string = 'owner';

export interface TargetMeta {
	[key: string]: unknown;
}

export interface NamespaceAccess {
	namespace_key: string;
	owner_actor: string;
	read_policy: string;
	write_policy: string;
	metadata: Record<string, unknown>;
	can_read: boolean | string | number;
	can_create: boolean | string | number;
	can_update: boolean | string | number;
	can_delete: boolean | string | number;
	can_admin: boolean | string | number;
}

interface Permissions {
	read: boolean;
	create: boolean;
	update: boolean;
	delete: boolean;
	admin: boolean;
}

function parseTargetMeta(target: unknown): TargetMeta {
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
			return parsed as TargetMeta;
		}
		return {};
	} catch {
		return { query: trimmed };
	}
}

function normalizeActor(value: unknown): string {
	const raw = String(value || '').trim();
	if (!raw) {
		return 'anonymous';
	}
	return raw.toLowerCase();
}

function defaultNamespaceForActor(actor: string): string {
	const safe = String(actor || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '');
	if (!safe) {
		return 'namespace_anonymous';
	}
	return `namespace_${safe}`;
}

export function normalizeNamespace(value: unknown, fallbackActor: string): string {
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

export function runSql(connection: DbConnection, sql: string, options: { tuplesOnly?: boolean } = {}): string {
	return runSqlBase(connection, sql, options).stdout;
}

function ensureSchema(connection: DbConnection): void {
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

function normalizePolicy(value: unknown, fallback: string): string {
	const normalized = String(value || '')
		.trim()
		.toLowerCase();
	if (SUPPORTED_POLICIES.has(normalized)) {
		return normalized;
	}
	return fallback;
}

function parsePermissions(targetMeta: TargetMeta): Permissions {
	const raw = targetMeta.permissions;
	const byName: Permissions = { read: false, create: false, update: false, delete: false, admin: false };
	if (Array.isArray(raw)) {
		for (const value of raw) {
			const key = String(value || '')
				.trim()
				.toLowerCase() as keyof Permissions;
			if (key in byName) {
				byName[key] = true;
			}
		}
		return byName;
	}
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		const obj = raw as Record<string, unknown>;
		byName.read = obj.read === true;
		byName.create = obj.create === true;
		byName.update = obj.update === true;
		byName.delete = obj.delete === true;
		byName.admin = obj.admin === true;
	}
	return byName;
}

export function loadNamespaceAccess(connection: DbConnection, namespace: string, actor: string): NamespaceAccess | null {
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
	) as NamespaceAccess | null;
}

function createNamespaceIfMissing(connection: DbConnection, namespace: string, actor: string, targetMeta: TargetMeta): void {
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

function canPerform(namespaceAccess: NamespaceAccess | null, actor: string, capability: string): boolean {
	if (!namespaceAccess) {
		return false;
	}

	const asBool = (value: unknown): boolean =>
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

export function hasAdmin(namespaceAccess: NamespaceAccess | null, actor: string): boolean {
	if (!namespaceAccess) {
		return false;
	}
	return (
		namespaceAccess.owner_actor === actor ||
		namespaceAccess.can_admin === true ||
		namespaceAccess.can_admin === 'true' ||
		namespaceAccess.can_admin === ('t' as unknown as boolean) ||
		namespaceAccess.can_admin === (1 as unknown as boolean) ||
		namespaceAccess.can_admin === ('1' as unknown as boolean)
	);
}

export function requireCapability(namespaceAccess: NamespaceAccess | null, actor: string, capability: string, namespace: string): void {
	if (!canPerform(namespaceAccess, actor, capability)) {
		fail(`actor '${actor}' is not allowed to ${capability} namespace '${namespace}'`);
	}
}

function resolveActor(request: PluginRequest, targetMeta: TargetMeta): string {
	return normalizeActor(
		targetMeta.actor ||
			request.caller_resource ||
			request.caller_agent_id ||
			request.llm_profile ||
			process.env.PINOKIO_MEMORY_ACTOR ||
			'anonymous'
	);
}

export function resolveNamespace(targetMeta: TargetMeta, actor: string): string {
	return normalizeNamespace(targetMeta.namespace, actor);
}

export function ensureNamespaceForAction(connection: DbConnection, actor: string, namespace: string, action: string, targetMeta: TargetMeta): NamespaceAccess {
	createNamespaceIfMissing(connection, namespace, actor, targetMeta);
	const access = loadNamespaceAccess(connection, namespace, actor);
	if (!access) {
		fail(`namespace '${namespace}' was not found`);
	}
	requireCapability(access, actor, action, namespace);
	return access;
}

export function listReadableNamespaces(connection: DbConnection, actor: string): Record<string, unknown>[] {
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
	return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}

export function runGrantOperation(connection: DbConnection, actor: string, targetMeta: TargetMeta): Record<string, unknown> {
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

export function runSetPolicyOperation(connection: DbConnection, actor: string, targetMeta: TargetMeta): Record<string, unknown> {
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

try {
	const { request } = pluginContext();
	const action = normalizeAction(request.action);
	if (!SUPPORTED_ACTIONS.has(action)) {
		fail(`unsupported action '${action}' for memory_agent`);
	}

	const targetMeta = parseTargetMeta(request.target);
	const connection = resolveDbConnection(targetMeta);
	ensureSchema(connection);

	const actor = resolveActor(request, targetMeta);
	let result: Record<string, unknown>;
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
