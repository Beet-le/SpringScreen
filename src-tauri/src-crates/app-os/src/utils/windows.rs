use std::env;
use std::ffi::c_void;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::Foundation::{HWND, VARIANT_BOOL};
use windows::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::System::Com::{
    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::Win32::System::TaskScheduler::{
    self, IAction, IActionCollection, IExecAction, ILogonTrigger, IPrincipal, IRegisteredTask,
    IRegistrationInfo, ITaskDefinition, ITaskFolder, ITaskService, ITaskSettings, ITrigger,
    ITriggerCollection, TASK_ACTION_EXEC, TASK_LOGON_GROUP, TASK_TRIGGER_LOGON,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetWindowLongPtrW, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOMOVE, SWP_NOSIZE,
    SetWindowPos, WS_EX_TOPMOST,
};
use windows::core::Interface;
use windows::core::PCWSTR;

/// 切换指定窗口的置顶状态
/// 通过 GetWindowLongPtrW 获取当前样式，使用 SetWindowPos 切换 TOPMOST/NOTOPMOST
pub fn switch_always_on_top(hwnd: *mut c_void) -> bool {
    let hwnd = HWND(hwnd);

    // 获取窗口的扩展样式
    let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };

    // 检查窗口是否已经置顶（WS_EX_TOPMOST 位是否被设置）
    let is_topmost = (ex_style & WS_EX_TOPMOST.0 as isize) != 0;

    // 根据当前状态切换置顶：置顶 → 取消置顶，非置顶 → 置顶
    let result = unsafe {
        SetWindowPos(
            hwnd,
            if is_topmost {
                Some(HWND_NOTOPMOST)
            } else {
                Some(HWND_TOPMOST)
            },
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE, // 保持位置和大小不变
        )
    };

    result.is_ok()
}

/// 设置 draw 窗口样式（当前为占位函数，暂不处理）
pub fn set_draw_window_style(#[allow(unused_variables)] window: tauri::Window) {
    // 暂时不处理，保留下函数占位
}

/// 获取当前前台窗口句柄
pub fn get_focused_window() -> HWND {
    unsafe { GetForegroundWindow() }
}

// ============================================================
// Windows 任务计划程序（Task Scheduler）自启动管理
//
// 当应用以管理员权限运行时，普通注册表 Run 键自启动会触发 UAC 弹窗。
// 解决方案：使用任务计划程序创建登录触发任务，以最高权限静默启动。
// ============================================================

/// 任务计划程序中创建的任务名称
const TASK_NAME: &str = "SnowShot Admin Auto Start";

/// COM 守卫：离开作用域时自动调用 CoUninitialize 清理 COM 资源
struct ComGuard;
impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

/// 在 Windows 任务计划程序中创建管理员权限的登录自启动任务
///
/// 任务属性：
/// - 触发器：用户登录时触发（TASK_TRIGGER_LOGON）
/// - 运行级别：最高权限（TASK_RUNLEVEL_HIGHEST）
/// - 登录类型：组登录（TASK_LOGON_GROUP，S-1-5-32-544 管理员组 SID）
/// - 执行参数：--auto_start（通知应用这是自启动，触发延迟逻辑）
pub fn create_admin_auto_start_task() -> Result<(), String> {
    // 获取当前可执行文件的路径
    let current_exe = match env::current_exe() {
        Ok(current_exe) => current_exe,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] env::current_exe failed: {:?}",
                e
            ));
        }
    };
    let exe_path = current_exe.to_string_lossy();

    let _com_guard = ComGuard {};

    // 初始化 COM（多线程模式）
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            return Err(format!(
                "[create_admin_auto_start_task] CoInitializeEx failed: {:?}",
                hr
            ));
        }
    }

    // 创建 Task Scheduler 服务实例
    let p_service: ITaskService = match unsafe {
        CoCreateInstance(&TaskScheduler::TaskScheduler, None, CLSCTX_INPROC_SERVER)
    } {
        Ok(p_service) => p_service,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] CoCreateInstance failed: {:?}",
                e
            ));
        }
    };

    // 连接到本地 Task Scheduler 服务
    unsafe {
        let hr = p_service.Connect(
            &VARIANT::default(),
            &VARIANT::default(),
            &VARIANT::default(),
            &VARIANT::default(),
        );
        if hr.is_err() {
            return Err("[create_admin_auto_start_task] Connect failed".into());
        }
    }

    // 获取根任务文件夹（\）
    let p_root_folder: ITaskFolder =
        match unsafe { p_service.GetFolder(&windows::core::BSTR::from("\\")) } {
            Ok(p_root_folder) => p_root_folder,
            Err(e) => {
                return Err(format!(
                    "[create_admin_auto_start_task] GetFolder failed: {:?}",
                    e
                ));
            }
        };

    // 先删除已存在的同名任务（如果存在）
    let _ = unsafe { p_root_folder.DeleteTask(&windows::core::BSTR::from(TASK_NAME), 0) };

    // 创建新的任务定义
    let p_task: ITaskDefinition = match unsafe { p_service.NewTask(0) } {
        Ok(p_task) => p_task,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] NewTask failed: {:?}",
                e
            ));
        }
    };

    // 设置任务主体信息
    let p_principal: IPrincipal = match unsafe { p_task.Principal() } {
        Ok(p_principal) => p_principal,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] Principal failed: {:?}",
                e
            ));
        }
    };

    // 使用最高权限运行（TASK_RUNLEVEL_HIGHEST）
    unsafe {
        let hr = p_principal.SetRunLevel(TaskScheduler::TASK_RUNLEVEL_HIGHEST);
        if hr.is_err() {
            return Err("[create_admin_auto_start_task] SetRunLevel failed".into());
        }
    }

    // 设置任务注册信息（作者、描述）
    let p_reg_info: IRegistrationInfo = match unsafe { p_task.RegistrationInfo() } {
        Ok(p_reg_info) => p_reg_info,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] RegistrationInfo failed: {:?}",
                e
            ));
        }
    };
    unsafe {
        let hr = p_reg_info.SetAuthor(&windows::core::BSTR::from("SnowShot"));
        if hr.is_err() {
            return Err(format!(
                "[create_admin_auto_start_task] SetAuthor failed: {:?}",
                hr
            ));
        }
    }
    unsafe {
        let hr =
            p_reg_info.SetDescription(&windows::core::BSTR::from("Auto start with administrator"));
        if hr.is_err() {
            return Err(format!(
                "[create_admin_auto_start_task] SetDescription failed: {:?}",
                hr
            ));
        }
    }

    // 设置任务配置：系统可用时立即启动
    let p_settings: ITaskSettings = match unsafe { p_task.Settings() } {
        Ok(p_settings) => p_settings,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] Settings failed: {:?}",
                e
            ));
        }
    };
    unsafe {
        let hr = p_settings.SetStartWhenAvailable(VARIANT_BOOL::from(true));
        if hr.is_err() {
            return Err("[create_admin_auto_start_task] SetStartWhenAvailable failed".into());
        }
    }

    // 获取触发器集合并创建登录触发器（用户登录时触发）
    let p_trigger_collection: ITriggerCollection = match unsafe { p_task.Triggers() } {
        Ok(p_trigger_collection) => p_trigger_collection,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] Triggers failed: {:?}",
                e
            ));
        }
    };
    let p_trigger: ITrigger = match unsafe { p_trigger_collection.Create(TASK_TRIGGER_LOGON) } {
        Ok(p_trigger) => p_trigger,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] Create failed: {:?}",
                e
            ));
        }
    };

    // 将 ITrigger 转换为 ILogonTrigger 接口
    let p_logon_trigger: ILogonTrigger = match p_trigger.cast() {
        Ok(p_logon_trigger) => p_logon_trigger,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] cast failed: {:?}",
                e
            ));
        }
    };
    unsafe {
        let hr = p_logon_trigger.SetId(&windows::core::BSTR::from("LogonTrigger"));
        if hr.is_err() {
            return Err(format!(
                "[create_admin_auto_start_task] SetId failed: {:?}",
                hr
            ));
        }
    }

    // 获取动作集合并创建执行动作（运行当前 exe）
    let p_action_collection: IActionCollection = match unsafe { p_task.Actions() } {
        Ok(p_action_collection) => p_action_collection,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] Actions failed: {:?}",
                e
            ));
        }
    };
    let p_action: IAction = match unsafe { p_action_collection.Create(TASK_ACTION_EXEC) } {
        Ok(p_action) => p_action,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] Create failed: {:?}",
                e
            ));
        }
    };

    // 将 IAction 转换为 IExecAction 接口
    let p_exec_action: IExecAction = match p_action.cast() {
        Ok(p_exec_action) => p_exec_action,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] cast failed: {:?}",
                e
            ));
        }
    };
    // 设置要执行的程序路径
    unsafe {
        let hr = p_exec_action.SetPath(&windows::core::BSTR::from(&*exe_path));
        if hr.is_err() {
            return Err(format!(
                "[create_admin_auto_start_task] SetPath failed: {:?}",
                hr
            ));
        }
    }

    // 设置执行参数：--auto_start（通知应用延迟启动）
    unsafe {
        let hr = p_exec_action.SetArguments(&windows::core::BSTR::from("--auto_start"));
        if hr.is_err() {
            return Err(format!(
                "[create_admin_auto_start_task] SetArguments failed: {:?}",
                hr
            ));
        }
    }

    // S-1-5-32-544 是管理员组的 SID（Security Identifier）
    let admin_sid = windows::core::BSTR::from("S-1-5-32-544");

    // 注册任务到根文件夹，使用管理员组 SID 确保以管理员权限运行
    let _p_registered_task: IRegisteredTask = match unsafe {
        p_root_folder.RegisterTaskDefinition(
            &windows::core::BSTR::from(TASK_NAME),
            &p_task,
            TaskScheduler::TASK_CREATE_OR_UPDATE.0,
            &VARIANT::from(admin_sid), // 使用管理员组 SID 指定运行身份
            &VARIANT::default(),
            TASK_LOGON_GROUP, // 组登录类型
            &VARIANT::from(""),
        )
    } {
        Ok(p_registered_task) => p_registered_task,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] RegisterTaskDefinition failed: {:?}",
                e
            ));
        }
    };

    Ok(())
}

/// 删除任务计划程序中的管理员自启动任务
pub fn delete_admin_auto_start_task() -> Result<(), String> {
    let _com_guard = ComGuard {};

    // 初始化 COM
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            return Err(format!(
                "[create_admin_auto_start_task] CoInitializeEx failed: {:?}",
                hr
            ));
        }
    }

    // 创建 Task Scheduler 服务实例
    let p_service: ITaskService = match unsafe {
        CoCreateInstance(&TaskScheduler::TaskScheduler, None, CLSCTX_INPROC_SERVER)
    } {
        Ok(p_service) => p_service,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] CoCreateInstance failed: {:?}",
                e
            ));
        }
    };

    // 连接到本地 Task Scheduler 服务
    unsafe {
        let hr = p_service.Connect(
            &VARIANT::default(),
            &VARIANT::default(),
            &VARIANT::default(),
            &VARIANT::default(),
        );
        if hr.is_err() {
            return Err("[create_admin_auto_start_task] Connect failed".into());
        }
    }

    // 获取根任务文件夹
    let p_root_folder: ITaskFolder =
        match unsafe { p_service.GetFolder(&windows::core::BSTR::from("\\")) } {
            Ok(p_root_folder) => p_root_folder,
            Err(e) => {
                return Err(format!(
                    "[create_admin_auto_start_task] GetFolder failed: {:?}",
                    e
                ));
            }
        };

    // 删除同名任务
    let _ = unsafe { p_root_folder.DeleteTask(&windows::core::BSTR::from(TASK_NAME), 0) };

    Ok(())
}

/// 检查管理员自启动任务是否已启用
pub fn is_admin_auto_start_task_enabled() -> Result<bool, String> {
    let _com_guard = ComGuard {};

    // 初始化 COM
    unsafe {
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() {
            return Err(format!(
                "[create_admin_auto_start_task] CoInitializeEx failed: {:?}",
                hr
            ));
        }
    }

    // 创建 Task Scheduler 服务实例
    let p_service: ITaskService = match unsafe {
        CoCreateInstance(&TaskScheduler::TaskScheduler, None, CLSCTX_INPROC_SERVER)
    } {
        Ok(p_service) => p_service,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] CoCreateInstance failed: {:?}",
                e
            ));
        }
    };

    // 连接到本地 Task Scheduler 服务
    unsafe {
        let hr = p_service.Connect(
            &VARIANT::default(),
            &VARIANT::default(),
            &VARIANT::default(),
            &VARIANT::default(),
        );
        if hr.is_err() {
            return Err("[create_admin_auto_start_task] Connect failed".into());
        }
    }

    // 获取根任务文件夹
    let p_root_folder: ITaskFolder =
        match unsafe { p_service.GetFolder(&windows::core::BSTR::from("\\")) } {
            Ok(p_root_folder) => p_root_folder,
            Err(e) => {
                return Err(format!(
                    "[create_admin_auto_start_task] GetFolder failed: {:?}",
                    e
                ));
            }
        };

    // 获取任务对象
    let task = match unsafe { p_root_folder.GetTask(&windows::core::BSTR::from(TASK_NAME)) } {
        Ok(task) => task,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] GetTask failed: {:?}",
                e
            ));
        }
    };

    // 查询任务启用状态
    let enabled = match unsafe { task.Enabled() } {
        Ok(enabled) => enabled,
        Err(e) => {
            return Err(format!(
                "[create_admin_auto_start_task] Enabled failed: {:?}",
                e
            ));
        }
    };

    Ok(enabled.as_bool())
}

/// 检查当前进程是否具有管理员权限
///
/// 通过 OpenProcessToken + GetTokenInformation 查询 TOKEN_ELEVATION 标志
pub fn is_admin() -> bool {
    unsafe {
        let mut token: HANDLE = HANDLE::default();
        let process = GetCurrentProcess();

        // 获取当前进程的访问令牌
        if OpenProcessToken(process, TOKEN_QUERY, &mut token).is_err() {
            return false;
        }

        // 查询令牌提升信息（TokenElevation）
        let mut elevation: TOKEN_ELEVATION = std::mem::zeroed();
        let mut return_length = 0u32;

        let result = GetTokenInformation(
            token,
            windows::Win32::Security::TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut return_length,
        );

        result.is_ok() && elevation.TokenIsElevated != 0
    }
}

/// 使用 ShellExecuteExW 请求 UAC 提权，以管理员权限启动当前进程的新实例
///
/// 流程：
/// 1. 检查是否已具有管理员权限（已管理员则直接返回）
/// 2. 通过 ShellExecuteExW + "runas" verb 触发 UAC 弹窗
/// 3. 新进程启动后，当前进程退出（std::process::exit(0)）
pub fn restart_with_admin() -> Result<(), String> {
    // 先检查是否已经具有管理员权限
    if is_admin() {
        return Ok(());
    }

    // 获取当前可执行文件的路径
    let current_exe = match env::current_exe() {
        Ok(current_exe) => current_exe,
        Err(e) => {
            return Err(format!(
                "[restart_with_admin] env::current_exe failed: {:?}",
                e
            ));
        }
    };
    let exe_path = current_exe.to_string_lossy();

    unsafe {
        let mut sei: SHELLEXECUTEINFOW = std::mem::zeroed();
        sei.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        sei.fMask = SEE_MASK_NOCLOSEPROCESS; // 等待新进程句柄

        // "runas" verb 会触发 UAC 提权弹窗
        let verb = "runas\0".encode_utf16().collect::<Vec<u16>>();
        let file = exe_path.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
        sei.lpVerb = PCWSTR::from_raw(verb.as_ptr());
        sei.lpFile = PCWSTR::from_raw(file.as_ptr());
        sei.nShow = windows::Win32::UI::WindowsAndMessaging::SW_SHOW.0 as i32;

        let result = ShellExecuteExW(&mut sei);
        if result.is_err() {
            return Err("[restart_with_admin] ShellExecuteExW failed".into());
        }

        // 检查是否成功创建进程
        if sei.hProcess.is_invalid() {
            return Err("[restart_with_admin] ShellExecuteExW failed".into());
        }

        // 提权成功，新进程已启动，当前进程退出
        std::process::exit(0);
    }
}
