import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const VM_COMMAND_SPECS: CommandSpec[] = [
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
