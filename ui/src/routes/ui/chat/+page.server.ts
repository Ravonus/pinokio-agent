import type { PageServerLoad } from './$types';
import { configureManagerPolicyStatus, discoverExtensionSurfaces } from '$lib/ui/manager';

export const load: PageServerLoad = async () => {
	try {
		const [surfaces, policy] = await Promise.all([
			discoverExtensionSurfaces(),
			configureManagerPolicyStatus()
		]);
		const chatSurface = surfaces.find((s) => s.name === 'chat');
		return {
			pluginEnabled: chatSurface ? chatSurface.enabled !== false : true,
			unsafeHostEnabled: policy.policy.unsafe_host_communication_enabled === true
		};
	} catch {
		return { pluginEnabled: true, unsafeHostEnabled: false };
	}
};
