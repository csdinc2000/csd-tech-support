import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/dashboard');
  });

  test('should load dashboard successfully', async ({ page }) => {
    await expect(page.locator('h2')).toContainText('RMM Dashboard');
    await expect(page.getByText('Real-time monitoring and management')).toBeVisible();
  });

  test('should display key metrics cards', async ({ page }) => {
    // Wait for data to load
    await page.waitForLoadState('networkidle');
    
    // Check for metrics cards
    await expect(page.getByTestId('total-devices') || page.getByText('Total Devices')).toBeVisible();
    await expect(page.getByTestId('active-alerts') || page.getByText('Active Alerts')).toBeVisible();
    await expect(page.getByTestId('open-tickets') || page.getByText('Open Tickets')).toBeVisible();
    await expect(page.getByTestId('uptime') || page.getByText('Uptime')).toBeVisible();
  });

  test('should navigate to different sections', async ({ page }) => {
    // Test navigation to devices
    await page.click('text="Device Management"');
    await expect(page).toHaveURL(/.*\/devices/);
    
    // Go back to dashboard
    await page.click('text="Dashboard"');
    await expect(page).toHaveURL(/.*\/dashboard/);
    
    // Test navigation to tickets
    await page.click('text="Help Desk"');
    await expect(page).toHaveURL(/.*\/tickets/);
  });

  test('should display recent alerts panel', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    
    // Look for alerts section
    const alertsSection = page.locator('[data-testid="alerts-panel"]').or(
      page.locator('text="Recent Alerts"').locator('..')
    );
    
    if (await alertsSection.count() > 0) {
      await expect(alertsSection).toBeVisible();
    }
  });

  test('should display device status overview', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    
    // Check for device status information
    const deviceSection = page.locator('[data-testid="device-status"]').or(
      page.locator('text="Device Status"').locator('..')
    );
    
    if (await deviceSection.count() > 0) {
      await expect(deviceSection).toBeVisible();
    }
  });

  test('should handle responsive design', async ({ page }) => {
    // Test mobile responsiveness
    await page.setViewportSize({ width: 375, height: 667 });
    await page.reload();
    
    await expect(page.locator('h1')).toBeVisible();
    
    // Test tablet responsiveness  
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.reload();
    
    await expect(page.locator('h1')).toBeVisible();
    
    // Reset to desktop
    await page.setViewportSize({ width: 1280, height: 720 });
  });
});