// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { emitCmdJRowIndexJump } from '@/lib/cmd-j-row-index-jump'
import WorktreeJumpPalette from './WorktreeJumpPalette'
import {
  makeDuplicateRecentTabState,
  makeManyTabState,
  makeRecentTabState,
  makeRepo
} from './worktree-jump-palette-test-fixtures'
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18Next>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key
    })
  }
})
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn()
  }
}))
vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))
vi.mock('@/components/sidebar/StatusIndicator', () => ({
  default: () => <span data-status-indicator="true" />
}))
vi.mock('@/components/repo/RepoBadgeLabel', () => ({
  RepoBadgeMark: () => <span data-repo-badge-mark="true" />
}))
vi.mock('@/components/cmd-j/palette-host-badge', () => ({
  getPaletteHostBadge: () => null
}))
const { activateWorkspaceTabPaletteResult } = vi.hoisted(() => ({
  activateWorkspaceTabPaletteResult: vi.fn((_result: unknown) => ({ status: 'activated' }) as const)
}))
vi.mock('@/lib/workspace-tab-palette-activation', () => ({
  activateWorkspaceTabPaletteResult: (result: unknown) => activateWorkspaceTabPaletteResult(result)
}))
vi.mock('@/components/ui/command', async () => {
  const React = await import('react')
  return {
    Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandDialog: ({
      children,
      open,
      commandProps
    }: {
      children: React.ReactNode
      open?: boolean
      commandProps?: { value?: string; onValueChange?: (next: string) => void }
    }) => {
      _setCommandSelection = commandProps?.onValueChange ?? null
      return open ? (
        <div data-command-dialog="true" data-command-value={commandProps?.value ?? ''}>
          {children}
        </div>
      ) : null
    },
    CommandInput: ({
      value,
      onValueChange,
      placeholder
    }: {
      value?: string
      onValueChange?: (next: string) => void
      placeholder?: string
    }) => {
      _setCommandQuery = onValueChange ?? null
      return (
        <input
          data-command-input="true"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onValueChange?.(event.currentTarget.value)}
        />
      )
    },
    CommandList: React.forwardRef(function CommandList(
      { children }: { children: React.ReactNode },
      ref: React.ForwardedRef<HTMLDivElement>
    ) {
      return (
        <div ref={ref} data-command-list="true">
          {children}
        </div>
      )
    }),
    CommandEmpty: ({ children }: { children: React.ReactNode }) => (
      <div data-command-empty="true">{children}</div>
    ),
    CommandItem: ({
      children,
      onSelect,
      value
    }: {
      children: React.ReactNode
      onSelect?: (value: string) => void
      value?: string
    }) => (
      <button data-command-item={value ?? ''} onClick={() => onSelect?.(value ?? '')} type="button">
        {children}
      </button>
    )
  }
})
const initialAppState = useAppStore.getInitialState()
let testRoot: Root
let testContainer: HTMLDivElement
let _setCommandQuery: ((next: string) => void) | null = null
let _setCommandSelection: ((next: string) => void) | null = null
async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
async function renderPalette(overrides: Partial<AppState>): Promise<void> {
  useAppStore.setState({
    activeModal: 'worktree-palette',
    activeWorktreeId: null,
    repos: [makeRepo()],
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    unifiedTabsByWorktree: {},
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    alwaysShowDefaultBranchWorkspace: true,
    lastVisitedAtByWorktreeId: {},
    ...overrides
  } as Partial<AppState>)
  await act(async () => {
    testRoot.render(<WorktreeJumpPalette />)
  })
  await flushEffects()
}
function getWorktreeRows(): string[] {
  return [...testContainer.querySelectorAll<HTMLElement>('[data-command-item^="worktree:"]')].map(
    (node) => node.textContent ?? ''
  )
}
function getRenderedRowIds(): string[] {
  return [...testContainer.querySelectorAll<HTMLElement>('[data-command-item]')].map(
    (node) => node.dataset.commandItem ?? ''
  )
}
function getTabRowIds(): string[] {
  return [
    ...testContainer.querySelectorAll<HTMLElement>('[data-command-item^="workspace-tab:"]')
  ].map((node) => (node.dataset.commandItem ?? '').replace('workspace-tab:', ''))
}
function getTabRowShortcutDigits(): string[] {
  return [
    ...testContainer.querySelectorAll<HTMLElement>('[data-command-item^="workspace-tab:"]')
  ].flatMap((row) =>
    [...row.querySelectorAll<HTMLElement>('span')]
      .map((node) => node.textContent ?? '')
      .filter((text) => /^\d+$/.test(text))
  )
}
function clickSeeMore(): void {
  ;[...testContainer.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('See more'))
    ?.click()
}
describe('WorktreeJumpPalette recent chats & terminals', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    setCommandQuery = null
    setCommandSelection = null
    activateWorkspaceTabPaletteResult.mockClear()
    useAppStore.setState(initialAppState, true)
    testContainer = document.createElement('div')
    document.body.appendChild(testContainer)
    testRoot = createRoot(testContainer)
  })
  afterEach(async () => {
    await act(async () => {
      testRoot.unmount()
    })
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })
  it('leads the empty-query list with the recent section', async () => {
    await renderPalette(makeRecentTabState())
    const rows = getRenderedRowIds().filter((id) => id.length > 0)
    expect(rows[0]).toMatch(/^workspace-tab:/)
    expect(rows.some((id) => id.startsWith('worktree:'))).toBe(true)
    expect(testContainer.textContent).toContain('Recent Chats & Terminals')
    expect(testContainer.textContent).toContain('Recent Worktrees')
  })
  it('keeps duplicate persisted tab ids as separate recent rows and digit targets', async () => {
    await renderPalette(makeDuplicateRecentTabState())
    expect(
      getRenderedRowIds().filter(
        (id) => id === 'workspace-tab:tab-duplicate' || id.includes(':workspace-tab:tab-duplicate')
      )
    ).toEqual(['workspace-tab:tab-duplicate', 'palette-dup:1:workspace-tab:tab-duplicate'])
    await act(async () => {
      emitCmdJRowIndexJump(1)
    })
    await flushEffects()
    expect(activateWorkspaceTabPaletteResult).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tab-duplicate', worktreeId: 'wt-beta' })
    )
  })
  it('caps the recent section so the worktree header stays above the fold', async () => {
    await renderPalette(makeManyTabState(12))
    expect(getTabRowIds()).toHaveLength(6)
    expect(testContainer.textContent).toContain('Recent Worktrees')
    expect(getWorktreeRows().length).toBeLessThanOrEqual(4)
  })
  it('shows more recent chats and terminals from the empty-query view', async () => {
    await renderPalette(makeManyTabState(12))
    const seeMoreButton = Array.from(testContainer.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('See more')
    )
    expect(seeMoreButton).toBeDefined()
    expect(testContainer.textContent).toContain('6 more')
    await act(async () => {
      seeMoreButton?.click()
    })
    await flushEffects()
    expect(getTabRowIds()).toHaveLength(12)
    expect(testContainer.textContent).not.toContain('6 more')
  })
  it('reveals every recent row from a single expansion', async () => {
    await renderPalette(makeManyTabState(30))
    expect(getTabRowIds()).toHaveLength(6)
    await act(async () => {
      clickSeeMore()
    })
    await flushEffects()
    expect(getTabRowIds()).toHaveLength(30)
  })
  it('stops badging expanded recent rows at the last addressable digit', async () => {
    await renderPalette(makeManyTabState(12))
    expect(getTabRowShortcutDigits()).toEqual(['1', '2', '3', '4', '5', '6'])
    await act(async () => {
      clickSeeMore()
    })
    await flushEffects()
    expect(getTabRowIds()).toHaveLength(12)
    expect(getTabRowShortcutDigits()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
  })
  it('backfills past the cap when rows drop out of the frozen order', async () => {
    await renderPalette(makeManyTabState(12))
    const before = getTabRowIds()
    await act(async () => {
      useAppStore.setState({
        unifiedTabsByWorktree: {
          'wt-many': (useAppStore.getState().unifiedTabsByWorktree['wt-many'] ?? []).filter(
            (tab) => !before.includes(tab.id)
          )
        }
      } as Partial<AppState>)
    })
    await flushEffects()
    const after = getTabRowIds()
    expect(after).toHaveLength(6)
    expect(after.some((id) => before.includes(id))).toBe(false)
  })
})
