// NOTHING in this file may be reported by `view-imports-store`.

// A view is typed against the model interface it renders (C40). The type
// vanishes at build time, so it is a contract, not a store dependency.
import type { IGalleryModel } from "../../stores/galleryStore"
import { type IUiModel } from "../../stores/uiStore"

// Everything else a view is allowed to touch: shared UI primitives and pure
// formatting helpers.
import { Badge } from "../../components/Badge/Badge"
import { formatBytes } from "../../lib/format"

export const GalleryHeaderView = ({
  model,
  ui,
}: {
  model: IGalleryModel
  ui: IUiModel
}) => (
  <h1>
    {model.title} <Badge label={formatBytes(model.size)} /> {ui.tab}
  </h1>
)
