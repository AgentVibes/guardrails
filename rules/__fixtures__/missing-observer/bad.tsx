// Every declaration in this file MUST be reported by `missing-observer`.

import { useStore } from "../../stores/StoreContext"

// Arrow component reading the store hook, no observer wrap — the canonical shape
// the previously-documented (never-implemented) rule could not match.
export const SessionsList = () => {
  const { data, ui } = useStore()
  return <div>{data.sessions.length} sessions, tab {ui.tab}</div>
}

// Bare call, no destructuring.
export const Header = () => {
  const store = useStore()
  return <header>{store.auth.userName}</header>
}

// function_declaration form.
export function Footer() {
  const { ui } = useStore()
  return <footer>{ui.statusText}</footer>
}

// A project-specific store hook (`use<Name>Store`), not just `useStore`.
export const GalleryGrid = () => {
  const { photos } = useGalleryStore()
  return <div>{photos.length}</div>
}

// Page store created on a screen — still needs the observer wrap.
export const GalleryScreen = () => {
  const page = usePageStore(() => new GalleryPageStore(rootStore, "slug"), [])
  return <section>{page.title}</section>
}

// The model-prop arm: takes `model`, dereferences it, never wrapped. This is
// the per-row extraction done right and then de-observed — the row re-renders
// only when the parent does.
export const SessionRow = ({ model }: { model: ISessionModel }) => {
  return <li>{model.title}</li>
}

// Same for a prop named `store`.
export const TabBar = ({ store }: { store: IUiModel }) => {
  return <nav>{store.activeTab}</nav>
}

// ── shapes taken from real components, not invented ────────────────────
// The store read happens at body level and never appears inside the JSX.
// tg-gallery's GalleryView does exactly this; an earlier "deref must be inside
// a jsx_expression" version of this rule missed it completely.
export const GalleryView = function GalleryView() {
  const { galleryStore, themeStore } = useStore()
  const layoutType = themeStore.layout.type
  return match(galleryStore.detailState)
    .with({ status: "loading" }, () => <GalleryViewSkeleton />)
    .with({ status: "loaded" }, ({ gallery }) => <GalleryLoadedView gallery={gallery} layoutType={layoutType} />)
    .exhaustive()
}

// Read straight into a local derivation — observatory's SessionsTreeSection.
export const SessionsTreeSection = () => {
  const { data, ui } = useStore()
  const matched = data.sessions.filter((s) => sessionMatches(s, ui.searchQuery))
  return <TreeSection count={matched.length}>{null}</TreeSection>
}
