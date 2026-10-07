// 這一份 scripts/web-deck/source.json 已經建過了嗎？（.github/workflows/web-deck.yml 第一步問的）
//
// push 的 paths 條件只看「source.json 有沒有改」：分支上把 run 加一、建好、合併到 main 時，main 也算「改了」，
// 分支改回 main 的那一次 push 也是——但那一份早就建過了。再建一次只會多一個只差建置時間的 commit（直接進 main），
// 而母簡報的分享照規定建好就關，那時候再下載只會失敗、在 main 上掛一個紅叉。
// 所以 deck.json 記著是從哪一份 source.json 建的（`source.hash`），一樣就不建；手動觸發（workflow_dispatch）一律重建。
//
//   node scripts/web-deck/needs-build.mjs   → 印 true（要建）或 false（建過了），理由寫在 stderr
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** source.json 的指紋（build.mjs 寫進 deck.json 的 source.hash，這裡拿來比）。 */
export const sourceHash = (source) => createHash("sha1").update(JSON.stringify(source)).digest("hex").slice(0, 12);

/** 要不要建：deck.json 沒有、沒記指紋（舊版）、或指紋對不上就要。 */
export const needsBuild = (source, deckJson) => deckJson?.source?.hash !== sourceHash(source);

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const source = JSON.parse(await readFile(path.join(ROOT, "scripts/web-deck/source.json"), "utf8"));
  let deck = null;
  try {
    deck = JSON.parse(await readFile(path.join(ROOT, "public/data/deck.json"), "utf8"));
  } catch {}
  const need = needsBuild(source, deck);
  console.error(need ? `要建（source.json ${sourceHash(source)}，deck.json 記的是 ${deck?.source?.hash || "（沒有）"}）` : `這一份 source.json（${sourceHash(source)}）已經建過了，不必再建`);
  console.log(need ? "true" : "false");
}
