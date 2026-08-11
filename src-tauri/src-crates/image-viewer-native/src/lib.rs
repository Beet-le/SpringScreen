// ============================================================
// Snow Shot 原生图片查看器 — 公开入口
// ============================================================

pub mod state;
pub mod render;
pub mod window;
pub mod input;
pub mod navigation;

/// 打开原生图片查看器窗口。
///
/// 此函数在新的系统线程中创建 Win32 窗口并进入消息循环，
/// 因此调用方无需额外线程包装即可直接调用。
///
/// # 参数
/// * `file_path` - 要打开的图片文件路径（UTF-8 编码）
pub fn open(file_path: &str) -> Result<(), String> {
    let path = file_path.to_string();
    window::create_and_run(&path)
}
