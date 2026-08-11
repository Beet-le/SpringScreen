// ============================================================
// 视图状态机 — zoom / pan / rotation / flip
// ============================================================

use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{HBITMAP, HDC};

/// 单级 mipmap
pub struct MipLevel {
    pub hbitmap: HBITMAP,
    pub width: i32,
    pub height: i32,
}

/// 图片查看器全局状态
pub struct ViewerState {
    // 窗口句柄
    pub hwnd: Option<HWND>,

    // 当前图片（全分辨率 HBITMAP）
    pub hbitmap: Option<HBITMAP>,
    pub image_width: i32,
    pub image_height: i32,

    // mipmap 链（从大到小，按需生成）
    pub mipmaps: Vec<MipLevel>,

    // GDI 渲染资源
    pub mem_dc: Option<HDC>,
    pub screen_dc: Option<HDC>,

    // 视图变换
    pub zoom: f64,
    pub pan_x: f64,
    pub pan_y: f64,
    pub rotation: i32, // 0, 90, 180, 270
    pub flip_x: f64, // 1.0 或 -1.0
    pub flip_y: f64, // 1.0 或 -1.0

    // 拖拽状态
    pub is_dragging: bool,
    pub drag_start_x: i32,
    pub drag_start_y: i32,
    pub drag_pan_start_x: f64,
    pub drag_pan_start_y: f64,

    // 窗口状态
    pub is_fullscreen: bool,
    pub saved_style: Option<u32>,
    pub saved_rect: Option<windows::Win32::Foundation::RECT>,

    // 工具栏
    pub toolbar_height: i32, // 底部工具栏高度（像素）

    // 导航
    pub file_path: String,
    pub dir_files: Vec<String>,
    pub current_index: usize,

    // 加载状态
    pub is_loading: bool,
    pub error_message: Option<String>,
}

impl ViewerState {
    pub fn new() -> Self {
        Self {
            hwnd: None,
            hbitmap: None,
            image_width: 0,
            image_height: 0,
            mipmaps: Vec::new(),
            mem_dc: None,
            screen_dc: None,
            zoom: 1.0,
            pan_x: 0.0,
            pan_y: 0.0,
            rotation: 0,
            flip_x: 1.0,
            flip_y: 1.0,
            is_dragging: false,
            drag_start_x: 0,
            drag_start_y: 0,
            drag_pan_start_x: 0.0,
            drag_pan_start_y: 0.0,
            is_fullscreen: false,
            saved_style: None,
            saved_rect: None,
            toolbar_height: 28,
            file_path: String::new(),
            dir_files: Vec::new(),
            current_index: 0,
            is_loading: true,
            error_message: None,
        }
    }

    /// 释放所有 GDI 资源
    pub fn free_gdi(&mut self) {
        use windows::Win32::Graphics::Gdi::{DeleteDC, DeleteObject, HGDIOBJ};

        // 释放 mipmap
        for mip in self.mipmaps.drain(..) {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(mip.hbitmap.0));
            }
        }

        // 释放主 HBITMAP
        if let Some(hb) = self.hbitmap.take() {
            unsafe {
                let _ = DeleteObject(HGDIOBJ(hb.0));
            }
        }

        // 释放 DC
        if let Some(dc) = self.mem_dc.take() {
            unsafe {
                let _ = DeleteDC(dc);
            }
        }
        if let Some(dc) = self.screen_dc.take() {
            unsafe {
                let _ = DeleteDC(dc);
            }
        }

        self.image_width = 0;
        self.image_height = 0;
        self.zoom = 1.0;
        self.pan_x = 0.0;
        self.pan_y = 0.0;
        self.rotation = 0;
        self.flip_x = 1.0;
        self.flip_y = 1.0;
    }
}
