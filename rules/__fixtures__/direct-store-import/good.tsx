// NOTHING in this file may be reported by `direct-store-import`.

// D1: the global rootStore imported at a screen is legal.
import { rootStore } from "../../stores/rootStore"

// Type-only imports are the view-model contract (C40), not a store dependency.
import type { IGalleryModel } from "../../stores/galleryStore"
import type { RootStore } from "../../stores/rootStore"
import type Photo from "../../stores/photo"
import type * as StoreTypes from "../../stores/types"
import { type IUiModel, type ITabModel } from "../../stores/uiStore"

// A mixed import: a real value constant alongside an inline-typed store name.
// The statement is not type-only, but the store binding in it still is.
import { NOTIFICATION_KINDS, type NotificationSettingsStore } from "../../stores/NotificationSettingsStore"

// The sanctioned access hooks are not store instances.
import { useStore } from "../../stores/StoreContext"
import { usePageStore } from "../../stores/usePageStore"

// Non-store bindings from a stores path are untouched — the rule keys on the
// binding name, not on the directory alone.
import { StoreProvider } from "../../stores/StoreContext"
import { SESSION_KEY } from "../../stores/keys"

// Imports from paths that are not a stores directory.
import { Restore } from "../../components/Restore/Restore"
import { formatBytes } from "../../lib/format"

export const X = ({ model }: { model: IGalleryModel }) => (
  <StoreProvider value={rootStore}>
    <Restore label={formatBytes(model.size)} k={SESSION_KEY} />
  </StoreProvider>
)
