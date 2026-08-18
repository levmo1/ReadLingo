package com.readlingo.app;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;

/**
 * ReadLingo 阅读器 Android 壳。
 * 内置一个本地 HTTP 服务器（loopback:8091 起）服务 assets 资源，
 * WebView 加载 http://localhost —— 保证 fetch()/IndexedDB 走标准 http 语义。
 */
public class MainActivity extends Activity {

    private WebView webView;
    private LocalHttpServer server;
    private int port = 8091;

    // WebView 文件选择（导入 EPUB 用）
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 全屏沉浸（阅读场景）
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.parseColor("#f6f4ef"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#f6f4ef"));
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // IndexedDB / localStorage
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(false);
        s.setTextZoom(100);
        // EPUB 内容不需要访问 file:// 的其他文件或跨 file:// 源访问资源。
        // 保留 file://android_asset 的兜底加载，但关闭两类跨文件权限。
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);

        webView.setWebChromeClient(new WebChromeClient() {
            // 必须实现：否则 WebView 里 <input type="file"> 完全失效
            @Override
            public boolean onShowFileChooser(WebView wv, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null); // 取消上一次未完成的回调
                }
                filePathCallback = callback;

                // 用 ACTION_OPEN_DOCUMENT 打开系统文档选择器（DocumentsUI）。
                // 注意：不能用 ACTION_GET_CONTENT + createChooser——MIUI 上会走"分享面板"，
                // 受 FRP 限制直接失败并弹"进入FRP模式，无法分享"。
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                        "application/epub+zip", "application/zip", "application/octet-stream"
                });
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !isTrustedUrl(request != null ? request.getUrl() : null);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !isTrustedUrl(url != null ? Uri.parse(url) : null);
            }
        });
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        // 阻止系统原生长按选词菜单（复制/分享/全选/网页搜索）：
        // 长按选词由 Web 层自定义实现（自定义菜单：复制/划线/单词翻译/句子翻译）
        webView.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                return true; // 消费长按，阻止系统文本选择菜单
            }
        });

        // 仅在应用本身可调试时开启 WebView 远程调试，避免发布版暴露调试通道。
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        android.webkit.WebView.setWebContentsDebuggingEnabled(debuggable);

        // JS 桥：让 Web 层同步系统状态栏/导航栏颜色（主题切换时）
        webView.addJavascriptInterface(new Object() {
            @android.webkit.JavascriptInterface
            public void setBarColors(String colorHex, boolean darkText) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            int color = android.graphics.Color.parseColor(colorHex);
                            getWindow().setStatusBarColor(color);
                            getWindow().setNavigationBarColor(color);
                            // 深色主题时用浅色状态栏文字，浅色主题用深色文字
                            int visibility = darkText
                                    ? android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                                    : 0;
                            getWindow().getDecorView().setSystemUiVisibility(visibility);
                        } catch (Exception ignored) { }
                    }
                });
            }
        }, "AndroidBridge");

        // 启动本地 HTTP 服务器（端口被占用则递增）
        startServer();

        webView.loadUrl("http://localhost:" + port + "/index.html");
    }

    /** 只允许应用自己的本地页面继续在 WebView 内导航。 */
    private boolean isTrustedUrl(Uri uri) {
        if (uri == null || uri.getScheme() == null) return false;
        String scheme = uri.getScheme().toLowerCase(java.util.Locale.ROOT);
        if ("http".equals(scheme)) {
            String host = uri.getHost();
            int uriPort = uri.getPort();
            return "localhost".equalsIgnoreCase(host)
                    && (uriPort == port || (uriPort == -1 && port == 80));
        }
        if ("file".equals(scheme)) {
            String path = uri.getPath();
            return path != null && path.startsWith("/android_asset/");
        }
        // epub.js 可能使用 blob/data iframe；它们不应触发外部页面导航。
        return "about".equals(scheme) || "blob".equals(scheme) || "data".equals(scheme);
    }

    private void startServer() {
        for (int attempt = 0; attempt < 5; attempt++) {
            try {
                server = new LocalHttpServer(this, port);
                server.start();
                return;
            } catch (IOException e) {
                port++;
            }
        }
        // 实在起不来就退回 file:// 加载（fetch 不可用但界面可显示）
        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (filePathCallback == null) {
                super.onActivityResult(requestCode, resultCode, data);
                return;
            }
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    if (count > 0) {
                        results = new Uri[count];
                        for (int i = 0; i < count; i++) {
                            results[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    }
                } else if (data.getData() != null) {
                    results = new Uri[]{ data.getData() };
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        // 优先 WebView 历史（书内链接跳转等）
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        // 单页应用：把返回键交给 Web 层逐级返回（浮窗→面板→目录→阅读器→书架）
        // JS 返回 true = 已消费（留在 app 内）；false/null = 无上一级，正常退出
        if (webView != null) {
            webView.evaluateJavascript(
                "window.__handleBack ? window.__handleBack() : false",
                new android.webkit.ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        boolean handled = "true".equals(value);
                        if (!handled) {
                            finish();
                        }
                    }
                }
            );
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (server != null) server.stop();
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
