import { emit } from "@tauri-apps/api/event";
import * as tauriLog from "@tauri-apps/plugin-log";
import { captureFocusedWindow } from "@/commands/screenshot";
import { FOCUS_WINDOW_APP_NAME_ENV_VARIABLE } from "@/constants/components/chat";
import { type AppSettingsData, AppSettingsGroup } from "@/types/appSettings";
import { getCorrectHdrColorAlgorithm } from "@/utils/appSettings";
import { playCameraShutterSound } from "@/utils/audio";
import { getImagePathFromSettings } from "@/utils/file";
import { appError } from "@/utils/log";
import { ScreenshotType } from "@/utils/types";

// ============================================================
// 前端截图触发函数
//
// 主链路：前端快捷键 handler → executeScreenshot() → emit("execute-screenshot")
//          → draw 页面收到事件 → excuteScreenshot() 执行截图
//
// 备用链路（兜底）：Rust 侧快捷键 handler → trigger_screenshot_core()
//                   → emit_to(draw, "execute-screenshot") 绕过前端 IPC
// ============================================================

/**
 * 触发截图（主链路入口）
 *
 * 通过 emit 全局事件通知 draw 窗口执行截图。
 * 当 WebView2 正常运行时，JS 侧的全局快捷键 handler 调用此函数；
 * 当 WebView2 被冻结时，Rust 侧会通过 emit_to 直接向 draw 窗口发事件作为兜底。
 *
 * @param type - 截图类型（default/delay/fullscreen 等）
 * @param windowLabel - 调用者的窗口标签（用于防止循环事件）
 * @param captureHistoryId - 截图历史 ID（切换历史时使用）
 */
export const executeScreenshot = async (
	type: ScreenshotType = ScreenshotType.Default,
	windowLabel?: string,
	captureHistoryId?: string,
) => {
	const t0 = performance.now();
	await emit("execute-screenshot", {
		type,
		windowLabel,
		captureHistoryId,
	});
	const elapsed = (performance.now() - t0).toFixed(1);
	tauriLog.debug(
		`[screenshot-perf] emit execute-screenshot: ${elapsed}ms, type=${type}`,
	);
};

/**
 * 捕获当前焦点窗口（直接保存到文件/剪贴板，不走 draw 编辑器）
 */
export const executeScreenshotFocusedWindow = async (
	appSettings: AppSettingsData,
) => {
	const imagePath = await getImagePathFromSettings(
		appSettings,
		"focused-window",
	);
	if (!imagePath) {
		tauriLog.error(
			"[executeScreenshotFocusedWindow] Failed to get image path from settings",
		);

		return;
	}

	try {
		const captureFocusedWindowPromise = captureFocusedWindow(
			imagePath.filePath,
			appSettings[AppSettingsGroup.FunctionScreenshot]
				.focusedWindowCopyToClipboard,
			FOCUS_WINDOW_APP_NAME_ENV_VARIABLE,
			getCorrectHdrColorAlgorithm(appSettings),
		);
		playCameraShutterSound();
		await captureFocusedWindowPromise;
	} catch (error) {
		appError(
			"[executeScreenshotFocusedWindow] Failed to capture focused window",
			error,
		);
	}
};

/**
 * 通知 draw 页面结束截图（隐藏窗口、释放资源）
 */
export const finishScreenshot = async () => {
	await emit("finish-screenshot");
};

/**
 * 释放 draw 页面
 *
 * keep-alive 模式下 force=false 时不会关闭窗口，
 * 仅重置状态为 Active 并释放 GPU 资源
 */
export const releaseDrawPage = async (force: boolean = false) => {
	await emit("release-draw-page", {
		force,
	});
};

/**
 * 通知截图历史已变更
 */
export const onCaptureHistoryChange = async () => {
	await emit("on-capture-history-change");
};
