import { readFileSync } from 'fs';
import { join } from 'path';
import type { ForgeConfig, PipelineConfig } from './types';

const NEXUS_CORE = process.env.NEXUS_CORE_PATH ?? '/Users/<user>/Nexus/core';

/**
 * Default target repo when a ticket doesn't carry an explicit `repoName`.
 * Pre-existing single-repo callers fall through to this so nothing breaks
 * during the multi-repo migration.
 */
export const DEFAULT_REPO_NAME = '[target-repo-realtime]';

let _registry: Record<string, PipelineConfig> | null = null;

function loadRegistry(): Record<string, PipelineConfig> {
  if (_registry) return _registry;
  const nexusJson = JSON.parse(
    readFileSync(join(NEXUS_CORE, 'nexus.json'), 'utf-8'),
  );
  const repos = nexusJson.forge?.repos;
  if (!repos || typeof repos !== 'object') {
    throw new Error(
      'forge.repos block missing in nexus.json — Forge cannot start',
    );
  }
  _registry = repos as Record<string, PipelineConfig>;
  return _registry;
}

/**
 * Resolve the per-repo Forge config. Throws if the repo is not registered
 * in nexus.json's forge.repos block.
 *
 * Activities that already accept a Ticket should call:
 *   getRepoConfig(ticket.repoName ?? DEFAULT_REPO_NAME)
 *
 * Activities that don't take a Ticket (bugbotWait, ciWait, merge,
 * devDeploy, runDeploy, runPatrol) accept an explicit `repoName` param
 * passed by the workflow.
 */
export function getRepoConfig(repoName: string): PipelineConfig {
  const registry = loadRegistry();
  const cfg = registry[repoName];
  if (!cfg) {
    const known = Object.keys(registry).join(', ');
    throw new Error(
      `Unknown forge repo "${repoName}". Known repos: ${known || '(none)'}`,
    );
  }
  return cfg;
}

/**
 * Full registry of every repo Forge knows about. Used by the trigger CLI
 * to validate --repo flags before launching a workflow.
 */
export function getAllRepoConfigs(): Record<string, PipelineConfig> {
  return { ...loadRegistry() };
}

/**
 * Backward-compat default singleton. Old callers that imported the
 * top-level `config` and read `config.pipeline.<field>` continue to
 * work against the default repo. New callers should prefer
 * `getRepoConfig(repoName)` so they pick up per-ticket repo selection.
 */
export const config: ForgeConfig = { pipeline: getRepoConfig(DEFAULT_REPO_NAME) };
