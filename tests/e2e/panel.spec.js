import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#app")).toBeVisible();
});

test("中转站测试显示汇总和批量进度", async ({ page }) => {
  await page.locator('[data-target="testSection"]').click();
  const overview = page.locator("#testOverview");
  await expect(overview).toContainText("测试汇总");
  await expect(page.locator("#testProgressText")).toHaveText("尚未开始");
  await expect(page.locator("#testTotalCount")).toHaveText("0");
  await page.locator("#testTarget").selectOption("provider-all:1");
  await page.locator("#runTestBtn").click();
  await expect(page.locator("#testProgressText")).toHaveText("已完成", {
    timeout: 20_000,
  });
  await expect(page.locator("#testTotalCount")).not.toHaveText("0");
  const now = Number(
    await page.locator("#testProgressTrack").getAttribute("aria-valuenow"),
  );
  const max = Number(
    await page.locator("#testProgressTrack").getAttribute("aria-valuemax"),
  );
  expect(now).toBe(max);
  await expect(page.locator("#testProgressBar")).toHaveCSS("width", /.+/);
});

test("批量测试进行中仍可查看检测日志", async ({ page }) => {
  let releaseFirst;
  await page.route("**/api/test", async (route) => {
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    await route.continue();
  });
  await page.locator('[data-target="testSection"]').click();
  await page.locator("#testTarget").selectOption("provider-all:1");
  await page.locator("#runTestBtn").click();
  const logButton = page.locator("#testLogToggleBtn");
  await expect(page.locator("#runTestBtn")).toBeEnabled();
  await expect(page.locator("#runTestBtn")).toHaveText("暂停测试");
  await expect(logButton).toBeEnabled();
  await logButton.click();
  await expect(page.locator("#testLog")).toBeVisible();
  await expect(logButton).toHaveText("隐藏检测日志");
  releaseFirst();
});

test("批量测试可以暂停并继续", async ({ page }) => {
  let requestCount = 0;
  let releaseFirst;
  await page.route("**/api/test", async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
    }
    await route.continue();
  });
  await page.locator('[data-target="testSection"]').click();
  await page.locator("#testTarget").selectOption("provider-all:1");
  const runButton = page.locator("#runTestBtn");
  await runButton.click();
  await expect(runButton).toHaveText("暂停测试");
  await runButton.click();
  await expect(runButton).toHaveText("继续测试");
  releaseFirst();
  await page.waitForTimeout(300);
  expect(requestCount).toBe(1);
  await expect(page.locator("#testProgressText")).toContainText("进行中");
  await runButton.click();
  await expect.poll(() => requestCount).toBeGreaterThan(1);
  await expect(page.locator("#testProgressText")).toHaveText("已完成", {
    timeout: 20_000,
  });
  await expect(runButton).toHaveText("开始测试");
});

test("模型卡片测试不继承顶部生图测试方式", async ({ page }) => {
  await page.locator('[data-target="testSection"]').click();
  await page.locator("#testMode").selectOption("image");
  let requestBody;
  await page.route("**/api/test", async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        results: [
          {
            providerIndex: 1,
            provider_name: "oai",
            base_url: "https://api.example/v1",
            model: "gpt-5.6-terra",
            api_mode: "chat_completions",
            test_mode: "basic",
            ok: true,
            http_status: 200,
            latency_ms: 10,
            text: "测试成功",
          },
        ],
      }),
    });
  });
  await page.locator('[data-target="providersSection"]').click();
  await page.locator('[data-action="test-model"]:visible').first().click();
  await expect.poll(() => requestBody?.test_mode).toBe("basic");
});

test("测试方式可选择生图测试并返回图片", async ({ page }) => {
  await page.locator('[data-target="testSection"]').click();
  await page.locator("#testTarget").selectOption({ index: 0 });
  await page.locator("#testMode").selectOption("image");
  let requestBody;
  await page.route("**/api/test", async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        results: [
          {
            providerIndex: 1,
            provider_name: "oai",
            base_url: "https://api.example/v1",
            model: "gpt-image-1.5",
            api_mode: "images_generations",
            test_mode: "image",
            ok: true,
            http_status: 200,
            latency_ms: 321,
            text: "图片生成成功",
            image_url: "data:image/png;base64,iVBORw0KGgo=",
          },
        ],
      }),
    });
  });
  await page.locator("#runTestBtn").click();
  await expect.poll(() => requestBody?.test_mode).toBe("image");
  await expect(page.locator("#testResults .reply")).toHaveText("图片生成成功");
  await expect(
    page.locator("#testResults .imageTestPreview img"),
  ).toHaveAttribute("src", /^data:image\/png;base64,/);
  await expect(page.locator("#testResults .imageTestPreview a")).toContainText(
    "查看原图 / 下载",
  );
});

test("生图页面提供图片生成接口专项测试", async ({ page }) => {
  await page
    .locator('[data-target="imageGenSection"]')
    .evaluate((button) => button.click());
  await expect(
    page.locator('[data-action="test-image-model"][data-agent="default"]'),
  ).toBeVisible();

  let requestBody;
  await page.route("**/api/image-gen/test", async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        http_status: 200,
        latency_ms: 321,
        relay: { name: "fixture" },
      }),
    });
  });
  await page
    .locator('[data-action="test-image-model"][data-agent="default"]')
    .click();
  await expect.poll(() => requestBody?.agent).toBe("default");
  await expect(page.locator("#imageGenBox")).toContainText(
    "测试成功 · HTTP 200 · 321ms",
  );
});

test("手机端测试结果卡片不会被长元信息撑出视口", async ({ page }) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page
      .locator('[data-target="testSection"]')
      .evaluate((button) => button.click());
    await page.locator("#testResults").evaluate((node) => {
      node.innerHTML = `<div class="result ok"><div class="rhead"><div><b>2号：11</b><div class="pmeta">claude-fable-5 · https://hello.iterm.today/v1/this/is/a/very/long/unbroken/provider/path · chat_completions</div></div><span class="pill ok">可用 · HTTP 200 · 3250ms</span></div><div class="reply">你好，测试成功！</div></div>`;
    });
    const result = page.locator("#testResults .result");
    const section = page.locator("#testSection");
    const [resultBox, sectionBox] = await Promise.all([
      result.boundingBox(),
      section.boundingBox(),
    ]);
    expect(resultBox.x).toBeGreaterThanOrEqual(sectionBox.x);
    expect(resultBox.x + resultBox.width).toBeLessThanOrEqual(
      sectionBox.x + sectionBox.width + 0.5,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    await expect(page.locator("#testResults .pmeta")).toHaveCSS(
      "overflow-wrap",
      "anywhere",
    );
  }
});

test("可删除名称含斜杠的 Hugging Face 模型", async ({ page }) => {
  await page.locator('[data-target="providersSection"]').click();
  const model = page.locator(".modelItem", {
    hasText: "deepseek-ai/DeepSeek-V3",
  });
  await expect(model).toBeVisible();
  const requestPromise = page.waitForRequest(
    (request) =>
      request.method() === "DELETE" &&
      request
        .url()
        .endsWith("/api/providers/1/models/deepseek-ai%2FDeepSeek-V3"),
  );
  await model.locator('[data-action="delete-model"]').click();
  await page.locator('[data-static-click="69"]').click();
  const request = await requestPromise;
  expect(request.url()).toContain("deepseek-ai%2FDeepSeek-V3");
  await expect(model).toHaveCount(0);
  await expect(page.locator("#toast")).toContainText("已删除模型");
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
  const panel = modal.locator(".providerEditPanel");
  const close = modal.locator(".modalHead > button");
  const actions = modal.locator(".providerEditActions");
  const models = page.locator("#editModels");
  const box = await panel.boundingBox();
  const closeBox = await close.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y).toBeGreaterThanOrEqual(70);
  expect(box.y + box.height).toBeLessThanOrEqual(774);
  expect(box.height).toBeLessThanOrEqual(844 * 0.79);
  expect(closeBox.width).toBeLessThan(100);
  expect(closeBox.height).toBeLessThanOrEqual(44);
  await models.scrollIntoViewIfNeeded();
  const modelBox = await models.boundingBox();
  const actionBox = await actions.boundingBox();
  expect(modelBox.y + modelBox.height).toBeLessThanOrEqual(actionBox.y);
});

test("手机端编辑中转站关闭时不等待禁用的动画", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#mobileMenuBtn").click();
  await page.locator('[data-target="providersSection"]').click();
  await page.locator('[data-action="edit-provider"]').click();
  const modal = page.locator("#providerEditModal");
  await expect(modal).toBeVisible();
  const hiddenSynchronously = await page.evaluate(() => {
    document.querySelector("#providerEditModal .modalHead > button").click();
    return document
      .querySelector("#providerEditModal")
      .classList.contains("hidden");
  });
  expect(hiddenSynchronously).toBe(true);
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

test("版本检查遇到 Cloudflare HTML 502 时显示友好提示", async ({ page }) => {
  await page.route("**/api/panel-update", (route) =>
    route.fulfill({
      status: 502,
      contentType: "text/html",
      body: "<html>Cloudflare</html>",
    }),
  );
  await page.goto("/");
  await page.locator("#versionBadgeBtn").click();
  await page.locator("#versionActionBtn").click();
  await expect(page.locator("#versionPopoverHint")).toContainText(
    "版本检查服务暂时不可用，请稍后重试",
  );
  await expect(page.locator("body")).not.toContainText("非 JSON 响应");
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
  const ignoredChildAnimation = await modal.evaluate((element) => {
    document.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    const event = new window.AnimationEvent("animationend", {
      animationName: "spin",
      bubbles: true,
    });
    element.querySelector(".modalHead").dispatchEvent(event);
    return !element.classList.contains("hidden");
  });
  expect(ignoredChildAnimation).toBe(true);
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

test("Escape 通用关闭当前打开的新旧弹窗", async ({ page }) => {
  await page.locator('[data-target="providersSection"]').click();
  const edit = page.locator('[data-action="edit-provider"]').first();
  await edit.click();
  const providerModal = page.locator("#providerEditModal");
  await expect(providerModal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(providerModal).toBeHidden();
  await expect(edit).toBeFocused();

  const openedRestart = await page.evaluate(() => {
    const modal = document.querySelector("#restartModal");
    if (!modal) return false;
    window.openModal("restartModal");
    return true;
  });
  if (openedRestart) {
    const restartModal = page.locator("#restartModal");
    await expect(restartModal).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(restartModal).toBeHidden();
  }
});

test("手机端允许缩放且表单控件不会触发 iOS 自动放大", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const viewport = await page
    .locator('meta[name="viewport"]')
    .getAttribute("content");
  expect(viewport).not.toContain("maximum-scale");
  expect(viewport).not.toContain("user-scalable=no");
  const sizes = await page
    .locator("input, select, textarea")
    .evaluateAll((elements) =>
      elements.map((element) =>
        parseFloat(window.getComputedStyle(element).fontSize),
      ),
    );
  expect(sizes.length).toBeGreaterThan(0);
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(16);
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
  test(`${width}px 长模型错误不会撑宽模型卡片`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector(".panelSection.activeSection");
      if (!panel) throw new Error("active panel missing");
      const list = document.createElement("div");
      list.className = "modelList";
      list.innerHTML = `<div class="modelItem"><div class="modelName">vertex_ai/gemini-robotics-er-1.5-preview</div><div class="sub">当前模型测试</div><div class="modelBtns"><button class="testBtn">测试</button><button>切 agent1</button></div><div class="modelResult">{"error":{"message":"Received Model Group=vertex_ai/gemini-robotics-er-1.5-preview Available Model Group Fallbacks=None","status":"NOT_FOUND"}}</div></div>`;
      panel.appendChild(list);
      const nodes = [list, ...list.querySelectorAll("*")];
      return {
        documentOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        escaped: nodes.filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left < -1 || rect.right > window.innerWidth + 1;
        }).length,
        cardWidth: list.querySelector(".modelItem").getBoundingClientRect()
          .width,
        listWidth: list.getBoundingClientRect().width,
      };
    });
    expect(geometry.documentOverflow).toBeLessThanOrEqual(1);
    expect(geometry.escaped).toBe(0);
    expect(geometry.cardWidth).toBeLessThanOrEqual(geometry.listWidth + 1);
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
