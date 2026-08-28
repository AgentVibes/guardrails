// BAD: a page store on a bare useMemo — no dispose, two of them under StrictMode.
import { useMemo } from "react";

class GalleryPageStore {
  constructor(readonly slug: string) {}
}
class SettingsPageStore {}

export function useGallery(slug: string) {
  return useMemo(() => new GalleryPageStore(slug), [slug]);
}

export function useSettings() {
  return useMemo(() => new SettingsPageStore(), []);
}
