fn main() {
    // 图标在构建期嵌入 exe 资源（Windows / macOS）。不显式声明监听的话，
    // 只替换 icons/ 下的文件不会让 cargo 重跑构建脚本——dev 模式下窗口、
    // 任务栏和托盘会一直显示旧图标。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    tauri_build::build()
}
