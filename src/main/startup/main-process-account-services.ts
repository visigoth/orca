import { setManagedClaudeCredentialsSource } from '../ssh/ssh-managed-claude-credentials-source'
import { startManagedTokenRefreshSchedule } from '../claude-accounts/managed-token-refresh-schedule'
import { resolveActiveManagedClaudeCredentialsPath } from '../claude-accounts/active-managed-credentials-path'
import { app } from 'electron'
import { RateLimitService } from '../rate-limits/service'
import { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import { CodexAccountService } from '../codex-accounts/service'
import { ClaudeRuntimeAuthService } from '../claude-accounts/runtime-auth-service'
import { ClaudeAccountService } from '../claude-accounts/service'
import { KeybindingService } from '../keybindings/keybinding-service'
import { createCodexSessionMigrationScheduler } from '../codex/codex-session-migration-scheduler'
import { startCodexSessionBackfillInBackground } from '../codex/codex-session-backfill'
import { startCodexSessionIndexHealInBackground } from '../codex/codex-session-index-heal'
import { startCodexStateDbBackfillRecoveryInBackground } from '../codex/codex-state-db-backfill-recovery'
import { getOrcaManagedCodexHomePath } from '../codex/codex-home-paths'
import { getInitialCodexRateLimitTarget } from '../rate-limits/codex-rate-limit-target'
import { getInitialClaudeRateLimitTarget } from '../rate-limits/claude-rate-limit-target'
import { getKimiRuntimeTarget, resolveKimiHome } from '../kimi/kimi-runtime-home'
import { readMiniMaxSessionCookie } from '../minimax/minimax-cookie-store'
import { createAccountRuntimeTargetSettingsSync } from '../rate-limits/account-runtime-target-sync'
import { normalizeCodexRuntimeSelection } from '../codex-accounts/runtime-selection'
import { normalizeClaudeRuntimeSelection } from '../claude-accounts/runtime-selection'
import { isAgentStatusHooksEnabled } from '../agent-hooks/managed-agent-hook-controls'
import { agentHookServer } from '../agent-hooks/server'
import { setSystemCodexHomeHookSweepSuppressed } from '../codex/hook-service'
import { isRealHomeCodexHookLaneUsable } from '../codex/codex-real-home-hook-install'
import { resolveHostCodexSessionSourceHome } from '../codex/codex-session-source-home'
import { browserManager } from '../browser/browser-manager'
import { mainProcessState as state } from './main-process-state'

export function initializeMainProcessAccountServices(): void {
  const store = state.store
  if (!store || !state.claudeUsage || !state.codexUsage || !state.openCodeUsage) {
    throw new Error('Usage stores must be initialized before account services')
  }
  state.rateLimits = new RateLimitService()
  state.codexRuntimeHome = new CodexRuntimeHomeService(store)
  void startCodexStateDbBackfillRecoveryInBackground(getOrcaManagedCodexHomePath())
  // Why: an incapable trust-grant host must fall back to the managed home for
  // every consumer (PTY env, rate limits, commit messages) in one place.
  state.codexRuntimeHome.setRealHomeLaneGate(() => isRealHomeCodexHookLaneUsable())
  // Why: while the real-home lane owns ~/.codex/hooks.json, the legacy
  // system-home sweep inside managed installs would delete the entry the
  // real-home installer just appended. Flag OFF, hooks off, or an incapable
  // trust lane re-arms the sweep so downgrade, opt-out, and rollback converge.
  setSystemCodexHomeHookSweepSuppressed(
    () =>
      state.codexRuntimeHome !== null &&
      state.codexRuntimeHome.isHostSystemDefaultRealHome() &&
      isAgentStatusHooksEnabled(state.store?.getSettings())
  )
  state.codexSessionMigration = createCodexSessionMigrationScheduler({
    isEligible: () =>
      state.codexRuntimeHome?.isHostSystemDefaultSessionMigrationEligible() === true,
    isQuitting: () => state.isQuitting,
    resolveSystemCodexHomePathOverride: () =>
      resolveHostCodexSessionSourceHome(store.getSettings()),
    prepareScheduledRun: (scanDates) =>
      state.codexRuntimeHome?.prepareHostSystemDefaultSessionMigrationPass(scanDates),
    finishScheduledRun: () => state.codexRuntimeHome?.finishHostSystemDefaultSessionMigrationPass(),
    startBackfill: startCodexSessionBackfillInBackground,
    startIndexHeal: startCodexSessionIndexHealInBackground
  })
  state.codexAccounts = new CodexAccountService(store, state.rateLimits, state.codexRuntimeHome, {
    onHostSystemDefaultSelected: state.codexSessionMigration.requestRun
  })
  // Why: migrate historical shared-home sessions after startup; compatibility
  // launches re-arm the non-destructive pass for new rollouts (#4444, #8612, #12480).
  state.codexSessionMigration.scheduleInitialRun()
  state.claudeRuntimeAuth = new ClaudeRuntimeAuthService(store)
  state.claudeAccounts = new ClaudeAccountService(store, state.rateLimits, state.claudeRuntimeAuth)
  // Why: SSH workspaces cannot be reached the way host and WSL agents are. Those get a managed
  // account by having CLAUDE_CONFIG_DIR set on a process this app spawns; an agent behind the relay
  // is spawned on the far side, so without this a host holding a perfectly good account still opens
  // every remote workspace logged out. The SSH layer reads the account through this seam.
  setManagedClaudeCredentialsSource({
    resolveActiveManagedCredentialsPath: async () => {
      // Refresh BEFORE handing the path over, not after discovering the token was dead.
      //
      // The SSH layer uploads this file as-is to a machine that cannot refresh it for us, so a
      // token that expires between now and the agent's first request is a workspace that opens
      // logged out. The host path already refreshes at exactly this moment -- runtime-auth-sync
      // rotates and persists before materializing, "else runtime gets a stale token that fails
      // invalid_grant" -- and this is the same moment for the remote one.
      //
      // Through syncForCurrentSelection rather than the refresh directly, because that is what
      // serializes: the refresh token is single use, and two concurrent rotations invalidate a
      // copy. Failure is not fatal here -- the materializer checks the credential itself and
      // refuses a stale one, so the worst case is the refusal it would have made anyway.
      try {
        await state.claudeRuntimeAuth?.syncForCurrentSelection()
      } catch (error) {
        console.warn('[claude-token-refresh] refresh before ssh materialization failed', error)
      }
      return resolveActiveManagedClaudeCredentialsPath({
        activeAccountId: store.getSettings().activeClaudeManagedAccountId,
        // Why the list too: selecting an account had no CLI equivalent until `orca account
        // select`, so a headless host that only ever ran `orca account add` still has none.
        registeredAccountIds: (state.claudeAccounts?.listAccounts().accounts ?? []).map((a) => a.id)
      })
    }
  })
  // Why a schedule at all: every other caller of syncForCurrentSelection is an event a headless
  // host never sees -- a local agent launch, a selection change, an auth-preserving restart. With
  // none of them, the refresh path is never entered and the token expires beside a valid refresh
  // token. Ticks are cheap: the refresh only fires inside the expiry buffer.
  state.stopManagedTokenRefresh?.()
  state.stopManagedTokenRefresh = startManagedTokenRefreshSchedule({
    sync: async () => {
      await state.claudeRuntimeAuth?.syncForCurrentSelection()
    }
  })
  state.rateLimits.setCodexHomePathResolver((target) =>
    state.codexRuntimeHome!.prepareForRateLimitFetch(target)
  )
  state.rateLimits.setCodexFetchTarget(getInitialCodexRateLimitTarget(store.getSettings()))
  // Why: Kimi's CLI refreshes its OAuth token in whichever runtime it runs in, so the
  // usage fetch must read the WSL-side credentials when that's the configured runtime (#12370).
  state.rateLimits.setKimiHomeResolver(() =>
    resolveKimiHome(getKimiRuntimeTarget(store.getSettings()))
  )
  state.rateLimits.setClaudeFetchTarget(getInitialClaudeRateLimitTarget(store.getSettings()))
  const syncAccountRuntimeTargets = createAccountRuntimeTargetSettingsSync(
    state.rateLimits,
    store.getSettings()
  )
  store.onSettingsChanged((updates, settings) => {
    // Why: auto is a live policy; retarget only providers whose settings-derived runtime changed.
    void syncAccountRuntimeTargets(updates, settings).catch((error) =>
      console.warn('[rate-limits] Failed to apply account runtime target:', error)
    )
  })
  state.rateLimits.setClaudeAuthPreparationResolver((target) =>
    state.claudeRuntimeAuth!.prepareForRateLimitFetch(target)
  )
  // Why: live Claude sessions stream usage windows through their statusLine command; feeding them here avoids OAuth usage-endpoint polling (and its 429s).
  agentHookServer.setClaudeStatusLineListener((event) => {
    state.rateLimits!.ingestLiveClaudeRateLimits(event)
  })
  state.rateLimits.setOpenCodeGoConfigResolver(() => {
    const settings = store.getSettings()
    return {
      sessionCookie: settings.opencodeSessionCookie,
      workspaceIdOverride: settings.opencodeWorkspaceId
    }
  })
  state.rateLimits.setMiniMaxConfigResolver(() => {
    const settings = store.getSettings()
    return {
      sessionCookie: readMiniMaxSessionCookie() ?? '',
      groupId: settings.minimaxGroupId,
      models: settings.minimaxUsageModels
    }
  })
  state.rateLimits.setGeminiCliOAuthEnabledResolver(() => store.getSettings().geminiCliOAuthEnabled)
  state.rateLimits.setNetworkProxySettingsResolver(() => store.getSettings())
  state.keybindings = new KeybindingService({
    homePath: app.getPath('home'),
    getLegacyOverrides: () => store.getSettings().keybindings,
    legacyTabSwitchSeed: {
      isPending: () => store.getSettings().tabSwitchKeybindingSeed === 'pending',
      markSeeded: () => store.updateSettings({ tabSwitchKeybindingSeed: 'done' })
    }
  })
  browserManager.setSettingsResolver(() => ({ keybindings: state.keybindings?.getOverrides() }))
  state.rateLimits.setInactiveClaudeAccountsResolver(() => {
    const settings = store.getSettings()
    const activeIds = new Set(
      [
        normalizeClaudeRuntimeSelection(settings).host,
        ...Object.values(normalizeClaudeRuntimeSelection(settings).wsl)
      ].filter(Boolean)
    )
    return settings.claudeManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({
        id: account.id,
        managedAuthPath: account.managedAuthPath,
        managedAuthRuntime: account.managedAuthRuntime,
        wslDistro: account.wslDistro,
        wslLinuxAuthPath: account.wslLinuxAuthPath
      }))
  })
  state.rateLimits.setInactiveCodexAccountsResolver(() => {
    const settings = store.getSettings()
    const activeIds = new Set(
      [
        normalizeCodexRuntimeSelection(settings).host,
        ...Object.values(normalizeCodexRuntimeSelection(settings).wsl)
      ].filter(Boolean)
    )
    return settings.codexManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({
        id: account.id,
        resolveHome: () => {
          const resolved =
            state.codexRuntimeHome!.resolveCodexManagedAccountHomeForInactiveFetch(account)
          return resolved.kind === 'ready'
            ? { kind: 'ready' as const, managedHomePath: resolved.homePath }
            : { kind: 'skip' as const }
        }
      }))
  })
}
