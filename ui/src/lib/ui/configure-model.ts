import {
	configureDoctor,
	configureManagerPolicyStatus,
	configurePackageLedgerScopes,
	configureServices,
	configureStatus,
	detectOAuthCliTools,
	discoverExtensionSurfaces
} from '$lib/ui/manager';
import { parseUiModel, type UiModel } from '$lib/ui/model';

export interface ConfigureUiBundle {
	model: UiModel;
	status: Awaited<ReturnType<typeof configureStatus>>;
	services: Awaited<ReturnType<typeof configureServices>>;
	doctor: Awaited<ReturnType<typeof configureDoctor>>;
	managerPolicy: Awaited<ReturnType<typeof configureManagerPolicyStatus>>;
	surfaces: Awaited<ReturnType<typeof discoverExtensionSurfaces>>;
	cliDetections: Awaited<ReturnType<typeof detectOAuthCliTools>>;
	packageLedgerScopes: Awaited<ReturnType<typeof configurePackageLedgerScopes>>;
}

export async function loadConfigureUiBundle(): Promise<ConfigureUiBundle> {
	const [status, services, doctor, managerPolicy, surfaces, cliDetections, packageLedgerScopes] =
		await Promise.all([
		configureStatus(),
		configureServices(),
		configureDoctor(),
		configureManagerPolicyStatus(),
		discoverExtensionSurfaces(),
		detectOAuthCliTools(),
		configurePackageLedgerScopes({ limit: 200 })
	]);

	const configured = status.filter((item) => item.configured).length;
	const ready = status.filter((item) => item.token_present).length;
	const runningServices = services.filter((service) => service.running).length;

	const model = parseUiModel({
		id: 'configure',
		title: 'Configuration Control',
		subtitle: 'App-driven LLM credential setup and extension-aware UI surfaces.',
		refreshedAt: new Date().toISOString(),
		sections: [
			{
				id: 'overview',
				title: 'Overview',
				blocks: [
					{
						type: 'stats',
						items: [
							{
								label: 'Credentials configured',
								value: `${configured}/${status.length}`,
								tone: configured === status.length ? 'success' : 'warning'
							},
							{
								label: 'Credentials ready',
								value: `${ready}/${status.length}`,
								tone: ready === status.length ? 'success' : 'warning'
							},
							{
								label: 'Profile health',
								value: doctor.ok ? 'ok' : `${doctor.profile_errors.length} errors`,
								tone: doctor.ok ? 'success' : 'danger'
							},
							{
								label: 'Extension surfaces',
								value: `${surfaces.length}`,
								tone: 'neutral'
							},
							{
								label: 'Managed services',
								value: `${runningServices}/${services.length}`,
								tone: runningServices === services.length ? 'success' : 'warning'
							}
						]
					}
				]
			},
			{
				id: 'extension-map',
				title: 'Extension map',
				description:
					'This configure UI is part of the same surface used by core, plugins, agents, and systems.',
				blocks: [
					{
						type: 'table',
						columns: ['kind', 'name', 'detail', 'source', 'route', 'enabled'],
						rows: surfaces.map((item) => ({
							kind: item.kind,
							name: item.name,
							detail: item.detail,
							source: item.source ?? 'unknown',
							route: item.route ?? 'not set',
							enabled: item.enabled === false ? 'false' : 'true'
						}))
					}
				]
			}
		]
	});

	return {
		model,
		status,
		services,
		doctor,
		managerPolicy,
		surfaces,
		cliDetections,
		packageLedgerScopes
	};
}
