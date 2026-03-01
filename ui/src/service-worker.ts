/// <reference lib="webworker" />

export {};

declare const self: ServiceWorkerGlobalScope;

interface PinokioNotificationAction {
	id: string;
	label: string;
	prompt?: string;
	url?: string;
}

interface PinokioNotificationData {
	url?: string;
	prompt?: string;
	tag?: string;
	actions?: PinokioNotificationAction[];
}

function toAbsoluteUrl(target: string): string {
	try {
		return new URL(target, self.registration.scope).toString();
	} catch {
		return new URL('/ui/chat', self.registration.scope).toString();
	}
}

function withPrompt(url: string, prompt: string): string {
	try {
		const parsed = new URL(url, self.registration.scope);
		parsed.searchParams.set('run_prompt', prompt);
		parsed.searchParams.set('auto_run', '1');
		return parsed.toString();
	} catch {
		const fallback = new URL('/ui/chat', self.registration.scope);
		fallback.searchParams.set('run_prompt', prompt);
		fallback.searchParams.set('auto_run', '1');
		return fallback.toString();
	}
}

async function focusOrOpenWindow(url: string): Promise<void> {
	const absolute = toAbsoluteUrl(url);
	const absoluteParsed = new URL(absolute);
	const clients = await self.clients.matchAll({
		type: 'window',
		includeUncontrolled: true
	});
	for (const client of clients) {
		const windowClient = client as WindowClient;
		if (windowClient.url === absolute) {
			await windowClient.focus();
			return;
		}
		try {
			const current = new URL(windowClient.url);
			if (
				current.origin === absoluteParsed.origin &&
				current.pathname === absoluteParsed.pathname &&
				typeof windowClient.navigate === 'function'
			) {
				await windowClient.navigate(absolute);
				await windowClient.focus();
				return;
			}
		} catch {
			// Continue scanning clients.
		}
	}
	await self.clients.openWindow(absolute);
}

self.addEventListener('install', (event: ExtendableEvent) => {
	event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event: ExtendableEvent) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
	const data = (event.notification.data || {}) as PinokioNotificationData;
	const actionId = String(event.action || '').trim();
	const selectedAction =
		actionId && Array.isArray(data.actions)
			? data.actions.find((item) => String(item?.id || '') === actionId) || null
			: null;

	let targetUrl = selectedAction?.url || data.url || '/ui/chat';
	const prompt = selectedAction?.prompt || data.prompt || null;
	if (prompt) {
		targetUrl = withPrompt(targetUrl, prompt);
	}
	event.notification.close();
	event.waitUntil(focusOrOpenWindow(targetUrl));
});
