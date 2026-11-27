package com.dsh.group;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Shader;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;

/**
 * 常驻服务：替 App 收消息。
 *
 * Android 8 以后后台连接会被杀，前台服务是唯一可靠的长连接方案 ——
 * 代价是状态栏必须挂一条常驻通知，微信 QQ 也一样。
 *
 * 收的方式是长轮询：/api/poll 会把请求挂住最多 25 秒，有新消息立刻返回。
 * 不用 WebSocket，是为了不加任何依赖（HttpURLConnection 就够）。
 */
public class PushService extends Service {

    public static final String CHANNEL_ONGOING = "nchat_ongoing";
    public static final String CHANNEL_MSG = "nchat_msg";
    public static final int NOTIF_ONGOING = 1001;

    /** who → 真实头像（网页那边传上来的）。拉不到就退回画的字。 */
    private final Map<String, Bitmap> avatarCache = new HashMap<>();
    private long avatarFetchedAt = 0;

    private volatile boolean running = false;
    private Thread worker = null;
    private String base = "";
    private String conv = "group";
    private long lastSeq = 0;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        SharedPreferences sp = getSharedPreferences("nchat", MODE_PRIVATE);
        base = sp.getString("server", "");
        conv = sp.getString("conv", "group");
        // 跨会话轮询，一条游标够用
        lastSeq = sp.getLong("lastSeqAll", 0);

        // 前台服务必须立刻挂通知，不然系统 5 秒后抛异常
        // targetSdk 34（Android 14）：不带 type 的 startForeground 会被系统限制，
        // 前台服务撑不住，锁屏一会儿就被回收 —— 这是"杀后台"的主因之一
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ONGOING, buildOngoing(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ONGOING, buildOngoing());
        }

        if (!running) {
            running = true;
            worker = new Thread(this::loop, "nchat-poll");
            worker.setDaemon(true);
            worker.start();
        }
        return START_STICKY;
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        NotificationChannel ongoing = new NotificationChannel(
                CHANNEL_ONGOING, "后台收消息", NotificationManager.IMPORTANCE_MIN);
        ongoing.setShowBadge(false);
        ongoing.setSound(null, null);
        nm.createNotificationChannel(ongoing);

        NotificationChannel msg = new NotificationChannel(
                CHANNEL_MSG, "新消息", NotificationManager.IMPORTANCE_HIGH);
        msg.setShowBadge(true);
        nm.createNotificationChannel(msg);
    }

    private Notification buildOngoing() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL_ONGOING)
                : new Notification.Builder(this);
        return b.setContentTitle("N-chat")
                .setContentText("正在等消息")
                .setSmallIcon(R.drawable.ic_notify)
                .setContentIntent(pi)
                .setOngoing(true)
                .setPriority(Notification.PRIORITY_MIN)
                .build();
    }

    private void loop() {
        while (running) {
            try {
                if (base == null || base.isEmpty()) {
                    Thread.sleep(3000);
                    continue;
                }
                String url = base + "/api/poll-all?after=" + lastSeq + "&wait=25";
                String body = httpGet(url, 32000);
                if (body == null) {
                    Thread.sleep(2000);
                    continue;
                }
                handle(body);
            } catch (InterruptedException ie) {
                break;
            } catch (Exception e) {
                try {
                    Thread.sleep(3000);
                } catch (InterruptedException ie) {
                    break;
                }
            }
        }
    }

    private void handle(String body) {
        try {
            JSONObject j = new JSONObject(body);
            JSONArray arr = j.optJSONArray("messages");
            if (arr == null || arr.length() == 0) return;

            String lastFrom = "";
            String lastText = "";
            long maxSeq = lastSeq;

            for (int i = 0; i < arr.length(); i++) {
                JSONObject m = arr.getJSONObject(i);
                long seq = m.optLong("seq", 0);
                if (seq > maxSeq) maxSeq = seq;
                String from = m.optString("from", "");
                if ("user".equals(from)) continue;   // 自己发的不用提醒
                lastFrom = from;
                String t = m.optString("text", "");
                if (t.isEmpty() && m.has("image")) t = "[图片]";
                lastText = t;
            }

            if (maxSeq > lastSeq) {
                lastSeq = maxSeq;
                getSharedPreferences("nchat", MODE_PRIVATE).edit()
                        .putLong("lastSeqAll", lastSeq).apply();
            }

            // 用户正在看这个界面就不弹 —— 界面自己会刷出来，再弹是多余的打扰。
            // 判断用的是"可见 + 有焦点"，比单纯的 onResume 标记准：
            // 下拉通知栏、弹系统对话框这些都不会再误判成后台。
            if (!lastText.isEmpty() && !MainActivity.isWatching()) {
                notifyMessage(nameOf(lastFrom), lastText, lastFrom);
            }
        } catch (Exception e) {
            // 解析失败就当这轮没收到，下次接着轮
        }
    }

    private String nameOf(String id) {
        if ("ajing".equals(id)) return "角色一";
        if ("yuejian".equals(id)) return "角色二";
        if ("xiyan".equals(id)) return "角色三";
        return "消息";
    }

    private void notifyMessage(String who, String text, String fromId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL_MSG)
                : new Notification.Builder(this);
        b.setContentTitle(who)
                .setContentText(text.length() > 60 ? text.substring(0, 60) + "…" : text)
                .setSmallIcon(R.drawable.ic_notify)
                .setLargeIcon(avatarOf(fromId))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .setPriority(Notification.PRIORITY_HIGH);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            b.setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE);
        }
        nm.notify((int) (System.currentTimeMillis() % 100000), b.build());
    }

    /**
     * 画一个圆形头像给通知用：角色底色 + 一个白字。
     *
     * 通知的 largeIcon 得是 Bitmap，而网页上的头像是 SVG / 用户上传的图，
     * Java 这边拿不到。用底色+首字是最省事又不会错的做法：
     * 位置对应得上（朋友圈列表里的配色也是这套），也不依赖任何资源文件。
     */
    private Bitmap avatarOf(String id) {
        // 五分钟刷一次映射；网页上换了头像，通知里跟着变
        if (System.currentTimeMillis() - avatarFetchedAt > 5 * 60 * 1000L) refreshAvatars();
        Bitmap real = avatarCache.get(id);
        if (real != null) return real;
        return drawFallback(id);
    }

    /** 从服务端拉头像映射，把图下载下来裁成圆的。失败就算了，用兜底。 */
    private void refreshAvatars() {
        avatarFetchedAt = System.currentTimeMillis();
        try {
            String json = httpGet(base + "/api/avatars", 6000);
            if (json == null || json.isEmpty()) return;
            JSONObject j = new JSONObject(json);
            for (String id : new String[]{"ajing", "yuejian", "xiyan", "group", "my"}) {
                String name = j.optString(id, "");
                if (name == null || name.isEmpty()) continue;
                Bitmap raw = downloadBitmap(base + "/uploads/" + URLEncoder.encode(name, "UTF-8"));
                if (raw != null) avatarCache.put(id, circleCrop(raw));
            }
        } catch (Exception e) {
            // 拉不到很正常（刚装、还没设过头像），下次轮询再试
        }
    }

    private Bitmap downloadBitmap(String urlStr) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(urlStr).openConnection();
            c.setConnectTimeout(6000);
            c.setReadTimeout(6000);
            if (c.getResponseCode() != 200) return null;
            try (InputStream in = c.getInputStream()) {
                return BitmapFactory.decodeStream(in);
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 裁成圆形，通知的 largeIcon 是圆的才好看。 */
    private Bitmap circleCrop(Bitmap src) {
        int size = Math.min(src.getWidth(), src.getHeight());
        if (size <= 0) return src;
        Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(out);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        BitmapShader shader = new BitmapShader(src, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
        p.setShader(shader);
        float r = size / 2f;
        c.drawCircle(r, r, r, p);
        return out;
    }

    /** 兜底：没设过头像就画一个圆底 + 首字。 */
    private Bitmap drawFallback(String id) {
        int color;
        String ch;
        if ("ajing".equals(id)) { color = 0xFF2D8F8F; ch = "鲸"; }
        else if ("yuejian".equals(id)) { color = 0xFF8A7BD8; ch = "见"; }
        else if ("xiyan".equals(id)) { color = 0xFFD88A5B; ch = "颜"; }
        else { color = 0xFF5B6EE1; ch = "群"; }

        int size = 144;
        Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

        p.setColor(color);
        c.drawCircle(size / 2f, size / 2f, size / 2f, p);

        p.setColor(Color.WHITE);
        p.setTextSize(size * 0.46f);
        p.setTextAlign(Paint.Align.CENTER);
        p.setFakeBoldText(true);
        Paint.FontMetrics fm = p.getFontMetrics();
        float baseline = size / 2f - (fm.ascent + fm.descent) / 2f;
        c.drawText(ch, size / 2f, baseline, p);
        return bmp;
    }

    private String httpGet(String urlStr, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            URL u = new URL(urlStr);
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(timeoutMs);
            c.setRequestMethod("GET");
            int code = c.getResponseCode();
            if (code != 200) return null;
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            return sb.toString();
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        if (worker != null) worker.interrupt();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    public static void start(Context ctx) {
        Intent i = new Intent(ctx, PushService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(i);
        } else {
            ctx.startService(i);
        }
    }
}
