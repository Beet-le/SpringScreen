import { ScanOutlined } from "@ant-design/icons";
import { Button, Flex, message, theme } from "antd";
import { useCallback, useContext, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { createVideoRecordWindow } from "@/commands/core";
import { DrawStatePublisher } from "@/components/drawCore/extra";
import { VideoRecordIcon } from "@/components/icons";
import { PLUGIN_ID_FFMPEG } from "@/constants/pluginService";
import { usePluginServiceContext } from "@/contexts/pluginServiceContext";
import { useStateSubscriber } from "@/hooks/useStateSubscriber";
import { DrawContext } from "@/pages/draw/types";
import { ExtraToolList } from "@/types/appSettings";
import { DrawState } from "@/types/draw";
import { appError, appWarn } from "@/utils/log";
import { getPlatform } from "@/utils/platform";
import { getButtonTypeByState } from "../../../extra";

export const ExtraTool: React.FC<{
	onToolClickAction: (tool: DrawState) => void;
	disable: boolean;
}> = ({ onToolClickAction, disable }) => {
	const intl = useIntl();
	const { token } = theme.useToken();

	const { captureBoundingBoxInfoRef, selectLayerActionRef, finishCapture } =
		useContext(DrawContext);

	const [activeTool, setActiveTool] = useState<ExtraToolList>(
		ExtraToolList.None,
	);
	const [, setEnabled] = useState(false);

	const executeScanQrcode = useCallback(() => {
		setActiveTool(ExtraToolList.ScanQrcode);
	}, []);

	// 视频录制执行防重入：状态订阅与按钮 onClick 都可能触发 executeVideoRecord，
	// 通过 ref 保证同一次点击只执行一次录制流程
	const videoRecordExecutingRef = useRef(false);

	const executeVideoRecord = useCallback(() => {
		if (videoRecordExecutingRef.current) {
			return;
		}

		const captureBoundingBoxInfo = captureBoundingBoxInfoRef.current;
		const selectRect = selectLayerActionRef.current?.getSelectRect();
		if (!captureBoundingBoxInfo || !selectRect) {
			// 未框选或截图信息缺失：给出提示，避免静默失败导致蒙版残留
			appWarn(
				"[extraTool] executeVideoRecord skipped: captureBoundingBoxInfo or selectRect is empty",
			);
			message.warning(
				intl.formatMessage({
					id: "draw.extraTool.videoRecord.selectRectEmpty",
				}),
			);
			return;
		}

		const monitorRect = captureBoundingBoxInfo.transformWindowRect(selectRect);

		if (
			getPlatform() === "macos" &&
			captureBoundingBoxInfo.getActiveMonitorRectList(monitorRect).length > 1
		) {
			message.warning(
				intl.formatMessage({
					id: "draw.extraTool.videoRecord.multiMonitor",
				}),
			);
			return;
		}

		videoRecordExecutingRef.current = true;

		createVideoRecordWindow(
			monitorRect.min_x,
			monitorRect.min_y,
			monitorRect.max_x,
			monitorRect.max_y,
		).catch((error) => {
			appError("[extraTool] createVideoRecordWindow error", error);
		});

		// 快捷执行时立刻 finish 可能窗口很多数据还没初始化好，所以延迟执行
		// 注意：无论录制窗口创建成功与否都必须 finishCapture，
		// 否则蒙版残留 + 鼠标被拦截，表现为"覆盖整个屏幕、类似卡死"
		setTimeout(() => {
			finishCapture()
				.catch((error) => {
					appError("[extraTool] finishCapture error", error);
				})
				.finally(() => {
					videoRecordExecutingRef.current = false;
				});
		}, 0);
	}, [captureBoundingBoxInfoRef, finishCapture, intl, selectLayerActionRef]);

	useStateSubscriber(
		DrawStatePublisher,
		useCallback(
			(drawState: DrawState) => {
				if (
					drawState === DrawState.ExtraTools ||
					drawState === DrawState.ScanQrcode ||
					drawState === DrawState.VideoRecord
				) {
					if (drawState === DrawState.ScanQrcode) {
						executeScanQrcode();
					} else if (drawState === DrawState.VideoRecord) {
						executeVideoRecord();
					}

					setEnabled(true);
				} else {
					setActiveTool(ExtraToolList.None);
					setEnabled(false);
				}
			},
			[executeScanQrcode, executeVideoRecord],
		),
	);

	const scanQrcodeButton = (
		<Button
			icon={<ScanOutlined />}
			title={intl.formatMessage({ id: "draw.extraTool.scanQrcode" })}
			type={getButtonTypeByState(activeTool === ExtraToolList.ScanQrcode)}
			key="scanQrcode"
			onClick={() => {
				onToolClickAction(DrawState.ScanQrcode);
			}}
			disabled={disable}
		/>
	);

	const videoRecordButton = (
		<Button
			icon={<VideoRecordIcon />}
			title={intl.formatMessage({ id: "draw.extraTool.videoRecord" })}
			type={getButtonTypeByState(activeTool === ExtraToolList.VideoRecord)}
			key="videoRecord"
			onClick={() => {
				onToolClickAction(DrawState.VideoRecord);
				// 直接执行录制流程（防重入）：
				// 若 DrawState 已卡在 VideoRecord，onToolClickAction 不会触发状态订阅，
				// 直接调用保证点击始终生效，避免蒙版残留后按钮失灵
				executeVideoRecord();
			}}
			disabled={disable}
		/>
	);

	const { isReadyStatus } = usePluginServiceContext();

	return (
		<Flex align="center" gap={token.paddingXS}>
			{scanQrcodeButton}
			{isReadyStatus?.(PLUGIN_ID_FFMPEG) && videoRecordButton}
		</Flex>
	);
};
