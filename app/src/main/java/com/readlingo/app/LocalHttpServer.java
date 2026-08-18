package com.readlingo.app;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 极简本地 HTTP 服务器：把 assets 目录文件以 loopback HTTP 提供服务。
 * 让 WebView 内的 fetch() / IndexedDB 走标准 http 语义（file:// 下 fetch 被禁）。
 */
public class LocalHttpServer {

    private static final int MAX_REQUEST_LINE_CHARS = 65536;
    private static final int MAX_HEADER_LINE_CHARS = 8192;
    private static final int MAX_QUERY_CHARS = 65536;
    private static final int MAX_QUERY_VALUE_CHARS = 49152;
    private static final int MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
    private static final int MAX_WORKERS = 8;

    private final Context context;
    private final int port;
    private ServerSocket serverSocket;
    private volatile boolean running = false;
    private Thread acceptThread;
    private java.util.concurrent.ExecutorService pool;

    private static final Map<String, String> MIME = new HashMap<>();
    static {
        MIME.put("html", "text/html; charset=utf-8");
        MIME.put("htm", "text/html; charset=utf-8");
        MIME.put("css", "text/css; charset=utf-8");
        MIME.put("js", "application/javascript; charset=utf-8");
        MIME.put("json", "application/json; charset=utf-8");
        MIME.put("epub", "application/epub+zip");
        MIME.put("zip", "application/zip");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("gif", "image/gif");
        MIME.put("svg", "image/svg+xml");
        MIME.put("woff", "font/woff");
        MIME.put("woff2", "font/woff2");
        MIME.put("ttf", "font/ttf");
        MIME.put("txt", "text/plain; charset=utf-8");
        MIME.put("mp3", "audio/mpeg");
        MIME.put("webm", "video/webm");
        MIME.put("ico", "image/x-icon");
    }

    public LocalHttpServer(Context context, int port) {
        this.context = context;
        this.port = port;
    }

    /** 启动服务器。若端口被占则抛异常，调用方换端口重试。 */
    public void start() throws IOException {
        // 使用字面量 loopback，避免 Android 主线程执行 localhost DNS 解析触发 NetworkOnMainThreadException。
        // 仍只绑定 loopback，不暴露到局域网；WebView 通过 localhost 访问同一端口。
        serverSocket = new ServerSocket(port, 64, java.net.InetAddress.getByName("127.0.0.1"));
        running = true;
        // 慢的上游查询不能阻塞 accept 循环，但线程数也不能由本地连接无限创建。
        pool = new java.util.concurrent.ThreadPoolExecutor(
                4, MAX_WORKERS, 60L, java.util.concurrent.TimeUnit.SECONDS,
                new java.util.concurrent.ArrayBlockingQueue<Runnable>(32),
                new java.util.concurrent.ThreadPoolExecutor.AbortPolicy());
        acceptThread = new Thread(new Runnable() {
            @Override
            public void run() {
                acceptLoop();
            }
        }, "ReadLingoHttpServer");
        acceptThread.setDaemon(true);
        acceptThread.start();
    }

    public int getPort() {
        return port;
    }

    public void stop() {
        running = false;
        try { if (serverSocket != null) serverSocket.close(); } catch (IOException ignored) {}
        if (pool != null) pool.shutdownNow();
    }

    private void acceptLoop() {
        while (running) {
            try {
                final Socket socket = serverSocket.accept();
                try {
                    pool.execute(new Runnable() {
                        @Override
                        public void run() {
                            handle(socket);
                        }
                    });
                } catch (java.util.concurrent.RejectedExecutionException e) {
                    try { socket.close(); } catch (IOException ignored) {}
                }
            } catch (IOException e) {
                if (running) {
                    // 继续尝试
                }
            }
        }
    }

    private void handle(Socket socket) {
        try {
            socket.setSoTimeout(15000);
            BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.ISO_8859_1));
            String requestLine = in.readLine();
            if (requestLine == null) { socket.close(); return; }
            if (requestLine.length() > MAX_REQUEST_LINE_CHARS) {
                respond(socket, 414, "URI Too Long", "text/plain; charset=utf-8", null);
                return;
            }

            String[] parts = requestLine.split(" ", 3);
            if (parts.length < 2) {
                respond(socket, 400, "Bad Request", "text/plain; charset=utf-8", null);
                return;
            }
            String method = parts.length > 0 ? parts[0] : "GET";
            String rawPath = parts.length > 1 ? parts[1] : "/";

            // 只服务 GET/HEAD，跳过请求头
            if (!"GET".equals(method) && !"HEAD".equals(method)) {
                respond(socket, 405, "Method Not Allowed", "text/plain; charset=utf-8", null);
                return;
            }
            while (true) {
                String line = in.readLine();
                if (line == null || line.isEmpty()) break;
                if (line.length() > MAX_HEADER_LINE_CHARS) {
                    respond(socket, 431, "Request Header Fields Too Large", "text/plain; charset=utf-8", null);
                    return;
                }
            }

            String path;
            try {
                path = decodeAssetPath(rawPath);
            } catch (IllegalArgumentException e) {
                respond(socket, 400, "Bad Request", "text/plain; charset=utf-8", null);
                return;
            }
            if (path.equals("/")) path = "/index.html";

            // 本地词典代理：同源请求由 Java 直连有道词典
            if (path.equals("/api/dict")) {
                handleDictProxy(socket, rawPath);
                return;
            }

            // 本地翻译代理：同源请求直连有道翻译
            if (path.equals("/api/translate")) {
                handleTranslateProxy(socket, rawPath);
                return;
            }

            // 本地发音代理：同源转发有道 dictvoice
            // （跨源音频直连被 Chromium ORB 阻止 net::ERR_BLOCKED_BY_ORB，同源请求绕开）
            if (path.equals("/api/voice")) {
                handleVoiceProxy(socket, rawPath);
                return;
            }

            String assetPath = path.startsWith("/") ? path.substring(1) : path;
            InputStream is = null;
            try {
                is = context.getAssets().open(assetPath);
            } catch (IOException e) {
                respond(socket, 404, "Not Found", "text/plain; charset=utf-8", null);
                return;
            }

            String ext = "";
            int dot = assetPath.lastIndexOf('.');
            if (dot >= 0) ext = assetPath.substring(dot + 1).toLowerCase(Locale.ROOT);
            String mime = MIME.getOrDefault(ext, "application/octet-stream");

            byte[] data = readAll(is);
            respond(socket, 200, "OK", mime, data, "HEAD".equals(method));
        } catch (Exception e) {
            try { socket.close(); } catch (IOException ignored) {}
        }
    }

    /** 解码并规范化 assets 路径，只允许相对 assets 根目录的安全路径。 */
    private String decodeAssetPath(String rawTarget) {
        int query = rawTarget.indexOf('?');
        String encodedPath = query >= 0 ? rawTarget.substring(0, query) : rawTarget;
        if (encodedPath.length() > MAX_REQUEST_LINE_CHARS) {
            throw new IllegalArgumentException("path too long");
        }
        String path;
        try {
            path = URLDecoder.decode(encodedPath, StandardCharsets.UTF_8.name());
        } catch (java.io.UnsupportedEncodingException e) {
            throw new IllegalArgumentException("UTF-8 unavailable", e);
        }
        if (!path.startsWith("/") || path.indexOf('\0') >= 0 || path.indexOf('\\') >= 0) {
            throw new IllegalArgumentException("invalid path");
        }

        StringBuilder normalized = new StringBuilder("/");
        String[] segments = path.split("/");
        for (String segment : segments) {
            if (segment.isEmpty() || ".".equals(segment)) continue;
            // AssetManager 不应接收任何带点段，避免不同平台对路径规范化规则不一致。
            if (segment.contains("..") || segment.indexOf('\0') >= 0) {
                throw new IllegalArgumentException("path traversal");
            }
            if (normalized.length() > 1) normalized.append('/');
            normalized.append(segment);
        }
        return normalized.toString();
    }

    /** 读取 query 参数并限制解码后的长度，兼容参数任意排列。 */
    private String queryParam(String rawTarget, String name) throws IOException {
        int query = rawTarget.indexOf('?');
        if (query < 0 || query + 1 >= rawTarget.length()) return "";
        String encodedQuery = rawTarget.substring(query + 1);
        if (encodedQuery.length() > MAX_QUERY_CHARS) {
            throw new IOException("query too long");
        }

        int start = 0;
        while (start <= encodedQuery.length()) {
            int end = encodedQuery.indexOf('&', start);
            if (end < 0) end = encodedQuery.length();
            if (end > start) {
                int equals = encodedQuery.indexOf('=', start);
                if (equals >= start && equals < end) {
                    String key = decodeQueryComponent(encodedQuery.substring(start, equals));
                    if (name.equals(key)) {
                        String value = decodeQueryComponent(encodedQuery.substring(equals + 1, end));
                        if (value.length() > MAX_QUERY_VALUE_CHARS) {
                            throw new IOException("query value too long");
                        }
                        return value;
                    }
                }
            }
            if (end == encodedQuery.length()) break;
            start = end + 1;
        }
        return "";
    }

    private String decodeQueryComponent(String value) throws IOException {
        try {
            return URLDecoder.decode(value, StandardCharsets.UTF_8.name());
        } catch (IllegalArgumentException e) {
            throw new IOException("invalid query encoding", e);
        }
    }

    private void handleDictProxy(Socket socket, String rawPath) throws IOException {
        String q;
        try {
            q = queryParam(rawPath, "q");
        } catch (IOException e) {
            respond(socket, 400, "Bad Request", "application/json; charset=utf-8", "{\"error\":\"invalid q\"}".getBytes(StandardCharsets.UTF_8));
            return;
        }
        if (q.isEmpty()) {
            respond(socket, 400, "Bad Request", "application/json; charset=utf-8", "{\"error\":\"missing q\"}".getBytes(StandardCharsets.UTF_8));
            return;
        }

        // Java 直连有道（无 CORS 限制），超时控制
        java.net.HttpURLConnection conn = null;
        try {
            java.net.URL url = new java.net.URL("https://dict.youdao.com/jsonapi?q="
                    + java.net.URLEncoder.encode(q, "UTF-8"));
            conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(10000);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36");
            conn.setRequestProperty("Accept", "application/json");
            int code = conn.getResponseCode();
            if (code == 200) {
                byte[] data = readAll(conn.getInputStream());
                respond(socket, 200, "OK", "application/json; charset=utf-8", data);
            } else {
                respond(socket, 502, "Upstream Error", "application/json; charset=utf-8",
                        ("{\"error\":\"upstream " + code + "\"}").getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            respond(socket, 502, "Upstream Error", "application/json; charset=utf-8",
                    "{\"error\":\"upstream unreachable\"}".getBytes(StandardCharsets.UTF_8));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void handleTranslateProxy(Socket socket, String rawPath) throws IOException {
        String text;
        try {
            text = queryParam(rawPath, "text");
        } catch (IOException e) {
            respond(socket, 400, "Bad Request", "application/json; charset=utf-8", "{\"error\":\"invalid text\"}".getBytes(StandardCharsets.UTF_8));
            return;
        }
        if (text.isEmpty()) {
            respond(socket, 400, "Bad Request", "application/json; charset=utf-8", "{\"error\":\"missing text\"}".getBytes(StandardCharsets.UTF_8));
            return;
        }

        // Java 直连有道翻译（智云 demo 接口，无 CORS/反爬），超时控制
        java.net.HttpURLConnection conn = null;
        try {
            java.net.URL url = new java.net.URL("https://aidemo.youdao.com/trans?q="
                    + java.net.URLEncoder.encode(text, "UTF-8") + "&from=auto&to=auto");
            conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(10000);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36");
            int code = conn.getResponseCode();
            if (code == 200) {
                byte[] data = readAll(conn.getInputStream());
                respond(socket, 200, "OK", "application/json; charset=utf-8", data);
            } else {
                String errBody = "{\"error\":\"upstream " + code + "\"}";
                respond(socket, 502, "Upstream Error", "application/json; charset=utf-8",
                        errBody.getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            respond(socket, 502, "Upstream Error", "application/json; charset=utf-8",
                    "{\"error\":\"upstream unreachable\"}".getBytes(StandardCharsets.UTF_8));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    // 本地发音代理：同源转发有道 dictvoice（?word=xxx&type=1|2）
    // 目的：绕开 Chromium ORB 对跨源音频的阻止（net::ERR_BLOCKED_BY_ORB）
    private void handleVoiceProxy(Socket socket, String rawPath) throws IOException {
        String word;
        String type;
        try {
            word = queryParam(rawPath, "word");
            type = queryParam(rawPath, "type");
        } catch (IOException e) {
            respond(socket, 400, "Bad Request", "text/plain; charset=utf-8", null);
            return;
        }
        if (!"1".equals(type) && !"2".equals(type)) type = "1";
        if (word.isEmpty()) {
            respond(socket, 400, "Bad Request", "text/plain; charset=utf-8", null);
            return;
        }
        java.net.HttpURLConnection conn = null;
        try {
            java.net.URL url = new java.net.URL("https://dict.youdao.com/dictvoice?audio="
                    + java.net.URLEncoder.encode(word, "UTF-8") + "&type=" + type);
            conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(10000);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36");
            conn.setRequestProperty("Referer", "https://dict.youdao.com/");
            int code = conn.getResponseCode();
            if (code == 200) {
                byte[] audio = readAll(conn.getInputStream());
                respond(socket, 200, "OK", "audio/mpeg", audio);
            } else {
                respond(socket, 502, "Upstream Error", "text/plain; charset=utf-8", null);
            }
        } catch (Exception e) {
            respond(socket, 502, "Upstream Error", "text/plain; charset=utf-8", null);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private byte[] readAll(InputStream is) throws IOException {
        BufferedInputStream bis = new BufferedInputStream(is);
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        int total = 0;
        try {
            while ((n = bis.read(buf)) != -1) {
                if (n > MAX_RESPONSE_BYTES - total) {
                    throw new IOException("response too large");
                }
                bos.write(buf, 0, n);
                total += n;
            }
            return bos.toByteArray();
        } finally {
            bis.close();
        }
    }

    private void respond(Socket socket, int status, String reason, String contentType, byte[] body) throws IOException {
        respond(socket, status, reason, contentType, body, false);
    }

    private void respond(Socket socket, int status, String reason, String contentType, byte[] body, boolean headOnly) throws IOException {
        byte[] b = body != null ? body : reason.getBytes(StandardCharsets.UTF_8);
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(status).append(" ").append(reason).append("\r\n");
        head.append("Content-Type: ").append(contentType).append("\r\n");
        head.append("Content-Length: ").append(b.length).append("\r\n");
        head.append("Connection: close\r\n");
        head.append("X-Content-Type-Options: nosniff\r\n");
        head.append("Cache-Control: no-store\r\n");
        head.append("\r\n");
        OutputStream out = socket.getOutputStream();
        out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
        if (!headOnly) out.write(b);
        out.flush();
        socket.close();
    }
}
