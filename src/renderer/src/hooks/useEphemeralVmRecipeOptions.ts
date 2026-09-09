import { useCallback, useEffect, useRef, useState } from 'react'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { OrcaVmRecipe } from '../../../shared/orca-yaml-hook-types'

type EphemeralVmRecipeOptionsArgs = {
  enabled: boolean
  repoId: string | null
  repoIsGit: boolean
  repoConnectionId: string | null
  repoExecutionHostId: ExecutionHostId | null
  /**
   * The runtime this client is paired to, when it is one — a browser client's repos are owned by
   * `runtime:<id>` rather than `local`, and that runtime is where recipe hooks actually run. Null
   * on the desktop, where `local` is the only host that provisions.
   */
  activeRuntimeEnvironmentId?: string | null
  projectGroupTarget: boolean
  initialRecipeId?: string
}

export function useEphemeralVmRecipeOptions(args: EphemeralVmRecipeOptionsArgs): {
  recipes: OrcaVmRecipe[]
  selectedRecipeId: string | null
  setSelectedRecipeId: (recipeId: string | null) => void
  error: string | null
} {
  const [recipes, setRecipes] = useState<OrcaVmRecipe[]>([])
  const [selectedRecipeId, setSelectedRecipeId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestGeneration = useRef(0)
  // Recipes run on the host that owns the checkout, so the gate is "is that host the one this
  // client can ask to provision". Two hosts qualify: the desktop's own machine, and the runtime a
  // browser client is paired to. An ssh: repo does not — recipes run locally to the host in v1.
  const repoHost = parseExecutionHostId(args.repoExecutionHostId)
  const repoHostProvisions =
    repoHost?.kind === 'local' ||
    (repoHost?.kind === 'runtime' &&
      Boolean(args.activeRuntimeEnvironmentId) &&
      repoHost.environmentId === args.activeRuntimeEnvironmentId)
  const canLoad =
    args.enabled &&
    Boolean(args.repoId) &&
    args.repoIsGit &&
    !args.repoConnectionId &&
    repoHostProvisions &&
    !args.projectGroupTarget

  const load = useCallback(
    (resetSelection: boolean): void => {
      const generation = ++requestGeneration.current
      if (resetSelection) {
        setRecipes([])
        setSelectedRecipeId(null)
        setError(null)
      }
      if (!canLoad || !args.repoId) {
        return
      }
      void window.api.ephemeralVm
        .listRecipes({ repoId: args.repoId })
        .then((result) => {
          if (generation !== requestGeneration.current) {
            return
          }
          const nextRecipes = result.recipes ?? []
          setRecipes(nextRecipes)
          setSelectedRecipeId((current) => {
            if (resetSelection) {
              return args.initialRecipeId &&
                nextRecipes.some((recipe) => recipe.id === args.initialRecipeId)
                ? args.initialRecipeId
                : null
            }
            return current && nextRecipes.some((recipe) => recipe.id === current) ? current : null
          })
          const diagnosticMessages = (result.diagnostics ?? []).map((diagnostic) => {
            const recipeLabel = `environmentRecipes[${diagnostic.index}]`
            const fieldLabel = diagnostic.field ? `.${diagnostic.field}` : ''
            return `${recipeLabel}${fieldLabel}: ${diagnostic.message}`
          })
          setError(
            [result.status === 'error' ? result.message : null, ...diagnosticMessages]
              .filter((message): message is string => Boolean(message))
              .join('\n') || null
          )
        })
        .catch((cause) => {
          if (generation !== requestGeneration.current) {
            return
          }
          setRecipes([])
          setSelectedRecipeId(null)
          setError(cause instanceof Error ? cause.message : String(cause))
        })
    },
    [args.initialRecipeId, args.repoId, canLoad]
  )

  useEffect(() => {
    load(true)
    return () => {
      requestGeneration.current += 1
    }
  }, [load])

  useEffect(() => {
    if (!window.api.plugins?.onChanged) {
      return
    }
    return window.api.plugins.onChanged((event) => {
      if (event?.contentPacksChanged ?? true) {
        load(false)
      }
    })
  }, [load])

  return { recipes, selectedRecipeId, setSelectedRecipeId, error }
}
