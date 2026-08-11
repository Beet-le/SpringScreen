// ============================================================
// 输入处理 — 鼠标滚轮缩放 / 拖拽平移 / 键盘快捷键
// ============================================================

use image::GenericImageView;
use windows::Win32::Foundation::RECT;
use windows::Win32::UI::WindowsAndMessaging::{DestroyWindow, GetClientRect};
use windows::Win32::Graphics::Gdi::{GetDC, CreateCompatibleDC, InvalidateRect};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    VK_LEFT, VK_RIGHT, VK_ESCAPE, VK_F11,
    VK_OEM_PLUS, VK_OEM_MINUS, VK_ADD, VK_SUBTRACT,
};

use crate::state::ViewerState;
use crate::navigation::scan_directory;
use crate::render::rgba_image_to_hbitmap;

// ============================================================
// 超大图保护常量（与 render.rs 保持一致）
// ============================================================

/// 解码绝对上限（100MP → ~400MiB RGBA），超过则先读取文件头检查尺寸再决定是否解码
const MAX_PIXELS: u64 = 100_000_000;

// ============================================================
// 鼠标 / 键盘事件
// ============================================================

pub fn handle_mouse_wheel(state: &mut ViewerState, delta: i16, x: i32, y: i32) {
    if state.is_loading || state.error_message.is_some() { return; }
    let hwnd = match state.hwnd { Some(h) => h, None => return };

    let mut cr = RECT::default();
    unsafe { GetClientRect(hwnd, &mut cr); }
    let cw = cr.right - cr.left;
    let ch = cr.bottom - cr.top;
    let image_h = ch - state.toolbar_height;

    let mx = x as f64 - cw as f64 / 2.0;
    let my = y as f64 - image_h as f64 / 2.0;

    let factor = if delta > 0 { 1.1 } else { 0.9 };
    let prev = state.zoom;
    let next = (prev * factor).clamp(0.01, 20.0);
    if (next - prev).abs() < 0.001 { return; }
    let ratio = next / prev;
    state.pan_x = state.pan_x * ratio - mx * (ratio - 1.0);
    state.pan_y = state.pan_y * ratio - my * (ratio - 1.0);
    state.zoom = next;
    unsafe { InvalidateRect(Some(hwnd), None, true) };
}

pub fn handle_lbutton_down(state: &mut ViewerState, x: i32, y: i32) {
    if state.is_loading || state.error_message.is_some() { return; }
    state.is_dragging = true;
    state.drag_start_x = x;
    state.drag_start_y = y;
    state.drag_pan_start_x = state.pan_x;
    state.drag_pan_start_y = state.pan_y;
}

pub fn handle_mouse_move(state: &mut ViewerState, x: i32, y: i32) {
    if !state.is_dragging { return; }
    state.pan_x = state.drag_pan_start_x + (x - state.drag_start_x) as f64;
    state.pan_y = state.drag_pan_start_y + (y - state.drag_start_y) as f64;
    if let Some(hwnd) = state.hwnd {
        unsafe { InvalidateRect(Some(hwnd), None, true) };
    }
}

pub fn handle_lbutton_up(state: &mut ViewerState) {
    state.is_dragging = false;
}

pub fn fit_to_window(state: &mut ViewerState) {
    if state.image_width <= 0 || state.image_height <= 0 { return; }
    let hwnd = match state.hwnd { Some(h) => h, None => return };
    let mut cr = RECT::default();
    unsafe { GetClientRect(hwnd, &mut cr); }
    let cw = cr.right - cr.left;
    let ch = cr.bottom - cr.top - state.toolbar_height;
    state.zoom = ((cw as f64 / state.image_width as f64)
        .min(ch as f64 / state.image_height as f64) * 0.95)
        .max(0.01);
    state.pan_x = 0.0;
    state.pan_y = 0.0;
    unsafe { InvalidateRect(Some(hwnd), None, true) };
}

pub fn rotate(state: &mut ViewerState) {
    state.rotation = (state.rotation + 90) % 360;
    if let Some(hwnd) = state.hwnd {
        unsafe { InvalidateRect(Some(hwnd), None, true) };
    }
}

pub fn flip_horizontal(state: &mut ViewerState) {
    state.flip_x = -state.flip_x;
    if let Some(hwnd) = state.hwnd {
        unsafe { InvalidateRect(Some(hwnd), None, true) };
    }
}

pub fn flip_vertical(state: &mut ViewerState) {
    state.flip_y = -state.flip_y;
    if let Some(hwnd) = state.hwnd {
        unsafe { InvalidateRect(Some(hwnd), None, true) };
    }
}

pub fn go_prev(state: &mut ViewerState) {
    if state.dir_files.len() <= 1 { return; }
    state.current_index = if state.current_index == 0 {
        state.dir_files.len() - 1
    } else {
        state.current_index - 1
    };
    let path = state.dir_files[state.current_index].clone();
    let _ = load_image(state, &path);
}

pub fn go_next(state: &mut ViewerState) {
    if state.dir_files.len() <= 1 { return; }
    state.current_index = if state.current_index >= state.dir_files.len() - 1 {
        0
    } else {
        state.current_index + 1
    };
    let path = state.dir_files[state.current_index].clone();
    let _ = load_image(state, &path);
}

pub fn handle_key_down(state: &mut ViewerState, vk: u32) {
    #[allow(non_upper_case_globals)]
    match vk as i32 {
        x if x == VK_ESCAPE.0 as i32 => {
            if let Some(hwnd) = state.hwnd {
                unsafe { DestroyWindow(hwnd).ok(); }
            }
        }
        x if x == VK_F11.0 as i32 => {
            crate::window::toggle_fullscreen(state);
        }
        x if x == VK_LEFT.0 as i32 => go_prev(state),
        x if x == VK_RIGHT.0 as i32 => go_next(state),
        x if x == VK_OEM_PLUS.0 as i32 || x == VK_ADD.0 as i32 => {
            state.zoom = (state.zoom * 1.1).min(20.0);
            if let Some(hwnd) = state.hwnd {
                unsafe { InvalidateRect(Some(hwnd), None, true) };
            }
        }
        x if x == VK_OEM_MINUS.0 as i32 || x == VK_SUBTRACT.0 as i32 => {
            state.zoom = (state.zoom * 0.9).max(0.01);
            if let Some(hwnd) = state.hwnd {
                unsafe { InvalidateRect(Some(hwnd), None, true) };
            }
        }
        _ => {}
    }
}

// ============================================================
// 图片加载 — 性能优化关键路径
// ============================================================

pub fn load_image(state: &mut ViewerState, file_path: &str) -> Result<(), String> {
    use std::time::Instant;

    let t_total = Instant::now();

    state.free_gdi();
    state.is_loading = true;
    state.error_message = None;
    state.file_path = file_path.to_string();

    // 1. 目录扫描（轻量操作）
    let t_dir = Instant::now();
    let (files, index) = scan_directory(file_path);
    state.dir_files = files;
    state.current_index = index;
    let dir_ms = t_dir.elapsed().as_millis();

    // 立刻刷新显示 Loading
    if let Some(hwnd) = state.hwnd {
        unsafe { InvalidateRect(Some(hwnd), None, true) };
    }

    // 1.5. 头预检：先读图片尺寸（不分配像素内存），超限直接拒绝
    let t_precheck = Instant::now();
    let path = std::path::Path::new(file_path);
    let (orig_w, orig_h) = {
        let reader = image::ImageReader::open(path)
            .map_err(|e| format!("Cannot open file: {}", e))?;
        let reader = reader
            .with_guessed_format()
            .map_err(|e| format!("Unknown format: {}", e))?;
        reader
            .into_dimensions()
            .map_err(|e| format!("Cannot read dimensions: {}", e))?
    };
    let precheck_ms = t_precheck.elapsed().as_millis();

    let pixels = orig_w as u64 * orig_h as u64;
    if pixels > MAX_PIXELS {
        let mp = pixels as f64 / 1_000_000.0;
        let max_mp = MAX_PIXELS as f64 / 1_000_000.0;
        let msg = format!(
            "Image too large: {}x{} = {:.1}MP (limit: {:.0}MP). Use a dedicated image viewer.",
            orig_w, orig_h, mp, max_mp
        );
        state.is_loading = false;
        state.error_message = Some(msg.clone());
        if let Some(hwnd) = state.hwnd {
            unsafe { InvalidateRect(Some(hwnd), None, true) };
        }
        log::warn!("[image_viewer] {}", msg);
        return Err(msg);
    }

    // 2. 解码图片（GDI+ 快速路径，对 30MB+ PNG 比 image crate 快 5-10x）
    let t_decode = Instant::now();
    let img = match snow_shot_app_services::gdiplus_decoder::decode_with_gdiplus(path) {
        Ok(img) => img,
        Err(e) => {
            state.is_loading = false;
            state.error_message = Some(format!("Cannot open image: {}", e));
            if let Some(hwnd) = state.hwnd {
                unsafe { InvalidateRect(Some(hwnd), None, true) };
            }
            log::error!("[image_viewer] 解码失败 {}: {}", file_path, e);
            return Err(e);
        }
    };
    let decode_ms = t_decode.elapsed().as_millis();

    // 3. 超大图降采样保护（参考 image_viewer_service::downscale_to_fit）
    let t_downscale = Instant::now();
    let img = super::render::downscale_to_fit(img);
    let downscale_ms = t_downscale.elapsed().as_millis();

    let (final_w, final_h) = img.dimensions();
    state.image_width = final_w as i32;
    state.image_height = final_h as i32;

    // 4. DynamicImage(RGBA) → HBITMAP — 完成后立刻 drop img 释放峰值内存
    let t_hbitmap = Instant::now();
    state.hbitmap = rgba_image_to_hbitmap(img);
    // img 已 move 进 rgba_image_to_hbitmap，无需手动 drop
    let hbitmap_ms = t_hbitmap.elapsed().as_millis();

    if state.hbitmap.is_none() {
        state.is_loading = false;
        state.error_message = Some("Failed to create GDI bitmap".into());
        if let Some(hwnd) = state.hwnd {
            unsafe { InvalidateRect(Some(hwnd), None, true) };
        }
        return Err("HBITMAP creation failed".into());
    }

    // 5. 初始化 GDI DC
    let screen_dc = unsafe { GetDC(None) };
    state.screen_dc = Some(screen_dc);
    state.mem_dc = Some(unsafe { CreateCompatibleDC(Some(screen_dc)) });

    state.is_loading = false;
    fit_to_window(state);

    // 6. 性能诊断日志
    let total_ms = t_total.elapsed().as_millis();
    let orig_mp = pixels as f64 / 1_000_000.0;
    let final_mp = (final_w as u64 * final_h as u64) as f64 / 1_000_000.0;
    let file_name = std::path::Path::new(file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("?");
    let size_hint = if downscale_ms > 0 {
        format!("\u{2192} {}x{} ({:.1}MP)", final_w, final_h, final_mp)
    } else {
        String::new()
    };
    
    log::info!(
        "[image_viewer] {} | orig {}x{} ({:.1}MP) {} | total {}ms (precheck {}ms, decode {}ms, downscale {}ms, hbitmap {}ms)",
        file_name, orig_w, orig_h, orig_mp, size_hint,
        total_ms, precheck_ms, decode_ms, downscale_ms, hbitmap_ms
    );

    // 最终刷新
    if let Some(hwnd) = state.hwnd {
        unsafe { InvalidateRect(Some(hwnd), None, true) };
    }

    Ok(())
}
