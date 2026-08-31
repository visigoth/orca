import { z } from 'zod'
import { defineMethod } from '../core'
import { requiredString } from '../schemas'
import type { Store } from '../../../persistence'
import type { PluginService } from '../../../plugins/plugin-service'
import { provisionEphemeralVmForRepo } from '../../../ephemeral-vm-provision-core'
import { getApprovedPluginVmRecipes } from '../../../plugins/plugin-approved-vm-recipes'
import { listRecipes } from '../../../ipc/ephemeral-vm-recipe-context'
import {
  getEphemeralVmRecipeResultCheckoutMode,
  getEphemeralVmRecipeResultProjectRoot
} from '../../../../shared/ephemeral-vm-recipes'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../../../../shared/execution-host'
import { getProjectIdentityKey } from '../../../../shared/project-host-setup-projection'

/**
 * Environment recipes over runtime RPC.
 *
 * The recipe surface was previously Electron IPC only, so it was reachable from the app window
 * and nowhere else. `orca worktree create` therefore had no way to ask for a workspace on a
 * recipe-provisioned environment, and a scripted workspace silently ran on the Orca host instead
 * — which is exactly where an agent should not be when the host holds privileged sockets. These
 * methods expose the operations the composer already uses so the CLI can offer the same choice.
 *
 * `vm.provisionWorkspaceTarget` deliberately does provision-then-register in ONE call. The
 * renderer runs those as two steps because it drives a progress UI between them; a CLI caller has
 * no such need, and splitting it would orphan a provisioned environment whenever the second call
 * failed or the client died in between.
 */

// Why: RpcContext carries only the OrcaRuntimeService, while provisioning needs the settings
// Store and the plugin registry. Injected by the composition root via setter, matching how
// methods/plugins.ts reaches the PluginService, rather than widening the shared context type.
let storeForRpc: Store | null = null
let pluginServiceForRpc: PluginService | null = null

export function setEphemeralVmDepsForRpc(
  store: Store | null,
  pluginService?: PluginService | null
): void {
  storeForRpc = store
  pluginServiceForRpc = pluginService ?? null
}

function requireStore(): Store {
  if (!storeForRpc) {
    throw new Error('Environment recipes are not available on this runtime')
  }
  return storeForRpc
}

const VmListRecipes = z.object({
  repo: requiredString('Missing repo selector')
})

const VmProvisionWorkspaceTarget = z.object({
  repo: requiredString('Missing repo selector'),
  recipeId: requiredString('Missing recipe id'),
  workspaceName: z.string().optional(),
  projectId: z.string().optional(),
  branch: z.string().optional(),
  ref: z.string().optional()
})

export const EPHEMERAL_VM_METHODS = [
  defineMethod({
    name: 'vm.listRecipes',
    params: VmListRecipes,
    handler: async (params, { runtime }) => {
      const repo = await runtime.showRepo(params.repo)
      return listRecipes(
        requireStore(),
        repo.id,
        await getApprovedPluginVmRecipes(pluginServiceForRpc ?? undefined)
      )
    }
  }),
  defineMethod({
    name: 'vm.provisionWorkspaceTarget',
    params: VmProvisionWorkspaceTarget,
    handler: async (params, { runtime }) => {
      const repo = await runtime.showRepo(params.repo)
      const provisioned = await provisionEphemeralVmForRepo(
        requireStore(),
        pluginServiceForRpc ?? undefined,
        {
          repoId: repo.id,
          recipeId: params.recipeId,
          ...(params.workspaceName ? { workspaceName: params.workspaceName } : {}),
          ...(params.projectId ? { projectId: params.projectId } : {}),
          ...(params.branch ? { branch: params.branch } : {}),
          ...(params.ref ? { ref: params.ref } : {})
        }
      )
      if (!provisioned.ok) {
        // Why: carry the recipe's own stderr. A create script fails for reasons only its output
        // explains — a missing image, an unreachable provider — and without it the caller gets a
        // bare "provisioning failed" with nothing to act on.
        throw new Error(
          provisioned.stderr.trim()
            ? `${provisioned.error}\n${provisioned.stderr.trim()}`
            : provisioned.error
        )
      }

      const checkoutMode = getEphemeralVmRecipeResultCheckoutMode(provisioned.runtime.recipeResult)
      const hostId =
        provisioned.connectionType === 'ssh'
          ? toSshExecutionHostId(provisioned.sshTargetId)
          : toRuntimeExecutionHostId(provisioned.environment.id)

      // Registering the environment's checkout as a project host setup is what makes it a valid
      // target for worktree.create. Mirrors prepareEphemeralVmWorkspaceTarget in the renderer.
      // projectId is required here. The renderer gates on a github: key to preserve behaviour
      // for portable projects, but a CLI caller always needs *some* id, and the shared identity
      // key is the canonical one — falling back to git:/repo: rather than inventing a value.
      const setup = await runtime.setupProjectExistingFolder({
        projectId: params.projectId ?? getProjectIdentityKey(repo),
        hostId,
        path: getEphemeralVmRecipeResultProjectRoot(provisioned.runtime.recipeResult),
        setupMethod: 'imported-existing-folder'
      })

      return {
        runtimeId: provisioned.runtime.id,
        connectionType: provisioned.connectionType,
        checkoutMode,
        hostId,
        projectHostSetupId: setup.setup.id,
        repoId: setup.repo.id,
        projectId: setup.project.id,
        path: setup.repo.path,
        ...(provisioned.connectionType === 'ssh' && provisioned.expectedRefHead
          ? { expectedRefHead: provisioned.expectedRefHead }
          : {}),
        warnings: provisioned.warnings
      }
    }
  })
]
