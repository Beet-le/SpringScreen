// ============================================================
// 目录扫描与同目录翻页
// ============================================================

use std::path::Path;

/// 支持浏览的图片扩展名
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "bmp", "gif", "tiff", "tif", "ico", "jxl",
];

/// 扫描文件所在目录，返回同目录所有图片文件路径和当前索引
pub fn scan_directory(file_path: &str) -> (Vec<String>, usize) {
    let path = Path::new(file_path);

    let dir = match path.parent() {
        Some(d) => d,
        None => return (vec![file_path.to_string()], 0),
    };

    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

    let Ok(entries) = std::fs::read_dir(dir) else {
        return (vec![file_path.to_string()], 0);
    };

    let mut files: Vec<String> = Vec::new();

    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
            files.push(p.to_string_lossy().to_string());
        }
    }

    // 按文件名排序
    files.sort_by(|a, b| {
        let a_name = Path::new(a).file_name().and_then(|n| n.to_str()).unwrap_or("");
        let b_name = Path::new(b).file_name().and_then(|n| n.to_str()).unwrap_or("");
        alphanumeric_sort::compare_str(a_name, b_name)
    });

    let current_index = files
        .iter()
        .position(|f| {
            Path::new(f).file_name().and_then(|n| n.to_str()) == Some(file_name)
        })
        .unwrap_or(0);

    (files, current_index)
}

/// 简单的字母数字混合排序（避免 "img2" 排在 "img10" 后面）
mod alphanumeric_sort {
    pub fn compare_str(a: &str, b: &str) -> std::cmp::Ordering {
        let a_chars: Vec<char> = a.chars().collect();
        let b_chars: Vec<char> = b.chars().collect();
        let mut i = 0;
        let mut j = 0;

        while i < a_chars.len() && j < b_chars.len() {
            let a_digit = a_chars[i].is_ascii_digit();
            let b_digit = b_chars[j].is_ascii_digit();

            if a_digit && b_digit {
                // 提取数字段
                let mut a_num = 0u64;
                while i < a_chars.len() && a_chars[i].is_ascii_digit() {
                    a_num = a_num * 10 + a_chars[i].to_digit(10).unwrap() as u64;
                    i += 1;
                }
                let mut b_num = 0u64;
                while j < b_chars.len() && b_chars[j].is_ascii_digit() {
                    b_num = b_num * 10 + b_chars[j].to_digit(10).unwrap() as u64;
                    j += 1;
                }
                match a_num.cmp(&b_num) {
                    std::cmp::Ordering::Equal => continue,
                    other => return other,
                }
            } else {
                match a_chars[i].cmp(&b_chars[j]) {
                    std::cmp::Ordering::Equal => {
                        i += 1;
                        j += 1;
                    }
                    other => return other,
                }
            }
        }

        a_chars.len().cmp(&b_chars.len())
    }
}
