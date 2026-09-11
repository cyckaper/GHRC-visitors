/**
 * Node 端入口：把 jszip 與 @xmldom/xmldom 注入共用核心（public/lib/pptx.mjs），再整個轉出。
 * 核心沒有 Node 相依，同一份程式在 admin.html 裡由瀏覽器直接執行（window.JSZip ＋ 原生 DOMParser）。
 */
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import { configure } from "../../public/lib/pptx.mjs";

configure({ JSZip, DOMParser });

export * from "../../public/lib/pptx.mjs";
