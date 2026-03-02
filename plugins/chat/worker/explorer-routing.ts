import path from 'node:path';
import { asOptionalString } from '../../plugin-utils.ts';
import type {
  ExplorerTarget,
  ExplorerCall,
  PendingFilesystemState,
  BuildExplorerOptions,
  ExplorerHeuristicResult,
} from './types.ts';
import {
  looksLikeFilesystemIntent,
  messageReferencesPriorFile,
  isExplicitPriorFileWriteIntent,
} from './intent-detection.ts';
import { isMutationAction, looksLikeExplicitPathSyntax, normalizeExplorerAction } from './shared-actions.ts';

/* ------------------------------------------------------------------ */
/*  Re-export parsing helpers (extracted to explorer-parsing.ts)        */
/* ------------------------------------------------------------------ */

import {
  inferCrudActionFromMessage,
  sanitizeInferredPath,
  inferPathFromMessage,
  parseInlineCreateContent,
  parseRenameNewNameFromMessage,
  formatTimestampForFileName,
  inferDefaultCreateFileName,
  parseSizeToBytes,
  parseMinSizeBytesFromMessage,
  parseExtensionListFromMessage,
  formatHumanBytes,
  maybeReadableBytesReply,
  inferScopeFromMessage,
} from './explorer-parsing.ts';

export {
  inferCrudActionFromMessage,
  sanitizeInferredPath,
  inferPathFromMessage,
  parseInlineCreateContent,
  parseRenameNewNameFromMessage,
  formatTimestampForFileName,
  inferDefaultCreateFileName,
  parseSizeToBytes,
  parseMinSizeBytesFromMessage,
  parseExtensionListFromMessage,
  formatHumanBytes,
  maybeReadableBytesReply,
  inferScopeFromMessage,
};

export { looksLikeExplicitPathSyntax } from './shared-actions.ts';

/* ------------------------------------------------------------------ */
/*  Build / route (lines 2703-3075)                                    */
/* ------------------------------------------------------------------ */

export function buildExplorerTargetFromMessage(message: string, requestedAction: string, options: BuildExplorerOptions = {}): ExplorerCall | null {
  const lower = String(message || '').toLowerCase();
  const defaultScope = asOptionalString(process.env.PINOKIO_EXPLORER_SCOPE) || '/app';
  const hostDocumentsScope =
    asOptionalString(process.env.PINOKIO_HOST_DOCUMENTS_SCOPE) || defaultScope;
  const hostDesktopScope =
    asOptionalString(process.env.PINOKIO_HOST_DESKTOP_SCOPE) || '/host/Desktop';
  const channel = asOptionalString(options.channel) || 'default';
  const responseFormat = asOptionalString(options.response_format);
  const lastFilePath = asOptionalString(options.last_file_path);
  const scopeDir = inferScopeFromMessage(
    lower,
    defaultScope,
    hostDocumentsScope,
    hostDesktopScope
  );
  const inferredAction = inferCrudActionFromMessage(message, requestedAction);
  const inferredPath = inferPathFromMessage(message);
  const renameIntent = lower.includes('rename');
  const renameNewName = parseRenameNewNameFromMessage(message);
  const referencesLastFile = messageReferencesPriorFile(message);
  const inferredPathIsBareFilename =
    Boolean(inferredPath) &&
    !String(inferredPath).includes('/') &&
    !String(inferredPath).includes('\\') &&
    !String(inferredPath).startsWith('~');
  const listIntent =
    lower.includes('list') ||
    lower.includes('show') ||
    lower.includes('display') ||
    lower.includes('get a list');
  const infoIntent =
    lower.includes('size') ||
    lower.includes('folder size') ||
    lower.includes('directory size') ||
    lower.includes('how big') ||
    lower.includes('disk usage') ||
    lower.includes('details for') ||
    lower.includes('info about');
  const cleanupIntent =
    lower.includes('clean up') || lower.includes('cleanup') || lower.includes('organize');
  const zipIntent =
    lower.includes('zip') || lower.includes('archive') || lower.includes('compress');
  const deleteAllExtIntent =
    (lower.includes('delete') || lower.includes('remove')) &&
    (lower.includes('all') || lower.includes('every')) &&
    (lower.includes('.rar') || lower.includes('rars') || lower.includes('extensions'));
  const extensionsFromMessage = parseExtensionListFromMessage(message);
  const minSizeBytes = parseMinSizeBytesFromMessage(message);

  if (infoIntent && inferredAction === 'read') {
    const target: ExplorerTarget = {
      scope_dir: scopeDir,
      desired_action: 'info',
      channel,
      dry_run: false
    };
    if (responseFormat) {
      target.response_format = responseFormat;
    }
    if (inferredPath) {
      target.path = inferredPath;
    } else {
      target.path = scopeDir;
    }
    return {
      action: 'read',
      target
    };
  }

  if (cleanupIntent && lower.includes('desktop')) {
    const target: ExplorerTarget = {
      scope_dir: hostDesktopScope,
      desired_action: 'update',
      operation: 'cleanup',
      cleanup_profile: 'desktop',
      recursive: true,
      channel,
      dry_run: false
    };
    if (responseFormat) {
      target.response_format = responseFormat;
    }
    return {
      action: 'update',
      target
    };
  }

  if (deleteAllExtIntent || (extensionsFromMessage.length > 0 && lower.includes('delete'))) {
    const target: ExplorerTarget = {
      scope_dir: scopeDir,
      desired_action: 'delete',
      operation: 'delete_by_extension',
      extensions: extensionsFromMessage.length > 0 ? extensionsFromMessage : ['rar'],
      recursive: true,
      channel,
      dry_run: false
    };
    if (responseFormat) {
      target.response_format = responseFormat;
    }
    return {
      action: 'delete',
      target
    };
  }

  if (zipIntent && minSizeBytes) {
    const target: ExplorerTarget = {
      scope_dir: scopeDir,
      desired_action: 'update',
      operation: 'zip_files_over_size',
      min_size_bytes: minSizeBytes,
      recursive: true,
      channel,
      dry_run: false
    };
    if (responseFormat) {
      target.response_format = responseFormat;
    }
    return {
      action: 'update',
      target
    };
  }

  const target: ExplorerTarget = {
    scope_dir: scopeDir,
    desired_action: inferredAction,
    channel,
    dry_run: false
  };
  if (responseFormat) {
    target.response_format = responseFormat;
  }

  const useLastFileAsRenameSource =
    Boolean(lastFilePath) &&
    renameIntent &&
    Boolean(renameNewName) &&
    (
      !inferredPath ||
      referencesLastFile ||
      lower.includes('last file') ||
      lower.includes('previous file') ||
      String(inferredPath).toLowerCase() === String(renameNewName).toLowerCase()
    );

  if (useLastFileAsRenameSource && lastFilePath) {
    target.path = lastFilePath;
    target.scope_dir = path.dirname(lastFilePath);
  } else if (inferredPath) {
    if (inferredPathIsBareFilename) {
      target.path = path.join(scopeDir, inferredPath);
    } else {
      target.path = inferredPath;
    }
  } else if (lastFilePath && referencesLastFile) {
    target.path = lastFilePath;
    target.scope_dir = path.dirname(lastFilePath);
  }

  if (typeof target.path === 'string' && path.isAbsolute(target.path)) {
    target.scope_dir = path.dirname(target.path);
  }

  if (!inferredPath && inferredAction === 'read') {
    const directFolderListing =
      listIntent &&
      (lower.includes('documents') || lower.includes('downloads') || lower.includes('desktop'));
    if (!directFolderListing) {
      target.query = message;
    }
  }

  if (inferredAction === 'create') {
    if (lower.includes('folder') || lower.includes('directory')) {
      target.kind = 'directory';
    } else {
      target.kind = 'file';
    }
    const targetPath = typeof target.path === 'string' ? target.path.toLowerCase() : '';
    if (targetPath.endsWith('.pdf') || lower.includes('pdf')) {
      target.operation = 'create_pdf';
      target.kind = 'file';
    }
    const inlineContent = parseInlineCreateContent(message);
    if (inlineContent) {
      target.content = inlineContent;
    }
    if (!target.path) {
      target.path = path.join(scopeDir, inferDefaultCreateFileName(message));
    }
  }

  if (inferredAction === 'update') {
    if (renameIntent && renameNewName) {
      target.operation = 'rename';
      target.new_name = renameNewName;
      if (!target.path && lastFilePath) {
        target.path = lastFilePath;
        target.scope_dir = path.dirname(lastFilePath);
      }
    }
    const inlineContent = parseInlineCreateContent(message);
    if (inlineContent) {
      target.content = inlineContent;
      if (!target.operation) {
        target.operation = lower.includes('append') ? 'append' : 'write';
      }
    }
  }

  if (inferredAction === 'delete' && lower.includes('recursive')) {
    target.recursive = true;
  }

  if ((inferredAction === 'create' || inferredAction === 'update' || inferredAction === 'delete') && !target.path) {
    return null;
  }

  return {
    action: inferredAction,
    target
  };
}

export function chooseHeuristicExplorerRoute(params: {
  message: string;
  filesystemIntent: boolean;
  pendingFilesystem: PendingFilesystemState | null;
  pendingExplorerCall: ExplorerCall | null;
  fallbackExplorerCall: ExplorerCall | null;
  lastFilePath: string | null;
}): ExplorerHeuristicResult {
  const {
    message,
    filesystemIntent,
    pendingFilesystem,
    pendingExplorerCall,
    fallbackExplorerCall,
    lastFilePath
  } = params;
  const hasPending = Boolean(pendingFilesystem);
  const hasExplicitPathSyntax = looksLikeExplicitPathSyntax(message);
  const shouldConsiderFilesystemRouting = filesystemIntent || hasPending || hasExplicitPathSyntax;

  if (!shouldConsiderFilesystemRouting) {
    return {
      should_route: false,
      confidence: 'low',
      call: null,
      source: 'none'
    };
  }

  if (pendingExplorerCall) {
    const pathHint = asOptionalString(pendingExplorerCall.target.path);
    if (isMutationAction(pendingExplorerCall.action) && !pathHint) {
      return {
        should_route: true,
        confidence: 'low',
        call: pendingExplorerCall,
        source: 'pending'
      };
    }
    if (
      pendingExplorerCall.action === 'update' &&
      isExplicitPriorFileWriteIntent(message, lastFilePath) &&
      !asOptionalString(pendingExplorerCall.target.content)
    ) {
      return {
        should_route: true,
        confidence: 'low',
        call: pendingExplorerCall,
        source: 'pending'
      };
    }
    return {
      should_route: true,
      confidence: 'high',
      call: pendingExplorerCall,
      source: 'pending'
    };
  }

  if (fallbackExplorerCall) {
    const pathHint = asOptionalString(fallbackExplorerCall.target.path);
    const queryHint = asOptionalString(fallbackExplorerCall.target.query);
    const desiredAction = asOptionalString(fallbackExplorerCall.target.desired_action);

    if (isMutationAction(fallbackExplorerCall.action)) {
      if (!pathHint) {
        return {
          should_route: true,
          confidence: 'low',
          call: fallbackExplorerCall,
          source: 'fallback'
        };
      }
      if (
        fallbackExplorerCall.action === 'update' &&
        isExplicitPriorFileWriteIntent(message, lastFilePath) &&
        !asOptionalString(fallbackExplorerCall.target.content)
      ) {
        return {
          should_route: true,
          confidence: 'low',
          call: fallbackExplorerCall,
          source: 'fallback'
        };
      }
      return {
        should_route: true,
        confidence: 'high',
        call: fallbackExplorerCall,
        source: 'fallback'
      };
    }

    if (desiredAction === 'info') {
      return {
        should_route: true,
        confidence: 'high',
        call: fallbackExplorerCall,
        source: 'fallback'
      };
    }

    if (fallbackExplorerCall.action === 'read') {
      if (pathHint && !queryHint) {
        return {
          should_route: true,
          confidence: 'high',
          call: fallbackExplorerCall,
          source: 'fallback'
        };
      }
      if (!queryHint && filesystemIntent) {
        return {
          should_route: true,
          confidence: 'high',
          call: fallbackExplorerCall,
          source: 'fallback'
        };
      }
      return {
        should_route: true,
        confidence: 'low',
        call: fallbackExplorerCall,
        source: 'fallback'
      };
    }
  }

  if (filesystemIntent || hasPending) {
    return {
      should_route: true,
      confidence: 'low',
      call: null,
      source: 'none'
    };
  }

  return {
    should_route: false,
    confidence: 'low',
    call: null,
    source: 'none'
  };
}

/* ------------------------------------------------------------------ */
/*  Validation / normalization (lines 3101-3251)                       */
/* ------------------------------------------------------------------ */

export function shouldPreferFallbackExplorerCall(params: {
  llmCall: ExplorerCall;
  fallbackCall: ExplorerCall | null;
  message: string;
  lastFilePath: string | null;
}): boolean {
  const { llmCall, fallbackCall, message, lastFilePath } = params;
  if (!fallbackCall) {
    return false;
  }

  const explicitWriteFollowup = isExplicitPriorFileWriteIntent(message, lastFilePath);
  if (explicitWriteFollowup) {
    const llmPath = sanitizeInferredPath(llmCall.target.path);
    const expectedPath = sanitizeInferredPath(lastFilePath);
    const llmContent = asOptionalString(llmCall.target.content);
    if (llmCall.action !== 'update') {
      return true;
    }
    if (!expectedPath || llmPath !== expectedPath) {
      return true;
    }
    if (!llmContent) {
      return true;
    }
  }

  if (isMutationAction(fallbackCall.action) && !isMutationAction(llmCall.action)) {
    return true;
  }

  const renameIntent = /\brename\b/i.test(String(message || ''));
  if (renameIntent && fallbackCall.action === 'update') {
    const fallbackOperation = asOptionalString(fallbackCall.target.operation)?.toLowerCase();
    const llmOperation = asOptionalString(llmCall.target.operation)?.toLowerCase();
    const fallbackNewName = asOptionalString(fallbackCall.target.new_name);
    const llmNewName = asOptionalString(llmCall.target.new_name);
    if (fallbackOperation === 'rename' && fallbackNewName && (!llmNewName || llmOperation !== 'rename')) {
      return true;
    }
  }

  if (isMutationAction(fallbackCall.action)) {
    const fallbackPath = sanitizeInferredPath(fallbackCall.target.path);
    const llmPath = sanitizeInferredPath(llmCall.target.path);
    if (fallbackPath && !llmPath) {
      return true;
    }
  }

  return false;
}

export function enforcePriorFileWriteCall(call: ExplorerCall, message: string, lastFilePath: string | null): ExplorerCall {
  if (!isExplicitPriorFileWriteIntent(message, lastFilePath) || !lastFilePath) {
    return call;
  }

  const enforcedTarget: ExplorerTarget = {
    ...call.target,
    desired_action: 'update',
    path: lastFilePath,
    scope_dir: path.dirname(lastFilePath),
    dry_run: false
  };
  const inlineContent = parseInlineCreateContent(message);
  if (inlineContent) {
    enforcedTarget.content = inlineContent;
  }
  if (!asOptionalString(enforcedTarget.operation) && asOptionalString(enforcedTarget.content)) {
    enforcedTarget.operation = String(message || '').toLowerCase().includes('append') ? 'append' : 'write';
  }

  return {
    action: 'update',
    target: enforcedTarget
  };
}

export { normalizeExplorerAction } from './shared-actions.ts';

export function normalizePlannerTarget(
  rawTarget: unknown,
  action: string,
  channel: string,
  responseFormat: string | null,
  message: string,
  lastFilePath: string | null
): ExplorerTarget | null {
  if (!rawTarget || typeof rawTarget !== 'object' || Array.isArray(rawTarget)) {
    return null;
  }
  const target: ExplorerTarget = { ...(rawTarget as ExplorerTarget) };
  if (!target.channel) {
    target.channel = channel;
  }
  if (!target.response_format && responseFormat) {
    target.response_format = responseFormat;
  }
  if (typeof target.dry_run !== 'boolean') {
    target.dry_run = false;
  }
  const desiredRaw = asOptionalString(target.desired_action);
  if (desiredRaw) {
    let desired = desiredRaw.toLowerCase();
    if (desired === 'create_file' || desired === 'new_file' || desired === 'mkdir') {
      desired = 'create';
    } else if (desired === 'write' || desired === 'replace' || desired === 'append' || desired === 'edit') {
      desired = 'update';
    } else if (desired === 'remove' || desired === 'rm') {
      desired = 'delete';
    } else if (desired === 'stat' || desired === 'size') {
      desired = 'info';
    }
    if (!['create', 'read', 'update', 'delete', 'info'].includes(desired)) {
      target.desired_action = action;
    } else {
      target.desired_action = desired;
    }
  } else {
    target.desired_action = action;
  }
  if (typeof target.path === 'string') {
    const sanitized = sanitizeInferredPath(target.path);
    if (sanitized) {
      target.path = sanitized;
    }
    if (target.path && path.isAbsolute(target.path) && (action !== 'read' || !target.scope_dir)) {
      target.scope_dir = path.dirname(target.path);
    }
  } else if (lastFilePath && messageReferencesPriorFile(message)) {
    target.path = lastFilePath;
    target.scope_dir = path.dirname(lastFilePath);
  }
  return target;
}

/* ------------------------------------------------------------------ */
/*  Pending / resolve (lines 3611-3692)                                */
/* ------------------------------------------------------------------ */

export function buildExplorerCallFromPending(
  pending: PendingFilesystemState | null,
  message: string,
  channel: string,
  responseFormat: string | null
): ExplorerCall | null {
  if (!pending) {
    return null;
  }
  const action = normalizeExplorerAction(pending.action) || 'update';
  const baseTarget: ExplorerTarget =
    pending.target && typeof pending.target === 'object' && !Array.isArray(pending.target)
      ? { ...(pending.target as ExplorerTarget) }
      : {};
  if (!baseTarget.channel) {
    baseTarget.channel = channel;
  }
  if (!baseTarget.response_format && responseFormat) {
    baseTarget.response_format = responseFormat;
  }
  if (typeof baseTarget.dry_run !== 'boolean') {
    baseTarget.dry_run = false;
  }
  if (!asOptionalString(baseTarget.desired_action)) {
    baseTarget.desired_action = action;
  }

  const inlineContent = parseInlineCreateContent(message);
  if (inlineContent) {
    baseTarget.content = inlineContent;
  } else if (!looksLikeFilesystemIntent(message)) {
    const raw = asOptionalString(message);
    if (raw && !asOptionalString(baseTarget.content)) {
      baseTarget.content = raw;
    }
  }
  if (action === 'update' && asOptionalString(baseTarget.content) && !asOptionalString(baseTarget.operation)) {
    baseTarget.operation = 'write';
  }

  if (isMutationAction(action) && !asOptionalString(baseTarget.path)) {
    return null;
  }
  return { action, target: baseTarget };
}

export function resolveNextLastFilePath(
  call: ExplorerCall,
  previousLastFilePath: string | null
): string | null {
  const routedPath = asOptionalString(call.target.path);
  const operation = asOptionalString(call.target.operation)?.toLowerCase();

  if (call.action === 'delete') {
    if (routedPath && previousLastFilePath) {
      const samePath = path.resolve(routedPath) === path.resolve(previousLastFilePath);
      if (samePath) {
        return null;
      }
    }
    return previousLastFilePath;
  }

  if (call.action === 'update' && operation === 'rename') {
    const newName = asOptionalString(call.target.new_name);
    if (routedPath && newName && !newName.includes('/') && !newName.includes('\\')) {
      return path.join(path.dirname(routedPath), newName);
    }
  }

  if (call.action === 'update' && operation === 'move') {
    const destination = asOptionalString(call.target.destination);
    if (routedPath && destination) {
      if (path.isAbsolute(destination)) {
        return destination;
      }
      return path.join(path.dirname(routedPath), destination);
    }
  }

  return routedPath || previousLastFilePath;
}
