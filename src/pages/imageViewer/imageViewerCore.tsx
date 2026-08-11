import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { ImageViewerToolbar } from "./imageViewerToolbar";

interface ImageViewerCoreProps {
	filePath: string;
	totalCount: number;
	currentIndex: number;
	onPrev: () => void;
	onNext: () => void;
	hasPrev: boolean;
	hasNext: boolean;
}

interface ImageViewerWindowState {
	width: number;
	height: number;
	x?: number;
	y?: number;
	maximized?: boolean;
}

interface ViewTransform {
	zoom: number;
	panX: number;
	panY: number;
}

interface ThumbLevel {
	canvas: HTMLCanvasElement;
	width: number;
}

/** 首屏快速生成的缩略图最大宽度，足够 fit-to-window */
const INITIAL_LEVEL_DIMS = [1024, 2048];
/** 后台生成的高级缩略图。8192 为最大级别，平衡内存（~270MB）与缩放性能 */
const DEFERRED_LEVEL_DIMS = [4096, 8192];

/** 从原图生成一张缩略图 canvas */
function makeThumbCanvas(
	source: HTMLImageElement | HTMLCanvasElement,
	tw: number,
	th: number,
): HTMLCanvasElement {
	const c = document.createElement("canvas");
	c.width = tw;
	c.height = th;
	c.getContext("2d")?.drawImage(source, 0, 0, tw, th);
	return c;
}

/** 首屏快速生成：只生成 [1024, 2048] 两级，足够 fit-to-window，~1s 完成 */
function buildInitialLevels(img: HTMLImageElement): ThumbLevel[] {
	const levels: ThumbLevel[] = [];
	const fullMaxDim = Math.max(img.naturalWidth, img.naturalHeight);
	for (const maxDim of INITIAL_LEVEL_DIMS) {
		if (maxDim >= fullMaxDim) break;
		const scale = maxDim / fullMaxDim;
		const tw = Math.round(img.naturalWidth * scale);
		const th = Math.round(img.naturalHeight * scale);
		levels.push({ canvas: makeThumbCanvas(img, tw, th), width: tw });
	}
	return levels;
}

/** 后台生成高级别缩略图：全部从原图直接生成，保证最高质量。
 * 每级 ~1-1.5s，共 ~3s。8192 为上限，平衡 GPU 内存（~270MB）与缩放性能 */
function buildDeferredLevels(img: HTMLImageElement): ThumbLevel[] {
	const levels: ThumbLevel[] = [];
	const fullMaxDim = Math.max(img.naturalWidth, img.naturalHeight);
	for (const maxDim of DEFERRED_LEVEL_DIMS) {
		if (maxDim >= fullMaxDim) break;
		const scale = maxDim / fullMaxDim;
		const tw = Math.round(img.naturalWidth * scale);
		const th = Math.round(img.naturalHeight * scale);
		levels.push({ canvas: makeThumbCanvas(img, tw, th), width: tw });
	}
	return levels;
}

function renderToCanvas(
	canvas: HTMLCanvasElement,
	img: HTMLImageElement,
	thumbLevels: ThumbLevel[],
	imgW: number,
	imgH: number,
	zoom: number,
	panX: number,
	panY: number,
	rotation: number,
	flipX: number,
	flipY: number,
	isZooming: boolean,
) {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const cw = canvas.width;
	const ch = canvas.height;
	if (cw === 0 || ch === 0) return;
	ctx.clearRect(0, 0, cw, ch);
	ctx.fillStyle = "#1e1e1e";
	ctx.fillRect(0, 0, cw, ch);

	// cw/ch 是设备像素，panX/panY/zoom 是 CSS 像素单位，统一缩放到设备像素
	const dpr = window.devicePixelRatio || 1;
	const panX_dp = panX * dpr;
	const panY_dp = panY * dpr;

	// 缩放交互期间使用低质量平滑，减少 GPU 开销，消除抖动
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = isZooming ? "low" : "high";

	// 多级缩略图金字塔：选最小但 ≥ 显示宽度的级别，避免从 2.7 亿像素原图采样
	const dstW_css = imgW * zoom;
	let srcImg: HTMLImageElement | HTMLCanvasElement = img;
	let srcW = imgW;
	for (const level of thumbLevels) {
		if (level.width >= dstW_css) {
			srcImg = level.canvas;
			srcW = level.width;
			break;
		}
	}
	const srcScale = srcW / imgW;
	const dstW = dstW_css * dpr;
	const dstH = imgH * zoom * dpr;
	const dstX0 = cw / 2 + panX_dp - dstW / 2;
	const dstY0 = ch / 2 + panY_dp - dstH / 2;

	const screenLeft = Math.max(0, dstX0);
	const screenTop = Math.max(0, dstY0);
	const screenRight = Math.min(cw, dstX0 + dstW);
	const screenBottom = Math.min(ch, dstY0 + dstH);
	if (screenLeft >= screenRight || screenTop >= screenBottom) return;

	const sx = ((screenLeft - dstX0) / (zoom * dpr)) * srcScale;
	const sy = ((screenTop - dstY0) / (zoom * dpr)) * srcScale;
	const sw = ((screenRight - screenLeft) / (zoom * dpr)) * srcScale;
	const sh = ((screenBottom - screenTop) / (zoom * dpr)) * srcScale;

	const hasTransform = rotation % 360 !== 0 || flipX !== 1 || flipY !== 1;
	if (hasTransform) {
		ctx.save();
		ctx.translate(cw / 2 + panX_dp, ch / 2 + panY_dp);
		ctx.rotate((rotation * Math.PI) / 180);
		ctx.scale(flipX, flipY);
		// 变换路径：绘制完整源图，中心对齐到变换原点
		const srcH_thumb = Math.round(srcW * (imgH / imgW));
		ctx.drawImage(
			srcImg,
			0,
			0,
			srcW,
			srcH_thumb,
			-dstW / 2,
			-dstH / 2,
			dstW,
			dstH,
		);
		ctx.restore();
		return;
	}

	ctx.drawImage(
		srcImg,
		sx,
		sy,
		sw,
		sh,
		screenLeft,
		screenTop,
		screenRight - screenLeft,
		screenBottom - screenTop,
	);
}

export const ImageViewerCore: React.FC<ImageViewerCoreProps> = ({
	filePath,
	totalCount,
	currentIndex,
	onPrev,
	onNext,
	hasPrev,
	hasNext,
}) => {
	const containerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const imgRef = useRef<HTMLImageElement | null>(null);
	const thumbLevelsRef = useRef<ThumbLevel[]>([]);

	// 合并 zoom/panX/panY 为单一状态，减少 React 重渲染次数
	const [viewTransform, setViewTransform] = useState<ViewTransform>({
		zoom: 1,
		panX: 0,
		panY: 0,
	});
	const [rotation, setRotation] = useState(0);
	const [flipX, setFlipX] = useState(1);
	const [flipY, setFlipY] = useState(1);
	const [imgW, setImgW] = useState(0);
	const [imgH, setImgH] = useState(0);
	const [loading, setLoading] = useState(true);
	const [isDragging, setIsDragging] = useState(false);
	const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
	const [fullscreen, setFullscreen] = useState(false);

	// Refs：供 scheduleRender（稳定回调）读取最新值
	const viewTransformRef = useRef<ViewTransform>(viewTransform);
	const rotationRef = useRef(rotation);
	const flipXRef = useRef(flipX);
	const flipYRef = useRef(flipY);
	const imgWRef = useRef(imgW);
	const imgHRef = useRef(imgH);
	// 是否处于活跃缩放交互中（用于 imageSmoothingQuality 切换）
	const isZoomingRef = useRef(false);
	const zoomTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		viewTransformRef.current = viewTransform;
	}, [viewTransform]);
	useEffect(() => {
		rotationRef.current = rotation;
	}, [rotation]);
	useEffect(() => {
		flipXRef.current = flipX;
	}, [flipX]);
	useEffect(() => {
		flipYRef.current = flipY;
	}, [flipY]);
	useEffect(() => {
		imgWRef.current = imgW;
	}, [imgW]);
	useEffect(() => {
		imgHRef.current = imgH;
	}, [imgH]);

	// 缓存 canvas 像素尺寸，避免每帧调用 getBoundingClientRect() 触发强制重排
	const canvasPixelWRef = useRef(0);
	const canvasPixelHRef = useRef(0);

	const updateCanvasSize = useCallback(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const rect = canvas.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		const w = Math.round(rect.width * dpr);
		const h = Math.round(rect.height * dpr);
		if (canvasPixelWRef.current !== w || canvasPixelHRef.current !== h) {
			canvasPixelWRef.current = w;
			canvasPixelHRef.current = h;
			canvas.width = w;
			canvas.height = h;
		}
	}, []);

	// 图片加载优化：使用 decoding="async" + decode() 将解码移至后台线程，避免阻塞主线程
	useEffect(() => {
		setLoading(true);
		// 重置 canvas 尺寸缓存，新图片可能触发窗口尺寸变化
		canvasPixelWRef.current = 0;
		canvasPixelHRef.current = 0;

		const img = new Image();
		img.decoding = "async";
		let cancelled = false;

		const loadImage = async () => {
			try {
				img.src = convertFileSrc(filePath);
				await img.decode();
				if (cancelled) return;
				imgRef.current = img;
				setImgW(img.naturalWidth);
				setImgH(img.naturalHeight);

				// 首屏快速生成：只生成 [1024, 2048]，~1s 完成即可显示图片
				thumbLevelsRef.current = buildInitialLevels(img);
				setLoading(false);
			} catch (_err) {
				if (cancelled) return;
				// decode() 失败时回退到 onload 方式
				img.onload = () => {
					if (cancelled) return;
					imgRef.current = img;
					setImgW(img.naturalWidth);
					setImgH(img.naturalHeight);
					thumbLevelsRef.current = buildInitialLevels(img);
					setLoading(false);
				};
				img.onerror = () => {
					console.error("[ImageViewer] failed:", filePath);
					setLoading(false);
				};
				img.src = convertFileSrc(filePath);
			}
		};

		loadImage();

		return () => {
			cancelled = true;
			thumbLevelsRef.current = [];
			img.onload = null;
			img.onerror = null;
			img.src = "";
			imgRef.current = null;
		};
	}, [filePath]);

	const scheduleRender = useCallback(() => {
		const canvas = canvasRef.current;
		const img = imgRef.current;
		if (!canvas || !img) return;

		const vt = viewTransformRef.current;
		renderToCanvas(
			canvas,
			img,
			thumbLevelsRef.current,
			imgWRef.current,
			imgHRef.current,
			vt.zoom,
			vt.panX,
			vt.panY,
			rotationRef.current,
			flipXRef.current,
			flipYRef.current,
			isZoomingRef.current,
		);
	}, []);

	// 后台生成高级别缩略图 [4096, 8192]，首屏渲染后异步执行。完成后释放低级别 canvas 回收 GPU 内存
	useEffect(() => {
		if (loading || !imgRef.current) return;
		const initial = thumbLevelsRef.current;
		if (initial.length === 0) return;
		let cancelled = false;

		const timer = setTimeout(() => {
			const img = imgRef.current;
			if (!img || cancelled) return;
			const deferred = buildDeferredLevels(img);
			if (!cancelled && deferred.length > 0) {
				// 释放首屏低级别 canvas（1024/2048），高级别已覆盖其缩放范围
				for (const level of initial) {
					level.canvas.width = 0;
					level.canvas.height = 0;
				}
				thumbLevelsRef.current = [...deferred].sort(
					(a, b) => a.width - b.width,
				);
				requestAnimationFrame(scheduleRender);
			}
		}, 200);

		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [loading, scheduleRender]);

	// 通过 viewTransform 触发渲染（合并为单一状态依赖，减少无效 effect 触发）
	// biome-ignore lint/correctness/useExhaustiveDependencies: scheduleRender reads from refs, state deps are triggers only
	useEffect(() => {
		if (loading) return;
		const id = requestAnimationFrame(scheduleRender);
		return () => cancelAnimationFrame(id);
	}, [viewTransform, rotation, flipX, flipY, loading, scheduleRender]);

	// resize 时重新计算 canvas 尺寸
	useEffect(() => {
		const handler = () => {
			canvasPixelWRef.current = 0;
			canvasPixelHRef.current = 0;
			updateCanvasSize();
			if (!loading) scheduleRender();
		};
		window.addEventListener("resize", handler);
		return () => window.removeEventListener("resize", handler);
	}, [loading, scheduleRender, updateCanvasSize]);

	// 首次渲染时计算 canvas 尺寸
	useEffect(() => {
		if (!loading) {
			updateCanvasSize();
		}
	}, [loading, updateCanvasSize]);

	const fitToWindow = useCallback(() => {
		if (!containerRef.current || imgW === 0 || imgH === 0) return;
		const rect = containerRef.current.getBoundingClientRect();
		const rot = rotationRef.current;
		const ew = rot % 180 !== 0 ? imgH : imgW;
		const eh = rot % 180 !== 0 ? imgW : imgH;
		const newZoom = Math.min(rect.width / ew, rect.height / eh) * 0.95;
		const newTransform: ViewTransform = { zoom: newZoom, panX: 0, panY: 0 };
		viewTransformRef.current = newTransform;
		setViewTransform(newTransform);
	}, [imgW, imgH]);

	useEffect(() => {
		if (imgW > 0 && imgH > 0 && !loading) fitToWindow();
	}, [imgW, imgH, loading, fitToWindow]);

	// 滚轮缩放：rAF 节流，每帧只触发一次 React 状态更新
	const wheelRafRef = useRef(0);
	const wheelStateRef = useRef<ViewTransform>({ zoom: 1, panX: 0, panY: 0 });

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const handler = (e: WheelEvent) => {
			e.preventDefault();
			const c = containerRef.current;
			if (!c) return;
			const r = c.getBoundingClientRect();
			const mx = e.clientX - r.left - r.width / 2;
			const my = e.clientY - r.top - r.height / 2;
			const d = e.deltaY > 0 ? 0.9 : 1.1;

			// 使用 ref 中的最新值进行增量计算（而非 state，避免闭包过期）
			const vt = viewTransformRef.current;
			const pz = vt.zoom;
			const nz = Math.max(0.01, Math.min(50, pz * d));
			if (nz === pz) return;

			const ratio = nz / pz;
			const nextTransform: ViewTransform = {
				zoom: nz,
				panX: vt.panX * ratio - mx * (ratio - 1),
				panY: vt.panY * ratio - my * (ratio - 1),
			};

			// 立即更新 ref，确保后续 wheel 事件和渲染使用最新值
			viewTransformRef.current = nextTransform;
			wheelStateRef.current = nextTransform;

			// 标记为活跃缩放，使用低质量平滑
			isZoomingRef.current = true;
			if (zoomTimeoutRef.current) {
				clearTimeout(zoomTimeoutRef.current);
			}
			zoomTimeoutRef.current = setTimeout(() => {
				isZoomingRef.current = false;
				// 缩放停止后立即重绘一帧，恢复高质量平滑
				scheduleRender();
			}, 200);

			// rAF 节流：每帧最多触发一次 React 状态更新
			if (!wheelRafRef.current) {
				wheelRafRef.current = requestAnimationFrame(() => {
					setViewTransform(wheelStateRef.current);
					wheelRafRef.current = 0;
				});
			}

			// 每帧手动触发渲染（不等 React 状态更新），使用最新 ref 值，消除抖动
			scheduleRender();
		};

		el.addEventListener("wheel", handler, { passive: false });
		return () => {
			el.removeEventListener("wheel", handler);
			if (zoomTimeoutRef.current) {
				clearTimeout(zoomTimeoutRef.current);
			}
		};
	}, [scheduleRender]);

	const handleDoubleClick = useCallback(() => fitToWindow(), [fitToWindow]);

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			if (e.button !== 0) return;
			setIsDragging(true);
			setDragStart({
				x: e.clientX - viewTransform.panX,
				y: e.clientY - viewTransform.panY,
			});
		},
		[viewTransform.panX, viewTransform.panY],
	);

	const handleMouseMove = useCallback(
		(e: React.MouseEvent) => {
			if (!isDragging) return;
			const nx = e.clientX - dragStart.x;
			const ny = e.clientY - dragStart.y;
			viewTransformRef.current = {
				...viewTransformRef.current,
				panX: nx,
				panY: ny,
			};
			setViewTransform((prev) => ({ ...prev, panX: nx, panY: ny }));
		},
		[isDragging, dragStart],
	);

	const handleMouseUp = useCallback(() => setIsDragging(false), []);

	const toggleFullscreen = useCallback(() => {
		const next = !fullscreen;
		setFullscreen(next);
		invoke("toggle_image_viewer_fullscreen", { enter: next });
	}, [fullscreen]);

	useEffect(() => {
		const h = (e: KeyboardEvent) => {
			if (e.key === "F11") {
				e.preventDefault();
				toggleFullscreen();
				return;
			}
			if (e.key === "ArrowLeft" && !e.ctrlKey) {
				if (hasPrev) onPrev();
				return;
			}
			if (e.key === "ArrowRight" && !e.ctrlKey) {
				if (hasNext) onNext();
				return;
			}
			switch (e.key) {
				case "r":
				case "R":
					setRotation((p) => (p + 90) % 360);
					break;
				case "f":
				case "F":
					setFlipX((p) => p * -1);
					break;
				case "g":
				case "G":
					setFlipY((p) => p * -1);
					break;
				case "0": {
					const reset: ViewTransform = { zoom: 1, panX: 0, panY: 0 };
					viewTransformRef.current = reset;
					setViewTransform(reset);
					break;
				}
				case "+":
				case "=": {
					const nz = Math.min(50, viewTransformRef.current.zoom * 1.1);
					const next: ViewTransform = {
						...viewTransformRef.current,
						zoom: nz,
					};
					viewTransformRef.current = next;
					setViewTransform(next);
					break;
				}
				case "-": {
					const nz = Math.max(0.01, viewTransformRef.current.zoom * 0.9);
					const next: ViewTransform = {
						...viewTransformRef.current,
						zoom: nz,
					};
					viewTransformRef.current = next;
					setViewTransform(next);
					break;
				}
				case "ArrowUp":
					setViewTransform((prev) => {
						const next: ViewTransform = {
							...prev,
							panY: prev.panY + 50,
						};
						viewTransformRef.current = next;
						return next;
					});
					break;
				case "ArrowDown":
					setViewTransform((prev) => {
						const next: ViewTransform = {
							...prev,
							panY: prev.panY - 50,
						};
						viewTransformRef.current = next;
						return next;
					});
					break;
				case "Escape":
					getCurrentWindow().close();
					break;
			}
		};
		window.addEventListener("keydown", h);
		return () => window.removeEventListener("keydown", h);
	}, [toggleFullscreen, hasPrev, hasNext, onPrev, onNext]);

	useEffect(() => {
		const win = getCurrentWindow();
		let saving = false;
		const unlisten = win.onCloseRequested(async (event) => {
			if (saving) return;
			event.preventDefault();
			saving = true;
			const maximized = await win.isMaximized();
			invoke("save_image_viewer_window_state", {
				windowState: {
					width: window.innerWidth,
					height: window.innerHeight,
					x: window.screenX,
					y: window.screenY,
					maximized,
				},
			}).finally(() => getCurrentWindow().close());
		});
		return () => {
			unlisten.then((fn) => fn());
		};
	}, []);

	const cs: React.CSSProperties = {
		width: "100%",
		height: "100%",
		overflow: "hidden",
		cursor: isDragging ? "grabbing" : "grab",
		position: "relative",
		backgroundColor: "#1e1e1e",
	};
	const vs: React.CSSProperties = {
		width: "100%",
		height: "100%",
		display: "block",
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
				style={cs}
				onMouseDown={handleMouseDown}
				onMouseMove={handleMouseMove}
				onMouseUp={handleMouseUp}
				onMouseLeave={handleMouseUp}
				onDoubleClick={handleDoubleClick}
				onContextMenu={(e) => e.preventDefault()}
			>
				<canvas ref={canvasRef} style={vs} />
				{loading && (
					<div
						style={{
							position: "absolute",
							inset: 0,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							color: "#888",
							fontSize: 14,
							fontFamily: "system-ui, sans-serif",
						}}
					>
						Loading...
					</div>
				)}
			</div>
			<ImageViewerToolbar
				filePath={filePath}
				naturalWidth={imgW}
				naturalHeight={imgH}
				zoom={viewTransform.zoom}
				rotation={rotation}
				currentIndex={currentIndex}
				totalCount={totalCount}
				hasPrev={hasPrev}
				hasNext={hasNext}
				fullscreen={fullscreen}
				onFitToWindow={fitToWindow}
				onOriginalSize={() => {
					const reset: ViewTransform = { zoom: 1, panX: 0, panY: 0 };
					viewTransformRef.current = reset;
					setViewTransform(reset);
				}}
				onRotate={() => setRotation((p) => (p + 90) % 360)}
				onFlipHorizontal={() => setFlipX((p) => p * -1)}
				onFlipVertical={() => setFlipY((p) => p * -1)}
				onPrev={onPrev}
				onNext={onNext}
				onToggleFullscreen={toggleFullscreen}
			/>
		</div>
	);
};
