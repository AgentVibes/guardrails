// NOTHING in this file may be reported by `ui-imports-app-store-ts`.

// Type-only imports erase at build time: the helper depends on a shape, not on
// an app store.
import type { IGalleryModel } from "../../stores/galleryStore"
import type { RootStore } from "../../store/rootStore"
import type Photo from "../../stores/photo"
import type * as StoreTypes from "../../stores/types"
import { type IUiModel, type ITabModel } from "../../stores/uiStore"

import { cn } from "../../lib/cn"

export const panelClass = (model: IGalleryModel, ui: IUiModel): string => cn("panel", model.title, ui.tab)
