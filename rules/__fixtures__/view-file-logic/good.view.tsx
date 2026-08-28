// GOOD: props in, JSX out. The tone was decided upstairs; useTheme is exempt.
import { useTheme } from "./theme";

export function StatusBadge(props: { readonly tone: string; readonly label: string }) {
  const theme = useTheme();
  return <span style={{ color: props.tone, fontFamily: theme.font }}>{props.label}</span>;
}
