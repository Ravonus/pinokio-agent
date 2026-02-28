import fs from 'node:fs';
import type { ServerOptions as HttpsServerOptions } from 'node:https';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin, type ServerOptions } from 'vite';

function stripLegacyCodeSplitting(): Plugin {
	return {
		name: 'strip-legacy-codesplitting',
		configResolved(config) {
			const output = config.build.rollupOptions?.output;
			if (Array.isArray(output)) {
				for (const item of output) {
					if (item && typeof item === 'object' && 'codeSplitting' in item) {
						delete (item as { codeSplitting?: unknown }).codeSplitting;
					}
				}
				return;
			}
			if (output && typeof output === 'object' && 'codeSplitting' in output) {
				delete (output as { codeSplitting?: unknown }).codeSplitting;
			}
		}
	};
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), stripLegacyCodeSplitting()],
	server: resolveServerOptions(),
	preview: resolvePreviewOptions()
});

function envFlag(name: string, fallback = false): boolean {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const normalized = raw.trim().toLowerCase();
	return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function envPort(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const parsed = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
		return fallback;
	}
	return parsed;
}

function resolveHttps(): HttpsServerOptions | undefined {
	const enabled = envFlag('PINOKIO_UI_HTTPS', false);
	if (!enabled) {
		return undefined;
	}
	const certPath = process.env.PINOKIO_UI_TLS_CERT?.trim() || '';
	const keyPath = process.env.PINOKIO_UI_TLS_KEY?.trim() || '';
	if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
		return {
			cert: fs.readFileSync(certPath),
			key: fs.readFileSync(keyPath)
		};
	}
	return {};
}

function resolveServerOptions(): ServerOptions {
	const host = process.env.PINOKIO_UI_HOST?.trim() || '127.0.0.1';
	const browserHost = process.env.PINOKIO_UI_BROWSER_HOST?.trim() || host;
	const port = envPort('PINOKIO_UI_PORT', 5173);
	const strictPort = envFlag('PINOKIO_UI_STRICT_PORT', true);
	const https = resolveHttps();
	const hmrPort = envPort('PINOKIO_UI_HMR_PORT', port);
	const hmrHost = process.env.PINOKIO_UI_HMR_HOST?.trim() || browserHost;
	const hmrProtocol =
		process.env.PINOKIO_UI_HMR_PROTOCOL?.trim() || (https ? 'wss' : 'ws');

	return {
		host,
		port,
		strictPort,
		allowedHosts: resolveAllowedHosts(host, browserHost),
		https,
		hmr: {
			host: hmrHost,
			port: hmrPort,
			clientPort: hmrPort,
			protocol: hmrProtocol as 'ws' | 'wss'
		}
	};
}

function resolvePreviewOptions() {
	const host = process.env.PINOKIO_UI_HOST?.trim() || '127.0.0.1';
	const browserHost = process.env.PINOKIO_UI_BROWSER_HOST?.trim() || host;
	const port = envPort('PINOKIO_UI_PORT', 5173);
	const strictPort = envFlag('PINOKIO_UI_STRICT_PORT', true);
	const https = resolveHttps();

	return {
		host,
		port,
		strictPort,
		allowedHosts: resolveAllowedHosts(host, browserHost),
		https
	};
}

function resolveAllowedHosts(host: string, browserHost: string): true | string[] {
	const raw = process.env.PINOKIO_UI_ALLOWED_HOSTS?.trim() || '';
	if (raw === '*') {
		return true;
	}
	if (raw) {
		const parsed = raw
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean);
		if (parsed.length > 0) {
			return parsed;
		}
	}

	const hosts = new Set<string>(['localhost', '127.0.0.1', '[::1]', host, browserHost]);
	if (browserHost.endsWith('.localhost')) {
		hosts.add('.localhost');
	}
	return Array.from(hosts).filter(Boolean);
}
