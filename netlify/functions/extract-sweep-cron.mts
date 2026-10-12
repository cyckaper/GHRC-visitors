import type { Config } from "@netlify/functions";
import { requireCron } from "../lib/http.mts";
import { sweepStaged } from "../lib/staged.mts";

/**
 * 每小時清一次讀信抽取沒讀成的附件（`lib/staged.mts sweepStaged`）。
 * 正常的路是背景函式讀完就刪；上傳到一半就關掉網頁、抽取的工作中途掛掉的，靠這裡收——
 * 截圖裡有對方的電話與整段對話，放上去超過一小時還在的就刪，不留著。
 */
export default async (req: Request) => {
  const denied = await requireCron(req);
  if (denied) return denied;
  const gone = await sweepStaged();
  return new Response(gone.length ? `清掉 ${gone.length} 個沒讀成的附件` : "沒有要清的附件");
};

export const config: Config = { schedule: "7 * * * *" };
