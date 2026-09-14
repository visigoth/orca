import { RuntimeClientError } from '../runtime-client'
import { printResult } from '../format'
import type { HandlerContext } from '../dispatch'

/**
 * `orca account select` — choose which managed account this host uses.
 *
 * Selecting an account was a desktop Settings action with no CLI equivalent, so a headless host
 * left the selection empty no matter how many accounts `orca account add` had registered. That is
 * not cosmetic: runtime-auth-sync bails at `if (!activeAccount)`, and that is the path which
 * refreshes a managed OAuth token before it is handed to an agent. A host that could never select
 * an account therefore never refreshed one either, and the token expired in place — observed
 * 2026-09-14 with a token two days dead and a refresh token still valid for another month.
 *
 * In its own module because account.ts sits at its 300-line budget, and the max-lines ratchet
 * exists to make a file split rather than acquire a bypass.
 */

type AccountSummary = { id: string; email: string }

type AccountsBlock = { accounts: readonly AccountSummary[] }

type AccountsSnapshot = { claude: AccountsBlock; codex: AccountsBlock }

/**
 * Resolve an account by email or id.
 *
 * Email first because that is what `account list` prints and what anyone typing this has in front
 * of them; the id is accepted too so scripts are not forced through a display string. Matching is
 * case-insensitive on email and exact on id.
 *
 * Ambiguity is an error rather than a guess: silently picking one of two matches would select an
 * account the caller did not name.
 */
export function resolveManagedAccountId(
  accounts: readonly AccountSummary[],
  selector: string
): string {
  const wanted = selector.trim()
  if (!wanted) {
    throw new RuntimeClientError('invalid_argument', 'Missing an account. Pass an email or id.')
  }
  const byId = accounts.filter((account) => account.id === wanted)
  if (byId.length === 1) {
    return byId[0]!.id
  }
  const lowered = wanted.toLowerCase()
  const byEmail = accounts.filter((account) => account.email.toLowerCase() === lowered)
  if (byEmail.length === 1) {
    return byEmail[0]!.id
  }
  if (byEmail.length > 1) {
    const ids = byEmail.map((account) => account.id).join(', ')
    throw new RuntimeClientError(
      'invalid_argument',
      `"${wanted}" matches ${byEmail.length} accounts. Pass the id instead: ${ids}`
    )
  }
  if (accounts.length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      'No managed accounts are registered. Run `orca account add` first.'
    )
  }
  const known = accounts.map((account) => account.email).join(', ')
  throw new RuntimeClientError(
    'invalid_argument',
    `No account matches "${wanted}". Known accounts: ${known}`
  )
}

/** Read `--agent`, defaulting to claude the way `account add` does. */
export function readAgentFlag(flags: HandlerContext['flags']): 'claude' | 'codex' {
  const agentFlag = flags.get('agent')
  // Why: a valueless `--agent` parses as boolean true; defaulting it to claude would select an
  // account for the provider the caller did not name.
  if (agentFlag !== undefined && typeof agentFlag !== 'string') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing a value for --agent. Use `--agent claude` or `--agent codex`.'
    )
  }
  const agent = agentFlag ?? 'claude'
  if (agent !== 'claude' && agent !== 'codex') {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unsupported --agent "${agent}". Use "claude" or "codex".`
    )
  }
  return agent
}

export async function runAccountSelect(ctx: HandlerContext): Promise<void> {
  const agent = readAgentFlag(ctx.flags)
  const selector = ctx.flags.get('account')
  if (typeof selector !== 'string' || selector.trim() === '') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing an account. Usage: orca account select --account <email-or-id> [--agent claude|codex]'
    )
  }
  const snapshot = await ctx.client.call<AccountsSnapshot>('accounts.list', { refreshUsage: false })
  const block = agent === 'claude' ? snapshot.result.claude : snapshot.result.codex
  const accountId = resolveManagedAccountId(block.accounts, selector)
  const response = await ctx.client.call(
    agent === 'claude' ? 'accounts.selectClaude' : 'accounts.selectCodex',
    { accountId }
  )
  const selected = block.accounts.find((account) => account.id === accountId)
  // Why the RPC envelope rather than a synthesized one: --json should report what the runtime
  // actually returned, not a summary this command made up about it.
  printResult(
    response,
    ctx.json,
    () => `Selected ${agent} account ${selected?.email ?? accountId}.`
  )
}
