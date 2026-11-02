/**
 * 照片在瀏覽器裡的處理——後台（admin.html）與研究室照片上傳頁（/photos）共用這一份，兩邊不會各長各的：
 *
 * - **HEIC**（iPhone、iPad 拍的）認得出來、轉成 JPEG：`isHeic`／`looksHeif`／`decodableImage`
 *   （實際回報：「要能讀 HEIC 檔」「要能收HEIC」——Claude 不收 HEIC，Chrome、Edge 也看不懂）
 * - **縮成照片庫要的大小**：`shrinkPhoto`（長邊 2560 的 JPEG ＋ 長邊 480 的縮圖；拍攝時間從 EXIF 讀）
 * - **打包下載**：`zipStore`（照片本來就壓過了，zip 不再壓縮，只是裝在一起）
 */

/**
 * - **認 HEIC 看檔案開頭**（ftyp 的 brand，`looksHeif`），不只看檔名與類型：AirDrop、轉寄來的檔常常沒有副檔名、類型是空的或寫錯。
 *   跟伺服器 http.mts 的 `isHeifBytes` 同一套：HEVC 的 brand，或只寫 mif1／msf1 又不是 AVIF。
 * - 瀏覽器自己解得開就用瀏覽器的（Safari 17 以後）；解不開才載 `/lib/vendor/heic-to.js`（libheif 1.23，約 3 MB、
 *   傳輸壓縮後 0.8 MB，第一次遇到 HEIC 才載）。以前的 heic2any 帶的是 2020 年的 libheif 1.10：iOS 18 之後的 iPhone 照片
 *   轉不了（「轉不成 JPEG」），10-bit 的轉出來是一片雜訊，之後同一頁再轉別張也會壞掉——實際拿各代 iPhone 的照片測過。
 * - 最多 16 MP（iPad 的 canvas 有面積上限，48 MP 的照片畫不上去；後面每一條路本來就還會再縮），透明的地方墊白底。
 * - 一張 12 MP 大約五秒，轉的時候 `note` 說一聲；兩分鐘還沒好就放棄、講一句人話。
 *   轉不過來**不要把 HEIC 原檔送上去**（送上去也讀不出來、來賓專頁上也看不到）：丟出來的錯誤帶 `heic: true`，呼叫的地方照這個判斷。
 */
export const HEVC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
export const isHeic = (f) => /^image\/hei[cf]/i.test(f?.type || "") || /\.(hei[cf]|hif)$/i.test(f?.name || "");

/** 檔案開頭的 ftyp 是不是 HEIF。 */
export async function looksHeif(f) {
  try {
    const b = new Uint8Array(await f.slice(0, 64).arrayBuffer());
    if (b.length < 16) return false;
    const tag = (at) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
    if (tag(4) !== "ftyp") return false;
    const size = Math.min(b.length, ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0 || 16);
    const brands = [tag(8)];
    for (let at = 16; at + 4 <= size; at += 4) brands.push(tag(at));
    return brands.some((x) => HEVC_BRANDS.has(x)) || ((brands[0] === "mif1" || brands[0] === "msf1") && !brands.some((x) => x === "avif" || x === "avis"));
  } catch (e) {
    return false;
  }
}

// 面積上限 16 MP（iPad 的 canvas 是照面積算的）、長邊上限 16384：又高又窄的捲動截圖保留原本的寬度，讀信第 1 步才切得清楚
const HEIC_AREA = 16e6, HEIC_EDGE = 16384, HEIC_WAIT = 120000;
let heicLib = null, heicLoads = 0; // 轉檔程式只載一次；載失敗就清掉，下一張換一個網址再試（瀏覽器會記住載失敗的那一個網址）

/**
 * HEIC 變成 JPEG（其他格式原樣回傳）。`reload` 是轉不過來時叫人做的那一句（後台寫「請重新整理後台再試一次」）。
 */
export async function decodableImage(file, note = () => {}, { reload = "請重新整理這一頁再試一次" } = {}) {
  if (!isHeic(file) && !(await looksHeif(file))) return file;
  const name = file.name || "這張照片";
  const heicError = (msg) => Object.assign(new Error(msg), { heic: true });
  let bmp = null, late = false;
  try { bmp = await createImageBitmap(file); } catch (e) { /* 這個瀏覽器看不懂 HEIC，交給轉檔程式 */ }
  try {
    if (!bmp) {
      note("HEIC 照片轉成 JPEG 中……一張大約五秒。");
      const work = (async () => {
        heicLib = heicLib || import(`/lib/vendor/heic-to.js${heicLoads++ ? `?r=${Date.now()}` : ""}`).catch((e) => { heicLib = null; throw e; });
        const { heicTo } = await heicLib.catch(() => { throw heicError(`HEIC 的轉檔程式沒有載入成功（網路不穩？）：${reload}`); });
        return await heicTo({ blob: file, type: "bitmap" });
      })();
      work.then((b) => { if (late) b?.close?.(); }, () => {}); // 等太久放棄了，晚到的那一張也要收掉
      let timer;
      const slow = new Promise((_, reject) => { timer = setTimeout(() => { late = true; reject(heicError(`${name} 轉了兩分鐘還沒好：${reload}，或在相簿裡把它匯出成 JPEG`)); }, HEIC_WAIT); });
      try { bmp = await Promise.race([work, slow]); } finally { clearTimeout(timer); }
    }
    const s = Math.min(1, Math.sqrt(HEIC_AREA / (bmp.width * bmp.height)), HEIC_EDGE / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.92));
    c.width = c.height = 1; // 大張的 canvas 馬上放掉（iPad 的記憶體）
    if (!blob) throw new Error("canvas");
    return new File([blob], `${String(file.name || "photo").replace(/\.[a-z0-9]{1,5}$/i, "")}.jpg`, { type: "image/jpeg" });
  } catch (e) {
    if (e?.heic) throw e;
    throw heicError(`${name} 是 HEIC，轉不成 JPEG：請在相簿裡把它匯出成 JPEG 再選一次`);
  } finally {
    try { bmp?.close?.(); } catch (e) { /* 已經關了 */ }
  }
}

/** 照片讀進 <img>（瀏覽器會照 EXIF 轉正：直拍的不會躺著）。 */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`${file.name || "這張照片"} 讀不出來：是不是壞掉的檔案？`)); };
    img.src = url;
  });
}

/** 畫到一張長邊不超過 `edge`（面積也不超過 16 MP）的 canvas，存成 JPEG。透明的地方墊白底。 */
async function encode(img, edge, quality) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const s = Math.min(1, edge / Math.max(w0, h0), Math.sqrt(HEIC_AREA / (w0 * h0)));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w0 * s)); c.height = Math.max(1, Math.round(h0 * s));
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
  const out = { blob, w: c.width, h: c.height };
  c.width = c.height = 1;
  if (!blob) throw new Error("這台裝置縮不了這張照片（記憶體不夠？）：請一次少選幾張再試");
  return out;
}

/**
 * JPEG 的拍攝時間（EXIF DateTimeOriginal，沒有就 DateTime）→ "2026-11-02T10:23:45"（相機上的時間，沒有時區）。
 * 照片庫照拍攝時間排、寫在照片旁邊；讀不到就空字串（從 iPhone 相簿選的，iOS 給的 JPEG 通常還帶著）。
 */
export async function exifTaken(file) {
  try {
    const b = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
    if (b[0] !== 0xff || b[1] !== 0xd8) return "";
    let at = 2;
    while (at + 4 < b.length && b[at] === 0xff) {
      const marker = b[at + 1], len = (b[at + 2] << 8) | b[at + 3];
      if (marker === 0xe1 && String.fromCharCode(...b.slice(at + 4, at + 8)) === "Exif") return tiffTaken(b, at + 10, len - 8);
      if (marker === 0xda) break; // 影像資料開始了，後面不會有 EXIF
      at += 2 + len;
    }
  } catch (e) { /* 讀不到就算了 */ }
  return "";
}

function tiffTaken(b, start, length) {
  const end = Math.min(b.length, start + length);
  const le = b[start] === 0x49; // "II"＝little-endian，"MM"＝big-endian
  const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
  const ascii = (o, n) => String.fromCharCode(...b.slice(o, o + n)).replace(/\0.*$/, "");
  const readIfd = (off) => {
    const out = {};
    const o = start + off;
    if (o + 2 > end) return out;
    const n = u16(o);
    for (let i = 0; i < n; i += 1) {
      const e = o + 2 + i * 12;
      if (e + 12 > end) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (type === 2 && count >= 19) out[tag] = ascii(start + u32(e + 8), 19);
      else if (type === 4 || type === 13) out[tag] = u32(e + 8);
    }
    return out;
  };
  const ifd0 = readIfd(u32(start + 4));
  const exif = ifd0[0x8769] ? readIfd(ifd0[0x8769]) : {};
  const raw = exif[0x9003] || exif[0x9004] || ifd0[0x0132] || "";
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  return m && m[1] !== "0000" ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : "";
}

/**
 * 照片庫要的那一份：**長邊 2560 的 JPEG**（印 A4、放簡報、做年報都夠，一張大約一 MB——原檔還在拍的人手機裡）
 * ＋**長邊 480 的縮圖**（後台的照片牆一次幾十張，不必每一張都載大圖）。HEIC 先轉 JPEG。
 * 回傳 { file, thumb, w, h, name（副檔名換成 .jpg）, taken（拍攝時間，讀不到就空字串） }。
 */
export async function shrinkPhoto(input, { edge = 2560, quality = 0.88, thumbEdge = 480, thumbQuality = 0.8, note = () => {}, reload } = {}) {
  const taken = await exifTaken(input);
  const file = await decodableImage(input, note, reload ? { reload } : undefined);
  const img = await loadImage(file);
  const full = await encode(img, edge, quality);
  const small = await encode(img, thumbEdge, thumbQuality);
  const stem = String(input.name || "photo").replace(/\.[a-z0-9]{1,5}$/i, "").slice(0, 100) || "photo";
  return { file: full.blob, thumb: small.blob, w: full.w, h: full.h, name: `${stem}.jpg`, taken };
}

/* ── zip（不壓縮）：照片下載成一個檔 ── */
let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 把幾個檔裝成一個 zip（STORE，不壓縮：JPEG 再壓也不會變小，還省時間）。檔名用 UTF-8（中文的拍照人名字、單位名稱）。
 * files: [{ name: "2026-11-02 九州大學/303/王小明_IMG_1234.jpg", bytes: Uint8Array, date?: Date }]。回傳 Blob。
 */
export function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const dos = (d) => {
    const t = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date();
    return {
      time: (t.getHours() << 11) | (t.getMinutes() << 5) | Math.floor(t.getSeconds() / 2),
      date: ((Math.max(1980, t.getFullYear()) - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate(),
    };
  };
  for (const f of files) {
    const name = enc.encode(String(f.name || "file").replace(/^\/+/, ""));
    const data = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
    const crc = crc32(data);
    const { time, date } = dos(f.date);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(6, 0x0800, true); // 檔名是 UTF-8
    head.setUint16(8, 0, true); // STORE
    head.setUint16(10, time, true);
    head.setUint16(12, date, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, data.length, true);
    head.setUint32(22, data.length, true);
    head.setUint16(26, name.length, true);
    head.setUint16(28, 0, true);
    parts.push(new Uint8Array(head.buffer), name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

/** 檔名裡不能有的字（Windows 也要打得開）換掉。 */
export const safeName = (s) => String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80);
