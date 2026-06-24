import { getDb } from "@/lib/db";

export const LOCAL_USER_ID = "seed-user";

export async function ensureLocalUser() {
  return getDb().user.upsert({
    where: { id: LOCAL_USER_ID },
    update: {},
    create: {
      id: LOCAL_USER_ID,
      displayName: "Calcifer",
      timezone: "Asia/Shanghai",
      defaultModel: "qwen-plus",
    },
  });
}
