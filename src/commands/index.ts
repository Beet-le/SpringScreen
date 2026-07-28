import { invoke } from "@tauri-apps/api/core";
import { Base64 } from "js-base64";
import {
	type ElementRect,
	type ImageBuffer,
	ImageBufferType,
	type ImageEncoder,
	type WindowElement,
} from "@/types/commands/screenshot";
import type { ImageFormat } from "@/types/utils/file";

// ============================================================
// Tauri IPC 命令封装层
//
// 所有前端对 Rust 后端的调用都通过 invoke() 函数进行。
// 本文件封装了截图相关的 IPC 命令，提供类型安全的接口。
// ============================================================

/**
 * 捕获鼠标所在显示器的屏幕图像
 */
export const captureCurrentMonitor = async (
	encoder: ImageEncoder,
): Promise<ImageBuffer | undefined> => {
	const result = await invoke<ArrayBuffer>("capture_current_monitor", {
		encoder,
	});

	if (result.byteLength === 0) {
		return undefined;
	}

	return {
		encoder,
		data: new Blob([result]),
		bufferType: ImageBufferType.Pixels,
		buffer: result,
	};
};

/**
 * 获取当前所有窗口元素列表（用于 UI 自动化自动框选）
 */
export const getWindowElements = async () => {
	const result = await invoke<WindowElement[]>("get_window_elements");
	return result;
};

/**
 * 初始化 UI 自动化元素缓存
 */
export const initUiElementsCache = async () => {
	const result = await invoke<void>("init_ui_elements_cache");
	return result;
};

/**
 * 初始化 UI 自动化引擎
 */
export const initUiElements = async () => {
	const result = await invoke<void>("init_ui_elements");
	return result;
};

/**
 * 根据鼠标位置获取对应的 UI 元素（自动识别按钮、输入框等）
 */
export const getElementFromPosition = async (
	mouseX: number,
	mouseY: number,
) => {
	const result = await invoke<ElementRect[]>("get_element_from_position", {
		mouseX,
		mouseY,
	});
	return result;
};

/**
 * 退出应用
 */
export const exitApp = async () => {
	const result = await invoke<void>("exit_app");
	return result;
};

/**
 * 获取当前鼠标位置
 */
export const getMousePosition = async () => {
	const result = await invoke<[number, number]>("get_mouse_position");
	return result;
};

/**
 * 保存文件到磁盘
 */
export const saveFile = async (
	filePath: string,
	data: ArrayBuffer | Uint8Array,
	fileType: ImageFormat,
) => {
	const result = await invoke<void>("save_file", data, {
		headers: {
			"x-file-path": Base64.encode(filePath),
			"x-file-type": Base64.encode(fileType),
		},
	});
	return result;
};

/**
 * 创建 draw 截图编辑窗口
 * 返回 true 表示创建了新窗口，false 表示已有 standby 窗口；WebView2 初始化失败时抛出异常
 */
export const createDrawWindow = async () => {
	const result = await invoke<boolean>("create_draw_window");
	return result;
};

/**
 * 触发截图（IPC 调用 Rust 侧 trigger_screenshot）
 *
 * 这是前端触发截图的底层 IPC 入口，调用 Rust 侧的 trigger_screenshot command。
 * 通常不直接调用此函数，而是通过 executeScreenshot() emit 事件的方式触发。
 * 此函数作为 Rust 侧兜底通道的 IPC 入口（前端 WebView 冻结场景下不使用）。
 *
 * @param screenshotType - 截图类型（"default"、"delay"、"fullscreen" 等）
 * @param windowLabel - 调用者窗口标签
 * @param captureHistoryId - 截图历史 ID
 */
export const triggerScreenshot = async (
	screenshotType: string,
	windowLabel?: string,
	captureHistoryId?: string,
) => {
	await invoke<void>("trigger_screenshot", {
		screenshotType,
		windowLabel,
		captureHistoryId,
	});
};

/**
 * 同步截图快捷键映射到 Rust 侧
 *
 * 前端在快捷键变更时调用此函数，将 {快捷键: 截图类型} 映射表同步到 Rust 状态中，
 * 使 Rust 侧的全局快捷键 handler 能够直接查找并触发对应类型的截图。
 */
export const syncScreenshotShortcuts = async (map: Record<string, string>) => {
	await invoke<void>("sync_screenshot_shortcuts", { map });
};
