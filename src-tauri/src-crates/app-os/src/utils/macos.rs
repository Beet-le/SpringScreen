pub fn get_focused_window() -> Option<()> {
    None
}

/// 获取系统启动以来的秒数（用于识别开机自启场景）
pub fn system_uptime_secs() -> Option<u64> {
    // 产品仅发布 Windows 平台：macOS 不启用开机自启抑制，放行所有 --open-draw
    None
}

pub fn switch_always_on_top() -> () {
    log::warn!("[os::utils::linux::switch_always_on_top] not implemented");

    ()
}

pub fn set_draw_window_style(#[allow(unused_variables)] window: tauri::Window) {
    // macOS 无需实现

    ()
}

pub fn create_admin_auto_start_task() -> Result<(), String> {
    Ok(())
}

pub fn delete_admin_auto_start_task() -> Result<(), String> {
    Ok(())
}

pub fn restart_with_admin() -> Result<(), String> {
    Ok(())
}

pub fn is_admin() -> bool {
    false
}
