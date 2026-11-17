using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

internal static class StartMenuShortcut
{
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLink
    {
        void GetPath(); void GetIDList(); void SetIDList(); void GetDescription();
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string text);
        void GetWorkingDirectory();
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string path);
        void GetArguments(); void SetArguments(); void GetHotkey(); void SetHotkey();
        void GetShowCmd(); void SetShowCmd(); void GetIconLocation();
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
        void SetRelativePath(); void Resolve();
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey { public Guid format; public uint id; }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropertyValue
    {
        [FieldOffset(0)] public ushort type;
        [FieldOffset(8)] public IntPtr text;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        void GetCount(); void GetAt(); void GetValue();
        void SetValue(ref PropertyKey key, ref PropertyValue value);
        void Commit();
    }

    public static void Register(string executable, string appId)
    {
        string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        if (string.IsNullOrEmpty(programs)) throw new IOException("找不到当前用户的开始菜单目录");
        string directory = Path.GetDirectoryName(executable);
        string temporary = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (executable.StartsWith(temporary, StringComparison.OrdinalIgnoreCase))
            throw new IOException("请将 TermDock 完整解压到固定目录后再创建快捷方式");
        Directory.CreateDirectory(programs);
        Write(Path.Combine(programs, "TermDock.lnk"), executable, directory, appId);
    }

    private static void Write(string shortcut, string executable, string directory, string appId)
    {
        var instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046"), true));
        try
        {
            var link = (IShellLink)instance;
            link.SetPath(executable);
            link.SetWorkingDirectory(directory);
            link.SetIconLocation(executable, 0);
            link.SetDescription("TermDock");
            var store = (IPropertyStore)instance;
            var key = new PropertyKey { format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), id = 5 };
            var value = new PropertyValue { type = 31, text = Marshal.StringToCoTaskMemUni(appId) };
            try { store.SetValue(ref key, ref value); store.Commit(); }
            finally { Marshal.FreeCoTaskMem(value.text); }
            ((IPersistFile)instance).Save(shortcut, true);
        }
        finally { Marshal.FinalReleaseComObject(instance); }
    }
}
