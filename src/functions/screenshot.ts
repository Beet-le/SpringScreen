import { emit } from "@tauri-apps/api/event";
import * as tauriLog from "@tauri-apps/plugin-log";
import { createDrawWindow } from "@/commands";
import { getCaptureState } from "@/commands/globalSate";
import { captureFocusedWindow } from "@/commands/screenshot";
import { FOCUS_WINDOW_APP_NAME_ENV_VARIABLE } from "@/constants/components/chat";
import { type AppSettingsData, AppSettingsGroup } from "@/types/appSettings";
import { getCorrectHdrColorAlgorithm } from "@/utils/appSettings";
import { playCameraShutterSound } from "@/utils/audio";
import { getImagePathFromSettings } from "@/utils/file";
import { appError } from "@/utils/log";
import { ScreenshotType } from "@/utils/types";

const SCREENSHOT_WAKE_RETRY_DELAY_MS = 120;
const SCREENSHOT_WAKE_RETRY_COUNT = 12;

const wait = async (delay: number) => {
	await new Promise((resolve) => {
		window.setTimeout(resolve, delay);
	});
};

export const executeScreenshot = async (
	type: ScreenshotType = ScreenshotType.Default,
	windowLabel?: string,
	captureHistoryId?: string,
) => {
	// Ensure draw window pool is normalized before broadcasting screenshot event.
	await createDrawWindow();

	const payload = {
		type,
		windowLabel,
		captureHistoryId,
	};

	for (let index = 0; index < SCREENSHOT_WAKE_RETRY_COUNT; index++) {
		if ((await getCaptureState()).capturing) {
			return;
		}

		await emit("execute-screenshot", payload);

		if (index < SCREENSHOT_WAKE_RETRY_COUNT - 1) {
			await wait(SCREENSHOT_WAKE_RETRY_DELAY_MS);
		}
	}
};

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

export const finishScreenshot = async () => {
	await emit("finish-screenshot");
};

export const releaseDrawPage = async (force: boolean = false) => {
	await emit("release-draw-page", {
		force,
	});
};

export const onCaptureHistoryChange = async () => {
	await emit("on-capture-history-change");
};
