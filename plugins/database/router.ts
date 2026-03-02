import { pluginContext, spawnChild, fail } from '../../sdk/typescript/pinokio-sdk.ts';
import type { PluginRequest } from '../../sdk/typescript/pinokio-sdk.ts';
import { normalizeAction, parseTargetMeta } from '../plugin-utils.ts';

const SUPPORTED_ACTIONS: Set<string> = new Set(['create', 'read', 'update', 'delete']);

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

function normalizeResource(value: unknown): string {
	const resource: string = String(value || '').trim();
	if (!resource) {
		return '';
	}
	if (!resource.startsWith('plugin:')) {
		fail(`resource '${resource}' must be a plugin resource`);
	}
	return resource;
}

function isReservedDbRoleResource(resource: string): boolean {
	return (
		resource === 'plugin:db_router_agent' ||
		resource === 'plugin:db_read_agent' ||
		resource === 'plugin:db_write_agent' ||
		resource === 'plugin:db_create_agent' ||
		resource === 'plugin:db_update_agent' ||
		resource === 'plugin:db_delete_agent'
	);
}

function resolveDelegateResource(request: PluginRequest, targetMeta: Record<string, unknown>): string {
	const explicit: string = normalizeResource(targetMeta.delegate_resource || targetMeta.resource);
	if (explicit) {
		if (isReservedDbRoleResource(explicit)) {
			fail(`delegate_resource '${explicit}' cannot be a db role/router resource`);
		}
		return explicit;
	}

	if (request.resource && !isReservedDbRoleResource(request.resource)) {
		const fromRequest: string = normalizeResource(request.resource);
		if (fromRequest) {
			return fromRequest;
		}
	}

	return 'plugin:postgres_agent';
}

function resolveSplitMode(targetMeta: Record<string, unknown>): string {
	const mode: string = String(targetMeta.split_mode || process.env.PINOKIO_DB_SPLIT_MODE || 'read_write')
		.trim()
		.toLowerCase();
	return mode === 'crud' ? 'crud' : 'read_write';
}

function resolveRoleResource(action: string, splitMode: string, targetMeta: Record<string, unknown>): string {
	if (splitMode === 'crud') {
		const createResource: string =
			normalizeResource(targetMeta.create_resource || process.env.PINOKIO_DB_CREATE_RESOURCE) ||
			'plugin:db_create_agent';
		const readResource: string =
			normalizeResource(targetMeta.read_resource || process.env.PINOKIO_DB_READ_RESOURCE) ||
			'plugin:db_read_agent';
		const updateResource: string =
			normalizeResource(targetMeta.update_resource || process.env.PINOKIO_DB_UPDATE_RESOURCE) ||
			'plugin:db_update_agent';
		const deleteResource: string =
			normalizeResource(targetMeta.delete_resource || process.env.PINOKIO_DB_DELETE_RESOURCE) ||
			'plugin:db_delete_agent';
		if (action === 'create') return createResource;
		if (action === 'read') return readResource;
		if (action === 'update') return updateResource;
		return deleteResource;
	}

	const readResource: string =
		normalizeResource(targetMeta.read_resource || process.env.PINOKIO_DB_READ_RESOURCE) ||
		'plugin:db_read_agent';
	const writeResource: string =
		normalizeResource(targetMeta.write_resource || process.env.PINOKIO_DB_WRITE_RESOURCE) ||
		'plugin:db_write_agent';
	return action === 'read' ? readResource : writeResource;
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
	return clone;
}

function deriveDelegateTarget(request: PluginRequest, targetMeta: Record<string, unknown>): string | null {
	if (targetMeta.delegate_target !== undefined) {
		if (typeof targetMeta.delegate_target === 'string') {
			const trimmed: string = (targetMeta.delegate_target as string).trim();
			return trimmed.length > 0 ? trimmed : null;
		}
		return JSON.stringify(targetMeta.delegate_target);
	}

	const parsed: Record<string, unknown> | null = parseObjectJson(request.target);
	if (parsed) {
		const cleaned: Record<string, unknown> = stripRouterFields(parsed);
		if (Object.keys(cleaned).length > 0) {
			return JSON.stringify(cleaned);
		}
		return null;
	}

	if (typeof request.target === 'string') {
		const trimmed: string = request.target.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	return null;
}

try {
	const { request }: { request: PluginRequest } = pluginContext();
	const action: string = normalizeAction(request.action);
	if (!SUPPORTED_ACTIONS.has(action)) {
		fail(`db_router_agent does not support action '${action}'`);
	}

	const targetMeta: Record<string, unknown> = parseTargetMeta(request.target);
	if (targetMeta.action && normalizeAction(targetMeta.action) !== action) {
		fail('target.action override is not allowed for db router');
	}

	const delegateResource: string = resolveDelegateResource(request, targetMeta);
	const splitMode: string = resolveSplitMode(targetMeta);
	const roleResource: string = resolveRoleResource(action, splitMode, targetMeta);
	if (!isReservedDbRoleResource(roleResource) || roleResource === 'plugin:db_router_agent') {
		fail(`role resource '${roleResource}' must be one of the db role agents`);
	}

	const delegateTarget: string | null = deriveDelegateTarget(request, targetMeta);
	const roleTarget: Record<string, unknown> = {
		delegate_resource: delegateResource,
		delegate_target: delegateTarget,
		split_mode: splitMode
	};

	spawnChild(
		{
			summary: String(request.summary || '').trim() || `db routed ${action}`,
			resource: roleResource,
			action,
			target: JSON.stringify(roleTarget),
			container_image: null,
			llm_profile:
				typeof request.llm_profile === 'string' && request.llm_profile.trim()
					? request.llm_profile.trim()
					: null
		},
		{
			ok: true,
			plugin: 'db_router_agent',
			action,
			split_mode: splitMode,
			role_resource: roleResource,
			delegate_resource: delegateResource
		}
	);
} catch (error: unknown) {
	fail(error instanceof Error ? error.message : String(error));
}
