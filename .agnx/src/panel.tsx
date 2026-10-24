// 场景：OpenBot 面板 — host.guest.mount 把上游 app（Bun + Vite 构建产物 + /api 反代）请进 8101。
// 上游自身有完整 web 形态（React SPA），按作业单「原样嵌入（首选）」，不自画平行 UI。
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type ReactElement,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  WorkspaceAppBrandLogoLoaderPanelProps,
  WorkspaceAppHostApi,
} from "@agnx-lab/app-sdk";
import { DEFAULT_OPENBOT_PORT, OPENBOT_APP_ID, OPENBOT_ENSURE_TOOL_REL } from "./constants";
import { bindOpenBotHost, requireBoundHost } from "./host-bind";

const WEB_ROOT_STYLE: CSSProperties = {
  flex: "1 1 0%",
  alignSelf: "stretch",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative",
  backgroundColor: "transparent",
};

const GUEST_HOST_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative",
};

const BOOT_LAYER_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 2,
  display: "flex",
  flexDirection: "column",
  background: "rgb(9, 9, 11)",
};

const ERROR_LAYER_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 3,
  display: "flex",
  flexDirection: "column",
  background: "rgba(9,9,11,0.92)",
};

const ERROR_FALLBACK_STYLE: CSSProperties = {
  ...ERROR_LAYER_STYLE,
  alignItems: "center",
  justifyContent: "center",
  color: "#a1a1aa",
  padding: 24,
  textAlign: "center",
};

const RETAIN_REASON = "openbot-open";

const styles = StyleSheet.create((theme) => ({
  fallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    backgroundColor: "transparent",
  },
  fallbackText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

export function bindOpenBotPanelHost(host: WorkspaceAppHostApi): void {
  bindOpenBotHost(host);
}

function getHost(): WorkspaceAppHostApi {
  return requireBoundHost();
}

function canUseGuestSurface(): boolean {
  return typeof document !== "undefined" && getHost().platform.isWeb;
}

export function OpenBotPanel(_props: {
  appId: string;
  panelId: string;
  entityId: string;
}): ReactElement {
  const guestHostRef = useRef<HTMLDivElement | null>(null);
  /** 首帧即 true：在 await ensure 之前盖住空 host，避免黑屏。 */
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = getHost();
    host.background?.requestRetain?.({
      appId: OPENBOT_APP_ID,
      active: true,
      reason: RETAIN_REASON,
    });
    return () => {
      host.background?.requestRetain?.({
        appId: OPENBOT_APP_ID,
        active: false,
        reason: RETAIN_REASON,
      });
    };
  }, []);

  useEffect(() => {
    if (!canUseGuestSurface()) {
      setBooting(false);
      setError("当前平台暂不支持嵌入 OpenBot，请使用 Agnx 桌面端。");
      return;
    }

    let cancelled = false;
    let unmountGuest: (() => void) | null = null;

    const mountGuest = (options?: { forceRestart?: boolean }) => {
      const host = getHost();
      const container = guestHostRef.current;
      if (!container) return;
      if (!host.guest?.mount) {
        setBooting(false);
        setError("宿主未提供 host.guest（需升级 Agnx 并重新扫描子应用）");
        return;
      }

      unmountGuest?.();
      unmountGuest = null;
      setBooting(true);
      setError(null);

      const args = ["--port", String(DEFAULT_OPENBOT_PORT)];
      if (options?.forceRestart) {
        args.push("--force-restart");
      }

      unmountGuest = host.guest.mount({
        container: guestHostRef.current,
        ensureTool: OPENBOT_ENSURE_TOOL_REL,
        ensureArgs: args,
        // 首次启动要跑 Bun + 建库连接，留足余量。
        timeoutMs: 240_000,
        bootOverlay: false,
        onReady: () => {
          if (cancelled) return;
          setError(null);
          // 留一帧给上游首屏，再撤面板遮罩。
          window.setTimeout(() => {
            if (!cancelled) setBooting(false);
          }, 320);
        },
        onError: (detail) => {
          if (cancelled) return;
          setBooting(false);
          setError(`${detail.code}: ${detail.message}`);
        },
      });
    };

    try {
      mountGuest();
    } catch (err) {
      setBooting(false);
      setError(err instanceof Error ? err.message : String(err));
    }

    return () => {
      cancelled = true;
      unmountGuest?.();
    };
  }, []);

  if (!canUseGuestSurface()) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>{error ?? "加载中…"}</Text>
      </View>
    );
  }

  const BrandPanel = getHost().ui?.BrandLogoLoaderPanel as
    | ComponentType<WorkspaceAppBrandLogoLoaderPanelProps>
    | undefined;

  return (
    <div style={WEB_ROOT_STYLE} data-testid="workspace-mini-app-openbot-root">
      <div ref={guestHostRef} data-agnx-guest-surface-host="true" style={GUEST_HOST_STYLE} />
      {booting && !error && BrandPanel ? (
        <div data-agnx-guest-boot-overlay="true" style={BOOT_LAYER_STYLE} role="status">
          <BrandPanel
            title="正在启动 OpenBot…"
            description="正在准备嵌入面"
            testID="openbot-boot-overlay"
          />
        </div>
      ) : null}
      {booting && !error && !BrandPanel ? (
        <div
          data-agnx-guest-boot-overlay="true"
          style={{ ...BOOT_LAYER_STYLE, ...ERROR_FALLBACK_STYLE }}
          role="status"
        >
          正在启动 OpenBot…
        </div>
      ) : null}
      {error && BrandPanel ? (
        <div style={ERROR_LAYER_STYLE} role="alert">
          <BrandPanel
            title="OpenBot 未能启动"
            description={error}
            testID="openbot-mount-error"
          />
        </div>
      ) : null}
      {error && !BrandPanel ? (
        <div style={ERROR_FALLBACK_STYLE} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
