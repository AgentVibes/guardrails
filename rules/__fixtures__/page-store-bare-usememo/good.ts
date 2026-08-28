// GOOD: the sanctioned hook owns creation, ref-counting and disposal.
// A plain useMemo over a non-store value stays legal.
import { useMemo } from "react";
import { usePageStore } from "@agentvibes/kit/react";

class GalleryPageStore {
  constructor(readonly slug: string) {}
  dispose(): void {}
}

export function useGallery(slug: string) {
  return usePageStore(() => new GalleryPageStore(slug), [slug]);
}

export function useIndex() {
  return useMemo(() => new Map<string, number>(), []);
}
