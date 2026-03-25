import { defineConfig } from "@rsbuild/core";
import { pluginNodePolyfill } from "@rsbuild/plugin-node-polyfill";
import { pluginReact } from "@rsbuild/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/rspack";

export default defineConfig({
	plugins: [pluginReact(), pluginNodePolyfill()],
	resolve: {
		alias: {
			"@": "./src",
			// 强制走 CJS 入口，避免 dev 场景下该包被 ESM 解析导致兼容问题。
			"browser-fs-access": "./node_modules/browser-fs-access/dist/index.cjs",
		},
	},
	output: {
		cleanDistPath: true,
	},
	server: {
		// 允许直接访问深层路由（如 /draw、/fixedContent）时回退到 index。
		historyApiFallback: true,
	},
	dev: {
		// 关闭懒编译，避免首帧截图链路第一次触发时模块还未编译完成。
		lazyCompilation: false,
	},
	performance: {
		chunkSplit: {
			strategy: "split-by-module",
		},
	},
	html: {
		tags: [
			{
				tag: "script",
				attrs: {
					src:
						import.meta.env.PUBLIC_ONLINE_STATUS === "true"
							? "/scripts/excalidraw.js"
							: "/scripts/excalidraw.offline.js",
				},
			},
			{
				tag: "script",
				attrs: {
					src: "/scripts/markdownItFix.js",
				},
			},
		],
	},
	tools: {
		swc: {
			jsc: {
				experimental: {
					plugins: [["@swc/plugin-styled-jsx", {}]],
				},
			},
		},
		rspack: {
			plugins: [
				tanstackRouter({
					target: "react",
					autoCodeSplitting: true,
				}),
			],
			optimization: {},
		},
	},
});
