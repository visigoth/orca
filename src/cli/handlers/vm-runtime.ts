import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { getOptionalStringFlag } from '../flags'

/**
 * Provisioned-environment lifecycle.
 *
 * Split from vm.ts, which sits near the 300-line cap. These exist because listing and cleaning
 * provisioned environments was Electron IPC only: a headless host could see neither what it had
 * provisioned nor tear any of it down, and a create that fails partway leaves an environment
 * behind by design — its SSH target stays registered so it can be retried or released.
 */
export const VM_RUNTIME_HANDLERS: Record<string, CommandHandler> = {
  'vm runtime list': async ({ client, json }) => {
    const response = await client.call<
      { id: string; workspaceId?: string; sshTargetId?: string; cleanupStatus?: string }[]
    >('vm.listRuntimes', {})
    const runtimes = response.result ?? []
    if (json) {
      console.log(JSON.stringify({ runtimes }, null, 2))
      return
    }
    if (runtimes.length === 0) {
      console.log('No provisioned environments.')
      return
    }
    for (const runtime of runtimes) {
      // An unattached runtime is the tell-tale of a create that failed partway: the environment
      // exists but no workspace claims it, so nothing will ever tear it down on its own.
      const workspace = runtime.workspaceId ?? '(unattached)'
      console.log(`${runtime.id}\t${runtime.cleanupStatus ?? 'unknown'}\t${workspace}`)
    }
  },

  'vm runtime cleanup': async ({ flags, client, json }) => {
    const runtimeId = getOptionalStringFlag(flags, 'runtime')
    if (!runtimeId) {
      throw new RuntimeClientError('invalid_argument', 'Missing --runtime id.')
    }
    const response = await client.call<{ id: string; cleanupStatus?: string }>('vm.cleanup', {
      runtimeId
    })
    if (json) {
      console.log(JSON.stringify(response.result, null, 2))
      return
    }
    console.log(`${runtimeId}\t${response.result?.cleanupStatus ?? 'unknown'}`)
  }
}
