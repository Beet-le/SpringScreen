import { createRouter, RouterProvider } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";
import "./styles.css";
import "github-markdown-css/github-markdown.css";
import { GlobalContext } from "./components/globalContext";

// Set up a Router instance
const router = createRouter({
	routeTree,
	defaultPreload: false, // 禁用自动预加载，减少初始内存占用
	defaultPreloadDelay: 100, // 如果需要预加载，延迟100ms
	scrollRestoration: true,
});

if (typeof window !== "undefined") {
	const searchParams = new URLSearchParams(window.location.search);
	// Support opening by `/?route=/xxx` and forward remaining query params.
	const route = searchParams.get("route");
	if (route && route.startsWith("/")) {
		searchParams.delete("route");
		const extraSearch = searchParams.toString();
		const to = extraSearch
			? `${route}${route.includes("?") ? "&" : "?"}${extraSearch}`
			: route;

		router.navigate({ to, replace: true }).catch(() => {});
	}
}

// Register things for typesafety
declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}
const App = () => {
	return (
		<GlobalContext>
			<RouterProvider router={router} />
		</GlobalContext>
	);
};

export default App;
