import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcSuccess } from '../transport/types'

/**
 * Provision an environment recipe from the mobile app, and bind it to the workspace afterwards.
 *
 * The mobile client could only ever create workspaces on the host that owns the checkout: recipe
 * selection lived in the desktop "Run on" picker, in `orca worktree create --recipe`, and (since
 * the web picker landed) in a browser — and nowhere else. A phone is the surface a headless
 * deployment actually gets used through, so it could not reach the environments the deployment
 * exists to run.
 *
 * Mirrors src/cli/handlers/worktree-create-recipe-target.ts deliberately: the runtime does
 * provision-then-register inside one RPC, so a client that dies midway cannot strand a booted
 * environment that no project host setup references.
 */
export type ProvisionedRecipeTarget = {
  repoId: string
  projectHostSetupId?: string
  runtimeId?: string
  warnings?: { message?: string }[]
}

export async function provisionRecipeTarget(args: {
  client: Pick<RpcClient, 'sendRequest'>
  repoId: string
  recipeId: string
  workspaceName: string
  baseBranch?: string
}): Promise<ProvisionedRecipeTarget> {
  const response = await args.client.sendRequest('vm.provisionWorkspaceTarget', {
    repo: `id:${args.repoId}`,
    recipeId: args.recipeId,
    workspaceName: args.workspaceName,
    // Why branch and ref up front: provisioned-root recipes clone inside the environment, so the
    // environment IS the checkout and is created before the worktree exists.
    branch: args.workspaceName,
    ...(args.baseBranch ? { ref: args.baseBranch } : {})
  })
  // The transport answers with an envelope, not the payload. Reading through it would leave the
  // target undefined and send the workspace to the host the recipe was chosen to avoid.
  if (!response.ok) {
    throw new Error((response as RpcFailure).error.message)
  }
  const target = (response as RpcSuccess).result as ProvisionedRecipeTarget
  if (!target?.repoId) {
    throw new Error('The environment provisioned without returning a workspace target.')
  }
  return target
}

/**
 * Bind a provisioned runtime to the workspace it now backs.
 *
 * Provisioning happens before the workspace exists, so the runtime record starts with no
 * workspaceId, and deletion matches environments by that id. Skipping this leaves the container
 * alive after its workspace is gone — an environment that outlives everything it was created for,
 * and a leaked row that later makes `--repo name:<x>` ambiguous.
 *
 * Non-fatal by design: the workspace exists either way, and failing here would strand it.
 */
export async function attachRecipeRuntimeToWorkspace(args: {
  client: Pick<RpcClient, 'sendRequest'>
  provisioned: ProvisionedRecipeTarget | null
  workspaceId: string | undefined
  onWarning?: (message: string) => void
}): Promise<void> {
  if (!args.provisioned?.runtimeId || !args.workspaceId) {
    return
  }
  try {
    const response = await args.client.sendRequest('vm.attachWorkspace', {
      runtimeId: args.provisioned.runtimeId,
      workspaceId: args.workspaceId
    })
    if (!response.ok) {
      throw new Error((response as RpcFailure).error.message)
    }
  } catch (error) {
    args.onWarning?.(
      `The workspace was created, but its environment could not be attached and will not be torn ` +
        `down automatically (${error instanceof Error ? error.message : String(error)}).`
    )
  }
}
