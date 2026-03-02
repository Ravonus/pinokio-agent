import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { pluginContext, respond, fail } from '../../sdk/typescript/pinokio-sdk.ts';
import type { PluginRequest } from '../../sdk/typescript/pinokio-sdk.ts';
import { parseTargetMeta, normalizeAction } from '../plugin-utils.ts';

const SUPPORTED_ACTIONS: Set<string> = new Set(['create', 'read', 'update', 'delete']);
const DEFAULT_READ_SQL: string =
	"SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name LIMIT 100;";

interface ConnectionInfo {
	container: string;
	database: string;
	user: string;
	password: string;
	timeoutMs: number;
}

interface SqlResult {
	stdout: string;
	stderr: string;
}


function isReadOnlySql(sql: string): boolean {
	return /^(select|with|show|explain)\b/i.test(sql.trim());
}

function resolveSql(action: string, summary: unknown, targetMeta: Record<string, unknown>): string {
	const explicitSql: string = typeof targetMeta.sql === 'string' ? (targetMeta.sql as string).trim() : '';
	if (explicitSql) {
		return explicitSql;
	}

	const summarySql: string = typeof summary === 'string' ? summary.trim() : '';
	if (summarySql && isReadOnlySql(summarySql)) {
		return summarySql;
	}

	if (action === 'read') {
		return DEFAULT_READ_SQL;
	}
	return '';
}

function requireWriteConfirmation(action: string, targetMeta: Record<string, unknown>): void {
	if (action === 'read') {
		return;
	}
	if (targetMeta.confirm_write === true) {
		return;
	}
	fail(
		"write actions require target JSON with {\"confirm_write\": true, \"sql\": \"...\"} to prevent accidental mutations"
	);
}

function resolveConnection(targetMeta: Record<string, unknown>): ConnectionInfo {
	return {
		container:
			(typeof targetMeta.container === 'string' && (targetMeta.container as string).trim()) ||
			process.env.PINOKIO_DB_CONTAINER ||
			'pinokio-postgres-main',
		database:
			(typeof targetMeta.database === 'string' && (targetMeta.database as string).trim()) ||
			process.env.PINOKIO_DB_NAME ||
			process.env.PGDATABASE ||
			'pinokio',
		user:
			(typeof targetMeta.user === 'string' && (targetMeta.user as string).trim()) ||
			process.env.PINOKIO_DB_USER ||
			process.env.PGUSER ||
			'pinokio',
		password:
			(typeof targetMeta.password === 'string' && (targetMeta.password as string)) ||
			process.env.PINOKIO_DB_PASSWORD ||
			process.env.PGPASSWORD ||
			'',
		timeoutMs: Number.isFinite(targetMeta.timeout_ms as number)
			? Math.min(Math.max(Number(targetMeta.timeout_ms), 1_000), 120_000)
			: 30_000
	};
}

function runSql(connection: ConnectionInfo, sql: string): SqlResult {
	const args: string[] = ['exec', '-i'];
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
		'pager=off',
		'--csv',
		'-c',
		sql
	);

	const out: SpawnSyncReturns<string> = spawnSync('docker', args, {
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
	return {
		stdout: (out.stdout || '').trim(),
		stderr: (out.stderr || '').trim()
	};
}

function rowCountFromCsv(stdout: string): number {
	if (!stdout) {
		return 0;
	}
	const lines: string[] = stdout.split(/\r?\n/).filter((line: string) => line.length > 0);
	if (lines.length <= 1) {
		return 0;
	}
	return lines.length - 1;
}

try {
	const { request }: { request: PluginRequest } = pluginContext();
	const action: string = normalizeAction(request.action);
	if (!SUPPORTED_ACTIONS.has(action)) {
		fail(`unsupported action '${action}' for postgres_agent`);
	}

	const targetMeta: Record<string, unknown> = parseTargetMeta(request.target);
	requireWriteConfirmation(action, targetMeta);

	const sql: string = resolveSql(action, request.summary, targetMeta);
	if (!sql) {
		fail("missing SQL. Provide target JSON {\"sql\":\"...\"}.");
	}
	if (action === 'read' && !isReadOnlySql(sql)) {
		fail('read action only accepts SELECT/SHOW/WITH/EXPLAIN SQL');
	}

	const connection: ConnectionInfo = resolveConnection(targetMeta);
	const result: SqlResult = runSql(connection, sql);

	respond({
		ok: true,
		plugin: 'postgres_agent',
		action,
		sql,
		container: connection.container,
		database: connection.database,
		user: connection.user,
		row_count: rowCountFromCsv(result.stdout),
		csv: result.stdout,
		stderr: result.stderr || null
	});
} catch (error: unknown) {
	fail(error instanceof Error ? error.message : String(error));
}
