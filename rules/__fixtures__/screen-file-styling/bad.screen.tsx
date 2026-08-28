// BAD: a screen growing its own layout instead of delegating to a view.
export function GalleryScreen() {
  return (
    <section className="p-4">
      <header style={{ gap: 8 }}>
        <h1 className="title">Gallery</h1>
      </header>
    </section>
  );
}
