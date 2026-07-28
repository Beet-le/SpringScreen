use tauri::command;
use tauri::ipc::Response;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::sync::Mutex;

use snow_shot_app_os::ui_automation::UIElements;
use snow_shot_app_shared::ElementRect;
use snow_shot_app_utils::monitor_info::CorrectHdrColorAlgorithm;
use snow_shot_global_state::{CaptureState, WebViewSharedBufferState};
use snow_shot_tauri_commands_screenshot::{CaptureFullScreenResult, WindowElement};

/// 捕获当前鼠标所在显示器的屏幕图像
#[command]
pub async fn capture_current_monitor(
    window: tauri::Window,
    encoder: String,
) -> Result<Response, String> {
    snow_shot_tauri_commands_screenshot::capture_current_monitor(window, encoder).await
}

/// 捕获所有显示器的屏幕图像（支持多显示器）
#[command]
pub async fn capture_all_monitors(
    app: tauri::AppHandle,
    window: tauri::Window,
    webview: tauri::Webview,
    webview_shared_buffer_state: tauri::State<'_, WebViewSharedBufferState>,
    enable_multiple_monitor: bool,
    correct_hdr_color_algorithm: CorrectHdrColorAlgorithm,
    correct_color_filter: bool,
) -> Result<Response, String> {
    snow_shot_tauri_commands_screenshot::capture_all_monitors(
        app,
        window,
        webview,
        webview_shared_buffer_state,
        enable_multiple_monitor,
        correct_hdr_color_algorithm,
        correct_color_filter,
    )
    .await
}

/// 捕获当前焦点窗口
#[command]
pub async fn capture_focused_window(
    app: tauri::AppHandle,
    file_path: String,
    copy_to_clipboard: bool,
    focus_window_app_name_variable_name: String,
    correct_hdr_color_algorithm: CorrectHdrColorAlgorithm,
) -> Result<(), String> {
    snow_shot_tauri_commands_screenshot::capture_focused_window(
        move |image| match app.clipboard().write_image(&tauri::image::Image::new(
            image.as_bytes(),
            image.width(),
            image.height(),
        )) {
            Ok(_) => Ok(()),
            Err(e) => Err(format!(
                "[capture_focused_window] Failed to write image to clipboard: {}",
                e
            )),
        },
        file_path,
        copy_to_clipboard,
        focus_window_app_name_variable_name,
        correct_hdr_color_algorithm,
    )
    .await
}

/// 初始化 UI 自动化元素缓存
#[command]
pub async fn init_ui_elements(ui_elements: tauri::State<'_, Mutex<UIElements>>) -> Result<(), ()> {
    snow_shot_tauri_commands_screenshot::init_ui_elements(ui_elements).await
}

#[command]
pub async fn init_ui_elements_cache(
    ui_elements: tauri::State<'_, Mutex<UIElements>>,
) -> Result<(), String> {
    snow_shot_tauri_commands_screenshot::init_ui_elements_cache(ui_elements).await
}

/// 获取当前所有窗口元素列表（用于自动框选）
#[command]
pub async fn get_window_elements(window: tauri::Window) -> Result<Vec<WindowElement>, ()> {
    snow_shot_tauri_commands_screenshot::get_window_elements(window).await
}

/// 切换指定窗口的置顶状态
#[command]
pub async fn switch_always_on_top(window_id: u32) -> bool {
    snow_shot_tauri_commands_screenshot::switch_always_on_top(window_id).await
}

/// 获取鼠标位置对应的 UI 元素（用于自动识别按钮/输入框等）
#[command]
pub async fn get_element_from_position(
    ui_elements: tauri::State<'_, Mutex<UIElements>>,
    mouse_x: i32,
    mouse_y: i32,
) -> Result<Vec<ElementRect>, ()> {
    snow_shot_tauri_commands_screenshot::get_element_from_position(ui_elements, mouse_x, mouse_y)
        .await
}

/// 获取当前鼠标位置
#[command]
pub async fn get_mouse_position(app: tauri::AppHandle) -> Result<(i32, i32), String> {
    snow_shot_tauri_commands_screenshot::get_mouse_position(app).await
}

/// 创建 draw 截图编辑窗口
#[command]
pub async fn create_draw_window(app: tauri::AppHandle) -> Result<bool, String> {
    snow_shot_tauri_commands_screenshot::create_draw_window(app).await
}

/// 设置 draw 窗口样式（无边框、全屏等）
#[command]
pub async fn set_draw_window_style(window: tauri::Window) {
    snow_shot_tauri_commands_screenshot::set_draw_window_style(window).await
}

/// 全屏截图并保存（直接保存到文件/剪贴板，不走 draw 编辑器）
#[command]
pub async fn capture_full_screen(
    app: tauri::AppHandle,
    enable_multiple_monitor: bool,
    file_path: String,
    copy_to_clipboard: bool,
    capture_history_file_path: String,
    correct_hdr_color_algorithm: CorrectHdrColorAlgorithm,
    correct_color_filter: bool,
) -> Result<CaptureFullScreenResult, String> {
    snow_shot_tauri_commands_screenshot::capture_full_screen(
        app.clone(),
        move |image| match app.clipboard().write_image(&tauri::image::Image::new(
            image.to_rgba8().as_raw(),
            image.width(),
            image.height(),
        )) {
            Ok(_) => Ok(()),
            Err(e) => Err(format!(
                "[capture_full_screen] Failed to write image to clipboard: {}",
                e
            )),
        },
        enable_multiple_monitor,
        file_path,
        copy_to_clipboard,
        capture_history_file_path,
        correct_hdr_color_algorithm,
        correct_color_filter,
    )
    .await
}

// ============================================================
// 截图触发核心流程（Rust 侧兜底通道）
//
// 背景：
//   WebView2 在 Windows 后台/效能模式下会被 Chromium 冻结 timer 和 IPC 响应，
//   导致 JS 侧快捷键 handler 无法及时响应。此函数作为 Rust 侧的兜底通道：
//   快捷键事件直接在 Rust 侧捕获 → 跳过前端 IPC → 直接操作 draw 窗口。
//
// 主备分工：
//   - 主链路：JS 侧 execute-screenshot 事件（正常情况）
//   - 备用链路：Rust 侧 trigger_screenshot_core（WebView 冻结时兜底）
// ============================================================

/// 原子化截图触发：创建 draw 窗口 + 设置截图状态 + 向 draw 窗口发射事件
///
/// 仅作为 JS 侧 WebView 冻结时的 Rust 兜底通道，非主链路
///
/// 流程：
/// 1. 检查是否已在截图中（CaptureState 互斥锁）
/// 2. 确保 draw 窗口存在（不存在则创建，等待 180ms 初始化；冷启动时额外重试 5×500ms）
/// 3. 构建 screenshot payload（类型、窗口标签、历史 ID）
/// 4. 向 draw 窗口 emit "execute-screenshot" 事件（最多重试 15 次 × 300ms，覆盖冷启动时间）
pub async fn trigger_screenshot_core(
    app: &tauri::AppHandle,
    screenshot_type: String,
    window_label: Option<String>,
    capture_history_id: Option<String>,
) {
    let t_total = std::time::Instant::now();
    log::info!(
        "[trigger_screenshot_core] started, type={}, window_label={:?}, capture_history_id={:?}",
        screenshot_type,
        window_label,
        capture_history_id
    );

    // 1. 检查是否已在截图中（捕获状态互斥锁）
    let is_capturing = app.state::<Mutex<CaptureState>>().lock().await.capturing;
    if is_capturing {
        log::info!(
            "[trigger_screenshot_core] aborted: already capturing, elapsed: {}ms",
            t_total.elapsed().as_millis()
        );
        return;
    }

    // 2. 确保 draw 窗口存在（keep-alive 模式下窗口保持存活，通常无需创建）
    let t_window = std::time::Instant::now();
    let mut target_label = latest_draw_window_label(app);
    let mut created_new = false;
    if target_label.is_none() {
        // draw 窗口不存在，创建新窗口并等待 180ms 初始化
        log::info!("[trigger_screenshot_core] no draw window found, creating new one...");
        match snow_shot_tauri_commands_screenshot::create_draw_window(app.clone()).await {
            Ok(_) => {
                created_new = true;
            }
            Err(e) => {
                // WebView2 初始化失败（低配机器常见），记录错误后仍继续重试，
                // target_label 保持 None，后续重试循环会再次尝试查找/创建窗口
                log::error!(
                    "[trigger_screenshot_core] create_draw_window failed: {}. \
                     将进入重试循环尝试恢复",
                    e
                );
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(180)).await;
        target_label = latest_draw_window_label(app);

        // 冷启动容错：WebView2 初始化可能较慢，额外等待并重试查找窗口
        if target_label.is_none() {
            log::info!(
                "[trigger_screenshot_core] draw window not found after 180ms, entering cold-start retry..."
            );
            for retry in 0..5 {
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                target_label = latest_draw_window_label(app);
                if target_label.is_some() {
                    log::info!(
                        "[trigger_screenshot_core] draw window found after cold-start retry {} (total: {}ms)",
                        retry + 1,
                        t_window.elapsed().as_millis()
                    );
                    break;
                }
            }
        }
    }
    log::info!(
        "[trigger_screenshot_core] draw window ready: {}ms, created_new={}, label={:?}",
        t_window.elapsed().as_millis(),
        created_new,
        target_label
    );

    // 3. 构建截图 payload（传递给 draw 页面的参数）
    let payload = serde_json::json!({
        "type": screenshot_type,
        "windowLabel": window_label,
        "captureHistoryId": capture_history_id,
    });

    // 4. 向 draw 窗口发射 "execute-screenshot" 事件，最多重试 15 次 × 300ms（总计约 4.5s）
    //    冷启动场景下 WebView2 需要 2-3 秒初始化，重试窗口需覆盖该时间
    //    热启动场景下第一次 emit 即可成功，不会感受到延迟
    //    每次重试前检查 capturing 状态，如果前端已响应则提前退出
    if let Some(label) = target_label {
        for i in 0..15 {
            let is_capturing = app.state::<Mutex<CaptureState>>().lock().await.capturing;
            if is_capturing {
                log::info!(
                    "[trigger_screenshot_core] emit confirmed at retry {}, total: {}ms",
                    i,
                    t_total.elapsed().as_millis()
                );
                break;
            }

            match app.emit_to(label.clone(), "execute-screenshot", &payload) {
                Ok(_) => {
                    log::debug!(
                        "[trigger_screenshot_core] emit retry {} to '{}', elapsed: {}ms",
                        i,
                        label,
                        t_total.elapsed().as_millis()
                    );
                }
                Err(e) => {
                    log::debug!(
                        "[trigger_screenshot_core] emit retry {} to '{}' FAILED: {}, elapsed: {}ms",
                        i,
                        label,
                        e,
                        t_total.elapsed().as_millis()
                    );
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }

        // 最终结论：检查是否成功进入截图状态
        let final_capturing = app.state::<Mutex<CaptureState>>().lock().await.capturing;
        if final_capturing {
            log::info!(
                "[trigger_screenshot_core] SUCCESS: screenshot started, total: {}ms",
                t_total.elapsed().as_millis()
            );
        } else {
            log::info!(
                "[trigger_screenshot_core] FAILED: screenshot not started after all retries, total: {}ms",
                t_total.elapsed().as_millis()
            );
        }
    } else {
        log::info!(
            "[trigger_screenshot_core] FAILED: no draw window found after creation attempt and cold-start retry, total: {}ms",
            t_total.elapsed().as_millis()
        );
    }
}

/// 获取最新的 draw 窗口标签（按名称排序取最后）
/// draw 窗口命名规则：draw-{序号}，如 draw-1、draw-2
pub fn latest_draw_window_label(app: &tauri::AppHandle) -> Option<String> {
    let mut labels = app
        .webview_windows()
        .keys()
        .filter(|label| label.starts_with("draw-"))
        .cloned()
        .collect::<Vec<String>>();
    labels.sort_unstable();
    labels.pop()
}

/// 前端 IPC 调用的 trigger_screenshot 入口（委托给 trigger_screenshot_core）
#[command]
pub async fn trigger_screenshot(
    app: tauri::AppHandle,
    screenshot_type: String,
    window_label: Option<String>,
    capture_history_id: Option<String>,
) {
    trigger_screenshot_core(&app, screenshot_type, window_label, capture_history_id).await;
}
