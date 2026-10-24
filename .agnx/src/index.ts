// 场景：OpenBot Sub App 入口 — 上游整仓 + ensure + iframe（Tab）。
import type { WorkspaceAppHostApi, WorkspaceAppModule } from "@agnx-lab/app-sdk";
import { OpenBotIcon } from "./openbot-icon";
import {
  OPENBOT_APP_ID,
  OPENBOT_ENSURE_TOOL_REL,
  OPENBOT_OPEN_COMMAND_ID,
  OPENBOT_PANEL_ID,
} from "./constants";
import { bindOpenBotPanelHost, OpenBotPanel } from "./panel";

export const appId = OPENBOT_APP_ID;

function openOpenBotTab(
  host: WorkspaceAppHostApi,
  context?: {
    serverId?: string;
    workspaceId?: string;
    currentPathname?: string | null;
  },
): void {
  host.openMiniAppTab({
    appId: OPENBOT_APP_ID,
    panelId: OPENBOT_PANEL_ID,
    serverId: context?.serverId,
    workspaceId: context?.workspaceId,
    currentPathname: context?.currentPathname,
  });
}

export function activate(host: WorkspaceAppHostApi): void {
  bindOpenBotPanelHost(host);

  host.registerMiniApp({
    id: OPENBOT_PANEL_ID,
    appId: OPENBOT_APP_ID,
    title: "OpenBot",
    icon: OpenBotIcon,
    component: OpenBotPanel,
    iframeShortcutCapture: true,
    isolation: {
      mode: "iframe",
      sidecarTools: [OPENBOT_ENSURE_TOOL_REL],
      note: "Tab iframe 加载上游 OpenBot（Bun app + server）；ensure 短跑 sidecar 拉起 8101",
    },
  });

  host.registerCommand({
    id: OPENBOT_OPEN_COMMAND_ID,
    appId: OPENBOT_APP_ID,
    title: "OpenBot",
    keywords: ["openbot", "copilotkit", "ag-ui", "coworker", "同事", "agent"],
    icon: OpenBotIcon,
    sidebarAction: {
      defaultVisible: true,
      label: "OpenBot",
      order: 59,
    },
    run: (context) => {
      openOpenBotTab(host, context);
    },
  });
}

const moduleExport: WorkspaceAppModule = {
  appId: OPENBOT_APP_ID,
  activate,
};

export default moduleExport;

export { OPENBOT_APP_ID, OPENBOT_OPEN_COMMAND_ID, OPENBOT_PANEL_ID } from "./constants";
export { OpenBotPanel } from "./panel";
