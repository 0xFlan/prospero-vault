// acpack — builds PS5 packages, including additional content (AC / DLC).
//
// This is a front end for LibProsperoPkg, which implements the package format
// (FIH container, AES-XTS PFS, metadata signing, NAPS layout, the install
// archive). Everything hard about the format lives there; what this tool adds is
// the content-type decision and the checks around it: read the source's own
// metadata, pick the right package mode, build, then confirm the result is what
// was asked for.
//
// Two commands:
//
//   acpack inspect <folder>
//       Reads sce_sys/param.json and reports what kind of content it is.
//
//   acpack build --source <folder> --output <folder> [options]
//       Builds a debug package. Progress goes to stdout as "<n>%" lines, which
//       is what Prospero Vault parses, and the last line is a RESULT object.
//
// Options:
//   --mode <auto|ac|ac-nodata|app>   default auto (from the source metadata)
//   --content-id <id>                default: the source's param.json
//   --title-id <id>                  default: derived from the content id
//   --version <NN.NN>                default: the source's contentVersion
//   --passcode <32 chars>            default: 32 zeros (debug passcode)
//   --title <name>                   default: the source's title
//   --no-fake-sign                   do not fake-sign raw ELF modules
//   --keep-license                   write a license record instead of license-free

using System.Text.Json;
using LibProsperoPkg;
using LibProsperoPkg.NpDrm;
using LibProsperoPkg.PKG;

namespace ProsperoAcPack;

internal static class Program
{
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0 || args[0] is "-h" or "--help" or "help")
            {
                PrintUsage();
                return args.Length == 0 ? 2 : 0;
            }

            return args[0] switch
            {
                "inspect" => Inspect(args.Skip(1).ToArray()),
                "build" => Build(args.Skip(1).ToArray()),
                _ => Fail($"Unknown command '{args[0]}'. Try --help."),
            };
        }
        catch (Exception error)
        {
            Console.Error.WriteLine($"acpack: {error.Message}");
            return 1;
        }
    }

    private static void PrintUsage()
    {
        Console.WriteLine("""
            acpack — PS5 package builder (application and additional content)

              acpack inspect <folder>
              acpack build --source <folder> --output <folder> [options]

            Options: --mode, --content-id, --title-id, --version, --passcode,
                     --title, --no-fake-sign, --keep-license
            """);
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine($"acpack: {message}");
        return 1;
    }

    // ---------------------------------------------------------------- inspect

    /// <summary>What the source says it is, and what we would therefore build.</summary>
    private sealed record SourceFacts(
        string Folder,
        string? ContentId,
        string? TitleId,
        string? Category,
        string? Title,
        string? Version,
        bool IsAdditionalContent,
        string Mode,
        bool HasParamJson,
        bool HasSecSys,
        List<string> Missing);

    private static int Inspect(string[] args)
    {
        if (args.Length != 1) return Fail("inspect takes exactly one folder");
        var facts = ReadSource(Path.GetFullPath(args[0]));

        Console.WriteLine(JsonSerializer.Serialize(new
        {
            ok = facts.Missing.Count == 0,
            facts.Folder,
            facts.ContentId,
            facts.TitleId,
            facts.Category,
            facts.Title,
            facts.Version,
            kind = facts.IsAdditionalContent ? "ac" : "app",
            facts.Mode,
            facts.HasParamJson,
            facts.HasSecSys,
            missing = facts.Missing,
        }, Json));

        return facts.Missing.Count == 0 ? 0 : 1;
    }

    // ------------------------------------------------------------------ build

    private static int Build(string[] args)
    {
        var options = ParseBuildArguments(args);
        if (options is null) return 2;

        var facts = ReadSource(options.Source);

        // A source without metadata cannot be packaged: every downstream field
        // (content id, title, version) would have to be invented, and a package
        // built on invented ids installs as the wrong thing or not at all.
        if (facts.Missing.Count > 0)
        {
            return Fail($"{options.Source} cannot be packaged — missing {string.Join(", ", facts.Missing)}");
        }

        var mode = options.Mode ?? facts.Mode;
        var packageMode = mode switch
        {
            "ac" => ProsperoPackageMode.AdditionalContentData,
            "ac-nodata" => ProsperoPackageMode.AdditionalContentNoData,
            "app" => ProsperoPackageMode.Application,
            _ => throw new ArgumentException($"Unknown mode '{mode}'"),
        };

        // The mode must agree with the metadata, or the console gets a package
        // whose header and param.json disagree about what it is.
        if (facts.IsAdditionalContent && packageMode == ProsperoPackageMode.Application)
            return Fail($"this source is additional content (category '{facts.Category}'), not an application");
        if (!facts.IsAdditionalContent && packagesAdditionalContent(packageMode))
            return Fail($"this source is an application (category '{facts.Category}'), not additional content");

        var contentId = options.ContentId ?? facts.ContentId;
        if (string.IsNullOrWhiteSpace(contentId) || !ProsperoPackageBuilder.IsValidContentId(contentId))
            return Fail($"'{contentId}' is not a valid content id");

        // A content id is <publisher>-<title id>_<service>-<label>; the title id
        // is the middle field's first nine characters, not a composed id.
        var titleId = options.TitleId ?? facts.TitleId ?? DeriveTitleId(contentId);
        if (string.IsNullOrWhiteSpace(titleId) || !ProsperoPackageBuilder.IsValidTitleId(titleId))
            return Fail($"cannot determine a valid title id from '{contentId}'");

        Directory.CreateDirectory(options.Output);

        Console.WriteLine($"acpack: {mode} · {contentId} · {facts.Title ?? titleId}");

        var build = new ProsperoBuildOptions
        {
            Mode = packageMode,
            OutputFormat = ProsperoOutputFormat.DebugImage,
            SourceFolder = options.Source,
            OutputFolder = options.Output,
            ContentId = contentId,
            Passcode = options.Passcode ?? new string('0', 32),
            Title = options.Title ?? facts.Title,
            TitleId = titleId,
            Version = NormalizeVersion(options.Version ?? facts.Version),
            LicenseFree = !options.KeepLicense,
            FakeSignSelfModules = !options.NoFakeSign,
        };

        var result = ProsperoPackageBuilder.Build(build, line => Console.WriteLine(line));
        if (result is null || string.IsNullOrEmpty(result.OutputPath) || !File.Exists(result.OutputPath))
            return Fail("the builder reported success but produced no package");

        foreach (var warning in result.Warnings)
            Console.WriteLine($"warning: {warning}");

        Console.WriteLine($"100% built {result.OutputPath}");

        // Verification is the point of the second half of this tool: a build that
        // reports success is not the same as a package the mount path accepts.
        var accepted = false;
        var classification = "unknown";
        var hasAc = false;

        try
        {
            var report = ProsperoPkgValidator.Validate(result.OutputPath, contentId);
            accepted = report.Accepted;
            foreach (var check in report.Checks.Where(c => c.Status != ProsperoCheckStatus.Pass))
                Console.WriteLine($"check: {check.Status} {check.Name}");
        }
        catch (Exception error)
        {
            Console.WriteLine($"warning: acceptance check failed to run ({error.Message})");
        }

        try
        {
            var info = ProsperoNpDrmContentInfo.Read(result.OutputPath);
            hasAc = info.ContentId == contentId;
            classification = $"drm=0x{info.DrmType:X2} type=0x{info.ContentType:X2} nested={info.IsNestedImage} finalized={info.IsFinalized} patch={info.PatchKind}";
        }
        catch (Exception error)
        {
            Console.WriteLine($"warning: content-info check failed to run ({error.Message})");
        }

        var size = new FileInfo(result.OutputPath).Length;
        Console.WriteLine("RESULT " + JsonSerializer.Serialize(new
        {
            ok = accepted,
            pkg = result.OutputPath,
            mode,
            contentId,
            titleId,
            bytes = size,
            accepted,
            classification,
            contentIdMatches = hasAc,
            licenseFree = result.LicenseFree,
            warnings = result.Warnings,
        }, Json));

        return accepted ? 0 : 1;

        static bool packagesAdditionalContent(ProsperoPackageMode mode) =>
            ProsperoPackageBuilder.IsDlcMode(mode);

        static string? DeriveTitleId(string contentId)
        {
            var fields = contentId.Split('-');
            return fields.Length >= 2 && fields[1].Length >= 9 ? fields[1][..9] : null;
        }

        // The builder takes NN.NN; param.json carries things like 01.000.000.
        static string NormalizeVersion(string? version)
        {
            if (string.IsNullOrWhiteSpace(version)) return "01.00";
            var parts = version.Split('.');
            if (parts.Length == 1 && parts[0].Length == 4) return $"{parts[0][..2]}.{parts[0][2..]}";
            if (parts.Length >= 2)
                return $"{parts[0].PadLeft(2, '0')}.{parts[1].PadRight(2, '0')[..2]}";
            return "01.00";
        }
    }

    // ------------------------------------------------------------- arguments

    private sealed class BuildArguments
    {
        public string Source { get; init; } = "";
        public string Output { get; init; } = "";
        public string? Mode { get; init; }
        public string? ContentId { get; init; }
        public string? TitleId { get; init; }
        public string? Version { get; init; }
        public string? Passcode { get; init; }
        public string? Title { get; init; }
        public bool NoFakeSign { get; init; }
        public bool KeepLicense { get; init; }
    }

    private static BuildArguments? ParseBuildArguments(string[] args)
    {
        string? source = null, output = null, mode = null, contentId = null, titleId = null;
        string? version = null, passcode = null, title = null;
        var noFakeSign = false;
        var keepLicense = false;

        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--source": source = Next(args, ref i); break;
                case "--output": output = Next(args, ref i); break;
                case "--mode": mode = Next(args, ref i); break;
                case "--content-id": contentId = Next(args, ref i); break;
                case "--title-id": titleId = Next(args, ref i); break;
                case "--version": version = Next(args, ref i); break;
                case "--passcode": passcode = Next(args, ref i); break;
                case "--title": title = Next(args, ref i); break;
                case "--no-fake-sign": noFakeSign = true; break;
                case "--keep-license": keepLicense = true; break;
                default:
                    Console.Error.WriteLine($"acpack: unknown option '{args[i]}'");
                    return null;
            }
        }

        if (string.IsNullOrWhiteSpace(source) || string.IsNullOrWhiteSpace(output))
        {
            Console.Error.WriteLine("acpack: --source and --output are required");
            return null;
        }

        if (passcode is { Length: not 32 })
        {
            Console.Error.WriteLine("acpack: --passcode must be exactly 32 characters");
            return null;
        }

        return new BuildArguments
        {
            Source = Path.GetFullPath(source),
            Output = Path.GetFullPath(output),
            Mode = mode,
            ContentId = contentId,
            TitleId = titleId,
            Version = version,
            Passcode = passcode,
            Title = title,
            NoFakeSign = noFakeSign,
            KeepLicense = keepLicense,
        };

        static string? Next(string[] args, ref int index) =>
            index + 1 < args.Length ? args[++index] : null;
    }

    // --------------------------------------------------------------- metadata

    private static readonly JsonSerializerOptions Json = new()
    {
        WriteIndented = false,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    /// <summary>
    /// Reads the content's own metadata. param.json is the only source of truth
    /// we trust for the content id, title and category.
    /// </summary>
    private static SourceFacts ReadSource(string folder)
    {
        var missing = new List<string>();
        var sceSys = Path.Combine(folder, "sce_sys");
        var paramPath = Path.Combine(sceSys, "param.json");

        var hasSecSys = Directory.Exists(sceSys);
        var hasParam = File.Exists(paramPath);
        if (!hasSecSys) missing.Add("sce_sys/");
        if (!hasParam) missing.Add("sce_sys/param.json");

        string? contentId = null, titleId = null, category = null, title = null, version = null;

        if (hasParam)
        {
            using var document = JsonDocument.Parse(File.ReadAllText(paramPath));
            var root = document.RootElement;

            contentId = Text(root, "contentId");
            titleId = Text(root, "titleId");
            category = Text(root, "applicationCategoryType");
            version = Text(root, "contentVersion") ?? Text(root, "masterVersion");

            // localizedParameters is keyed by language; defaultLanguage says
            // which one to prefer. Titles are per language, not per file.
            if (root.TryGetProperty("localizedParameters", out var localized))
            {
                var preferred = Text(localized, "defaultLanguage") ?? "en-US";
                if (localized.TryGetProperty(preferred, out var entry)) title = Text(entry, "titleName");
                if (title is null)
                {
                    foreach (var language in localized.EnumerateObject())
                    {
                        if (language.Value.ValueKind != JsonValueKind.Object) continue;
                        title = Text(language.Value, "titleName");
                        if (title is not null) break;
                    }
                }
            }

            if (contentId is null) missing.Add("contentId in param.json");
        }

        // A category starting with "ac" (or "addcont") is additional content;
        // "gp" is an update; everything else is a base application.
        var isAc = category is not null &&
                   (category.StartsWith("ac", StringComparison.OrdinalIgnoreCase) ||
                    category.StartsWith("addcont", StringComparison.OrdinalIgnoreCase));

        var mode = isAc ? "ac" : "app";

        return new SourceFacts(folder, contentId, titleId, category, title, version, isAc, mode, hasParam, hasSecSys, missing);
    }

    private static string? Text(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
