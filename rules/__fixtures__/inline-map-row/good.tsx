// NOTHING in this file may be reported by `inline-map-row`.

import { observer } from "mobx-react-lite"
import { SessionRow } from "./SessionRow/SessionRow"

// The target pattern: one extracted, self-closed row component per item.
export const A = observer(() => <ul>{xs.map((x) => <SessionRow key={x.id} item={x} />)}</ul>)

// An extracted row that takes children is still one component reference.
export const B = observer(() => <ul>{xs.map((x) => <SessionRow key={x.id}>{x.title}</SessionRow>)}</ul>)

// A single host element with only an expression inside is not a row body.
export const C = observer(() => <ul>{xs.map((x) => <li key={x.id}>{x.title}</li>)}</ul>)

// A thin wrapper around ONE extracted component. Deliberately not flagged: the
// rule needs two or more nested elements before it calls something a row body,
// so the wrapper costs a false positive at `error` severity rather than a fix.
export const D = observer(() => <ul>{xs.map((x) => <li key={x.id}><SessionRow item={x} /></li>)}</ul>)

// One nested element deep. Same reasoning as D.
export const E = observer(() => <ul>{xs.map((x) => <li key={x.id}><a href={x.href}>{x.title}</a></li>)}</ul>)

// Mapping to non-JSX values is untouched.
export const F = observer(() => <ul>{xs.map((x) => x.title).join(", ")}</ul>)

// A literal array — CLAUDE.md's "pure data" carve-out. A skeleton drawing four
// placeholder cards has no observable to subscribe to and no row to extract.
export const G = observer(() => (
  <div>
    {[1, 2, 3, 4].map((i) => (
      <div key={i}>
        <Skeleton width={80} />
        <Skeleton width="60%" />
      </div>
    ))}
  </div>
))

// The same inline row body, in a component that is NOT an observer. There is no
// reactive scope to over-subscribe, so there is no defect of this kind — a
// plain UI library renders lists exactly like this and must stay silent.
export const H = () => (
  <ul>
    {items.map((it) => (
      <li key={it.id}>
        <img src={it.src} />
        <span>{it.title}</span>
      </li>
    ))}
  </ul>
)
