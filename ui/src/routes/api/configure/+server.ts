import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import {
	configureDoctor,
	configureStatus,
	detectOAuthCliTools,
	discoverExtensionSurfaces,
	runConfigureAction
} from '$lib/ui/manager';

const ActionSchema = z.enum([
	'openai',
	'claude_api',
	'claude_code',
	'codex',
	'login',
	'detect_clis',
	'install_cli',
	'install_missing_clis',
	'claude_code_oauth_connect',
	'codex_oauth_connect',
	'doctor',
	'status',
	'manager_policy_status',
	'manager_policy_set',
	'services',
	'service_ensure',
	'package_ledger_scopes',
	'package_ledger_events',
	'skills',
	'skill_add',
	'skill_remove',
	'plugin_catalog',
	'plugin_preview',
	'plugin_install',
	'plugin_remove',
	'extensions',
	'extension_add',
	'extension_remove'
]);

const RequestSchema = z.object({
	action: ActionSchema,
	payload: z.record(z.string(), z.unknown()).default({})
});

export const GET: RequestHandler = async ({ url }) => {
	const rawView = url.searchParams.get('view');
	const view =
		rawView === 'doctor' ||
		rawView === 'surfaces' ||
		rawView === 'detectors' ||
		rawView === 'services' ||
		rawView === 'package_ledger_scopes' ||
		rawView === 'package_ledger_events' ||
		rawView === 'skills' ||
		rawView === 'plugins' ||
		rawView === 'manager_policy'
			? rawView
			: 'status';
	try {
		const data =
			view === 'doctor'
				? await configureDoctor()
				: view === 'detectors'
					? await detectOAuthCliTools()
					: view === 'services'
					? await runConfigureAction('services', {})
					: view === 'package_ledger_scopes'
						? await runConfigureAction('package_ledger_scopes', {})
						: view === 'package_ledger_events'
							? await runConfigureAction('package_ledger_events', {})
						: view === 'skills'
							? await runConfigureAction('skills', {})
						: view === 'plugins'
							? await runConfigureAction('plugin_catalog', {})
							: view === 'manager_policy'
								? await runConfigureAction('manager_policy_status', {})
								: view === 'surfaces'
									? await discoverExtensionSurfaces()
									: await configureStatus();
		return json(
			{
				ok: true,
				view,
				data
			},
			{
				headers: {
					'cache-control': 'no-store'
				}
			}
		);
	} catch (error) {
		return json(
			{
				ok: false,
				view,
				error: error instanceof Error ? error.message : String(error)
			},
			{
				status: 500,
				headers: {
					'cache-control': 'no-store'
				}
			}
		);
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = RequestSchema.parse(await request.json());
		const data = await runConfigureAction(body.action, body.payload);
		return json({
			ok: true,
			action: body.action,
			data
		});
	} catch (error) {
		return json(
			{
				ok: false,
				error: error instanceof Error ? error.message : String(error)
			},
			{
				status: 400
			}
		);
	}
};
