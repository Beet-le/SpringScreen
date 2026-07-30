import { invoke } from "@tauri-apps/api/core";

export const createImageViewerWindow = async (filePath: string) => {
	await invoke<void>("create_image_viewer_window", { filePath });
};
