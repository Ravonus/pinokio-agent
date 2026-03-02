import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildSelectorFallbackStack,
  enforceExecutionGuardrails,
  extractSiteProfileLabels,
  extractSiteProfileNetworkCandidates,
  mapPluginModeToWorkflowTelemetry,
  mergeSiteProfile,
  resolveApiAttemptFromCandidates,
  type SiteProfile
} from '../plugins/playwright/runtime-utils.ts';

interface ReplayFixture {
  name: string;
  host: string;
  labels: Array<Record<string, unknown>>;
  network_candidates: Array<Record<string, unknown>>;
  step: Record<string, unknown>;
  api_attempt: Record<string, unknown>;
  guardrail: {
    mutate: boolean;
    desiredAction: string;
    preferNetworkFirst: boolean;
    cleanupIntent: boolean;
    pilotApproved: boolean;
    requiredLabelKeys: string[];
    actionsCount: number;
    apiAttemptsCount: number;
  };
}

function loadFixture(fileName: string): ReplayFixture {
  const fixturePath = path.join(
    process.cwd(),
    'tests',
    'playwright-replay-fixtures',
    fileName
  );
  const raw = fs.readFileSync(fixturePath, 'utf8');
  return JSON.parse(raw) as ReplayFixture;
}

function buildProfile(fixture: ReplayFixture): SiteProfile {
  const labels = extractSiteProfileLabels(fixture.labels);
  const network = extractSiteProfileNetworkCandidates(fixture.network_candidates);
  return mergeSiteProfile(fixture.host, null, {
    labels,
    network_candidates: network,
    mark_success: false
  });
}

function runFixtureAssertions(fixture: ReplayFixture): void {
  const profile = buildProfile(fixture);
  const stack = buildSelectorFallbackStack({
    step: fixture.step,
    siteProfile: profile
  });
  assert.ok(stack.length > 0, `${fixture.name}: selector fallback stack must not be empty`);
  const apiResolved = resolveApiAttemptFromCandidates({
    attempt: fixture.api_attempt,
    siteProfile: profile,
    fallbackOrigin: profile.network_candidates[0]?.origin || null
  });
  if (fixture.name !== 'ecommerce-admin') {
    assert.ok(apiResolved.url, `${fixture.name}: API attempt should resolve to URL`);
  }
  const guard = enforceExecutionGuardrails({
    mutate: fixture.guardrail.mutate,
    desiredAction: fixture.guardrail.desiredAction,
    preferNetworkFirst: fixture.guardrail.preferNetworkFirst,
    cleanupIntent: fixture.guardrail.cleanupIntent,
    pilotApproved: fixture.guardrail.pilotApproved,
    labels: fixture.labels,
    requiredLabelKeys: fixture.guardrail.requiredLabelKeys,
    networkCandidates: fixture.network_candidates,
    actionsCount: fixture.guardrail.actionsCount,
    apiAttemptsCount: fixture.guardrail.apiAttemptsCount
  });
  if (fixture.name === 'ecommerce-admin') {
    assert.equal(guard.ok, false, 'ecommerce-admin: guardrails should block without pilot approval');
    assert.equal(guard.pilotRequired, true, 'ecommerce-admin: pilot guard must trigger');
  } else {
    assert.equal(guard.ok, true, `${fixture.name}: guardrails should pass`);
  }
}

function runWorkflowAssertions(): void {
  const discover = mapPluginModeToWorkflowTelemetry({
    mode: 'discover',
    challengeDetected: false
  });
  assert.equal(discover.state, 'probing');
  const challenge = mapPluginModeToWorkflowTelemetry({
    mode: 'discover',
    challengeDetected: true
  });
  assert.equal(challenge.state, 'challenge_detected');
  const human = mapPluginModeToWorkflowTelemetry({
    mode: 'discovery_needs_user',
    challengeDetected: false,
    needsUserStep: 'Login then READY'
  });
  assert.equal(human.state, 'human_required');
}

function main(): void {
  const fixtures = [
    loadFixture('email.json'),
    loadFixture('dashboard.json'),
    loadFixture('ecommerce-admin.json')
  ];
  for (const fixture of fixtures) {
    runFixtureAssertions(fixture);
  }
  runWorkflowAssertions();
  process.stdout.write('playwright replay fixtures: ok\n');
}

main();
