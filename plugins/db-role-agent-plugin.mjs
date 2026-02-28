import { pluginContext, spawnChild, fail } from '../sdk/typescript/pinokio-sdk.mjs';

const ROLE_ACTIONS = {
	read: new Set(['read']),
	write: new Set(['create', 'update', 'delete']),
	create: new Set(['create']),
	update: new Set(['update']),
	delete: new Set(['delete']),
	all: new Set(['create', 'read', 'update', 'delete'])
};

const RESERVED_RESOURCES = new Set([
	'plugin:db_router_agent',
	'plugin:db_read_agent',
	'plugin:db_write_agent',
	'plugin:db_create_agent',
	'plugin:db_update_agent',
	'plugin:db_delete_agent'
]);

function normalizeAction(value) {
	return String(value || '')
		.trim()
		.toLowerCase();
}

function parseObjectJson(raw) {
	if (typeof raw !== 'string') {
		return null;
	}
	const trimmed = raw.trim();
	if (!trimmed.startsWith('{')) {
		return null;
	}
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed;
		}
	} catch {
		return null;
	}
	return null;
}

function parseTargetMeta(target) {
	if (typeof target !== 'string') {
		return {};
	}
	const parsed = parseObjectJson(target);
	return parsed ?? {};
}

function normalizeRole(value) {
	const role = String(value || '')
		.trim()
		.toLowerCase();
	if (!ROLE_ACTIONS[role]) {
		fail(`unsupported db role '${role}'. expected read|write|create|update|delete|all`);
	}
	return role;
}

function ensureActionAllowed(role, action) {
	if (!ROLE_ACTIONS[role].has(action)) {
		fail(`db role '${role}' does not allow action '${action}'`);
	}
}

function normalizeResource(value) {
	const resource = String(value || '').trim();
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

function deriveDelegateResource(request, targetMeta) {
	const explicit = normalizeResource(targetMeta.delegate_resource || targetMeta.resource);
	if (explicit) {
		return explicit;
	}

	const fromRequest = normalizeResource(request.resource);
	if (fromRequest && !RESERVED_RESOURCES.has(fromRequest)) {
		return fromRequest;
	}

	return 'plugin:postgres_agent';
}

function stripRouterFields(obj) {
	const clone = { ...obj };
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

function jsonIfNonEmptyObject(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	if (Object.keys(value).length === 0) {
		return null;
	}
	return JSON.stringify(value);
}

function stringifyDelegateTarget(value) {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	return JSON.stringify(value);
}

function deriveDelegateTarget(request, targetMeta) {
	const explicit = stringifyDelegateTarget(targetMeta.delegate_target);
	if (explicit) {
		return explicit;
	}

	const requestObj = parseObjectJson(request.target);
	if (requestObj) {
		return jsonIfNonEmptyObject(stripRouterFields(requestObj));
	}

	if (typeof request.target === 'string') {
		const trimmed = request.target.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	return null;
}

try {
	const { request } = pluginContext();
	const role = normalizeRole(process.env.PINOKIO_DB_ROLE || 'read');
	const action = normalizeAction(request.action);
	if (!action) {
		fail('missing request action');
	}
	ensureActionAllowed(role, action);

	const targetMeta = parseTargetMeta(request.target);
	if (targetMeta.action && normalizeAction(targetMeta.action) !== action) {
		fail('target.action override is not allowed for db role agent');
	}
	if (targetMeta.delegate_action && normalizeAction(targetMeta.delegate_action) !== action) {
		fail('target.delegate_action override is not allowed for db role agent');
	}

	const delegateResource = deriveDelegateResource(request, targetMeta);
	const delegateTarget = deriveDelegateTarget(request, targetMeta);

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
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}
