// Every import, re-export, dynamic import and require in this file MUST be
// reported by `retired-ui-scope` (14 hits).

// Public UI packages retired from @byoklab/* → @byok-ui/*
import { tokens } from "@byoklab/ui-tokens";
import { theme } from "@byoklab/ui-theme/dark";
import { Icon } from "@byoklab/ui-icons";
import { Box } from "@byoklab/ui-primitives";
import { Button } from "@byoklab/ui-components/button";
import { Markdown } from "@byoklab/ui-markdown";
import { Kit } from "@byoklab/ui";
import type { EditorState } from "@byoklab/editor-core";

// Private UI packages retired from @byoklab/* → @byok-ui-private/*
import { decodePhoto } from "@byoklab/photo-core";
import { PhotoCanvas } from "@byoklab/ui-photo/canvas";
export { ElementTree } from "@byoklab/ui-elements";
export * from "@byoklab/ui-wiredrill/inspector";

// Public UI packages retired from @agentvibes/* → @byok-ui/*
const lazyIcons = () => import("@agentvibes/ui-components/dialog");
const legacyEditor = require("@agentvibes/editor-core");

export const useAll = (): unknown[] => [
  tokens,
  theme,
  Icon,
  Box,
  Button,
  Markdown,
  Kit,
  decodePhoto,
  PhotoCanvas,
  lazyIcons,
  legacyEditor,
  null as unknown as EditorState,
];
