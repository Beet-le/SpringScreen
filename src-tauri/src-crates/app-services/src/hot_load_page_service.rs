use std::path::PathBuf;

use dashmap::DashMap;
use serde::Serialize;
use tokio::sync::RwLock;

#[derive(Debug)]
pub struct HotLoadPage {
    window: tauri::WebviewWindow,
    /// 是否可用
    status: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct HotLoadPageRoutePushEvent {
    pub label: String,
    pub url: String,
}

#[derive(Debug)]
pub struct HotLoadPageService {
    /// 热加载页面数量
    page_limit: RwLock<usize>,
    /// 热加载页面列表
    page_list: DashMap<String, HotLoadPage>,
    /// 应用句柄
    app_handle: RwLock<Option<tauri::AppHandle>>,
    /// 页面 ID
    page_id: RwLock<usize>,
}

impl HotLoadPageService {
    pub fn new() -> Self {
        Self {
            page_limit: RwLock::new(10),
            page_list: DashMap::new(),
            app_handle: RwLock::new(None),
            page_id: RwLock::new(0),
        }
    }

    /// 创建用于热加载的待机窗口
    async fn create_idle_window_core(&self) -> Result<(), String> {
        let app_handle = self.app_handle.read().await;
        let app_handle = match app_handle.as_ref() {
            Some(app_handle) => app_handle,
            None => {
                return Err(
                    "[HotLoadPageService:create_idle_window_core] App handle is not initialized"
                        .to_string(),
                );
            }
        };

        let page_id = {
            let mut page_id_guard = self.page_id.write().await;
            *page_id_guard += 1;
            *page_id_guard
        };

        let window_label = format!("hot-load-page-{}", page_id);

        let window = match tauri::WebviewWindowBuilder::new(
            app_handle,
            window_label.as_str(),
            tauri::WebviewUrl::App(PathBuf::from(format!("/fixedContent?idle_page=true",))),
        )
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .fullscreen(false)
        .title("Snow Shot - Hot Load Page")
        .decorations(false)
        .shadow(false)
        .transparent(true)
        .skip_taskbar(true)
        .resizable(false)
        .inner_size(1.0, 1.0)
        // Keep the standby page technically visible so WebView2 does not background-freeze it.
        .position(-32000.0, -32000.0)
        .visible(true)
        .focused(false)
        .build()
        {
            Ok(window) => {
                // 在 Win32 层面隐藏窗口，防止 Windows 将极端负坐标 clamp 到可见区域导致闪烁。
                // 保持 visible(true) 让 WebView2 认为窗口可见，避免后台冻结。
                #[cfg(target_os = "windows")]
                {
                    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER};
                    let hwnd = window.hwnd().unwrap();
                    let _ = unsafe {
                        SetWindowPos(hwnd, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_HIDEWINDOW | SWP_NOACTIVATE)
                    };
                }
                window
            }
            Err(e) => {
                return Err(format!(
                    "[HotLoadPageService:create_idle_window_core] Create idle window error: {:?}",
                    e
                ));
            }
        };

        self.page_list.insert(
            window_label,
            HotLoadPage {
                window,
                status: false,
            },
        );

        Ok(())
    }

    pub async fn create_idle_windows(&self) -> Result<(), String> {
        let page_limit = {
            let page_limit_guard = self.page_limit.read().await;
            *page_limit_guard
        };

        let current_page_count = {
            let current_page_list = self.page_list.len();
            current_page_list
        };

        if page_limit == current_page_count {
            return Ok(());
        }

        // 多余的窗口需要关闭
        if page_limit < current_page_count {
            let excess = current_page_count - page_limit;
            let keys_to_remove: Vec<String> = self
                .page_list
                .iter()
                .take(excess)
                .map(|entry| entry.key().to_owned())
                .collect();

            for key in keys_to_remove {
                if let Some((_, page)) = self.page_list.remove(&key) {
                    let _ = page.window.close();
                    log::info!(
                        "[HotLoadPageService] Closed excess idle window: {}",
                        key
                    );
                }
            }
            return Ok(());
        }

        for _ in 0..(page_limit - current_page_count) {
            match self.create_idle_window_core().await {
                Ok(_) => (),
                Err(e) => {
                    log::error!(
                        "[HotLoadPageService:create_idle_windows] Create idle window error: {}",
                        e
                    );
                }
            }
        }

        Ok(())
    }

    /// 初始化热加载服务
    pub async fn init(&self, page_limit: usize, app_handle: tauri::AppHandle) {
        {
            let mut page_limit_guard = self.page_limit.write().await;
            *page_limit_guard = page_limit;
        }

        {
            let mut app_handle_guard = self.app_handle.write().await;

            if app_handle_guard.is_none() {
                *app_handle_guard = Some(app_handle);
            }
        }
    }

    /// 将准备好的页面加入到页面列表中
    pub async fn add_page(&self, window: tauri::WebviewWindow) -> Result<(), String> {
        let window_label = window.label().to_owned();
        let page = self.page_list.get_mut(&window_label);
        match page {
            Some(mut page) => {
                page.status = true;
                Ok(())
            }
            None => Err(format!(
                "[HotLoadPageService:add_page] Page not found: {}",
                window_label
            )),
        }
    }

    pub async fn pop_page(&self) -> Option<tauri::WebviewWindow> {
        let page_key = {
            let page_item = self
                .page_list
                .iter()
                .find(|entry| entry.value().status == true);

            match page_item {
                Some(page_key) => page_key.key().to_owned(),
                None => return None,
            }
        };

        let (_, page) = {
            match self.page_list.remove(page_key.as_str()) {
                Some(page_item) => page_item,
                None => return None,
            }
        };

        // 弹出窗口前，恢复 Win32 层面的可见性（与 create_idle_window_core 中 SWP_HIDEWINDOW 对应）
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_SHOWWINDOW, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER};
            let hwnd = page.window.hwnd().unwrap();
            let _ = unsafe {
                SetWindowPos(hwnd, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_SHOWWINDOW | SWP_NOACTIVATE)
            };
        }

        Some(page.window)
    }
}
