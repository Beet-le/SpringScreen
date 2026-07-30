// ============================================================
// 应用配置模块 - 提供配置持久化的 Tauri IPC 命令
// 配置数据结构定义在 snow-shot-app-shared 中，供多个 crate 共享
// ============================================================

use snow_shot_app_shared::{AppConfig, ImageViewerWindowState};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use tauri::command;
use tauri::Manager;

/// 获取配置文件路径（应用配置目录下的 config.json）
fn get_config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("获取配置目录失败: {}", e))?;
    Ok(config_dir.join("config.json"))
}

/// 保存图片查看器窗口状态到配置文件
#[command]
pub fn save_image_viewer_window_state(
    app: tauri::AppHandle,
    config_state: tauri::State<'_, Arc<StdMutex<AppConfig>>>,
    window_state: ImageViewerWindowState,
) -> Result<(), String> {
    let config_path = get_config_path(&app)?;
    let mut config = config_state.lock().map_err(|e| e.to_string())?;
    config.image_viewer_window_state = window_state;
    config.save(&config_path)
}

/// 从配置文件加载图片查看器窗口状态
#[command]
pub fn load_image_viewer_window_state(
    config_state: tauri::State<'_, Arc<StdMutex<AppConfig>>>,
) -> Result<ImageViewerWindowState, String> {
    let config = config_state.lock().map_err(|e| e.to_string())?;
    Ok(config.image_viewer_window_state.clone())
}
