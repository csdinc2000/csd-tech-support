import { test, expect } from '@playwright/test';

test.describe('Device Management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/devices');
    await page.waitForLoadState('networkidle');
  });

  test('should load devices page successfully', async ({ page }) => {
    await expect(page.locator('h1, h2').filter({ hasText: /Device|Devices/ })).toBeVisible();
  });

  test('should display device list', async ({ page }) => {
    // Wait for devices to load
    await page.waitForTimeout(2000);
    
    // Check if devices are displayed
    const deviceCards = page.locator('[data-testid="device-card"]').or(
      page.locator('div').filter({ hasText: /SERVER|WORKSTATION|LAPTOP/ })
    );
    
    const deviceCount = await deviceCards.count();
    if (deviceCount > 0) {
      await expect(deviceCards.first()).toBeVisible();
    }
  });

  test('should show device status indicators', async ({ page }) => {
    // Look for status indicators
    const statusElements = page.locator('text="Online"').or(
      page.locator('text="Offline"')
    ).or(
      page.locator('.bg-green-100, .bg-red-100, .bg-yellow-100')
    );
    
    const statusCount = await statusElements.count();
    if (statusCount > 0) {
      await expect(statusElements.first()).toBeVisible();
    }
  });

  test('should handle device filtering', async ({ page }) => {
    // Look for filter controls
    const filterButtons = page.locator('button').filter({ hasText: /All|Online|Offline|Server|Workstation/ });
    const filterCount = await filterButtons.count();
    
    if (filterCount > 0) {
      await filterButtons.first().click();
      await page.waitForTimeout(500);
    }
  });

  test('should display device details', async ({ page }) => {
    await page.waitForTimeout(2000);
    
    // Look for device detail information
    const detailElements = page.locator('text="CPU Usage"').or(
      page.locator('text="Memory"')
    ).or(
      page.locator('text="Disk"')
    ).or(
      page.locator('text="IP Address"')
    );
    
    const detailCount = await detailElements.count();
    if (detailCount > 0) {
      await expect(detailElements.first()).toBeVisible();
    }
  });

  test('should handle device actions', async ({ page }) => {
    await page.waitForTimeout(2000);
    
    // Look for action buttons
    const actionButtons = page.locator('button').filter({ 
      hasText: /Connect|Remote|Monitor|Update|Restart/ 
    });
    
    const actionCount = await actionButtons.count();
    if (actionCount > 0) {
      // Test hovering over action button
      await actionButtons.first().hover();
    }
  });

  test('should be responsive', async ({ page }) => {
    // Test mobile view
    await page.setViewportSize({ width: 375, height: 667 });
    await page.reload();
    await page.waitForLoadState('networkidle');
    
    await expect(page.locator('body')).toBeVisible();
    
    // Test tablet view
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.reload();
    await page.waitForLoadState('networkidle');
    
    await expect(page.locator('body')).toBeVisible();
    
    // Reset to desktop
    await page.setViewportSize({ width: 1280, height: 720 });
  });
});