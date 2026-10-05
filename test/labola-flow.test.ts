import { describe, expect, it } from "vitest";
import { identifyStep, looksSlotTaken, parseAmount, parseBookingRow, parseReservationNumber } from "../src/providers/labola/flow.js";

// 2026-10-05 に観測した画面タイトル・パス（個人情報は含めない）
describe("identifyStep", () => {
  it("recognizes observed pages", () => {
    expect(identifyStep("スペース予約｜予約内容の選択 - LaBOLA総合予約", "/r/booking/rental/shop/3036/booking-info/", false, "")).toBe("step1");
    expect(identifyStep("スペース予約｜お支払い方法の選択 - LaBOLA総合予約", "/r/booking/rental/shop/3036/customer-payment/", false, "")).toBe("step3");
    expect(identifyStep("スペース予約｜内容確認 - LaBOLA総合予約", "/r/booking/rental/shop/3036/customer-confirm/", false, "")).toBe("step4");
    expect(identifyStep("スペース予約｜予約方法の選択 - LaBOLA総合予約", "/r/booking/rental/shop/3036/facility/661/20261130-1030-1130/customer-type/", true, "")).toBe("login");
  });
  it("detects a 3-D Secure challenge page", () => {
    expect(identifyStep("Authentication", "/acs", false, "本人認証サービス ワンタイムパスワードを入力")).toBe("three_ds");
  });
  it("returns unknown for anything else (treated as SITE_CHANGED)", () => {
    expect(identifyStep("Something", "/x", false, "")).toBe("unknown");
  });
});

describe("parsers", () => {
  it("parses the amount", () => {
    expect(parseAmount("料金プラン メンバー料金：17,600 円 金額 17,600 円")).toBe(17600);
    expect(parseAmount("no amount")).toBeNull();
  });

  it("parses booking rows (completed and cancelled)", () => {
    const done = parseBookingRow({
      href: "/r/customer/member-booking/rental/1",
      text: "スポーツクラブ＆サウナスパ ルネサンスもりのみやキューズモール24 2026/12/13 (日) 13:30 - 15:30｜Southコート（屋根有） 22,000円 予約完了 詳細確認",
    })!;
    expect(done.start.toISO()).toBe("2026-12-13T13:30:00.000+09:00");
    expect(done.end.toFormat("HH:mm")).toBe("15:30");
    expect(done.spaceLabel).toBe("Southコート（屋根有）");
    expect(done.price).toBe(22000);
    expect(done.cancelled).toBe(false);

    const cancelled = parseBookingRow({
      href: "/r/customer/member-booking/rental/2",
      text: "ルネサンスもりのみやキューズモール24 2026/12/13 (日) 12:30 - 14:30｜Southコート（屋根有） - キャンセル 詳細確認",
    })!;
    expect(cancelled.cancelled).toBe(true);
    expect(cancelled.price).toBeNull();
  });

  it("parses the reservation number", () => {
    expect(parseReservationNumber("予約情報 予約番号 15198 利用スペース")).toBe("15198");
  });

  it("detects slot-taken messages", () => {
    expect(looksSlotTaken("選択された時間帯は既に予約されています")).toBe(true);
    expect(looksSlotTaken("内容確認へ進む")).toBe(false);
  });
});
