/**
 * Type definitions, Zod schemas, and shared constants for the
 * playwright-read agent plugin.
 */

import { z } from 'zod';
import type { PlaywrightActionStep, PlaywrightApiAttempt } from '../common.ts';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const SUPPORTED_ACTIONS: Set<string> = new Set(['read']);

export const CLEANUP_TRAINING_SENTINEL = '[pinokio_cleanup_training_pending]';

export const WORKFLOW_TIMEOUT_POLICY_MS: Record<string, number> = {
	needs_ready: 10 * 60 * 1000,
	needs_policy: 15 * 60 * 1000,
	needs_user_step: 20 * 60 * 1000,
	needs_pilot_approval: 10 * 60 * 1000,
	challenge_detected: 8 * 60 * 1000,
	human_required: 20 * 60 * 1000,
	probing: 12 * 60 * 1000,
	executing: 10 * 60 * 1000
};

/* ------------------------------------------------------------------ */
/*  Interfaces                                                         */
/* ------------------------------------------------------------------ */

export interface PlannerResult {
	actions: PlaywrightActionStep[];
	apiAttempts: PlaywrightApiAttempt[];
	needsUserStep: string | null;
	notes: string | null;
}

export type ProbeWalkthroughStepKind = 'label' | 'action';

export interface ProbeWalkthroughStep {
	id: string;
	kind: ProbeWalkthroughStepKind;
	title: string;
	instruction: string;
	suggested_label?: string | null;
	required: boolean;
}

export interface ProbeWalkthroughPlan {
	goal: string;
	context: string;
	steps: ProbeWalkthroughStep[];
	source: 'llm' | 'fallback' | 'state';
	generated_at: string;
}

export interface ProbeState {
	channel: string;
	updated_at: string;
	task_summary?: string;
	desired_action?: string;
	url?: string | null;
	checkpoint_satisfied?: boolean;
	checkpoint_awaited?: boolean;
	checkpoint_reason?: string | null;
	checkpoint_waited_ms?: number;
	discovery?: Record<string, unknown>;
	planner_actions?: PlaywrightActionStep[];
	planner_api_attempts?: PlaywrightApiAttempt[];
	planner_notes?: string | null;
	needs_user_step?: string | null;
	walkthrough_plan?: ProbeWalkthroughPlan | null;
	workflow_state?: string | null;
	workflow_pending_step?: string | null;
	workflow_last_transition?: string | null;
	workflow_last_error?: string | null;
	site_profile_host?: string | null;
}

export interface ProbeSkillBuildInput {
	skillName: string;
	description: string;
	url: string | null;
	state: ProbeState;
}

export interface SkillRegistrationResult {
	ok: boolean;
	command: string;
	detail: string;
}

/* ------------------------------------------------------------------ */
/*  Zod schemas                                                        */
/* ------------------------------------------------------------------ */

export const plannerPayloadSchema = z.object({
	mode: z.string().optional(),
	question: z.string().optional(),
	notes: z.string().optional(),
	api_attempts: z.array(z.record(z.string(), z.unknown())).optional(),
	actions: z.array(z.record(z.string(), z.unknown())).optional()
}).passthrough();

export const walkthroughStepSchema = z.object({
	id: z.string().min(1).max(100),
	kind: z.enum(['label', 'action']),
	title: z.string().min(1).max(200),
	instruction: z.string().min(1).max(1200),
	suggested_label: z.string().min(1).max(120).optional(),
	required: z.boolean().optional()
}).passthrough();

export const walkthroughPlanSchema = z.object({
	goal: z.string().min(1).max(300).optional(),
	context: z.string().max(300).optional(),
	steps: z.array(walkthroughStepSchema).min(1).max(20)
}).passthrough();
