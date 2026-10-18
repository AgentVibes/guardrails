// Every import in this file MUST be reported by `ui-imports-app-store-ts`.
// A `.ts` file in a UI directory — a hook or view helper next to the components.

import { galleryStore } from "../../stores/galleryStore"
import { GalleryStore } from "../../stores/galleryStore"
import { rootStore } from "../../store/rootStore"
import { useStore } from "../../stores/StoreContext"
import photoStore from "../../stores/photoStore"

export const panelLabel = (label: string): string =>
  `${label}${galleryStore.n}${GalleryStore.name}${rootStore.n}${useStore.name}${photoStore.n}`
