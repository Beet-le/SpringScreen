// ============================================================
// GDI 渲染管线 — HBITMAP 创建 / mipmap 生成 / WM_PAINT 绘制
// ============================================================

use std::ptr;

use image::{DynamicImage, GenericImageView};
use image::imageops::FilterType;
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateDIBSection,
    CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect, GetDC,
    GetStockObject, ReleaseDC, SelectObject, SetBkMode, SetStretchBltMode, SetTextColor,
    StretchBlt, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HALFTONE, SRCCOPY,
    BLACK_BRUSH, TRANSPARENT, HDC, HBITMAP, HBRUSH, HGDIOBJ, PAINTSTRUCT,
    DT_CENTER, DT_SINGLELINE, DT_VCENTER, STRETCH_BLT_MODE,
};
use windows::Win32::Foundation::{COLORREF, RECT};
use windows::Win32::UI::WindowsAndMessaging::GetClientRect;

use crate::state::{MipLevel, ViewerState};

// ============================================================
// 超大图降采样保护
// ============================================================

/// 降采样后 level 0 的最长边上限（像素）。
const MAX_MIP0_DIM: u32 = 16384;

/// 降采样后 level 0 的总像素上限（约 50MP → 200MiB DIB）。
/// 20-30MB PNG 交互稿解压后通常 30-80MP，50MP 覆盖绝大多数场景。
const MAX_MIP0_PIXELS: u64 = 50_000_000;

/// 解码绝对上限（100MP → ~400MiB RGBA），超过则拒绝解码防止 OOM。
/// 对 20MB PNG 而言，100MP 足够；更大幅面的图会给出明确提示。
const MAX_PIXELS: u64 = 100_000_000;

/// 对超大图做降采样，确保同时满足最长边和像素数约束。
///
/// 参考 `image_viewer_service::downscale_to_fit`：
/// 先用 Triangle 滤波做整数减半（快），最后一步用 Lanczos3 精确缩放。
pub fn downscale_to_fit(img: DynamicImage) -> DynamicImage {
    let (mut w, mut h) = img.dimensions();
    let longest = w.max(h);
    let pixels = w as u64 * h as u64;

    let edge_scale = if longest > MAX_MIP0_DIM {
        MAX_MIP0_DIM as f64 / longest as f64
    } else {
        1.0
    };
    let pixel_scale = if pixels > MAX_MIP0_PIXELS {
        (MAX_MIP0_PIXELS as f64 / pixels as f64).sqrt()
    } else {
        1.0
    };
    let scale = edge_scale.min(pixel_scale);
    if scale >= 1.0 {
        return img;
    }

    let target_w = ((w as f64 * scale).round() as u32).max(1);
    let target_h = ((h as f64 * scale).round() as u32).max(1);

    // 快速整数减半阶段
    let mut img = img;
    while w / 2 >= target_w && h / 2 >= target_h && w > 1 && h > 1 {
        let next_w = (w / 2).max(1);
        let next_h = (h / 2).max(1);
        img = img.resize_exact(next_w, next_h, FilterType::Triangle);
        w = next_w;
        h = next_h;
    }

    if w == target_w && h == target_h {
        return img;
    }
    img.resize_exact(target_w, target_h, FilterType::Lanczos3)
}

// ============================================================
// DynamicImage(RGBA) → HBITMAP
// ============================================================

pub fn rgba_image_to_hbitmap(img: DynamicImage) -> Option<HBITMAP> {
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return None;
    }

    // into_rgba8() 对 ImageRgba8 变体是零开销（仅拆 enum 标记），不拷贝像素
    let rgba = img.into_rgba8();
    let rgba_ptr = rgba.as_ptr();
    let pixel_count = (w as usize) * (h as usize);

    let screen_dc = unsafe { GetDC(None) };

    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w as i32,
            biHeight: -(h as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: [Default::default()],
    };

    let mut bits: *mut std::ffi::c_void = ptr::null_mut();
    let hb = unsafe { CreateDIBSection(Some(screen_dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) };

    let result = match hb {
        Ok(hb) => {
            if !bits.is_null() {
                // 零中间分配：直接从 RGBA buffer 写入 DIB 内存，边读边做 R↔B 交换
                // 使用裸指针跳过所有边界检查，编译器可自动向量化（SIMD）
                unsafe {
                    let src = rgba_ptr;
                    let dst = bits as *mut u8;
                    for i in 0..pixel_count {
                        let o = i * 4;
                        *dst.add(o) = *src.add(o + 2);       // B ← R
                        *dst.add(o + 1) = *src.add(o + 1);   // G ← G
                        *dst.add(o + 2) = *src.add(o);       // R ← B
                        *dst.add(o + 3) = *src.add(o + 3);   // A ← A
                    }
                }
            }
            Some(hb)
        }
        Err(_) => None,
    };

    unsafe { let _ = ReleaseDC(None, screen_dc); }
    // rgba 在此 drop，像素已全部写入 DIB
    result
}

// ============================================================
// Mipmap 生成
// ============================================================

pub fn get_or_create_mipmap(
    state: &mut ViewerState,
    render_wide: i32,
    render_high: i32,
) -> Option<(HBITMAP, i32, i32)> {
    let hbitmap = state.hbitmap?;
    let img_w = state.image_width;
    let img_h = state.image_height;

    if render_wide >= img_w && render_high >= img_h {
        return Some((hbitmap, img_w, img_h));
    }
    let mip1_w = (img_w + 1) / 2;
    let mip1_h = (img_h + 1) / 2;
    if mip1_w <= 1 && mip1_h <= 1 {
        return Some((hbitmap, img_w, img_h));
    }
    if render_wide >= mip1_w || render_high >= mip1_h {
        return Some((hbitmap, img_w, img_h));
    }

    let mut best_hbitmap = hbitmap;
    let mut best_w = img_w;
    let mut best_h = img_h;
    let mut cur_w = mip1_w;
    let mut cur_h = mip1_h;
    let mut level_idx = 0usize;

    loop {
        if cur_w <= 1 && cur_h <= 1 { break; }

        if level_idx >= state.mipmaps.len() {
            let screen_dc = state.screen_dc?;
            unsafe {
                let src_dc = CreateCompatibleDC(Some(screen_dc));
                let dst_dc = CreateCompatibleDC(Some(screen_dc));
                let old_src = SelectObject(src_dc, HGDIOBJ(hbitmap.0));

                let new_hb = CreateCompatibleBitmap(screen_dc, cur_w, cur_h);
                let old_dst = SelectObject(dst_dc, HGDIOBJ(new_hb.0));
                let old_mode = SetStretchBltMode(dst_dc, HALFTONE);
                let _ = StretchBlt(
                    dst_dc, 0, 0, cur_w, cur_h,
                    Some(src_dc), 0, 0, best_w, best_h,
                    SRCCOPY,
                );
                SetStretchBltMode(dst_dc, STRETCH_BLT_MODE(old_mode));
                SelectObject(dst_dc, old_dst);
                SelectObject(src_dc, old_src);
                let _ = DeleteDC(src_dc);
                let _ = DeleteDC(dst_dc);

                state.mipmaps.push(MipLevel { hbitmap: new_hb, width: cur_w, height: cur_h });
            }
        }

        let mip = &state.mipmaps[level_idx];
        best_hbitmap = mip.hbitmap;
        best_w = mip.width;
        best_h = mip.height;

        let nw = (cur_w + 1) / 2;
        let nh = (cur_h + 1) / 2;
        if nw <= 1 && nh <= 1 { break; }
        if render_wide >= nw || render_high >= nh {
            return Some((best_hbitmap, best_w, best_h));
        }
        cur_w = nw.max(1);
        cur_h = nh.max(1);
        level_idx += 1;
    }

    Some((best_hbitmap, best_w, best_h))
}

// ============================================================
// WM_PAINT 绘制
// ============================================================

pub fn paint(state: &mut ViewerState) {
    let hwnd = match state.hwnd { Some(h) => h, None => return };

    let mut ps = PAINTSTRUCT::default();
    let paint_dc = unsafe { BeginPaint(hwnd, &mut ps) };

    let mut cr = RECT::default();
    unsafe { GetClientRect(hwnd, &mut cr) };
    let cw = cr.right - cr.left;
    let ch = cr.bottom - cr.top;
    let image_h = ch - state.toolbar_height;

    // 背景
    {
        let bg = unsafe { GetStockObject(BLACK_BRUSH) };
        let brush = HBRUSH(bg.0);
        unsafe {
            FillRect(paint_dc, &RECT { left: 0, top: 0, right: cw, bottom: image_h }, brush);
        }
    }

    if state.is_loading {
        draw_centered_text(paint_dc, cw, image_h, "Loading...", 0x888888);
    } else if let Some(ref err) = state.error_message {
        draw_centered_text(paint_dc, cw, image_h, err, 0xEE8888);
    } else if state.hbitmap.is_some() && state.image_width > 0 && state.image_height > 0 {
        let zoom = state.zoom.max(0.01);
        let rw = (state.image_width as f64 * zoom).round() as i32;
        let rh = (state.image_height as f64 * zoom).round() as i32;
        let rx = cw / 2 + state.pan_x as i32 - rw / 2;
        let ry = image_h / 2 + state.pan_y as i32 - rh / 2;

        if let Some((mip_hb, mip_w, mip_h)) = get_or_create_mipmap(state, rw, rh) {
            unsafe {
                let mem_dc = CreateCompatibleDC(Some(paint_dc));
                let old_bmp = SelectObject(mem_dc, HGDIOBJ(mip_hb.0));

                // HALFTONE 对缩小和放大均提供最高质量（GDI 不支持双三次，HALFTONE 是最佳可用）
                let old_mode = SetStretchBltMode(paint_dc, HALFTONE);
                // SetBrushOrgEx 对齐 halftone 调色板原点，避免缩放时出现偏移条纹
                windows::Win32::Graphics::Gdi::SetBrushOrgEx(paint_dc, -rx, -ry, None);

                if rw == mip_w && rh == mip_h {
                    let _ = BitBlt(paint_dc, rx, ry, rw, rh, Some(mem_dc), 0, 0, SRCCOPY);
                } else {
                    let _ = StretchBlt(
                        paint_dc, rx, ry, rw, rh,
                        Some(mem_dc), 0, 0, mip_w, mip_h,
                        SRCCOPY,
                    );
                }

                SetStretchBltMode(paint_dc, STRETCH_BLT_MODE(old_mode));
                SelectObject(mem_dc, old_bmp);
                let _ = DeleteDC(mem_dc);
            }
        }
    }

    // 工具栏
    draw_toolbar(paint_dc, cw, ch, state.toolbar_height, state);

    unsafe { let _ = EndPaint(hwnd, &ps); }
}

fn draw_centered_text(dc: HDC, w: i32, h: i32, text: &str, color_rgb: u32) {
    unsafe {
        SetBkMode(dc, TRANSPARENT);
        let _ = SetTextColor(dc, COLORREF(color_rgb));
    }
    let mut rect = RECT { left: 0, top: 0, right: w, bottom: h };
    let mut utf16: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { let _ = DrawTextW(dc, &mut utf16, &mut rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE); }
}

fn draw_toolbar(dc: HDC, cw: i32, ch: i32, tb_h: i32, state: &ViewerState) {
    let tb_top = ch - tb_h;
    if tb_top < 0 { return; }

    let bg = unsafe { CreateSolidBrush(COLORREF(0x002D2D2D)) };
    unsafe {
        let brush = HBRUSH(bg.0);
        FillRect(dc, &RECT { left: 0, top: tb_top, right: cw, bottom: ch }, brush);
        let _ = DeleteObject(HGDIOBJ(bg.0));
    }

    unsafe {
        SetBkMode(dc, TRANSPARENT);
        let _ = SetTextColor(dc, COLORREF(0x00CCCCCC));
    }

    let file_name = std::path::Path::new(&state.file_path)
        .file_name().and_then(|n| n.to_str()).unwrap_or("(no file)");
    let zoom_pct = (state.zoom * 100.0).round() as i32;

    let info = if state.dir_files.len() > 1 {
        format!("{}  |  {}x{}  |  {}%  |  {}/{}",
            file_name, state.image_width, state.image_height, zoom_pct,
            state.current_index + 1, state.dir_files.len())
    } else {
        format!("{}  |  {}x{}  |  {}%", file_name, state.image_width, state.image_height, zoom_pct)
    };

    let mut rect = RECT { left: 8, top: tb_top + 4, right: cw - 8, bottom: ch - 4 };
    let mut utf16: Vec<u16> = info.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { let _ = DrawTextW(dc, &mut utf16, &mut rect, DT_SINGLELINE | DT_VCENTER); }
}
