/**
 * EphemeralVmHost abstracts the host-process facilities the runtime's environment-recipe RPCs
 * need but must not import: provisioning and SSH-backed repo registration.
 *
 * Why a port at all: the runtime has to stay bootable on plain Node (`pnpm run build:orcad`,
 * enforced by config/scripts/check-runtime-electron-ratchet.mjs against an intentionally EMPTY
 * baseline). Those facilities reach `electron` — directly, and transitively through the SSH IPC
 * layer, which pulls in the browser stack and `node:sqlite` behind it. Importing them from an RPC
 * method, even with a dynamic `import()`, puts all of it in the runtime's graph: the ratchet
 * measures reachability, not evaluation order.
 *
 * So the RPC methods depend on this interface and the desktop installs an implementation. A
 * headless host that never provisions installs nothing and simply reports the feature
 * unavailable, which is the same shape `getAppEnvironment()` uses for paths.
 *
 * Types only, deliberately: every signature here is type-level or drawn from src/shared, so this
 * module pulls in no implementation and stays free of `node:` imports (src/shared/** is in the
 * web build graph).
 */

import type { EphemeralVmRecipeResult } from './ephemeral-vm-recipes'

export type EphemeralVmProvisionRequest = {
  repoId: string
  recipeId: string
  workspaceName?: string
  projectId?: string
  workspaceId?: string
  branch?: string
  ref?: string
}

/** The subset of a provision result the RPC layer projects to callers. */
export type EphemeralVmProvisionOutcome =
  | {
      ok: true
      connectionType: 'ssh' | 'orca-server'
      runtimeId: string
      /** Set when connectionType is 'ssh'. */
      sshTargetId?: string
      /** Set when connectionType is 'orca-server'. */
      environmentId?: string
      recipeResult: EphemeralVmRecipeResult
      expectedRefHead?: string
      warnings: { message?: string }[]
    }
  | { ok: false; error: string; stderr: string; stdout: string }

export type EphemeralVmRepoRegistration =
  | { ok: true; repoId: string; projectHostSetupId: string; projectId: string; path: string }
  | { ok: false; error: string }

export type EphemeralVmHost = {
  listRecipes(repoId: string): Promise<unknown>
  provision(request: EphemeralVmProvisionRequest): Promise<EphemeralVmProvisionOutcome>
  /**
   * Register a provisioned checkout as a project host setup. Splits on host kind internally:
   * an ssh: host cannot use the local git/filesystem providers, so it goes through the same
   * remote-registration path the desktop uses.
   */
  registerProvisionedRepo(args: {
    hostId: string
    projectId: string
    path: string
    sshTargetId?: string
  }): Promise<EphemeralVmRepoRegistration>
}

/**
 * Realm-anchored for the same reason AppEnvironment is: `vi.resetModules()` hands the re-imported
 * graph a fresh module copy, so a host installed before the reset would read back as uninstalled.
 */
const SLOT = Symbol.for('orca.host.ephemeralVmHost')

type Slot = { [SLOT]?: EphemeralVmHost | null }

function slot(): Slot {
  return globalThis as unknown as Slot
}

/** Install the active host. The desktop entrypoint calls this once during startup. */
export function setEphemeralVmHost(host: EphemeralVmHost | null): void {
  slot()[SLOT] = host
}

/**
 * Null when no host is installed — a plain-Node runtime with no recipe support. Callers report
 * the feature unavailable rather than throwing at import time, so the runtime still boots.
 */
export function getEphemeralVmHost(): EphemeralVmHost | null {
  return slot()[SLOT] ?? null
}
