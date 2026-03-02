import fs from 'node:fs';
import path from 'node:path';
import { fail } from '../../sdk/typescript/pinokio-sdk.ts';
import { asOptionalString, normalizeAction } from '../plugin-utils.ts';
import type { TargetMeta, ScriptStep } from './shared.ts';
import { ensureInsideScope, normalizeScriptOperation } from './shared.ts';
import { createSingleFileZipBuffer, createPdfBufferFromText, MAX_ZIP_SOURCE_BYTES } from './binary-formats.ts';
import {
  executeEnsurePackagesStep,
  executeRemovePackagesStep,
  executeRestorePackagesStep
} from './package-management.ts';
import {
  ensureParentDir,
  ensureUniquePath,
  extractHandoffMatches,
  executeDeleteByExtension,
  executeCleanup,
  executeZipFilesOverSize
} from './write.ts';
import type { HandoffMatch, MutationResult } from './write.ts';

// ── Types ───────────────────────────────────────────────────────────

export interface ScriptDefinition {
  steps: ScriptStep[];
  stop_on_error: boolean;
  require_handoff_matches: boolean;
}

export interface TemplateContext {
  scope_dir: string;
  index: number;
  match_index?: number;
  match?: HandoffMatch | null;
}

// ── Helpers ─────────────────────────────────────────────────────────

export function normalizeScriptStepOperation(value: unknown): string {
  const op = normalizeAction(value);
  if (!op) {
    return '';
  }
  if (op === 'mkdirp') {
    return 'mkdir';
  }
  if (op === 'write' || op === 'replace') {
    return 'write_file';
  }
  if (op === 'append') {
    return 'append_file';
  }
  if (op === 'copy') {
    return 'copy_file';
  }
  if (op === 'delete' || op === 'remove') {
    return 'delete_path';
  }
  if (op === 'zip') {
    return 'zip_file';
  }
  if (op === 'install_packages' || op === 'apt_install') {
    return 'ensure_packages';
  }
  if (op === 'uninstall_packages' || op === 'apt_remove' || op === 'purge_packages') {
    return 'remove_packages';
  }
  if (op === 'restore_ledger_packages' || op === 'restore_packages') {
    return 'restore_packages';
  }
  return op;
}

export function parseScriptDefinition(targetMeta: TargetMeta): ScriptDefinition {
  let script: Record<string, unknown> | null = null;
  if (Array.isArray(targetMeta.script)) {
    script = { steps: targetMeta.script };
  } else if (targetMeta.script && typeof targetMeta.script === 'object' && !Array.isArray(targetMeta.script)) {
    script = targetMeta.script as Record<string, unknown>;
  } else if (
    targetMeta.script_plan &&
    typeof targetMeta.script_plan === 'object' &&
    !Array.isArray(targetMeta.script_plan) &&
    (targetMeta.script_plan as Record<string, unknown>).script &&
    typeof (targetMeta.script_plan as Record<string, unknown>).script === 'object' &&
    !Array.isArray((targetMeta.script_plan as Record<string, unknown>).script)
  ) {
    script = (targetMeta.script_plan as Record<string, unknown>).script as Record<string, unknown>;
  } else if (typeof targetMeta.script === 'string') {
    const trimmed = (targetMeta.script as string).trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          script = { steps: parsed };
        } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          script = parsed;
        }
      } catch {
        fail('run_script requires target.script JSON with a steps array');
      }
    }
  }

  if (!script) {
    fail('run_script requires target.script');
  }

  const rawSteps = Array.isArray(script.steps)
    ? script.steps
    : Array.isArray(script.operations)
      ? script.operations
      : null;
  if (!rawSteps || rawSteps.length === 0) {
    fail('run_script requires script.steps with at least one step');
  }
  if (rawSteps.length > 200) {
    fail('run_script supports at most 200 steps');
  }

  const steps: ScriptStep[] = rawSteps.map((step: unknown, index: number) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      fail(`run_script step #${index + 1} must be an object`);
    }
    const stepObj = step as Record<string, unknown>;
    const op = normalizeScriptStepOperation(stepObj.op || stepObj.operation);
    if (!op) {
      fail(`run_script step #${index + 1} requires op`);
    }
    return {
      ...stepObj,
      op
    };
  });

  const requireMatches =
    typeof script.require_handoff_matches === 'boolean'
      ? script.require_handoff_matches
      : typeof targetMeta.require_handoff_matches === 'boolean'
        ? targetMeta.require_handoff_matches as boolean
        : true;

  return {
    steps,
    stop_on_error: script.stop_on_error !== false,
    require_handoff_matches: requireMatches
  };
}

export function resolveTemplateString(value: unknown, context: TemplateContext): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match: string, token: string) => {
    const key = String(token || '').trim().toLowerCase();
    if (key === 'scope_dir') {
      return String(context.scope_dir || '');
    }
    if (key === 'index') {
      return String(context.index ?? 0);
    }
    if (key.startsWith('match.')) {
      if (!context.match || typeof context.match !== 'object') {
        fail(`template token '${token}' requires for_each_match context`);
      }
      const field = key.slice('match.'.length);
      if (field === 'path') {
        return String(context.match.path || '');
      }
      if (field === 'name') {
        return String(context.match.name || '');
      }
      if (field === 'kind') {
        return String(context.match.kind || '');
      }
      if (field === 'size') {
        return String(context.match.size ?? '');
      }
    }
    fail(`unsupported template token '${token}'`);
  });
}

export function resolveScriptPath(scopeDir: string, rawValue: unknown, fieldName: string, context: TemplateContext): string {
  const templateValue = resolveTemplateString(rawValue, context);
  const input = asOptionalString(templateValue);
  if (!input) {
    fail(`${fieldName} is required in run_script`);
  }
  if (path.isAbsolute(input)) {
    return ensureInsideScope(scopeDir, input);
  }
  return ensureInsideScope(scopeDir, path.join(scopeDir, input));
}

export function resolveScriptString(rawValue: unknown, fieldName: string, context: TemplateContext, allowEmpty: boolean = false): string {
  const templateValue = resolveTemplateString(rawValue, context);
  const value = typeof templateValue === 'string' ? templateValue : String(templateValue ?? '');
  if (!allowEmpty && !value.trim()) {
    fail(`${fieldName} is required in run_script`);
  }
  return value;
}

export function filterMatches(matches: HandoffMatch[], selector: unknown): HandoffMatch[] {
  const mode = normalizeAction(selector || 'all');
  if (mode === 'file' || mode === 'files') {
    return matches.filter((item) => item.kind === 'file');
  }
  if (mode === 'directory' || mode === 'directories' || mode === 'dir' || mode === 'dirs') {
    return matches.filter((item) => item.kind === 'directory');
  }
  return matches;
}

export function executeRunScriptStep(scopeDir: string, step: ScriptStep, context: TemplateContext, dryRun: boolean): MutationResult {
  const op = normalizeScriptStepOperation(step.op || step.operation);

  if (op === 'mkdir') {
    const fullPath = resolveScriptPath(scopeDir, step.path, 'path', context);
    const recursive = step.recursive !== false;
    if (!dryRun) {
      fs.mkdirSync(fullPath, { recursive });
    }
    return {
      operation: 'mkdir',
      path: fullPath,
      recursive,
      script: `mkdir ${recursive ? '-p ' : ''}${JSON.stringify(fullPath)}`.trim()
    };
  }

  if (op === 'write_file') {
    const fullPath = resolveScriptPath(scopeDir, step.path, 'path', context);
    const overwrite = step.overwrite !== false;
    const ensureParent = step.ensure_parent !== false;
    const content = resolveScriptString(step.content ?? '', 'content', context, true);
    if (!dryRun) {
      if (ensureParent) {
        ensureParentDir(fullPath);
      }
      if (fs.existsSync(fullPath) && !overwrite) {
        fail(`write_file target already exists: ${fullPath}`);
      }
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        fail(`write_file target is a directory: ${fullPath}`);
      }
      fs.writeFileSync(fullPath, content, {
        encoding: 'utf8',
        flag: overwrite ? 'w' : 'wx'
      });
    }
    return {
      operation: 'write_file',
      path: fullPath,
      overwrite,
      bytes_written: Buffer.byteLength(content, 'utf8'),
      script: overwrite
        ? `cat > ${JSON.stringify(fullPath)} <<'EOF'\n${content}\nEOF`
        : `cat > ${JSON.stringify(fullPath)} (fails if exists)`
    };
  }

  if (op === 'append_file') {
    const fullPath = resolveScriptPath(scopeDir, step.path, 'path', context);
    const ensureParent = step.ensure_parent !== false;
    const content = resolveScriptString(step.content ?? '', 'content', context, true);
    if (!dryRun) {
      if (ensureParent) {
        ensureParentDir(fullPath);
      }
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
        fail(`append_file target is a directory: ${fullPath}`);
      }
      fs.appendFileSync(fullPath, content, { encoding: 'utf8' });
    }
    return {
      operation: 'append_file',
      path: fullPath,
      bytes_appended: Buffer.byteLength(content, 'utf8'),
      script: `cat >> ${JSON.stringify(fullPath)} <<'EOF'\n${content}\nEOF`
    };
  }

  if (op === 'create_pdf') {
    const fullPath = resolveScriptPath(scopeDir, step.path, 'path', context);
    const overwrite = step.overwrite !== false;
    const ensureParent = step.ensure_parent !== false;
    const content = resolveScriptString(step.content ?? '', 'content', context, true);
    const pdfBuffer = createPdfBufferFromText(content);
    if (!dryRun) {
      if (ensureParent) {
        ensureParentDir(fullPath);
      }
      if (fs.existsSync(fullPath) && !overwrite) {
        fail(`create_pdf target already exists: ${fullPath}`);
      }
      fs.writeFileSync(fullPath, pdfBuffer, { flag: overwrite ? 'w' : 'wx' });
    }
    return {
      operation: 'create_pdf',
      path: fullPath,
      overwrite,
      bytes_written: pdfBuffer.length,
      script: `create_pdf ${JSON.stringify(fullPath)} <<'TEXT'\n${content}\nTEXT`
    };
  }

  if (op === 'delete_path') {
    const fullPath = resolveScriptPath(scopeDir, step.path, 'path', context);
    const recursive = step.recursive !== false;
    const ignoreMissing = step.ignore_missing === true;
    if (!dryRun) {
      if (!fs.existsSync(fullPath)) {
        if (!ignoreMissing) {
          fail(`delete_path target not found: ${fullPath}`);
        }
      } else {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory() && !recursive) {
          fail(`delete_path target is a directory; set recursive=true: ${fullPath}`);
        }
        fs.rmSync(fullPath, { recursive, force: false });
      }
    }
    return {
      operation: 'delete_path',
      path: fullPath,
      recursive,
      ignore_missing: ignoreMissing,
      script: recursive
        ? `rm -rf ${JSON.stringify(fullPath)}`
        : `rm -f ${JSON.stringify(fullPath)}`
    };
  }

  if (op === 'rename') {
    const sourcePath = resolveScriptPath(scopeDir, step.path, 'path', context);
    const newName = resolveScriptString(step.new_name, 'new_name', context);
    if (newName.includes('/') || newName.includes('\\')) {
      fail('rename new_name must be a single filename');
    }
    const destinationPath = ensureInsideScope(scopeDir, path.join(path.dirname(sourcePath), newName));
    if (!dryRun) {
      if (!fs.existsSync(sourcePath)) {
        fail(`rename source does not exist: ${sourcePath}`);
      }
      fs.renameSync(sourcePath, destinationPath);
    }
    return {
      operation: 'rename',
      source_path: sourcePath,
      destination_path: destinationPath,
      script: `mv ${JSON.stringify(sourcePath)} ${JSON.stringify(destinationPath)}`
    };
  }

  if (op === 'move') {
    const sourcePath = resolveScriptPath(scopeDir, step.path, 'path', context);
    let destinationPath = resolveScriptPath(scopeDir, step.destination, 'destination', context);
    if (!dryRun) {
      if (!fs.existsSync(sourcePath)) {
        fail(`move source does not exist: ${sourcePath}`);
      }
      if (fs.existsSync(destinationPath) && fs.statSync(destinationPath).isDirectory()) {
        destinationPath = ensureInsideScope(scopeDir, path.join(destinationPath, path.basename(sourcePath)));
      }
      ensureParentDir(destinationPath);
      fs.renameSync(sourcePath, destinationPath);
    }
    return {
      operation: 'move',
      source_path: sourcePath,
      destination_path: destinationPath,
      script: `mv ${JSON.stringify(sourcePath)} ${JSON.stringify(destinationPath)}`
    };
  }

  if (op === 'copy_file') {
    const sourcePath = resolveScriptPath(scopeDir, step.path, 'path', context);
    const overwrite = step.overwrite === true;
    let destinationPath = resolveScriptPath(scopeDir, step.destination, 'destination', context);
    if (!dryRun) {
      if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
        fail(`copy_file source must be a file: ${sourcePath}`);
      }
      if (fs.existsSync(destinationPath) && fs.statSync(destinationPath).isDirectory()) {
        destinationPath = ensureInsideScope(scopeDir, path.join(destinationPath, path.basename(sourcePath)));
      }
      if (fs.existsSync(destinationPath) && !overwrite) {
        fail(`copy_file destination already exists: ${destinationPath}`);
      }
      ensureParentDir(destinationPath);
      fs.copyFileSync(sourcePath, destinationPath);
    }
    return {
      operation: 'copy_file',
      source_path: sourcePath,
      destination_path: destinationPath,
      overwrite,
      script: `cp ${JSON.stringify(sourcePath)} ${JSON.stringify(destinationPath)}`
    };
  }

  if (op === 'zip_file') {
    const sourcePath = resolveScriptPath(scopeDir, step.path, 'path', context);
    const deleteSource = step.delete_source === true;
    const destinationRaw = asOptionalString(resolveTemplateString(step.destination, context));
    if (!dryRun) {
      if (!fs.existsSync(sourcePath)) {
        fail(`zip_file source not found: ${sourcePath}`);
      }
      const sourceStat = fs.statSync(sourcePath);
      if (!sourceStat.isFile()) {
        fail(`zip_file source must be a file: ${sourcePath}`);
      }
      if (sourceStat.size > MAX_ZIP_SOURCE_BYTES) {
        fail(`zip_file source too large (${sourceStat.size} bytes): ${sourcePath}`);
      }
    }
    const sourceStat = fs.existsSync(sourcePath) ? fs.statSync(sourcePath) : null;
    const baseName = path.basename(sourcePath);
    const defaultZipName = baseName.endsWith('.zip') ? `${baseName}.packed.zip` : `${baseName}.zip`;
    let destinationPath = destinationRaw
      ? resolveScriptPath(scopeDir, destinationRaw, 'destination', context)
      : ensureInsideScope(scopeDir, path.join(path.dirname(sourcePath), defaultZipName));
    if (!path.extname(destinationPath)) {
      destinationPath = ensureInsideScope(scopeDir, path.join(destinationPath, defaultZipName));
    }
    destinationPath = ensureUniquePath(destinationPath);

    if (!dryRun) {
      const sourceBuffer = fs.readFileSync(sourcePath);
      const zipBuffer = createSingleFileZipBuffer(baseName, sourceBuffer, sourceStat ? sourceStat.mtime : new Date());
      ensureParentDir(destinationPath);
      fs.writeFileSync(destinationPath, zipBuffer, { flag: 'wx' });
      if (deleteSource) {
        fs.rmSync(sourcePath, { recursive: false, force: false });
      }
    }
    return {
      operation: 'zip_file',
      source_path: sourcePath,
      destination_path: destinationPath,
      delete_source: deleteSource,
      script: `zip ${JSON.stringify(destinationPath)} ${JSON.stringify(sourcePath)}`
    };
  }

  if (op === 'ensure_packages') {
    return executeEnsurePackagesStep(scopeDir, step, context, dryRun);
  }

  if (op === 'remove_packages') {
    return executeRemovePackagesStep(scopeDir, step, context, dryRun);
  }

  if (op === 'restore_packages') {
    return executeRestorePackagesStep(scopeDir, step, context, dryRun);
  }

  fail(`unsupported run_script step op '${op}'`);
}

export function executeRunScript(scopeDir: string, targetMeta: TargetMeta, dryRun: boolean): MutationResult {
  const definition = parseScriptDefinition(targetMeta);
  const handoffMatches = extractHandoffMatches(scopeDir, targetMeta, {
    required: definition.require_handoff_matches
  });
  const stepResults: Record<string, unknown>[] = [];
  const scriptLines: string[] = [];

  for (let stepIndex = 0; stepIndex < definition.steps.length; stepIndex += 1) {
    const step = definition.steps[stepIndex];
    const forEach = step.for_each_match === true;
    const selectedMatches = forEach ? filterMatches(handoffMatches, step.select) : [null];

    if (forEach && selectedMatches.length === 0) {
      if (definition.require_handoff_matches || step.require_match === true) {
        fail(`run_script step #${stepIndex + 1} requires handoff matches`);
      }
      continue;
    }

    for (let matchIndex = 0; matchIndex < selectedMatches.length; matchIndex += 1) {
      const match = selectedMatches[matchIndex];
      const context: TemplateContext = {
        scope_dir: scopeDir,
        index: stepIndex,
        match_index: matchIndex,
        match
      };
      try {
        const result = executeRunScriptStep(scopeDir, step, context, dryRun);
        stepResults.push({
          step_index: stepIndex,
          match_index: match ? matchIndex : null,
          match_path: match ? match.path : null,
          ...result
        });
        if (typeof result.script === 'string' && (result.script as string).trim()) {
          scriptLines.push(result.script as string);
        }
      } catch (error) {
        if (!definition.stop_on_error) {
          stepResults.push({
            step_index: stepIndex,
            match_index: match ? matchIndex : null,
            match_path: match ? match.path : null,
            operation: step.op,
            error: error instanceof Error ? error.message : String(error)
          });
          continue;
        }
        throw error;
      }
    }
  }

  return {
    operation: 'run_script',
    step_count: definition.steps.length,
    executed_count: stepResults.length,
    require_handoff_matches: definition.require_handoff_matches,
    handoff_match_count: handoffMatches.length,
    stop_on_error: definition.stop_on_error,
    results: stepResults.slice(0, 500),
    script: scriptLines.join('\n'),
    applied: !dryRun
  };
}

export function executeScriptedOperation(scopeDir: string, targetMeta: TargetMeta, dryRun: boolean): MutationResult {
  const operation = normalizeScriptOperation(targetMeta.operation || '');

  if (operation === 'delete_by_extension') {
    return executeDeleteByExtension(scopeDir, targetMeta, dryRun);
  }
  if (operation === 'cleanup') {
    return executeCleanup(scopeDir, targetMeta, dryRun);
  }
  if (operation === 'zip_files_over_size') {
    return executeZipFilesOverSize(scopeDir, targetMeta, dryRun);
  }
  if (operation === 'run_script') {
    return executeRunScript(scopeDir, targetMeta, dryRun);
  }

  fail(`unsupported scripted explorer operation '${operation}'`);
}
