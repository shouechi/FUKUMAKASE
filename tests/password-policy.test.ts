import { describe, expect, test } from "vitest";
import {
  newPasswordSchema,
  passwordPolicy,
} from "../packages/schemas/src/index";

// Independent expected alphabet: every printable ASCII punctuation character.
const allowedSymbols = [
  "!",
  '"',
  "#",
  "$",
  "%",
  "&",
  "'",
  "(",
  ")",
  "*",
  "+",
  ",",
  "-",
  ".",
  "/",
  ":",
  ";",
  "<",
  "=",
  ">",
  "?",
  "@",
  "[",
  "\\",
  "]",
  "^",
  "_",
  "`",
  "{",
  "|",
  "}",
  "~",
];
const requirement =
  "8文字以上で、英小文字・英大文字・数字・記号をそれぞれ1文字以上含めてください。";
const maximumRequirement =
  "パスワードが長すぎます。72バイト以内（半角英数字・記号なら72文字以内）に短くしてください。";

describe("new password UTF-8 byte ceiling", () => {
  test("publishes the independent 72-byte boundary and Japanese message", () => {
    expect(passwordPolicy.maxBytes).toBe(72);
    expect(passwordPolicy.maxMessage).toBe(maximumRequirement);
  });
  for (const [label, prefix, baseBytes] of [
    ["ASCII", "Aa1!", 4],
    ["Japanese", `Aa1!${"あ".repeat(22)}`, 70],
    ["emoji", `Aa1!${"😀".repeat(16)}`, 68],
    ["Japanese and emoji", `Aa1!${"あ😀".repeat(9)}`, 67],
  ] as const) {
    test.each([71, 72, 73])(`${label}: %i UTF-8 bytes`, (bytes) => {
      const value = prefix + "a".repeat(bytes - baseBytes);
      expect(new TextEncoder().encode(value).byteLength).toBe(bytes);
      if (label !== "ASCII") expect(value.length).toBeLessThan(bytes);
      const result = newPasswordSchema.safeParse(value);
      expect(result.success).toBe(bytes <= 72);
      if (result.success) expect(result.data).toBe(value);
      else
        expect(result.error.issues.map((issue) => issue.message)).toEqual([
          maximumRequirement,
        ]);
    });
  }
});

describe("new password policy: independent boundary and character-class acceptance", () => {
  test("accepts exactly eight characters with all four required groups", () => {
    expect(newPasswordSchema.parse("Aa1!aaaa")).toBe("Aa1!aaaa");
    expect(passwordPolicy.minLength).toBe(8);
    expect(passwordPolicy.message).toBe(requirement);
  });
  test.each([
    ["seven characters", "Aa1!aaa"],
    ["missing lowercase", "AA1!AAAA"],
    ["missing uppercase", "aa1!aaaa"],
    ["missing number", "AaA!aaaa"],
    ["missing punctuation", "Aa12aaaa"],
  ])("rejects %s and returns the Japanese requirement", (_label, value) => {
    const result = newPasswordSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(
        result.error.issues.every((issue) => issue.message === requirement),
      ).toBe(true);
  });
  test("test oracle covers exactly 32 unique symbols", () => {
    expect(allowedSymbols).toHaveLength(32);
    expect(new Set(allowedSymbols).size).toBe(32);
  });
  test.each(allowedSymbols)(
    "ASCII punctuation %j satisfies the symbol condition",
    (symbol) => {
      expect(newPasswordSchema.safeParse(`Aa1${symbol}aaaa`).success).toBe(
        true,
      );
    },
  );
  test.each([
    ["ASCII space", " "],
    ["tab", "\t"],
    ["newline", "\n"],
    ["fullwidth space", "　"],
    ["fullwidth exclamation", "！"],
    ["fullwidth at sign", "＠"],
    ["emoji", "😀"],
  ])("%s alone cannot satisfy the symbol group", (_label, substitute) => {
    expect(newPasswordSchema.safeParse(`Aa1${substitute}aaaa`).success).toBe(
      false,
    );
  });
});
