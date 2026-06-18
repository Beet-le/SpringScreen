use std::collections::HashMap;
use tauri::command;
use tokio::sync::Mutex;

use snow_shot_global_state::{CaptureState, ReadClipboardState, ScreenshotShortcutMap};

#[command]
pub async fn set_capture_state(
    capture_state: tauri::State<'_, Mutex<CaptureState>>,
    capturing: bool,
) -> Result<(), String> {
    let mut capture_state = capture_state.lock().await;
    capture_state.capturing = capturing;

    Ok(())
}

#[command]
pub async fn get_capture_state(
    capture_state: tauri::State<'_, Mutex<CaptureState>>,
) -> Result<CaptureState, String> {
    let capture_state = capture_state.lock().await;
    Ok(capture_state.clone())
}

#[command]
pub async fn set_read_clipboard_state(
    read_clipboard_state: tauri::State<'_, Mutex<ReadClipboardState>>,
    reading: bool,
) -> Result<(), String> {
    let mut read_clipboard_state = read_clipboard_state.lock().await;
    read_clipboard_state.reading = reading;
    Ok(())
}

#[command]
pub async fn get_read_clipboard_state(
    read_clipboard_state: tauri::State<'_, Mutex<ReadClipboardState>>,
) -> Result<ReadClipboardState, String> {
    let read_clipboard_state = read_clipboard_state.lock().await;
    Ok(read_clipboard_state.clone())
}

/// JS 注册快捷键后同步白名单到 Rust，供兜底 handler 查询
#[command]
pub async fn sync_screenshot_shortcuts(
    shortcuts: tauri::State<'_, Mutex<ScreenshotShortcutMap>>,
    map: HashMap<String, String>,
) -> Result<(), String> {
    let mut shortcuts = shortcuts.lock().await;
    *shortcuts = map;
    Ok(())
}
