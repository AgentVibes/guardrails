// GOOD: the screen picks the model and composes views; styling lives in them.
import { observer } from "mobx-react-lite";
import { rootStore } from "./rootStore";
import { GalleryGrid } from "./galleryGrid.view";

export const GalleryScreen = observer(function GalleryScreen() {
  return <GalleryGrid photos={rootStore.gallery.photos} />;
});
