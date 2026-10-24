// 场景：OpenBot Sub App 常量（AppId / 命令 / 面板 / ensure / 默认端口）。
export const OPENBOT_APP_ID = "openbot";
export const OPENBOT_PANEL_ID = "openbot.main";
export const OPENBOT_OPEN_COMMAND_ID = "openbot.open";

/** 短跑 sidecar：复用或拉起上游 app + server。 */
export const OPENBOT_ENSURE_TOOL_REL = ".agnx/tools/ensure-openbot.mjs";

export const OPENBOT_CONFIG_KEY = "openbot-app-config";

/** 作业单 §2.2 分配给 openbot 的端口。 */
export const DEFAULT_OPENBOT_PORT = 8101;
