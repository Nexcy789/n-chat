package com.dsh.group;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * WebView 宿主。
 *
 * 页面不再从服务器加载，而是挂在 http://nchat.local/ 这个虚拟域名下，
 * 由 shouldInterceptRequest 从本地喂内容。原因只有一个：IndexedDB 需要一个
 * 稳定的 origin。file:// 是 opaque origin，那边 IDB 直接报 SecurityError，
 * 而离线要存几十兆图片语音，localStorage 的 5 MB 根本不够。
 *
 * 虚拟域的页面照样能调服务器接口（跨源，服务端已开 CORS），
 * 在线时行为跟以前一样，离线时退化成纯本地阅读器。
 */
public class MainActivity extends Activity {

    /** 当前可见的 Activity 实例。推送服务靠它判断"用户是不是正在看"。 */
    public static volatile MainActivity current = null;

    private static final int REQ_FILE = 1001;

    private static final String VHOST = "nchat.local";
    private static final String APP_URL = "http://" + VHOST + "/app/";
    private static final String SETUP_URL = "http://" + VHOST + "/setup";

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    /** 页面脚本跑通了就给个话。收不到说明热更新的那份坏掉，得回滚。 */
    private volatile boolean shellReady = false;
    /** 拦截失效时只能直接塞 HTML，塞一次就够了，别递归。 */
    private boolean fallbackUsed = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
        w.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            w.setNavigationBarDividerColor(Color.TRANSPARENT);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            w.setNavigationBarContrastEnforced(false);
        }

        web = new WebView(this);
        web.setBackgroundColor(0xFF0B0E14);
        // 布局变化（转屏、三键/手势切换、键盘）都重新量一次底部安全区
        web.getViewTreeObserver().addOnGlobalLayoutListener(this::pushInsets);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // 页面还没起来之前，先用上次记下的配色把系统栏铺好
        applySystemTheme(prefs().getString("themeScheme", "dark"),
                prefs().getString("themeColor", "#0b0e14"));

        web.addJavascriptInterface(new Bridge(), "NChat");
        web.addJavascriptInterface(new Saver(), "AndroidSaver");

        WebView.setWebContentsDebuggingEnabled(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (u == null || !VHOST.equals(u.getHost())) return null;
                String path = u.getPath();
                if (path == null) path = "/";
                if (path.equals("/app") || path.equals("/app/") || path.equals("/app/index.html")) {
                    return html(shellHtml());
                }
                if (path.equals("/setup")) {
                    return html(readAsset("setup.html"));
                }
                return new WebResourceResponse("text/plain", "utf-8",
                        new ByteArrayInputStream("not found".getBytes(StandardCharsets.UTF_8)));
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, android.webkit.WebResourceError err) {
                // 极端情况：拦截没生效，WebView 真去解析 nchat.local 然后失败了。
                // 这时候别给白屏，直接把内容塞进去。
                if (req == null || !req.isForMainFrame() || fallbackUsed) return;
                String u = req.getUrl() == null ? "" : req.getUrl().toString();
                if (!u.startsWith("http://" + VHOST)) return;
                fallbackUsed = true;
                v.loadDataWithBaseURL(APP_URL, shellHtml(), "text/html", "utf-8", null);
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                if (url == null || !url.startsWith(APP_URL)) return;
                shellReady = false;
                // 2.6 秒还没等到页面的 ready 回调，说明这份壳跑不起来：
                // 删掉热更新的文件，回落到包里自带的那份再试一次。
                v.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        if (shellReady) return;
                        File f = new File(getFilesDir(), "shell.html");
                        if (f.exists() && f.delete() && web != null) {
                            web.loadUrl(APP_URL);
                        }
                    }
                }, 2600);
                // 顺手看看电脑上有没有更新的壳
                new Thread(new Runnable() {
                    @Override
                    public void run() { pullShell(); }
                }).start();
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                fileCallback = cb;
                // 问的是图片就直接开相册（澎湃/HyperOS 下是系统相册），
                // 别再弹文件管理器让人一层层翻目录
                boolean wantImage = false;
                String[] accepts = params != null ? params.getAcceptTypes() : null;
                if (accepts != null) {
                    for (String a : accepts) {
                        if (a != null && a.startsWith("image/")) { wantImage = true; break; }
                    }
                }
                Intent i;
                if (wantImage) {
                    i = new Intent(Intent.ACTION_PICK, MediaStore.Images.Media.EXTERNAL_CONTENT_URI);
                    i.setType("image/*");
                } else {
                    i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                }
                try {
                    startActivityForResult(i, REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        if (state == null) {
            String savedUrl = prefs().getString("server", "");
            if (savedUrl.isEmpty()) {
                web.loadUrl(SETUP_URL);
            } else {
                // 地址只决定接口打哪儿，页面永远是本地这份，所以不会再闪一下地址页
                web.loadUrl(APP_URL);
            }

            // 通知权限（Android 13+ 要运行时申请）
            if (Build.VERSION.SDK_INT >= 33
                    && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 2001);
            }
            // 已经配过地址就直接把常驻服务拉起来
            if (!savedUrl.isEmpty()) {
                PushService.start(this);
            }
        } else {
            web.restoreState(state);
        }
    }

    /* ── 虚拟域的内容从哪来 ───────────────────────────────── */

    /** 优先用热更新下来的那份，没有再退回包里带的。 */
    private String shellHtml() {
        File f = new File(getFilesDir(), "shell.html");
        if (f.exists() && f.length() > 2000) {
            try {
                return readFile(f);
            } catch (Exception e) {
                /* 读坏了就用内置的 */
            }
        }
        return readAsset("index.html");
    }

    private WebResourceResponse html(String body) {
        return new WebResourceResponse("text/html", "utf-8",
                new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            return readAll(in);
        } catch (Exception e) {
            return "<!doctype html><meta charset='utf-8'>"
                    + "<body style='background:#0d1117;color:#8b98a5;font:14px system-ui;padding:40px'>"
                    + "页面壳没打进包里：" + name + "</body>";
        }
    }

    private String readFile(File f) throws Exception {
        try (InputStream in = new FileInputStream(f)) {
            return readAll(in);
        }
    }

    private String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
        return new String(bo.toByteArray(), StandardCharsets.UTF_8);
    }

    /**
     * 把电脑上最新的 index.html 拉到本地存着，下次启动就用它。
     * 这样改界面不用重新打包装机。拉不到、内容不对，就都不动。
     */
    private void pullShell() {
        String base = prefs().getString("server", "");
        if (base.isEmpty()) return;
        HttpURLConnection c = null;
        try {
            URL u = new URL(base + "/?shell=" + System.currentTimeMillis());
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(4000);
            c.setReadTimeout(8000);
            c.setRequestMethod("GET");
            if (c.getResponseCode() != 200) return;
            String body = readAll(c.getInputStream());
            if (body.length() < 2000 || !body.contains("nchat")) return;

            byte[] data = body.getBytes(StandardCharsets.UTF_8);
            String hash = md5(data);
            File dir = getFilesDir();
            File hashFile = new File(dir, "shell.hash");
            String old = hashFile.exists() ? readFile(hashFile).trim() : "";
            if (hash.equals(old)) return;   // 没变，省一次写盘

            writeAll(new File(dir, "shell.html"), data);
            writeAll(hashFile, hash.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            /* 拉不到就继续用旧的 */
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private void writeAll(File f, byte[] data) throws Exception {
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(data);
            out.flush();
        }
    }

    private String md5(byte[] d) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] h = md.digest(d);
            StringBuilder sb = new StringBuilder();
            for (byte b : h) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return String.valueOf(d.length);
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences("nchat", MODE_PRIVATE);
    }

    /**
     * 状态栏、导航栏、WebView 的底色统一跟着页面主题走。
     * 页面在启动时和切换明暗时都会调 setTheme，深色配浅字、浅色配深字。
     */
    private void applySystemTheme(String scheme, String color) {
        boolean light = "light".equals(scheme);
        int c;
        try {
            c = Color.parseColor(color);
        } catch (Exception e) {
            c = light ? 0xFFF3F5F9 : 0xFF0B0E14;
        }

        getWindow().setStatusBarColor(c);

        View dv = getWindow().getDecorView();
        int flags = dv.getSystemUiVisibility();
        // 底部延伸到导航栏下面，横条浮在内容上；状态栏仍然占位，保持纯色
        flags |= View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
        if (light) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
        } else {
            flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            }
        }
        dv.setSystemUiVisibility(flags);

        if (web != null) web.setBackgroundColor(c);
        prefs().edit().putString("themeScheme", scheme).putString("themeColor", color).apply();
    }

    /** 两条系统栏各占了页面多少（dp）。推给页面当安全区。 */
    private int lastStatus = -1;
    private int lastNav = -1;

    private int dpOf(int px) {
        return Math.round(px / getResources().getDisplayMetrics().density);
    }

    /** 状态栏盖住了页面顶部多少。页面没铺到栏下面时应该是 0。 */
    private int statusInsetDp() {
        try {
            int id = getResources().getIdentifier("status_bar_height", "dimen", "android");
            int h = id > 0 ? getResources().getDimensionPixelSize(id) : 0;
            if (web == null || h <= 0) return 0;
            int[] loc = new int[2];
            web.getLocationOnScreen(loc);
            // 减几 dp：顶栏本身还有内边距，全给足会显得空
            return Math.max(0, dpOf(h - loc[1]) - 5);
        } catch (Exception e) {
            return 0;
        }
    }

    /** 导航栏实际占了多高（手势横条约 24dp，三键约 48dp）。 */
    private int navInsetDp() {
        int b = 0;
        try {
            WindowInsets wi = web == null ? null : web.getRootWindowInsets();
            if (wi != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    b = wi.getInsets(WindowInsets.Type.navigationBars()).bottom;
                } else {
                    b = wi.getSystemWindowInsetBottom();
                }
            }
        } catch (Exception e) {
            b = 0;
        }
        int dp = dpOf(b);
        // 键盘弹起时个别机型会把 IME 高度算进 bottom，那种不算安全区
        if (dp > 96) dp = 0;
        return dp;
    }

    private void pushInsets() {
        if (web == null) return;
        int st = statusInsetDp();
        int nav = navInsetDp();
        if (st == lastStatus && nav == lastNav) return;
        lastStatus = st;
        lastNav = nav;
        web.evaluateJavascript("(function(){var r=document.documentElement;"
                + "r.style.setProperty('--status-inset','" + st + "px');"
                + "r.style.setProperty('--nav-inset','" + nav + "px')})()", null);
    }

    /** 系统切了深色/浅色。页面「跟随系统」时会重新算一遍主题。 */
    @Override
    public void onConfigurationChanged(Configuration cfg) {
        super.onConfigurationChanged(cfg);
        if (web == null) return;
        boolean dark = (cfg.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        web.evaluateJavascript("window.__nchatSysTheme&&window.__nchatSysTheme(" + (dark ? "true" : "false") + ")", null);
    }

    /* ── 系统事件 ─────────────────────────────────────────── */

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE) {
            if (fileCallback != null) {
                Uri[] out = null;
                if (res == RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int n = data.getClipData().getItemCount();
                        out = new Uri[n];
                        for (int k = 0; k < n; k++) {
                            out[k] = data.getClipData().getItemAt(k).getUri();
                        }
                    } else if (data.getData() != null) {
                        out = new Uri[]{data.getData()};
                    }
                }
                fileCallback.onReceiveValue(out);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        // 先问网页：设置面板 / 大图预览 / 搜索结果开着的话，先关它们
        web.evaluateJavascript(
            "(window.__nchatBack && window.__nchatBack()) ? '1' : '0'",
            new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    if (value != null && value.contains("1")) return;
                    if (web.canGoBack()) web.goBack();
                    else MainActivity.super.onBackPressed();
                }
            });
    }

    @Override
    protected void onResume() {
        super.onResume();
        current = this;
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (current == this) current = null;
    }

    /** 用户是不是真的在看这个界面。窗口失去焦点（下拉通知栏、切到别的 app）都不算。 */
    public static boolean isWatching() {
        MainActivity a = current;
        return a != null && !a.isFinishing() && a.hasWindowFocus();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /* ── 给页面调的桥 ─────────────────────────────────────── */

    /** 供页面调用的保存通道：AndroidSaver.save(文件名, MIME, base64) -> 保存路径或空串 */
    public class Saver {
        @JavascriptInterface
        public String save(String name, String mime, String b64) {
            try {
                byte[] data = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                String safe = name == null ? "backup.json" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
                if (safe.trim().isEmpty()) safe = "backup.json";
                String type = (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime;

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, type);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH,
                            Environment.DIRECTORY_DOWNLOADS + "/NChat");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) return "";
                    OutputStream os = getContentResolver().openOutputStream(uri);
                    if (os == null) return "";
                    os.write(data);
                    os.flush();
                    os.close();
                    return "/Download/NChat/" + safe;
                }

                File dir = new File(getExternalFilesDir(null), "NChat");
                if (!dir.exists() && !dir.mkdirs()) return "";
                File f = new File(dir, safe);
                FileOutputStream fo = new FileOutputStream(f);
                fo.write(data);
                fo.flush();
                fo.close();
                return f.getAbsolutePath();
            } catch (Exception e) {
                return "";
            }
        }

        /**
         * 存进系统相册（Pictures/NChat）。大图预览右下角那个按钮走这里。
         * 和上面的 save() 分开：那个落 Download 目录，这个进相册，用户在图库里能直接看到。
         */
        @JavascriptInterface
        public String saveImage(String name, String b64) {
            try {
                byte[] data = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                String safe = name == null ? "image.png" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
                if (safe.trim().isEmpty()) safe = "image.png";

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, "image/png");
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/NChat");
                    v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                    Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) return "";
                    OutputStream os = getContentResolver().openOutputStream(uri);
                    if (os == null) return "";
                    os.write(data);
                    os.flush();
                    os.close();
                    v.clear();
                    v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    getContentResolver().update(uri, v, null, null);
                    return "相册/NChat/" + safe;
                }

                // Q 以下：写相册要存储权限，退回应用目录，别假装存进去了
                File dir = new File(getExternalFilesDir(null), "NChat");
                if (!dir.exists() && !dir.mkdirs()) return "";
                File f = new File(dir, safe);
                FileOutputStream fo = new FileOutputStream(f);
                fo.write(data);
                fo.flush();
                fo.close();
                return f.getAbsolutePath();
            } catch (Exception e) {
                return "";
            }
        }
    }

    /** 页面和原生之间就这三件事：服务器地址、当前会话、加载成功。 */
    private class Bridge {
        @JavascriptInterface
        public void saveServer(String url) {
            if (url == null || url.isEmpty()) return;
            prefs().edit().putString("server", url).apply();
            PushService.start(MainActivity.this);
        }

        /** 页面每次打接口都要问一遍，地址变了不用重启 app。 */
        @JavascriptInterface
        public String server() {
            return prefs().getString("server", "");
        }

        /** 页面脚本跑通了。用来判断热更新的壳能不能用。 */
        @JavascriptInterface
        public void ready() {
            shellReady = true;
            lastStatus = -1;
            lastNav = -1;
            web.post(MainActivity.this::pushInsets);
        }

        /** 首帧之前页面就要问一次：状态栏、导航栏各占多少。 */
        @JavascriptInterface
        public String insets() {
            return statusInsetDp() + "," + navInsetDp();
        }

        /** 页面定好明暗之后把结果交给原生，系统栏立刻跟着变。 */
        @JavascriptInterface
        public void setTheme(String scheme, String color) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    applySystemTheme(scheme, color);
                }
            });
        }

        /** WebView 的 prefers-color-scheme 跟的是应用主题不是系统，页面得直接问。 */
        @JavascriptInterface
        public int systemDark() {
            int m = getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
            return m == Configuration.UI_MODE_NIGHT_YES ? 1 : 0;
        }

        @JavascriptInterface
        public void saveConv(String conv) {
            if (conv == null || conv.isEmpty()) return;
            prefs().edit().putString("conv", conv).apply();
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
    }
}
