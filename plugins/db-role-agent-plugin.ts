import { pluginContext, spawnChild, fail } from '../sdk/typescript/pinokio-sdk.ts';
import type { PluginRequest } from '../sdk/typescript/pinokio-sdk.ts';
import { parseTargetMeta, normalizeAction } from './plugin-utils.ts';

const ROLE_ACTIONS: Record<string, Set<string>> = {
	read: new Set(['read']),
	write: new Set(['create', 'update', 'delete']),
	create: new Set(['create']),
	update: new Set(['update']),
	delete: new Set(['delete']),
	all: new Set(['create', 'read', 'update', 'delete'])
};

function parseObjectJson(raw: unknown): Record<string, unknown> | null {
	if (typeof raw !== 'string') {
		return null;
	}
	const trimmed: string = raw.trim();
	if (!trimmed.startsWith('{')) {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		return null;
	}
	return null;
}

const RESERVED_RESOURCES: Set<string> = new Set([
	'plugin:db_router_agent',
	'plugin:db_read_agent',
	'plugin:db_write_agent',
	'plugin:db_create_agent',
	'plugin:db_update_agent',
	'plugin:db_delete_agent'
]);


function normalizeRole(value: unknown): string {
	const role: string = String(value || '')
		.trim()
		.toLowerCase();
	if (!ROLE_ACTIONS[role]) {
		fail(`unsupported db role '${role}'. expected read|write|create|update|delete|all`);
	}
	return role;
}

function ensureActionAllowed(role: string, action: string): void {
	if (!ROLE_ACTIONS[role].has(action)) {
		fail(`db role '${role}' does not allow action '${action}'`);
	}
}

function normalizeResource(value: unknown): string {
	const resource: string = String(value || '').trim();
	if (!resource) {
		return '';
	}
	if (!resource.startsWith('plugin:')) {
		fail(`delegate_resource must be a plugin resource (got '${resource}')`);
	}
	if (RESERVED_RESOURCES.has(resource)) {
		fail(`delegate_resource '${resource}' is a db role/router resource and would recurse`);
	}
	return resource;
}

function deriveDelegateResource(request: PluginRequest, targetMeta: Record<string, unknown>): string {
	const explicit: string = normalizeResource(targetMeta.delegate_resource || targetMeta.resource);
	if (explicit) {
		return explicit;
	}

	const fromRequest: string = normalizeResource(request.resource);
	if (fromRequest && !RESERVED_RESOURCES.has(fromRequest)) {
		return fromRequest;
	}

	return 'plugin:postgres_agent';
}

function stripRouterFields(obj: Record<string, unknown>): Record<string, unknown> {
	const clone: Record<string, unknown> = { ...obj };
	delete clone.delegate_resource;
	delete clone.delegate_target;
	delete clone.resource;
	delete clone.split_mode;
	delete clone.read_resource;
	delete clone.write_resource;
	delete clone.create_resource;
	delete clone.update_resource;
	delete clone.delete_resource;
	delete clone.action;
	delete clone.delegate_action;
	return clone;
}

function jsonIfNonEmptyObject(value: unknown): string | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	if (Object.keys(value as Record<string, unknown>).length === 0) {
		return null;
	}
	return JSON.stringify(value);
}

function stringifyDelegateTarget(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === 'string') {
		const trimmed: string = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	return JSON.stringify(value);
}

function deriveDelegateTarget(request: PluginRequest, targetMeta: Record<string, unknown>): string | null {
	const explicit: string | null = stringifyDelegateTarget(targetMeta.delegate_target);
	if (explicit) {
		return explicit;
	}

	const requestObj: Record<string, unknown> | null = parseObjectJson(request.target);
	if (requestObj) {
		return jsonIfNonEmptyObject(stripRouterFields(requestObj));
	}

	if (typeof request.target === 'string') {
		const trimmed: string = request.target.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	return null;
}

try {
	const { request }: { request: PluginRequest } = pluginContext();
	const role: string = normalizeRole(process.env.PINOKIO_DB_ROLE || 'read');
	const action: string = normalizeAction(request.action);
	if (!action) {
		fail('missing request action');
	}
	ensureActionAllowed(role, action);

	const targetMeta: Record<string, unknown> = parseTargetMeta(request.target);
	if (targetMeta.action && normalizeAction(targetMeta.action) !== action) {
		fail('target.action override is not allowed for db role agent');
	}
	if (targetMeta.delegate_action && normalizeAction(targetMeta.delegate_action) !== action) {
		fail('target.delegate_action override is not allowed for db role agent');
	}

	const delegateResource: string = deriveDelegateResource(request, targetMeta);
	const delegateTarget: string | null = deriveDelegateTarget(request, targetMeta);

	spawnChild(
		{
			summary: String(request.summary || '').trim() || `db role ${role} ${action}`,
			resource: delegateResource,
			action,
			target: delegateTarget,
			container_image: null,
			llm_profile:
				typeof request.llm_profile === 'string' && request.llm_profile.trim()
					? request.llm_profile.trim()
					: null
		},
		{
			ok: true,
			plugin: 'db_role_agent',
			role,
			action,
			delegate_resource: delegateResource
		}
	);
} catch (error: unknown) {
	fail(error instanceof Error ? error.message : String(error));
}
