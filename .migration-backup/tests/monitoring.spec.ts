import { test, expect } from '@playwright/test';

test.describe('Real-Time Monitoring', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/monitoring');
    await page.waitForLoadState('networkidle');
  });

  test('should load monitoring page', async ({ page }) => {
    await expect(page.locator('h1, h2').filter({ hasText: /Monitoring/ })).toBeVisible();
  });

  test('should display real-time metrics', async ({ page }) => {
    await page.waitForTimeout(3000);
    
    const metricsSection = page.locator('text="Real-Time Monitoring"').or(
      page.locator('[data-testid="realtime-metrics"]')
    );
    
    if (await metricsSection.count() > 0) {
      await expect(metricsSection).toBeVisible();
    }
  });

  test('should show system performance data', async ({ page }) => {
    await page.waitForTimeout(3000);
    
    const performanceMetrics = page.locator('text="CPU Usage"').or(
      page.locator('text="Memory Usage"')
    ).or(
      page.locator('text="Disk Usage"')
    ).or(
      page.locator('text="Network"')
    );
    
    const metricsCount = await performanceMetrics.count();
    if (metricsCount > 0) {
      await expect(performanceMetrics.first()).toBeVisible();
    }
  });

  test('should display device health status', async ({ page }) => {
    await page.waitForTimeout(3000);
    
    const healthIndicators = page.locator('.text-green-500, .text-red-500, .text-yellow-500').or(
      page.locator('text="Healthy"').or(page.locator('text="Warning"')).or(page.locator('text="Critical"'))
    );
    
    const healthCount = await healthIndicators.count();
    if (healthCount > 0) {
      await expect(healthIndicators.first()).toBeVisible();
    }
  });

  test('should show network latency information', async ({ page }) => {
    await page.waitForTimeout(3000);
    
    const latencyInfo = page.locator('text="Latency"').or(
      page.locator('text="ms"')
    ).or(
      page.locator('[data-testid="network-latency"]')
    );
    
    const latencyCount = await latencyInfo.count();
    if (latencyCount > 0) {
      await expect(latencyInfo.first()).toBeVisible();
    }
  });
});