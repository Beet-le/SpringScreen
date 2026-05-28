import * as path from "@tauri-apps/api/path";
import { exists } from "@tauri-apps/plugin-fs";
import { appError, appWarn } from "@/utils/log";
import type { PluginStatusResult } from "../commands/plugin";

export type PluginItem = {
	id: string;
	file_list: string[];
};

export class PluginConfig {
	plugins: Map<string, PluginItem> = new Map();
	version: string = "";
	/** 插件安装目录（运行目录，优先使用） */
	plugin_install_dir: string = "";
	/** 插件安装回退目录（AppData，运行目录不存在时使用） */
	fallback_install_dir: string = "";
	plugin_download_dir: string = "";
	plugin_download_service_url: string = "";

	constructor(
		plugins: PluginItem[],
		version: string,
		plugin_install_dir: string,
		fallback_install_dir: string,
		plugin_download_dir: string,
		plugin_download_service_url: string,
	) {
		this.plugins = new Map(plugins.map((plugin) => [plugin.id, plugin]));
		this.version = version;
		this.plugin_install_dir = plugin_install_dir;
		this.fallback_install_dir = fallback_install_dir;
		this.plugin_download_dir = plugin_download_dir;
		this.plugin_download_service_url = plugin_download_service_url;
	}

	async getPluginDirPath(name: string) {
		const pluginId = this.plugins.get(name)?.id ?? "";
		if (pluginId === "") {
			appError("[PluginConfig::getPluginDirPath] pluginId is empty");
		}

		// 优先从运行目录获取插件
		const resourcePath = await path.join(
			this.plugin_install_dir,
			this.version,
			pluginId,
		);
		console.log(`获取运行资源目录: ${resourcePath}`);

		if (await exists(resourcePath)) {
			return resourcePath;
		}

		// 运行目录下不存在时，回退到 AppData 目录
		const appDataPath = await path.join(
			this.fallback_install_dir,
			this.version,
			pluginId,
		);
		console.log(`获取AppData目录: ${appDataPath}`);

		if (await exists(appDataPath)) {
			return appDataPath;
		}

		appWarn(
			`[PluginConfig::getPluginDirPath] plugin not found in both paths, resource: ${resourcePath}, appData: ${appDataPath}`,
		);

		// 都不存在时返回运行目录路径，让后续流程报出明确错误
		return resourcePath;
	}
}

export type PluginStatusRecord = Record<string, PluginStatusResult>;
