import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { ImageViewerCore } from "./imageViewerCore";

interface ImageDirInfo {
	files: string[];
	current_index: number;
}

export const ImageViewerPage: React.FC = () => {
	const [currentFilePath, setCurrentFilePath] = useState<string>("");
	const [dirFiles, setDirFiles] = useState<string[]>([]);
	const [currentIndex, setCurrentIndex] = useState(0);
	const [ready, setReady] = useState(false);

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const pathParam = params.get("path");
		if (!pathParam) return;
		setCurrentFilePath(pathParam);
	}, []);

	useEffect(() => {
		if (!currentFilePath) return;
		(async () => {
			try {
				const info = await invoke<ImageDirInfo>("scan_image_dir", {
					filePath: currentFilePath,
				});
				setDirFiles(info.files);
				setCurrentIndex(info.current_index);
			} catch {
				setDirFiles([currentFilePath]);
				setCurrentIndex(0);
			}
			setReady(true);
		})();
	}, [currentFilePath]);

	const goPrev = useCallback(() => {
		const idx = currentIndex - 1;
		if (idx >= 0 && dirFiles[idx]) setCurrentFilePath(dirFiles[idx]);
	}, [currentIndex, dirFiles]);

	const goNext = useCallback(() => {
		const idx = currentIndex + 1;
		if (idx < dirFiles.length && dirFiles[idx])
			setCurrentFilePath(dirFiles[idx]);
	}, [currentIndex, dirFiles]);

	if (!ready) return null;

	return (
		<ImageViewerCore
			filePath={currentFilePath}
			totalCount={dirFiles.length}
			currentIndex={currentIndex}
			onPrev={goPrev}
			onNext={goNext}
			hasPrev={currentIndex > 0}
			hasNext={currentIndex < dirFiles.length - 1}
		/>
	);
};
