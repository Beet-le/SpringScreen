use tauri::command;

/// 创建图片查看器窗口
#[command]
pub async fn create_image_viewer_window(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<(), String> {
    snow_shot_tauri_commands_core::create_image_viewer_window(app, file_path).await
}
