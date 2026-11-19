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

/**
 * A retail-shaped eboot: a real ELF64 x86-64 executable with two PT_LOAD
 * segments. `cc` on this Mac would emit Mach-O, which is not the shape a dump
 * carries, so the file is written byte for byte instead.
 */
async function realElf(target: string): Promise<boolean> {
  const size = 0x4000;
  const image = Buffer.alloc(size);
  image.write("\x7fELF", 0, "latin1");
  image[4] = 2; // ELFCLASS64
  image[5] = 1; // ELFDATA2LSB
  image[6] = 1; // EV_CURRENT
  image.writeUInt16LE(2, 16); // ET_EXEC
  image.writeUInt16LE(0x3e, 18); // EM_X86_64
  image.writeUInt32LE(1, 20);
  image.writeBigUInt64LE(0x400000n + 0x78n, 24); // entry
  image.writeBigUInt64LE(64n, 32); // phoff
  image.writeUInt16LE(64, 52);
  image.writeUInt16LE(56, 54);
  image.writeUInt16LE(2, 56); // two PT_LOAD segments

  const writeSegment = (index: number, offset: number, vaddr: number) => {
    const at = 64 + index * 56;
    image.writeUInt32LE(1, at); // PT_LOAD
    image.writeUInt32LE(5, at + 4); // R+X
    image.writeBigUInt64LE(BigInt(offset), at + 8);
    image.writeBigUInt64LE(BigInt(vaddr), at + 16);
    image.writeBigUInt64LE(BigInt(vaddr), at + 24);
    image.writeBigUInt64LE(0x2000n, at + 32);
    image.writeBigUInt64LE(0x2000n, at + 40);
    image.writeBigUInt64LE(0x1000n, at + 48);
  };
  writeSegment(0, 0x1000, 0x400000);
  writeSegment(1, 0x3000, 0x402000);

  // Some plausible code so the image is not a hole.
  for (let i = 0; i < 256; i++) image[0x1000 + i] = (i * 37 + 11) & 0xff;
  image[0x1000] = 0x55; // push rbp
  image[0x1001] = 0xc3; // ret
  await writeFile(target, image);
  return true;
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

  // 5. Retail-shaped: a real compiled ELF eboot with PT_LOAD segments.
  const retail = join(root, "retail", "PPSA09010");
  await mkdir(join(retail, "sce_sys"), { recursive: true });
  await writeFile(
    join(retail, "sce_sys", "param.json"),
    JSON.stringify(
      PARAM({
        titleId: "PPSA09010",
        titleName: "Retail Shaped Title",
        contentId: "UP0000-PPSA09010_00-RETAIL0000000001",
      }),
    ),
  );
  await writeFile(join(retail, "sce_sys", "icon0.png"), PNG);
  const elfMade = await realElf(join(retail, "eboot.bin"));
  fixtures.push({ name: "retail", path: retail, titleId: "PPSA09010", valid: elfMade });

  const retailConsole = join(root, "retail", "PPSA09012");
  await mkdir(join(retailConsole, "sce_sys"), { recursive: true });
  await writeFile(
    join(retailConsole, "sce_sys", "param.json"),
    JSON.stringify(
      PARAM({
        titleId: "PPSA09012",
        titleName: "Retail Console Title",
        contentId: "UP0000-PPSA09012_00-RETAIL0000000002",
      }),
    ),
  );
  await writeFile(join(retailConsole, "sce_sys", "icon0.png"), PNG);
  await realElf(join(retailConsole, "eboot.bin"));
  fixtures.push({ name: "retail-console", path: retailConsole, titleId: "PPSA09012", valid: true });

  // 6. Malformed: an encrypted eboot (not an ELF) is a decryption problem, not
  // a packer problem, and the gate has to say which.
  const encrypted = join(root, "broken", "PPSA09011");
  await mkdir(join(encrypted, "sce_sys"), { recursive: true });
  await writeFile(
    join(encrypted, "sce_sys", "param.json"),
    JSON.stringify(PARAM({ titleId: "PPSA09011", contentId: "UP0000-PPSA09011_00-SYNTHETIC0000011" })),
  );
  const noise = new Uint8Array(64 * 1024);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 131 + 17) & 0xff;
  await writeFile(join(encrypted, "eboot.bin"), noise);
  fixtures.push({ name: "encrypted-eboot", path: encrypted, titleId: "PPSA09011", valid: false, expect: "ELF" });

  // 7. Malformed: eboot but no metadata at all.
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
