import { useEffect } from "react";

const KEEP_ALIVE_LOCK_NAME = "snow-shot-hidden-webview-keepalive";

const supportsWebLocks = () => {
	return (
		typeof window !== "undefined" &&
		typeof navigator !== "undefined" &&
		"locks" in navigator &&
		typeof navigator.locks?.request === "function"
	);
};

export const useKeepWebviewAlive = (enabled: boolean) => {
	useEffect(() => {
		if (!enabled || !supportsWebLocks()) {
			return;
		}

		let disposed = false;
		let releaseLock: (() => void) | undefined;

		const holdLock = async () => {
			while (!disposed) {
				try {
					await navigator.locks.request(
						KEEP_ALIVE_LOCK_NAME,
						{ mode: "shared" },
						async () => {
							await new Promise<void>((resolve) => {
								releaseLock = resolve;
								if (disposed) {
									resolve();
								}
							});
						},
					);
				} catch {
					if (disposed) {
						return;
					}

					await new Promise((resolve) => {
						window.setTimeout(resolve, 1000);
					});
				}
			}
		};

		void holdLock();

		return () => {
			disposed = true;
			releaseLock?.();
		};
	}, [enabled]);
};
