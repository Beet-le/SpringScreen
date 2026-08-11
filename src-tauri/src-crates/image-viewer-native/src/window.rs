// ============================================================
// Win32 窗口创建 + WndProc 消息循环
// ============================================================
#![allow(unsafe_op_in_unsafe_fn)]

use std::ffi::c_void;

use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
    GetWindowLongPtrW, GetWindowRect, LoadCursorW, PostQuitMessage, RegisterClassW,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage, WNDCLASSW,
    WS_CAPTION, WS_OVERLAPPEDWINDOW, WS_POPUP, WS_SIZEBOX, WS_SYSMENU,
    WS_THICKFRAME, SW_SHOW, GWLP_USERDATA, GWL_STYLE, HWND_TOPMOST,
    SWP_FRAMECHANGED, SWP_NOZORDER, IDC_ARROW,
    WM_CREATE, WM_DESTROY, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP,
    WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_PAINT, WM_SIZE, WM_CLOSE,
};
use windows::Win32::Graphics::Gdi::{
    InvalidateRect, MonitorFromWindow, GetMonitorInfoW, MONITORINFO,
    MONITOR_DEFAULTTONEAREST,
};
use windows::core::PCWSTR;

use crate::state::ViewerState;
use crate::render::paint;
use crate::input;

const WINDOW_CLASS_NAME: &str = "SnowShotImageViewer\0";

pub fn create_and_run(file_path: &str) -> Result<(), String> {
    let hmodule = unsafe { GetModuleHandleW(None) }
        .map_err(|e| format!("GetModuleHandleW failed: {:?}", e))?;
    let hinstance = HINSTANCE(hmodule.0);

    register_window_class(hinstance)?;

    let state = Box::new(ViewerState::new());
    let state_ptr = Box::into_raw(state);

    let title: Vec<u16> = "SnowShot - Picture Viewer\0".encode_utf16().collect();
    let cls: Vec<u16> = WINDOW_CLASS_NAME.encode_utf16().collect();

    let hwnd = unsafe {
        CreateWindowExW(
            Default::default(),
            PCWSTR::from_raw(cls.as_ptr()),
            PCWSTR::from_raw(title.as_ptr()),
            WS_OVERLAPPEDWINDOW | WS_SIZEBOX | WS_THICKFRAME,
            0, 0, 800, 600,
            None, None,
            Some(hinstance),
            Some(state_ptr as *const c_void),
        )
    };

    let hwnd = match hwnd {
        Ok(h) => h,
        Err(e) => {
            unsafe { let _ = Box::from_raw(state_ptr); }
            return Err(format!("CreateWindowExW failed: {:?}", e));
        }
    };

    unsafe { ShowWindow(hwnd, SW_SHOW); }

    // 加载图片
    {
        let state: &mut ViewerState = unsafe {
            &mut *(GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ViewerState)
        };
        state.hwnd = Some(hwnd);
        let _ = input::load_image(state, file_path);
    }

    // 消息循环
    let mut msg = windows::Win32::UI::WindowsAndMessaging::MSG::default();
    loop {
        let ret = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if ret.0 == 0 || ret.0 == -1 { break; }
        unsafe { let _ = TranslateMessage(&msg); DispatchMessageW(&msg); }
    }

    Ok(())
}

fn register_window_class(hinstance: HINSTANCE) -> Result<(), String> {
    let cls: Vec<u16> = WINDOW_CLASS_NAME.encode_utf16().collect();
    let wc = WNDCLASSW {
        style: Default::default(),
        lpfnWndProc: Some(wndproc),
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: hinstance,
        hIcon: Default::default(),
        hCursor: unsafe { LoadCursorW(None, IDC_ARROW).unwrap_or(Default::default()) },
        hbrBackground: Default::default(),
        lpszMenuName: PCWSTR::null(),
        lpszClassName: PCWSTR::from_raw(cls.as_ptr()),
    };
    if unsafe { RegisterClassW(&wc) } == 0 {
        return Err("RegisterClassW failed".to_string());
    }
    Ok(())
}

extern "system" fn wndproc(
    hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM,
) -> LRESULT {
    // Rust 2024: unsafe extern fn 不再自动创建 unsafe 块，需要手动标注
    unsafe { wndproc_inner(hwnd, msg, wparam, lparam) }
}

unsafe fn wndproc_inner(
    hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_CREATE => {
            let cs = lparam.0 as *const windows::Win32::UI::WindowsAndMessaging::CREATESTRUCTW;
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, (*cs).lpCreateParams as isize);
            LRESULT(0)
        }
        WM_PAINT => {
            let sp = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ViewerState;
            if !sp.is_null() { paint(&mut *sp); }
            LRESULT(0)
        }
        WM_SIZE => LRESULT(0),
        WM_LBUTTONDOWN => {
            let sp = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ViewerState;
            if !sp.is_null() {
                input::handle_lbutton_down(
                    &mut *sp,
                    (lparam.0 & 0xFFFF) as i32,
                    ((lparam.0 >> 16) & 0xFFFF) as i32,
                );
            }
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let sp = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ViewerState;
            if !sp.is_null() {
                input::handle_mouse_move(
                    &mut *sp,
                    (lparam.0 & 0xFFFF) as i32,
                    ((lparam.0 >> 16) & 0xFFFF) as i32,
                );
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let sp = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ViewerState;
            if !sp.is_null() { input::handle_lbutton_up(&mut *sp); }
            LRESULT(0)
        }
        WM_MOUSEWHEEL => {
            let sp = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ViewerState;
            if !sp.is_null() {
                let delta = ((wparam.0 >> 16) & 0xFFFF) as i16;
                let sx = (lparam.0 & 0xFFFF) as i32;
                let sy = ((lparam.0 >> 16) & 0xFFFF) as i32;
                let mut wr = RECT::default();
                GetWindowRect(hwnd, &mut wr);
                input::handle_mouse_wheel(&mut *sp, delta, sx - wr.left, sy - wr.top);
            }
            LRESULT(0)
        }
        WM_KEYDOWN => {
            let sp = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ViewerState;
            if !sp.is_null() { input::handle_key_down(&mut *sp, wparam.0 as u32); }
            LRESULT(0)
        }
        WM_CLOSE => {
            let sp = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ViewerState;
            if !sp.is_null() {
                (*sp).free_gdi();
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                let _ = Box::from_raw(sp);
            }
            DestroyWindow(hwnd).ok();
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

pub fn toggle_fullscreen(state: &mut ViewerState) {
    let hwnd = match state.hwnd { Some(h) => h, None => return };
    unsafe {
        if state.is_fullscreen {
            if let Some(style) = state.saved_style {
                let _ = SetWindowLongPtrW(hwnd, GWL_STYLE, style as isize);
            }
            if let Some(ref rect) = state.saved_rect {
                let _ = SetWindowPos(
                    hwnd, None, rect.left, rect.top,
                    rect.right - rect.left, rect.bottom - rect.top,
                    SWP_NOZORDER | SWP_FRAMECHANGED,
                );
            }
            state.is_fullscreen = false;
        } else {
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
            state.saved_style = Some(style);
            let mut wr = RECT::default();
            GetWindowRect(hwnd, &mut wr);
            state.saved_rect = Some(wr);

            let new_style = (style
                & !(WS_CAPTION.0 | WS_THICKFRAME.0 | WS_SYSMENU.0))
                | WS_POPUP.0;
            let _ = SetWindowLongPtrW(hwnd, GWL_STYLE, new_style as isize);

            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut mi = MONITORINFO::default();
            mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            GetMonitorInfoW(monitor, &mut mi).ok();

            let _ = SetWindowPos(
                hwnd, Some(HWND_TOPMOST),
                mi.rcMonitor.left, mi.rcMonitor.top,
                mi.rcMonitor.right - mi.rcMonitor.left,
                mi.rcMonitor.bottom - mi.rcMonitor.top,
                SWP_NOZORDER | SWP_FRAMECHANGED,
            );
            state.is_fullscreen = true;
        }
        InvalidateRect(Some(hwnd), None, true);
    }
}
