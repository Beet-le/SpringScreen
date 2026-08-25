import { invoke } from "@tauri-apps/api/core";
import { DrawState } from "@/types/draw";
import { appLog, LogMessageLevel } from "./appLog";

/** 缓存系统用户名，避免重复调用 */
let cachedUsername: string | null = null;

/**
 * 获取系统用户名（工号）
 * 首次调用从 Rust 后端获取，后续使用缓存
 */
const getSystemUsername = async (): Promise<string> => {
  if (cachedUsername !== null) {
    return cachedUsername;
  }
  try {
    const username = await invoke<string>("get_system_username");
    cachedUsername = username;
    return username;
  } catch {
    return "unknown";
  }
};

/**
 * 统计事件类型
 */
export enum TrackEventType {
  ToolUsage = "tool_usage", // 工具使用
  Screenshot = "screenshot", // 截图完成
  Save = "save", // 保存
  Copy = "copy", // 复制到剪贴板
  OcrDetect = "ocr_detect", // 文字识别
  VideoRecord = "video_record", // 录制视频
}

/**
 * 统计事件基础接口
 */
export interface TrackEvent {
  /** 事件类型 */
  eventType: TrackEventType;
  /** 会话 ID */
  sessionId: string;
  /** 额外数据 */
  [key: string]: any;
}

/**
 * 工具使用统计事件
 */
export interface ToolUsageTrackEvent extends TrackEvent {
  eventType: TrackEventType.ToolUsage;
  /** 工具名称 */
  toolName: string;
  /** 操作类型 */
  action: "click" | "drag" | "complete" | "cancel";
}

/**
 * 获取或创建会话 ID
 */
const getSessionId = (): string => {
  // 尝试从 sessionStorage 获取
  let sessionId = sessionStorage.getItem("snow_shot_session_id");

  if (!sessionId) {
    // 创建新的会话 ID
    sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    sessionStorage.setItem("snow_shot_session_id", sessionId);
  }

  return sessionId;
};

/**
 * 发送统计请求（异步，不阻塞用户操作）
 */
const sendTrackRequest = async (event: TrackEvent): Promise<void> => {
  try {
    // 埋点接口地址（可通过环境变量 ANALYTICS_API_URL 配置，默认为后端地址）
    const trackApiUrl = import.meta.env.ANALYTICS_API_URL || "https://your-api-domain.com/track";

    // 获取系统用户名（工号）
    const username = await getSystemUsername();

    const trackData = {
      ...event,
      timestamp: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
      userId: username, // 计算机名
    };

    // 记录即将发送的完整数据（包含 userId）
    appLog(
      LogMessageLevel.Info,
      `[Analytics] Sending track data: ${JSON.stringify(trackData)}`,
      "APP_WEB",
    );

    // 使用 fetch 发送，失败不影响用户体验
    await fetch(trackApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(trackData),
      // 超时设置
      signal: AbortSignal.timeout(3000),
    });
  } catch (error) {
    // 静默失败，记录到本地日志（不显示给用户）
    appLog(
      LogMessageLevel.Info,
      `[Analytics] Track request failed: ${event.eventType}`,
      "APP_WEB",
    );
  }
};

/**
 * 通用统计函数
 */
export const trackEvent = (event: TrackEvent): void => {
  // 检查是否允许统计（可以从设置中读取）
  if (!isTrackingAllowed()) {
    appLog(
      LogMessageLevel.Info,
      `[Analytics] Tracking skipped (disabled by user): ${event.eventType}`,
      "APP_WEB",
    );
    return;
  }

  // 记录统计触发
  appLog(
    LogMessageLevel.Info,
    `[Analytics] Tracking triggered: ${event.eventType} | ${JSON.stringify(event)}`,
    "APP_WEB",
  );

  // 使用 requestIdleCallback 或 setTimeout 确保不阻塞用户操作
  if (typeof requestIdleCallback !== "undefined") {
    requestIdleCallback(() => sendTrackRequest(event), { timeout: 2000 });
  } else {
    setTimeout(() => sendTrackRequest(event), 0);
  }
};

/**
 * 工具使用统计
 */
export const trackToolUsage = (
  toolName: string | DrawState,
  action: "click" | "drag" | "complete" | "cancel" = "click",
): void => {
  // 将 DrawState 枚举值转换为可读的工具名称
  const toolNameStr =
    typeof toolName === "number" ? DrawState[toolName] || String(toolName) : toolName;

  const event: ToolUsageTrackEvent = {
    eventType: TrackEventType.ToolUsage,
    toolName: toolNameStr,
    action,
    sessionId: getSessionId(),
  };

  trackEvent(event);
};

/**
 * 截图完成统计
 */
export const trackScreenshot = (
  screenshotType: string,
  duration?: number,
): void => {
  trackEvent({
    eventType: TrackEventType.Screenshot,
    screenshotType,
    duration,
    sessionId: getSessionId(),
  });
};

/**
 * 保存统计
 */
export const trackSave = (
  saveType: "local" | "cloud" | "clipboard",
  format?: string,
): void => {
  trackEvent({
    eventType: TrackEventType.Save,
    saveType,
    format,
    sessionId: getSessionId(),
  });
};

/**
 * 文字识别统计
 */
export const trackOcrDetect = (
  ocrModel: string,
  duration?: number,
): void => {
  trackEvent({
    eventType: TrackEventType.OcrDetect,
    ocrModel,
    duration,
    sessionId: getSessionId(),
  });
};

/**
 * 录制视频统计
 */
export const trackVideoRecord = (
  action: "start" | "stop" | "pause" | "resume",
  duration?: number,
): void => {
  trackEvent({
    eventType: TrackEventType.VideoRecord,
    action,
    duration,
    sessionId: getSessionId(),
  });
};

/**
 * 检查是否允许统计
 * 从 localStorage 读取（设置页面会同步到此）
 */
const isTrackingAllowed = (): boolean => {
  const trackingEnabled = localStorage.getItem("snow_shot_tracking_enabled");

  if (trackingEnabled === null) {
    return true; // 默认允许
  }

  return trackingEnabled === "true";
};

/**
 * 设置是否允许统计（由设置页面调用）
 */
export const setTrackingEnabled = (enabled: boolean): void => {
  localStorage.setItem("snow_shot_tracking_enabled", enabled ? "true" : "false");

  appLog(
    LogMessageLevel.Info,
    `[Analytics] Tracking ${enabled ? "enabled" : "disabled"}`,
    "APP_WEB",
  );
};

/**
 * 获取当前会话 ID（用于调试）
 */
export const getSessionIdDebug = (): string => {
  return getSessionId();
};
