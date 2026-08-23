import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
});

test('13 页导航保留 SVG，移动菜单可重复开关', async ({ page }) => {
  const nav = page.locator('.sideNav button[data-target]');
  await expect(nav).toHaveCount(13);
  const svgCount = await page.locator('.sideNav svg').count();
  for (let index = 0; index < 13; index += 1) {
    await nav.nth(index).click();
    const target = await nav.nth(index).getAttribute('data-target');
    await expect(page.locator(`#${target}`)).toHaveClass(/activeSection/);
  }
  await expect(page.locator('.sideNav svg')).toHaveCount(svgCount);
  await page.setViewportSize({ width: 390, height: 760 });
  for (let round = 0; round < 2; round += 1) {
    await page.locator('#mobileMenuBtn').click();
    await expect(page.locator('#sideMenu')).toHaveClass(/open/);
    await page.mouse.click(380, 400);
    await expect(page.locator('#sideMenu')).not.toHaveClass(/open/);
  }
});

test('弹窗保持焦点陷阱并恢复触发按钮焦点', async ({ page }) => {
  const trigger = page.locator('[data-target="commandsSection"]');
  await trigger.click();
  const open = page.locator('#commandsSection button');
  await open.click();
  await expect(page.locator('#commandsModal')).toBeVisible();
  const close = page.locator('#commandsModal button');
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#commandsModal')).toBeHidden();
  await expect(open).toBeFocused();
});

for (const width of [320, 390, 900, 1024, 1100]) {
  test(`${width}px 无页面横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

test('主要动态 DOM 的恶意属性值不能形成事件处理器', async ({ page }) => {
  await page.locator('[data-target="providersSection"]').click();
  await expect(page.locator('#providers')).toContainText('onclick');
  const unsafe = await page.locator('#providers [onclick], #providers [onerror], #providers [onload]').count();
  expect(unsafe).toBe(0);
  expect(await page.evaluate(() => globalThis.pwned)).toBeUndefined();
});
