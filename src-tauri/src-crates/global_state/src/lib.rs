use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::RwLock;

#[derive(Clone, Serialize, Deserialize)]
pub struct CaptureState {
    pub capturing: bool,
}

/// 是否支持 WebView SharedBuffer 传输
pub struct WebViewSharedBufferState {
    pub enable: RwLock<bool>,
}

impl WebViewSharedBufferState {
    pub fn new(value: bool) -> Self {
        Self {
            enable: RwLock::new(value),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ReadClipboardState {
    pub reading: bool,
}

impl ReadClipboardState {
    pub fn new(value: bool) -> Self {
        Self { reading: value }
    }
}

/// 截图快捷键白名单：shortcut_key → screenshot_type
/// JS 注册快捷键后同步到 Rust，供 Rust 侧兜底 handler 使用
pub type ScreenshotShortcutMap = HashMap<String, String>;
