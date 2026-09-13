import React from 'react'
import { ChevronDown, Cloud, Plus, Server } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { RunTargetRow } from './RunTargetComboboxRow'
import {
  getEphemeralVmLabel,
  getRecipeDetail,
  RUN_TARGET_ADD_HOST_KEY,
  type EphemeralVmRecipeOption
} from './run-target-options'
import { COMBOBOX_POPOVER_SURFACE } from './type-ahead-combobox-styles'

const SUBMENU_CONTENT = cn('w-72 p-1', COMBOBOX_POPOVER_SURFACE)
/**
 * Recipes get their own, wider surface. The add-host rows carry short fixed labels that 18rem
 * holds comfortably; a recipe carries a name the repo chose plus a sentence describing it, and at
 * 18rem both were cut off, which makes choosing between similarly-named recipes guesswork.
 * Capped at what Radix reports is actually available so a narrow window clamps instead of
 * overflowing offscreen.
 */
const RECIPES_SUBMENU_CONTENT = cn(
  'w-[26rem] max-w-[calc(var(--radix-popover-content-available-width)-1rem)] p-1',
  COMBOBOX_POPOVER_SURFACE
)

/** The "Per-Workspace Environment" row and its nested recipe list. */
export function RecipesSubmenuRow({
  open,
  onOpenChange,
  armed,
  optionId,
  recipes,
  selectedRecipeId,
  onArm,
  onSelectRecipe
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  armed: boolean
  optionId: string | undefined
  recipes: readonly EphemeralVmRecipeOption[]
  selectedRecipeId: string | null
  onArm: () => void
  onSelectRecipe: (recipeId: string) => void
}): React.JSX.Element {
  const [hoveredKey, setHoveredKey] = React.useState<string | null>(null)
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div>
          <RunTargetRow
            icon={<Cloud className="size-3.5 shrink-0 text-muted-foreground" />}
            label={getEphemeralVmLabel()}
            detail={translate(
              'auto.components.NewWorkspaceComposerCard.perWorkspaceEnvHint',
              'Provision an on-demand environment from a recipe'
            )}
            armed={armed}
            current={selectedRecipeId !== null}
            optionId={optionId}
            submenu
            onArm={onArm}
            onCommit={() => onOpenChange(true)}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={6}
        className={RECIPES_SUBMENU_CONTENT}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {/* Why hover state: submenu rows track their own — without it they were the only rows
            in either picker that never highlighted under the pointer. Why a height bound: unlike
            the parent list this had none at all, so a repo with more than a handful of recipes
            ran the submenu off the bottom of the window. */}
        <div
          role="listbox"
          aria-label={getEphemeralVmLabel()}
          className="max-h-80 overflow-y-auto scrollbar-sleek"
          onMouseLeave={() => setHoveredKey(null)}
        >
          {recipes.map((recipe) => (
            <RunTargetRow
              key={recipe.id}
              icon={<Cloud className="size-3.5 shrink-0 text-muted-foreground" />}
              label={recipe.name}
              detail={getRecipeDetail(recipe)}
              armed={hoveredKey === recipe.id}
              current={recipe.id === selectedRecipeId}
              // Why stacked here and not in the parent list: a host row pairs a short name with
              // a path, so name-then-right-aligned-detail reads well. A recipe row pairs a name
              // with prose about it, and sharing one line caps the name at half the row — which
              // is how the name, the only part identifying the recipe, became the truncated half.
              stacked
              detailLines={2}
              optionId={undefined}
              onArm={() => setHoveredKey(recipe.id)}
              onCommit={() => onSelectRecipe(recipe.id)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * "Add host", pinned to the popover edge so it stays reachable in every state —
 * scrolled, filtered to nothing, or with no hosts at all.
 */
export function AddHostSubmenuRow({
  open,
  onOpenChange,
  armed,
  optionId,
  onArm,
  onAddSshHost,
  onAddRemoteServer
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  armed: boolean
  optionId: string | undefined
  onArm: () => void
  onAddSshHost?: () => void
  onAddRemoteServer?: () => void
}): React.JSX.Element {
  const [hoveredKey, setHoveredKey] = React.useState<string | null>(null)
  const addHostLabel = translate('auto.components.NewWorkspaceComposerCard.addHost', 'Add host')
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div
          role="option"
          id={optionId}
          aria-selected={armed}
          // `option` supports aria-haspopup but not aria-expanded.
          aria-haspopup="menu"
          data-armed={armed || undefined}
          data-run-target-add-host="true"
          onMouseDown={(event) => event.preventDefault()}
          onMouseMove={onArm}
          onClick={() => onOpenChange(true)}
          className={cn(
            'flex h-9 shrink-0 cursor-default items-center gap-2 border-t border-border px-2 text-sm',
            armed && 'bg-accent text-accent-foreground'
          )}
        >
          <Plus className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{addHostLabel}</span>
          <span className="ml-auto flex shrink-0 items-center">
            <ChevronDown className="size-3.5 -rotate-90 text-muted-foreground" />
          </span>
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="end"
        sideOffset={6}
        className={SUBMENU_CONTENT}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div role="listbox" aria-label={addHostLabel} onMouseLeave={() => setHoveredKey(null)}>
          {onAddSshHost ? (
            <RunTargetRow
              icon={<Server className="size-3.5 shrink-0 text-muted-foreground" />}
              label={translate(
                'auto.components.NewWorkspaceComposerCard.addSshHost',
                'Add SSH host'
              )}
              detail={translate(
                'auto.components.NewWorkspaceComposerCard.addSshHostHint',
                'Use an existing machine over SSH'
              )}
              armed={hoveredKey === 'ssh'}
              current={false}
              stacked
              optionId={undefined}
              onArm={() => setHoveredKey('ssh')}
              onCommit={onAddSshHost}
            />
          ) : null}
          {onAddRemoteServer ? (
            <RunTargetRow
              icon={<Cloud className="size-3.5 shrink-0 text-muted-foreground" />}
              label={translate(
                'auto.components.NewWorkspaceComposerCard.addRemoteOrcaServer',
                'Add Remote Orca Server'
              )}
              detail={translate(
                'auto.components.NewWorkspaceComposerCard.addRemoteOrcaServerHint',
                'Pair another Orca runtime'
              )}
              armed={hoveredKey === 'remote'}
              current={false}
              stacked
              optionId={undefined}
              onArm={() => setHoveredKey('remote')}
              onCommit={onAddRemoteServer}
            />
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export { RUN_TARGET_ADD_HOST_KEY }
