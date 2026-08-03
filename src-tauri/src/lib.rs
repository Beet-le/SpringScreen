// ============================================================
// 模块声明 - Tauri 后端各功能模块的路由入口
// ============================================================
pub mod core;            // 核心功能：自启动、窗口管理、提权重启等
pub mod file;            // 文件操作：读写、复制、删除、路径管理
pub mod global_state;    // 全局状态管理：截图状态同步、快捷键映射
pub mod hot_load_page;   // 热加载页面管理（动态注册新的 Tauri 窗口路由）
pub mod http_services;   // HTTP 服务：云端上传（S3）
pub mod listen_key;      // 键盘/鼠标监听服务
pub mod ocr;             // OCR 文字识别
pub mod plugin;          // 插件系统
pub mod screenshot;      // 截图功能核心：触发截图、draw 窗口管理
pub mod scroll_screenshot; // 滚动截图
pub mod video_record;    // 录屏功能
pub mod config;          // 应用配置持久化（图片查看器窗口状态等）
pub mod image_viewer;  // 图片查看器窗口管理
pub mod webview;         // WebView 共享缓冲区（GPU 零拷贝传输）

use snow_shot_app_services::listen_mouse_service;
use snow_shot_tauri_commands_core::{FullScreenDrawWindowLabels, VideoRecordWindowLabels};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use tauri::Emitter;
use tokio::sync::Mutex;

use tauri::Manager;

use snow_shot_app_shared::AppConfig;
use snow_shot_app_os::ui_automation::UIElements;
use snow_shot_app_scroll_screenshot_service::scroll_screenshot_capture_service;
use snow_shot_app_scroll_screenshot_service::scroll_screenshot_image_service;
use snow_shot_app_scroll_screenshot_service::scroll_screenshot_service;
use snow_shot_app_services::file_cache_service;
use snow_shot_app_services::free_drag_window_service;
use snow_shot_app_services::hot_load_page_service;
use snow_shot_app_services::listen_key_service;
use snow_shot_app_services::ocr_service::OcrService;
use snow_shot_app_services::resize_window_service;
use snow_shot_app_services::video_record_service;
use snow_shot_app_shared::EnigoManager;
use snow_shot_global_state::{
    CaptureState, ReadClipboardState, ScreenshotShortcutMap, WebViewSharedBufferState,
};
use snow_shot_plugin_service::plugin_service;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

// ============================================================
// 文件级诊断日志，绕过 tauri-plugin-log 的 filter，确保 release 模式下也能看到关键诊断信息
// 日志写入到 app config 目录下的 debug/single-instance.log
// ============================================================

/// 文件级诊断日志，绕过 tauri-plugin-log 的 filter，确保 release 模式下也能看到关键诊断信息
/// 日志写入到 app config 目录下的 `debug/single-instance.log`
#[allow(dead_code)]
fn debug_log(app: &tauri::AppHandle, msg: &str) {
    if let Ok(config_dir) = app.path().app_config_dir() {
        let debug_dir = config_dir.join("debug");
        let _ = std::fs::create_dir_all(&debug_dir);
        let log_path = debug_dir.join("single-instance.log");
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let line = format!("[{}] {}\n", timestamp, msg);
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
    }
}

// ============================================================
// --open-draw 触发防抖机制
// 防止短时间内重复触发截图（如快捷键连按、多实例同时启动等场景）
// ============================================================

#[cfg(feature = "dhat-heap")]
pub static PROFILER: std::sync::LazyLock<Mutex<Option<dhat::Profiler>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

/// 是否正在触发 --open-draw 流程中（原子标志，防止并发重复触发）
static OPEN_DRAW_TRIGGERING: AtomicBool = AtomicBool::new(false);
/// 上一次触发 --open-draw 的时间戳（毫秒），用于防抖判断
static LAST_OPEN_DRAW_TRIGGER_AT_MS: AtomicU64 = AtomicU64::new(0);
/// --open-draw 重复触发的防抖窗口期（毫秒）
const OPEN_DRAW_TRIGGER_DEBOUNCE_MS: u64 = 1200;

/// 检查当前是否可以触发 open-draw 截图
/// 使用 CAS（Compare-And-Swap）无锁算法实现线程安全的防抖检查
fn can_trigger_open_draw_now(now_ms: u64) -> bool {
    loop {
        let last_ms = LAST_OPEN_DRAW_TRIGGER_AT_MS.load(Ordering::SeqCst);
        // 距上次触发不足防抖窗口期，拒绝本次触发
        if now_ms.saturating_sub(last_ms) < OPEN_DRAW_TRIGGER_DEBOUNCE_MS {
            return false;
        }

        // CAS 原子更新最后触发时间，成功则允许触发
        if LAST_OPEN_DRAW_TRIGGER_AT_MS
            .compare_exchange(last_ms, now_ms, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            return true;
        }
    }
}

/// 检测命令行参数中是否包含 `--open-draw`
/// 该参数由 C# 托盘服务或外部调用传入，用于触发一次截图
fn has_open_draw_arg(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--open-draw")
}

/// 检查命令行参数中是否包含图片文件路径
/// 当用户通过"右键 → 打开方式"或"拖拽文件到 exe"启动时，Windows 会将文件路径作为参数传入
fn extract_image_path_from_args(args: &[String]) -> Option<String> {
    for arg in args {
        // 跳过以 -- 开头的参数（如 --open-draw, --auto_start）
        if arg.starts_with("--") {
            continue;
        }
        // 检查是否是图片文件扩展名
        let lower = arg.to_lowercase();
        if lower.ends_with(".png") || lower.ends_with(".jpg")
            || lower.ends_with(".jpeg") || lower.ends_with(".webp")
            || lower.ends_with(".bmp") || lower.ends_with(".gif")
            || lower.ends_with(".tiff") || lower.ends_with(".tif")
        {
            return Some(arg.clone());
        }
    }
    None
}

/// 【Windows 专属】在 --open-draw 模式下，预清理崩溃进程残留的单实例互斥锁
///
/// 背景：当 C# 托盘服务在旧进程崩溃后立即重启新进程时，崩溃进程持有的
///       single-instance Mutex 可能仍处于 abandoned 状态。
///       如果不清理，tauri-plugin-single-instance 会看到 ERROR_ALREADY_EXISTS
///       但 FindWindowW 返回 null（隐藏窗口不存在），进入僵尸状态。
///
/// 策略：获取 abandoned mutex 的所有权后立即释放，不保留额外句柄，
///       等待 OS 完成内核对象回收后让插件重新创建干净的互斥锁。
///
/// 注意：此函数会短暂获取 mutex 所有权（WAIT_ABANDONED），但会立即释放。
#[cfg(target_os = "windows")]
fn pre_acquire_single_instance_mutex_if_open_draw() {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    // 仅请求 SYNCHRONIZE 权限：最小化访问权限，避免不必要的权限提升
    use windows_sys::Win32::System::Threading::{OpenMutexW, ReleaseMutex, WaitForSingleObject};

    // SYNCHRONIZE = 0x00100000（等待/获取互斥锁所需的最小权限）
    const SYNCHRONIZE: u32 = 0x00100000;
    // WAIT_OBJECT_0 = 0, WAIT_ABANDONED = 0x80（Win32 API 常量，windows-sys 未导出）
    const WAIT_OBJECT_0: u32 = 0x00000000;
    const WAIT_ABANDONED: u32 = 0x00000080;

    let args: Vec<String> = std::env::args().collect();
    // 非 open-draw 模式下不需要预检查
    if !has_open_draw_arg(&args) {
        return;
    }

    // 互斥锁名称格式与 tauri_plugin_single_instance 保持一致：{identifier}-sim
    // identifier 即为 tauri.conf.json 中的 "XiaoDaShuai"
    let mutex_name = "XiaoDaShuai-sim";
    let wide_name: Vec<u16> = OsStr::new(mutex_name)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    const MAX_RETRIES: u32 = 3;
    // 释放 abandoned mutex 后等待 OS 完成内核对象回收的时间
    // 需要足够长，确保插件 CreateMutex 时不会看到残留的核对象
    const RETRY_DELAY_MS: u64 = 1000;
    // 每次等待 200ms，如果活跃进程持有锁则会超时
    const WAIT_TIMEOUT_MS: u32 = 200;

    for attempt in 0..=MAX_RETRIES {
        // 仅以 SYNCHRONIZE 权限打开互斥锁，最小化权限需求
        let hmutex: HANDLE =
            unsafe { OpenMutexW(SYNCHRONIZE, false.into(), wide_name.as_ptr()) };

        if hmutex.is_null() {
            // 互斥锁不存在 —— 无残留锁，正常继续
            if attempt == 0 {
                log::debug!("[single-instance-pre-check] No existing mutex found, proceeding normally");
            }
            return;
        }

        // 互斥锁存在，短暂等待看是否被释放（崩溃进程清理后的 abandoned 状态）
        let wait_result = unsafe { WaitForSingleObject(hmutex, WAIT_TIMEOUT_MS) };

        match wait_result {
            WAIT_OBJECT_0 | WAIT_ABANDONED => {
                // WaitForSingleObject 返回 WAIT_OBJECT_0/WAIT_ABANDONED 时，调用线程已获取 mutex 所有权
                // 必须先 ReleaseMutex 归还所有权，再 CloseHandle 释放句柄，否则 mutex 泄露
                // 释放后不保留任何额外句柄，让 OS 能完全回收内核对象
                unsafe { ReleaseMutex(hmutex) };
                unsafe { CloseHandle(hmutex) };
                log::debug!(
                    "[single-instance-pre-check] Mutex released at attempt {} (result={}), waiting {}ms for OS cleanup...",
                    attempt,
                    wait_result,
                    RETRY_DELAY_MS
                );
                // 等待 OS 完成内核对象回收，避免插件看到残留互斥锁进入僵尸状态
                std::thread::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS));
                if attempt < MAX_RETRIES {
                    continue;
                }
                return;
            }
            _ => {
                // WAIT_TIMEOUT：活跃进程持有互斥锁，未获取所有权，仅关闭句柄后退出
                unsafe { CloseHandle(hmutex) };
                log::debug!(
                    "[single-instance-pre-check] Live process owns mutex at attempt {}, bailing out",
                    attempt
                );
                return;
            }
        }
    }
}

/// 打开 draw 页面并执行一次截图（--open-draw 触发的主流程）
///
/// 流程：
/// 1. 防抖检查：拒绝 1200ms 内的重复触发
/// 2. 原子标志检查：防止并发重复执行
/// 3. 异步调用 trigger_screenshot_core 执行实际截图
fn schedule_open_draw(app: tauri::AppHandle) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    // 防抖：距上次触发不足 1200ms 则跳过
    if !can_trigger_open_draw_now(now_ms) {
        log::info!("[schedule_open_draw] skipped: within debounce window ({}ms)", OPEN_DRAW_TRIGGER_DEBOUNCE_MS);
        return;
    }

    // 原子标志：如果已有执行中的 open-draw 流程，则跳过
    if OPEN_DRAW_TRIGGERING.swap(true, Ordering::SeqCst) {
        log::info!("[schedule_open_draw] skipped: already triggering in progress");
        return;
    }

    log::info!("[schedule_open_draw] triggered, spawning trigger_screenshot_core...");
    tauri::async_runtime::spawn(async move {
        screenshot::trigger_screenshot_core(&app, "default".to_string(), None, None).await;

        OPEN_DRAW_TRIGGERING.store(false, Ordering::SeqCst);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // ============================================================
    // Layer 2: 必须在任何 WebView2 实例创建前设置环境变量
    // 禁用 Chromium 的后台节流、GPU 超时等节能策略，确保截图窗口响应速度
    // ============================================================
    #[cfg(target_os = "windows")]
    {
        snow_shot_app_os::efficiency_mode::set_webview2_chromium_args();
    }

    // ============================================================
    // Windows 崩溃重启场景：预清理残留的单实例互斥锁
    // 当 C# 托盘服务在旧进程崩溃后重启新进程时，OS 可能尚未释放崩溃进程的内核对象
    // ============================================================
    #[cfg(target_os = "windows")]
    pre_acquire_single_instance_mutex_if_open_draw();

    // ============================================================
    // 初始化所有后端服务实例（均通过 Tauri 状态管理注入）
    // ============================================================
    let ocr_instance = Mutex::new(OcrService::new());
    let video_record_service = Mutex::new(video_record_service::VideoRecordService::new());
    let hot_load_page_service = Arc::new(hot_load_page_service::HotLoadPageService::new());
    let enigo_instance = Mutex::new(EnigoManager::new());

    let ui_elements = Mutex::new(UIElements::new());

    let scroll_screenshot_service =
        Mutex::new(scroll_screenshot_service::ScrollScreenshotService::new());
    let scroll_screenshot_image_service =
        Mutex::new(scroll_screenshot_image_service::ScrollScreenshotImageService::new());
    let scroll_screenshot_capture_service =
        Mutex::new(scroll_screenshot_capture_service::ScrollScreenshotCaptureService::new());
    #[cfg(target_os = "windows")]
    let shared_buffer_service = Arc::new(snow_shot_webview::SharedBufferService::new());

    let free_drag_window_service =
        Mutex::new(free_drag_window_service::FreeDragWindowService::new());
    let resize_window_service = Mutex::new(resize_window_service::ResizeWindowService::new());

    let listen_key_service = Mutex::new(listen_key_service::ListenKeyService::new());
    let listen_mouse_service = Mutex::new(listen_mouse_service::ListenMouseService::new());

    let file_cache_service = Arc::new(file_cache_service::FileCacheService::new());

    let enable_run_log = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let enable_run_log_clone = enable_run_log.clone();

    let plugin_service = Arc::new(plugin_service::PluginService::new());

    // 截图全局状态：是否正在截图中（互斥锁保护）
    let capture_state = Mutex::new(CaptureState { capturing: false });

    let full_screen_draw_window_labels = Mutex::new(Option::<FullScreenDrawWindowLabels>::None);
    let video_record_window_label = Mutex::new(Option::<VideoRecordWindowLabels>::None);

    let webview_shared_buffer_state = WebViewSharedBufferState::new(false);

    let read_clipboard_state = Mutex::new(ReadClipboardState { reading: false });

    // 应用配置（图片查看器窗口状态等，持久化到 config.json）
    // 延迟到 setup 中从文件加载，此处先创建默认值
    let app_config = Arc::new(StdMutex::new(AppConfig::default()));
    let app_config_for_setup = app_config.clone();

    // 截图快捷键 -> 截图类型映射表（由前端同步）
    let screenshot_shortcut_map: Mutex<ScreenshotShortcutMap> = Mutex::new(std::collections::HashMap::new());

    use tauri_plugin_log::{Target, TargetKind};

    // ============================================================
    // 日志配置：debug 模式下输出到 stdout + 文件 + WebView；release 模式仅文件
    // 注意：release 下不移除 log 插件初始化，避免前端调用 log 时反复报错
    // ============================================================
    let log_targets: Vec<Target> = if cfg!(debug_assertions) {
        vec![
            Target::new(TargetKind::Stdout),
            Target::new(TargetKind::LogDir { file_name: None }),
            Target::new(TargetKind::Webview),
        ]
    } else {
        vec![Target::new(TargetKind::LogDir { file_name: None })]
    };
    let log_level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };

    // 延迟创建图片查看器：存储待处理的图片路径，等主窗口 page-load 后再创建
    // 原因：setup 回调执行时 HTTP server 可能尚未就绪，过早创建窗口会导致 ERR_CONNECTION_REFUSED
    let pending_image_path: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));

    // on_page_load 回调：主窗口页面加载完成后，检查是否有待创建的图片查看器
    let pending_image_path_for_load = pending_image_path.clone();
    let on_page_load_handler = move |webview: &tauri::Webview, payload: &tauri::webview::PageLoadPayload| {
        if let tauri::webview::PageLoadEvent::Finished = payload.event() {
            // 仅处理主窗口的 page-load 事件
            if webview.window().label() != "main" {
                return;
            }
            let path_clone = pending_image_path_for_load.lock().unwrap().take();
            if let Some(image_path) = path_clone {
                let app_handle = webview.app_handle().clone();
                let image_path_log = image_path.clone();
                log::info!("[on_page_load] creating image viewer for path '{}'", image_path_log);
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = snow_shot_tauri_commands_core::create_image_viewer_window(
                        app_handle,
                        image_path,
                    ).await {
                        log::error!("[on_page_load] create_image_viewer_window failed for path '{}': {}", image_path_log, e);
                    }
                });
            }
        }
    };

    #[allow(unused_mut)]
    let mut app_builder = tauri::Builder::default()
        .on_page_load(on_page_load_handler)
        // ---- Tauri 插件链 ----
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION,
                )
                .with_filter(|label| label == "main")
                .build(),
        )
        .plugin(tauri_plugin_os::init())
        // -- single-instance: 单实例插件，处理多开请求 --
        // 当检测到已有实例运行时，通过回调将 --open-draw 参数转发给主实例
        .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
            // 文件级日志：绕过 tauri-plugin-log filter，release 下也可见
            debug_log(app, &format!("[single_instance] callback triggered, argv={:?}", argv));
            log::info!("[single_instance] callback triggered, argv={:?}", argv);
            if has_open_draw_arg(&argv) {
                // 次要实例携带 --open-draw 参数：通知主实例执行截图
                debug_log(app, "[single_instance] branch: --open-draw");
                log::info!("[single_instance] branch: --open-draw, scheduling screenshot");
                schedule_open_draw(app.clone());
            } else if let Some(image_path) = extract_image_path_from_args(&argv) {
                // 次要实例收到图片文件路径，在主实例中打开图片查看器
                debug_log(app, &format!("[single_instance] branch: image path = {}", image_path));
                log::info!("[single_instance] branch: image path '{}', creating image viewer", image_path);
                let app_clone = app.clone();
                let image_path_log = image_path.clone();
                tauri::async_runtime::spawn(async move {
                    match snow_shot_tauri_commands_core::create_image_viewer_window(
                        app_clone.clone(),
                        image_path,
                    ).await {
                        Ok(_) => debug_log(&app_clone, &format!("[single_instance] create_image_viewer_window succeeded for path '{}'", image_path_log)),
                        Err(e) => {
                            debug_log(&app_clone, &format!("[single_instance] create_image_viewer_window FAILED for path '{}': {}", image_path_log, e));
                            log::error!("[single_instance] create_image_viewer_window failed for path '{}': {}", image_path_log, e);
                        }
                    }
                });
            } else {
                // 普通的多开请求：激活并显示主窗口
                debug_log(app, "[single_instance] branch: activate main window");
                log::info!("[single_instance] branch: activate main window");
                let app_window = app.get_webview_window("main").expect("no main window");
                app_window.show().unwrap();
                app_window.unminimize().unwrap();
                app_window.set_focus().unwrap();
            }
        }))
        .plugin(tauri_plugin_macos_permissions::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        // -- autostart: 自启动插件，通过 --auto_start 参数启动 --
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--auto_start"]),
        ))
        .plugin(tauri_plugin_clipboard::init())
        .plugin(tauri_plugin_dialog::init())
        // -- global-shortcut: 全局快捷键插件 --
        // Rust 侧直接处理快捷键事件，绕过前端 IPC，作为 JS 侧 WebView 冻结时的兜底通道
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    // 只响应按键按下事件
                    if event.state != ShortcutState::Pressed {
                        return;
                    }

                    let shortcut_str = shortcut.to_string();

                    // 从 Rust 状态中查询该快捷键对应的截图类型（由前端通过 sync_screenshot_shortcuts 同步）
                    let app_clone = app.clone();
                    let shortcut_str_clone = shortcut_str.clone();
                    tauri::async_runtime::spawn(async move {
                        let t_shortcut = std::time::Instant::now();
                        let map = app_clone.state::<Mutex<ScreenshotShortcutMap>>();
                        let screenshot_type = map.lock().await.get(&shortcut_str_clone).cloned();

                        if let Some(screenshot_type) = screenshot_type {
                            log::debug!(
                                "[screenshot-perf] Rust shortcut handler fired, shortcut='{}', type={}, lookup: {}ms",
                                shortcut_str_clone,
                                screenshot_type,
                                t_shortcut.elapsed().as_millis()
                            );
                            // 直接调用 Rust 侧 trigger_screenshot_core，跳过前端 IPC 链路
                            crate::screenshot::trigger_screenshot_core(
                                &app_clone,
                                screenshot_type,
                                None,
                                None,
                            )
                            .await;
                            log::debug!(
                                "[screenshot-perf] Rust shortcut trigger_screenshot_core done, total: {}ms",
                                t_shortcut.elapsed().as_millis()
                            );
                        }
                    });
                })
                .build(),
        )
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        // -- log 插件：支持运行时过滤，release 模式默认关闭日志 --
        .plugin(
            tauri_plugin_log::Builder::default()
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .targets(log_targets)
                .level(log_level)
                .filter(move |_| {
                    #[cfg(debug_assertions)]
                    {
                        return true;
                    }

                    #[cfg(not(debug_assertions))]
                    {
                        // release 模式下由前端通过 set_run_log 控制是否输出日志
                        return enable_run_log.load(std::sync::atomic::Ordering::Relaxed);
                    }
                })
                .build(),
        )
        // ============================================================
        // setup: 应用初始化完成后的配置
        // ============================================================
        .setup(move |app| {
            // 安全获取主窗口：如果不存在则记录错误并提前返回，避免 panic 导致进程终止
            let main_window = match app.get_webview_window("main") {
                Some(w) => w,
                None => {
                    log::error!("[lib::setup] no main window found, skipping setup");
                    return Ok(());
                }
            };

            let args: Vec<String> = std::env::args().collect();
            if has_open_draw_arg(&args) {
                // 主实例启动时也支持 --open-draw：直接触发截图
                debug_log(app.handle(), "[setup] --open-draw detected, calling schedule_open_draw");
                schedule_open_draw(app.handle().clone());
            } else if let Some(image_path) = extract_image_path_from_args(&args) {
                // 检查是否通过"打开方式"或拖拽传递了图片文件
                // 注意：不在此处创建窗口，HTTP server 可能尚未就绪
                // 延迟到主窗口 page-load 事件触发后再创建
                debug_log(app.handle(), &format!("[setup] image path detected, storing as pending: {}", image_path));
                *pending_image_path.lock().unwrap() = Some(image_path);
            }

            #[cfg(target_os = "windows")]
            {
                // Layer 1: 禁用主进程的 Windows 效能模式（Efficiency Mode）
                // 防止系统将截图进程降频导致截图响应变慢
                snow_shot_app_os::efficiency_mode::disable_main_process_efficiency_mode();

                // 移除窗口装饰（标题栏），实现无边框截图窗口
                match main_window.set_decorations(false) {
                    Ok(_) => (),
                    Err(_) => {
                        log::error!("[init_main_window] Failed to set decorations");
                    }
                }

                // Layer 3: 启动后台守护线程，周期性扫描进程树并禁用 WebView2 子进程的效能模式
                snow_shot_app_os::efficiency_mode::spawn_efficiency_mode_guard();

                // 修复 UIPI 阻断：允许低权限进程（如文件关联启动的普通用户进程）
                // 通过 WM_COPYDATA 向本进程（可能以管理员权限运行）发送单实例通信消息
                // 场景：C# 托盘以管理员启动后，双击图片（普通用户）无法触发单实例回调
                {
                    use windows_sys::Win32::UI::WindowsAndMessaging::{
                        ChangeWindowMessageFilter, WM_COPYDATA, MSGFLT_ADD,
                    };
                    unsafe { ChangeWindowMessageFilter(WM_COPYDATA, MSGFLT_ADD) };
                }
            }

            #[cfg(target_os = "macos")]
            {
                // macOS 下不在 dock 显示图标
                app.set_activation_policy(tauri::ActivationPolicy::Prohibited);
            }

            // ============================================================
            // 拦截主窗口关闭事件：隐藏而非销毁，实现"最小化到托盘"效果
            // ============================================================
            let window_clone = main_window.clone();
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close(); // 阻止真正关闭窗口

                    #[cfg(target_os = "windows")]
                    {
                        if let Err(e) = window_clone.hide() {
                            log::error!("[setup] hide window error: {:?}", e);
                        }
                    }

                    #[cfg(target_os = "macos")]
                    {
                        if let Err(e) = window_clone.hide() {
                            log::error!("[setup] hide window error: {:?}", e);
                        }
                    }

                    // 通知前端窗口已隐藏，用于菜单/托盘状态同步
                    // 安全处理：emit 失败时记录日志而非 panic
                    if let Err(e) = window_clone.emit("on-hide-main-window", ()) {
                        log::error!("[setup] emit on-hide-main-window error: {:?}", e);
                    }
                }
            });

            // 加载持久化的应用配置（图片查看器窗口状态等）
            if let Ok(config_dir) = app.path().app_config_dir() {
                let config_path = config_dir.join("config.json");
                let loaded_config = AppConfig::load(&config_path);
                if let Ok(mut cfg) = app_config_for_setup.lock() {
                    *cfg = loaded_config;
                }
                log::info!("[setup] 已加载应用配置: {:?}", config_path);
            }

            // debug 模式下默认显示窗口方便调试
            #[cfg(debug_assertions)]
            {
                // 安全处理：show 失败时记录日志而非 panic
                if let Err(e) = main_window.show() {
                    log::error!("[setup] show main window error: {:?}", e);
                }
            }

            // 兜底：如果 page-load 事件在 setup 之前已触发（极端时序），
            // 此时 HTTP server 必然已就绪，直接创建图片查看器
            let fallback_path = pending_image_path.lock().unwrap().take();
            if let Some(image_path) = fallback_path {
                log::info!("[setup] page-load may have fired before setup, creating image viewer as fallback");
                let app_handle = app.handle().clone();
                let image_path_log = image_path.clone();
                log::info!("[setup_fallback] creating image viewer for path '{}'", image_path_log);
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = snow_shot_tauri_commands_core::create_image_viewer_window(
                        app_handle,
                        image_path,
                    ).await {
                        log::error!("[setup_fallback] create_image_viewer_window failed for path '{}': {}", image_path_log, e);
                    }
                });
            }

            Ok(())
        })
        // ============================================================
        // 将所有服务注册到 Tauri 全局状态，供各模块通过 State<T> 访问
        // ============================================================
        .manage(ui_elements)
        .manage(ocr_instance)
        .manage(enigo_instance)
        .manage(scroll_screenshot_service)
        .manage(scroll_screenshot_image_service)
        .manage(scroll_screenshot_capture_service)
        .manage(video_record_service)
        .manage(free_drag_window_service)
        .manage(resize_window_service)
        .manage(listen_key_service)
        .manage(listen_mouse_service)
        .manage(file_cache_service)
        .manage(enable_run_log_clone)
        .manage(plugin_service)
        .manage(full_screen_draw_window_labels)
        .manage(webview_shared_buffer_state)
        .manage(hot_load_page_service)
        .manage(video_record_window_label)
        .manage(capture_state)
        .manage(read_clipboard_state)
        .manage(screenshot_shortcut_map)
        .manage(app_config.clone())
        // ============================================================
        // 注册所有 IPC 命令处理器（前端 invoke 的入口）
        // ============================================================
        .invoke_handler(tauri::generate_handler![
            screenshot::capture_current_monitor,
            screenshot::capture_all_monitors,
            screenshot::capture_focused_window,
            screenshot::get_window_elements,
            screenshot::init_ui_elements,
            screenshot::get_element_from_position,
            screenshot::init_ui_elements_cache,
            screenshot::get_mouse_position,
            screenshot::create_draw_window,
            screenshot::switch_always_on_top,
            screenshot::set_draw_window_style,
            screenshot::capture_full_screen,
            screenshot::trigger_screenshot,
            global_state::sync_screenshot_shortcuts,
            file::save_file,
            file::write_file,
            file::copy_file,
            file::remove_file,
            file::create_dir,
            file::remove_dir,
            file::get_app_config_dir,
            file::get_app_config_base_dir,
            file::create_local_config_dir,
            ocr::ocr_detect,
            #[cfg(target_os = "windows")]
            ocr::ocr_detect_with_shared_buffer,
            ocr::ocr_init,
            ocr::ocr_release,
            core::exit_app,
            core::start_free_drag,
            core::start_resize_window,
            core::close_window_after_delay,
            core::get_selected_text,
            core::set_enable_proxy,
            core::scroll_through,
            core::auto_scroll_through,
            core::click_through,
            core::create_fixed_content_window,
            core::read_image_from_clipboard,
            core::create_full_screen_draw_window,
            core::close_full_screen_draw_window,
            core::get_current_monitor_info,
            core::get_monitors_bounding_box,
            core::send_new_version_notification,
            core::create_video_record_window,
            core::close_video_record_window,
            core::has_video_record_window,
            core::has_focused_full_screen_window,
            core::set_current_window_always_on_top,
            core::auto_start_enable,
            core::auto_start_disable,
            core::restart_with_admin,
            core::write_bitmap_image_to_clipboard,
            #[cfg(target_os = "windows")]
            core::write_bitmap_image_to_clipboard_with_shared_buffer,
            core::retain_dir_files,
            core::is_admin,
            core::set_run_log,
            core::set_exclude_from_capture,
            image_viewer::create_image_viewer_window,
            config::save_image_viewer_window_state,
            config::load_image_viewer_window_state,
            core::show_main_window,
            core::set_window_rect,
            core::trim_process_working_set,
            scroll_screenshot::scroll_screenshot_get_image_data,
            scroll_screenshot::scroll_screenshot_init,
            scroll_screenshot::scroll_screenshot_capture,
            scroll_screenshot::scroll_screenshot_handle_image,
            scroll_screenshot::scroll_screenshot_save_to_file,
            scroll_screenshot::scroll_screenshot_save_to_clipboard,
            scroll_screenshot::scroll_screenshot_get_size,
            scroll_screenshot::scroll_screenshot_clear,
            video_record::video_record_start,
            video_record::video_record_stop,
            video_record::video_record_pause,
            video_record::video_record_resume,
            video_record::video_record_kill,
            video_record::video_record_get_microphone_device_names,
            video_record::video_record_init,
            listen_key::listen_key_start,
            listen_key::listen_key_stop,
            listen_key::listen_key_stop_by_window_label,
            listen_key::listen_mouse_start,
            listen_key::listen_mouse_stop,
            listen_key::listen_mouse_stop_by_window_label,
            file::text_file_read,
            file::text_file_write,
            file::text_file_clear,
            file::is_portable_app,
            plugin::plugin_init,
            plugin::plugin_get_plugins_status,
            plugin::plugin_register_plugin,
            plugin::plugin_install_plugin,
            plugin::plugin_uninstall_plugin,
            webview::create_webview_shared_buffer,
            webview::set_support_webview_shared_buffer,
            #[cfg(target_os = "windows")]
            webview::create_webview_shared_buffer_channel,
            #[cfg(target_os = "windows")]
            core::write_image_pixels_to_clipboard_with_shared_buffer,
            http_services::upload_to_s3,
            hot_load_page::hot_load_page_init,
            hot_load_page::hot_load_page_add_page,
            global_state::set_capture_state,
            global_state::get_capture_state,
            global_state::set_read_clipboard_state,
            global_state::get_read_clipboard_state,
        ])
        // ============================================================
        // 全局窗口关闭事件处理：通知前端停止监听服务
        // ============================================================
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let window_label = window.label().to_owned();

                // 用事件通知前端清理键盘/鼠标监听（异步清理存在所有权问题）
                match window
                    .app_handle()
                    .emit("listen-key-service:stop", window_label.clone())
                {
                    Ok(_) => (),
                    Err(e) => {
                        log::error!("[listen_key_service:stop] Failed to emit event: {}", e);
                    }
                }
                match window
                    .app_handle()
                    .emit("listen-mouse-service:stop", window_label.clone())
                {
                    Ok(_) => (),
                    Err(e) => {
                        log::error!("[listen_mouse_service:stop] Failed to emit event: {}", e);
                    }
                }
            }

            // image-viewer 窗口销毁后延迟触发工作集裁剪，回收 WebView2 子进程残留内存
            if let tauri::WindowEvent::Destroyed = event {
                let label = window.label().to_owned();
                if label.starts_with("image-viewer-") {
                    log::info!("[window_event] image-viewer '{}' destroyed, scheduling working set trim", label);
                    tauri::async_runtime::spawn(async move {
                        // 延迟 500ms 等待 WebView2 子进程完成销毁
                        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                        // trim_working_set_for_process_tree 是同步阻塞操作，
                        // 必须用 spawn_blocking 放到阻塞线程池，避免阻塞 tokio async worker 线程。
                        // 无需防抖：trim 本身是轻量操作，多个窗口各自触发一次即可，互不干扰。
                        tauri::async_runtime::spawn_blocking(|| {
                            snow_shot_app_os::efficiency_mode::trim_working_set_for_process_tree();
                        });
                    });
                }
            }
        });

    #[cfg(target_os = "windows")]
    {
        app_builder = app_builder.manage(shared_buffer_service);
    }

    // 启动 Tauri 应用事件循环
    app_builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
