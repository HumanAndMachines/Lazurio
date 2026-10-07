import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const publicUrl = new URL("../public/", import.meta.url);
const rootUrl = new URL("../../", import.meta.url);

test("Launchpad loads its fonts locally, never from a third-party font CDN", async () => {
  const html = await readFile(new URL("index.html", publicUrl), "utf8");
  expect(html).not.toContain("fonts.googleapis.com");
  expect(html).not.toContain("fonts.gstatic.com");
});

test("Launchpad web and system icons are valid icon files", async () => {
  const [webIco, touchIcon, shortcutIco] = await Promise.all([
    readFile(new URL("favicon.ico", publicUrl)),
    readFile(new URL("apple-touch-icon.png", publicUrl)),
    readFile(new URL("assets/launchpad.ico", rootUrl)),
    readFile(new URL("favicon.svg", publicUrl)),
    readFile(new URL("favicon-dark.svg", publicUrl)),
    readFile(new URL("assets/launchpad.svg", rootUrl)),
  ]);
  expect(webIco.subarray(0, 4)).toEqual(new Uint8Array([0, 0, 1, 0]));
  expect(touchIcon.readUInt32BE(16)).toBe(180);
  expect(touchIcon.readUInt32BE(20)).toBe(180);
  expect(shortcutIco.subarray(0, 4)).toEqual(new Uint8Array([0, 0, 1, 0]));
});
