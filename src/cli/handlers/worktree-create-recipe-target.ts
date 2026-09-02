import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { getOptionalStringFlag } from '../flags'

export type ProvisionedRecipeTarget = {
  repoId: string
  projectHostSetupId: string
  runtimeId: string
  warnings?: { message?: string }[]
}

/**
 * Provision an environment recipe and return the workspace target it produced.
 *
 * Without this the CLI could only ever create workspaces on the Orca host itself: recipe
 * selection existed solely in the app's "Run on" picker. The runtime does provision-then-register
 * in a single RPC, so a client that dies midway cannot strand a booted environment that no
 * project host setup references.
 */
export async function provisionRecipeTarget(
  flags: Map<string, string | boolean>,
  repoSelector: string,
  name: string,
  client: Parameters<CommandHandler>[0]['client']
): Promise<ProvisionedRecipeTarget> {
  const recipeId = getOptionalStringFlag(flags, 'recipe')
  if (!recipeId) {
    throw new RuntimeClientError('invalid_argument', '--recipe needs a recipe id')
  }
  const baseBranch = getOptionalStringFlag(flags, 'base-branch')
  // .result: client.call returns the RPC envelope, and the target is its payload.
  const response = await client.call<ProvisionedRecipeTarget>('vm.provisionWorkspaceTarget', {
    repo: repoSelector,
    recipeId,
    workspaceName: name,
    // Why: provisioned-root recipes clone inside the environment, so they need the branch and
    // start ref up front — the environment IS the checkout, created before the worktree exists.
    branch: name,
    ...(baseBranch ? { ref: baseBranch } : {})
  })
  // Recipe warnings are advisory (a slow provider, a deprecated field). They go to stderr so
  // they never contaminate --json on stdout, and are printed here so the caller cannot forget.
  for (const warning of response.result.warnings ?? []) {
    if (warning?.message) {
      process.stderr.write(`warning: ${warning.message}\n`)
    }
  }
  return response.result
}

/**
 * Bind a provisioned runtime to the workspace it now backs.
 *
 * Provisioning happens before the workspace exists, so the runtime record starts with no
 * workspaceId. Deletion matches environments by that id, so skipping this step leaves the
 * container alive after its workspace is gone — the environment outlives everything it was
 * created for.
 *
 * Non-fatal by design: the workspace exists either way, and failing here would strand it.
 */
export async function attachRecipeRuntimeToWorkspace(
  client: Parameters<CommandHandler>[0]['client'],
  provisioned: ProvisionedRecipeTarget | null,
  workspaceId: string | undefined
): Promise<void> {
  if (!provisioned?.runtimeId || !workspaceId) {
    return
  }
  try {
    await client.call('vm.attachWorkspace', { runtimeId: provisioned.runtimeId, workspaceId })
  } catch (error) {
    process.stderr.write(
      `warning: could not attach the provisioned environment to the workspace; it will not be ` +
        `torn down automatically (${String(error)})\n`
    )
  }
}
