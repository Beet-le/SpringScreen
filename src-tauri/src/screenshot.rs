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

#[command]
pub async fn capture_current_monitor(
    window: tauri::Window,
    encoder: String,
) -> Result<Response, String> {
    snow_shot_tauri_commands_screenshot::capture_current_monitor(window, encoder).await
}

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

/**
 * 捕获当前焦点窗口
 */
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

#[command]
pub async fn get_window_elements(window: tauri::Window) -> Result<Vec<WindowElement>, ()> {
    snow_shot_tauri_commands_screenshot::get_window_elements(window).await
}

#[command]
pub async fn switch_always_on_top(window_id: u32) -> bool {
    snow_shot_tauri_commands_screenshot::switch_always_on_top(window_id).await
}

#[command]
pub async fn get_element_from_position(
    ui_elements: tauri::State<'_, Mutex<UIElements>>,
    mouse_x: i32,
    mouse_y: i32,
) -> Result<Vec<ElementRect>, ()> {
    snow_shot_tauri_commands_screenshot::get_element_from_position(ui_elements, mouse_x, mouse_y)
        .await
}

#[command]
pub async fn get_mouse_position(app: tauri::AppHandle) -> Result<(i32, i32), String> {
    snow_shot_tauri_commands_screenshot::get_mouse_position(app).await
}

#[command]
pub async fn create_draw_window(app: tauri::AppHandle) {
    snow_shot_tauri_commands_screenshot::create_draw_window(app).await
}

#[command]
pub async fn set_draw_window_style(window: tauri::Window) {
    snow_shot_tauri_commands_screenshot::set_draw_window_style(window).await
}

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

/// 原子化截图触发：创建窗口 + 设状态 + 发射事件
/// 仅作为 JS 侧 WebView 冻结时的 Rust 兜底通道，非主链路
pub async fn trigger_screenshot_core(
    app: &tauri::AppHandle,
    screenshot_type: String,
    window_label: Option<String>,
    capture_history_id: Option<String>,
) {
    let t_total = std::time::Instant::now();

    // 1. 检查是否已在截图中
    let is_capturing = app.state::<Mutex<CaptureState>>().lock().await.capturing;
    if is_capturing {
        log::debug!(
            "[screenshot-perf] trigger_screenshot_core aborted: already capturing"
        );
        return;
    }

    // 2. 确保 draw 窗口存在
    let t_window = std::time::Instant::now();
    let mut target_label = latest_draw_window_label(app);
    let mut created_new = false;
    if target_label.is_none() {
        snow_shot_tauri_commands_screenshot::create_draw_window(app.clone()).await;
        created_new = true;
        tokio::time::sleep(std::time::Duration::from_millis(180)).await;
        target_label = latest_draw_window_label(app);
    }
    log::debug!(
        "[screenshot-perf] draw window ready: {}ms, created_new={}, label={:?}",
        t_window.elapsed().as_millis(),
        created_new,
        target_label
    );

    // 3. 构建 payload
    let payload = serde_json::json!({
        "type": screenshot_type,
        "windowLabel": window_label,
        "captureHistoryId": capture_history_id,
    });

    // 4. 向 draw 窗口 emit，最多重试 3 次 × 200ms（仅兜底，不做大循环）
    if let Some(label) = target_label {
        for i in 0..3 {
            let is_capturing = app.state::<Mutex<CaptureState>>().lock().await.capturing;
            if is_capturing {
                log::debug!(
                    "[screenshot-perf] emit confirmed at retry {}, total: {}ms",
                    i,
                    t_total.elapsed().as_millis()
                );
                break;
            }

            let _ = app.emit_to(label.clone(), "execute-screenshot", &payload);
            log::debug!(
                "[screenshot-perf] emit retry {}, elapsed: {}ms",
                i,
                t_total.elapsed().as_millis()
            );
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    } else {
        log::warn!(
            "[screenshot-perf] no draw window found after creation attempt, total: {}ms",
            t_total.elapsed().as_millis()
        );
    }
}

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

#[command]
pub async fn trigger_screenshot(
    app: tauri::AppHandle,
    screenshot_type: String,
    window_label: Option<String>,
    capture_history_id: Option<String>,
) {
    trigger_screenshot_core(&app, screenshot_type, window_label, capture_history_id).await;
}
