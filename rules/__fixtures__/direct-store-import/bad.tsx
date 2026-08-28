// Every import in this file MUST be reported by `direct-store-import`.

// A store CLASS pulled into a component file — the component now constructs or
// type-switches on the implementation instead of receiving a model.
import { GalleryStore } from "../../stores/galleryStore"

// A slice-store singleton. `rootStore` at a screen is legal (decision D1);
// reaching past it for one slice is not.
import { galleryStore } from "../../stores/galleryStore"

// Same, from a barrel.
import { authStore } from "../../stores"

// Aliased — the local binding is what the file actually uses.
import { galleryStore as gallery } from "../../store/gallery"

// Default-exported store instance.
import photoStore from "../../stores/photoStore"

// Mixed: `rootStore` alone would be fine, the slice next to it is not.
import { rootStore, uiStore } from "../../stores/rootStore"

export const X = () => <div>{GalleryStore.name}{galleryStore.count}{authStore.id}{gallery.n}{photoStore.n}{rootStore.n}{uiStore.tab}</div>
