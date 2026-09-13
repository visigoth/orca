import type { OrcaVmRecipe } from '../../../src/shared/orca-yaml-hook-types'
import type { Repo } from '../../../src/shared/repo-types'
import {
  getExecutionHostLabel,
  getLocalExecutionHostLabel,
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../src/shared/execution-host'
import {
  getProjectIdentityKey,
  getProjectProviderIdentity
} from '../../../src/shared/project-host-setup-projection'

type WorkspaceRepo = Pick<Repo, 'id' | 'displayName' | 'path'> &
  Partial<
    Pick<Repo, 'connectionId' | 'executionHostId' | 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>
  >

export type NewWorkspaceProjectOption<TRepo extends WorkspaceRepo> = {
  id: string
  label: string
  detail?: string
  repo: TRepo
}

export type NewWorkspaceRunTargetOption<TRepo extends WorkspaceRepo> = {
  id: string
  label: string
  detail: string
  repo: TRepo
  /**
   * Set when this option provisions a per-workspace environment rather than running on a host that
   * already exists. The repo here is still the SOURCE checkout: provisioning returns a different
   * repo id, and the workspace is created against that one.
   */
  recipeId?: string
}

export function buildNewWorkspaceProjectOptions<TRepo extends WorkspaceRepo>(
  repos: readonly TRepo[]
): NewWorkspaceProjectOption<TRepo>[] {
  const options = new Map<string, NewWorkspaceProjectOption<TRepo>>()
  const hostIdsByProject = new Map<string, Set<string>>()
  for (const repo of repos) {
    const id = getProjectIdentityKey(repo)
    const hostIds = hostIdsByProject.get(id) ?? new Set<string>()
    hostIds.add(getRepoExecutionHostId(repo))
    hostIdsByProject.set(id, hostIds)
    if (!options.has(id)) {
      options.set(id, {
        id,
        label: repo.displayName,
        repo
      })
    }
  }
  return [...options.values()].map((option) => {
    const providerIdentity = getProjectProviderIdentity(option.repo)
    const providerDetail = providerIdentity
      ? `${providerIdentity.owner}/${providerIdentity.repo}`
      : ''
    const hostCount = hostIdsByProject.get(option.id)?.size ?? 0
    const detail = providerDetail || (hostCount > 1 ? `${hostCount} hosts configured` : '')
    return detail ? { ...option, detail } : option
  })
}

export function getNewWorkspaceRunTarget(
  repo: WorkspaceRepo,
  localPlatform: NodeJS.Platform | null = null
): {
  label: string
  detail: string
} {
  const hostId = getRepoExecutionHostId(repo)
  const host = parseExecutionHostId(hostId)
  const hostLabel = getExecutionHostLabel(hostId)
  if (host?.kind === 'ssh') {
    return { label: `SSH · ${hostLabel}`, detail: repo.path }
  }
  if (host?.kind === 'runtime') {
    return { label: `Remote · ${hostLabel}`, detail: repo.path }
  }
  return {
    label: localPlatform ? getLocalExecutionHostLabel(localPlatform) : 'This computer',
    detail: repo.path
  }
}

export function buildNewWorkspaceRunTargetOptions<TRepo extends WorkspaceRepo>(
  repos: readonly TRepo[],
  projectId: string | null,
  localPlatform: NodeJS.Platform | null = null,
  recipes: readonly OrcaVmRecipe[] = []
): NewWorkspaceRunTargetOption<TRepo>[] {
  if (!projectId) {
    return []
  }
  const options = new Map<string, NewWorkspaceRunTargetOption<TRepo>>()
  for (const repo of repos) {
    if (getProjectIdentityKey(repo) !== projectId) {
      continue
    }
    const hostId = getRepoExecutionHostId(repo)
    if (!options.has(hostId)) {
      options.set(hostId, {
        id: repo.id,
        ...getNewWorkspaceRunTarget(repo, localPlatform),
        repo
      })
    }
  }
  const hostOptions = [...options.values()]
  // Why recipes hang off the first host option: `vm.listRecipes` is answered by the machine that
  // owns the checkout, and provisioning starts from that same checkout. Offering a recipe under a
  // different host would ask a machine to provision from a tree it cannot see.
  const source = hostOptions[0]
  if (!source) {
    return hostOptions
  }
  return [
    ...hostOptions,
    ...recipes.map((recipe) => ({
      // Distinct from the host option's id, which is the repo id: one repo now yields several run
      // targets, and a picker keyed on the repo alone could not tell them apart.
      id: `${source.repo.id}::${recipe.id}`,
      label: recipe.name || recipe.id,
      detail: recipe.description || 'Per-workspace environment',
      repo: source.repo,
      recipeId: recipe.id
    }))
  ]
}
