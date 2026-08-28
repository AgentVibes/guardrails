// BAD: same leak, in the file where page stores actually get created.
import { useMemo } from "react";

class GalleryPageStore {
  constructor(readonly slug: string) {}
}
class FiltersPageStore {}

export function GalleryScreenBody(props: { readonly slug: string }) {
  const store = useMemo(() => new GalleryPageStore(props.slug), [props.slug]);
  const filters = useMemo(() => new FiltersPageStore(), []);
  return <span>{String(store.slug) + String(filters)}</span>;
}
