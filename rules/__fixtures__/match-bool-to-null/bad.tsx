// Every match here MUST be reported by `match-bool-to-null`.
import { match } from "ts-pattern"

export const Badge = ({ on }: { on: boolean }) =>
  match(on)
    .with(true, () => <span>new</span>)
    .with(false, () => null)
    .exhaustive()
