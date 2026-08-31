import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

/**
 * Plugin management specs.
 *
 * Exists because the plugin UI is Electron-only (window.api.plugins.*) and the web client has no
 * plugins API, leaving headless runtimes with no way to review or enable a plugin — even though
 * the runtime already exposes plugins.list / plugins.consent / plugins.setEnabled for that case.
 */
export const PLUGIN_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['plugin', 'list'],
    summary: 'List plugins installed on this Orca runtime',
    usage: 'orca plugin list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Shows each plugin key, version and status. A plugin contributing vm recipes, keybindings or agents stays inactive until approved.'
    ],
    examples: ['orca plugin list --json']
  },
  {
    path: ['plugin', 'approve'],
    summary: 'Review and approve a plugin so it becomes active',
    usage: 'orca plugin approve --plugin <key> [--decision approve|keep-disabled] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'plugin', 'decision'],
    notes: [
      'Approval pins the exact capability set reviewed, so a later version that widens what the plugin does must be approved again.',
      'The capabilities being approved are printed to stderr first; the fingerprint is read from the runtime rather than passed by hand.',
      'Use --decision keep-disabled to record a review without activating the plugin.'
    ],
    examples: [
      'orca plugin approve --plugin symmory.workhorse',
      'orca plugin approve --plugin symmory.workhorse --json'
    ]
  },
  {
    path: ['plugin', 'set-enabled'],
    summary: 'Enable or disable an already-approved plugin',
    usage: 'orca plugin set-enabled --plugin <key> [--disable] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'plugin', 'disable'],
    notes: [
      'Enablement is separate from consent: disabling keeps the approval, it just stops the plugin loading.'
    ],
    examples: ['orca plugin set-enabled --plugin symmory.workhorse --disable']
  }
]
