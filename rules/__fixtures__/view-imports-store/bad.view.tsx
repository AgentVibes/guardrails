// Every import in this file MUST be reported by `view-imports-store`.
// A `*.view.tsx` is props in, JSX out — it may not reach a store by any route,
// not even the global rootStore that a screen is allowed to import.

import { rootStore } from "../../stores/rootStore"
import { galleryStore } from "../../stores/galleryStore"
import { GalleryStore } from "../../stores/galleryStore"
import { useStore } from "../../stores/StoreContext"
import { SESSION_KEY } from "../../stores/keys"

export const GalleryHeaderView = ({ title }: { title: string }) => (
  <h1 data-k={SESSION_KEY}>{title}{rootStore.n}{galleryStore.n}{GalleryStore.name}{useStore.name}</h1>
)
