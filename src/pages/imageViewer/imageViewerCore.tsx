import { invoke } from "@tauri-apps/api/core";
// Rust 端已在 create_image_viewer_window 中恢复窗口状态，前端无需重复恢复
// import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { ImageViewerToolbar } from "./imageViewerToolbar";

interface ImageViewerCoreProps {
	imageUrl: string;
	filePath: string;
}

/** 图片查看器窗口状态（大小和位置） */
interface ImageViewerWindowState {
	width: number;
	height: number;
	x?: number;
	y?: number;
}

export const ImageViewerCore: React.FC<ImageViewerCoreProps> = ({
	imageUrl,
	filePath,
}) => {
	const containerRef = useRef<HTMLDivElement>(null);

	const [zoom, setZoom] = useState(1);
	const [panX, setPanX] = useState(0);
	const [panY, setPanY] = useState(0);
	const [rotation, setRotation] = useState(0);
	const [flipX, setFlipX] = useState(1);
	const [flipY, setFlipY] = useState(1);
	const [naturalWidth, setNaturalWidth] = useState(0);
	const [naturalHeight, setNaturalHeight] = useState(0);
	const [isDragging, setIsDragging] = useState(false);
	// [已废弃] 旧的 dragStart 状态，拖拽改用 movementX/movementY 增量模式
	// const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

	// ============================================================
	// 像素空间渲染模型（参考 voidImageViewer）
	// ============================================================
	// CSS 模型：left:0; top:0; transformOrigin:"0 0"; translate 独立属性
	// - 图片渲染尺寸 = naturalWidth × zoom, naturalHeight × zoom
	// - 图片左上角屏幕位置 = (panX, panY)（相对于容器左上角）
	// - 图片上像素 P 的屏幕位置 = panX + P × zoom
	// ============================================================

	// 用 ref 同步最新状态值，供事件回调读取
	const zoomRef = useRef(zoom);
	const panXRef = useRef(panX);
	const panYRef = useRef(panY);
	useEffect(() => {
		zoomRef.current = zoom;
	}, [zoom]);
	useEffect(() => {
		panXRef.current = panX;
	}, [panX]);
	useEffect(() => {
		panYRef.current = panY;
	}, [panY]);

	// 适应窗口（居中显示）— 像素空间计算
	const fitToWindow = useCallback(() => {
		const container = containerRef.current;
		if (!container || naturalWidth === 0 || naturalHeight === 0) return;
		const rect = container.getBoundingClientRect();
		const containerW = rect.width;
		const containerH = rect.height;

		// 计算 fit 缩放（留 5% 边距）
		const scaleX = containerW / naturalWidth;
		const scaleY = containerH / naturalHeight;
		const fitZoom = Math.min(scaleX, scaleY) * 0.95;

		// 计算渲染尺寸
		const renderW = naturalWidth * fitZoom;
		const renderH = naturalHeight * fitZoom;

		// 居中：图片左上角 = (容器尺寸 - 渲染尺寸) / 2
		const centerX = (containerW - renderW) / 2;
		const centerY = (containerH - renderH) / 2;

		setZoom(fitZoom);
		setPanX(centerX);
		setPanY(centerY);
	}, [naturalWidth, naturalHeight]);

	// 图片加载完成后适应窗口
	const handleImageLoad = useCallback(
		(e: React.SyntheticEvent<HTMLImageElement>) => {
			const img = e.currentTarget;
			setNaturalWidth(img.naturalWidth);
			setNaturalHeight(img.naturalHeight);
		},
		[],
	);

	// naturalWidth/naturalHeight 变化时自动适应窗口
	useEffect(() => {
		if (naturalWidth > 0 && naturalHeight > 0) {
			fitToWindow();
		}
	}, [naturalWidth, naturalHeight, fitToWindow]);

	// 窗口尺寸变化时重新适应
	useEffect(() => {
		const handleResize = () => {
			fitToWindow();
		};
		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, [fitToWindow]);

	// 鼠标滚轮缩放（以鼠标位置为中心）— voidImageViewer 像素空间公式
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const handler = (e: WheelEvent) => {
			e.preventDefault();
			const rect = el.getBoundingClientRect();

			// 鼠标在容器中的位置（相对于容器左上角）
			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;

			const currentZoom = zoomRef.current;
			const currentPanX = panXRef.current;
			const currentPanY = panYRef.current;

			// 当前渲染尺寸
			const renderW = naturalWidth * currentZoom;
			const renderH = naturalHeight * currentZoom;

			// 图片左上角位置
			const imgLeft = currentPanX;
			const imgTop = currentPanY;

			// 鼠标在渲染图上的相对位置（像素坐标）
			const cursorPx = mouseX - imgLeft;
			const cursorPy = mouseY - imgTop;

			// 计算新缩放
			const delta = e.deltaY > 0 ? 0.9 : 1.1;
			const newZoom = Math.max(0.1, Math.min(20, currentZoom * delta));
			if (newZoom === currentZoom) return;

			// 新渲染尺寸
			const newRenderW = naturalWidth * newZoom;
			const newRenderH = naturalHeight * newZoom;

			// 缩放后鼠标位置的等比映射
			const newCursorPx = (cursorPx * newRenderW) / renderW;
			const newCursorPy = (cursorPy * newRenderH) / renderH;

			// 反算新 pan：保持鼠标下像素不动
			// mouseX = newPanX + newCursorPx
			const newPanX = mouseX - newCursorPx;
			const newPanY = mouseY - newCursorPy;

			setZoom(newZoom);
			setPanX(newPanX);
			setPanY(newPanY);
		};
		el.addEventListener("wheel", handler, { passive: false });
		return () => el.removeEventListener("wheel", handler);
	}, [naturalWidth, naturalHeight]);

	// 双击适应窗口
	const handleDoubleClick = useCallback(() => {
		fitToWindow();
	}, [fitToWindow]);

	// 拖拽平移 — 使用 movementX/movementY 增量模式
	const handleMouseDown = useCallback((e: React.MouseEvent) => {
		if (e.button !== 0) return; // 只响应左键
		setIsDragging(true);
	}, []);

	const handleMouseMove = useCallback(
		(e: React.MouseEvent) => {
			if (!isDragging) return;
			setPanX((prev) => prev + e.movementX);
			setPanY((prev) => prev + e.movementY);
		},
		[isDragging],
	);

	const handleMouseUp = useCallback(() => {
		setIsDragging(false);
	}, []);

	// 键盘事件
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			switch (e.key) {
				case "r":
				case "R":
					setRotation((prev) => (prev + 90) % 360);
					break;
				case "f":
				case "F":
					setFlipX((prev) => prev * -1);
					break;
				case "g":
				case "G":
					setFlipY((prev) => prev * -1);
					break;
				case "0": {
					// 原始大小（zoom=1），渲染尺寸 = 原始像素尺寸，居中显示
					const container = containerRef.current;
					if (container) {
						const rect = container.getBoundingClientRect();
						setZoom(1);
						setPanX((rect.width - naturalWidth) / 2);
						setPanY((rect.height - naturalHeight) / 2);
					} else {
						setZoom(1);
						setPanX(0);
						setPanY(0);
					}
					break;
				}
				case "+":
				case "=": {
					// 以容器中心为缩放中心，voidImageViewer 公式
					const container = containerRef.current;
					if (container) {
						const rect = container.getBoundingClientRect();
						const centerX = rect.width / 2;
						const centerY = rect.height / 2;
						const currentZoom = zoomRef.current;
						const currentPanX = panXRef.current;
						const currentPanY = panYRef.current;
						const renderW = naturalWidth * currentZoom;
						const renderH = naturalHeight * currentZoom;
						const cursorPx = centerX - currentPanX;
						const cursorPy = centerY - currentPanY;
						const newZoom = Math.min(20, currentZoom * 1.1);
						const newRenderW = naturalWidth * newZoom;
						const newRenderH = naturalHeight * newZoom;
						const newCursorPx = (cursorPx * newRenderW) / renderW;
						const newCursorPy = (cursorPy * newRenderH) / renderH;
						setZoom(newZoom);
						setPanX(centerX - newCursorPx);
						setPanY(centerY - newCursorPy);
					}
					break;
				}
				case "-": {
					// 以容器中心为缩放中心，voidImageViewer 公式
					const container = containerRef.current;
					if (container) {
						const rect = container.getBoundingClientRect();
						const centerX = rect.width / 2;
						const centerY = rect.height / 2;
						const currentZoom = zoomRef.current;
						const currentPanX = panXRef.current;
						const currentPanY = panYRef.current;
						const renderW = naturalWidth * currentZoom;
						const renderH = naturalHeight * currentZoom;
						const cursorPx = centerX - currentPanX;
						const cursorPy = centerY - currentPanY;
						const newZoom = Math.max(0.1, currentZoom * 0.9);
						const newRenderW = naturalWidth * newZoom;
						const newRenderH = naturalHeight * newZoom;
						const newCursorPx = (cursorPx * newRenderW) / renderW;
						const newCursorPy = (cursorPy * newRenderH) / renderH;
						setZoom(newZoom);
						setPanX(centerX - newCursorPx);
						setPanY(centerY - newCursorPy);
					}
					break;
				}
				// 方向键平移（屏幕空间像素偏移）
				case "ArrowLeft":
					setPanX((prev) => prev + 50);
					break;
				case "ArrowRight":
					setPanX((prev) => prev - 50);
					break;
				case "ArrowUp":
					setPanY((prev) => prev + 50);
					break;
				case "ArrowDown":
					setPanY((prev) => prev - 50);
					break;
				case "Escape":
					getCurrentWindow().close();
					break;
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [naturalWidth, naturalHeight]);

	// Rust 端已在 create_image_viewer_window 中通过 set_size/set_position 恢复窗口状态
	// 前端不再重复恢复，避免闪烁
	// useEffect(() => {
	// 	invoke<ImageViewerWindowState>("load_image_viewer_window_state")
	// 		.then((state) => {
	// 			if (state?.width && state.height) {
	// 				const win = getCurrentWindow();
	// 				win.setSize(new LogicalSize(state.width, state.height));
	// 				if (state.x !== undefined && state.y !== undefined) {
	// 					win.setPosition(new LogicalPosition(state.x, state.y));
	// 				}
	// 			}
	// 		})
	// 		.catch(() => {});
	// }, []);

	// 窗口关闭前保存窗口状态
	useEffect(() => {
		const win = getCurrentWindow();
		// 标记是否已保存过状态，防止 close() 再次触发 onCloseRequested 时无限循环
		let isSaving = false;
		const unlisten = win.onCloseRequested((event) => {
			if (isSaving) return; // 第二次触发（保存完成后的 close()），不阻止，允许关闭
			event.preventDefault(); // 阻止立即关闭，等待状态保存完成
			isSaving = true;
			const windowState: ImageViewerWindowState = {
				width: window.innerWidth,
				height: window.innerHeight,
				x: window.screenX,
				y: window.screenY,
			};
			invoke("save_image_viewer_window_state", { windowState }).finally(() => {
				getCurrentWindow().close(); // 保存完成后再关闭
			});
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	// 组件卸载时清除图片引用，帮助 WebView2 释放解码缓冲区
	useEffect(() => {
		return () => {
			document.querySelectorAll("img").forEach((img) => {
				img.src = "";
			});
		};
	}, []);

	// 容器样式
	// 使用 flex:1 替代 height:"100%"，确保在 WebView2 flex 布局中正确获取高度
	const containerStyle: React.CSSProperties = {
		width: "100%",
		flex: "1 1 0",
		minHeight: 0,
		overflow: "hidden",
		cursor: isDragging ? "grabbing" : "grab",
		position: "relative",
		backgroundColor: "#1a1a1a",
	};

	// [已废弃] 旧的 CSS 模型：left:50% + 负 margin 居中 + transformOrigin: "center center"
	// 该模型依赖复杂的 CSS transform-origin 行为，图片不可见
	// const imageStyle_old = {
	// 	transform: `scale(${zoom}) rotate(${rotation}deg) scaleX(${flipX}) scaleY(${flipY})`,
	// 	transformOrigin: "center center",
	// 	transition: isDragging ? "none" : "transform 0.15s ease-out",
	// 	maxWidth: "none",
	// 	position: "absolute",
	// 	left: "50%",
	// 	top: "50%",
	// 	marginLeft: naturalWidth > 0 ? `-${naturalWidth / 2}px` : undefined,
	// 	marginTop: naturalHeight > 0 ? `-${naturalHeight / 2}px` : undefined,
	// 	translate: `${panX}px ${panY}px`,
	// 	userSelect: "none",
	// };

	// 图片样式 — 像素空间渲染模型（参考 voidImageViewer）
	// left:0; top:0; transformOrigin:"0 0"; translate 是独立 CSS 属性
	// scale 从左上角开始缩放，translate 将图片平移到正确位置
	const imageStyle: React.CSSProperties = {
		transform: `scale(${zoom}) rotate(${rotation}deg) scaleX(${flipX}) scaleY(${flipY})`,
		transformOrigin: "0 0",
		transition: isDragging ? "none" : "transform 0.15s ease-out",
		maxWidth: "none",
		maxHeight: "none",
		position: "absolute",
		left: 0,
		top: 0,
		translate: `${panX}px ${panY}px`,
		userSelect: "none",
	};

	return (
		<div
			style={{
				width: "100vw",
				height: "100vh",
				display: "flex",
				flexDirection: "column",
				overflow: "hidden",
				backgroundColor: "#1a1a1a",
			}}
		>
			<div
				ref={containerRef}
				style={containerStyle}
				onMouseDown={handleMouseDown}
				onMouseMove={handleMouseMove}
				onMouseUp={handleMouseUp}
				onMouseLeave={handleMouseUp}
				onDoubleClick={handleDoubleClick}
				onContextMenu={(e) => e.preventDefault()}
			>
				<img
					src={imageUrl}
					alt=""
					style={imageStyle}
					draggable={false}
					onLoad={handleImageLoad}
				/>
			</div>
			<ImageViewerToolbar
				filePath={filePath}
				naturalWidth={naturalWidth}
				naturalHeight={naturalHeight}
				zoom={zoom}
				rotation={rotation}
				onFitToWindow={fitToWindow}
				onOriginalSize={() => {
					// 原始大小（zoom=1），渲染尺寸 = 原始像素尺寸，居中显示
					const container = containerRef.current;
					if (container) {
						const rect = container.getBoundingClientRect();
						setZoom(1);
						setPanX((rect.width - naturalWidth) / 2);
						setPanY((rect.height - naturalHeight) / 2);
					} else {
						setZoom(1);
						setPanX(0);
						setPanY(0);
					}
				}}
				onRotate={() => setRotation((prev) => (prev + 90) % 360)}
				onFlipHorizontal={() => setFlipX((prev) => prev * -1)}
				onFlipVertical={() => setFlipY((prev) => prev * -1)}
			/>
		</div>
	);
};
