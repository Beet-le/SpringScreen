pub fn get_focused_window() -> () {
    log::warn!("[os::utils::linux::get_focused_window] not implemented");

    ()
}

/// 获取系统启动以来的秒数（用于识别开机自启场景）
pub fn system_uptime_secs() -> Option<u64> {
    // Linux 暂无需求：返回 None 表示放行（不做开机自启抑制）
    None
}

pub fn switch_always_on_top() -> () {
    log::warn!("[os::utils::linux::switch_always_on_top] not implemented");

    ()
}

pub fn set_draw_window_style(window: tauri::Window) {
    log::warn!("[os::utils::linux::set_draw_window_style] not implemented");

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
