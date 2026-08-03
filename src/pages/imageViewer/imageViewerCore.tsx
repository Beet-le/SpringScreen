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
	const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

	// 用 ref 同步最新状态值，供滚轮回调读取
	const zoomRef = useRef(zoom);
	const panXRef = useRef(panX);
	const panYRef = useRef(panY);
	const rotationRef = useRef(rotation);
	useEffect(() => {
		zoomRef.current = zoom;
	}, [zoom]);
	useEffect(() => {
		panXRef.current = panX;
	}, [panX]);
	useEffect(() => {
		panYRef.current = panY;
	}, [panY]);
	useEffect(() => {
		rotationRef.current = rotation;
	}, [rotation]);

	// 适应窗口（居中显示）
	// 旋转 90°/270° 时视觉宽高互换，需据此计算正确的 fitZoom
	const fitToWindow = useCallback(() => {
		if (!containerRef.current || naturalWidth === 0 || naturalHeight === 0)
			return;
		const containerRect = containerRef.current.getBoundingClientRect();

		// 旋转 90°/270° 时视觉宽高互换
		const rot = rotationRef.current;
		const isSwapped = rot % 180 !== 0;
		const effectiveW = isSwapped ? naturalHeight : naturalWidth;
		const effectiveH = isSwapped ? naturalWidth : naturalHeight;

		const scaleX = containerRect.width / effectiveW;
		const scaleY = containerRect.height / effectiveH;
		const fitScale = Math.min(scaleX, scaleY) * 0.95; // 留 5% 边距
		setZoom(fitScale);
		setPanX(0);
		setPanY(0);
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

	// 鼠标滚轮缩放（以鼠标位置为中心）- 使用原生事件监听以支持 passive: false
	// 参考 voidImageViewer _viv_do_mousewheel_action：
	//   old_cursor_px = cursor - render_left  →  new_cursor = old_cursor * rw_new / rw_old
	//   等比映射到 CSS 模型：pan_new = pan * ratio - mouse_from_center * (ratio - 1)
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const handler = (e: WheelEvent) => {
			e.preventDefault();
			const container = containerRef.current;
			if (!container) return;
			const rect = container.getBoundingClientRect();
			// 鼠标相对于容器中心的偏移
			const mouseX = e.clientX - rect.left - rect.width / 2;
			const mouseY = e.clientY - rect.top - rect.height / 2;
			const delta = e.deltaY > 0 ? 0.9 : 1.1;
			const prevZoom = zoomRef.current;
			const newZoom = Math.max(0.1, Math.min(20, prevZoom * delta));
			if (newZoom === prevZoom) return;
			// 立即更新 ref，避免连续滚轮事件读到过期值
			zoomRef.current = newZoom;
			const ratio = newZoom / prevZoom;
			// 保持鼠标下像素不动: pan_new = pan * ratio - mouse * (ratio - 1)
			setPanX((prev) => prev * ratio - mouseX * (ratio - 1));
			setPanY((prev) => prev * ratio - mouseY * (ratio - 1));
			setZoom(newZoom);
		};
		el.addEventListener("wheel", handler, { passive: false });
		return () => el.removeEventListener("wheel", handler);
	}, []);

	// 双击适应窗口
	const handleDoubleClick = useCallback(() => {
		fitToWindow();
	}, [fitToWindow]);

	// 拖拽平移
	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			if (e.button !== 0) return; // 只响应左键
			setIsDragging(true);
			setDragStart({ x: e.clientX - panX, y: e.clientY - panY });
		},
		[panX, panY],
	);

	const handleMouseMove = useCallback(
		(e: React.MouseEvent) => {
			if (!isDragging) return;
			setPanX(e.clientX - dragStart.x);
			setPanY(e.clientY - dragStart.y);
		},
		[isDragging, dragStart],
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
				case "0":
					setZoom(1);
					setPanX(0);
					setPanY(0);
					break;
				case "+":
				case "=":
					setZoom((prev) => Math.min(20, prev * 1.1));
					break;
				case "-":
					setZoom((prev) => Math.max(0.1, prev * 0.9));
					break;
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
	}, []);

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
	const containerStyle: React.CSSProperties = {
		width: "100%",
		height: "100%",
		overflow: "hidden",
		cursor: isDragging ? "grabbing" : "grab",
		position: "relative",
		backgroundColor: "#1e1e1e",
	};

	// 图片样式 — 缩放/旋转/翻转 统一围绕视觉中心（transformOrigin: "center center"）
	// left:50%; top:50% + 负 margin 将图片中心对齐到容器中心，translate 做平移
	// 不使用 CSS transition：pan 需瞬时同步才能保证滚轮以鼠标点为中心缩放
	const imageStyle: React.CSSProperties = {
		transform: `scale(${zoom}) rotate(${rotation}deg) scaleX(${flipX}) scaleY(${flipY})`,
		transformOrigin: "center center",
		maxWidth: "none",
		position: "absolute",
		left: "50%",
		top: "50%",
		marginLeft: naturalWidth > 0 ? `-${naturalWidth / 2}px` : undefined,
		marginTop: naturalHeight > 0 ? `-${naturalHeight / 2}px` : undefined,
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
				backgroundColor: "#1e1e1e",
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
					setZoom(1);
					setPanX(0);
					setPanY(0);
				}}
				onRotate={() => setRotation((prev) => (prev + 90) % 360)}
				onFlipHorizontal={() => setFlipX((prev) => prev * -1)}
				onFlipVertical={() => setFlipY((prev) => prev * -1)}
			/>
		</div>
	);
};
