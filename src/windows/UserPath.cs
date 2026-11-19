using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;

internal static class UserPath
{
    public sealed class PathValue
    {
        public string Raw { get; set; }
        public string Kind { get; set; }
    }

    public sealed class PathChange
    {
        public PathValue Before { get; set; }
        public PathValue After { get; set; }
    }

    private static PathValue Read(RegistryKey key)
    {
        var raw = key == null ? null : key.GetValue("Path", null, RegistryValueOptions.DoNotExpandEnvironmentNames);
        if (raw == null) return new PathValue { Kind = "ExpandString" };
        var kind = key.GetValueKind("Path");
        if (kind != RegistryValueKind.String && kind != RegistryValueKind.ExpandString)
            throw new IOException("User PATH has an unsupported registry type.");
        return new PathValue { Raw = (string)raw, Kind = kind.ToString() };
    }

    public static void Run(string operation)
    {
        var json = new JavaScriptSerializer();
        using (var key = operation == "read" ? Registry.CurrentUser.OpenSubKey("Environment", false) : Registry.CurrentUser.CreateSubKey("Environment"))
        using (var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)))
        {
            var current = Read(key);
            if (operation == "read")
            {
                var machine = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.Machine) ?? "";
                var user = current.Kind == "ExpandString" ? Environment.ExpandEnvironmentVariables(current.Raw ?? "") : current.Raw ?? "";
                output.Write(json.Serialize(new { value = current, effectivePath = machine + ";" + user }));
                return;
            }
            if (operation != "write") throw new ArgumentException("Unknown user PATH operation.");
            using (var input = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8))
            {
                var change = json.Deserialize<PathChange>(input.ReadToEnd());
                if (change.Before.Raw != current.Raw || change.Before.Kind != current.Kind)
                    throw new IOException("User PATH changed in another program. Retry the save.");
                if (change.After.Raw == null) key.DeleteValue("Path", false);
                else
                {
                    var kind = change.After.Kind == "String" ? RegistryValueKind.String : RegistryValueKind.ExpandString;
                    key.SetValue("Path", change.After.Raw, kind);
                }
            }
        }
        IntPtr result;
        SendMessageTimeout(new IntPtr(0xffff), 0x001a, IntPtr.Zero, "Environment", 2, 150, out result);
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
}
