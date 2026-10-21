// Splash.cs — the window AeterMC-Setup.exe shows while it unpacks the app.
// Compiled by installer/build-splash.js with the C# compiler that ships with Windows (.NET Framework 4).
// The /*@...@*/ placeholders are filled in by that script: theme colors and the logo polygons.
//
// Usage: splash.exe <pid of the setup stub>
// Closes itself when the installer window ("Установка AeterMC") appears, when the stub exits,
// or after three minutes.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

static class Theme
{
    public static readonly Color Bg = ColorTranslator.FromHtml("/*@BG@*/");
    public static readonly Color Line = ColorTranslator.FromHtml("/*@LINE@*/");
    public static readonly Color Text = ColorTranslator.FromHtml("/*@TEXT@*/");
    public static readonly Color Muted = ColorTranslator.FromHtml("/*@MUTED@*/");
    public static readonly Color Accent = ColorTranslator.FromHtml("/*@ACCENT@*/");
    public const string InstallerTitle = "/*@INSTALLER_TITLE@*/";
    // logo.svg: groups of polygons (opacity, flat x,y list) in its 1048×1048 viewBox starting at 500,500
    public static readonly float[] LogoOpacity = { /*@LOGO_OPACITY@*/ };
    public static readonly int[][] LogoPolygons = { /*@LOGO_POLYGONS@*/ };
}

class SplashForm : Form
{
    const int BaseW = 440, BaseH = 240;
    readonly float scale;
    readonly Stopwatch clock = Stopwatch.StartNew();
    readonly Timer frame = new Timer { Interval = 16 };
    readonly Timer watch = new Timer { Interval = 150 };
    readonly int stubPid;
    readonly Font titleFont, captionFont;
    readonly StringFormat center = new StringFormat { Alignment = StringAlignment.Center };
    long closingAt = -1;

    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);

    public SplashForm(int stubPid, float scale)
    {
        this.stubPid = stubPid;
        this.scale = scale;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        ShowInTaskbar = false;
        TopMost = true;
        BackColor = Theme.Bg;
        ClientSize = new Size((int)(BaseW * scale), (int)(BaseH * scale));
        Opacity = 0;
        Text = "AeterMC";
        titleFont = new Font(PickFont("Segoe UI Variable Display", "Segoe UI Semibold"), 17f * scale, FontStyle.Bold, GraphicsUnit.Pixel);
        captionFont = new Font(PickFont("Segoe UI Variable Text", "Segoe UI"), 12.5f * scale, FontStyle.Regular, GraphicsUnit.Pixel);
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);

        frame.Tick += (s, e) => Tick();
        watch.Tick += (s, e) => Watch();
    }

    protected override bool ShowWithoutActivation { get { return false; } }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Windows 11: native rounded corners and a 1px border in the theme's line color
        int round = 2; // DWMWCP_ROUND
        bool rounded = DwmSetWindowAttribute(Handle, 33, ref round, 4) == 0;
        int border = ColorTranslator.ToWin32(Theme.Line);
        DwmSetWindowAttribute(Handle, 34, ref border, 4);
        if (!rounded)
        {
            // older Windows: clip the window to a rounded rectangle instead
            using (var path = RoundRect(new RectangleF(0, 0, ClientSize.Width, ClientSize.Height), 12 * scale))
                Region = new Region(path);
        }
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        frame.Start();
        watch.Start();
    }

    void Tick()
    {
        double t = clock.Elapsed.TotalSeconds;
        if (closingAt < 0) Opacity = Math.Min(1, t / 0.22);
        else
        {
            double left = 1 - (clock.ElapsedMilliseconds - closingAt) / 160.0;
            if (left <= 0) { Close(); return; }
            Opacity = left;
        }
        Invalidate();
    }

    void Watch()
    {
        if (closingAt >= 0) return;
        IntPtr installer = FindWindow(null, Theme.InstallerTitle);
        bool stubGone = false;
        if (stubPid > 0)
        {
            try { stubGone = Process.GetProcessById(stubPid).HasExited; } catch { stubGone = true; }
        }
        if ((installer != IntPtr.Zero && IsWindowVisible(installer)) || stubGone || clock.Elapsed.TotalMinutes > 3)
            closingAt = clock.ElapsedMilliseconds;
    }

    static GraphicsPath RoundRect(RectangleF r, float radius)
    {
        var p = new GraphicsPath();
        float d = radius * 2;
        if (d > r.Height) d = r.Height;
        if (d > r.Width) d = r.Width;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    static Color WithAlpha(Color c, double a)
    {
        return Color.FromArgb((int)Math.Round(Math.Max(0, Math.Min(1, a)) * 255), c);
    }

    static double EaseInOut(double x) { return x < 0.5 ? 2 * x * x : 1 - Math.Pow(-2 * x + 2, 2) / 2; }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        g.Clear(Theme.Bg);
        double t = clock.Elapsed.TotalSeconds;
        float cx = ClientSize.Width / 2f;

        // Logo: the same slow pulse as the installer's progress screen (1.6 s, down to 55% / 94%)
        double pulse = (1 - Math.Cos(t / 1.6 * 2 * Math.PI)) / 2;
        float logoSize = 64 * scale * (float)(1 - 0.06 * pulse);
        float logoAlpha = (float)(1 - 0.45 * pulse);
        float logoTop = 44 * scale + (64 * scale - logoSize) / 2;
        float k = logoSize / 1048f;
        float ox = cx - logoSize / 2;
        for (int i = 0; i < Theme.LogoPolygons.Length; i++)
        {
            int[] pts = Theme.LogoPolygons[i];
            var poly = new PointF[pts.Length / 2];
            for (int j = 0; j < poly.Length; j++)
                poly[j] = new PointF(ox + (pts[j * 2] - 500) * k, logoTop + (pts[j * 2 + 1] - 500) * k);
            using (var b = new SolidBrush(WithAlpha(Theme.Accent, Theme.LogoOpacity[i] * logoAlpha)))
                g.FillPolygon(b, poly);
        }

        // Title and caption
        using (var tb = new SolidBrush(Theme.Text))
            g.DrawString("AeterMC", titleFont, tb, new PointF(cx, 124 * scale), center);
        using (var cb = new SolidBrush(Theme.Muted))
            g.DrawString("Подготовка установки…", captionFont, cb, new PointF(cx, 152 * scale), center);

        // Indeterminate bar: a quarter of the track slides across and back in (1.1 s, like the launcher's)
        float tw = 160 * scale, th = 3 * scale, tx = cx - tw / 2, ty = 192 * scale;
        using (var track = RoundRect(new RectangleF(tx, ty, tw, th), th / 2))
        using (var tb = new SolidBrush(Theme.Line))
            g.FillPath(tb, track);
        double phase = EaseInOut((t % 1.1) / 1.1);
        float fw = tw * 0.25f;
        float fx = tx - fw + (float)phase * (tw + fw);
        var clip = g.Clip;
        g.SetClip(new RectangleF(tx, ty, tw, th));
        using (var fill = RoundRect(new RectangleF(fx, ty, fw, th), th / 2))
        using (var fb = new SolidBrush(Theme.Accent))
            g.FillPath(fb, fill);
        g.Clip = clip;
    }

    static FontFamily PickFont(string preferred, string fallback)
    {
        foreach (var f in FontFamily.Families)
            if (f.Name == preferred) return f;
        foreach (var f in FontFamily.Families)
            if (f.Name == fallback) return f;
        return FontFamily.GenericSansSerif;
    }
}

static class Program
{
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

    [STAThread]
    static void Main(string[] args)
    {
        SetProcessDPIAware();
        int pid = 0;
        if (args.Length > 0) int.TryParse(args[0], out pid);
        float scale;
        using (var g = Graphics.FromHwnd(IntPtr.Zero)) scale = g.DpiX / 96f;
        Application.EnableVisualStyles();
        Application.Run(new SplashForm(pid, scale));
    }
}
