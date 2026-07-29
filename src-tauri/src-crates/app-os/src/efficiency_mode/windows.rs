//! Windows 效能模式防御：防止 WebView2 子进程被 Windows Efficiency Mode 冻结，
//! 导致长时间闲置后截图唤起延迟。
//!
//! 三层防御：
//! 1. 主进程调用 SetProcessInformation 禁用效能模式
//! 2. 启动前注入 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 禁用 Chromium EfficiencyMode
//! 3. 后台遍历进程树，对 GPU/渲染器等子进程递归禁用效能模式

use std::mem;

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::ProcessStatus::EmptyWorkingSet;
use windows::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, SetProcessInformation, PROCESS_POWER_THROTTLING_STATE,
    PROCESS_QUERY_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION,
    PROCESS_SET_QUOTA, ProcessPowerThrottling,
};

/// Layer 1: 禁用当前主进程的效能模式
pub fn disable_main_process_efficiency_mode() {
    unsafe {
        let mut state = PROCESS_POWER_THROTTLING_STATE {
            Version: 1,
            ControlMask: 1, // PROCESS_POWER_THROTTLING_EXECUTION_SPEED
            StateMask: 0,   // 0 = disable throttling
        };

        match SetProcessInformation(
            GetCurrentProcess(),
            ProcessPowerThrottling,
            &mut state as *mut _ as *mut _,
            mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        ) {
            Ok(_) => {
                log::info!("[efficiency_mode] Disabled efficiency mode for main process");
            }
            Err(e) => {
                log::warn!(
                    "[efficiency_mode] Failed to disable efficiency mode for main process: {:?}",
                    e
                );
            }
        }
    }
}

/// Layer 2: 设置 WebView2 环境变量，禁用 Chromium EfficiencyMode
/// 必须在任何 WebView2 实例创建之前调用
pub fn set_webview2_chromium_args() {
    let env_key = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    if std::env::var(env_key).is_err() {
        // SAFETY: 在应用启动最早阶段调用，此时无其他线程并发读写环境变量
        unsafe {
            std::env::set_var(env_key, "--disable-features=EfficiencyMode");
        }
        log::info!(
            "[efficiency_mode] Set {}=--disable-features=EfficiencyMode",
            env_key
        );
    } else {
        log::info!(
            "[efficiency_mode] {} already set, skipping",
            env_key
        );
    }
}

/// 对单个进程 PID 禁用效能模式
fn disable_efficiency_for_pid(pid: u32) -> bool {
    unsafe {
        // SetProcessInformation 需要 PROCESS_SET_INFORMATION 权限
        let access = PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION;
        let handle = match OpenProcess(access, false, pid) {
            Ok(h) => h,
            Err(e) => {
                log::debug!(
                    "[efficiency_mode] OpenProcess failed for pid {}: {:?}",
                    pid, e
                );
                return false;
            }
        };

        let mut state = PROCESS_POWER_THROTTLING_STATE {
            Version: 1,
            ControlMask: 1,
            StateMask: 0,
        };

        let result = SetProcessInformation(
            handle,
            ProcessPowerThrottling,
            &mut state as *mut _ as *mut _,
            mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        );

        let _ = CloseHandle(handle);
        result.is_ok()
    }
}

/// 收集指定父进程的所有后代进程 PID（递归）
fn collect_descendant_pids(parent_pid: u32) -> Vec<u32> {
    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let mut entries = Vec::new();
        let mut pe = PROCESSENTRY32 {
            dwSize: mem::size_of::<PROCESSENTRY32>() as u32,
            ..Default::default()
        };

        if Process32First(snapshot, &mut pe).is_ok() {
            loop {
                entries.push((pe.th32ProcessID, pe.th32ParentProcessID));
                if Process32Next(snapshot, &mut pe).is_err() {
                    break;
                }
            }
        }

        let _ = CloseHandle(snapshot);

        // BFS 收集所有后代
        let mut result = Vec::new();
        let mut queue = vec![parent_pid];

        while let Some(current_pid) = queue.pop() {
            for &(pid, ppid) in &entries {
                if ppid == current_pid && pid != parent_pid {
                    result.push(pid);
                    queue.push(pid);
                }
            }
        }

        result
    }
}

/// Layer 3: 遍历进程树，对所有子进程禁用效能模式
pub fn disable_child_processes_efficiency_mode() {
    let current_pid = std::process::id();

    let descendant_pids = collect_descendant_pids(current_pid);
    let mut disabled_count = 0u32;

    for pid in &descendant_pids {
        if disable_efficiency_for_pid(*pid) {
            disabled_count += 1;
        }
    }

    log::info!(
        "[efficiency_mode] Disabled efficiency mode for {} child processes (total descendants: {})",
        disabled_count,
        descendant_pids.len()
    );
}

/// 启动后台任务：延迟 3 秒后首次执行，之后每 60 秒扫描一次新子进程
pub fn spawn_efficiency_mode_guard() {
    std::thread::spawn(|| {
        // 等待 3 秒，确保 WebView2 子进程已创建
        std::thread::sleep(std::time::Duration::from_secs(3));
        disable_child_processes_efficiency_mode();

        // 每 60 秒扫描一次，覆盖动态创建的子进程
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            disable_child_processes_efficiency_mode();
        }
    });
    log::info!("[efficiency_mode] Background efficiency mode guard spawned");
}

/// 裁剪单个进程 PID 的工作集，将物理内存换出到页面文件。
/// 与效能模式不同，EmptyWorkingSet 只是一次性回收物理页，不会改变进程优先级、
/// 也不会冻结进程，因此不会破坏"秒唤起"所依赖的反冻结策略。
fn empty_working_set_for_pid(pid: u32) -> bool {
    unsafe {
        // EmptyWorkingSet 需要 PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA 权限
        let access = PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION;
        let handle = match OpenProcess(access, false, pid) {
            Ok(h) => h,
            Err(e) => {
                log::debug!(
                    "[efficiency_mode] OpenProcess (trim) failed for pid {}: {:?}",
                    pid, e
                );
                return false;
            }
        };

        let result = EmptyWorkingSet(handle);

        let _ = CloseHandle(handle);
        result.is_ok()
    }
}

/// 裁剪当前进程树（主进程 + 所有后代 WebView2 子进程）的工作集。
/// 用于截图待机（GPU 资源已释放）后主动回收物理内存，降低任务管理器中的内存占用，
/// 下次唤起时仅需缺页回读，延迟增加极小。
pub fn trim_working_set_for_process_tree() {
    let current_pid = std::process::id();

    // 主进程自身
    unsafe {
        let _ = EmptyWorkingSet(GetCurrentProcess());
    }

    let descendant_pids = collect_descendant_pids(current_pid);
    let mut trimmed_count = 0u32;

    for pid in &descendant_pids {
        if empty_working_set_for_pid(*pid) {
            trimmed_count += 1;
        }
    }

    log::info!(
        "[efficiency_mode] Trimmed working set for {} child processes (total descendants: {})",
        trimmed_count,
        descendant_pids.len()
    );
}
