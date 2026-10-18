// NOTHING in this file may be reported by `match-bool-to-null`.
import { match } from "ts-pattern"

// The fix: the purpose-built helper.
export const Badge = ({ on }: { on: boolean }) => <ShowWhen cond={on}>{() => <span>new</span>}</ShowWhen>

// Both arms render something: match() stays.
export const renderLabel = (on: boolean) =>
  match(on)
    .with(true, () => <span>on</span>)
    .with(false, () => <span>off</span>)
    .exhaustive()
