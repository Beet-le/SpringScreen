import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { ImageViewerCore } from "./imageViewerCore";

export const ImageViewerPage: React.FC = () => {
	const [imageUrl, setImageUrl] = useState<string | undefined>();
	const [filePath, setFilePath] = useState<string>("");

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const pathParam = params.get("path");
		if (!pathParam) return;

		// URLSearchParams.get() 已自动解码 percent-encoding，无需额外解码
		setFilePath(pathParam);
		setImageUrl(convertFileSrc(pathParam));
	}, []);

	if (!imageUrl) return null;

	return <ImageViewerCore imageUrl={imageUrl} filePath={filePath} />;
};
