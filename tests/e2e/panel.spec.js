import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#app")).toBeVisible();
});

test("完整编辑中转站且 API Key 默认隐藏、可切换显示", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#mobileMenuBtn").click();
  await page.locator('[data-target="providersSection"]').click();
  await page.locator('[data-action="edit-provider"]').click();
  const modal = page.locator("#providerEditModal");
  const key = page.locator("#editKey");
  await expect(modal).toBeVisible();
  await expect(page.locator("#editName")).toHaveValue(/onclick/);
  await expect(page.locator("#editUrl")).toHaveValue(
    "https://fixture.invalid/v1",
  );
  await expect(page.locator("#editMode")).toHaveValue("chat_completions");
  await expect(page.locator("#editModel")).toHaveValue(/onclick/);
  await expect(key).toHaveValue("");
  await expect(key).toHaveAttribute("type", "password");
  await page.route("**/api/providers/*/api-key", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, api_key: "fixture-secret-key" }),
    }),
  );
  await page.locator('[data-secret-target="editKey"]').click();
  await expect(key).toHaveValue("fixture-secret-key");
  await expect(key).toHaveAttribute("type", "text");
  await expect(page.locator('[data-secret-target="editKey"]')).toHaveText(
    "隐藏",
  );
  await page.locator('[data-secret-target="editKey"]').click();
  await expect(key).toHaveAttribute("type", "password");
  const box = await modal.locator(".providerEditPanel").boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
});

test("14 页导航保留 SVG，移动菜单可重复开关", async ({ page }) => {
  const nav = page.locator(".sideNav button[data-target]");
  await expect(nav).toHaveCount(14);
  await expect(page.locator('[data-target="currentSection"]')).toHaveClass(
    /active/,
  );
  const svgCount = await page.locator(".sideNav svg").count();
  for (let index = 0; index < 14; index += 1) {
    await nav.nth(index).click();
    const target = await nav.nth(index).getAttribute("data-target");
    await expect(page.locator(`#${target}`)).toHaveClass(/activeSection/);
  }
  await expect(page.locator(".sideNav svg")).toHaveCount(svgCount);
  await expect(
    page.locator("#serviceStatus .statusSummary, #serviceStatus .statusChip"),
  ).toHaveCount(1);
  await expect(page.locator("#serviceStatus")).toContainText(/Agent|Gateway/);
  await page.setViewportSize({ width: 390, height: 760 });
  for (let round = 0; round < 2; round += 1) {
    await page.locator("#mobileMenuBtn").click();
    await expect(page.locator("#sideMenu")).toHaveClass(/open/);
    await page.mouse.click(380, 400);
    await expect(page.locator("#sideMenu")).not.toHaveClass(/open/);
  }
});

test("侧栏版本入口可检查更新并展示回滚版本", async ({ page }) => {
  await page.route("**/api/panel-update", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        version: "1.2.0",
        installed_sha: "a".repeat(40),
        latest_sha: "b".repeat(40),
        update_available: true,
        status: { state: "idle" },
        rollbacks: [
          {
            id: "20260825T012101Z",
            version: "1.1.4",
            sha: "c".repeat(40),
            created_at: "2026-08-25T01:21:01Z",
          },
        ],
      }),
    });
  });
  await page.locator("#versionBadgeBtn").click();
  await expect(page.locator("#versionPopover")).toBeVisible();
  await expect(page.locator("#versionPopoverNumber")).toHaveText("v1.2.0");
  await expect(page.locator("#versionUpdateDot")).not.toHaveClass(/hidden/);
  await expect(page.locator("#versionActionBtn")).toBeVisible();
  await expect(page.locator("#versionActionBtn")).toContainText("立即更新到");
  await page.locator("#versionActionBtn").click();
  await expect(page.locator("#confirmModal")).toHaveClass(/show/);
  await expect(page.locator("#confirmMessage")).toContainText(
    "确定将面板更新到",
  );
  await expect(page.locator("#versionLatestRow")).toBeVisible();
  await expect(page.locator("#versionRollbackList")).toContainText("v1.1.4");
  await expect(page.locator("[data-rollback-id]")).toHaveText("回滚");
  await page.locator('[data-static-click="68"]').click();
});

test("移动端版本管理以内联折叠区展示且空回滚状态可见", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#mobileMenuBtn").click();
  await page.locator("#versionBadgeBtn").click();
  const control = page.locator(".versionControl");
  const popover = page.locator("#versionPopover");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("可回滚版本");
  await expect(popover).toContainText("暂无可回滚版本");
  const [controlBox, popoverBox] = await Promise.all([
    control.boundingBox(),
    popover.boundingBox(),
  ]);
  expect(controlBox).not.toBeNull();
  expect(popoverBox).not.toBeNull();
  expect(popoverBox.x).toBeGreaterThanOrEqual(controlBox.x - 1);
  expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(
    controlBox.x + controlBox.width + 1,
  );
});

test("检查更新按钮有完整的检查中与结果过渡状态", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#mobileMenuBtn").click();
  await page.locator("#versionBadgeBtn").click();
  const button = page.locator("#versionActionBtn");
  await button.click();
  await expect(page.locator("#versionPopoverHint")).toHaveClass(/checkDone/);
  await expect(button).toContainText(/检查更新|立即更新到/);
});

test("管理员登录卡片在桌面和手机视口中居中", async ({ page }) => {
  await page.route("**/state", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: '{"ok":false,"error":"unauthorized"}',
    }),
  );
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const login = page.locator("#login");
    const card = page.locator(".loginCard");
    await expect(login).toBeVisible();
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    expect(
      Math.abs(box.x + box.width / 2 - viewport.width / 2),
    ).toBeLessThanOrEqual(2);
    expect(
      Math.abs(box.y + box.height / 2 - viewport.height / 2),
    ).toBeLessThanOrEqual(3);
  }
});

test("主题入口位于菜单底部并支持切换与持久化", async ({ page }) => {
  const root = page.locator("html");
  const theme = page.locator("#themeToggle");
  await expect(theme).toBeVisible();
  await expect(theme.locator(".themeLabel")).toHaveText(/日间模式|夜间模式/);
  await expect(
    theme.evaluate((el) =>
      el.closest(".sideFoot")?.contains(document.querySelector("#logoutBtn")),
    ),
  ).resolves.toBe(true);
  await theme.click();
  const selected = await root.getAttribute("data-theme");
  expect(["light", "dark"]).toContain(selected);
  expect(
    await page.evaluate(() => window.localStorage.getItem("hermes-theme")),
  ).toBe(selected);
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", selected);
});

test("移动菜单退出动画完成后才释放页面锁", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 760 });
  await page.locator("#mobileMenuBtn").click();
  await expect(page.locator("body")).toHaveClass(/menuOpen/);
  await page.mouse.click(380, 400);
  await expect(page.locator("#sideMenu")).not.toHaveClass(/open/);
  await expect
    .poll(() =>
      page.locator("body").evaluate((el) => el.classList.contains("menuOpen")),
    )
    .toBe(false);
});

test("移动菜单快速关闭再打开不会被旧动画释放页面锁", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.locator("#sideMenu");
  const button = page.locator("#mobileMenuBtn");
  await button.click();
  await expect(menu).toHaveClass(/open/);
  await page.evaluate(() => document.querySelector("#menuShade").click());
  await page.evaluate(() => document.querySelector("#mobileMenuBtn").click());
  await page.waitForTimeout(420);
  await expect(menu).toHaveClass(/open/);
  await expect(page.locator("body")).toHaveClass(/menuOpen/);
});

test("弹窗退出不会被子元素动画提前结束", async ({ page }) => {
  const trigger = page.locator('[data-target="commandsSection"]');
  await trigger.click();
  await page.locator("#commandsSection button").click();
  const modal = page.locator("#commandsModal");
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await modal.locator(".modalHead").dispatchEvent("animationend", {
    animationName: "spin",
  });
  await page.waitForTimeout(60);
  await expect(modal).not.toHaveClass(/hidden/);
  await expect(modal).toHaveClass(/hidden/, { timeout: 600 });
});

test("弹窗保持焦点陷阱并恢复触发按钮焦点", async ({ page }) => {
  const trigger = page.locator('[data-target="commandsSection"]');
  await trigger.click();
  const open = page.locator("#commandsSection button");
  await open.click();
  await expect(page.locator("#commandsModal")).toBeVisible();
  const close = page.locator("#commandsModal button");
  await expect(close).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#commandsModal")).toBeHidden();
  await expect(open).toBeFocused();
});

for (const width of [320, 390, 900, 1024, 1100]) {
  test(`${width}px 无页面横向溢出`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
}

for (const width of [320, 390]) {
  test(`${width}px 主内容在视口内水平居中`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const geometry = await page.evaluate(() => {
      const content = document
        .querySelector(".content")
        ?.getBoundingClientRect();
      const panel = document
        .querySelector(".panelSection.activeSection")
        ?.getBoundingClientRect();
      return {
        contentLeft: content?.left,
        contentRight: window.innerWidth - content?.right,
        panelLeft: panel?.left,
        panelRight: window.innerWidth - panel?.right,
      };
    });
    expect(
      Math.abs(geometry.contentLeft - geometry.contentRight),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(geometry.panelLeft - geometry.panelRight),
    ).toBeLessThanOrEqual(1);
    expect(geometry.panelLeft).toBeGreaterThanOrEqual(12);
    expect(geometry.panelRight).toBeGreaterThanOrEqual(12);
    const sections = page.locator(".sideNav button[data-target]");
    for (let index = 0; index < (await sections.count()); index += 1) {
      const target = await sections.nth(index).getAttribute("data-target");
      await sections.nth(index).evaluate((element) => element.click());
      const escaped = await page.locator(`#${target}`).evaluate(
        (root) =>
          [root, ...root.querySelectorAll("*")].filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.left < -1 || rect.right > window.innerWidth + 1;
          }).length,
      );
      expect(escaped, `${target} 存在越出视口的控件`).toBe(0);
    }
  });
}

test("退出按钮只在密码保护开启时显示", async ({ page }) => {
  const logout = page.locator("#logoutBtn");
  await expect(logout).toBeHidden();
  await logout.evaluate((element) => element.classList.toggle("hidden", false));
  await expect(logout).toBeVisible();
  await logout.evaluate((element) => element.classList.toggle("hidden", true));
  await expect(logout).toBeHidden();
});

test("面板安全保存按钮会提交密码与开关设置", async ({ page }) => {
  const requests = [];
  await page.route("**/api/{change-password,auth-settings}", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.continue();
    requests.push({
      path: new URL(request.url()).pathname,
      body: request.postDataJSON(),
    });
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        password_enabled: true,
        password_set: true,
        csrf_token: "fixture-token",
      }),
    });
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator('[data-target="settingsSection"]').click();
  await page.locator(".settingSwitch").click();
  await page.locator("#saveAuthBtn").click();
  await expect(page.locator("#toast")).toContainText(
    "必须输入至少 8 位的新密码",
  );
  expect(requests).toEqual([]);
  await page.locator("#authNewPassword").fill("example-pass-123");
  await page.locator("#saveAuthBtn").click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests.map((item) => item.path)).toEqual([
    "/api/change-password",
    "/api/auth-settings",
  ]);
  expect(requests[0].body.new_password).toBe("example-pass-123");
  expect(requests[1].body.password_enabled).toBe(true);
  await expect(page.locator("#toast")).toContainText("已打开密码保护");
  expect(errors).toEqual([]);
});

test("主要动态 DOM 的恶意属性值不能形成事件处理器", async ({ page }) => {
  await page.locator('[data-target="providersSection"]').click();
  await expect(page.locator("#providers")).toContainText("onclick");
  const unsafe = await page
    .locator("#providers [onclick], #providers [onerror], #providers [onload]")
    .count();
  expect(unsafe).toBe(0);
  expect(await page.evaluate(() => globalThis.pwned)).toBeUndefined();
});
