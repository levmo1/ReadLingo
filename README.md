<a id="readme-top"></a>

<div align="center">
  <h1>ReadLingo</h1>
  <p>一个面向英语原版阅读的 Android EPUB 阅读器与本地背词工具</p>
  <p>
    <a href="#功能">功能</a> ·
    <a href="#快速开始">快速开始</a> ·
    <a href="#后端构建流程">后端构建流程</a> ·
    <a href="#测试">测试</a> ·
    <a href="#许可证与资源">许可证与资源</a>
  </p>
</div>

## 关于项目

ReadLingo 让用户在 Android 设备上阅读英语原版 EPUB，并在阅读过程中完成查词、翻译、划线、生词整理和间隔复习。

项目采用“原生 Android WebView 壳 + `assets` 内单页 Web 应用”的架构：

- Android 层负责 WebView、文件选择器、返回键、状态栏和本地 HTTP 服务。
- Web 层负责书架、EPUB 阅读、选词、生词本、词书和背词逻辑。
- 书籍、封面、进度、设置、生词和学习状态默认保存在本地 IndexedDB。
- 不需要账号，也没有自建后端；查词、翻译和发音通过本地代理访问第三方服务。

## 功能

- 导入和管理 EPUB，支持封面、合集、重命名和阅读进度。
- 支持分页滑动和滚动阅读。
- 长按选词，支持复制、划线、单词翻译、句子翻译和发音。
- 管理生词本，支持删除、发音和 CSV 导出。
- 通过词书选择、每日计划、反馈、拼写巩固和统计复习词汇。
- 使用轻量 D-S-R 风格模型估计难度、稳定性、到期复习和回忆率。
- 针对不同 Android CSS 视口适配书架、背词页、统计页和快捷面板。

## 技术栈

- Java / Android WebView
- Android Gradle Plugin 8.1.4
- Gradle Wrapper 8.4
- Android SDK 34，最低 API 26
- HTML / CSS / JavaScript
- [epub.js](https://github.com/futurepress/epub.js)
- [JSZip](https://github.com/Stuk/jszip)
- IndexedDB

## 快速开始

### 环境要求

- JDK 17（Android Gradle Plugin 8.x 的推荐运行环境）。
- Android SDK Platform 34。
- Android Build Tools 34.0.0。
- Node.js 18 或更高版本，用于 JavaScript smoke tests。
- `adb` 仅在需要安装到实体设备或模拟器时使用。

### 构建 Debug APK

```bash
git clone https://github.com/<你的用户名>/readlingo.git
cd readlingo

export ANDROID_SDK_ROOT=/path/to/android-sdk
./gradlew assembleDebug
```

APK 输出位置：

```text
app/build/outputs/apk/debug/app-debug.apk
```

安装到已连接设备：

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### 构建 Release APK

不提供正式 keystore 时，Gradle 仍可生成未签名的 Release 包。正式签名前设置自己的密钥环境变量：

```bash
export READLINGO_KEYSTORE=/secure/path/readlingo-release.keystore
export READLINGO_KEY_ALIAS=readlingo
export READLINGO_KEYSTORE_PASSWORD='你的 keystore 密码'
export READLINGO_KEY_PASSWORD='你的 key 密码'

./gradlew assembleRelease
```

不要把正式 keystore、密码、用户 EPUB、生词本 CSV、IndexedDB 数据或调试日志提交到仓库。

## 后端构建流程

ReadLingo 没有独立部署的云端后端。Android 层的
[`LocalHttpServer.java`](app/src/main/java/com/readlingo/app/LocalHttpServer.java)
就是随 APK 一起编译的本地服务：它只绑定 `127.0.0.1`，默认从 8091 端口启动；如果端口被占用，会自动递增后重试。WebView 通过
`http://localhost:<port>` 加载页面和调用同源接口，避免 `file://` 页面无法正常使用 `fetch()`、IndexedDB 以及跨域音频的问题。

本地服务提供以下接口：

| 接口 | 用途 | 上游服务 |
| --- | --- | --- |
| `/api/dict?q=...` | 查询单词释义、音标等信息 | 有道词典 JSON API |
| `/api/translate?text=...` | 翻译选中的句子或文本 | 有道翻译接口 |
| `/api/voice?word=...&type=1\|2` | 转发英式/美式发音音频 | 有道 dictvoice |

### 后端修改后的构建与验证

1. 修改 [`LocalHttpServer.java`](app/src/main/java/com/readlingo/app/LocalHttpServer.java)、[`MainActivity.java`](app/src/main/java/com/readlingo/app/MainActivity.java) 或 `AndroidManifest.xml` 中的网络/服务配置。
2. 设置 Android SDK 并编译 Debug APK：

   ```bash
   export ANDROID_SDK_ROOT=/path/to/android-sdk
   ./gradlew assembleDebug
   ```

3. 运行 Android smoke test，验证本地服务依赖的 APK 资源、包名、对齐和签名：

   ```bash
   tools/android-smoke-test.sh
   ```

4. 安装到设备后验证本地服务和代理接口：

   ```bash
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   adb logcat | grep -E 'ReadLingo|AndroidRuntime'
   ```

   在应用内执行查词、翻译和发音操作即可验证 `/api/dict`、`/api/translate` 和 `/api/voice`。这些请求会从设备直接访问上游 HTTPS 服务；设备没有网络或上游不可用时，代理会返回错误，书架、阅读和本地学习数据仍可使用。

后端代码、WebView 壳和前端资源最终都打包进同一个 APK，不需要单独启动 Node.js、Java 或数据库服务。正式发布时，使用上面的 Release APK 构建流程并配置自己的 keystore。

### 旧版手工构建入口

`tools/build-apk.sh` 仍保留作为 Android SDK 直接构建的兼容入口。新开发和 CI 默认使用 Gradle Wrapper；手工脚本适用于没有完整 Gradle 环境的本地场景。

## 测试

JavaScript smoke tests 检查应用脚本语法、HTML 本地资源引用、关键 DOM ID、预设资源和响应式 CSS 约束：

```bash
node --test tests/js/smoke.test.mjs
```

Android APK smoke test 会构建 Debug APK，并检查应用包名、核心 assets、zipalign 和 APK 签名：

```bash
export ANDROID_SDK_ROOT=/path/to/android-sdk
tools/android-smoke-test.sh
```

运行完整本地检查：

```bash
tools/smoke-test.sh
```

如果需要重新生成预设词书：

```bash
python3 -m pip install -r tools/requirements-wordbooks.txt
python3 tools/generate-wordbooks.py
```

GitHub Actions 配置位于 [.github/workflows/ci.yml](.github/workflows/ci.yml)，会在 `main` 分支 push 和 Pull Request 上自动运行上述检查。

## 项目结构

```text
ReadLingo/
├── app/
│   ├── build.gradle
│   └── src/main/
│       ├── java/com/readlingo/app/
│       │   ├── MainActivity.java
│       │   └── LocalHttpServer.java
│       ├── res/
│       └── assets/
│           ├── index.html
│           ├── css/style.css
│           ├── js/app.js
│           ├── books/
│           ├── fonts/
│           ├── libs/
│           └── wordbooks/
├── tests/js/smoke.test.mjs
├── tools/
│   ├── android-smoke-test.sh
│   ├── smoke-test.sh
│   └── build-apk.sh
├── licenses/
├── .github/workflows/ci.yml
├── build.gradle
├── settings.gradle
├── gradle.properties
├── gradlew
├── LICENSE
└── THIRD_PARTY_NOTICES.md
```

## 数据与隐私

ReadLingo 默认将书籍、阅读进度、设置、生词和学习状态保存在设备本地。项目不提供云同步功能。查词代理请求会发送用户主动查询的单词或句子；导入的 EPUB 和本地学习数据不会自动上传到 ReadLingo 服务。

## 许可证与资源

ReadLingo 自有项目代码使用 MIT 许可证，见 [LICENSE](LICENSE)。第三方资源不自动适用 MIT，完整许可证文本和来源记录见：

- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：仓库根目录的第三方资源清单。
- [licenses/](licenses/README.md)：运行库、字体、书籍和词表的许可证/通知文件。
- [app/src/main/assets/wordbooks/SOURCES.md](app/src/main/assets/wordbooks/SOURCES.md)：预设词书来源。

字体、运行库、书籍和预设词表的许可证/来源记录已经随仓库补齐。四套词表现在来自 `wordfreq` 3.1.1 的频率数据，按 CC BY-SA 4.0 分发；它们是通用英语频率分层，不是 CET4、CET6、TOEFL 或 IELTS 官方词表。

## 参与贡献

欢迎提交 Issue、改进建议和 Pull Request。

建议流程：

1. Fork 项目并创建功能分支，例如 `feature/improve-study-stats`。
2. 修改代码并运行 `node --test tests/js/smoke.test.mjs`。
3. 运行 `tools/android-smoke-test.sh`，确认 APK 可以构建、对齐并通过签名检查。
4. UI 修改请覆盖至少一个窄屏 Android CSS 视口，并附上截图或复现设备信息。
5. 如果修改 EPUB、字体、词表或第三方库，请同步更新 `THIRD_PARTY_NOTICES.md`、`licenses/` 和 `SOURCES.md`。

Bug 反馈请包含 Android 版本、设备型号、ReadLingo 版本、复现步骤和必要截图。提交前请移除个人学习数据。

## 安全问题

请阅读 [SECURITY.md](SECURITY.md)，不要在公开 Issue 中发布密码、私钥、个人 EPUB、生词本导出文件或完整调试日志。

## 致谢

- [epub.js](https://github.com/futurepress/epub.js)：EPUB 解析、分页和渲染。
- [JSZip](https://github.com/Stuk/jszip)：EPUB ZIP 容器读取。
- [Project Gutenberg](https://www.gutenberg.org/)：预设 EPUB 来源。
- [wordfreq](https://github.com/rspeer/wordfreq)：开放英语频率数据来源。
- [MaiMemo SSP-MMC-Plus](https://github.com/maimemo/SSP-MMC-Plus) 和 [FSRS](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm)：间隔复习模型参考。

<p align="right"><a href="#readme-top">返回顶部</a></p>
