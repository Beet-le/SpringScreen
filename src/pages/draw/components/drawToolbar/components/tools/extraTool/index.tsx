import { ScanOutlined } from "@ant-design/icons";
import { Button, Flex, message, theme } from "antd";
import { useCallback, useContext, useState } from "react";
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

	const executeVideoRecord = useCallback(() => {
		const captureBoundingBoxInfo = captureBoundingBoxInfoRef.current;
		const selectRect = selectLayerActionRef.current?.getSelectRect();
		if (!captureBoundingBoxInfo || !selectRect) {
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

		createVideoRecordWindow(
			monitorRect.min_x,
			monitorRect.min_y,
			monitorRect.max_x,
			monitorRect.max_y,
		);

		// 快捷执行时立刻 finish 可能窗口很多数据还没初始化好，所以延迟执行
		setTimeout(() => {
			finishCapture();
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
