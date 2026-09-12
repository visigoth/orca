/**
 * Where the SSH session finds the managed Claude account to push to a remote workspace.
 *
 * A registry rather than a constructor argument, matching how this layer already reaches the other
 * services it needs (ssh-target-registry, ssh-active-relay-sessions). The SSH session is
 * constructed deep inside a connect flow that has no view of the account services, and threading
 * one through every call site to deliver an optional convenience is a worse trade than a seam that
 * is unset by default and provably a no-op until startup fills it in.
 */
export type ManagedClaudeCredentialsSource = {
  /**
   * Absolute path of the active managed account's `.credentials.json`, or null when no account is
   * registered, none is selected, or the path is not one Orca owns.
   */
  resolveActiveManagedCredentialsPath: () => Promise<string | null>
}

let source: ManagedClaudeCredentialsSource | null = null

export function setManagedClaudeCredentialsSource(
  next: ManagedClaudeCredentialsSource | null
): void {
  source = next
}

export function getManagedClaudeCredentialsSource(): ManagedClaudeCredentialsSource | null {
  return source
}

/** Null-safe accessor: no source registered is the same answer as no account registered. */
export async function resolveActiveManagedCredentialsPath(): Promise<string | null> {
  try {
    return (await source?.resolveActiveManagedCredentialsPath()) ?? null
  } catch {
    return null
  }
}
