// Pins the `ignores:` globs. These are the SAME imports bad.tsx is flagged for,
// under `showcase/` — a preview harness legitimately builds stores over
// fixtures (fake-data.md). If someone removes the ignore globs, this file
// starts reporting and the assertion below it fails, instead of the 21-hit
// false-positive class quietly coming back.
import { GalleryStore } from "../../stores/galleryStore"
import { galleryStore } from "../../stores/galleryStore"

export const Preview = () => <div>{GalleryStore.name}{galleryStore.count}</div>
