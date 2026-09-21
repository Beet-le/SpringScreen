interface ImageViewerToolbarProps {
	naturalWidth: number;
	naturalHeight: number;
	zoom: number;
	rotation: number;
	currentIndex: number;
	totalCount: number;
	fullscreen: boolean;
	enableOcr: boolean;
	hasOcrPlugin: boolean;
	onFitToWindow: () => void;
	onOriginalSize: () => void;
	onRotate: () => void;
	onFlipHorizontal: () => void;
	onFlipVertical: () => void;
	onToggleFullscreen: () => void;
	onToggleOcr: () => void;
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
	naturalWidth,
	naturalHeight,
	zoom,
	rotation,
	currentIndex,
	totalCount,
	fullscreen,
	enableOcr,
	hasOcrPlugin,
	onFitToWindow,
	onOriginalSize,
	onRotate,
	onFlipHorizontal,
	onFlipVertical,
	onToggleFullscreen,
	onToggleOcr,
}) => {
	return (
		<div style={toolbarStyle}>
			<div style={infoStyle}>
				{totalCount > 1 && (
					<span style={{ opacity: 0.7 }}>
						{currentIndex + 1}/{totalCount}
					</span>
				)}
				{naturalWidth > 0 && naturalHeight > 0 && (
					<span style={{ opacity: 0.7 }}>
						{naturalWidth} × {naturalHeight}
					</span>
				)}
				<span style={{ opacity: 0.7 }}>{Math.round(zoom * 100)}%</span>
				{rotation !== 0 && <span style={{ opacity: 0.7 }}>{rotation}°</span>}
			</div>
			<div style={buttonsStyle}>
				{/* OCR */}
				{hasOcrPlugin && (
					<button
						type="button"
						style={{
							...buttonStyle,
							backgroundColor: enableOcr ? "rgba(24, 144, 255, 0.3)" : undefined,
						}}
						onClick={onToggleOcr}
						title="文字识别 (T)"
					>
						文字识别
					</button>
				)}

				{/* 缩放 */}
				<button
					type="button"
					style={buttonStyle}
					onClick={onFitToWindow}
					title="适应窗口"
				>
					适应
				</button>

				{/* 变换 */}
				<button
					type="button"
					style={buttonStyle}
					onClick={onRotate}
					title="旋转 (R)"
				>
					旋转
				</button>
				<button
					type="button"
					style={buttonStyle}
					onClick={onFlipHorizontal}
					title="水平翻转 (F)"
				>
					↔
				</button>
				<button
					type="button"
					style={buttonStyle}
					onClick={onFlipVertical}
					title="垂直翻转 (G)"
				>
					↕
				</button>

				{/* 全屏 */}
				<button
					type="button"
					style={buttonStyle}
					onClick={onToggleFullscreen}
					title="全屏 (F11)"
				>
					{fullscreen ? "⤢" : "⤡"}
				</button>
			</div>
		</div>
	);
};
