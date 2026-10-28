import { expect, type Page } from "@playwright/test";

/** Fails (with the offending elements named) on sideways overflow or a visible scrollbar. */
export async function expectNoScrollbars(page: Page, label: string, fitsHeight = false) {
  await page.waitForTimeout(150);
  const problems = await page.evaluate((fits) => {
    const out: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth)
      out.push(`page scrolls sideways (${root.scrollWidth} > ${root.clientWidth})`);
    if (fits && root.scrollHeight > root.clientHeight)
      out.push(`page scrolls vertically (${root.scrollHeight} > ${root.clientHeight})`);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || el === root || el === document.body) continue;
      const bx = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      const by = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const name = `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ").join(".") : ""}`;
      if (el.offsetWidth - el.clientWidth - bx > 0.5 && el.clientWidth > 0)
        out.push(`${name} shows a vertical scrollbar`);
      if (el.offsetHeight - el.clientHeight - by > 0.5 && el.clientHeight > 0)
        out.push(`${name} shows a horizontal scrollbar`);
    }
    return out;
  }, fitsHeight);
  expect(problems, label).toEqual([]);
}
