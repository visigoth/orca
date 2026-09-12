import type { RemoteHostPlatform } from './ssh-remote-platform'
import { isWindowsRemoteHost } from './ssh-remote-platform'

/**
 * Give an SSH workspace the managed Claude account the runtime already holds.
 *
 * Why this exists: `orca account add` registers an account with the local runtime, and the rest of
 * the account machinery reaches agents by setting CLAUDE_CONFIG_DIR on a process this app spawns —
 * host or WSL. An SSH workspace runs its agent on the far side of the relay, where nothing this
 * app spawns can be pointed anywhere, so a host with a perfectly good managed account still opened
 * every remote workspace at `Not logged in — Please run /login`.
 *
 * The account is materialised into the remote Claude config directory, which is the same strategy
 * the host runtime uses and not the WSL one: WSL gets an isolated CLAUDE_CONFIG_DIR per account,
 * which is only possible because the app launches that process.
 */
export type ManagedClaudeCredentialsOutcome =
  | 'written'
  | 'remote-already-authenticated'
  | 'no-managed-account'
  | 'unsupported-remote'
  | 'unavailable'

export type ManagedClaudeCredentialsDeps = {
  hostPlatform: RemoteHostPlatform
  /** Absolute path to the relay's node on the remote, used to parse JSON there. */
  remoteNodePath: string | null | undefined
  execRemote: (command: string) => Promise<string>
  /**
   * Upload a local file to the remote. The local file is the managed credentials file itself, so
   * the secret never becomes a command argument (visible in the remote process list) and is never
   * copied to a temporary file on this machine.
   */
  uploadFile: (localPath: string, remotePath: string) => Promise<void>
  /** Absolute path of the active managed account's `.credentials.json`, or null when there is none. */
  resolveManagedCredentialsPath: () => Promise<string | null>
  log?: (message: string) => void
}

const REMOTE_PROBE_USABLE = 'USABLE'

/**
 * Resolve the remote Claude config directory the same way Claude Code does: CLAUDE_CONFIG_DIR when
 * set, otherwise ~/.claude. Asking the remote shell is the only correct way — the variable is part
 * of the image in a devcontainer and is not knowable from here.
 */
export function buildRemoteConfigDirCommand(): string {
  return 'printf %s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"'
}

/**
 * Is the remote already holding credentials worth keeping?
 *
 * Deliberately conservative: anything that parses and carries an unexpired access token counts, so
 * a login the user performed inside the workspace is never overwritten by ours. An empty, expired,
 * or unparseable file does not count — Claude Code rewrites that file to empty tokens after a
 * failed refresh, and treating that as "authenticated" would strand the workspace permanently.
 */
export function buildRemoteProbeCommand(nodePath: string, configDir: string): string {
  const program =
    'try{' +
    'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));' +
    'const o=d.claudeAiOauth||{};' +
    'const exp=Number(o.expiresAt||0);' +
    `process.stdout.write(o.accessToken&&exp>Date.now()?"${REMOTE_PROBE_USABLE}":"STALE")` +
    '}catch(e){process.stdout.write("STALE")}'
  return `${shellQuote(nodePath)} -e ${shellQuote(program)} ${shellQuote(`${configDir}/.credentials.json`)}`
}

export function isRemoteProbeUsable(output: string): boolean {
  return output.trim() === REMOTE_PROBE_USABLE
}

export async function materializeManagedClaudeCredentials(
  deps: ManagedClaudeCredentialsDeps
): Promise<ManagedClaudeCredentialsOutcome> {
  const log = deps.log ?? ((message: string) => console.log(message))

  // Why: the remote command vocabulary below is POSIX. A Windows remote needs its own dialect and
  // its own config-dir rule, and guessing at either would write a secret to the wrong place.
  if (isWindowsRemoteHost(deps.hostPlatform)) {
    return 'unsupported-remote'
  }

  const localCredentialsPath = await deps.resolveManagedCredentialsPath()
  if (!localCredentialsPath) {
    return 'no-managed-account'
  }

  try {
    const configDir = (await deps.execRemote(buildRemoteConfigDirCommand())).trim()
    if (!configDir || !configDir.startsWith('/')) {
      log(`[ssh-claude-auth] remote config dir not resolvable (${configDir || 'empty'}); skipping`)
      return 'unavailable'
    }

    if (deps.remoteNodePath) {
      const probe = await deps
        .execRemote(buildRemoteProbeCommand(deps.remoteNodePath, configDir))
        .catch(() => 'STALE')
      if (isRemoteProbeUsable(probe)) {
        return 'remote-already-authenticated'
      }
    }

    // 0700 before the upload, not after: the file lands with whatever default mode the SFTP server
    // applies, and a private directory is what keeps that instant from being an exposure.
    await deps.execRemote(`mkdir -p ${shellQuote(configDir)} && chmod 700 ${shellQuote(configDir)}`)
    const remotePath = `${configDir}/.credentials.json`
    await deps.uploadFile(localCredentialsPath, remotePath)
    await deps.execRemote(`chmod 600 ${shellQuote(remotePath)}`)
    log(`[ssh-claude-auth] materialized the managed Claude account into ${remotePath}`)
    return 'written'
  } catch (error) {
    // Why never fatal: this is an authentication convenience layered onto session establish. A
    // workspace that comes up logged out is usable and recoverable with one login; a workspace that
    // refuses to open because a credential push failed is not.
    log(
      `[ssh-claude-auth] could not materialize managed credentials: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return 'unavailable'
  }
}

/** POSIX single-quote escaping: close, escape, reopen. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}
