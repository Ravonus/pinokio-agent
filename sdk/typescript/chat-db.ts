import { spawnSync } from 'node:child_process';
import type {
  ChatDbConnection,
  ChatSession,
  ChatMessage,
  ChatMemoryRef,
  InsertMessageOptions,
  QueryMessagesOptions,
  FlagMessageOptions,
  CreateMemoryRefOptions,
} from './types.ts';

/* ------------------------------------------------------------------ */
/*  SQL helpers (mirrors memory-agent-plugin pattern)                  */
/* ------------------------------------------------------------------ */

function sqlQuote(value: unknown): string {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function sqlJson(value: unknown): string {
  const obj = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return `${sqlQuote(JSON.stringify(obj))}::jsonb`;
}

function sqlTextArray(values: unknown): string {
  const list = Array.isArray(values)
    ? values.map((v) => String(v ?? '').trim()).filter((v) => v.length > 0).slice(0, 200)
    : [];
  if (list.length === 0) return 'ARRAY[]::text[]';
  return `ARRAY[${list.map(sqlQuote).join(',')}]::text[]`;
}

function firstNonEmptyLine(text: unknown): string | null {
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

interface RunSqlOptions {
  tuplesOnly?: boolean;
}

function runSql(connection: ChatDbConnection, sql: string, options: RunSqlOptions = {}): string {
  const args: string[] = ['exec', '-i'];
  if (connection.password) {
    args.push('-e', `PGPASSWORD=${connection.password}`);
  }
  args.push(
    connection.container,
    'psql',
    '-v', 'ON_ERROR_STOP=1',
    '-X',
    '-U', connection.user,
    '-d', connection.database,
    '-P', 'pager=off',
  );
  if (options.tuplesOnly) {
    args.push('-t', '-A');
  }
  args.push('-c', sql);

  const out = spawnSync('docker', args, {
    encoding: 'utf8',
    env: process.env,
    timeout: connection.timeoutMs,
  });
  if (out.error) {
    throw new Error(`failed to execute docker: ${out.error.message}`);
  }
  if (out.status !== 0) {
    throw new Error((out.stderr || out.stdout || `docker exited ${String(out.status)}`).trim());
  }
  return (out.stdout || '').trim();
}

function runJson(connection: ChatDbConnection, sql: string): unknown {
  const stdout = runSql(connection, sql, { tuplesOnly: true });
  const line = firstNonEmptyLine(stdout);
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`database returned invalid JSON: ${line.slice(0, 120)}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Connection resolution                                              */
/* ------------------------------------------------------------------ */

export function resolveChatDbConnection(overrides?: Partial<ChatDbConnection>): ChatDbConnection {
  return {
    container:
      overrides?.container ||
      process.env.PINOKIO_DB_CONTAINER ||
      'pinokio-postgres-main',
    database:
      overrides?.database ||
      process.env.PINOKIO_DB_NAME ||
      process.env.PGDATABASE ||
      'pinokio',
    user:
      overrides?.user ||
      process.env.PINOKIO_DB_USER ||
      process.env.PGUSER ||
      'pinokio',
    password:
      overrides?.password ||
      process.env.PINOKIO_DB_PASSWORD ||
      process.env.PGPASSWORD ||
      '',
    timeoutMs: overrides?.timeoutMs ?? 30_000,
  };
}

/* ------------------------------------------------------------------ */
/*  Schema bootstrap (idempotent)                                      */
/* ------------------------------------------------------------------ */

export function ensureChatSchema(connection: ChatDbConnection): void {
  runSql(
    connection,
    [
      'CREATE SCHEMA IF NOT EXISTS pinokio_chat;',

      `CREATE TABLE IF NOT EXISTS pinokio_chat.sessions (
        id              BIGSERIAL PRIMARY KEY,
        session_key     TEXT NOT NULL UNIQUE,
        channel         TEXT NOT NULL DEFAULT 'default',
        agent_id        TEXT,
        caller_agent_id TEXT,
        caller_resource TEXT,
        llm_profile     TEXT,
        status          TEXT NOT NULL DEFAULT 'active',
        metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
        tags            TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
        summary         TEXT,
        message_count   INTEGER NOT NULL DEFAULT 0,
        first_message_at TIMESTAMPTZ,
        last_message_at  TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );`,

      `CREATE TABLE IF NOT EXISTS pinokio_chat.messages (
        id              BIGSERIAL PRIMARY KEY,
        session_id      BIGINT NOT NULL REFERENCES pinokio_chat.sessions(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        turn_index      INTEGER NOT NULL DEFAULT 0,
        metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
        tags            TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
        importance      SMALLINT NOT NULL DEFAULT 0,
        flagged_for_memory BOOLEAN NOT NULL DEFAULT false,
        llm_profile     TEXT,
        llm_provider    TEXT,
        llm_model       TEXT,
        routed_resource TEXT,
        routed_action   TEXT,
        response_mode   TEXT,
        token_estimate  INTEGER,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );`,

      `CREATE TABLE IF NOT EXISTS pinokio_chat.memory_refs (
        id              BIGSERIAL PRIMARY KEY,
        message_id      BIGINT NOT NULL REFERENCES pinokio_chat.messages(id) ON DELETE CASCADE,
        session_id      BIGINT NOT NULL REFERENCES pinokio_chat.sessions(id) ON DELETE CASCADE,
        memory_namespace TEXT NOT NULL,
        memory_key      TEXT NOT NULL,
        ref_type        TEXT NOT NULL DEFAULT 'excerpt',
        excerpt         TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(message_id, memory_namespace, memory_key)
      );`,

      // Session indexes
      'CREATE INDEX IF NOT EXISTS pka_chat_sessions_channel_idx ON pinokio_chat.sessions (channel, updated_at DESC);',
      'CREATE INDEX IF NOT EXISTS pka_chat_sessions_agent_idx ON pinokio_chat.sessions (agent_id, updated_at DESC);',
      'CREATE INDEX IF NOT EXISTS pka_chat_sessions_status_idx ON pinokio_chat.sessions (status, updated_at DESC);',
      'CREATE INDEX IF NOT EXISTS pka_chat_sessions_tags_idx ON pinokio_chat.sessions USING GIN (tags);',

      // Message indexes
      'CREATE INDEX IF NOT EXISTS pka_chat_messages_session_idx ON pinokio_chat.messages (session_id, turn_index);',
      'CREATE INDEX IF NOT EXISTS pka_chat_messages_session_time_idx ON pinokio_chat.messages (session_id, created_at);',
      'CREATE INDEX IF NOT EXISTS pka_chat_messages_flagged_idx ON pinokio_chat.messages (flagged_for_memory, importance DESC, created_at DESC) WHERE flagged_for_memory = true;',
      'CREATE INDEX IF NOT EXISTS pka_chat_messages_tags_idx ON pinokio_chat.messages USING GIN (tags);',
      "CREATE INDEX IF NOT EXISTS pka_chat_messages_content_fts_idx ON pinokio_chat.messages USING GIN (to_tsvector('simple', content));",
      'CREATE INDEX IF NOT EXISTS pka_chat_messages_importance_idx ON pinokio_chat.messages (importance DESC, created_at DESC) WHERE importance > 0;',

      // Memory ref indexes
      'CREATE INDEX IF NOT EXISTS pka_chat_memory_refs_memory_idx ON pinokio_chat.memory_refs (memory_namespace, memory_key);',
      'CREATE INDEX IF NOT EXISTS pka_chat_memory_refs_session_idx ON pinokio_chat.memory_refs (session_id);',
    ].join('\n'),
  );
}

/* ------------------------------------------------------------------ */
/*  Session management                                                 */
/* ------------------------------------------------------------------ */

function generateSessionKey(channel: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${channel}:${ts}:${rand}`;
}

export function createSession(
  connection: ChatDbConnection,
  options: {
    channel: string;
    agent_id?: string | null;
    caller_agent_id?: string | null;
    caller_resource?: string | null;
    llm_profile?: string | null;
    metadata?: Record<string, unknown>;
    tags?: string[];
  },
): ChatSession {
  const key = generateSessionKey(options.channel);
  const result = runJson(
    connection,
    `WITH ins AS (
      INSERT INTO pinokio_chat.sessions (
        session_key, channel, agent_id, caller_agent_id, caller_resource,
        llm_profile, metadata, tags
      ) VALUES (
        ${sqlQuote(key)},
        ${sqlQuote(options.channel)},
        ${options.agent_id ? sqlQuote(options.agent_id) : 'NULL'},
        ${options.caller_agent_id ? sqlQuote(options.caller_agent_id) : 'NULL'},
        ${options.caller_resource ? sqlQuote(options.caller_resource) : 'NULL'},
        ${options.llm_profile ? sqlQuote(options.llm_profile) : 'NULL'},
        ${sqlJson(options.metadata ?? {})},
        ${sqlTextArray(options.tags ?? [])}
      )
      RETURNING *
    )
    SELECT row_to_json(ins)::text FROM ins;`,
  );
  if (!result) {
    return getSession(connection, key) as ChatSession;
  }
  return result as ChatSession;
}

export function findOrCreateSession(
  connection: ChatDbConnection,
  options: {
    channel: string;
    agent_id?: string | null;
    caller_agent_id?: string | null;
    caller_resource?: string | null;
    max_age_minutes?: number;
  },
): ChatSession {
  const maxAge = options.max_age_minutes ?? 30;
  const existing = runJson(
    connection,
    `SELECT COALESCE(
      (SELECT row_to_json(s)::text
       FROM pinokio_chat.sessions s
       WHERE s.channel = ${sqlQuote(options.channel)}
         AND s.status = 'active'
         AND s.updated_at >= now() - interval '${maxAge} minutes'
       ORDER BY s.updated_at DESC
       LIMIT 1),
      'null'
    );`,
  ) as ChatSession | null;

  if (existing) return existing;

  return createSession(connection, {
    channel: options.channel,
    agent_id: options.agent_id,
    caller_agent_id: options.caller_agent_id,
    caller_resource: options.caller_resource,
  });
}

export function closeSession(connection: ChatDbConnection, sessionId: number, summary?: string): void {
  runSql(
    connection,
    `UPDATE pinokio_chat.sessions
     SET status = 'closed',
         summary = ${summary ? sqlQuote(summary) : 'summary'},
         updated_at = now()
     WHERE id = ${sessionId};`,
  );
}

export function getSession(connection: ChatDbConnection, idOrKey: number | string): ChatSession | null {
  const where = typeof idOrKey === 'number'
    ? `id = ${idOrKey}`
    : `session_key = ${sqlQuote(idOrKey)}`;
  return runJson(
    connection,
    `SELECT COALESCE(
      (SELECT row_to_json(s)::text FROM pinokio_chat.sessions s WHERE ${where}),
      'null'
    );`,
  ) as ChatSession | null;
}

export function listSessions(
  connection: ChatDbConnection,
  options: {
    channel?: string;
    agent_id?: string;
    status?: string;
    limit?: number;
  } = {},
): ChatSession[] {
  const conditions: string[] = [];
  if (options.channel) conditions.push(`channel = ${sqlQuote(options.channel)}`);
  if (options.agent_id) conditions.push(`agent_id = ${sqlQuote(options.agent_id)}`);
  if (options.status) conditions.push(`status = ${sqlQuote(options.status)}`);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

  const result = runJson(
    connection,
    `SELECT COALESCE(
      (SELECT json_agg(row_to_json(t))::text
       FROM (
         SELECT * FROM pinokio_chat.sessions ${where}
         ORDER BY updated_at DESC LIMIT ${limit}
       ) t),
      '[]'
    );`,
  );
  return Array.isArray(result) ? result : [];
}

/* ------------------------------------------------------------------ */
/*  Message storage                                                    */
/* ------------------------------------------------------------------ */

export function insertMessage(connection: ChatDbConnection, options: InsertMessageOptions): ChatMessage {
  const tokenEst = options.token_estimate ?? estimateTokens(options.content);
  const result = runJson(
    connection,
    `WITH ins AS (
      INSERT INTO pinokio_chat.messages (
        session_id, role, content, turn_index, metadata, tags,
        importance, flagged_for_memory, llm_profile, llm_provider, llm_model,
        routed_resource, routed_action, response_mode, token_estimate
      ) VALUES (
        ${options.session_id},
        ${sqlQuote(options.role)},
        ${sqlQuote(options.content)},
        ${options.turn_index},
        ${sqlJson(options.metadata ?? {})},
        ${sqlTextArray(options.tags ?? [])},
        ${options.importance ?? 0},
        ${options.flagged_for_memory ? 'true' : 'false'},
        ${options.llm_profile ? sqlQuote(options.llm_profile) : 'NULL'},
        ${options.llm_provider ? sqlQuote(options.llm_provider) : 'NULL'},
        ${options.llm_model ? sqlQuote(options.llm_model) : 'NULL'},
        ${options.routed_resource ? sqlQuote(options.routed_resource) : 'NULL'},
        ${options.routed_action ? sqlQuote(options.routed_action) : 'NULL'},
        ${options.response_mode ? sqlQuote(options.response_mode) : 'NULL'},
        ${tokenEst}
      ) RETURNING *
    )
    SELECT row_to_json(ins)::text FROM ins;`,
  );
  return result as ChatMessage;
}

export function updateSessionCounters(connection: ChatDbConnection, sessionId: number): void {
  runSql(
    connection,
    `UPDATE pinokio_chat.sessions SET
       message_count = (SELECT COUNT(*) FROM pinokio_chat.messages WHERE session_id = ${sessionId}),
       first_message_at = (SELECT MIN(created_at) FROM pinokio_chat.messages WHERE session_id = ${sessionId}),
       last_message_at = (SELECT MAX(created_at) FROM pinokio_chat.messages WHERE session_id = ${sessionId}),
       updated_at = now()
     WHERE id = ${sessionId};`,
  );
}

/* ------------------------------------------------------------------ */
/*  Message querying                                                   */
/* ------------------------------------------------------------------ */

export function queryMessages(connection: ChatDbConnection, options: QueryMessagesOptions): ChatMessage[] {
  const conditions: string[] = [];
  const joins: string[] = [];

  if (options.session_id != null) {
    conditions.push(`m.session_id = ${options.session_id}`);
  }
  if (options.channel || options.agent_id) {
    joins.push('JOIN pinokio_chat.sessions s ON s.id = m.session_id');
    if (options.channel) conditions.push(`s.channel = ${sqlQuote(options.channel)}`);
    if (options.agent_id) conditions.push(`s.agent_id = ${sqlQuote(options.agent_id)}`);
  }
  if (options.role) conditions.push(`m.role = ${sqlQuote(options.role)}`);
  if (options.flagged_for_memory != null) {
    conditions.push(`m.flagged_for_memory = ${options.flagged_for_memory ? 'true' : 'false'}`);
  }
  if (options.min_importance != null) {
    conditions.push(`m.importance >= ${options.min_importance}`);
  }
  if (options.tags && options.tags.length > 0) {
    conditions.push(`m.tags && ${sqlTextArray(options.tags)}`);
  }
  if (options.query) {
    conditions.push(
      `(to_tsvector('simple', m.content) @@ plainto_tsquery('simple', ${sqlQuote(options.query)}) OR m.content ILIKE ${sqlQuote('%' + options.query + '%')})`,
    );
  }
  if (options.since) conditions.push(`m.created_at >= ${sqlQuote(options.since)}::timestamptz`);
  if (options.until) conditions.push(`m.created_at <= ${sqlQuote(options.until)}::timestamptz`);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);

  const result = runJson(
    connection,
    `SELECT COALESCE(
      (SELECT json_agg(row_to_json(t))::text
       FROM (
         SELECT m.* FROM pinokio_chat.messages m
         ${joins.join(' ')}
         ${where}
         ORDER BY m.created_at DESC
         LIMIT ${limit} OFFSET ${offset}
       ) t),
      '[]'
    );`,
  );
  return Array.isArray(result) ? result : [];
}

export function getSessionMessages(
  connection: ChatDbConnection,
  sessionId: number,
  options?: { limit?: number; offset?: number; roles?: string[] },
): ChatMessage[] {
  const conditions: string[] = [`session_id = ${sessionId}`];
  if (options?.roles && options.roles.length > 0) {
    conditions.push(`role IN (${options.roles.map(sqlQuote).join(',')})`);
  }
  const where = `WHERE ${conditions.join(' AND ')}`;
  const limit = Math.min(Math.max(options?.limit ?? 200, 1), 1000);
  const offset = Math.max(options?.offset ?? 0, 0);

  const result = runJson(
    connection,
    `SELECT COALESCE(
      (SELECT json_agg(row_to_json(t))::text
       FROM (
         SELECT * FROM pinokio_chat.messages
         ${where}
         ORDER BY turn_index ASC
         LIMIT ${limit} OFFSET ${offset}
       ) t),
      '[]'
    );`,
  );
  return Array.isArray(result) ? result : [];
}

export function getFullContext(
  connection: ChatDbConnection,
  sessionId: number,
): { session: ChatSession | null; messages: ChatMessage[] } {
  const session = getSession(connection, sessionId);
  const messages = session ? getSessionMessages(connection, sessionId) : [];
  return { session, messages };
}

/* ------------------------------------------------------------------ */
/*  Memory flagging                                                    */
/* ------------------------------------------------------------------ */

export function flagMessage(connection: ChatDbConnection, options: FlagMessageOptions): ChatMessage {
  const sets: string[] = [];
  if (options.importance != null) sets.push(`importance = ${options.importance}`);
  if (options.flagged_for_memory != null) sets.push(`flagged_for_memory = ${options.flagged_for_memory ? 'true' : 'false'}`);
  if (options.tags && options.tags.length > 0) {
    sets.push(`tags = tags || ${sqlTextArray(options.tags)}`);
  }
  if (sets.length === 0) sets.push('importance = importance'); // no-op update

  const result = runJson(
    connection,
    `WITH upd AS (
      UPDATE pinokio_chat.messages SET ${sets.join(', ')}
      WHERE id = ${options.message_id}
      RETURNING *
    )
    SELECT row_to_json(upd)::text FROM upd;`,
  );
  return result as ChatMessage;
}

export function getFlaggedMessages(
  connection: ChatDbConnection,
  options: {
    channel?: string;
    min_importance?: number;
    tags?: string[];
    query?: string;
    limit?: number;
  } = {},
): Array<ChatMessage & { session_key: string; channel: string }> {
  const conditions: string[] = ['m.flagged_for_memory = true'];
  if (options.min_importance != null) {
    conditions.push(`m.importance >= ${options.min_importance}`);
  }
  if (options.channel) {
    conditions.push(`s.channel = ${sqlQuote(options.channel)}`);
  }
  if (options.tags && options.tags.length > 0) {
    conditions.push(`m.tags && ${sqlTextArray(options.tags)}`);
  }
  if (options.query) {
    conditions.push(
      `(to_tsvector('simple', m.content) @@ plainto_tsquery('simple', ${sqlQuote(options.query)}) OR m.content ILIKE ${sqlQuote('%' + options.query + '%')})`,
    );
  }
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

  const result = runJson(
    connection,
    `SELECT COALESCE(
      (SELECT json_agg(row_to_json(t))::text
       FROM (
         SELECT m.*, s.session_key, s.channel
         FROM pinokio_chat.messages m
         JOIN pinokio_chat.sessions s ON s.id = m.session_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY m.importance DESC, m.created_at DESC
         LIMIT ${limit}
       ) t),
      '[]'
    );`,
  );
  return Array.isArray(result) ? result as Array<ChatMessage & { session_key: string; channel: string }> : [];
}

/* ------------------------------------------------------------------ */
/*  Memory cross-references                                            */
/* ------------------------------------------------------------------ */

export function createMemoryRef(connection: ChatDbConnection, options: CreateMemoryRefOptions): ChatMemoryRef {
  const result = runJson(
    connection,
    `WITH ins AS (
      INSERT INTO pinokio_chat.memory_refs (
        message_id, session_id, memory_namespace, memory_key, ref_type, excerpt
      ) VALUES (
        ${options.message_id},
        ${options.session_id},
        ${sqlQuote(options.memory_namespace)},
        ${sqlQuote(options.memory_key)},
        ${sqlQuote(options.ref_type ?? 'excerpt')},
        ${options.excerpt ? sqlQuote(options.excerpt) : 'NULL'}
      )
      ON CONFLICT (message_id, memory_namespace, memory_key) DO NOTHING
      RETURNING *
    )
    SELECT row_to_json(ins)::text FROM ins;`,
  );
  return result as ChatMemoryRef;
}

export function getMemoryRefs(
  connection: ChatDbConnection,
  options: {
    memory_namespace?: string;
    memory_key?: string;
    session_id?: number;
    limit?: number;
  } = {},
): ChatMemoryRef[] {
  const conditions: string[] = [];
  if (options.memory_namespace) conditions.push(`memory_namespace = ${sqlQuote(options.memory_namespace)}`);
  if (options.memory_key) conditions.push(`memory_key = ${sqlQuote(options.memory_key)}`);
  if (options.session_id != null) conditions.push(`session_id = ${options.session_id}`);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  const result = runJson(
    connection,
    `SELECT COALESCE(
      (SELECT json_agg(row_to_json(t))::text
       FROM (
         SELECT * FROM pinokio_chat.memory_refs ${where}
         ORDER BY created_at DESC LIMIT ${limit}
       ) t),
      '[]'
    );`,
  );
  return Array.isArray(result) ? result : [];
}

export function getSessionsForMemory(
  connection: ChatDbConnection,
  memoryNamespace: string,
  memoryKey: string,
): ChatSession[] {
  const result = runJson(
    connection,
    `SELECT COALESCE(
      (SELECT json_agg(row_to_json(t))::text
       FROM (
         SELECT DISTINCT s.*
         FROM pinokio_chat.memory_refs r
         JOIN pinokio_chat.sessions s ON s.id = r.session_id
         WHERE r.memory_namespace = ${sqlQuote(memoryNamespace)}
           AND r.memory_key = ${sqlQuote(memoryKey)}
         ORDER BY s.updated_at DESC
       ) t),
      '[]'
    );`,
  );
  return Array.isArray(result) ? result : [];
}

/* ------------------------------------------------------------------ */
/*  Auto-flagging heuristic                                            */
/* ------------------------------------------------------------------ */

const PLUGIN_RESPONSE_MODES = new Set([
  'plugin_first_playwright',
  'plugin_first_directory',
  'plugin_first_directory_llm',
  'spawn_child_unsafe_host',
]);

const ERROR_PATTERNS = /\b(error|exception|failed|failure|crash|bug|fix|debug|issue|broken|stack\s*trace)\b/i;
const CONFIG_PATTERNS = /\b(config|setting|configure|setup|install|credential|api[_\s-]?key|password|token|secret)\b/i;
const SECURITY_PATTERNS = /\b(security|vulnerability|exploit|injection|xss|csrf|auth|permission|access[_\s-]?control)\b/i;
const FILE_OP_PATTERNS = /\b(created?\s+file|deleted?\s+file|renamed?\s+file|moved?\s+file|wrote\s+to|saved?\s+to)\b/i;

export function autoFlagImportance(
  content: string,
  role: string,
  responseMode: string | null,
): { importance: number; flagged_for_memory: boolean; auto_tags: string[] } {
  const tags: string[] = [];
  let importance = 0;
  let flagged = false;

  // Plugin-routed responses are at least important
  if (responseMode && PLUGIN_RESPONSE_MODES.has(responseMode)) {
    importance = Math.max(importance, 2);
    flagged = true;
    tags.push('plugin_routed');
    if (responseMode.includes('playwright')) tags.push('playwright');
    if (responseMode.includes('directory')) tags.push('filesystem');
    if (responseMode.includes('unsafe_host')) tags.push('unsafe_host');
  }

  // Error-related content is critical
  if (ERROR_PATTERNS.test(content)) {
    importance = Math.max(importance, 3);
    flagged = true;
    tags.push('error');
  }

  // Config/security decisions are critical
  if (SECURITY_PATTERNS.test(content)) {
    importance = Math.max(importance, 3);
    flagged = true;
    tags.push('security');
  }
  if (CONFIG_PATTERNS.test(content)) {
    importance = Math.max(importance, 2);
    flagged = true;
    tags.push('config');
  }

  // File operations are important
  if (FILE_OP_PATTERNS.test(content)) {
    importance = Math.max(importance, 2);
    flagged = true;
    tags.push('file_operation');
  }

  // Substantive assistant responses with decent length are notable
  if (role === 'assistant' && content.length > 200 && importance === 0) {
    importance = 1;
  }

  return { importance, flagged_for_memory: flagged, auto_tags: tags };
}

/* ------------------------------------------------------------------ */
/*  Token estimation                                                   */
/* ------------------------------------------------------------------ */

export function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  return Math.ceil(words * 1.3);
}
