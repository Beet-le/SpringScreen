import { createLazyFileRoute } from "@tanstack/react-router";
import { ImageViewerPage } from "@/pages/imageViewer/page";

export const Route = createLazyFileRoute("/_noLayout/imageViewer")({
	component: RouteComponent,
});

function RouteComponent() {
	return <ImageViewerPage />;
}
