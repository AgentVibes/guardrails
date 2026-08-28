// Every import in this file MUST be reported by `ui-imports-app-store`.
// Path matters: the rule is scoped to `**/src/ui/**`, so this fixture has to
// live under `src/ui/` for the rule to see it at all.

import { galleryStore } from "../../stores/galleryStore"
import { GalleryStore } from "../../stores/galleryStore"
import { rootStore } from "../../store/rootStore"
import { useStore } from "../../stores/StoreContext"
import photoStore from "../../stores/photoStore"

export const Panel = ({ label }: { label: string }) => (
  <div>{label}{galleryStore.n}{GalleryStore.name}{rootStore.n}{useStore.name}{photoStore.n}</div>
)
