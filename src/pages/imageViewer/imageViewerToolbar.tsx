import { useCallback } from "react";

interface ImageViewerToolbarProps {
	filePath: string;
	naturalWidth: number;
	naturalHeight: number;
	zoom: number;
	rotation: number;
	onFitToWindow: () => void;
	onOriginalSize: () => void;
	onRotate: () => void;
	onFlipHorizontal: () => void;
	onFlipVertical: () => void;
}

const toolbarStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	padding: "4px 12px",
	backgroundColor: "rgba(0, 0, 0, 0.75)",
	color: "#fff",
	fontSize: "12px",
	fontFamily: "system-ui, sans-serif",
	userSelect: "none",
	flexShrink: 0,
	gap: "8px",
};

const infoStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "12px",
	overflow: "hidden",
	whiteSpace: "nowrap",
	textOverflow: "ellipsis",
	minWidth: 0,
};

const buttonsStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: "4px",
	flexShrink: 0,
};

const buttonStyle: React.CSSProperties = {
	background: "rgba(255, 255, 255, 0.1)",
	border: "none",
	color: "#fff",
	padding: "3px 8px",
	borderRadius: "3px",
	cursor: "pointer",
	fontSize: "12px",
	fontFamily: "system-ui, sans-serif",
	lineHeight: "1.4",
};

export const ImageViewerToolbar: React.FC<ImageViewerToolbarProps> = ({
	filePath,
	naturalWidth,
	naturalHeight,
	zoom,
	rotation,
	onFitToWindow,
	onOriginalSize,
	onRotate,
	onFlipHorizontal,
	onFlipVertical,
}) => {
	// 从文件路径提取文件名
	const fileName = filePath.split(/[\\/]/).pop() ?? filePath;

	const handleFitToWindow = useCallback(() => {
		onFitToWindow();
	}, [onFitToWindow]);

	const handleOriginalSize = useCallback(() => {
		onOriginalSize();
	}, [onOriginalSize]);

	const handleRotate = useCallback(() => {
		onRotate();
	}, [onRotate]);

	const handleFlipH = useCallback(() => {
		onFlipHorizontal();
	}, [onFlipHorizontal]);

	const handleFlipV = useCallback(() => {
		onFlipVertical();
	}, [onFlipVertical]);

	return (
		<div style={toolbarStyle}>
			<div style={infoStyle}>
				<span style={{ fontWeight: 500 }}>{fileName}</span>
				{naturalWidth > 0 && naturalHeight > 0 && (
					<span style={{ opacity: 0.7 }}>
						{naturalWidth} × {naturalHeight}
					</span>
				)}
				<span style={{ opacity: 0.7 }}>{Math.round(zoom * 100)}%</span>
				{rotation !== 0 && <span style={{ opacity: 0.7 }}>{rotation}°</span>}
			</div>
			<div style={buttonsStyle}>
				<button
					type="button"
					style={buttonStyle}
					onClick={handleFitToWindow}
					title="适应窗口"
				>
					适应
				</button>
				<button
					type="button"
					style={buttonStyle}
					onClick={handleOriginalSize}
					title="原始大小 (0)"
				>
					1:1
				</button>
				<button
					type="button"
					style={buttonStyle}
					onClick={handleRotate}
					title="旋转 (R)"
				>
					旋转
				</button>
				<button
					type="button"
					style={buttonStyle}
					onClick={handleFlipH}
					title="水平翻转 (F)"
				>
					水平翻转
				</button>
				<button
					type="button"
					style={buttonStyle}
					onClick={handleFlipV}
					title="垂直翻转 (G)"
				>
					垂直翻转
				</button>
			</div>
		</div>
	);
};
