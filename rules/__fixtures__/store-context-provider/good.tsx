// GOOD: the screen imports the singleton directly, the row gets a prop.
import { observer } from "mobx-react-lite";
import { rootStore } from "./rootStore";

export const AppScreen = observer(function AppScreen() {
  return <ReadyBadge ready={rootStore.ready} />;
});

function ReadyBadge(props: { readonly ready: boolean }) {
  return <span>{String(props.ready)}</span>;
}
