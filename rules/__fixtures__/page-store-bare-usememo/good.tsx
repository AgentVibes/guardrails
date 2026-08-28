// GOOD: usePageStore, plus a plain useMemo over a non-store value.
import { useMemo } from "react";
import { usePageStore } from "@agentvibes/kit/react";

class GalleryPageStore {
  constructor(readonly slug: string) {}
  dispose(): void {}
}

export function GalleryScreenBody(props: { readonly slug: string }) {
  const store = usePageStore(() => new GalleryPageStore(props.slug), [props.slug]);
  const seen = useMemo(() => new Set<string>(), []);
  return <span>{store.slug + String(seen.size)}</span>;
}
