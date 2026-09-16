// Prepare external acceptance assets. The font and document never enter the PAK.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { bakeFontArchive } from "../framework/compiler/font-archive.ts";
const out = resolve(Bun.argv[2] ?? ".pocket-build/text-lab");
const revision = "f8d157532fbfaeda587e826d4cd5b21a49186f7c";
const sha = "68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5";
await mkdir(join(out, "fonts"), { recursive: true });
const source = join(out, "NotoSansCJKjp-Regular.otf");
let font: Uint8Array;
try {
  font = await readFile(source);
} catch {
  const response = await fetch(
    `https://raw.githubusercontent.com/notofonts/noto-cjk/${revision}/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf`,
  );
  if (!response.ok) throw new Error(`Font download failed: ${response.status}`);
  font = new Uint8Array(await response.arrayBuffer());
}
if (createHash("sha256").update(font).digest("hex") !== sha)
  throw new Error("Font source checksum mismatch");
await writeFile(source, font);
const archive = await bakeFontArchive({
  font: source,
  slots: [0, 2, 4],
  onStrike: (slot, count) => console.log(`slot ${slot}: ${count} glyphs`),
});
await writeFile(join(out, "fonts/cjk.pjfa"), archive);
await writeFile(
  join(out, "text-lab.txt"),
  [
    "动态字库验收：这些文字来自记忆棒，编译程序时并未声明。",
    "汉字、日文假名和符号使用普通文本组件展示。",
    "気迫。日本語の文章をメモリースティックから読み込みます。",
    "東京、大阪、京都。春夏秋冬、山川草木、風林火山。",
    "体験、読書、冒険、観察。新しい文字も必要な分だけ読み込みます。",
    "罕见字：龘麤靐齉。补充平面：𠮷。",
    "修改这个文件并按 X，无需重新编译应用。",
    "一二三四五六七八九十。天地玄黄，宇宙洪荒。",
    "これはコンパニオン接続を必要としません。",
    "缓存压力测试后返回，字形与段落应当保持一致。",
    "",
  ].join("\n"),
);
await writeFile(
  join(out, "fonts/LICENSE-NotoSansCJK.txt"),
  await readFile(
    new URL("../assets/fonts/LICENSE-NotoSansCJK.txt", import.meta.url),
  ),
);
console.log(
  `Copy fonts/ and text-lab.txt from ${out} to ms0:/PSP/COMMON/pocketjs/`,
);
console.log(
  `Archive: ${archive.length} bytes, SHA256 ${createHash("sha256").update(archive).digest("hex")}`,
);
