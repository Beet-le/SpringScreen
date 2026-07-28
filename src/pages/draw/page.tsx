"use client";

import type { NonDeletedExcalidrawElement } from "@mg-chao/excalidraw/element/types";
import {
	type Window as AppWindow,
	getCurrentWindow,
} from "@tauri-apps/api/window";
import { debounce } from "es-toolkit";
import Flatbush from "flatbush";
import React, {
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { getMousePosition } from "@/commands";
import {
	createFixedContentWindow,
	getMonitorsBoundingBox,
	setCurrentWindowAlwaysOnTop,
	trimProcessWorkingSet,
} from "@/commands/core";
import { setCaptureState } from "@/commands/globalSate";
import { listenKeyStart, listenKeyStop } from "@/commands/listenKey";
import { captureAllMonitors, switchAlwaysOnTop } from "@/commands/screenshot";
import {
	scrollScreenshotClear,
	scrollScreenshotGetImageData,
	scrollScreenshotGetSize,
	scrollScreenshotSaveToClipboard,
	scrollScreenshotSaveToFile,
} from "@/commands/scrollScreenshot";
import {
	HistoryContext,
	withCanvasHistory,
} from "@/components/drawCore/components/historyContext";
import {
	DrawStatePublisher,
	ExcalidrawEventPublisher,
	ExcalidrawOnHandleEraserPublisher,
} from "@/components/drawCore/extra";
import { EventListenerContext } from "@/components/eventListener";
import { ImageLayer, type ImageLayerActionType } from "@/components/imageLayer";
import { TextScaleFactorContextProvider } from "@/components/textScaleFactorContextProvider";
import { AntdContext } from "@/contexts/antdContext";
import {
	AppSettingsActionContext,
	AppSettingsPublisher,
} from "@/contexts/appSettingsActionContext";
import {
	executeScreenshot as executeScreenshotFunc,
	releaseDrawPage,
} from "@/functions/screenshot";
import { sendErrorMessage } from "@/functions/sendMessage";
import { withStatePublisher } from "@/hooks/useStatePublisher";
import { useStateSubscriber } from "@/hooks/useStateSubscriber";
import { AppSettingsGroup, DoubleClickAction } from "@/types/appSettings";
import {
	type ElementRect,
	type ImageBuffer,
	ImageBufferType,
	ImageEncoder,
} from "@/types/commands/screenshot";
import { DrawState } from "@/types/draw";
import { getCorrectHdrColorAlgorithm } from "@/utils/appSettings";
import {
	type CaptureHistoryItem,
	CaptureHistorySource,
} from "@/utils/appStore";
import {
	writeFilePathToClipboard,
	writeHtmlToClipboard,
	writeTextToClipboard,
} from "@/utils/clipboard";
import {
	getImageFormat,
	getImagePathFromSettings,
	showImageDialog,
} from "@/utils/file";
import { appDebug, appError, appWarn } from "@/utils/log";
import { MousePosition } from "@/utils/mousePosition";
import { ScreenshotType } from "@/utils/types";
import { setWindowRect, showWindow as showCurrentWindow } from "@/utils/window";
import { zIndexs } from "@/utils/zIndex";
import {
	type FixedContentActionType,
	FixedContentCore,
} from "../fixedContent/components/fixedContentCore";
import {
	covertOcrResultToText,
	OcrResultType,
} from "../fixedContent/components/ocrResult";
import { getOcrResultIframeSrcDoc } from "../fixedContent/components/ocrResult/extra";
import {
	DrawContext as CommonDrawContext,
	type DrawContextType as CommonDrawContextType,
} from "../fullScreenDraw/extra";
import {
	copyToClipboard,
	fixedToScreen,
	getCanvas,
	handleOcrDetect,
	saveCanvasToCloud,
	saveToFile,
} from "./actions";
import {
	type CaptureHistoryActionType,
	CaptureHistoryController,
} from "./components/captureHistory";
import {
	ColorPicker,
	type ColorPickerActionType,
} from "./components/colorPicker";
import { DrawLayer } from "./components/drawLayer";
import type { DrawLayerActionType } from "./components/drawLayer/extra";
import {
	DrawToolbar,
	type DrawToolbarActionType,
	DrawToolbarStatePublisher,
} from "./components/drawToolbar";
import { EnableKeyEventPublisher } from "./components/drawToolbar/components/keyEventWrap/extra";
import { isOcrTool } from "./components/drawToolbar/components/tools/ocrTool";
import { ScanQrcodeTool } from "./components/drawToolbar/components/tools/scanQrcodeTool";
import {
	OcrBlocks,
	type OcrBlocksActionType,
	type OcrBlocksSelectedText,
} from "./components/ocrBlocks";
import SelectLayer, {
	type SelectLayerActionType,
} from "./components/selectLayer";
import StatusBar from "./components/statusBar";
import {
	CaptureBoundingBoxInfo,
	CaptureEvent,
	CaptureEventPublisher,
	CaptureLoadingPublisher,
	CaptureStepPublisher,
	DrawEventPublisher,
	ElementDraggingPublisher,
	ScreenshotTypePublisher,
	switchLayer,
} from "./extra";
import styles from "./page.module.css";
import {
	getImageBufferFromSharedBuffer,
	type ImageSharedBufferData,
} from "./tools";
import {
	CanvasLayer,
	CaptureStep,
	DrawContext,
	type DrawContextType,
} from "./types";

// ============================================================
// Draw 页面状态机
//
// 状态说明：
//   Init        - 初始化状态：页面刚加载，PixiJS 画布尚未就绪
//   Active      - 激活状态：画布就绪，可接收截图事件（keep-alive 下的待机状态）
//   WaitRelease - 等待释放：用户完成截图操作后，等待 3s 延迟释放 GPU 资源
//   Release     - 释放状态：窗口被隐藏后等待重新激活
//
// 状态流转：
//   Init → Active (onInitCanvasReady) → WaitRelease (finishCapture)
//   → Active (releasePage: keep-alive 复用)
//
// keep-alive 策略：
//   截图完成后不销毁 draw 窗口，而是保持在 Active 状态等待下次截图。
//   3s 后释放 PixiJS GPU 资源（WebGL 纹理），但保留 V8 JS 代码缓存，
//   下次截图重新初始化 PixiJS 仅需 ~50-100ms。
// ============================================================
enum DrawPageState {
	/** 初始化状态：页面刚加载，PixiJS 画布尚未就绪 */
	Init = "init",
	/** 激活状态：画布就绪，可接收截图事件 */
	Active = "active",
	/** 等待释放状态：截图完成，等待延迟释放 GPU 资源 */
	WaitRelease = "wait-release",
	/** 释放状态：窗口隐藏，等待重新激活 */
	Release = "release",
}

const DrawPageCore: React.FC<{
	getFixedContentAction: () => FixedContentActionType | undefined;
	onFixedContentLoad: () => void;
	showFixedContent: () => void;
}> = ({ getFixedContentAction, onFixedContentLoad, showFixedContent }) => {
	const { message } = useContext(AntdContext);
	const intl = useIntl();

	const appWindowRef = useRef<AppWindow>(undefined as unknown as AppWindow);
	useEffect(() => {
		appWindowRef.current = getCurrentWindow();
	}, []);

	// 截图原始数据
	const imageBufferRef = useRef<
		ImageBuffer | ImageSharedBufferData | undefined
	>(undefined);
	const captureBoundingBoxInfoRef = useRef<CaptureBoundingBoxInfo | undefined>(
		undefined,
	);
	const imageBlobUrlRef = useRef<string | undefined>(undefined);
	const { addListener, removeListener } = useContext(EventListenerContext);

	// 层级
	const drawLayerWrapRef = useRef<HTMLDivElement>(null);
	const layerContainerRef = useRef<HTMLDivElement>(null);
	const imageLayerActionRef = useRef<ImageLayerActionType | undefined>(
		undefined,
	);
	const drawLayerActionRef = useRef<DrawLayerActionType | undefined>(undefined);
	const selectLayerActionRef = useRef<SelectLayerActionType | undefined>(
		undefined,
	);
	const drawToolbarActionRef = useRef<DrawToolbarActionType | undefined>(
		undefined,
	);
	const colorPickerActionRef = useRef<ColorPickerActionType | undefined>(
		undefined,
	);
	const captureHistoryActionRef = useRef<CaptureHistoryActionType | undefined>(
		undefined,
	);
	const ocrBlocksActionRef = useRef<OcrBlocksActionType | undefined>(undefined);

	// ============================================================
	// 状态引用（useRef 确保状态在闭包中始终是最新值，避免闭包陷阱）
	// ============================================================

	// 页面状态机当前状态
	const drawPageStateRef = useRef<DrawPageState>(DrawPageState.Init);
	// Init 态暂存的截图事件：当画布未就绪时收到截图请求，暂存后等 onInitCanvasReady 自动执行
	const pendingScreenshotRef = useRef<{
		type: ScreenshotType;
		payload: { windowLabel?: string; captureHistoryId?: string };
	} | null>(null);
	// keep-alive 待机时 PixiJS GPU 资源是否已释放
	const canvasDisposedRef = useRef(false);
	const mousePositionRef = useRef<MousePosition>(new MousePosition(0, 0));
	const [getAppSettings] = useStateSubscriber(AppSettingsPublisher, undefined);
	const { updateAppSettings } = useContext(AppSettingsActionContext);
	const [getScreenshotType, setScreenshotType, resetScreenshotType] =
		useStateSubscriber(ScreenshotTypePublisher, undefined);
	const [getCaptureStep, setCaptureStep, resetCaptureStep] = useStateSubscriber(
		CaptureStepPublisher,
		undefined,
	);
	const [getDrawState, , resetDrawState] = useStateSubscriber(
		DrawStatePublisher,
		useCallback((drawState: DrawState) => {
			if (drawState === DrawState.Text || drawState === DrawState.Watermark) {
				setCurrentWindowAlwaysOnTop(true);
			} else {
				setCurrentWindowAlwaysOnTop(false);
			}
		}, []),
	);
	const [, setCaptureLoading] = useStateSubscriber(
		CaptureLoadingPublisher,
		undefined,
	);
	const [getCaptureEvent, setCaptureEvent] = useStateSubscriber(
		CaptureEventPublisher,
		undefined,
	);
	const onCaptureLoad = useCallback<ImageLayerActionType["onCaptureLoad"]>(
		async (
			imageSrc: string | undefined,
			imageBuffer: ImageBuffer | ImageSharedBufferData | undefined,
			captureBoundingBoxInfo: CaptureBoundingBoxInfo,
		) => {
			await Promise.all([
				imageLayerActionRef.current?.onCaptureLoad(
					imageSrc,
					imageBuffer,
					captureBoundingBoxInfo,
				),
			]);

			setCaptureEvent({
				event: CaptureEvent.onCaptureLoad,
				params: [imageSrc, imageBuffer, captureBoundingBoxInfo],
			});

			if (getScreenshotType()?.type === ScreenshotType.SwitchCaptureHistory) {
				const captureHistoryId = getScreenshotType().params.captureHistoryId;
				if (captureHistoryId) {
					await captureHistoryActionRef.current?.switch(captureHistoryId);
				} else {
					appWarn("[DrawPageCore] Capture history id is not found");
				}
			}
		},
		[getScreenshotType, setCaptureEvent],
	);
	const capturingRef = useRef(false);
	// 标记当前窗口是否已进入 fixedContent 模式（已固定到屏幕）
	// 使用 ref 避免闭包陈旧值问题，确保事件监听器中能读到最新状态
	const isFixedRef = useRef(false);
	const circleCursorRef = useRef<HTMLDivElement>(null);

	const { history } = useContext(HistoryContext);

	const handleLayerSwitch = useCallback((layer: CanvasLayer) => {
		switchLayer(
			layer,
			imageLayerActionRef.current,
			selectLayerActionRef.current,
		);
	}, []);
	const onCaptureStepDrawStateChange = useCallback(() => {
		const captureStep = getCaptureStep();
		const drawState = getDrawState();

		if (captureStep === CaptureStep.Select) {
			handleLayerSwitch(CanvasLayer.Select);
			return;
		} else if (captureStep === CaptureStep.Draw) {
			if (drawState === DrawState.Idle) {
				handleLayerSwitch(CanvasLayer.Select);
				return;
			}

			handleLayerSwitch(CanvasLayer.Draw);
			return;
		}

		handleLayerSwitch(CanvasLayer.Select);
	}, [getCaptureStep, getDrawState, handleLayerSwitch]);
	const onCaptureStepDrawStateChangeDebounce = useMemo(() => {
		return debounce(onCaptureStepDrawStateChange, 0);
	}, [onCaptureStepDrawStateChange]);
	useStateSubscriber(
		CaptureStepPublisher,
		onCaptureStepDrawStateChangeDebounce,
	);
	useStateSubscriber(
		DrawStatePublisher,
		useCallback(
			(drawState: DrawState) => {
				onCaptureStepDrawStateChangeDebounce();

				if (!drawLayerWrapRef.current) {
					return;
				}

				if (drawState === DrawState.ScrollScreenshot) {
					drawLayerWrapRef.current.style.opacity = "0";
				} else {
					drawLayerWrapRef.current.style.opacity = "1";
				}
			},
			[onCaptureStepDrawStateChangeDebounce],
		),
	);

	/** 截图准备 */
	const readyCapture = useCallback(
		async (
			imageBuffer: ImageBuffer | ImageSharedBufferData | undefined,
			captureBoundingBoxInfo: CaptureBoundingBoxInfo,
		) => {
			setCaptureLoading(true);

			if (imageBlobUrlRef.current) {
				const tempUrl = imageBlobUrlRef.current;
				// 延迟释放 URL，提速
				setTimeout(() => {
					URL.revokeObjectURL(tempUrl);
				}, 0);
			}

			imageBlobUrlRef.current =
				imageBuffer && "data" in imageBuffer
					? URL.createObjectURL(new Blob([imageBuffer.data]))
					: undefined;

			setCaptureEvent({
				event: CaptureEvent.onCaptureImageBufferReady,
				params: {
					imageBuffer,
				},
			});

			mousePositionRef.current = new MousePosition(
				Math.floor(
					captureBoundingBoxInfo.mousePosition.mouseX / window.devicePixelRatio,
				),
				Math.floor(
					captureBoundingBoxInfo.mousePosition.mouseY / window.devicePixelRatio,
				),
			);

			await Promise.all([
				imageLayerActionRef.current?.onCaptureReady(
					imageBlobUrlRef.current,
					imageBuffer,
				),
				drawLayerActionRef.current?.onCaptureReady(),
			]);

			setCaptureEvent({
				event: CaptureEvent.onCaptureReady,
				params: [imageBlobUrlRef.current, imageBuffer],
			});
			setCaptureLoading(false);

			onCaptureLoad(
				imageBlobUrlRef.current,
				imageBuffer,
				captureBoundingBoxInfo,
			);
		},
		[onCaptureLoad, setCaptureLoading, setCaptureEvent],
	);

	/** 显示截图窗口 */
	const showWindow = useCallback(
		async ({ min_x, min_y, max_x, max_y }: ElementRect) => {
			const appWindow = appWindowRef.current;

			// 恢复 setAlwaysOnTop(true)：确保截图覆盖层在所有置顶窗口（如置顶记事本、视频播放器等）之上
			// 最终状态会设为 false，但显示窗口时必须先置顶，否则截图覆盖层可能被其他置顶窗口遮挡
			await Promise.all([
				setWindowRect(appWindow, { min_x, min_y, max_x, max_y }),
				appWindow.setAlwaysOnTop(true),
			]);

			if (layerContainerRef.current) {
				const documentWidth = (max_x - min_x) / window.devicePixelRatio;
				const documentHeight = (max_y - min_y) / window.devicePixelRatio;

				layerContainerRef.current.style.width = `${documentWidth}px`;
				layerContainerRef.current.style.height = `${documentHeight}px`;
			}

			// showCurrentWindow 内部已调用 setFocus()，无需再额外调用
			await showCurrentWindow();

			// 最终状态：取消置顶（开发模式下额外处理已移除，直接统一设置 false）
			setCurrentWindowAlwaysOnTop(false);

			// 监听键盘
			listenKeyStart().catch((error) => {
				appError("[DrawPageCore] listenKeyStart error", error);
			});

			// 性能优化：移除冗余的 appWindow.setFocus() 调用，
			// showCurrentWindow() 内部已调用 setFocus()，无需重复
		},
		[],
	);

	const hideWindow = useCallback(async () => {
		await appWindowRef.current.hide();
		// await Promise.all([
		// 	appWindowRef.current.show(),
		// 	appWindowRef.current.setSize(new PhysicalSize(100, 100)),
		// ]);
	}, []);

	// ============================================================
	// keep-alive 释放页面：截图完成后不关闭窗口，延迟 3s 释放 GPU 资源后回到待机状态
	//
	// 策略：
	//   1. 保持 draw 窗口存活（不销毁 WebView2），下次截图从 Active 状态直接复用
	//   2. 释放 PixiJS GPU 资源（WebGL 上下文、纹理），减少内存占用
	//   3. 调用 trimProcessWorkingSet 回收物理内存（Windows 下通知 OS 裁剪工作集）
	//   4. 下次截图时 PixiJS 重新初始化仅需 ~50-100ms
	// ============================================================
	const releasePage = useMemo(() => {
		return debounce(async () => {
			if (drawPageStateRef.current !== DrawPageState.WaitRelease) {
				return;
			}

			// keep-alive: 直接回到 Active 状态，复用现有 draw 窗口
			drawPageStateRef.current = DrawPageState.Active;

			// 释放 PixiJS GPU 资源（WebGL 上下文、纹理），减少后台内存占用
			// PixiJS 代码已在 V8 中缓存，下次截图时重新初始化仅需 ~50-100ms
			// 3s 足够判断用户是否已退出编辑，避免长时间占据 GPU 内存
			await imageLayerActionRef.current?.disposeCanvas();
			canvasDisposedRef.current = true;

			// GPU 资源已释放，主动裁剪进程树工作集回收物理内存（仅 Windows 生效）
			// 不冻结进程，不影响 --open-draw 秒唤起
			trimProcessWorkingSet().catch((error) => {
				appError("[DrawPageCore] trimProcessWorkingSet error", error);
			});

			appDebug(
				"[screenshot-perf] releasePage debounce fired, state reset to Active (keep-alive), GPU resources disposed",
			);
		}, 1000 * 3);
	}, []);

	// 防止快速截图的情况下延迟设置 setCaptureState 后覆盖正确的值
	const setCaptureStateActionTimerRef = useRef<NodeJS.Timeout | undefined>(
		undefined,
	);
	const setCaptureStateAction = useCallback(async (capturing: boolean) => {
		if (setCaptureStateActionTimerRef.current) {
			clearTimeout(setCaptureStateActionTimerRef.current);
			setCaptureStateActionTimerRef.current = undefined;
		}

		if (capturing) {
			setCaptureState(capturing);
		} else {
			setCaptureStateActionTimerRef.current = setTimeout(() => {
				setCaptureState(capturing);
				setCaptureStateActionTimerRef.current = undefined;
			}, 256);
		}
	}, []);

	const finishCapture = useCallback<DrawContextType["finishCapture"]>(
		async (clearScrollScreenshot: boolean = true) => {
			// 停止监听键盘
			listenKeyStop().catch((error) => {
				appError("[DrawPageCore] listenKeyStop error", error);
			});

			// 快速隐藏窗口
			appWindowRef.current.setIgnoreCursorEvents(true);
			if (layerContainerRef.current) {
				layerContainerRef.current.style.opacity = "0";
			}

			drawPageStateRef.current = DrawPageState.WaitRelease;
			releasePage();

			if (clearScrollScreenshot) {
				scrollScreenshotClear();
			}

			window.getSelection()?.removeAllRanges();
			await Promise.all([
				imageLayerActionRef.current?.onCaptureFinish(),
				selectLayerActionRef.current?.onCaptureFinish(),
				drawLayerActionRef.current?.onCaptureFinish(),
			]);

			setCaptureEvent({
				event: CaptureEvent.onCaptureFinish,
			});
			imageBufferRef.current = undefined;
			// 立即释放 Blob URL，避免大块截图数据长时间占据内存
			if (imageBlobUrlRef.current) {
				URL.revokeObjectURL(imageBlobUrlRef.current);
				imageBlobUrlRef.current = undefined;
			}
			pendingScreenshotRef.current = null;
			resetCaptureStep();
			resetDrawState();
			resetScreenshotType();
			drawToolbarActionRef.current?.setEnable(false);
			capturingRef.current = false;
			setCaptureStateAction(false);
			history.clear();

			// 等待 1 帧，确保截图窗口内的元素均隐藏完成
			setTimeout(() => {
				hideWindow();
			}, 17);
		},
		[
			hideWindow,
			history,
			releasePage,
			resetCaptureStep,
			resetDrawState,
			resetScreenshotType,
			setCaptureEvent,
			setCaptureStateAction,
		],
	);

	const initCaptureBoundingBoxInfoAndShowWindow = useCallback(async () => {
		// 如果窗口已进入 fixedContent 模式，阻止后续截图流程重新显示此窗口
		if (isFixedRef.current) return;

		// 恢复窗口
		appWindowRef.current.setIgnoreCursorEvents(false);
		if (layerContainerRef.current) {
			layerContainerRef.current.style.opacity = "1";
		}

		// 获取显示器边界框和鼠标位置（并行 IPC 调用）
		const [captureBoundingBox, mousePosition] = await Promise.all([
			getMonitorsBoundingBox(
				undefined,
				getAppSettings()[AppSettingsGroup.SystemScreenshot]
					.enableMultipleMonitor,
			),
			getMousePosition().catch((error) => {
				appError("[DrawPageCore] getMousePosition error", error);
				message.error(<FormattedMessage id="draw.getMousePositionError" />);
				return [0, 0];
			}),
		]);

		// 性能优化：IPC 返回 rect 后立即启动 showWindow（fire-and-forget），
		// 让窗口显示与下方 R-tree 构建、CaptureBoundingBoxInfo 创建并行执行，
		// 避免 showWindow 被同步计算阻塞，加快截图窗口可见显示速度
		const showWindowPromise =
			getScreenshotType()?.type === ScreenshotType.Delay
				? Promise.resolve()
				: showWindow(captureBoundingBox.rect);

		// 构建 R-tree 空间索引（同步计算，会阻塞主线程）
		const rTree = new Flatbush(captureBoundingBox.monitor_rect_list.length);
		captureBoundingBox.monitor_rect_list.forEach(({ rect }) => {
			rTree.add(rect.min_x, rect.min_y, rect.max_x, rect.max_y);
		});
		rTree.finish();

		captureBoundingBoxInfoRef.current = new CaptureBoundingBoxInfo(
			captureBoundingBox.rect,
			captureBoundingBox.monitor_rect_list,
			new MousePosition(mousePosition[0], mousePosition[1]),
		);

		// keep-alive: 如果 GPU 资源已在待机时释放，重新初始化 PixiJS
		if (canvasDisposedRef.current) {
			const t_reinit = performance.now();
			await imageLayerActionRef.current?.initCanvas(true);
			canvasDisposedRef.current = false;
			appDebug(
				`[screenshot-perf] PixiJS re-init after dispose: ${(performance.now() - t_reinit).toFixed(1)}ms`,
			);
		}

		// 等待 showWindow 完成（可能已在 R-tree 构建期间完成），
		// 然后并行执行 selectLayer 和 imageLayer 的回调
		await Promise.all([
			showWindowPromise,
			captureBoundingBoxInfoRef.current
				? selectLayerActionRef.current?.onCaptureBoundingBoxInfoReady(
						captureBoundingBoxInfoRef.current,
					)
				: undefined,
			imageLayerActionRef.current?.onCaptureBoundingBoxInfoReady(
				captureBoundingBoxInfoRef.current.width,
				captureBoundingBoxInfoRef.current.height,
			),
		]);
	}, [getAppSettings, getScreenshotType, message, showWindow]);

	const captureAllMonitorsAction = useCallback(
		async (
			excuteScreenshotType: ScreenshotType,
		): Promise<ImageBuffer | ImageSharedBufferData | undefined> => {
			if (excuteScreenshotType === ScreenshotType.SwitchCaptureHistory) {
				return undefined;
			}

			if (excuteScreenshotType === ScreenshotType.Delay) {
				await new Promise((resolve) => {
					setTimeout(() => {
						resolve(undefined);
					}, 1000 *
						getAppSettings()[AppSettingsGroup.Cache].delayScreenshotSeconds);
				});
			}

			const imageBufferFromSharedBufferPromise = getImageBufferFromSharedBuffer(
				"screenshot",
				true,
			);

			let result: ImageBuffer | ImageSharedBufferData | undefined =
				await captureAllMonitors(
					getAppSettings()[AppSettingsGroup.SystemScreenshot]
						.enableMultipleMonitor,
					getCorrectHdrColorAlgorithm(getAppSettings(), true),
					getAppSettings()[AppSettingsGroup.SystemScreenshot]
						.correctColorFilter,
				).catch((error) => {
					appError("[DrawPageCore] captureAllMonitors error", error);
					return undefined;
				});

			if (
				result &&
				"bufferType" in result &&
				result.bufferType === ImageBufferType.SharedBuffer
			) {
				result = await imageBufferFromSharedBufferPromise;
			}

			if (
				excuteScreenshotType === ScreenshotType.Delay &&
				captureBoundingBoxInfoRef.current
			) {
				showWindow(captureBoundingBoxInfoRef.current.rect);
			}

			return result;
		},
		[getAppSettings, showWindow],
	);

	// ============================================================
	// 执行截图核心流程
	//
	// 流程步骤：
	// 1. 设置截图状态（capturing = true）并禁用工具栏
	// 2. 并行执行：截图捕获 + 边界框计算 + 层级准备
	// 3. 等待截图结果和边界框就绪
	// 4. 将截图数据渲染到各层级（ImageLayer、SelectLayer、DrawLayer）
	// 5. 性能打点记录各阶段耗时
	// ============================================================
	/** 执行截图 */
	const excuteScreenshot = useCallback(
		async (
			excuteScreenshotType: ScreenshotType,
			params: { windowId?: string; captureHistoryId?: string },
		) => {
			const t_exec = performance.now();
			appDebug(
				`[screenshot-perf] excuteScreenshot start, type=${excuteScreenshotType}`,
			);

			capturingRef.current = true;
			setCaptureStateAction(true);
			drawToolbarActionRef.current?.setEnable(false);

			// 并行启动截图捕获和边界框计算
			const captureAllMonitorsPromise =
				captureAllMonitorsAction(excuteScreenshotType);
			const initCaptureBoundingBoxInfoPromise =
				initCaptureBoundingBoxInfoAndShowWindow();

			setScreenshotType({
				type: excuteScreenshotType,
				params,
			});

			const layerOnExecuteScreenshotPromise = Promise.all([
				imageLayerActionRef.current?.onExecuteScreenshot(),
				selectLayerActionRef.current?.onExecuteScreenshot(),
			]);
			setCaptureEvent({
				event: CaptureEvent.onExecuteScreenshot,
			});

			let imageBuffer: ImageBuffer | ImageSharedBufferData | undefined;
			try {
				imageBuffer = await captureAllMonitorsPromise;
			} catch {
				imageBuffer = undefined;
			}
			const t_capture = performance.now();
			appDebug(
				`[screenshot-perf] captureAllMonitors done: ${(t_capture - t_exec).toFixed(1)}ms`,
			);

			await initCaptureBoundingBoxInfoPromise;
			const t_bbox = performance.now();
			appDebug(
				`[screenshot-perf] initBoundingBox done: ${(t_bbox - t_capture).toFixed(1)}ms`,
			);

			// 如果截图失败且不是切换截图历史，提示错误并结束
			if (
				!imageBuffer &&
				excuteScreenshotType !== ScreenshotType.SwitchCaptureHistory
			) {
				sendErrorMessage(intl.formatMessage({ id: "draw.captureError" }));

				finishCapture();
				return;
			}

			imageBufferRef.current = imageBuffer;

			// 防止用户在截图过程中提前退出
			if (getCaptureEvent()?.event !== CaptureEvent.onExecuteScreenshot) {
				return;
			}

			try {
				// 将截图数据渲染到各层级（imageLayer、selectLayer、drawLayer）
				await Promise.all([
					captureBoundingBoxInfoRef.current
						? readyCapture(
								imageBufferRef.current,
								captureBoundingBoxInfoRef.current,
							)
						: (() => {
								appWarn(
									"[DrawPageCore] Capture bounding box info is not ready",
								);
								return Promise.resolve();
							})(),
					layerOnExecuteScreenshotPromise,
				]);
				const t_ready = performance.now();
				appDebug(
					`[screenshot-perf] readyCapture+layers done: ${(t_ready - t_bbox).toFixed(1)}ms, total: ${(t_ready - t_exec).toFixed(1)}ms`,
				);
			} catch (error) {
				// 防止用户提前退出报错
				if (getCaptureEvent()?.event !== CaptureEvent.onExecuteScreenshot) {
					return;
				}

				throw error;
			}
		},
		[
			initCaptureBoundingBoxInfoAndShowWindow,
			captureAllMonitorsAction,
			setScreenshotType,
			setCaptureEvent,
			getCaptureEvent,
			intl,
			finishCapture,
			readyCapture,
			setCaptureStateAction,
		],
	);

	const saveCaptureHistory = useCallback(
		async (
			captureResult: ArrayBuffer | HTMLCanvasElement | undefined,
			source: CaptureHistorySource | undefined,
		) => {
			if (!captureHistoryActionRef.current) {
				return;
			}

			const screenshotType = getScreenshotType()?.type;
			const captureHistoryIndex =
				captureHistoryActionRef.current.getCurrentIndex();
			const selectRect = selectLayerActionRef.current?.getSelectRect();
			const excalidrawApi = drawLayerActionRef.current?.getExcalidrawAPI();
			const excalidrawElements = excalidrawApi?.getSceneElements();
			const appState = excalidrawApi?.getAppState();

			let imageBuffer: ImageBuffer | CaptureHistoryItem | undefined;
			if (imageBufferRef.current && "sharedBuffer" in imageBufferRef.current) {
				// 截图的图像数据已经被 transfer 到了 worker，无法在此访问
				// 所以直接从 ImageLayer 渲染出 PNG 数据
				const pngBuffer =
					await imageLayerActionRef.current?.renderImageSharedBufferToPng();
				if (pngBuffer) {
					imageBuffer = {
						encoder: ImageEncoder.Png,
						data: undefined as unknown as Blob,
						bufferType: ImageBufferType.Pixels,
						buffer: pngBuffer,
					};
				}
			} else if (screenshotType === ScreenshotType.SwitchCaptureHistory) {
				imageBuffer =
					captureHistoryActionRef.current.getCurrentCaptureHistoryItem();
			} else {
				imageBuffer = imageBufferRef.current;
			}

			if (!imageBuffer) {
				appError(
					"[DrawPageCore] saveCaptureHistory error, invalid imageBuffer",
					{
						screenshotType,
					},
				);
				return;
			}

			updateAppSettings(
				AppSettingsGroup.Cache,
				{
					prevSelectRect: selectRect,
				},
				false,
				true,
				false,
				true,
				false,
			);

			if (
				!getAppSettings()[AppSettingsGroup.SystemScreenshot]
					.recordCaptureHistory
			) {
				return;
			}

			let captureResultImageBuffer: ArrayBuffer | undefined;
			if (captureResult instanceof HTMLCanvasElement) {
				captureResultImageBuffer = await new Promise<ArrayBuffer | undefined>(
					(resolve) => {
						captureResult.toBlob(
							async (blob) => {
								resolve(await blob?.arrayBuffer());
							},
							"image/png",
							1,
						);
					},
				);
			} else if (captureResult instanceof ArrayBuffer) {
				captureResultImageBuffer = captureResult;
			}

			await captureHistoryActionRef.current?.saveCurrentCapture(
				imageBuffer,
				captureHistoryIndex,
				selectRect,
				excalidrawElements,
				appState,
				captureResultImageBuffer,
				source,
			);
		},
		[getAppSettings, updateAppSettings, getScreenshotType],
	);

	const onSave = useCallback(
		async (fastSave: boolean = false) => {
			if (getDrawState() === DrawState.ScrollScreenshot) {
				const scrollScreenshotSize = await scrollScreenshotGetSize();
				if (
					scrollScreenshotSize.top_image_size === 0 &&
					scrollScreenshotSize.bottom_image_size === 0
				) {
					message.error(
						<FormattedMessage id="draw.scrollScreenshotSizeError" />,
					);
					return;
				}

				saveCaptureHistory(
					undefined,
					CaptureHistorySource.ScrollScreenshotSave,
				); // 滚动截图不保存编辑结果

				const imagePath =
					(await getImagePathFromSettings(
						fastSave ? getAppSettings() : undefined,
						"fast",
					)) ?? (await showImageDialog(getAppSettings()));

				if (!imagePath) {
					return;
				}

				if (!fastSave) {
					updateAppSettings(
						AppSettingsGroup.Cache,
						{
							prevImageFormat: imagePath.imageFormat,
						},
						false,
						true,
						false,
						true,
						false,
					);
				}

				scrollScreenshotSaveToFile(imagePath.filePath)
					.catch((error) => {
						appError("[DrawPageCore] scrollScreenshotSaveToFile error", error);
					})
					.then(() => {
						scrollScreenshotClear();
					});
				finishCapture(false);
				return;
			}

			if (
				!selectLayerActionRef.current ||
				!imageLayerActionRef.current ||
				!drawLayerActionRef.current
			) {
				return;
			}

			const imageCanvas = await getCanvas(
				selectLayerActionRef.current.getSelectRectParams(),
				imageLayerActionRef.current,
				drawLayerActionRef.current,
			);

			saveCaptureHistory(
				getAppSettings()[AppSettingsGroup.SystemScreenshot]
					.historySaveEditResult
					? imageCanvas
					: undefined,
				CaptureHistorySource.Save,
			);

			saveToFile(
				getAppSettings(),
				imageCanvas,
				async (filePath: string) => {
					if (!fastSave) {
						updateAppSettings(
							AppSettingsGroup.Cache,
							{
								prevImageFormat: getImageFormat(filePath),
							},
							false,
							true,
							false,
							true,
							false,
						);
					}

					finishCapture();
				},
				getAppSettings()[AppSettingsGroup.Cache].prevImageFormat,
				fastSave
					? await getImagePathFromSettings(getAppSettings(), "fast")
					: undefined,
			);
		},
		[
			finishCapture,
			getAppSettings,
			getDrawState,
			saveCaptureHistory,
			updateAppSettings,
			message,
		],
	);

	const onSaveToCloud = useCallback(async () => {
		if (!getAppSettings()[AppSettingsGroup.FunctionScreenshot].saveToCloud) {
			return;
		}

		if (
			!selectLayerActionRef.current ||
			!imageLayerActionRef.current ||
			!drawLayerActionRef.current
		) {
			return;
		}

		let imageData: ArrayBuffer | HTMLCanvasElement | undefined;
		if (getDrawState() === DrawState.ScrollScreenshot) {
			imageData = await scrollScreenshotGetImageData(true);
		} else {
			imageData = await getCanvas(
				selectLayerActionRef.current.getSelectRectParams(),
				imageLayerActionRef.current,
				drawLayerActionRef.current,
			);
		}

		if (!imageData) {
			return;
		}

		const hideLoading = message.loading(
			<FormattedMessage id="draw.saveToCloud.loading" />,
		);

		try {
			const result = await saveCanvasToCloud(imageData, getAppSettings());
			if (typeof result === "object" && "error" in result) {
				message.error(<FormattedMessage id="draw.saveToCloud.error" />);
			} else {
				writeTextToClipboard(result);
				finishCapture();
			}
		} catch (error) {
			appError("[DrawPageCore] S3 upload error", error);
		}

		hideLoading();
	}, [finishCapture, getAppSettings, message, getDrawState]);

	const onFixed = useCallback(async () => {
		if (getDrawState() === DrawState.ScrollScreenshot) {
			const scrollScreenshotSize = await scrollScreenshotGetSize();
			if (
				scrollScreenshotSize.top_image_size === 0 &&
				scrollScreenshotSize.bottom_image_size === 0
			) {
				message.error(<FormattedMessage id="draw.scrollScreenshotSizeError" />);
				return;
			}
			// 停止监听键盘
			listenKeyStop();

			// 标记当前窗口已进入 fixedContent 模式，防止后续截图事件被旧窗口错误响应
			isFixedRef.current = true;
			saveCaptureHistory(undefined, CaptureHistorySource.ScrollScreenshotFixed);

			createFixedContentWindow(true);
			finishCapture(false);
			return;
		}
		// 停止监听键盘
		listenKeyStop();

		// 标记当前窗口已进入 fixedContent 模式，防止后续截图事件被旧窗口错误响应
		isFixedRef.current = true;
		capturingRef.current = false;
		setCaptureStateAction(false);

		const fixedContentAction = getFixedContentAction();

		if (
			!layerContainerRef.current ||
			!selectLayerActionRef.current ||
			!captureBoundingBoxInfoRef.current ||
			!imageLayerActionRef.current ||
			!drawLayerActionRef.current ||
			!fixedContentAction ||
			!ocrBlocksActionRef.current
		) {
			return;
		}

		await fixedToScreen(
			captureBoundingBoxInfoRef.current,
			appWindowRef.current,
			layerContainerRef.current,
			selectLayerActionRef.current,
			fixedContentAction,
			imageLayerActionRef.current,
			drawLayerActionRef.current,
			setCaptureStep,
			// 如果当前是 OCR 识别状态，则使用已有的 OCR 结果
			isOcrTool(getDrawState())
				? ocrBlocksActionRef.current?.getOcrResultAction()?.getAllOcrResult()
				: undefined,
			async (canvas: HTMLCanvasElement) => {
				await saveCaptureHistory(
					getAppSettings()[AppSettingsGroup.SystemScreenshot]
						.historySaveEditResult
						? canvas
						: undefined,
					CaptureHistorySource.Fixed,
				);
			},
			onFixedContentLoad,
			showFixedContent,
		);

		switchLayer(
			undefined,
			imageLayerActionRef.current,
			selectLayerActionRef.current,
		);

		imageBufferRef.current = undefined;
	}, [
		finishCapture,
		getAppSettings,
		getDrawState,
		getFixedContentAction,
		saveCaptureHistory,
		setCaptureStep,
		setCaptureStateAction,
		onFixedContentLoad,
		showFixedContent,
		message,
	]);

	const onTopWindow = useCallback(async () => {
		const windowId = selectLayerActionRef.current?.getWindowId();

		if (windowId) {
			await switchAlwaysOnTop(windowId);
		}

		await finishCapture();
	}, [finishCapture]);

	const onOcrDetect = useCallback(async () => {
		if (
			!captureBoundingBoxInfoRef.current ||
			!selectLayerActionRef.current ||
			!imageLayerActionRef.current ||
			!drawLayerActionRef.current ||
			!ocrBlocksActionRef.current
		) {
			return;
		}

		handleOcrDetect(
			captureBoundingBoxInfoRef.current,
			selectLayerActionRef.current,
			imageLayerActionRef.current,
			drawLayerActionRef.current,
			ocrBlocksActionRef.current,
			true,
		);
	}, []);

	const onCopyToClipboard = useCallback(async () => {
		const enableAutoSave =
			getAppSettings()[AppSettingsGroup.FunctionScreenshot].autoSaveOnCopy;
		const enableCopyImageFileToClipboard =
			getAppSettings()[AppSettingsGroup.FunctionScreenshot]
				.copyImageFileToClipboard;

		if (getDrawState() === DrawState.ScrollScreenshot) {
			const scrollScreenshotSize = await scrollScreenshotGetSize();
			if (
				scrollScreenshotSize.top_image_size === 0 &&
				scrollScreenshotSize.bottom_image_size === 0
			) {
				message.error(<FormattedMessage id="draw.scrollScreenshotSizeError" />);
				return;
			}

			saveCaptureHistory(undefined, CaptureHistorySource.ScrollScreenshotCopy);

			const filePath = (
				await getImagePathFromSettings(getAppSettings(), "auto")
			)?.filePath;
			Promise.all([
				scrollScreenshotSaveToClipboard().catch((error) => {
					appError(
						"[DrawPageCore] scrollScreenshotSaveToClipboard error",
						error,
					);
				}),
				enableAutoSave && filePath
					? scrollScreenshotSaveToFile(filePath).catch((error) => {
							appError(
								"[DrawPageCore] scrollScreenshotSaveToFile error",
								error,
							);
						})
					: Promise.resolve(),
			]).finally(() => {
				scrollScreenshotClear();
			});

			finishCapture(false);
			return;
		}

		let selectedText: OcrBlocksSelectedText | undefined;
		if (isOcrTool(getDrawState())) {
			selectedText = ocrBlocksActionRef.current?.getSelectedText();
		} else if (getDrawState() === DrawState.ScanQrcode) {
			selectedText = {
				type: "text",
				text: window.getSelection()?.toString().trim() ?? "",
			};
		}

		const ocrResult = ocrBlocksActionRef.current
			?.getOcrResultAction()
			?.getOcrResult();
		if (
			selectedText &&
			selectedText.text.trim() !== "" &&
			(isOcrTool(getDrawState()) || getDrawState() === DrawState.ScanQrcode)
		) {
			if (selectedText.type === "visionModelHtml") {
				writeHtmlToClipboard(selectedText.text);
			} else {
				writeTextToClipboard(selectedText.text);
			}
			finishCapture();
			return;
		} else if (
			isOcrTool(getDrawState()) &&
			(getAppSettings()[AppSettingsGroup.FunctionScreenshot].ocrCopyText ||
				ocrResult?.ocrResultType === OcrResultType.VisionModelHtml ||
				ocrResult?.ocrResultType === OcrResultType.VisionModelMarkdown)
		) {
			if (
				ocrResult &&
				(ocrResult.ocrResultType === OcrResultType.Ocr ||
					ocrResult.ocrResultType === OcrResultType.Translated)
			) {
				writeTextToClipboard(covertOcrResultToText(ocrResult.result));
			} else if (
				ocrResult &&
				ocrResult.ocrResultType === OcrResultType.VisionModelHtml
			) {
				const html = getOcrResultIframeSrcDoc(
					ocrResult.result.text_blocks[0].text,
					ocrResult.ocrResultType,
					undefined,
					undefined,
					undefined,
				);
				writeHtmlToClipboard(html);
			} else if (
				ocrResult &&
				ocrResult.ocrResultType === OcrResultType.VisionModelMarkdown
			) {
				writeTextToClipboard(ocrResult.result.text_blocks[0].text);
			}

			finishCapture();
			return;
		} else {
			if (
				!selectLayerActionRef.current ||
				!imageLayerActionRef.current ||
				!drawLayerActionRef.current
			) {
				return;
			}

			if (
				!getAppSettings()[AppSettingsGroup.SystemScreenshot]
					.historySaveEditResult
			) {
				saveCaptureHistory(undefined, CaptureHistorySource.Copy);
			}

			// 保持焦点，假隐藏窗口
			appWindowRef.current.setIgnoreCursorEvents(true);
			if (layerContainerRef.current) {
				layerContainerRef.current.style.opacity = "0";
			}

			const selectRectParams =
				selectLayerActionRef.current.getSelectRectParams();
			const imageCanvas: HTMLCanvasElement | undefined = await getCanvas(
				selectRectParams,
				imageLayerActionRef.current,
				drawLayerActionRef.current,
			);
			if (!imageCanvas) {
				return;
			}

			if (
				getAppSettings()[AppSettingsGroup.SystemScreenshot]
					.historySaveEditResult
			) {
				saveCaptureHistory(imageCanvas, CaptureHistorySource.Copy);
			}

			await Promise.all([
				enableCopyImageFileToClipboard
					? Promise.resolve()
					: copyToClipboard(imageCanvas, getAppSettings(), selectRectParams),
				(async () => {
					await new Promise((resolve) => {
						setTimeout(resolve, 0);
					});

					await finishCapture();
				})(),
			]);

			if (enableAutoSave || enableCopyImageFileToClipboard) {
				const imagePath = await getImagePathFromSettings(
					getAppSettings(),
					"auto",
				);
				if (imagePath) {
					await saveToFile(
						getAppSettings(),
						imageCanvas,
						undefined,
						undefined,
						imagePath,
					);
					await writeFilePathToClipboard(imagePath.filePath);
				}
			}
		}
	}, [
		finishCapture,
		getAppSettings,
		getDrawState,
		saveCaptureHistory,
		message,
	]);

	const releaseExecuteScreenshotTimerRef = useRef<
		| {
				timer: NodeJS.Timeout | undefined;
				type: ScreenshotType;
		  }
		| undefined
	>(undefined);

	useEffect(() => {
		// ============================================================
		// 监听截图命令事件 "execute-screenshot"
		//
		// 此事件由两处发射：
		//   - 主链路：前端 executeScreenshot() → emit("execute-screenshot")
		//   - 兜底链路：Rust trigger_screenshot_core() → emit_to(draw, "execute-screenshot")
		//
		// 状态机处理逻辑：
		//   Init        → 暂存事件到 pendingScreenshotRef，等 onInitCanvasReady 消费
		//   Release     → 暂存事件，等 release-draw-page 后自动重新触发
		//   WaitRelease → 直接重置为 Active，立即执行截图
		//   Active      → 直接执行 excuteScreenshot()
		// ============================================================
		const listenerId = addListener("execute-screenshot", (args) => {
			// 如果窗口已进入 fixedContent 模式，忽略截图事件，防止旧窗口错误响应
			if (isFixedRef.current) return;

			const t0 = performance.now();
			const payload = (
				args as {
					payload: {
						type: ScreenshotType;
						windowLabel?: string;
						captureHistoryId?: string;
					};
				}
			).payload;

			appDebug(
				`[screenshot-perf] draw received execute-screenshot event, type=${payload.type}`,
			);

			// 防止循环调用：忽略自身窗口发出的事件
			if (payload.windowLabel === appWindowRef.current?.label) {
				return;
			}

			// 正在截图中，跳过重复请求
			if (capturingRef.current) {
				appDebug("[screenshot-perf] draw skipped: already capturing");
				return;
			}

			// 特殊类型：全屏截图直接保存，不走 draw 编辑器
			if (payload.type === ScreenshotType.CaptureFullScreen) {
				captureHistoryActionRef.current?.captureFullScreen();
				return;
			}

			if (drawPageStateRef.current === DrawPageState.Init) {
				// Init 态：画布尚未就绪，暂存事件等待 onInitCanvasReady 回调执行
				appDebug(`[screenshot-perf] draw state=Init, queuing screenshot`);
				pendingScreenshotRef.current = {
					type: payload.type,
					payload: payload,
				};
				return;
			} else if (drawPageStateRef.current === DrawPageState.Release) {
				// Release 态：窗口正在加载/隐藏中，暂存一次待执行截图
				appDebug(`[screenshot-perf] draw state=Release, queuing screenshot`);
				releaseExecuteScreenshotTimerRef.current = {
					timer: undefined,
					type: payload.type,
				};

				return;
			} else if (drawPageStateRef.current === DrawPageState.WaitRelease) {
				// WaitRelease → Active：用户快速连续截图，取消等待释放直接复用
				drawPageStateRef.current = DrawPageState.Active;
			}

			appDebug(
				`[screenshot-perf] draw state=Active, dispatching excuteScreenshot, recv_to_dispatch: ${(performance.now() - t0).toFixed(1)}ms`,
			);
			excuteScreenshot(payload.type, payload);
		});

		const finishListenerId = addListener("finish-screenshot", () => {
			finishCapture();
		});

		const releaseListenerId = addListener("release-draw-page", (args) => {
			const payload = (args as { payload: { force: boolean } }).payload;

			if (payload.force) {
				// force 模式：强制关闭窗口
				getCurrentWindow().close();
				return;
			}

			if (drawPageStateRef.current !== DrawPageState.Release) {
				return;
			}

			if (releaseExecuteScreenshotTimerRef.current?.timer) {
				clearTimeout(releaseExecuteScreenshotTimerRef.current.timer);
			}

			// release 完成后如果有待执行的截图，触发一次
			if (releaseExecuteScreenshotTimerRef.current) {
				executeScreenshotFunc(releaseExecuteScreenshotTimerRef.current.type);
				releaseExecuteScreenshotTimerRef.current = undefined;
			}

			// keep-alive: 不关闭窗口，重置为待机状态
			drawPageStateRef.current = DrawPageState.Active;
			appDebug(
				"[screenshot-perf] release-draw-page: keeping window alive, state reset to Active",
			);
		});

		return () => {
			removeListener(listenerId);
			removeListener(finishListenerId);
			removeListener(releaseListenerId);
		};
	}, [addListener, excuteScreenshot, removeListener, finishCapture]);

	// 默认隐藏
	useEffect(() => {
		hideWindow();
	}, [hideWindow]);

	const drawContextValue = useMemo<DrawContextType>(() => {
		return {
			finishCapture,
			imageLayerActionRef,
			selectLayerActionRef,
			imageBufferRef,
			drawToolbarActionRef,
			mousePositionRef,
			circleCursorRef,
			drawLayerActionRef,
			ocrBlocksActionRef,
			colorPickerActionRef,
			captureBoundingBoxInfoRef,
			captureHistoryActionRef,
		};
	}, [finishCapture]);

	const commonDrawContextValue = useMemo<CommonDrawContextType>(() => {
		return {
			getDrawCoreAction: () => drawLayerActionRef.current?.getDrawCoreAction(),
			setTool: (drawState: DrawState) => {
				drawToolbarActionRef.current?.onToolClick(drawState);
			},
			enableColorPicker: true,
			pickColor: async (mousePosition: MousePosition) => {
				return await colorPickerActionRef.current?.pickColor(mousePosition);
			},
			setColorPickerForceEnable: (forceEnable: boolean) => {
				colorPickerActionRef.current?.setForceEnable(forceEnable);
			},
			getColorPickerCurrentColor: () => {
				return colorPickerActionRef.current?.getCurrentColor();
			},
			getPopupContainer: () => {
				return document.getElementById("layout-menu-render") ?? document.body;
			},
			getImageLayerAction: () => imageLayerActionRef.current,
			getDrawLayerAction: () => drawLayerActionRef.current,
			getSelectRectParams: () =>
				selectLayerActionRef.current?.getSelectRectParams(),
		};
	}, []);

	useEffect(() => {
		const handleMouseMove = (e: MouseEvent) => {
			mousePositionRef.current = new MousePosition(e.clientX, e.clientY);
		};

		document.addEventListener("mousemove", handleMouseMove);

		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
		};
	}, []);

	useEffect(() => {
		document.oncopy = () => {
			if (getCaptureStep() === CaptureStep.Fixed || isOcrTool(getDrawState())) {
				return true;
			}

			return false;
		};
	}, [getCaptureStep, getDrawState]);

	const latestExcalidrawNewElementRef = useRef<
		| {
				id: string;
				created: number;
		  }
		| {
				editingTextElement: NonDeletedExcalidrawElement;
		  }
		| undefined
	>(undefined);
	const unsetLatestExcalidrawNewElement = useMemo(() => {
		return debounce(() => {
			latestExcalidrawNewElementRef.current = undefined;
		}, 512);
	}, []);
	const onDoubleClickFirstClick = useCallback(() => {
		// 判断 excalidraw 是否在绘制中
		const excalidrawAPI = drawLayerActionRef.current?.getExcalidrawAPI();
		const sceneElements = excalidrawAPI?.getSceneElements();
		const currentAppState = excalidrawAPI?.getAppState();
		const newElement = currentAppState?.newElement;
		const editingTextElement = currentAppState?.editingTextElement;
		const selectedElements = sceneElements?.filter(
			(element) => currentAppState?.selectedElementIds[element.id],
		);
		const selectedGroupIds = Object.keys(
			currentAppState?.selectedGroupIds ?? {},
		).filter((id) => currentAppState?.selectedGroupIds[id]);

		if (newElement && "updated" in newElement) {
			let created = newElement.updated;
			if (
				latestExcalidrawNewElementRef.current &&
				"id" in latestExcalidrawNewElementRef.current &&
				latestExcalidrawNewElementRef.current.id === newElement.id
			) {
				created = latestExcalidrawNewElementRef.current.created ?? created;
			}

			// 如果是箭头，判断下箭头长度，长度很小判断为无效
			if (newElement.type === "arrow") {
				let pointsDistance = 0;
				if (newElement.points.length === 2 || newElement.points.length === 3) {
					for (let i = newElement.points.length - 1; i > 0; i--) {
						pointsDistance +=
							Math.abs(newElement.points[i][0] - newElement.points[i - 1][0]) +
							Math.abs(newElement.points[i][1] - newElement.points[i - 1][1]);
					}
				} else {
					pointsDistance = 999;
				}
				if (pointsDistance < 3) {
					created = Date.now();
				} else {
					created = 0;
				}
			}

			latestExcalidrawNewElementRef.current = {
				id: newElement.id,
				created: created,
			};
		} else if (editingTextElement) {
			latestExcalidrawNewElementRef.current = {
				editingTextElement: editingTextElement,
			};
		} else if (
			selectedElements?.length === 1 &&
			selectedElements[0].type === "text"
		) {
			latestExcalidrawNewElementRef.current = {
				editingTextElement: selectedElements[0],
			};
		} else if (
			selectedElements &&
			selectedGroupIds &&
			selectedGroupIds.length === 1
		) {
			latestExcalidrawNewElementRef.current = {
				editingTextElement: selectedElements[0],
			};
		} else {
			unsetLatestExcalidrawNewElement();
		}
	}, [unsetLatestExcalidrawNewElement]);
	const onDoubleClick = useCallback<React.MouseEventHandler<HTMLDivElement>>(
		(e) => {
			const doubleClickAction =
				getAppSettings()[AppSettingsGroup.FunctionScreenshot].doubleClickAction;
			if (doubleClickAction === DoubleClickAction.None) {
				return;
			}

			if (
				e.button === 0 &&
				// 如果存在创建时间大于 300ms 的在编辑中的元素，则认为是对箭头的双击
				!(
					(latestExcalidrawNewElementRef.current &&
						"created" in latestExcalidrawNewElementRef.current &&
						latestExcalidrawNewElementRef.current.created < Date.now() - 300) ||
					(latestExcalidrawNewElementRef.current &&
						"editingTextElement" in latestExcalidrawNewElementRef.current)
				)
			) {
				switch (doubleClickAction) {
					case DoubleClickAction.Copy:
						onCopyToClipboard();
						break;
					case DoubleClickAction.Save:
						onSave();
						break;
					case DoubleClickAction.FixedToScreen:
						onFixed();
						break;
					default:
						break;
				}
			}
		},
		[getAppSettings, onCopyToClipboard, onSave, onFixed],
	);

	const onInitCanvasReady = useCallback(async () => {
		drawPageStateRef.current = DrawPageState.Active;

		// 消费 Init 态暂存的截图事件
		const pending = pendingScreenshotRef.current;
		pendingScreenshotRef.current = null;
		if (pending) {
			excuteScreenshot(pending.type, pending.payload);
		}

		await releaseDrawPage();
	}, [excuteScreenshot]);

	return (
		<CommonDrawContext.Provider value={commonDrawContextValue}>
			<DrawContext.Provider value={drawContextValue}>
				<div
					className={styles.layerContainer}
					ref={layerContainerRef}
					onDoubleClick={onDoubleClick}
					onClick={onDoubleClickFirstClick}
				>
					<CaptureHistoryController actionRef={captureHistoryActionRef} />

					<ScanQrcodeTool />

					<OcrBlocks
						actionRef={ocrBlocksActionRef}
						finishCapture={finishCapture}
					/>

					<div className={styles.drawLayerWrap} ref={drawLayerWrapRef}>
						<ImageLayer
							actionRef={imageLayerActionRef}
							zIndex={zIndexs.Draw_DrawLayer}
							onInitCanvasReady={onInitCanvasReady}
						/>
						<DrawLayer actionRef={drawLayerActionRef} />
					</div>
					<SelectLayer actionRef={selectLayerActionRef} />
					<DrawToolbar
						actionRef={drawToolbarActionRef}
						onCancel={finishCapture}
						onSave={onSave}
						onSaveToCloud={onSaveToCloud}
						onFixed={onFixed}
						onCopyToClipboard={onCopyToClipboard}
						onOcrDetect={onOcrDetect}
						onTopWindow={onTopWindow}
					/>
					<ColorPicker
						onCopyColor={finishCapture}
						actionRef={colorPickerActionRef}
					/>
					<StatusBar />

					<div
						ref={circleCursorRef}
						className={styles.drawToolbarCursor}
						style={{ zIndex: zIndexs.Draw_Cursor }}
					/>
				</div>
			</DrawContext.Provider>
		</CommonDrawContext.Provider>
	);
};

const DrawPageContent = React.memo(
	withCanvasHistory(
		withStatePublisher(
			DrawPageCore,
			CaptureStepPublisher,
			DrawStatePublisher,
			CaptureLoadingPublisher,
			EnableKeyEventPublisher,
			ExcalidrawEventPublisher,
			CaptureEventPublisher,
			ExcalidrawOnHandleEraserPublisher,
			ScreenshotTypePublisher,
			DrawEventPublisher,
			DrawToolbarStatePublisher,
			ElementDraggingPublisher,
		),
	),
);

export const DrawPage: React.FC = () => {
	const [isFixed, setIsFixed] = useState(false);
	const fixedContentActionRef = useRef<FixedContentActionType | undefined>(
		undefined,
	);

	const getFixedContentAction = useCallback(() => {
		return fixedContentActionRef.current;
	}, []);

	const onFixedContentLoad = useCallback(() => {
		setIsFixed(true);
	}, []);

	const [fixedContentDisabled, setFixedContentDisabled] = useState(true);
	const showFixedContent = useCallback(() => {
		setFixedContentDisabled(false);
	}, []);

	return (
		<TextScaleFactorContextProvider>
			{!isFixed && (
				<DrawPageContent
					getFixedContentAction={getFixedContentAction}
					onFixedContentLoad={onFixedContentLoad}
					showFixedContent={showFixedContent}
				/>
			)}
			<div>
				<FixedContentCore
					actionRef={fixedContentActionRef}
					disabled={fixedContentDisabled}
				/>
			</div>
		</TextScaleFactorContextProvider>
	);
};
