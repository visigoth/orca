import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { getOptionalStringFlag } from '../flags'

/**
 * Plugin management for headless runtimes.
 *
 * The desktop settings UI drives plugins through `window.api.plugins.*`, an Electron preload
 * bridge. The web client has no equivalent — there is no plugins entry in the web preload API at
 * all — so on `orca serve` there was no way to reach plugin state from anywhere.
 *
 * That matters most for consent. A plugin contributing vmRecipes, keybindings or agents needs an
 * explicit review before it activates, and `plugins.consent` already exists on the runtime for
 * this exact reason ("headless serve has no consent dialog — an explicit consent call is the only
 * way a pending plugin becomes active on a server"). It simply had no caller. These commands are
 * that caller.
 *
 * Consent is deliberately fingerprint-checked: approving pins the exact capability set reviewed,
 * so a later version that widens what the plugin does needs approving again. The CLI reads the
 * current fingerprint from `plugins.list` rather than making you paste a hash, and prints what is
 * being approved first — the fingerprint is an integrity check, not the thing a human reviews.
 */

type PluginListEntry = {
  pluginKey: string
  consentFingerprint: string | null
  name: string
  version: string
  status: string
  needsReconsent: boolean
  error?: string
  capabilities?: { kind: string; description: string }[]
}

async function listPlugins(
  client: Parameters<CommandHandler>[0]['client']
): Promise<PluginListEntry[]> {
  const response = await client.call<PluginListEntry[]>('plugins.list', {})
  return response.result ?? []
}

function requirePlugin(plugins: PluginListEntry[], pluginKey: string): PluginListEntry {
  const found = plugins.find((plugin) => plugin.pluginKey === pluginKey)
  if (!found) {
    const known = plugins.map((plugin) => plugin.pluginKey).join(', ') || '(none installed)'
    throw new RuntimeClientError('invalid_argument', `Unknown plugin ${pluginKey}. Known: ${known}`)
  }
  return found
}

export const PLUGIN_HANDLERS: Record<string, CommandHandler> = {
  'plugin list': async ({ client, json }) => {
    const plugins = await listPlugins(client)
    if (json) {
      console.log(JSON.stringify({ plugins }, null, 2))
      return
    }
    if (plugins.length === 0) {
      console.log('No plugins installed.')
      return
    }
    for (const plugin of plugins) {
      const flags = [plugin.status, plugin.needsReconsent ? 'needs-reconsent' : null]
        .filter(Boolean)
        .join(', ')
      console.log(`${plugin.pluginKey}\t${plugin.version}\t${flags}`)
      if (plugin.error) {
        console.log(`  error: ${plugin.error}`)
      }
    }
  },

  'plugin approve': async ({ flags, client, json }) => {
    const pluginKey = getOptionalStringFlag(flags, 'plugin')
    if (!pluginKey) {
      throw new RuntimeClientError('invalid_argument', '--plugin needs a plugin key')
    }
    const plugin = requirePlugin(await listPlugins(client), pluginKey)
    if (!plugin.consentFingerprint) {
      const detail = plugin.error ? `: ${plugin.error}` : ''
      throw new RuntimeClientError(
        'invalid_argument',
        `${pluginKey} has nothing to review (status: ${plugin.status})${detail}`
      )
    }
    // Print the capabilities before approving. The fingerprint pins what was reviewed; this is
    // the part a person can actually judge, and the desktop dialog shows the same thing.
    console.error(`Approving ${plugin.pluginKey} ${plugin.version}`)
    for (const capability of plugin.capabilities ?? []) {
      console.error(`  capability: ${capability.kind} — ${capability.description}`)
    }
    const response = await client.call<PluginListEntry[]>('plugins.consent', {
      pluginKey,
      reviewedFingerprint: plugin.consentFingerprint,
      decision:
        getOptionalStringFlag(flags, 'decision') === 'keep-disabled' ? 'keep-disabled' : 'approve'
    })
    const updated = (response.result ?? []).find((entry) => entry.pluginKey === pluginKey)
    if (json) {
      console.log(JSON.stringify({ plugin: updated }, null, 2))
      return
    }
    console.log(`${pluginKey}\t${updated?.status ?? 'unknown'}`)
  },

  'plugin set-enabled': async ({ flags, client, json }) => {
    const pluginKey = getOptionalStringFlag(flags, 'plugin')
    if (!pluginKey) {
      throw new RuntimeClientError('invalid_argument', '--plugin needs a plugin key')
    }
    const enabled = flags.get('disable') !== true
    const response = await client.call<PluginListEntry[]>('plugins.setEnabled', {
      pluginKey,
      enabled
    })
    const updated = (response.result ?? []).find((entry) => entry.pluginKey === pluginKey)
    if (json) {
      console.log(JSON.stringify({ plugin: updated }, null, 2))
      return
    }
    console.log(`${pluginKey}\t${updated?.status ?? 'unknown'}`)
  }
}
