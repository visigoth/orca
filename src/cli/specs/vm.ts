import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const VM_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['vm', 'runtime', 'list'],
    summary: 'List environments provisioned by recipes on this runtime',
    usage: 'orca vm runtime list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'An "(unattached)" entry is an environment no workspace claims — usually a create that failed partway. Nothing tears those down on their own; use `vm runtime cleanup`.'
    ],
    examples: ['orca vm runtime list --json']
  },
  {
    path: ['vm', 'runtime', 'cleanup'],
    summary: "Run a provisioned environment's destroy hook and release its SSH target",
    usage: 'orca vm runtime cleanup --runtime <id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'runtime'],
    notes: [
      'Deleting a workspace already does this for the environment behind it; this is for the ones left unattached by a failed create.',
      'Safe to re-run: an environment already cleaned reports succeeded without re-running the hook.'
    ],
    examples: ['orca vm runtime cleanup --runtime orca-4c9fe533-40a6-424f-82bd-814c55c1fac1']
  },
  {
    path: ['vm', 'recipe', 'list'],
    summary: 'List environment recipes available for a repo',
    usage: 'orca vm recipe list --repo <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo'],
    notes: [
      'Combines recipes from the repo orca.yaml with those contributed by enabled plugins — the same set the app offers in its Run on picker.',
      'Use an id from here with `orca worktree create --recipe <id>`.'
    ],
    examples: ['orca vm recipe list --repo name:stoa --json']
  },
  {
    path: ['vm', 'recipe', 'doctor'],
    summary: 'Validate a per-workspace environment recipe without provisioning by default',
    usage:
      'orca vm recipe doctor <recipe-id> [--repo-path <path>] [--provision|--connect] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'recipe-id', 'repo-path', 'provision', 'connect'],
    positionalArgs: ['recipe-id'],
    notes: [
      'Reads environmentRecipes from orca.yaml in the repo path, validates the selected recipe, and reports agent-friendly checks.',
      'This default mode is non-destructive and does not run the recipe command.',
      'Use --provision or --connect to run the recipe, validate its result, and run cleanup when configured.'
    ],
    examples: [
      'orca vm recipe doctor cloud-sandbox',
      'orca vm recipe doctor cloud-sandbox --repo-path /path/to/repo --json',
      'orca vm recipe doctor cloud-sandbox --provision --json'
    ]
  }
]
