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
  await expect(page.locator('#serviceStatus .statusSummary, #serviceStatus .statusChip')).toHaveCount(1);
  await expect(page.locator('#serviceStatus')).toContainText(/Agent|Gateway/);
  await page.setViewportSize({ width: 390, height: 760 });
  for (let round = 0; round < 2; round += 1) {
    await page.locator('#mobileMenuBtn').click();
    await expect(page.locator('#sideMenu')).toHaveClass(/open/);
    await page.mouse.click(380, 400);
    await expect(page.locator('#sideMenu')).not.toHaveClass(/open/);
  }
});

test('主题入口位于菜单底部并支持切换与持久化', async ({ page }) => {
  const root = page.locator('html');
  const theme = page.locator('#themeToggle');
  await expect(theme).toBeVisible();
  await expect(theme.locator('.themeLabel')).toHaveText(/日间模式|夜间模式/);
  await expect(theme.evaluate((el) => el.closest('.sideFoot')?.contains(document.querySelector('#logoutBtn')))).resolves.toBe(true);
  await theme.click();
  const selected = await root.getAttribute('data-theme');
  expect(['light', 'dark']).toContain(selected);
  expect(await page.evaluate(() => window.localStorage.getItem('hermes-theme'))).toBe(selected);
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', selected);
});

test('移动菜单退出动画完成后才释放页面锁', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.locator('#mobileMenuBtn').click();
  await expect(page.locator('body')).toHaveClass(/menuOpen/);
  await page.mouse.click(380, 400);
  await expect(page.locator('#sideMenu')).not.toHaveClass(/open/);
  await expect.poll(() => page.locator('body').evaluate((el) => el.classList.contains('menuOpen'))).toBe(false);
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

test('面板安全保存按钮会提交密码与开关设置', async ({ page }) => {
  const requests = [];
  await page.route('**/api/{change-password,auth-settings}', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') return route.continue();
    requests.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, password_enabled: true, password_set: true, csrf_token: 'fixture-token' }),
    });
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('[data-target="settingsSection"]').click();
  await page.locator('.settingSwitch').click();
  await page.locator('#saveAuthBtn').click();
  await expect(page.locator('#toast')).toContainText('必须输入至少 8 位的新密码');
  expect(requests).toEqual([]);
  await page.locator('#authNewPassword').fill('example-pass-123');
  await page.locator('#saveAuthBtn').click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests.map((item) => item.path)).toEqual(['/api/change-password', '/api/auth-settings']);
  expect(requests[0].body.new_password).toBe('example-pass-123');
  expect(requests[1].body.password_enabled).toBe(true);
  await expect(page.locator('#toast')).toContainText('已打开密码保护');
  expect(errors).toEqual([]);
});

test('主要动态 DOM 的恶意属性值不能形成事件处理器', async ({ page }) => {
  await page.locator('[data-target="providersSection"]').click();
  await expect(page.locator('#providers')).toContainText('onclick');
  const unsafe = await page.locator('#providers [onclick], #providers [onerror], #providers [onload]').count();
  expect(unsafe).toBe(0);
  expect(await page.evaluate(() => globalThis.pwned)).toBeUndefined();
});
