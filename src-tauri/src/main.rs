// 禁止 Windows 发行版弹出控制台窗口，请勿删除此属性!!
// 将 Windows 子系统设置为 "windows"，隐藏控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// ============================================================
// dhat 堆内存性能分析模式（仅在启用 dhat-heap feature 时编译）
// ============================================================

#[cfg(feature = "dhat-heap")]
use app_lib::PROFILER;

#[cfg(feature = "dhat-heap")]
#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

#[cfg(feature = "dhat-heap")]
#[tokio::main]
async fn main() {
    #[cfg(feature = "dhat-heap")]
    PROFILER.lock().await.replace(dhat::Profiler::new_heap());

    snow_shot_lib::run();
}

// ============================================================
// 正常启动模式（非 dhat 性能分析）
// ============================================================

/// Windows 下 --auto_start 自启动延迟（秒）
/// 延迟较长是为了等待系统服务完全就绪后再启动截图功能
#[cfg(target_os = "windows")]
const DELAY_SECONDS: u64 = 10;

/// macOS 下 --auto_start 自启动延迟（秒）
/// macOS 系统启动较快，延迟较短
#[cfg(target_os = "macos")]
const DELAY_SECONDS: u64 = 3;

#[cfg(not(feature = "dhat-heap"))]
fn main() {
    // ============================================================
    // 【Windows 专属】隐藏启动时闪现的控制台窗口
    // 背景：Windows 通过文件关联（"打开方式"/拖拽到 exe）启动应用时，
    //       即使设置了 windows_subsystem = "windows"，控制台窗口仍可能短暂闪现。
    //       在 main() 最开始调用 FreeConsole() 彻底分离控制台，消除闪现。
    // ============================================================
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::System::Console::{FreeConsole, GetConsoleWindow};
        use windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow;
        let hwnd = unsafe { GetConsoleWindow() };
        if !hwnd.is_null() {
            unsafe { ShowWindow(hwnd, 0) }; // SW_HIDE = 0
        }
        unsafe { FreeConsole() };
    }

    // 设置全局 panic 钩子，捕获崩溃时的调用栈信息并记录到日志
    let default_panic = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        use std::backtrace::Backtrace;

        let backtrace = Backtrace::force_capture();
        log::error!("Panic: {info}\n{backtrace}");
        default_panic(info);
    }));

    // ============================================================
    // --auto_start 自启动延迟逻辑
    // 背景：系统开机自启时，某些系统服务（如显卡驱动、COM 组件等）可能尚未初始化完成，
    //       此时立即启动截图可能导致黑屏或截图失败。通过延迟等待可提高启动成功率。
    // ============================================================
    let args: Vec<String> = std::env::args().collect();
    if args.contains(&"--auto_start".to_string()) {
        println!(
            "[main] --auto_start parameter detected, delaying {} seconds before starting",
            DELAY_SECONDS
        );
        // 阻塞当前线程等待系统就绪，期间不初始化任何 Tauri/WebView 资源
        std::thread::sleep(std::time::Duration::from_secs(DELAY_SECONDS));
    }

    // 入口：将所有控制权交给 Tauri 应用的 lib.rs run() 函数
    snow_shot_lib::run();
}
