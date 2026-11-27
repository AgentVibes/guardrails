// NOTHING in this file may be reported by `retired-ui-scope-tsx`.

// Replacement public and private UI scopes
import { tokens } from "@byok-ui/ui-tokens";
import { theme } from "@byok-ui/ui-theme/dark";
import { Icon } from "@byok-ui/ui-icons";
import { Box } from "@byok-ui/ui-primitives";
import { Button } from "@byok-ui/ui-components/button";
import { Markdown } from "@byok-ui/ui-markdown";
import { Kit } from "@byok-ui/ui";
import type { EditorState } from "@byok-ui/editor-core";
import { decodePhoto } from "@byok-ui-private/photo-core";
import { PhotoCanvas } from "@byok-ui-private/ui-photo/canvas";
export { ElementTree } from "@byok-ui-private/ui-elements";
export * from "@byok-ui-private/ui-wiredrill";

// Active @byoklab/* packages that are NOT retired UI libraries
import { site } from "@byoklab/site";
import { house } from "@byoklab/house";
import { siteConfig } from "@byoklab/site-config";
import { siteDoctor } from "@byoklab/site-doctor";
import { agentUi } from "@byoklab/agent-ui-kit";
import { agentChat } from "@byoklab/agent-ui-chat/panel";

// Active @agentvibes/* non-UI packages
const kit = () => import("@agentvibes/kit/resource");
const guardrails = require("@agentvibes/guardrails");

export const keep = (): unknown[] => [
  tokens,
  theme,
  Icon,
  Box,
  Button,
  Markdown,
  Kit,
  decodePhoto,
  PhotoCanvas,
  site,
  house,
  siteConfig,
  siteDoctor,
  agentUi,
  agentChat,
  kit,
  guardrails,
  null as unknown as EditorState,
];
