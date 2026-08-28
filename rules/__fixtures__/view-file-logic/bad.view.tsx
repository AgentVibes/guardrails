// BAD: a view that decides. Hook, match, ternary — all three belong upstairs.
import { useState } from "react";
import { match } from "ts-pattern";

export function StatusBadge(props: { readonly status: "ok" | "bad"; readonly label: string }) {
  const [open, setOpen] = useState(false);
  const tone = match(props.status)
    .with("ok", () => "green")
    .with("bad", () => "red")
    .exhaustive();
  return (
    <span onClick={() => setOpen(true)} style={{ color: tone }}>
      {open ? props.label : ""}
    </span>
  );
}
