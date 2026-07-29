
<div align="center">
<a name="readme-top"></a>
<h1>SpringScreen！一款轻量好用的Windows截图工具，低配电脑友好</h1>
</div>

## 软件介绍
本项目基于开源项目 [mg-chao/snow-shot](https://github.com/mg-chao/snow-shot) 二次开发，针对低配置 Windows 设备深度优化，核心改进如下：
1. 重构长截图渲染逻辑，提升滚动截取、长图拼接流畅度
2. 新增命令行启动能力，运行目录CMD 执行以下指令可直接唤起绘图截图面板
    ```bash
    SpringScreen.exe --open-draw
    ```
3. 优化 WebView2 内核内存管理，降低后台内存占用，解决内存持续上涨问题
4. 调整 OCR 文字识别、FFmpeg 录屏插件资源加载规则，支持读取程序运行目录内依赖文件
5. 截图固定后支持键盘方向键移动
