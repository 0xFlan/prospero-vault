/**
 * Synthesizes realistic PS5 dump shapes for the dump checks. No game data is
 * shipped: every file here is generated (the payload ELF stands in for eboot,
 * and the large fixture pads it with zeros).
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type DumpFixture = {
  name: string;
  path: string;
  titleId: string;
  valid: boolean;
  expect?: string;
};

const PARAM = (over: Record<string, unknown>) => ({
  titleId: "PPSA09001",
  titleName: "Synthetic Title",
  applicationCategoryType: "gd",
  contentId: "UP0000-PPSA09001_00-SYNTHETIC0000001",
  version: "01.00",
  ...over,
});

async function eboot(target: string): Promise<void> {
  await copyFile(join(process.cwd(), "console", "build", "prospero-vault.elf"), target);
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export async function makeDumpFixtures(
  root: string,
  options: { largeMB?: number } = {},
): Promise<DumpFixture[]> {
  const fixtures: DumpFixture[] = [];

  // 1. PkgEditor-style: a folder named after the title, sce_sys/ beside eboot.
  const editor = join(root, "pkg-editor", "PPSA09001-app");
  await mkdir(join(editor, "sce_sys"), { recursive: true });
  await writeFile(join(editor, "sce_sys", "param.json"), JSON.stringify(PARAM({}), null, 2));
  await writeFile(join(editor, "sce_sys", "icon0.png"), PNG);
  await eboot(join(editor, "eboot.bin"));

  fixtures.push({ name: "pkg-editor", path: editor, titleId: "PPSA09001", valid: true });

  // 2. Odd filenames: uppercase metadata, a title-named folder, unrelated files.
  const odd = join(root, "odd-names", "Synthetic Game (USA)");
  await mkdir(join(odd, "SCE_SYS"), { recursive: true });
  await writeFile(join(odd, "SCE_SYS", "PARAM.JSON"), JSON.stringify(PARAM({ titleId: "PPSA09002", contentId: "UP0000-PPSA09002_00-SYNTHETIC0000002" })));
  await writeFile(join(odd, "SCE_SYS", "ICON0.PNG"), PNG);
  await eboot(join(odd, "EBOOT.BIN"));
  await writeFile(join(odd, "readme.txt"), "copied from a backup");
  await writeFile(join(odd, ".DS_Store"), "junk");
  await mkdir(join(odd, "__MACOSX"), { recursive: true });
  await writeFile(join(odd, "__MACOSX", "._param.json"), "resource fork");
  fixtures.push({ name: "odd-names", path: odd, titleId: "PPSA09002", valid: true });

  // 3. DLC: its own content id, category ac, no eboot.
  const dlc = join(root, "dlc", "UP0000-PPSA09003_00-SYNTHETICDLC0001");
  await mkdir(join(dlc, "sce_sys"), { recursive: true });
  await writeFile(
    join(dlc, "sce_sys", "param.json"),
    JSON.stringify(
      PARAM({
        titleId: "PPSA09003",
        titleName: "Synthetic Title — Add-on",
        applicationCategoryType: "ac",
        contentId: "UP0000-PPSA09003_00-SYNTHETICDLC0001",
      }),
    ),
  );
  await writeFile(join(dlc, "sce_sys", "icon0.png"), PNG);
  await writeFile(join(dlc, "dlc.bin"), "additional content payload".repeat(256));
  fixtures.push({ name: "dlc", path: dlc, titleId: "PPSA09003", valid: true });

  // 4. Large payload: a few hundred MB of eboot, to exercise size and streaming.
  const large = join(root, "large", "PPSA09004");
  await mkdir(join(large, "sce_sys"), { recursive: true });
  await writeFile(
    join(large, "sce_sys", "param.json"),
    JSON.stringify(PARAM({ titleId: "PPSA09004", contentId: "UP0000-PPSA09004_00-SYNTHETIC0000004" })),
  );
  await writeFile(join(large, "sce_sys", "icon0.png"), PNG);
  await eboot(join(large, "eboot.bin"));
  // A large payload tree, incompressible on purpose: zeros would package to a
  // megabyte and prove nothing about size-dependent paths. The packer fake-signs
  // eboot and keeps only the ELF, so size has to live beside it.
  const target = (options.largeMB ?? 240) * 1024 * 1024;
  const chunk = new Uint8Array(4 * 1024 * 1024);
  let seed = 0x12345678;
  for (let i = 0; i < chunk.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    chunk[i] = seed & 0xff;
  }
  if (target > 0) {
    await mkdir(join(large, "data"), { recursive: true });
    const handle = Bun.file(join(large, "data", "stream.bin")).writer();
    let written = 0;
    while (written < target) {
      const take = Math.min(chunk.length, target - written);
      handle.write(chunk.subarray(0, take));
      written += take;
    }
    await handle.end();
  }
  fixtures.push({ name: "large", path: large, titleId: "PPSA09004", valid: true });

  // 5. Malformed: eboot but no metadata at all.
  const noMeta = join(root, "broken", "PPSA09005");
  await mkdir(noMeta, { recursive: true });
  await eboot(join(noMeta, "eboot.bin"));
  fixtures.push({ name: "no-metadata", path: noMeta, titleId: "PPSA09005", valid: false, expect: "param" });

  // 6. Malformed: metadata the packer rejects (content id is not valid).
  const badMeta = join(root, "broken", "PPSA09006");
  await mkdir(join(badMeta, "sce_sys"), { recursive: true });
  await writeFile(
    join(badMeta, "sce_sys", "param.json"),
    JSON.stringify(PARAM({ titleId: "PPSA09006", contentId: "not-a-content-id" })),
  );
  await eboot(join(badMeta, "eboot.bin"));
  fixtures.push({ name: "bad-content-id", path: badMeta, titleId: "PPSA09006", valid: false, expect: "content id" });

  // 7. Malformed: metadata but no executable. The packer would accept this and
  // produce a package that installs to nothing, so the app must refuse it.
  const noEboot = join(root, "broken", "PPSA09007");
  await mkdir(join(noEboot, "sce_sys"), { recursive: true });
  await writeFile(
    join(noEboot, "sce_sys", "param.json"),
    JSON.stringify(PARAM({ titleId: "PPSA09007", contentId: "UP0000-PPSA09007_00-SYNTHETIC0000007" })),
  );
  fixtures.push({ name: "no-eboot", path: noEboot, titleId: "PPSA09007", valid: false, expect: "eboot" });

  return fixtures;
}
