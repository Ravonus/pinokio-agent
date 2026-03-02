/**
 * Shared database utilities for Pinokio plugins that interact with PostgreSQL
 * via `docker exec psql`.
 *
 * Used by: memory-agent, postgres-agent (and potentially db-role, db-router).
 */

import { spawnSync } from 'node:child_process';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface DbConnection {
	container: string;
	database: string;
	user: string;
	password: string;
	timeoutMs: number;
}

export interface SqlResult {
	stdout: string;
	stderr: string;
}

export interface RunSqlOptions {
	tuplesOnly?: boolean;
	csv?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export function asObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, unknown>;
}

export function asStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((item) => String(item ?? '').trim())
		.filter((item) => item.length > 0)
		.slice(0, 200);
}

export function firstNonEmptyLine(text: unknown): string | null {
	for (const line of String(text || '').split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length > 0) {
			return trimmed;
		}
	}
	return null;
}

/* ------------------------------------------------------------------ */
/*  SQL escaping                                                       */
/* ------------------------------------------------------------------ */

export function sqlQuote(value: unknown): string {
	return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

export function sqlJson(value: unknown): string {
	return `${sqlQuote(JSON.stringify(asObject(value)))}::jsonb`;
}

export function sqlTextArray(values: unknown): string {
	const list = asStringArray(values);
	if (list.length === 0) {
		return 'ARRAY[]::text[]';
	}
	return `ARRAY[${list.map(sqlQuote).join(',')}]::text[]`;
}

/* ------------------------------------------------------------------ */
/*  Connection resolution                                              */
/* ------------------------------------------------------------------ */

export function resolveDbConnection(targetMeta: Record<string, unknown>): DbConnection {
	const timeoutRaw = Number(targetMeta.timeout_ms);
	const timeoutMs = Number.isFinite(timeoutRaw)
		? Math.min(Math.max(Math.trunc(timeoutRaw), 1_000), 120_000)
		: 30_000;
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
		timeoutMs
	};
}

/* ------------------------------------------------------------------ */
/*  SQL execution                                                      */
/* ------------------------------------------------------------------ */

export function runSql(connection: DbConnection, sql: string, options: RunSqlOptions = {}): SqlResult {
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
		'pager=off'
	);
	if (options.tuplesOnly) {
		args.push('-t', '-A');
	}
	if (options.csv) {
		args.push('--csv');
	}
	args.push('-c', sql);

	const out = spawnSync('docker', args, {
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

export function runJson(connection: DbConnection, sql: string): unknown {
	const result = runSql(connection, sql, { tuplesOnly: true });
	const line = firstNonEmptyLine(result.stdout);
	if (!line) {
		return null;
	}
	try {
		return JSON.parse(line);
	} catch {
		throw new Error(`database returned invalid JSON: ${line.slice(0, 120)}`);
	}
}
