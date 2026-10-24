// 场景：OpenBot 侧栏/命令用品牌标 — 上游未带独立 svg 图标，这里按「一个 AI 同事」语义画一个极简标
// （聊天气泡 + 光标），不复制上游 UI，只做入口识别。
import { SvgXml } from "react-native-svg";

/** fill/stroke 跟 WorkspaceAppIcon.color 走，适配明暗主题。 */
const OPENBOT_ICON_XML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><path d="M4.5 5.5A2.5 2.5 0 0 1 7 3h10a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 17 16H9.2L5.1 19.3A.9.9 0 0 1 3.7 18.6V5.5Z" stroke="CURRENT" stroke-width="1.7" stroke-linejoin="round"/><circle cx="9" cy="9.6" r="1.25" fill="CURRENT"/><circle cx="15" cy="9.6" r="1.25" fill="CURRENT"/></svg>`;

export function OpenBotIcon(props: {
  size?: number | string;
  color?: string;
  absoluteStrokeWidth?: boolean;
}) {
  const size = typeof props.size === "number" ? props.size : Number(props.size) || 16;
  const color = props.color ?? "currentColor";
  const xml = OPENBOT_ICON_XML.replaceAll("CURRENT", color);
  return <SvgXml xml={xml} width={size} height={size} />;
}
