import { useEffect, useState } from 'react'
import type { OrcaVmRecipe } from '../../../src/shared/orca-yaml-hook-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'

type RecipeListResult = {
  recipes?: OrcaVmRecipe[]
  repoPath?: string
  diagnostics?: unknown[]
}

/**
 * The environment recipes a repo offers, as the run-target picker's extra choices.
 *
 * `vm.listRecipes` is the same RPC the CLI and the web picker use — the server has always been
 * willing to answer it, and this client simply never asked, so a phone could only ever create
 * workspaces on the host that owns the checkout.
 *
 * Failure is empty, not an error: a repo whose host cannot read recipes (a folder row, a checkout
 * owned by another machine) must still be able to create a workspace the ordinary way.
 */
export function useNewWorkspaceRecipes(args: {
  client: Pick<RpcClient, 'sendRequest'> | null
  repoId: string | null
  enabled: boolean
}): OrcaVmRecipe[] {
  const { client, repoId, enabled } = args
  const [recipes, setRecipes] = useState<OrcaVmRecipe[]>([])

  useEffect(() => {
    if (!client || !repoId || !enabled) {
      setRecipes([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const response = await client.sendRequest('vm.listRecipes', { repo: `id:${repoId}` })
        // The transport answers with an envelope; a repo with no recipes and a repo whose host
        // cannot answer both end up empty here, which is the same outcome for this picker.
        const result = response.ok ? ((response as RpcSuccess).result as RecipeListResult) : null
        if (!cancelled) {
          setRecipes(Array.isArray(result?.recipes) ? result.recipes : [])
        }
      } catch {
        if (!cancelled) {
          setRecipes([])
        }
      }
    })()
    // Why cancelled rather than an AbortController: switching repos mid-flight must not let a
    // late answer for the previous repo repopulate the picker for the current one.
    return () => {
      cancelled = true
    }
  }, [client, repoId, enabled])

  return recipes
}
