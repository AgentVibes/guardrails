// NOTHING in this file may be reported by `ui-imports-app-store`.

// X7 (report §2): a reusable UI component typed against the view-model
// interface the store implements is exactly what the mobx-models view-model
// pattern prescribes. `import type` erases at build time — the component
// depends on a shape, not on an app store — so it must not trip the rule that
// bans importing the store itself.
import type { IGalleryModel } from "../../stores/galleryStore"
import type { RootStore } from "../../store/rootStore"
import type Photo from "../../stores/photo"
import type * as StoreTypes from "../../stores/types"
import { type IUiModel, type ITabModel } from "../../stores/uiStore"

// Ordinary UI-package dependencies.
import { cn } from "../../lib/cn"

export const Panel = ({
  model,
  ui,
}: {
  model: IGalleryModel
  ui: IUiModel
}) => <div className={cn("panel")}>{model.title} {ui.tab}</div>
