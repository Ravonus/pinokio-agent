// Barrel re-export — all existing `import { ... } from 'pinokio-sdk.ts'` continue to work.
// New code can import directly from the submodules for finer-grained control.

// Types
export type {
  PluginRequest,
  PluginSpec,
  PluginContext,
  ConnectionRequest,
  ConnectionSpec,
  ConnectionContext,
  SpawnChildRequest,
  HookRequest,
  SocketRequest,
  SocketReadOptions,
  ChatDbConnection,
  ChatSession,
  ChatMessage,
  ChatMemoryRef,
  InsertMessageOptions,
  QueryMessagesOptions,
  FlagMessageOptions,
  CreateMemoryRefOptions,
} from './types.ts';

// Context
export { parseJsonEnv, pluginContext, connectionContext } from './context.ts';

// Response
export { respond, spawnChild, requestHook, fail } from './response.ts';

// Socket
export {
  requestSocket,
  requestSockets,
  socketPublish,
  socketRead,
  socketConsume,
  socketReadPluginCatalog,
  socketReadPluginMeta,
  socketReadPluginReadme,
} from './socket.ts';

// Chat DB
export {
  resolveChatDbConnection,
  ensureChatSchema,
  createSession,
  findOrCreateSession,
  closeSession,
  getSession,
  listSessions,
  insertMessage,
  updateSessionCounters,
  queryMessages,
  getSessionMessages,
  getFullContext,
  flagMessage,
  getFlaggedMessages,
  createMemoryRef,
  getMemoryRefs,
  getSessionsForMemory,
  autoFlagImportance,
  estimateTokens,
} from './chat-db.ts';
