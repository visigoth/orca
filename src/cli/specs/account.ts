import { GLOBAL_FLAGS, type CommandSpec } from '../args'

// Why: the desktop "Add account" button is disabled when the UI drives a remote
// runtime (a headless server). These commands run the interactive agent login
// (`claude login` / `codex login`) in the caller's own terminal on the host and
// register the captured account with the local runtime, giving headless hosts a
// way to manage Claude and Codex accounts.
export const ACCOUNT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['account', 'add'],
    summary: 'Add a managed Claude or Codex account by signing in on this Orca host',
    usage: 'orca account add [--agent claude|codex] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent'],
    notes: [
      'Runs the agent login (`claude login` / `codex login`) in this terminal, then registers the account with the local Orca runtime.',
      'Codex uses device authorization so the browser can complete sign-in from a different machine.',
      'Sign in with the account you want to add (e.g. use a private/incognito browser window for a second account).',
      '--agent defaults to claude. Requires the Orca runtime to be running on this machine.'
    ],
    examples: ['orca account add', 'orca account add --agent codex']
  },
  {
    path: ['account', 'select'],
    summary: 'Choose which managed account this Orca host uses',
    usage: 'orca account select --account <email-or-id> [--agent claude|codex] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'agent', 'account'],
    notes: [
      'Selecting an account was previously only possible in the desktop Settings UI, so a headless host left the selection empty however many accounts it had registered.',
      'That is load-bearing rather than cosmetic: the path that refreshes a managed OAuth token before handing it to an agent does nothing when no account is selected, so the token expires in place and workspaces open logged out.',
      '--account accepts the email shown by `orca account list` or the account id. --agent defaults to claude.'
    ],
    examples: [
      'orca account select --account you@example.com',
      'orca account select --account you@example.com --agent codex'
    ]
  },
  {
    path: ['account', 'list'],
    summary: 'List managed Claude and Codex accounts on this Orca host',
    usage: 'orca account list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      'Lists the accounts on this machine. `--environment` / `--pairing-code` are rejected rather than ignored; run it on the host whose accounts you want to see.'
    ],
    examples: ['orca account list']
  }
]
